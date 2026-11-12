import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LearningSchedule, type ScheduledLearningInput } from '../src/learningSchedule.js';
import { normalizeLearningScheduleAction, type LearningSkillNotice } from '@extalia/platform';

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

  it('leaves empty and terminal-only wakes out of the busy lifetime and revision', async () => {
    const queue = new LearningSchedule();
    const empty = queue.snapshot(); queue.wake();
    expect(queue.snapshot()).toEqual(empty); expect(queue.isBusy).toBe(false);
    queue.schedule(entry('finished'));
    await vi.advanceTimersByTimeAsync(60_000);
    const finished = queue.snapshot(); queue.wake();
    expect(queue.snapshot()).toEqual(finished); expect(queue.isBusy).toBe(false);
    await queue.close();
  });

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

  it('starts the full quiet interval from final idle rather than the old deadline', async () => {
    let ready = false;
    const queue = new LearningSchedule();
    const task = entry('run-a', { ready: () => ready });
    queue.schedule(task);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queue.snapshot().jobs[0]!.reason).toBe('busy');
    expect(queue.snapshot().jobs[0]!.waitingForIdle).toBe(true);
    expect(task.validate).not.toHaveBeenCalled();
    queue.deferWorkspace('workspace-a');
    ready = true; queue.wake();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(task.execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(task.execute).toHaveBeenCalledTimes(1);
    await queue.close();
  });

  it('resets a selected ten-minute snooze after all workers settle, even beyond its former deadline', async () => {
    let workers = 0;
    const queue = new LearningSchedule();
    const second = entry('run-b');
    second.ready = () => workers === 0;
    queue.schedule(second);
    queue.act({ id: second.id, revision: queue.snapshot().revision, action: 'snooze' });
    const staleRevision = queue.snapshot().revision;
    await vi.advanceTimersByTimeAsync(550_000);
    workers = 2; await queue.yieldForForeground();
    await vi.advanceTimersByTimeAsync(150_000);
    expect(second.execute).not.toHaveBeenCalled();
    expect(queue.snapshot().jobs[0]).toMatchObject({ state: 'scheduled', reason: 'busy', waitingForIdle: true });
    expect(() => queue.act({ id: second.id, revision: staleRevision, action: 'run-now' })).toThrow('changed');
    workers--; queue.wake(); await vi.advanceTimersByTimeAsync(100_000);
    expect(second.execute).not.toHaveBeenCalled();
    workers--; queue.wake();
    expect(queue.snapshot().jobs[0]).toMatchObject({ waitingForIdle: false, dueAt: '2026-01-01T00:23:20.000Z' });
    await vi.advanceTimersByTimeAsync(599_999); expect(second.execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(second.execute).toHaveBeenCalledTimes(1);
    await queue.close();
  });

  it('keeps Run now waiting for ownership and discards immediate intent on a fresh task', async () => {
    let ready = false;
    const queue = new LearningSchedule();
    const first = entry('run-now', { ready: () => ready }); queue.schedule(first);
    queue.act({ id: first.id, revision: queue.snapshot().revision, action: 'run-now' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(first.execute).not.toHaveBeenCalled(); expect(queue.snapshot().jobs[0]!.waitingForIdle).toBe(true);
    ready = true; queue.wake(); await vi.advanceTimersByTimeAsync(0);
    expect(first.execute).toHaveBeenCalledTimes(1);
    ready = false;
    const next = entry('next-task', { ready: () => ready }); queue.schedule(next);
    queue.act({ id: next.id, revision: queue.snapshot().revision, action: 'run-now' });
    await queue.yieldForForeground();
    ready = true; queue.wake(); await vi.advanceTimersByTimeAsync(59_999);
    expect(next.execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(next.execute).toHaveBeenCalledTimes(1);
    await queue.close();
  });

  it('ignores a timer callback retained before a snooze or foreground generation change', async () => {
    const callbacks: (() => void)[] = [];
    const queue = new LearningSchedule({ setTimer: (callback, milliseconds) => { callbacks.push(callback); return setTimeout(callback, milliseconds); } });
    const task = entry('stale-timer'); queue.schedule(task);
    const stale = callbacks[0]!;
    queue.act({ id: task.id, revision: queue.snapshot().revision, action: 'snooze' });
    const current = queue.snapshot();
    stale();
    expect(queue.snapshot()).toEqual(current); expect(task.execute).not.toHaveBeenCalled();
    await queue.close();
  });

  it('coalesces only unentered meetings for the same workspace and retains the selected snooze', async () => {
    let ready = true;
    const queue = new LearningSchedule();
    const old = entry('meeting-old', { kind: 'knowledge-meeting', ready: () => ready });
    queue.schedule(old); queue.act({ id: old.id, revision: queue.snapshot().revision, action: 'snooze' });
    for (let index = 0; index < 15; index++) queue.schedule(entry(`learning-${index}`, { ready: () => ready }));
    ready = false; await queue.yieldForForeground();
    const latest = entry('meeting-latest', { kind: 'knowledge-meeting', workspaceName: 'Latest project', sessionId: 'session-latest', sessionName: 'Latest work', ready: () => ready });
    expect(queue.schedule(latest)).toBe(true);
    expect(queue.snapshot().jobs).toHaveLength(16);
    expect(queue.snapshot().jobs.some(job => job.id === old.id)).toBe(false);
    expect(queue.schedule(old)).toBe(false);
    await vi.advanceTimersByTimeAsync(900_000);
    expect(old.execute).not.toHaveBeenCalled(); expect(latest.execute).not.toHaveBeenCalled();
    ready = true; queue.wake();
    expect(queue.snapshot().jobs.find(job => job.id === latest.id)).toMatchObject({ workspaceName: 'Latest project', sessionId: 'session-latest', sessionName: 'Latest work', dueAt: '2026-01-01T00:25:00.000Z', waitingForIdle: false });
    await vi.advanceTimersByTimeAsync(599_999); expect(latest.execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(latest.execute).toHaveBeenCalledTimes(1);
    await queue.close();
  });

  it('aborts active knowledge work and drains a provider that ignores abort before yielding', async () => {
    let ready = true, signal!: AbortSignal;
    const finish = deferred<void>();
    const queue = new LearningSchedule();
    const active = entry('active-curator', { execute: vi.fn(async value => { signal = value; await finish.promise; }), ready: () => ready });
    const pending = entry('pending-meeting', { kind: 'knowledge-meeting', ready: () => ready });
    queue.schedule(active); queue.schedule(pending);
    await vi.advanceTimersByTimeAsync(60_000);
    ready = false;
    let yielded = false;
    const yielding = queue.yieldForForeground().then(() => { yielded = true; });
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(yielded).toBe(false); expect(queue.isBusy).toBe(true); expect(pending.execute).not.toHaveBeenCalled();
    finish.resolve(); await yielding;
    expect(queue.isBusy).toBe(false);
    expect(queue.snapshot().jobs.find(job => job.id === active.id)).toMatchObject({ state: 'cancelled', reason: 'busy' });
    expect(queue.schedule(active)).toBe(false);
    ready = true; queue.wake();
    await vi.advanceTimersByTimeAsync(59_999); expect(pending.execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(pending.execute).toHaveBeenCalledTimes(1);
    expect(active.execute).toHaveBeenCalledTimes(1);
    await queue.close();
  });

  it('fences asynchronous validation on foreground admission and resumes only an unentered source', async () => {
    let ready = true;
    const validation = deferred<boolean>();
    const queue = new LearningSchedule();
    const task = entry('validating', { ready: () => ready, validate: vi.fn(() => validation.promise) });
    queue.schedule(task); await vi.advanceTimersByTimeAsync(60_000);
    ready = false;
    let yielded = false;
    const yielding = queue.yieldForForeground().then(() => { yielded = true; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(yielded).toBe(false); expect(task.execute).not.toHaveBeenCalled();
    validation.resolve(true); await yielding;
    expect(queue.snapshot().jobs[0]).toMatchObject({ state: 'scheduled', waitingForIdle: true, reason: 'busy' });
    ready = true; queue.wake(); await vi.advanceTimersByTimeAsync(59_999);
    expect(task.execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(task.execute).toHaveBeenCalledTimes(1);
    await queue.close();
  });

  it.each([false, true])('distinguishes curator-owned readiness pulses from real foreground work (foreground: %s)', async foreground => {
    let ready = true;
    const finish = deferred<void>();
    const queue = new LearningSchedule();
    const curator = entry('curator', { execute: () => finish.promise, ready: () => ready });
    const meeting = entry('meeting', { kind: 'knowledge-meeting', ready: () => ready });
    queue.schedule(curator); queue.schedule(meeting);
    queue.act({ id: meeting.id, revision: queue.snapshot().revision, action: 'snooze' });
    const deadline = queue.snapshot().jobs.find(job => job.id === meeting.id)!.dueAt;
    await vi.advanceTimersByTimeAsync(60_000);
    ready = false; queue.wake();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(queue.snapshot().jobs.find(job => job.id === meeting.id)).toMatchObject({ dueAt: deadline, waitingForIdle: false });
    if (foreground) {
      const yielding = queue.yieldForForeground();
      expect(queue.snapshot().jobs.find(job => job.id === meeting.id)!.waitingForIdle).toBe(true);
      finish.resolve(); await yielding;
      await vi.advanceTimersByTimeAsync(30_000);
      ready = true; queue.wake();
      expect(queue.snapshot().jobs.find(job => job.id === meeting.id)!.dueAt).toBe('2026-01-01T00:13:30.000Z');
      await vi.advanceTimersByTimeAsync(599_999); expect(meeting.execute).not.toHaveBeenCalled();
    } else {
      ready = true; queue.wake();
      finish.resolve(); await vi.advanceTimersByTimeAsync(0);
      expect(queue.snapshot().jobs.find(job => job.id === meeting.id)!.dueAt).toBe(deadline);
      await vi.advanceTimersByTimeAsync(419_999); expect(meeting.execute).not.toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(1); expect(meeting.execute).toHaveBeenCalledTimes(1);
    await queue.close();
  });

  it('records positive partial receipts before a later failure without implying activation or saved knowledge', async () => {
    const finish = deferred<void>();
    const queue = new LearningSchedule();
    const skill: LearningSkillNotice = { id: 'skill-receipt', profileId: 'profile-a', workspaceId: 'workspace-a', sessionId: 'session-a', runId: 'partial', createdAt: new Date().toISOString(), kind: 'skill-candidate', packageId: 'package-a', revisionId: 'revision-a', state: 'quarantined', change: 'saved', activationPerformed: false, partial: true };
    const task = entry('partial', { execute: async () => {
      queue.recordResult('partial', { skill });
      await finish.promise;
      queue.recordResult('partial', { meeting: { outcome: 'completed', knowledge: 'failed', problem: 'Minutes export failed.' } });
      throw new Error('Cleanup failed after the candidate was saved.');
    } });
    expect(() => queue.recordResult(task.id, { skill })).toThrow('no longer');
    queue.schedule(task); await vi.advanceTimersByTimeAsync(60_000);
    expect(queue.snapshot().jobs[0]).toMatchObject({ state: 'running', result: { skill } });
    const copy = queue.snapshot(); copy.jobs[0]!.result!.skill!.state = 'changed';
    skill.state = 'changed';
    expect(queue.snapshot().jobs[0]!.result!.skill!.state).toBe('quarantined');
    expect(() => queue.recordResult(task.id, { skill: { ...skill, profileId: 'foreign' } })).toThrow('another source');
    expect(() => queue.recordResult(task.id, { skill: { ...skill, activationPerformed: true } as unknown as LearningSkillNotice })).toThrow('Invalid');
    finish.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(queue.snapshot().jobs[0]).toMatchObject({ state: 'failed', result: { skill: { state: 'quarantined', partial: true }, meeting: { outcome: 'completed', knowledge: 'failed' } } });
    expect(queue.snapshot().jobs[0]!.result!.meeting!.notePath).toBeUndefined();
    expect(() => queue.recordResult(task.id, { skill })).toThrow('no longer');
    await queue.close();
  });

  it('retains a real saved-note receipt arriving during physical cancellation drain', async () => {
    const finish = deferred<void>();
    const queue = new LearningSchedule();
    queue.schedule(entry('saved-late', { kind: 'knowledge-meeting', execute: async () => {
      await finish.promise;
      queue.recordResult('saved-late', { meeting: { outcome: 'cancelled', meetingId: 'meeting-a', knowledge: 'saved', notePath: 'Meetings/workspace-a/meeting-a.md' } });
    } }));
    await vi.advanceTimersByTimeAsync(60_000);
    const closing = queue.close(); finish.resolve(); await closing;
    expect(queue.snapshot().jobs[0]).toMatchObject({ state: 'cancelled', reason: 'shutdown', result: { meeting: { knowledge: 'saved', notePath: 'Meetings/workspace-a/meeting-a.md' } } });
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
