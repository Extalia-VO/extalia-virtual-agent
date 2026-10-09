import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { isAgentHostMethod, type AgentHostApi, type UpdateStatus } from '@extalia/platform';

/**
 * The local Extalia Bridge: serves the web UI and exposes the agent host over
 * HTTP + Server-Sent Events on the loopback interface only.
 *
 * Defenses: loopback bind, Host allow-list (DNS rebinding), per-launch token
 * (constant-time compare), Origin check, JSON-only bodies (forces a CORS
 * preflight, which fails because no CORS headers are ever sent), body limit.
 */

export const BRIDGE_HOST = '127.0.0.1';
export const TOKEN_HEADER = 'x-extalia-token';
export const MAX_BODY_BYTES = 1024 * 1024;
export const PING_INTERVAL_MS = 15_000;
/** A client that stops reading events is dropped instead of buffering without bound; it reconnects and reloads. */
const MAX_EVENT_BACKLOG_BYTES = 8 * 1024 * 1024;

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
} as const;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.ktx2': 'image/ktx2',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Thrown by update handlers to refuse a request with a specific status (for example 409 while agents work). */
export class BridgeRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface BridgeUpdates {
  status(): UpdateStatus;
  check(): Promise<UpdateStatus>;
  /** Start installing; resolves to the status to report, or throws BridgeRequestError. */
  install(): Promise<UpdateStatus>;
}

export interface BridgeServerOptions {
  port: number;
  /** Loopback only; defaults to 127.0.0.1. */
  host?: string;
  /** Directory with the built web UI (index.html and assets). */
  webRoot: string;
  /** 64 hex characters; a fresh random token by default. */
  token?: string;
  /** Resolves to the agent host, or rejects with the reason agents are unavailable. */
  agents(): Promise<AgentHostApi>;
  updates: BridgeUpdates;
  pingIntervalMs?: number;
  maxBodyBytes?: number;
}

export interface BridgeServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

export function createToken(): string {
  return randomBytes(32).toString('hex');
}

/** Constant-time token comparison; hashing first makes inputs of any length comparable. */
export function tokenMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string' || !given) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(expected), digest(given));
}

/** Add the Bridge token for the web client and root relative asset URLs so deep links resolve. */
export function injectBridgeToken(html: string, token: string): string {
  const meta = `<meta name="extalia-bridge" content="${token}">`;
  // The UI is built with relative URLs for Desktop's app protocol; the Bridge always serves it from `/`.
  const rooted = html.replace(/(\s(?:src|href)=["'])\.\//g, '$1/');
  const head = /<head(?:\s[^>]*)?>/i;
  return head.test(rooted) ? rooted.replace(head, match => `${match}\n    ${meta}`) : `${meta}\n${rooted}`;
}

/** Map a URL path to a file inside the web root; undefined for anything that would escape it. */
export function resolveStaticFile(webRoot: string, pathname: string): string | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return undefined; }
  if (decoded.includes('\0')) return undefined;
  const relative = decoded.replace(/^[/\\]+/, '') || 'index.html';
  const root = path.resolve(webRoot);
  const file = path.resolve(root, relative);
  return file.startsWith(root + path.sep) ? file : undefined;
}

function isJsonContentType(value: string | undefined): boolean {
  return value?.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === 'string' && error ? error : 'Unexpected error.';
}

class BodyTooLargeError extends Error {}

function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  if (Number(request.headers['content-length']) > limit) return Promise.reject(new BodyTooLargeError());
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) { chunks.push(chunk); return; }
      request.off('data', onData);
      request.resume();
      reject(new BodyTooLargeError());
    };
    request.on('data', onData);
    request.once('end', () => resolve(Buffer.concat(chunks)));
    request.once('error', reject);
  });
}

function send(response: ServerResponse, status: number, body: string | Buffer, headers: OutgoingHttpHeaders, head = false): void {
  const buffer = typeof body === 'string' ? Buffer.from(body) : body;
  response.writeHead(status, { ...headers, 'Content-Length': buffer.length });
  response.end(head ? undefined : buffer);
}

function sendJson(response: ServerResponse, status: number, value: unknown, headers: OutgoingHttpHeaders = {}): void {
  send(response, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
}

const sendError = (response: ServerResponse, status: number, error: string, headers?: OutgoingHttpHeaders) => sendJson(response, status, { error }, headers);

const MISSING_WEB_PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Extalia</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5">
    <h1>The Extalia web UI is not bundled</h1>
    <p>This copy of the <code>extalia</code> command was built without the web UI. From a source checkout, build both and start again:</p>
    <pre>pnpm --filter @extalia/web build
pnpm --filter extalia-vo build
node apps/cli/dist/extalia.mjs</pre>
  </body>
</html>
`;

type Route = { method: 'GET' | 'POST'; handle(request: IncomingMessage, response: ServerResponse): Promise<void> | void };

export async function startBridgeServer(options: BridgeServerOptions): Promise<BridgeServer> {
  const host = options.host ?? BRIDGE_HOST;
  // The Bridge runs agents with the user's files and credentials; it never listens on the network.
  if (host !== BRIDGE_HOST) throw new Error(`The Bridge only listens on ${BRIDGE_HOST}.`);
  const token = options.token ?? createToken();
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('The Bridge token must be 64 hexadecimal characters.');
  const webRoot = path.resolve(options.webRoot);
  const indexFile = path.join(webRoot, 'index.html');
  const maxBody = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const pingInterval = options.pingIntervalMs ?? PING_INTERVAL_MS;
  let port = options.port;
  let allowedHosts = new Set<string>();

  async function serveIndex(response: ServerResponse, head: boolean): Promise<void> {
    let html: string;
    try { html = await readFile(indexFile, 'utf8'); }
    catch { send(response, 503, MISSING_WEB_PAGE, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': CONTENT_SECURITY_POLICY }, head); return; }
    send(response, 200, injectBridgeToken(html, token), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': CONTENT_SECURITY_POLICY }, head);
  }

  async function serveStatic(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
    const head = request.method === 'HEAD';
    if (request.method !== 'GET' && !head) { send(response, 405, 'Method not allowed', { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' }); return; }
    const file = resolveStaticFile(webRoot, pathname);
    if (!file) { send(response, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' }, head); return; }
    if (file === indexFile) return serveIndex(response, head);
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) {
      // SPA fallback for page routes; a missing asset stays a 404 instead of HTML under a script URL.
      const pageRoute = !path.extname(pathname) || (request.headers.accept ?? '').includes('text/html');
      if (pageRoute) return serveIndex(response, head);
      send(response, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' }, head);
      return;
    }
    const headers: OutgoingHttpHeaders = {
      'Content-Type': contentTypeFor(file),
      'Content-Length': info.size,
      // Vite content-hashes everything under assets/; other files revalidate.
      'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    if (file.endsWith('.html')) headers['Content-Security-Policy'] = CONTENT_SECURITY_POLICY;
    response.writeHead(200, headers);
    if (head) { response.end(); return; }
    const stream = createReadStream(file);
    stream.once('error', () => response.destroy());
    stream.pipe(response);
  }

  async function agentsOrError(response: ServerResponse): Promise<AgentHostApi | undefined> {
    try { return await options.agents(); }
    catch (error) { sendError(response, 503, `Agents are not available: ${errorMessage(error)}`); return undefined; }
  }

  async function handleCall(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isJsonContentType(request.headers['content-type'])) { sendError(response, 415, 'Content-Type must be application/json.'); return; }
    let body: Buffer;
    try { body = await readBody(request, maxBody); }
    catch (error) {
      if (error instanceof BodyTooLargeError) sendError(response, 413, `Request body is larger than ${maxBody} bytes.`, { Connection: 'close' });
      else sendError(response, 400, 'Could not read the request body.');
      return;
    }
    let payload: unknown;
    try { payload = JSON.parse(body.toString('utf8')); } catch { sendError(response, 400, 'Request body is not valid JSON.'); return; }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) { sendError(response, 400, 'Expected { "method": string, "args": array }.'); return; }
    const { method, args } = payload as { method?: unknown; args?: unknown };
    if (!isAgentHostMethod(method)) { sendError(response, 400, 'Unknown method.'); return; }
    if (!Array.isArray(args)) { sendError(response, 400, 'args must be an array.'); return; }
    const host = await agentsOrError(response);
    if (!host) return;
    try {
      const call = host[method] as (...values: unknown[]) => Promise<unknown>;
      const result = await call.apply(host, args);
      sendJson(response, 200, { result: result === undefined ? null : result });
    } catch (error) {
      // Host messages are meant for the user; stacks and other properties never leave the process.
      sendError(response, 500, errorMessage(error));
    }
  }

  function handleEvents(_request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    let closed = false;
    let unsubscribe: (() => void) | undefined;
    const write = (chunk: string) => {
      if (closed || response.destroyed) return;
      if (response.writableLength > MAX_EVENT_BACKLOG_BYTES) { response.destroy(); return; }
      response.write(chunk);
    };
    // Reconnect quickly after a restart (for example after an in-app update).
    write('retry: 2000\n\n');
    const ping = setInterval(() => write(': ping\n\n'), pingInterval);
    response.on('error', () => undefined);
    response.once('close', () => {
      closed = true;
      clearInterval(ping);
      unsubscribe?.();
    });
    // Without agents the stream stays open with pings, so the client still notices restarts.
    options.agents().then(host => {
      if (closed) return;
      unsubscribe = host.subscribe(event => write(`data: ${JSON.stringify(event)}\n\n`));
    }, () => undefined);
  }

  async function handleUpdate(response: ServerResponse, action: () => UpdateStatus | Promise<UpdateStatus>): Promise<void> {
    try { sendJson(response, 200, await action()); }
    catch (error) {
      if (error instanceof BridgeRequestError) sendError(response, error.status, error.message);
      else sendError(response, 500, errorMessage(error));
    }
  }

  const routes: Record<string, Route> = {
    '/api/call': { method: 'POST', handle: handleCall },
    '/api/events': { method: 'GET', handle: handleEvents },
    '/api/update': { method: 'GET', handle: (_request, response) => handleUpdate(response, () => options.updates.status()) },
    '/api/update/check': { method: 'POST', handle: (_request, response) => handleUpdate(response, () => options.updates.check()) },
    '/api/update/install': { method: 'POST', handle: (_request, response) => handleUpdate(response, () => options.updates.install()) },
  };

  async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const route = Object.hasOwn(routes, url.pathname) ? routes[url.pathname] : undefined;
    if (!route) { sendError(response, 404, 'Not found.'); return; }
    if (request.method !== route.method) { sendError(response, 405, 'Method not allowed.', { Allow: route.method }); return; }
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== `http://${request.headers.host?.toLowerCase()}`) { sendError(response, 403, 'Requests from other origins are not allowed.'); return; }
    // EventSource cannot send headers, so the event stream takes the token from the query.
    const given = url.pathname === '/api/events' ? url.searchParams.get('token') : request.headers[TOKEN_HEADER];
    if (!tokenMatches(token, given)) { sendError(response, 401, 'Missing or invalid Bridge token.'); return; }
    await route.handle(request, response);
  }

  const server = createServer((request, response) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
    // DNS rebinding defense: only names that resolve to this machine by definition.
    if (!allowedHosts.has(request.headers.host?.toLowerCase() ?? '')) { send(response, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' }); return; }
    let url: URL;
    try { url = new URL(request.url ?? '/', `http://${BRIDGE_HOST}:${port}`); }
    catch { send(response, 400, 'Bad request', { 'Content-Type': 'text/plain; charset=utf-8' }); return; }
    const api = url.pathname === '/api' || url.pathname.startsWith('/api/');
    const handled = api ? handleApi(request, response, url) : serveStatic(request, response, url.pathname);
    Promise.resolve(handled).catch(() => {
      if (response.headersSent) response.destroy();
      else if (api) sendError(response, 500, 'Unexpected error.');
      else send(response, 500, 'Internal error', { 'Content-Type': 'text/plain; charset=utf-8' });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => { server.off('error', reject); resolve(); });
  });
  port = (server.address() as AddressInfo).port;
  allowedHosts = new Set([`${BRIDGE_HOST}:${port}`, `localhost:${port}`]);

  return {
    url: `http://${BRIDGE_HOST}:${port}/`,
    port,
    token,
    close: () => new Promise<void>(resolve => {
      server.close(() => resolve());
      // Event streams never end by themselves.
      server.closeAllConnections();
    }),
  };
}
