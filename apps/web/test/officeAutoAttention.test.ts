import { describe, expect, it } from 'vitest';
import type { PendingApproval } from '../src/approvals/model';
import type { ObservedInputView } from '../src/observe/observedInputModel';
import { officeAttentionRequests } from '../src/office/OfficeAutoAttention';
const approval: PendingApproval = { id: 'approval', sessionId: 'native', source: 'native', agentName: 'Example agent', sessionTitle: 'Example task', action: 'Run command', risk: 'medium', requestedAt: '2026-01-01T00:00:00Z', choices: ['allow-once', 'deny'] };
function entry(patch: Partial<ObservedInputView['entries'][string]> = {}): ObservedInputView['entries'][string] {
  return { baselined: true, phase: 'ready', source: 'codex:example', requests: [{ id: 'question', revision: 'revision-1', origin: 'codex-native', state: 'pending', canAnswer: true, identityVerified: true, questions: [{ id: 'choice', title: 'Choose one', options: ['First'], allowOther: true, isSecret: false }], askedAt: '2026-01-01T00:00:01Z' }], ...patch };
}
describe('foreground Office attention candidates', () => {
  it('preserves exact request/session identity while exposing no answer or question content', () => {
    const requests = officeAttentionRequests([approval], { observed: entry() });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ kind: 'approval', sessionId: 'native', requestId: 'approval' });
    expect(requests[1]).toMatchObject({ kind: 'input', sessionId: 'observed', requestId: 'question' });
    expect(JSON.stringify(requests)).not.toContain('Choose one');
    expect(JSON.stringify(requests)).not.toContain('Run command');
  });
  it('never auto-opens unsupported, private or unavailable requests', () => {
    expect(officeAttentionRequests([{ ...approval, choices: [] }], { a: entry({ phase: 'private' }), b: entry({ phase: 'unavailable' }), c: entry({ phase: 'loading' }) })).toEqual([]);
  });
  it.each(['queued', 'submitted', 'unknown'] as const)('does not reopen %s receipts', state => {
    const e = entry();e.requests[0]!.state = state;
    expect(officeAttentionRequests([], { observed: e })).toEqual([]);
  });
  it('excludes unverifiable and unanswerable requests', () => {
    const a = entry(), b = entry();a.requests[0]!.identityVerified = false;b.requests[0]!.canAnswer = false;
    expect(officeAttentionRequests([], { a, b })).toEqual([]);
  });
  it('a changed source or revision obtains a fresh popup identity', () => {
    const first = entry(), revised = entry(), source = entry({ source: 'codex:other' });revised.requests[0]!.revision = 'revision-2';
    expect(new Set([first, revised, source].map(e => officeAttentionRequests([], { observed: e })[0]!.key)).size).toBe(3);
  });
});
