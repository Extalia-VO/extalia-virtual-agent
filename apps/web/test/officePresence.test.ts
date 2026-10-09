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
    const [agent] = projectOfficePresence([observed], [
      event('obs', 1, { type: 'prompt.submitted', text: 'historic prompt', via: 'native' }, 'primary', 'transcript'),
      event('obs', 2, { type: 'agent.state', state: 'working' }, 'primary', 'transcript'),
    ]);
    expect(agent).toMatchObject({ control: 'observed', status: 'observing', running: false, observation: { status: 'watching' } });
    expect(agent?.pendingApprovalId).toBeUndefined();

    const [paused] = projectOfficePresence([{ ...observed, observation: { ...observed.observation!, watching: false, status: 'paused' } }], []);
    expect(paused?.status).toBe('paused');
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
