import type { Point3 } from '../layout';
import { doorAxes, doorHandedness, doorLeafPoint, doorPoint, type DoorInfo } from '../interior/doorTraffic';

/** Body capsule plus clearance from the leaf and jambs, in metres. */
export const DOOR_BODY_CLEARANCE = 0.34;
export const DOOR_GRIP_OFFSET = 0.42;

/** Feet follow the middle of the leaf; the hand reaches farther along to its handle. */
export function doorGripPosition(door: Readonly<DoorInfo>, amount: number, side: 1 | -1, out: Point3): Point3 {
  return doorLeafPoint(door, amount, door.clearWidth * 0.5, side * DOOR_GRIP_OFFSET, out);
}

/**
 * Turn back beside the handle, rather than returning to the middle of the leaf.
 * Near the jamb, the feet tuck inward enough that their complete swing circle
 * clears the latch post. Only the final third of a quarter turn extends the
 * stance toward the free edge, where the wall is already behind the body.
 */
export function doorClosePosition(door: Readonly<DoorInfo>, amount: number, side: 1 | -1, out: Point3, entryStart?: number): Point3 {
  if (entryStart !== undefined) return doorEntryClosePosition(door, amount, side, out, entryStart);
  const width = door.clearWidth;
  const handleAlong = width * 0.82;
  const jambRadius = Math.max(0, width - DOOR_BODY_CLEARANCE - 0.01);
  const innerAlong = Math.min(handleAlong, Math.sqrt(Math.max(0, jambRadius * jambRadius - DOOR_GRIP_OFFSET * DOOR_GRIP_OFFSET)));
  const theta = Math.abs(Math.max(0, Math.min(1, amount)) * door.openAngle);
  const t = Math.max(0, Math.min(1, (theta - Math.PI / 3) / (Math.PI / 6)));
  const along = innerAlong + (handleAlong - innerAlong) * t * t * (3 - 2 * t);
  return doorLeafPoint(door, amount, along, side * DOOR_GRIP_OFFSET, out);
}

/**
 * After pushing inward, tug the accessible handle and step inside as the leaf
 * closes. The feet round its moving tip, never its stationary rear face.
 * A radius of .42 m keeps the complete body clear as the tip changes sides.
 */
export function doorEntryClosePosition(door: Readonly<DoorInfo>, amount: number, side: 1 | -1, out: Point3, start = 1): Point3 {
  const progress = Math.max(0, Math.min(1, amount / Math.max(1e-6, start)));
  const phi = Math.PI / 2 - Math.PI * progress;
  return doorLeafPoint(door, amount, door.clearWidth + DOOR_GRIP_OFFSET * Math.cos(phi),
    -side * DOOR_GRIP_OFFSET * Math.sin(phi), out);
}

/** Release the entry-side tug before the turning leaf takes the handle away. */
export function doorEntryCloseHandWeight(door: Readonly<DoorInfo>, amount: number, start: number): number {
  return Math.max(0, 1 - Math.max(0, start - amount) * Math.abs(door.openAngle) / (Math.PI / 36));
}

/** Pull from the latch, then step aside instead of following the leaf behind its hinge. */
export function doorOpenPosition(door: Readonly<DoorInfo>, amount: number, side: 1 | -1, out: Point3): Point3 {
  if (side !== doorSwingSide(door)) return doorGripPosition(door, amount, side, out);
  const theta = Math.abs(amount * door.openAngle);
  const t = Math.min(1, theta / (Math.PI / 18));
  const latch = door.clearWidth * 0.32;
  const parked = door.clearWidth / 2 + DOOR_BODY_CLEARANCE + 0.02;
  return doorPoint(door, doorHandedness(door) * (latch + (parked - latch) * t),
    side * (DOOR_GRIP_OFFSET + 0.26 * t), out);
}

/** The initial tug releases before the moving handle leaves arm reach. */
export function doorOpenHandWeight(door: Readonly<DoorInfo>, amount: number, side: 1 | -1): number {
  return side === doorSwingSide(door) ? Math.max(0, 1 - Math.abs(amount * door.openAngle) / (Math.PI / 36)) : 1;
}

export const doorSwingSide = (door: Readonly<DoorInfo>): 1 | -1 => -doorHandedness(door) * Math.sign(door.openAngle || 1) as 1 | -1;

type P = { x: number; z: number };
const cross = (a: P, b: P, c: P) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
function pointSegment(p: P, a: P, b: P): number {
  const dx = b.x - a.x, dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / Math.max(1e-12, dx * dx + dz * dz)));
  return Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz);
}
function segmentDistance(a: P, b: P, c: P, d: P): number {
  if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return 0;
  return Math.min(pointSegment(a, c, d), pointSegment(b, c, d), pointSegment(c, a, b), pointSegment(d, a, b));
}

/**
 * Shortest clear path through the doorway or round the free end of its leaf.
 * The hinge end is never a shortcut through the adjoining wall. No detour is
 * returned when the aperture cannot fit the capsule; callers keep waiting.
 */
export function doorWalkPath(door: Readonly<DoorInfo>, amount: number, from: Readonly<Point3>, to: Readonly<Point3>): Point3[] | null {
  const local = (p: Readonly<Point3>): P => { const a = doorAxes(door, p); return { x: a.across, z: a.through }; };
  const q = doorHandedness(door), w = door.clearWidth, theta = amount * door.openAngle;
  const hinge: P = { x: -q * w / 2, z: 0 };
  const e: P = { x: q * Math.cos(theta), z: -q * Math.sin(theta) };
  const n: P = { x: Math.sin(theta), z: Math.cos(theta) };
  const tip: P = { x: hinge.x + e.x * w, z: e.z * w };
  const nodes: P[] = [local(from), local(to)];
  // Closely spaced points round the free tip permit a short, clear change of
  // leaf face. Their chords stay outside the body capsule (r*cos(pi/16)>.34).
  for (let i = -4; i <= 4; i++) {
    const phi = i * Math.PI / 8, r = DOOR_BODY_CLEARANCE + 0.04;
    nodes.push({ x: tip.x + r * (e.x * Math.cos(phi) + n.x * Math.sin(phi)), z: tip.z + r * (e.z * Math.cos(phi) + n.z * Math.sin(phi)) });
  }
  // A square apron around the free tip keeps every connecting segment outside
  // its capsule; threshold nodes keep crossings away from both jambs.
  for (const face of [-1, 1]) {
    for (const extension of [0, 0.5]) nodes.push({ x: tip.x + e.x * extension + n.x * face * 0.5, z: tip.z + e.z * extension + n.z * face * 0.5 });
    nodes.push({ x: 0, z: face * 0.65 }, { x: q * (w / 2 - DOOR_BODY_CLEARANCE - 0.02), z: face * 0.65 }, { x: 0, z: face * (w + 0.65) });
  }
  const jambs = [{ x: -w / 2, z: 0 }, { x: w / 2, z: 0 }];
  const clear = (a: P, b: P): boolean => {
    if (segmentDistance(a, b, hinge, tip) < DOOR_BODY_CLEARANCE - 1e-6) return false;
    if (jambs.some(jamb => pointSegment(jamb, a, b) < DOOR_BODY_CLEARANCE)) return false;
    if (a.z * b.z <= 0 && Math.abs(a.z - b.z) > 1e-8) {
      const x = a.x + (b.x - a.x) * a.z / (a.z - b.z);
      if (Math.abs(x) > w / 2) return false;
    }
    // Points on the wall itself cannot be used to round the hinge/jamb.
    return ![a, b].some(p => (Math.abs(p.z) < 0.06 && Math.abs(p.x) > w / 2 - DOOR_BODY_CLEARANCE)
      || (Math.abs(p.x) > w / 2 && Math.abs(p.z) < DOOR_BODY_CLEARANCE));
  };
  const distances = nodes.map(() => Infinity), previous = nodes.map(() => -1), visited = new Set<number>();
  distances[0] = 0;
  for (let k = 0; k < nodes.length; k++) {
    let at = -1;
    for (let i = 0; i < nodes.length; i++) if (!visited.has(i) && (at < 0 || distances[i]! < distances[at]!)) at = i;
    if (at < 0 || !Number.isFinite(distances[at]!)) return null;
    if (at === 1) {
      const path: Point3[] = [];
      for (let i = 1; i !== 0; i = previous[i]!) path.unshift(doorPoint(door, nodes[i]!.x, nodes[i]!.z, [0, 0, 0]));
      return path;
    }
    visited.add(at);
    for (let i = 0; i < nodes.length; i++) {
      if (visited.has(i) || !clear(nodes[at]!, nodes[i]!)) continue;
      const d = distances[at]! + Math.hypot(nodes[i]!.x - nodes[at]!.x, nodes[i]!.z - nodes[at]!.z);
      if (d < distances[i]!) { distances[i] = d; previous[i] = at; }
    }
  }
  return null;
}
