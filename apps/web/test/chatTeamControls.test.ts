import type { Workspace } from '@extalia/core';
import type { AgentHostApi, AgentTeam, HostState, ModelChoices, SessionSummary } from '@extalia/platform';
import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatTeamControls } from '../src/chat/ChatTeamControls';
import { chatTeamEnableBlock, toggleChatTeam, useChatTeam } from '../src/chat/chatTeam';
import { createComposerSession } from '../src/chat/sessionHandoff';
import { MESSAGES } from '../src/i18n';
import { TeamSetupDialog } from '../src/office/TeamSetupDialog';

// Run the actual hook/handlers; effect cleanup and scope changes remain observable.
const hooks = vi.hoisted(() => ({ index: 0, dirty: false, state: [] as unknown[], memo: new Map<number, { deps: unknown[]; value: unknown }>(), effects: new Map<number, { deps: unknown[]; cleanup?: () => void }>(), pending: [] as (() => void)[] }));
vi.mock('react', async original => {
  const same = (a: unknown[] | undefined, b: unknown[]) => a?.length === b.length && a.every((item, i) => Object.is(item, b[i]));
  const effect = (run: () => (() => void) | void, deps: unknown[]) => {
    const id = hooks.index++, prior = hooks.effects.get(id);
    if (!same(prior?.deps, deps)) {
      const entry = { deps } as { deps: unknown[]; cleanup?: () => void };
      hooks.effects.set(id, entry);
      hooks.pending.push(() => { prior?.cleanup?.(); entry.cleanup = run() || undefined; });
    }
  };
  return { ...await original<typeof React>(),
    useState: (initial: unknown) => {
      const id = hooks.index++;
      if (!(id in hooks.state)) hooks.state[id] = typeof initial === 'function' ? initial() : initial;
      return [hooks.state[id], (next: unknown) => {
        const value = typeof next === 'function' ? next(hooks.state[id]) : next;
        if (!Object.is(value, hooks.state[id])) { hooks.state[id] = value; hooks.dirty = true; }
      }];
    },
    useMemo: (compute: () => unknown, deps: unknown[]) => {
      const id = hooks.index++, prior = hooks.memo.get(id);
      if (!prior || !same(prior.deps, deps)) hooks.memo.set(id, { deps, value: compute() });
      return hooks.memo.get(id)!.value;
    },
    useRef: (initial: unknown) => { const id = hooks.index++; return hooks.state[id] ??= { current: initial }; },
    useEffect: effect, useLayoutEffect: effect,
    useId: () => 'chat-team-test',
  };
});

const at = '2026-11-08T00:00:00.000Z';
const team: AgentTeam = { enabled: true, allowedModels: ['lead-model'], goal: 'Review the project', rules: ['Report evidence'], connections: [{ connectionId: 'other-connection', allowedModels: ['worker-model'] }], members: [{ id: 'worker', name: 'Example Worker', role: 'Reviewer', models: ['worker-model'], connectionId: 'other-connection', access: 'read', forbidden: ['private'] }], updatedAt: at };
const workspace: Workspace = { id: 'workspace', profileId: 'profile', name: 'Example', providerProfileId: 'connection', team, createdAt: at, updatedAt: at };
const session: SessionSummary = { id: 'session', workspaceId: workspace.id, connectionId: 'connection', control: 'managed', title: 'Example', running: false, createdAt: at, lastActiveAt: at };
const choices: ModelChoices = { runtime: 'hermes', models: [], efforts: [], hermesDelegation: { profile: 'default', maxTeamMembers: 3, maxConcurrentChildren: 3, oneshotMaxChildren: 3, workerModelSource: 'lead', source: 'defaults', modelRouting: 'shared' } };
const state = (): HostState => ({ profile: { id: 'profile', name: 'Example' }, workspaces: [workspace], sessions: [session], connections: [] }) as unknown as HostState;
const elements = (node: ReactNode): ReactElement<Record<string, unknown>>[] => Array.isArray(node) ? node.flatMap(elements) : isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children as ReactNode)] : [];
const text = (node: ReactNode): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : '';
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function harness(language: 'en' | 'id' = 'en') {
  const agents = {
    planTeam: vi.fn(), getSessionTeam: vi.fn(async (): Promise<AgentTeam | undefined> => team),
    saveSessionTeam: vi.fn(async (_id: string, team: AgentTeam | null) => team ?? undefined),
    saveWorkspaceTeam: vi.fn(async (_id: string, next: AgentTeam | null) => ({ ...state(), workspaces: [{ ...workspace, id: _id, team: next ?? undefined }] })),
    modelChoices: vi.fn(async () => choices), getState: vi.fn(async () => state()),
  } as unknown as AgentHostApi;
  const props: Parameters<typeof useChatTeam>[0] = { agents, state: state(), workspace, onState: vi.fn() };
  let control!: ReturnType<typeof useChatTeam>;
  const render = (running = false) => {
    let tree: ReactNode;
    do {
      hooks.dirty = false; hooks.index = 0;
      control = useChatTeam(props);
      tree = ChatTeamControls({ ...props, t: MESSAGES[language], workspace: props.workspace!, running, control });
      for (const run of hooks.pending.splice(0)) run();
    } while (hooks.dirty);
    return tree;
  };
  const switchNode = () => elements(render()).find(item => item.props.role === 'switch')!;
  return { props, render, switchNode, control: () => { render(); return control; } };
}

beforeEach(() => { for (const value of hooks.effects.values()) value.cleanup?.(); hooks.index = 0; hooks.dirty = false; hooks.state = []; hooks.memo.clear(); hooks.effects.clear(); hooks.pending = []; });

describe('persistent Chat team controls', () => {
  it.each(['en', 'id'] as const)('shows and toggles the workspace default without losing grants in %s', async language => {
    const h = harness(language), m = MESSAGES[language].chat.team;
    expect(text(h.render())).toContain(m.workspaceScope);
    expect(text(h.render())).toContain(m.active);
    expect(h.switchNode().props['aria-checked']).toBe(true);
    const save = h.control().toggle(false);
    expect(h.control().isUpdating()).toBe(true);
    await save;
    expect(h.props.agents.saveWorkspaceTeam).toHaveBeenCalledWith(workspace.id, { ...team, enabled: false });
    expect(h.props.agents.saveSessionTeam).not.toHaveBeenCalled();
    expect(text(h.render())).toContain(m.inactive);
    await h.control().toggle(true);
    expect(h.props.agents.saveWorkspaceTeam).toHaveBeenLastCalledWith(workspace.id, team);
  });

  it('blocks an empty roster, opens workspace setup and retains the saved reviewed team', () => {
    const h = harness(); h.props.workspace = { ...workspace, team: undefined };
    expect(h.switchNode().props.disabled).toBe(true);
    h.control().openSetup();
    const dialog = elements(h.render()).find(item => item.type === TeamSetupDialog)!;
    expect(dialog.props.scope).toBe('workspace');
    (dialog.props.onSaved as (team: AgentTeam) => void)(team);
    h.control().closeSetup();
    expect(h.control().team).toEqual(team);
    expect(h.props.agents.saveWorkspaceTeam).not.toHaveBeenCalled(); // The actual dialog owns its save.
    expect(toggleChatTeam({ ...team, members: [] }, true)).toBeUndefined();
  });

  it('loads a session copy, keeps changes scoped to it, and explains running-turn behavior', async () => {
    const h = harness(); h.props.session = session;
    expect(h.control().loading).toBe(true);
    await settle();
    expect(h.control().team).toEqual(team);
    expect(text(h.render(true))).toContain(MESSAGES.en.chat.team.nextTurn);
    await h.control().toggle(false);
    expect(h.props.agents.saveSessionTeam).toHaveBeenCalledWith(session.id, { ...team, enabled: false });
    expect(h.props.agents.saveWorkspaceTeam).not.toHaveBeenCalled();
    expect(h.props.agents).not.toHaveProperty('cancel');
    h.control().openSetup();
    expect(elements(h.render()).find(item => item.type === TeamSetupDialog)?.props.sessionId).toBe(session.id);
  });

  it('never retroactively substitutes a workspace default for an existing session without a team', async () => {
    const h = harness(); h.props.session = session;
    vi.mocked(h.props.agents.getSessionTeam).mockResolvedValue(undefined);
    h.render(); await settle();
    expect(h.control().team).toBeUndefined();
    expect(h.switchNode().props.disabled).toBe(true);
    expect(text(h.render())).toContain(MESSAGES.en.chat.team.sessionScope);
  });

  it('surfaces failed loads with retry and never falls back to workspace defaults', async () => {
    const h = harness(); h.props.session = session;
    vi.mocked(h.props.agents.getSessionTeam).mockRejectedValueOnce(new Error('Saved team unavailable'));
    h.render(); await settle();
    expect(h.control().error).toBe('Saved team unavailable');
    expect(h.control().team).toBeUndefined();
    expect(h.switchNode().props.disabled).toBe(true);
    h.control().retry(); h.render(); await settle();
    expect(h.control().team).toEqual(team);
    expect(h.control().error).toBeUndefined();
  });

  it.each(['success', 'failure'] as const)('ignores stale load %s after session navigation, including navigation back', async outcome => {
    const h = harness(); h.props.session = session;
    const old = deferred<AgentTeam | undefined>();
    vi.mocked(h.props.agents.getSessionTeam).mockReturnValueOnce(old.promise);
    h.render();
    h.props.session = { ...session, id: 'another-session' }; h.render(); await settle();
    h.props.session = session; h.render(); await settle();
    if (outcome === 'success') old.resolve({ ...team, members: [] });
    else old.reject(new Error('Stale failure'));
    await settle();
    expect(h.control().team).toEqual(team);
    expect(h.control().error).toBeUndefined();
  });

  it.each(['host', 'workspace'] as const)('drops stale full-team load failures after a %s switch', async target => {
    const h = harness(); h.props.session = session;
    const old = deferred<AgentTeam | undefined>();
    vi.mocked(h.props.agents.getSessionTeam).mockReturnValueOnce(old.promise);
    h.render();
    if (target === 'host') h.props.agents = { ...h.props.agents };
    else h.props.workspace = { ...workspace, id: 'other-workspace' };
    h.render(); await settle();
    old.reject(new Error('Old host/workspace failure')); await settle();
    expect(h.control().team).toEqual(team);
    expect(h.control().error).toBeUndefined();
  });

  it('does not reuse a previous team after its saved summary changes and the fresh load fails', async () => {
    const h = harness(); h.props.session = session;
    h.render(); await settle(); expect(h.control().team).toEqual(team);
    h.props.session = { ...session, team: { enabled: false, size: 1, updatedAt: '2026-11-08T01:00:00.000Z' } };
    vi.mocked(h.props.agents.getSessionTeam).mockRejectedValueOnce(new Error('Fresh load failed'));
    expect(h.control().team).toBeUndefined(); await settle();
    expect(h.control().error).toBe('Fresh load failed');
    expect(h.control().team).toBeUndefined();
  });

  it.each(['workspace', 'host', 'session'] as const)('discards late save results after a %s switch', async target => {
    const h = harness(), save = deferred<HostState>();
    vi.mocked(h.props.agents.saveWorkspaceTeam).mockReturnValueOnce(save.promise);
    const pending = h.control().toggle(false);
    if (target === 'workspace') h.props.workspace = { ...workspace, id: 'other', team: undefined };
    if (target === 'host') h.props.agents = { ...h.props.agents };
    if (target === 'session') h.props.session = session;
    h.render();
    save.resolve({ ...state(), workspaces: [{ ...workspace, team: { ...team, enabled: false } }] });
    await pending;
    expect(h.props.onState).not.toHaveBeenCalled();
    expect(h.control().busy).toBe(false);
    expect(h.control().error).toBeUndefined();
  });

  it('ignores a failed old save after navigation and permits immediate retry after a current failure', async () => {
    const h = harness(), old = deferred<HostState>();
    vi.mocked(h.props.agents.saveWorkspaceTeam).mockReturnValueOnce(old.promise);
    const save = h.control().toggle(false);
    h.props.workspace = { ...workspace, id: 'other' }; h.render();
    old.reject(new Error('Old save failure')); await save;
    expect(h.control().error).toBeUndefined();
    vi.mocked(h.props.agents.saveWorkspaceTeam).mockRejectedValueOnce(new Error('Save failed'));
    await h.control().toggle(false);
    expect(h.control().error).toBe('Save failed');
    h.control().retry();
    await h.control().toggle(false);
    expect(h.control().team?.enabled).toBe(false);
  });

  it('makes observed and unsupported-host controls honest and inaccessible', () => {
    const h = harness(); h.props.session = { ...session, control: 'observed' };
    expect(text(h.render())).toContain(MESSAGES.en.chat.team.observed);
    expect(elements(h.render()).some(item => item.type === 'button')).toBe(false);
    expect(h.props.agents.getSessionTeam).not.toHaveBeenCalled();
    h.props.session = undefined;
    h.props.agents = { ...h.props.agents, saveWorkspaceTeam: undefined } as unknown as AgentHostApi;
    expect(text(h.render())).toContain(MESSAGES.en.chat.team.unsupported);
    expect(elements(h.render()).some(item => item.type === 'button')).toBe(false);
  });

  it('requires current Hermes limits for activation but permits deactivation with blocked routing', async () => {
    const h = harness(); h.props.workspace = { ...workspace, runtimeId: 'hermes', team: { ...team, enabled: false } };
    expect(h.switchNode().props.disabled).toBe(true);
    await settle(); expect(h.switchNode().props.disabled).toBe(false);
    expect(chatTeamEnableBlock(team, true, { ...choices, hermesDelegation: { ...choices.hermesDelegation!, modelRouting: 'profile-custom' } })).toBe('routing');
    expect(chatTeamEnableBlock({ ...team, members: [team.members[0]!, team.members[0]!, team.members[0]!, team.members[0]!] }, true, choices)).toBe('size');
    expect(chatTeamEnableBlock(team, false)).toBeUndefined();
    h.props.workspace = { ...h.props.workspace, team };
    vi.mocked(h.props.agents.modelChoices).mockRejectedValueOnce(new Error('Unavailable'));
    h.control().retry(); h.render(); await settle();
    expect(h.switchNode().props.disabled).toBe(false);
    await h.control().toggle(false);
    expect(h.props.agents.saveWorkspaceTeam).toHaveBeenCalledWith(workspace.id, { ...team, enabled: false });
  });

  it.each(['en', 'id'] as const)('discloses Hermes runtime delegation independently from the saved team state in %s', language => {
    const h = harness(language);
    h.props.workspace = { ...workspace, runtimeId: 'hermes', team: { ...team, enabled: false } };
    expect(text(h.render())).toContain(MESSAGES[language].chat.team.hermesRuntime);
    expect(text(h.render())).toContain(MESSAGES[language].chat.team.inactive);
  });

  it('does not reuse successful Hermes limits after changing host/runtime scope and a failed reload', async () => {
    const h = harness(); h.props.workspace = { ...workspace, runtimeId: 'hermes', team: { ...team, enabled: false } };
    h.render(); await settle(); expect(h.control().enableBlock).toBeUndefined();
    h.props.agents = { ...h.props.agents, modelChoices: vi.fn(async () => { throw new Error('Unavailable'); }) };
    h.render(); await settle();
    expect(h.control().enableBlock).toBe('limits');
    expect(h.switchNode().props.disabled).toBe(true);
  });
});

describe('Chat session creation team handoff', () => {
  it.each([true, false])('sends the exact enabled=%s team snapshot with the model choice', async enabled => {
    const snapshot = { ...team, enabled };
    const agents = { createSession: vi.fn(async () => session), getState: vi.fn(async () => state()) };
    const onSelect = vi.fn();
    await createComposerSession({ agents, workspaceId: workspace.id, choice: { model: 'chosen-model' }, team: snapshot, bindSession: () => true, onState: vi.fn(), onSelect, interrupted: 'Interrupted' });
    expect(agents.createSession).toHaveBeenCalledWith(workspace.id, { model: 'chosen-model', team: snapshot });
    expect(onSelect).toHaveBeenCalledWith({ workspaceId: workspace.id, sessionId: session.id });
  });

  it('retains no-team intent explicitly and leaves old callers on default inheritance', async () => {
    const agents = { createSession: vi.fn(async () => session), getState: vi.fn(async () => state()) };
    const request = { agents, workspaceId: workspace.id, choice: {}, bindSession: () => true, onState: vi.fn(), onSelect: vi.fn(), interrupted: 'Interrupted' };
    await createComposerSession({ ...request, team: null });
    expect(agents.createSession).toHaveBeenLastCalledWith(workspace.id, { team: null });
    await createComposerSession(request);
    expect(agents.createSession).toHaveBeenLastCalledWith(workspace.id, {});
  });
});
