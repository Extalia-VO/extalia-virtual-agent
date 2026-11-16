import type { SessionSummary } from '@extalia/platform';
import { createEvent, type EventBody } from '@extalia/protocol';
import { expect, it } from 'vitest';
import { cameraAttentionIds } from '../src/office/cameraAttention';
import { projectOfficePresence, type OfficeAgent } from '../src/office/presence';

const at = '2030-01-01T00:00:00.000Z';
const session: SessionSummary = {
  id: 'session', workspaceId: '', connectionId: '', title: 'Example session',
  control: 'observed', running: false, createdAt: at, lastActiveAt: at,
  observation: { sourceId: 'codex', nativeSessionId: 'native', watching: true, status: 'watching', channel: 'hook' },
};
const hook = (counter: number, body: EventBody) => createEvent({
  id: `hook-session-${counter}-0`, at, sessionId: session.id, agentId: 'primary',
  source: { runtime: 'codex', channel: 'hook', adapter: 'native-hooks' }, body,
});

it('preserves hook arrival order through a decimal counter rollover at the same timestamp', () => {
  const events = [
    hook(8, { type: 'session.ended' }),
    hook(9, { type: 'agent.state', state: 'offline' }),
    hook(10, { type: 'session.started', control: 'observed' }),
    hook(11, { type: 'agent.state', state: 'working', activity: 'read' }),
  ];
  const [agent] = projectOfficePresence([session], events, Date.parse(at) + 1000);
  expect(agent).toMatchObject({ status: 'working', running: true, live: true });
  expect(agent?.earlier).toBeUndefined();
});

it('does not replay a resolved approval because opaque event IDs sort before its request', () => {
  const agent: OfficeAgent = { id: 'session:primary', sessionId: 'session', agentId: 'primary',
    displayName: 'Example agent', status: 'waiting', phase: 'approval', control: 'observed', running: false };
  const events = [
    hook(9, { type: 'approval.requested', approvalId: 'approval', action: 'Read file' }),
    hook(10, { type: 'approval.resolved', approvalId: 'approval', decision: 'granted', by: 'user' }),
  ];
  expect(cameraAttentionIds([agent], events, [])).toEqual([]);
});

it('retires an input wait when a same-timestamp completion crosses the hook counter rollover', () => {
  const agent: OfficeAgent = { id: 'session:primary', sessionId: 'session', agentId: 'primary',
    displayName: 'Example agent', status: 'waiting', phase: 'input', control: 'observed', running: false };
  const events = [
    hook(9, { type: 'agent.state', state: 'waiting', phase: 'input' }),
    hook(10, { type: 'tool.completed', tool: 'question', kind: 'tool', label: 'Question', ok: true }),
  ];
  expect(cameraAttentionIds([agent], events, [])).toEqual([]);
});

it('still uses explicit sequence numbers for out-of-order delivery', () => {
  const end = { ...hook(9, { type: 'session.ended' }), seq: 1 };
  const start = { ...hook(10, { type: 'session.started', control: 'observed' }), seq: 2 };
  const state = { ...hook(11, { type: 'agent.state', state: 'working' }), seq: 3 };
  const [agent] = projectOfficePresence([session], [state, start, end], Date.parse(at) + 1000);
  expect(agent).toMatchObject({ status: 'working', running: true });
  expect(agent?.earlier).toBeUndefined();
});
