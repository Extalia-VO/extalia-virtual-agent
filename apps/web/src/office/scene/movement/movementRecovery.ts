import type { Point3 } from '../layout';
import type { WalkableSegment, WalkingNeighbor } from './naturalWalking';

/** Recovery is bounded per destination, including unsuccessful attempts. */
export const MOVEMENT_RECOVERY_LIMIT = 3;
export const WALK_STALL_SECONDS = 3;
export const DOOR_STALL_SECONDS = 6;
export const STAIR_STALL_SECONDS = 6;
export const LIFT_STALL_SECONDS = 20;
export const LIFT_LOST_SECONDS = 6;
export const LIFT_SAMPLE_SECONDS = 0.5;
/** Observations contain controller work, never a render heartbeat or queue arrivals. */
export interface ElevatorProgress {
  readonly y: number;
  readonly doors: number;
  readonly phase: string;
  readonly ownership: 'missing' | 'queued' | 'reserved' | 'boarded' | 'exited';
  readonly queueAhead: number | null;
  readonly doorway?: boolean;
  readonly serviceRevision: number;
}
interface TransitWatch {
  key: string;
  elapsed: number;
  frozen: number;
  missing: number;
  observation: ElevatorProgress | null;
}
export interface MovementRecoveryState {
  transit: TransitWatch;
  avoidedElevators: ('A' | 'B')[];
  avoidedEdges: string[];
  stairRetreat: string[];
  anchor: Point3;
  signature: string;
  leaf: number;
  stalled: number;
  attempts: number;
  goal: string | null;
  remaining: number;
  yielding: { neighbor: string; origin: Point3; direction: readonly [number, number]; waited: number } | null;
}
export function createMovementRecovery(position: Readonly<Point3>): MovementRecoveryState {
  return { transit: { key: '', elapsed: 0, frozen: 0, missing: 0, observation: null }, avoidedElevators: [], avoidedEdges: [], stairRetreat: [], anchor: [...position], signature: '', leaf: 0, stalled: 0, attempts: 0, goal: null, remaining: Infinity, yielding: null };
}
export function recoveryGoal(state: MovementRecoveryState, goal: string): void {
  if (state.goal === goal) return;
  state.goal = goal; state.attempts = 0; state.stalled = 0; state.signature = '';
  state.yielding = null; state.avoidedElevators = []; state.avoidedEdges = []; state.stairRetreat = [];
  resetTransitWatch(state);
}

/** Timers alone are not progress. Small genuine movements accumulate at an anchor. */
export function recoveryDue(state: MovementRecoveryState, position: Readonly<Point3>, signature: string | null, leaf: number, dt: number, threshold: number, remaining = Infinity): boolean {
  const moved = Math.hypot(position[0] - state.anchor[0], position[1] - state.anchor[1], position[2] - state.anchor[2]) >= 0.02 && (!Number.isFinite(remaining) || remaining <= state.remaining - 0.02);
  if (signature === null || signature !== state.signature || moved || Math.abs(leaf - state.leaf) >= 0.01) {
    state.anchor = [...position]; state.signature = signature ?? ''; state.leaf = leaf; state.stalled = 0; state.remaining = remaining;
    return false;
  }
  state.stalled += Math.min(0.1, Math.max(0, dt));
  if (state.attempts >= MOVEMENT_RECOVERY_LIMIT || state.stalled < threshold) return false;
  state.stalled = 0; state.attempts++;
  return true;
}

/** Static sweep and current/predicted bodies must all allow the escape corridor. */
export function recoverySegmentClear(id: string, from: Readonly<Point3>, to: Readonly<Point3>, walkable: WalkableSegment, neighbors: readonly WalkingNeighbor[]): boolean {
  if (!walkable(from, to, 0.29) || !walkable(to, to, 0.29)) return false;
  const dx = to[0] - from[0], dz = to[2] - from[2], length2 = dx * dx + dz * dz;
  for (const other of neighbors) {
    if (other.id === id || Math.abs(other.position[1] - from[1]) > 0.8) continue;
    for (const horizon of [0, 0.3]) {
      const x = other.position[0] + other.velocity[0] * horizon, z = other.position[2] + other.velocity[2] * horizon;
      const initial = Math.hypot(from[0] - x, from[2] - z);
      const t = length2 > 1e-6 ? Math.max(0, Math.min(1, ((x - from[0]) * dx + (z - from[2]) * dz) / length2)) : 0;
      // An existing tight encounter can retreat, but cannot deepen its overlap.
      if (Math.hypot(to[0] - x, to[2] - z) < 0.62 || Math.hypot(from[0] + dx * t - x, from[2] + dz * t - z) < Math.min(0.6, initial - 1e-5)) return false;
    }
  }
  return true;
}

/** Keep the original protected endpoint; only the approach to it can change. */
export function recoveryDetour(position: Readonly<Point3>, target: Readonly<Point3>, clear: (from: Readonly<Point3>, to: Readonly<Point3>) => boolean): Point3 | null {
  const dx = target[0] - position[0], dz = target[2] - position[2], length = Math.hypot(dx, dz);
  if (length < 0.1) return null;
  for (const lateral of [0.85, -0.85, 1.3, -1.3, 1.8, -1.8]) {
    const middle: Point3 = [position[0] + dz / length * lateral, position[1], position[2] - dx / length * lateral];
    if (clear(position, middle) && clear(middle, target)) return middle;
  }
  return null;
}

export function resetTransitWatch(state: MovementRecoveryState): void {
  state.transit = { key: '', elapsed: 0, frozen: 0, missing: 0, observation: null };
}

/** Poll diagnostics at most twice a simulated second; a long frame cannot age a wait. */
export function transitRecoveryDue(state: MovementRecoveryState, key: string, dt: number, observe: () => ElevatorProgress | null, position: Readonly<Point3>, protectPeerService = true): boolean {
  const watch = state.transit;
  if (watch.key !== key) { resetTransitWatch(state); state.transit.key = key; }
  const current = state.transit;
  current.elapsed += Math.min(.1, Math.max(0, dt));
  if (current.elapsed < LIFT_SAMPLE_SECONDS || state.attempts >= MOVEMENT_RECOVERY_LIMIT) return false;
  const elapsed = current.elapsed; current.elapsed = 0;
  let next: ElevatorProgress | null;
  try { next = observe(); } catch { next = null; }
  if (!next || ![next.y, next.doors, next.serviceRevision].every(Number.isFinite)) {
    current.observation = null; current.frozen = 0; current.missing = 0; return false;
  }
  const previous = current.observation;
  const bodyMoved = Math.hypot(...position.map((value, index) => value - state.anchor[index]!) as [number, number, number]) >= .02;
  // Once the rider has exited, the cab's subsequent work belongs to others.
  // Only body movement (or an outer stage/key change) can advance that rider.
  const controllerProgress = previous && next.ownership !== 'exited' && (Math.abs(next.y - previous.y) >= .005 || Math.abs(next.doors - previous.doors) >= .005
    || next.phase !== previous.phase || next.ownership !== previous.ownership || (!!next.doorway && !previous.doorway)
    || (protectPeerService && !next.doorway && (next.ownership === 'queued' || next.ownership === 'reserved') && next.serviceRevision > previous.serviceRevision)
    || (next.queueAhead !== null && previous.queueAhead !== null && next.queueAhead < previous.queueAhead));
  const progress = !previous || bodyMoved || controllerProgress;
  current.frozen = progress ? 0 : current.frozen + elapsed;
  current.missing = next.ownership === 'missing' ? current.missing + elapsed : 0;
  // Keep the anchor until small movements accumulate; polling is not progress.
  if (progress) { current.observation = next; state.anchor = [...position]; }
  if (current.frozen < LIFT_STALL_SECONDS && current.missing < LIFT_LOST_SECONDS) return false;
  current.frozen = 0; current.missing = 0; state.attempts++;
  return true;
}
