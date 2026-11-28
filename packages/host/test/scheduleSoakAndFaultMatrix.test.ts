import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GENERAL_SCHEDULE_LIMITS,
  SCHEDULE_REVIEW_ACTIONS,
  type GeneralSchedule,
  type ScheduleAgentAssignment,
  type ScheduleReviewAction,
  type ScheduleRunV1,
} from '@extalia/platform';
import {
  GeneralScheduleManager,
  ScheduleStoreDowngradeError,
  type ScheduleExecutionTarget,
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

function makeHarness(configDir: string, stateDir: string, initialNowIso: string) {
  let nowMs = Date.parse(initialNowIso);
  let correlationSeq = 0;
  const timers: FakeTimer[] = [];
  const activeTimers = new Set<FakeTimer>();
  const prepare = vi.fn(async (_schedule: GeneralSchedule, _manual: boolean, _retryContext?: ScheduleRetryContext) => 'ready' as 'ready' | 'connection-unavailable');
  const resolve = vi.fn(async (schedule: GeneralSchedule, _manual: boolean, _retryContext?: ScheduleRetryContext): Promise<ScheduleExecutionTarget> => ({
    sessionId: schedule.sessionTarget.mode === 'existing' ? schedule.sessionTarget.sessionId : `s_auto_${schedule.id}`,
  }));
  const dispatch = vi.fn(async (_sessionId: string, _prompt: string, _assignment: ScheduleAgentAssignment, _retryContext?: ScheduleRetryContext) => ({
    runtimeId: 'extalia-native',
    correlationId: `corr_${++correlationSeq}`,
    executionGeneration: 'gen_soak_1',
  }));
  let manager!: GeneralScheduleManager;

  const open = async () => {
    manager = new GeneralScheduleManager({
      directory: configDir,
      stateDirectory: stateDir,
      now: () => nowMs,
      setTimer: (callback, delay) => {
        const timer: FakeTimer = { callback, delay, cancelled: false };
        timers.push(timer);
        activeTimers.add(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: handle => {
        const timer = handle as unknown as FakeTimer;
        timer.cancelled = true;
        activeTimers.delete(timer);
      },
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

  const settle = async () => {
    for (let i = 0; i < 32 && manager.isBusy; i++) {
      await Promise.resolve();
    }
    if (manager.isBusy) {
      const deadline = Date.now() + 10_000;
      while (manager.isBusy && Date.now() < deadline) {
        await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate));
      }
      expect(manager.isBusy).toBe(false);
    }
  };

  const advanceUntil = async (endIsoOrMs: string | number) => {
    const endMs = typeof endIsoOrMs === 'string' ? Date.parse(endIsoOrMs) : endIsoOrMs;
    while (nowMs <= endMs) {
      let active: FakeTimer | undefined;
      for (const timer of activeTimers) {
        active = timer;
      }
      if (!active) break;
      const nextTickMs = nowMs + active.delay;
      if (nextTickMs > endMs) {
        nowMs = endMs;
        break;
      }
      nowMs = nextTickMs;
      active.cancelled = true;
      activeTimers.delete(active);
      active.callback();
      await settle();
    }
  };

  return {
    open,
    settle,
    advanceUntil,
    prepare,
    resolve,
    dispatch,
    timers,
    get manager() { return manager; },
    get nowMs() { return nowMs; },
    setNow(isoOrMs: string | number) {
      nowMs = typeof isoOrMs === 'string' ? Date.parse(isoOrMs) : isoOrMs;
    },
  };
}

async function collectAllRuns(manager: GeneralScheduleManager, workspaceId: string): Promise<ScheduleRunV1[]> {
  const runs: ScheduleRunV1[] = [];
  let cursor: string | undefined;
  do {
    const page = await manager.listScheduleRuns({ workspaceId, limit: GENERAL_SCHEDULE_LIMITS.maxRunPageLimit, ...(cursor ? { cursor } : {}) });
    runs.push(...page.runs);
    cursor = page.nextCursor;
  } while (cursor);
  return runs;
}

function formatZonedParts(utcIso: string, timeZone: string): { date: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(Date.parse(utcIso)));
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? '';
  const hour = pick('hour') === '24' ? '00' : pick('hour');
  return { date: `${pick('year')}-${pick('month')}-${pick('day')}`, hour, minute: pick('minute') };
}

describe('Schedule & Automation vNext — 64-job 24h DST soak, crash/restart fault matrix & rollback (WP-SCH-12, SCH-AT-20, 32, 33)', () => {
  it('WP-SCH-12 / SCH-AT-32: executes 64 active multi-timezone schedules across 24h US spring-forward soak with zero duplicate occurrence keys and clean timer teardown', async () => {
    const { configDir, stateDir } = await makeTempRoot('extalia-sch-soak-');
    const h = makeHarness(configDir, stateDir, '2026-03-08T00:00:00.000Z');
    await h.open();

    const zones = ['UTC', 'America/New_York', 'Europe/Berlin', 'Asia/Jakarta', 'Pacific/Auckland'] as const;
    const hourlyCronIdsByZone = new Map<string, string[]>(zones.map(zone => [zone, []]));
    const intervalIds: string[] = [];
    const onceIds: string[] = [];

    // 40 hourly cron jobs (8 per IANA zone)
    for (const zone of zones) {
      for (let i = 0; i < 8; i++) {
        const name = `Hourly ${zone} #${i + 1}`;
        const created = (await h.manager.save({
          workspaceId: 'ws-soak',
          name,
          prompt: `Check ${zone} hourly #${i + 1}.`,
          enabled: true,
          trigger: { kind: 'cron', cron: '0 * * * *', timeZone: zone, dstPolicy: 'each-valid-instant' },
          sessionTarget: { mode: 'existing', sessionId: `s_cron_${zone}_${i}` },
          missedPolicy: 'run-once',
        })).schedules.find(item => item.name === name)!;
        hourlyCronIdsByZone.get(zone)!.push(created.id);
      }
    }

    // 15 three-hour interval jobs (3 per timezone bucket)
    for (let i = 0; i < 15; i++) {
      const name = `Interval 3h #${i + 1}`;
      const created = (await h.manager.save({
        workspaceId: 'ws-soak',
        name,
        prompt: `Check interval #${i + 1}.`,
        enabled: true,
        trigger: { kind: 'interval', intervalMinutes: 180 },
        sessionTarget: { mode: 'existing', sessionId: `s_int_${i}` },
        missedPolicy: 'run-once',
      })).schedules.find(item => item.name === name)!;
      intervalIds.push(created.id);
    }

    // 9 once jobs scheduled inside the 24-hour soak window
    for (let i = 0; i < 9; i++) {
      const name = `Once #${i + 1}`;
      const runAt = new Date(Date.parse('2026-03-08T00:30:00.000Z') + i * 2 * 3_600_000).toISOString();
      const created = (await h.manager.save({
        workspaceId: 'ws-soak',
        name,
        prompt: `Run once #${i + 1}.`,
        enabled: true,
        trigger: { kind: 'once', runAt },
        sessionTarget: { mode: 'existing', sessionId: `s_once_${i}` },
        missedPolicy: 'run-once',
      })).schedules.find(item => item.name === name)!;
      onceIds.push(created.id);
    }

    const seededCatalog = await h.manager.list();
    expect(seededCatalog.schedules).toHaveLength(GENERAL_SCHEDULE_LIMITS.schedules);

    // Advance 24 simulated UTC hours across 2026-03-08T00:00:00Z -> 2026-03-09T00:00:00Z
    await h.advanceUntil('2026-03-09T00:00:00.000Z');
    await h.settle();

    const catalogAt24h = await h.manager.list();
    const byId = new Map(catalogAt24h.schedules.map(item => [item.id, item]));
    const runsAt24h = await collectAllRuns(h.manager, 'ws-soak');

    // 40 * 24 + 15 * 8 + 9 * 1 = 1089 runs
    expect(runsAt24h).toHaveLength(1089);
    expect(new Set(runsAt24h.map(run => run.occurrenceKey)).size).toBe(runsAt24h.length);
    expect(h.prepare.mock.calls.length).toBe(1089);
    expect(h.resolve.mock.calls.length).toBe(1089);
    expect(h.dispatch.mock.calls.length).toBe(1089);

    for (const id of onceIds) {
      const job = byId.get(id)!;
      expect(job.runCount).toBe(1);
      expect(job.enabled).toBe(false);
      expect(job.state).toBe('completed');
      expect(job.nextRunAt).toBeUndefined();
      expect(runsAt24h.filter(run => run.scheduleId === id)).toHaveLength(1);
    }

    for (const id of intervalIds) {
      const job = byId.get(id)!;
      expect(job.runCount).toBe(8);
      expect(job.nextRunAt).toBe('2026-03-09T03:00:00.000Z');
      expect(runsAt24h.filter(run => run.scheduleId === id)).toHaveLength(8);
    }

    for (const zone of zones) {
      for (const id of hourlyCronIdsByZone.get(zone)!) {
        const job = byId.get(id)!;
        expect(job.runCount).toBe(24);
        expect(job.nextRunAt).toBe('2026-03-09T01:00:00.000Z');
      }
    }

    // Continue 3h59m to finish the full 2026-03-08 local calendar day in America/New_York (05:00Z -> 03:00Z).
    await h.advanceUntil('2026-03-09T03:59:00.000Z');
    await h.settle();
    const runsThroughNyDay = await collectAllRuns(h.manager, 'ws-soak');
    expect(new Set(runsThroughNyDay.map(run => run.occurrenceKey)).size).toBe(runsThroughNyDay.length);

    // On America/New_York spring-forward day (2026-03-08), 02:00 is skipped -> exactly 23 hourly firings on 2026-03-08.
    for (const nyId of hourlyCronIdsByZone.get('America/New_York')!) {
      const nyMarch8Runs = runsThroughNyDay.filter(
        run => run.scheduleId === nyId && formatZonedParts(run.scheduledFor, 'America/New_York').date === '2026-03-08',
      );
      expect(nyMarch8Runs).toHaveLength(23);
      const nyHours = nyMarch8Runs.map(run => formatZonedParts(run.scheduledFor, 'America/New_York').hour);
      expect(nyHours).not.toContain('02');
      expect(nyHours).toContain('01');
      expect(nyHours).toContain('03');
    }

    // Contrast: UTC hourly jobs had 24 firings inside their 24h UTC day (01:00Z..00:00Z).
    for (const utcId of hourlyCronIdsByZone.get('UTC')!) {
      const utcFirst24hRuns = runsAt24h.filter(run => run.scheduleId === utcId);
      expect(utcFirst24hRuns).toHaveLength(24);
    }

    // Closing GeneralScheduleManager cleanly cancels every remaining timer.
    await h.manager.close();
    expect(h.timers.filter(timer => !timer.cancelled)).toEqual([]);
  }, 90_000);

  it('SCH-AT-20 / SCH-AT-06: executes both repeated 01:30 EDT/EST occurrences and all 25 wall-clock hours on US fall-back day (2026-11-01)', async () => {
    const { configDir, stateDir } = await makeTempRoot('extalia-sch-fallback-');
    // Start 1 minute before 2026-11-01T04:00:00Z (00:00 EDT) so the full 25-hour fall-back day is observed.
    const h = makeHarness(configDir, stateDir, '2026-11-01T03:59:00.000Z');
    await h.open();

    const hourly = (await h.manager.save({
      workspaceId: 'ws-fallback',
      name: 'NY fall-back hourly',
      prompt: 'Check hourly across fall-back.',
      enabled: true,
      trigger: { kind: 'cron', cron: '0 * * * *', timeZone: 'America/New_York', dstPolicy: 'each-valid-instant' },
      sessionTarget: { mode: 'existing', sessionId: 's_ny_hourly' },
      missedPolicy: 'run-once',
    })).schedules[0]!;

    const halfPastOne = (await h.manager.save({
      workspaceId: 'ws-fallback',
      name: 'NY fall-back 01:30',
      prompt: 'Run at both 01:30 EDT and 01:30 EST.',
      enabled: true,
      trigger: { kind: 'cron', cron: '30 1 * * *', timeZone: 'America/New_York', dstPolicy: 'each-valid-instant' },
      sessionTarget: { mode: 'existing', sessionId: 's_ny_0130' },
      missedPolicy: 'run-once',
    })).schedules.find(item => item.name === 'NY fall-back 01:30')!;

    await h.advanceUntil('2026-11-01T10:00:00.000Z');
    await h.settle();

    const foldRuns = await collectAllRuns(h.manager, 'ws-fallback');
    const halfPastRuns = foldRuns
      .filter(run => run.scheduleId === halfPastOne.id)
      .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
    expect(halfPastRuns.map(run => run.scheduledFor)).toEqual([
      '2026-11-01T05:30:00.000Z', // 01:30 EDT (UTC-04:00)
      '2026-11-01T06:30:00.000Z', // 01:30 EST (UTC-05:00)
    ]);
    expect(new Set(halfPastRuns.map(run => run.occurrenceKey)).size).toBe(2);

    const hourlyWindowRuns = foldRuns
      .filter(run => run.scheduleId === hourly.id)
      .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
    expect(hourlyWindowRuns.map(run => run.scheduledFor)).toEqual([
      '2026-11-01T04:00:00.000Z',
      '2026-11-01T05:00:00.000Z', // 01:00 EDT
      '2026-11-01T06:00:00.000Z', // 01:00 EST
      '2026-11-01T07:00:00.000Z',
      '2026-11-01T08:00:00.000Z',
      '2026-11-01T09:00:00.000Z',
      '2026-11-01T10:00:00.000Z',
    ]);

    // Finish the full 25-hour local day (through 2026-11-01 23:00 EST = 2026-11-02T04:00:00Z).
    await h.advanceUntil('2026-11-02T04:00:00.000Z');
    await h.settle();

    const fullDayRuns = await collectAllRuns(h.manager, 'ws-fallback');
    const nyDayHourly = fullDayRuns.filter(
      run => run.scheduleId === hourly.id && formatZonedParts(run.scheduledFor, 'America/New_York').date === '2026-11-01',
    );
    expect(nyDayHourly).toHaveLength(25);
    expect(new Set(fullDayRuns.map(run => run.occurrenceKey)).size).toBe(fullDayRuns.length);

    const finalHalfPast = (await h.manager.list()).schedules.find(item => item.id === halfPastOne.id)!;
    expect(finalHalfPast.runCount).toBe(2);
    expect(finalHalfPast.nextRunAt).toBe('2026-11-02T06:30:00.000Z');

    await h.manager.close();
    expect(h.timers.filter(timer => !timer.cancelled)).toEqual([]);
  }, 90_000);

  it('WP-SCH-12: quarantines every interrupted non-terminal state without auto-replay after abrupt crash, preserves deferred/pending slots, and resolves via explicit manual review', async () => {
    const { configDir, stateDir } = await makeTempRoot('extalia-sch-fault-matrix-');
    const initialIso = '2026-11-24T10:00:00.000Z';
    const h1 = makeHarness(configDir, stateDir, initialIso);
    await h1.open();

    // Create jobs covering each non-terminal state in ScheduleStore:
    // 1. unclosed abrupt crash while `dispatched` (skipping h1.manager.close())
    const jobUnclosed = (await h1.manager.save({
      workspaceId: 'ws-matrix',
      name: 'Unclosed dispatched job',
      prompt: 'Crash before close.',
      enabled: true,
      trigger: { kind: 'interval', intervalMinutes: 60 },
      sessionTarget: { mode: 'existing', sessionId: 's_unclosed' },
      missedPolicy: 'run-once',
    })).schedules.at(-1)!;

    // 2..6. Additional jobs whose ledger states we drive into admitting, dispatched, running (+ pending delivery), deferred, and pending.
    const makeJob = async (name: string, sessionId: string) => (await h1.manager.save({
      workspaceId: 'ws-matrix',
      name,
      prompt: `Task ${name}.`,
      enabled: true,
      trigger: { kind: 'interval', intervalMinutes: 60 },
      sessionTarget: { mode: 'existing', sessionId },
      missedPolicy: 'run-once',
    })).schedules.find(item => item.name === name)!;

    const jobAdmitting = await makeJob('Admitting crash job', 's_adm');
    const jobDispatched = await makeJob('Dispatched crash job', 's_disp');
    const jobRunning = await makeJob('Running crash job', 's_run');
    const jobDeferred = await makeJob('Deferred job', 's_def');
    const jobPending = await makeJob('Pending slot job', 's_pend');

    // Trigger jobUnclosed via real manager execution so it leaves `dispatched` in SQLite,
    // and intentionally DO NOT call h1.manager.close() before reopening a fresh host instance.
    h1.setNow('2026-11-24T11:00:00.000Z');
    const unclosedLatest = (await h1.manager.list()).schedules.find(item => item.id === jobUnclosed.id)!;
    await h1.manager.runNow(unclosedLatest.id, unclosedLatest.revision, 'op-unclosed');
    expect(h1.dispatch).toHaveBeenCalledTimes(1);

    // Inject the remaining matrix states directly into schedules.sqlite while the crashed host never closed cleanly.
    const rawStore = await ScheduleStore.open(path.join(stateDir, 'schedules.sqlite'));
    stores.push(rawStore);

    const admRun = rawStore.admitOccurrence({
      scheduleId: jobAdmitting.id,
      scheduleRevision: jobAdmitting.revision,
      occurrenceKey: buildAutomaticOccurrenceKey(jobAdmitting.id, '2026-11-24T11:00:00.000Z', 1),
      occurrenceKind: 'automatic',
      scheduledFor: '2026-11-24T11:00:00.000Z',
      workspaceId: 'ws-matrix',
      sessionId: 's_adm',
      nowIso: '2026-11-24T11:00:00.000Z',
    });
    expect(admRun.admitted).toBe(true);

    const dispAdmit = rawStore.admitOccurrence({
      scheduleId: jobDispatched.id,
      scheduleRevision: jobDispatched.revision,
      occurrenceKey: buildAutomaticOccurrenceKey(jobDispatched.id, '2026-11-24T11:00:00.000Z', 1),
      occurrenceKind: 'automatic',
      scheduledFor: '2026-11-24T11:00:00.000Z',
      workspaceId: 'ws-matrix',
      nowIso: '2026-11-24T11:00:00.000Z',
    });
    if (!dispAdmit.admitted) throw new Error('expected dispAdmit');
    const dispRun = rawStore.markRunDispatched(dispAdmit.run.id, dispAdmit.run.revision, {
      sessionId: 's_disp',
      correlationId: 'corr_disp_crash',
      executionGeneration: 'gen_1',
      nowIso: '2026-11-24T11:00:01.000Z',
    });

    const runAdmit = rawStore.admitOccurrence({
      scheduleId: jobRunning.id,
      scheduleRevision: jobRunning.revision,
      occurrenceKey: buildAutomaticOccurrenceKey(jobRunning.id, '2026-11-24T11:00:00.000Z', 1),
      occurrenceKind: 'automatic',
      scheduledFor: '2026-11-24T11:00:00.000Z',
      workspaceId: 'ws-matrix',
      nowIso: '2026-11-24T11:00:00.000Z',
    });
    if (!runAdmit.admitted) throw new Error('expected runAdmit');
    const runDispatched = rawStore.markRunDispatched(runAdmit.run.id, runAdmit.run.revision, {
      sessionId: 's_run',
      correlationId: 'corr_run_crash',
      executionGeneration: 'gen_1',
      nowIso: '2026-11-24T11:00:01.000Z',
    });
    const runBound = rawStore.recordTurnBound(runDispatched.id, {
      sessionId: 's_run',
      turnId: 'turn_run_crash',
      correlationId: 'corr_run_crash',
      executionGeneration: 'gen_1',
      nowIso: '2026-11-24T11:00:02.000Z',
    });
    rawStore.recordDelivery({
      runId: runBound.id,
      destinationBindingId: 'bind_matrix',
      destinationRevision: 1,
      notificationKind: 'terminal-summary',
      targetGuildId: 'guild_1',
      targetChannelId: 'chan_1',
      payloadDigest: 'f'.repeat(64),
      state: 'pending',
      attemptCount: 0,
      nowIso: '2026-11-24T11:00:02.000Z',
    });

    const defAdmit = rawStore.admitOccurrence({
      scheduleId: jobDeferred.id,
      scheduleRevision: jobDeferred.revision,
      occurrenceKey: buildAutomaticOccurrenceKey(jobDeferred.id, '2026-11-24T11:00:00.000Z', 1),
      occurrenceKind: 'automatic',
      scheduledFor: '2026-11-24T11:00:00.000Z',
      workspaceId: 'ws-matrix',
      nowIso: '2026-11-24T11:00:00.000Z',
    });
    if (!defAdmit.admitted) throw new Error('expected defAdmit');
    const defRun = rawStore.markRunDeferred(defAdmit.run.id, defAdmit.run.revision, {
      statusReason: 'connection-unavailable',
      sessionId: 's_def',
      nowIso: '2026-11-24T11:00:01.000Z',
    });

    const pendRun = rawStore.createPendingOccurrence({
      scheduleId: jobPending.id,
      scheduleRevision: jobPending.revision,
      occurrenceKey: buildAutomaticOccurrenceKey(jobPending.id, '2026-11-24T12:00:00.000Z', 1),
      occurrenceKind: 'automatic',
      scheduledFor: '2026-11-24T12:00:00.000Z',
      workspaceId: 'ws-matrix',
      nowIso: '2026-11-24T11:00:00.000Z',
    });

    // Also mark admitting/dispatched/running catalog rows as `running` (as before abrupt crash),
    // and attach a future recovery receipt for jobDeferred.
    const catalogNow = rawStore.readCatalogState();
    const updatedCatalog = catalogNow.schedules.map(item => {
      if (item.id === jobAdmitting.id || item.id === jobDispatched.id || item.id === jobRunning.id) {
        return {
          ...item,
          state: 'running' as const,
          nextRunAt: '2026-11-24T11:00:00.000Z',
        };
      }
      if (item.id === jobDeferred.id) {
        return {
          ...item,
          nextRunAt: '2026-11-24T11:05:00.000Z',
        };
      }
      if (item.id === jobPending.id) {
        return {
          ...item,
          nextRunAt: '2026-11-24T12:00:00.000Z',
        };
      }
      return item;
    });
    rawStore.replaceCatalogState({
      schedules: updatedCatalog,
      promptCreations: catalogNow.promptCreations,
      recoveries: [
        {
          scheduleId: jobDeferred.id,
          reason: 'connection-unavailable',
          dueAt: '2026-11-24T11:00:00.000Z',
          retryAt: '2026-11-24T11:05:00.000Z',
          attempt: 1,
          runId: defRun.id,
        },
      ],
      triggerGenerations: catalogNow.triggerGenerations,
    });
    rawStore.close();
    stores.pop();

    // Open a fresh GeneralScheduleManager WITHOUT having called h1.manager.close()!
    const h2 = makeHarness(configDir, stateDir, '2026-11-24T11:02:00.000Z');
    await h2.open();
    await h2.settle();

    // Zero auto-replay on restart!
    expect(h2.dispatch).not.toHaveBeenCalled();

    const unknownPage = await h2.manager.listScheduleRuns({ workspaceId: 'ws-matrix', state: 'unknown' });
    expect(unknownPage.total).toBe(4);
    const quarantinedIds = new Set(unknownPage.runs.map(run => run.scheduleId));
    expect(quarantinedIds).toEqual(new Set([jobUnclosed.id, jobAdmitting.id, jobDispatched.id, jobRunning.id]));

    for (const run of unknownPage.runs) {
      expect(run.state).toBe('unknown');
      expect(run.verification).toBe('not-checked');
      expect(run.statusReason).toMatch(/Host restarted/);
    }

    // Pending outbound delivery on the interrupted running attempt stays intact and inspectable.
    const runningDetail = await h2.manager.scheduleRunDetail(runBound.id);
    expect(runningDetail?.deliveries).toHaveLength(1);
    expect(runningDetail?.deliveries[0]).toMatchObject({ state: 'pending', targetChannelId: 'chan_1' });

    // Deferred and pending runs were NOT prematurely quarantined.
    expect((await h2.manager.scheduleRunDetail(defRun.id))?.run.state).toBe('deferred');
    expect((await h2.manager.scheduleRunDetail(pendRun.id))?.run.state).toBe('pending');

    // Next scheduled slot waits cleanly (11:03 < 11:05 / 12:00 -> zero dispatches).
    await h2.advanceUntil('2026-11-24T11:03:00.000Z');
    expect(h2.dispatch).not.toHaveBeenCalled();

    // Verify all 3 explicit ScheduleReviewAction decisions resolve quarantine honestly without fabricating completion/verification.
    const runsToReview = [
      unknownPage.runs.find(r => r.scheduleId === jobAdmitting.id)!,
      unknownPage.runs.find(r => r.id === dispRun.id)!,
      unknownPage.runs.find(r => r.id === runBound.id)!,
    ];
    const actions: readonly ScheduleReviewAction[] = SCHEDULE_REVIEW_ACTIONS;
    for (let i = 0; i < actions.length; i++) {
      const targetRun = runsToReview[i]!;
      const action = actions[i]!;
      const reviewed = await h2.manager.reviewUnknownScheduleRun(targetRun.id, targetRun.revision, {
        action,
        note: `Reviewed via ${action}`,
      });
      expect(reviewed.run.state).toBe('unknown');
      expect(reviewed.run.verification).toBe('not-checked');
      expect(reviewed.run.reviewDecision).toBe(action);
      expect(reviewed.run.reviewNote).toBe(`Reviewed via ${action}`);
      expect(reviewed.run.reviewedAt).toBe('2026-11-24T11:03:00.000Z');
    }

    // Manual Run now after `dismiss-for-new-run` admits a brand new occurrence key without touching the quarantined run.
    const latestRunJob = (await h2.manager.list()).schedules.find(item => item.id === jobRunning.id)!;
    expect(latestRunJob.nextRunAt).toBe('2026-11-24T12:00:00.000Z');
    await h2.manager.runNow(latestRunJob.id, latestRunJob.revision, 'op-after-review');
    expect(h2.dispatch).toHaveBeenCalledTimes(1);

    const jobRunningRuns = await h2.manager.listScheduleRuns({ workspaceId: 'ws-matrix', scheduleId: jobRunning.id });
    expect(jobRunningRuns.total).toBe(2);
    expect(jobRunningRuns.runs.map(r => r.state).sort()).toEqual(['dispatched', 'unknown']);

    await h2.manager.close();
  });

  it('SCH-AT-32 & SCH-AT-33: keeps immutable 0o600 schedules.pre-sqlite.json backup, refuses schema downgrade without mutating DB bytes, and recovers cleanly on rollback', async () => {
    const { configDir, stateDir } = await makeTempRoot('extalia-sch-rollback-');
    const promptId = `sch_${createHash('sha256').update('rollback-prompt-key').digest('hex')}`;
    const legacyPayload = {
      schema: 'extalia.schedules.v1',
      schedules: [
        {
          id: promptId,
          revision: 3,
          workspaceId: 'ws-rb',
          name: 'Legacy Cron Audit',
          prompt: 'Audit workspace.',
          enabled: true,
          trigger: { kind: 'cron', cron: '0 9 * * 1-5' },
          sessionTarget: { mode: 'create-and-reuse' },
          boundSessionId: 's_rb_bound',
          assignment: { teamMode: 'workspace' },
          missedPolicy: 'run-once',
          state: 'scheduled',
          nextRunAt: '2026-12-01T09:00:00.000Z',
          lastRunAt: '2026-11-23T09:00:00.000Z',
          lastOutcome: 'succeeded',
          lastSessionId: 's_rb_bound',
          runCount: 12,
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-11-23T09:00:00.000Z',
        },
        {
          id: 'sch_legacy_interval_2',
          revision: 1,
          workspaceId: 'ws-rb',
          name: 'Legacy Interval Pulse',
          prompt: 'Check status.',
          enabled: true,
          trigger: { kind: 'interval', intervalMinutes: 120 },
          sessionTarget: { mode: 'new-each-run' },
          assignment: { teamMode: 'solo' },
          missedPolicy: 'skip',
          state: 'scheduled',
          nextRunAt: '2026-12-01T10:00:00.000Z',
          runCount: 4,
          createdAt: '2026-10-15T00:00:00.000Z',
          updatedAt: '2026-11-23T10:00:00.000Z',
        },
      ],
      promptCreations: [
        { scheduleId: promptId, fingerprint: 'a'.repeat(64), invalidated: false },
      ],
    };

    const legacyJsonPath = path.join(configDir, 'schedules.json');
    const legacyBytes = Buffer.from(`${JSON.stringify(legacyPayload, null, 2)}\n`, 'utf8');
    await writeFile(legacyJsonPath, legacyBytes);

    const h1 = makeHarness(configDir, stateDir, '2026-11-24T10:00:00.000Z');
    await h1.open();
    expect(h1.dispatch).not.toHaveBeenCalled();

    const backupPath = path.join(configDir, 'schedules.pre-sqlite.json');
    const backupBytes = await readFile(backupPath);
    expect(Buffer.compare(backupBytes, legacyBytes)).toBe(0);
    if (process.platform !== 'win32') {
      expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
    }

    // Save a post-migration schedule; immutable backup must stay byte-exact.
    await h1.manager.save({
      workspaceId: 'ws-rb',
      name: 'Post-SQLite Job',
      prompt: 'Newer vNext job.',
      enabled: true,
      trigger: { kind: 'cron', cron: '0 8 * * *', timeZone: 'UTC', dstPolicy: 'each-valid-instant' },
      sessionTarget: { mode: 'new-each-run' },
    });
    expect(Buffer.compare(await readFile(backupPath), legacyBytes)).toBe(0);
    await h1.manager.close();

    // Bump SQLite schema_version & user_version above SCHEDULE_STORE_SCHEMA_VERSION to simulate downgrade.
    const sqlitePath = path.join(stateDir, 'schedules.sqlite');
    const futureVersion = SCHEDULE_STORE_SCHEMA_VERSION + 1;
    const db = new DatabaseSync(sqlitePath);
    db.prepare("UPDATE schedule_meta SET value = ? WHERE key = 'schema_version'").run(String(futureVersion));
    db.exec(`PRAGMA user_version = ${futureVersion}`);
    db.close();

    const dbBytesBefore = await readFile(sqlitePath);
    const dbDigestBefore = createHash('sha256').update(dbBytesBefore).digest('hex');
    const dbMtimeBefore = (await stat(sqlitePath)).mtimeMs;

    await expect(ScheduleStore.open(sqlitePath)).rejects.toThrow(ScheduleStoreDowngradeError);
    const hDowngrade = makeHarness(configDir, stateDir, '2026-11-24T10:05:00.000Z');
    await expect(hDowngrade.open()).rejects.toThrow(ScheduleStoreDowngradeError);
    expect((await hDowngrade.manager.list()).problem).toBe('storage-unavailable');

    const dbBytesAfter = await readFile(sqlitePath);
    expect(createHash('sha256').update(dbBytesAfter).digest('hex')).toBe(dbDigestBefore);
    expect(Buffer.compare(dbBytesAfter, dbBytesBefore)).toBe(0);
    expect((await stat(sqlitePath)).mtimeMs).toBe(dbMtimeBefore);

    // Rollback verification: restore schedules.pre-sqlite.json to schedules.json in a clean rollback state directory.
    const rollbackRoot = await makeTempRoot('extalia-sch-clean-rollback-');
    await writeFile(path.join(rollbackRoot.configDir, 'schedules.json'), backupBytes);

    const hRollback = makeHarness(rollbackRoot.configDir, rollbackRoot.stateDir, '2026-11-24T10:10:00.000Z');
    await hRollback.open();
    expect(hRollback.dispatch).not.toHaveBeenCalled();

    const recovered = await hRollback.manager.list();
    expect(recovered.schedules).toHaveLength(2);
    expect(recovered.schedules.find(item => item.id === promptId)).toMatchObject({
      id: promptId,
      revision: 3,
      name: 'Legacy Cron Audit',
      boundSessionId: 's_rb_bound',
      runCount: 12,
      legacyDispatchCount: 12,
      trigger: { kind: 'cron', cron: '0 9 * * 1-5' },
    });
    expect(recovered.schedules.find(item => item.id === 'sch_legacy_interval_2')).toMatchObject({
      id: 'sch_legacy_interval_2',
      revision: 1,
      name: 'Legacy Interval Pulse',
      runCount: 4,
      legacyDispatchCount: 4,
      missedPolicy: 'skip',
    });
    await hRollback.manager.close();
  });
});
