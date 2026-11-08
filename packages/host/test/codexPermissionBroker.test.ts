import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { CodexPermissionBroker, type CodexPermissionTarget } from '../src/codexPermissionBroker.js';

const TOKEN = 'synthetic-permission-secret';
const SESSION = '11111111-1111-4111-8111-111111111111';
const cleanups: Array<() => Promise<void>> = [];
const native = (input: Record<string, unknown> = {}) => ({
  session_id: SESSION, turn_id: 'turn-1', transcript_path: '/tmp/extalia-permission-test/rollout.jsonl',
  cwd: '/tmp/extalia-permission-test/workspace', hook_event_name: 'PermissionRequest', model: 'test-model',
  permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'printf harmless', description: 'A synthetic command' }, ...input,
});
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 2));
  expect(check()).toBe(true);
}
async function make(timers?: ConstructorParameters<typeof CodexPermissionBroker>[0]['timers'], verifyToken: (value: string) => Promise<boolean> = async value => value === TOKEN) {
  const target: CodexPermissionTarget = { threadId: SESSION, codexHome: '/tmp/extalia-permission-test/profile', sourceFingerprint: 'a'.repeat(64), cwd: '/tmp/extalia-permission-test/workspace', watching: true };
  const broker = new CodexPermissionBroker({
    target: id => id === 'observed-1' ? target : undefined,
    resolve: payload => payload.session_id === SESSION && payload.transcript_path === '/tmp/extalia-permission-test/rollout.jsonl' ? 'observed-1' : undefined,
    verifyToken, ...(timers ? { timers } : {}),
  });
  const server: Server = createServer((request, response) => { void broker.handle(request, response); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No synthetic listener.');
  const url = `http://127.0.0.1:${address.port}/api/permissions/codex`;
  cleanups.push(async () => { broker.close(); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); });
  const send = (payload: Record<string, unknown> = native(), options: { requestId?: string; signal?: AbortSignal; headers?: Record<string, string>; raw?: string } = {}) => fetch(url, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...options.headers },
    body: options.raw ?? JSON.stringify({ requestId: options.requestId ?? randomUUID(), payload }), signal: options.signal,
  });
  return { broker, target, send, url };
}
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

describe('CodexPermissionBroker', () => {
  it('binds an explicit one-use choice to the exact original caller, nonce and full payload', async () => {
    const { broker, send } = await make();
    const nonce = randomUUID();
    const payload = native({ tool_input: { command: `printf '${'界'.repeat(10_000)}'`, description: 'Full preview retained' } });
    const call = send(payload, { requestId: nonce });
    await waitFor(() => broker.status('observed-1').requests.length === 1);
    const request = broker.status('observed-1').requests[0]!;
    expect(JSON.parse(request.sourceJson)).toEqual(payload);
    expect(request.sourceJson).toContain('界'.repeat(10_000));
    expect(request.availableDecisions).toEqual(['allow', 'deny', 'pass']);
    expect(request.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(request.requestId).not.toBe(nonce);
    expect(broker.answer('observed-1', { requestId: request.requestId, payloadDigest: 'b'.repeat(64), decision: 'allow' }).requests).toHaveLength(1);
    expect(broker.answer('another-session', { ...request, decision: 'allow' }).state).toBe('unavailable');
    expect(broker.answer('observed-1', { ...request, decision: 'allow' }).requests).toHaveLength(0);
    expect(await (await call).json()).toEqual({ decision: 'allow', confirmed: true, requestId: nonce, nativeSessionId: SESSION, turnId: 'turn-1', toolName: 'Bash' });
    expect(broker.answer('observed-1', { ...request, decision: 'deny' }).problem).toContain('no longer waiting');
    expect(await (await send(payload, { requestId: nonce })).json()).toEqual({ decision: 'pass', confirmed: false });
  });

  it('returns pass for offline, unbound, malformed, duplicate-key and oversized input', async () => {
    const { broker, send, target } = await make();
    expect(await (await send(native({ session_id: randomUUID() }))).json()).toEqual({ decision: 'pass', confirmed: false });
    expect(await (await send(native(), { raw: `{"requestId":"${randomUUID()}","payload":${JSON.stringify(native())},"payload":${JSON.stringify(native())}}` })).json()).toEqual({ decision: 'pass', confirmed: false });
    const duplicateNested = JSON.stringify({ requestId: randomUUID(), payload: native() }).replace('"command":"printf harmless"', '"command":"printf harmless","comm\\u0061nd":"hidden"');
    expect(await (await send(native(), { raw: duplicateNested })).json()).toEqual({ decision: 'pass', confirmed: false });
    expect(await (await send(native(), { raw: '{' })).json()).toEqual({ decision: 'pass', confirmed: false });
    expect(await (await send(native(), { raw: ' '.repeat(65_537) })).json()).toEqual({ decision: 'pass', confirmed: false });
    expect(await (await send(native({ cwd: '/tmp/another-workspace' }))).json()).toEqual({ decision: 'pass', confirmed: false });
    target.watching = false;
    expect(await (await send()).json()).toEqual({ decision: 'pass', confirmed: false });
    expect(broker.status('observed-1').requests).toEqual([]);
  });

  it('enforces Origin, method, JSON and the dedicated permission secret before admission', async () => {
    const { broker, send, url } = await make();
    expect((await send(native(), { headers: { Origin: 'https://example.com' } })).status).toBe(403);
    expect((await send(native(), { headers: { Authorization: 'Bearer synthetic-notification-secret' } })).status).toBe(401);
    expect((await send(native(), { headers: { 'Content-Type': 'text/plain' } })).status).toBe(415);
    expect((await fetch(url)).status).toBe(405);
    expect(broker.status('observed-1').requests).toHaveLength(0);
  });

  it('does not offer allow for unverified tools, modes, tool fields or permission context', async () => {
    const { broker, send } = await make();
    for (const payload of [
      native({ tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** End Patch' } }),
      native({ permission_mode: 'unknown' }), native({ extra_permissions: { network: true } }),
      native({ tool_input: { command: 'printf harmless', prefix_rule: ['printf'] } }),
    ]) {
      const call = send(payload);
      await waitFor(() => broker.status('observed-1').requests.length === 1);
      const request = broker.status('observed-1').requests[0]!;
      expect(request.availableDecisions).toEqual(['deny', 'pass']);
      expect(broker.answer('observed-1', { ...request, decision: 'allow' }).requests).toHaveLength(1);
      broker.answer('observed-1', { ...request, decision: 'deny' });
      expect(await (await call).json()).toMatchObject({ decision: 'deny', confirmed: true, nativeSessionId: SESSION });
    }
  });

  it('settles pass on pause, source replacement and close, and requires resume after drop', async () => {
    const { broker, send, target } = await make();
    const first = send();
    await waitFor(() => broker.status('observed-1').requests.length === 1);
    broker.drop('observed-1');
    expect(await (await first).json()).toEqual({ decision: 'pass', confirmed: false });
    expect(await (await send()).json()).toEqual({ decision: 'pass', confirmed: false });
    broker.resume('observed-1');
    const second = send();
    await waitFor(() => broker.status('observed-1').requests.length === 1);
    const old = broker.status('observed-1').requests[0]!;
    target.sourceFingerprint = 'b'.repeat(64);
    expect(broker.answer('observed-1', { ...old, decision: 'allow' }).state).toBe('unavailable');
    expect(await (await second).json()).toEqual({ decision: 'pass', confirmed: false });
    const third = send();
    await waitFor(() => broker.status('observed-1').requests.length === 1);
    broker.close();
    expect(await (await third).json()).toEqual({ decision: 'pass', confirmed: false });
    expect(await (await send()).json()).toEqual({ decision: 'pass', confirmed: false });
  });

  it('revokes authority when the calling HTTP connection disconnects', async () => {
    const { broker, send } = await make();
    const controller = new AbortController();
    const call = send(native(), { signal: controller.signal }).catch(() => undefined);
    await waitFor(() => broker.status('observed-1').requests.length === 1);
    const old = broker.status('observed-1').requests[0]!;
    controller.abort(); await call;
    await waitFor(() => broker.status('observed-1').requests.length === 0);
    expect(broker.answer('observed-1', { ...old, decision: 'allow' }).problem).toContain('no longer waiting');
  });

  it('passes simultaneous duplicates and caps pending HTTP authority at 32', async () => {
    const { broker, send } = await make();
    const nonce = randomUUID();
    const first = send(native(), { requestId: nonce });
    await waitFor(() => broker.status('observed-1').requests.length === 1);
    expect(await (await send(native(), { requestId: nonce })).json()).toEqual({ decision: 'pass', confirmed: false });
    expect(await (await send()).json()).toEqual({ decision: 'pass', confirmed: false });
    const calls = [first, ...Array.from({ length: 31 }, (_, i) => send(native({ turn_id: `turn-${i + 2}` })))];
    await waitFor(() => broker.status('observed-1').requests.length === 32);
    expect(await (await send(native({ turn_id: 'overflow' }))).json()).toEqual({ decision: 'pass', confirmed: false });
    broker.close();
    for (const call of calls) expect(await (await call).json()).toEqual({ decision: 'pass', confirmed: false });
  });

  it('passes after the 55-second decision deadline and the five-second body deadline', async () => {
    const jobs: Array<{ ms: number; run(): void; cancelled: boolean }> = [];
    const timers = {
      setTimeout(run: () => void, ms: number) { const job = { ms, run, cancelled: false }; jobs.push(job); return job as unknown as ReturnType<typeof setTimeout>; },
      clearTimeout(timer: ReturnType<typeof setTimeout>) { if (timer) (timer as unknown as { cancelled: boolean }).cancelled = true; },
    };
    const { broker, send, url } = await make(timers);
    const call = send();
    await waitFor(() => broker.status('observed-1').requests.length === 1);
    jobs.find(job => job.ms === 55_000 && !job.cancelled)!.run();
    expect(await (await call).json()).toEqual({ decision: 'pass', confirmed: false });
    expect(broker.status('observed-1').requests).toHaveLength(0);
    const partial = new Promise<unknown>((resolve, reject) => {
      const request = httpRequest(url, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } }, response => {
        const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => { request.end(); resolve(JSON.parse(Buffer.concat(chunks).toString())); });
      });
      request.on('error', reject); request.write('{');
    });
    await waitFor(() => jobs.some(job => job.ms === 5_000 && !job.cancelled));
    jobs.find(job => job.ms === 5_000 && !job.cancelled)!.run();
    expect(await partial).toEqual({ decision: 'pass', confirmed: false });
  });

  it('survives partial-body disconnects during body receive and asynchronous authentication', async () => {
    let receiving = false;
    const timers = {
      setTimeout(callback: () => void, ms: number) { if (ms === 5_000) receiving = true; return setTimeout(callback, ms); },
      clearTimeout,
    };
    const body = await make(timers);
    const partial = httpRequest(body.url, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } });
    partial.on('error', () => undefined); partial.write('{');
    await waitFor(() => receiving);
    partial.destroy();

    let release!: () => void, entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const auth = await make(undefined, async value => { entered = true; await gate; return value === TOKEN; });
    const duringAuth = httpRequest(auth.url, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } });
    duringAuth.on('error', () => undefined); duringAuth.write('{');
    await waitFor(() => entered);
    duringAuth.destroy(); release();
    await new Promise(resolve => setTimeout(resolve, 20));
    for (const fixture of [body, auth]) {
      const call = fixture.send();
      await waitFor(() => fixture.broker.status('observed-1').requests.length === 1);
      const request = fixture.broker.status('observed-1').requests[0]!;
      fixture.broker.answer('observed-1', { ...request, decision: 'pass' });
      expect(await (await call).json()).toEqual({ decision: 'pass', confirmed: false });
    }
  });
});
