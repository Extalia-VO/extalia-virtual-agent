/** Stable trip geometry and short-horizon passing; no frame-to-frame random noise. */
import type { Point3 } from '../layout';
import type { OfficeNavigation, RouteStep } from './navGraph';

export type WalkableSegment = (from: Readonly<Point3>, to: Readonly<Point3>, radius?: number) => boolean;
export interface WalkingNeighbor {
  readonly id: string;
  readonly position: Readonly<Point3>;
  readonly velocity: Readonly<Point3>;
}
/** A sampled curve leg, with progress measured along its centre line, not the displaced body. */
export interface NaturalLeg {
  readonly from: Point3;
  readonly transit: boolean;
  readonly startDistance: number;
  readonly endDistance: number;
  readonly rightFrom: readonly [number, number];
  readonly rightTo: readonly [number, number];
}
export interface NaturalWalkState {
  index: number;
  progress: number;
  offset: number;
  speed: number;
  blockedTime: number;
  lateralSpeed: number;
}
export const createNaturalWalkState = (): NaturalWalkState => ({ index: -1, progress: 0, offset: 0, speed: 1, blockedTime: 0, lateralSpeed: 0 });
const distance = (a: Readonly<Point3>, b: Readonly<Point3>) => Math.hypot(b[0] - a[0], b[2] - a[2]);
const mix = (a: Readonly<Point3>, b: Readonly<Point3>, t: number): Point3 => [a[0] + (b[0] - a[0]) * t, a[1], a[2] + (b[2] - a[2]) * t];
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
export function walkingSeed(id: string, trip: number): number {
  let hash = 2166136261;
  for (const c of `${id}:${trip}`) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return (hash >>> 0) / 4294967296;
}

function protectedNode(node: string, navigation: OfficeNavigation): boolean {
  const kind = navigation.waypoints.get(node)?.kind;
  return kind === 'door' || kind === 'connector' || node.endsWith(':stage');
}
interface CurvePoint { point: Point3; node: string; transit: boolean }

/** Round real positions, rather than merely turning the body at square route corners. */
function shapeChunk(start: Readonly<Point3>, steps: readonly Extract<RouteStep, { kind: 'walk' }>[], amount: number, lane: number): CurvePoint[] {
  const anchors = [start, ...steps.map(step => step.to)];
  const lengths = anchors.slice(1).map((point, i) => distance(anchors[i]!, point));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const shifted: Point3[] = [];
  let along = 0;
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i]!;
    if (i > 0) along += lengths[i - 1]!;
    const a = anchors[Math.max(0, i - 1)]!, b = anchors[Math.min(anchors.length - 1, i + 1)]!;
    const length = Math.max(1e-6, distance(a, b));
    const taper = Math.min(1, along / 1.6, (total - along) / 1.6);
    const offset = lane * amount * taper;
    shifted.push([anchor[0] + (b[2] - a[2]) / length * offset, anchor[1], anchor[2] - (b[0] - a[0]) / length * offset]);
  }
  const result: CurvePoint[] = [];
  let previous = [...start] as Point3;
  const line = (to: Point3, node: string, milestone = false) => {
    const count = Math.max(1, Math.ceil(distance(previous, to) / 0.18));
    const from = previous;
    for (let j = 1; j <= count; j++) result.push({ point: mix(from, to, j / count), node, transit: !milestone || j < count });
    previous = to;
  };
  for (let i = 1; i < shifted.length; i++) {
    const point = shifted[i]!, step = steps[i - 1]!;
    const next = shifted[i + 1];
    if (!next || amount === 0) {
      // Even a two-anchor leg has a gently varied middle, returning to an exact portal/contact.
      if (i === 1 && shifted.length === 2 && distance(previous, point) > 4 && amount > 0) {
        const length = distance(previous, point), middle = mix(previous, point, 0.5);
        middle[0] += (point[2] - previous[2]) / length * lane * amount;
        middle[2] -= (point[0] - previous[0]) / length * lane * amount;
        const from = previous, count = Math.ceil(length / 0.18);
        for (let j = 1; j <= count; j++) {
          const t = j / count, s = 1 - t;
          result.push({ point: [s * s * from[0] + 2 * s * t * middle[0] + t * t * point[0], point[1], s * s * from[2] + 2 * s * t * middle[2] + t * t * point[2]], node: step.node, transit: j < count });
        }
        previous = point;
      } else line(point, step.node, true);
      continue;
    }
    const before = shifted[i - 1]!;
    const incoming = distance(before, point), outgoing = distance(point, next);
    const radius = Math.min(0.9 * amount, incoming * 0.32, outgoing * 0.32);
    if (radius < 0.03) { line(point, step.node, true); continue; }
    const entry = mix(point, before, radius / incoming), exit = mix(point, next, radius / outgoing);
    line(entry, step.node);
    const count = Math.max(4, Math.ceil((radius * 2) / 0.13));
    for (let j = 1; j <= count; j++) {
      const t = j / count, s = 1 - t;
      result.push({ point: [s * s * entry[0] + 2 * s * t * point[0] + t * t * exit[0], point[1], s * s * entry[2] + 2 * s * t * point[2] + t * t * exit[2]], node: step.node, transit: j !== Math.ceil(count / 2) });
    }
    previous = exit;
  }
  return result;
}

/** Expand only level free-space runs. Every portal, chair stage and connector stays exact. */
export function naturalRoute(start: Readonly<Point3>, steps: readonly RouteStep[], navigation: OfficeNavigation, seed: number, walkable?: WalkableSegment, contacts = true): RouteStep[] {
  if (!walkable) return [...steps];
  const result: RouteStep[] = [];
  let position = start;
  let chunk: Extract<RouteStep, { kind: 'walk' }>[] = [];
  let chunkStart = start;
  const flush = () => {
    if (!chunk.length) return;
    // Keep the hand-contact/threshold approach as a full exact leg. A densely
    // sampled final 10 cm would make doorAhead discover a shut leaf too late.
    const routeLength = chunk.reduce((sum, step, index) => sum + distance(index ? chunk[index - 1]!.to : chunkStart, step.to), 0);
    if (contacts && routeLength < 2.8) { result.push(...chunk); chunk = []; return; }
    // Open rooms may take a different valid chord on another trip. Never skip
    // portal/contact boundaries: chunks were split at those before this point.
    const direct: typeof chunk = [];
    let from: Readonly<Point3> = chunkStart;
    for (let i = 0; i < chunk.length;) {
      let next = i;
      for (let j = Math.min(chunk.length - 1, i + 4); j > i; j--) {
        if (walkable(from, chunk[j]!.to, 0.31)) { next = j; break; }
      }
      direct.push(chunk[next]!); from = chunk[next]!.to; i = next + 1;
    }
    const alternatives = seed < 0.45 ? [direct, chunk] : [chunk, direct];
    const lane = (seed - 0.5) * 1.5;
    let points: CurvePoint[] | null = null;
    for (const path of alternatives) {
      for (const amount of [1, 0.55, 0.25, 0]) {
        const full = shapeChunk(chunkStart, path, amount, lane);
        const last = full.at(-1)!;
        let tail = full.length - 2, remaining = 0;
        for (; tail >= 0; tail--) {
          remaining += distance(full[tail]!.point, full[tail + 1]!.point);
          if (remaining >= 1.4) break;
        }
        const candidate = contacts ? [...full.slice(0, Math.max(1, tail + 1)), last] : full;
        let from = chunkStart;
        if (candidate.every(sample => { const safe = walkable(from, sample.point, 0.29); from = sample.point; return safe; })) { points = candidate; break; }
      }
      if (points) break;
    }
    if (!points) result.push(...chunk);
    else {
      const endpoint = contacts ? points.pop()! : null;
      const distances: number[] = []; let total = 0, from = chunkStart;
      for (const sample of points) { const length = distance(from, sample.point); distances.push(length); total += length; from = sample.point; }
      const normal = (a: Readonly<Point3>, b: Readonly<Point3>): readonly [number, number] => {
        const length = Math.max(1e-6, distance(a, b)); return [(b[2] - a[2]) / length, -(b[0] - a[0]) / length];
      };
      let along = 0; from = chunkStart;
      points.forEach((sample, index) => {
        result.push({ kind: 'walk', node: sample.node, to: sample.point, stairs: false,
          natural: { from: [...from] as Point3, transit: sample.transit, startDistance: along, endDistance: total - along,
            rightFrom: normal(index > 1 ? points![index - 2]!.point : chunkStart, sample.point),
            rightTo: normal(from, points![index + 1]?.point ?? sample.point) } });
        along += distances[index]!; from = sample.point;
      });
      if (endpoint) result.push({ kind: 'walk', node: endpoint.node, to: endpoint.point, stairs: false });
    }
    chunk = [];
  };
  for (const step of steps) {
    if (step.kind !== 'walk' || step.stairs || Math.abs(step.to[1] - position[1]) > 0.05) {
      flush(); result.push(step); position = step.kind === 'walk' ? step.to : step.exit; chunkStart = position;
      continue;
    }
    if (!chunk.length) chunkStart = position;
    chunk.push(step); position = step.to;
    if (contacts && protectedNode(step.node, navigation)) { flush(); chunkStart = position; }
  }
  flush();
  return result;
}

export interface NaturalAdvance { readonly position: Point3; readonly progress: number; readonly offset: number; readonly speed: number; readonly lateralSpeed: number; readonly secondsUsed: number; readonly arrived: boolean }
/**
 * Reciprocal keep-right passing with bounded lateral speed. Candidate bodies are
 * checked against both static geometry and predicted neighbours before advancing.
 */
export function advanceNaturalWalk(id: string, position: Readonly<Point3>, target: Readonly<Point3>, leg: NaturalLeg, state: NaturalWalkState, speed: number, dt: number, neighbors: readonly WalkingNeighbor[], walkable: WalkableSegment): NaturalAdvance {
  const dx = target[0] - leg.from[0], dz = target[2] - leg.from[2], length = Math.hypot(dx, dz);
  if (length < 1e-6) return { position: [...target] as Point3, progress: length, offset: 0, speed: 1, lateralSpeed: 0, secondsUsed: 0, arrived: true };
  const tx = dx / length, tz = dz / length;
  const t = clamp(state.progress / length, 0, 1);
  const nx = leg.rightFrom[0] + (leg.rightTo[0] - leg.rightFrom[0]) * t, nz = leg.rightFrom[1] + (leg.rightTo[1] - leg.rightFrom[1]) * t;
  const normalLength = Math.max(1e-6, Math.hypot(nx, nz)), rx = nx / normalLength, rz = nz / normalLength;
  let preferredOffset = 0, comfort = false;
  for (const other of neighbors) {
    if (other.id === id || Math.abs(other.position[1] - position[1]) > 0.8) continue;
    const ox = other.position[0] - position[0], oz = other.position[2] - position[2];
    const ahead = ox * tx + oz * tz, across = ox * rx + oz * rz;
    const approaching = other.velocity[0] * tx + other.velocity[2] * tz < speed * 0.7;
    if (ahead > -0.2 && ahead < 2.6 && Math.abs(across) < 0.95 && approaching) { preferredOffset = 0.95; comfort = true; }
  }
  let best: NaturalAdvance | null = null, bestScore = -Infinity;
  for (const direction of comfort ? [1, -1, 0] : [0]) {
    for (const fraction of [1, 0.65, 0.25, 0]) {
      const acceleration = dt * 2.2;
      const scale = state.speed + clamp(fraction - state.speed, -acceleration, acceleration);
      // Virtual curve markers are not stops. Steering can use the frame to
      // recenter; actual consumed time is measured below when a marker ends.
      let progress = Math.min(length, state.progress + speed * scale * dt);
      const fade = clamp(Math.min(leg.startDistance + progress, leg.endDistance - progress) / 1.3, 0, 1);
      let wanted = preferredOffset * direction * fade;
      if (comfort && direction !== 0) {
        // Width is measured from this particular curved centre line. Opposing
        // trips can have different base lanes, so a fixed small offset may
        // leave both people shoulder-to-shoulder with no room to pass.
        for (const share of [1, 0.8, 0.6, 0.4, 0.2, 0]) {
          const candidate = state.offset + (wanted - state.offset) * share;
          const goal: Point3 = [position[0] + rx * (candidate - state.offset), position[1], position[2] + rz * (candidate - state.offset)];
          if (walkable(position, goal, 0.29)) { wanted = candidate; break; }
        }
      }
      const wantedVelocity = clamp((wanted - state.offset) * 2.6, -0.7, 0.7);
      let lateralSpeed = state.lateralSpeed + clamp(wantedVelocity - state.lateralSpeed, -dt * 1.6, dt * 1.6);
      const offset = state.offset + lateralSpeed * dt;
      let actualOffset = offset * Math.min(1, (leg.endDistance - progress) / 0.4);
      const pointAt = (): Point3 => {
        const u = progress / length;
        const px = leg.rightFrom[0] + (leg.rightTo[0] - leg.rightFrom[0]) * u, pz = leg.rightFrom[1] + (leg.rightTo[1] - leg.rightFrom[1]) * u;
        const plen = Math.max(1e-6, Math.hypot(px, pz));
        return [leg.from[0] + tx * progress + px / plen * actualOffset, target[1], leg.from[2] + tz * progress + pz / plen * actualOffset];
      };
      let p = pointAt();
      // Side stepping shares the walking-speed budget rather than adding speed
      // on top of it. Scale curve progress and body offset together coherently.
      const budget = Math.max(0, speed * dt);
      for (let guard = 0; guard < 3; guard++) {
        const travelled = distance(position, p);
        if (travelled <= budget + 1e-8) break;
        const share = budget / Math.max(1e-8, travelled);
        progress = state.progress + (progress - state.progress) * share;
        actualOffset = state.offset + (actualOffset - state.offset) * share;
        p = pointAt();
      }
      if (distance(position, p) > budget + 1e-6) continue;
      lateralSpeed = (actualOffset - state.offset) / Math.max(1e-6, dt);
      if (!walkable(position, p, 0.29)) continue;
      const vx = (p[0] - position[0]) / Math.max(dt, 1e-6), vz = (p[2] - position[2]) / Math.max(dt, 1e-6);
      let risk = 0, collision = false;
      for (const other of neighbors) {
        if (other.id === id || Math.abs(other.position[1] - p[1]) > 0.8) continue;
        const ox = other.position[0] - position[0], oz = other.position[2] - position[2];
        const ovx = other.velocity[0] - vx, ovz = other.velocity[2] - vz;
        const relative = ovx * ovx + ovz * ovz;
        const t = relative > 1e-5 ? clamp(-(ox * ovx + oz * ovz) / relative, 0, 0.9) : 0;
        const closest = Math.hypot(ox + ovx * t, oz + ovz * t);
        const immediate = Math.hypot(other.position[0] + other.velocity[0] * dt - p[0], other.position[2] + other.velocity[2] * dt - p[2]);
        if (immediate < 0.56 && immediate < Math.hypot(ox, oz) - 1e-4) { collision = true; break; }
        risk += Math.max(0, 0.85 - closest) * 5;
      }
      if (collision) continue;
      // With eased lateral acceleration, the first side step is tiny. Score the
      // clear passing destination as well as instantaneous velocity; otherwise
      // standing still is a local optimum and nobody starts making room.
      let passingIntent = 0;
      if (comfort && direction !== 0 && Math.abs(wanted - state.offset) > 0.025) {
        const goal: Point3 = [position[0] + rx * (wanted - state.offset), position[1], position[2] + rz * (wanted - state.offset)];
        passingIntent = walkable(position, goal, 0.29) ? 0.4 : -0.6;
        for (const other of neighbors) {
          if (other.id === id || Math.abs(other.position[1] - position[1]) > 0.8) continue;
          passingIntent -= Math.max(0, 0.75 - distance(goal, other.position)) * 3;
        }
      }
      const score = scale * 1.6 - risk + passingIntent - Math.abs(offset - wanted) * 0.05 - (direction < 0 ? 0.025 : 0);
      if (score > bestScore) {
        const arrived = progress >= length - 1e-6;
        const forwardSeconds = speed * scale > 1e-8 ? Math.max(0, length - state.progress) / (speed * scale) : dt;
        // A lateral recenter may take longer than the tiny remaining forward
        // leg. Keep that time available instead of trapping the offset at a
        // marker whose remaining forward duration tends toward zero.
        const secondsUsed = arrived ? Math.min(dt, Math.max(forwardSeconds, distance(position, p) / Math.max(speed, 1e-6))) : dt;
        bestScore = score;
        best = { position: p, progress, offset: actualOffset,
          speed: state.speed + clamp(fraction - state.speed, -secondsUsed * 2.2, secondsUsed * 2.2), lateralSpeed: clamp(lateralSpeed, -0.7, 0.7), secondsUsed, arrived };
      }
    }
  }
  return best ?? { position: [...position] as Point3, progress: state.progress, offset: state.offset, speed: 0, lateralSpeed: 0, secondsUsed: dt, arrived: false };
}

/** Narrow/contact legs keep their authored line and yield rather than sidestep. */
export function protectedHeadway(id: string, position: Readonly<Point3>, target: Readonly<Point3>, speed: number, dt: number, neighbors: readonly WalkingNeighbor[]): number {
  const length = distance(position, target);
  if (length < 1e-6 || speed < 1e-6) return 1;
  const tx = (target[0] - position[0]) / length, tz = (target[2] - position[2]) / length;
  let allowed = speed;
  for (const other of neighbors) {
    if (other.id === id || Math.abs(other.position[1] - position[1]) > 0.8) continue;
    const ox = other.position[0] - position[0], oz = other.position[2] - position[2];
    const ahead = ox * tx + oz * tz, across = Math.abs(ox * tz - oz * tx);
    if (ahead <= 0 || ahead > 2 || across > 0.56) continue;
    const onward = other.velocity[0] * tx + other.velocity[2] * tz;
    allowed = Math.min(allowed, Math.max(0, (ahead - 0.62) / 0.6 + Math.min(speed, onward)));
    const predictedAcross = Math.abs((ox + other.velocity[0] * dt) * tz - (oz + other.velocity[2] * dt) * tx);
    const predictedAhead = ahead + onward * dt;
    if (predictedAcross < 0.56) allowed = Math.min(allowed, Math.max(0, (predictedAhead - 0.56) / Math.max(1e-6, dt)));
  }
  return clamp(allowed / speed, 0, 1);
}

/** A bounded local visibility detour after sustained blockage, retaining all contacts ahead. */
export function reconnectNaturalRoute(position: Readonly<Point3>, steps: readonly RouteStep[], index: number, navigation: OfficeNavigation, seed: number, walkable: WalkableSegment, neighbors: readonly WalkingNeighbor[] = []): { steps: RouteStep[]; count: number } | null {
  let join = index, along = 0, previous = position;
  for (let i = index; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.kind !== 'walk' || !step.natural) break;
    along += distance(previous, step.to); previous = step.to; join = i;
    if (along >= 3) break;
  }
  const target = steps[join];
  if (!target || target.kind !== 'walk' || !target.natural || distance(position, target.to) < 0.5) return null;
  const length = distance(position, target.to), tx = (target.to[0] - position[0]) / length, tz = (target.to[2] - position[2]) / length;
  const localClear: WalkableSegment = (a, b, radius) => {
    if (!walkable(a, b, radius)) return false;
    const dx = b[0] - a[0], dz = b[2] - a[2], length2 = dx * dx + dz * dz;
    for (const other of neighbors) {
      if (Math.abs(other.position[1] - a[1]) > 0.8) continue;
      const t = length2 > 1e-6 ? clamp(((other.position[0] - a[0]) * dx + (other.position[2] - a[2]) * dz) / length2, 0, 1) : 0;
      const closest = Math.hypot(a[0] + dx * t - other.position[0], a[2] + dz * t - other.position[2]);
      if (closest < Math.min(0.57, distance(position, other.position) - 1e-5)) return false;
    }
    return true;
  };
  for (const lateral of [0.85, -0.85, 1.3, -1.3, 1.8, -1.8]) {
    const middle: Point3 = [position[0] + tz * lateral, position[1], position[2] - tx * lateral];
    if (!localClear(position, middle, 0.29) || !localClear(middle, target.to, 0.29)) continue;
    const route: RouteStep[] = [
      { kind: 'walk', node: 'natural-local-detour', to: middle, stairs: false },
      { kind: 'walk', node: target.node, to: [...target.to] as Point3, stairs: false },
    ];
    return { steps: naturalRoute(position, route, navigation, seed, localClear, false), count: join - index + 1 };
  }
  return null;
}
