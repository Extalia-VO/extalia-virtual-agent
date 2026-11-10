import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  PROVIDER_COMPLETE_SCHEMA, PROVIDER_COMPLETE_MAX_REQUEST_BYTES, PROVIDER_COMPLETE_MAX_FRAME_BYTES,
  parseProviderCompleteFrame, type ProviderCompleteFrame,
} from '@extalia/protocol';
import { ProviderError, type OpenAICompletionPort } from '@extalia/runtime';
import type { ModelDiscoveryProcess, SpawnModelDiscovery } from './modelDiscovery.js';

type Completion = Awaited<ReturnType<OpenAICompletionPort>>;
interface Pending { abort(): void; done: Promise<Completion> }
const unavailable = (reason: string) => new ProviderError(`Native provider completion is unavailable (${reason}).`, undefined, false);
const spawnChild: SpawnModelDiscovery = (binary, args, options) => spawn(binary, args, {
  ...options, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});

/** Count JSON bytes without materializing or escaping the large strings twice. */
function stringBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) bytes += 2;
    else if (code < 32) bytes += 6;
    else if (code < 128) bytes++;
    else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index++; } else bytes += 6;
    } else bytes += code >= 0xdc00 && code <= 0xdfff ? 6 : 3;
  }
  return bytes;
}

/** Copy containers once, retaining immutable strings; later caller mutation cannot change the admitted request. */
export function snapshotJson(value: unknown, ancestors = new Set<object>(), depth = 0): { value: unknown; bytes: number } {
  if (depth > 256) throw unavailable('invalid_request');
  if (typeof value === 'string') return { value, bytes: stringBytes(value) };
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
    return { value, bytes: JSON.stringify(value).length };
  }
  if (typeof value !== 'object' || value === null || ancestors.has(value)) throw unavailable('invalid_request');
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw unavailable('invalid_request');
  ancestors.add(value);
  let bytes = 2, count = 0;
  const copy: unknown[] | Record<string, unknown> = array ? [] : Object.create(null);
  const keys = array ? undefined : Object.keys(value);
  const length = array ? value.length : keys!.length;
  for (let index = 0; index < length; index++) {
    const key = array ? String(index) : keys![index]!;
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !('value' in property)) throw unavailable('invalid_request');
    if (!array && property.value === undefined) continue;
    const child = snapshotJson(property.value, ancestors, depth + 1);
    bytes += (count++ ? 1 : 0) + (array ? 0 : stringBytes(key) + 1) + child.bytes;
    if (bytes > PROVIDER_COMPLETE_MAX_REQUEST_BYTES) throw unavailable('request_too_large');
    if (array) (copy as unknown[]).push(child.value);
    else (copy as Record<string, unknown>)[key] = child.value;
  }
  ancestors.delete(value);
  return { value: copy, bytes };
}

/** Bounded string fragments preserve surrogate pairs at every slice boundary. */
export function* jsonChunks(value: unknown, depth = 0): Generator<string> {
  if (depth > 256) throw unavailable('invalid_request');
  if (typeof value === 'string') {
    yield '"';
    for (let start = 0; start < value.length;) {
      let end = Math.min(start + 4096, value.length);
      const last = value.charCodeAt(end - 1);
      if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
      yield JSON.stringify(value.slice(start, end)).slice(1, -1);
      start = end;
    }
    yield '"';
  } else if (value === null || typeof value === 'boolean' || typeof value === 'number') yield JSON.stringify(value);
  else if (Array.isArray(value)) {
    yield '[';
    for (let index = 0; index < value.length; index++) {
      if (index) yield ',';
      yield* jsonChunks(value[index], depth + 1);
    }
    yield ']';
  } else if (value && typeof value === 'object') {
    yield '{';
    let first = true;
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      if (!first) yield ',';
      first = false;
      yield* jsonChunks(key, depth + 1); yield ':'; yield* jsonChunks(item, depth + 1);
    }
    yield '}';
  } else throw unavailable('invalid_request');
}

/** One owned Rust HTTP child per admitted completion, with no waiting queue or replay. */
export class RustCompletion {
  private readonly pending = new Set<Pending>();
  private bytes = 0;
  private closed = false;

  constructor(private readonly options: {
    binary(): string | undefined;
    directory: string;
    clientVersion: string;
    env?: Readonly<Record<string, string | undefined>>;
    spawn?: SpawnModelDiscovery;
    timeoutMs?: number;
    startupGraceMs?: number;
    maxActive?: number;
    maxInputBytes?: number;
  }) {}

  get pendingCount(): number { return this.pending.size; }
  get reservedBytes(): number { return this.bytes; }

  readonly complete: OpenAICompletionPort = (connection, request, requestUsage) => {
    if (this.closed || request.signal?.aborted) return Promise.reject(unavailable('cancelled'));
    if (this.pending.size >= (this.options.maxActive ?? 32)) return Promise.reject(unavailable('busy'));
    const binary = this.options.binary();
    if (!binary) return Promise.reject(unavailable('binary_missing'));
    const timeoutMs = this.options.timeoutMs ?? 600_000;
    const requestId = randomUUID();
    const envelope = { schema: PROVIDER_COMPLETE_SCHEMA, requestId, clientVersion: this.options.clientVersion.slice(0, 64),
      connection, system: request.system, messages: request.messages, tools: request.tools, timeoutMs, requestUsage };
    let reserved: number, payload: unknown;
    try { const snapshot = snapshotJson(envelope); reserved = snapshot.bytes; payload = snapshot.value; } catch (error) { return Promise.reject(error instanceof ProviderError ? error : unavailable('invalid_request')); }
    if (reserved > PROVIDER_COMPLETE_MAX_REQUEST_BYTES) return Promise.reject(unavailable('request_too_large'));
    if (reserved + this.bytes > (this.options.maxInputBytes ?? 256 * 1024 * 1024)) return Promise.reject(unavailable('busy'));
    const env: Record<string, string> = {};
    for (const key of ['SystemRoot', 'windir', 'TMPDIR', 'TEMP', 'TMP']) {
      const value = this.options.env?.[key]; if (value) env[key] = value;
    }
    let child: ModelDiscoveryProcess;
    try { child = (this.options.spawn ?? spawnChild)(binary, ['--provider-complete'], { cwd: this.options.directory, env }); }
    catch { return Promise.reject(unavailable('spawn_failed')); }
    const operation: Pending = { abort: () => undefined, done: Promise.resolve({ result: { text: '', toolCalls: [], stop: 'end' } }) };
    this.pending.add(operation); this.bytes += reserved;
    let abort!: () => void;
    const done = new Promise<Completion>((resolve, reject) => {
      let failure: ProviderError | undefined, finished = false, spawned = false, inputDone = false;
      let terminal: ProviderCompleteFrame | undefined, seq = 0, stderrBytes = 0, outputBytes = 0;
      const header = Buffer.alloc(4);
      let headerBytes = 0, frameSize = 0, frameBytes = 0, frameBuffer = Buffer.alloc(0);
      const stop = (reason: string) => {
        failure ??= unavailable(reason);
        // Kill is a request, never settlement. Ownership survives all failures until close.
        try { child.kill('SIGKILL'); } catch { /* Keep admission if process settlement is unknown. */ }
      };
      abort = () => stop('cancelled');
      const timer = setTimeout(() => stop('timeout'), timeoutMs + (this.options.startupGraceMs ?? 1000));
      const finish = (code: number | null) => {
        if (finished) return;
        finished = true; clearTimeout(timer); request.signal?.removeEventListener('abort', abort);
        this.pending.delete(operation); this.bytes -= reserved;
        if (failure || code !== 0) { reject(failure ?? unavailable('process_failed')); return; }
        if (!inputDone || !terminal || headerBytes || frameBytes) { reject(unavailable('invalid_response')); return; }
        if (terminal.kind === 'result') resolve({ result: terminal.result, ...(terminal.streamOptionsRejected ? { streamOptionsRejected: true } : {}) });
        else if (terminal.kind === 'error') {
          const message = terminal.code === 'http_error' ? `The endpoint returned ${terminal.status}.` : `Native provider completion failed (${terminal.code}).`;
          reject(new ProviderError(message, terminal.status, terminal.retryable));
        } else reject(unavailable('invalid_response'));
      };
      child.once('spawn', () => { spawned = true; });
      child.once('error', () => {
        failure ??= unavailable('spawn_failed');
        if (!spawned && child.pid === undefined) finish(null); else stop('process_failed');
      });
      child.once('close', (code: number | null) => finish(code));
      child.stdout.on('data', (chunk: Buffer) => {
        if (failure || finished) return;
        outputBytes += chunk.length;
        if (outputBytes > 256 * 1024 * 1024) { stop('output_limit'); return; }
        let offset = 0;
        while (offset < chunk.length && !failure) {
          if (terminal) { stop('invalid_response'); return; }
          if (headerBytes < 4) {
            const count = Math.min(4 - headerBytes, chunk.length - offset);
            chunk.copy(header, headerBytes, offset, offset + count); headerBytes += count; offset += count;
            if (headerBytes < 4) continue;
            frameSize = header.readUInt32LE(0);
            if (!frameSize || frameSize > PROVIDER_COMPLETE_MAX_FRAME_BYTES) { stop('output_limit'); return; }
            frameBuffer = Buffer.allocUnsafe(frameSize);
          }
          const count = Math.min(frameSize - frameBytes, chunk.length - offset);
          if (count) { chunk.copy(frameBuffer, frameBytes, offset, offset + count); frameBytes += count; offset += count; }
          if (frameBytes !== frameSize) continue;
          let frame: ProviderCompleteFrame | undefined;
          try { frame = parseProviderCompleteFrame(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frameBuffer))); }
          catch { /* Untrusted output never supplies evidence or diagnostics. */ }
          frameBuffer = Buffer.alloc(0); frameBytes = 0; headerBytes = 0;
          if (!frame || frame.requestId !== requestId || frame.seq !== seq++) { stop('invalid_response'); return; }
          if (frame.kind === 'delta') {
            try { request.onText?.(frame.text); } catch { stop('callback_failed'); }
          } else terminal = frame;
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > 4096) stop('output_limit');
      });
      child.stdin.on('error', () => stop('input_failed'));
      child.stdout.on('error', () => stop('output_failed'));
      child.stderr.on('error', () => stop('output_failed'));
      request.signal?.addEventListener('abort', abort, { once: true });
      if (request.signal?.aborted) abort();
      else void (async () => {
        let bytes = 0, pending: string[] = [], characters = 0;
        const flush = async () => {
          if (failure || finished) throw unavailable('cancelled');
          const buffer = Buffer.from(pending.join('')); pending = []; characters = 0;
          bytes += buffer.length;
          // A caller mutating its request cannot exceed its original byte reservation.
          if (bytes > reserved || bytes > PROVIDER_COMPLETE_MAX_REQUEST_BYTES) throw unavailable('request_too_large');
          // Waiting for the write callback bounds the outstanding stdin buffer even under backpressure.
          await new Promise<void>((written, failed) => child.stdin.write(buffer, error => error ? failed(error) : written()));
        };
        try {
          for (const chunk of jsonChunks(payload)) {
            pending.push(chunk); characters += chunk.length;
            if (characters >= 8192) await flush();
          }
          if (characters) await flush();
          if (!failure && !finished) { inputDone = true; child.stdin.end(); }
        } catch { if (!finished) stop('input_failed'); }
      })();
    });
    operation.abort = abort; operation.done = done;
    return done;
  };

  async close(): Promise<void> {
    this.closed = true;
    for (const operation of this.pending) operation.abort();
    await Promise.allSettled([...this.pending].map(operation => operation.done));
  }
}
