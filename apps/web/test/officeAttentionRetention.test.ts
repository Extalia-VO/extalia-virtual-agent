import { describe, expect, it } from 'vitest';
import { createEvent, type EventBody } from '@extalia/protocol';
import { retainOfficeEvents } from '../src/office/useOfficeEvents';
import { cameraAttentionIds } from '../src/office/cameraAttention';
import type { OfficeAgent } from '../src/office/presence';

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
