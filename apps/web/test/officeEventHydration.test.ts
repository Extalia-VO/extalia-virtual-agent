import { describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@extalia/platform';
import { createEvent, type EventBody, type ExtaliaEvent } from '@extalia/protocol';
import { createOfficeEventHydration, retainOfficeEvents, selectOfficeEvents } from '../src/office/useOfficeEvents';
import { projectOfficePresence, subagentLingerMs } from '../src/office/presence';
import { cameraAttentionIds } from '../src/office/cameraAttention';

const event = (sessionId: string, seq: number, body: EventBody = { type: 'agent.state', state: 'working' }, agentId = 'primary'): ExtaliaEvent => ({
  ...createEvent({ sessionId, agentId, source: { runtime: 'example', channel: 'hook' }, body }),
  id: `${sessionId}-${agentId}-${seq}`, seq, at: new Date(seq * 1_000).toISOString(),
});
const deferred = () => {
  let resolve!: (events: ExtaliaEvent[]) => void;
  let reject!: (failure: Error) => void;
  const promise = new Promise<ExtaliaEvent[]>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const fixture = () => {
  const requests = new Map<string, ReturnType<typeof deferred>[]>();
  const listeners = new Set<(event: ExtaliaEvent) => void>();
  const order: string[] = [];
  const host = {
    subscribe: vi.fn((listener: (event: ExtaliaEvent) => void) => {
      order.push('subscribe'); listeners.add(listener);
      return () => { listeners.delete(listener); };
    }),
    sessionEvents: vi.fn((id: string) => {
      order.push(`history:${id}`);
      const request = deferred();
      requests.set(id, [...requests.get(id) ?? [], request]);
      return request.promise;
    }),
  };
  const hydration = createOfficeEventHydration(host);
  const read = (ids: string[]) => selectOfficeEvents(hydration.getSnapshot(), ids);
  const emit = (value: ExtaliaEvent) => { for (const listener of listeners) listener(value); };
  const request = (id: string, index = 0) => requests.get(id)![index]!;
  return { host, hydration, read, emit, request, order, listeners };
};

describe('host-scoped Office event hydration', () => {
  it('distinguishes a successfully empty history from pending or failed hydration', async () => {
    const f = fixture(), stop = f.hydration.start();
    f.hydration.setSessionIds(['a', 'b']);
    expect(f.hydration.isLoaded('a')).toBe(false);
    f.emit(event('a', 1));
    expect(f.hydration.isLoaded('a')).toBe(false);
    f.request('a').reject(new Error('History unavailable'));
    f.request('b').resolve([]);
    await Promise.resolve();
    expect(f.hydration.isLoaded('a')).toBe(false);
    expect(f.hydration.isLoaded('b')).toBe(true);
    expect(f.read(['b']).events).toEqual([]);
    f.hydration.setSessionIds([]);
    expect(f.hydration.isLoaded('b')).toBe(false);
    stop();
  });

  it('keeps retained sessions through add/remove and partial out-of-order history without refetching', async () => {
    const f = fixture(), stop = f.hydration.start();
    f.hydration.setSessionIds(['a']);
    const a = event('a', 1);
    f.request('a').resolve([a]); await Promise.resolve();
    f.hydration.setSessionIds(['a', 'b', 'c']);
    expect(f.read(['a', 'b', 'c']).events).toEqual([a]);
    const c = event('c', 2);
    f.request('c').resolve([c]); await Promise.resolve();
    expect(f.read(['a', 'b', 'c']).events).toEqual([a, c]);
    // A render sees the new selection even before the membership effect prunes it.
    expect(f.read(['a', 'b']).events).toEqual([a]);
    f.hydration.setSessionIds(['a', 'b']);
    f.emit(event('c', 3));
    const b = event('b', 1);
    f.request('b').resolve([b]); await Promise.resolve();
    expect(f.read(['a', 'b']).events).toEqual([a, b]);
    expect(f.hydration.getSnapshot().has('c')).toBe(false);
    expect(f.host.sessionEvents.mock.calls).toEqual([['a'], ['b'], ['c']]);
    stop();
  });

  it('subscribes first and merges live events received before history resolves, including duplicates', async () => {
    const f = fixture(), stop = f.hydration.start();
    f.hydration.setSessionIds(['a']);
    const old = event('a', 1), live = event('a', 2);
    f.emit(live);
    f.hydration.setSessionIds(['a', 'b']);
    expect(f.read(['a', 'b']).events).toEqual([live]);
    f.request('a').resolve([old, live, event('unselected', 1)]); await Promise.resolve();
    expect(f.read(['a', 'b']).events).toEqual([old, live]);
    expect(f.order.slice(0, 2)).toEqual(['subscribe', 'history:a']);
    expect(f.host.sessionEvents.mock.calls.filter(([id]) => id === 'a')).toHaveLength(1);
    stop();
  });

  it('ignores requests and callbacks from a cleaned-up host, even with identical session IDs', async () => {
    const old = fixture(), current = fixture();
    const stop = old.hydration.start();
    old.hydration.setSessionIds(['a']);
    const staleCallback = [...old.listeners][0]!;
    stop();
    const stopCurrent = current.hydration.start();
    current.hydration.setSessionIds(['a']);
    staleCallback(event('a', 2));
    old.request('a').resolve([event('a', 1)]); await Promise.resolve();
    expect(old.read(['a']).events).toEqual([]);
    expect(current.read(['a']).events).toEqual([]);
    const fresh = event('a', 3);
    current.request('a').resolve([fresh]); await Promise.resolve();
    expect(current.read(['a']).events).toEqual([fresh]);
    stopCurrent();
  });

  it('does not reuse removed history or accept its late request when that ID returns', async () => {
    const f = fixture(), stop = f.hydration.start();
    f.hydration.setSessionIds(['a']);
    f.emit(event('a', 1));
    f.hydration.setSessionIds([]);
    f.hydration.setSessionIds(['a']);
    f.request('a').resolve([event('a', 2)]); await Promise.resolve();
    expect(f.read(['a']).events).toEqual([]);
    const fresh = event('a', 3);
    f.request('a', 1).resolve([fresh]); await Promise.resolve();
    expect(f.read(['a']).events).toEqual([fresh]);
    stop();
  });

  it('preserves known and in-flight live history on failure and ignores stale rejection after restart', async () => {
    const f = fixture();
    const stop = f.hydration.start();
    f.hydration.setSessionIds(['a', 'b']);
    const a = event('a', 1), live = event('b', 2);
    f.request('a').resolve([a]); await Promise.resolve();
    f.emit(live);
    stop();
    const stopAgain = f.hydration.start();
    f.request('b').reject(new Error('stale failure')); await Promise.resolve();
    expect(f.read(['a', 'b'])).toEqual({ events: [a, live], error: undefined });
    f.request('b', 1).reject(new Error('history unavailable')); await Promise.resolve();
    expect(f.read(['a', 'b'])).toEqual({ events: [a, live], error: 'history unavailable' });
    f.hydration.setSessionIds(['a']);
    expect(f.read(['a'])).toEqual({ events: [a], error: undefined });
    expect(f.host.sessionEvents.mock.calls.filter(([id]) => id === 'a')).toHaveLength(1);
    stopAgain();
  });

  it('rejects a stale successful completion after effect restart', async () => {
    const f = fixture(), stop = f.hydration.start();
    f.hydration.setSessionIds(['a']); stop();
    const stopAgain = f.hydration.start();
    f.request('a').resolve([event('a', 1)]); await Promise.resolve();
    expect(f.read(['a']).events).toEqual([]);
    f.request('a', 1).resolve([event('a', 2)]); await Promise.resolve();
    expect(f.read(['a']).events.map(value => value.seq)).toEqual([2]);
    stopAgain();
  });
});

const session = (id: string): SessionSummary => ({ id, workspaceId: 'workspace', connectionId: 'connection', title: 'Fixture', control: 'observed', running: false,
  createdAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString(),
  observation: { sourceId: 'example', nativeSessionId: id, watching: true, status: 'watching' } });
const busy = (id: string, start: number) => Array.from({ length: 450 }, (_, i) => event(id, start + i, { type: 'agent.state', state: 'working' }, 'sibling'));

describe('quiet Office sibling liveness retention', () => {
  it.each<EventBody>([
    { type: 'approval.resolved', approvalId: 'approval', decision: 'granted', by: 'user' },
    { type: 'tool.completed', tool: 'question', kind: 'tool', label: 'Answered', ok: true },
    { type: 'turn.completed' },
  ])('does not retain a superseded wait after $type and repeated truncation', completion => {
    const managed = { ...session('a'), control: 'managed' as const, running: true };
    let history = retainOfficeEvents([event('a', 1, { type: 'agent.state', state: 'waiting', phase: completion.type === 'approval.resolved' ? 'approval' : 'input' }),
      ...(completion.type === 'approval.resolved' ? [event('a', 2, { type: 'approval.requested', approvalId: 'approval', action: 'Proceed' })] : []), ...busy('a', 3)]);
    history = retainOfficeEvents([...history, event('a', 500, completion), ...busy('a', 501)]);
    history = retainOfficeEvents([...history, ...busy('a', 1_000)]);
    const agents = projectOfficePresence([managed], history, 1_500_000);
    expect(agents[0]?.status).not.toBe('waiting');
    expect(history.some(value => value.body.type === 'agent.state' && value.body.state === 'waiting')).toBe(false);
    expect(cameraAttentionIds(agents, history, [])).toEqual([]);
  });

  it('keeps each session/agent report and paired tool phase without refreshing its source timestamp', () => {
    const initial = ['a', 'b'].flatMap(id => [event(id, 1, { type: 'subagent.spawned', subagentId: 'quiet', label: 'Quiet' }),
      event(id, 2, { type: 'agent.state', state: 'working', activity: 'command', phase: 'planning' }, 'quiet'),
      { ...event(id, 3, { type: 'tool.started', tool: 'shell', kind: 'command', label: 'Long command' }, 'quiet'), at: new Date(2_000).toISOString() }]);
    let history = retainOfficeEvents([...initial, ...busy('a', 4), ...busy('b', 4)]);
    history = retainOfficeEvents([...history, ...busy('a', 500), ...busy('b', 500)]);
    for (const id of ['a', 'b']) {
      const quiet = projectOfficePresence([session(id)], history, 1_000_000).find(agent => agent.agentId === 'quiet');
      expect(quiet).toMatchObject({ status: 'working', activity: 'command', phase: 'planning', lastActivityAt: new Date(2_000).toISOString() });
    }
  });

  it.each<EventBody>([{ type: 'agent.stopped' }, { type: 'agent.state', state: 'offline' }, { type: 'turn.completed' }, { type: 'turn.failed', error: 'failed' }, { type: 'session.ended' }])('keeps terminal evidence for $type through repeated sibling floods', terminal => {
    const id = 'a';
    let history = retainOfficeEvents([event(id, 1, { type: 'subagent.spawned', subagentId: 'quiet' }),
      event(id, 2, { type: 'agent.state', state: 'working' }, 'quiet'), event(id, 3, terminal, 'quiet'), ...busy(id, 4)]);
    history = retainOfficeEvents([...history, ...busy(id, 500)]);
    const now = 1_000_000 + subagentLingerMs('a:quiet');
    const quiet = projectOfficePresence([session(id)], history, now).find(agent => agent.agentId === 'quiet');
    expect(quiet?.status).not.toBe('working');
    expect(quiet?.status).toBe('offline');
    if (terminal.type === 'turn.failed') {
      const failed = projectOfficePresence([session(id)], history, 10_000).find(agent => agent.agentId === 'quiet');
      expect(failed).toMatchObject({ status: 'idle', phase: 'error', lastActivityAt: new Date(3_000).toISOString() });
    }
  });

  it('retains an explicit restart after stop without reviving an ended session', () => {
    const id = 'a';
    const initial = [event(id, 1, { type: 'subagent.spawned', subagentId: 'quiet' }), event(id, 2, { type: 'agent.stopped' }, 'quiet'),
      event(id, 3, { type: 'agent.state', state: 'working' }, 'quiet')];
    let history = retainOfficeEvents([...initial, ...busy(id, 4)]);
    expect(projectOfficePresence([session(id)], history, 500_000).find(agent => agent.agentId === 'quiet')?.status).toBe('working');
    history = retainOfficeEvents([...history, event(id, 500, { type: 'session.ended' }), ...busy(id, 501)]);
    expect(projectOfficePresence([session(id)], history, 1_000_000).find(agent => agent.agentId === 'quiet')?.status).toBe('offline');
  });

  it('still ages quiet work from its own report while newer sibling traffic arrives', () => {
    const initial = [event('a', 1, { type: 'subagent.spawned', subagentId: 'quiet' }),
      event('a', 2, { type: 'agent.state', state: 'working' }, 'quiet')];
    const history = retainOfficeEvents([...initial, ...busy('a', 100_000)]);
    const quiet = projectOfficePresence([session('a')], history, 100_500_000).find(agent => agent.agentId === 'quiet');
    expect(quiet).toMatchObject({ status: 'offline', lastActivityAt: new Date(2_000).toISOString() });
  });

  it('bounds historical actors and retains closing evidence for every retained identity', () => {
    let history: ExtaliaEvent[] = [];
    for (let batch = 0; batch < 5; batch++) {
      const actors = Array.from({ length: 600 }, (_, index) => {
        const agentId = `worker-${batch}-${index}`, seq = batch * 3_000 + index * 3 + 1;
        return [event('a', seq, { type: 'subagent.spawned', subagentId: agentId }),
          event('a', seq + 1, { type: 'agent.state', state: 'working' }, agentId),
          event('a', seq + 2, { type: 'agent.stopped' }, agentId)];
      }).flat();
      history = retainOfficeEvents([...history, ...actors]);
      expect(history.length).toBeLessThanOrEqual(1_200);
      const retainedWorkers = projectOfficePresence([session('a')], history, 100_000_000).filter(agent => agent.agentId !== 'primary');
      expect(retainedWorkers.length).toBeGreaterThan(0);
      expect(retainedWorkers.every(agent => agent.status === 'offline')).toBe(true);
    }
  });
});
