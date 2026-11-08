import { spawn } from 'node:child_process';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OUTPUT_LIMIT = 8192;
const TIMEOUT = 10_000;

export interface CodexQueueOptions {
  bin: string;
  /** Supply the authoritative profile environment; this is passed without merging. */
  env?: NodeJS.ProcessEnv;
  threadId: string;
  text: string;
  signal?: AbortSignal;
}
export interface CodexQueueResult {
  state: 'queued' | 'unknown';
  messageId?: string;
}

/** A failed command can have persisted its message. Never automatically retry it. */
export class CodexQueueError extends Error {
  readonly state = 'unknown' as const;
  constructor(message = 'Codex queue status is unknown. Check the native queue before retrying.', readonly cleanupUnconfirmed = false) {
    super(message); this.name = 'CodexQueueError';
  }
}

/** Persist text through the public CLI only. Never resume, start, or steer an engine. */
export async function queueCodexMessage(
  options: CodexQueueOptions,
  limits: { timeoutMs?: number } = {},
): Promise<CodexQueueResult> {
  if (typeof options.threadId !== 'string' || options.threadId.length !== 36 || !UUID.test(options.threadId)) throw new Error('A Codex thread UUID is required.');
  if (typeof options.text !== 'string' || !options.text.trim() || options.text.length > 16_000 || options.text.includes('\0')) throw new Error('Codex queue text must contain 1–16000 characters without null bytes.');
  if (typeof options.bin !== 'string' || !options.bin.trim() || options.bin.includes('\0')) throw new Error('A Codex executable is required.');
  const timeout = limits.timeoutMs ?? TIMEOUT;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > TIMEOUT) throw new Error('Invalid Codex queue timeout.');
  if (options.signal?.aborted) throw new CodexQueueError('Codex queue cancelled before submission.');

  return new Promise<CodexQueueResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.bin, ['queue', '--thread', options.threadId, '--message', options.text], {
        env: options.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
      });
    } catch { reject(new CodexQueueError()); return; }
    let stdout = Buffer.alloc(0);
    let bytes = 0;
    let stopping = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let reapTimer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(reapTimer);
      options.signal?.removeEventListener('abort', stop);
    };
    const fail = (message?: string, cleanupUnconfirmed = false) => {
      if (settled) return;
      settled = true; cleanup(); reject(new CodexQueueError(message, cleanupUnconfirmed));
    };
    const stop = () => {
      if (stopping || settled) return;
      stopping = true;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 250);
      reapTimer = setTimeout(() => {
        child.stdout?.destroy(); child.stderr?.destroy();
        fail('Codex queue status and child cleanup are unconfirmed. Do not retry automatically.', true);
      }, 2000);
    };
    const timer = setTimeout(stop, timeout);
    const read = (chunk: Buffer, output: boolean) => {
      if (stopping || settled) return;
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) { stop(); return; }
      if (output) stdout = Buffer.concat([stdout, chunk]);
    };
    child.stdout?.on('data', (chunk: Buffer) => read(chunk, true));
    child.stderr?.on('data', (chunk: Buffer) => read(chunk, false));
    child.once('error', stop);
    child.once('close', (code, signal) => {
      if (settled) return;
      if (stopping || code !== 0 || signal !== null) { fail(); return; }
      settled = true; cleanup();
      const match = /^Queued message ([0-9a-fA-F-]+) for thread ([0-9a-fA-F-]+)\.$/.exec(stdout.toString('utf8').trim());
      if (!match || !UUID.test(match[1]!) || match[2] !== options.threadId) { resolve({ state: 'unknown' }); return; }
      resolve({ state: 'queued', messageId: match[1] });
    });
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) stop();
  });
}
