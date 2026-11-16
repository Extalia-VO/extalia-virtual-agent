import { afterEach, describe, expect, it, vi } from 'vitest';
import { bridgeAgentHost, bridgeUpdater, BRIDGE_TOKEN_HEADER, createBridgeConnection } from '../src/host/bridgeHost';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
class EventStream {
  static all: EventStream[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) { EventStream.all.push(this); }
  close() { this.closed = true; }
  send(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
const EventSource = EventStream as unknown as typeof globalThis.EventSource;
const event = (id: string) => ({ id, sessionId: 'session', body: { type: 'session.updated' } });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); EventStream.all = []; });

describe('Bridge credentials after a manual restart', () => {
  it('recovers one read-only snapshot, replaces active SSE and shares the credential with updater calls', async () => {
    const bootstrap = vi.fn(async () => 'new-token');
    const connection = createBridgeConnection('old-token', { bootstrap });
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(json({ result: { profile: { id: 'same-profile' } } }))
      .mockResolvedValueOnce(json({ current: '0.1.0', state: 'idle', channel: 'stable' }));
    const host = bridgeAgentHost(connection, { fetch, EventSource });
    const updater = bridgeUpdater(connection, {}, { fetch });
    const received = vi.fn();
    const stop = host.subscribe(received);
    const old = EventStream.all[0]!;
    await expect(host.getState()).resolves.toEqual({ profile: { id: 'same-profile' } });
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(old.closed).toBe(true);
    expect(EventStream.all.map(stream => stream.url)).toEqual(['/api/events?token=old-token', '/api/events?token=new-token']);
    old.send(event('stale'));
    EventStream.all[1]!.send(event('current'));
    expect(received).toHaveBeenCalledExactlyOnceWith(event('current'));
    await updater.status();
    expect(fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get(BRIDGE_TOKEN_HEADER))).toEqual(['old-token', 'new-token', 'new-token']);
    stop();
    expect(EventStream.all[1]!.closed).toBe(true);
  });

  it('does not replay a mutation or an uncertain network failure', async () => {
    const bootstrap = vi.fn(async () => 'new-token');
    const connection = createBridgeConnection('old-token', { bootstrap });
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401));
    const host = bridgeAgentHost(connection, { fetch });
    await expect(host.cancelNativeMission!('session', 'mission')).rejects.toThrow('Unauthorized');
    await expect(host.getState()).rejects.toThrow('Failed to fetch');
    await expect(bridgeUpdater(connection, {}, { fetch }).check()).rejects.toThrow('Unauthorized');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it('coalesces concurrent token recovery and ignores a late refusal of the old token', async () => {
    const boot = deferred<string | null>(), late = deferred<Response>();
    const bootstrap = vi.fn(() => boot.promise);
    const connection = createBridgeConnection('old-token', { bootstrap });
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401))
      .mockReturnValueOnce(late.promise)
      .mockImplementation(async () => json({ result: { fresh: true } }));
    const host = bridgeAgentHost(connection, { fetch });
    const first = host.getState(), second = host.getState(), third = host.getState();
    await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledOnce());
    boot.resolve('new-token');
    await Promise.all([first, second]);
    late.resolve(json({ error: 'Unauthorized' }, 401));
    await expect(third).resolves.toEqual({ fresh: true });
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(connection.token).toBe('new-token');
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it('does not reopen a stream after its subscribers leave during bootstrap', async () => {
    const boot = deferred<string | null>();
    const connection = createBridgeConnection('old-token', { bootstrap: () => boot.promise });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(json({ result: { fresh: true } }));
    const host = bridgeAgentHost(connection, { fetch, EventSource });
    const stop = host.subscribe(vi.fn());
    const request = host.getState();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    stop(); boot.resolve('new-token'); await request;
    expect(EventStream.all).toHaveLength(1);
    expect(EventStream.all[0]!.closed).toBe(true);
  });

  it('keeps recovery failed if bootstrap fails or the new host still refuses the snapshot', async () => {
    const bootstrap = vi.fn<() => Promise<string | null>>().mockResolvedValueOnce(null).mockResolvedValueOnce('new-token');
    const connection = createBridgeConnection('old-token', { bootstrap });
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => json({ error: 'Unauthorized' }, 401));
    const host = bridgeAgentHost(connection, { fetch });
    await expect(host.getState()).rejects.toThrow('Unauthorized');
    expect(connection.token).toBe('old-token');
    await expect(host.getState()).rejects.toThrow('Unauthorized');
    expect(connection.token).toBe('new-token');
    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(3); // no recursive refresh/retry on the second refusal
  });

  it('bounds a stuck bootstrap and ignores its late token after a later recovery', async () => {
    vi.useFakeTimers();
    const stuck = deferred<string | null>();
    const bootstrap = vi.fn<(signal: AbortSignal) => Promise<string | null>>().mockReturnValueOnce(stuck.promise).mockResolvedValueOnce('current-token');
    const connection = createBridgeConnection('old-token', { bootstrap, bootstrapTimeoutMs: 25 });
    const first = expect(connection.recover('old-token')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(25); await first;
    expect(bootstrap.mock.calls[0]![0].aborted).toBe(true);
    await expect(connection.recover('old-token')).resolves.toBe(true);
    stuck.resolve('late-token'); await vi.advanceTimersByTimeAsync(0);
    expect(connection.token).toBe('current-token');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not finish reconnecting merely because credentials and streaming have recovered', async () => {
    const snapshot = deferred<Response>();
    const connection = createBridgeConnection('old-token', { bootstrap: async () => 'new-token' });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401)).mockReturnValueOnce(snapshot.promise);
    const host = bridgeAgentHost(connection, { fetch, EventSource });
    const stop = host.subscribe(vi.fn());
    let complete = false;
    const result = host.getState().then(value => { complete = true; return value; });
    await vi.waitFor(() => expect(EventStream.all).toHaveLength(2));
    EventStream.all[1]!.send(event('stream-reconnected'));
    expect(complete).toBe(false);
    snapshot.resolve(json({ result: { profile: { id: 'current-profile' } } }));
    await expect(result).resolves.toEqual({ profile: { id: 'current-profile' } }); stop();
  });

  it('rejects old successful mutation and updater results after credentials change without replaying them', async () => {
    const mutation = deferred<Response>(), status = deferred<Response>();
    const connection = createBridgeConnection('old-token', { bootstrap: async () => 'new-token' });
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValueOnce(mutation.promise).mockReturnValueOnce(status.promise)
      .mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(json({ result: { profile: { id: 'new-profile' } } }));
    const host = bridgeAgentHost(connection, { fetch });
    const oldMutation = expect(host.saveProfile({ displayName: 'Updated profile' } as never)).rejects.toThrow('connection changed');
    const oldStatus = expect(bridgeUpdater(connection, {}, { fetch }).status()).rejects.toThrow('connection changed');
    await host.getState();
    mutation.resolve(json({ result: { profile: { id: 'old-profile' } } }));
    status.resolve(json({ current: '0.1.0', state: 'idle', channel: 'stable' }));
    await Promise.all([oldMutation, oldStatus]);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

describe('trusted browser bootstrap', () => {
  const origin = 'http://127.0.0.1:5207';
  function browser() {
    const parse = vi.fn(() => ({ querySelector: () => ({ content: 'new-token' }) }));
    vi.stubGlobal('location', new URL(`${origin}/`));
    vi.stubGlobal('DOMParser', class { parseFromString = parse; });
    return parse;
  }
  function html(url = `${origin}/`, contentType = 'text/html; charset=utf-8', redirected = false) {
    const response = new Response('<meta name="extalia-bridge" content="new-token"><script>neverRun()</script>', { headers: { 'Content-Type': contentType } });
    Object.defineProperties(response, { url: { value: url }, redirected: { value: redirected } });
    return response;
  }
  it('fetches only a fresh same-origin HTML document without credentials in the URL or executable parsing', async () => {
    const parse = browser();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(html());
    const connection = createBridgeConnection('old-token', { fetch });
    await expect(connection.recover('old-token')).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/', { method: 'GET', headers: { Accept: 'text/html' }, cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: expect.any(AbortSignal) });
    expect(parse).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('<script>neverRun()</script>'), 'text/html');
    expect(connection.token).toBe('new-token');
  });
  it.each([
    ['http://example.com/', 'text/html', false], [`${origin}/`, 'application/json', false], [`${origin}/`, 'text/html', true],
  ])('rejects untrusted bootstrap response %s %s %s', async (url, contentType, redirected) => {
    const parse = browser();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(html(url as string, contentType as string, redirected as boolean));
    const connection = createBridgeConnection('old-token', { fetch });
    await expect(connection.recover('old-token')).resolves.toBe(false);
    expect(parse).not.toHaveBeenCalled(); expect(connection.token).toBe('old-token');
  });
});
