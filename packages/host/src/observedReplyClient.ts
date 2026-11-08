/** Cooperative replies return through the agent's original waiting tool call. */
export interface ObservedReplyRequest {
  url: string;
  token: string;
  question?: string;
}

export type ObservedReplyResult = { status: 'answered'; text: string } | { status: 'expired' | 'unavailable' };

export interface ObservedReplyClientOptions {
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

const MAX_RESPONSE_BYTES = 64 * 1024;
const REPLY_PATH = /^\/reply\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/i;

/** Validate before attaching the secret. No DNS, redirects, or arbitrary routes. */
export function isObservedReplyRequest(value: unknown): value is ObservedReplyRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (typeof row.url !== 'string' || typeof row.token !== 'string' || !TOKEN.test(row.token)) return false;
  if (row.question !== undefined && (typeof row.question !== 'string' || row.question.length > 2000)) return false;
  try {
    const url = new URL(row.url);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== '' &&
      !url.username && !url.password && !url.search && !url.hash && REPLY_PATH.test(url.pathname) &&
      row.url === url.href;
  } catch {
    return false;
  }
}

/** One bounded request; a disconnect never retries a potentially delivered reply. */
export async function awaitObservedReply(
  request: ObservedReplyRequest,
  options: ObservedReplyClientOptions = {},
): Promise<ObservedReplyResult> {
  if (!isObservedReplyRequest(request) || options.signal?.aborted) return { status: 'unavailable' };
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(cancel, 50_000);
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await (options.fetch ?? globalThis.fetch)(request.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${request.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(request.question === undefined ? {} : { question: request.question }),
      redirect: 'error',
      signal: controller.signal,
    });
    if ((!response.ok && response.status !== 408 && response.status !== 410) || !response.body) return { status: 'unavailable' };
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) return { status: 'unavailable' };
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) return { status: 'unavailable' };
      chunks.push(next.value);
    }
    if (controller.signal.aborted) return { status: 'unavailable' };
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (typeof result !== 'object' || result === null || Array.isArray(result)) return { status: 'unavailable' };
    const row = result as Record<string, unknown>;
    if (response.ok && row.status === 'answered' && typeof row.text === 'string' && row.text.length <= 16000) return { status: 'answered', text: row.text };
    if (row.status === 'expired' && (response.ok || response.status === 408)) return { status: 'expired' };
    if (row.status === 'unavailable' && (response.ok || response.status === 410)) return { status: 'unavailable' };
    return { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    if (reader) {
      try { await reader.cancel(); } catch { /* The connection may already be closed. */ }
      reader.releaseLock();
    }
    controller.abort();
  }
}
