import type { UpdateStatus } from '@extalia/platform';
import { describe, expect, it, vi } from 'vitest';
import { BRIDGE_TOKEN_HEADER, bridgeAgentHost, bridgeUpdater, readBridgeToken } from '../src/host/bridgeHost';
import { createRemoteHost, errorMessage } from '../src/host/remote';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('remote hosts', () => {
  it('forwards every method without trailing undefined arguments', async () => {
    const call = vi.fn(async () => 'ok');
    const host = createRemoteHost(call, () => () => undefined);
    await host.saveConnection({ name: 'n' } as never, undefined);
    expect(call).toHaveBeenCalledWith('saveConnection', [{ name: 'n' }]);
  });

  it('shows the host message instead of transport prefixes', () => {
    expect(errorMessage(new Error("Error invoking remote method 'agents:call': Error: Folder not found."))).toBe('Folder not found.');
    expect(errorMessage('plain')).toBe('plain');
  });
});

describe('Bridge transport', () => {
  it('reads the token from the page', () => {
    const doc = { querySelector: () => ({ content: ' abc ' }) } as unknown as Document;
    expect(readBridgeToken(doc)).toBe('abc');
    expect(readBridgeToken({ querySelector: () => null } as unknown as Document)).toBeNull();
  });

  it('calls /api/call with the token and surfaces host errors', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ result: { ok: true, path: '/projects/app' } }))
      .mockResolvedValueOnce(json({ error: 'No folder exists at this path.' }, 400));
    const host = bridgeAgentHost('t1', { fetch });
    await expect(host.checkFolder('/projects/app')).resolves.toEqual({ ok: true, path: '/projects/app' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/call');
    expect(init).toMatchObject({ method: 'POST', headers: { [BRIDGE_TOKEN_HEADER]: 't1', 'Content-Type': 'application/json' } });
    expect(JSON.parse(String(init?.body))).toEqual({ method: 'checkFolder', args: ['/projects/app'] });
    await expect(host.checkFolder('/nope')).rejects.toThrow('No folder exists at this path.');
  });

  it('reloads once the Bridge answers again after an install', async () => {
    const status = (state: UpdateStatus['state'], current = '0.1.0'): UpdateStatus => ({ current, latest: '0.2.0', channel: 'stable', state });
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(status('available')))
      .mockResolvedValueOnce(json(status('installing')))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json(status('up-to-date', '0.2.0')));
    const reload = vi.fn();
    const updater = bridgeUpdater('t1', { restartPollMs: 1, reload }, { fetch });
    const seen: string[] = [];
    const stop = updater.onStatus(next => seen.push(next.state));
    await updater.install();
    stop();
    expect(reload).toHaveBeenCalledOnce();
    expect(seen).toContain('installing');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/update', '/api/update/install', '/api/update', '/api/update']);
  });
});
