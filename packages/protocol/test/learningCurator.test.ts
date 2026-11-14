import { describe, expect, it } from 'vitest';
import { learningParams, learningResult } from '../src/daemonLearningRules.js';

const valid = (rule: typeof learningParams, value: unknown) => {
  const errors: string[] = []; rule.check(value, 'value', errors); return errors.length === 0;
};
const input = {
  profileId: 'default', revision: 'r1', workspaceId: 'workspace', sessionId: 'session', runId: 'run', promptSha256: 'a'.repeat(64),
  policy: { enabled: true, skills: true, notes: true }, tools: [], evidence: [],
};

describe('bounded learning curator contract', () => {
  it('admits current-turn text without invented tool evidence and bounds both roles', () => {
    const sourceContext = { user: 'Use a concise checklist.', assistant: 'I will use that preference.' };
    expect(valid(learningParams, { action: 'job.begin', input: { ...input, sourceContext } })).toBe(true);
    expect(valid(learningParams, { action: 'job.begin', input: { ...input, sourceContext: { ...sourceContext, user: 'x'.repeat(2001) } } })).toBe(false);
    expect(valid(learningParams, { action: 'job.begin', input: { ...input, sourceContext: { ...sourceContext, verified: true } } })).toBe(false);
  });

  it('bounds analysis deadlines independently of provider error details', () => {
    expect(valid(learningParams, { action: 'job.begin', input: { ...input, timeoutMs: 120_000 } })).toBe(true);
    expect(valid(learningParams, { action: 'job.begin', input: { ...input, timeoutMs: 120_001 } })).toBe(false);
    const advance = { jobId: 'job', effectId: 'effect', completion: { kind: 'failed', stage: 'provider', code: 'invalid-request' } };
    expect(valid(learningParams, { action: 'job.advance', input: advance })).toBe(true);
    expect(valid(learningParams, { action: 'job.advance', input: { ...advance, completion: { ...advance.completion, message: 'Unbounded external text' } } })).toBe(false);
    expect(valid(learningParams, { action: 'job.advance', input: { ...advance, completion: { ...advance.completion, code: 'arbitrary' } } })).toBe(false);
  });

  it('binds observed publication to a destination revision separately from its immutable source episode', () => {
    const observed = { scope: { profileId: 'default', workspaceId: 'global-observe', sessionId: 'observed', sourceId: 'codex', nativeSessionId: 'native', boundary: 'a'.repeat(64) },
      episodeId: 'b'.repeat(64), revision: 'c'.repeat(64), destinationRevision: 'vault-r2', runId: 'run', promptSha256: 'd'.repeat(64),
      policy: { enabled: true, skills: true, notes: true }, tools: [] };
    expect(valid(learningParams, { action: 'observed.jobBegin', input: observed })).toBe(true);
    expect(valid(learningParams, { action: 'observed.jobBegin', input: { ...observed, destinationRevision: '' } })).toBe(false);
    expect(valid(learningParams, { action: 'observed.jobBegin', input: { ...observed, destinationRevision: 'x'.repeat(513) } })).toBe(false);
    expect(valid(learningParams, { action: 'observed.jobBegin', input: { ...observed, revision: 'vault-r2' } })).toBe(false);
  });

  it('accepts independent artifact receipts without granting lifecycle or execution authority', () => {
    const digest = 'b'.repeat(64);
    const receipt = { kind: 'note', data: JSON.stringify({ path: 'Learning/workspace/run.md' }) };
    expect(valid(learningParams, { action: 'receipt.get', input: { profileId: 'default', contentSha256: digest } })).toBe(true);
    expect(valid(learningParams, { action: 'receipt.record', input: { profileId: 'default', contentSha256: digest, runId: 'run', receipt } })).toBe(true);
    expect(valid(learningParams, { action: 'receipt.record', input: { profileId: 'default', contentSha256: digest, runId: 'run', receipt: { ...receipt, data: 'x'.repeat(8193) } } })).toBe(false);
    expect(valid(learningResult, { action: 'receipt.get', status: 'recorded', receipt })).toBe(true);
    expect(valid(learningResult, { action: 'receipt.record', recorded: true, replayed: false })).toBe(true);
    expect(valid(learningResult, { action: 'receipt.get', status: 'recorded', receipt, activated: true })).toBe(false);
  });
});
