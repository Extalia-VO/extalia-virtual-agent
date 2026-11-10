import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  PROVIDER_MODELS_SCHEMA, PROVIDER_MODELS_MAX_REQUEST_BYTES, PROVIDER_MODELS_MAX_RESPONSE_BYTES,
  parseProviderModelsResponse,
} from '@extalia/protocol';
import { ProviderError } from '@extalia/runtime';
import type { DaemonProcess } from './client.js';

export interface ModelDiscoveryInput {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
}
export type ModelDiscoveryPort = (request: ModelDiscoveryInput, signal?: AbortSignal) => Promise<string[]>;
export interface ModelDiscoveryProcess extends DaemonProcess {
  readonly pid?: number;
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
}
export type SpawnModelDiscovery = (binary: string, args: string[], options: { cwd: string; env: Record<string, string> }) => ModelDiscoveryProcess;
interface Pending { abort(): void; done: Promise<string[]> }

const unavailable = (reason: string) => new ProviderError(`Native model discovery is unavailable (${reason}).`);
const spawnChild: SpawnModelDiscovery = (binary, args, options) => spawn(binary, args, {
  ...options, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});

/**
 * One-shot Rust transport, not an HTTP adapter. A reply never releases a process
 * handle: success, refusal and cancellation all wait for actual child close.
 */
export class RustModelDiscovery {
  private readonly pending = new Set<Pending>();
  private closed = false;

  constructor(private readonly options: {
    binary(): string | undefined;
    directory: string;
    clientVersion: string;
    env?: Readonly<Record<string, string | undefined>>;
    spawn?: SpawnModelDiscovery;
  }) {}

  get pendingCount(): number { return this.pending.size; }

  readonly list: ModelDiscoveryPort = (input, signal) => {
    if (this.closed || signal?.aborted) return Promise.reject(unavailable('cancelled'));
    // Bound admitted IPC children; there is no unbounded waiting queue or retry.
    if (this.pending.size >= 4) return Promise.reject(unavailable('busy'));
    const binary = this.options.binary();
    if (!binary) return Promise.reject(unavailable('binary_missing'));
    const requestId = randomUUID();
    const payload = JSON.stringify({ ...input, schema: PROVIDER_MODELS_SCHEMA, requestId,
      clientVersion: this.options.clientVersion.slice(0, 64), timeoutMs: 15_000 });
    if (Buffer.byteLength(payload) > PROVIDER_MODELS_MAX_REQUEST_BYTES) return Promise.reject(unavailable('request_too_large'));
    const env: Record<string, string> = {};
    for (const key of ['SystemRoot', 'windir', 'TMPDIR', 'TEMP', 'TMP']) {
      const value = this.options.env?.[key];
      if (value) env[key] = value;
    }
    let child: ModelDiscoveryProcess;
    try { child = (this.options.spawn ?? spawnChild)(binary, ['--provider-models'], { cwd: this.options.directory, env }); }
    catch { return Promise.reject(unavailable('spawn_failed')); }
    let abort!: () => void;
    const operation: Pending = { abort: () => undefined, done: Promise.resolve([]) };
    this.pending.add(operation);
    const done = new Promise<string[]>((resolve, reject) => {
      let output = Buffer.alloc(0), stderrBytes = 0;
      let failure: ProviderError | undefined, finished = false, spawned = false;
      const stop = (reason: string) => {
        failure ??= unavailable(reason);
        // Killing is only a request. Keep the promise and admission until close.
        try { child.kill('SIGKILL'); } catch { /* Unconfirmed termination retains ownership. */ }
      };
      abort = () => stop('cancelled');
      const timer = setTimeout(() => stop('timeout'), 16_000);
      const finish = (code: number | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.pending.delete(operation);
        if (failure || code !== 0) { reject(failure ?? unavailable('process_failed')); return; }
        let response;
        try { response = parseProviderModelsResponse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output))); }
        catch { /* Invalid bytes are never provider evidence. */ }
        if (!response || response.requestId !== requestId) { reject(unavailable('invalid_response')); return; }
        if (response.outcome === 'error') {
          if (response.code === 'http_error') {
            const prefix = response.status === 401 || response.status === 403
              ? 'The endpoint rejected the credentials' : `The endpoint returned ${response.status}`;
            reject(new ProviderError(`${prefix}.`, response.status));
          } else reject(unavailable(response.code));
          return;
        }
        resolve(response.models);
      };
      child.once('spawn', () => { spawned = true; });
      child.once('error', () => {
        failure ??= unavailable('spawn_failed');
        // A failed spawn with no process is positively settled. A live child isn't.
        if (!spawned && child.pid === undefined) finish(null);
        else stop('process_failed');
      });
      child.once('close', (code: number | null) => finish(code));
      child.stdout.on('data', (chunk: Buffer) => {
        if (failure || finished) return;
        if (output.length + chunk.length > PROVIDER_MODELS_MAX_RESPONSE_BYTES) { stop('output_limit'); return; }
        output = Buffer.concat([output, chunk]);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        // Drain without retaining or logging provider/credential-bearing text.
        stderrBytes += chunk.length;
        if (stderrBytes > 4096) stop('output_limit');
      });
      child.stdin.on('error', () => stop('input_failed'));
      child.stdout.on('error', () => stop('output_failed'));
      child.stderr.on('error', () => stop('output_failed'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else child.stdin.end(payload);
    });
    operation.abort = abort;
    operation.done = done;
    return done;
  };

  async close(): Promise<void> {
    this.closed = true;
    for (const operation of this.pending) operation.abort();
    await Promise.allSettled([...this.pending].map(operation => operation.done));
  }
}
