import { describe, expect, it, vi } from 'vitest';
import { LearningQueueAdmissions, learningQueueBinding, sameLearningObservedScope } from '../src/learningQueue.js';
import type { LearningRecoveryRecord, RustLearningAction, RustLearningPort } from '../src/rustLearning.js';

const binding = { profileId: 'profile-one', workspaceId: 'workspace-one', sessionId: 'session-one', runId: 'run-one',
  promptSha256: 'a'.repeat(64), routeFingerprint: 'b'.repeat(64), policy: { enabled: true, skills: true, notes: true } };
const record: LearningRecoveryRecord = { ...binding, destinationRevision: 'vault-revision-one', jobId: 'c'.repeat(64),
  state: 'queued', active: false, updatedAt: 1, expiresAt: 100, modelRequests: 0, reads: 0, skillReviewRequired: false,
  queue: { revision: 'd'.repeat(64), delaySeconds: 60 } };
const input = { ...binding, revision: record.destinationRevision,
  evidence: [{ toolCallId: 'read-one', name: 'read_file', content: 'Validate parser input before saving.', isError: false }],
  sourceContext: { user: 'Preserve parser verification guidance.', assistant: 'The parser validates input.' } };
function backend(handler?: (action: RustLearningAction) => Promise<void>) {
  const process = vi.fn(async (action: RustLearningAction, _input: unknown) => {
    await handler?.(action);
    return { action, ...(action === 'evidence.begin' ? { intakeId: 'intake-one' }
      : action === 'evidence.append' ? { complete: false }
        : action === 'evidence.release' ? { released: true } : { record, created: true }) };
  });
  return { process, port: { process } as unknown as RustLearningPort };
}

describe('durable learning capture admission', () => {
  it('persists only the bounded source binding through Rust and starts no analysis or vault owner', async () => {
    const owner = backend(), admissions = new LearningQueueAdmissions(owner.port), current = vi.fn();
    expect(await admissions.native(input, current)).toEqual(record);
    expect(owner.process.mock.calls.map(call => call[0])).toEqual(['evidence.begin', 'evidence.append', 'queue.capture']);
    expect(owner.process.mock.calls.at(-1)?.[1]).toEqual({ ...binding, revision: record.destinationRevision,
      sourceContext: input.sourceContext, intakeId: 'intake-one' });
    expect(current).toHaveBeenCalledTimes(3);
    await admissions.close();
  });

  it('drains synchronously accepted capture even when close precedes its first asynchronous step', async () => {
    const owner = backend(), admissions = new LearningQueueAdmissions(owner.port);
    const capturing = admissions.native(input, () => undefined);
    const closing = admissions.close();
    expect(await capturing).toEqual(record);
    await closing;
    expect(owner.process.mock.calls.at(-1)?.[0]).toBe('queue.capture');
  });

  it('frames Unicode evidence without splitting a surrogate pair before Rust sanitizes it', async () => {
    const owner = backend(), admissions = new LearningQueueAdmissions(owner.port);
    const content = `${'x'.repeat(16_383)}🌱more source evidence`;
    await admissions.native({ ...input, evidence: [{ ...input.evidence[0]!, content }] }, () => undefined);
    const chunks = owner.process.mock.calls.filter(call => call[0] === 'evidence.append').map(call => call[1] as { chunk: string; final: boolean });
    expect(chunks.map(value => value.chunk).join('')).toBe(content);
    expect(chunks[0]?.chunk).toHaveLength(16_383);
    expect(chunks.at(-1)?.final).toBe(true);
    expect(chunks.some(value => /[\uD800-\uDBFF]$/u.test(value.chunk))).toBe(false);
    await admissions.close();
  });

  it('drains a capture already in flight at shutdown and never retries its lost acknowledgement', async () => {
    let reject!: (reason: Error) => void;
    const gate = new Promise<void>((_resolve, fail) => { reject = fail; });
    const owner = backend(action => action === 'queue.capture' ? gate : Promise.resolve());
    const admissions = new LearningQueueAdmissions(owner.port), capturing = admissions.native(input, () => undefined);
    const rejected = expect(capturing).rejects.toThrow('Synthetic lost acknowledgement');
    await vi.waitFor(() => expect(owner.process.mock.calls.some(call => call[0] === 'queue.capture')).toBe(true));
    let closed = false;
    const closing = admissions.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    await expect(admissions.native(input, () => undefined)).rejects.toThrow('closing');
    reject(new Error('Synthetic lost acknowledgement'));
    await rejected; await closing;
    expect(owner.process.mock.calls.filter(call => call[0] === 'queue.capture')).toHaveLength(1);
    expect(owner.process.mock.calls.at(-1)?.[0]).toBe('evidence.release');
  });

  it('rechecks source authority before persistence and releases an unconsumed intake', async () => {
    const owner = backend(), admissions = new LearningQueueAdmissions(owner.port);
    let checks = 0;
    await expect(admissions.native(input, () => { if (++checks === 3) throw new Error('Consent changed'); })).rejects.toThrow('Consent changed');
    expect(owner.process.mock.calls.map(call => call[0])).toEqual(['evidence.begin', 'evidence.append', 'evidence.release']);
    await admissions.close();
  });

  it('compares Observe scope fields across JSON key order without accepting a different alias or boundary', () => {
    const scope = { profileId: 'default', workspaceId: 'global-observe', sessionId: 'observed-one', sourceId: 'codex', nativeSessionId: 'native-one', boundary: 'a'.repeat(64) };
    const reordered = Object.fromEntries(Object.entries(scope).reverse()) as typeof scope;
    expect(JSON.stringify(scope)).not.toBe(JSON.stringify(reordered));
    expect(sameLearningObservedScope(scope, reordered)).toBe(true);
    expect(sameLearningObservedScope(scope, { ...reordered, sessionId: 'observed-two' })).toBe(false);
    expect(sameLearningObservedScope(scope, { ...reordered, boundary: 'b'.repeat(64) })).toBe(false);
  });

  it('projects only exact queued authority fields into controls', () => {
    expect(learningQueueBinding(record)).toEqual({ ...binding, destinationRevision: record.destinationRevision,
      jobId: record.jobId, queueRevision: record.queue!.revision });
    expect(() => learningQueueBinding({ ...record, state: 'resumable' })).toThrow('no longer queued');
  });
});
