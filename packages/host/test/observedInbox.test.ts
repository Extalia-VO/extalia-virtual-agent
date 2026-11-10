import { afterEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest, type ServerResponse } from 'node:http';
import { ObservedInboxChannels, type ObservedInboxTarget } from '../src/observedInboxChannel.js';
import { isObservedInboxRequest, pollObservedInbox } from '../src/observedInboxClient.js';

const brokers: ObservedInboxChannels[] = [];
const target = (): ObservedInboxTarget => ({ app: 'terminal-agent', nativeSessionId: 'thread-1', watching: true, sourceBinding: 'source-generation-1' });
function make(t = target(), timers?: ConstructorParameters<typeof ObservedInboxChannels>[0]['timers']) {
  const broker = new ObservedInboxChannels({ target: () => t, timers });
  brokers.push(broker);
  return { broker, target: t };
}
const paired = (s: { url?: string; token?: string }) => ({ url: s.url!, token: s.token! });
function post(s: { url?: string; token?: string }, body: unknown = { operation: 'poll' }, headers = {}) {
  return fetch(s.url!, { method: 'POST', headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
async function waitFor(test: () => boolean) {
  for (let n = 0; n < 100 && !test(); n++) await new Promise(resolve => setTimeout(resolve, 2));
  expect(test()).toBe(true);
}
function clock() {
  let now = 0;
  const entries: Array<{ due: number; callback: () => void; cancelled: boolean }> = [];
  return {
    timers: {
      setTimeout(callback: () => void, ms: number) { const entry = { due: now + ms, callback, cancelled: false }; entries.push(entry); return entry as unknown as ReturnType<typeof setTimeout>; },
      clearTimeout(t: ReturnType<typeof setTimeout>) { (t as unknown as { cancelled: boolean }).cancelled = true; },
    },
    advance(ms: number) { now += ms; for (const e of [...entries].sort((a, b) => a.due - b.due)) if (!e.cancelled && e.due <= now) { e.cancelled = true; e.callback(); } },
  };
}
afterEach(async () => { await Promise.all(brokers.splice(0).map(b => b.close())); vi.restoreAllMocks(); });

describe('cooperative observed inbox transport', () => {
  it('queues without a poll, isolates sessions, and acknowledges without taking the next message', async () => {
    const { broker } = make();
    const a = await broker.create('a'); const b = await broker.create('b');
    expect(a).toMatchObject({ state: 'connected', queued: 0, polling: false });
    expect(a.token).toMatch(/^[a-f0-9]{64}$/);
    expect(a.expiresAt! - Date.now()).toBeGreaterThan(1_790_000);
    broker.send('a', { channelId: a.channelId!, text: 'first', operationId: 'op-1' });
    broker.send('a', { channelId: a.channelId!, text: 'second' });
    expect(await pollObservedInbox(paired(b))).toEqual({ status: 'empty' });
    const first = await pollObservedInbox(paired(a));
    expect(first).toMatchObject({ status: 'message', message: { text: 'first' } });
    if (first.status !== 'message') throw new Error('Missing message.');
    expect(broker.status('a').receipts?.[0]?.state).toBe('delivered');
    expect(await pollObservedInbox({ ...paired(a), ack: first.message.messageId })).toEqual({ status: 'empty', acknowledged: first.message.messageId });
    expect(broker.status('a')).toMatchObject({ queued: 1, receipts: [{ state: 'acknowledged' }, { state: 'queued' }] });
    const second = await pollObservedInbox({ ...paired(a), ack: first.message.messageId, waitMs: 0 });
    expect(second).toMatchObject({ status: 'message', message: { text: 'second' } });
    expect(await pollObservedInbox(paired(a))).toEqual({ status: 'empty' });
  });
  it('deduplicates operation IDs by payload digest and rejects stale exact channel IDs', async () => {
    const { broker } = make(); const a = await broker.create('a');
    const input = { channelId: a.channelId!, text: 'once', operationId: 'same' };
    const one = broker.send('a', input);
    expect(broker.send('a', input)).toEqual(one);
    expect(broker.send('a', { ...input, text: 'different' }).problem).toMatch(/different message/);
    expect(broker.status('a').queued).toBe(1);
    const fresh = await broker.create('a');
    expect(broker.send('a', input).state).toBe('unavailable');
    expect((await post(a)).status).toBe(404);
    expect(broker.status('a').channelId).toBe(fresh.channelId);
  });
  it('bounds queue, text bytes, visible receipts and lifetime deduplication metadata', async () => {
    const { broker } = make(); const a = await broker.create('a');
    expect(broker.send('a', { channelId: a.channelId!, text: '界'.repeat(6000) }).problem).toBeDefined();
    for (let n = 0; n < 16; n++) broker.send('a', { channelId: a.channelId!, text: `message-${n}`, operationId: `op-${n}` });
    expect(broker.send('a', { channelId: a.channelId!, text: 'overflow' }).problem).toMatch(/full/);
    for (let n = 0; n < 16; n++) expect((await pollObservedInbox(paired(a))).status).toBe('message');
    for (let n = 16; n < 128; n++) {
      broker.send('a', { channelId: a.channelId!, text: `message-${n}`, operationId: `op-${n}` });
      await pollObservedInbox(paired(a));
    }
    expect(broker.status('a').receipts).toHaveLength(32);
    expect(broker.send('a', { channelId: a.channelId!, text: 'message-0', operationId: 'op-0' }).problem).toBeUndefined();
    expect(broker.status('a').queued).toBe(0);
    expect(broker.send('a', { channelId: a.channelId!, text: 'overflow' }).problem).toMatch(/receipt limit/);
  });
  it('rejects wrong auth, Origin, Host, payloads and oversized bodies without consuming queued data', async () => {
    const { broker } = make(); const a = await broker.create('a');
    broker.send('a', { channelId: a.channelId!, text: 'private message' });
    expect((await post({ ...a, token: '0'.repeat(64) })).status).toBe(401);
    expect((await post(a, undefined, { origin: 'http://example.test' })).status).toBe(403);
    const wrongHost = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(a.url!, { method: 'POST', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json', host: 'localhost' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject); req.end(JSON.stringify({ operation: 'poll' }));
    });
    expect(wrongHost).toBe(403);
    expect((await post(a, { operation: 'poll', waitMs: 25_001 })).status).toBe(400);
    expect((await post(a, { operation: 'poll', extra: true })).status).toBe(400);
    expect((await post(a, { operation: 'poll', extra: 'x'.repeat(2000) })).status).toBe(413);
    expect((await post(a, { operation: 'poll', ack: '00000000-0000-0000-0000-000000000000' })).status).toBe(409);
    expect(broker.status('a').queued).toBe(1);
  });
  it('allows only one waiting consumer and revokes on drop without losing receipt states', async () => {
    const { broker } = make(); const a = await broker.create('a');
    const first = pollObservedInbox({ ...paired(a), waitMs: 25_000 });
    await waitFor(() => !!broker.status('a').polling);
    expect(await pollObservedInbox(paired(a))).toEqual({ status: 'busy' });
    broker.drop('a');
    expect(await first).toEqual({ status: 'unavailable' });
    const b = await broker.create('b');
    broker.send('b', { channelId: b.channelId!, text: 'cancel me' });
    broker.drop('b');
    expect(broker.status('b')).toMatchObject({ state: 'unavailable', queued: 0, receipts: [{ state: 'cancelled' }] });
    expect(broker.status('b').token).toBeUndefined();
  });
  it('revokes stale opaque source bindings and paused sessions while a consumer waits', async () => {
    const time = clock(); const { broker, target } = make(undefined, time.timers);
    const a = await broker.create('a');
    const waiting = pollObservedInbox({ ...paired(a), waitMs: 25_000 });
    await waitFor(() => !!broker.status('a').polling);
    target.sourceBinding = 'replacement-source-same-app-and-thread';
    time.advance(250);
    expect(await waiting).toEqual({ status: 'unavailable' });
    const b = await broker.create('b');
    broker.send('b', { channelId: b.channelId!, text: 'queued' });
    target.watching = false;
    expect(broker.status('b')).toMatchObject({ state: 'unavailable', receipts: [{ state: 'cancelled' }] });
    expect((await post(b)).status).toBe(410);
  });
  it('has an absolute lifetime which successful polling does not renew', async () => {
    const time = clock(); const { broker } = make(undefined, time.timers); const a = await broker.create('a');
    time.advance(29 * 60_000);
    expect(await pollObservedInbox(paired(a))).toEqual({ status: 'empty' });
    broker.send('a', { channelId: a.channelId!, text: 'expire' });
    time.advance(60_000);
    expect(broker.status('a')).toMatchObject({ state: 'expired', receipts: [{ state: 'cancelled' }] });
    expect(await pollObservedInbox(paired(a))).toEqual({ status: 'expired' });
  });
  it('seals drop, source change and close races during listener creation', async () => {
    const { broker, target } = make();
    const creating = broker.create('a'); broker.drop('a');
    expect((await creating).state).toBe('unavailable');
    const changed = broker.create('a'); target.sourceBinding = 'changed-before-listener-settles';
    expect((await changed).state).toBe('unavailable');
    const final = broker.create('a'); const closing = broker.close();
    expect((await final).state).toBe('unavailable'); await closing;
    expect((await broker.create('a')).state).toBe('unavailable');
  });
  it('enforces 32 active channels and frees revoked slots', async () => {
    const { broker } = make();
    const result = await Promise.all(Array.from({ length: 33 }, (_, n) => broker.create(`s-${n}`)));
    expect(result.filter(s => s.state === 'connected')).toHaveLength(32);
    broker.drop('s-0'); expect((await broker.create('s-32')).state).toBe('connected');
  });
  it('does not mark abandoned empty polls as a delivery or discard queued messages', async () => {
    const { broker } = make(); const a = await broker.create('a');
    const controller = new AbortController();
    const waiting = pollObservedInbox({ ...paired(a), waitMs: 25_000 }, { signal: controller.signal });
    await waitFor(() => !!broker.status('a').polling); controller.abort();
    expect(await waiting).toEqual({ status: 'unknown' });
    await waitFor(() => !broker.status('a').polling);
    broker.send('a', { channelId: a.channelId!, text: 'still queued' });
    expect((await pollObservedInbox(paired(a))).status).toBe('message');
  });
  it('retains uncertain delivery without replay after an interrupted HTTP response', async () => {
    const { broker } = make(); const a = await broker.create('a');
    const pending = new Promise<void>(resolve => {
      const req = httpRequest(a.url!, { method: 'POST', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' } });
      req.on('error', () => resolve()); req.on('response', response => { response.resume(); response.on('end', resolve); });
      req.end(JSON.stringify({ operation: 'poll', waitMs: 25_000 }));
    });
    await waitFor(() => !!broker.status('a').polling);
    // Simulate a socket failure between admission and response write, not an agent acknowledgment.
    const channel = (broker as unknown as { channels: Map<string, { waiter: { response: ServerResponse } }> }).channels.get('a')!;
    channel.waiter.response.destroy();
    broker.send('a', { channelId: a.channelId!, text: 'uncertain' });
    await pending;
    expect(broker.status('a').receipts).toMatchObject([{ state: 'unknown' }]);
    expect(await pollObservedInbox(paired(a))).toEqual({ status: 'empty' });
  });
  it('seals requests whose body was still arriving when the channel was dropped', async () => {
    const { broker } = make(); const a = await broker.create('a');
    let finish!: () => void;
    const response = new Promise<number>(resolve => {
      const req = httpRequest(a.url!, { method: 'POST', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.write('{'); finish = () => req.end('"operation":"poll","waitMs":25000}');
    });
    await new Promise(resolve => setTimeout(resolve, 10)); broker.drop('a'); finish();
    expect(await response).toBe(410); expect(broker.status('a').polling).toBe(false);
  });
});

describe('inbox client validation', () => {
  const request = { url: 'http://127.0.0.1:8123/inbox/12345678-1234-1234-1234-123456789abc', token: 'a'.repeat(64) };
  it('rejects remote, redirect, credential, alternate host and unbounded poll inputs before attaching a token', async () => {
    const fetchMock = vi.fn();
    for (const url of ['http://localhost:8123/inbox/12345678-1234-1234-1234-123456789abc', request.url + '?secret=x', request.url.replace('http:', 'https:'), request.url.replace('127.0.0.1', '127.1'), request.url.replace('127.0.0.1', 'user@127.0.0.1')]) {
      expect(isObservedInboxRequest({ ...request, url })).toBe(false);
      expect(await pollObservedInbox({ ...request, url }, { fetch: fetchMock })).toEqual({ status: 'unavailable' });
    }
    expect(isObservedInboxRequest({ ...request, waitMs: Infinity })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('never retries uncertainty and rejects malformed or oversized tool results', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => { expect(init?.redirect).toBe('error'); throw new Error('private transport failure'); });
    expect(await pollObservedInbox(request, { fetch: fetchMock })).toEqual({ status: 'unknown' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const result of [{ status: 'message', message: { messageId: 'invalid', text: 'x' } }, { status: 'message', message: { messageId: '12345678-1234-1234-1234-123456789abc', text: '界'.repeat(6000) } }, { status: 'empty', acknowledged: 'unexpected' }, { status: 'empty', secret: 'not accepted' }]) {
      expect(await pollObservedInbox(request, { fetch: async () => new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } }) })).toEqual({ status: 'unknown' });
    }
    expect(await pollObservedInbox(request, { fetch: async () => new Response('x'.repeat(100_001), { headers: { 'content-type': 'application/json' } }) })).toEqual({ status: 'unknown' });
  });
  it('connects directly to loopback without leaking bearer token to an active environment proxy', async () => {
    let proxyHits = 0;
    const { createServer } = await import('node:http');
    const proxyServer = createServer((_req, res) => {
      proxyHits++;
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('bad gateway from proxy');
    });
    await new Promise<void>(resolve => proxyServer.listen(0, '127.0.0.1', () => resolve()));
    const proxyPort = (proxyServer.address() as { port: number }).port;
    const prevHttpProxy = process.env.HTTP_PROXY;
    const prevHttpProxyLower = process.env.http_proxy;
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
    process.env.http_proxy = `http://127.0.0.1:${proxyPort}`;

    try {
      const { broker } = make();
      const a = await broker.create('a');
      broker.send('a', { channelId: a.channelId!, text: 'secret message' });
      const result = await pollObservedInbox(paired(a));
      expect(result).toMatchObject({ status: 'message', message: { text: 'secret message' } });
      expect(proxyHits).toBe(0);
    } finally {
      if (prevHttpProxy !== undefined) process.env.HTTP_PROXY = prevHttpProxy;
      else delete process.env.HTTP_PROXY;
      if (prevHttpProxyLower !== undefined) process.env.http_proxy = prevHttpProxyLower;
      else delete process.env.http_proxy;
      await new Promise<void>(resolve => proxyServer.close(() => resolve()));
    }
  });
});
