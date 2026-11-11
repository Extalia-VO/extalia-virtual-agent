import http from 'node:http';

export interface ObservedInboxRequest { url: string; token: string; ack?: string; waitMs?: number }
export type ObservedInboxResult =
  | { status: 'message'; message: { messageId: string; text: string }; acknowledged?: string }
  | { status: 'empty'; acknowledged?: string }
  | { status: 'unavailable' | 'expired' | 'busy' | 'unknown' };
export interface ObservedInboxClientOptions { signal?: AbortSignal; fetch?: typeof fetch }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH = /^\/inbox\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/i;
const directAgent = new http.Agent({ keepAlive: false });

function directLoopbackPost(
  urlStr: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal,
): Promise<{ status: number; ok: boolean; headers: { get(name: string): string | null }; bodyBytes: Uint8Array }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      return reject(new Error('Aborted'));
    }
    const parsed = new URL(urlStr);
    const bodyBuffer = Buffer.from(body, 'utf-8');
    const req = http.request({
      protocol: 'http:',
      hostname: '127.0.0.1',
      port: Number(parsed.port),
      path: parsed.pathname,
      method: 'POST',
      headers: {
        ...headers,
        'content-length': bodyBuffer.byteLength,
        connection: 'close',
      },
      agent: directAgent,
      signal,
    });

    req.on('error', reject);

    req.on('response', (res) => {
      const status = res.statusCode ?? 500;
      const responseHeaders = {
        get(name: string) {
          const val = res.headers[name.toLowerCase()];
          if (Array.isArray(val)) return val[0] ?? null;
          return val ?? null;
        },
      };

      const length = responseHeaders.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > 100_000)) {
        req.destroy();
        return resolve({
          status,
          ok: status >= 200 && status < 300,
          headers: responseHeaders,
          bodyBytes: new Uint8Array(0),
        });
      }

      const chunks: Buffer[] = [];
      let size = 0;

      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 100_000) {
          req.destroy();
          return resolve({
            status,
            ok: status >= 200 && status < 300,
            headers: responseHeaders,
            bodyBytes: new Uint8Array(0),
          });
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        resolve({
          status,
          ok: status >= 200 && status < 300,
          headers: responseHeaders,
          bodyBytes: new Uint8Array(Buffer.concat(chunks)),
        });
      });

      res.on('error', reject);
    });

    req.write(bodyBuffer);
    req.end();
  });
}
/** Validate the exact paired route before attaching a secret; no DNS or redirects. */
export function isObservedInboxRequest(value: unknown): value is ObservedInboxRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['url', 'token', 'ack', 'waitMs'].includes(key)) || typeof row.url !== 'string' || typeof row.token !== 'string' || !TOKEN.test(row.token)) return false;
  if (row.ack !== undefined && (typeof row.ack !== 'string' || !UUID.test(row.ack))) return false;
  if (row.waitMs !== undefined && (typeof row.waitMs !== 'number' || !Number.isInteger(row.waitMs) || row.waitMs < 0 || row.waitMs > 25_000)) return false;
  try {
    const url = new URL(row.url);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== '' && !url.username && !url.password && !url.search && !url.hash && PATH.test(url.pathname) && url.href === row.url;
  } catch { return false; }
}
/**
 * One bounded poll, never retried. Acknowledge only after receiving a result.
 * ack alone confirms that result without taking the next message; ack + waitMs
 * explicitly requests another poll. HTTP delivery does not prove consumption.
 */
export async function pollObservedInbox(request: ObservedInboxRequest, options: ObservedInboxClientOptions = {}): Promise<ObservedInboxResult> {
  if (!isObservedInboxRequest(request) || options.signal?.aborted) return { status: 'unavailable' };
  const bodyStr = JSON.stringify({ operation: 'poll', ...(request.ack ? { ack: request.ack } : {}), ...(request.waitMs !== undefined ? { waitMs: request.waitMs } : {}) });
  return executeInboxPoll(request.url, request.token, bodyStr, request.ack, request.waitMs, options);
}

export interface HookObservedInboxRequest { port: number; app: string; token: string; sessionId: string; ack?: string; waitMs?: number }
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const APP_ID = /^[a-z0-9-]{1,32}$/;

export async function pollHookObservedInbox(request: HookObservedInboxRequest, options: ObservedInboxClientOptions = {}): Promise<ObservedInboxResult> {
  if (
    !request ||
    !Number.isInteger(request.port) || request.port < 1 || request.port > 65_535 ||
    !APP_ID.test(request.app) ||
    typeof request.token !== 'string' || !request.token.trim() ||
    typeof request.sessionId !== 'string' || !SESSION_ID.test(request.sessionId) ||
    (request.ack !== undefined && (typeof request.ack !== 'string' || !UUID.test(request.ack))) ||
    (request.waitMs !== undefined && (typeof request.waitMs !== 'number' || !Number.isInteger(request.waitMs) || request.waitMs < 0 || request.waitMs > 25_000)) ||
    options.signal?.aborted
  ) {
    return { status: 'unavailable' };
  }
  const bodyStr = JSON.stringify({
    operation: 'poll',
    session_id: request.sessionId,
    ...(request.ack ? { ack: request.ack } : {}),
    ...(request.waitMs !== undefined ? { waitMs: request.waitMs } : {}),
  });
  return executeInboxPoll(`http://127.0.0.1:${request.port}/api/hooks/${request.app}`, request.token, bodyStr, request.ack, request.waitMs, options);
}

async function executeInboxPoll(
  url: string,
  token: string,
  bodyStr: string,
  ack: string | undefined,
  waitMs: number | undefined,
  options: ObservedInboxClientOptions,
): Promise<ObservedInboxResult> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(cancel, (waitMs ?? 0) + 5_000);
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    let status: number;
    let ok: boolean;
    let getHeader: (name: string) => string | null;
    let bytes: Uint8Array;

    if (options.fetch) {
      const response = await options.fetch(url, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: bodyStr,
        redirect: 'error', signal: controller.signal,
      });
      status = response.status;
      ok = response.ok;
      getHeader = (name: string) => response.headers.get(name);
      if ((!ok && ![408, 409, 410].includes(status)) || !response.body) return { status: 'unavailable' };
      if (!/^application\/json(?:\s*;|\s*$)/i.test(getHeader('content-type') ?? '')) return { status: 'unknown' };
      const length = getHeader('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > 100_000)) return { status: 'unknown' };
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 100_000) return { status: 'unknown' };
        chunks.push(next.value);
      }
      if (controller.signal.aborted) return { status: 'unknown' };
      bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    } else {
      const res = await directLoopbackPost(
        url,
        { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        bodyStr,
        controller.signal,
      );
      status = res.status;
      ok = res.ok;
      getHeader = (name: string) => res.headers.get(name);
      bytes = res.bodyBytes;
      if ((!ok && ![408, 409, 410].includes(status)) || !bytes.length) return { status: 'unavailable' };
      if (!/^application\/json(?:\s*;|\s*$)/i.test(getHeader('content-type') ?? '')) return { status: 'unknown' };
      const length = getHeader('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > 100_000 || Number(length) !== bytes.byteLength)) return { status: 'unknown' };
    }

    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'unknown' };
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some(key => !['status', 'message', 'acknowledged'].includes(key))) return { status: 'unknown' };
    if (row.acknowledged !== undefined && (typeof row.acknowledged !== 'string' || row.acknowledged !== ack)) return { status: 'unknown' };
    const acknowledged = typeof row.acknowledged === 'string' ? { acknowledged: row.acknowledged } : {};
    if (ok && row.status === 'empty' && row.message === undefined) return { status: 'empty', ...acknowledged };
    if (ok && row.status === 'message' && row.message && typeof row.message === 'object' && !Array.isArray(row.message)) {
      const m = row.message as Record<string, unknown>;
      if (Object.keys(m).every(key => ['messageId', 'text'].includes(key)) && typeof m.messageId === 'string' && UUID.test(m.messageId) && typeof m.text === 'string' && m.text.trim() && m.text.length <= 16_000 && new TextEncoder().encode(m.text).length <= 16 * 1024) return { status: 'message', message: { messageId: m.messageId, text: m.text }, ...acknowledged };
    }
    if (row.message !== undefined || row.acknowledged !== undefined) return { status: 'unknown' };
    if (row.status === 'expired' && status === 408) return { status: 'expired' };
    if (row.status === 'busy' && status === 409) return { status: 'busy' };
    if (row.status === 'unavailable' && [409, 410].includes(status)) return { status: 'unavailable' };
    return { status: 'unknown' };
  } catch { return { status: 'unknown' }; }
  finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    if (reader) { try { await reader.cancel(); } catch { /* Connection already closed. */ } reader.releaseLock(); }
    controller.abort();
  }
}
