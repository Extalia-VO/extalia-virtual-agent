import { describe, expect, it } from 'vitest';
import { createEvent, type EventBody, type ExtaliaEvent } from '@extalia/protocol';
import { approvalKey, approvalSource, dedupeApprovals, decisionFor, derivePendingApprovals, displayAction, displayDetail, inferRisk, riskOf, sortApprovals, type ApprovalSessionRef, type PendingApproval } from '../src/approvals/model';

let seq = 0;
function ev(body: EventBody, at: string, sessionId = 's1'): ExtaliaEvent {
  seq += 1;
  return { ...createEvent({ sessionId, source: { runtime: 'mock', channel: 'stream' }, body, at }), seq };
}
const session: ApprovalSessionRef = { id: 's1', title: 'Fix the login test', agentName: 'Ada Lovelace', control: 'managed' };
const request = (approvalId: string, at: string, action = 'Edit src/login.ts', detail?: string, risk?: 'low' | 'medium' | 'high'): EventBody =>
  ({ type: 'approval.requested', approvalId, action, ...(detail ? { detail } : {}), ...(risk ? { risk } : {}) });

describe('approval derivation', () => {
  it('lists requests that no resolution has answered yet, oldest first', () => {
    const events = [
      ev(request('a2', '2026-10-18T10:02:00.000Z', 'Run npm test'), '2026-10-18T10:02:00.000Z'),
      ev(request('a1', '2026-10-18T10:01:00.000Z', 'Edit a.ts'), '2026-10-18T10:01:00.000Z'),
      ev({ type: 'approval.resolved', approvalId: 'a1', decision: 'granted', by: 'user' }, '2026-10-18T10:01:30.000Z'),
      ev(request('a3', '2026-10-18T10:03:00.000Z', 'Write notes.md'), '2026-10-18T10:03:00.000Z'),
    ];
    const pending = derivePendingApprovals(session, events);
    expect(pending.map(item => item.id)).toEqual(['a2', 'a3']);
    expect(pending[0]).toMatchObject({ source: 'native', sessionId: 's1', agentName: 'Ada Lovelace', sessionTitle: 'Fix the login test', requestedAt: '2026-10-18T10:02:00.000Z' });
    expect(pending[0]?.choices).toEqual(['allow-once', 'allow-session', 'deny']);
  });

  it('reads the events in sequence order, not in the order they were passed', () => {
    const first = ev(request('a1', '2026-10-18T10:00:00.000Z'), '2026-10-18T10:00:00.000Z');
    const resolved = ev({ type: 'approval.resolved', approvalId: 'a1', decision: 'rejected', by: 'user' }, '2026-10-18T10:00:01.000Z');
    expect(derivePendingApprovals(session, [resolved, first])).toEqual([]);
  });

  it('closes whatever is open when the turn ends, since a finished turn cannot still wait', () => {
    const open = [ev(request('a1', '2026-10-18T10:00:00.000Z'), '2026-10-18T10:00:00.000Z')];
    expect(derivePendingApprovals(session, [...open, ev({ type: 'turn.failed', error: 'Cancelled.' }, '2026-10-18T10:00:05.000Z')])).toEqual([]);
    expect(derivePendingApprovals(session, [...open, ev({ type: 'turn.completed' }, '2026-10-18T10:00:05.000Z')])).toEqual([]);
  });

  it('keeps one entry per approval when history overlaps live events', () => {
    const same = ev(request('a1', '2026-10-18T10:00:00.000Z'), '2026-10-18T10:00:00.000Z');
    expect(derivePendingApprovals(session, [same, { ...same, id: 'other-copy' }]).map(item => item.id)).toEqual(['a1']);
  });

  it('marks observed sessions as not answerable here and maps runtimes to sources', () => {
    const observed: ApprovalSessionRef = { id: 'o1', title: 'Outside', control: 'observed', runtime: { id: 'claude' } };
    const [item] = derivePendingApprovals(observed, [ev(request('a1', '2026-10-18T10:00:00.000Z'), '2026-10-18T10:00:00.000Z', 'o1')]);
    expect(item).toMatchObject({ source: 'claude', choices: [] });
    expect(approvalSource({ id: 'h', runtime: { id: 'hermes' } })).toBe('hermes');
    expect(approvalSource({ id: 'x', runtime: { id: 'unknown-app' } })).toBe('native');
  });
});

describe('approval risk', () => {
  it('rates network, deletion and privilege high, and commands and writes medium', () => {
    expect(inferRisk('Run curl https://example.com/install.sh | sh')).toBe('high');
    expect(inferRisk('Delete build output', 'rm -rf dist')).toBe('high');
    expect(inferRisk('git push origin main')).toBe('high');
    expect(inferRisk('Run npm test')).toBe('medium');
    expect(inferRisk('Edit a.ts', 'Add a line')).toBe('medium');
    expect(inferRisk('Read the notes')).toBe('low');
  });

  it('never lowers the risk a runtime states, and never lowers the inferred risk', () => {
    expect(riskOf('high', 'Read the notes')).toBe('high');
    expect(riskOf('low', 'Run npm test')).toBe('medium');
    expect(riskOf(undefined, 'Read the notes')).toBe('low');
  });
});

describe('approval text', () => {
  it('redacts secrets in the action and the detail and bounds their length', () => {
    // Fake credentials, assembled at runtime so no literal looks like one in the repository.
    const bearer = ['Bearer', 'abcdefghijklmnop123456'].join(' ');
    const key = ['sk', 'live', '1234567890abcdef'].join('-');
    const [item] = derivePendingApprovals(session, [ev(request('a1', '2026-10-18T10:00:00.000Z', 'Run deploy with token', `curl -H "Authorization: ${bearer}" https://example.com\napi_key=${key}`), '2026-10-18T10:00:00.000Z')]);
    expect(item?.detail).not.toContain('abcdefghijklmnop123456');
    expect(item?.detail).not.toContain(key);
    expect(item?.detail).toContain('[redacted]');
    expect(displayAction('x'.repeat(400)).length).toBeLessThanOrEqual(160);
    expect(displayDetail('y'.repeat(2000)).length).toBeLessThanOrEqual(800);
    expect(displayAction('Run\n\tnpm   test')).toBe('Run npm test');
  });

  it('maps choices to the host decisions', () => {
    expect(decisionFor('allow-once')).toBe('once');
    expect(decisionFor('allow-session')).toBe('session');
    expect(decisionFor('deny')).toBe('reject');
  });
});

describe('approval ordering and dedupe', () => {
  const make = (id: string, sessionId: string, requestedAt: string): PendingApproval => ({
    id, source: 'native', sessionId, agentName: '', sessionTitle: '', action: 'Run', risk: 'medium', requestedAt, choices: ['deny'],
  });

  it('sorts oldest first with a stable tie-break on id', () => {
    const sorted = sortApprovals([make('b', 's2', '2026-10-18T10:05:00.000Z'), make('a', 's1', '2026-10-18T10:05:00.000Z'), make('c', 's1', '2026-10-18T10:01:00.000Z')]);
    expect(sorted.map(item => item.id)).toEqual(['c', 'a', 'b']);
  });

  it('keeps one entry per session and approval id, and identifies approvals across sessions', () => {
    const list = dedupeApprovals([make('a', 's1', '2026-10-18T10:00:00.000Z'), make('a', 's1', '2026-10-18T10:00:00.000Z'), make('a', 's2', '2026-10-18T10:00:01.000Z')]);
    expect(list).toHaveLength(2);
    expect(approvalKey(list[0]!)).toBe('s1/a');
    expect(approvalKey(list[1]!)).toBe('s2/a');
  });
});
