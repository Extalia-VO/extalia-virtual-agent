import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { awaitObservedReply, isObservedReplyRequest } from '../src/observedReplyClient.js';

const token = 'a'.repeat(64);
const route = '/reply/12345678-1234-1234-1234-123456789abc';
const request = { url: `http://127.0.0.1:4321${route}`, token, question: 'Continue?' };
const servers: Server[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });

describe('cooperative reply client', () => {
  it.each([
    'https://127.0.0.1:4321', 'http://localhost:4321', 'http://example.com:4321',
    'http://127.0.0.2:4321', 'http://2130706433:4321', 'http://user@127.0.0.1:4321',
  ])('refuses a noncanonical or foreign destination: %s', async base => {
    const fetch = vi.fn();
    expect(await awaitObservedReply({ ...request, url: `${base}${route}` }, { fetch })).toEqual({ status: 'unavailable' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses arbitrary paths, query strings and malformed credentials', () => {
    for (const url of [request.url + '?token=x', request.url + '#x', request.url.replace('/reply/', '/other/'), 'http://127.0.0.1' + route]) {
      expect(isObservedReplyRequest({ ...request, url })).toBe(false);
    }
    expect(isObservedReplyRequest({ ...request, token: 'secret' })).toBe(false);
    expect(isObservedReplyRequest({ ...request, question: 'q'.repeat(2001) })).toBe(false);
  });

  it('posts only the question and returns the exact original-call answer', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toEqual({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
      expect(init?.body).toBe(JSON.stringify({ question: 'Continue?' }));
      return Response.json({ status: 'answered', text: 'Yes\nProceed.' });
    });
    expect(await awaitObservedReply(request, { fetch })).toEqual({ status: 'answered', text: 'Yes\nProceed.' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['expired', 'unavailable'] as const)('preserves %s without manufacturing an answer', async status => {
    expect(await awaitObservedReply(request, { fetch: async () => Response.json({ status }) })).toEqual({ status });
  });

  it.each([{ status: 'expired', http: 408 }, { status: 'unavailable', http: 410 }])('preserves broker status $status on HTTP $http', async ({ status, http }) => {
    expect(await awaitObservedReply(request, { fetch: async () => Response.json({ status }, { status: http }) })).toEqual({ status });
    expect(await awaitObservedReply(request, { fetch: async () => Response.json({ status: 'answered', text: 'forged' }, { status: http }) })).toEqual({ status: 'unavailable' });
  });

  it('bounds streamed bytes and cancels the response body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1)); }, cancel });
    expect(await awaitObservedReply(request, { fetch: async () => new Response(body) })).toEqual({ status: 'unavailable' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Response('not json'), Response.json({ status: 'answered', text: 42 }),
    Response.json({ status: 'other' }), new Response('secret', { status: 403 }),
    new Response('{}', { headers: { 'content-length': '70000' } }),
    Response.json({ status: 'answered', text: 'x'.repeat(16001) }),
  ])('returns sanitized unavailable for invalid or failed responses', async response => {
    expect(await awaitObservedReply(request, { fetch: async () => response })).toEqual({ status: 'unavailable' });
  });

  it('preserves the 16000-character Unicode answer within the byte cap', async () => {
    const text = '界'.repeat(16000);
    expect(await awaitObservedReply(request, { fetch: async () => Response.json({ status: 'answered', text }) })).toEqual({ status: 'answered', text });
  });

  it('does not admit a request after caller cancellation', async () => {
    const fetch = vi.fn();
    const controller = new AbortController();
    controller.abort();
    expect(await awaitObservedReply(request, { fetch, signal: controller.signal })).toEqual({ status: 'unavailable' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('enforces the 50 second deadline without retrying', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('private transport details')));
    }));
    const result = awaitObservedReply(request, { fetch });
    await vi.advanceTimersByTimeAsync(50_000);
    expect(await result).toEqual({ status: 'unavailable' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not follow an actual HTTP redirect or disclose the token to its target', async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => { seen.push(req.url ?? ''); res.writeHead(302, { location: '/other' }); res.end(); });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test address');
    expect(await awaitObservedReply({ ...request, url: `http://127.0.0.1:${address.port}${route}` })).toEqual({ status: 'unavailable' });
    expect(seen).toEqual([route]);
  });

  it('caller cancellation closes an actual held request', async () => {
    let admitted!: () => void;
    const started = new Promise<void>(resolve => { admitted = resolve; });
    let disconnected!: () => void;
    const closed = new Promise<void>(resolve => { disconnected = resolve; });
    const server = createServer((_req, res) => { res.on('close', disconnected); admitted(); });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test address');
    const controller = new AbortController();
    const result = awaitObservedReply({ ...request, url: `http://127.0.0.1:${address.port}${route}` }, { signal: controller.signal });
    await started;
    controller.abort();
    expect(await result).toEqual({ status: 'unavailable' });
    await closed;
  });
});
