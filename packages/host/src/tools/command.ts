import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { redact, safeLabel, safeText } from '@extalia/core';
import type { ActivityKind, RiskLevel } from '@extalia/protocol';
import type { ToolDefinition, ToolRunContext } from '@extalia/runtime';
import { integer, text } from './shared.js';

export interface CommandToolOptions {
  /** Environment the command inherits before credentials are removed. Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Time between SIGTERM and SIGKILL when a command is stopped. Defaults to 2000 ms. */
  killGraceMs?: number;
  /** Minimum time between streamed `command.output` events per command. Defaults to 200 ms. */
  outputIntervalMs?: number;
}

type CommandInput = { command: string; timeout_seconds?: number };
type Stream = 'stdout' | 'stderr';

export const TIMEOUT_EXIT_CODE = 124;
export const CANCELLED_EXIT_CODE = 130;
const HEAD_CHARACTERS = 5_000;
const TAIL_CHARACTERS = 25_000;
const EVENT_TEXT_LIMIT = 20_000;
const LONG_LINE = 8_192;

const CREDENTIAL_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i;
const CREDENTIAL_PREFIXES = ['ANTHROPIC_', 'OPENAI_', 'EXTALIA_', 'AWS_', 'GITHUB_', 'GH_'];

/**
 * The parent environment without anything that looks like a credential: names
 * such as `*_TOKEN` or `OPENAI_*`, and values that contain a credential (for
 * example a database URL with a password).
 */
export function commandEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (CREDENTIAL_NAME.test(name) || CREDENTIAL_PREFIXES.some(prefix => upper.startsWith(prefix))) continue;
    if (redact(value) !== value) continue;
    result[name] = value;
  }
  return result;
}

const TEST_COMMAND = /\b(?:test|tests|pytest|vitest|jest|mocha|check|typecheck|lint|eslint|tsc)\b/i;

/** `test` for test, lint and type-check commands; `command` otherwise. */
export function commandKind(command: string): ActivityKind {
  return TEST_COMMAND.test(command) ? 'test' : 'command';
}

const HIGH_RISK: readonly RegExp[] = [
  /\brm\s+(?:-[a-z]*(?:r[a-z]*f|f[a-z]*r)|(?:-[a-z]+\s+)*--recursive)\b/i,
  /\brm\s+-r\s+-f\b|\brm\s+-f\s+-r\b/i,
  /\bsudo\b/,
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/,
  /\bmkfs(?:\.\w+)?\b/,
  /\bdd\s+if=/,
  /\bch(?:mod|own)\s+-R\b/,
  /\b(?:shutdown|reboot)\b/,
];

export function commandRisk(command: string): RiskLevel {
  return HIGH_RISK.some(pattern => pattern.test(command)) ? 'high' : 'medium';
}

/** Splits a byte stream into whole lines so credentials are redacted before they are split across events. */
class LineBuffer {
  private readonly decoder = new StringDecoder('utf8');
  private partial = '';

  push(chunk: Buffer): string {
    const value = this.partial + this.decoder.write(chunk);
    const cut = value.lastIndexOf('\n') + 1;
    if (!cut && value.length < LONG_LINE) { this.partial = value; return ''; }
    const end = cut || value.length;
    this.partial = value.slice(end);
    return value.slice(0, end);
  }

  end(): string {
    const rest = this.partial + this.decoder.end();
    this.partial = '';
    return rest;
  }
}

/** Keeps the first and last part of the combined output. */
class OutputCapture {
  private head = '';
  private tail = '';
  private omitted = 0;

  add(value: string): void {
    if (this.head.length < HEAD_CHARACTERS) {
      const take = HEAD_CHARACTERS - this.head.length;
      this.head += value.slice(0, take);
      value = value.slice(take);
    }
    if (!value) return;
    this.tail += value;
    if (this.tail.length > TAIL_CHARACTERS * 2) this.trim();
  }

  private trim(): void {
    if (this.tail.length <= TAIL_CHARACTERS) return;
    this.omitted += this.tail.length - TAIL_CHARACTERS;
    this.tail = this.tail.slice(-TAIL_CHARACTERS);
  }

  result(): string {
    this.trim();
    return this.omitted ? `${this.head}\n… [${this.omitted} characters of output omitted] …\n${this.tail}` : this.head + this.tail;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch { /* the group already exited */ }
}

/** Stop the command and everything it started. */
function terminate(child: ChildProcess, graceMs: number): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    return;
  }
  signalGroup(pid, 'SIGTERM');
  setTimeout(() => signalGroup(pid, 'SIGKILL'), graceMs).unref();
}

function firstLine(command: string): string {
  const line = command.trim().split(/\r?\n/)[0] ?? '';
  return command.trim().includes('\n') ? `${line} …` : line;
}

async function runCommand(root: string, input: CommandInput, context: ToolRunContext, options: Required<CommandToolOptions>) {
  const command = text(input.command);
  if (!command.trim()) return { ok: false, output: 'The command is empty.' };
  const timeoutSeconds = integer(input.timeout_seconds, 120, 1, 600);
  if (context.signal.aborted) return { ok: false, output: `The command was cancelled before it started.\nexit code ${CANCELLED_EXIT_CODE}` };

  const commandId = context.toolCallId;
  const started = Date.now();
  context.emit({ type: 'command.started', commandId, command: redact(command), cwd: '.' });

  const child = spawn(command, {
    shell: true,
    cwd: root,
    // Its own process group, so a timeout or cancel can stop everything the command started.
    detached: process.platform !== 'win32',
    env: commandEnvironment(options.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const capture = new OutputCapture();
  const pending: Record<Stream, string> = { stdout: '', stderr: '' };
  const buffers: Record<Stream, LineBuffer> = { stdout: new LineBuffer(), stderr: new LineBuffer() };
  let flushTimer: NodeJS.Timeout | undefined;
  let lastFlush = 0;

  const flush = () => {
    flushTimer = undefined;
    lastFlush = Date.now();
    for (const stream of ['stdout', 'stderr'] as const) {
      let value = pending[stream];
      if (!value) continue;
      pending[stream] = '';
      if (value.length > EVENT_TEXT_LIMIT) value = `… [${value.length - EVENT_TEXT_LIMIT} characters skipped]\n${value.slice(-EVENT_TEXT_LIMIT)}`;
      context.emit({ type: 'command.output', commandId, stream, text: value });
    }
  };
  const accept = (stream: Stream, raw: string) => {
    if (!raw) return;
    const clean = redact(raw);
    capture.add(clean);
    pending[stream] += clean;
    flushTimer ??= setTimeout(flush, Math.max(0, lastFlush + options.outputIntervalMs - Date.now()));
  };
  child.stdout?.on('data', (chunk: Buffer) => accept('stdout', buffers.stdout.push(chunk)));
  child.stderr?.on('data', (chunk: Buffer) => accept('stderr', buffers.stderr.push(chunk)));

  let stopReason: 'timeout' | 'cancelled' | undefined;
  const stop = (reason: 'timeout' | 'cancelled') => {
    if (stopReason) return;
    stopReason = reason;
    terminate(child, options.killGraceMs);
    // If the process cannot be reaped (for example stuck in the kernel), report anyway.
    setTimeout(() => finish(null, null), options.killGraceMs + 3000).unref();
  };
  const timeout = setTimeout(() => stop('timeout'), timeoutSeconds * 1000);
  const onAbort = () => stop('cancelled');
  context.signal.addEventListener('abort', onAbort, { once: true });

  let spawnError: Error | undefined;
  let resolveDone!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => { resolveDone = resolve; });
  let finished = false;
  function finish(code: number | null, signal: NodeJS.Signals | null) {
    if (finished) return;
    finished = true;
    resolveDone({ code, signal });
  }
  child.on('error', error => { spawnError = error; finish(127, null); });
  child.on('close', (code, signal) => finish(code, signal));
  // A background process may keep the pipes open after the shell exits; do not wait for it forever.
  child.on('exit', (code, signal) => { setTimeout(() => finish(code, signal), 1000).unref(); });

  const { code, signal } = await done;
  clearTimeout(timeout);
  context.signal.removeEventListener('abort', onAbort);
  child.stdout?.destroy();
  child.stderr?.destroy();
  accept('stdout', buffers.stdout.end());
  accept('stderr', buffers.stderr.end());
  if (flushTimer) clearTimeout(flushTimer);
  flush();

  const exitCode = stopReason === 'timeout' ? TIMEOUT_EXIT_CODE
    : stopReason === 'cancelled' ? CANCELLED_EXIT_CODE
    : code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1);
  context.emit({ type: 'command.completed', commandId, exitCode, durationMs: Date.now() - started });

  const lines = [capture.result().trimEnd() || '(no output)'];
  if (spawnError) lines.push(`Could not start the command: ${spawnError.message}`);
  if (stopReason === 'timeout') lines.push(`The command timed out after ${timeoutSeconds} s and was stopped.`);
  if (stopReason === 'cancelled') lines.push('The command was cancelled.');
  lines.push(`exit code ${exitCode}`);
  return { ok: exitCode === 0, output: lines.join('\n') };
}

/** `run_command`: runs a shell command in the workspace root with credentials removed from its environment. */
export function createCommandTool(root: string, options: CommandToolOptions = {}): ToolDefinition<CommandInput> {
  const settings: Required<CommandToolOptions> = { env: options.env ?? process.env, killGraceMs: options.killGraceMs ?? 2000, outputIntervalMs: options.outputIntervalMs ?? 200 };
  return {
    name: 'run_command',
    description: 'Run a shell command in the workspace root and return its combined output and exit code. stdin is closed, so interactive programs fail; pass non-interactive flags. Credentials are not available in the environment.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command, for example "pnpm test".' },
        timeout_seconds: { type: 'integer', description: 'Stop the command after this many seconds (1-600). Defaults to 120.', minimum: 1, maximum: 600 },
      },
      required: ['command'],
      additionalProperties: false,
    },
    access: 'execute',
    kind: 'command',
    describe: input => {
      const command = text(input.command);
      return { label: safeLabel(`Running ${firstLine(command)}`, 80), detail: safeText(command, 4000), risk: commandRisk(command) };
    },
    run: (input, context) => runCommand(root, input, context, settings),
  };
}
