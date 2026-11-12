import { describe, expect, it, vi } from 'vitest';
import { CONTINUITY_RESPONSE_LIMIT, readHookContinuity, validContinuityInput } from '../src/continuityClient.js';

const code = `sk-extalia-context-${'a'.repeat(64)}`;
const input = { port: 4321, app: 'codex', token: 'example-ingest-credential', sessionId: 'native-example', operation: 'status' as const, args: { access_code: code } };

describe('scoped MCP context client', () => {
  it('requires bounded read arguments and never sends arbitrary URLs or write operations', async () => {
    const fetch = vi.fn(async (_url: unknown, _options?: RequestInit) => Response.json({ status: 'ok', value: { canonicalId: 'continuity-example' } }));
    expect(validContinuityInput({ access_code: code, limit: 3 }, 'status')).toBe(false);
    expect(validContinuityInput({ access_code: code, snapshot_id: '../other' }, 'read')).toBe(false);
    expect(validContinuityInput({ access_code: code, url: 'https://example.com' }, 'status')).toBe(false);
    expect(validContinuityInput({ access_code: code }, 'read')).toBe(false);
    expect(await readHookContinuity({ ...input, port: 0 }, { fetch })).toEqual({ status: 'unavailable' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await readHookContinuity(input, { fetch })).toMatchObject({ status: 'ok', value: { canonicalId: 'continuity-example' } });
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:4321/api/hooks/codex');
    expect(options!.redirect).toBe('error');
    expect(JSON.parse(String(options!.body))).toMatchObject({ operation: 'continuity', request: 'status', session_id: 'native-example' });
  });
  it('bounds response bytes, cancels streams and never retries redirects or errors', async () => {
    const cancel = vi.fn();
    const fetch = vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(CONTINUITY_RESPONSE_LIMIT + 1)); }, cancel }),
      { headers: { 'content-type': 'application/json' } }));
    expect(await readHookContinuity(input, { fetch })).toEqual({ status: 'unavailable' });
    expect(fetch).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalled();
    const redirect = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://example.com' } }));
    expect(await readHookContinuity(input, { fetch: redirect })).toEqual({ status: 'unavailable' });
    expect(redirect).toHaveBeenCalledTimes(1);
    const stopped = new AbortController(); stopped.abort();
    expect(await readHookContinuity(input, { fetch: redirect, signal: stopped.signal })).toEqual({ status: 'unavailable' });
    expect(redirect).toHaveBeenCalledTimes(1);
  });
});
