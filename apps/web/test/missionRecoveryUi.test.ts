import type { AgentHostApi, HostMissionRecoveryResult, HostMissionRun, SessionSummary } from '@extalia/platform';
import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { MissionMonitor } from '../src/missions/MissionMonitor';

// Exercise the monitor's actual async button handler and subsequent render without WebGL or a browser.
const hooks = vi.hoisted(() => ({ index: 0, state: [] as unknown[], effects: [] as (() => void | (() => void))[] }));
vi.mock('react', async original => ({
  ...await original<typeof React>(),
  useId: () => 'recovery-heading', useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); }, useRef: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.state)) hooks.state[index] = { current: initial };
    return hooks.state[index];
  }, useMemo: (compute: () => unknown) => compute(),
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.state)) hooks.state[index] = initial;
    return [hooks.state[index], (value: unknown) => { hooks.state[index] = value; }];
  },
}));
vi.mock('../src/chat/useSessionEvents', () => ({ useSessionEvents: () => ({ events: [] }) }));

const at = '2026-10-27T00:00:00.000Z';
const run: HostMissionRun = { id: 'mission', sessionId: 'session', workspaceId: 'workspace', title: 'Inspect', state: 'recovering', transient: false, createdAt: at, updatedAt: at,
  tasks: [{ id: 'inspect', taskId: 'task', agentId: 'agent', title: 'Inspect project', connectionId: 'provider', model: 'model', state: 'unknown', evidenceIds: [] }] };
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const text = (node: ReactNode): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : '';
const button = (tree: ReactNode, label: string) => elements(tree).find(element => element.type === 'button' && text(element.props.children as ReactNode) === label);
beforeEach(() => { hooks.index = 0; hooks.state = []; hooks.effects = []; });

describe('mission recovery UI', () => {
  it.each(['en', 'id'] as const)('forwards refresh, disables the pending button, and shows canonical quarantine detail (%s)', async language => {
    const t = MESSAGES[language], onChanged = vi.fn();
    let resolve!: (value: HostMissionRecoveryResult) => void;
    const refresh = vi.fn(() => new Promise<HostMissionRecoveryResult>(done => { resolve = done; }));
    const agents = { refreshNativeMissionRecovery: refresh } as unknown as AgentHostApi;
    const render = () => { hooks.index = 0; return MissionMonitor({ t, language, agents, initial: run, session: { id: 'session' } as SessionSummary, connections: [], onBack: vi.fn(), onChanged }); };
    let tree = render();
    expect(button(tree, t.missions.run.cancel)).toBeUndefined();
    (button(tree, t.missions.run.refreshRecovery)!.props.onClick as () => void)();
    expect(refresh).toHaveBeenCalledWith('session', 'mission');
    tree = render();
    expect(button(tree, t.missions.run.refreshingRecovery)!.props.disabled).toBe(true);
    resolve({ run, status: 'quarantined', reason: 'tasks-nonterminal', snapshot: { missionId: 'mission', workspaceId: 'canonical-workspace', state: 'recovering', updatedAt: at, version: 7, sequence: 11,
      tasks: [{ taskId: 'task', assignedAgentId: 'agent', state: 'running', attempt: 1 }], leases: [] } });
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith(run));
    tree = render();
    expect(text(tree)).toContain(t.missions.run.recoveryReasons['tasks-nonterminal']);
    expect(text(tree)).toContain(t.missions.run.snapshotDetail(7, 11, 0));
    expect(elements(tree).some(element => element.props.state === 'running')).toBe(true);
    expect(button(tree, t.missions.run.refreshRecovery)!.props.disabled).toBe(false);
  });

  it('ignores a delayed old poll after a successful terminal refresh', async () => {
    const t = MESSAGES.en, onChanged = vi.fn();
    let poll!: (run: HostMissionRun) => void;
    const completed: HostMissionRun = { ...run, state: 'completed', tasks: [{ ...run.tasks[0]!, state: 'completed' }] };
    const agents = {
      nativeMissionRun: vi.fn(() => new Promise<HostMissionRun>(resolve => { poll = resolve; })),
      refreshNativeMissionRecovery: vi.fn(async () => ({ run: completed, status: 'refreshed' as const })),
    } as unknown as AgentHostApi;
    const props = { t, language: 'en' as const, agents, initial: run, session: { id: 'session' } as SessionSummary, connections: [], onBack: vi.fn(), onChanged };
    const first = MissionMonitor(props);
    const unmount = hooks.effects[0]!();
    const stopPoll = hooks.effects[1]!();
    (button(first, t.missions.run.refreshRecovery)!.props.onClick as () => void)();
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith(completed));
    poll(run);
    await Promise.resolve(); await Promise.resolve();
    expect(onChanged).toHaveBeenCalledTimes(1);
    hooks.index = 0;
    expect(button(MissionMonitor(props), t.missions.run.refreshRecovery)).toBeUndefined();
    if (typeof stopPoll === 'function') stopPoll();
    if (typeof unmount === 'function') unmount();
  });

  it('does not apply a refresh response after unmount', async () => {
    const t = MESSAGES.en, onChanged = vi.fn();
    let answer!: (result: HostMissionRecoveryResult) => void;
    const agents = { refreshNativeMissionRecovery: vi.fn(() => new Promise<HostMissionRecoveryResult>(resolve => { answer = resolve; })) } as unknown as AgentHostApi;
    const tree = MissionMonitor({ t, language: 'en', agents, initial: run, session: { id: 'session' } as SessionSummary, connections: [], onBack: vi.fn(), onChanged });
    const cleanup = hooks.effects[0]!();
    (button(tree, t.missions.run.refreshRecovery)!.props.onClick as () => void)();
    if (typeof cleanup === 'function') cleanup();
    answer({ run: { ...run, state: 'completed' }, status: 'refreshed' });
    await Promise.resolve(); await Promise.resolve();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('shows unsupported on older host objects and keeps missing output absent after terminal refresh', async () => {
    const t = MESSAGES.en;
    const props = { t, language: 'en' as const, initial: run, session: { id: 'session' } as SessionSummary, connections: [], onBack: vi.fn(), onChanged: vi.fn() };
    expect(text(MissionMonitor({ ...props, agents: {} as AgentHostApi }))).toContain(t.missions.run.recoveryUnsupported);
    hooks.state = []; hooks.index = 0;
    const completed: HostMissionRun = { ...run, state: 'completed', tasks: [{ ...run.tasks[0]!, state: 'completed' }] };
    const agents = { refreshNativeMissionRecovery: vi.fn(async () => ({ run: completed, status: 'refreshed' as const })) } as unknown as AgentHostApi;
    const tree = MissionMonitor({ ...props, agents });
    (button(tree, t.missions.run.refreshRecovery)!.props.onClick as () => void)();
    await vi.waitFor(() => expect(props.onChanged).toHaveBeenCalledWith(completed));
    hooks.index = 0;
    const next = MissionMonitor({ ...props, agents });
    expect(text(next)).toContain(t.missions.run.noAnswer);
    expect(text(next)).toContain(t.missions.run.recoveryRefreshed);
    expect(button(next, t.missions.run.refreshRecovery)).toBeUndefined();
  });
});
