/**
 * Door traffic for the office: who holds a door, when it swings, and who closes
 * it behind them. Pure apart from reading the registered door portals and the
 * tracked walkers, so the rules are unit-tested with plain arrays.
 *
 * Rules (people, not machines):
 * - A walker reserves a hinged door and starts its swing by the handle. Pull
 *   entries release the initial tug while stepping aside; the reserved swing
 *   finishes only while the doorway is clear. Closing regrips the handle.
 * - Walkers pass once the leaf is far enough open (`DOOR_PASS_OPEN`).
 * - The last walker through a door closes it behind them, unless another walker
 *   is approaching the same door (within `APPROACH_RANGE_M`, heading toward it),
 *   in which case the door stays open for that person and they close it.
 * - A sliding door opens when a walker approaches and closes shortly after the
 *   last one has passed, with the same approach rule.
 */
import type { Point3 } from '../layout';

/** Leaf fraction open (0 closed … 1 fully open) that lets a walker through. */
export const DOOR_PASS_OPEN = 0.8;
/** Leaf fraction per second while a hand swings a hinged leaf. */
export const DOOR_SWING_RATE = 0.9;
/** A walker this close to a door's plane is at the threshold. */
export const DOOR_NEAR_M = 1.2;
/** Walkers this close, heading to the door, count as approaching it. */
export const APPROACH_RANGE_M = 4;
/** An approaching walker's next waypoint is this close to the door. */
export const APPROACH_TARGET_M = 3;
/** A walker's tracked position is trusted for this long after its last update. */
export const TRACK_FRESH_MS = 3000;
/** A sliding door stays open this long after the last walker near it. */
export const SLIDE_HOLD_MS = 1000;
/** Sliding leaves move this fast toward their target (damping rate, 1/s). */
export const SLIDE_RATE = 7.5;

/** A door's geometry (the registered door portal; `center` is the frame at the threshold). */
export interface DoorInfo {
  readonly floor: number;
  readonly center: Readonly<Point3>;
  readonly yaw: number;
  readonly clearWidth: number;
  readonly height: number;
  readonly openAngle: number;
  readonly hinge?: 'left' | 'right';
  readonly handleHeight?: number;
  readonly handleOffset?: number;
  readonly sliding: boolean;
}

export interface WalkerInfo {
  readonly id: string;
  readonly position: Readonly<Point3>;
  readonly target: Readonly<Point3>;
  readonly updatedAt: number;
}

/** Where door traffic reads its doors and walkers from (the registry in the app, arrays in tests). */
export interface DoorSource {
  forEachDoor(visit: (id: string, door: Readonly<DoorInfo>) => void): void;
  forEachWalker(visit: (walker: WalkerInfo) => void): void;
}

export interface DoorHit { readonly id: string; readonly door: Readonly<DoorInfo> }

interface DoorState {
  /** 0 closed … 1 open. */
  amount: number;
  /** The walker whose hand is on a hinged leaf. */
  operator: string | null;
  /** Sliding leaves: open until this time (ms) after the last walker near them. */
  holdUntil: number;
}

/** Rendered transforms and authored route nodes may differ by sub-micrometres. */
const PLANE_EPSILON = 1e-6;
const onPlane = (through: number): number => Math.abs(through) <= PLANE_EPSILON ? 0 : through;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** Through-coordinate (along the door's normal, positive on the side it faces) and across-coordinate (along the wall). */
export function doorAxes(door: Readonly<DoorInfo>, p: Readonly<Point3>): { through: number; across: number } {
  const sin = Math.sin(door.yaw), cos = Math.cos(door.yaw);
  const dx = p[0] - door.center[0], dz = p[2] - door.center[2];
  return { through: sin * dx + cos * dz, across: cos * dx - sin * dz };
}

/** Convert a frame-local floor point to world space. */
export function doorPoint(door: Readonly<DoorInfo>, across: number, through: number, out: Point3): Point3 {
  const c = Math.cos(door.yaw), s = Math.sin(door.yaw);
  out[0] = door.center[0] + across * c + through * s;
  out[1] = door.center[1];
  out[2] = door.center[2] - across * s + through * c;
  return out;
}

/** +1 extends from the left hinge; -1 extends from the right hinge. */
export const doorHandedness = (door: Readonly<DoorInfo>): 1 | -1 => door.hinge === 'right' ? -1 : 1;

/** Point along the actual rotating leaf, offset from its positive face. */
export function doorLeafPoint(door: Readonly<DoorInfo>, amount: number, along: number, face: number, out: Point3): Point3 {
  const q = doorHandedness(door), theta = clamp01(amount) * door.openAngle;
  return doorPoint(door, -q * door.clearWidth / 2 + q * along * Math.cos(theta) + face * Math.sin(theta),
    -q * along * Math.sin(theta) + face * Math.cos(theta), out);
}

/** Handle point on the selected face of either a left- or right-hinged leaf. */
export function doorHandle(door: Readonly<DoorInfo>, amount: number, side: 1 | -1, out: Point3): Point3 {
  doorLeafPoint(door, amount, 0.82 * door.clearWidth, side * (door.handleOffset ?? 0.1), out);
  out[1] += door.handleHeight ?? door.height * 0.5;
  return out;
}

/** Distance from a floor point to the rendered leaf segment, including its free end. */
export function doorLeafDistance(door: Readonly<DoorInfo>, amount: number, point: Readonly<Point3>): number {
  const p = doorAxes(door, point), q = doorHandedness(door), theta = clamp01(amount) * door.openAngle;
  const x = p.across + q * door.clearWidth / 2, z = p.through;
  const ex = q * Math.cos(theta), ez = -q * Math.sin(theta);
  const t = Math.max(0, Math.min(door.clearWidth, x * ex + z * ez));
  return Math.hypot(x - ex * t, z - ez * t);
}

export class DoorTraffic {
  private readonly amounts = new Map<string, DoorState>();
  private readonly duties = new Map<string, DoorHit>();

  constructor(private readonly source: DoorSource, private readonly now: () => number) {}

  private state(id: string): DoorState {
    let state = this.amounts.get(id);
    if (!state) {
      state = { amount: 0, operator: null, holdUntil: -Infinity };
      this.amounts.set(id, state);
    }
    return state;
  }

  /** How far a door's leaf is open (0 … 1). */
  amount(id: string): number { return this.amounts.get(id)?.amount ?? 0; }

  /** Walkers heading toward a door (not counting `excludeId`). */
  approachers(door: Readonly<DoorInfo>, excludeId: string): WalkerInfo[] {
    const result: WalkerInfo[] = [];
    const now = this.now();
    this.source.forEachWalker(walker => {
      if (walker.id === excludeId || now - walker.updatedAt > TRACK_FRESH_MS) return;
      if (Math.abs(walker.position[1] - door.center[1]) > 1.15) return;
      const at = doorAxes(door, walker.position);
      if (Math.hypot(at.through, at.across) > APPROACH_RANGE_M) return;
      const dx = walker.target[0] - walker.position[0], dz = walker.target[2] - walker.position[2];
      const towardDoor = dx * (door.center[0] - walker.position[0]) + dz * (door.center[2] - walker.position[2]) > 0;
      const ahead = doorAxes(door, walker.target);
      if (towardDoor && Math.hypot(ahead.through, ahead.across) <= APPROACH_TARGET_M) result.push(walker);
    });
    return result;
  }

  /** Another walker is standing at the threshold of the door. */
  occupied(door: Readonly<DoorInfo>, excludeId: string): boolean {
    let found = false;
    this.source.forEachWalker(walker => {
      if (found || walker.id === excludeId || Math.abs(walker.position[1] - door.center[1]) > 1.15) return;
      const at = doorAxes(door, walker.position);
      if (Math.hypot(at.through, at.across) < DOOR_NEAR_M && Math.abs(at.across) < door.clearWidth / 2 + 0.4) found = true;
    });
    return found;
  }

  /**
   * The door a planned step `from` → `to` passes through: the segment crosses
   * the leaf plane within the clear width, starting no further than
   * `DOOR_NEAR_M` from it. Null when the step crosses no door.
   */
  doorAhead(from: Readonly<Point3>, to: Readonly<Point3>): DoorHit | null {
    let found: DoorHit | null = null;
    this.source.forEachDoor((id, door) => {
      if (found || Math.abs(from[1] - door.center[1]) > 1.1) return;
      const a = doorAxes(door, from), b = doorAxes(door, to);
      const fromPlane = onPlane(a.through), toPlane = onPlane(b.through);
      if (Math.abs(fromPlane) > Math.max(DOOR_NEAR_M, door.clearWidth + 0.65) || fromPlane === toPlane || fromPlane * toPlane > 0) return;
      const t = fromPlane / (fromPlane - toPlane);
      const across = a.across + (b.across - a.across) * t;
      if (Math.abs(across) <= door.clearWidth / 2 + 0.25) found = { id, door };
    });
    return found;
  }

  /**
   * Whether a walker may go through a door now: `'pass'` when the leaf is open
   * enough; `'open'` when it is closed and free for this walker to swing; else `'wait'`.
   */
  request(id: string, door: Readonly<DoorInfo>, walkerId: string): 'pass' | 'open' | 'wait' {
    const state = this.state(id);
    if (state.operator !== null && state.operator !== walkerId) return 'wait';
    if (state.amount >= DOOR_PASS_OPEN) return 'pass';
    if (door.sliding) return 'wait';
    return state.operator === null || state.operator === walkerId ? 'open' : 'wait';
  }

  /** Reserve the whole maneuver, including walking round the open leaf. */
  claim(id: string, walkerId: string): boolean {
    const state = this.state(id);
    if (state.operator !== null && state.operator !== walkerId) return false;
    state.operator = walkerId;
    return true;
  }

  /** Do not sweep a leaf through a waiting or passing character. */
  clearForSwing(door: Readonly<DoorInfo>, excludeId: string, from: number, to: number): boolean {
    let clear = true;
    this.source.forEachWalker(walker => {
      if (!clear || walker.id === excludeId || this.now() - walker.updatedAt > TRACK_FRESH_MS || Math.abs(walker.position[1] - door.center[1]) > 1.15) return;
      for (let sample = 0; sample <= 2; sample++) {
        const amount = from + (to - from) * sample / 2;
        if (doorLeafDistance(door, amount, walker.position) < 0.36) { clear = false; break; }
      }
    });
    return clear;
  }

  /**
   * The reserved operator advances a hinged swing toward `target` (1 open,
   * 0 closed) over `seconds`, including the released part of an initial tug.
   */
  hold(id: string, walkerId: string, target: 0 | 1, seconds: number): number {
    const state = this.state(id);
    if (state.operator !== null && state.operator !== walkerId) return state.amount;
    state.operator = walkerId;
    const step = DOOR_SWING_RATE * Math.max(0, seconds);
    const next = clamp01(target > state.amount ? Math.min(target, state.amount + step) : Math.max(target, state.amount - step));
    // Foot-limited swings may leave a rounding residue at their exact endpoint.
    state.amount = Math.abs(next - target) < 1e-9 ? target : next;
    return state.amount;
  }

  /** The hand comes off the leaf. */
  release(id: string, walkerId: string): void {
    const state = this.state(id);
    if (state.operator === walkerId) state.operator = null;
  }

  /**
   * Record a walker's movement from `from` to `to`. A walker crossing an open
   * hinged door becomes its closer, unless someone else is approaching it.
   */
  moved(walkerId: string, from: Readonly<Point3>, to: Readonly<Point3>): void {
    this.source.forEachDoor((id, door) => {
      if (door.sliding || Math.abs(from[1] - door.center[1]) > 1.1) return;
      const a = doorAxes(door, from), b = doorAxes(door, to);
      const fromPlane = onPlane(a.through), toPlane = onPlane(b.through);
      if (fromPlane === toPlane || fromPlane * toPlane > 0 || Math.abs(fromPlane) > DOOR_NEAR_M) return;
      const t = fromPlane / (fromPlane - toPlane);
      const across = a.across + (b.across - a.across) * t;
      if (Math.abs(across) > door.clearWidth / 2 + 0.25 || this.amount(id) <= 0.05) return;
      if (this.approachers(door, walkerId).length === 0) this.duties.set(walkerId, { id, door });
    });
  }

  /** The door this walker must close behind it (the last one through), if any. */
  duty(walkerId: string): DoorHit | null { return this.duties.get(walkerId) ?? null; }

  /** Close duty done, cancelled or abandoned. */
  clearDuty(walkerId: string): void { this.duties.delete(walkerId); }

  /**
   * One frame of a sliding leaf: open while a walker is approaching or near,
   * then closing after `SLIDE_HOLD_MS` with nobody near. Returns the leaf fraction.
   */
  slideStep(id: string, door: Readonly<DoorInfo>, seconds: number): number {
    const state = this.state(id);
    const now = this.now();
    if (this.approachers(door, '').length > 0 || this.occupied(door, '')) state.holdUntil = now + SLIDE_HOLD_MS;
    const target = now < state.holdUntil ? 1 : 0;
    state.amount = clamp01(state.amount + (target - state.amount) * (1 - Math.exp(-SLIDE_RATE * Math.max(0, seconds))));
    return state.amount;
  }
}
