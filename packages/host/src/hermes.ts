import { safeText } from '@extalia/core';
import type { RuntimeInfo } from '@extalia/platform';
import type { EventBody } from '@extalia/protocol';
import { HERMES_PROFILE_PATTERN, HermesAdapter, type HermesResult } from '@extalia/runtime';
import { spawn, type ChildProcess } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/**
 * Runs Hermes Agent as a managed runtime: one `hermes chat` process per
 * prompt, without a shell, in the workspace folder, with a minimal environment.
 * Discovery reads only the executable location and profile directory names.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** Variables Hermes needs to find its home, locale and tools. Extalia's own settings and secrets are never passed on. */
const PASSED_VARIABLES = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ', 'TMPDIR', 'TEMP', 'TMP',
  'HERMES_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
];
export const HERMES_KILL_GRACE_MS = 3_000;
const STDERR_LIMIT = 8_000;
const NOISE_LIMIT = 4_000;
const LINE_LIMIT = 8 * 1024 * 1024;
const ERROR_LIMIT = 2_000;

export function hermesEnvironment(env: Env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of PASSED_VARIABLES) if (env[name] !== undefined) result[name] = env[name]!;
  // Plain, UTF-8 diagnostics: they become the error message of a failed turn.
  return { ...result, NO_COLOR: '1', PYTHONIOENCODING: 'utf-8' };
}

async function isExecutable(file: string): Promise<boolean> {
  try { await access(file, fsConstants.X_OK); return true; } catch { return false; }
}

/**
 * `EXTALIA_HERMES_BIN`, else `hermes` on PATH, else the per-user install folder
 * (`~/.local/bin`), which apps started from the Dock or Start menu usually lack
 * on their PATH. Nothing is executed to find it.
 */
export async function findHermes(env: Env, homeDirectory?: string, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  const override = env.EXTALIA_HERMES_BIN?.trim();
  if (override) return path.isAbsolute(override) && await isExecutable(override) ? override : undefined;
  const names = platform === 'win32' ? ['hermes.exe', 'hermes'] : ['hermes'];
  const directories = (env.PATH ?? '').split(platform === 'win32' ? ';' : ':').filter(item => path.isAbsolute(item));
  if (homeDirectory && platform !== 'win32') directories.push(path.join(homeDirectory, '.local', 'bin'));
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Hermes' root home: `HERMES_HOME` (or its root when it names a profile), else `~/.hermes`. */
export function hermesRoot(env: Env, homeDirectory: string): string {
  const configured = env.HERMES_HOME?.trim();
  if (!configured) return path.join(homeDirectory, '.hermes');
  return path.basename(path.dirname(configured)) === 'profiles' ? path.dirname(path.dirname(configured)) : configured;
}

/** `default` plus the profile directory names; no profile file is opened. */
export async function hermesProfiles(env: Env, homeDirectory: string): Promise<string[]> {
  const names = new Set(['default']);
  try {
    const entries = await readdir(path.join(hermesRoot(env, homeDirectory), 'profiles'), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && HERMES_PROFILE_PATTERN.test(entry.name)) names.add(entry.name);
    }
  } catch { /* no named profiles */ }
  return [...names];
}

export async function discoverRuntimes(env: Env, homeDirectory: string): Promise<RuntimeInfo[]> {
  const executable = await findHermes(env, homeDirectory);
  return [
    { id: 'extalia-native', available: true, profiles: [] },
    { id: 'hermes', available: Boolean(executable), profiles: executable ? await hermesProfiles(env, homeDirectory) : [] },
  ];
}

export interface HermesTurnOptions {
  executable: string;
  cwd: string;
  prompt: string;
  profile: string;
  model?: string;
  resumeSessionId?: string;
  yolo: boolean;
  env: Env;
  signal: AbortSignal;
  emit: (body: EventBody) => void;
  /** Time between SIGTERM and SIGKILL when the turn is stopped. */
  killGraceMs?: number;
}

export interface HermesTurnResult {
  outcome: 'completed' | 'failed' | 'cancelled';
  /** Hermes' session id, once Hermes has actually worked on it (safe to resume). */
  sessionId?: string;
}

/** Strip terminal escapes and Hermes' own `session_id:` trailer from diagnostics. */
function cleanDiagnostics(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').split(/\r?\n/).filter(line => line.trim() && !/^session_id:/.test(line.trim())).join('\n').trim();
}

const tail = (value: string, limit: number) => value.length > limit ? value.slice(-limit) : value;

function signalProcess(pid: number, signal: NodeJS.Signals, group: boolean): void {
  try { process.kill(group ? -pid : pid, signal); } catch { /* already gone */ }
}

/** Ask Hermes to stop (it interrupts its tools on SIGTERM), then kill its process group. */
function terminate(child: ChildProcess, graceMs: number, exited: () => boolean): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    return;
  }
  signalProcess(pid, 'SIGTERM', false);
  setTimeout(() => { if (!exited()) { signalProcess(pid, 'SIGKILL', true); signalProcess(pid, 'SIGKILL', false); } }, graceMs).unref();
}

/**
 * Run one prompt through Hermes and report it as protocol bodies, ending with
 * `turn.completed` or `turn.failed` and `agent.state: idle`.
 */
export async function runHermesTurn(options: HermesTurnOptions): Promise<HermesTurnResult> {
  const { emit, signal } = options;
  const adapter = new HermesAdapter();
  const plan = adapter.plan({
    cwd: options.cwd, prompt: options.prompt, profile: options.profile, yolo: options.yolo,
    ...(options.model ? { model: options.model } : {}),
    ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
  });
  const parse = adapter.createStreamParser();
  const finish = (outcome: HermesTurnResult['outcome'], extra: { error?: string; result?: HermesResult; model?: string } = {}) => {
    if (outcome === 'completed') emit({ type: 'turn.completed', ...(extra.model ? { model: extra.model } : {}), ...(extra.result?.usage ? { usage: extra.result.usage } : {}) });
    else emit({ type: 'turn.failed', error: extra.error ?? 'Stopped by the user.' });
    emit({ type: 'agent.state', state: 'idle' });
  };
  if (signal.aborted) { finish('cancelled'); return { outcome: 'cancelled' }; }

  emit({ type: 'agent.state', state: 'working', summary: 'Hermes Agent' });
  const child = spawn(options.executable, plan.args, {
    cwd: options.cwd,
    env: hermesEnvironment(options.env),
    shell: false,
    // Its own process group, so a stop can reach everything Hermes started.
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let sessionId: string | undefined, model: string | undefined, result: HermesResult | undefined;
  let worked = false, stderr = '', noise = '', partial = '';
  const decoder = new StringDecoder('utf8'), errors = new StringDecoder('utf8');
  const line = (raw: string) => {
    const update = parse(raw);
    if (!update) { if (raw.trim()) noise = tail(`${noise}${raw}\n`, NOISE_LIMIT); return; }
    if (update.sessionId) sessionId = update.sessionId;
    if (update.model) model = update.model;
    if (update.result) result = update.result;
    for (const body of update.events) {
      if (body.type !== 'agent.state') worked = true;
      emit(body.type === 'file.written' ? { ...body, path: displayPath(options.cwd, body.path) } : body);
    }
  };
  const read = (text: string) => {
    partial += text;
    let cut: number;
    while ((cut = partial.indexOf('\n')) !== -1) { line(partial.slice(0, cut)); partial = partial.slice(cut + 1); }
    if (partial.length > LINE_LIMIT) partial = '';
  };
  child.stdout?.on('data', (chunk: Buffer) => read(decoder.write(chunk)));
  child.stderr?.on('data', (chunk: Buffer) => { stderr = tail(stderr + errors.write(chunk), STDERR_LIMIT); });
  child.stdin?.on('error', () => { /* Hermes exited before reading the prompt; its exit explains why. */ });
  child.stdin?.end(plan.stdin);

  let exited = false, cancelled = false;
  const onAbort = () => { cancelled = true; terminate(child, options.killGraceMs ?? HERMES_KILL_GRACE_MS, () => exited); };
  signal.addEventListener('abort', onAbort, { once: true });

  let spawnError: Error | undefined;
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    let done = false;
    const settle = (code: number | null, by: NodeJS.Signals | null) => { if (!done) { done = true; resolve({ code, signal: by }); } };
    child.on('error', error => { spawnError = error; settle(null, null); });
    child.on('close', settle);
    // Something Hermes started may keep the pipes open; do not wait for it forever.
    child.on('exit', (code, by) => { exited = true; setTimeout(() => settle(code, by), 1_000).unref(); });
  });
  exited = true;
  signal.removeEventListener('abort', onAbort);
  child.stdout?.destroy();
  child.stderr?.destroy();
  read(decoder.end());
  if (partial) { line(partial); partial = ''; }
  stderr = tail(stderr + errors.end(), STDERR_LIMIT);

  const resumable = sessionId && (worked || result?.exitCode === 0) ? { sessionId } : {};
  if (cancelled) { finish('cancelled'); return { outcome: 'cancelled', ...resumable }; }
  if (spawnError) {
    finish('failed', { error: `Hermes Agent could not be started: ${spawnError.message}` });
    return { outcome: 'failed' };
  }
  // Without the terminal `result` record the run did not finish, whatever the exit code.
  if (result?.exitCode === 0) {
    finish('completed', { result, ...(model ? { model } : {}) });
    return { outcome: 'completed', ...resumable };
  }
  const detail = cleanDiagnostics(stderr) || cleanDiagnostics(noise);
  const reason = result?.error ?? (result ? undefined : exit.signal ? `Hermes Agent was stopped (${exit.signal}).` : `Hermes Agent exited with code ${exit.code ?? 1}.`);
  const message = [reason, detail && tail(detail, ERROR_LIMIT)].filter(Boolean).join('\n') || `Hermes Agent exited with code ${result?.exitCode ?? exit.code ?? 1}.`;
  finish('failed', { error: safeText(message, ERROR_LIMIT + 400) });
  return { outcome: 'failed', ...resumable };
}

/** Paths inside the workspace are shown relative to it, like Extalia Native's. */
function displayPath(root: string, file: string): string {
  if (!path.isAbsolute(file)) return file;
  const relative = path.relative(root, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : file;
}

/** First Hermes prompt of a continued session: the carried conversation as context, then the request. */
export function continuationPrompt(origin: { source: string; title: string }, history: readonly { role: string; text?: string }[], prompt: string): string {
  const messages = history
    .filter(message => (message.role === 'user' || message.role === 'assistant') && message.text?.trim())
    .map(message => `${message.role === 'user' ? 'User' : 'Assistant'}:\n${message.text!.trim()}`);
  if (!messages.length) return prompt;
  return [
    `This session continues "${origin.title.replace(/["\n]/g, ' ')}", a conversation that started in ${origin.source}. ` +
      'Its earlier messages follow as context; the other agent\'s tool calls and their output are not included.',
    '<earlier-conversation>', messages.join('\n\n'), '</earlier-conversation>',
    '', 'The new request:', prompt,
  ].join('\n');
}
