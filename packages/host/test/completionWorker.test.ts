import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_WORKER_SCHEMA } from '@extalia/protocol';
import { RustCompletionWorker } from '../src/daemon/completionWorker.js';
import type { ModelDiscoveryProcess } from '../src/daemon/modelDiscovery.js';

interface Input { op: string; workerId: string; requestId?: string; bytes?: number; chunk?: Buffer }
class WorkerChild extends EventEmitter implements ModelDiscoveryProcess {
  pid: number | undefined = 12345;
  stdin: Writable = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  killed = 0; frames: Input[] = []; raw: Buffer[] = [];
  constructor(readonly id: string) { super(); this.stdin.on('data', chunk => this.capture(chunk)); }
  capture(frame: Buffer): void {
    this.raw.push(Buffer.from(frame));
    const size = frame.readUInt32LE(0); expect(frame.length).toBe(size + 4); expect(size).toBeLessThanOrEqual(65536);
    const op = frame.toString('ascii', 4, 5);
    this.frames.push(op === 'C' ? { op, workerId: frame.toString('ascii', 5, 41), requestId: frame.toString('ascii', 41, 77), chunk: Buffer.from(frame.subarray(77)) }
      : { op, ...JSON.parse(frame.subarray(5).toString()) });
  }
  get requests(): string[] { return this.frames.filter(frame => frame.op === 'B').map(frame => frame.requestId!); }
  hello(): void { this.reply({ kind: 'hello' }); }
  reply(extra: Record<string, unknown>, split = false): void {
    const body = Buffer.from(JSON.stringify({ schema: PROVIDER_WORKER_SCHEMA, workerId: this.id, ...extra }));
    const frame = Buffer.alloc(body.length + 4); frame.writeUInt32LE(body.length); body.copy(frame, 4);
    if (split) for (const byte of frame) this.stdout.write(Buffer.from([byte])); else this.stdout.write(frame);
  }
  result(requestId: string, seq = 0): void { this.reply({ requestId, seq, kind: 'result', result: { text: 'hello', stop: 'end', toolCalls: [] } }, true); }
  settled(requestId: string, seq = 1): void { this.reply({ requestId, seq, kind: 'settled', joined: true }); }
  kill(): boolean { this.killed++; return true; }
  close(): void { this.emit('close', 0, null); }
}
const teardown: (() => void)[] = [];
afterEach(() => { while (teardown.length) teardown.pop()!(); });
const connection = { baseUrl: 'https://example.com/v1', model: 'fixture', apiKey: 'explicit-fixture-key' };
const request = { system: '', messages: [], tools: [] };
function fixture(overrides: Partial<ConstructorParameters<typeof RustCompletionWorker>[0]> = {}) {
  const children: WorkerChild[] = [], launches: unknown[] = [];
  const client = new RustCompletionWorker({ binary: () => '/native/extalia-daemon', directory: '/temporary/data', clientVersion: 'test',
    env: { OPENAI_API_KEY: 'must-not-leave', PATH: '/private/bin', HOME: '/private/home', TMPDIR: '/temporary/scratch' },
    spawn: (binary, args, options) => {
      const child = new WorkerChild(args[1]!); children.push(child); launches.push({ binary, args, ...options });
      teardown.push(() => child.close()); return child;
    }, ...overrides });
  async function close() { const closing = client.close(); await setImmediate(); for (const child of children) child.close(); await closing; }
  return { client, children, launches, close };
}

describe('Joined Rust completion worker transport', () => {
  it('starts lazily, keeps secrets off arguments and holds terminal results until positive joined receipts', async () => {
    const { client, children, launches, close } = fixture(); expect(client.processCount).toBe(0);
    const deltas: string[] = []; let settled = false;
    const pending = client.complete(connection, { ...request, onText: text => deltas.push(text) }, true).finally(() => { settled = true; });
    const child = children[0]!; expect(child.frames).toEqual([]); child.hello(); await setImmediate();
    expect(launches).toEqual([{ binary: '/native/extalia-daemon', args: ['--provider-worker', child.id], cwd: '/temporary/data', env: { TMPDIR: '/temporary/scratch' } }]);
    const id = child.requests[0]!;
    const payload = Buffer.concat(child.frames.filter(frame => frame.op === 'C').map(frame => frame.chunk!));
    expect(JSON.parse(payload.toString())).toMatchObject({ connection, requestUsage: true }); expect(client.reservedBytes).toBe(payload.length);
    child.reply({ requestId: id, seq: 0, kind: 'delta', text: 'hello' }); child.result(id, 1); await setImmediate();
    expect(settled).toBe(false); expect(client.pendingCount).toBe(1); expect(deltas).toEqual(['hello']);
    child.settled(id, 2); await expect(pending).resolves.toMatchObject({ result: { text: 'hello' } }); expect(client.pendingCount).toBe(0); expect(client.reservedBytes).toBe(0);
    expect(client.processCount).toBe(1); await close(); expect(child.frames.at(-1)?.op).toBe('S'); expect(client.processCount).toBe(0);
  });

  it('isolates cancellation and callback failure from another active request', async () => {
    const { client, children, close } = fixture(); const controller = new AbortController();
    const deltas: string[] = [];
    const first = client.complete(connection, { ...request, signal: controller.signal, onText: text => deltas.push(text) }, true).catch(error => error);
    const second = client.complete(connection, request, true); const child = children[0]!;
    child.hello(); await setImmediate(); const [a, b] = child.requests as [string, string]; controller.abort(); await setImmediate();
    expect(child.frames.some(frame => frame.op === 'X' && frame.requestId === a)).toBe(true); expect(child.killed).toBe(0); expect(client.pendingCount).toBe(2);
    child.reply({ requestId: a, seq: 0, kind: 'delta', text: 'queued after cancel' });
    expect(deltas).toEqual([]); expect(client.pendingCount).toBe(2);
    child.reply({ requestId: a, seq: 1, kind: 'error', code: 'cancelled', retryable: false }); child.settled(a, 2);
    expect(await first).toMatchObject({ retryable: false }); expect(client.pendingCount).toBe(1);
    child.result(b); child.settled(b); await expect(second).resolves.toMatchObject({ result: { text: 'hello' } });
    const callback = client.complete(connection, { ...request, onText: () => { throw new Error('private callback'); } }, true).catch(error => error);
    await setImmediate(); const c = child.requests[2]!; child.reply({ requestId: c, seq: 0, kind: 'delta', text: 'text' }); await setImmediate();
    expect(child.killed).toBe(0); expect(client.pendingCount).toBe(1); expect(child.frames.at(-1)).toMatchObject({ op: 'X', requestId: c });
    child.reply({ requestId: c, seq: 1, kind: 'error', code: 'cancelled', retryable: false }); child.settled(c, 2);
    expect(await callback).toMatchObject({ retryable: false, message: expect.stringContaining('callback_failed') }); await close();
  });

  it.each(['worker', 'sequence', 'settled_before_terminal', 'duplicate_terminal', 'delta_after_terminal', 'unknown', 'stderr', 'utf8'])(
    'retains all ownership after invalid %s until worker close and never replays', async mode => {
      const { client, children, close } = fixture();
      const pending = client.complete(connection, request, true).catch(error => error); const child = children[0]!;
      child.hello(); await setImmediate(); const id = child.requests[0]!, reserved = client.reservedBytes;
      if (mode === 'worker') child.reply({ workerId: '00000000-0000-4000-8000-000000000000', requestId: id, seq: 0, kind: 'delta', text: 'text' });
      if (mode === 'sequence') child.result(id, 1);
      if (mode === 'settled_before_terminal') child.settled(id, 0);
      if (mode === 'duplicate_terminal') { child.result(id); child.result(id, 1); }
      if (mode === 'delta_after_terminal') { child.result(id); child.reply({ requestId: id, seq: 1, kind: 'delta', text: 'text' }); }
      if (mode === 'unknown') child.result('00000000-0000-4000-8000-000000000000');
      if (mode === 'stderr') child.stderr.write(Buffer.alloc(4097));
      if (mode === 'utf8') child.stdout.write(Buffer.from([1, 0, 0, 0, 255]));
      expect(child.killed).toBeGreaterThan(0); expect(client.pendingCount).toBe(1); expect(client.reservedBytes).toBe(reserved);
      await expect(client.complete(connection, request, true)).rejects.toThrow(/worker_draining/); expect(children).toHaveLength(1);
      child.close(); expect(await pending).toMatchObject({ retryable: false }); expect(client.pendingCount).toBe(0); expect(client.reservedBytes).toBe(0);
      const next = client.complete(connection, request, true).catch(error => error); expect(children).toHaveLength(2);
      children[1]!.close(); expect(await next).toMatchObject({ retryable: false }); await close();
    });

  it('reserves bounded retirement waiters and starts exactly one replacement after actual close', async () => {
    const { client, children, close } = fixture({ idleTtlMs: 5, maxActive: 2 });
    const pending = client.complete(connection, request, true); const child = children[0]!; child.hello(); await setImmediate();
    child.result(child.requests[0]!); child.settled(child.requests[0]!); await pending;
    await vi.waitFor(() => expect(child.frames.at(-1)?.op).toBe('S'));
    const mutable = { ...request, messages: [{ role: 'user' as const, text: 'original' }] };
    const a = client.complete(connection, mutable, true), b = client.complete(connection, request, true);
    mutable.messages[0]!.text = 'changed';
    expect(client.pendingCount).toBe(2); expect(client.reservedBytes).toBeGreaterThan(0); expect(children).toHaveLength(1);
    await expect(client.complete(connection, request, true)).rejects.toThrow(/busy/);
    expect(child.requests).toHaveLength(1); child.close(); await setImmediate();
    expect(children).toHaveLength(2); const replacement = children[1]!; replacement.hello(); await setImmediate();
    expect(replacement.requests).toHaveLength(2);
    const payload = Buffer.concat(replacement.frames.filter(frame => frame.op === 'C' && frame.requestId === replacement.requests[0]).map(frame => frame.chunk!));
    expect(JSON.parse(payload.toString()).messages).toEqual([{ role: 'user', text: 'original' }]);
    for (const id of replacement.requests) {
      expect(replacement.frames.filter(frame => frame.requestId === id && frame.op === 'E')).toHaveLength(1);
      replacement.result(id); replacement.settled(id);
    }
    await Promise.all([a, b]); expect(client.pendingCount).toBe(0); expect(client.reservedBytes).toBe(0); await close();
  });

  it.each(['abort', 'timeout', 'close'] as const)('settles a retirement waiter on %s without entering HTTP or starting a replacement', async mode => {
    const { client, children, close } = fixture({ idleTtlMs: 1, ...(mode === 'timeout' ? { timeoutMs: 5, startupGraceMs: 100 } : {}) });
    const first = client.complete(connection, request, true); const child = children[0]!; child.hello(); await setImmediate();
    child.result(child.requests[0]!); child.settled(child.requests[0]!); await first;
    await vi.waitFor(() => expect(child.frames.at(-1)?.op).toBe('S'));
    const controller = new AbortController();
    const waiting = client.complete(connection, { ...request, signal: controller.signal }, true).catch(error => error);
    expect(client.pendingCount).toBe(1); expect(client.reservedBytes).toBeGreaterThan(0);
    let closing: Promise<void> | undefined, closed = false;
    if (mode === 'abort') controller.abort();
    if (mode === 'close') closing = client.close().then(() => { closed = true; });
    if (mode === 'timeout') await vi.waitFor(() => expect(client.pendingCount).toBe(0));
    expect(await waiting).toMatchObject({ retryable: false, message: expect.stringContaining(mode === 'timeout' ? 'timeout' : 'cancelled') });
    expect(client.reservedBytes).toBe(0); expect(children).toHaveLength(1); expect(child.requests).toHaveLength(1);
    await setImmediate(); if (mode === 'close') expect(closed).toBe(false);
    child.close(); await closing; await setImmediate(); expect(children).toHaveLength(1); await close();
  });

  it('counts retirement waiter bytes against the same aggregate budget', async () => {
    const { client, children, close } = fixture({ idleTtlMs: 1, maxInputBytes: 1000 });
    const first = client.complete(connection, request, true); const child = children[0]!; child.hello(); await setImmediate();
    child.result(child.requests[0]!); child.settled(child.requests[0]!); await first;
    await vi.waitFor(() => expect(child.frames.at(-1)?.op).toBe('S'));
    const controller = new AbortController();
    const waiting = client.complete(connection, { ...request, system: 'x'.repeat(600), signal: controller.signal }, true).catch(error => error);
    await expect(client.complete(connection, request, true)).rejects.toThrow(/busy/);
    expect(children).toHaveLength(1); controller.abort(); await waiting; child.close(); await close();
  });

  it('waits for joined receipts and actual process close during host shutdown', async () => {
    const { client, children } = fixture(); const pending = client.complete(connection, request, true).catch(error => error);
    const child = children[0]!; child.hello(); await setImmediate(); let closed = false;
    const closing = client.close().then(() => { closed = true; }); await setImmediate();
    expect(child.frames.slice(-2).map(frame => frame.op)).toEqual(['X', 'S']); expect(child.stdin.writableEnded).toBe(true); expect(closed).toBe(false);
    const id = child.requests[0]!; child.reply({ requestId: id, seq: 0, kind: 'error', code: 'cancelled', retryable: false }); child.settled(id);
    expect(await pending).toMatchObject({ retryable: false }); await setImmediate(); expect(closed).toBe(false); expect(client.processCount).toBe(1);
    child.close(); await closing; expect(client.processCount).toBe(0);
  });

  it('bounds admission and retains missing-receipt requests through timeout until close', async () => {
    const { client, children, close } = fixture({ maxActive: 1, timeoutMs: 20, startupGraceMs: 10 });
    const pending = client.complete(connection, request, true).catch(error => error); const child = children[0]!; child.hello(); await setImmediate();
    child.result(child.requests[0]!); await expect(client.complete(connection, request, true)).rejects.toThrow(/busy/);
    await vi.waitFor(() => expect(child.killed).toBeGreaterThan(0)); expect(client.pendingCount).toBe(1); expect(client.reservedBytes).toBeGreaterThan(0);
    child.close(); expect(await pending).toMatchObject({ retryable: false, message: expect.stringContaining('timeout') }); await close();
  });

  it('round-robins bounded input and prioritizes cancellation after a blocked physical frame', async () => {
    const children: WorkerChild[] = []; let release: (() => void) | undefined;
    const { client } = fixture({ spawn: (_binary, args) => {
      const child = new WorkerChild(args[1]!); children.push(child); teardown.push(() => child.close());
      child.stdin = new Writable({ highWaterMark: 1, write(frame, _encoding, callback) {
        child.capture(frame);
        if (child.frames.at(-1)?.op === 'C') release = callback; else callback();
      } }); return child;
    } });
    const controller = new AbortController();
    const a = client.complete(connection, { ...request, system: 'x'.repeat(100000), signal: controller.signal }, true).catch(error => error);
    const b = client.complete(connection, { ...request, system: 'y'.repeat(100000) }, true).catch(error => error);
    const child = children[0]!; child.hello(); await setImmediate();
    const [first, second] = child.requests as [string, string]; expect(child.frames.at(-1)).toMatchObject({ op: 'C', requestId: first });
    expect(child.stdin.writableLength).toBeLessThanOrEqual(16461); controller.abort(); release!(); await setImmediate();
    expect(child.frames.slice(-2).map(frame => [frame.op, frame.requestId])).toEqual([['X', first], ['C', second]]);
    expect(child.killed).toBe(0); expect(client.pendingCount).toBe(2); child.close(); await Promise.all([a, b]); await client.close();
  });

  it('separately settles a failed spawn with no process', async () => {
    const { client, children, close } = fixture(); const pending = client.complete(connection, request, true).catch(error => error);
    children[0]!.pid = undefined; children[0]!.emit('error', new Error('private path'));
    expect(await pending).toMatchObject({ retryable: false }); expect(client.processCount).toBe(0); expect(client.pendingCount).toBe(0); await close();
  });
});
