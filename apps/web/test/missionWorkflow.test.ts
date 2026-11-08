import type { AgentHostApi, ConnectionView, HostMissionRun, HostState, MissionPlan, MissionPlanRequest, SessionSummary } from '@extalia/platform';
import type * as React from 'react';
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { MissionComposer } from '../src/missions/MissionComposer';
import { MissionPlanEditor } from '../src/missions/MissionPlanEditor';
import { MissionSessionSetup } from '../src/missions/MissionSessionSetup';
import { MissionWorkflow } from '../src/missions/MissionWorkflow';
import { allowedPairs, draftFromPlan, requestFromDraft, submittedPlan } from '../src/missions/missionModel';

type Scope = {
  index: number; state: unknown[]; mounted: boolean;
  memo: Map<number, { deps: unknown[]; value: unknown }>;
  effects: Map<number, { deps: unknown[]; cleanup?: () => void }>;
};
// A keyed hook harness renders the actual workflow/setup components and task editor.
// Other UI leaves stay opaque; no DOM, WebGL or new browser dependency is needed.
const hooks = vi.hoisted(() => ({ active: null as Scope | null, dirty: false, lateWrites: 0, pending: [] as (() => void)[] }));
vi.mock('react', async original => {
  const same = (a: unknown[] | undefined, b: unknown[]) => a?.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const effect = (run: () => void | (() => void), deps: unknown[]) => {
    const scope = hooks.active!, index = scope.index++, previous = scope.effects.get(index);
    if (!same(previous?.deps, deps)) hooks.pending.push(() => {
      previous?.cleanup?.();
      const cleanup = run();
      scope.effects.set(index, { deps, ...(cleanup ? { cleanup } : {}) });
    });
  };
  return { ...await original<typeof React>(),
    useState: (initial: unknown) => {
      const scope = hooks.active!, index = scope.index++;
      if (!(index in scope.state)) scope.state[index] = typeof initial === 'function' ? initial() : initial;
      return [scope.state[index], (next: unknown) => {
        if (!scope.mounted) hooks.lateWrites++;
        const value = typeof next === 'function' ? next(scope.state[index]) : next;
        if (!Object.is(value, scope.state[index])) { scope.state[index] = value; hooks.dirty = true; }
      }];
    },
    useRef: (initial: unknown) => { const scope = hooks.active!, index = scope.index++; return scope.state[index] ??= { current: initial }; },
    useMemo: (compute: () => unknown, deps: unknown[]) => {
      const scope = hooks.active!, index = scope.index++, previous = scope.memo.get(index);
      if (!same(previous?.deps, deps)) scope.memo.set(index, { deps, value: compute() });
      return scope.memo.get(index)!.value;
    },
    useEffect: effect, useLayoutEffect: effect,
    useId: () => `field-${hooks.active!.index++}`,
  };
});

function elements(node: ReactNode, visibleOnly = false): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(item => elements(item, visibleOnly));
  if (!isValidElement<Record<string, unknown>>(node) || (visibleOnly && node.props.hidden)) return [];
  return [node, ...elements(node.props.children as ReactNode, visibleOnly)];
}
const text = (node: ReactNode): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : '';
const button = (tree: ReactNode, label: string) => elements(tree, true).find(node => node.type === 'button' && text(node.props.children as ReactNode) === label)!;
const click = (node: ReactElement<Record<string, unknown>>) => (node.props.onClick as () => void)();
const change = (node: ReactElement<Record<string, unknown>>, value: string | boolean) => (node.props.onChange as (event: unknown) => void)({ target: typeof value === 'boolean' ? { checked: value } : { value } });
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (failure: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

const mounted: (() => void)[] = [];
function mount<P extends object>(component: (props: P) => ReactNode, props: P) {
  const scopes = new Map<string, Scope>();
  const dispose = (scope: Scope) => { for (const effect of scope.effects.values()) effect.cleanup?.(); scope.mounted = false; };
  const unmount = () => { for (const scope of scopes.values()) dispose(scope); scopes.clear(); };
  mounted.push(unmount);
  const render = () => {
    let tree: ReactNode;
    do {
      hooks.dirty = false;
      const seen = new Set<string>();
      const visit = (node: ReactNode, path: string): ReactNode => {
        if (Array.isArray(node)) return node.map((child, index) => visit(child, `${path}.${index}`));
        if (!isValidElement<Record<string, unknown>>(node)) return node;
        const key = `${path}:${node.key ?? ''}`;
        if (typeof node.type === 'function' && ['MissionWorkflow', 'MissionComposer', 'MissionPlanEditor', 'MissionSessionSetup', 'TaskEditor'].includes(node.type.name)) {
          seen.add(key);
          if (!scopes.has(key)) scopes.set(key, { index: 0, state: [], mounted: true, memo: new Map(), effects: new Map() });
          hooks.active = scopes.get(key)!; hooks.active.index = 0;
          const result = (node.type as (props: Record<string, unknown>) => ReactNode)(node.props);
          return cloneElement(node, { children: visit(result, `${key}.output`) });
        }
        return cloneElement(node, { children: visit(node.props.children as ReactNode, `${key}.children`) });
      };
      tree = visit(createElement(component, props), 'root');
      for (const [key, scope] of scopes) if (!seen.has(key)) { dispose(scope); scopes.delete(key); }
      for (const run of hooks.pending.splice(0)) run();
    } while (hooks.dirty);
    return tree;
  };
  return { props, render, unmount };
}

const at = '2026-11-08T00:00:00Z';
function fixture() {
  const connection = (id: string): ConnectionView => ({ id, name: id, preset: 'openai-compatible' as ConnectionView['preset'], api: 'openai-chat', baseUrl: 'https://example.com/v1', model: `model-${id}`, credential: { kind: 'none' }, credentialStatus: 'not-needed', features: { memory: 'extalia', skills: 'off' }, orchestration: { enabled: true, maxDelegations: 3, tiers: {} }, createdAt: at, updatedAt: at });
  const workspace = { id: 'workspace', profileId: 'profile', name: 'Project', projectLocation: '/tmp/project', providerProfileId: 'a', missionConnectionIds: ['b'], createdAt: at, updatedAt: at };
  const session: SessionSummary = { id: 'session', workspaceId: workspace.id, connectionId: 'a', title: 'Session', control: 'managed', running: false, createdAt: at, lastActiveAt: at };
  const state: HostState = { setupComplete: true, dataDirectory: '/tmp/profile', profile: { id: 'profile', name: 'Profile' }, connections: [connection('a'), connection('b')], workspaces: [workspace], sessions: [session], library: [], storage: { dataDirectory: '/tmp/profile', secretStore: 'memory' }, host: { kind: 'bridge', version: '0' } };
  const plan: MissionPlan = { title: 'Proposed review', maxConcurrency: 1, source: 'model', tasks: [{ id: 'review', title: 'Review', instructions: 'Inspect the project.', connectionId: 'a', model: 'model-a', dependsOn: [] }] };
  const planner = vi.fn(async (_sessionId: string, _request: MissionPlanRequest): Promise<MissionPlan> => plan), launch = vi.fn();
  const agents = { planNativeMission: planner, startNativeMission: launch, modelChoices: vi.fn(async () => ({ models: ['model-extra'], efforts: [] })) } as unknown as AgentHostApi;
  return { t: MESSAGES.en, agents, state, session, workspace, onState: vi.fn(), onLaunched: vi.fn(), planner, launch, plan };
}
function typeGoal(tree: ReactNode, value: string) { change(elements(tree, true).find(node => node.type === 'textarea')!, value); }
function submit(tree: ReactNode) { (elements(tree, true).find(node => node.type === 'form')!.props.onSubmit as (event: unknown) => void)({ preventDefault() {} }); }

beforeEach(() => { hooks.active = null; hooks.dirty = false; hooks.lateWrites = 0; hooks.pending = []; });
afterEach(() => { mounted.splice(0).forEach(unmount => unmount()); });

describe('mission workflow preservation', () => {
  it('retains goal choices and edited tasks on Back / Return to plan without another host call', async () => {
    const f = fixture(), h = mount(MissionWorkflow, f);
    typeGoal(h.render(), 'Inspect this project'); await settle();
    let tree = h.render();
    change(elements(tree, true).filter(node => node.type === 'input' && node.props.type === 'checkbox')[1]!, false);
    tree = h.render();
    click(button(tree, 'model-extraa'));
    tree = h.render();
    change(elements(tree, true).find(node => node.type === 'input' && node.props.type === 'number')!, '3');
    submit(h.render()); await settle();
    tree = h.render();
    const taskEditor = elements(tree).find(node => typeof node.type === 'function' && node.type.name === 'TaskEditor')!;
    const task = taskEditor.props.task as { title: string; instructions: string };
    (taskEditor.props.onChange as (next: unknown) => void)({ ...task, title: 'Edited task', instructions: 'Keep these edits.' });
    click(button(h.render(), f.t.missions.plan.back));
    tree = h.render();
    expect(elements(tree, true).find(node => node.type === 'textarea')!.props.value).toBe('Inspect this project');
    expect(elements(tree, true).filter(node => node.type === 'input' && node.props.type === 'checkbox').map(node => node.props.checked)).toEqual([true, false]);
    expect(elements(tree, true).find(node => node.type === 'input' && node.props.type === 'number')!.props.value).toBe(3);
    expect(elements(tree, true).find(node => node.type === 'button' && text(node.props.children as ReactNode) === 'model-extraa')!.props['aria-pressed']).toBe(false);
    click(button(tree, f.t.missions.compose.resumePlan));
    tree = h.render();
    expect(elements(tree, true).find(node => typeof node.type === 'function' && node.type.name === 'TaskEditor')!.props.task).toMatchObject({ title: 'Edited task', instructions: 'Keep these edits.' });
    expect(f.planner).toHaveBeenCalledOnce(); expect(f.launch).not.toHaveBeenCalled(); expect(f.onLaunched).not.toHaveBeenCalled();
    expect(f.planner.mock.calls[0]).toEqual(['session', { goal: 'Inspect this project', maxTasks: 3, connectionIds: ['a'], models: ['model-a'] }]);
    click(button(tree, f.t.missions.plan.back));
    submit(h.render()); await settle();
    tree = h.render();
    expect(elements(tree, true).find(node => node.type === MissionPlanEditor)!.props.initial).toMatchObject({ title: 'Proposed review' });
    expect(elements(tree, true).find(node => typeof node.type === 'function' && node.type.name === 'TaskEditor')!.props.task).toMatchObject({ title: 'Review', instructions: 'Inspect the project.' });
  });

  it('retains the full long goal document across review and back', async () => {
    const f = fixture(), h = mount(MissionWorkflow, f), longGoal = 'Read this context.\n'.repeat(400);
    typeGoal(h.render(), longGoal); submit(h.render()); await settle();
    click(button(h.render(), f.t.missions.plan.back));
    expect(text(h.render())).toContain(f.t.composer.longTextAttached);
    submit(h.render()); await settle();
    expect(f.planner).toHaveBeenCalledTimes(2);
    expect(f.planner.mock.calls[0]).toEqual(f.planner.mock.calls[1]);
    expect(f.planner.mock.calls[0]![1]).toMatchObject({ goalDocument: { name: 'goal.txt', text: longGoal } });
    expect(f.launch).not.toHaveBeenCalled();
  });
});

describe('mission composer request ownership', () => {
  it('admits one planner call for same-tick submissions and blocks manual bypass', async () => {
    const f = fixture(), pending = deferred<MissionPlan>(); f.planner.mockImplementation(() => pending.promise);
    const onPlanned = vi.fn(), h = mount(MissionComposer, { ...f, onPlanned });
    typeGoal(h.render(), 'Review'); const tree = h.render();
    submit(tree); submit(tree); click(button(tree, f.t.missions.compose.manual));
    expect(f.planner).toHaveBeenCalledOnce(); expect(onPlanned).not.toHaveBeenCalled();
    pending.resolve(f.plan); await settle(); expect(onPlanned).toHaveBeenCalledOnce();
  });

  it.each(['unmount', 'host', 'session', 'workspace'] as const)('ignores late success after %s change', async kind => {
    const f = fixture(), pending = deferred<MissionPlan>(); f.planner.mockImplementation(() => pending.promise);
    const onPlanned = vi.fn(), h = mount(MissionComposer, { ...f, onPlanned });
    typeGoal(h.render(), 'Review'); submit(h.render());
    if (kind === 'unmount') h.unmount();
    else { if (kind === 'host') h.props.agents = { ...f.agents }; if (kind === 'session') h.props.session = { ...f.session, id: 'next-session' }; if (kind === 'workspace') h.props.workspace = { ...f.workspace, id: 'next-workspace' }; h.render(); }
    pending.resolve(f.plan); await settle();
    expect(onPlanned).not.toHaveBeenCalled(); expect(hooks.lateWrites).toBe(0);
    if (kind !== 'unmount') expect(button(h.render(), f.t.missions.compose.plan).props.disabled).toBe(false);
  });

  it('ignores a stale error while a newer host request is pending', async () => {
    const f = fixture(), old = deferred<MissionPlan>(), next = deferred<MissionPlan>(); f.planner.mockImplementation(() => old.promise);
    const onPlanned = vi.fn(), h = mount(MissionComposer, { ...f, onPlanned });
    typeGoal(h.render(), 'Review'); submit(h.render());
    const nextPlanner = vi.fn(() => next.promise); h.props.agents = { ...f.agents, planNativeMission: nextPlanner };
    submit(h.render()); old.reject(new Error('Old host failure')); await settle();
    const tree = h.render(); expect(text(tree)).not.toContain('Old host failure'); expect(button(tree, f.t.missions.compose.planning).props.disabled).toBe(true);
    next.resolve(f.plan); await settle(); expect(onPlanned).toHaveBeenCalledOnce();
  });

  it('ignores a late failure after unmount and releases the lock after a current failure', async () => {
    const f = fixture(), pending = deferred<MissionPlan>(); f.planner.mockImplementation(() => pending.promise);
    const onPlanned = vi.fn(), h = mount(MissionComposer, { ...f, onPlanned });
    typeGoal(h.render(), 'Review'); submit(h.render());
    pending.reject(new Error('Planning unavailable')); await settle();
    expect(text(h.render())).toContain('Planning unavailable');
    const late = deferred<MissionPlan>(); f.planner.mockImplementation(() => late.promise);
    submit(h.render()); expect(f.planner).toHaveBeenCalledTimes(2);
    h.unmount(); late.reject(new Error('Late failure')); await settle();
    expect(onPlanned).not.toHaveBeenCalled(); expect(hooks.lateWrites).toBe(0);
  });

  it('does not revive abandoned planning when returning to the original host', async () => {
    const f = fixture(), pending = deferred<MissionPlan>(); f.planner.mockImplementation(() => pending.promise);
    const onPlanned = vi.fn(), h = mount(MissionComposer, { ...f, onPlanned });
    typeGoal(h.render(), 'Review'); submit(h.render());
    h.props.agents = { ...f.agents }; h.render();
    h.props.agents = f.agents;
    expect(button(h.render(), f.t.missions.compose.plan).props.disabled).toBe(false);
    pending.resolve(f.plan); await settle(); expect(onPlanned).not.toHaveBeenCalled();
  });
});

describe('mission launch ownership', () => {
  function editor() {
    const f = fixture();
    const props: Parameters<typeof MissionPlanEditor>[0] = {
      t: f.t, agents: f.agents, session: f.session, connections: f.state.connections,
      pairs: allowedPairs(f.state.connections), initial: draftFromPlan(f.plan), onBack: vi.fn(), onLaunched: f.onLaunched,
    };
    const run = (id: string): HostMissionRun => ({
      id, sessionId: f.session.id, workspaceId: f.workspace.id, title: f.plan.title, state: 'running', createdAt: at, updatedAt: at, transient: false,
      tasks: [{ id: 'review', taskId: 'task-review', agentId: 'agent-review', title: 'Review', connectionId: 'a', model: 'model-a', state: 'running', evidenceIds: [] }],
    });
    return { f, h: mount(MissionPlanEditor, props), run };
  }

  it('launches once with the reviewed request snapshot and remembers that exact submitted plan', async () => {
    const { f, h, run } = editor(), pending = deferred<HostMissionRun>();
    f.launch.mockReturnValue(pending.promise);
    const submitted = requestFromDraft(h.props.initial), tree = h.render();
    click(button(tree, f.t.missions.plan.launch)); click(button(tree, f.t.missions.plan.launch));
    expect(f.launch).toHaveBeenCalledOnce(); expect(f.launch).toHaveBeenCalledWith(f.session.id, submitted);
    const taskEditor = elements(h.render()).find(node => typeof node.type === 'function' && node.type.name === 'TaskEditor')!;
    (taskEditor.props.onChange as (next: unknown) => void)({ ...(taskEditor.props.task as object), instructions: 'Later edit while launch is pending.' });
    h.render();
    const result = run('owned-launch-snapshot'); pending.resolve(result); await settle();
    expect(f.onLaunched).toHaveBeenCalledExactlyOnceWith(result);
    expect(submittedPlan(result.id)).toEqual(submitted);
    expect(submittedPlan(result.id)!.tasks[0]!.instructions).toBe('Inspect the project.');
    click(button(tree, f.t.missions.plan.launch)); expect(f.launch).toHaveBeenCalledOnce();
  });

  it.each(['unmount', 'host', 'session', 'workspace'] as const)('ignores late launch success after %s change', async kind => {
    const { f, h, run } = editor(), pending = deferred<HostMissionRun>(); f.launch.mockReturnValue(pending.promise);
    click(button(h.render(), f.t.missions.plan.launch));
    if (kind === 'unmount') h.unmount();
    else {
      if (kind === 'host') h.props.agents = { ...f.agents };
      if (kind === 'session') h.props.session = { ...f.session, id: 'next-session' };
      if (kind === 'workspace') h.props.session = { ...f.session, workspaceId: 'next-workspace' };
      h.render();
    }
    const result = run(`stale-launch-${kind}`); pending.resolve(result); await settle();
    expect(f.onLaunched).not.toHaveBeenCalled(); expect(hooks.lateWrites).toBe(0);
    expect(submittedPlan(result.id)).toBeUndefined();
    if (kind !== 'unmount') expect(button(h.render(), f.t.missions.plan.launch).props.disabled).toBe(false);
  });

  it.each(['unmount', 'host', 'session', 'workspace'] as const)('ignores late launch error after %s change', async kind => {
    const { f, h } = editor(), pending = deferred<HostMissionRun>(); f.launch.mockReturnValue(pending.promise);
    click(button(h.render(), f.t.missions.plan.launch));
    if (kind === 'unmount') h.unmount();
    else {
      if (kind === 'host') h.props.agents = { ...f.agents };
      if (kind === 'session') h.props.session = { ...f.session, id: 'next-session' };
      if (kind === 'workspace') h.props.session = { ...f.session, workspaceId: 'next-workspace' };
      h.render();
    }
    pending.reject(new Error('Old launch failure')); await settle();
    expect(f.onLaunched).not.toHaveBeenCalled(); expect(hooks.lateWrites).toBe(0);
    if (kind !== 'unmount') {
      const tree = h.render(); expect(text(tree)).not.toContain('Old launch failure');
      expect(button(tree, f.t.missions.plan.launch).props.disabled).toBe(false);
    }
  });

  it('preserves a newer pending launch when the previous host fails', async () => {
    const { f, h, run } = editor(), old = deferred<HostMissionRun>(), next = deferred<HostMissionRun>(); f.launch.mockReturnValue(old.promise);
    click(button(h.render(), f.t.missions.plan.launch));
    const nextLaunch = vi.fn(() => next.promise); h.props.agents = { ...f.agents, startNativeMission: nextLaunch };
    click(button(h.render(), f.t.missions.plan.launch)); old.reject(new Error('Previous host failed')); await settle();
    const tree = h.render(); expect(text(tree)).not.toContain('Previous host failed');
    expect(button(tree, f.t.missions.plan.launching).props.disabled).toBe(true);
    const result = run('new-host-launch'); next.resolve(result); await settle();
    expect(f.onLaunched).toHaveBeenCalledExactlyOnceWith(result);
    expect(nextLaunch).toHaveBeenCalledOnce();
  });

  it('does not revive an abandoned launch when returning to the original context', async () => {
    const { f, h } = editor(), old = deferred<HostMissionRun>(); f.launch.mockReturnValue(old.promise);
    click(button(h.render(), f.t.missions.plan.launch));
    h.props.session = { ...f.session, id: 'other-session' }; h.render();
    h.props.session = f.session;
    expect(button(h.render(), f.t.missions.plan.launch).props.disabled).toBe(false);
    old.reject(new Error('Abandoned launch')); await settle();
    expect(text(h.render())).not.toContain('Abandoned launch'); expect(f.onLaunched).not.toHaveBeenCalled();
  });
});

describe('mission session setup request ownership', () => {
  function setup() {
    const f = fixture();
    const created = { ...f.session, id: 'fresh-session' };
    const nextState = { ...f.state, sessions: [created] };
    const createSession = vi.fn<AgentHostApi['createSession']>();
    const getState = vi.fn(async () => nextState);
    const agents = { ...f.agents, getState, createSession };
    const props: Parameters<typeof MissionSessionSetup>[0] = {
      t: f.t, agents, state: f.state, workspace: f.workspace, session: undefined, sessions: [],
      onWorkspace: vi.fn(), onSession: vi.fn(), onState: f.onState, onCreated: vi.fn(), onOpenChat: vi.fn(),
    };
    return { f, created, nextState, createSession, getState, agents, h: mount(MissionSessionSetup, props) };
  }

  it('admits one session creation for same-tick Create actions without planning or launching', async () => {
    const { f, h, createSession, getState, created, nextState } = setup(), pending = deferred<SessionSummary>();
    createSession.mockReturnValue(pending.promise);
    const tree = h.render();
    click(button(tree, f.t.missions.createSession)); click(button(tree, f.t.missions.createSession));
    expect(getState).toHaveBeenCalledOnce();
    await settle();
    expect(createSession).toHaveBeenCalledExactlyOnceWith(f.workspace.id);
    expect(button(h.render(), f.t.missions.creatingSession).props.disabled).toBe(true);
    expect(h.props.onCreated).not.toHaveBeenCalled(); expect(f.onState).not.toHaveBeenCalled();
    pending.resolve(created); await settle(); await settle();
    expect(h.props.onCreated).toHaveBeenCalledExactlyOnceWith(created);
    expect(f.onState).toHaveBeenCalledExactlyOnceWith(nextState);
    expect(button(h.render(), f.t.missions.createSession).props.disabled).toBe(false);
    expect(f.planner).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
  });

  it.each(['success', 'error'] as const)('keeps a new create pending after host A → B → A and stale %s', async outcome => {
    const { f, h, agents, createSession, getState, created, nextState } = setup();
    const abandoned = deferred<SessionSummary>(), fresh = deferred<SessionSummary>();
    createSession.mockReturnValueOnce(abandoned.promise).mockReturnValueOnce(fresh.promise);
    click(button(h.render(), f.t.missions.createSession)); await settle();
    expect(createSession).toHaveBeenCalledOnce();
    h.props.agents = { ...agents }; h.render();
    h.props.agents = agents;
    expect(button(h.render(), f.t.missions.createSession).props.disabled).toBe(false);
    click(button(h.render(), f.t.missions.createSession)); await settle();
    expect(createSession).toHaveBeenCalledTimes(2);
    if (outcome === 'success') abandoned.resolve({ ...created, id: 'abandoned-session' });
    else abandoned.reject(new Error('Abandoned session creation failed'));
    await settle(); await settle();
    const tree = h.render();
    expect(button(tree, f.t.missions.creatingSession).props.disabled).toBe(true);
    expect(text(tree)).not.toContain('Abandoned session creation failed');
    expect(h.props.onCreated).not.toHaveBeenCalled(); expect(h.props.onSession).not.toHaveBeenCalled();
    expect(f.onState).not.toHaveBeenCalled(); expect(getState).toHaveBeenCalledTimes(2);
    click(button(tree, f.t.missions.creatingSession)); await settle(); expect(createSession).toHaveBeenCalledTimes(2);
    fresh.resolve(created); await settle(); await settle();
    expect(h.props.onCreated).toHaveBeenCalledExactlyOnceWith(created);
    expect(f.onState).toHaveBeenCalledExactlyOnceWith(nextState);
    expect(getState).toHaveBeenCalledTimes(3);
    expect(button(h.render(), f.t.missions.createSession).props.disabled).toBe(false);
    expect(f.planner).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
    expect(hooks.lateWrites).toBe(0);
  });
});
