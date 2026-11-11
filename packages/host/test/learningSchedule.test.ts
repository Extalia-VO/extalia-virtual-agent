import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LearningSchedule, type ScheduledLearningInput } from '../src/learningSchedule.js';
import { normalizeLearningScheduleAction } from '@extalia/platform';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function entry(id: string, overrides: Partial<ScheduledLearningInput> = {}): ScheduledLearningInput {
  return { id, workspaceId: 'workspace-a', profileId: 'profile-a', profileName: 'Research', sessionId: 'session-a',
    execute: vi.fn(async () => undefined), validate: vi.fn(async () => true), ready: () => true, ...overrides };
}

describe('learning admission schedule', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('waits for the authoritative deadline before validation or execution and clones snapshots', async () => {
    const queue = new LearningSchedule();
    const task = entry('run-a');
    expect(queue.schedule(task)).toBe(true);
    queue.snapshot().jobs[0]!.state = 'cancelled';
    await vi.advanceTimersByTimeAsync(59_999);
    expect(task.validate).not.toHaveBeenCalled();
    expect(task.execute).not.toHaveBeenCalled();
    expect(queue.isBusy).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(task.execute).toHaveBeenCalledTimes(1);
    expect(queue.snapshot().jobs[0]!.state).toBe('completed');
    expect(queue.isBusy).toBe(false);
    await queue.close();
  });

  it('revision-checks snooze and run-now, admitting run-now without waiting for execution', async () => {
    const finish = deferred<void>();
    const queue = new LearningSchedule();
    const task = entry('run-a', { execute: vi.fn(() => finish.promise) });
    queue.schedule(task);
    const revision = queue.snapshot().revision;
    queue.act({ id: task.id, revision, action: 'snooze' });
    expect(queue.snapshot().jobs[0]!.dueAt).toBe('2026-01-01T00:10:00.000Z');
    expect(() => queue.act({ id: task.id, revision, action: 'run-now' })).toThrow(/changed/);
    queue.act({ id: task.id, revision: queue.snapshot().revision, action: 'run-now' });
    expect(task.execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.isBusy).toBe(true);
    expect(() => queue.act({ id: task.id, revision: queue.snapshot().revision, action: 'snooze' })).toThrow(/no longer waiting/);
    finish.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(task.execute).toHaveBeenCalledTimes(1);
    await queue.close();
  });

  it('notifies idle observers only after the final physical effect settles', async () => {
    const finish = deferred<void>();
    const observed: boolean[] = [];
    const queue = new LearningSchedule({ onChange: () => observed.push(queue.isBusy) });
    queue.schedule(entry('run-idle', { execute: () => finish.promise }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(observed.at(-1)).toBe(true);
    finish.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(observed.at(-1)).toBe(false);
    expect(queue.snapshot().jobs[0]!.state).toBe('completed');
    await queue.close();
  });

  it('serializes work, bounds pending admissions, and deduplicates terminal sources', async () => {
    const finish = deferred<void>();
    const queue = new LearningSchedule();
    const first = entry('run-0', { execute: vi.fn(() => finish.promise) });
    queue.schedule(first);
    const later = Array.from({ length: 15 }, (_, index) => entry(`run-${index + 1}`));
    for (const task of later) expect(queue.schedule(task)).toBe(true);
    expect(queue.schedule(entry('overflow'))).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(later[0]!.execute).not.toHaveBeenCalled();
    expect(queue.schedule(first)).toBe(false);
    finish.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(later.at(-1)!.execute).toHaveBeenCalledTimes(1);
    expect(queue.snapshot().jobs).toHaveLength(8);
    expect(queue.schedule(first)).toBe(false);
    await queue.close();
  });

  it('defers busy work and resets a new prompt quiet period without shortening snooze', async () => {
    let ready = false;
    const queue = new LearningSchedule();
    const task = entry('run-a', { ready: () => ready });
    queue.schedule(task);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queue.snapshot().jobs[0]!.reason).toBe('busy');
    expect(task.validate).not.toHaveBeenCalled();
    queue.deferWorkspace('workspace-a');
    ready = true;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(task.execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(task.execute).toHaveBeenCalledTimes(1);
    const second = entry('run-b');
    queue.schedule(second);
    queue.act({ id: second.id, revision: queue.snapshot().revision, action: 'snooze' });
    const deadline = queue.snapshot().jobs.at(-1)!.dueAt;
    queue.deferWorkspace('workspace-a');
    expect(queue.snapshot().jobs.at(-1)!.dueAt).toBe(deadline);
    await queue.close();
  });

  it('cancels changed destinations before any effect and never automatically retries failures', async () => {
    const queue = new LearningSchedule();
    const changed = entry('changed', { validate: async () => false });
    const failed = entry('failed', { execute: vi.fn(async () => { throw new Error('Unknown acknowledgement'); }) });
    queue.schedule(changed); queue.schedule(failed);
    await vi.advanceTimersByTimeAsync(60_010);
    expect(changed.execute).not.toHaveBeenCalled();
    expect(queue.snapshot().jobs.map(job => [job.state, job.reason])).toEqual([['cancelled', 'changed'], ['failed', 'failed']]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(failed.execute).toHaveBeenCalledTimes(1);
    await queue.close();
  });

  it('owns async validation and waits for shutdown without entering execution', async () => {
    const validation = deferred<boolean>();
    const queue = new LearningSchedule();
    const task = entry('run-a', { validate: () => validation.promise });
    queue.schedule(task);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queue.isBusy).toBe(true);
    let closed = false;
    const closing = queue.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(queue.isBusy).toBe(true);
    validation.resolve(true);
    await closing;
    expect(task.execute).not.toHaveBeenCalled();
    expect(queue.snapshot().jobs[0]!.reason).toBe('shutdown');
    expect(queue.isBusy).toBe(false);
  });

  it('does not release active ownership during invalidation or abort until effects physically settle', async () => {
    const finish = deferred<void>();
    let signal: AbortSignal | undefined;
    const queue = new LearningSchedule();
    queue.schedule(entry('active', { execute: async value => { signal = value; await finish.promise; } }));
    queue.schedule(entry('pending'));
    await vi.advanceTimersByTimeAsync(60_000);
    queue.invalidatePending();
    expect(queue.snapshot().jobs[1]!.reason).toBe('changed');
    expect(queue.isBusy).toBe(true);
    let closed = false;
    const closing = queue.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(signal?.aborted).toBe(true);
    expect(queue.isBusy).toBe(true);
    expect(closed).toBe(false);
    finish.resolve();
    await closing;
    expect(queue.isBusy).toBe(false);
    expect(queue.schedule(entry('late'))).toBe(false);
  });

  it('observes thrown validation/readiness and presentation failures without dropping ownership', async () => {
    const queue = new LearningSchedule({ onChange: () => { throw new Error('Disconnected UI'); } });
    queue.schedule(entry('validation', { validate: async () => { throw new Error('Changed'); } }));
    queue.schedule(entry('readiness', { ready: () => { throw new Error('Unavailable'); } }));
    await vi.advanceTimersByTimeAsync(60_010);
    expect(queue.snapshot().jobs.every(job => job.state === 'failed')).toBe(true);
    expect(queue.isBusy).toBe(false);
    await queue.close();
  });

  it('rejects malformed public actions', () => {
    expect(normalizeLearningScheduleAction({ id: 'job', revision: 'revision', action: 'snooze' })).toEqual({ id: 'job', revision: 'revision', action: 'snooze' });
    expect(() => normalizeLearningScheduleAction({ id: 'job', revision: 'revision', action: 'cancel' })).toThrow();
    expect(() => normalizeLearningScheduleAction({ id: 'job', revision: 'revision', action: 'run-now', root: '/tmp/example' })).toThrow();
  });
});
