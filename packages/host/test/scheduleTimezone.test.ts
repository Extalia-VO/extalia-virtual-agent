import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isValidIanaTimeZone,
  nextCronRunAt,
  nextScheduleRunAt,
  normalizeScheduleTrigger,
  previewScheduleNextRuns,
  type ScheduleTrigger,
} from '@extalia/platform';
import { GeneralScheduleManager } from '../src/schedules.js';

type FakeTimer = { callback(): void; delay: number; cancelled: boolean };

const tempDirs: string[] = [];
const managers: GeneralScheduleManager[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const manager of managers.splice(0)) {
    await manager.close();
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempRoot(prefix: string): Promise<{ configDir: string; stateDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(root);
  const configDir = path.join(root, 'config');
  const stateDir = path.join(root, 'state');
  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  return { configDir, stateDir };
}

describe('Schedule & Automation vNext — IANA timezones, DST policy, and interval anchoring', () => {
  it('validates IANA timezones and rejects invalid identifiers', () => {
    expect(isValidIanaTimeZone('UTC')).toBe(true);
    expect(isValidIanaTimeZone('America/New_York')).toBe(true);
    expect(isValidIanaTimeZone('Asia/Jakarta')).toBe(true);
    expect(isValidIanaTimeZone('Australia/Lord_Howe')).toBe(true);

    expect(isValidIanaTimeZone('')).toBe(false);
    expect(isValidIanaTimeZone('Invalid/Timezone')).toBe(false);
    expect(isValidIanaTimeZone('+07:00')).toBe(false);
    expect(isValidIanaTimeZone(' America/New_York ')).toBe(false);
    expect(isValidIanaTimeZone('UTC\n')).toBe(false);

    expect(() => normalizeScheduleTrigger({ kind: 'cron', cron: '0 9 * * *', timeZone: 'Mars/Olympus' })).toThrow(/Invalid IANA time zone/);
    expect(() => normalizeScheduleTrigger({ kind: 'cron', cron: '0 9 * * *', timeZone: 'UTC', dstPolicy: 'skip-second' as never })).toThrow(/Unsupported cron DST policy/);
    expect(() => nextCronRunAt('0 9 * * *', Date.parse('2026-01-01T00:00:00.000Z'), 'No/Such_Zone')).toThrow(/Invalid IANA time zone/);

    // Preserves legacy cron normalization shape when timeZone is omitted.
    expect(normalizeScheduleTrigger({ kind: 'cron', cron: '0 9 * * 1-5' })).toEqual({ kind: 'cron', cron: '0 9 * * 1-5' });
    expect(normalizeScheduleTrigger({ kind: 'cron', cron: '0 9 * * 1-5', timeZone: 'Asia/Jakarta', dstPolicy: 'each-valid-instant' })).toEqual({
      kind: 'cron',
      cron: '0 9 * * 1-5',
      timeZone: 'Asia/Jakarta',
      dstPolicy: 'each-valid-instant',
    });
  });

  it('SCH-AT-03: preserves legacy host-local cron without silent shift and exposes migration timezone drift diagnostics', async () => {
    const { configDir, stateDir } = await makeTempRoot('extalia-sch-at03-');
    const legacyJson = {
      schema: 'extalia.schedules.v1',
      schedules: [
        {
          id: 'sch_legacy_tz_1',
          revision: 2,
          workspaceId: 'ws-tz',
          name: 'Legacy morning job',
          prompt: 'Summarize open work.',
          enabled: true,
          trigger: { kind: 'cron', cron: '0 9 * * *' },
          sessionTarget: { mode: 'existing', sessionId: 's_legacy' },
          assignment: { teamMode: 'workspace' },
          missedPolicy: 'run-once',
          state: 'scheduled',
          nextRunAt: '2026-12-01T02:00:00.000Z',
          runCount: 3,
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-01T00:00:00.000Z',
        },
      ],
    };
    await writeFile(path.join(configDir, 'schedules.json'), JSON.stringify(legacyJson, null, 2));

    // Migrate while host is in Asia/Jakarta.
    vi.stubEnv('TZ', 'Asia/Jakarta');
    const nowMs = Date.parse('2026-11-24T00:00:00.000Z');
    const first = new GeneralScheduleManager({
      directory: configDir,
      stateDirectory: stateDir,
      now: () => nowMs,
      setTimer: () => setTimeout(() => undefined, 3_600_000),
      clearTimer: t => clearTimeout(t),
      callbacks: {
        validateWorkspace: () => undefined,
        resolveSession: async () => ({ sessionId: 's_legacy' }),
        dispatchPrompt: async () => undefined,
      },
    });
    managers.push(first);
    await first.initialize();
    const migratedCatalog = await first.list();
    expect(migratedCatalog.schedules[0]?.trigger).toEqual({ kind: 'cron', cron: '0 9 * * *' });
    expect(migratedCatalog.schedules[0]?.nextRunAt).toBe('2026-12-01T02:00:00.000Z');
    const diagBefore = await first.migrationDiagnostics();
    expect(diagBefore.migrated).toBe(true);
    expect(diagBefore.migratedHostTimeZone).toBe('Asia/Jakarta');
    expect(diagBefore.hostTimeZoneChanged).toBe(false);
    await first.close();

    // Reopen under a different host timezone (America/New_York): planned nextRunAt is NOT silently shifted.
    vi.stubEnv('TZ', 'America/New_York');
    const second = new GeneralScheduleManager({
      directory: configDir,
      stateDirectory: stateDir,
      now: () => nowMs,
      setTimer: () => setTimeout(() => undefined, 3_600_000),
      clearTimer: t => clearTimeout(t),
      callbacks: {
        validateWorkspace: () => undefined,
        resolveSession: async () => ({ sessionId: 's_legacy' }),
        dispatchPrompt: async () => undefined,
      },
    });
    managers.push(second);
    await second.initialize();
    const reopenedCatalog = await second.list();
    expect(reopenedCatalog.schedules[0]?.trigger).toEqual({ kind: 'cron', cron: '0 9 * * *' });
    expect(reopenedCatalog.schedules[0]?.nextRunAt).toBe('2026-12-01T02:00:00.000Z');

    const diagAfter = await second.migrationDiagnostics();
    expect(diagAfter.migratedHostTimeZone).toBe('Asia/Jakarta');
    expect(diagAfter.currentHostTimeZone).toBe('America/New_York');
    expect(diagAfter.hostTimeZoneChanged).toBe(true);

    const preview = second.previewScheduleNextRuns(reopenedCatalog.schedules[0]!.trigger, 2, nowMs);
    expect(preview.usedFallbackTimeZone).toBe(true);
    expect(preview.timeZone).toBe('America/New_York');
    expect(preview.notes.some(note => note.includes('fallback host timezone'))).toBe(true);
  });

  it('SCH-AT-04: computes exact next 5 UTC instants across two independent IANA zones regardless of host TZ', () => {
    vi.stubEnv('TZ', 'UTC');
    const fromMs = Date.parse('2026-01-05T00:00:00.000Z');

    const nyTrigger: ScheduleTrigger = { kind: 'cron', cron: '0 9 * * 1-5', timeZone: 'America/New_York', dstPolicy: 'each-valid-instant' };
    const nyPreview = previewScheduleNextRuns(nyTrigger, 5, fromMs);
    expect(nyPreview.timeZone).toBe('America/New_York');
    expect(nyPreview.usedFallbackTimeZone).toBe(false);
    expect(nyPreview.runs.map(item => item.utc)).toEqual([
      '2026-01-05T14:00:00.000Z',
      '2026-01-06T14:00:00.000Z',
      '2026-01-07T14:00:00.000Z',
      '2026-01-08T14:00:00.000Z',
      '2026-01-09T14:00:00.000Z',
    ]);
    expect(nyPreview.runs[0]?.localTime).toBe('2026-01-05 09:00 (UTC-05:00)');

    const jktTrigger: ScheduleTrigger = { kind: 'cron', cron: '30 8 * * 1-5', timeZone: 'Asia/Jakarta', dstPolicy: 'each-valid-instant' };
    const jktPreview = previewScheduleNextRuns(jktTrigger, 5, fromMs);
    expect(jktPreview.timeZone).toBe('Asia/Jakarta');
    expect(jktPreview.usedFallbackTimeZone).toBe(false);
    expect(jktPreview.runs.map(item => item.utc)).toEqual([
      '2026-01-05T01:30:00.000Z',
      '2026-01-06T01:30:00.000Z',
      '2026-01-07T01:30:00.000Z',
      '2026-01-08T01:30:00.000Z',
      '2026-01-09T01:30:00.000Z',
    ]);
    expect(jktPreview.runs[0]?.localTime).toBe('2026-01-05 08:30 (UTC+07:00)');

    // Verify nextScheduleRunAt agrees identically with preview regardless of host TZ.
    vi.stubEnv('TZ', 'Pacific/Auckland');
    expect(nextScheduleRunAt(nyTrigger, fromMs)).toBe('2026-01-05T14:00:00.000Z');
    expect(nextScheduleRunAt(jktTrigger, fromMs)).toBe('2026-01-05T01:30:00.000Z');
  });

  it('SCH-AT-05: advances past DST spring-forward skipped local time and annotates the preview', () => {
    vi.stubEnv('TZ', 'UTC');
    // America/New_York springs forward on 2026-03-08 from 02:00 EST to 03:00 EDT; 02:30 never exists.
    const trigger: ScheduleTrigger = { kind: 'cron', cron: '30 2 * * *', timeZone: 'America/New_York', dstPolicy: 'each-valid-instant' };
    const beforeGap = Date.parse('2026-03-08T05:00:00.000Z'); // 00:00 EST

    expect(nextScheduleRunAt(trigger, beforeGap)).toBe('2026-03-09T06:30:00.000Z');

    const preview = previewScheduleNextRuns(trigger, 3, beforeGap);
    expect(preview.runs.map(item => item.utc)).toEqual([
      '2026-03-09T06:30:00.000Z',
      '2026-03-10T06:30:00.000Z',
      '2026-03-11T06:30:00.000Z',
    ]);
    expect(preview.runs[0]?.localTime).toBe('2026-03-09 02:30 (UTC-04:00)');
    expect(preview.runs[0]?.dstNote).toBe('after-skipped-gap');
    expect(preview.notes.some(note => note.includes('spring-forward'))).toBe(true);
  });

  it('SCH-AT-06: yields two distinct UTC occurrences and distinct occurrence keys across DST fall-back fold', async () => {
    vi.stubEnv('TZ', 'UTC');
    // America/New_York falls back on 2026-11-01 at 02:00 EDT -> 01:00 EST; 01:30 occurs twice.
    const trigger: ScheduleTrigger = { kind: 'cron', cron: '30 1 * * *', timeZone: 'America/New_York', dstPolicy: 'each-valid-instant' };
    const beforeFold = Date.parse('2026-11-01T05:00:00.000Z'); // 01:00 EDT

    const preview = previewScheduleNextRuns(trigger, 3, beforeFold);
    expect(preview.runs).toEqual([
      {
        utc: '2026-11-01T05:30:00.000Z',
        localTime: '2026-11-01 01:30 (UTC-04:00)',
        timeZone: 'America/New_York',
        dstNote: 'repeated-first',
      },
      {
        utc: '2026-11-01T06:30:00.000Z',
        localTime: '2026-11-01 01:30 (UTC-05:00)',
        timeZone: 'America/New_York',
        dstNote: 'repeated-second',
      },
      {
        utc: '2026-11-02T06:30:00.000Z',
        localTime: '2026-11-02 01:30 (UTC-05:00)',
        timeZone: 'America/New_York',
      },
    ]);
    expect(preview.notes.some(note => note.includes('each-valid-instant'))).toBe(true);

    // Also verify half-hour DST fold in Australia/Lord_Howe (2026-04-04 01:45 occurs twice).
    const lordHowe: ScheduleTrigger = { kind: 'cron', cron: '45 1 * * *', timeZone: 'Australia/Lord_Howe', dstPolicy: 'each-valid-instant' };
    const lhPreview = previewScheduleNextRuns(lordHowe, 2, Date.parse('2026-04-04T14:30:00.000Z'));
    expect(lhPreview.runs.map(item => item.utc)).toEqual([
      '2026-04-04T14:45:00.000Z',
      '2026-04-04T15:15:00.000Z',
    ]);
    expect(lhPreview.runs.map(item => item.dstNote)).toEqual(['repeated-first', 'repeated-second']);

    // Verify end-to-end in GeneralScheduleManager: both fall-back instants execute with unique occurrenceKeys.
    const { configDir, stateDir } = await makeTempRoot('extalia-sch-at06-');
    let nowMs = beforeFold;
    const timers: FakeTimer[] = [];
    const dispatches: string[] = [];
    const manager = new GeneralScheduleManager({
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
        resolveSession: async () => ({ sessionId: 's_fold' }),
        dispatchPrompt: async () => { dispatches.push(new Date(nowMs).toISOString()); },
      },
    });
    managers.push(manager);
    await manager.initialize();
    const saved = (await manager.save({
      workspaceId: 'ws-dst',
      name: 'Fold job',
      prompt: 'Check DST fold.',
      enabled: true,
      trigger,
      sessionTarget: { mode: 'existing', sessionId: 's_fold' },
      missedPolicy: 'run-once',
    })).schedules[0]!;
    expect(saved.nextRunAt).toBe('2026-11-01T05:30:00.000Z');

    const fireLatest = async () => {
      const timer = [...timers].reverse().find(item => !item.cancelled);
      expect(timer).toBeDefined();
      timer!.cancelled = true;
      timer!.callback();
      await vi.waitFor(() => expect(manager.isBusy).toBe(false));
    };

    nowMs = Date.parse('2026-11-01T05:30:00.000Z');
    await fireLatest();
    expect((await manager.list()).schedules[0]?.nextRunAt).toBe('2026-11-01T06:30:00.000Z');

    nowMs = Date.parse('2026-11-01T06:30:00.000Z');
    await fireLatest();
    expect((await manager.list()).schedules[0]?.nextRunAt).toBe('2026-11-02T06:30:00.000Z');

    expect(dispatches).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
    const page = await manager.listScheduleRuns({ workspaceId: 'ws-dst', scheduleId: saved.id });
    expect(page.total).toBe(2);
    expect(new Set(page.runs.map(run => run.occurrenceKey)).size).toBe(2);
    expect(page.runs.map(run => run.scheduledFor).sort()).toEqual([
      '2026-11-01T05:30:00.000Z',
      '2026-11-01T06:30:00.000Z',
    ]);
  });

  it('SCH-AT-07: keeps 1-minute interval anchored over a long model call without overlap or drift', async () => {
    const { configDir, stateDir } = await makeTempRoot('extalia-sch-at07-');
    let nowMs = Date.parse('2026-11-24T10:00:00.000Z');
    const timers: FakeTimer[] = [];
    let releaseSlowCall!: () => void;
    let enteredSlowCall!: () => void;
    const slowEntered = new Promise<void>(resolve => { enteredSlowCall = resolve; });
    const slowGate = new Promise<void>(resolve => { releaseSlowCall = resolve; });
    let dispatchCount = 0;

    const manager = new GeneralScheduleManager({
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
        resolveSession: async () => ({ sessionId: 's_interval' }),
        dispatchPrompt: async () => {
          dispatchCount++;
          if (dispatchCount === 1) {
            enteredSlowCall();
            await slowGate;
          }
        },
      },
    });
    managers.push(manager);
    await manager.initialize();

    const saved = (await manager.save({
      workspaceId: 'ws-int',
      name: 'One-minute pulse',
      prompt: 'Check status.',
      enabled: true,
      trigger: { kind: 'interval', intervalMinutes: 1 },
      sessionTarget: { mode: 'existing', sessionId: 's_interval' },
      missedPolicy: 'run-once',
    })).schedules[0]!;
    expect(saved.nextRunAt).toBe('2026-11-24T10:01:00.000Z');

    // Trigger at 10:01:00.000Z.
    nowMs = Date.parse('2026-11-24T10:01:00.000Z');
    const activeTimer = [...timers].reverse().find(item => !item.cancelled)!;
    activeTimer.cancelled = true;
    activeTimer.callback();
    await slowEntered;

    // While the first call runs for 2 minutes 25 seconds, manual/overlapping runs are refused.
    nowMs = Date.parse('2026-11-24T10:03:25.000Z');
    await expect(manager.runNow(saved.id)).rejects.toThrow(/already running/);
    expect(dispatchCount).toBe(1);

    // Finish the slow call at 10:03:25.000Z — nextRunAt stays anchored to the :00 second grid (10:04:00.000Z), NOT 10:04:25.000Z.
    releaseSlowCall();
    await vi.waitFor(() => expect(manager.isBusy).toBe(false));
    const afterSlow = (await manager.list()).schedules[0]!;
    expect(afterSlow.nextRunAt).toBe('2026-11-24T10:04:00.000Z');
    expect(dispatchCount).toBe(1);
  });
});
