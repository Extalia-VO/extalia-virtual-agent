import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from '@extalia/core';
import { LearningRecovery, learningRouteFingerprint, type LearningRecoveryCandidate } from '../src/learningRecovery.js';
import { LearningSchedule } from '../src/learningSchedule.js';
import type { LearningRecoveryRecord } from '../src/rustLearning.js';

const queues: LearningSchedule[] = [];
afterEach(async () => { for (const queue of queues.splice(0)) await queue.close(); });
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
  const list = vi.fn(async (): Promise<LearningRecoveryCandidate[]> => records.map(record => ({ record, profileName: 'Synthetic profile' })));
  const prepare = vi.fn(async (record: LearningRecoveryRecord, id: string) => ({ id, profileId: record.profileId,
    workspaceId: record.workspaceId, sessionId: record.sessionId, profileName: 'Synthetic profile',
    ready: () => false, validate: async () => true, execute }));
  const recovery = new LearningRecovery({ queue, list, prepare });
  return { queue, recovery, list, prepare, execute };
}

describe('authorized learning recovery admission', () => {
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
