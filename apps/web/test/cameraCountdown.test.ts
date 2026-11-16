import { describe, expect, it } from 'vitest';
import { cameraTourCountdown } from '../src/office/cameraCountdown';
import { createCameraDirectorState, stepCameraDirector, type CameraDirectorInput, type CameraDirectorState } from '../src/office/cameraDirector';

const input = (patch: Partial<CameraDirectorInput> = {}): CameraDirectorInput => ({ now: 170_000, enabled: true, suspended: false,
  lastInteractionAt: 0, workingIds: ['current', 'next'], attentionIds: [], currentFloor: 1, floorOf: () => 1, ...patch });
const state = (patch: Partial<CameraDirectorState> = {}): CameraDirectorState => ({ ...createCameraDirectorState(),
  command: { phase: 'focus', mode: 'tour', targetId: 'current', fromId: null }, observedInteractionAt: 0,
  phaseStartedAt: 60_000, dwellMs: 120_000, lastTourId: 'current', ...patch });

describe('auto camera next-visit countdown', () => {
  it('shows only the final ten seconds for a working destination, rounds up, and never emits zero', () => {
    expect(cameraTourCountdown(state(), input({ now: 169_999 }))).toBeNull();
    expect(cameraTourCountdown(state(), input())).toEqual({ targetId: 'next', seconds: 10, windowSeconds: 10 });
    expect(cameraTourCountdown(state(), input({ now: 170_001 }))?.seconds).toBe(10);
    expect(cameraTourCountdown(state(), input({ now: 179_999 }))?.seconds).toBe(1);
    expect(cameraTourCountdown(state(), input({ now: 180_000 }))).toBeNull();
    expect(cameraTourCountdown(state(), input({ now: 180_001 }))).toBeNull();
  });

  it('uses five seconds for an idle destination even when the current character works', () => {
    const next = input({ workingIds: ['current'], idleIds: ['idle'] });
    expect(cameraTourCountdown(state(), { ...next, now: 174_999 })).toBeNull();
    expect(cameraTourCountdown(state(), { ...next, now: 175_000 })).toEqual({ targetId: 'idle', seconds: 5, windowSeconds: 5 });
    expect(cameraTourCountdown(state(), { ...next, now: 179_999 })?.seconds).toBe(1);
  });

  it('classifies the actual next unique candidate from the live roster', () => {
    const current = state({ command: { phase: 'focus', mode: 'tour', targetId: 'idle', fromId: 'current' } });
    expect(cameraTourCountdown(current, input({ workingIds: ['working', 'working'], idleIds: ['idle', 'working'] })))
      .toEqual({ targetId: 'working', seconds: 10, windowSeconds: 10 });
    expect(cameraTourCountdown(state(), input({ workingIds: ['current'], idleIds: ['next'], now: 170_000 }))).toBeNull();
    expect(cameraTourCountdown(state(), input({ workingIds: ['current', 'replacement'], now: 175_000 }))?.targetId).toBe('replacement');
    expect(cameraTourCountdown(state(), input({ workingIds: ['missing-current', 'next'] }))).toBeNull();
  });

  it.each([
    { enabled: false }, { suspended: true }, { reducedMotion: true }, { attentionIds: ['requester'] }, { lastInteractionAt: 169_999 },
  ])('hides when the director cannot make an ordinary transition: %j', patch => {
    expect(cameraTourCountdown(state(), input(patch))).toBeNull();
  });

  it('hides for attention ownership, paused shots, transitions, no shot and a single unique character', () => {
    for (const patch of [
      { heldAttentionId: 'requester' }, { pausedAt: 165_000 }, { command: null },
      { command: { phase: 'overview' as const, mode: 'tour' as const, targetId: 'current', fromId: null } },
      { command: { phase: 'travel' as const, mode: 'tour' as const, targetId: 'current', fromId: null } },
      { command: { phase: 'focus' as const, mode: 'attention' as const, targetId: 'current', fromId: null } },
    ]) expect(cameraTourCountdown(state(patch), input())).toBeNull();
    expect(cameraTourCountdown(state(), input({ workingIds: ['current', 'current'], idleIds: ['current'] }))).toBeNull();
    expect(cameraTourCountdown(state(), input({ workingIds: [], idleIds: [] }))).toBeNull();
  });

  it('uses the walking hard cap instead of counting down a held dwell', () => {
    const walking = state({ dwellMs: 30_000, movementSeen: true });
    expect(cameraTourCountdown(walking, input({ now: 85_000 }))).toBeNull();
    expect(cameraTourCountdown(walking, input({ now: 170_000 }))).toEqual({ targetId: 'next', seconds: 10, windowSeconds: 10 });
    expect(cameraTourCountdown(walking, input({ now: 180_000 }))).toBeNull();
  });

  it('tracks arrival settlement, bounded by the walking cap and original dwell', () => {
    const arrived = state({ dwellMs: 30_000, movementSeen: true, movementStoppedAt: 100_000 });
    expect(cameraTourCountdown(arrived, input({ now: 100_000 }))?.seconds).toBe(5);
    expect(cameraTourCountdown(arrived, input({ now: 104_999 }))?.seconds).toBe(1);
    expect(cameraTourCountdown(arrived, input({ now: 105_000 }))).toBeNull();
    expect(cameraTourCountdown(state({ movementSeen: true, movementStoppedAt: 100_000 }), input())?.seconds).toBe(10);
    expect(cameraTourCountdown(state({ dwellMs: 30_000, movementSeen: true, movementStoppedAt: 178_000 }), input({ now: 179_000 }))?.seconds).toBe(1);
  });

  it('waits for an early newcomer ordinary-tour grace, including paused time', () => {
    const newcomer = state({ phaseStartedAt: 2_000, dwellMs: 20_000, newcomerTargetId: 'current', idleDelayMs: 90_000, pausedDuration: 5_000 });
    expect(cameraTourCountdown(newcomer, input({ now: 20_000 }))).toBeNull();
    expect(cameraTourCountdown(newcomer, input({ now: 84_999 }))).toBeNull();
    expect(cameraTourCountdown(newcomer, input({ now: 85_000 }))?.seconds).toBe(10);
    expect(cameraTourCountdown(newcomer, input({ now: 95_000 }))).toBeNull();
  });

  it('follows the stepped meeting deadline and disappears immediately when the director changes target', () => {
    const current = state({ phaseStartedAt: 60_000, dwellMs: 30_000, idleDelayMs: 60_000 });
    const before = input({ now: 80_000, subjectOf: () => ({ meeting: true }) });
    const meeting = stepCameraDirector(current, before);
    expect(meeting.state.dwellMs).toBe(90_000);
    expect(cameraTourCountdown(meeting.state, before)).toBeNull();
    const end = { ...before, now: 140_000 };
    expect(cameraTourCountdown(stepCameraDirector(meeting.state, end).state, end)?.seconds).toBe(10);
    const transitionInput = { ...end, now: 150_000 };
    const transition = stepCameraDirector(meeting.state, transitionInput);
    expect(transition.command?.targetId).toBe('next');
    expect(cameraTourCountdown(transition.state, transitionInput)).toBeNull();
  });

  it.each([false, true])('advertises the actual stepped switch time across floor changes and pauses (different floor: %s)', differentFloor => {
    const initial = input({ now: 60_000, random: 0, floorOf: id => differentFloor && id === 'next' ? 2 : 1 });
    let current = stepCameraDirector(createCameraDirectorState(), initial).state;
    const before = { ...initial, now: 80_000 };
    current = stepCameraDirector(current, before).state;
    expect(cameraTourCountdown(current, before)).toEqual({ targetId: 'next', seconds: 10, windowSeconds: 10 });
    const pause = { ...initial, now: 85_000, suspended: true };
    current = stepCameraDirector(current, pause).state;
    expect(cameraTourCountdown(current, pause)).toBeNull();
    const resume = { ...initial, now: 95_000 };
    current = stepCameraDirector(current, resume).state;
    expect(cameraTourCountdown(current, resume)).toEqual({ targetId: 'next', seconds: 5, windowSeconds: 10 });
    const finalSecond = { ...initial, now: 99_999 };
    current = stepCameraDirector(current, finalSecond).state;
    expect(current.command?.targetId).toBe('current');
    expect(cameraTourCountdown(current, finalSecond)?.seconds).toBe(1);
    const deadline = { ...initial, now: 100_000 };
    const switched = stepCameraDirector(current, deadline);
    expect(switched.command).toMatchObject({ targetId: 'next', phase: differentFloor ? 'overview' : 'focus' });
    expect(cameraTourCountdown(switched.state, deadline)).toBeNull();
  });

  it('rejects non-finite clocks and invalid durations rather than showing misleading counts', () => {
    expect(cameraTourCountdown(state(), input({ now: Number.NaN }))).toBeNull();
    expect(cameraTourCountdown(state({ dwellMs: Number.POSITIVE_INFINITY }), input())).toBeNull();
    expect(cameraTourCountdown(state({ dwellMs: 0 }), input())).toBeNull();
    expect(cameraTourCountdown(state({ movementStoppedAt: Number.NaN }), input())).toBeNull();
  });
});
