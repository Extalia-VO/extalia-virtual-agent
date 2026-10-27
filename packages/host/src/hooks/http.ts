import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isHookApp, type HookApp } from './normalize.js';

/**
 * The hook ingest endpoint, shared by the Bridge and Desktop:
 * `POST http://127.0.0.1:<port>/api/hooks/<codex|claude|gemini|hermes>`.
 *
 * Rules: loopback only (the caller binds 127.0.0.1 and checks the Host header);
 * any request with an `Origin` header is refused (browsers always send one on
 * cross-site POSTs); `Content-Type: application/json`; at most 64 KB; per-app
 * rate limit; `Authorization: Bearer <ingest token>` or, for Hermes,
 * `X-Hermes-Signature-256: sha256=<HMAC-SHA256 of the raw body keyed with the token>`.
 * Accepted requests always get `204` with an empty body, even for unknown,
 * malformed or rate-limited events, so a hook can never block or steer the agent.
 * Only 401 (auth), 413 (size) and 415 (type) are reported; 403/404/405 are routing.
 */

export const HOOK_BODY_LIMIT = 64 * 1024;
export const HOOK_RATE_PER_SECOND = 50;
export const HOOK_PATH = /^\/api\/hooks\/([^/]+)$/;
export const HERMES_SIGNATURE_HEADER = 'x-hermes-signature-256';

/** Token bucket per app: `rate` events per second, bursts up to twice that. */
export class HookRateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private rate = HOOK_RATE_PER_SECOND, private burst = HOOK_RATE_PER_SECOND * 2, private now: () => number = Date.now) {}
  take(key: string): boolean {
    const time = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, at: time };
    bucket.tokens = Math.min(this.burst, bucket.tokens + ((time - bucket.at) / 1000) * this.rate);
    bucket.at = time;
    this.buckets.set(key, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest();

/** Constant-time comparison of a presented secret with the expected one. */
export function secretMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string' || !given) return false;
  return timingSafeEqual(sha(expected), sha(given));
}

export function hermesSignature(token: string, body: Buffer | string): string {
  return `sha256=${createHmac('sha256', token).update(body).digest('hex')}`;
}

export function signatureMatches(token: string, body: Buffer, header: unknown): boolean {
  if (typeof header !== 'string' || !/^sha256=[0-9a-fA-F]{64}$/.test(header.trim())) return false;
  return timingSafeEqual(sha(hermesSignature(token, body)), sha(`sha256=${header.trim().slice(7).toLowerCase()}`));
}

const bearer = (header: unknown) => typeof header === 'string' ? /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1] : undefined;

export interface HookRequestOptions {
  /** True when the presented secret is the current ingest token (re-reads the file after a rotation). */
  verifyToken(given: string): Promise<boolean>;
  /** True when the Hermes HMAC signature of the raw body matches the current token. */
  verifySignature(body: Buffer, header: string): Promise<boolean>;
  /** Receives every authenticated JSON object; must not throw or block. */
  deliver(app: HookApp, payload: Record<string, unknown>): void;
  limiter: HookRateLimiter;
  maxBodyBytes?: number;
}

function reply(response: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'Content-Length': '0', 'Cache-Control': 'no-store', ...headers });
  response.end();
}

/**
 * Discard what is left of the request before answering, so the client reads the
 * status instead of a connection reset; bounded in size and time.
 */
function discard(request: IncomingMessage, limit: number): Promise<void> {
  if (request.complete || request.readableEnded) return Promise.resolve();
  return new Promise(resolve => {
    let size = 0;
    const done = () => { clearTimeout(timer); request.off('data', onData); resolve(); };
    const onData = (chunk: Buffer) => { size += chunk.length; if (size > limit * 4) done(); };
    const timer = setTimeout(done, 2_000);
    request.on('data', onData);
    request.once('end', done);
    request.once('close', done);
    request.once('error', done);
    request.resume();
  });
}

function readLimited(request: IncomingMessage, limit: number): Promise<Buffer | 'too-large'> {
  if (Number(request.headers['content-length']) > limit) return Promise.resolve('too-large');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) { chunks.push(chunk); return; }
      request.off('data', onData);
      resolve('too-large');
    };
    request.on('data', onData);
    request.once('end', () => resolve(Buffer.concat(chunks)));
    request.once('error', reject);
  });
}

const isJson = (value: string | undefined) => value?.split(';')[0]?.trim().toLowerCase() === 'application/json';

/** Handle one request to `/api/hooks/<app>`. The caller has already checked the Host header. */
export async function handleHookRequest(request: IncomingMessage, response: ServerResponse, app: string, options: HookRequestOptions): Promise<void> {
  const limit = options.maxBodyBytes ?? HOOK_BODY_LIMIT;
  response.setHeader('X-Content-Type-Options', 'nosniff');
  // Browsers attach Origin to cross-site POSTs; agent apps and the forwarder never do.
  if (request.headers.origin !== undefined) { await discard(request, limit); reply(response, 403, { Connection: 'close' }); return; }
  if (request.method !== 'POST') { await discard(request, limit); reply(response, 405, { Allow: 'POST' }); return; }
  if (!isHookApp(app)) { await discard(request, limit); reply(response, 404); return; }
  if (!isJson(request.headers['content-type'])) { await discard(request, limit); reply(response, 415, { Connection: 'close' }); return; }

  const presented = bearer(request.headers.authorization);
  const signature = request.headers[HERMES_SIGNATURE_HEADER];
  const byToken = presented !== undefined && await options.verifyToken(presented);
  if (!byToken && !(app === 'hermes' && typeof signature === 'string')) { await discard(request, limit); reply(response, 401, { Connection: 'close' }); return; }

  let body: Buffer | 'too-large';
  try { body = await readLimited(request, limit); }
  catch { reply(response, 204); return; }
  if (body === 'too-large') { await discard(request, limit); reply(response, 413, { Connection: 'close' }); return; }
  if (!byToken && !(await options.verifySignature(body, signature as string))) { reply(response, 401, { Connection: 'close' }); return; }

  if (options.limiter.take(app)) {
    let payload: unknown;
    try { payload = JSON.parse(body.toString('utf8')); } catch { payload = undefined; }
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      try { options.deliver(app, payload as Record<string, unknown>); } catch { /* a hook never fails the agent */ }
    }
  }
  reply(response, 204);
}

export interface HookListener { port: number; close(): Promise<void> }

/**
 * A loopback HTTP listener serving only `/api/hooks/<app>` (Desktop). It binds
 * 127.0.0.1, prefers `port` and falls back to a free port when it is taken.
 */
export async function startHookListener(options: { port?: number; handle(request: IncomingMessage, response: ServerResponse, app: string): Promise<void> }): Promise<HookListener> {
  let allowed = new Set<string>();
  const server = createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // DNS rebinding defense: only names that are this machine by definition.
    if (!allowed.has(request.headers.host?.toLowerCase() ?? '')) { request.resume(); reply(response, 403, { Connection: 'close' }); return; }
    let pathname: string;
    try { pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname; } catch { request.resume(); reply(response, 400); return; }
    const match = HOOK_PATH.exec(pathname);
    if (!match) { request.resume(); reply(response, 404); return; }
    options.handle(request, response, match[1]!).catch(() => reply(response, 204));
  });
  const listen = (port: number) => new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  try { await listen(options.port ?? 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || !options.port) throw error;
    await listen(0);
  }
  const port = (server.address() as AddressInfo).port;
  allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return {
    port,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
