import { CITY_STREETS, CITY_STREET_TOP } from './campusGroundBounds';
import { FRONT_APPROACH } from './campusSiteLayout';

/*
 * The district's drivable road network, shared by the drawn neighborhood streets
 * (CampusNeighborhood) and the traffic simulation (trafficNetwork). Pure data, no Three.js.
 *
 * Streets: the front ring road (z = -60), the cross street (z = 84) and the north ring (z = 108)
 * behind the campus, the flanking avenues (x = ±60) and the ring's sides (x = ±108). Where a street
 * continues as a skyline street beyond the neighborhood, the network follows it two city blocks out,
 * so cars enter and leave among the skyline towers, never in view of the campus.
 */

export const STREET = FRONT_APPROACH.roadWidth;
export const ROAD_TOP = FRONT_APPROACH.roadTop;
export const AVENUE_X = 60;
export const RING_X = 108;
export const RING_SOUTH_Z = FRONT_APPROACH.roadCenterZ;
export const RING_NORTH_Z = 108;
export const CROSS_Z = 84;

export type RoadRun = { axis: 'x' | 'z'; at: number; from: number; to: number; width: number };

/** Every street segment drawn on the neighborhood plane (`axis` is the direction it runs in). */
export const ROAD_RUNS: readonly RoadRun[] = Object.freeze([
  // Outer ring aligned with skyline streets; extends past the plane edge.
  { axis: 'z', at: -RING_X, from: RING_SOUTH_Z - STREET / 2, to: 126, width: STREET },
  { axis: 'z', at: RING_X, from: RING_SOUTH_Z - STREET / 2, to: 126, width: STREET },
  { axis: 'x', at: RING_SOUTH_Z, from: -112, to: 112, width: STREET },
  { axis: 'x', at: RING_NORTH_Z, from: -112, to: 112, width: STREET },
  // Avenues flanking the campus, tying the campus roads to the ring.
  { axis: 'z', at: -AVENUE_X, from: RING_SOUTH_Z, to: RING_NORTH_Z, width: STREET },
  { axis: 'z', at: AVENUE_X, from: RING_SOUTH_Z, to: RING_NORTH_Z, width: STREET },
  { axis: 'x', at: CROSS_Z, from: -RING_X, to: RING_X, width: STREET },
] satisfies RoadRun[]);

export const CROSS_LINES_X: readonly number[] = [-RING_X, -AVENUE_X, AVENUE_X, RING_X];
export const CROSS_LINES_Z: readonly number[] = [RING_SOUTH_Z, CROSS_Z, RING_NORTH_Z];

/** Junction zebra crossings: stripe band centred `offset` from the junction centre, `half` its half length. */
export const CROSSWALK = Object.freeze({ offset: STREET / 2 + 1.8, half: 1.2 });
export const CROSSWALK_JUNCTIONS: readonly (readonly [number, number])[] = Object.freeze([
  [-AVENUE_X, RING_SOUTH_Z], [AVENUE_X, RING_SOUTH_Z], [-AVENUE_X, CROSS_Z], [AVENUE_X, CROSS_Z],
] as const);
/** The main arrival crossing on the front road, where pedestrians cross towards the campus. */
export const ARRIVAL_CROSSWALK = Object.freeze({ x: FRONT_APPROACH.x, z: RING_SOUTH_Z });

/** Left-hand traffic: a lane centre lies this far left of the road centreline. */
export const LANE_OFFSET = 1.65;
/** Lane ends stop short of a junction centre by this much: clear of the box and its crosswalks. */
export const JUNCTION_SETBACK = CROSSWALK.offset + CROSSWALK.half + .5;
/** Lanes ease from the neighborhood road top to the skyline street top over this length. */
const SURFACE_EASE = 4;

/**
 * The visible district: the ring road's outer kerbs. Traffic enters and leaves only at network
 * boundaries beyond it by at least `margin`, out among the skyline blocks.
 */
export const VISIBLE_DISTRICT = Object.freeze({
  minX: -(RING_X + STREET / 2), maxX: RING_X + STREET / 2, minZ: RING_SOUTH_Z - STREET / 2, maxZ: RING_NORTH_Z + STREET / 2, margin: 36,
});
/** How far the network follows skyline streets beyond the ring: two city blocks. */
export const NETWORK_REACH = 2 * CITY_STREETS.block;

/** True when (x, z) lies on a drawn neighborhood street, at least `margin` inside its kerbs. */
export function onNeighborhoodRoad(x: number, z: number, margin = 0): boolean {
  for (const run of ROAD_RUNS) {
    const along = run.axis === 'x' ? x : z, across = run.axis === 'x' ? z : x;
    if (Math.abs(across - run.at) <= run.width / 2 - margin && along >= run.from + margin && along <= run.to - margin) return true;
  }
  return false;
}
/** True when (x, z) lies on a skyline street (outside the campus/park clearing). */
export function onSkylineStreet(x: number, z: number, margin = 0): boolean {
  const { block, offset, width, clear } = CITY_STREETS;
  const line = (value: number) => Math.round((value - offset) / block) * block + offset;
  const lx = line(x), lz = line(z);
  const northSouth = Math.abs(x - lx) <= width / 2 - margin && (lx < clear.minX || lx > clear.maxX || z > clear.maxZ || z < clear.minZ);
  const eastWest = Math.abs(z - lz) <= width / 2 - margin && (lz < clear.minZ || lz > clear.maxZ || x > clear.maxX || x < clear.minX);
  return northSouth || eastWest;
}

export type Point2 = readonly [number, number];
export interface NetworkNode {
  index: number; x: number; z: number;
  /** A network boundary (traffic enters and leaves here) rather than a junction. */
  boundary: boolean;
  /** Turns through this junction (indices into `turns`), and their pairwise conflict matrix. */
  turns: number[]; conflicts: Uint8Array;
}
/** One directed lane between two nodes (left-hand traffic). */
export interface TrafficLane {
  id: string; road: string; index: number;
  from: Point2; to: Point2; length: number; dx: number; dz: number;
  /** Surface height: `top` near the start, easing to `endTop` between `ease[0]` and `ease[1]` (along the lane). */
  top: number; endTop: number; ease: Point2;
  /** Cruise speed (m/s). */
  speed: number;
  /** Stops at the arrival zebra crossing, `crossAt` metres along the lane (else -1). */
  crossing: boolean; crossAt: number;
  fromNode: number; toNode: number;
  /** Starts at a network boundary (traffic enters) / ends at one (traffic leaves). */
  entry: boolean; exit: boolean;
  /** The opposite direction of the same street segment. */
  reverse: number;
}
export type TurnKind = 'straight' | 'left' | 'right';
/** A movement through a junction: a Bézier from the end of `from` to the start of `to`. */
export interface LaneTurn {
  index: number; node: number; from: number; to: number; kind: TurnKind;
  /** Position of this turn in its node's `turns` (conflict matrix row). */
  local: number;
  speed: number; length: number;
  /** Quadratic Bézier: start, control, end. */
  p0: Point2; c: Point2; p2: Point2;
  /** Arc length at `TURN_SAMPLES + 1` evenly spaced parameters. */
  table: Float32Array;
}
export interface RoadNetwork {
  nodes: NetworkNode[]; lanes: TrafficLane[]; turns: LaneTurn[];
  /** Turns leaving the end of each lane. */
  turnsFrom: number[][];
  /** Lanes starting / ending at a boundary. */
  entries: number[]; exits: number[];
}

/** Turn speeds (m/s): the tight left turn, the wide right turn across the oncoming lane. */
export const TURN_SPEED = Object.freeze({ left: 3.6, right: 5 });
/** Turns through one junction conflict when their centrelines come closer than this (widest vehicle plus margin). */
export const CONFLICT_DISTANCE = 3.2;
export const TURN_SAMPLES = 24;

interface RoadLine { name: string; axis: 'x' | 'z'; at: number; speeds: readonly [number, number] }
/** Cruise speeds per street (positive direction first: eastbound / northbound). */
const LINE_SPEEDS: Record<string, readonly [number, number]> = {
  front: [7.5, 6.8], cross: [7.6, 7.3], rear: [7.2, 7.4], west: [8, 7.8], east: [8.2, 8.5], 'west-ring': [9, 8.8], 'east-ring': [8.8, 9],
};
/** Lanes keeping their pre-network names (the parking lots join two of them). */
const LEGACY_IDS: Record<string, string> = {
  'front:+:2': 'front-eastbound', 'front:-:2': 'front-westbound', 'west:+:0': 'west-northbound', 'west:-:0': 'west-southbound',
  'east:-:0': 'east-southbound', 'east:+:0': 'east-northbound',
};
function lineName(run: RoadRun): string {
  if (run.axis === 'x') return run.at === RING_SOUTH_Z ? 'front' : run.at === CROSS_Z ? 'cross' : 'rear';
  return Math.abs(run.at) === RING_X ? (run.at < 0 ? 'west-ring' : 'east-ring') : run.at < 0 ? 'west' : 'east';
}
/** Whether a street continues as a skyline street beyond `end` (a coordinate along it). */
function continuesBeyond(run: RoadRun, end: number): boolean {
  const { clear } = CITY_STREETS;
  if (run.axis === 'z') return run.at < clear.minX || run.at > clear.maxX || end >= clear.maxZ || end <= clear.minZ;
  return run.at < clear.minZ || run.at > clear.maxZ || end >= clear.maxX - 1e-9 || end <= clear.minX + 1e-9;
}

function bezierPoint(turn: Pick<LaneTurn, 'p0' | 'c' | 'p2'>, t: number, out: { x: number; z: number; tx: number; tz: number }) {
  const u = 1 - t;
  out.x = u * u * turn.p0[0] + 2 * u * t * turn.c[0] + t * t * turn.p2[0];
  out.z = u * u * turn.p0[1] + 2 * u * t * turn.c[1] + t * t * turn.p2[1];
  out.tx = 2 * u * (turn.c[0] - turn.p0[0]) + 2 * t * (turn.p2[0] - turn.c[0]);
  out.tz = 2 * u * (turn.c[1] - turn.p0[1]) + 2 * t * (turn.p2[1] - turn.c[1]);
  return out;
}
const scratchPoint = { x: 0, z: 0, tx: 0, tz: 0 };
/** Centre and heading of a car `s` metres into a turn (no allocation). */
export function turnPose(turn: LaneTurn, s: number, out: { x: number; z: number; yaw: number }) {
  const table = turn.table, clamped = Math.max(0, Math.min(turn.length, s));
  let i = 0;
  while (i < TURN_SAMPLES - 1 && table[i + 1]! < clamped) i++;
  const span = table[i + 1]! - table[i]!;
  const t = (i + (span > 0 ? (clamped - table[i]!) / span : 0)) / TURN_SAMPLES;
  bezierPoint(turn, t, scratchPoint);
  out.x = scratchPoint.x; out.z = scratchPoint.z; out.yaw = Math.atan2(scratchPoint.tx, scratchPoint.tz);
  return out;
}
/** Surface height `s` metres along a lane. */
export function laneTop(lane: TrafficLane, s: number): number {
  const [e0, e1] = lane.ease;
  if (s <= e0 || e1 <= e0) return s <= e0 ? lane.top : lane.endTop;
  if (s >= e1) return lane.endTop;
  return lane.top + (lane.endTop - lane.top) * (s - e0) / (e1 - e0);
}
/** Surface height `s` metres into a turn: from the incoming lane's end to the outgoing lane's start. */
export function turnTop(network: RoadNetwork, turn: LaneTurn, s: number): number {
  const a = network.lanes[turn.from]!, b = network.lanes[turn.to]!;
  const t = turn.length > 0 ? Math.max(0, Math.min(1, s / turn.length)) : 0;
  return a.endTop + (b.top - a.endTop) * t;
}

/**
 * Builds the lane graph from `ROAD_RUNS`: junction nodes where streets cross, boundary nodes where a
 * street continues as a skyline street, two lanes per street segment and every non-U-turn movement
 * through each junction, with a conflict matrix from the movements' centreline clearance.
 */
export function buildRoadNetwork(runs: readonly RoadRun[] = ROAD_RUNS): RoadNetwork {
  const nodes: NetworkNode[] = [];
  const nodeAt = (x: number, z: number, boundary: boolean) => {
    let node = nodes.find(entry => Math.abs(entry.x - x) < 1e-6 && Math.abs(entry.z - z) < 1e-6);
    if (!node) nodes.push(node = { index: nodes.length, x, z, boundary, turns: [], conflicts: new Uint8Array(0) });
    return node.index;
  };
  const lines: (RoadLine & { stops: { at: number; node: number }[] })[] = [];
  for (const run of runs) {
    const stops: { at: number; node: number }[] = [];
    for (const other of runs) {
      if (other.axis === run.axis || other.at < run.from - 1e-6 || other.at > run.to + 1e-6 || run.at < other.from - 1e-6 || run.at > other.to + 1e-6) continue;
      stops.push({ at: other.at, node: -1 });
    }
    stops.sort((a, b) => a.at - b.at);
    const first = stops[0]!.at, last = stops[stops.length - 1]!.at;
    if (continuesBeyond(run, run.from)) stops.unshift({ at: first - NETWORK_REACH, node: -2 });
    if (continuesBeyond(run, run.to)) stops.push({ at: last + NETWORK_REACH, node: -2 });
    for (const stop of stops) {
      const [x, z] = run.axis === 'x' ? [stop.at, run.at] : [run.at, stop.at];
      stop.node = nodeAt(x, z, stop.node === -2);
    }
    const name = lineName(run);
    lines.push({ name, axis: run.axis, at: run.at, speeds: LINE_SPEEDS[name] ?? [8, 8], stops });
  }
  const lanes: TrafficLane[] = [];
  for (const line of lines) {
    for (let k = 0; k + 1 < line.stops.length; k++) {
      const a = line.stops[k]!, b = line.stops[k + 1]!;
      const pair: number[] = [];
      for (const sign of [1, -1] as const) {
        const [start, end] = sign > 0 ? [a, b] : [b, a];
        const setback = (stop: { node: number }) => nodes[stop.node]!.boundary ? 0 : JUNCTION_SETBACK;
        const s0 = start.at + sign * setback(start), s1 = end.at - sign * setback(end);
        // Left of the heading: eastbound (+x) keeps to -z, northbound (+z) keeps to +x.
        const offset = line.axis === 'x' ? -sign * LANE_OFFSET : sign * LANE_OFFSET;
        const from: Point2 = line.axis === 'x' ? [s0, line.at + offset] : [line.at + offset, s0];
        const to: Point2 = line.axis === 'x' ? [s1, line.at + offset] : [line.at + offset, s1];
        const length = Math.abs(s1 - s0);
        const segment = k;
        const key = `${line.name}:${sign > 0 ? '+' : '-'}:${segment}`;
        const direction = line.axis === 'x' ? (sign > 0 ? 'eastbound' : 'westbound') : (sign > 0 ? 'northbound' : 'southbound');
        const entry = nodes[start.node]!.boundary, exit = nodes[end.node]!.boundary;
        const speed = entry || exit ? 10 : line.speeds[sign > 0 ? 0 : 1];
        const dx = (to[0] - from[0]) / (length || 1), dz = (to[1] - from[1]) / (length || 1);
        const cross = line.name === 'front' && line.axis === 'x'
          && Math.min(s0, s1) < ARRIVAL_CROSSWALK.x && Math.max(s0, s1) > ARRIVAL_CROSSWALK.x ? Math.abs(ARRIVAL_CROSSWALK.x - s0) : -1;
        // Surface: the neighborhood road while on a drawn street, else the (lower) skyline street.
        let covered = -1, uncovered = -1;
        for (let s = 0; s <= length; s += .5) {
          const on = onNeighborhoodRoad(from[0] + dx * s, from[1] + dz * s);
          if (on && covered < 0) covered = s;
          if (!on && uncovered < 0) uncovered = s;
        }
        let top: number = ROAD_TOP, endTop: number = ROAD_TOP, ease: Point2 = [length, length];
        if (exit && uncovered >= 0) { endTop = CITY_STREET_TOP; ease = [uncovered, uncovered + SURFACE_EASE]; }
        if (entry) { top = CITY_STREET_TOP; ease = covered >= 0 ? [Math.max(0, covered - SURFACE_EASE), covered] : [length, length]; endTop = covered >= 0 ? ROAD_TOP : CITY_STREET_TOP; }
        pair.push(lanes.length);
        lanes.push({
          id: LEGACY_IDS[key] ?? `${line.name}-${direction}-${segment}`, road: line.name, index: lanes.length, from, to, length, dx, dz,
          top, endTop, ease, speed, crossing: cross >= 0, crossAt: cross, fromNode: start.node, toNode: end.node, entry, exit, reverse: -1,
        });
      }
      lanes[pair[0]!]!.reverse = pair[1]!; lanes[pair[1]!]!.reverse = pair[0]!;
    }
  }
  const turns: LaneTurn[] = [];
  const turnsFrom: number[][] = lanes.map(() => []);
  for (const node of nodes) {
    if (node.boundary) continue;
    for (const a of lanes) {
      if (a.toNode !== node.index) continue;
      for (const b of lanes) {
        if (b.fromNode !== node.index || b.reverse === a.index) continue;
        const cross = a.dx * b.dz - a.dz * b.dx, dot = a.dx * b.dx + a.dz * b.dz;
        const kind: TurnKind = dot > .9 ? 'straight' : cross < 0 ? 'left' : 'right';
        // Control point: where the two lane centrelines meet (the midpoint for a straight run).
        let c: Point2 = [(a.to[0] + b.from[0]) / 2, (a.to[1] + b.from[1]) / 2];
        if (kind !== 'straight') {
          const det = a.dx * -b.dz - a.dz * -b.dx;
          const t = ((b.from[0] - a.to[0]) * -b.dz - (b.from[1] - a.to[1]) * -b.dx) / det;
          c = [a.to[0] + a.dx * t, a.to[1] + a.dz * t];
        }
        const turn: LaneTurn = {
          index: turns.length, node: node.index, from: a.index, to: b.index, kind, local: node.turns.length,
          speed: kind === 'straight' ? Math.min(a.speed, b.speed) : TURN_SPEED[kind], length: 0, p0: a.to, c, p2: b.from,
          table: new Float32Array(TURN_SAMPLES + 1),
        };
        let length = 0, px = turn.p0[0], pz = turn.p0[1];
        for (let i = 1; i <= TURN_SAMPLES; i++) {
          bezierPoint(turn, i / TURN_SAMPLES, scratchPoint);
          length += Math.hypot(scratchPoint.x - px, scratchPoint.z - pz);
          px = scratchPoint.x; pz = scratchPoint.z; turn.table[i] = length;
        }
        turn.length = length;
        node.turns.push(turn.index); turnsFrom[a.index]!.push(turn.index); turns.push(turn);
      }
    }
    const n = node.turns.length;
    node.conflicts = new Uint8Array(n * n);
    const samples = node.turns.map(index => {
      const out: number[] = [];
      for (let i = 0; i <= 32; i++) { bezierPoint(turns[index]!, i / 32, scratchPoint); out.push(scratchPoint.x, scratchPoint.z); }
      return out;
    });
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      let near = Infinity;
      const a = samples[i]!, b = samples[j]!;
      for (let p = 0; p < a.length; p += 2) for (let q = 0; q < b.length; q += 2) near = Math.min(near, Math.hypot(a[p]! - b[q]!, a[p + 1]! - b[q + 1]!));
      if (near < CONFLICT_DISTANCE) node.conflicts[i * n + j] = node.conflicts[j * n + i] = 1;
    }
  }
  return {
    nodes, lanes, turns, turnsFrom,
    entries: lanes.filter(lane => lane.entry).map(lane => lane.index), exits: lanes.filter(lane => lane.exit).map(lane => lane.index),
  };
}

export const ROAD_NETWORK: RoadNetwork = buildRoadNetwork();

/**
 * Shortest-route table towards `target` (a lane): `next[lane]` is the lane to take after `lane`
 * (-1 when `lane` is the target or cannot reach it) and `cost[lane]` the metres from the end of `lane`
 * to the start of the target. Long vehicles may be limited to straight movements.
 */
export interface RouteTable { target: number; next: Int16Array; cost: Float32Array }
export function routeTable(network: RoadNetwork, target: number, straightOnly = false): RouteTable {
  const count = network.lanes.length;
  const cost = new Float32Array(count).fill(Infinity), next = new Int16Array(count).fill(-1), done = new Uint8Array(count);
  // Backwards Dijkstra over lanes: reaching `target`'s start from the end of a lane feeding it costs the turn.
  const into: number[][] = network.lanes.map(() => []);
  for (const turn of network.turns) if (!straightOnly || turn.kind === 'straight') into[turn.to]!.push(turn.index);
  const settle = (lane: number) => {
    done[lane] = 1;
    for (const index of into[lane]!) {
      const turn = network.turns[index]!, through = lane === target ? turn.length : turn.length + cost[lane]! + network.lanes[lane]!.length;
      if (through < cost[turn.from]!) { cost[turn.from] = through; next[turn.from] = lane; }
    }
  };
  settle(target);
  for (;;) {
    let best = -1;
    for (let lane = 0; lane < count; lane++) if (!done[lane] && cost[lane]! < Infinity && (best < 0 || cost[lane]! < cost[best]!)) best = lane;
    if (best < 0) break;
    settle(best);
  }
  cost[target] = 0;
  return { target, next, cost };
}
/** The turn from lane `a` straight into lane `b`, or -1. */
export function turnBetween(network: RoadNetwork, a: number, b: number): number {
  for (const index of network.turnsFrom[a]!) if (network.turns[index]!.to === b) return index;
  return -1;
}
