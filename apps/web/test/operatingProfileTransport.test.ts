import { describe, expect, it } from 'vitest';
import type { OperatingProfileInput } from '@extalia/platform';
import { bridgeAgentHost, BRIDGE_TOKEN_HEADER } from '../src/host/bridgeHost';

const input: OperatingProfileInput = {
  name: 'Product team', purpose: 'Build reliable tools', personality: 'Explain decisions clearly',
  defaults: { connectionId: 'c_example', model: 'fixture-model', lead: { role: 'Coordinator', soul: 'Check the evidence' } },
};

describe('operating profile transport', () => {
  it('carries profile, workspace and individual lead settings through authenticated Web RPC', async () => {
    const requests: { method: string; args: unknown[]; headers: Record<string, string> }[] = [];
    const api = bridgeAgentHost('fixture-token', { EventSource: undefined, fetch: async (_url, init) => {
      const call = JSON.parse(String(init?.body)) as { method: string; args: unknown[] };
      requests.push({ ...call, headers: init?.headers as Record<string, string> });
      return Response.json({ result: call.method === 'listOperatingProfiles' ? [] : {} });
    } });
    await api.listOperatingProfiles!();
    await api.saveOperatingProfile!(input);
    await api.setWorkspaceOperatingProfile!('w_example', { profileId: 'op_example', overrides: { model: 'custom-model', team: null } });
    await api.getSessionOperatingProfile!('s_example');
    await api.saveSessionOperatingProfile!('s_example', { lead: { soul: '' } });
    await api.deleteOperatingProfile!('op_example', 3);
    expect(requests.map(call => call.method)).toEqual([
      'listOperatingProfiles', 'saveOperatingProfile', 'setWorkspaceOperatingProfile',
      'getSessionOperatingProfile', 'saveSessionOperatingProfile', 'deleteOperatingProfile',
    ]);
    expect(requests.every(call => call.headers[BRIDGE_TOKEN_HEADER] === 'fixture-token')).toBe(true);
    expect(requests[1]!.args).toEqual([input]);
    expect(requests[2]!.args).toEqual(['w_example', { profileId: 'op_example', overrides: { model: 'custom-model', team: null } }]);
    expect(requests[4]!.args).toEqual(['s_example', { lead: { soul: '' } }]);
    expect(requests[5]!.args).toEqual(['op_example', 3]);
  });

  it('does not replay a profile write after an expired Bridge credential', async () => {
    let calls = 0;
    const api = bridgeAgentHost('expired-token', { EventSource: undefined, fetch: async () => {
      calls++;
      return Response.json({ error: 'Connection expired' }, { status: 401 });
    } });
    await expect(api.saveOperatingProfile!(input)).rejects.toThrow('Connection expired');
    expect(calls).toBe(1);
  });

});
