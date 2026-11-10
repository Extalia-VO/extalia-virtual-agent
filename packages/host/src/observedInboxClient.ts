export interface ObservedInboxRequest { url: string; token: string; ack?: string; waitMs?: number }
export type ObservedInboxResult =
  | { status: 'message'; message: { messageId: string; text: string }; acknowledged?: string }
  | { status: 'empty'; acknowledged?: string }
  | { status: 'unavailable' | 'expired' | 'busy' | 'unknown' };
export interface ObservedInboxClientOptions { signal?: AbortSignal; fetch?: typeof fetch }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH = /^\/inbox\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/i;
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
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(cancel, (request.waitMs ?? 0) + 5_000);
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await (options.fetch ?? globalThis.fetch)(request.url, {
      method: 'POST', headers: { authorization: `Bearer ${request.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'poll', ...(request.ack ? { ack: request.ack } : {}), ...(request.waitMs !== undefined ? { waitMs: request.waitMs } : {}) }),
      redirect: 'error', signal: controller.signal,
    });
    if ((!response.ok && ![408, 409, 410].includes(response.status)) || !response.body) return { status: 'unavailable' };
    if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) return { status: 'unknown' };
    const length = response.headers.get('content-length');
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
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'unknown' };
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some(key => !['status', 'message', 'acknowledged'].includes(key))) return { status: 'unknown' };
    if (row.acknowledged !== undefined && (typeof row.acknowledged !== 'string' || row.acknowledged !== request.ack)) return { status: 'unknown' };
    const acknowledged = typeof row.acknowledged === 'string' ? { acknowledged: row.acknowledged } : {};
    if (response.ok && row.status === 'empty' && row.message === undefined) return { status: 'empty', ...acknowledged };
    if (response.ok && row.status === 'message' && row.message && typeof row.message === 'object' && !Array.isArray(row.message)) {
      const m = row.message as Record<string, unknown>;
      if (Object.keys(m).every(key => ['messageId', 'text'].includes(key)) && typeof m.messageId === 'string' && UUID.test(m.messageId) && typeof m.text === 'string' && m.text.trim() && m.text.length <= 16_000 && new TextEncoder().encode(m.text).length <= 16 * 1024) return { status: 'message', message: { messageId: m.messageId, text: m.text }, ...acknowledged };
    }
    if (row.message !== undefined || row.acknowledged !== undefined) return { status: 'unknown' };
    if (row.status === 'expired' && response.status === 408) return { status: 'expired' };
    if (row.status === 'busy' && response.status === 409) return { status: 'busy' };
    if (row.status === 'unavailable' && [409, 410].includes(response.status)) return { status: 'unavailable' };
    return { status: 'unknown' };
  } catch { return { status: 'unknown' }; }
  finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    if (reader) { try { await reader.cancel(); } catch { /* Connection already closed. */ } reader.releaseLock(); }
    controller.abort();
  }
}
