import { PARKING_ACCESS, PARKING_LOTS, parkingSurfaceY, type ParkingLot } from './campusParkingLots';
import {
  DAILY_CATALOG, PARKED_VEHICLES, TRAFFIC_LANES, TRAFFIC_TIMING, VEHICLE_SPECS,
  carActive, createTrafficPose, isMobilityVehicle, laneLength, trafficDensity,
  type CatalogVehicle, type LaneSchedule, type MobilityModel, type ParkedVehicle, type TrafficCarPose, type TrafficLane,
} from './campusMobilityLayout';

/**
 * Parking-lot manoeuvres: cars leave their bays and join the lot's traffic lane, and cars arrive from
 * that lane and park, on a deterministic per-lot schedule. Pure simulation (no Three.js): the
 * renderer reads `ManeuverPose`s and the lot occupancy; every array is allocated once per lot and
 * once per manoeuvre, never per frame.
 */

type Point = readonly [number, number];
/** A lot as published by the shared contract (`campusParkingLots.ts`, owned by the parking-lot module). */
export type LotInput = ParkingLot;
export const MANEUVER_LOTS: readonly LotInput[] = PARKING_LOTS;

export const LOT_TIMING = Object.freeze({
  /** Seconds between manoeuvre decisions (busier at rush hour), the first one, and a blocked retry. */
  interval: [20, 60] as const, first: [6, 18] as const, retry: 2,
  /** m/s and m/s²: lot, turning and reversing speeds; gentle lot acceleration, brisker on the road. */
  lotSpeed: 2.6, turnSpeed: 4, bayTurnSpeed: 1.8, reverseSpeed: 1.1, accel: 1.5, laneAccel: 2.6, decel: 2.4,
  /** Engine start (lamps on before moving), a gear change between legs, the parking flash and lights-off delay. */
  engineStart: 1.5, gearPause: .7, lightsOff: 1, flash: [[0, .3], [.45, .75]] as readonly (readonly [number, number])[],
  /** Gap acceptance at the give-way line (metres behind/ahead on the lane) and for an arrival entering the lane. */
  mergeBehind: 32, mergeAhead: 10, arrivalLead: 5, arrivalAhead: 18, holdLook: 8,
  /**
   * Carriageway edge (lateral metres from the lane centre; `PARKING_ACCESS.roadEdge` on the drawn access)
   * and the give-way stop: the front bumper this far short of that edge, just behind the painted line.
   */
  giveWay: .45, roadEdge: 1.85,
  /** Each direction keeps left on the two-way access drive: lane centres this far from its centre line. */
  accessLane: PARKING_ACCESS.halfWidth / 2, laneShift: 4,
  /** Tightest centre-line turn into or out of a bay; corner fillets on aisle bends and the lane junction. */
  minTurn: 3, aisleTurn: 4, junctionTurn: 5,
  /** Past the far end of the bay row a pulling-forward (or reversing-out) car may reach this far with its body. */
  rowOverrun: 1, bayHalfWidth: 1.6,
  /** Straight runs tried (shortest first) before the bay turn, widest arc first, until the way is clear. */
  runs: [0, .5, 1, 1.5] as readonly number[],
  /** Occupancy kept within [min, max] of the bays; arrivals may add this many cars of one style. */
  occupancy: [.3, .88] as const, extraPerModel: 2, clearance: .08,
});

export type ManeuverKind = 'depart' | 'arrive';
export type ManeuverPhase = 'parked' | 'starting' | 'reversing' | 'driving' | 'merging' | 'arriving' | 'parking';

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

/** Speed zone along a leg: from `s` on, at most `v` (m/s). */
export interface SpeedZone { s: number; v: number }
export interface RouteLeg {
  /** +1 forward, -1 reversing (heading opposite to the motion). */
  gear: 1 | -1;
  x: Float32Array; z: Float32Array; y: Float32Array; yaw: Float32Array; s: Float32Array; count: number; length: number;
  zones: SpeedZone[];
  /** Departure's road leg: the car leaves at speed at the lane end instead of stopping. */
  exit: boolean;
}
export interface ManeuverRoute {
  kind: ManeuverKind; legs: RouteLeg[];
  /** Departure: give-way stop (centre `s` on the last leg) and where the car is aligned on the lane. */
  holdS: number; joinS: number;
  /** Arrival: where the car leaves the lane (first leg). */
  leaveS: number;
  /** Lane coordinate of the junction (merge point). */
  mergeLane: number;
  /** Effective radius of the bay turn; below `minTurn` the route is not drivable. */
  bayTurn: number;
}

const STEP = .25;
const unit = (x: number, z: number): [number, number] => { const l = Math.hypot(x, z) || 1; return [x / l, z / l]; };

/** Lane frame: origin, unit direction, length. */
function laneFrame(lane: Pick<TrafficLane, 'from' | 'to'>) {
  const [dx, dz] = unit(lane.to[0] - lane.from[0], lane.to[1] - lane.from[1]);
  return { ox: lane.from[0], oz: lane.from[1], dx, dz, length: laneLength(lane as TrafficLane) };
}
/** Lane coordinate (along) and unsigned lateral distance of a point. */
type LaneFrame = ReturnType<typeof laneFrame>;
const FRAMES = new Map<Pick<TrafficLane, 'from' | 'to'>, LaneFrame>();
/** Cached lane frame (no allocation per frame). */
function frameOf(lane: Pick<TrafficLane, 'from' | 'to'>): LaneFrame {
  let frame = FRAMES.get(lane);
  if (!frame) FRAMES.set(lane, frame = laneFrame(lane));
  return frame;
}
const laneAlong = (frame: LaneFrame, x: number, z: number) => (x - frame.ox) * frame.dx + (z - frame.oz) * frame.dz;
function laneCoord(frame: LaneFrame, x: number, z: number) {
  const rx = x - frame.ox, rz = z - frame.oz;
  return { along: rx * frame.dx + rz * frame.dz, lateral: Math.abs(rx * frame.dz - rz * frame.dx) };
}

/** Closest point on a polyline: segment index, point and the segment direction. */
function projectPolyline(points: readonly Point[], x: number, z: number) {
  let best = { seg: 0, x: points[0]![0], z: points[0]![1], d: Infinity };
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, az] = points[i]!, [bx, bz] = points[i + 1]!;
    const lx = bx - ax, lz = bz - az, l2 = lx * lx + lz * lz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * lx + (z - az) * lz) / l2));
    const px = ax + lx * t, pz = az + lz * t, d = Math.hypot(x - px, z - pz);
    if (d < best.d) best = { seg: i, x: px, z: pz, d };
  }
  return best;
}

/** Drops repeated and collinear points (keeps the ends). */
function cleanPolyline(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 1e-3) continue;
    out.push(p);
    while (out.length >= 3) {
      const a = out[out.length - 3]!, b = out[out.length - 2]!, c = out[out.length - 1]!;
      const [ux, uz] = unit(b[0] - a[0], b[1] - a[1]), [wx, wz] = unit(c[0] - b[0], c[1] - b[1]);
      if (Math.abs(ux * wz - uz * wx) > 1e-4 || ux * wx + uz * wz < 0) break;
      out.splice(out.length - 2, 1);
    }
  }
  return out;
}

/**
 * Samples a polyline whose interior corners are rounded by circular-arc fillets (cubic Bézier
 * approximations) of the requested radius, bounded by the neighbouring segments (end segments may be
 * consumed whole, shared ones only half). Returns the samples and each corner's effective radius.
 */
export function filletPath(input: Point[], radius: (index: number, point: Point) => number, step = STEP) {
  const points = cleanPolyline(input);
  const xs: number[] = [points[0]![0]], zs: number[] = [points[0]![1]], radii: number[] = [];
  const lineTo = (x: number, z: number) => {
    const x0 = xs[xs.length - 1]!, z0 = zs[zs.length - 1]!, n = Math.ceil(Math.hypot(x - x0, z - z0) / step);
    for (let k = 1; k <= n; k++) { xs.push(x0 + (x - x0) * k / n); zs.push(z0 + (z - z0) * k / n); }
  };
  const last = points.length - 1;
  for (let i = 1; i < last; i++) {
    const p = points[i]!, a = points[i - 1]!, b = points[i + 1]!;
    const [ux, uz] = unit(p[0] - a[0], p[1] - a[1]), [wx, wz] = unit(b[0] - p[0], b[1] - p[1]);
    const theta = Math.acos(Math.max(-1, Math.min(1, ux * wx + uz * wz)));
    const lenIn = Math.hypot(p[0] - a[0], p[1] - a[1]) * (i === 1 ? 1 : .5);
    const lenOut = Math.hypot(b[0] - p[0], b[1] - p[1]) * (i === last - 1 ? 1 : .5);
    const t = Math.min(radius(i, p) * Math.tan(theta / 2), lenIn, lenOut);
    const r = t / Math.tan(theta / 2), h = 4 / 3 * Math.tan(theta / 4) * r;
    radii.push(r);
    const sx = p[0] - ux * t, sz = p[1] - uz * t, ex = p[0] + wx * t, ez = p[1] + wz * t;
    lineTo(sx, sz);
    const c1x = sx + ux * h, c1z = sz + uz * h, c2x = ex - wx * h, c2z = ez - wz * h;
    const n = Math.max(6, Math.ceil(r * theta / step));
    for (let k = 1; k <= n; k++) {
      const q = k / n, m = 1 - q;
      xs.push(m * m * m * sx + 3 * m * m * q * c1x + 3 * m * q * q * c2x + q * q * q * ex);
      zs.push(m * m * m * sz + 3 * m * m * q * c1z + 3 * m * q * q * c2z + q * q * q * ez);
    }
  }
  lineTo(points[last]![0], points[last]![1]);
  return { xs, zs, radii };
}

const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
function makeLeg(xs: number[], zs: number[], gear: 1 | -1, height: (i: number, s: number) => number, zones: (leg: RouteLeg) => SpeedZone[], exit = false): RouteLeg {
  const count = xs.length;
  const leg: RouteLeg = {
    gear, x: Float32Array.from(xs), z: Float32Array.from(zs), y: new Float32Array(count), yaw: new Float32Array(count), s: new Float32Array(count),
    count, length: 0, zones: [], exit,
  };
  for (let i = 1; i < count; i++) leg.s[i] = leg.s[i - 1]! + Math.hypot(xs[i]! - xs[i - 1]!, zs[i]! - zs[i - 1]!);
  leg.length = leg.s[count - 1]!;
  // Tangent heading: mean of the neighbouring chords; at the ends, extrapolated by half the next chord turn.
  const chord = (i: number) => Math.atan2(xs[i + 1]! - xs[i]!, zs[i + 1]! - zs[i]!);
  for (let i = 0; i < count; i++) {
    let motion: number;
    if (count < 3) motion = chord(0);
    else if (i === 0) motion = chord(0) - wrap(chord(1) - chord(0)) / 2;
    else if (i === count - 1) motion = chord(i - 1) + wrap(chord(i - 1) - chord(i - 2)) / 2;
    else motion = chord(i - 1) + wrap(chord(i) - chord(i - 1)) / 2;
    leg.yaw[i] = wrap(gear > 0 ? motion : motion + Math.PI);
    leg.y[i] = height(i, leg.s[i]!);
  }
  leg.zones = zones(leg);
  return leg;
}

/** Index of the last sample at or before `s` (binary search). */
function sampleIndex(leg: RouteLeg, s: number): number {
  let lo = 0, hi = leg.count - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (leg.s[mid]! <= s) lo = mid; else hi = mid; }
  return lo;
}
export interface PathPose { x: number; y: number; z: number; yaw: number }
/** Pose at distance `s` along a leg (interpolated; heading follows the path tangent). */
export function legPose(leg: RouteLeg, s: number, out: PathPose = { x: 0, y: 0, z: 0, yaw: 0 }): PathPose {
  const clamped = Math.max(0, Math.min(leg.length, s));
  const i = sampleIndex(leg, clamped), j = Math.min(leg.count - 1, i + 1);
  const span = leg.s[j]! - leg.s[i]!, t = span > 1e-6 ? (clamped - leg.s[i]!) / span : 0;
  out.x = leg.x[i]! + (leg.x[j]! - leg.x[i]!) * t;
  out.z = leg.z[i]! + (leg.z[j]! - leg.z[i]!) * t;
  out.y = leg.y[i]! + (leg.y[j]! - leg.y[i]!) * t;
  out.yaw = wrap(leg.yaw[i]! + wrap(leg.yaw[j]! - leg.yaw[i]!) * t);
  return out;
}

/** Height along a leg: the drawn surface (lot top, access ramp and crossing) off the lane, the road on it. */
function surfaceHeight(xs: number[], zs: number[], lot: LotInput, lane: TrafficLane) {
  const frame = laneFrame(lane);
  return (i: number) => laneCoord(frame, xs[i]!, zs[i]!).lateral <= LOT_TIMING.roadEdge ? lane.top : parkingSurfaceY(lot, xs[i]!, zs[i]!);
}
/** Intersection of the lines p + s·u and q + t·v (null when parallel). */
function intersect(p: Point, u: Point, q: Point, v: Point): Point | null {
  const det = u[0] * v[1] - u[1] * v[0];
  if (Math.abs(det) < 1e-6) return null;
  const s = ((q[0] - p[0]) * v[1] - (q[1] - p[1]) * v[0]) / det;
  return [p[0] + u[0] * s, p[1] + u[1] * s];
}

/**
 * The route of one manoeuvre. Bays whose parked heading faces the aisle are back-in bays: arrivals
 * pull past the bay and reverse in, departures drive straight out. Nose-in bays: arrivals drive in,
 * departures reverse out. Every bay turn is a quarter arc; the aisle bends, the throat and the lane
 * junction are rounded; the lane portion follows the lane centre.
 */
export function maneuverRoute(lot: LotInput, bayIndex: number, kind: ManeuverKind, lane: TrafficLane, run = 0, half = 2.4): ManeuverRoute {
  const bay = lot.bays[bayIndex]!;
  const aisle = lot.aisle;
  const near = projectPolyline(aisle, bay.x, bay.z);
  const A: Point = [near.x, near.z];
  const k = Math.hypot(A[0] - bay.x, A[1] - bay.z);
  const [fx, fz] = unit(A[0] - bay.x, A[1] - bay.z);
  const facesAisle = Math.sin(bay.yaw) * fx + Math.cos(bay.yaw) * fz > 0;
  const throat = lot.entry.throat as Point;
  const first = aisle[0]!, end = aisle[aisle.length - 1]!;
  const throatAtEnd = Math.hypot(end[0] - throat[0], end[1] - throat[1]) <= Math.hypot(first[0] - throat[0], first[1] - throat[1]);
  // Aisle vertices from the bay's projection to the throat end, and the room beyond it the other way.
  const toThroat: Point[] = throatAtEnd ? aisle.slice(near.seg + 1) : aisle.slice(0, near.seg + 1).reverse();
  const awayEnd = throatAtEnd ? first : end;
  const [tx, tz] = unit(toThroat[0]![0] - A[0], toThroat[0]![1] - A[1]);
  // Room to pull past the bay (or swing out of it) away from the throat: up to the aisle end, and the
  // car body no further than `rowOverrun` past the end of the bay row (the court's kerb lies just beyond).
  let rowEnd = 0;
  for (const other of lot.bays) rowEnd = Math.max(rowEnd, (other.x - A[0]) * -tx + (other.z - A[1]) * -tz + LOT_TIMING.bayHalfWidth);
  const room = Math.min(Math.hypot(awayEnd[0] - A[0], awayEnd[1] - A[1]), rowEnd + LOT_TIMING.rowOverrun - half);
  // Quarter turn of radius k - run: the car first runs straight out of (or last straight into) the bay.
  const turn = Math.max(.5, k - run);
  const pull = Math.min(turn, room);
  const P: Point = [A[0] - tx * pull, A[1] - tz * pull];
  // Junction: the lane point opposite the entry (`from` lies on the lane centre).
  const frame = laneFrame(lane);
  const entryFrom = lot.entry.from as Point;
  const along = Math.max(0, Math.min(frame.length, laneCoord(frame, entryFrom[0], entryFrom[1]).along));
  const M: Point = [frame.ox + frame.dx * along, frame.oz + frame.dz * along];
  // Access drive: keep left. The exit lane lies left of the outward direction, the entry lane right of it.
  const out = unit(M[0] - throat[0], M[1] - throat[1]);
  const left: Point = [out[1], -out[0]];
  const accessSide = (sign: 1 | -1) => {
    const offset: Point = [throat[0] + left[0] * LOT_TIMING.accessLane * sign, throat[1] + left[1] * LOT_TIMING.accessLane * sign];
    // Aisle vertices up to the access line, then the corner where the aisle meets this access lane.
    const onAccess = (p: Point) => Math.abs((p[0] - throat[0]) * out[1] - (p[1] - throat[1]) * out[0]) < .3;
    const kept = toThroat.slice(0, Math.max(0, toThroat.findIndex(onAccess) < 0 ? toThroat.length : toThroat.findIndex(onAccess)));
    const last = kept[kept.length - 1] ?? A, before = kept.length > 1 ? kept[kept.length - 2]! : A;
    const along = unit(last[0] - before[0], last[1] - before[1]), junction = intersect(offset, out, M, [frame.dx, frame.dz]) ?? M;
    // This direction's lane on the aisle's side of the access: turn straight into it. On the far side,
    // turn onto the access centre line (the apron's widest part) and ease over to the lane past the throat.
    if ((offset[0] - throat[0]) * -along[0] + (offset[1] - throat[1]) * -along[1] > 0) {
      return [...kept.slice(0, -1), intersect(last, along, offset, out) ?? last, junction];
    }
    const shift: Point = [offset[0] + out[0] * LOT_TIMING.laneShift, offset[1] + out[1] * LOT_TIMING.laneShift];
    return [...kept.slice(0, -1), intersect(last, along, throat, out) ?? last, shift, junction];
  };
  const laneEnd: Point = [lane.to[0], lane.to[1]], laneStart: Point = [lane.from[0], lane.from[1]];
  const junctions = [accessSide(1).at(-1)!, accessSide(-1).at(-1)!];
  const radius = (bayCorner: Point, turn: number) => (_: number, p: Point) =>
    Math.hypot(p[0] - bayCorner[0], p[1] - bayCorner[1]) < 1e-3 ? turn
      : junctions.some(j => Math.hypot(p[0] - j[0], p[1] - j[1]) < 1e-3) ? LOT_TIMING.junctionTurn : LOT_TIMING.aisleTurn;
  const B: Point = [bay.x, bay.z];
  const lot2road: Point[] = [...accessSide(1), laneEnd];
  const road2lot: Point[] = [laneStart, ...accessSide(-1).reverse()];
  const legs: RouteLeg[] = [];
  let bayTurn = turn;
  // Slow through the bay turn: straight run plus a quarter arc, and a little margin.
  const bayRun = run + turn * Math.PI / 2 + .5;
  const reverseZones = () => [{ s: 0, v: LOT_TIMING.reverseSpeed }];
  const intoBay = (zones: SpeedZone[], made: RouteLeg) => [...zones, { s: Math.max(0, made.length - bayRun - 1), v: LOT_TIMING.bayTurnSpeed }];
  const route: ManeuverRoute = { kind, legs, holdS: -1, joinS: -1, leaveS: -1, mergeLane: along, bayTurn };
  const leg = (points: Point[], gear: 1 | -1, zones: (leg: RouteLeg) => SpeedZone[], turn: number, exit = false) => {
    const { xs, zs, radii } = filletPath(points, radius(A, turn));
    const bend = radii[cleanPolyline(points).findIndex(p => Math.hypot(p[0] - A[0], p[1] - A[1]) < 1e-3) - 1];
    if (bend !== undefined) bayTurn = Math.min(bayTurn, bend);
    const made = makeLeg(xs, zs, gear, surfaceHeight(xs, zs, lot, lane), zones, exit);
    legs.push(made);
    return made;
  };
  // Departure road leg: lot speed to the give-way line, turning speed through the junction, lane speed once aligned.
  const departZones = (made: RouteLeg) => {
    const { hold, join } = departMarks(made, frame);
    route.holdS = hold; route.joinS = join;
    const zones = [{ s: 0, v: LOT_TIMING.lotSpeed }, { s: hold, v: LOT_TIMING.turnSpeed }, { s: join, v: lane.speed }];
    return made.gear > 0 && facesAisle ? [{ s: 0, v: LOT_TIMING.bayTurnSpeed }, { s: Math.min(hold, bayRun), v: LOT_TIMING.lotSpeed }, ...zones.slice(1)] : zones;
  };
  const arriveZones = (made: RouteLeg) => {
    const leave = arriveMark(made, frame);
    route.leaveS = leave;
    let throatS = leave;
    for (let i = 0, best = Infinity; i < made.count; i++) {
      const d = Math.hypot(made.x[i]! - throat[0], made.z[i]! - throat[1]);
      if (d < best) { best = d; throatS = made.s[i]!; }
    }
    const zones = [{ s: 0, v: lane.speed }, { s: leave, v: LOT_TIMING.turnSpeed }, { s: Math.max(leave, throatS), v: LOT_TIMING.lotSpeed }];
    return facesAisle ? zones : intoBay(zones, made);
  };
  if (kind === 'depart') {
    if (facesAisle) leg([B, A, ...lot2road], 1, departZones, turn, true);
    else {
      leg([B, A, P], -1, reverseZones, turn);
      leg([P, A, ...lot2road], 1, departZones, turn, true);
    }
  } else if (facesAisle) {
    leg([...road2lot, A, P], 1, arriveZones, turn);
    leg([P, A, B], -1, reverseZones, turn);
  } else leg([...road2lot, A, B], 1, arriveZones, turn);
  route.bayTurn = bayTurn;
  return route;
}

/** Departure leg marks: the give-way stop (front bumper short of the carriageway edge) and lane alignment. */
function departMarks(leg: RouteLeg, frame: ReturnType<typeof laneFrame>) {
  let hold = -1, join = leg.length;
  const reach = 2.4; // representative half length: the stop is re-derived per car (see `holdFor`)
  for (let i = 0; i < leg.count; i++) {
    const yaw = leg.yaw[i]!, fx = leg.x[i]! + Math.sin(yaw) * reach, fz = leg.z[i]! + Math.cos(yaw) * reach;
    if (hold < 0 && laneCoord(frame, fx, fz).lateral <= LOT_TIMING.roadEdge + LOT_TIMING.giveWay) hold = leg.s[i]!;
    const aligned = Math.sin(yaw) * frame.dx + Math.cos(yaw) * frame.dz > .995;
    if (hold >= 0 && aligned && laneCoord(frame, leg.x[i]!, leg.z[i]!).lateral < .2) { join = leg.s[i]!; break; }
  }
  return { hold: Math.max(0, hold), join };
}
/** Arrival leg mark: where the car leaves the lane centre to turn in. */
function arriveMark(leg: RouteLeg, frame: ReturnType<typeof laneFrame>) {
  for (let i = 0; i < leg.count; i++) {
    const yaw = leg.yaw[i]!;
    const aligned = Math.sin(yaw) * frame.dx + Math.cos(yaw) * frame.dz > .995;
    if (!aligned || laneCoord(frame, leg.x[i]!, leg.z[i]!).lateral > .2) return leg.s[Math.max(0, i - 1)]!;
  }
  return leg.length;
}
/** Give-way stop for a car of `half` length: its front bumper `giveWay` short of the carriageway edge. */
export function holdFor(route: ManeuverRoute, lane: TrafficLane, half: number): number {
  const leg = route.legs[route.legs.length - 1]!, frame = frameOf(lane);
  const limit = LOT_TIMING.roadEdge + LOT_TIMING.giveWay;
  let previous = Infinity;
  for (let i = 0; i < leg.count; i++) {
    const yaw = leg.yaw[i]!, fx = leg.x[i]! + Math.sin(yaw) * half, fz = leg.z[i]! + Math.cos(yaw) * half;
    const lateral = laneCoord(frame, fx, fz).lateral;
    if (lateral <= limit) {
      // Interpolate between samples so a coarse step never puts the bumper past the line.
      if (i === 0 || !Number.isFinite(previous) || previous <= lateral) return leg.s[i]!;
      const t = (previous - limit) / (previous - lateral);
      return leg.s[i - 1]! + (leg.s[i]! - leg.s[i - 1]!) * t;
    }
    previous = lateral;
  }
  return route.holdS;
}

// ---------------------------------------------------------------------------------------------
// Clearance
// ---------------------------------------------------------------------------------------------

/** Car footprint: centre, heading, half length and half width (metres). */
export interface Footprint { x: number; z: number; yaw: number; half: number; halfWidth: number }
/** Separating-axis test for two oriented rectangles, grown by `margin` each. */
export function footprintsOverlap(a: Footprint, b: Footprint, margin = 0): boolean {
  const axes = [a.yaw, a.yaw + Math.PI / 2, b.yaw, b.yaw + Math.PI / 2];
  const dx = b.x - a.x, dz = b.z - a.z;
  for (const angle of axes) {
    const ax = Math.sin(angle), az = Math.cos(angle);
    const project = (f: Footprint) => {
      const fx = Math.sin(f.yaw), fz = Math.cos(f.yaw);
      return (f.half + margin) * Math.abs(fx * ax + fz * az) + (f.halfWidth + margin) * Math.abs(fz * ax - fx * az);
    };
    if (Math.abs(dx * ax + dz * az) > project(a) + project(b)) return false;
  }
  return true;
}
const FOOTPRINTS = new Map<MobilityModel, Readonly<{ half: number; halfWidth: number }>>();
export function footprintOf(model: MobilityModel): Readonly<{ half: number; halfWidth: number }> {
  let size = FOOTPRINTS.get(model);
  if (!size) {
    const spec = isMobilityVehicle(model) ? VEHICLE_SPECS[model] : undefined;
    FOOTPRINTS.set(model, size = Object.freeze({ half: (spec?.length ?? 4.6) / 2, halfWidth: (spec?.width ?? 2) / 2 }));
  }
  return size;
}
/**
 * True when the car (`half`/`halfWidth`) can follow `route` without touching any parked footprint
 * (only obstacles within reach of the samples are tested).
 */
export function routeClear(route: ManeuverRoute, size: { half: number; halfWidth: number }, parked: readonly Footprint[], margin: number = LOT_TIMING.clearance): boolean {
  const car: Footprint = { x: 0, y: 0, z: 0, yaw: 0, ...size } as Footprint;
  const reach = size.half + 4;
  for (const leg of route.legs) for (let i = 0; i < leg.count; i += 2) {
    car.x = leg.x[i]!; car.z = leg.z[i]!; car.yaw = leg.yaw[i]!;
    for (const other of parked) {
      if (Math.abs(other.x - car.x) > reach || Math.abs(other.z - car.z) > reach) continue;
      if (footprintsOverlap(car, other, margin / 2)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Lamps
// ---------------------------------------------------------------------------------------------

export interface ManeuverLamps { on: boolean; brake: boolean; reverse: boolean }
/**
 * Lamp timeline of a lot car (scaled by the shared night/override lamp power): head and tail lamps
 * come on at engine start (`starting`, with the foot on the brake) at least `engineStart` seconds
 * before the car moves, stay on while it moves (brake lamps while slowing or held, the white
 * reverse lamp while in reverse), and after parking the brake lamps flash twice and every lamp
 * goes off `lightsOff` seconds later. Parked cars are dark.
 */
export function maneuverLamps(phase: ManeuverPhase, phaseTime: number, braking: boolean, out: ManeuverLamps = { on: false, brake: false, reverse: false }): ManeuverLamps {
  out.on = phase !== 'parked' && !(phase === 'parking' && phaseTime >= LOT_TIMING.lightsOff);
  out.reverse = out.on && phase === 'reversing';
  let flash = false;
  for (const [from, to] of LOT_TIMING.flash) if (phaseTime >= from && phaseTime < to) flash = true;
  out.brake = out.on && (phase === 'starting' || (phase === 'parking' ? flash : braking));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Schedule and simulation
// ---------------------------------------------------------------------------------------------

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}
const between = (range: readonly [number, number], u: number) => range[0] + (range[1] - range[0]) * u;

/** Seconds to the next manoeuvre: 20–60 s, shorter as the shared local-time traffic density rises. */
export function maneuverInterval(density: number, u: number): number {
  const calm = Math.max(0, Math.min(1, 1 - density));
  return between(LOT_TIMING.interval, Math.max(0, Math.min(1, calm * (.55 + .9 * u) + .12 * u)));
}
/** Share of arrivals by local time: mostly arrivals in the morning, mostly departures in the evening. */
export function arrivalShare(minutes: number): number {
  const hour = (((minutes % 1440) + 1440) % 1440) / 60;
  if (hour >= 6 && hour < 10.5) return .8;
  if (hour >= 16 && hour < 20) return .2;
  return .5;
}
/** Occupancy bounds (cars) for a lot of `bays`: never empty, never full. */
export function occupancyBounds(bays: number): [number, number] {
  return [Math.max(2, Math.round(bays * LOT_TIMING.occupancy[0])), Math.min(bays - 2, Math.round(bays * LOT_TIMING.occupancy[1]))];
}
/** Concurrent manoeuvres per lot for a render tier (fewer on the lowest tiers). */
export function lotManeuverCap(trafficCars: number): number { return trafficCars >= 10 ? 2 : 1; }
export const MAX_LOT_MANEUVERS = 2;

export interface ManeuverPose extends TrafficCarPose {
  lot: number; bay: number; kind: ManeuverKind; phase: ManeuverPhase;
  /** Lamp state (1 = lamps on); `stopped` doubles as the brake lamp flag. */
  lit: number; reverse: boolean; waiting: boolean; speed: number;
  /** Ground height under the car (decals) and the lane index while the car is on its lane, else -1. */
  top: number; onLane: number;
}
const createManeuverPose = (): ManeuverPose => ({ ...createTrafficPose(), lot: 0, bay: -1, kind: 'depart', phase: 'parked', lit: 0, reverse: false, waiting: false, speed: 0, top: 0, onLane: -1 });

export interface Maneuver {
  active: boolean; kind: ManeuverKind; bay: number; model: MobilityModel; tone: string; half: number; halfWidth: number;
  route: ManeuverRoute | null; leg: number; s: number; v: number; hold: number;
  phase: ManeuverPhase; phaseTime: number; pause: number; braking: boolean; cleared: boolean; crossed: boolean; crossWait: number;
  pose: ManeuverPose; lamps: ManeuverLamps;
}
export interface ManeuverEvent { t: number; lot: string; kind: ManeuverKind; bay: string; model: MobilityModel; started: boolean }
export interface LotState {
  lot: LotInput; index: number; laneIndex: number; lane: TrafficLane;
  rng: () => number; next: number; lastDecision: number;
  pending: { kind: ManeuverKind; pick: number; model: number; tone: number; interval: number } | null;
  models: (MobilityModel | null)[]; tones: string[]; reserved: Uint8Array;
  corridor: number; serial: number; maneuvers: Maneuver[];
}
export interface ParkingSim {
  seed: number; seconds: number; lots: LotState[];
  /** Bumped whenever the set of parked or manoeuvring cars changes (renderers re-pack their instances). */
  version: number;
  styles: readonly CatalogVehicle[]; capacity: Map<MobilityModel, number>; counts: Map<MobilityModel, number>;
  log: ManeuverEvent[];
}
export const LOT_TONES = ['#a3bec5', '#e5e1d7', '#507b88', '#9c6552', '#747a86', '#2f3a40', '#c6c2b6'] as const;

/** Parked vehicles no lot bay claims (kept as static instances by the renderer). */
export function unmanagedParked(lots: readonly LotInput[] = MANEUVER_LOTS, parked: readonly ParkedVehicle[] = PARKED_VEHICLES): ParkedVehicle[] {
  return parked.filter(car => !lots.some(lot => lot.bays.some(bay => bay.id === car.id || Math.hypot(bay.x - car.x, bay.z - car.z) < .5)));
}

/** Instance capacity per model across the lots: today's parked cars plus a few arrivals of each style. */
export function lotModelCapacity(parked: readonly Pick<ParkedVehicle, 'model'>[] = PARKED_VEHICLES, styles: readonly CatalogVehicle[] = DAILY_CATALOG): Map<MobilityModel, number> {
  const capacity = new Map<MobilityModel, number>();
  for (const vehicle of styles) if (!vehicle.trafficOnly) capacity.set(vehicle.model, LOT_TIMING.extraPerModel);
  for (const car of parked) if (isMobilityVehicle(car.model)) capacity.set(car.model, (capacity.get(car.model) ?? 0) + 1);
  return capacity;
}

export function createParkingSim(seed: number, lots: readonly LotInput[] = MANEUVER_LOTS, parked: readonly ParkedVehicle[] = PARKED_VEHICLES,
  styles: readonly CatalogVehicle[] = DAILY_CATALOG, lanes: readonly TrafficLane[] = TRAFFIC_LANES): ParkingSim {
  const counts = new Map<MobilityModel, number>();
  const states = lots.map((lot, index): LotState => {
    const laneIndex = lanes.findIndex(lane => lane.id === lot.laneId);
    const rng = random((seed ^ hashString(`lot:${lot.id}`)) >>> 0);
    const models: (MobilityModel | null)[] = lot.bays.map(() => null), tones = lot.bays.map(() => LOT_TONES[0] as string);
    for (const car of parked) {
      if (!isMobilityVehicle(car.model)) continue;
      let bay = lot.bays.findIndex(b => b.id === car.id);
      if (bay < 0) bay = lot.bays.findIndex(b => Math.hypot(b.x - car.x, b.z - car.z) < .5);
      if (bay < 0 || models[bay]) continue;
      models[bay] = car.model; tones[bay] = car.tone;
      counts.set(car.model, (counts.get(car.model) ?? 0) + 1);
    }
    const first = between(LOT_TIMING.first, rng());
    return {
      lot, index, laneIndex, lane: lanes[Math.max(0, laneIndex)]!, rng, next: first, lastDecision: -Infinity, pending: null,
      models, tones, reserved: new Uint8Array(lot.bays.length), corridor: -1, serial: 0,
      maneuvers: Array.from({ length: MAX_LOT_MANEUVERS }, () => ({
        active: false, kind: 'depart' as ManeuverKind, bay: -1, model: 'mobility-sedan' as MobilityModel, tone: '#ffffff', half: 2.3, halfWidth: 1,
        route: null, leg: 0, s: 0, v: 0, hold: -1, phase: 'parked' as ManeuverPhase, phaseTime: 0, pause: 0, braking: false, cleared: false, crossed: false, crossWait: 0,
        pose: createManeuverPose(), lamps: { on: false, brake: false, reverse: false },
      })),
    };
  });
  return { seed, seconds: 0, lots: states, version: 0, styles, capacity: lotModelCapacity(parked, styles), counts, log: [] };
}

/** Traffic seen by the lots: the live poses plus the schedule for cars about to enter a lane. */
export interface TrafficContext {
  poses: readonly TrafficCarPose[]; count: number;
  schedules?: readonly LaneSchedule[]; admitted?: readonly Uint8Array[]; seconds: number; density: number;
}
export interface ParkingStepOptions { minutes: number; density: number; cap: number; reducedMotion: boolean; traffic: TrafficContext }

const occupiedCount = (state: LotState) => {
  let count = 0;
  for (const model of state.models) if (model) count++;
  for (const m of state.maneuvers) if (m.active) count += m.kind === 'arrive' ? 1 : -1;
  return count;
};
const activeCount = (state: LotState) => { let n = 0; for (const m of state.maneuvers) if (m.active) n++; return n; };
function parkedFootprints(state: LotState, except: number): Footprint[] {
  const out: Footprint[] = [];
  state.lot.bays.forEach((bay, index) => {
    const model = state.models[index];
    if (!model || index === except) return;
    out.push({ x: bay.x, z: bay.z, yaw: bay.yaw, ...footprintOf(model) });
  });
  // Arrivals already heading for a bay count as parked there.
  for (const m of state.maneuvers) if (m.active && m.kind === 'arrive' && m.bay !== except) {
    const bay = state.lot.bays[m.bay]!;
    out.push({ x: bay.x, z: bay.z, yaw: bay.yaw, half: m.half, halfWidth: m.halfWidth });
  }
  return out;
}

/**
 * Lane occupancy test: true when no live car (traffic or another lot car) and no scheduled car
 * about to enter the lane is within [`behind`, `ahead`] metres of lane position `at`.
 */
export function laneGapClear(sim: ParkingSim, laneIndex: number, lane: TrafficLane, at: number, behind: number, ahead: number, traffic: TrafficContext, self?: ManeuverPose): boolean {
  const from = at - behind, to = at + ahead, frame = frameOf(lane);
  for (let i = 0; i < traffic.count; i++) {
    const pose = traffic.poses[i]!;
    if (pose.visible && pose.lane === laneIndex && pose.distance > from && pose.distance < to) return false;
  }
  for (const state of sim.lots) for (const m of state.maneuvers) {
    if (!m.active || m.pose === self || m.pose.onLane !== laneIndex) continue;
    const along = laneAlong(frame, m.pose.x, m.pose.z);
    if (along > from && along < to) return false;
  }
  const schedule = traffic.schedules?.[laneIndex];
  if (schedule) {
    // Cars about to depart from the lane start sit at negative positions (their distance to go at lane speed).
    const local = ((traffic.seconds + schedule.phase) % schedule.cycle + schedule.cycle) % schedule.cycle;
    const horizon = (behind - at) / lane.speed;
    const admitted = traffic.admitted?.[laneIndex];
    if (horizon > 0) for (let i = 0; i < schedule.cars.length; i++) {
      const car = schedule.cars[i]!;
      if ((admitted && !admitted[i]) || !carActive(car, traffic.density)) continue;
      for (let wrap = 0; wrap < 2; wrap++) {
        const wait = car.depart + wrap * schedule.cycle - local, position = -wait * lane.speed;
        if (wait > 0 && wait <= horizon && position > from && position < to) return false;
      }
    }
  }
  return true;
}

function pickModel(sim: ParkingSim, ev: boolean, u: number): MobilityModel | null {
  const pool = sim.styles.filter(vehicle => !vehicle.trafficOnly && (!ev || vehicle.category === 'ev'));
  if (!pool.length) return null;
  const total = pool.reduce((sum, vehicle) => sum + vehicle.weight, 0);
  let left = u * total, start = pool.length - 1;
  for (let i = 0; i < pool.length; i++) { left -= pool[i]!.weight; if (left < 0) { start = i; break; } }
  for (let k = 0; k < pool.length; k++) {
    const model = pool[(start + k) % pool.length]!.model;
    if ((sim.counts.get(model) ?? 0) < (sim.capacity.get(model) ?? 0)) return model;
  }
  return null;
}

function beginManeuver(sim: ParkingSim, state: LotState, kind: ManeuverKind, bay: number, model: MobilityModel, tone: string, route: ManeuverRoute): Maneuver | null {
  const slot = state.maneuvers.findIndex(m => !m.active);
  if (slot < 0) return null;
  const m = state.maneuvers[slot]!;
  const size = footprintOf(model);
  Object.assign(m, {
    active: true, kind, bay, model, tone, half: size.half, halfWidth: size.halfWidth, route, leg: 0, s: 0, v: 0,
    hold: kind === 'depart' ? holdFor(route, state.lane, size.half) : -1,
    phase: kind === 'depart' ? 'starting' : 'arriving', phaseTime: 0, pause: 0, braking: false, cleared: false, crossed: false, crossWait: 0,
  });
  if (kind === 'arrive') {
    m.v = state.lane.speed;
    state.corridor = slot;
    sim.counts.set(model, (sim.counts.get(model) ?? 0) + 1);
  }
  state.reserved[bay] = 1;
  m.pose.onLane = -1; m.pose.distance = 0;
  state.serial = (state.serial + 1) % 100_000;
  m.pose.id = 1_000_000 + state.index * 100_000 + state.serial;
  sim.version++;
  return m;
}

/** The widest drivable route for this car that clears every parked car, or null. */
export function clearRoute(state: Pick<LotState, 'lot' | 'lane'> & Partial<LotState>, bay: number, kind: ManeuverKind, model: MobilityModel, parked?: readonly Footprint[]): ManeuverRoute | null {
  const others = parked ?? parkedFootprints(state as LotState, bay), size = footprintOf(model);
  for (const run of LOT_TIMING.runs) {
    const route = maneuverRoute(state.lot, bay, kind, state.lane, run, size.half);
    if (route.bayTurn >= LOT_TIMING.minTurn - 1e-6 && routeClear(route, size, others)) return route;
  }
  return null;
}

/** Starts a departure from `bay` (or the `pick`-th eligible bay); false when none can leave now. */
function tryDepart(sim: ParkingSim, state: LotState, pick: number, bayId?: string): boolean {
  const eligible: number[] = [];
  state.lot.bays.forEach((bay, index) => { if (state.models[index] && !state.reserved[index] && (!bayId || bay.id === bayId)) eligible.push(index); });
  for (let k = 0; k < eligible.length; k++) {
    const bay = eligible[(Math.floor(pick * eligible.length) + k) % eligible.length]!;
    const model = state.models[bay]!;
    const route = clearRoute(state, bay, 'depart', model);
    if (route) return !!beginManeuver(sim, state, 'depart', bay, model, state.tones[bay]!, route);
  }
  return false;
}
/** Starts an arrival into a free bay (EV bays only for electric styles); false when none fits now. */
function tryArrive(sim: ParkingSim, state: LotState, pick: number, modelU: number, tone: string, traffic: TrafficContext, bayId?: string, force = false): boolean {
  if (state.corridor >= 0 || state.laneIndex < 0) return false;
  if (!force && !laneGapClear(sim, state.laneIndex, state.lane, 0, state.lane.speed * LOT_TIMING.arrivalLead, LOT_TIMING.arrivalAhead, traffic)) return false;
  const free: number[] = [];
  state.lot.bays.forEach((bay, index) => { if (!state.models[index] && !state.reserved[index] && (!bayId || bay.id === bayId)) free.push(index); });
  for (let k = 0; k < free.length; k++) {
    const bay = free[(Math.floor(pick * free.length) + k) % free.length]!;
    const model = pickModel(sim, state.lot.bays[bay]!.ev, modelU);
    if (!model) continue;
    const route = clearRoute(state, bay, 'arrive', model);
    if (route) return !!beginManeuver(sim, state, 'arrive', bay, model, tone, route);
  }
  return false;
}

/** Development and tests: start a departure or an arrival now (ignores the schedule and the cap, keeps the rules). */
export function triggerManeuver(sim: ParkingSim, lotId: string, kind: ManeuverKind, bayId?: string, traffic?: TrafficContext): boolean {
  const state = sim.lots.find(lot => lot.lot.id === lotId) ?? sim.lots[0];
  if (!state) return false;
  const context = traffic ?? { poses: [], count: 0, seconds: 0, density: 0 };
  return kind === 'depart' ? tryDepart(sim, state, 0, bayId) : tryArrive(sim, state, 0, .3, LOT_TONES[state.serial % LOT_TONES.length]!, context, bayId, true);
}

function finish(sim: ParkingSim, state: LotState, m: Maneuver) {
  const slot = state.maneuvers.indexOf(m);
  if (state.corridor === slot) state.corridor = -1;
  state.reserved[m.bay] = 0;
  if (m.kind === 'depart') {
    state.models[m.bay] = null;
    sim.counts.set(m.model, Math.max(0, (sim.counts.get(m.model) ?? 0) - 1));
  } else { state.models[m.bay] = m.model; state.tones[m.bay] = m.tone; }
  m.active = false; m.phase = 'parked'; m.route = null; m.pose.visible = false; m.pose.lit = 0; m.pose.onLane = -1;
  sim.version++;
}

/** Abandons a departure that can no longer leave (lamps off, the car stays parked). */
function cancel(sim: ParkingSim, state: LotState, m: Maneuver) {
  const slot = state.maneuvers.indexOf(m);
  if (state.corridor === slot) state.corridor = -1;
  state.reserved[m.bay] = 0;
  m.active = false; m.phase = 'parked'; m.route = null; m.pose.visible = false; m.pose.lit = 0; m.pose.onLane = -1;
  sim.version++;
}

const scratchPose: PathPose = { x: 0, y: 0, z: 0, yaw: 0 };
function advance(sim: ParkingSim, state: LotState, m: Maneuver, dt: number, traffic: TrafficContext) {
  const slot = state.maneuvers.indexOf(m);
  m.phaseTime += dt;
  const route = m.route!;
  if (m.phase === 'starting') {
    m.braking = true;
    if (m.phaseTime >= LOT_TIMING.engineStart && (state.corridor < 0 || state.corridor === slot)) {
      // Re-check the way out against the cars parked meanwhile.
      if (!routeClear(route, m, parkedFootprints(state, m.bay))) { if (m.phaseTime > 30) cancel(sim, state, m); return; }
      state.corridor = slot;
      m.phase = route.legs[0]!.gear < 0 ? 'reversing' : 'driving'; m.phaseTime = 0;
    }
    return;
  }
  if (m.phase === 'parking') {
    m.braking = false;
    if (m.phaseTime >= LOT_TIMING.lightsOff) finish(sim, state, m);
    return;
  }
  if (m.pause > 0) { m.pause = Math.max(0, m.pause - dt); m.v = 0; m.braking = true; return; }
  const leg = route.legs[m.leg]!;
  const last = m.leg === route.legs.length - 1;
  const decel = LOT_TIMING.decel;
  let allowed = Infinity;
  for (const zone of leg.zones) {
    if (zone.s <= m.s) allowed = zone.v;
    else allowed = Math.min(allowed, Math.sqrt(zone.v * zone.v + 2 * decel * (zone.s - m.s)));
  }
  if (!leg.exit) allowed = Math.min(allowed, Math.sqrt(2 * decel * Math.max(0, leg.length - m.s)));
  // Give way at the lot exit until the lane is clear behind and ahead of the junction.
  const lane = state.lane, frame = frameOf(lane);
  if (m.kind === 'depart' && last && m.hold >= 0 && !m.cleared && m.s >= m.hold - LOT_TIMING.holdLook) {
    m.cleared = laneGapClear(sim, state.laneIndex, lane, route.mergeLane, LOT_TIMING.mergeBehind, LOT_TIMING.mergeAhead, traffic, m.pose);
    if (!m.cleared) allowed = Math.min(allowed, Math.sqrt(2 * decel * Math.max(0, m.hold - m.s)));
  }
  // On the lane: follow the car ahead and stop at a zebra crossing like through traffic.
  const onLane = m.kind === 'depart' ? last && m.s >= route.joinS : m.leg === 0 && m.s < route.leaveS;
  m.pose.onLane = onLane ? state.laneIndex : -1;
  if (onLane) {
    const mine = laneAlong(frame, m.pose.x, m.pose.z);
    let gap = Infinity;
    for (let i = 0; i < traffic.count; i++) {
      const pose = traffic.poses[i]!;
      if (!pose.visible || pose.lane !== state.laneIndex || pose.distance <= mine) continue;
      gap = Math.min(gap, pose.distance - mine - m.half - (footprintOf(pose.model).half) - TRAFFIC_TIMING.clearance);
    }
    for (const other of sim.lots) for (const o of other.maneuvers) {
      if (!o.active || o === m || o.pose.onLane !== state.laneIndex) continue;
      const along = laneAlong(frame, o.pose.x, o.pose.z);
      if (along > mine) gap = Math.min(gap, along - mine - m.half - o.half - TRAFFIC_TIMING.clearance);
    }
    if (lane.crossing && !m.crossed) {
      const stop = frame.length / 2 - TRAFFIC_TIMING.stopLine - m.half;
      if (mine > stop + .5) m.crossed = true;
      else {
        gap = Math.min(gap, stop - mine);
        if (stop - mine < .3 && m.v < .05) { m.crossWait += dt; if (m.crossWait >= TRAFFIC_TIMING.wait) m.crossed = true; }
      }
    }
    if (gap < Infinity) allowed = Math.min(allowed, Math.sqrt(2 * decel * Math.max(0, gap)));
  }
  const accel = allowed > LOT_TIMING.turnSpeed + .1 ? LOT_TIMING.laneAccel : LOT_TIMING.accel;
  const previous = m.v;
  m.v = m.v < allowed ? Math.min(allowed, m.v + accel * dt) : allowed;
  m.braking = m.v < previous - 1e-4 || m.v < .05;
  m.s = Math.min(leg.length, m.s + m.v * dt);
  m.pose.distance += leg.gear * m.v * dt;
  if (m.kind === 'depart' && last) {
    m.phase = m.s >= m.hold - LOT_TIMING.holdLook && (m.s < route.joinS || m.v < lane.speed * .9) ? 'merging' : 'driving';
  }
  if (leg.length - m.s < .02) {
    m.s = leg.length;
    if (leg.exit) { finish(sim, state, m); return; }
    if (!last) {
      m.leg++; m.s = 0; m.v = 0; m.pause = LOT_TIMING.gearPause; m.braking = true;
      m.phase = route.legs[m.leg]!.gear < 0 ? 'reversing' : m.kind === 'arrive' ? 'arriving' : 'driving';
      m.phaseTime = 0;
      return;
    }
    // Arrival in the bay: release the aisle, flash the brake lamps, lights off a second later.
    m.v = 0; m.phase = 'parking'; m.phaseTime = 0;
    if (state.corridor === slot) state.corridor = -1;
  }
}

function writePose(state: LotState, m: Maneuver) {
  const pose = m.pose, route = m.route;
  if (!m.active || !route) { pose.visible = false; pose.lit = 0; return; }
  const leg = route.legs[Math.min(m.leg, route.legs.length - 1)]!;
  legPose(leg, m.s, scratchPose);
  pose.lane = state.laneIndex; pose.model = m.model; pose.tone = m.tone;
  pose.x = scratchPose.x; pose.y = scratchPose.y + .015; pose.z = scratchPose.z; pose.yaw = scratchPose.yaw; pose.top = scratchPose.y;
  pose.lot = state.index; pose.bay = m.bay; pose.kind = m.kind; pose.phase = m.phase; pose.speed = m.v * leg.gear;
  maneuverLamps(m.phase, m.phaseTime, m.braking || m.pause > 0, m.lamps);
  pose.lit = m.lamps.on ? 1 : 0; pose.stopped = m.lamps.brake; pose.reverse = m.lamps.reverse;
  pose.waiting = m.kind === 'depart' && !m.cleared && m.v < .05 && m.phase === 'merging';
  pose.visible = true;
}

/** Completes every manoeuvre at once (reduced motion): departing cars are gone, arriving ones parked. */
function settle(sim: ParkingSim, state: LotState) {
  for (const m of state.maneuvers) if (m.active) finish(sim, state, m);
}
/** Development: settle every lot (as under reduced motion) before a scripted capture. */
export function settleParking(sim: ParkingSim): void { for (const state of sim.lots) settle(sim, state); }

/**
 * Advances every lot by `dt` seconds: schedule decisions (deterministic from the seed, the lot id
 * and the inputs), manoeuvre motion, give-way and lamp states. No allocation per call except when a
 * manoeuvre starts (its route). Reduced motion settles and suppresses all manoeuvres.
 */
export function stepParking(sim: ParkingSim, dt: number, options: ParkingStepOptions): void {
  const step = Math.max(0, dt);
  sim.seconds += step;
  for (const state of sim.lots) {
    if (options.reducedMotion) { settle(sim, state); continue; }
    if (state.laneIndex < 0) continue;
    if (step > 0 && sim.seconds >= state.next) decide(sim, state, options);
    for (const m of state.maneuvers) if (m.active && step > 0) advance(sim, state, m, step, options.traffic);
    for (const m of state.maneuvers) writePose(state, m);
  }
}

function decide(sim: ParkingSim, state: LotState, options: ParkingStepOptions) {
  if (!state.pending) {
    const interval = state.rng(), kindU = state.rng(), pick = state.rng(), model = state.rng(), tone = state.rng();
    const [min, max] = occupancyBounds(state.lot.bays.length), occupied = occupiedCount(state);
    const kind: ManeuverKind = occupied <= min ? 'arrive' : occupied >= max ? 'depart' : kindU < arrivalShare(options.minutes) ? 'arrive' : 'depart';
    state.pending = { kind, pick, model, tone, interval };
  }
  const pending = state.pending;
  let started = false, blocked = false;
  if (activeCount(state) >= Math.min(MAX_LOT_MANEUVERS, options.cap)) blocked = true;
  else if (pending.kind === 'depart') started = tryDepart(sim, state, pending.pick);
  else {
    started = tryArrive(sim, state, pending.pick, pending.model, LOT_TONES[Math.floor(pending.tone * LOT_TONES.length)]!, options.traffic);
    blocked = !started && (state.corridor >= 0 || !laneGapClear(sim, state.laneIndex, state.lane, 0, state.lane.speed * LOT_TIMING.arrivalLead, LOT_TIMING.arrivalAhead, options.traffic));
  }
  if (blocked && sim.seconds - state.next < 60) { state.next = sim.seconds + LOT_TIMING.retry; return; }
  const begun = started ? state.maneuvers.find(m => m.active && m.pose.id === 1_000_000 + state.index * 100_000 + state.serial) : undefined;
  sim.log.push({ t: sim.seconds, lot: state.lot.id, kind: pending.kind, bay: begun ? state.lot.bays[begun.bay]!.id : '', model: begun?.model ?? 'mobility-sedan', started });
  if (sim.log.length > 256) sim.log.shift();
  state.lastDecision = sim.seconds;
  state.next = sim.seconds + maneuverInterval(options.density, pending.interval);
  state.pending = null;
}

/** Parked (static) cars of one lot bay: model and tone, or null when empty or taken by a manoeuvre. */
export function parkedAt(state: LotState, bay: number): MobilityModel | null {
  return state.reserved[bay] ? null : state.models[bay] ?? null;
}

/** Development audit: per-lot occupancy, schedule and every manoeuvring car's state. */
export function parkingDebug(sim: ParkingSim) {
  const round = (value: number) => Math.round(value * 100) / 100;
  return sim.lots.map(state => ({
    lot: state.lot.id, lane: state.lane.id, next: round(state.next), corridor: state.corridor, occupancy: occupiedCount(state),
    bounds: occupancyBounds(state.lot.bays.length),
    cars: state.lot.bays.map((bay, index) => {
      const m = state.maneuvers.find(x => x.active && x.bay === index);
      return m ? { bay: bay.id, model: m.model, state: m.phase, kind: m.kind } : state.models[index] ? { bay: bay.id, model: state.models[index], state: 'parked' } : null;
    }).filter(Boolean),
    maneuvers: state.maneuvers.filter(m => m.active).map(m => ({
      id: m.pose.id, kind: m.kind, bay: state.lot.bays[m.bay]!.id, model: m.model, state: m.phase, leg: m.leg, s: round(m.s), v: round(m.v),
      x: round(m.pose.x), y: round(m.pose.y), z: round(m.pose.z), yaw: round(m.pose.yaw), lamps: { ...m.lamps }, waiting: m.pose.waiting, onLane: m.pose.onLane,
    })),
  }));
}

/** Local-time density (shared traffic curve) for scheduling; re-exported for callers without the layout module. */
export { trafficDensity as lotDensity };
