import { describe, expect, it } from 'vitest';
import type { AutomaticLearningResult } from '../src/automaticLearning.js';
import type { SkillProposalResult } from '../src/skillLearning.js';
import { automaticLearningNotice, type SkillLearningNoticeOrigin, type SkillLearningRegistryHistory } from '../src/skillLearningNotices.js';

const origin: SkillLearningNoticeOrigin = {
  profileId: 'profile-one', workspaceId: 'workspace-one', sessionId: 'session-one', runId: 'run-one', createdAt: '2026-01-02T12:00:00.000Z',
};
const receipt: SkillProposalResult = {
  packageId: 'example-skill', revisionId: 'a'.repeat(64), state: 'quarantined', stateReason: 'scanner-unavailable',
  created: true, inspection: 'unavailable', activationPerformed: false, cancellationObserved: false,
};
const completed = (changes: Partial<AutomaticLearningResult> = {}): AutomaticLearningResult => ({
  outcome: 'completed', skill: { status: 'recorded', receipt }, note: { status: 'saved', path: 'Learning/workspace-one/run-one.md' }, ...changes,
});
const history = (changes: Partial<SkillLearningRegistryHistory> = {}): SkillLearningRegistryHistory => ({
  profileId: origin.profileId, mode: 'registry', status: 'ready', truncated: false,
  revisions: [{ packageId: receipt.packageId, revisionId: receipt.revisionId, createdAt: origin.createdAt }], ...changes,
});
const previous = { packageId: receipt.packageId, revisionId: 'b'.repeat(64), createdAt: '2026-01-01T12:00:00.000Z' };

describe('receipt-backed automatic learning notices', () => {
  it('shows only the saved candidate and its originating scope when inspection is unavailable', () => {
    const notice = automaticLearningNotice(completed(), origin);
    expect(notice).toEqual({
      id: expect.stringMatching(/^skill-[a-f0-9]{64}$/), ...origin,
      kind: 'skill-candidate', packageId: receipt.packageId, revisionId: receipt.revisionId,
      state: 'quarantined', change: 'saved', activationPerformed: false,
    });
    expect(notice).not.toHaveProperty('path');
    expect(notice).not.toHaveProperty('inspectionOutcome');
  });

  it.each(['skipped', 'unknown'] as const)('does not turn %s status into a successful artifact notice', status => {
    expect(automaticLearningNotice(completed({ skill: { status, receipt } }), origin)).toBeUndefined();
  });

  it('requires an acknowledged new revision rather than a missing or identical-existing receipt', () => {
    expect(automaticLearningNotice(completed({ skill: { status: 'recorded' } }), origin)).toBeUndefined();
    const duplicate = completed({ skill: { status: 'recorded', receipt: { ...receipt, created: false } } });
    expect(automaticLearningNotice(duplicate, origin, history())).toBeUndefined();
    expect(automaticLearningNotice(duplicate, origin, history({ revisions: [...history().revisions, previous] }))).toBeUndefined();
  });

  it.each(['failed', 'cancelled'] as const)('preserves a durable candidate after a later %s outcome without claiming completed learning', outcome => {
    const result = completed({
      outcome, reason: 'A later effect did not finish.', note: { status: 'failed' },
      skill: { status: 'recorded', receipt: { ...receipt, cancellationObserved: outcome === 'cancelled' } },
    });
    expect(automaticLearningNotice(result, origin)).toMatchObject({ kind: 'skill-candidate', change: 'saved', partial: true, activationPerformed: false });
  });

  it('deduplicates the same profile revision independently of projection time or run, while separating profiles and revisions', () => {
    const first = automaticLearningNotice(completed(), origin)!;
    const repeat = automaticLearningNotice(completed(), { ...origin, runId: 'run-two', createdAt: '2026-01-03T12:00:00.000Z' })!;
    expect(repeat.id).toBe(first.id);
    expect(automaticLearningNotice(completed(), { ...origin, profileId: 'profile-two' })!.id).not.toBe(first.id);
    const changed = completed({ skill: { status: 'recorded', receipt: { ...receipt, revisionId: 'c'.repeat(64) } } });
    expect(automaticLearningNotice(changed, origin)!.id).not.toBe(first.id);
  });

  it('calls a candidate new only when a complete current-profile registry history contains just that package revision', () => {
    expect(automaticLearningNotice(completed(), origin, history())?.change).toBe('new');
    const unrelated = { ...previous, packageId: 'different-skill' };
    expect(automaticLearningNotice(completed(), origin, history({ revisions: [...history().revisions, unrelated] }))?.change).toBe('new');
  });

  it('recognizes an earlier same-package revision even when unrelated registry history is truncated', () => {
    const revisions = [...history().revisions, previous];
    for (const truncated of [false, true]) {
      expect(automaticLearningNotice(completed(), origin, history({ revisions, truncated }))?.change).toBe('revised');
    }
  });

  it.each([
    { profileId: 'profile-two' }, { mode: 'legacy' as const }, { status: 'unavailable' as const },
    { status: 'off' as const }, { truncated: true }, { revisions: [previous] },
  ])('uses a generic saved notice when history cannot prove new or revised: %j', change => {
    expect(automaticLearningNotice(completed(), origin, history(change))?.change).toBe('saved');
  });

  it.each([origin.createdAt, '2026-01-03T12:00:00.000Z', 'invalid'])('does not mistake an equal, later or invalid timestamp for an earlier revision: %s', createdAt => {
    const revisions = [...history().revisions, { ...previous, createdAt }];
    expect(automaticLearningNotice(completed(), origin, history({ revisions }))?.change).toBe('saved');
  });
});
