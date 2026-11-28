import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GeneralScheduleManager,
  ScheduleStoreCorruptionError,
  ScheduleStoreDowngradeError,
  type ScheduleRetryContext,
} from '../src/schedules.js';
import {
  buildAutomaticOccurrenceKey,
  ScheduleStore,
  SCHEDULE_STORE_SCHEMA_VERSION,
} from '../src/scheduleStore.js';

type FakeTimer = { callback(): void; delay: number; cancelled: boolean };

const tempDirs: string[] = [];
const managers: GeneralScheduleManager[] = [];
const stores: ScheduleStore[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const manager of managers.splice(0)) {
    await manager.close();
  }
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempRoot(prefix: string): Promise<{ root: string; configDir: string; stateDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(root);
  const configDir = path.join(root, 'config');
  const stateDir = path.join(root, 'state');
  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  return { root, configDir, stateDir };
}

function makeFixture(
  configDir: string,
  stateDir: string,
  initialNowIso = '2026-11-24T10:00:00.000Z',
) {
  let nowMs = Date.parse(initialNowIso);
  const timers: FakeTimer[] = [];
  const prepare = vi.fn(async () => 'ready' as 'ready' | 'connection-unavailable');
  const resolve = vi.fn(async () => ({ sessionId: 's_fixture' } as { sessionId: string; boundSessionId?: string; skippedBusy?: boolean }));
  const dispatch = vi.fn(async () => undefined as void | { deferred: 'connection-unavailable'; retryContext: ScheduleRetryContext } | { correlationId?: string; turnId?: string; executionGeneration?: string; runtimeId?: string });
  let manager!: GeneralScheduleManager;

  const open = async () => {
    manager = new GeneralScheduleManager({
      directory: configDir,
      stateDirectory: stateDir,
      now: () => nowMs,
      setTimer: (callback, delay) => {
        const timer: FakeTimer = { callback, delay, cancelled: false };
        timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: handle => { (handle as unknown as FakeTimer).cancelled = true; },
      callbacks: {
        validateWorkspace: () => undefined,
        prepareExecution: prepare,
        resolveSession: resolve,
        dispatchPrompt: dispatch,
      },
    });
    managers.push(manager);
    await manager.initialize();
    return manager;
  };

  const fireLatest = async () => {
    const timer = [...timers].reverse().find(item => !item.cancelled);
    expect(timer).toBeDefined();
    timer!.cancelled = true;
    timer!.callback();
    await vi.waitFor(() => expect(manager.isBusy).toBe(false));
  };

  return {
    open,
    fireLatest,
    prepare,
    resolve,
    dispatch,
    timers,
    get manager() { return manager; },
    get nowMs() { return nowMs; },
    setNow(isoOrMs: string | number) { nowMs = typeof isoOrMs === 'string' ? Date.parse(isoOrMs) : isoOrMs; },
  };
}

describe('Schedule & Automation vNext — Durable SQLite ledger & lifecycle acceptance (SCH-AT-01..19, 33)', () => {
  it('SCH-AT-01 & SCH-AT-02: migrates legacy v0.4.353 catalog with 0o600 immutable backup, preserves receipts & legacyDispatchCount, and stays idempotent on restart', async () => {
    const { configDir, stateDir } = await makeTempRoot('extalia-sch-at01-');
    const promptId = `sch_${createHash('sha256').update('legacy-prompt-key').digest('hex')}`;
    const legacyPayload = {
      schema: 'extalia.schedules.v1',
      schedules: [
        {
          id: promptId,
          revision: 4,
          workspaceId: 'ws-mig',
          name: 'Legacy Daily Audit',
          prompt: 'Inspect repository health.',
          enabled: true,
          trigger: { kind: 'cron', cron: '0 9 * * 1-5' },
          sessionTarget: { mode: 'create-and-reuse' },
          boundSessionId: 's_bound_42',
          assignment: { leadModel: 'gpt-5', teamMode: 'solo' },
          missedPolicy: 'run-once',
          state: 'scheduled',
          nextRunAt: '2026-11-30T09:00:00.000Z',
          lastRunAt: '2026-11-23T09:00:00.000Z',
          lastOutcome: 'succeeded',
          lastSessionId: 's_bound_42',
          runCount: 7,
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-11-23T09:00:00.000Z',
        },
      ],
      promptCreations: [
        { scheduleId: promptId, fingerprint: 'a'.repeat(64), invalidated: false },
      ],
      recoveries: [
        {
          scheduleId: promptId,
          reason: 'connection-unavailable',
          dueAt: '2026-11-30T08:59:00.000Z',
          retryAt: '2026-11-30T09:00:00.000Z',
          attempt: 2,
          retryContext: { sessionId: 's_bound_42', historySha256: 'b'.repeat(64) },
        },
      ],
    };
    const legacyPath = path.join(configDir, 'schedules.json');
    const legacyBytes = `${JSON.stringify(legacyPayload, null, 2)}\n`;
    await writeFile(legacyPath, legacyBytes);

    const f = makeFixture(configDir, stateDir, '2026-11-24T10:00:00.000Z');
    await f.open();

    // SCH-AT-01: Zero implicit dispatch during migration.
    expect(f.dispatch).not.toHaveBeenCalled();

    // Immutable backup created with 0o600 permissions and exact original bytes.
    const backupPath = path.join(configDir, 'schedules.pre-sqlite.json');
    expect(await readFile(backupPath, 'utf8')).toBe(legacyBytes);
    if (process.platform !== 'win32') {
      expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
      expect((await stat(path.join(stateDir, 'schedules.sqlite'))).mode & 0o777).toBe(0o600);
    }

    const catalog = await f.manager.list();
    expect(catalog.schedules).toHaveLength(1);
    expect(catalog.schedules[0]).toMatchObject({
      id: promptId,
      revision: 4,
      boundSessionId: 's_bound_42',
      runCount: 7,
      legacyDispatchCount: 7,
      recovery: { reason: 'connection-unavailable', attempt: 2 },
    });
    expect(catalog.schedules[0]?.completedRunCount).toBeUndefined();
    expect((await f.manager.listScheduleRuns({ workspaceId: 'ws-mig' })).total).toBe(0);

    // Mutate SQLite by saving a second schedule; legacy schedules.json must remain untouched.
    await f.manager.save({
      workspaceId: 'ws-mig',
      name: 'Post-migration job',
      prompt: 'Check status.',
      enabled: false,
      trigger: { kind: 'interval', intervalMinutes: 60 },
      sessionTarget: { mode: 'new-each-run' },
    });
    expect(await readFile(legacyPath, 'utf8')).toBe(legacyBytes);

    // SCH-AT-02: Restarting is strictly idempotent (no duplicate jobs, backup preserved, zero dispatch).
    const backupStatBefore = await stat(backupPath);
    await f.manager.close();
    await f.open();
    const afterRestart = await f.manager.list();
    expect(afterRestart.schedules).toHaveLength(2);
    expect(afterRestart.schedules.find(item => item.id === promptId)?.legacyDispatchCount).toBe(7);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect((await stat(backupPath)).mtimeMs).toBe(backupStatBefore.mtimeMs);
  });

  it('SCH-AT-08: guarantees unique automatic vs manual occurrence keys and rejects duplicate automatic admission via atomic CAS', async () => {
    const { configDir, stateDir } = await makeTempRoot('extalia-sch-at08-');
    const f = makeFixture(configDir, stateDir, '2026-11-24T10:00:00.000Z');
    await f.open();

    const job = (await f.manager.save({
      workspaceId: 'ws-occ',
      name: 'Concurrent check',
      prompt: 'Run check.',
      enabled: true,
      trigger: { kind: 'interval', intervalMinutes: 30 },
      sessionTarget: { mode: 'existing', sessionId: 's_occ' },
      missedPolicy: 'run-once',
    })).schedules[0]!;

    // Fire manual run before due time with explicit operatorRequestId, then fire due timer.
    f.setNow('2026-11-24T10:15:00.000Z');
    await f.manager.runNow(job.id, job.revision, 'op-req-1');
    f.setNow('2026-11-24T10:30:00.000Z');
    await f.fireLatest();

    const page = await f.manager.listScheduleRuns({ workspaceId: 'ws-occ', scheduleId: job.id });
    expect(page.total).toBe(2);
    const manualRun = page.runs.find(run => run.occurrenceKind === 'manual')!;
    const autoRun = page.runs.find(run => run.occurrenceKind === 'automatic')!;
    expect(manualRun.occurrenceKey).toBe(`manual:${job.id}:op-req-1`);
    expect(autoRun.occurrenceKey).toBe(buildAutomaticOccurrenceKey(job.id, '2026-11-24T10:30:00.000Z', 1));

    // Reusing the same operatorRequestId or automatic key is refused atomically by SQLite UNIQUE constraint.
    const latestJob = (await f.manager.list()).schedules[0]!;
    await expect(f.manager.runNow(latestJob.id, latestJob.revision, 'op-req-1')).rejects.toThrow(/already admitted/);

    await f.manager.close();
    const store = await ScheduleStore.open(path.join(stateDir, 'schedules.sqlite'));
    stores.push(store);
    const dup = store.admitOccurrence({
      scheduleId: job.id,
      scheduleRevision: latestJob.revision,
      occurrenceKey: autoRun.occurrenceKey,
      occurrenceKind: 'automatic',
      scheduledFor: '2026-11-24T10:30:00.000Z',
      workspaceId: 'ws-occ',
      nowIso: '2026-11-24T10:30:05.000Z',
    });
    expect(dup.admitted).toBe(false);
    if (!dup.admitted) expect(dup.reason).toBe('already-exists');
  });

  it('SCH-AT-09 & SCH-AT-10: enforces safe no-work proof for deferred retry, quarantines interrupted admitting/dispatched/running runs as unknown on crash without replay, and requires CAS for operator review', async () => {
    const { configDir, stateDir } = await makeTempRoot('extalia-sch-at09-');
    const sqlitePath = path.join(stateDir, 'schedules.sqlite');
    const store = await ScheduleStore.open(sqlitePath);
    stores.push(store);

    // 1. Pre-dispatch deferred occurrence: refuses re-admission without safeNoWorkProof, succeeds with proof.
    const defKey = buildAutomaticOccurrenceKey('sch_1', '2026-11-24T10:00:00.000Z', 1);
    const admitted = store.admitOccurrence({
      scheduleId: 'sch_1',
      scheduleRevision: 1,
      occurrenceKey: defKey,
      occurrenceKind: 'automatic',
      scheduledFor: '2026-11-24T10:00:00.000Z',
      workspaceId: 'ws-crash',
      nowIso: '2026-11-24T10:00:00.000Z',
    });
    expect(admitted.admitted).toBe(true);
    if (!admitted.admitted) throw new Error('expected admitted');
    const deferredRun = store.markRunDeferred(admitted.run.id, admitted.run.revision, {
      statusReason: 'connection-unavailable',
      nowIso: '2026-11-24T10:00:01.000Z',
    });
    expect(deferredRun.state).toBe('deferred');

    const refusedWithoutProof = store.admitOccurrence({
      scheduleId: 'sch_1',
      scheduleRevision: 1,
      occurrenceKey: defKey,
      occurrenceKind: 'automatic',
      scheduledFor: '2026-11-24T10:00:00.000Z',
      workspaceId: 'ws-crash',
      nowIso: '2026-11-24T10:01:00.000Z',
      safeNoWorkProof: false,
    });
    expect(refusedWithoutProof.admitted).toBe(false);
    if (!refusedWithoutProof.admitted) expect(refusedWithoutProof.reason).toBe('missing-no-work-proof');

    const retriedWithProof = store.admitOccurrence({
      scheduleId: 'sch_1',
      scheduleRevision: 1,
      occurrenceKey: defKey,
      occurrenceKind: 'automatic',
      scheduledFor: '2026-11-24T10:00:00.000Z',
      workspaceId: 'ws-crash',
      nowIso: '2026-11-24T10:01:00.000Z',
      safeNoWorkProof: true,
    });
    expect(retriedWithProof.admitted).toBe(true);
    if (!retriedWithProof.admitted) throw new Error('expected retried');
    expect(retriedWithProof.run.attemptCount).toBe(2);

    // 2. Simulate crash while one run is `admitting` and another is `dispatched` / `running`.
    const dispatchedKey = buildAutomaticOccurrenceKey('sch_2', '2026-11-24T10:05:00.000Z', 1);
    const adm2 = store.admitOccurrence({
      scheduleId: 'sch_2',
      scheduleRevision: 1,
      occurrenceKey: dispatchedKey,
      occurrenceKind: 'automatic',
      scheduledFor: '2026-11-24T10:05:00.000Z',
      workspaceId: 'ws-crash',
      nowIso: '2026-11-24T10:05:00.000Z',
    });
    if (!adm2.admitted) throw new Error('expected admitted');
    const disp2 = store.markRunDispatched(adm2.run.id, adm2.run.revision, {
      sessionId: 's_active',
      correlationId: 'corr-2',
      nowIso: '2026-11-24T10:05:01.000Z',
    });
    store.recordTurnBound(disp2.id, { sessionId: 's_active', turnId: 'turn-2', correlationId: 'corr-2', nowIso: '2026-11-24T10:05:02.000Z' });
    store.close();
    stores.pop();

    // Restart via GeneralScheduleManager: both interrupted runs become `unknown` with ZERO dispatch replay.
    const f = makeFixture(configDir, stateDir, '2026-11-24T10:10:00.000Z');
    await f.open();
    expect(f.dispatch).not.toHaveBeenCalled();

    const unknownPage = await f.manager.listScheduleRuns({ workspaceId: 'ws-crash', state: 'unknown' });
    expect(unknownPage.total).toBe(2);
    const quarantined = unknownPage.runs.find(run => run.id === disp2.id)!;
    expect(quarantined.state).toBe('unknown');
    expect(quarantined.verification).toBe('not-checked');
    expect(quarantined.statusReason).toMatch(/Host restarted/);

    // Stale revision review is rejected; valid CAS review records decision without fabricating `completed` or `passed`.
    await expect(
      f.manager.reviewUnknownScheduleRun(quarantined.id, quarantined.revision - 1, { action: 'acknowledge' }),
    ).rejects.toThrow(/changed/);

    const reviewed = await f.manager.reviewUnknownScheduleRun(quarantined.id, quarantined.revision, {
      action: 'dismiss-for-new-run',
      note: 'Checked session transcript; safe to run a fresh occurrence.',
    });
    expect(reviewed.run.state).toBe('unknown');
    expect(reviewed.run.verification).toBe('not-checked');
    expect(reviewed.run.reviewDecision).toBe('dismiss-for-new-run');
    expect(reviewed.run.reviewNote).toBe('Checked session transcript; safe to run a fresh occurrence.');
    expect(reviewed.run.reviewedAt).toBe('2026-11-24T10:10:00.000Z');
  });

  it('SCH-AT-11: coalesces 40 missed cron slots into one catch-up run (run-once) or zero dispatches (skip)', async () => {
    const { configDir, stateDir } = await makeTempRoot('extalia-sch-at11-');
    const f = makeFixture(configDir, stateDir, '2026-11-01T00:00:00.000Z');
    await f.open();

    const catchUpJob = (await f.manager.save({
      workspaceId: 'ws-missed',
      name: 'Hourly catch-up',
      prompt: 'Catch up once.',
      enabled: true,
      trigger: { kind: 'cron', cron: '0 * * * *', timeZone: 'UTC' },
      sessionTarget: { mode: 'existing', sessionId: 's_1' },
      missedPolicy: 'run-once',
    })).schedules.find(item => item.name === 'Hourly catch-up')!;

    const skipJob = (await f.manager.save({
      workspaceId: 'ws-missed',
      name: 'Hourly skip',
      prompt: 'Skip when offline.',
      enabled: true,
      trigger: { kind: 'cron', cron: '0 * * * *', timeZone: 'UTC' },
      sessionTarget: { mode: 'existing', sessionId: 's_2' },
      missedPolicy: 'skip',
    })).schedules.find(item => item.name === 'Hourly skip')!;

    await f.manager.close();

    // Advance 40 hours offline (40 missed hourly slots) and restart.
    f.setNow('2026-11-02T16:30:00.000Z');
    await f.open();
    await vi.waitFor(() => expect(f.manager.isBusy).toBe(false));

    expect(f.dispatch).toHaveBeenCalledTimes(1);
    const catalog = await f.manager.list();
    expect(catalog.schedules.find(item => item.id === catchUpJob.id)).toMatchObject({
      runCount: 1,
      nextRunAt: '2026-11-02T17:00:00.000Z',
    });
    expect(catalog.schedules.find(item => item.id === skipJob.id)).toMatchObject({
      runCount: 0,
      lastOutcome: 'missed',
      nextRunAt: '2026-11-02T17:00:00.000Z',
    });

    const catchUpRuns = await f.manager.listScheduleRuns({ workspaceId: 'ws-missed', scheduleId: catchUpJob.id });
    expect(catchUpRuns.total).toBe(1);
    expect(catchUpRuns.runs[0]?.occurrenceKind).toBe('catch-up');
    expect((await f.manager.listScheduleRuns({ workspaceId: 'ws-missed', scheduleId: skipJob.id })).total).toBe(0);
  });

  it('SCH-AT-12, SCH-AT-13, SCH-AT-14, SCH-AT-15: tracks busy deferral, connection deferral with retryContext, post-dispatch failure, and deleted target session without replay', async () => {
    const { configDir, stateDir } = await makeTempRoot('extalia-sch-at12-');
    const f = makeFixture(configDir, stateDir, '2026-11-24T10:00:00.000Z');
    await f.open();

    // SCH-AT-12: Busy existing session defers the same run record and retries once idle.
    const busyJob = (await f.manager.save({
      workspaceId: 'ws-rec',
      name: 'Busy target job',
      prompt: 'Run when idle.',
      enabled: true,
      trigger: { kind: 'interval', intervalMinutes: 60 },
      sessionTarget: { mode: 'existing', sessionId: 's_busy' },
      missedPolicy: 'run-once',
    })).schedules[0]!;

    f.resolve.mockResolvedValueOnce({ sessionId: 's_busy', skippedBusy: true });
    f.setNow('2026-11-24T11:00:00.000Z');
    await f.fireLatest();
    let busyRuns = await f.manager.listScheduleRuns({ workspaceId: 'ws-rec', scheduleId: busyJob.id });
    expect(busyRuns.total).toBe(1);
    expect(busyRuns.runs[0]).toMatchObject({ state: 'deferred', attemptCount: 1, statusReason: 'skipped-busy' });

    f.resolve.mockResolvedValueOnce({ sessionId: 's_busy' });
    f.setNow('2026-11-24T11:01:00.000Z');
    await f.fireLatest();
    busyRuns = await f.manager.listScheduleRuns({ workspaceId: 'ws-rec', scheduleId: busyJob.id });
    expect(busyRuns.total).toBe(1);
    expect(busyRuns.runs[0]).toMatchObject({ state: 'dispatched', attemptCount: 2, sessionId: 's_busy' });

    // Pause busyJob so the next timer tick targets connJob deterministically.
    const latestBusy = (await f.manager.list()).schedules.find(item => item.id === busyJob.id)!;
    await f.manager.setEnabled(latestBusy.id, false, latestBusy.revision);

    // SCH-AT-13: Connection unavailable before work defers safely with preserved retryContext, then dispatches once.
    const connJob = (await f.manager.save({
      workspaceId: 'ws-rec',
      name: 'Conn retry job',
      prompt: 'Run when connected.',
      enabled: true,
      trigger: { kind: 'interval', intervalMinutes: 60 },
      sessionTarget: { mode: 'new-each-run' },
      missedPolicy: 'run-once',
    })).schedules.find(item => item.name === 'Conn retry job')!;

    const ctx: ScheduleRetryContext = { sessionId: 's_pending_new', historySha256: 'c'.repeat(64) };
    f.resolve.mockResolvedValueOnce({ sessionId: 's_pending_new' });
    f.dispatch.mockResolvedValueOnce({ deferred: 'connection-unavailable', retryContext: ctx });
    f.setNow('2026-11-24T12:01:00.000Z');
    await f.fireLatest();
    let connRuns = await f.manager.listScheduleRuns({ workspaceId: 'ws-rec', scheduleId: connJob.id });
    expect(connRuns.total).toBe(1);
    expect(connRuns.runs[0]).toMatchObject({ state: 'deferred', statusReason: 'deferred-connection', attemptCount: 1 });

    f.resolve.mockResolvedValueOnce({ sessionId: 's_pending_new' });
    f.dispatch.mockResolvedValueOnce({ correlationId: 'corr-conn-ok' });
    f.setNow('2026-11-24T12:02:00.000Z');
    await f.fireLatest();
    connRuns = await f.manager.listScheduleRuns({ workspaceId: 'ws-rec', scheduleId: connJob.id });
    expect(connRuns.total).toBe(1);
    expect(connRuns.runs[0]).toMatchObject({ state: 'dispatched', attemptCount: 2, sessionId: 's_pending_new', correlationId: 'corr-conn-ok' });

    // SCH-AT-14: Failure after stream/tool (dispatch rejection) records terminal `failed` with zero auto-replay.
    const failJob = (await f.manager.save({
      workspaceId: 'ws-rec',
      name: 'Stream fail job',
      prompt: 'Review diffs.',
      enabled: false,
      trigger: { kind: 'interval', intervalMinutes: 60 },
      sessionTarget: { mode: 'existing', sessionId: 's_fail' },
      missedPolicy: 'run-once',
    })).schedules.find(item => item.name === 'Stream fail job')!;
    f.resolve.mockResolvedValueOnce({ sessionId: 's_fail' });
    f.dispatch.mockRejectedValueOnce(new Error('Provider disconnected mid-stream.'));
    await expect(f.manager.runNow(failJob.id, failJob.revision)).rejects.toThrow(/mid-stream/);
    const failRuns = await f.manager.listScheduleRuns({ workspaceId: 'ws-rec', scheduleId: failJob.id });
    expect(failRuns.total).toBe(1);
    expect(failRuns.runs[0]).toMatchObject({ state: 'failed', statusReason: 'Provider disconnected mid-stream.' });

    // SCH-AT-15: Deleted target session fails closed with no dispatch and no substitute conversation.
    const missingJob = (await f.manager.save({
      workspaceId: 'ws-rec',
      name: 'Deleted target job',
      prompt: 'Run in deleted session.',
      enabled: false,
      trigger: { kind: 'interval', intervalMinutes: 60 },
      sessionTarget: { mode: 'existing', sessionId: 's_deleted' },
      missedPolicy: 'run-once',
    })).schedules.find(item => item.name === 'Deleted target job')!;
    const dispatchesBefore = f.dispatch.mock.calls.length;
    f.resolve.mockRejectedValueOnce(new Error('That target session no longer exists in this workspace.'));
    await expect(f.manager.runNow(missingJob.id, missingJob.revision)).rejects.toThrow(/no longer exists/);
    expect(f.dispatch.mock.calls.length).toBe(dispatchesBefore);
    const missingRuns = await f.manager.listScheduleRuns({ workspaceId: 'ws-rec', scheduleId: missingJob.id });
    expect(missingRuns.total).toBe(1);
    expect(missingRuns.runs[0]).toMatchObject({ state: 'failed', statusReason: 'That target session no longer exists in this workspace.' });
  });

  it('SCH-AT-16, SCH-AT-17, SCH-AT-18: splits dispatch from turn settlement, refuses unrelated session/correlation settlement, keeps verification not-checked until trusted evidence is recorded', async () => {
    const { configDir, stateDir } = await makeTempRoot('extalia-sch-at16-');
    const f = makeFixture(configDir, stateDir, '2026-11-24T10:00:00.000Z');
    await f.open();

    const job = (await f.manager.save({
      workspaceId: 'ws-corr',
      name: 'Correlated review',
      prompt: 'Audit build health.',
      enabled: false,
      trigger: { kind: 'interval', intervalMinutes: 60 },
      sessionTarget: { mode: 'existing', sessionId: 's_target' },
    })).schedules[0]!;

    f.resolve.mockResolvedValueOnce({ sessionId: 's_target' });
    f.dispatch.mockResolvedValueOnce({
      runtimeId: 'extalia-native',
      correlationId: 'corr_exact_1',
      executionGeneration: 'gen_1',
    });
    await f.manager.runNow(job.id, job.revision);

    // After dispatch: run is `dispatched` (NOT `completed`), verification is `not-checked`.
    const runAfterDispatch = (await f.manager.listScheduleRuns({ workspaceId: 'ws-corr', scheduleId: job.id })).runs[0]!;
    expect(runAfterDispatch.state).toBe('dispatched');
    expect(runAfterDispatch.verification).toBe('not-checked');
    expect(runAfterDispatch.correlationId).toBe('corr_exact_1');
    expect(runAfterDispatch.executionGeneration).toBe('gen_1');

    // Bind turn start (`dispatched -> running`).
    const running = await f.manager.recordTurnStarted(runAfterDispatch.id, {
      sessionId: 's_target',
      turnId: 'turn_99',
      correlationId: 'corr_exact_1',
      executionGeneration: 'gen_1',
    });
    expect(running.state).toBe('running');
    expect(running.turnId).toBe('turn_99');

    // SCH-AT-16: Unrelated session, mismatched correlationId, mismatched turnId, or mismatched generation MUST be refused.
    await expect(
      f.manager.recordTurnSettled({ runId: running.id, sessionId: 's_other', correlationId: 'corr_exact_1', executionGeneration: 'gen_1' }, 'completed'),
    ).rejects.toThrow(/unrelated sessionId/);
    await expect(
      f.manager.recordTurnSettled({ runId: running.id, sessionId: 's_target', correlationId: 'corr_wrong', executionGeneration: 'gen_1' }, 'completed'),
    ).rejects.toThrow(/correlationId/);
    await expect(
      f.manager.recordTurnSettled({ runId: running.id, sessionId: 's_target', correlationId: 'corr_exact_1', turnId: 'turn_other', executionGeneration: 'gen_1' }, 'completed'),
    ).rejects.toThrow(/turnId/);
    await expect(
      f.manager.recordTurnSettled({ runId: running.id, sessionId: 's_target', correlationId: 'corr_exact_1', executionGeneration: 'gen_wrong' }, 'completed'),
    ).rejects.toThrow(/executionGeneration/);

    // Run must still be `running`!
    expect((await f.manager.scheduleRunDetail(running.id))?.run.state).toBe('running');

    // SCH-AT-17: Exact correlation settles turn as `completed`, but verification remains `not-checked`.
    const settled = await f.manager.recordTurnSettled(
      { sessionId: 's_target', correlationId: 'corr_exact_1', turnId: 'turn_99', executionGeneration: 'gen_1' },
      'completed',
      { terminalEvidenceRef: 'event:ev_turn_99_done' },
    );
    expect(settled.state).toBe('completed');
    expect(settled.verification).toBe('not-checked');
    expect(settled.terminalEvidenceRef).toBe('event:ev_turn_99_done');
    expect((await f.manager.list()).schedules[0]?.completedRunCount).toBe(1);

    // SCH-AT-18: `passed` verification requires explicit trusted evidenceRef; absence fails closed.
    await expect(f.manager.recordVerification(settled.id, 'passed')).rejects.toThrow(/evidence reference/);
    const verified = await f.manager.recordVerification(settled.id, 'passed', {
      evidenceRef: 'receipt:vitest-suite-sha256-abc',
    });
    expect(verified.verification).toBe('passed');
    expect(verified.verificationEvidenceRef).toBe('receipt:vitest-suite-sha256-abc');

    // Deleting the schedule preserves immutable run history for audit.
    const latest = (await f.manager.list()).schedules[0]!;
    await f.manager.delete(latest.id, latest.revision);
    const detailAfterDelete = await f.manager.scheduleRunDetail(verified.id);
    expect(detailAfterDelete?.run.state).toBe('completed');
    expect(detailAfterDelete?.run.verification).toBe('passed');
  });

  it('SCH-AT-19: fails closed on SQLite storage corruption and blocks new admissions', async () => {
    const { configDir, stateDir } = await makeTempRoot('extalia-sch-at19-');
    const sqlitePath = path.join(stateDir, 'schedules.sqlite');
    await writeFile(sqlitePath, 'NOT-A-VALID-SQLITE-DATABASE-BYTES');

    const f = makeFixture(configDir, stateDir);
    await expect(f.open()).rejects.toThrow(ScheduleStoreCorruptionError);

    const catalog = await f.manager.list();
    expect(catalog.problem).toBe('storage-unavailable');
    await expect(
      f.manager.save({
        workspaceId: 'ws-corrupt',
        name: 'Blocked job',
        prompt: 'Should fail closed.',
        trigger: { kind: 'interval', intervalMinutes: 60 },
        sessionTarget: { mode: 'new-each-run' },
      }),
    ).rejects.toThrow(/storage is unavailable/);
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it('SCH-AT-33: refuses unsafe schema downgrade when database version exceeds supported version without modifying DB bytes', async () => {
    const { configDir, stateDir } = await makeTempRoot('extalia-sch-at33-');
    const sqlitePath = path.join(stateDir, 'schedules.sqlite');

    // Create a newer-version SQLite database (v99) and record its exact SHA-256.
    const futureDb = new DatabaseSync(sqlitePath);
    futureDb.exec('CREATE TABLE schedule_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT');
    futureDb.prepare("INSERT INTO schedule_meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEDULE_STORE_SCHEMA_VERSION + 98));
    futureDb.exec(`PRAGMA user_version = ${SCHEDULE_STORE_SCHEMA_VERSION + 98}`);
    futureDb.close();
    const digestBefore = createHash('sha256').update(await readFile(sqlitePath)).digest('hex');

    await expect(ScheduleStore.open(sqlitePath)).rejects.toThrow(ScheduleStoreDowngradeError);
    const f = makeFixture(configDir, stateDir);
    await expect(f.open()).rejects.toThrow(/Refused unsafe downgrade/);

    // Verify the newer database was NOT overwritten or altered.
    const digestAfter = createHash('sha256').update(await readFile(sqlitePath)).digest('hex');
    expect(digestAfter).toBe(digestBefore);
    expect((await f.manager.list()).problem).toBe('storage-unavailable');
  });

  it('paginates workspace-scoped runs and exposes delivery receipts in run detail', async () => {
    const { configDir, stateDir } = await makeTempRoot('extalia-sch-page-');
    const f = makeFixture(configDir, stateDir, '2026-11-24T10:00:00.000Z');
    await f.open();

    const jobA = (await f.manager.save({
      workspaceId: 'ws-alpha',
      name: 'Alpha job',
      prompt: 'Alpha work.',
      enabled: false,
      trigger: { kind: 'interval', intervalMinutes: 60 },
      sessionTarget: { mode: 'existing', sessionId: 's_a' },
    })).schedules[0]!;
    const jobB = (await f.manager.save({
      workspaceId: 'ws-beta',
      name: 'Beta job',
      prompt: 'Beta work.',
      enabled: false,
      trigger: { kind: 'interval', intervalMinutes: 60 },
      sessionTarget: { mode: 'existing', sessionId: 's_b' },
    })).schedules.find(item => item.workspaceId === 'ws-beta')!;

    for (let i = 0; i < 3; i++) {
      f.setNow(Date.parse('2026-11-24T10:00:00.000Z') + i * 1_000);
      const currentA = (await f.manager.list()).schedules.find(item => item.id === jobA.id)!;
      await f.manager.runNow(currentA.id, currentA.revision, `req-a-${i}`);
    }
    await f.manager.runNow(jobB.id, jobB.revision, 'req-b-0');

    const page1 = await f.manager.listScheduleRuns({ workspaceId: 'ws-alpha', limit: 2 });
    expect(page1.total).toBe(3);
    expect(page1.runs).toHaveLength(2);
    expect(page1.runs.every(run => run.workspaceId === 'ws-alpha')).toBe(true);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await f.manager.listScheduleRuns({ workspaceId: 'ws-alpha', limit: 2, cursor: page1.nextCursor });
    expect(page2.runs).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();

    // Record a delivery receipt directly via ScheduleStore and inspect via detail.
    const runId = page1.runs[0]!.id;
    await f.manager.close();
    const store = await ScheduleStore.open(path.join(stateDir, 'schedules.sqlite'));
    stores.push(store);
    store.recordDelivery({
      runId,
      destinationBindingId: 'bind_1',
      destinationRevision: 1,
      notificationKind: 'terminal-summary',
      targetGuildId: 'guild_1',
      targetChannelId: 'chan_1',
      payloadDigest: 'd'.repeat(64),
      state: 'sent',
      attemptCount: 1,
      discordMessageId: 'msg_1001',
      acknowledgedAt: '2026-11-24T10:05:00.000Z',
    });
    const detail = store.getRunDetail(runId);
    expect(detail?.scheduleName).toBe('Alpha job');
    expect(detail?.deliveries).toHaveLength(1);
    expect(detail?.deliveries[0]).toMatchObject({ state: 'sent', discordMessageId: 'msg_1001' });
  });

  it('rolls back both single-schedule upsert and run transition when runAtomic throws mid-transaction', async () => {
    const { configDir, stateDir } = await makeTempRoot('extalia-sch-atomic-');
    const f = makeFixture(configDir, stateDir, '2026-11-24T10:00:00.000Z');
    await f.open();

    const saved = (await f.manager.save({
      workspaceId: 'ws_ledger',
      name: 'Atomic job',
      prompt: 'Ping',
      enabled: true,
      trigger: { kind: 'once', runAt: '2026-11-24T10:05:00.000Z' },
      sessionTarget: { mode: 'existing', sessionId: 's_1' },
      missedPolicy: 'run-once',
    })).schedules[0]!;
    await f.manager.close();

    const store = await ScheduleStore.open(path.join(stateDir, 'schedules.sqlite'));
    stores.push(store);

    expect(() => store.runAtomic(() => {
      const admission = store.admitOccurrence({
        scheduleId: saved.id,
        scheduleRevision: saved.revision + 1,
        occurrenceKey: `manual:${saved.id}:req_atomic_rollback`,
        occurrenceKind: 'manual',
        scheduledFor: '2026-11-24T10:00:00.000Z',
        requestedAt: '2026-11-24T10:00:00.000Z',
        workspaceId: saved.workspaceId,
        nowIso: '2026-11-24T10:00:00.000Z',
      });
      expect(admission.admitted).toBe(true);
      store.upsertScheduleState({
        schedule: { ...saved, revision: saved.revision + 1, state: 'running' },
      });
      throw new Error('Injected mid-transaction failure');
    })).toThrow('Injected mid-transaction failure');

    const after = store.readCatalogState().schedules.find(item => item.id === saved.id)!;
    expect(after.revision).toBe(saved.revision);
    expect(after.state).toBe('scheduled');
    expect(store.listRuns({ workspaceId: saved.workspaceId, scheduleId: saved.id }).runs).toEqual([]);
  });
});
