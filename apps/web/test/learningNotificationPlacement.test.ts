import { isValidElement, type ReactElement } from 'react';
import type { LearningScheduleSnapshot } from '@extalia/platform';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LearningCountdownPlacement, type LearningCountdownView } from '../src/knowledge/LearningCountdown';
import { MESSAGES } from '../src/i18n';

const portals = vi.hoisted(() => [] as { view: ReactElement; target: HTMLElement }[]);
vi.mock('react-dom', () => ({ createPortal: (view: ReactElement, target: HTMLElement) => { portals.push({ view, target }); return view; } }));
const stamp = '2026-11-16T03:00:00.000Z';
const job = (id: string, state: LearningScheduleSnapshot['jobs'][number]['state'] = 'scheduled'): LearningScheduleSnapshot['jobs'][number] => ({
  id, workspaceId: 'workspace', profileId: 'profile', profileName: 'Project vault', sessionId: 'session',
  kind: 'knowledge-meeting', state, createdAt: stamp, dueAt: stamp,
});
function placement(jobs: LearningScheduleSnapshot['jobs'], accepted: string[] = [], embedded = true, target: HTMLElement | null = {} as HTMLElement, compactTarget?: HTMLElement | null) {
  const tree = LearningCountdownPlacement({ t: MESSAGES.en, snapshot: { revision: 'r1', delaySeconds: 60, snoozeSeconds: 600, jobs },
    now: Date.parse(stamp), accepted, embedded, target, compactTarget, onAction: vi.fn(), onDismiss: vi.fn() });
  return (tree.props.children as unknown[]).filter(isValidElement) as ReactElement<Parameters<typeof LearningCountdownView>[0]>[];
}
beforeEach(() => { portals.length = 0; });

describe('learning foreground and corner placement', () => {
  it('retains only unaccepted decisions above the prompt and gives background work one compact owner', () => {
    const views = placement([job('waiting'), job('accepted'), job('running', 'running'), job('failed', 'failed')], ['accepted']);
    expect(views).toHaveLength(2);
    expect(views[0]!.props.snapshot.jobs.map(value => value.id)).toEqual(['waiting']);
    expect(views[0]!.props.embedded).toBe(true);
    expect(views[1]!.props.snapshot.jobs.map(value => value.id)).toEqual(['accepted', 'running', 'failed']);
    expect(views[1]!.props.compact).toBe(true);
    expect(views[1]!.props.embedded).toBe(false);
  });
  it('immediately places an explicitly requested ten-second meeting in the corner', () => {
    const views = placement([{ ...job('manual'), delaySeconds: 10 }]);
    expect(views[0]!.props.snapshot.jobs).toEqual([]);
    expect(views[1]!.props.snapshot.jobs.map(value => value.id)).toEqual(['manual']);
  });
  it('keeps running work visible when an inline prompt target is unavailable', () => {
    const views = placement([job('running', 'running')], [], true, null);
    expect(views).toHaveLength(1);
    expect(views[0]!.props.compact).toBe(true);
    expect(views[0]!.props.snapshot.jobs[0]!.id).toBe('running');
  });
  it.each(['office-canvas', 'page-content'])('uses a distinct %s compact target without moving pending decisions from the prompt', compactId => {
    const prompt = { id: 'prompt' } as HTMLElement, compact = { id: compactId } as HTMLElement;
    const views = placement([job('pending'), job('running', 'running')], [], true, prompt, compact);
    expect(portals.map(portal => portal.target)).toEqual([prompt, compact]);
    expect(views).toHaveLength(2);
    expect(views.filter(view => view.props.compact)).toHaveLength(1);
    expect(portals[0]!.view).toBe(views[0]);
    expect(portals[1]!.view).toBe(views[1]);
    expect(views[0]!.props.snapshot.jobs.map(job => job.id)).toEqual(['pending']);
    expect(views[1]!.props.snapshot.jobs.map(job => job.id)).toEqual(['running']);
    expect(views[1]!.props.embedded).toBe(false);
  });
  it('keeps the compact portal visible while a foreground prompt target is mounting', () => {
    const compact = { id: 'page-content' } as HTMLElement;
    const views = placement([job('pending'), job('running', 'running')], [], true, null, compact);
    expect(portals.map(portal => portal.target)).toEqual([compact]);
    expect(views).toHaveLength(1);
    expect(views[0]!.props.compact).toBe(true);
    expect(views[0]!.props.snapshot.jobs.map(job => job.id)).toEqual(['running']);
  });
  it('renders exactly one compact fallback when both targets are unavailable', () => {
    const views = placement([job('pending'), job('failed', 'failed')], [], false, null, null);
    expect(portals).toEqual([]);
    expect(views).toHaveLength(2);
    expect(views.filter(view => view.props.compact)).toHaveLength(1);
    expect(views[0]!.props.snapshot.jobs.map(job => job.id)).toEqual(['pending']);
    expect(views[1]!.props.snapshot.jobs.map(job => job.id)).toEqual(['failed']);
  });
});
