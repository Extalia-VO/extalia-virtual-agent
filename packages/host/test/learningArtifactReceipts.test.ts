import { describe, expect, it } from 'vitest';
import { learningFailureCode, learningPublicationReason, readLearningArtifact } from '../src/learningArtifactReceipts.js';

describe('learning artifact confirmation decoding', () => {
  it('explains known publication refusals without disclosing nested adapter diagnostics', () => {
    const failure = Object.assign(new Error('Private diagnostic text must not leave the adapter.'), { reason: 'refinement_base_required' });
    expect(learningPublicationReason(failure)).toContain('Read the current candidate');
    expect(learningPublicationReason(new Error('Wrapped path details', { cause: { reason: 'knowledge_source_changed' } }))).toContain('note changed');
    expect(learningPublicationReason({ reason: 'unknown-private-diagnostic', message: 'refinement_base_required' })).toBeUndefined();
    expect(learningPublicationReason({ reason: '__proto__' })).toBeUndefined();
    const circular: { cause?: unknown } = {}; circular.cause = circular;
    expect(learningPublicationReason(circular)).toBeUndefined();
  });

  it('accepts historical note confirmations only for the same workspace', () => {
    const receipt = { kind: 'note' as const, data: JSON.stringify({ path: 'Learning/workspace/earlier-run.md' }) };
    expect(readLearningArtifact(receipt, 'note', 'workspace')).toEqual({ path: 'Learning/workspace/earlier-run.md' });
    expect(() => readLearningArtifact(receipt, 'note', 'another')).toThrow();
    for (const path of ['Learning/workspace/../elsewhere.md', 'Learning/workspace/C:\\private.md', '/Learning/workspace/absolute.md'])
      expect(() => readLearningArtifact({ kind: 'note', data: JSON.stringify({ path }) }, 'note', 'workspace')).toThrow();
  });

  it('validates lifecycle state and never announces a confirmed earlier skill as newly created', () => {
    const saved = { packageId: 'generated-example', revisionId: 'revision-example', state: 'quarantined', created: true,
      inspection: 'recorded', activationPerformed: false, cancellationObserved: false };
    expect(readLearningArtifact({ kind: 'skill', data: JSON.stringify(saved) }, 'skill', 'workspace')).toMatchObject({ created: false, state: 'quarantined' });
    expect(() => readLearningArtifact({ kind: 'skill', data: JSON.stringify({ ...saved, state: 'fictional-state' }) }, 'skill', 'workspace')).toThrow();
    expect(() => readLearningArtifact({ kind: 'skill', data: JSON.stringify({ ...saved, activationPerformed: true }) }, 'skill', 'workspace')).toThrow();
  });

  it('maps provider faults to safe finite categories', () => {
    expect(learningFailureCode({ status: 400 })).toBe('invalid-request');
    expect(learningFailureCode({ statusCode: 429 })).toBe('rate-limited');
    expect(learningFailureCode({ status: 503 })).toBe('unavailable');
    expect(learningFailureCode(new Error('request timed out'))).toBe('timeout');
    expect(learningFailureCode(new Error('private unknown content'))).toBe('unknown');
  });
});
