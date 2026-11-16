import type * as React from 'react';
import { isValidElement } from 'react';
import type { AgentHostApi, LearningScheduleSnapshot } from '@extalia/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LearningCountdown, LearningCountdownPlacement, LEARNING_SCHEDULE_REFRESH_EVENT } from '../src/knowledge/LearningCountdown';
import { MESSAGES } from '../src/i18n';

// Drive the real owner and its effect cleanups without a DOM/WebGL renderer.
const hooks = vi.hoisted(() => ({ index: 0, dirty: false, state: [] as unknown[],
  effects: new Map<number, { deps: unknown[]; cleanup?: (() => void) | undefined }>(), pending: [] as (() => void)[],
  targets: [] as unknown[],
}));
vi.mock('react', async original => ({ ...await original<typeof React>(),
  useState: (initial: unknown) => {
    const id = hooks.index++;
    if (!(id in hooks.state)) hooks.state[id] = typeof initial === 'function' ? initial() : initial;
    return [hooks.state[id], (next: unknown) => {
      const value = typeof next === 'function' ? next(hooks.state[id]) : next;
      if (!Object.is(value, hooks.state[id])) { hooks.state[id] = value; hooks.dirty = true; }
    }];
  },
  useRef: (initial: unknown) => { const id = hooks.index++; return hooks.state[id] ??= { current: initial }; },
  useEffect: (run: () => void | (() => void), deps: unknown[]) => {
    const id = hooks.index++, prior = hooks.effects.get(id);
    if (prior?.deps.length === deps.length && prior.deps.every((value, i) => Object.is(value, deps[i]))) return;
    const next = { deps, cleanup: undefined as (() => void) | undefined };
    hooks.effects.set(id, next);
    hooks.pending.push(() => { prior?.cleanup?.(); next.cleanup = run() || undefined; });
  },
}));
vi.mock('react-dom', () => ({ createPortal: (children: React.ReactNode, target: unknown) => {
  hooks.targets.push(target); return children;
} }));

type ViewProps = Parameters<typeof LearningCountdownPlacement>[0];
const at = Date.parse('2026-11-11T06:00:00.000Z');
const snapshot = (): LearningScheduleSnapshot => ({ revision: 'r1', delaySeconds: 60, snoozeSeconds: 600, jobs: [{
  id: 'job', kind: 'knowledge-meeting', workspaceId: 'workspace-a', workspaceName: 'Project A', profileId: 'profile', profileName: 'Example',
  sessionId: 'session-a', sessionName: 'Task A', state: 'scheduled', dueAt: new Date(at + 60_000).toISOString(), createdAt: new Date(at).toISOString(),
}] });
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const stop = () => { for (const effect of hooks.effects.values()) effect.cleanup?.(); hooks.effects.clear(); };
function harness(value = snapshot()) {
  const host = { learningSchedule: vi.fn(async () => value), changeLearningSchedule: vi.fn(async () => value) };
  const props: Parameters<typeof LearningCountdown>[0] = { agents: host as unknown as AgentHostApi, t: MESSAGES.en, target: null };
  const render = () => {
    let output: ReturnType<typeof LearningCountdown>;
    do {
      hooks.index = 0; hooks.dirty = false; output = LearningCountdown(props);
      for (const effect of hooks.pending.splice(0)) effect();
    } while (hooks.dirty);
    if (!isValidElement<ViewProps>(output)) return undefined;
    LearningCountdownPlacement(output.props);
    return output.props;
  };
  return { host, props, render, value };
}
beforeEach(() => {
  hooks.index = 0; hooks.dirty = false; hooks.state = []; hooks.effects.clear(); hooks.pending = []; hooks.targets = [];
  vi.useFakeTimers(); vi.setSystemTime(at);
});
afterEach(() => { stop(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('shared learning notification owner', () => {
  it('waits for an embedded Chat slot without floating over controls, retaining its single poller', async () => {
    const h = harness(); h.value.jobs[0]!.state = 'failed'; h.props.embedded = true;
    expect(h.render()).toBeUndefined(); await settle();
    expect(h.render()).toBeDefined();
    expect(hooks.targets).toHaveLength(0);
    expect(h.host.learningSchedule).toHaveBeenCalledOnce();
    const slot = { id: 'chat-slot' } as unknown as HTMLElement;
    h.props.target = slot; let view = h.render()!;
    expect(view.embedded).toBe(true); expect(hooks.targets.at(-1)).toBe(slot);
    const memory = view.noticeMemory; view.onDismiss('job');
    h.props.target = null;
    expect(h.render()).toBeDefined();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.render()).toBeDefined(); expect(h.host.learningSchedule).toHaveBeenCalledTimes(2);
    h.props.target = { id: 'next-chat-slot' } as unknown as HTMLElement; view = h.render()!;
    expect(view.noticeMemory).toBe(memory); expect(view.dismissed).toEqual(['job']);
    expect(h.host.learningSchedule).toHaveBeenCalledTimes(2);
  });

  it('keeps one poller, receipt memory and dismissals when moving between Office and other pages', async () => {
    const h = harness(); h.value.jobs[0]!.state = 'failed';
    h.value.jobs[0]!.result = { skill: { id: 'saved-receipt', profileId: 'profile', workspaceId: 'workspace-a', sessionId: 'session-a', runId: 'run',
      createdAt: new Date(at).toISOString(), kind: 'skill-candidate', packageId: 'validation', revisionId: 'revision', state: 'quarantined', change: 'saved', activationPerformed: false } };
    h.render(); await settle();
    let view = h.render()!; const memory = view.noticeMemory;
    memory!.record('saved-receipt'); view.onDismiss('job'); view.onDismissSkill!('saved-receipt');
    const slot = { id: 'office-slot' } as unknown as HTMLElement;
    h.props.target = slot; view = h.render()!;
    expect(view.embedded).toBe(true);
    expect(hooks.targets.at(-1)).toBe(slot);
    expect(view.dismissed).toEqual(['job']); expect(view.dismissedSkills).toEqual(['saved-receipt']);
    expect(view.noticeMemory).toBe(memory); expect(view.noticeMemory!.has('saved-receipt')).toBe(true);
    h.props.target = null; h.render();
    h.props.target = { id: 'next-office-slot' } as unknown as HTMLElement; view = h.render()!;
    expect(view.dismissedSkills).toEqual(['saved-receipt']);
    expect(h.host.learningSchedule).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000); h.render();
    expect(h.host.learningSchedule).toHaveBeenCalledTimes(2);
    stop(); await vi.advanceTimersByTimeAsync(30_000);
    expect(h.host.learningSchedule).toHaveBeenCalledTimes(2);
  });

  it('refreshes after manual scheduling without creating parallel pollers', async () => {
    vi.stubGlobal('window', new EventTarget());
    const h = harness(); h.render(); await settle(); h.render();
    const pending = deferred<LearningScheduleSnapshot>(); h.host.learningSchedule.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(1000);
    window.dispatchEvent(new Event(LEARNING_SCHEDULE_REFRESH_EVENT));
    window.dispatchEvent(new Event(LEARNING_SCHEDULE_REFRESH_EVENT));
    expect(h.host.learningSchedule).toHaveBeenCalledTimes(2);
    pending.resolve(h.value); await settle(); h.render();
    expect(h.host.learningSchedule).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000); h.render();
    expect(h.host.learningSchedule).toHaveBeenCalledTimes(4);
  });

  it('keeps once-started work in the corner after transient admission deferral while a new decision stays inline', async () => {
    const initial = snapshot(); initial.jobs[0]!.state = 'running';
    const h = harness(initial); h.props.target = { id: 'chat-slot' } as HTMLElement;
    h.render(); await settle();
    expect(h.render()!.accepted).toEqual(['job']);
    h.host.learningSchedule.mockResolvedValueOnce({ ...initial, revision: 'r2', jobs: [
      { ...initial.jobs[0]!, state: 'scheduled' }, { ...initial.jobs[0]!, id: 'new-decision', state: 'scheduled' },
    ] });
    await vi.advanceTimersByTimeAsync(1000);
    const view = h.render()!;
    const placed = LearningCountdownPlacement(view).props.children as React.ReactElement<ViewProps>[];
    expect(placed[0]!.props.snapshot.jobs.map(job => job.id)).toEqual(['new-decision']);
    expect(placed[1]!.props.snapshot.jobs.map(job => job.id)).toEqual(['job']);
    expect(placed[1]!.props.compact).toBe(true);
    expect(h.host.changeLearningSchedule).not.toHaveBeenCalled();
  });

  it('bounds the remembered started jobs across snapshot history', async () => {
    const initial = snapshot();
    initial.jobs = Array.from({ length: 130 }, (_, index) => ({ ...initial.jobs[0]!, id: `started-${index}`, state: 'running' }));
    const h = harness(initial); h.render(); await settle();
    const remembered = h.render()!.accepted!;
    expect(remembered).toHaveLength(128);
    expect(remembered).not.toContain('started-0');
    expect(remembered).toContain('started-129');
  });

  it('keeps terminal closes through owner remount while a new attempt and resumed active work stay visible', async () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } });
    const initial = snapshot(); initial.jobs[0]!.state = 'completed';
    const h = harness(initial); h.props.dismissalScope = 'host-profile';
    h.render(); await settle(); h.render()!.onDismiss('job');
    expect(h.render()!.dismissed).toEqual(['job']);
    stop(); hooks.state = []; hooks.index = 0; hooks.pending = [];
    const reloaded = harness(initial); reloaded.props.dismissalScope = 'host-profile';
    reloaded.render(); await settle();
    expect(reloaded.render()!.dismissed).toEqual(['job']);
    reloaded.host.learningSchedule.mockResolvedValueOnce({ ...initial, revision: 'new-host-revision', jobs: [{ ...initial.jobs[0]!, state: 'running' }] });
    await vi.advanceTimersByTimeAsync(5000);
    const active = reloaded.render()!;
    expect(active.dismissed).toEqual([]);
    active.onDismiss('job'); expect(reloaded.render()!.dismissed).toEqual([]);
    reloaded.host.learningSchedule.mockResolvedValueOnce({ ...initial, revision: 'r3', jobs: [{ ...initial.jobs[0]!, createdAt: new Date(at + 1).toISOString() }] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(reloaded.render()!.dismissed).toEqual([]);
  });

  it('refreshes terminal acknowledgements from another tab storage event without affecting another scope', async () => {
    const data = new Map<string, string>();
    const cache = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    vi.stubGlobal('localStorage', cache); vi.stubGlobal('window', new EventTarget());
    const initial = snapshot(); initial.jobs[0]!.state = 'failed';
    const h = harness(initial); h.props.dismissalScope = 'host-profile';
    h.render(); await settle(); expect(h.render()!.dismissed).toEqual([]);
    const { createLearningNoticeDismissals } = await import('../src/knowledge/learningNoticeDismissals');
    const otherTab = createLearningNoticeDismissals('host-profile', () => cache); otherTab.dismissJob(initial.jobs[0]!);
    const event = new Event('storage'); Object.assign(event, { key: otherTab.key }); window.dispatchEvent(event);
    expect(h.render()!.dismissed).toEqual(['job']);
    h.props.dismissalScope = 'different-host';
    expect(h.render()!.dismissed).toEqual([]);
  });

  it('never executes at zero and rejects Run now during foreground work', async () => {
    const h = harness(); h.value.jobs[0]!.waitingForIdle = true;
    h.render(); await settle(); let view = h.render()!;
    view.onAction(view.snapshot.jobs[0]!, 'run-now');
    expect(h.host.changeLearningSchedule).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(70_000); view = h.render()!;
    expect(view.now).toBeGreaterThan(at + 60_000);
    expect(h.host.changeLearningSchedule).not.toHaveBeenCalled();
    view.onAction(view.snapshot.jobs[0]!, 'snooze'); await settle();
    expect(h.host.changeLearningSchedule).toHaveBeenCalledExactlyOnceWith('job', 'r1', 'snooze');
  });

  it('sends the exact host revision once and ignores a prior poll response after an action', async () => {
    const h = harness(); h.render(); await settle(); h.render();
    const olderPoll = deferred<LearningScheduleSnapshot>(); h.host.learningSchedule.mockReturnValueOnce(olderPoll.promise);
    await vi.advanceTimersByTimeAsync(1000);
    const result = deferred<LearningScheduleSnapshot>(); h.host.changeLearningSchedule.mockReturnValueOnce(result.promise);
    const view = h.render()!;
    view.onAction(view.snapshot.jobs[0]!, 'run-now'); view.onAction(view.snapshot.jobs[0]!, 'snooze');
    expect(h.host.changeLearningSchedule).toHaveBeenCalledExactlyOnceWith('job', 'r1', 'run-now');
    expect(h.render()!.busyId).toBe('job');
    result.resolve({ ...h.value, revision: 'r2', jobs: [{ ...h.value.jobs[0]!, state: 'running' }] }); await settle();
    expect(h.render()!.snapshot.revision).toBe('r2'); expect(h.render()!.busyId).toBeUndefined();
    olderPoll.resolve(h.value); await settle();
    expect(h.render()!.snapshot.revision).toBe('r2');
  });

  it('resolves a rejected stale revision from the host without editing its deadline locally', async () => {
    const h = harness(); h.render(); await settle(); const view = h.render()!;
    h.host.changeLearningSchedule.mockRejectedValueOnce(new Error('Schedule changed.'));
    const latest = { ...h.value, revision: 'r3', jobs: [{ ...h.value.jobs[0]!, waitingForIdle: true }] };
    h.host.learningSchedule.mockResolvedValueOnce(latest);
    view.onAction(view.snapshot.jobs[0]!, 'snooze'); await settle();
    const updated = h.render()!;
    expect(updated.snapshot).toBe(latest); expect(updated.error).toBe('Schedule changed.');
    expect(updated.busyId).toBeUndefined(); expect(updated.snapshot.jobs[0]!.dueAt).toBe(h.value.jobs[0]!.dueAt);
  });

  it('ignores late replies after owner disposal and supports older hosts without the schedule API', async () => {
    const h = harness(); h.render(); await settle(); const view = h.render()!;
    const late = deferred<LearningScheduleSnapshot>(); h.host.changeLearningSchedule.mockReturnValueOnce(late.promise);
    view.onAction(view.snapshot.jobs[0]!, 'run-now'); h.render(); stop(); hooks.dirty = false;
    late.resolve({ ...h.value, revision: 'late' }); await settle();
    expect(hooks.dirty).toBe(false);
    hooks.state = []; hooks.index = 0; h.props.agents = {} as AgentHostApi;
    expect(h.render()).toBeUndefined();
  });
});
