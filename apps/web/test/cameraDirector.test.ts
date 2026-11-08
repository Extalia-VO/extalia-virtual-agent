import { describe, expect, it } from 'vitest';
import { CAMERA_IDLE_DELAY_MIN, CAMERA_IDLE_DELAY_MAX, createCameraDirectorState, stepCameraDirector,
  type CameraDirectorInput, type CameraDirectorState } from '../src/office/cameraDirector';

const defaults: CameraDirectorInput = { now: 0, enabled: true, suspended: false,
  lastInteractionAt: 0, workingIds: ['agent-a', 'agent-b'], attentionIds: [], random: 0 };

function director(overrides: Partial<CameraDirectorInput> = {}) {
  let state: CameraDirectorState = createCameraDirectorState();
  let input = { ...defaults, ...overrides };
  return (changes: Partial<CameraDirectorInput> = {}) => {
    input = { ...input, ...changes };
    const result = stepCameraDirector(state, input);
    state = result.state;
    return result;
  };
}

describe('office camera director', () => {
  it('samples a 60–120 second idle threshold once per interaction, never per tick', () => {
    const tick = director();
    expect(tick().state.idleDelayMs).toBe(CAMERA_IDLE_DELAY_MIN);
    expect(tick({ now: 59_999, random: 1 }).command).toBeNull();
    expect(tick({ now: 60_000 }).command?.phase).toBe('overview');
    expect(tick({ now: 61_000, lastInteractionAt: 61_000 }).state.idleDelayMs).toBe(CAMERA_IDLE_DELAY_MAX);
    expect(tick({ now: 180_999, random: 0 }).command).toBeNull();
    expect(tick({ now: 181_000 }).command?.phase).toBe('overview');
  });

  it('frames overview, next floor and character with stable commands and variable active dwell', () => {
    const tick = director();
    const overview = tick({ now: 60_000 }).command;
    expect(overview).toEqual({ phase: 'overview', mode: 'tour', targetId: 'agent-a', fromId: null });
    expect(tick({ now: 60_100 }).command).toBe(overview);
    expect(tick({ now: 60_900 }).command?.phase).toBe('travel');
    expect(tick({ now: 61_800 }).command?.phase).toBe('focus');
    expect(tick({ now: 70_799 }).command?.targetId).toBe('agent-a');
    const next = tick({ now: 70_800, random: 1 });
    expect(next.command).toEqual({ phase: 'overview', mode: 'tour', targetId: 'agent-b', fromId: 'agent-a' });
    expect(next.state.dwellMs).toBe(17_000);
    tick({ now: 71_700 }); tick({ now: 72_600 });
    expect(tick({ now: 89_599 }).command?.targetId).toBe('agent-b');
    expect(tick({ now: 89_600 }).command?.targetId).toBe('agent-a');
  });

  it('tours idle characters with shorter 4–7 second dwell', () => {
    const tick = director({ workingIds: [], idleIds: ['idle-a', 'idle-b'] });
    expect(tick({ now: 60_000 }).state.dwellMs).toBe(4_000);
    tick({ now: 60_900 }); tick({ now: 61_800 });
    expect(tick({ now: 65_799 }).command?.targetId).toBe('idle-a');
    const next = tick({ now: 65_800, random: 1 });
    expect(next.command?.targetId).toBe('idle-b');
    expect(next.state.dwellMs).toBe(7_000);
  });

  it('preempts a tour for pending input and holds each character through request reordering', () => {
    const tick = director();
    tick({ now: 60_000 });
    expect(tick({ now: 60_100, attentionIds: ['agent-b', 'agent-c'] }).command?.targetId).toBe('agent-b');
    tick({ now: 61_000 });
    const focus = tick({ now: 61_900 }).command;
    expect(tick({ now: 90_000, attentionIds: ['agent-c', 'agent-b', 'agent-d'] }).command).toBe(focus);
    expect(tick({ now: 90_100, attentionIds: ['agent-c', 'agent-d'] }).command).toBe(focus);
    expect(tick({ now: 91_599 }).command).toBe(focus);
    expect(tick({ now: 91_600 }).command?.targetId).toBe('agent-c');
  });

  it('allows a returning request to retain its owner during settlement, and eventually releases an empty queue', () => {
    const tick = director({ attentionIds: ['agent-a', 'agent-b'] });
    tick({ now: 2_000 }); tick({ now: 2_900 });
    const focus = tick({ now: 3_800 }).command;
    expect(tick({ now: 4_000, attentionIds: ['agent-b'] }).command).toBe(focus);
    expect(tick({ now: 5_499, attentionIds: ['agent-b', 'agent-a'] }).command).toBe(focus);
    expect(tick({ now: 6_000, attentionIds: [] }).command).toBe(focus);
    expect(tick({ now: 7_499 }).command).toBe(focus);
    expect(tick({ now: 7_500 }).command).toBeNull();
    expect(tick({ now: 60_000 }).command?.mode).toBe('tour');
  });

  it('resumes the same held attention directly after answer/manual activity without replaying overview', () => {
    const tick = director({ attentionIds: ['agent-b', 'agent-c'] });
    tick({ now: 2_000 }); tick({ now: 2_900 }); tick({ now: 3_800 });
    expect(tick({ now: 4_000, lastInteractionAt: 4_000, attentionIds: ['agent-c', 'agent-b'] }).command).toBeNull();
    expect(tick({ now: 5_999 }).command).toBeNull();
    expect(tick({ now: 6_000 }).command).toMatchObject({ phase: 'focus', mode: 'attention', targetId: 'agent-b' });
    tick({ now: 6_100, attentionIds: ['agent-c'] });
    expect(tick({ now: 7_600 }).command).toMatchObject({ phase: 'overview', mode: 'attention', targetId: 'agent-c' });
  });

  it('freezes movement and inactivity while hidden or a modal/editor suspends it', () => {
    const tick = director();
    tick({ now: 59_000, suspended: true });
    expect(tick({ now: 100_000, suspended: false }).command).toBeNull();
    const overview = tick({ now: 101_000 }).command;
    expect(overview?.phase).toBe('overview');
    expect(tick({ now: 101_300, suspended: true }).command).toBeNull();
    expect(tick({ now: 201_300, suspended: false }).command).toBe(overview);
    expect(tick({ now: 201_899 }).command?.phase).toBe('overview');
    expect(tick({ now: 201_900 }).command?.phase).toBe('travel');
  });

  it('handles vanished and empty agents without cycling a single character repeatedly', () => {
    const tick = director({ workingIds: ['agent-a'] });
    tick({ now: 60_000 }); tick({ now: 60_900 });
    const focus = tick({ now: 61_800 }).command;
    expect(tick({ now: 100_000 }).command).toBe(focus);
    expect(tick({ now: 100_100, workingIds: ['agent-b'] }).command?.targetId).toBe('agent-b');
    expect(tick({ now: 100_200, workingIds: [] }).command).toBeNull();
    expect(tick({ now: 100_300, attentionIds: ['agent-c'] }).command?.targetId).toBe('agent-c');
    tick({ now: 100_400, attentionIds: [] });
    expect(tick({ now: 101_900 }).command).toBeNull();
  });

  it('preempts idle focus with the newest active character once, and rearms after an absent announcement', () => {
    const tick = director({ workingIds: [], idleIds: ['idle-a'] });
    tick({ now: 60_000 }); tick({ now: 60_900 }); tick({ now: 61_800 });
    const announced = tick({ now: 62_000, workingIds: ['new-a', 'new-b'], newcomerIds: ['new-a', 'new-b'] });
    expect(announced.command?.targetId).toBe('new-a');
    expect(tick({ now: 62_100 }).command).toBe(announced.command);
    tick({ now: 62_900 }); tick({ now: 63_800 });
    expect(tick({ now: 72_800 }).command?.targetId).toBe('new-b');
    expect(tick({ now: 72_900 }).command?.targetId).toBe('new-b');
    tick({ now: 73_000, newcomerIds: [] });
    expect(tick({ now: 73_100, newcomerIds: ['new-a'] }).command?.targetId).toBe('new-a');
  });

  it('admits a newcomer after manual cooldown without starting the whole idle tour early', () => {
    const tick = director({ workingIds: ['new-a'], idleIds: ['idle-a'], newcomerIds: ['new-a'] });
    expect(tick({ now: 1_999 }).command).toBeNull();
    expect(tick({ now: 2_000 }).command?.targetId).toBe('new-a');
    tick({ now: 2_900 });
    const focus = tick({ now: 3_800 }).command;
    expect(focus?.phase).toBe('focus');
    expect(tick({ now: 12_799 }).command).toBe(focus);
    expect(tick({ now: 12_800 }).command).toBe(focus);
    expect(tick({ now: 59_999 }).command).toBe(focus);
    expect(tick({ now: 60_000 }).command).toMatchObject({ phase: 'overview', targetId: 'idle-a' });
  });

  it('keeps an already framed idle character steady when it starts working, with a full active dwell', () => {
    const tick = director({ workingIds: [], idleIds: ['agent-a', 'agent-b'] });
    tick({ now: 60_000 }); tick({ now: 60_900 });
    const focus = tick({ now: 61_800 }).command;
    const active = tick({ now: 65_000, workingIds: ['agent-a'], idleIds: ['agent-b'], newcomerIds: ['agent-a'] });
    expect(active.command).toBe(focus);
    expect(active.state.dwellMs).toBe(9_000);
    expect(tick({ now: 73_999 }).command).toBe(focus);
    expect(tick({ now: 74_000 }).command?.targetId).toBe('agent-b');
  });

  it('keeps attention and its settlement grace above newcomer priority, and respects manual takeover', () => {
    const tick = director({ attentionIds: ['agent-a'] });
    tick({ now: 2_000 }); tick({ now: 2_900 }); tick({ now: 3_800 });
    expect(tick({ now: 4_000, newcomerIds: ['agent-b'] }).command?.targetId).toBe('agent-a');
    tick({ now: 4_100, attentionIds: [] });
    expect(tick({ now: 5_599 }).command?.targetId).toBe('agent-a');
    expect(tick({ now: 5_600 }).command?.targetId).toBe('agent-b');
    expect(tick({ now: 5_700, lastInteractionAt: 5_700 }).command).toBeNull();
    expect(tick({ now: 7_699, newcomerIds: ['agent-a'] }).command).toBeNull();
    expect(tick({ now: 7_700 }).command?.targetId).toBe('agent-a');
  });

  it('stops when disabled and limits reduced-motion automation to direct attention focus', () => {
    const tick = director({ reducedMotion: true });
    expect(tick({ now: 60_000, newcomerIds: ['agent-b'] }).command).toBeNull();
    expect(tick({ now: 60_100, attentionIds: ['agent-b'] }).command).toEqual({
      phase: 'focus', mode: 'attention', targetId: 'agent-b', fromId: null,
    });
    expect(tick({ now: 60_200, enabled: false }).command).toBeNull();
    expect(tick({ now: 60_300, enabled: true }).command?.targetId).toBe('agent-b');
  });
});
