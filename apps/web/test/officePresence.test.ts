import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@extalia/platform';
import { createEvent, type EventBody, type ExtaliaEvent } from '@extalia/protocol';
import { projectOfficePresence } from '../src/office/presence';

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id, workspaceId: 'ws', connectionId: 'connection', title: id, control: 'managed',
    createdAt: '2026-10-09T00:00:00.000Z', lastActiveAt: '2026-10-09T00:00:00.000Z',
    running: false, ...overrides,
  };
}

function event(sessionId: string, n: number, body: EventBody, agentId = 'primary', channel: 'stream' | 'transcript' = 'stream'): ExtaliaEvent {
  return createEvent({ id: `${sessionId}-${n}`, at: `2026-10-09T00:00:0${n}.000Z`, seq: n, sessionId, agentId,
    source: { runtime: 'test', channel }, body });
}

describe('projectOfficePresence', () => {
  it('projects managed prompt, approval, and terminal transitions using host running state', () => {
    const events = [
      event('s1', 1, { type: 'prompt.submitted', text: 'go', via: 'extalia' }),
      event('s1', 2, { type: 'agent.state', state: 'working', activity: 'test', summary: 'Running tests' }),
      event('s1', 3, { type: 'approval.requested', approvalId: 'a1', action: 'Run command' }),
    ];
    const [waiting] = projectOfficePresence([session('s1', { running: true })], events);
    expect(waiting).toMatchObject({ status: 'waiting', running: true, pendingApprovalId: 'a1', activity: 'test', summary: 'Running tests' });

    const [done] = projectOfficePresence([session('s1', { running: false })], [
      ...events, event('s1', 4, { type: 'approval.resolved', approvalId: 'a1', decision: 'granted', by: 'user' }),
      event('s1', 5, { type: 'turn.completed' }),
    ]);
    expect(done).toMatchObject({ status: 'idle', running: false });
    expect(done?.pendingApprovalId).toBeUndefined();

    const [ended] = projectOfficePresence([session('s1', { running: true })], [...events, event('s1', 4, { type: 'session.ended' })]);
    expect(ended).toMatchObject({ status: 'offline', running: false });
  });

  it('shows observation availability and never claims a transcript is running', () => {
    const observed = session('obs', { control: 'observed', running: true, pendingApprovalId: 'native-approval',
      observation: { sourceId: 'codex', nativeSessionId: 'native-1', watching: true, status: 'watching' } });
    // The events are far in the past relative to `now`: a replayed history, not live work.
    const [agent] = projectOfficePresence([observed], [
      event('obs', 1, { type: 'prompt.submitted', text: 'historic prompt', via: 'native' }, 'primary', 'transcript'),
      event('obs', 2, { type: 'agent.state', state: 'working' }, 'primary', 'transcript'),
    ], Date.parse('2026-10-11T00:00:00.000Z'));
    expect(agent).toMatchObject({ control: 'observed', status: 'idle', running: false, live: false, observation: { status: 'watching' } });
    expect(agent?.pendingApprovalId).toBeUndefined();

    const [quiet] = projectOfficePresence([observed], [], Date.parse('2026-10-11T00:00:00.000Z'));
    expect(quiet).toMatchObject({ status: 'observing', running: false });

    const [paused] = projectOfficePresence([{ ...observed, observation: { ...observed.observation!, watching: false, status: 'paused' } }], []);
    expect(paused?.status).toBe('paused');
    const [unavailable] = projectOfficePresence([{ ...observed, observation: { ...observed.observation!, status: 'unavailable', error: 'gone' } }], [
      event('obs', 1, { type: 'agent.state', state: 'working' }, 'primary', 'transcript'),
    ], Date.parse('2026-10-09T00:00:01.000Z'));
    expect(unavailable).toMatchObject({ status: 'unavailable', running: false });
  });

  describe('observed sessions with structured activity', () => {
    const observed = session('obs', { control: 'observed', title: 'Outside', observation: { sourceId: 'codex', nativeSessionId: 'native-1', watching: true, status: 'watching' } });
    const base = Date.parse('2026-10-09T00:00:00.000Z');
    const at = (seconds: number) => base + seconds * 1000;
    const stamped = (n: number, seconds: number, body: EventBody, channel: 'transcript' | 'import' | 'hook' = 'transcript') =>
      createEvent({ id: `obs-${n}`, at: new Date(at(seconds)).toISOString(), seq: n, sessionId: 'obs', agentId: 'primary', source: { runtime: 'codex', channel }, body });

    it('shows a recently active outside agent as working with its activity and target, read-only', () => {
      const [agent] = projectOfficePresence([observed], [
        stamped(1, 0, { type: 'prompt.submitted', text: 'refactor', via: 'native' }),
        stamped(2, 10, { type: 'tool.started', tool: 'apply_patch', kind: 'edit', label: 'Edit src/a.ts', target: 'src/a.ts' }),
      ], at(30));
      expect(agent).toMatchObject({ control: 'observed', status: 'working', running: true, live: true, activity: 'edit', target: 'src/a.ts', summary: 'Edit src/a.ts' });
      expect(agent?.pendingApprovalId).toBeUndefined();
      expect(agent?.lastActivityAt).toBe(new Date(at(10)).toISOString());
    });

    it('follows agent.state and returns to idle when the turn completes', () => {
      const thinking = projectOfficePresence([observed], [stamped(1, 0, { type: 'agent.state', state: 'thinking' })], at(5))[0];
      expect(thinking).toMatchObject({ status: 'thinking', running: true });
      const finished = projectOfficePresence([observed], [
        stamped(1, 0, { type: 'tool.started', tool: 'shell', kind: 'test', label: 'Run tests', target: 'pnpm test' }),
        stamped(2, 5, { type: 'tool.completed', tool: 'shell', kind: 'test', label: 'Run tests', ok: true }),
        stamped(3, 6, { type: 'turn.completed' }),
      ], at(10))[0];
      expect(finished).toMatchObject({ status: 'idle', running: false, live: true });
      expect(finished?.activity).toBeUndefined();
      expect(finished?.target).toBeUndefined();
    });

    it('is live for two minutes, keeps the reported state (stalled after its allowance) until thirty minutes, then shows idle', () => {
      const events = [stamped(1, 0, { type: 'tool.started', tool: 'shell', kind: 'command', label: 'Run build' })];
      expect(projectOfficePresence([observed], events, at(119))[0]).toMatchObject({ status: 'working', running: true, live: true });
      expect(projectOfficePresence([observed], events, at(121))[0]).toMatchObject({ status: 'working', running: false, live: false });
      // v0.0.40: a command may run 15 minutes without a word; then it stops responding; after 30 minutes it is gone.
      expect(projectOfficePresence([observed], events, at(601))[0]).toMatchObject({ status: 'working', running: false, live: false });
      expect(projectOfficePresence([observed], events, at(601))[0]?.stalled).toBeUndefined();
      expect(projectOfficePresence([observed], events, at(901))[0]).toMatchObject({ status: 'working', stalled: true, running: false, live: false, lastActivityAt: new Date(at(0)).toISOString() });
      const recovered = projectOfficePresence([observed], [...events, stamped(2, 902, { type: 'turn.completed' })], at(903))[0];
      expect(recovered).toMatchObject({ status: 'idle', running: false, live: true, lastActivityAt: new Date(at(902)).toISOString() });
      expect(recovered?.stalled).toBeUndefined();
      expect(projectOfficePresence([observed], events, at(1801))[0]).toMatchObject({ status: 'idle', running: false, live: false });
      expect(projectOfficePresence([observed], events, at(1801))[0]?.stalled).toBeUndefined();
    });

    it('ignores import-channel history and still accepts hook events', () => {
      expect(projectOfficePresence([observed], [stamped(1, 0, { type: 'agent.state', state: 'working' }, 'import')], at(1))[0]).toMatchObject({ status: 'observing', running: false });
      expect(projectOfficePresence([observed], [stamped(1, 0, { type: 'agent.state', state: 'working', activity: 'search' }, 'hook')], at(1))[0]).toMatchObject({ status: 'working', running: true, activity: 'search' });
    });

    it('keeps paused and unavailable observations regardless of fresh events', () => {
      const fresh = [stamped(1, 0, { type: 'agent.state', state: 'working' })];
      const paused = { ...observed, observation: { ...observed.observation!, watching: false, status: 'paused' as const } };
      expect(projectOfficePresence([paused], fresh, at(1))[0]).toMatchObject({ status: 'paused', running: false });
    });
  });

  it('scopes repeated agent ids by session and adds reported subagents', () => {
    const sessions = [session('one', { title: 'First', running: true }), session('two', { title: 'Second', running: true })];
    const presences = projectOfficePresence(sessions, [
      event('one', 1, { type: 'agent.state', state: 'thinking' }),
      event('one', 2, { type: 'subagent.spawned', subagentId: 'worker', label: 'QA worker', role: 'qa' }),
      event('one', 3, { type: 'subagent.state', subagentId: 'worker', state: 'working', summary: 'Checking' }, 'primary'),
      event('two', 1, { type: 'agent.state', state: 'working' }),
    ]);
    expect(presences.map(agent => agent.id)).toEqual(['one:primary', 'one:worker', 'two:primary']);
    expect(presences).toMatchObject([
      { displayName: 'First', status: 'thinking' },
      { displayName: 'QA worker', status: 'working', summary: 'Checking', parentId: 'one:primary' },
      { displayName: 'Second', status: 'working' },
    ]);
  });
});

describe('explicit Office meetings', () => {
  const start = { type: 'meeting.started', meetingId: 'review', participants: ['primary', 'member'], topic: 'Design review' } as const;
  const spawned = event('s', 1, { type: 'subagent.spawned', subagentId: 'member', label: 'Member' });
  const started = event('s', 2, { ...start, participants: [...start.participants] });
  it('scopes membership to the exact session and keeps participants through stopped round workers', () => {
    const events = [spawned, started, event('s', 3, { type: 'agent.stopped' }, 'member'),
      event('s', 4, { type: 'meeting.contribution', meetingId: 'review', round: 2, text: 'Agreed' }, 'member')];
    const projected = projectOfficePresence([session('s', { running: true }), session('foreign')], events);
    expect(projected.filter(agent => agent.meeting).map(agent => agent.id)).toEqual(['s:primary', 's:member']);
    expect(projected.find(agent => agent.id === 's:member')).toMatchObject({ status: 'working', meeting: { topic: 'Design review', round: 2, speakerId: 'member' } });
    expect(projectOfficePresence([session('s', { running: true }), session('foreign')], events.slice().reverse())).toEqual(projected);
  });
  it('releases membership on every outcome, session end, failure and user cancellation', () => {
    for (const terminal of [
      { type: 'meeting.completed', meetingId: 'review', outcome: 'completed' },
      { type: 'meeting.completed', meetingId: 'review', outcome: 'cancelled' },
      { type: 'meeting.completed', meetingId: 'review', outcome: 'failed' },
      { type: 'session.ended' }, { type: 'turn.failed', error: 'Failed' },
      { type: 'user.intervention', action: 'cancel' },
    ] as EventBody[]) {
      const projected = projectOfficePresence([session('s', { running: true })], [spawned, started, event('s', 3, terminal)]);
      expect(projected.every(agent => !agent.meeting)).toBe(true);
    }
  });
  it('ignores unknown participants, duplicate membership, overflow, and work text mentioning meetings', () => {
    for (const participants of [['primary', 'missing'], ['primary', 'primary'], Array.from({ length: 15 }, (_, i) => `a${i}`)]) {
      const projected = projectOfficePresence([session('s')], [spawned, event('s', 2, { ...start, participants })]);
      expect(projected.every(agent => !agent.meeting)).toBe(true);
    }
    const projected = projectOfficePresence([session('s')], [event('s', 1, { type: 'agent.state', state: 'working', summary: 'meeting discussion', activity: 'delegate' })]);
    expect(projected[0]?.meeting).toBeUndefined();
  });
  it('ignores foreign contributors and never revives a completed meeting from a duplicate start', () => {
    const projected = projectOfficePresence([session('s')], [spawned, started,
      event('s', 3, { type: 'meeting.contribution', meetingId: 'review', round: 1, text: 'No membership' }, 'unknown'),
      event('s', 4, { type: 'meeting.completed', meetingId: 'review' }), event('s', 5, { ...start, participants: [...start.participants] })]);
    expect(projected.every(agent => !agent.meeting)).toBe(true);
    expect(projected.some(agent => agent.agentId === 'unknown')).toBe(false);
  });
});
