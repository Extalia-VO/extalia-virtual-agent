import type { AgentHostApi, HostState, SessionSummary } from '@extalia/platform';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createMockPlatform } from '../src/host/mockHost';
import { MESSAGES } from '../src/i18n';
import { MissionsPage } from '../src/missions/MissionsPage';
import { createRemoteHost } from '../src/host/remote';
import { createMissionSession, MissionSetupChanged, missionMethodUnavailable, missionSelection, missionSetupIssue } from '../src/missions/missionSetup';

async function fixture() {
  const agents = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
  const state = await agents.getState();
  const workspace = state.workspaces.find(item => !missionSetupIssue(state, item))!;
  const session = state.sessions.find(item => item.workspaceId === workspace.id && item.control === 'managed' && !item.runtime)!;
  return { agents, state, workspace, session };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('mission project and session setup', () => {
  it('explains each missing prerequisite without treating Hermes as a Native workspace', async () => {
    const { state, workspace } = await fixture();
    expect(missionSetupIssue(state, workspace)).toBeUndefined();
    expect(missionSetupIssue(state, undefined)).toBe('noWorkspace');
    expect(missionSetupIssue(state, { ...workspace, runtimeId: 'hermes' })).toBe('hermes');
    const { projectLocation: _folder, ...withoutFolder } = workspace;
    expect(missionSetupIssue(state, withoutFolder)).toBe('folder');
    expect(missionSetupIssue({ ...state, connections: [] }, workspace)).toBe('connection');
    const primary = state.connections.find(item => item.id === workspace.providerProfileId)!;
    expect(missionSetupIssue({ ...state, connections: [{ ...primary, credentialStatus: 'missing' }] }, workspace)).toBe('credential');
    expect(missionSetupIssue({ ...state, connections: [{ ...primary, model: '', orchestration: { ...primary.orchestration, tiers: {} } }] }, workspace)).toBe('model');
  });

  it('scopes sessions to the project, prefers an idle session, and preserves an explicit busy choice', async () => {
    const { state, workspace, session } = await fixture();
    const busy = { ...session, id: 'busy', running: true }, idle = { ...session, id: 'idle', running: false };
    const otherWorkspace = { ...workspace, id: 'other-project' };
    const other = { ...idle, id: 'foreign', workspaceId: otherWorkspace.id };
    const current = { ...state, workspaces: [workspace, otherWorkspace], sessions: [busy, other, idle] };
    expect(missionSelection(current, { workspaceId: workspace.id }).session).toBe(idle);
    expect(missionSelection(current, { workspaceId: workspace.id, sessionId: busy.id }).session).toBe(busy);
    expect(missionSelection(current, { workspaceId: workspace.id }).sessions).toEqual([busy, idle]);
    expect(missionSelection(current, { workspaceId: otherWorkspace.id }).sessions).toEqual([other]);
  });

  it('never substitutes another session for an unavailable or foreign exact mission target', async () => {
    const { state, workspace, session } = await fixture();
    expect(missionSelection(state, { sessionId: 'missing', exact: true }).session).toBeUndefined();
    expect(missionSelection(state, { workspaceId: 'missing', sessionId: 'missing', exact: true }).session).toBeUndefined();
    expect(missionSelection(state, { workspaceId: workspace.id, sessionId: session.id, exact: true }).session?.id).toBe(session.id);
  });

  it('creates an empty session on explicit action and commits the actual returned host state', async () => {
    const { agents, state, workspace } = await fixture();
    const before = state.sessions.length, onState = vi.fn(), onCreated = vi.fn();
    const create = vi.spyOn(agents, 'createSession'), plan = vi.spyOn(agents, 'planNativeMission'), launch = vi.spyOn(agents, 'startNativeMission');
    await createMissionSession({ agents, workspaceId: workspace.id, current: () => true, onState, onCreated });
    expect(create).toHaveBeenCalledExactlyOnceWith(workspace.id);
    expect(onState.mock.calls[0]![0].sessions).toHaveLength(before + 1);
    expect(onCreated.mock.calls[0]![0]).toMatchObject({ workspaceId: workspace.id, control: 'managed', running: false });
    expect(plan).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
  });

  it('revalidates project configuration before creating and refuses a changed runtime after creation', async () => {
    const { state, workspace, session } = await fixture();
    const create = vi.fn(async () => session), onState = vi.fn(), onCreated = vi.fn();
    const getState = vi.fn<() => Promise<HostState>>(async () => ({ ...state, workspaces: [{ ...workspace, runtimeId: 'hermes' }] }));
    await expect(createMissionSession({ agents: { getState, createSession: create }, workspaceId: workspace.id, current: () => true, onState, onCreated })).rejects.toBeInstanceOf(MissionSetupChanged);
    expect(create).not.toHaveBeenCalled();
    getState.mockResolvedValueOnce(state);
    await expect(createMissionSession({ agents: { getState, createSession: create }, workspaceId: workspace.id, current: () => true, onState, onCreated })).rejects.toBeInstanceOf(MissionSetupChanged);
    expect(create).toHaveBeenCalledOnce(); expect(onCreated).not.toHaveBeenCalled(); expect(onState).toHaveBeenCalledOnce();
  });

  it.each(['before', 'create', 'state'] as const)('ignores a stale %s response without selecting another project', async stage => {
    const { state, workspace, session } = await fixture();
    const before = deferred<HostState>(), created = deferred<SessionSummary>(), after = deferred<HostState>();
    const getState = vi.fn().mockReturnValueOnce(stage === 'before' ? before.promise : Promise.resolve(state)).mockReturnValueOnce(after.promise);
    const createSession = vi.fn().mockReturnValue(stage === 'create' ? created.promise : Promise.resolve(session));
    let active = true;
    const onState = vi.fn(), onCreated = vi.fn();
    const request = createMissionSession({ agents: { getState, createSession }, workspaceId: workspace.id, current: () => active, onState, onCreated });
    if (stage === 'before') { active = false; before.resolve(state); }
    else {
      await vi.waitFor(() => expect(createSession).toHaveBeenCalledOnce());
      if (stage === 'create') { active = false; created.resolve(session); }
      else { await vi.waitFor(() => expect(getState).toHaveBeenCalledTimes(2)); active = false; after.resolve(state); }
    }
    await request;
    expect(onState).not.toHaveBeenCalled(); expect(onCreated).not.toHaveBeenCalled();
    if (stage === 'before') expect(createSession).not.toHaveBeenCalled();
  });
});

describe('Missions entry presentation', () => {
  it('recognizes an older remote peer despite manufactured proxy methods, without mistaking network failure for unsupported', async () => {
    const remote = createRemoteHost(async () => { throw new Error('This host does not support this action.'); }, () => () => undefined);
    expect(typeof remote.listNativeMissions).toBe('function');
    await expect(remote.listNativeMissions('session')).rejects.toSatisfy((error: Error) => missionMethodUnavailable(error.message));
    for (const message of ['Unknown method.', 'Unknown host method.', 'Extalia Bridge answered 501.']) expect(missionMethodUnavailable(message)).toBe(true);
    for (const message of [undefined, 'Network request failed.', 'Unknown mission.', 'Extalia Bridge answered 503.']) expect(missionMethodUnavailable(message)).toBe(false);
  });
  it.each(['en', 'id'] as const)('offers project-first setup without automatic inference (%s)', async language => {
    const { agents, state, workspace } = await fixture();
    const create = vi.spyOn(agents, 'createSession'), plan = vi.spyOn(agents, 'planNativeMission');
    const t = MESSAGES[language];
    const html = renderToStaticMarkup(createElement(MissionsPage, { t, language, agents, state: { ...state, sessions: [] }, workspaceId: workspace.id, onState: vi.fn(), onSelectSession: vi.fn(), onOpenChat: vi.fn(), onOpenSettings: vi.fn() }));
    for (const label of [t.missions.project, t.missions.createSession, t.missions.newSessionHint, t.missions.scope, ...Object.values(t.missions.steps)]) expect(html).toContain(label);
    expect(html).toContain('role="combobox"');
    expect(create).not.toHaveBeenCalled(); expect(plan).not.toHaveBeenCalled();
  });

  it('explains older host capability and unavailable exact-session links explicitly', async () => {
    const { agents, state, workspace } = await fixture(), t = MESSAGES.en;
    const props = { t, language: 'en' as const, state, onState: vi.fn(), onSelectSession: vi.fn(), onOpenChat: vi.fn() };
    const unsupported = renderToStaticMarkup(createElement(MissionsPage, { ...props, agents: {} as AgentHostApi }));
    expect(unsupported).toContain(t.missions.hostUnavailable); expect(unsupported).not.toContain(t.missions.createSession);
    const missing = renderToStaticMarkup(createElement(MissionsPage, { ...props, agents, workspaceId: workspace.id, sessionId: 'missing', missionId: 'missing-mission' }));
    expect(missing).toContain(t.missions.missingSession);
  });
});
