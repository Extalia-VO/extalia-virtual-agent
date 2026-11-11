import { describe, expect, it } from 'vitest';
import type { EventBody, ExtaliaEvent } from '@extalia/protocol';
import { cameraAttentionIds } from '../src/office/cameraAttention';
import type { OfficeAgent } from '../src/office/presence';

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 15, 10, 0, seconds)).toISOString();
const agent = (sessionId = 's1', agentId = 'primary', extra: Partial<OfficeAgent> = {}): OfficeAgent => ({
  id: `${sessionId}:${agentId}`, sessionId, agentId, displayName: 'Agent', control: 'managed', status: 'waiting', running: true, ...extra,
});
const event = (seq: number, body: EventBody, extra: Partial<ExtaliaEvent> = {}): ExtaliaEvent => ({
  v: 'extalia.v0', id: `event-${seq}`, sessionId: 's1', seq, at: at(seq), source: { runtime: 'example', channel: 'stream' }, body, ...extra,
});
const request = (seq: number, approvalId: string, extra: Partial<ExtaliaEvent> = {}) => event(seq, { type: 'approval.requested', approvalId, action: 'Run a command' }, extra);
const resolve = (seq: number, approvalId: string, extra: Partial<ExtaliaEvent> = {}) => event(seq, { type: 'approval.resolved', approvalId, decision: 'granted', by: 'user' }, extra);
const wait = (seq: number, phase: 'input' | 'approval' = 'input', extra: Partial<ExtaliaEvent> = {}) => event(seq, { type: 'agent.state', state: 'waiting', phase }, extra);

describe('camera attention requests', () => {
  it('orders simultaneous agents by oldest request and returns each character once', () => {
    const agents = [agent('s1', 'primary'), agent('s1', 'worker'), agent('s2')];
    const events = [request(3, 'c', { agentId: 'worker' }), request(2, 'b'), request(1, 'a', { sessionId: 's2' }), request(4, 'd')];
    expect(cameraAttentionIds(agents, events, [])).toEqual(['s2:primary', 's1:primary', 's1:worker']);
  });

  it('holds multiple requests on their original character until each named request resolves', () => {
    const agents = [agent(), agent('s1', 'worker')];
    const events = [request(1, 'a', { agentId: 'worker' }), request(2, 'b', { agentId: 'worker' }), resolve(3, 'a'), event(4, { type: 'turn.completed' }), event(5, { type: 'agent.state', state: 'working' }, { agentId: 'worker' })];
    expect(cameraAttentionIds(agents, events, [])).toEqual(['s1:worker']);
    expect(cameraAttentionIds(agents, [...events, resolve(6, 'b')], [])).toEqual([]);
  });

  it('keeps approval ids and replay event ids scoped to their session', () => {
    const events = [request(1, 'same'), request(1, 'same', { sessionId: 's2' }), resolve(2, 'same')];
    expect(cameraAttentionIds([agent(), agent('s2')], events, [])).toEqual(['s2:primary']);
  });

  it('replays sequence order even when arrays and event timestamps disagree', () => {
    const requested = request(1, 'a', { at: at(30) });
    const resolved = resolve(2, 'a', { at: at(1) });
    expect(cameraAttentionIds([agent()], [resolved, requested, requested], [])).toEqual([]);
  });

  it('deduplicates replayed request deliveries without moving ownership or age', () => {
    const events = [request(1, 'a', { agentId: 'worker' }), request(2, 'a'), request(3, 'b')];
    expect(cameraAttentionIds([agent(), agent('s1', 'worker')], events, [])).toEqual(['s1:worker', 's1:primary']);
  });

  it('uses deterministic timestamp and character ordering across sessions without sequence numbers', () => {
    const events = [request(1, 'b', { sessionId: 's2', seq: undefined }), request(1, 'a', { seq: undefined })];
    const agents = [agent('s2'), agent()];
    expect(cameraAttentionIds(agents, events, [])).toEqual(['s1:primary', 's2:primary']);
    expect(cameraAttentionIds([...agents].reverse(), [...events].reverse(), [])).toEqual(['s1:primary', 's2:primary']);
  });

  it('uses current managed approvals and summary fallback when history has not loaded', () => {
    const agents = [agent('s2', 'primary', { pendingApprovalId: 'summary-only' }), agent()];
    expect(cameraAttentionIds(agents, [], [{ id: 'a', sessionId: 's1', requestedAt: at(2) }])).toEqual(['s1:primary', 's2:primary']);
  });

  it('does not resurrect resolved approvals from a stale inbox or presence summary', () => {
    expect(cameraAttentionIds([agent('s1', 'primary', { pendingApprovalId: 'a', phase: 'approval' })], [request(1, 'a'), resolve(2, 'a')], [{ id: 'a', sessionId: 's1', requestedAt: at(1) }])).toEqual([]);
  });

  it('ends identified approvals with their session without affecting another session', () => {
    expect(cameraAttentionIds([agent(), agent('s2')], [request(1, 'a'), request(1, 'a', { sessionId: 's2' }), event(2, { type: 'session.ended' })], [])).toEqual(['s2:primary']);
  });

  it('does not fabricate external approvals from inbox or summary fallback', () => {
    const observed = agent('s1', 'primary', { control: 'observed', pendingApprovalId: 'a' });
    expect(cameraAttentionIds([observed], [], [{ id: 'a', sessionId: 's1', requestedAt: at(1) }])).toEqual([]);
    expect(cameraAttentionIds([observed], [request(1, 'a')], [])).toEqual(['s1:primary']);
  });

  it('excludes characters outside the active Office even with outstanding requests', () => {
    const agents = [agent('offline', 'primary', { status: 'offline' }), agent('earlier', 'primary', { earlier: true }), agent('unavailable', 'primary', { status: 'unavailable' }), agent('paused', 'primary', { observation: { status: 'paused' } })];
    expect(cameraAttentionIds(agents, agents.map((item, index) => request(index + 1, 'a', { sessionId: item.sessionId })), [])).toEqual([]);
  });
});

describe('camera attention from explicit waiting phases', () => {
  it('accepts input and approval waits for observed apps without creating an approval record', () => {
    const observed = [agent('s1', 'primary', { control: 'observed' }), agent('s1', 'worker', { control: 'observed' })];
    expect(cameraAttentionIds(observed, [wait(1), event(2, { type: 'subagent.state', subagentId: 'worker', state: 'waiting', phase: 'approval' })], [])).toEqual(['s1:primary', 's1:worker']);
  });

  it('uses a stated current presence phase when event history is unavailable', () => {
    expect(cameraAttentionIds([agent('s1', 'primary', { phase: 'input' })], [], [])).toEqual(['s1:primary']);
  });

  it.each<EventBody>([
    { type: 'agent.state', state: 'thinking' },
    { type: 'prompt.submitted', text: 'Answer', via: 'native' },
    { type: 'tool.completed', tool: 'question', kind: 'tool', label: 'Question', ok: true },
    { type: 'turn.completed' },
    { type: 'session.ended' },
  ])('clears a stale phase after $type', body => {
    expect(cameraAttentionIds([agent('s1', 'primary', { phase: 'input' })], [event(2, body), wait(1)], [])).toEqual([]);
  });

  it('retains a question tool wait across its paired tool.started, then clears on its completion', () => {
    const events = [event(1, { type: 'agent.state', state: 'waiting', phase: 'input', activity: 'tool' }), event(2, { type: 'tool.started', tool: 'question', kind: 'tool', label: 'Question' }, { at: at(1) })];
    expect(cameraAttentionIds([agent()], events, [])).toEqual(['s1:primary']);
    expect(cameraAttentionIds([agent()], [...events, event(3, { type: 'tool.completed', tool: 'question', kind: 'tool', label: 'Question', ok: true })], [])).toEqual([]);
  });

  it('ignores generic waiting, idle prompts, completed answers, and imported history', () => {
    expect(cameraAttentionIds([agent()], [event(1, { type: 'agent.state', state: 'waiting' })], [])).toEqual([]);
    expect(cameraAttentionIds([agent('s1', 'primary', { status: 'idle', phase: 'input' })], [event(1, { type: 'agent.state', state: 'idle', phase: 'input' }), event(2, { type: 'model.completed', text: 'Please answer when ready.' })], [])).toEqual([]);
    expect(cameraAttentionIds([agent()], [wait(1, 'input', { source: { runtime: 'example', channel: 'import' } }), request(2, 'a', { source: { runtime: 'example', channel: 'import' } })], [])).toEqual([]);
  });
});

it('keeps observed async input in attention while work continues, without inventing a waiting state', () => {
  const visible = agent('outside', 'primary', { control: 'observed', status: 'working' });
  const input = { sessionId: 'outside', id: 'question', requestedAt: at(1) };
  expect(cameraAttentionIds([visible], [], [], [input])).toEqual(['outside:primary']);
  expect(visible.status).toBe('working');
  expect(cameraAttentionIds([visible], [], [], [])).toEqual([]);
});
it('routes input attention only to the matching admitted observed character', () => {
  const inputs = [{ sessionId: 'outside', id: 'question', requestedAt: at(1) }, { sessionId: 'missing', id: 'foreign', requestedAt: at(0) }];
  for (const visible of [agent('outside'), agent('outside', 'primary', { control: 'observed', earlier: true }), agent('outside', 'primary', { control: 'observed', status: 'paused' })]) {
    expect(cameraAttentionIds([visible], [], [], inputs)).toEqual([]);
  }
});
