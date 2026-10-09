import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentHostApi, UpdateStatus } from '@extalia/platform';
import type { ExtaliaEvent } from '@extalia/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BridgeRequestError, CONTENT_SECURITY_POLICY, MAX_BODY_BYTES, TOKEN_HEADER, createToken, injectBridgeToken, resolveStaticFile,
  startBridgeServer, tokenMatches, type BridgeServer, type BridgeServerOptions,
} from '../src/bridge/server';

interface Reply { status: number; headers: IncomingHttpHeaders; body: string }
interface Send { method?: string; path?: string; headers?: Record<string, string>; body?: string; host?: string | null; chunks?: string[] }

function send(port: number, { method = 'GET', path: target = '/', headers = {}, body, host = `127.0.0.1:${port}`, chunks }: Send = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const allHeaders: Record<string, string> = { ...headers };
    if (host !== null) allHeaders.host = host;
    const req = request({ host: '127.0.0.1', port, method, path: target, headers: allHeaders, setHost: false }, res => {
      const parts: Buffer[] = [];
      res.on('data', (chunk: Buffer) => parts.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts).toString('utf8') }));
    });
    req.on('error', reject);
    if (chunks) { for (const chunk of chunks) req.write(chunk); req.end(); } else req.end(body);
  });
}

const event = (n: number) => ({
  v: 'extalia.v0', id: `e-${n}`, at: '2026-01-31T12:00:00.000Z', sessionId: 's', source: { runtime: 'extalia', channel: 'stream' }, body: { type: 'model.delta', text: `hi ${n}` },
}) as unknown as ExtaliaEvent;

class FakeHost {
  listeners = new Set<(event: ExtaliaEvent) => void>();
  calls: unknown[][] = [];
  state = { setupComplete: true };
  async getState() { return this.state; }
  async renameSession(id: string, title: string) {
    this.calls.push([id, title]);
    if (title === 'boom') throw Object.assign(new Error('Session not found.'), { secret: 'internal detail' });
    return this.state;
  }
  async cancel() { return undefined; }
  subscribe(listener: (event: ExtaliaEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  emit(value: ExtaliaEvent) { for (const listener of this.listeners) listener(value); }
}

const status = (state: UpdateStatus['state']): UpdateStatus => ({ current: '1.0.0', channel: 'stable', state, command: 'npm i -g extalia-vo@latest --prefer-online' });

describe('Bridge server', () => {
  let dir: string, webRoot: string, fake: FakeHost, server: BridgeServer;
  const servers: BridgeServer[] = [];

  async function start(overrides: Partial<BridgeServerOptions> = {}): Promise<BridgeServer> {
    const value = await startBridgeServer({
      port: 0,
      webRoot,
      agents: async () => fake as unknown as AgentHostApi,
      updates: {
        status: () => status('idle'),
        check: async () => status('up-to-date'),
        install: async () => { throw new BridgeRequestError('Agents are still working.', 409); },
      },
      ...overrides,
    });
    servers.push(value);
    return value;
  }

  const call = (body: unknown, headers: Record<string, string> = {}) => send(server.port, {
    method: 'POST', path: '/api/call', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', [TOKEN_HEADER]: server.token, ...headers },
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'extalia-bridge-'));
    webRoot = path.join(dir, 'web');
    await mkdir(path.join(webRoot, 'assets'), { recursive: true });
    await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><html><head>\n<title>Extalia</title>\n<script type="module" crossorigin src="./assets/index.js"></script>\n<link rel="icon" href="./favicon.svg" />\n</head><body></body></html>');
    await writeFile(path.join(webRoot, 'assets', 'index.js'), 'console.log("app");');
    await writeFile(path.join(webRoot, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(path.join(dir, 'secret.txt'), 'top secret');
    fake = new FakeHost();
    server = await start();
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(value => value.close()));
    await rm(dir, { recursive: true, force: true });
  });

  it('serves index.html with the token, CSP and no-store', async () => {
    const reply = await send(server.port);
    expect(reply.status).toBe(200);
    expect(reply.body).toContain(`<meta name="extalia-bridge" content="${server.token}">`);
    expect(reply.body).toContain('src="/assets/index.js"');
    expect(reply.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
    expect(server.token).toMatch(/^[0-9a-f]{64}$/);
    expect((await send(server.port, { path: '/index.html' })).body).toContain(server.token);
  });

  it('serves assets with content types and falls back to index.html for page routes', async () => {
    const asset = await send(server.port, { path: '/assets/index.js' });
    expect(asset.status).toBe(200);
    expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(asset.headers['x-content-type-options']).toBe('nosniff');
    expect((await send(server.port, { path: '/favicon.svg' })).headers['content-type']).toBe('image/svg+xml');
    const route = await send(server.port, { path: '/sessions/abc?tab=chat' });
    expect(route.status).toBe(200);
    expect(route.body).toContain(server.token);
    expect((await send(server.port, { path: '/assets/missing.js' })).status).toBe(404);
    const head = await send(server.port, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    const post = await send(server.port, { method: 'POST', path: '/' });
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET, HEAD');
  });

  it('never serves files outside the web root', async () => {
    for (const target of ['/..%2fsecret.txt', '/%2e%2e%2fsecret.txt', '/assets/..%2f..%2fsecret.txt', '/..%5csecret.txt', '/%00index.html', '/%E0%A4%A']) {
      const reply = await send(server.port, { path: target });
      expect(reply.body, target).not.toContain('top secret');
      expect(reply.status, target).toBe(404);
    }
    const normalized = await send(server.port, { path: '/../secret.txt' });
    expect(normalized.body).not.toContain('top secret');
  });

  it('explains how to build the UI when the web build is missing', async () => {
    const bare = await start({ webRoot: path.join(dir, 'missing') });
    const reply = await send(bare.port);
    expect(reply.status).toBe(503);
    expect(reply.body).toContain('pnpm --filter @extalia/web build');
    expect(reply.body).not.toContain(bare.token);
  });

  it('rejects requests whose Host header is not the loopback address and port', async () => {
    for (const host of ['evil.example.com', `evil.example.com:${server.port}`, `127.0.0.1:${server.port + 1}`, `localhost:${server.port}.evil.example.com`, '127.0.0.1', `[::1]:${server.port}`]) {
      expect((await send(server.port, { host })).status, String(host)).toBe(403);
      expect((await send(server.port, { host, path: '/api/update', headers: { [TOKEN_HEADER]: server.token } })).status, String(host)).toBe(403);
    }
    // Node itself answers 400 when HTTP/1.1 requests omit Host.
    expect((await send(server.port, { host: null })).status).toBe(400);
    expect((await send(server.port, { host: `localhost:${server.port}` })).status).toBe(200);
    expect((await send(server.port, { host: `LOCALHOST:${server.port}` })).status).toBe(200);
  });

  it('requires the token on API calls', async () => {
    expect((await call({ method: 'getState', args: [] }, { [TOKEN_HEADER]: '' })).status).toBe(401);
    expect((await call({ method: 'getState', args: [] }, { [TOKEN_HEADER]: createToken() })).status).toBe(401);
    expect((await call({ method: 'getState', args: [] }, { [TOKEN_HEADER]: server.token.slice(1) })).status).toBe(401);
    const missing = await send(server.port, { method: 'POST', path: '/api/call', body: '{"method":"getState","args":[]}', headers: { 'content-type': 'application/json' } });
    expect(missing.status).toBe(401);
    expect(JSON.parse(missing.body)).toEqual({ error: 'Missing or invalid Bridge token.' });
    for (const target of ['/api/update']) expect((await send(server.port, { path: target })).status).toBe(401);
    for (const target of ['/api/update/check', '/api/update/install']) expect((await send(server.port, { method: 'POST', path: target })).status).toBe(401);
  });

  it('rejects foreign origins and accepts the served origin', async () => {
    for (const origin of ['http://evil.example.com', `http://127.0.0.1:${server.port + 1}`, `https://127.0.0.1:${server.port}`, 'null']) {
      expect((await call({ method: 'getState', args: [] }, { origin })).status, origin).toBe(403);
    }
    expect((await call({ method: 'getState', args: [] }, { origin: `http://127.0.0.1:${server.port}` })).status).toBe(200);
    // The origin must match the name the page was loaded from.
    expect((await call({ method: 'getState', args: [] }, { origin: `http://localhost:${server.port}` })).status).toBe(403);
    expect((await send(server.port, {
      method: 'POST', path: '/api/call', host: `localhost:${server.port}`, body: '{"method":"getState","args":[]}',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: server.token, origin: `http://localhost:${server.port}` },
    })).status).toBe(200);
  });

  it('accepts only JSON calls of whitelisted methods with array arguments', async () => {
    expect((await call({ method: 'getState', args: [] }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await call({ method: 'getState', args: [] }, { 'content-type': 'application/json; charset=utf-8' })).status).toBe(200);
    for (const method of ['subscribe', 'constructor', '__proto__', 'toString', 'emit', 42, undefined]) {
      const reply = await call({ method, args: [] });
      expect(reply.status, String(method)).toBe(400);
      expect(JSON.parse(reply.body)).toEqual({ error: 'Unknown method.' });
    }
    for (const args of [undefined, 'x', { 0: 'a' }, null]) expect((await call({ method: 'getState', args })).status).toBe(400);
    for (const body of ['[]', 'null', '"getState"']) expect((await send(server.port, { method: 'POST', path: '/api/call', body, headers: { 'content-type': 'application/json', [TOKEN_HEADER]: server.token } })).status).toBe(400);
    const invalid = await send(server.port, { method: 'POST', path: '/api/call', body: '{nope', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: server.token } });
    expect(invalid.status).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it('rejects bodies over the limit', async () => {
    const big = JSON.stringify({ method: 'renameSession', args: ['s', 'x'.repeat(MAX_BODY_BYTES)] });
    const declared = await send(server.port, { method: 'POST', path: '/api/call', body: big, headers: { 'content-type': 'application/json', [TOKEN_HEADER]: server.token, 'content-length': String(Buffer.byteLength(big)) } });
    expect(declared.status).toBe(413);
    const small = await start({ maxBodyBytes: 64 });
    const streamed = await send(small.port, {
      method: 'POST', path: '/api/call', chunks: ['{"method":"renameSession","args":["s","', 'x'.repeat(100), '"]}'],
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: small.token, 'transfer-encoding': 'chunked' },
    });
    expect(streamed.status).toBe(413);
    expect(fake.calls).toEqual([]);
  });

  it('maps host results and errors without leaking internals', async () => {
    const state = await call({ method: 'getState', args: [] });
    expect(state.status).toBe(200);
    expect(state.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(state.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(state.body)).toEqual({ result: { setupComplete: true } });
    expect(JSON.parse((await call({ method: 'cancel', args: ['s'] })).body)).toEqual({ result: null });
    expect((await call({ method: 'renameSession', args: ['s', 'New title'] })).status).toBe(200);
    expect(fake.calls).toEqual([['s', 'New title']]);
    const failure = await call({ method: 'renameSession', args: ['s', 'boom'] });
    expect(failure.status).toBe(500);
    expect(JSON.parse(failure.body)).toEqual({ error: 'Session not found.' });
    expect(failure.body).not.toMatch(/at |internal detail|stack/);
    // Methods the fake does not implement fail like host errors, not crashes.
    expect((await call({ method: 'sendPrompt', args: ['s', 'hi'] })).status).toBe(500);
  });

  it('reports unavailable agents but keeps serving the UI', async () => {
    const down = await start({ agents: () => Promise.reject(new Error('the host failed to start')) });
    const reply = await send(down.port, { method: 'POST', path: '/api/call', body: '{"method":"getState","args":[]}', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: down.token } });
    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body)).toEqual({ error: 'Agents are not available: the host failed to start' });
    expect((await send(down.port)).status).toBe(200);
  });

  it('streams host events over SSE with pings and unsubscribes on close', async () => {
    const live = await start({ pingIntervalMs: 20 });
    const received = await new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: live.port, path: `/api/events?token=${live.token}` }, res => {
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
          if (fake.listeners.size && !text.includes('data:')) { fake.emit(event(1)); fake.emit(event(2)); }
          if (text.includes('"e-2"') && text.includes(': ping')) { req.destroy(); resolve(text); }
        });
      });
      req.on('error', error => { if (!req.destroyed) reject(error); });
      req.end();
    });
    const data = received.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as { id: string });
    expect(data.map(item => item.id)).toEqual(['e-1', 'e-2']);
    await expect.poll(() => fake.listeners.size).toBe(0);
  });

  it('rejects event streams without the token or from foreign origins', async () => {
    expect((await send(server.port, { path: '/api/events' })).status).toBe(401);
    expect((await send(server.port, { path: `/api/events?token=${createToken()}` })).status).toBe(401);
    expect((await send(server.port, { path: `/api/events?token=${server.token}`, headers: { origin: 'http://evil.example.com' } })).status).toBe(403);
    expect((await send(server.port, { method: 'POST', path: `/api/events?token=${server.token}` })).status).toBe(405);
    expect(fake.listeners.size).toBe(0);
  });

  it('answers update requests with UpdateStatus and maps refusals', async () => {
    const headers = { [TOKEN_HEADER]: server.token };
    expect(JSON.parse((await send(server.port, { path: '/api/update', headers })).body)).toMatchObject({ state: 'idle', current: '1.0.0' });
    expect(JSON.parse((await send(server.port, { method: 'POST', path: '/api/update/check', headers })).body)).toMatchObject({ state: 'up-to-date' });
    const install = await send(server.port, { method: 'POST', path: '/api/update/install', headers });
    expect(install.status).toBe(409);
    expect(JSON.parse(install.body)).toEqual({ error: 'Agents are still working.' });
    expect((await send(server.port, { path: '/api/update/install', headers })).status).toBe(405);
    expect((await send(server.port, { path: '/api/nothing', headers })).status).toBe(404);
  });

  it('never sends CORS headers', async () => {
    const replies = [
      await send(server.port, { method: 'OPTIONS', path: '/api/call', headers: { origin: 'http://evil.example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': TOKEN_HEADER } }),
      await call({ method: 'getState', args: [] }, { origin: `http://127.0.0.1:${server.port}` }),
      await send(server.port, { headers: { origin: 'http://evil.example.com' } }),
    ];
    expect(replies[0]?.status).toBe(405);
    for (const reply of replies) expect(Object.keys(reply.headers).filter(name => name.startsWith('access-control-'))).toEqual([]);
  });

  it('refuses to listen beyond loopback and needs a well-formed token', async () => {
    await expect(start({ host: '0.0.0.0' })).rejects.toThrow(/only listens on 127\.0\.0\.1/);
    await expect(start({ token: 'short' })).rejects.toThrow(/64 hexadecimal/);
  });
});

describe('Bridge helpers', () => {
  it('injects the token right after <head> and roots relative URLs', () => {
    const html = injectBridgeToken('<html><head lang="x"><script src="./assets/a.js"></script><link href=\'./b.css\'></head></html>', 'abc');
    expect(html).toMatch(/^<html><head lang="x">\n\s+<meta name="extalia-bridge" content="abc">/);
    expect(html).toContain('src="/assets/a.js"');
    expect(html).toContain("href='/b.css'");
    expect(injectBridgeToken('<p>no head</p>', 'abc')).toBe('<meta name="extalia-bridge" content="abc">\n<p>no head</p>');
    expect(injectBridgeToken('<header></header>', 'abc').startsWith('<meta')).toBe(true);
  });

  it('resolves static paths inside the root only', () => {
    const root = path.resolve('/srv/web');
    expect(resolveStaticFile(root, '/')).toBe(path.join(root, 'index.html'));
    expect(resolveStaticFile(root, '/assets/a.js')).toBe(path.join(root, 'assets', 'a.js'));
    expect(resolveStaticFile(root, '/..%2f..%2fetc/passwd')).toBeUndefined();
    expect(resolveStaticFile(root, '/%00')).toBeUndefined();
    expect(resolveStaticFile(root, '/%E0%A4%A')).toBeUndefined();
  });

  it('compares tokens in constant time and rejects non-strings', () => {
    const token = createToken();
    expect(tokenMatches(token, token)).toBe(true);
    expect(tokenMatches(token, token.toUpperCase())).toBe(false);
    expect(tokenMatches(token, `${token}0`)).toBe(false);
    expect(tokenMatches(token, undefined)).toBe(false);
    expect(tokenMatches(token, [token])).toBe(false);
    expect(createToken()).not.toBe(token);
  });
});
