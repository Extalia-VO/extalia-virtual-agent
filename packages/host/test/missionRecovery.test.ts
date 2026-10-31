import type { HostMissionRun } from '@extalia/platform';
import type { DaemonMissionSnapshot, TaskState } from '@extalia/protocol';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MissionRecords } from '../src/mission.js';
import { MissionRecovery } from '../src/missionRecovery.js';
import type { SessionRecord } from '../src/sessions.js';

const at = '2026-10-27T00:00:00.000Z';
const roots: string[] = [], stores: MissionRecords[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (stores.length) stores.pop()!.close();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'extalia-recovery-')); roots.push(root);
  const session = { id: 's_recovery123', workspaceId: 'workspace' } as SessionRecord;
  const records = new MissionRecords(root, path.join(root, 'missions.sqlite')); stores.push(records);
  await records.initialize([session]);
  const run: HostMissionRun = {
    id: randomUUID(), sessionId: session.id, workspaceId: session.workspaceId, title: 'Inspect', state: 'recovering', transient: false, createdAt: at, updatedAt: at,
    authority: { backend: 'rust', profileId: 'default', workspaceId: randomUUID() }, recovery: { source: 'host-restart', at },
    tasks: [0, 1].map(index => ({ id: `task-${index}`, taskId: randomUUID(), agentId: randomUUID(), title: 'Inspect', connectionId: 'provider', model: 'model', state: index ? 'unknown' : 'completed', evidenceIds: [],
      ...(index ? { reason: 'host-restarted', usage: { unknown: true } } : { answer: 'Retained answer', verification: 'unverified' as const }) })),
  };
  await records.save(run);
  const snapshot: DaemonMissionSnapshot = { missionId: run.id, workspaceId: run.authority!.backend === 'rust' ? run.authority!.workspaceId : '', version: 5, state: 'completed', updatedAt: at, sequence: 9,
    tasks: run.tasks.map(task => ({ taskId: task.taskId, assignedAgentId: task.agentId, state: 'completed', attempt: 1 })), leases: [] };
  let active = false;
  const read = vi.fn(async () => structuredClone(snapshot));
  const recovery = new MissionRecovery({ records, profileId: 'default', active: () => active, snapshot: read });
  return { root, session, records, run, snapshot, read, recovery, setActive: (value: boolean) => { active = value; } };
}

describe('canonical recovery inspection', () => {
  it('persists a terminal shadow repair, preserves only retained matching answers, and survives restart', async () => {
    const f = await fixture();
    const result = await f.recovery.refresh(f.session.id, f.run.id);
    expect(result.status).toBe('refreshed');
    expect(result.run.state).toBe('completed');
    expect(result.run.tasks[0]).toMatchObject({ answer: 'Retained answer', verification: 'unverified' });
    expect(result.run.tasks[1]).not.toHaveProperty('answer');
    expect(result.run.tasks[1]).not.toHaveProperty('verification');
    expect(result.run.tasks[1]!.usage).toEqual({ unknown: true });
    expect(result.run).not.toHaveProperty('usage');
    expect(result.run.tasks.every(task => task.evidenceIds.length === 0)).toBe(true);
    f.records.close();
    const next = new MissionRecords(f.root, path.join(f.root, 'missions.sqlite')); stores.push(next);
    await next.initialize([f.session]);
    expect(next.get(f.session.id, f.run.id)).toEqual(result.run);
    expect((await f.recovery.refresh(f.session.id, f.run.id)).status).toBe('refreshed');
  });

  it.each([
    { state: 'running', reason: undefined, expected: 'host-restart' },
    { state: 'unknown', reason: 'execution-unknown', expected: 'execution-uncertain' },
    { state: 'running', reason: 'persistence-failed', expected: 'execution-uncertain' },
  ] as const)('persists startup provenance for $state / $reason', async ({ state, reason, expected }) => {
    const f = await fixture();
    await f.records.save({ ...f.run, recovery: undefined, state: 'running', tasks: f.run.tasks.map(task => ({ ...task, state, reason })) });
    f.records.close();
    const next = new MissionRecords(f.root, path.join(f.root, 'missions.sqlite')); stores.push(next);
    await next.initialize([f.session]);
    expect(next.get(f.session.id, f.run.id)).toMatchObject({ state: 'recovering', recovery: { source: expected } });
    next.close();
    const again = new MissionRecords(f.root, path.join(f.root, 'missions.sqlite')); stores.push(again);
    await again.initialize([f.session]);
    expect(again.get(f.session.id, f.run.id).recovery?.source).toBe(expected);
  });

  it.each(['unknown', 'queued', 'blocked', 'assigned', 'running', 'waiting', 'awaiting_approval', 'verifying'] satisfies TaskState[])(
    'quarantines terminal missions containing a %s task', async state => {
      const f = await fixture(); f.snapshot.tasks[1]!.state = state;
      expect(await f.recovery.refresh(f.session.id, f.run.id)).toMatchObject({ status: 'quarantined', reason: 'tasks-nonterminal', run: { state: 'recovering' }, snapshot: { tasks: [{ state: 'completed' }, { state }] } });
    });

  it('rejects nonterminal canonical missions and every recorded lease, including expired leases', async () => {
    const f = await fixture();
    for (const state of ['queued', 'running', 'recovering'] as const) {
      f.snapshot.state = state;
      expect((await f.recovery.refresh(f.session.id, f.run.id)).reason).toBe('canonical-nonterminal');
    }
    f.snapshot.state = 'completed';
    f.snapshot.leases.push({ leaseId: randomUUID(), taskId: f.run.tasks[0]!.taskId, holderAgentId: f.run.tasks[0]!.agentId, acquiredAt: at, expiresAt: at });
    expect((await f.recovery.refresh(f.session.id, f.run.id)).reason).toBe('leases-present');
  });

  it('never infers old authority or clears earlier execution uncertainty', async () => {
    const f = await fixture();
    for (const authority of [undefined, { backend: 'typescript' as const }, { ...f.run.authority!, profileId: 'another' }]) {
      await f.records.save({ ...f.run, ...(authority ? { authority } : { authority: undefined }) });
      expect((await f.recovery.refresh(f.session.id, f.run.id)).reason).toBe(authority === undefined ? 'authority-unknown' : authority.backend === 'typescript' ? 'authority-typescript' : 'profile-mismatch');
    }
    expect(f.read).not.toHaveBeenCalled();
    for (const recovery of [undefined, { source: 'execution-uncertain' as const, at }]) {
      await f.records.save({ ...f.run, recovery });
      expect((await f.recovery.refresh(f.session.id, f.run.id)).reason).toBe('execution-uncertain');
    }
  });

  it('requires exact mission, workspace, task membership and assignees', async () => {
    const f = await fixture(), original = structuredClone(f.snapshot);
    const changes = [
      () => { f.snapshot.missionId = randomUUID(); }, () => { f.snapshot.workspaceId = randomUUID(); },
      () => { f.snapshot.tasks.pop(); }, () => { f.snapshot.tasks.push({ ...f.snapshot.tasks[0]!, taskId: randomUUID() }); },
      () => { f.snapshot.tasks[1]!.taskId = f.snapshot.tasks[0]!.taskId; },
      () => { f.snapshot.tasks[0]!.assignedAgentId = randomUUID(); }, () => { delete f.snapshot.tasks[0]!.assignedAgentId; },
    ];
    for (const change of changes) {
      Object.assign(f.snapshot, structuredClone(original)); change();
      expect(await f.recovery.refresh(f.session.id, f.run.id)).toMatchObject({ status: 'quarantined', reason: 'identity-mismatch' });
      expect(f.records.get(f.session.id, f.run.id).state).toBe('recovering');
    }
    await expect(f.recovery.refresh('foreign-session', f.run.id)).rejects.toThrow('no longer exists');
  });

  it('serializes concurrent refresh and rechecks activity and reservations after the daemon await', async () => {
    const f = await fixture();
    let answer!: (snapshot: DaemonMissionSnapshot) => void;
    f.read.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const first = f.recovery.refresh(f.session.id, f.run.id), second = f.recovery.refresh(f.session.id, f.run.id);
    f.setActive(true); answer(f.snapshot);
    expect((await first).reason).toBe('local-active'); expect((await second).reason).toBe('local-active');
    expect(f.read).toHaveBeenCalledTimes(1);
    f.setActive(false);
    // A preparation reservation is an independent guard, even if no host promise exists.
    vi.spyOn(f.records, 'isReserved').mockReturnValue(true);
    expect((await f.recovery.refresh(f.session.id, f.run.id)).reason).toBe('local-active');
    expect(f.read).toHaveBeenCalledTimes(1);
  });

  it('fails closed on unavailable core or checkpoint writes and permits an idempotent retry', async () => {
    const f = await fixture();
    f.read.mockRejectedValueOnce(new Error('unavailable'));
    expect((await f.recovery.refresh(f.session.id, f.run.id)).reason).toBe('core-unavailable');
    const save = vi.spyOn(f.records, 'save');
    const database = new DatabaseSync(path.join(f.root, 'missions.sqlite'));
    database.exec("CREATE TRIGGER fail_recovery BEFORE INSERT ON mission_changes BEGIN SELECT RAISE(ABORT, 'synthetic recovery storage failure'); END;");
    database.close();
    expect(await f.recovery.refresh(f.session.id, f.run.id)).toMatchObject({ status: 'unavailable', reason: 'checkpoint-unavailable', run: { state: 'recovering' } });
    expect(f.records.get(f.session.id, f.run.id).state).toBe('recovering');
    const retryDatabase = new DatabaseSync(path.join(f.root, 'missions.sqlite'));
    retryDatabase.exec('DROP TRIGGER fail_recovery'); retryDatabase.close();
    expect((await f.recovery.refresh(f.session.id, f.run.id)).run.state).toBe('completed');
    expect(save).toHaveBeenCalledTimes(2);
  });
});

describe('execution observation inspection', () => {
  async function observedFixture() {
    const f = await fixture(), supervisorId = randomUUID();
    const run = { ...f.run, authority: { backend: 'rust' as const, profileId: 'default', workspaceId: f.snapshot.workspaceId, supervisorId }, recovery: { source: 'execution-uncertain' as const, at } };
    await f.records.save(run);
    f.snapshot.state = 'recovering'; f.snapshot.tasks.forEach(task => { task.state = 'unknown'; });
    const executions = { missionId: f.run.id, executions: [{ admission: { missionId: f.run.id, workspaceId: f.snapshot.workspaceId, taskId: f.run.tasks[0]!.taskId, holderAgentId: f.run.tasks[0]!.agentId,
      supervisorId, leaseId: randomUUID(), attempt: 1, missionVersion: 2, taskDigest: 'a'.repeat(64), graphDigest: 'b'.repeat(64), admissionDigest: 'c'.repeat(64), admittedAt: at },
      observation: { observationId: randomUUID(), kind: 'turn-promise-settled' as const, recordedAt: at } }] };
    const readExecutions = vi.fn(async () => structuredClone(executions));
    const recovery = new MissionRecovery({ records: f.records, profileId: 'default', active: () => false, snapshot: f.read, executions: readExecutions });
    return { ...f, executions, readExecutions, recovery };
  }
  it('exposes matching weak observations without clearing genuine uncertainty', async () => {
    const f = await observedFixture();
    expect(await f.recovery.refresh(f.session.id, f.run.id)).toMatchObject({ status: 'quarantined', reason: 'execution-uncertain', run: { state: 'recovering' }, executionInspection: { status: 'available', executions: f.executions.executions } });
    expect(f.records.get(f.session.id, f.run.id).state).toBe('recovering');
  });
  it.each(['supervisorId', 'holderAgentId', 'workspaceId', 'taskId', 'missionId'] as const)('refuses %s evidence without changing the run', async key => {
    const f = await observedFixture(); f.executions.executions[0]!.admission[key] = randomUUID();
    expect(await f.recovery.refresh(f.session.id, f.run.id)).toMatchObject({ run: { state: 'recovering' }, executionInspection: { status: 'unavailable' } });
  });
  it('rechecks reservations after a delayed execution inspection', async () => {
    const f = await observedFixture();
    let resolve!: (value: typeof f.executions) => void;
    f.readExecutions.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = f.recovery.refresh(f.session.id, f.run.id);
    await vi.waitFor(() => expect(f.readExecutions).toHaveBeenCalled());
    vi.spyOn(f.records, 'isReserved').mockReturnValue(true); resolve(f.executions);
    expect((await pending).reason).toBe('local-active');
    expect(f.records.get(f.session.id, f.run.id).state).toBe('recovering');
  });
});

describe('coherent recovery review', () => {
  async function coherentFixture() {
    const f = await fixture(), supervisorId = randomUUID();
    const run = { ...f.run, authority: { backend: 'rust' as const, profileId: 'default', workspaceId: f.snapshot.workspaceId, supervisorId }, recovery: { source: 'execution-uncertain' as const, at } };
    await f.records.save(run);
    f.snapshot.state = 'recovering'; f.snapshot.tasks.forEach(task => { task.state = 'unknown'; });
    const review = { kind: 'extalia-recovery-review-v1' as const, snapshot: structuredClone(f.snapshot), executions: [{ admission: {
      missionId: f.run.id, workspaceId: f.snapshot.workspaceId, taskId: f.run.tasks[0]!.taskId, holderAgentId: f.run.tasks[0]!.agentId,
      supervisorId, leaseId: randomUUID(), attempt: 1, missionVersion: 2, taskDigest: 'a'.repeat(64), graphDigest: 'b'.repeat(64), admissionDigest: 'c'.repeat(64), admittedAt: at,
    } }], missionDigest: 'd'.repeat(64), graphDigest: 'e'.repeat(64), reviewDigest: 'f'.repeat(64), missingAdmissionTaskIds: [f.run.tasks[1]!.taskId], worktreeOwnership: 'unverified' as const };
    const readReview = vi.fn(async () => structuredClone(review)), readExecutions = vi.fn();
    const recovery = new MissionRecovery({ records: f.records, profileId: 'default', active: () => false, snapshot: f.read, executions: readExecutions, review: readReview });
    return { ...f, review, readReview, readExecutions, recovery };
  }
  it('uses only the atomic read and preserves quarantine, results and capacity guards', async () => {
    const f = await coherentFixture();
    const before = f.records.get(f.session.id, f.run.id);
    expect(await f.recovery.refresh(f.session.id, f.run.id)).toMatchObject({ status: 'quarantined', reason: 'execution-uncertain',
      snapshot: f.review.snapshot, executionInspection: { status: 'available', executions: f.review.executions }, reviewInspection: { status: 'available', review: f.review } });
    expect(f.read).not.toHaveBeenCalled(); expect(f.readExecutions).not.toHaveBeenCalled();
    expect(f.records.get(f.session.id, f.run.id)).toEqual(before);
  });
  it('does not fall back to separate reads after a supported review fails', async () => {
    const f = await coherentFixture(); f.readReview.mockRejectedValueOnce(new Error('unavailable'));
    expect(await f.recovery.refresh(f.session.id, f.run.id)).toMatchObject({ status: 'unavailable', reason: 'core-unavailable', reviewInspection: { status: 'unavailable' } });
    expect(f.read).not.toHaveBeenCalled(); expect(f.readExecutions).not.toHaveBeenCalled();
    expect((await f.recovery.refresh(f.session.id, f.run.id)).reviewInspection?.status).toBe('available');
  });
  it('labels separate reads unsupported when the core lacks the new operation', async () => {
    const f = await coherentFixture(); f.readReview.mockResolvedValueOnce(undefined as never);
    expect(await f.recovery.refresh(f.session.id, f.run.id)).toMatchObject({ reviewInspection: { status: 'unsupported' } });
    expect(f.read).toHaveBeenCalledTimes(1); expect(f.readExecutions).toHaveBeenCalledTimes(1);
  });
  it.each(['supervisorId', 'workspaceId', 'taskId', 'holderAgentId', 'missionId'] as const)('refuses mismatched %s without exposing a reviewed identity', async key => {
    const f = await coherentFixture(); f.review.executions[0]!.admission[key] = randomUUID();
    const result = await f.recovery.refresh(f.session.id, f.run.id);
    expect(result).toMatchObject({ reason: 'identity-mismatch', reviewInspection: { status: 'unavailable' }, run: { state: 'recovering' } });
    expect(result).not.toHaveProperty('executionInspection'); expect(result).not.toHaveProperty('snapshot');
  });
  it('rechecks local guards and saved ownership after the review await', async () => {
    const f = await coherentFixture(); let resolve!: (value: typeof f.review) => void;
    f.readReview.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = f.recovery.refresh(f.session.id, f.run.id);
    vi.spyOn(f.records, 'isReserved').mockReturnValue(true); resolve(f.review);
    expect((await pending).reason).toBe('local-active'); expect(f.read).not.toHaveBeenCalled();
    vi.mocked(f.records.isReserved).mockReturnValue(false);
    f.readReview.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const second = f.recovery.refresh(f.session.id, f.run.id);
    await f.records.save({ ...f.run, authority: { backend: 'typescript' } }); resolve(f.review);
    expect((await second).reason).toBe('identity-mismatch');
  });
  it('shows missing legacy admissions without inventing a supervisor or certifying settlement', async () => {
    const f = await coherentFixture(); f.review.executions = []; f.review.missingAdmissionTaskIds = f.run.tasks.map(task => task.taskId);
    const run = f.records.get(f.session.id, f.run.id); await f.records.save({ ...run, authority: { backend: 'rust', profileId: 'default', workspaceId: f.snapshot.workspaceId } });
    const result = await f.recovery.refresh(f.session.id, f.run.id);
    expect(result).toMatchObject({ status: 'quarantined', reviewInspection: { status: 'available', review: { executions: [], missingAdmissionTaskIds: f.review.missingAdmissionTaskIds } } });
    expect(result.run.authority).not.toHaveProperty('supervisorId');
  });
});
