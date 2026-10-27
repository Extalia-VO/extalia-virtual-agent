/** Fixed seats have an open front; their backs and armrests are never walkways. */
import type { Point3 } from '../layout';
import type { OfficeNavigation, SeatApproach } from './navGraph';
import type { WalkableSegment, WalkingNeighbor } from './naturalWalking';

export const STATIC_BODY_RADIUS = 0.29;
export const STATIC_BODY_SEPARATION = 0.56;
const distance = (a: Readonly<Point3>, b: Readonly<Point3>) => Math.hypot(a[0] - b[0], a[2] - b[2]);

export function isStaticSeat(seat: SeatApproach): boolean {
  return !seat.standing && (seat.seatStyle === 'sofa' || seat.seatStyle === 'armchair' || seat.seatStyle === 'bench' || seat.seatStyle === 'patio');
}

export function staticSeatPoint(seat: SeatApproach, x: number, z: number): Point3 {
  const c = Math.cos(seat.rotationY), s = Math.sin(seat.rotationY);
  return [seat.seat[0] + x * c + z * s, seat.seat[1], seat.seat[2] - x * s + z * c];
}

function local(seat: SeatApproach, p: Readonly<Point3>): readonly [number, number] {
  const dx = p[0] - seat.seat[0], dz = p[2] - seat.seat[2], c = Math.cos(seat.rotationY), s = Math.sin(seat.rotationY);
  return [dx * c - dz * s, dx * s + dz * c];
}

/** Feet stop outside the cushion, then the hips translate a short distance as they lower. */
export const staticSeatContact = (seat: SeatApproach): Point3 => staticSeatPoint(seat, 0, (seat.seatFront ?? 0.23) + 0.10);

/** Swept bodies, including a short prediction for someone crossing the terminal lane. */
export function staticSeatNeighborsClear(id: string, from: Readonly<Point3>, to: Readonly<Point3>, neighbors: readonly WalkingNeighbor[], seconds = 0): boolean {
  const dx = to[0] - from[0], dz = to[2] - from[2];
  for (const other of neighbors) {
    if (other.id === id || Math.abs(other.position[1] - from[1]) > 0.8) continue;
    const ox = from[0] - other.position[0], oz = from[2] - other.position[2];
    const rx = dx - other.velocity[0] * seconds, rz = dz - other.velocity[2] * seconds;
    const length2 = rx * rx + rz * rz;
    const t = length2 > 1e-9 ? Math.max(0, Math.min(1, -(ox * rx + oz * rz) / length2)) : 0;
    const closest = Math.hypot(ox + rx * t, oz + rz * t);
    // A pre-existing overlap may recover by moving away, never by moving deeper.
    const clearance = Math.min(STATIC_BODY_SEPARATION, Math.hypot(ox, oz));
    if (closest < clearance - 1e-6) return false;
  }
  return true;
}

interface SeatBounds { left: number; right: number; back: number; front: number }
function furnitureBounds(seat: SeatApproach, navigation: OfficeNavigation): SeatBounds {
  const half = seat.seatStyle === 'sofa' ? 0.63 : seat.seatStyle === 'bench' ? 0.42 : 0.53;
  let left = 0, right = 0;
  // Join adjacent slots of the same sofa/bench so a middle seat cannot take a
  // diagonal shortcut across another cushion. Separate front lanes remain open.
  if (seat.seatStyle === 'sofa' || seat.seatStyle === 'bench') {
    const slots = [...navigation.seats.values()].filter(other => other.roomId === seat.roomId && other.seatStyle === seat.seatStyle &&
      Math.abs(other.seat[1] - seat.seat[1]) < 0.05 && Math.abs(Math.sin((other.rotationY - seat.rotationY) / 2)) < 0.01)
      .map(other => local(seat, other.seat)).filter(([, z]) => Math.abs(z) < 0.12).map(([x]) => x).sort((a, b) => a - b);
    let changed = true;
    while (changed) {
      changed = false;
      for (const x of slots) if (x >= left - 1.1 && x <= right + 1.1) {
        if (x < left) { left = x; changed = true; }
        if (x > right) { right = x; changed = true; }
      }
    }
  }
  return { left: left - half - STATIC_BODY_RADIUS, right: right + half + STATIC_BODY_RADIUS,
    back: -0.65 - STATIC_BODY_RADIUS, front: (seat.seatFront ?? 0.23) + 0.04 + STATIC_BODY_RADIUS };
}

function outsideFurniture(seat: SeatApproach, a: Readonly<Point3>, b: Readonly<Point3>, bounds: SeatBounds): boolean {
  const from = local(seat, a), to = local(seat, b);
  let enter = 0, exit = 1;
  for (const [start, end, min, max] of [[from[0], to[0], bounds.left, bounds.right], [from[1], to[1], bounds.back, bounds.front]]) {
    const delta = end! - start!;
    if (Math.abs(delta) < 1e-9) { if (start! < min! || start! > max!) return true; }
    else {
      const t0 = (min! - start!) / delta, t1 = (max! - start!) / delta;
      enter = Math.max(enter, Math.min(t0, t1)); exit = Math.min(exit, Math.max(t0, t1));
      if (enter > exit) return true;
    }
  }
  return false;
}

export interface StaticSeatRoute { readonly apron: Point3; readonly contact: Point3; readonly path: Point3[] }

/**
 * A small visibility graph routes side/back staging around the furniture.
 * Render clearance applies to this exterior corridor. Only the straight,
 * seat-local front contact is exempt from conservative cushion render bounds.
 */
export function staticSeatRoute(id: string, seat: SeatApproach, from: Readonly<Point3>, navigation: OfficeNavigation,
  walkable?: WalkableSegment, neighbors: readonly WalkingNeighbor[] = [], contactClear?: WalkableSegment): StaticSeatRoute | null {
  const contact = staticSeatContact(seat), bounds = furnitureBounds(seat, navigation);
  if (!staticSeatNeighborsClear(id, contact, seat.seat, neighbors) || (contactClear && !contactClear(contact, seat.seat, STATIC_BODY_RADIUS))) return null;
  const clear = (a: Readonly<Point3>, b: Readonly<Point3>) => outsideFurniture(seat, a, b, bounds) &&
    (!walkable || walkable(a, b, STATIC_BODY_RADIUS)) && staticSeatNeighborsClear(id, a, b, neighbors);
  const front = seat.seatFront ?? 0.23;
  const aprons = [0.34, 0.42, 0.62, 0.82, 1.22].map(gap => staticSeatPoint(seat, 0, front + gap))
    .filter(point => staticSeatNeighborsClear(id, point, contact, neighbors) && (!walkable || walkable(point, point, STATIC_BODY_RADIUS)) &&
      (!contactClear || contactClear(point, contact, STATIC_BODY_RADIUS)));
  if (!aprons.length) return null;
  const points: Point3[] = [[...from] as Point3, ...aprons];
  const xs = [bounds.left - 0.08, bounds.right + 0.08, bounds.left - 0.45, bounds.right + 0.45, 0];
  const zs = [bounds.back - 0.08, bounds.back - 0.45, front + 0.34, front + 0.42, front + 0.82, front + 1.22];
  for (const x of xs) for (const z of zs) {
    const point = staticSeatPoint(seat, x, z);
    if (clear(point, point)) points.push(point);
  }
  // Nearby aisle anchors help navigate a coffee table or a neighboring chair.
  for (const node of navigation.waypoints.values()) {
    if (node.kind === 'connector' || node.kind === 'door' || Math.abs(node.position[1] - seat.seat[1]) > 0.05 || distance(node.position, seat.seat) > 4) continue;
    const point = [...node.position] as Point3;
    if (clear(point, point)) points.push(point);
  }
  const costs = points.map(() => Infinity), previous = points.map(() => -1), visited = new Set<number>();
  costs[0] = 0;
  while (visited.size < points.length) {
    let next = -1;
    for (let i = 0; i < points.length; i++) if (!visited.has(i) && (next < 0 || costs[i]! < costs[next]!)) next = i;
    if (next < 0 || !Number.isFinite(costs[next])) break;
    if (next > 0 && next <= aprons.length) {
      const path: Point3[] = [];
      for (let cursor = next; cursor > 0; cursor = previous[cursor]!) path.unshift(points[cursor]!);
      return { apron: points[next]!, contact, path };
    }
    visited.add(next);
    for (let i = 1; i < points.length; i++) {
      if (visited.has(i)) continue;
      const cost = costs[next]! + distance(points[next]!, points[i]!);
      if (cost >= costs[i]! || !clear(points[next]!, points[i]!)) continue;
      costs[i] = cost; previous[i] = next;
    }
  }
  return null;
}
