import { expect, it } from 'vitest';
import { createMockPlatform } from '../src/host/mockHost';

it('inspects a saved team connection without granting it and follows the saved session runtime', async () => {
  const api = createMockPlatform({ seed: 'setup', host: 'bridge', hermes: true }).capabilities.agents!;
  const state = await api.saveConnection({ name: 'Example provider', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1',
    model: 'example-model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } });
  const connectionId = state.connections[0]!.id;
  const configured = await api.saveWorkspace({ name: 'Example project', projectLocation: '/projects/example', connectionId,
    permissions: { fileWrite: 'ask', commands: 'ask' } });
  const workspaceId = configured.workspaces[0]!.id;
  const session = await api.createSession(workspaceId);
  const before = await api.getSessionTeam(session.id);
  const catalog = await api.teamModelChoices(workspaceId, connectionId, session.id);
  expect(catalog).toMatchObject({ runtime: 'extalia-native', defaultModel: 'example-model' });
  expect(await api.getSessionTeam(session.id)).toEqual(before);
  await api.saveWorkspace({ id: workspaceId, name: 'Example project', projectLocation: '/projects/example', runtimeId: 'hermes',
    permissions: { fileWrite: 'ask', commands: 'ask' } });
  expect((await api.teamModelChoices(workspaceId, connectionId, session.id)).runtime).toBe('extalia-native');
  await expect(api.teamModelChoices(workspaceId, connectionId)).rejects.toThrow(/Native/);
  await expect(api.teamModelChoices(workspaceId, 'missing', session.id)).rejects.toThrow(/no longer exists/);
});
