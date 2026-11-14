import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentHostApi, HostState } from '@extalia/platform';
import { createMockPlatform } from '../src/host/mockHost';
import { MESSAGES } from '../src/i18n';
import { WorkspacesSection } from '../src/pages/settings/WorkspacesSection';
import { canFinish } from '../src/setup/steps';
import { draftFromWorkspace, emptyWorkspaceDraft, toWorkspaceInput, validateWorkspace } from '../src/setup/validation';
import { WorkspaceForm } from '../src/setup/WorkspaceForm';

const ready = { ...emptyWorkspaceDraft(), mode: 'observe' as const, name: 'Observed project',
  folderInput: '/projects/example', folder: { path: '/projects/example', name: 'example' } };

describe('Observe-only workspace setup and upgrade', () => {
  it('validates providerless Observe, preserves its identity and requires a connection for Native upgrade', () => {
    expect(validateWorkspace(ready)).toEqual({});
    const input = toWorkspaceInput({ ...ready, runtimeId: 'hermes', hermesProfile: 'invalid profile', gateCommand: 'invalid\0command' });
    expect(input).toMatchObject({ mode: 'observe', connectionId: '', projectLocation: '/projects/example' });
    expect(input).not.toHaveProperty('runtimeId');
    expect(input).not.toHaveProperty('integrationGate');
    expect(validateWorkspace({ ...ready, mode: 'managed' })).toEqual({ connection: 'connectionRequired' });
    const draft = draftFromWorkspace({ id: 'workspace-observe', mode: 'observe', profileId: 'profile', name: ready.name,
      projectLocation: ready.folder.path, createdAt: 'now', updatedAt: 'now' });
    expect(toWorkspaceInput(draft)).toMatchObject({ id: 'workspace-observe', mode: 'observe', connectionId: '' });
    expect(toWorkspaceInput({ ...draft, mode: 'managed', connectionId: 'model-one' })).toMatchObject({ id: 'workspace-observe', mode: 'managed', connectionId: 'model-one' });
  });

  it('shows folder grouping and optional curator, hides execution controls in both languages', () => {
    for (const t of [MESSAGES.en, MESSAGES.id]) {
      const html = renderToStaticMarkup(createElement(WorkspaceForm, { t, agents: {} as AgentHostApi,
        draft: ready, onChange: () => undefined, connections: [], showGate: true }));
      expect(html).toContain(t.workspace.folder);
      expect(html).toContain(t.workspace.observeLead);
      expect(html).toContain(t.workspace.noCurator);
      expect(html).not.toContain(t.workspace.permissionsLead);
      expect(html).not.toContain(t.workspace.gate.heading);
      expect(html).not.toContain(t.workspace.runtimeChangeHint);
      expect(html).not.toContain(t.workspace.hermesProfile);
    }
  });

  it('keeps native/team/skill controls out of the Observe workspace list', async () => {
    const agents = createMockPlatform({ seed: 'setup', host: 'bridge' }).capabilities.agents!;
    const saved = await agents.saveWorkspace(toWorkspaceInput(ready));
    const state: HostState = { ...saved, workflow: 'observe' };
    const t = MESSAGES.en;
    const html = renderToStaticMarkup(createElement(WorkspacesSection, { t, agents, state, onState: () => undefined, onReviewSkills: () => undefined }));
    expect(html).toContain(t.workspace.noCurator);
    expect(html).not.toContain(t.settings.missingConnection);
    expect(html).not.toContain(t.team.settingsSetUp);
    expect(html).not.toContain(t.team.settingsNoTeam);
  });

  it('simulates observe setup without credentials then upgrades the same project with its history retained', async () => {
    const agents = createMockPlatform({ seed: 'setup', host: 'bridge' }).capabilities.agents!;
    let state = await agents.saveWorkspace(toWorkspaceInput(ready));
    const workspace = state.workspaces[0]!;
    expect(state.connections).toHaveLength(0);
    expect(await agents.completeSetup('observe')).toMatchObject({ setupComplete: true, workflow: 'observe' });
    await expect(agents.completeSetup('managed')).rejects.toThrow(/model connection/);
    await expect(agents.createSession(workspace.id)).rejects.toThrow(/full Extalia/);
    expect(canFinish(state, workspace.id)).toBe(false);
    state = await agents.saveConnection({ name: 'Model connection', preset: 'custom', api: 'openai-chat', baseUrl: 'http://mock.test/v1', model: 'mock-model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } });
    const connectionId = state.connections[0]!.id;
    // A curator connection alone does not grant managed execution.
    state = await agents.saveWorkspace(toWorkspaceInput({ ...draftFromWorkspace(workspace), connectionId }));
    await expect(agents.createSession(workspace.id)).rejects.toThrow(/full Extalia/);
    const priorSessions = state.sessions.map(session => session.id);
    state = await agents.saveWorkspace(toWorkspaceInput({ ...draftFromWorkspace(state.workspaces[0]!), mode: 'managed' }));
    expect(state.workspaces).toHaveLength(1);
    expect(state.workspaces[0]).toMatchObject({ id: workspace.id, profileId: workspace.profileId, projectLocation: workspace.projectLocation, mode: 'managed' });
    expect(state.sessions.map(session => session.id)).toEqual(priorSessions);
    expect(canFinish(state, workspace.id)).toBe(true);
    expect(await agents.completeSetup('managed')).toMatchObject({ workflow: 'managed' });
    expect(await agents.createSession(workspace.id)).toMatchObject({ workspaceId: workspace.id, control: 'managed' });
  });

  it('preserves nonempty observed and managed histories when editing a workspace between modes', async () => {
    const agents = createMockPlatform({ seed: 'ready', host: 'bridge', observed: true }).capabilities.agents!;
    const initial = await agents.getState();
    const workspace = initial.workspaces[0]!;
    const sessions = initial.sessions.filter(session => session.workspaceId === workspace.id);
    expect(sessions.length).toBeGreaterThan(0);
    const histories = await Promise.all(sessions.map(session => agents.sessionEvents(session.id)));
    let state = await agents.saveWorkspace(toWorkspaceInput({ ...draftFromWorkspace(workspace), mode: 'observe', connectionId: '' }));
    expect(state.workspaces.find(item => item.id === workspace.id)?.mode).toBe('observe');
    state = await agents.saveWorkspace(toWorkspaceInput({ ...draftFromWorkspace(state.workspaces.find(item => item.id === workspace.id)!), mode: 'managed', connectionId: workspace.providerProfileId! }));
    expect(state.sessions.filter(session => session.workspaceId === workspace.id)).toEqual(sessions);
    expect(await Promise.all(sessions.map(session => agents.sessionEvents(session.id)))).toEqual(histories);
  });
});
