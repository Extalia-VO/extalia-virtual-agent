import type * as React from 'react';
import type { AgentHostApi, HostState, SessionSummary } from '@extalia/platform';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  index: 0,
  state: [] as unknown[],
  memo: new Map<number, { deps: readonly unknown[]; value: unknown }>(),
  layout: new Map<number, { deps: readonly unknown[]; cleanup?: () => void }>(),
  pendingLayout: [] as (() => void)[],
}));

vi.mock('react', async original => {
  const changed = (previous: readonly unknown[] | undefined, next: readonly unknown[]) =>
    !previous || previous.length !== next.length || next.some((value, index) => !Object.is(value, previous[index]));
  return {
    ...await original<typeof React>(),
    useState: (initial: unknown) => {
      const id = hooks.index++;
      if (!(id in hooks.state)) hooks.state[id] = typeof initial === 'function' ? initial() : initial;
      return [hooks.state[id], (value: unknown) => { hooks.state[id] = typeof value === 'function' ? value(hooks.state[id]) : value; }];
    },
    useRef: (initial: unknown) => { const id = hooks.index++; return hooks.state[id] ??= { current: initial }; },
    useMemo: (compute: () => unknown, deps: readonly unknown[]) => {
      const id = hooks.index++, previous = hooks.memo.get(id);
      if (!previous || changed(previous.deps, deps)) hooks.memo.set(id, { deps, value: compute() });
      return hooks.memo.get(id)!.value;
    },
    useLayoutEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
      const id = hooks.index++, previous = hooks.layout.get(id);
      if (!previous || changed(previous.deps, deps)) hooks.pendingLayout.push(() => {
        hooks.layout.get(id)?.cleanup?.();
        hooks.layout.set(id, { deps, cleanup: effect() ?? undefined });
      });
    },
  };
});

import { useWorkspaceReviewRecovery } from '../src/chat/workspaceReviewRecovery';

const stamp = '2026-11-12T00:00:00.000Z';
const workspaceId = 'workspace-example';
const session = (patch: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 'session-example', workspaceId, connectionId: 'connection-example', title: 'Example', control: 'managed',
  running: false, createdAt: stamp, lastActiveAt: stamp, ...patch,
});
const hostState = { sessions: [] } as unknown as HostState;
function harness(initialSession: SessionSummary = session()) {
  const agents = {
    getState: vi.fn(async () => hostState),
    previewSessionMove: vi.fn(), moveSession: vi.fn(), sendPrompt: vi.fn(),
  } as unknown as AgentHostApi;
  const onState = vi.fn();
  const props = { agents, session: initialSession, onState };
  const render = () => {
    hooks.index = 0;
    const result = useWorkspaceReviewRecovery(props);
    for (const run of hooks.pendingLayout.splice(0)) run();
    return result;
  };
  const unmount = () => {
    for (const entry of hooks.layout.values()) entry.cleanup?.();
    hooks.layout.clear();
  };
  return { agents, onState, props, render, unmount };
}

beforeEach(() => {
  hooks.index = 0; hooks.state = []; hooks.memo.clear(); hooks.layout.clear(); hooks.pendingLayout = [];
});

describe('Native workspace review recovery', () => {
  it('recognizes a remote-prefixed boundary error and refreshes a stale summary without replay or consent', async () => {
    const h = harness(session({ workspaceReviewRequired: undefined }));
    const recovery = h.render();
    expect(recovery.required).toBe(false);
    const failure = new Error("Error invoking remote method 'agentHost.sendPrompt': Error: Workspace folders or access boundaries changed. Review this session's workspace.");
    await recovery.recover(failure);
    expect(h.render().required).toBe(true);
    expect(h.agents.getState).toHaveBeenCalledExactlyOnceWith();
    expect(h.onState).toHaveBeenCalledExactlyOnceWith(hostState);
    expect(h.agents.previewSessionMove).not.toHaveBeenCalled();
    expect(h.agents.moveSession).not.toHaveBeenCalled();
    expect(h.agents.sendPrompt).not.toHaveBeenCalled();
  });

  it('ignores generic, observed, and Hermes failures', async () => {
    const h = harness();
    const recovery = h.render();
    await recovery.recover(new Error('The provider is temporarily unavailable.'));
    expect(h.render().required).toBe(false);
    h.props.session = session({ control: 'observed' });
    const observed = h.render(); await observed.recover(new Error('Workspace folders or access boundaries changed.'));
    expect(h.render().required).toBe(false);
    h.props.session = session({ runtime: { id: 'hermes', profile: 'default' } });
    const hermes = h.render(); await hermes.recover(new Error('Workspace folders or access boundaries changed.'));
    expect(h.render().required).toBe(false);
    expect(h.agents.getState).not.toHaveBeenCalled();
  });

  it('keeps the review action when the diagnostic refresh fails', async () => {
    const h = harness(); vi.mocked(h.agents.getState).mockRejectedValue(new Error('Bridge disconnected.'));
    await h.render().recover(new Error('Workspace folders or access boundaries changed.'));
    expect(h.render().required).toBe(true);
    expect(h.onState).not.toHaveBeenCalled();
  });

  it.each(['session', 'host', 'workspace', 'aba'] as const)('drops a stale refresh after a %s change', async change => {
    const h = harness(), pending = deferred<HostState>();
    vi.mocked(h.agents.getState).mockReturnValue(pending.promise);
    const recovery = h.render();
    const read = recovery.recover(new Error('Workspace folders or access boundaries changed.'));
    expect(h.render().required).toBe(true);
    const originalSession = h.props.session, originalHost = h.props.agents;
    if (change === 'session') h.props.session = session({ id: 'another-session' });
    else if (change === 'host') h.props.agents = { ...originalHost } as AgentHostApi;
    else if (change === 'workspace') h.props.session = session({ workspaceId: 'another-workspace' });
    else {
      h.props.session = session({ workspaceId: 'another-workspace' }); h.render();
      h.props.session = originalSession;
    }
    h.render();
    pending.resolve(hostState); await read;
    expect(h.onState).not.toHaveBeenCalled();
  });

  it('ignores a pending refresh after unmount', async () => {
    const h = harness(), pending = deferred<HostState>();
    vi.mocked(h.agents.getState).mockReturnValue(pending.promise);
    const read = h.render().recover(new Error('Workspace folders or access boundaries changed.'));
    h.unmount(); pending.resolve(hostState); await read;
    expect(h.onState).not.toHaveBeenCalled();
  });

  it('clear invalidates a pending diagnostic read', async () => {
    const h = harness(), pending = deferred<HostState>();
    vi.mocked(h.agents.getState).mockReturnValue(pending.promise);
    const recovery = h.render(), read = recovery.recover(new Error('Workspace folders or access boundaries changed.'));
    expect(h.render().required).toBe(true);
    h.render().clear();
    expect(h.render().required).toBe(false);
    pending.resolve(hostState); await read;
    expect(h.onState).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
