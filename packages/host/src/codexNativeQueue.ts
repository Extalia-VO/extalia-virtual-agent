import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ObservedCodexNativeQueueItem } from '@extalia/platform';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const TIMEOUT_MS = 10_000;
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
const bounded = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit && !value.includes('\0');

export interface CodexNativeQueueOptions {
  bin: string;
  /** The host resolves this exact source profile; no fallback profile is permitted. */
  codexHome: string;
  env: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  threadId: string;
  signal?: AbortSignal;
}
export interface CodexNativeQueueResult { items: ObservedCodexNativeQueueItem[]; truncated?: boolean }
export class CodexNativeQueueError extends Error {
  constructor(readonly state: 'unavailable' | 'unsupported' = 'unavailable', readonly cleanupUnconfirmed = false) {
    super(state === 'unsupported' ? 'Native Codex queue inspection is unsupported.' : 'Native Codex queue inspection is unavailable.');
    this.name = 'CodexNativeQueueError';
  }
}

/** Installed Codex 0.167 queue projection. Attachment values and text spans never cross this boundary. */
function project(value: unknown): CodexNativeQueueResult {
  const page = object(value);
  if (!page || !Array.isArray(page.data) || page.data.length > 50 || page.nextCursor !== undefined && page.nextCursor !== null && !bounded(page.nextCursor, 4096)) throw new CodexNativeQueueError();
  let remaining = MAX_TEXT_BYTES;
  let truncated = typeof page.nextCursor === 'string';
  const ids = new Set<string>();
  const items = page.data.map((value): ObservedCodexNativeQueueItem => {
    const entry = object(value);
    if (!entry || !bounded(entry.id, 256) || ids.has(entry.id) || !bounded(entry.clientUserMessageId, 256) || !Array.isArray(entry.input) || entry.input.length > 1024) throw new CodexNativeQueueError();
    ids.add(entry.id);
    let text = '', nonTextItems = 0, clipped = false;
    for (const value of entry.input) {
      const input = object(value);
      if (!input || typeof input.type !== 'string') throw new CodexNativeQueueError();
      if (input.type === 'text') {
        if (typeof input.text !== 'string' || input.text.includes('\0')) throw new CodexNativeQueueError();
        if (clipped) continue;
        const source = (text && input.text ? '\n' : '') + input.text;
        for (const char of source) {
          const bytes = Buffer.byteLength(char);
          if (text.length + char.length > 16_000 || bytes > remaining) { clipped = true; break; }
          text += char; remaining -= bytes;
        }
      } else {
        // Validate known discriminants without returning private attachment paths, URLs or names.
        const valid = ['image', 'audio'].includes(input.type) ? true
          : ['localImage', 'localAudio'].includes(input.type) ? bounded(input.path, 4096)
            : ['skill', 'mention'].includes(input.type) && bounded(input.path, 4096) && bounded(input.name, 4096);
        if (!valid) throw new CodexNativeQueueError('unsupported');
        nonTextItems++;
      }
    }
    if (clipped) truncated = true;
    return { id: entry.id, text, nonTextItems, ...(clipped ? { truncated: true } : {}) };
  });
  return { items, ...(truncated ? { truncated: true } : {}) };
}

/** A disposable public stdio client: initialize, initialized, queue/list, then actual child cleanup. */
export async function readCodexNativeQueue(options: CodexNativeQueueOptions, limits: { timeoutMs?: number } = {}): Promise<CodexNativeQueueResult> {
  const timeoutMs = limits.timeoutMs ?? TIMEOUT_MS;
  if (!bounded(options.threadId, 36) || !UUID.test(options.threadId) || !bounded(options.bin, 4096)
    || !bounded(options.codexHome, 4096) || !path.isAbsolute(options.codexHome)
    || options.cwd !== undefined && (!bounded(options.cwd, 4096) || !path.isAbsolute(options.cwd))
    || !options.env || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS || options.signal?.aborted) throw new CodexNativeQueueError();
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.bin, ['app-server', '--listen', 'stdio://'], {
        env: { ...options.env, CODEX_HOME: options.codexHome }, cwd: options.cwd ?? options.codexHome,
        stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
      });
    } catch { reject(new CodexNativeQueueError()); return; }
    let frame: Buffer = Buffer.alloc(0), bytes = 0, stderrBytes = 0, notifications = 0;
    let phase: 'initialize' | 'queue' = 'initialize';
    let stopping = false, settled = false, result: CodexNativeQueueResult | undefined, failure: CodexNativeQueueError | undefined;
    let killTimer: NodeJS.Timeout | undefined, reapTimer: NodeJS.Timeout | undefined;
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); clearTimeout(reapTimer); options.signal?.removeEventListener('abort', abort); };
    const finish = (unconfirmed = false) => {
      if (settled) return;
      settled = true; cleanup();
      if (unconfirmed || failure || !result) reject(unconfirmed ? new CodexNativeQueueError('unavailable', true) : failure ?? new CodexNativeQueueError());
      else resolve(result);
    };
    const stop = (error?: CodexNativeQueueError) => {
      if (settled) return;
      if (error) { failure = error; result = undefined; }
      if (stopping) return;
      stopping = true; frame = Buffer.alloc(0); child.stdin?.end();
      // End of input is sufficient for conforming stdio servers; a bounded watchdog owns stragglers.
      killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 250);
      reapTimer = setTimeout(() => {
        child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); finish(true);
      }, 2250);
    };
    const abort = () => stop(new CodexNativeQueueError());
    const timer = setTimeout(abort, timeoutMs);
    const write = (message: ObjectValue) => {
      if (stopping || settled) return;
      child.stdin?.write(JSON.stringify(message) + '\n', error => { if (error) abort(); });
    };
    const receive = (line: Buffer) => {
      let message: ObjectValue | undefined;
      try { message = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))); }
      catch { abort(); return; }
      if (!message) { abort(); return; }
      if (typeof message.method === 'string') {
        // Never answer an app-server callback, including approvals or provider/auth requests.
        if (message.id !== undefined || ++notifications > 128) abort();
        return;
      }
      if (message.id !== (phase === 'initialize' ? 1 : 2)) { abort(); return; }
      if (message.error !== undefined) {
        const error = object(message.error);
        stop(new CodexNativeQueueError(error?.code === -32601 || error?.code === -32602 ? 'unsupported' : 'unavailable')); return;
      }
      if (!object(message.result)) { abort(); return; }
      if (phase === 'initialize') {
        phase = 'queue';
        write({ method: 'initialized', params: {} });
        write({ id: 2, method: 'thread/queue/list', params: { threadId: options.threadId, limit: 50 } });
      } else {
        try { result = project(message.result); stop(); }
        catch (error) { stop(error instanceof CodexNativeQueueError ? error : new CodexNativeQueueError()); }
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stopping || settled) return;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { abort(); return; }
      frame = Buffer.concat([frame, chunk]);
      while (!stopping) {
        const end = frame.indexOf(10);
        if (end < 0) { if (frame.length > MAX_FRAME_BYTES) abort(); break; }
        if (end > MAX_FRAME_BYTES) { abort(); break; }
        const line = frame.subarray(0, end); frame = frame.subarray(end + 1);
        if (line.length) receive(line);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => { if (!stopping && (stderrBytes += chunk.length) > 64 * 1024) abort(); });
    child.stdin?.on('error', () => { if (!stopping) abort(); });
    child.stdout?.on('error', abort); child.stderr?.on('error', abort);
    child.once('error', abort);
    child.once('close', (code, signal) => {
      // SIGKILL is our cleanup watchdog, not evidence that a partial reply succeeded.
      if (!stopping || code !== 0 && signal !== 'SIGKILL') failure ??= new CodexNativeQueueError();
      finish();
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    else write({ id: 1, method: 'initialize', params: { clientInfo: { name: 'extalia_queue_observer', version: '1' }, capabilities: { experimentalApi: true } } });
  });
}
