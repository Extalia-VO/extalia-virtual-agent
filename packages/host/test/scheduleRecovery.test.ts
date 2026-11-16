import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GeneralSchedule, SaveGeneralScheduleInput, ScheduleTrigger, ScheduleAgentAssignment } from '@extalia/platform';
import { GeneralScheduleManager, type ScheduleExecutionTarget, type ScheduleRetryContext, type ScheduleDeferredDispatch } from '../src/schedules.js';
import * as jsonStore from '../src/jsonStore.js';

type Timer = { callback(): void; delay: number; cancelled: boolean };
const managers: GeneralScheduleManager[] = [], roots: string[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()));
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const local = (day: number, hour: number, minute = 0, second = 0) => new Date(2026, 0, day, hour, minute, second).getTime();
const iso = (value: number) => new Date(value).toISOString();
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'extalia-schedule-recovery-')); roots.push(directory);
  let now = local(2, 8), manager: GeneralScheduleManager;
  const timers: Timer[] = [], dispatch = vi.fn(async (_sessionId: string, _prompt: string, _assignment: ScheduleAgentAssignment, _retryContext?: ScheduleRetryContext): Promise<void | ScheduleDeferredDispatch> => undefined);
  const prepare = vi.fn(async (_schedule: GeneralSchedule, _manual: boolean, _retryContext?: ScheduleRetryContext): Promise<'ready' | 'connection-unavailable'> => 'ready');
  const resolve = vi.fn(async (_schedule: GeneralSchedule, _manual: boolean, _retryContext?: ScheduleRetryContext): Promise<ScheduleExecutionTarget> => ({ sessionId: 'session-fixture' }));
  const open = async () => {
    manager = new GeneralScheduleManager({ directory, now: () => now,
      setTimer: (callback, delay) => { const timer = { callback, delay, cancelled: false }; timers.push(timer); return timer as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: timer => { (timer as unknown as Timer).cancelled = true; },
      callbacks: { validateWorkspace: () => undefined, prepareExecution: prepare, resolveSession: resolve, dispatchPrompt: dispatch } });
    managers.push(manager); await manager.initialize(); return manager;
  };
  await open();
  const settle = async () => { await vi.waitFor(() => expect(manager.isBusy).toBe(false)); return (await manager.list()).schedules; };
  const save = async (policy: 'skip' | 'run-once' = 'run-once', trigger: ScheduleTrigger = { kind: 'cron', cron: '0 9 * * *' }) => {
    const input: SaveGeneralScheduleInput = { workspaceId: 'workspace-fixture', name: 'Daily review', prompt: 'Review project progress.', enabled: true,
      trigger, sessionTarget: { mode: 'existing', sessionId: 'session-fixture' }, missedPolicy: policy };
    return (await manager.save(input)).schedules[0]!;
  };
  const active = () => timers.filter(timer => !timer.cancelled);
  const fire = async () => {
    const timer = active().at(-1); expect(timer).toBeDefined(); timer!.cancelled = true; timer!.callback(); return settle();
  };
  return { directory, save, settle, fire, active, dispatch, resolve, prepare, now: () => now, setNow: (value: number) => { now = value; },
    get manager() { return manager; }, async restart() { await manager.close(); await open(); return settle(); } };
}

describe('schedule downtime, wake and bounded recovery', () => {
  it('coalesces several offline daily occurrences into one catch-up and resumes the normal wall-clock time', async () => {
    const f = await fixture(); await f.save();
    await f.manager.close(); f.setNow(local(5, 10));
    const jobs = await f.restart();
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(jobs[0]).toMatchObject({ runCount: 1, nextRunAt: iso(local(6, 9)), lastOutcome: 'succeeded' });
    await f.fire(); expect(f.dispatch).toHaveBeenCalledOnce();
  });

  it('honors explicit skip after offline days without silently dispatching missed work', async () => {
    const f = await fixture(); await f.save('skip'); await f.manager.close(); f.setNow(local(5, 10));
    const jobs = await f.restart();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(jobs[0]).toMatchObject({ lastOutcome: 'missed', nextRunAt: iso(local(6, 9)), runCount: 0 });
  });

  it.each(['skip', 'run-once'] as const)('applies %s identically after a late wake without restarting the host', async policy => {
    const f = await fixture(); await f.save(policy); f.setNow(local(5, 10));
    const jobs = await f.fire();
    expect(f.dispatch).toHaveBeenCalledTimes(policy === 'run-once' ? 1 : 0);
    expect(jobs[0]?.nextRunAt).toBe(iso(local(6, 9)));
    expect(jobs[0]?.lastOutcome).toBe(policy === 'run-once' ? 'succeeded' : 'missed');
  });

  it.each([0, 45_000, 60_000])('accepts an exact deadline or normal timer jitter of %ims for skip policy', async jitter => {
    const f = await fixture(); await f.save('skip'); f.setNow(local(2, 9) + jitter); await f.fire();
    expect(f.dispatch).toHaveBeenCalledOnce();
  });

  it('treats more than a minute of lateness as missed under skip policy', async () => {
    const f = await fixture(); await f.save('skip'); f.setNow(local(2, 9) + 60_001); await f.fire();
    expect(f.dispatch).not.toHaveBeenCalled(); expect((await f.settle())[0]?.lastOutcome).toBe('missed');
  });

  it('keeps interval slots anchored through offline catch-up and slow dispatch', async () => {
    const f = await fixture(); await f.save('run-once', { kind: 'interval', intervalMinutes: 30 });
    await f.manager.close(); f.setNow(local(2, 10, 47));
    f.dispatch.mockImplementationOnce(async () => { f.setNow(local(2, 10, 51)); });
    const jobs = await f.restart();
    expect(f.dispatch).toHaveBeenCalledOnce(); expect(jobs[0]?.nextRunAt).toBe(iso(local(2, 11)));
  });

  it('preserves a future interval deadline for Run now and consumes an already due slot exactly once', async () => {
    const f = await fixture(), job = await f.save('run-once', { kind: 'interval', intervalMinutes: 30 });
    f.setNow(local(2, 8, 29));
    const early = (await f.manager.runNow(job.id, job.revision)).schedules[0]!;
    expect(early.nextRunAt).toBe(iso(local(2, 8, 30)));
    const stale = f.active().at(-1)!;
    f.setNow(local(2, 8, 30)); await f.manager.runNow(early.id, early.revision);
    stale.callback(); await f.settle();
    expect(f.dispatch).toHaveBeenCalledTimes(2);
    expect((await f.settle())[0]?.nextRunAt).toBe(iso(local(2, 9)));
  });

  it('rechecks forward and backward wall-clock jumps within a bounded heartbeat', async () => {
    const f = await fixture(); await f.save();
    expect(f.active().at(-1)?.delay).toBe(30_000);
    f.setNow(local(1, 8)); await f.fire();
    expect(f.dispatch).not.toHaveBeenCalled(); expect(f.active().at(-1)?.delay).toBe(30_000);
    f.setNow(local(6, 12)); await f.fire();
    expect(f.dispatch).toHaveBeenCalledOnce(); expect((await f.settle())[0]?.nextRunAt).toBe(iso(local(7, 9)));
  });

  it('defers a busy recurring target with persisted backoff, then dispatches once when it becomes idle', async () => {
    const f = await fixture(); await f.save();
    f.resolve.mockResolvedValueOnce({ sessionId: 'session-fixture', skippedBusy: true });
    f.setNow(local(2, 9));
    let jobs = await f.fire();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(jobs[0]).toMatchObject({ lastOutcome: 'skipped-busy', nextRunAt: iso(local(2, 9, 1)), recovery: { reason: 'busy', dueAt: iso(local(2, 9)), attempt: 1 } });
    jobs = await f.restart();
    expect(f.resolve).toHaveBeenCalledOnce(); expect(jobs[0]?.nextRunAt).toBe(iso(local(2, 9, 1)));
    f.setNow(local(2, 9, 1)); jobs = await f.fire();
    expect(f.dispatch).toHaveBeenCalledOnce(); expect(jobs[0]).toMatchObject({ nextRunAt: iso(local(3, 9)), runCount: 1 });
    expect(jobs[0]?.recovery).toBeUndefined();
  });

  it('bounds repeated busy deferrals without a zero-delay loop or indefinite catch-up', async () => {
    const f = await fixture(); await f.save(); f.resolve.mockResolvedValue({ sessionId: 'session-fixture', skippedBusy: true });
    f.setNow(local(2, 9));
    for (const [attempt, seconds] of [[1, 60], [2, 120], [3, 300], [4, 600]] as const) {
      const now = f.now(), jobs = await f.fire();
      expect(jobs[0]?.recovery?.attempt).toBe(attempt);
      expect(jobs[0]?.nextRunAt).toBe(iso(now + seconds * 1000));
      f.setNow(now + seconds * 1000);
    }
    const jobs = await f.fire();
    expect(f.resolve).toHaveBeenCalledTimes(5); expect(f.dispatch).not.toHaveBeenCalled();
    expect(jobs[0]?.recovery).toBeUndefined(); expect(jobs[0]?.nextRunAt).toBe(iso(local(3, 9)));
    expect(f.active().at(-1)?.delay).toBe(30_000);
  });

  it('consumes a pending retry when a manual run succeeds before the retry deadline', async () => {
    const f = await fixture(); await f.save(); f.resolve.mockResolvedValueOnce({ sessionId: 'session-fixture', skippedBusy: true });
    f.setNow(local(2, 9)); const job = (await f.fire())[0]!;
    f.setNow(local(2, 9, 0, 30));
    const result = (await f.manager.runNow(job.id, job.revision)).schedules[0]!;
    expect(result.recovery).toBeUndefined(); expect(result.nextRunAt).toBe(iso(local(3, 9)));
    f.setNow(local(2, 9, 1)); await f.fire(); expect(f.dispatch).toHaveBeenCalledOnce();
  });

  it('preserves an existing deferred retry when manual Run now confirms the target is still busy', async () => {
    const f = await fixture(); await f.save();
    f.resolve.mockResolvedValueOnce({ sessionId: 'session-fixture', skippedBusy: true });
    f.setNow(local(2, 9)); const original = (await f.fire())[0]!;
    f.resolve.mockResolvedValueOnce({ sessionId: 'session-fixture', skippedBusy: true });
    f.setNow(local(2, 9, 0, 30));
    await expect(f.manager.runNow(original.id, original.revision)).rejects.toThrow(/still working/);
    const waiting = (await f.settle())[0]!;
    expect(waiting.nextRunAt).toBe(original.nextRunAt); expect(waiting.recovery).toEqual(original.recovery);
    expect(waiting.runCount).toBe(0); expect(f.dispatch).not.toHaveBeenCalled();
    await f.restart();
    f.setNow(local(2, 9, 1)); const finished = (await f.fire())[0]!;
    expect(f.dispatch).toHaveBeenCalledOnce(); expect(finished.recovery).toBeUndefined();
    expect(finished.nextRunAt).toBe(iso(local(3, 9)));
  });

  it('does not preserve a pending retry after a generic manual resolver error', async () => {
    const f = await fixture(); await f.save(); f.resolve.mockResolvedValueOnce({ sessionId: 'session-fixture', skippedBusy: true });
    f.setNow(local(2, 9)); const original = (await f.fire())[0]!;
    f.resolve.mockRejectedValueOnce(new Error('The attempted effect cannot be confirmed.'));
    f.setNow(local(2, 9, 0, 30));
    await expect(f.manager.runNow(original.id, original.revision)).rejects.toThrow(/cannot be confirmed/);
    const job = (await f.settle())[0]!;
    expect(job.recovery).toBeUndefined(); expect(job.lastOutcome).toBe('failed'); expect(job.nextRunAt).toBe(iso(local(3, 9)));
    f.setNow(local(2, 9, 1)); await f.fire(); expect(f.dispatch).not.toHaveBeenCalled();
  });

  it('does not automatically retry an arbitrary dispatch error', async () => {
    const f = await fixture(); await f.save(); f.dispatch.mockRejectedValueOnce(new Error('Acceptance is uncertain.'));
    f.setNow(local(2, 9)); const jobs = await f.fire();
    expect(jobs[0]).toMatchObject({ lastOutcome: 'failed', nextRunAt: iso(local(3, 9)), runCount: 0 });
    expect(jobs[0]?.recovery).toBeUndefined(); await f.fire(); expect(f.dispatch).toHaveBeenCalledOnce();
  });

  it('pausing or deleting a deferred job clears recovery and prevents its captured timer from dispatching', async () => {
    const f = await fixture(); await f.save(); f.resolve.mockResolvedValue({ sessionId: 'session-fixture', skippedBusy: true });
    f.setNow(local(2, 9)); let job = (await f.fire())[0]!;
    const stale = f.active().at(-1)!;
    job = (await f.manager.setEnabled(job.id, false, job.revision)).schedules[0]!;
    expect(job.recovery).toBeUndefined(); f.setNow(local(2, 10)); stale.callback(); await f.settle();
    expect(f.resolve).toHaveBeenCalledOnce();
    await f.manager.delete(job.id, job.revision); await f.restart(); expect((await f.settle())).toEqual([]);
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it('marks interrupted dispatch as uncertain and advances without replay even with a recovery ledger', async () => {
    const f = await fixture(); await f.save(); f.resolve.mockResolvedValueOnce({ sessionId: 'session-fixture', skippedBusy: true });
    f.setNow(local(2, 9)); await f.fire(); await f.manager.close();
    const file = path.join(f.directory, 'schedules.json'); const stored = JSON.parse(await readFile(file, 'utf8'));
    stored.schedules[0].state = 'running'; await writeFile(file, JSON.stringify(stored));
    f.setNow(local(2, 9, 1)); const jobs = await f.restart();
    expect(f.dispatch).not.toHaveBeenCalled(); expect(jobs[0]).toMatchObject({ lastOutcome: 'failed', nextRunAt: iso(local(3, 9)) });
    expect(jobs[0]?.recovery).toBeUndefined();
  });

  it('keeps busy retry budget and its future retry deadline through repeated host restarts', async () => {
    const f = await fixture(); await f.save(); f.resolve.mockResolvedValue({ sessionId: 'session-fixture', skippedBusy: true });
    f.setNow(local(2, 9)); await f.fire(); f.setNow(local(2, 9, 1)); await f.fire();
    f.setNow(local(2, 9, 1, 30));
    const jobs = await f.restart(); await f.restart();
    expect(f.resolve).toHaveBeenCalledTimes(2); expect(jobs[0]).toMatchObject({ recovery: { attempt: 2 }, nextRunAt: iso(local(2, 9, 3)) });
  });

  it('clears private recovery on explicit edits and workspace removal', async () => {
    const f = await fixture(); await f.save(); f.resolve.mockResolvedValueOnce({ sessionId: 'session-fixture', skippedBusy: true });
    f.setNow(local(2, 9)); let job = (await f.fire())[0]!;
    job = (await f.manager.save({ id: job.id, expectedRevision: job.revision, workspaceId: job.workspaceId, name: 'Edited task', prompt: job.prompt,
      trigger: { kind: 'interval', intervalMinutes: 60 }, sessionTarget: job.sessionTarget, missedPolicy: job.missedPolicy })).schedules[0]!;
    expect(job.recovery).toBeUndefined(); await f.restart();
    expect(JSON.parse(await readFile(path.join(f.directory, 'schedules.json'), 'utf8')).recoveries).toBeUndefined();
    await f.manager.removeWorkspace(job.workspaceId); await f.restart(); expect((await f.settle())).toEqual([]);
  });

  it.each(['automatic', 'manual'] as const)('never repeats a consumed cron slot if the clock moves backward during %s dispatch', async mode => {
    const f = await fixture(), job = await f.save('run-once', { kind: 'cron', cron: '* * * * *' });
    const due = Date.parse(job.nextRunAt!); f.setNow(due);
    f.dispatch.mockImplementationOnce(async () => { f.setNow(due - 30_000); });
    if (mode === 'automatic') await f.fire(); else await f.manager.runNow(job.id, job.revision);
    expect((await f.settle())[0]?.nextRunAt).toBe(iso(due + 60_000));
    f.setNow(due); await f.fire(); expect(f.dispatch).toHaveBeenCalledOnce();
  });

  it('makes an interrupted one-off terminal instead of resurrecting its consumed deadline', async () => {
    const f = await fixture(); await f.save('run-once', { kind: 'once', runAt: iso(local(2, 9)) }); await f.manager.close();
    const file = path.join(f.directory, 'schedules.json'), stored = JSON.parse(await readFile(file, 'utf8'));
    stored.schedules[0].state = 'running'; await writeFile(file, JSON.stringify(stored)); f.setNow(local(2, 10));
    const jobs = await f.restart(); expect(f.dispatch).not.toHaveBeenCalled();
    expect(jobs[0]).toMatchObject({ state: 'failed', enabled: false, lastOutcome: 'failed' });
    expect(jobs[0]?.nextRunAt).toBeUndefined(); expect(f.active()).toEqual([]);
  });

  it.each(['unknown-job', 'invalid-attempt', 'retry-mismatch', 'invalid-reason'] as const)('refuses malformed recovery metadata: %s', async mutation => {
    const f = await fixture(); await f.save(); f.resolve.mockResolvedValueOnce({ sessionId: 'session-fixture', skippedBusy: true });
    f.setNow(local(2, 9)); await f.fire(); await f.manager.close();
    const file = path.join(f.directory, 'schedules.json'), stored = JSON.parse(await readFile(file, 'utf8'));
    if (mutation === 'unknown-job') stored.recoveries[0].scheduleId = 'removed-job';
    else if (mutation === 'invalid-attempt') stored.recoveries[0].attempt = 99;
    else if (mutation === 'retry-mismatch') stored.recoveries[0].retryAt = iso(local(2, 9, 2));
    else stored.recoveries[0].reason = 'unknown-reason';
    await writeFile(file, JSON.stringify(stored)); const before = await readFile(file, 'utf8');
    await expect(f.restart()).rejects.toThrow(/recovery receipt/);
    expect(await readFile(file, 'utf8')).toBe(before); expect(f.dispatch).not.toHaveBeenCalled();
  });

  it('defers a known unreachable connection before resolving or mutating a destination, then dispatches once when ready', async () => {
    const f = await fixture(); await f.save(); f.prepare.mockResolvedValueOnce('connection-unavailable');
    f.setNow(local(2, 9)); const deferred = (await f.fire())[0]!;
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled();
    expect(deferred).toMatchObject({ enabled: true, state: 'scheduled', lastOutcome: 'deferred-connection', nextRunAt: iso(local(2, 9, 1)),
      recovery: { reason: 'connection-unavailable', dueAt: iso(local(2, 9)), attempt: 1 } });
    f.setNow(local(2, 9, 1)); const finished = (await f.fire())[0]!;
    expect(f.resolve).toHaveBeenCalledOnce(); expect(f.dispatch).toHaveBeenCalledOnce();
    expect(finished).toMatchObject({ runCount: 1, lastOutcome: 'succeeded', nextRunAt: iso(local(3, 9)) });
    expect(finished.recovery).toBeUndefined();
  });

  it('caps the outage retry rate and attempt counter while retaining exactly one pending occurrence through restarts', async () => {
    const f = await fixture(); await f.save(); f.prepare.mockResolvedValue('connection-unavailable'); f.setNow(local(2, 9));
    for (const [index, seconds] of [60, 120, 300, 600, 600, 600].entries()) {
      const now = f.now(), job = (await f.fire())[0]!;
      expect(job.recovery).toMatchObject({ reason: 'connection-unavailable', attempt: Math.min(index + 1, 4), dueAt: iso(local(2, 9)) });
      expect(job.nextRunAt).toBe(iso(now + seconds * 1000));
      await f.restart(); expect((await f.settle())[0]?.nextRunAt).toBe(job.nextRunAt);
      f.setNow(now + seconds * 1000);
    }
    expect(f.prepare).toHaveBeenCalledTimes(6); expect(f.resolve).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled();
    f.prepare.mockResolvedValue('ready'); await f.fire();
    expect(f.dispatch).toHaveBeenCalledOnce(); expect((await f.settle())[0]?.nextRunAt).toBe(iso(local(3, 9)));
  });

  it('retains an offline one-off until the connection is available, including process restart', async () => {
    const f = await fixture(); await f.save('run-once', { kind: 'once', runAt: iso(local(2, 9)) });
    f.prepare.mockResolvedValueOnce('connection-unavailable'); f.setNow(local(2, 9));
    let job = (await f.fire())[0]!;
    expect(job).toMatchObject({ enabled: true, state: 'scheduled', lastOutcome: 'deferred-connection' });
    await f.restart(); expect(f.resolve).not.toHaveBeenCalled();
    f.setNow(local(2, 9, 1)); job = (await f.fire())[0]!;
    expect(f.dispatch).toHaveBeenCalledOnce(); expect(job).toMatchObject({ state: 'completed', enabled: false, runCount: 1 });
    expect(job.nextRunAt).toBeUndefined(); expect(job.recovery).toBeUndefined();
  });

  it('preserves an existing retry after a manual proven-unreachable attempt without consuming its deadline or budget', async () => {
    const f = await fixture(); await f.save('run-once', { kind: 'once', runAt: iso(local(2, 9)) });
    f.prepare.mockResolvedValue('connection-unavailable'); f.setNow(local(2, 9)); const first = (await f.fire())[0]!;
    f.setNow(local(2, 9, 0, 30)); await expect(f.manager.runNow(first.id, first.revision)).rejects.toThrow(/connection is unavailable/);
    const waiting = (await f.settle())[0]!;
    expect(waiting.nextRunAt).toBe(first.nextRunAt); expect(waiting.recovery).toEqual(first.recovery);
    expect(waiting).toMatchObject({ enabled: true, state: 'scheduled' });
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled();
  });

  it('starts a separate bounded busy budget after a long outage rather than inheriting its saturated attempt count', async () => {
    const f = await fixture(); await f.save(); f.prepare.mockResolvedValue('connection-unavailable'); f.setNow(local(2, 9));
    for (let i = 0; i < 4; i++) { const job = (await f.fire())[0]!; f.setNow(Date.parse(job.nextRunAt!)); }
    f.prepare.mockResolvedValue('ready'); f.resolve.mockResolvedValueOnce({ sessionId: 'session-fixture', skippedBusy: true });
    const now = f.now(), busy = (await f.fire())[0]!;
    expect(busy.recovery).toMatchObject({ reason: 'busy', attempt: 1 }); expect(busy.nextRunAt).toBe(iso(now + 60_000));
  });

  it('makes a once job visibly paused if connectivity returns but its target is busy', async () => {
    const f = await fixture(); await f.save('run-once', { kind: 'once', runAt: iso(local(2, 9)) });
    f.prepare.mockResolvedValueOnce('connection-unavailable'); f.setNow(local(2, 9)); await f.fire();
    f.resolve.mockResolvedValueOnce({ sessionId: 'session-fixture', skippedBusy: true }); f.setNow(local(2, 9, 1));
    const job = (await f.fire())[0]!;
    expect(job).toMatchObject({ state: 'paused', enabled: false, lastOutcome: 'skipped-busy' });
    expect(job.recovery).toBeUndefined(); expect(f.dispatch).not.toHaveBeenCalled();
  });

  it('does not retry a generic preparation failure or an explicit manual unreachable attempt without prior recovery', async () => {
    const f = await fixture(); const job = await f.save();
    f.prepare.mockRejectedValueOnce(new Error('Preparation result is uncertain.')); f.setNow(local(2, 9));
    let current = (await f.fire())[0]!;
    expect(current).toMatchObject({ lastOutcome: 'failed', nextRunAt: iso(local(3, 9)) }); expect(current.recovery).toBeUndefined();
    f.prepare.mockResolvedValueOnce('connection-unavailable');
    await expect(f.manager.runNow(job.id, current.revision)).rejects.toThrow(/connection is unavailable/);
    current = (await f.settle())[0]!;
    expect(current.recovery).toBeUndefined(); expect(f.resolve).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled();
  });

  it.each(['pause', 'delete'] as const)('clears a connection deferral on explicit %s', async action => {
    const f = await fixture(); await f.save(); f.prepare.mockResolvedValue('connection-unavailable'); f.setNow(local(2, 9));
    const job = (await f.fire())[0]!;
    if (action === 'pause') {
      const paused = (await f.manager.setEnabled(job.id, false, job.revision)).schedules[0]!;
      expect(paused.recovery).toBeUndefined();
    } else await f.manager.delete(job.id, job.revision);
    await f.restart(); f.setNow(local(4, 10));
    expect(f.active()).toEqual([]); expect(f.resolve).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled();
  });

  it('leaves an unreachable skip-policy recurring job on its next normal slot without automatic retry', async () => {
    const f = await fixture(); await f.save('skip'); f.prepare.mockResolvedValue('connection-unavailable'); f.setNow(local(2, 9));
    const job = (await f.fire())[0]!;
    expect(job).toMatchObject({ lastOutcome: 'deferred-connection', nextRunAt: iso(local(3, 9)), runCount: 0 });
    expect(job.recovery).toBeUndefined(); expect(f.resolve).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled();
  });

  it('keeps manual busy one-offs terminal even when an earlier network outage was deferred', async () => {
    const f = await fixture(); await f.save('run-once', { kind: 'once', runAt: iso(local(2, 9)) });
    f.prepare.mockResolvedValueOnce('connection-unavailable'); f.setNow(local(2, 9)); const first = (await f.fire())[0]!;
    f.setNow(local(2, 9, 0, 30)); f.resolve.mockResolvedValueOnce({ sessionId: 'session-fixture', skippedBusy: true });
    await expect(f.manager.runNow(first.id, first.revision)).rejects.toThrow(/still working/);
    const job = (await f.settle())[0]!;
    expect(job).toMatchObject({ enabled: false, state: 'paused', lastOutcome: 'skipped-busy' });
    expect(job.recovery).toBeUndefined(); expect(job.nextRunAt).toBeUndefined(); expect(f.dispatch).not.toHaveBeenCalled();
  });

  it('records current unavailability reason without changing the prior manual retry budget or deadline', async () => {
    const f = await fixture(); await f.save(); f.resolve.mockResolvedValueOnce({ sessionId: 'session-fixture', skippedBusy: true });
    f.setNow(local(2, 9)); const first = (await f.fire())[0]!;
    f.setNow(local(2, 9, 0, 30)); f.prepare.mockResolvedValueOnce('connection-unavailable');
    await expect(f.manager.runNow(first.id, first.revision)).rejects.toThrow(/connection is unavailable/);
    const job = (await f.settle())[0]!;
    expect(job.nextRunAt).toBe(first.nextRunAt); expect(job.recovery).toEqual({ ...first.recovery, reason: 'connection-unavailable' });
    await f.restart(); expect(f.resolve).toHaveBeenCalledOnce(); expect(f.dispatch).not.toHaveBeenCalled();
  });

  it.each(['busy', 'connection-unavailable'] as const)('does not schedule a %s retry before the original deadline when the clock rolls backward during preparation', async reason => {
    const f = await fixture(); await f.save();
    if (reason === 'busy') f.resolve.mockImplementationOnce(async () => { f.setNow(local(2, 8, 30)); return { sessionId: 'session-fixture', skippedBusy: true }; });
    else f.prepare.mockImplementationOnce(async () => { f.setNow(local(2, 8, 30)); return 'connection-unavailable'; });
    f.setNow(local(2, 9)); const pending = (await f.fire())[0]!;
    expect(pending).toMatchObject({ nextRunAt: iso(local(2, 9, 1)), recovery: { reason, dueAt: iso(local(2, 9)), attempt: 1 } });
    f.setNow(local(2, 8, 31)); await f.fire(); expect(f.dispatch).not.toHaveBeenCalled();
    f.setNow(local(2, 9, 1)); await f.fire(); expect(f.dispatch).toHaveBeenCalledOnce();
  });

  it.each(['busy', 'connection-unavailable'] as const)('preserves the retry deadline but starts a fresh budget when a manual probe changes from %s', async initialReason => {
    const f = await fixture(); await f.save();
    if (initialReason === 'busy') f.resolve.mockResolvedValue({ sessionId: 'session-fixture', skippedBusy: true });
    else f.prepare.mockResolvedValue('connection-unavailable');
    f.setNow(local(2, 9)); let original: GeneralSchedule | undefined;
    for (let i = 0; i < 4; i++) { original = (await f.fire())[0]!; f.setNow(Date.parse(original.nextRunAt!)); }
    expect(original!.recovery?.attempt).toBe(4);
    const nextReason = initialReason === 'busy' ? 'connection-unavailable' : 'busy';
    if (nextReason === 'busy') {
      f.prepare.mockResolvedValue('ready'); f.resolve.mockResolvedValue({ sessionId: 'session-fixture', skippedBusy: true });
    } else f.prepare.mockResolvedValue('connection-unavailable');
    f.setNow(Date.parse(original!.nextRunAt!) - 30_000);
    await expect(f.manager.runNow(original!.id, original!.revision)).rejects.toThrow(nextReason === 'busy' ? /still working/ : /connection is unavailable/);
    let changed = (await f.settle())[0]!;
    expect(changed.nextRunAt).toBe(original!.nextRunAt);
    expect(changed.recovery).toEqual({ ...original!.recovery, reason: nextReason, attempt: 1 });
    f.setNow(Date.parse(changed.nextRunAt!)); changed = (await f.fire())[0]!;
    expect(changed.recovery).toMatchObject({ reason: nextReason, attempt: 2 });
    expect(changed.nextRunAt).toBe(iso(f.now() + 120_000));
    f.prepare.mockResolvedValue('ready'); f.resolve.mockResolvedValue({ sessionId: 'session-fixture' });
    f.setNow(Date.parse(changed.nextRunAt!)); const finished = (await f.fire())[0]!;
    expect(f.dispatch).toHaveBeenCalledOnce(); expect(finished.recovery).toBeUndefined(); expect(finished.runCount).toBe(1);
  });

  it('persists a typed zero-work destination across restart and reuses it instead of allocating a second new-each-run session', async () => {
    const f = await fixture();
    await f.manager.save({ workspaceId: 'workspace-fixture', name: 'Unstarted retry', prompt: 'Review project progress.', trigger: { kind: 'interval', intervalMinutes: 60 },
      sessionTarget: { mode: 'new-each-run' }, missedPolicy: 'run-once' });
    let created = 0;
    f.resolve.mockImplementation(async (_job, _manual, context) => ({ sessionId: context?.sessionId ?? `unstarted-${++created}` }));
    const context: ScheduleRetryContext = { sessionId: 'unstarted-1', historySha256: 'a'.repeat(64) };
    f.dispatch.mockResolvedValueOnce({ deferred: 'connection-unavailable', retryContext: context });
    f.setNow(local(2, 9)); let job = (await f.fire())[0]!;
    expect(job).toMatchObject({ lastOutcome: 'deferred-connection', runCount: 0, nextRunAt: iso(local(2, 9, 1)) });
    expect(created).toBe(1); expect(JSON.stringify(await f.manager.list())).not.toContain('retryContext');
    expect(JSON.stringify(await f.manager.list())).not.toContain(context.historySha256);
    const stored = JSON.parse(await readFile(path.join(f.directory, 'schedules.json'), 'utf8'));
    expect(stored.recoveries[0].retryContext).toEqual(context);
    f.setNow(local(2, 9, 0, 30)); await f.restart();
    expect(created).toBe(1); expect(f.dispatch).toHaveBeenCalledOnce();
    f.setNow(local(2, 9, 1)); job = (await f.fire())[0]!;
    expect(f.prepare.mock.calls.at(-1)?.[2]).toEqual(context);
    expect(f.resolve.mock.calls.at(-1)?.[2]).toEqual(context);
    expect(f.dispatch.mock.calls.at(-1)?.[3]).toEqual(context);
    expect(created).toBe(1); expect(job).toMatchObject({ runCount: 1, nextRunAt: iso(local(2, 10)) });
    expect(job.recovery).toBeUndefined();
    f.setNow(local(2, 10)); await f.fire(); expect(created).toBe(2);
    expect(f.dispatch.mock.calls.at(-1)?.[3]).toBeUndefined();
  });

  it('retains the same unstarted context through later preflight unavailability and a busy target', async () => {
    const f = await fixture(); await f.save();
    const context: ScheduleRetryContext = { sessionId: 'session-fixture', historySha256: 'b'.repeat(64) };
    f.dispatch.mockResolvedValueOnce({ deferred: 'connection-unavailable', retryContext: context });
    f.setNow(local(2, 9)); await f.fire();
    f.prepare.mockResolvedValueOnce('connection-unavailable'); f.setNow(local(2, 9, 1)); let job = (await f.fire())[0]!;
    expect(f.resolve).toHaveBeenCalledOnce(); expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.prepare.mock.calls.at(-1)?.[2]).toEqual(context);
    f.resolve.mockResolvedValueOnce({ sessionId: 'session-fixture', skippedBusy: true });
    f.setNow(Date.parse(job.nextRunAt!)); job = (await f.fire())[0]!;
    expect(job.recovery?.reason).toBe('busy'); expect(f.resolve.mock.calls.at(-1)?.[2]).toEqual(context);
    await f.restart(); f.setNow(Date.parse(job.nextRunAt!)); await f.fire();
    expect(f.dispatch).toHaveBeenCalledTimes(2); expect(f.dispatch.mock.calls.at(-1)?.[3]).toEqual(context);
    expect((await f.settle())[0]?.recovery).toBeUndefined();
  });

  it('updates a proven retry context after a manual zero-work receipt while preserving its queued deadline', async () => {
    const f = await fixture(); await f.save();
    const first: ScheduleRetryContext = { sessionId: 'session-fixture', historySha256: 'c'.repeat(64) };
    const next: ScheduleRetryContext = { ...first, historySha256: 'd'.repeat(64) };
    f.dispatch.mockResolvedValueOnce({ deferred: 'connection-unavailable', retryContext: first });
    f.setNow(local(2, 9)); const job = (await f.fire())[0]!;
    f.dispatch.mockResolvedValueOnce({ deferred: 'connection-unavailable', retryContext: next });
    f.setNow(local(2, 9, 0, 30)); await expect(f.manager.runNow(job.id, job.revision)).rejects.toThrow(/connection is unavailable/);
    expect((await f.settle())[0]?.nextRunAt).toBe(job.nextRunAt);
    await f.restart(); f.setNow(Date.parse(job.nextRunAt!)); await f.fire();
    expect(f.dispatch.mock.calls.at(-1)?.[3]).toEqual(next);
    expect((await f.settle())[0]?.runCount).toBe(1);
  });

  it.each(['different-session', 'invalid-hash', 'extra-context-field', 'extra-receipt-field'] as const)('refuses an invalid zero-work dispatch receipt: %s', async mutation => {
    const f = await fixture(); await f.save();
    const context: Record<string, unknown> = { sessionId: 'session-fixture', historySha256: 'e'.repeat(64) };
    const receipt: Record<string, unknown> = { deferred: 'connection-unavailable', retryContext: context };
    if (mutation === 'different-session') context.sessionId = 'some-other-session';
    else if (mutation === 'invalid-hash') context.historySha256 = 'invalid';
    else if (mutation === 'extra-context-field') context.accepted = true;
    else receipt.accepted = true;
    f.dispatch.mockResolvedValueOnce(receipt as unknown as ScheduleDeferredDispatch);
    f.setNow(local(2, 9)); const job = (await f.fire())[0]!;
    expect(job).toMatchObject({ lastOutcome: 'failed', runCount: 0, nextRunAt: iso(local(3, 9)) });
    expect(job.recovery).toBeUndefined(); f.setNow(local(2, 9, 1)); await f.fire(); expect(f.dispatch).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(path.join(f.directory, 'schedules.json'), 'utf8')).recoveries).toBeUndefined();
  });

  it('refuses a retry resolver that changes the pinned destination before another dispatch', async () => {
    const f = await fixture(); await f.save();
    const context: ScheduleRetryContext = { sessionId: 'session-fixture', historySha256: 'f'.repeat(64) };
    f.dispatch.mockResolvedValueOnce({ deferred: 'connection-unavailable', retryContext: context });
    f.setNow(local(2, 9)); await f.fire();
    f.resolve.mockResolvedValueOnce({ sessionId: 'replacement-session' }); f.setNow(local(2, 9, 1)); const job = (await f.fire())[0]!;
    expect(f.dispatch).toHaveBeenCalledOnce(); expect(job.lastOutcome).toBe('failed'); expect(job.recovery).toBeUndefined();
    expect(job.lastSessionId).toBe('session-fixture');
  });

  it('clears a pinned context after an unknown dispatch failure instead of replaying uncertain work', async () => {
    const f = await fixture(); await f.save();
    const context: ScheduleRetryContext = { sessionId: 'session-fixture', historySha256: '1'.repeat(64) };
    f.dispatch.mockResolvedValueOnce({ deferred: 'connection-unavailable', retryContext: context });
    f.setNow(local(2, 9)); await f.fire(); f.dispatch.mockRejectedValueOnce(new Error('Unknown acceptance.'));
    f.setNow(local(2, 9, 1)); const job = (await f.fire())[0]!;
    expect(job).toMatchObject({ lastOutcome: 'failed', nextRunAt: iso(local(3, 9)), runCount: 0 });
    expect(job.recovery).toBeUndefined(); await f.restart(); expect(f.dispatch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(path.join(f.directory, 'schedules.json'), 'utf8')).recoveries).toBeUndefined();
  });

  it.each(['pause', 'edit', 'delete'] as const)('clears private retry context on explicit %s', async action => {
    const f = await fixture(); await f.save();
    f.dispatch.mockResolvedValueOnce({ deferred: 'connection-unavailable', retryContext: { sessionId: 'session-fixture', historySha256: '2'.repeat(64) } });
    f.setNow(local(2, 9)); const job = (await f.fire())[0]!;
    if (action === 'pause') await f.manager.setEnabled(job.id, false, job.revision);
    else if (action === 'delete') await f.manager.delete(job.id, job.revision);
    else await f.manager.save({ id: job.id, expectedRevision: job.revision, workspaceId: job.workspaceId, name: 'Reviewed task', prompt: job.prompt,
      trigger: job.trigger, sessionTarget: job.sessionTarget, missedPolicy: job.missedPolicy });
    await f.restart();
    const stored = await readFile(path.join(f.directory, 'schedules.json'), 'utf8'); expect(stored).not.toContain('historySha256');
  });

  it.each(['invalid-hash', 'invalid-id', 'extra-field'] as const)('rejects malformed retry context in the stored recovery ledger: %s', async mutation => {
    const f = await fixture(); await f.save();
    f.dispatch.mockResolvedValueOnce({ deferred: 'connection-unavailable', retryContext: { sessionId: 'session-fixture', historySha256: '3'.repeat(64) } });
    f.setNow(local(2, 9)); await f.fire(); await f.manager.close();
    const file = path.join(f.directory, 'schedules.json'), stored = JSON.parse(await readFile(file, 'utf8'));
    if (mutation === 'invalid-hash') stored.recoveries[0].retryContext.historySha256 = 'broken';
    else if (mutation === 'invalid-id') stored.recoveries[0].retryContext.sessionId = ' padded ';
    else stored.recoveries[0].retryContext.granted = true;
    await writeFile(file, JSON.stringify(stored)); const before = await readFile(file, 'utf8');
    await expect(f.restart()).rejects.toThrow(/retry context/);
    expect(await readFile(file, 'utf8')).toBe(before); expect(f.dispatch).toHaveBeenCalledOnce();
  });

  it.each(['edit', 'pause'] as const)('rechecks a manual run revision after a concurrent %s reaches the reservation lane first', async action => {
    const f = await fixture(), job = await f.save();
    const running = f.manager.runNow(job.id, job.revision);
    const changing = action === 'pause'
      ? f.manager.setEnabled(job.id, false, job.revision)
      : f.manager.save({ id: job.id, expectedRevision: job.revision, workspaceId: job.workspaceId,
        name: 'Changed task', prompt: 'A new unreviewed task.', trigger: job.trigger,
        sessionTarget: { mode: 'existing', sessionId: 'new-unreviewed-session' }, missedPolicy: job.missedPolicy });
    const [runResult, editResult] = await Promise.allSettled([running, changing]);
    expect(editResult.status).toBe('fulfilled'); expect(runResult.status).toBe('rejected');
    if (runResult.status === 'rejected') expect(runResult.reason.message).toMatch(/schedule changed/);
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.resolve).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled();
  });

  it('halts rather than dispatching when catch-up reservation cannot be persisted', async () => {
    const f = await fixture(); await f.save();
    vi.spyOn(jsonStore, 'writeJsonAtomic').mockRejectedValueOnce(new Error('Storage unavailable.'));
    f.setNow(local(4, 10)); await f.fire();
    expect((await f.manager.list()).problem).toBe('storage-unavailable');
    expect(f.dispatch).not.toHaveBeenCalled(); expect(f.active()).toEqual([]);
  });
});
