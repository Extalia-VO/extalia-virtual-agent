import { OFFICE_BUILDING, type Point3 } from '../layout';
import { getElevatorGeometry, type ElevatorId } from '../prefabs/architecture/elevatorController';
import type { WalkableSegment, WalkingNeighbor } from './naturalWalking';
import { staticSeatNeighborsClear } from './staticSeating';

const RADIUS = .29;
const distance = (a: Readonly<Point3>, b: Readonly<Point3>) => Math.hypot(a[0] - b[0], a[2] - b[2]);

/** Separate both landing queues from the cab's centre exit lane and each other. */
export function elevatorWaitingPosition(landing: Readonly<Point3>, door: { readonly z: number }, slot: number): Point3 {
  const index = Math.max(0, Math.floor(slot));
  return [landing[0] - 1.2 * (index % 3), landing[1], landing[2] + (door.z < 0 ? -1 : 1) * (1 + 1.2 * Math.floor(index / 3))];
}

/**
 * Ordinary renderer clearance owns the landing. Only the controller-owned
 * bridge/cab may leave the building inset, using their authored physical sizes.
 * Render clearance intentionally excludes the dynamic cabin and cannot approve
 * an upper-floor segment outside the building polygon by itself.
 */
export function elevatorSegmentClear(liftId: ElevatorId, from: Readonly<Point3>, to: Readonly<Point3>, walkable?: WalkableSegment): boolean {
  if (![...from, ...to].every(Number.isFinite) || Math.abs(from[1] - to[1]) > .05) return false;
  const lift = getElevatorGeometry(liftId), inset = OFFICE_BUILDING.east - RADIUS - .01;
  if (from[0] <= inset && to[0] <= inset) return !walkable || walkable(from, to, RADIUS);
  // Check every portion that still belongs to the ordinary floor, including furniture.
  if (from[0] < inset || to[0] < inset) {
    const t = (inset - from[0]) / (to[0] - from[0]);
    const edge: Point3 = [inset, from[1], from[2] + (to[2] - from[2]) * t];
    if (walkable && !(from[0] < inset ? walkable(from, edge, RADIUS) : walkable(edge, to, RADIUS))) return false;
  }
  const samples = Math.max(1, Math.ceil(distance(from, to) / .05));
  for (let index = 0; index <= samples; index++) {
    const t = index / samples, x = from[0] + (to[0] - from[0]) * t, z = from[2] + (to[2] - from[2]) * t;
    if (x <= inset) continue;
    const across = Math.abs(z - lift.z);
    if (x > lift.x + lift.cabWidth / 2 - RADIUS || across > lift.cabDepth / 2 - RADIUS) return false;
    // The landing jambs and the bridge railings remain obstacles with doors open.
    if (Math.abs(x - lift.doorX) <= .15 + RADIUS + .01 && across > lift.doorWidth / 2 - RADIUS) return false;
    if (x < lift.x - lift.cabWidth / 2 + RADIUS && across > lift.doorWidth / 2 + .25 - RADIUS) return false;
  }
  return true;
}

interface PathState { target: Point3; path: Point3[]; retry: number }
const paths = new WeakMap<object, PathState>();

/** A bounded visibility path around actual waiting bodies; never crosses another lift. */
function plan(id: string, from: Readonly<Point3>, to: Readonly<Point3>, clear: (a: Readonly<Point3>, b: Readonly<Point3>) => boolean,
  neighbors: readonly WalkingNeighbor[], landingOnly: boolean): Point3[] | null {
  if (clear(from, to)) return [[...to]];
  const points: Point3[] = [[...from], [...to], [from[0], from[1], to[2]], [to[0], from[1], from[2]]];
  const nearby = neighbors.filter(other => other.id !== id && Math.abs(other.position[1] - from[1]) < .8 && distance(other.position, from) < 4)
    .sort((a, b) => distance(a.position, from) - distance(b.position, from)).slice(0, 8);
  for (const other of nearby) for (const [dx, dz] of [[-.66, -.66], [-.66, .66], [.66, -.66], [.66, .66], [-.8, 0], [.8, 0], [0, -.8], [0, .8]]) {
    const point: Point3 = [other.position[0] + dx!, from[1], other.position[2] + dz!];
    if ((!landingOnly || point[0] <= OFFICE_BUILDING.east - RADIUS - .01) && clear(point, point)) points.push(point);
  }
  const costs = points.map(() => Infinity), previous = points.map(() => -1), visited = new Set<number>();
  costs[0] = 0;
  while (visited.size < points.length) {
    let current = -1;
    for (let index = 0; index < points.length; index++) if (!visited.has(index) && (current < 0 || costs[index]! < costs[current]!)) current = index;
    if (current < 0 || !Number.isFinite(costs[current])) return null;
    if (current === 1) {
      const path: Point3[] = [];
      for (let index = 1; index > 0; index = previous[index]!) path.unshift(points[index]!);
      return path;
    }
    visited.add(current);
    for (let index = 1; index < points.length; index++) {
      if (visited.has(index)) continue;
      const cost = costs[current]! + distance(points[current]!, points[index]!);
      if (cost >= costs[index]! || !clear(points[current]!, points[index]!)) continue;
      costs[index] = cost; previous[index] = current;
    }
  }
  return null;
}

/** Cache safe bends across frames; unavailable corridors retry after bounded simulation time. */
export function elevatorMovementTarget(owner: object, id: string, liftId: ElevatorId, from: Readonly<Point3>, to: Readonly<Point3>,
  seconds: number, walkable: WalkableSegment | undefined, neighbors: readonly WalkingNeighbor[], landingOnly = false): Point3 | null {
  const clear = (a: Readonly<Point3>, b: Readonly<Point3>) => (!landingOnly || Math.max(a[0], b[0]) <= OFFICE_BUILDING.east - RADIUS - .01)
    && elevatorSegmentClear(liftId, a, b, walkable) && staticSeatNeighborsClear(id, a, b, neighbors);
  let state = paths.get(owner);
  if (!state || Math.abs(state.target[1] - to[1]) > .01 || distance(state.target, to) > .01) {
    state = { target: [...to], path: [], retry: 0 }; paths.set(owner, state);
  }
  while (state.path.length && distance(from, state.path[0]!) < .025) state.path.shift();
  state.retry = Math.max(0, state.retry - seconds);
  if (state.path.length && clear(from, state.path[0]!)) return state.path[0]!;
  state.path = [];
  if (state.retry > 0) return null;
  state.retry = .3;
  state.path = plan(id, from, to, clear, neighbors, landingOnly) ?? [];
  return state.path[0] ?? null;
}
