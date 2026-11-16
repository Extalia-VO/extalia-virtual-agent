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
  it('separates durable queue capture from effect admission and requires exact mutation generations', () => {
    const { tools: _tools, ...source } = input; void _tools;
    const capture = { ...source, routeFingerprint: 'b'.repeat(64) };
    expect(valid(learningParams, { action: 'queue.capture', input: capture })).toBe(true);
    expect(valid(learningParams, { action: 'queue.capture', input: { ...capture, tools: [] } })).toBe(false);
    expect(valid(learningParams, { action: 'queue.capture', input: { ...capture, memoryContext: 'old recall' } })).toBe(false);
    expect(valid(learningParams, { action: 'queue.capture', input: { ...capture, routeFingerprint: undefined } })).toBe(false);
    const binding = { profileId: input.profileId, workspaceId: input.workspaceId, sessionId: input.sessionId,
      runId: input.runId, promptSha256: input.promptSha256, destinationRevision: input.revision,
      routeFingerprint: capture.routeFingerprint, policy: input.policy, jobId: 'c'.repeat(64), queueRevision: 'd'.repeat(64) };
    expect(valid(learningParams, { action: 'queue.admit', input: { ...binding, tools: [] } })).toBe(true);
    expect(valid(learningParams, { action: 'queue.admit', input: { ...binding, tools: [], replayUncertain: true } })).toBe(false);
    expect(valid(learningParams, { action: 'queue.admit', input: { ...binding, tools: [], queueRevision: undefined } })).toBe(false);
    expect(valid(learningParams, { action: 'queue.delay', input: { ...binding, delaySeconds: 600 } })).toBe(true);
    expect(valid(learningParams, { action: 'queue.delay', input: { ...binding, delaySeconds: 0 } })).toBe(false);
    expect(valid(learningParams, { action: 'queue.delay', input: { ...binding, delaySeconds: 599 } })).toBe(false);
    expect(valid(learningParams, { action: 'queue.cancel', input: binding })).toBe(true);
    const { queueRevision, ...recordBinding } = binding;
    const record = { ...recordBinding, state: 'queued', active: false, updatedAt: 10, expiresAt: 20,
      modelRequests: 0, reads: 0, skillReviewRequired: false, queue: { revision: queueRevision, delaySeconds: 600 } };
    expect(valid(learningResult, { action: 'queue.capture', record, created: true })).toBe(true);
    expect(valid(learningResult, { action: 'queue.delay', record })).toBe(true);
    expect(valid(learningResult, { action: 'queue.capture', record: { ...record, sourceContext: { user: 'private', assistant: '' } }, created: true })).toBe(false);
    expect(valid(learningResult, { action: 'queue.capture', record: { ...record, queue: { ...record.queue, runImmediately: true } }, created: true })).toBe(false);
  });

  it('requires an exact observed episode and destination for pre-admission capture', () => {
    const capture = { scope: { profileId: 'default', workspaceId: 'global-observe', sessionId: 'observed', sourceId: 'codex', nativeSessionId: 'native', boundary: 'a'.repeat(64) },
      episodeId: 'b'.repeat(64), revision: 'c'.repeat(64), destinationRevision: 'vault-r2', runId: 'run', promptSha256: 'd'.repeat(64),
      policy: input.policy, routeFingerprint: 'e'.repeat(64) };
    expect(valid(learningParams, { action: 'observed.queueCapture', input: capture })).toBe(true);
    expect(valid(learningParams, { action: 'observed.queueCapture', input: { ...capture, destinationRevision: undefined } })).toBe(false);
    expect(valid(learningParams, { action: 'observed.queueCapture', input: { ...capture, tools: [] } })).toBe(false);
    expect(valid(learningParams, { action: 'observed.queueCapture', input: { ...capture, scope: { ...capture.scope, granted: true } } })).toBe(false);
  });

  it('binds checkpoint recovery to source, route and destination without accepting replay permission', () => {
    const binding = { jobId: 'c'.repeat(64), profileId: input.profileId, workspaceId: input.workspaceId, sessionId: input.sessionId,
      runId: input.runId, promptSha256: input.promptSha256, destinationRevision: input.revision,
      routeFingerprint: 'b'.repeat(64), policy: input.policy, tools: [] };
    expect(valid(learningParams, { action: 'job.begin', input: { ...input, routeFingerprint: binding.routeFingerprint } })).toBe(true);
    expect(valid(learningParams, { action: 'job.enter', input: { jobId: binding.jobId, effectId: `${binding.jobId}-1` } })).toBe(true);
    expect(valid(learningParams, { action: 'job.recover', input: binding })).toBe(true);
    expect(valid(learningParams, { action: 'job.recover', input: { ...binding, routeFingerprint: undefined } })).toBe(false);
    expect(valid(learningParams, { action: 'job.recover', input: { ...binding, replayUncertain: true } })).toBe(false);
    expect(valid(learningParams, { action: 'job.list', input: { profileId: 'default', limit: 33 } })).toBe(false);
    const { tools: _tools, ...recordBinding } = binding; void _tools;
    const record = { ...recordBinding, state: 'uncertain', active: false, updatedAt: 10, expiresAt: 20, modelRequests: 1, reads: 0, skillReviewRequired: false };
    expect(valid(learningResult, { action: 'job.list', jobs: [record], omitted: 0 })).toBe(true);
    expect(valid(learningResult, { action: 'job.list', jobs: [{ ...record, modelRequests: 7 }], omitted: 0 })).toBe(false);
    expect(valid(learningResult, { action: 'job.list', jobs: [{ ...record, state: 'automatically-approved' }], omitted: 0 })).toBe(false);
  });

  it('bounds source revalidation and accepts normalized relationships without promoting them into authority', () => {
    const reads = [{ path: 'Knowledge/Policy.md', ok: true, output: '{}' }];
    expect(valid(learningParams, { action: 'job.revalidate', input: { jobId: 'job', reads } })).toBe(true);
    expect(valid(learningParams, { action: 'job.revalidate', input: { jobId: 'job', reads: Array.from({ length: 9 }, () => reads[0]) } })).toBe(false);
    expect(valid(learningParams, { action: 'job.revalidate', input: { jobId: 'job', reads, trust: 'verified' } })).toBe(false);
    const job = { jobId: 'job', status: 'ready', evidence: [], provenance: { sessionId: 'session', workspaceId: 'workspace', promptSha256: 'a'.repeat(64) },
      submission: { title: 'Correction', lesson: 'Validate before saving.', evidenceIds: ['source'], relatedNotes: [{ path: 'Policy.md', relation: 'updates', reason: 'A source reports a changed procedure.', evidenceIds: ['source'], sourceSha256: 'b'.repeat(64) }] },
      knowledgeReads: [{ path: 'Policy.md', sha256: 'b'.repeat(64) }] };
    expect(valid(learningResult, { action: 'job.revalidate', job })).toBe(true);
    expect(valid(learningResult, { action: 'job.revalidate', job: { ...job, knowledgeReads: [{ path: 'Policy.md', sha256: 'bad' }] } })).toBe(false);
  });

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
