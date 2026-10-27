import type { Point3 } from "../../layout";
import type { CampusFloor } from "../worldRegistry";

/**
 * Frame-local physical presence registry.
 *
 * Stage 4.2 keeps global A* static and uses this registry only for local,
 * predictive collision avoidance / headway. This avoids the old feedback loop
 * where every moving avatar continuously changed everyone else's global path.
 */
export type OccupantMotionMode =
  | "idle"
  | "walk"
  | "stairs_up"
  | "stairs_down"
  | "interaction";

export type MovingOccupantSnapshot = {
  id: string;
  position: Point3;
  target: Point3;
  velocity: Point3;
  motion: OccupantMotionMode;
  updatedAt: number;
};

type MovingOccupantState = Omit<MovingOccupantSnapshot, "id">;

const movingOccupants = new Map<string, MovingOccupantState>();
// Seated bodies remain physical obstacles without registering door-opening intent.
const stationaryOccupants = new Map<string, Point3>();

export function trackStationaryOccupant(id: string, position: Readonly<Point3> | null): void {
  if (!position) { stationaryOccupants.delete(id); return; }
  const point = stationaryOccupants.get(id) ?? [0, 0, 0];
  point[0] = position[0]; point[1] = position[1]; point[2] = position[2];
  stationaryOccupants.set(id, point);
}

function stationarySnapshot(id: string, point: Point3, updatedAt: number): MovingOccupantSnapshot {
  return { id, position: [...point], target: [...point], velocity: [0, 0, 0], motion: 'idle', updatedAt };
}
export type DoorPortal = {
  floor: CampusFloor;
  roomId: string;
  role: string;
  /** World-space center of the door frame at the threshold. */
  center: Point3;
  /** World-space frame yaw, measured from the positive Z axis. */
  yaw: number;
  clearWidth: number;
  openAmount: number;
  /** Leaf height and the hinged leaf's fully open angle (radians; positive swings toward local -Z). */
  height: number;
  openAngle: number;
  /** Which jamb carries the hinged leaf; omitted portals use the left jamb. */
  hinge?: "left" | "right";
  handleHeight?: number;
  handleOffset?: number;
  /** Sliding leaves open by themselves; hinged leaves only move while a character holds them. */
  sliding: boolean;
};

export type DoorPortalSnapshot = DoorPortal & { id: string };
const doorPortals = new Map<string, DoorPortal>();

export function setDoorPortal(id: string, portal: DoorPortal | null) {
  if (portal) doorPortals.set(id, { ...portal, center: [...portal.center] as Point3 });
  else doorPortals.delete(id);
}

/** Visit every registered door without copying (per-frame door logic). */
export function forEachDoorPortal(visit: (id: string, portal: Readonly<DoorPortal>) => void) {
  for (const [id, portal] of doorPortals) visit(id, portal);
}

/** Visit every walking character tracked for door logic, without copying. */
export function forEachTrackedWalker(visit: (id: string, position: Readonly<Point3>, target: Readonly<Point3>, updatedAt: number) => void) {
  for (const [id, state] of movingOccupants) visit(id, state.position, state.target, state.updatedAt);
}

/** Return detached, stable semantic portal data for scene overlays and inspection. */
export function getDoorPortalsSnapshot(): DoorPortalSnapshot[] {
  return [...doorPortals].map(([id, portal]) => ({
    ...portal,
    id,
    center: [...portal.center] as Point3
  })).sort((a, b) => a.id.localeCompare(b.id));
}

/** Stop at an automatic threshold until the moving leaf has cleared the opening. */
export function doorwayCrossingReady(from: Point3, to: Point3, agentRadius = 0.29) {
  for (const door of doorPortals.values()) {
    const [x, y, z] = door.center;
    if (Math.abs(from[1] - y) > 1.1 || Math.abs(to[1] - y) > 1.1) continue;
    const sin = Math.sin(door.yaw);
    const cos = Math.cos(door.yaw);
    const fromAcross = cos * (from[0] - x) - sin * (from[2] - z);
    const toAcross = cos * (to[0] - x) - sin * (to[2] - z);
    const fromThrough = sin * (from[0] - x) + cos * (from[2] - z);
    const toThrough = sin * (to[0] - x) + cos * (to[2] - z);
    const throughDelta = toThrough - fromThrough;
    if (Math.abs(throughDelta) < 1e-4 || fromThrough * toThrough > 0) continue;
    const t = fromThrough / (fromThrough - toThrough);
    const across = fromAcross + (toAcross - fromAcross) * t;
    if (Math.abs(across) <= Math.max(0, door.clearWidth * 0.5 - agentRadius) && door.openAmount < 0.78) return false;
  }
  return true;
}

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function clampVelocityComponent(value: number, max = 3.5) {
  return Math.max(-max, Math.min(max, value));
}

export function setMovingOccupant(
  occupantId: string,
  position: Point3 | null,
  target?: Point3,
  motion: OccupantMotionMode = "walk"
) {
  if (!position || !target) {
    movingOccupants.delete(occupantId);
    return;
  }

  const now = nowMs();
  const previous = movingOccupants.get(occupantId);
  let velocity: Point3 = [0, 0, 0];

  if (previous) {
    const dt = Math.max(0.016, Math.min(0.25, (now - previous.updatedAt) / 1000));
    const raw: Point3 = [
      clampVelocityComponent((position[0] - previous.position[0]) / dt),
      clampVelocityComponent((position[1] - previous.position[1]) / dt),
      clampVelocityComponent((position[2] - previous.position[2]) / dt)
    ];
    // Light smoothing is enough to make short-horizon predictions stable without
    // making an agent continue "moving" long after it has stopped.
    if (motion === "idle") {
      velocity = [0, 0, 0];
    } else {
      const blend = 0.65;
      velocity = [
        previous.velocity[0] * (1 - blend) + raw[0] * blend,
        previous.velocity[1] * (1 - blend) + raw[1] * blend,
        previous.velocity[2] * (1 - blend) + raw[2] * blend
      ];
    }
  }

  movingOccupants.set(occupantId, {
    position: [...position] as Point3,
    target: [...target] as Point3,
    velocity,
    motion,
    updatedAt: now
  });
}

/**
 * Allocation-free per-frame form of `setMovingOccupant` for walkers that own
 * their position tuples (doors open for them); `null` removes the walker.
 * Velocity is measured from the previous copied frame, independently of the owner's mutable tuple.
 */
export function trackMovingOccupant(occupantId: string, position: Readonly<Point3> | null, target?: Readonly<Point3>, motion: OccupantMotionMode = "walk", timestamp = nowMs()) {
  if (!position || !target) {
    movingOccupants.delete(occupantId);
    return;
  }
  let state = movingOccupants.get(occupantId);
  const previous = Boolean(state);
  if (!state) {
    state = { position: [0, 0, 0], target: [0, 0, 0], velocity: [0, 0, 0], motion, updatedAt: 0 };
    movingOccupants.set(occupantId, state);
  }
  const dt = Math.max(.008, Math.min(.25, (timestamp - state.updatedAt) / 1000));
  for (let axis = 0; axis < 3; axis++) {
    const measured = previous && motion !== 'idle' ? clampVelocityComponent((position[axis]! - state.position[axis]!) / dt) : 0;
    state.velocity[axis] = measured;
  }
  state.position[0] = position[0]; state.position[1] = position[1]; state.position[2] = position[2];
  state.target[0] = target[0]; state.target[1] = target[1]; state.target[2] = target[2];
  state.motion = motion;
  state.updatedAt = timestamp;
}

/** Return a stable copy so callers can safely iterate while other agents move. */
export function getMovingOccupantsSnapshot(excludeId?: string): MovingOccupantSnapshot[] {
  const result: MovingOccupantSnapshot[] = [];
  for (const [id, state] of movingOccupants) {
    if (id === excludeId) continue;
    result.push({
      id,
      position: [...state.position] as Point3,
      target: [...state.target] as Point3,
      velocity: [...state.velocity] as Point3,
      motion: state.motion,
      updatedAt: state.updatedAt
    });
  }
  for (const [id, point] of stationaryOccupants) {
    if (id !== excludeId && !movingOccupants.has(id)) result.push(stationarySnapshot(id, point, nowMs()));
  }
  return result;
}

/** Local steering cannot meet bodies beyond this conservative 1.15 s envelope.
 * Velocity components are clamped to 3.5 m/s; 12 m exceeds combined closing
 * distance plus body clearance. Upper/lower stories outside 1.5 m are separate.
 * Full detached snapshots remain available for admission and diagnostics.
 */
export function getNearbyMovingOccupantsSnapshot(excludeId: string, point: Readonly<Point3>): MovingOccupantSnapshot[] {
  const result: MovingOccupantSnapshot[] = [];
  const now = nowMs();
  for (const [id, state] of movingOccupants) {
    if (id === excludeId || now - state.updatedAt > 750 || Math.abs(state.position[1] - point[1]) > 1.5 ||
        Math.hypot(state.position[0] - point[0], state.position[2] - point[2]) > 12) continue;
    result.push({ id, position: [...state.position] as Point3, target: [...state.target] as Point3,
      velocity: [...state.velocity] as Point3, motion: state.motion, updatedAt: state.updatedAt });
  }
  for (const [id, position] of stationaryOccupants) {
    if (id === excludeId || movingOccupants.has(id) || Math.abs(position[1] - point[1]) > 1.5 ||
        Math.hypot(position[0] - point[0], position[2] - point[2]) > 12) continue;
    result.push(stationarySnapshot(id, position, now));
  }
  return result;
}

/**
 * Short-horizon XZ closest-approach distance for velocity-obstacle style steering.
 * Y is intentionally filtered before calling this helper.
 */
export function predictedClosestDistanceXZ(
  selfPosition: Point3,
  selfVelocity: Point3,
  other: MovingOccupantSnapshot,
  horizonSeconds = 1.15
): number {
  const rx = other.position[0] - selfPosition[0];
  const rz = other.position[2] - selfPosition[2];
  const rvx = other.velocity[0] - selfVelocity[0];
  const rvz = other.velocity[2] - selfVelocity[2];
  const relativeSpeedSq = rvx * rvx + rvz * rvz;

  let t = 0;
  if (relativeSpeedSq > 0.0001) {
    t = Math.max(0, Math.min(horizonSeconds, -(rx * rvx + rz * rvz) / relativeSpeedSq));
  }

  const dx = rx + rvx * t;
  const dz = rz + rvz * t;
  return Math.hypot(dx, dz);
}

/** Physical separation at the current instant, not the predicted comfort radius. */
export function currentDistanceXZ(a: Point3, b: Point3) {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}
