import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { PROVIDER_MODELS_SCHEMA, PROVIDER_MODELS_MAX_RESPONSE_BYTES } from '@extalia/protocol';
import { RustModelDiscovery, type ModelDiscoveryProcess } from '../src/daemon/modelDiscovery.js';

class Child extends EventEmitter implements ModelDiscoveryProcess {
  pid: number | undefined = 12345;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = 0;
  input = '';
  constructor() { super(); this.stdin.on('data', chunk => { this.input += String(chunk); }); }
  kill(): boolean { this.killed++; return true; }
  reply(extra: Record<string, unknown> = {}): void {
    const request = JSON.parse(this.input);
    this.stdout.write(JSON.stringify({ schema: PROVIDER_MODELS_SCHEMA, requestId: request.requestId,
      daemonVersion: 'test', outcome: 'ok', models: ['model-a'], truncated: false, ...extra }));
  }
  close(code = 0): void { this.emit('close', code, null); }
}
const closes: (() => void)[] = [];
afterEach(() => { while (closes.length) closes.pop()!(); });
function fixture() {
  const children: Child[] = [];
  const launches: { binary: string; args: string[]; env: Record<string, string>; cwd: string }[] = [];
  const client = new RustModelDiscovery({
    binary: () => '/native/extalia-daemon', directory: '/temporary/data', clientVersion: 'test',
    env: { OPENAI_API_KEY: 'environment-key-must-not-leave', HTTP_PROXY: 'http://example.com', HOME: '/private/home', PATH: '/private/bin', TMPDIR: '/temporary/scratch', SystemRoot: 'system-root' },
    spawn: (binary, args, options) => {
      const child = new Child(); children.push(child); launches.push({ binary, args, ...options });
      closes.push(() => child.close(1)); return child;
    },
  });
  return { client, children, launches };
}
const input = { baseUrl: 'https://example.com/v1', apiKey: 'explicit-fixture-key' };

describe('Rust provider model discovery transport', () => {
  it('sends credentials only over stdin and waits for close after a valid reply', async () => {
    const { client, children, launches } = fixture();
    let settled = false;
    const pending = client.list(input).finally(() => { settled = true; });
    const child = children[0]!;
    expect(launches).toEqual([{ binary: '/native/extalia-daemon', args: ['--provider-models'], cwd: '/temporary/data', env: { TMPDIR: '/temporary/scratch', SystemRoot: 'system-root' } }]);
    expect(JSON.parse(child.input)).toMatchObject({ ...input, schema: PROVIDER_MODELS_SCHEMA, timeoutMs: 15000 });
    expect(child.stdin.writableEnded).toBe(true);
    child.reply();
    await setImmediate();
    expect(settled).toBe(false);
    expect(client.pendingCount).toBe(1);
    child.close();
    await expect(pending).resolves.toEqual(['model-a']);
    expect(client.pendingCount).toBe(0);
    await client.close();
  });

  it('holds all four process slots through cancellation until actual close', async () => {
    const { client, children } = fixture();
    const controller = new AbortController();
    const pending = Array.from({ length: 4 }, (_, index) => client.list(input, index === 0 ? controller.signal : undefined)
      .then(value => ({ value }), (error: unknown) => ({ error })));
    await expect(client.list(input)).rejects.toThrow(/busy/);
    expect(children).toHaveLength(4);
    controller.abort();
    expect(children[0]!.killed).toBe(1);
    expect(client.pendingCount).toBe(4);
    await expect(client.list(input)).rejects.toThrow(/busy/);
    let closed = false;
    const closing = client.close().then(() => { closed = true; });
    await setImmediate();
    expect(closed).toBe(false);
    for (const child of children) child.close();
    await closing;
    expect(await Promise.all(pending)).toEqual(Array.from({ length: 4 }, () => ({ error: expect.any(Error) })));
    await expect(client.list(input)).rejects.toThrow(/cancelled/);
  });

  it('refuses an already cancelled or oversized request without launching', async () => {
    const { client, children } = fixture();
    const controller = new AbortController(); controller.abort();
    await expect(client.list(input, controller.signal)).rejects.toThrow(/cancelled/);
    await expect(client.list({ ...input, apiKey: 'x'.repeat(20000) })).rejects.toThrow(/request_too_large/);
    expect(children).toHaveLength(0);
    await client.close();
  });

  it.each(['stdout', 'stderr'] as const)('bounds %s without exposing its contents or declaring early settlement', async stream => {
    const { client, children } = fixture();
    const pending = client.list(input).catch((error: unknown) => error);
    const child = children[0]!;
    child[stream].write(Buffer.alloc(stream === 'stdout' ? PROVIDER_MODELS_MAX_RESPONSE_BYTES + 1 : 4097, 120));
    expect(child.killed).toBe(1);
    expect(client.pendingCount).toBe(1);
    child.close();
    expect(await pending).toMatchObject({ message: expect.stringContaining('output_limit') });
    await client.close();
  });

  it('refuses a mismatched correlation even when it claims an HTTP fallback status', async () => {
    const { client, children } = fixture();
    const pending = client.list(input).catch((error: unknown) => error);
    children[0]!.stdout.write(JSON.stringify({ schema: PROVIDER_MODELS_SCHEMA, requestId: '00000000-0000-4000-8000-000000000000', daemonVersion: 'test', outcome: 'error', code: 'http_error', status: 404 }));
    children[0]!.close();
    expect(await pending).toMatchObject({ message: expect.stringContaining('invalid_response'), status: undefined });
    await client.close();
  });

  it('does not accept a valid reply followed by a failed process exit', async () => {
    const { client, children } = fixture();
    const pending = client.list(input).catch((error: unknown) => error);
    children[0]!.reply(); children[0]!.close(1);
    expect(await pending).toMatchObject({ message: expect.stringContaining('process_failed') });
    await client.close();
  });

  it('releases a positively failed spawn without waiting for a nonexistent child', async () => {
    const { client, children } = fixture();
    const pending = client.list(input).catch((error: unknown) => error);
    children[0]!.pid = undefined;
    children[0]!.emit('error', new Error('sensitive raw diagnostic'));
    expect(await pending).toMatchObject({ message: expect.stringContaining('spawn_failed') });
    expect(client.pendingCount).toBe(0);
    await client.close();
  });
});
