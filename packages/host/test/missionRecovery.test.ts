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
