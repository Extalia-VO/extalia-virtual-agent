import { directLoopbackPost } from './observedInboxClient.js';

export const CONTINUITY_RESPONSE_LIMIT = 256 * 1024;
export interface ContinuityMcpInput { session_id?: string; access_code: string; snapshot_id?: string; offset?: number; limit?: number }
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const CODE = /^sk-extalia-context-[a-f0-9]{64}$/;

/** A bearer code is scoped to the reviewed destination; it never authorizes an arbitrary project or snapshot. */
export function validContinuityInput(value: unknown, operation: 'status' | 'read'): value is ContinuityMcpInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return !Object.keys(row).some(key => !['session_id', 'access_code', 'snapshot_id', 'offset', 'limit'].includes(key))
    && typeof row.access_code === 'string' && CODE.test(row.access_code)
    && (row.session_id === undefined || typeof row.session_id === 'string' && ID.test(row.session_id))
    && (operation === 'read' ? typeof row.snapshot_id === 'string' && ID.test(row.snapshot_id) : row.snapshot_id === undefined)
    && (row.offset === undefined || Number.isSafeInteger(row.offset) && (row.offset as number) >= 0)
    && (row.limit === undefined || Number.isSafeInteger(row.limit) && (row.limit as number) >= 1 && (row.limit as number) <= 2);
}

/** One authenticated loopback read. No proxy, redirect, implicit retry, report event or arbitrary URL. */
export async function readHookContinuity(input: {
  port: number; app: string; token: string; sessionId: string; operation: 'status' | 'read'; args: ContinuityMcpInput;
}, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<{ status: 'ok'; value: unknown } | { status: 'unavailable' }> {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535 || !/^[a-z0-9-]{1,32}$/.test(input.app)
    || !ID.test(input.sessionId) || !validContinuityInput(input.args, input.operation) || options.signal?.aborted) return { status: 'unavailable' };
  const url = `http://127.0.0.1:${input.port}/api/hooks/${input.app}`;
  const body = JSON.stringify({ operation: 'continuity', session_id: input.sessionId, access_code: input.args.access_code, request: input.operation,
    ...(input.args.snapshot_id ? { snapshot_id: input.args.snapshot_id } : {}),
    ...(input.args.offset !== undefined ? { offset: input.args.offset } : {}), ...(input.args.limit !== undefined ? { limit: input.args.limit } : {}) });
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const headers = { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' };
    let bytes: Uint8Array;
    if (options.fetch) {
      const response = await options.fetch(url, { method: 'POST', headers, body, signal, redirect: 'error' });
      if (response.status !== 200 || !/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '') || !response.body) return { status: 'unavailable' };
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > CONTINUITY_RESPONSE_LIMIT)) return { status: 'unavailable' };
      reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > CONTINUITY_RESPONSE_LIMIT) return { status: 'unavailable' };
        chunks.push(next.value);
      }
      bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    } else {
      const response = await directLoopbackPost(url, headers, body, signal, CONTINUITY_RESPONSE_LIMIT);
      if (response.status !== 200 || !/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) return { status: 'unavailable' };
      bytes = response.bodyBytes;
    }
    if (signal.aborted) return { status: 'unavailable' };
    const result = JSON.parse(new TextDecoder().decode(bytes)) as { status?: unknown; value?: unknown };
    return result?.status === 'ok' && result.value !== undefined ? { status: 'ok', value: result.value } : { status: 'unavailable' };
  } catch { return { status: 'unavailable' }; }
  finally { try { await reader?.cancel(); } catch { /* bounded read already settled */ } }
}
