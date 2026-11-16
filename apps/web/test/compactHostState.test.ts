import { describe, expect, it, vi } from 'vitest';
import { bridgeAgentHost } from '../src/host/bridgeHost';
import { desktopAgentHost } from '../src/host/desktopHost';

describe('compact UI state transport', () => {
  it('polls metadata counts without downloading the imported library through Bridge', async () => {
    const state = { library: [], sessionBrowser: { libraryTotal: 500, observedTotal: 12 } };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ result: state })));
    await expect(bridgeAgentHost('fixture', { fetch }).getState()).resolves.toEqual(state);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ method: 'getStateSummary', args: [] });
  });

  it('remembers an explicitly unsupported summary method and falls back on older Desktop hosts', async () => {
    const call = vi.fn().mockRejectedValueOnce(new Error('This host does not support this action.')).mockResolvedValue({ library: [] });
    const host = desktopAgentHost({ call, onEvent: () => () => undefined });
    await host.getState(); await host.getState();
    expect(call.mock.calls.map(([method]) => method)).toEqual(['getStateSummary', 'getState', 'getState']);
  });

  it('does not hide authentication or uncertain network errors by fetching full state', async () => {
    const call = vi.fn().mockRejectedValue(new Error('Unauthorized'));
    const host = desktopAgentHost({ call, onEvent: () => () => undefined });
    await expect(host.getState()).rejects.toThrow('Unauthorized');
    expect(call).toHaveBeenCalledExactlyOnceWith('getStateSummary', []);
  });
});
