import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  PROVIDER_COMPLETE_SCHEMA, PROVIDER_COMPLETE_MAX_REQUEST_BYTES, PROVIDER_COMPLETE_MAX_FRAME_BYTES,
  PROVIDER_WORKER_SCHEMA, parseProviderWorkerFrame, type ProviderWorkerFrame,
} from '@extalia/protocol';
import { ProviderError, type OpenAICompletionPort } from '@extalia/runtime';
import type { ModelDiscoveryProcess, SpawnModelDiscovery } from './modelDiscovery.js';
import { snapshotJson, jsonChunks } from './completion.js';

type Completion = Awaited<ReturnType<OpenAICompletionPort>>;
type Terminal = Extract<ProviderWorkerFrame, { kind: 'result' | 'error' }>;
interface Operation {
  id: string;
  worker?: Worker;
  bytes: number;
  source: Generator<Buffer> | undefined;
  stage: 'begin' | 'chunks' | 'sent';
  seq: number;
  outputBytes: number;
  inputBytes: number;
  onText?: (text: string) => void;
  terminal?: Terminal;
  failure?: ProviderError;
  cancelSent: boolean;
  commitSent: boolean;
  signal?: AbortSignal;
  abort(): void;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: Completion): void;
  reject(error: ProviderError): void;
}
interface Worker {
  id: string;
  child: ModelDiscoveryProcess;
  ready: boolean;
  spawned: boolean;
  closed: boolean;
  stopping: boolean;
  retiring: boolean;
  admissions: number;
  shutdownSent: boolean;
  writing: boolean;
  failure?: ProviderError;
  timer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  done: Promise<void>;
  finishClose(): void;
}
const unavailable = (reason: string) => new ProviderError(`Native provider completion is unavailable (${reason}).`, undefined, false);
const spawnChild: SpawnModelDiscovery = (binary, args, options) => spawn(binary, args, {
  ...options, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
const CHUNK_BYTES = 16 * 1024;

/** Each yielded buffer is bounded; JSON strings are immutable references in the admitted snapshot. */
function* inputChunks(payload: unknown): Generator<Buffer> {
  let output = Buffer.allocUnsafe(CHUNK_BYTES), length = 0;
  for (const text of jsonChunks(payload)) {
    const bytes = Buffer.from(text);
    for (let offset = 0; offset < bytes.length;) {
      const count = Math.min(CHUNK_BYTES - length, bytes.length - offset);
      bytes.copy(output, length, offset, offset + count); length += count; offset += count;
      if (length === CHUNK_BYTES) { yield output; output = Buffer.allocUnsafe(CHUNK_BYTES); length = 0; }
    }
  }
  if (length) yield output.subarray(0, length);
}
function control(worker: Worker, op: string, requestId?: string, bytes?: number): Buffer {
  return Buffer.concat([Buffer.from(op), Buffer.from(JSON.stringify({ schema: PROVIDER_WORKER_SCHEMA,
    workerId: worker.id, ...(requestId ? { requestId } : {}), ...(bytes !== undefined ? { bytes } : {}) }))]);
}

/** Isolated shared Rust HTTP process. A terminal reply is held until its runtime-join receipt. */
export class RustCompletionWorker {
  private readonly pending = new Map<string, Operation>();
  private bytes = 0;
  private closed = false;
  private worker?: Worker;
  private cursor = 0;

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
    idleTtlMs?: number;
  }) {}

  get pendingCount(): number { return this.pending.size; }
  get reservedBytes(): number { return this.bytes; }
  get processCount(): number { return this.worker ? 1 : 0; }

  readonly complete: OpenAICompletionPort = (connection, request, requestUsage) => {
    if (this.closed || request.signal?.aborted) return Promise.reject(unavailable('cancelled'));
    if (this.worker?.failure) return Promise.reject(unavailable('worker_draining'));
    if (this.pending.size >= (this.options.maxActive ?? 32)) return Promise.reject(unavailable('busy'));
    const requestId = randomUUID(), timeoutMs = this.options.timeoutMs ?? 600_000;
    let payload: unknown, bytes: number;
    try {
      const snapshot = snapshotJson({ schema: PROVIDER_COMPLETE_SCHEMA, requestId, clientVersion: this.options.clientVersion.slice(0, 64),
        connection, system: request.system, messages: request.messages, tools: request.tools, timeoutMs, requestUsage });
      payload = snapshot.value; bytes = snapshot.bytes;
    } catch (error) { return Promise.reject(error instanceof ProviderError ? error : unavailable('invalid_request')); }
    if (bytes > PROVIDER_COMPLETE_MAX_REQUEST_BYTES) return Promise.reject(unavailable('request_too_large'));
    if (this.bytes + bytes > (this.options.maxInputBytes ?? 256 * 1024 * 1024)) return Promise.reject(unavailable('busy'));
    const done = new Promise<Completion>((resolve, reject) => {
      const operation: Operation = {
        id: requestId, bytes, source: inputChunks(payload), stage: 'begin', seq: 0, outputBytes: 0, inputBytes: 0, cancelSent: false, commitSent: false, onText: request.onText,
        signal: request.signal, resolve, reject,
        abort: () => this.cancel(operation, 'cancelled'),
        timer: setTimeout(() => {
          if (operation.worker) this.fail(operation.worker, 'timeout');
          else this.cancel(operation, 'timeout');
        }, timeoutMs + (this.options.startupGraceMs ?? 1000)),
      };
      this.pending.set(requestId, operation); this.bytes += bytes;
      request.signal?.addEventListener('abort', operation.abort, { once: true });
      if (request.signal?.aborted) operation.abort();
      this.activateWaiting();
    });
    return done;
  };

  /** Waiting operations have never entered a worker: retirement is a handoff, never a replay. */
  private activateWaiting(): void {
    if (this.closed || ![...this.pending.values()].some(operation => !operation.worker)) return;
    let worker = this.worker;
    if (worker?.stopping || worker?.retiring || worker?.failure) return;
    if (!worker) {
      try { worker = this.launch(); }
      catch (error) {
        for (const operation of [...this.pending.values()]) {
          if (operation.worker) continue;
          operation.failure = error instanceof ProviderError ? error : unavailable('spawn_failed');
          this.settle(operation);
        }
        return;
      }
    }
    if (worker.idleTimer) { clearTimeout(worker.idleTimer); worker.idleTimer = undefined; }
    for (const operation of this.pending.values()) {
      if (operation.worker) continue;
      operation.worker = worker;
      if (++worker.admissions >= 65_000) { worker.retiring = true; break; }
    }
    this.pump(worker);
  }

  private launch(): Worker {
    const binary = this.options.binary();
    if (!binary) throw unavailable('binary_missing');
    const env: Record<string, string> = {};
    for (const key of ['SystemRoot', 'windir', 'TMPDIR', 'TEMP', 'TMP']) {
      const value = this.options.env?.[key]; if (value) env[key] = value;
    }
    const id = randomUUID();
    const child = (this.options.spawn ?? spawnChild)(binary, ['--provider-worker', id], { cwd: this.options.directory, env });
    let finishClose!: () => void;
    const done = new Promise<void>(resolve => { finishClose = resolve; });
    const worker: Worker = { id, child, ready: false, spawned: false, closed: false, stopping: false,
      retiring: false, admissions: 0, shutdownSent: false, writing: false, done, finishClose };
    this.worker = worker;
    worker.timer = setTimeout(() => this.fail(worker, 'startup_timeout'), this.options.startupGraceMs ?? 1000);
    let stderrBytes = 0, headerBytes = 0, frameBytes = 0, frameSize = 0, frameBuffer = Buffer.alloc(0);
    const header = Buffer.alloc(4);
    child.once('spawn', () => { worker.spawned = true; });
    child.once('error', () => {
      if (!worker.spawned && child.pid === undefined) this.processClosed(worker);
      else this.fail(worker, 'process_failed');
    });
    child.once('close', () => this.processClosed(worker));
    child.stdout.on('data', (chunk: Buffer) => {
      if (worker.failure || worker.closed) return;
      let offset = 0;
      while (offset < chunk.length && !worker.failure) {
        if (headerBytes < 4) {
          const count = Math.min(4 - headerBytes, chunk.length - offset);
          chunk.copy(header, headerBytes, offset, offset + count); headerBytes += count; offset += count;
          if (headerBytes < 4) continue;
          frameSize = header.readUInt32LE(0);
          if (!frameSize || frameSize > PROVIDER_COMPLETE_MAX_FRAME_BYTES) { this.fail(worker, 'output_limit'); return; }
          frameBuffer = Buffer.allocUnsafe(frameSize);
        }
        const count = Math.min(frameSize - frameBytes, chunk.length - offset);
        if (count) { chunk.copy(frameBuffer, frameBytes, offset, offset + count); frameBytes += count; offset += count; }
        if (frameBytes !== frameSize) continue;
        let frame: ProviderWorkerFrame | undefined;
        try { frame = parseProviderWorkerFrame(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frameBuffer))); }
        catch { /* Never retain untrusted provider output as a diagnostic. */ }
        frameBuffer = Buffer.alloc(0); frameBytes = 0; headerBytes = 0;
        if (!frame || frame.workerId !== worker.id) { this.fail(worker, 'invalid_response'); return; }
        this.receive(worker, frame, frameSize);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 4096) this.fail(worker, 'output_limit'); });
    child.stdin.on('error', () => this.fail(worker, 'input_failed'));
    child.stdout.on('error', () => this.fail(worker, 'output_failed'));
    child.stderr.on('error', () => this.fail(worker, 'output_failed'));
    return worker;
  }

  private receive(worker: Worker, frame: ProviderWorkerFrame, size: number): void {
    if (frame.kind === 'hello') {
      if (worker.ready || worker.shutdownSent) { this.fail(worker, 'invalid_response'); return; }
      worker.ready = true; clearTimeout(worker.timer); worker.timer = undefined; this.pump(worker); return;
    }
    if (!worker.ready) { this.fail(worker, 'invalid_response'); return; }
    const operation = this.pending.get(frame.requestId);
    if (!operation || operation.worker !== worker || frame.seq !== operation.seq++) { this.fail(worker, 'invalid_response'); return; }
    operation.outputBytes += size;
    if (operation.outputBytes > 256 * 1024 * 1024) { this.fail(worker, 'output_limit'); return; }
    if (frame.kind === 'settled') {
      if (!operation.terminal) { this.fail(worker, 'invalid_response'); return; }
      this.settle(operation);
      this.idle(worker);
      this.pump(worker);
    } else if (operation.terminal || ((frame.kind === 'delta' || frame.kind === 'result') && !operation.commitSent)) this.fail(worker, 'invalid_response');
    else if (frame.kind === 'delta') {
      if (!operation.failure) {
        try { operation.onText?.(frame.text); } catch { this.cancel(operation, 'callback_failed'); }
      }
    } else operation.terminal = frame;
  }

  private settle(operation: Operation): void {
    this.pending.delete(operation.id); this.bytes -= operation.bytes;
    clearTimeout(operation.timer); operation.signal?.removeEventListener('abort', operation.abort);
    operation.source = undefined;
    if (operation.failure) { operation.reject(operation.failure); return; }
    const terminal = operation.terminal;
    if (terminal?.kind === 'result') operation.resolve({ result: terminal.result, ...(terminal.streamOptionsRejected ? { streamOptionsRejected: true } : {}) });
    else if (terminal?.kind === 'error') operation.reject(new ProviderError(terminal.code === 'http_error'
      ? `The endpoint returned ${terminal.status}.` : `Native provider completion failed (${terminal.code}).`, terminal.status, terminal.retryable));
    else operation.reject(unavailable('invalid_response'));
  }

  private cancel(operation: Operation, reason: string): void {
    if (!this.pending.has(operation.id)) return;
    operation.failure ??= unavailable(reason);
    if (operation.worker) this.pump(operation.worker);
    else this.settle(operation); // No worker admission or HTTP exists for a retirement waiter.
  }

  /** Select only one bounded frame; cancellation/control take priority over round-robin input chunks. */
  private nextFrame(worker: Worker): Buffer | undefined {
    const operations = [...this.pending.values()].filter(operation => operation.worker === worker);
    for (const operation of operations) {
      if (!operation.failure || operation.cancelSent) continue;
      if (operation.stage === 'begin') { operation.stage = 'chunks'; return control(worker, 'B', operation.id, operation.bytes); }
      operation.cancelSent = true; operation.stage = 'sent'; operation.source = undefined;
      return control(worker, 'X', operation.id);
    }
    for (const operation of operations) {
      if (operation.stage === 'begin') { operation.stage = 'chunks'; return control(worker, 'B', operation.id, operation.bytes); }
    }
    for (let offset = 0; offset < operations.length; offset++) {
      const index = (this.cursor + offset) % operations.length, operation = operations[index]!;
      if (operation.stage !== 'chunks' || !operation.source) continue;
      const chunk = operation.source.next(); this.cursor = (index + 1) % operations.length;
      if (chunk.done) {
        if (operation.inputBytes !== operation.bytes) throw unavailable('input_limit');
        operation.source = undefined; operation.stage = 'sent'; operation.commitSent = true; return control(worker, 'E', operation.id);
      }
      operation.inputBytes += chunk.value.length;
      if (operation.inputBytes > operation.bytes) throw unavailable('input_limit');
      return Buffer.concat([Buffer.from(`C${worker.id}${operation.id}`, 'ascii'), chunk.value]);
    }
    if (worker.stopping && !worker.shutdownSent) {
      worker.shutdownSent = true;
      return control(worker, 'S');
    }
    return undefined;
  }

  private pump(worker: Worker): void {
    if (!worker.ready || worker.writing || worker.closed || worker.failure) return;
    worker.writing = true;
    void (async () => {
      try {
        while (!worker.failure && !worker.closed) {
          const body = this.nextFrame(worker); if (!body) break;
          if (body.length > 64 * 1024) throw unavailable('input_limit');
          const frame = Buffer.allocUnsafe(body.length + 4); frame.writeUInt32LE(body.length); body.copy(frame, 4);
          await new Promise<void>((resolve, reject) => worker.child.stdin.write(frame, error => error ? reject(error) : resolve()));
          if (worker.shutdownSent) {
            worker.child.stdin.end();
            worker.timer = setTimeout(() => this.fail(worker, 'shutdown_timeout'), this.options.startupGraceMs ?? 1000);
            break;
          }
        }
      } catch { this.fail(worker, 'input_failed'); }
      finally { worker.writing = false; }
    })();
  }

  private idle(worker: Worker): void {
    if (worker.stopping || worker.failure || worker.closed || [...this.pending.values()].some(operation => operation.worker === worker)) return;
    if (worker.retiring) { worker.stopping = true; this.pump(worker); return; }
    worker.idleTimer = setTimeout(() => {
      worker.idleTimer = undefined;
      if (![...this.pending.values()].some(operation => operation.worker === worker)) { worker.stopping = true; this.pump(worker); }
    }, this.options.idleTtlMs ?? 1000);
  }

  private fail(worker: Worker, reason: string): void {
    if (worker.closed) return;
    worker.failure ??= unavailable(reason);
    clearTimeout(worker.timer); clearTimeout(worker.idleTimer);
    try { worker.child.kill('SIGKILL'); } catch { /* Keep all ownership until positively observed close. */ }
  }

  private processClosed(worker: Worker): void {
    if (worker.closed) return;
    worker.closed = true; clearTimeout(worker.timer); clearTimeout(worker.idleTimer);
    for (const operation of [...this.pending.values()]) {
      if (operation.worker !== worker) continue;
      operation.failure = worker.failure ?? unavailable('process_failed'); this.settle(operation);
    }
    if (this.worker === worker) this.worker = undefined;
    worker.finishClose();
    void worker.done.then(() => this.activateWaiting());
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const operation of [...this.pending.values()]) this.cancel(operation, 'cancelled');
    const worker = this.worker; if (!worker) return;
    worker.stopping = true; clearTimeout(worker.idleTimer);
    this.pump(worker);
    await worker.done;
  }
}
