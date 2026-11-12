/** Timings are milliseconds, using the same monotonic clock as user interactions. */
export const CAMERA_IDLE_DELAY_MIN = 60_000;
export const CAMERA_IDLE_DELAY_MAX = 120_000;
export const CAMERA_IDLE_DELAY = (CAMERA_IDLE_DELAY_MIN + CAMERA_IDLE_DELAY_MAX) / 2;
export const CAMERA_ATTENTION_DELAY = 2_000;
export const CAMERA_ATTENTION_SETTLEMENT = 1_500;
export const CAMERA_PHASE_DURATION = 900;
export const CAMERA_WORKING_DWELL_MIN = 30_000;
export const CAMERA_WORKING_DWELL_MAX = 120_000;
export const CAMERA_IDLE_DWELL_MIN = 20_000;
export const CAMERA_IDLE_DWELL_MAX = 30_000;
export const CAMERA_ARRIVAL_SETTLEMENT = 5_000;

export interface CameraSubject {
  role?: 'lead' | 'worker';
  meeting?: boolean;
  moving?: boolean;
}

export interface CameraDirectorCommand {
  phase: 'overview' | 'travel' | 'focus';
  mode: 'tour' | 'attention';
  targetId: string;
  /** Overview starts on this character's floor; null preserves the current floor. */
  fromId: string | null;
}

export interface CameraDirectorState {
  command: CameraDirectorCommand | null;
  phaseStartedAt: number;
  dwellMs: number;
  heldAttentionId: string | null;
  attentionResolvedAt: number | null;
  focusedAttentionId: string | null;
  lastTourId: string | null;
  idleDelayMs: number;
  consumedNewcomerIds: readonly string[];
  newcomerTargetId: string | null;
  observedInteractionAt: number | null;
  pausedAt: number | null;
  pausedDuration: number;
  movementSeen: boolean;
  movementStoppedAt: number | null;
  workingShot: boolean;
}

export interface CameraDirectorInput {
  now: number;
  enabled: boolean;
  /** Hidden page, modal, editing, or an active manual camera gesture. */
  suspended: boolean;
  lastInteractionAt: number;
  workingIds: readonly string[];
  /** Other office characters participate with a shorter dwell. */
  idleIds?: readonly string[];
  /** Recently admitted/activated characters, newest first; absence rearms an ID. */
  newcomerIds?: readonly string[];
  /** Genuine newly admitted characters; ordinary work restarts cannot interrupt an active shot. */
  spawnedIds?: readonly string[];
  /** Current single-floor view and live floor lookup; unknown floors retain the overview sequence. */
  currentFloor?: number | undefined;
  floorOf?: ((id: string) => number | undefined) | undefined;
  subjectOf?: ((id: string) => CameraSubject | undefined) | undefined;
  /** Unique character IDs in oldest-unresolved-request order. */
  attentionIds: readonly string[];
  /** Sample in [0, 1], supplied by the caller; defaults to the midpoint. */
  random?: number;
  /** Disable idle touring and snap directly to pending-input characters. */
  reducedMotion?: boolean;
}

export interface CameraDirectorResult {
  state: CameraDirectorState;
  /** Stable object identity until a phase or target changes; null yields control. */
  command: CameraDirectorCommand | null;
}

export function createCameraDirectorState(): CameraDirectorState {
  return { command: null, phaseStartedAt: 0, dwellMs: (CAMERA_WORKING_DWELL_MIN + CAMERA_WORKING_DWELL_MAX) / 2, heldAttentionId: null,
    attentionResolvedAt: null, focusedAttentionId: null, lastTourId: null, idleDelayMs: CAMERA_IDLE_DELAY,
    consumedNewcomerIds: [], newcomerTargetId: null,
    observedInteractionAt: null, pausedAt: null, pausedDuration: 0, movementSeen: false, movementStoppedAt: null, workingShot: false };
}

function sampleUnit(sample = 0.5): number {
  return Math.min(1, Math.max(0, Number.isFinite(sample) ? sample : 0.5));
}

function dwellDuration(active: boolean, random?: number, subject?: CameraSubject): number {
  const range = !active ? [CAMERA_IDLE_DWELL_MIN, CAMERA_IDLE_DWELL_MAX]
    : subject?.meeting ? [90_000, 120_000]
    : subject?.moving ? [60_000, 120_000]
    : subject?.role === 'lead' ? [60_000, 90_000]
    : subject?.role === 'worker' ? [30_000, 60_000]
    : [CAMERA_WORKING_DWELL_MIN, CAMERA_WORKING_DWELL_MAX];
  return range[0]! + sampleUnit(random) * (range[1]! - range[0]!);
}

function startMove(state: CameraDirectorState, input: CameraDirectorInput, mode: CameraDirectorCommand['mode'], targetId: string): CameraDirectorState {
  const previous = state.command;
  const fromId = previous?.phase === 'overview' ? previous.fromId : previous?.targetId ?? null;
  const targetFloor = input.floorOf?.(targetId);
  const fromFloor = input.currentFloor ?? (previous?.phase === 'focus' && fromId ? input.floorOf?.(fromId) : undefined);
  const sameFloor = targetFloor !== undefined && fromFloor === targetFloor;
  const phase = input.reducedMotion || sameFloor || (mode === 'attention' && state.focusedAttentionId === targetId) ? 'focus' : 'overview';
  const active = mode === 'attention' || input.workingIds.includes(targetId);
  const subject = input.subjectOf?.(targetId);
  return { ...state, phaseStartedAt: input.now,
    dwellMs: dwellDuration(active, input.random, subject), movementSeen: Boolean(subject?.moving), movementStoppedAt: null, workingShot: active,
    lastTourId: mode === 'tour' ? targetId : state.lastTourId,
    focusedAttentionId: mode === 'attention' && phase === 'focus' ? targetId : state.focusedAttentionId,
    command: { phase, mode, targetId, fromId } };
}

/**
 * Advance one phase per tick so each overview can actually be rendered. Pending
 * input owns the camera until every request for that character disappears and
 * its settlement grace elapses. The caller owns floor lookup, interpolation
 * and actual camera/selection updates.
 */
export function stepCameraDirector(previous: CameraDirectorState, input: CameraDirectorInput): CameraDirectorResult {
  let state = previous;
  if (input.lastInteractionAt !== state.observedInteractionAt) {
    // An answer may itself be the interaction: preserve the owner and its focus
    // so another request from that character does not replay the floor tour.
    state = { ...state, command: null, observedInteractionAt: input.lastInteractionAt,
      idleDelayMs: CAMERA_IDLE_DELAY_MIN + sampleUnit(input.random) * (CAMERA_IDLE_DELAY_MAX - CAMERA_IDLE_DELAY_MIN),
      newcomerTargetId: null,
      pausedAt: null, pausedDuration: 0 };
  }
  if (!input.enabled) {
    return { state: { ...state, command: null, pausedAt: null, pausedDuration: 0 }, command: null };
  }
  if (input.suspended) {
    if (state.pausedAt === null) state = { ...state, pausedAt: input.now };
    return { state, command: null };
  }
  if (state.pausedAt !== null) {
    const paused = Math.max(0, input.now - state.pausedAt);
    state = { ...state, pausedAt: null, pausedDuration: state.pausedDuration + paused,
      attentionResolvedAt: state.attentionResolvedAt === null ? null : state.attentionResolvedAt + paused,
      movementStoppedAt: state.movementStoppedAt === null ? null : state.movementStoppedAt + paused,
      phaseStartedAt: state.phaseStartedAt + paused };
  }

  if (state.heldAttentionId && !input.attentionIds.includes(state.heldAttentionId)) {
    if (state.attentionResolvedAt === null) state = { ...state, attentionResolvedAt: input.now };
    else if (input.now - state.attentionResolvedAt >= CAMERA_ATTENTION_SETTLEMENT) {
      state = { ...state, heldAttentionId: null, attentionResolvedAt: null, focusedAttentionId: null };
    }
  } else if (state.attentionResolvedAt !== null) state = { ...state, attentionResolvedAt: null };
  if (!state.heldAttentionId && input.attentionIds.length) {
    state = { ...state, heldAttentionId: input.attentionIds[0]!, focusedAttentionId: null };
  }

  const heldAttentionId = state.heldAttentionId;
  const tourIds = [...new Set([...input.workingIds, ...(input.idleIds ?? [])])];
  const newcomerIds = input.newcomerIds ?? [];
  const consumed = state.consumedNewcomerIds.filter(id => newcomerIds.includes(id));
  if (consumed.length !== state.consumedNewcomerIds.length) state = { ...state, consumedNewcomerIds: consumed };
  const inactiveFor = Math.max(0, input.now - input.lastInteractionAt - state.pausedDuration);
  const mode = heldAttentionId ? 'attention' : 'tour';
  const newcomerId = !heldAttentionId && !input.reducedMotion && inactiveFor >= CAMERA_ATTENTION_DELAY
    ? newcomerIds.find(id => !consumed.includes(id) && tourIds.includes(id)
      && (state.command?.targetId === id || (input.spawnedIds ?? newcomerIds).includes(id))) : undefined;
  if (newcomerId) {
    state = { ...state, consumedNewcomerIds: [...newcomerIds], newcomerTargetId: newcomerId };
    if (state.command?.mode !== 'tour' || state.command.targetId !== newcomerId) {
      state = startMove(state, input, 'tour', newcomerId);
      return { state, command: state.command };
    }
    // An idle character can become active while already in the shot. Keep the
    // camera steady and grant the full active dwell from this announcement.
    if (!state.workingShot && input.workingIds.includes(newcomerId)) state = { ...state, dwellMs: dwellDuration(true, input.random, input.subjectOf?.(newcomerId)), workingShot: true,
      phaseStartedAt: state.command.phase === 'focus' ? input.now : state.phaseStartedAt };
  }
  const continuingNewcomer = state.command?.mode === 'tour' && state.command.targetId === state.newcomerTargetId
    && tourIds.includes(state.command.targetId);
  const delay = heldAttentionId ? CAMERA_ATTENTION_DELAY : continuingNewcomer ? CAMERA_ATTENTION_DELAY : state.idleDelayMs;
  if (inactiveFor < delay || (!heldAttentionId && (input.reducedMotion || tourIds.length === 0))) {
    if (state.command) state = { ...state, command: null };
    return { state, command: null };
  }

  let command = state.command;
  const targetPresent = command && (command.mode === 'attention'
    ? command.targetId === heldAttentionId : tourIds.includes(command.targetId));
  if (!command || command.mode !== mode || !targetPresent) {
    const index = state.lastTourId === null ? -1 : tourIds.indexOf(state.lastTourId);
    const targetId = heldAttentionId ?? tourIds[(index + 1) % tourIds.length]!;
    state = { ...state, newcomerTargetId: null };
    state = startMove(state, input, mode, targetId);
    return { state, command: state.command };
  }

  const elapsed = Math.max(0, input.now - state.phaseStartedAt);
  if (command.phase === 'focus' && mode === 'tour') {
    const subject = input.subjectOf?.(command.targetId);
    if (subject?.moving) state = { ...state, movementSeen: true, movementStoppedAt: null };
    else if (state.movementSeen && state.movementStoppedAt === null) state = { ...state, movementStoppedAt: input.now };
    // A meeting that starts during a shot earns a longer visit without redrawing its random sample.
    if (subject?.meeting && state.dwellMs < 90_000) state = { ...state, dwellMs: 90_000 };
  }
  if (command.phase !== 'focus' && (input.reducedMotion || elapsed >= CAMERA_PHASE_DURATION)) {
    command = { ...command, phase: input.reducedMotion || command.phase === 'travel' ? 'focus' : 'travel' };
    state = { ...state, command, phaseStartedAt: input.now,
      focusedAttentionId: command.mode === 'attention' && command.phase === 'focus' ? command.targetId : state.focusedAttentionId };
  } else if (command.phase === 'focus' && mode === 'tour' && elapsed >= state.dwellMs) {
    // Give a journey time to finish and settle, with a hard cap for long queues or stalled movement.
    if (state.movementSeen && elapsed < CAMERA_WORKING_DWELL_MAX
      && (state.movementStoppedAt === null || input.now - state.movementStoppedAt < CAMERA_ARRIVAL_SETTLEMENT)) return { state, command: state.command };
    if (continuingNewcomer && inactiveFor < state.idleDelayMs) {
      // Keep following the live character while waiting for the ordinary tour
      // threshold. Ending its dwell does not hand control to another subject.
      return { state, command: state.command };
    }
    const index = tourIds.indexOf(command.targetId);
    const targetId = tourIds[(index + 1) % tourIds.length]!;
    // With one worker, retain the shot instead of repeatedly zooming in/out.
    if (targetId !== command.targetId) state = startMove({ ...state, newcomerTargetId: null }, input, mode, targetId);
  }
  return { state, command: state.command };
}
