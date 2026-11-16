import type * as React from 'react';
import { isValidElement } from 'react';
import type { AgentHostApi, LearningScheduleSnapshot } from '@extalia/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LearningCountdown, type LearningCountdownView } from '../src/knowledge/LearningCountdown';
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

type ViewProps = Parameters<typeof LearningCountdownView>[0];
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
    return isValidElement<ViewProps>(output) ? output.props : undefined;
  };
  return { host, props, render, value };
}
beforeEach(() => {
  hooks.index = 0; hooks.dirty = false; hooks.state = []; hooks.effects.clear(); hooks.pending = []; hooks.targets = [];
  vi.useFakeTimers(); vi.setSystemTime(at);
});
afterEach(() => { stop(); vi.useRealTimers(); });

describe('shared learning notification owner', () => {
  it('waits for an embedded Chat slot without floating over controls, retaining its single poller', async () => {
    const h = harness(); h.props.embedded = true;
    expect(h.render()).toBeUndefined(); await settle();
    expect(h.render()).toBeUndefined();
    expect(h.host.learningSchedule).toHaveBeenCalledOnce();
    const slot = { id: 'chat-slot' } as unknown as HTMLElement;
    h.props.target = slot; let view = h.render()!;
    expect(view.embedded).toBe(true); expect(hooks.targets.at(-1)).toBe(slot);
    const memory = view.noticeMemory; view.onDismiss('job');
    h.props.target = null;
    expect(h.render()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.render()).toBeUndefined(); expect(h.host.learningSchedule).toHaveBeenCalledTimes(2);
    h.props.target = { id: 'next-chat-slot' } as unknown as HTMLElement; view = h.render()!;
    expect(view.noticeMemory).toBe(memory); expect(view.dismissed).toEqual(['job']);
    expect(h.host.learningSchedule).toHaveBeenCalledTimes(2);
  });

  it('keeps one poller, receipt memory and dismissals when moving between Office and other pages', async () => {
    const h = harness(); h.render(); await settle();
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
    await vi.advanceTimersByTimeAsync(1000); h.render();
    expect(h.host.learningSchedule).toHaveBeenCalledTimes(2);
    stop(); await vi.advanceTimersByTimeAsync(30_000);
    expect(h.host.learningSchedule).toHaveBeenCalledTimes(2);
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
