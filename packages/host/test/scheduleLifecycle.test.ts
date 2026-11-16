import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GeneralSchedule, SaveGeneralScheduleInput } from '@extalia/platform';
import { GeneralScheduleManager, type ScheduleExecutionTarget } from '../src/schedules.js';
import * as jsonStore from '../src/jsonStore.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

type Timer = { callback(): void; delay: number; cancelled: boolean };
const roots: string[] = [], managers: GeneralScheduleManager[] = [], releases: Array<() => void> = [];
const operations: Promise<unknown>[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(operations.splice(0));
  for (const manager of managers.splice(0)) {
    await manager.close();
    await vi.waitFor(() => expect(manager.isBusy).toBe(false), { timeout: 3000 });
    await manager.close();
  }
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'extalia-schedule-lifecycle-')); roots.push(directory);
  let now = Date.parse('2026-01-02T10:00:00Z');
  const timers: Timer[] = [];
  const dispatch = vi.fn(async (_sessionId: string, _prompt: string) => undefined);
  const resolve = vi.fn(async (_schedule: GeneralSchedule, _manual: boolean): Promise<ScheduleExecutionTarget> => ({ sessionId: 's_fixture' }));
  const manager = new GeneralScheduleManager({
    directory, now: () => now,
    setTimer: (callback, delay) => {
      const timer: Timer = { callback, delay, cancelled: false }; timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: handle => { (handle as unknown as Timer).cancelled = true; },
    callbacks: { validateWorkspace: () => undefined, resolveSession: resolve, dispatchPrompt: dispatch },
  });
  managers.push(manager); await manager.initialize();
  const input = (name = 'Lifecycle check'): SaveGeneralScheduleInput => ({ workspaceId: 'workspace-one', name, prompt: name,
    trigger: { kind: 'once', runAt: new Date(now + 60_000).toISOString() }, sessionTarget: { mode: 'existing', sessionId: 's_fixture' }, assignment: { teamMode: 'solo' } });
  const save = async (value = input()) => (await manager.save(value)).schedules.find(item => item.name === value.name)!;
  const run = (schedule: GeneralSchedule) => {
    const promise = manager.runNow(schedule.id, schedule.revision); operations.push(promise); void promise.catch(() => undefined); return promise;
  };
  const fire = () => {
    const timer = [...timers].reverse().find(item => !item.cancelled);
    expect(timer).toBeDefined(); timer!.cancelled = true; timer!.callback();
  };
  return { manager, directory, input, save, run, dispatch, resolve, timers, fire, advance: (ms: number) => { now += ms; },
    activeTimers: () => timers.filter(item => !item.cancelled), list: () => manager.list() };
}

describe('general schedule occurrence and shutdown ownership', () => {
  it('consumes a one-off Run now instead of leaving its future deadline armed', async () => {
    const f = await fixture(), schedule = await f.save();
    const result = (await f.run(schedule)).schedules[0]!;
    expect(result).toMatchObject({ state: 'completed', enabled: false, lastOutcome: 'succeeded', runCount: 1 });
    expect(result.nextRunAt).toBeUndefined();
    expect(f.activeTimers()).toEqual([]);
    expect(f.dispatch).toHaveBeenCalledExactlyOnceWith('s_fixture', schedule.prompt, { teamMode: 'solo' });
  });

  it('leaves a failed one-off terminal rather than retrying its past deadline', async () => {
    const f = await fixture(), schedule = await f.save();
    f.dispatch.mockRejectedValueOnce(new Error('Controlled dispatch rejection.'));
    await expect(f.run(schedule)).rejects.toThrow('Controlled dispatch rejection.');
    const result = (await f.list()).schedules[0]!;
    expect(result).toMatchObject({ state: 'failed', enabled: false, lastOutcome: 'failed', runCount: 0 });
    expect(result.nextRunAt).toBeUndefined(); expect(f.activeTimers()).toEqual([]);
    expect(f.dispatch).toHaveBeenCalledOnce();
  });

  it('consumes an automatic busy one-off without dispatch or a zero-delay retry', async () => {
    const f = await fixture(), schedule = await f.save();
    f.resolve.mockResolvedValueOnce({ sessionId: 's_fixture', skippedBusy: true });
    f.advance(60_000); f.fire();
    await vi.waitFor(async () => expect((await f.list()).schedules[0]?.lastOutcome).toBe('skipped-busy'));
    const result = (await f.list()).schedules[0]!;
    expect(result.id).toBe(schedule.id);
    expect(result).toMatchObject({ state: 'paused', enabled: false, runCount: 0 });
    expect(result.nextRunAt).toBeUndefined(); expect(f.activeTimers()).toEqual([]);
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it('waits for held resolution during close and never dispatches its late result', async () => {
    const f = await fixture(), schedule = await f.save(), entered = deferred(), release = deferred<ScheduleExecutionTarget>();
    releases.push(() => release.resolve({ sessionId: 's_fixture' }));
    f.resolve.mockImplementationOnce(async () => { entered.resolve(); return release.promise; });
    const running = f.run(schedule).catch(error => error); await entered.promise;
    let closed = false; const closing = f.manager.close().then(() => { closed = true; });
    await new Promise<void>(done => setImmediate(done));
    expect(closed).toBe(false);
    release.resolve({ sessionId: 's_fixture' });
    await Promise.all([running, closing]);
    expect(f.dispatch).not.toHaveBeenCalled(); expect(f.manager.isBusy).toBe(false);
  });

  it('waits for an entered dispatch and its durable settlement before closing', async () => {
    const f = await fixture(), schedule = await f.save(), entered = deferred(), release = deferred();
    releases.push(() => release.resolve());
    f.dispatch.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
    const running = f.run(schedule); await entered.promise;
    let closed = false; const closing = f.manager.close().then(() => { closed = true; });
    await new Promise<void>(done => setImmediate(done));
    expect(closed).toBe(false); expect(f.manager.isBusy).toBe(true);
    release.resolve(); await Promise.all([running, closing]);
    expect((await f.list()).schedules[0]).toMatchObject({ lastOutcome: 'succeeded', runCount: 1, enabled: false });
    expect(f.manager.isBusy).toBe(false); expect(f.activeTimers()).toEqual([]);
  });

  it('drops a derived binding when its source session changes', async () => {
    const f = await fixture();
    f.resolve.mockImplementation(async schedule => ({ sessionId: schedule.boundSessionId ?? `derived-${schedule.sessionTarget.mode === 'derive-from-session' ? schedule.sessionTarget.sourceSessionId : 'other'}`,
      boundSessionId: schedule.boundSessionId ?? `derived-${schedule.sessionTarget.mode === 'derive-from-session' ? schedule.sessionTarget.sourceSessionId : 'other'}` }));
    const schedule = await f.save({ ...f.input(), trigger: { kind: 'interval', intervalMinutes: 30 }, sessionTarget: { mode: 'derive-from-session', sourceSessionId: 'source-a', reuseDerived: true } });
    const first = (await f.run(schedule)).schedules[0]!;
    expect(first.boundSessionId).toBe('derived-source-a');
    const changed = (await f.manager.save({ ...f.input(), id: first.id, expectedRevision: first.revision, trigger: first.trigger,
      sessionTarget: { mode: 'derive-from-session', sourceSessionId: 'source-b', reuseDerived: true } })).schedules[0]!;
    expect(changed.boundSessionId).toBeUndefined();
    const second = (await f.run(changed)).schedules[0]!;
    expect(second.boundSessionId).toBe('derived-source-b');
    expect(f.dispatch.mock.calls.map(([id]) => id)).toEqual(['derived-source-a', 'derived-source-b']);
  });

  it('retains the same derived source for an ordinary edit but drops it when reuse is disabled', async () => {
    const f = await fixture();
    f.resolve.mockResolvedValue({ sessionId: 'derived-source-a', boundSessionId: 'derived-source-a' });
    const input = { ...f.input(), trigger: { kind: 'interval' as const, intervalMinutes: 30 },
      sessionTarget: { mode: 'derive-from-session' as const, sourceSessionId: 'source-a', reuseDerived: true } };
    const schedule = await f.save(input), first = (await f.run(schedule)).schedules[0]!;
    const renamed = (await f.manager.save({ ...input, id: first.id, expectedRevision: first.revision, name: 'Renamed lifecycle check' })).schedules[0]!;
    expect(renamed.boundSessionId).toBe('derived-source-a');
    const unbound = (await f.manager.save({ ...input, id: renamed.id, expectedRevision: renamed.revision,
      sessionTarget: { mode: 'derive-from-session', sourceSessionId: 'source-a', reuseDerived: false } })).schedules[0]!;
    expect(unbound.boundSessionId).toBeUndefined();
  });

  it('rechecks a captured automatic deadline after a manual occurrence has already advanced it', async () => {
    const f = await fixture(), firstEntered = deferred(), firstRelease = deferred(), lastEntered = deferred();
    releases.push(() => firstRelease.resolve());
    const first = await f.save({ ...f.input('First due'), trigger: { kind: 'interval', intervalMinutes: 1 } });
    const middle = await f.save({ ...f.input('Middle due'), trigger: { kind: 'interval', intervalMinutes: 1 } });
    await f.save({ ...f.input('Last due'), trigger: { kind: 'interval', intervalMinutes: 1 } });
    f.resolve.mockImplementation(async schedule => {
      if (schedule.id === first.id) { firstEntered.resolve(); await firstRelease.promise; }
      return { sessionId: schedule.id };
    });
    f.dispatch.mockImplementation(async (_id, prompt) => { if (prompt === 'Last due') lastEntered.resolve(); });
    f.advance(60_000); f.fire(); await firstEntered.promise;
    await f.run(middle); firstRelease.resolve(); await lastEntered.promise;
    await vi.waitFor(() => expect(f.manager.isBusy).toBe(false));
    expect(f.dispatch.mock.calls.filter(([, prompt]) => prompt === middle.prompt)).toHaveLength(1);
    expect((await f.list()).schedules.find(item => item.id === middle.id)).toMatchObject({ runCount: 1 });
  });

  it('observes an automatic reservation write failure, preserves disk and halts further effects', async () => {
    const f = await fixture(), schedule = await f.save(), file = path.join(f.directory, 'schedules.json');
    const before = await readFile(file, 'utf8');
    vi.spyOn(jsonStore, 'writeJsonAtomic').mockRejectedValueOnce(new Error('Controlled reservation write failure.'));
    f.advance(60_000); f.fire();
    await vi.waitFor(async () => expect((await f.list()).problem).toBe('storage-unavailable'));
    await vi.waitFor(() => expect(f.manager.isBusy).toBe(false));
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(f.dispatch).not.toHaveBeenCalled(); expect(f.activeTimers()).toEqual([]);
    const current = (await f.list()).schedules.find(item => item.id === schedule.id)!;
    await expect(f.run(current)).rejects.toThrow(/storage is unavailable/);
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it('does not retry an accepted automatic effect when its final receipt cannot be persisted', async () => {
    const f = await fixture(); await f.save();
    const write = jsonStore.writeJsonAtomic; let writes = 0;
    vi.spyOn(jsonStore, 'writeJsonAtomic').mockImplementation(async (...args) => {
      if (++writes === 2) throw new Error('Controlled settlement write failure.');
      return write(...args);
    });
    f.advance(60_000); f.fire();
    await vi.waitFor(async () => expect((await f.list()).problem).toBe('storage-unavailable'));
    await vi.waitFor(() => expect(f.manager.isBusy).toBe(false));
    expect(f.dispatch).toHaveBeenCalledOnce(); expect(f.activeTimers()).toEqual([]);
    const saved = JSON.parse(await readFile(path.join(f.directory, 'schedules.json'), 'utf8')) as { schedules: GeneralSchedule[] };
    expect(saved.schedules[0]?.state).toBe('running');
    await expect(f.run((await f.list()).schedules[0]!)).rejects.toThrow(/storage is unavailable/);
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
});
