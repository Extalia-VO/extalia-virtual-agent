import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@extalia/platform';
import { createEvent, type EventBody, type ExtaliaEvent } from '@extalia/protocol';
import { retainOfficeEvents } from '../src/office/useOfficeEvents';
import { cameraAttentionIds } from '../src/office/cameraAttention';
import { allocateOfficeAgents } from '../src/office/scene/interior/seating';
import { projectOfficePresence, type OfficeAgent } from '../src/office/presence';

const make = (seq: number, body: EventBody, agentId = 'primary') => ({ ...createEvent({ sessionId: 'session', agentId, source: { runtime: 'example', channel: 'hook' }, body }), id: `event-${seq}`, seq, at: new Date(seq * 1000).toISOString() });
const busy = (start: number) => Array.from({ length: 450 }, (_, i) => make(start + i, { type: 'agent.state', state: 'working' }, 'sibling'));
const agent: OfficeAgent = { id: 'session:worker', sessionId: 'session', agentId: 'worker', displayName: 'Agent', status: 'waiting', control: 'observed', running: false };

describe('Office attention outside the recent activity window', () => {
  it('retains all outstanding requests without resurrecting resolved ones on later truncation', () => {
    let history = retainOfficeEvents([make(1, { type: 'approval.requested', approvalId: 'a', action: 'Run' }, 'worker'), ...busy(2)]);
    expect(cameraAttentionIds([agent], history, [])).toEqual([agent.id]);
    history = retainOfficeEvents([...history, make(500, { type: 'approval.resolved', approvalId: 'a', decision: 'granted', by: 'user' }), ...busy(501)]);
    history = retainOfficeEvents([...history, ...busy(1000)]);
    expect(cameraAttentionIds([agent], history, [])).toEqual([]);
  });
  it('retains an explicit input wait while a different agent floods events, then retires it', () => {
    let history = retainOfficeEvents([make(1, { type: 'agent.state', state: 'waiting', phase: 'input' }, 'worker'), ...busy(2)]);
    expect(cameraAttentionIds([agent], history, [])).toEqual([agent.id]);
    history = retainOfficeEvents([...history, make(500, { type: 'tool.completed', tool: 'question', kind: 'tool', label: 'Question', ok: true }, 'worker'), ...busy(501)]);
    expect(cameraAttentionIds([agent], history, [])).toEqual([]);
  });
});

describe('Office meeting retention reaches live presence projection', () => {
  const session: SessionSummary = { id: 'session', workspaceId: 'workspace', connectionId: 'connection', title: 'Fixture', control: 'managed', running: true,
    createdAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString() };
  const start = make(3, { type: 'meeting.started', meetingId: 'sync', participants: ['primary', 'member'], topic: 'Design review' });
  const initial = [make(1, { type: 'agent.created', name: 'Lead' }), make(2, { type: 'subagent.spawned', subagentId: 'member', label: 'Member' }), start];
  const project = (events: ExtaliaEvent[]) => projectOfficePresence([session], retainOfficeEvents(events), 1_000_000);
  it('retains explicit membership, participant identity and each latest round contribution past both windows', () => {
    const contribution = make(4, { type: 'meeting.contribution', meetingId: 'sync', round: 1, text: 'Proposal' }, 'member');
    // More than 200 unrelated identities must not evict an active meeting member.
    const identities = Array.from({ length: 250 }, (_, i) => make(5 + i, { type: 'subagent.spawned', subagentId: `other-${i}` }));
    let history = retainOfficeEvents([...initial, contribution, ...identities, ...busy(300)]);
    history = retainOfficeEvents([...history, make(800, { type: 'agent.stopped' }, 'member'),
      make(801, { type: 'meeting.contribution', meetingId: 'sync', round: 2, text: 'Agreement' }, 'member'), ...busy(802)]);
    history = retainOfficeEvents([...history, ...busy(1300)]);
    const members = project(history).filter(agent => agent.meeting);
    expect(members.map(agent => agent.id)).toEqual(['session:primary', 'session:member']);
    expect(members[1]).toMatchObject({ displayName: 'Member', status: 'working', meeting: { topic: 'Design review', round: 2, speakerId: 'member' } });
    expect(history.filter(event => event.body.type === 'meeting.contribution')).toHaveLength(2);
    expect(allocateOfficeAgents(members).every(seat => seat.resourceId.startsWith('meeting-a.seat-'))).toBe(true);
  });
  it('keeps meetings closed through repeated truncation after each terminal and a replayed duplicate start', () => {
    for (const terminal of [
      { type: 'meeting.completed', meetingId: 'sync', outcome: 'completed' },
      { type: 'meeting.completed', meetingId: 'sync', outcome: 'cancelled' },
      { type: 'meeting.completed', meetingId: 'sync', outcome: 'failed' },
      { type: 'session.ended' }, { type: 'turn.failed', error: 'Failure' }, { type: 'user.intervention', action: 'cancel' },
    ] as EventBody[]) {
      let history = retainOfficeEvents([...initial, ...busy(4)]);
      history = retainOfficeEvents([...history, make(500, terminal), ...busy(501), make(951, { type: 'subagent.spawned', subagentId: 'member', label: 'Member' }), { ...start, id: 'duplicate-start', seq: 952, at: new Date(952_000).toISOString() }]);
      expect(project(history).every(agent => !agent.meeting)).toBe(true);
      history = retainOfficeEvents([...history, ...busy(1000)]);
      history = retainOfficeEvents([...history, ...busy(1500)]);
      expect(project(history).every(agent => !agent.meeting)).toBe(true);
    }
  });
  it('keeps session end and observed restart evidence after the activity window', () => {
    const observed = { ...session, control: 'observed' as const };
    const history = retainOfficeEvents([make(1, { type: 'session.ended' }), ...busy(2)]);
    expect(projectOfficePresence([observed], history).every(agent => !agent.meeting)).toBe(true);
    const resumed = retainOfficeEvents([...history, make(500, { type: 'session.started', control: 'observed' }), ...busy(501)]);
    expect(resumed.some(event => event.body.type === 'session.started')).toBe(true);
  });
});
