import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from '@extalia/core';
import { LearningRecovery, learningRouteFingerprint, type LearningRecoveryCandidate, type LearningRecoveryCatalog } from '../src/learningRecovery.js';
import { LearningSchedule, type ScheduledLearningInput } from '../src/learningSchedule.js';
import type { LearningRecoveryRecord } from '../src/rustLearning.js';

const queues: LearningSchedule[] = [];
afterEach(async () => { for (const queue of queues.splice(0)) await queue.close(); vi.useRealTimers(); });
function checkpoint(overrides: Partial<LearningRecoveryRecord> = {}): LearningRecoveryRecord {
  return { jobId: 'saved-job', profileId: 'profile', workspaceId: 'workspace', sessionId: 'session', runId: 'run',
    promptSha256: 'a'.repeat(64), routeFingerprint: 'b'.repeat(64), destinationRevision: 'revision',
    policy: { enabled: true, notes: true, skills: false }, state: 'resumable', active: false,
    updatedAt: Date.parse('2026-01-01T00:00:00Z'), expiresAt: Date.parse('2026-01-08T00:00:00Z'),
    modelRequests: 1, reads: 2, skillReviewRequired: false, ...overrides };
}
function fixture(records: LearningRecoveryRecord[] = [checkpoint()]) {
  const queue = new LearningSchedule(); queues.push(queue);
  const execute = vi.fn(async () => undefined);
  const list = vi.fn(async (): Promise<LearningRecoveryCandidate[] | LearningRecoveryCatalog> => records.map(record => ({ record, profileName: 'Synthetic profile' })));
  const prepare = vi.fn(async (record: LearningRecoveryRecord, id: string): Promise<ScheduledLearningInput> => ({ id, profileId: record.profileId,
    workspaceId: record.workspaceId, sessionId: record.sessionId, profileName: 'Synthetic profile',
    ready: () => false, validate: async () => true, execute }));
  const recovery = new LearningRecovery({ queue, list, prepare });
  return { queue, recovery, list, prepare, execute };
}

describe('authorized learning recovery admission', () => {
  it('restores healthy queued sources and reports an incomplete catalog without hiding them', async () => {
    const saved = checkpoint({ state: 'queued', modelRequests: 0, reads: 0, queue: { revision: 'd'.repeat(64), delaySeconds: 60 } });
    const f = fixture();
    f.list.mockResolvedValue({ candidates: [{ record: saved, profileName: 'Synthetic profile' }], incomplete: true });
    await f.recovery.restoreQueued();
    const snapshot = await f.recovery.snapshot();
    expect(snapshot.recoveryIncomplete).toBe(true);
    expect(snapshot.recoveryUnavailable).toBeUndefined();
    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.jobs[0]?.state).toBe('scheduled');
    const snoozed = await f.recovery.act({ id: snapshot.jobs[0]!.id, revision: snapshot.revision, action: 'snooze' });
    expect(snoozed.jobs[0]?.delaySeconds).toBe(600);
    expect(snoozed.recoveryIncomplete).toBe(true);
  });

  it('does not prevent startup when durable listing is unavailable', async () => {
    const f = fixture(); f.list.mockRejectedValue(new Error('Synthetic backend unavailable.'));
    await expect(f.recovery.restoreQueued()).resolves.toBeUndefined();
    expect(f.prepare).not.toHaveBeenCalled();
    expect((await f.recovery.snapshot()).recoveryUnavailable).toBe(true);
  });

  it('restores only never-started jobs and preserves the full selected quiet interval', async () => {
    vi.useFakeTimers();
    const saved = checkpoint({ state: 'queued', modelRequests: 0, reads: 0, queue: { revision: 'd'.repeat(64), delaySeconds: 600 } });
    const f = fixture([saved, checkpoint({ jobId: 'started', runId: 'started-run' }), checkpoint({ jobId: 'uncertain', runId: 'uncertain-run', state: 'uncertain' })]);
    f.prepare.mockImplementation(async (record, id) => ({ id, profileId: record.profileId, workspaceId: record.workspaceId,
      sessionId: record.sessionId, profileName: 'Synthetic profile', ready: () => true, validate: async () => true, execute: f.execute }));
    await f.recovery.restoreQueued();
    const snapshot = await f.recovery.snapshot();
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(snapshot.jobs.filter(job => job.state === 'scheduled')).toEqual([expect.objectContaining({ id: 'run', delaySeconds: 600 })]);
    expect(snapshot.jobs.filter(job => job.recovery).map(job => job.recovery!.state)).toEqual(['resumable', 'uncertain']);
    await vi.advanceTimersByTimeAsync(599_999);
    expect(f.execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('restores once, fences concurrent actions, and does not hydrate on snapshot reads', async () => {
    const f = fixture([checkpoint({ state: 'queued', modelRequests: 0, reads: 0, queue: { revision: 'd'.repeat(64), delaySeconds: 60 } })]);
    const before = await f.recovery.snapshot();
    expect(f.prepare).not.toHaveBeenCalled();
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const prepare = f.prepare.getMockImplementation()!;
    f.prepare.mockImplementation(async (...args) => { await wait; return prepare(...args); });
    const first = f.recovery.restoreQueued();
    expect(f.recovery.restoreQueued()).toBe(first);
    await expect(f.recovery.act({ id: before.jobs[0]!.id, revision: before.revision, action: 'resume' })).rejects.toThrow(/Another learning action/);
    release(); await first; await f.recovery.restoreQueued();
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.queue.snapshot().jobs).toHaveLength(1);
  });

  it('leaves queued records discoverable if the local queue is full or authority changes during restore', async () => {
    const f = fixture([checkpoint({ state: 'queued', queue: { revision: 'd'.repeat(64), delaySeconds: 60 } })]);
    for (let i = 0; i < 16; i++) f.queue.schedule({ id: `existing-${i}`, workspaceId: 'workspace', profileId: 'profile', sessionId: 'session',
      profileName: 'Fixture', ready: () => false, validate: async () => true, execute: f.execute });
    await f.recovery.restoreQueued();
    expect(f.queue.snapshot().jobs).toHaveLength(16);
    expect((await f.recovery.snapshot()).jobs.at(-1)?.recovery?.state).toBe('queued');
    expect(f.execute).not.toHaveBeenCalled();
    const changed = fixture([checkpoint({ state: 'queued', queue: { revision: 'e'.repeat(64), delaySeconds: 60 } })]);
    changed.prepare.mockRejectedValue(new Error('Synthetic authority changed.'));
    await changed.recovery.restoreQueued();
    expect(changed.queue.snapshot().jobs).toHaveLength(0);
    expect((await changed.recovery.snapshot()).jobs[0]?.recovery?.state).toBe('queued');
  });

  it('allows explicit queued admission with fresh metadata but never accepts missing queue proof', async () => {
    const saved = checkpoint({ state: 'queued', modelRequests: 0, reads: 0, queue: { revision: 'd'.repeat(64), delaySeconds: 600 } });
    const f = fixture([saved]); const before = await f.recovery.snapshot();
    expect(before.jobs[0]?.delaySeconds).toBe(600);
    const admitted = await f.recovery.act({ id: before.jobs[0]!.id, revision: before.revision, action: 'resume' });
    expect(admitted.jobs).toHaveLength(1);
    expect(admitted.jobs[0]?.state).toBe('scheduled');
    expect(f.prepare.mock.calls[0]?.[0]).toEqual(saved);
    expect(f.execute).not.toHaveBeenCalled();
    const incomplete = fixture([checkpoint({ state: 'queued' })]); const invalid = await incomplete.recovery.snapshot();
    await expect(incomplete.recovery.act({ id: invalid.jobs[0]!.id, revision: invalid.revision, action: 'resume' })).rejects.toThrow(/cannot be safely resumed/);
    expect(incomplete.prepare).not.toHaveBeenCalled();
  });

  it('invalidates a queued action when only its durable snooze generation changes', async () => {
    const saved = checkpoint({ state: 'queued', queue: { revision: 'd'.repeat(64), delaySeconds: 60 } });
    const f = fixture([saved]); const old = await f.recovery.snapshot();
    f.list.mockResolvedValue([{ record: { ...saved, queue: { revision: 'e'.repeat(64), delaySeconds: 600 } }, profileName: 'Synthetic profile' }]);
    await expect(f.recovery.act({ id: old.jobs[0]!.id, revision: old.revision, action: 'resume' })).rejects.toThrow(/changed/);
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it('shows scoped recovery metadata without exposing retained source or routing data', async () => {
    const f = fixture([checkpoint(), checkpoint({ jobId: 'live', active: true }), checkpoint({ jobId: 'done', state: 'terminal' })]);
    const snapshot = await f.recovery.snapshot();
    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.jobs[0]).toMatchObject({ id: 'recovery:saved-job', workspaceId: 'workspace', recovery: { state: 'resumable', modelRequests: 1, reads: 2 } });
    expect(JSON.stringify(snapshot)).not.toContain('routeFingerprint');
    expect(JSON.stringify(snapshot)).not.toContain('promptSha256');
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('requires a fresh snapshot and reauthorizes before putting recovery in the existing idle queue', async () => {
    const f = fixture(); const current = await f.recovery.snapshot();
    const resumed = await f.recovery.act({ id: current.jobs[0]!.id, revision: current.revision, action: 'resume' });
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.prepare.mock.calls[0]![0]).toEqual(checkpoint());
    expect(f.execute).not.toHaveBeenCalled();
    expect(resumed.jobs).toHaveLength(1);
    expect(resumed.jobs[0]).toMatchObject({ state: 'scheduled', waitingForIdle: true, workspaceId: 'workspace' });
    expect(resumed.jobs[0]!.recovery).toBeUndefined();
    await expect(f.recovery.act({ id: current.jobs[0]!.id, revision: current.revision, action: 'resume' })).rejects.toThrow(/changed/);
    expect(f.prepare).toHaveBeenCalledTimes(1);
  });

  it.each(['uncertain', 'expired'] as const)('never replays a %s checkpoint', async state => {
    const f = fixture([checkpoint({ state })]); const snapshot = await f.recovery.snapshot();
    await expect(f.recovery.act({ id: snapshot.jobs[0]!.id, revision: snapshot.revision, action: 'resume' })).rejects.toThrow(/cannot be safely resumed/);
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  });

  it('invalidates review when an unexposed source binding changes', async () => {
    const f = fixture(); const old = await f.recovery.snapshot();
    f.list.mockResolvedValue([{ record: checkpoint({ routeFingerprint: 'c'.repeat(64) }), profileName: 'Synthetic profile' }]);
    await expect(f.recovery.act({ id: old.jobs[0]!.id, revision: old.revision, action: 'resume' })).rejects.toThrow(/changed/);
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it('does not admit a recovery whose authority is revoked during preparation', async () => {
    const f = fixture(); const snapshot = await f.recovery.snapshot();
    f.prepare.mockRejectedValue(new Error('Current profile consent was revoked.'));
    await expect(f.recovery.act({ id: snapshot.jobs[0]!.id, revision: snapshot.revision, action: 'resume' })).rejects.toThrow(/revoked/);
    expect(f.queue.snapshot().jobs).toHaveLength(0); expect(f.execute).not.toHaveBeenCalled();
  });

  it('reports catalog unavailability while keeping scheduled work visible and actionable', async () => {
    const f = fixture();
    f.queue.schedule({ id: 'existing', profileId: 'profile', workspaceId: 'workspace', sessionId: 'session', profileName: 'Fixture',
      ready: () => false, validate: async () => true, execute: f.execute });
    f.list.mockRejectedValue(new Error('Synthetic sidecar outage.'));
    const snapshot = await f.recovery.snapshot();
    expect(snapshot.recoveryUnavailable).toBe(true);
    expect(snapshot.jobs).toHaveLength(1);
    const next = await f.recovery.act({ id: 'existing', revision: snapshot.revision, action: 'snooze' });
    expect(next.jobs[0]!.delaySeconds).toBe(600);
  });

  it('fences two overlapping resume requests', async () => {
    const f = fixture(); const snapshot = await f.recovery.snapshot();
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const prepare = f.prepare.getMockImplementation()!;
    f.prepare.mockImplementation(async (...args) => { await wait; return prepare(...args); });
    const action = { id: snapshot.jobs[0]!.id, revision: snapshot.revision, action: 'resume' as const };
    const first = f.recovery.act(action);
    await expect(f.recovery.act(action)).rejects.toThrow(/Another learning action/);
    release(); await first;
    expect(f.queue.snapshot().jobs).toHaveLength(1);
  });
});

it('binds learning to the selected model, effort, features and source while ignoring cosmetic names', () => {
  const connection: Connection = { id: 'connection', name: 'Fixture', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1',
    model: 'fixture-model', credential: { kind: 'none' }, features: { memory: 'extalia', skills: 'extalia' },
    orchestration: { enabled: false, maxDelegations: 0, tiers: {} }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
  const source = { profile: 'profile', boundary: 'workspace-boundary' }, fingerprint = learningRouteFingerprint(connection, source);
  expect(learningRouteFingerprint({ ...connection, name: 'Renamed' }, source)).toBe(fingerprint);
  for (const patch of [{ model: 'another-model' }, { effort: 'high' as const }, { contextOptimization: { mode: 'off' as const } }, { features: { memory: 'off' as const, skills: 'extalia' as const } }]) {
    expect(learningRouteFingerprint({ ...connection, ...patch }, source)).not.toBe(fingerprint);
  }
  expect(learningRouteFingerprint(connection, { ...source, boundary: 'different' })).not.toBe(fingerprint);
});
