import type * as React from 'react';
import type { AgentHostApi, AgentTeam, SessionSummary } from '@extalia/platform';
import type { ExtaliaEvent } from '@extalia/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionTeamSnapshot } from '../src/office/useSessionTeams';

// Run the real hook and its asynchronous effects without mounting the Office.
const hooks = vi.hoisted(() => ({
  index: 0, dirty: false, state: [] as unknown[],
  memos: new Map<number, { deps: unknown[]; value: unknown }>(),
  effects: new Map<number, { deps: unknown[]; cleanup?: () => void }>(),
  pending: [] as (() => void)[],
}));
const sameDeps = (left: unknown[], right: unknown[]) => left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
vi.mock('react', async original => ({ ...await original<typeof React>(),
  useState: (initial: unknown) => {
    const id = hooks.index++;
    if (!(id in hooks.state)) hooks.state[id] = typeof initial === 'function' ? initial() : initial;
    return [hooks.state[id], (next: unknown) => {
      const value = typeof next === 'function' ? next(hooks.state[id]) : next;
      if (!Object.is(value, hooks.state[id])) { hooks.state[id] = value; hooks.dirty = true; }
    }];
  },
  useMemo: (calculate: () => unknown, deps: unknown[]) => {
    const id = hooks.index++, previous = hooks.memos.get(id);
    if (previous && sameDeps(previous.deps, deps)) return previous.value;
    const value = calculate();
    hooks.memos.set(id, { deps, value });
    return value;
  },
  useEffect: (run: () => void | (() => void), deps: unknown[]) => {
    const id = hooks.index++, previous = hooks.effects.get(id);
    if (previous && sameDeps(previous.deps, deps)) return;
    hooks.pending.push(() => {
      previous?.cleanup?.();
      const cleanup = run();
      hooks.effects.set(id, { deps, ...(cleanup ? { cleanup } : {}) });
    });
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function host() {
  const requests = new Map<string, ReturnType<typeof deferred<AgentTeam | undefined>>[]>();
  const getSessionTeam = vi.fn((id: string) => {
    const request = deferred<AgentTeam | undefined>();
    requests.set(id, [...requests.get(id) ?? [], request]);
    return request.promise;
  });
  const agents = { getSessionTeam, planTeam: vi.fn(), saveSessionTeam: vi.fn() } as unknown as AgentHostApi;
  return { agents, getSessionTeam, request: (id: string, index = 0) => requests.get(id)![index]! };
}
const session = (id = 'session', revision = 'revision-1'): SessionSummary => ({
  id, workspaceId: 'workspace', connectionId: 'connection', title: 'Team', control: 'managed', running: false,
  createdAt: '2026-11-01T00:00:00.000Z', lastActiveAt: '2026-11-01T00:00:00.000Z',
  team: { enabled: true, size: 1, updatedAt: revision },
});
const team = (member = 'original'): AgentTeam => ({
  enabled: true, allowedModels: ['model'],
  members: [{ id: member, name: `Member ${member}`, role: 'Reviewer', models: [`model-${member}`] }],
});
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function harness(agents: AgentHostApi, sessions = [session()]) {
  const input = { agents, sessions, events: [] as ExtaliaEvent[], scope: 'profile-a' };
  const effects = () => { for (const run of hooks.pending.splice(0)) run(); };
  const render = (commit = true) => {
    let result: ReturnType<typeof useSessionTeamSnapshot>;
    do {
      hooks.index = 0; hooks.dirty = false;
      result = useSessionTeamSnapshot(input.agents, input.sessions, input.events, input.scope);
      if (commit) effects();
    } while (hooks.dirty);
    return result;
  };
  return { input, render, effects };
}
beforeEach(() => {
  for (const effect of hooks.effects.values()) effect.cleanup?.();
  hooks.index = 0; hooks.dirty = false; hooks.state = []; hooks.memos.clear(); hooks.effects.clear(); hooks.pending = [];
});

describe('session roster snapshot readiness', () => {
  it('revokes readiness before effects for a pending same-size revision, then certifies the refreshed roster', async () => {
    const source = host(), h = harness(source.agents);
    expect(h.render().readySessionIds.size).toBe(0);
    source.request('session').resolve(team()); await settle();
    expect(h.render().readySessionIds.has('session')).toBe(true);
    h.input.sessions = [session('session', 'revision-2')];
    const pending = h.render(false);
    expect(pending.teams.get('session')?.[0]?.id).toBe('original');
    expect(pending.readySessionIds.has('session')).toBe(false);
    expect(source.getSessionTeam).toHaveBeenCalledTimes(1);
    h.effects();
    source.request('session', 1).resolve(team('replacement')); await settle();
    const refreshed = h.render();
    expect(refreshed.teams.get('session')?.[0]).toMatchObject({ id: 'replacement', model: 'model-replacement' });
    expect(refreshed.readySessionIds.has('session')).toBe(true);
  });

  it('preserves display metadata after a changed-revision failure without certifying it', async () => {
    const source = host(), h = harness(source.agents);
    h.render(); source.request('session').resolve(team()); await settle();
    expect(h.render().readySessionIds.has('session')).toBe(true);
    h.input.sessions = [session('session', 'revision-2')]; h.render();
    source.request('session', 1).reject(new Error('Roster unavailable')); await settle();
    const failed = h.render();
    expect(failed.teams.get('session')?.[0]?.id).toBe('original');
    expect(failed.readySessionIds.size).toBe(0);
  });

  it.each(['host', 'scope'] as const)('isolates a changed %s immediately and ignores its late old response', async kind => {
    const original = host(), replacement = host(), h = harness(original.agents);
    h.render(); original.request('session').resolve(team('old')); await settle();
    expect(h.render().readySessionIds.has('session')).toBe(true);
    // Leave a refresh outstanding on the old source when the identity changes.
    h.input.sessions = [session('session', 'revision-2')]; h.render();
    if (kind === 'host') h.input.agents = replacement.agents;
    else h.input.scope = 'profile-b';
    const beforeCommit = h.render(false);
    expect(beforeCommit.teams.size).toBe(0);
    expect(beforeCommit.readySessionIds.size).toBe(0);
    h.effects();
    const current = kind === 'host' ? replacement.request('session') : original.request('session', 2);
    current.resolve(team('current')); await settle();
    const loaded = h.render();
    expect(loaded.teams.get('session')?.[0]?.id).toBe('current');
    expect(loaded.readySessionIds.has('session')).toBe(true);
    original.request('session', 1).resolve(team('late-old')); await settle();
    const afterLate = h.render();
    expect(afterLate.teams.get('session')?.[0]?.id).toBe('current');
    expect(afterLate.readySessionIds.has('session')).toBe(true);
  });

  it('keeps an unchanged sibling ready while another revision waits or fails', async () => {
    const source = host(), h = harness(source.agents, [session('changed'), session('stable')]);
    h.render(); source.request('changed').resolve(team('first')); source.request('stable').resolve(team('second')); await settle();
    expect([...h.render().readySessionIds].sort()).toEqual(['changed', 'stable']);
    h.input.sessions = [session('changed', 'revision-2'), session('stable')];
    const pending = h.render();
    expect([...pending.readySessionIds]).toEqual(['stable']);
    source.request('changed', 1).reject(new Error('Changed roster unavailable'));
    source.request('stable', 1).reject(new Error('Stable roster unavailable')); await settle();
    const failed = h.render();
    expect([...failed.readySessionIds]).toEqual(['stable']);
    expect(failed.teams.get('changed')?.[0]?.id).toBe('first');
    expect(failed.teams.get('stable')?.[0]?.id).toBe('second');
  });
});
