import type { Point3 } from '../layout';
import type { Mover } from './mover';

export type MovementMonitorReason = 'moving' | 'settled' | 'door-queue' | 'transit' | 'interaction' | 'blocked-route' | 'blocked-seat';
export const MOVEMENT_MONITOR_GRACE_SECONDS = 3;
const PROGRESS_METRES = .02;

/** Per-mover diagnostics only: recovery and all movement remain the caller's responsibility. */
export interface MovementMonitorState {
  speed: number;
  stationarySeconds: number;
  reason: MovementMonitorReason;
  actionable: boolean;
  anchor: Point3 | null;
  remaining: number;
  targetKey: string;
  signature: string;
  timer: number | null;
  yaw: number;
  sit: number;
  pull: number;
}

export interface MovementDiagnostic {
  readonly id: string;
  readonly phase: Mover['phase'];
  readonly position: Readonly<Point3>;
  readonly speed: number;
  readonly stationarySeconds: number;
  readonly reason: MovementMonitorReason;
  readonly actionable: boolean;
  readonly destination: string | null;
  readonly recoveryAttempts: number;
}

/** Detached read-only presentation data; it cannot mutate a mover or its monitor. */
export function movementDiagnostic(state: Readonly<MovementMonitorState>, mover: Readonly<Mover>): MovementDiagnostic {
  const goal = mover.pending ?? mover.goal;
  return { id: mover.id, phase: mover.phase, position: [...mover.position], speed: state.speed,
    stationarySeconds: state.stationarySeconds, reason: state.reason, actionable: state.actionable,
    destination: goal ? goal.kind === 'seat' ? goal.seat.seatId : goal.node : null, recoveryAttempts: mover.recovery.attempts };
}

export function createMovementMonitor(): MovementMonitorState {
  return { speed: 0, stationarySeconds: 0, reason: 'settled', actionable: false, anchor: null,
    remaining: Infinity, targetKey: '', signature: '', timer: null, yaw: 0, sit: 0, pull: 0 };
}

interface Activity {
  signature: string;
  timer: number | null;
  timerLimit: number;
  protectedReason?: 'settled' | 'door-queue' | 'transit';
  blockedReason: 'blocked-route' | 'blocked-seat';
  poseProgress: boolean;
}

function activity(mover: Readonly<Mover>): Activity {
  const base: Activity = { signature: mover.phase, timer: null, timerLimit: 0, blockedReason: 'blocked-route', poseProgress: false };
  if (mover.trip && ['waiting', 'boarding', 'riding', 'alighting'].includes(mover.phase)) {
    return { ...base, signature: `${mover.phase}:${mover.trip.id}:${mover.trip.stage}`, protectedReason: 'transit' };
  }
  if (mover.phase === 'gone' || mover.phase === 'vanishing') return { ...base, protectedReason: 'settled' };
  if (mover.phase === 'seated') {
    if (mover.recovery.departure) return base;
    if (mover.seat?.standing || mover.motion.sit > .5 || (!mover.seat && !mover.goal && !mover.pending)) return { ...base, protectedReason: 'settled' };
    return { ...base, blockedReason: 'blocked-seat' };
  }
  if (mover.phase === 'doorwork' && mover.door) {
    const door = mover.door;
    const result = { ...base, signature: `door:${door.id}:${door.kind}:${door.beat}` };
    if (door.beat === 'resume' || door.beat === 'reserve' && (door.kind === 'wait' || (door.queueIndex ?? 0) > 0)) {
      return { ...result, protectedReason: 'door-queue' };
    }
    if (door.beat === 'grip' || door.beat === 'release' || door.beat === 'swing') {
      return { ...result, timer: door.timer, timerLimit: 2, poseProgress: true };
    }
    return result;
  }
  if (mover.phase === 'seatwork' && mover.staticSeat) {
    const seat = mover.staticSeat;
    const result: Activity = { ...base, signature: `seat:${seat.kind}:${seat.beat}`, blockedReason: 'blocked-seat' };
    if (seat.beat === 'align') return { ...result, timer: seat.timer, timerLimit: .25, poseProgress: true };
    if (seat.beat === 'lower' || seat.beat === 'rise') return { ...result, timer: seat.timer,
      timerLimit: (seat.beat === 'lower' ? seat.seat.sitMs : seat.seat.standMs) / 1000, poseProgress: true };
    // Cached paths, contact retries and retry timer changes are not activity.
    return result;
  }
  if (mover.phase === 'chairing' && mover.chair) {
    const chair = mover.chair;
    const walking = chair.beat === 0 || chair.kind === 'sit' && chair.beat === 4;
    return { ...base, signature: `chair:${chair.kind}:${chair.beat}`, blockedReason: 'blocked-seat',
      timer: walking ? null : chair.timer, timerLimit: 2, poseProgress: !walking };
  }
  if (mover.phase === 'standing' || mover.phase === 'sitting') {
    const limit = mover.phase === 'standing' ? Math.max(1.1, (mover.seat?.standMs ?? 760) / 1000) : (mover.seat?.sitMs ?? 850) / 1000;
    return { ...base, timer: mover.timer >= 0 ? mover.timer : null, timerLimit: limit, blockedReason: 'blocked-seat', poseProgress: true };
  }
  return base;
}

function targetOf(mover: Readonly<Mover>): Readonly<Point3> | undefined {
  if (mover.phase === 'seatwork') {
    const seat = mover.staticSeat;
    return seat?.beat === 'contact' ? seat.route?.contact : seat?.beat === 'exit-contact' ? seat.route?.apron : seat?.path?.[0];
  }
  if (mover.phase === 'chairing') return mover.chair?.path[0];
  if (mover.phase === 'doorwork') return mover.door?.path?.[0];
  const step = mover.steps[mover.stepIndex];
  return mover.target ?? (step?.kind === 'walk' ? step.to : undefined);
}

/**
 * Measure actual feet displacement, never the walk animation blend. The clock
 * is capped to the mover's simulated frame budget so a hidden-tab gap cannot
 * instantly declare everyone stalled. The function mutates/returns only its
 * diagnostic state; it never modifies the mover, its route or its identity.
 */
export function stepMovementMonitor(state: MovementMonitorState, mover: Readonly<Mover>, seconds: number, beforePosition: Readonly<Point3>): MovementMonitorState {
  const dt = Number.isFinite(seconds) ? Math.min(.1, Math.max(0, seconds)) : 0;
  const distance = Math.hypot(mover.position[0] - beforePosition[0], mover.position[1] - beforePosition[1], mover.position[2] - beforePosition[2]);
  state.speed = dt > 0 && Number.isFinite(distance) ? distance / dt : 0;
  const next = activity(mover), target = targetOf(mover);
  const goal = mover.pending ?? mover.goal;
  const signature = `${next.signature}:${goal?.kind ?? ''}:${goal ? goal.kind === 'seat' ? goal.seat.seatId : goal.node : ''}`;
  const targetKey = target?.join(',') ?? '';
  // A new curve/contact target changes the distance scale, not whether the
  // body has made progress. Keep the physical anchor across short samples.
  if (targetKey !== state.targetKey) state.remaining = Infinity;
  const remaining = target ? Math.hypot(target[0] - mover.position[0], target[1] - mover.position[1], target[2] - mover.position[2]) : Infinity;
  if (!state.anchor) state.anchor = [...beforePosition];
  const moved = Math.hypot(mover.position[0] - state.anchor[0], mover.position[1] - state.anchor[1], mover.position[2] - state.anchor[2]) >= PROGRESS_METRES
    && (!Number.isFinite(remaining) || remaining <= state.remaining - PROGRESS_METRES);
  const changed = signature !== state.signature;
  const timed = next.timer !== null && state.timer !== null && next.timer > state.timer + 1e-6 && next.timer <= next.timerLimit + .001;
  const pose = next.poseProgress && (Math.abs(mover.yaw - state.yaw) >= .01 || Math.abs(mover.motion.sit - state.sit) >= .001 || Math.abs(mover.chairPull - state.pull) >= .001);
  const progress = moved || changed || timed || pose;
  if (progress) {
    state.stationarySeconds = 0;
    state.anchor = [...mover.position];
    state.remaining = remaining;
  } else state.stationarySeconds += dt;
  state.reason = next.protectedReason ?? (timed || pose || changed && next.timer !== null ? 'interaction'
    : distance > 1e-5 && state.stationarySeconds < MOVEMENT_MONITOR_GRACE_SECONDS ? 'moving' : next.blockedReason);
  state.actionable = (state.reason === 'blocked-route' || state.reason === 'blocked-seat')
    && state.stationarySeconds >= MOVEMENT_MONITOR_GRACE_SECONDS - 1e-9;
  state.signature = signature; state.timer = next.timer; state.targetKey = targetKey;
  state.yaw = mover.yaw; state.sit = mover.motion.sit; state.pull = mover.chairPull;
  return state;
}
