import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { PROVIDER_COMPLETE_SCHEMA, PROVIDER_COMPLETE_MAX_FRAME_BYTES } from '@extalia/protocol';
import { RustCompletion } from '../src/daemon/completion.js';
import type { ModelDiscoveryProcess } from '../src/daemon/modelDiscovery.js';

class Child extends EventEmitter implements ModelDiscoveryProcess {
  pid: number | undefined = 12345;
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  killed = 0; input: Buffer[] = [];
  constructor() { super(); this.stdin.on('data', chunk => this.input.push(Buffer.from(chunk))); }
  kill(): boolean { this.killed++; return true; }
  get request(): { requestId: string } { return JSON.parse(Buffer.concat(this.input).toString()); }
  frame(extra: Record<string, unknown>, split = false): void {
    const body = Buffer.from(JSON.stringify({ schema: PROVIDER_COMPLETE_SCHEMA, requestId: this.request.requestId, seq: 0, ...extra }));
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    if (split) for (const byte of Buffer.concat([header, body])) this.stdout.write(Buffer.from([byte]));
    else this.stdout.write(Buffer.concat([header, body]));
  }
  close(code = 0): void { this.emit('close', code, null); }
}
const teardown: (() => void)[] = [];
afterEach(() => { while (teardown.length) teardown.pop()!(); });
const connection = { baseUrl: 'https://example.com/v1', model: 'test-model', apiKey: 'explicit-fixture-key' };
const request = { system: '', messages: [], tools: [] };
const result = { text: 'hello', toolCalls: [], stop: 'end' };
function fixture(overrides: Partial<ConstructorParameters<typeof RustCompletion>[0]> = {}) {
  const children: Child[] = [], launches: unknown[] = [];
  const client = new RustCompletion({ binary: () => '/native/extalia-daemon', directory: '/temporary/data', clientVersion: 'test',
    env: { OPENAI_API_KEY: 'must-not-leave', HTTP_PROXY: 'http://example.com', PATH: '/private/bin', HOME: '/private/home', TMPDIR: '/temporary/scratch' },
    spawn: (binary, args, options) => {
      const child = new Child(); children.push(child); launches.push({ binary, args, ...options });
      teardown.push(() => child.close(1)); return child;
    }, ...overrides });
  return { client, children, launches };
}

describe('Rust completion child transport', () => {
  it('streams validated split frames, uses private stdin and settles only after close', async () => {
    const { client, children, launches } = fixture(); const deltas: string[] = [];
    let settled = false;
    const pending = client.complete(connection, { ...request, onText: text => deltas.push(text) }, true).finally(() => { settled = true; });
    await setImmediate(); const child = children[0]!;
    expect(launches).toEqual([{ binary: '/native/extalia-daemon', args: ['--provider-complete'], cwd: '/temporary/data', env: { TMPDIR: '/temporary/scratch' } }]);
    expect(child.request).toMatchObject({ schema: PROVIDER_COMPLETE_SCHEMA, connection, timeoutMs: 600000, requestUsage: true, ...request });
    expect(child.stdin.writableEnded).toBe(true);
    child.frame({ kind: 'delta', text: 'hello' }, true);
    child.frame({ seq: 1, kind: 'result', result }, true);
    await setImmediate(); expect(settled).toBe(false); expect(deltas).toEqual(['hello']); expect(client.pendingCount).toBe(1);
    child.close(); await expect(pending).resolves.toEqual({ result }); expect(client.pendingCount).toBe(0); expect(client.reservedBytes).toBe(0);
    await client.close();
  });

  it('preserves JSON escaping, surrogate pairs and images across bounded stdin writes', async () => {
    const { client, children } = fixture();
    const text = '\0\n"\\'.repeat(4095) + '😀' + '\ud800' + 'é';
    const messages = [{ role: 'user' as const, text, images: [{ mimeType: 'image/png' as const, data: 'A'.repeat(100000) }] }];
    const pending = client.complete(connection, { ...request, system: text, messages }, false);
    await setImmediate(); const child = children[0]!;
    expect(child.request).toMatchObject({ system: text, messages, requestUsage: false });
    expect(Math.max(...child.input.map(buffer => buffer.length))).toBeLessThanOrEqual(32768);
    expect(client.reservedBytes).toBe(Buffer.concat(child.input).length);
    child.frame({ kind: 'result', result }); child.close(); await pending; await client.close();
  });

  it('snapshots caller containers before asynchronous writes and refuses getters/nonfinite data', async () => {
    const children: Child[] = [];
    const { client } = fixture({ spawn: () => {
      const child = new Child(); children.push(child); teardown.push(() => child.close(1));
      child.stdin = new Writable({ write(chunk, _encoding, callback) {
        child.input.push(Buffer.from(chunk)); setImmediate().then(() => callback());
      } }) as PassThrough;
      return child;
    } });
    const mutable = { ...request, system: 'x'.repeat(50000), messages: [{ role: 'user' as const, text: 'original' }] };
    const pending = client.complete(connection, mutable, true);
    mutable.messages[0]!.text = 'changed'; mutable.messages.push({ role: 'user', text: 'injected' });
    await new Promise<void>(resolve => children[0]!.stdin.once('finish', resolve));
    expect(children[0]!.request).toMatchObject({ messages: [{ role: 'user', text: 'original' }] });
    children[0]!.frame({ kind: 'result', result }); children[0]!.close(); await pending;
    const getter = { ...connection, get model(): string { throw new Error('private getter'); } };
    await expect(client.complete(getter, request, true)).rejects.toThrow(/invalid_request/);
    await expect(client.complete(connection, { ...request, tools: [{ name: 't', description: '', parameters: { type: 'object', properties: { bad: { type: 'number', minimum: NaN } } } }] }, true)).rejects.toThrow(/invalid_request/);
    expect(children).toHaveLength(1); await client.close();
  });

  it('holds all admitted handles and byte reservations through abort and shutdown until close', async () => {
    const { client, children } = fixture({ maxActive: 8 });
    const controller = new AbortController();
    const pending = Array.from({ length: 8 }, () => client.complete(connection, { ...request, signal: controller.signal }, true).catch(error => error));
    await setImmediate(); await expect(client.complete(connection, request, true)).rejects.toThrow(/busy/);
    const reserved = client.reservedBytes; controller.abort(); expect(children.every(child => child.killed === 1)).toBe(true);
    expect(client.pendingCount).toBe(8); expect(client.reservedBytes).toBe(reserved);
    let closed = false; const closing = client.close().then(() => { closed = true; }); await setImmediate(); expect(closed).toBe(false);
    for (const child of children) child.close(); await closing;
    expect(await Promise.all(pending)).toEqual(Array.from({ length: 8 }, () => expect.objectContaining({ retryable: false })));
    expect(client.reservedBytes).toBe(0); await expect(client.complete(connection, request, true)).rejects.toThrow(/cancelled/);
  });

  it('refuses aggregate input bytes and cancelled inputs without launching', async () => {
    const { client, children } = fixture({ maxInputBytes: 1000 });
    const first = client.complete(connection, { ...request, system: 'a'.repeat(600) }, true).catch(error => error);
    await expect(client.complete(connection, request, true)).rejects.toThrow(/busy/);
    expect(children).toHaveLength(1); children[0]!.close(1); await first;
    const controller = new AbortController(); controller.abort();
    await expect(client.complete(connection, { ...request, signal: controller.signal }, true)).rejects.toThrow(/cancelled/);
    await client.close();
  });

  it.each(['sequence', 'correlation', 'unknown_result', 'trailing_frame', 'trailing_bytes', 'stderr', 'oversize_frame', 'utf8', 'callback'])(
    'kills invalid %s and never frees capacity before close or permits automatic model fallback', async mode => {
      const { client, children } = fixture({ maxActive: 1 });
      const pending = client.complete(connection, { ...request, onText: () => { if (mode === 'callback') throw new Error('private callback'); } }, true).catch(error => error);
      await setImmediate(); const child = children[0]!;
      if (mode === 'sequence') child.frame({ seq: 1, kind: 'result', result });
      if (mode === 'correlation') child.frame({ requestId: '00000000-0000-4000-8000-000000000000', kind: 'result', result });
      if (mode === 'unknown_result') child.frame({ kind: 'result', result: { ...result, native: { api: 'openai-chat', content: 'private' } } });
      if (mode === 'trailing_frame') { child.frame({ kind: 'result', result }); child.frame({ seq: 1, kind: 'result', result }); }
      if (mode === 'trailing_bytes') { child.frame({ kind: 'result', result }); child.stdout.write(Buffer.from([0])); }
      if (mode === 'stderr') child.stderr.write(Buffer.alloc(4097));
      if (mode === 'oversize_frame') { const header = Buffer.alloc(4); header.writeUInt32LE(PROVIDER_COMPLETE_MAX_FRAME_BYTES + 1); child.stdout.write(header); }
      if (mode === 'utf8') { const bytes = Buffer.alloc(5); bytes.writeUInt32LE(1); bytes[4] = 255; child.stdout.write(bytes); }
      if (mode === 'callback') child.frame({ kind: 'delta', text: 'hello' });
      expect(child.killed).toBeGreaterThan(0); expect(client.pendingCount).toBe(1);
      await expect(client.complete(connection, request, true)).rejects.toThrow(/busy/);
      child.close(); const error = await pending; expect(error.retryable).toBe(false); expect(error.message).not.toContain('private'); await client.close();
    });

  it.each(['nonzero', 'missing_terminal', 'partial'] as const)('rejects %s even on process close', async mode => {
    const { client, children } = fixture(); const pending = client.complete(connection, request, true).catch(error => error);
    await setImmediate(); const child = children[0]!;
    if (mode === 'nonzero') child.frame({ kind: 'result', result });
    if (mode === 'partial') child.stdout.write(Buffer.from([10, 0]));
    child.close(mode === 'nonzero' ? 1 : 0); expect(await pending).toMatchObject({ retryable: false }); await client.close();
  });

  it('retains timeouts until actual close and classifies positively settled provider errors', async () => {
    const { client, children } = fixture({ timeoutMs: 5, startupGraceMs: 0 });
    const pending = client.complete(connection, request, true).catch(error => error); await setImmediate();
    await new Promise(resolve => setTimeout(resolve, 15)); expect(children[0]!.killed).toBeGreaterThan(0); expect(client.pendingCount).toBe(1);
    children[0]!.close(); expect(await pending).toMatchObject({ retryable: false, message: expect.stringContaining('timeout') });
    const second = client.complete(connection, request, true).catch(error => error); await setImmediate();
    children[1]!.frame({ kind: 'error', code: 'http_error', status: 429, retryable: true }); children[1]!.close();
    expect(await second).toMatchObject({ status: 429, retryable: true }); await client.close();
  });

  it('handles a failed spawn with no process independently of close', async () => {
    const { client, children } = fixture(); const pending = client.complete(connection, request, true).catch(error => error);
    const child = children[0]!; child.pid = undefined; child.emit('error', new Error('private path'));
    expect(await pending).toMatchObject({ retryable: false }); expect(client.pendingCount).toBe(0); expect(client.reservedBytes).toBe(0); await client.close();
  });

  it('bounds outstanding input when the child applies stdin backpressure', async () => {
    const { client, children } = fixture({ spawn: () => {
      const child = new Child(); children.push(child); teardown.push(() => child.close(1));
      child.stdin = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) { /* blocked child */ } }) as PassThrough;
      return child;
    } });
    const controller = new AbortController();
    const pending = client.complete(connection, { ...request, system: 'x'.repeat(1_000_000), signal: controller.signal }, true).catch(error => error);
    await setImmediate(); const child = children[0]!;
    expect(child.stdin.writableLength).toBeLessThanOrEqual(32768); controller.abort(); expect(client.pendingCount).toBe(1);
    child.close(); expect(await pending).toMatchObject({ retryable: false }); await client.close();
  });
});
