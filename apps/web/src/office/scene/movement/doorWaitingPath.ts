import type { Point3 } from '../layout';
import { doorAxes, doorLeafDistance, doorPoint, type DoorInfo } from '../interior/doorTraffic';
import { DOOR_BODY_CLEARANCE } from './doorChoreography';
import { staticSeatNeighborsClear } from './staticSeating';
import type { WalkableSegment, WalkingNeighbor } from './naturalWalking';
import type { OfficeNavigation, RouteStep } from './navGraph';

/** Waiting never crosses the wall plane, the leaf, furniture, or another body. */
export function waitingSegmentClear(id: string, door: Readonly<DoorInfo>, amount: number, side: 1 | -1,
  from: Readonly<Point3>, to: Readonly<Point3>, walkable: WalkableSegment | undefined, neighbors: readonly WalkingNeighbor[], minimumThrough = DOOR_BODY_CLEARANCE): boolean {
  if (doorAxes(door, to).through * side < minimumThrough - 1e-6 || (walkable && !walkable(from, to, .29))
    || !staticSeatNeighborsClear(id, from, to, neighbors)) return false;
  if (door.sliding) return true;
  const minimum = Math.min(DOOR_BODY_CLEARANCE, doorLeafDistance(door, amount, from));
  const count = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[2] - from[2]) / .1));
  for (let i = 1; i <= count; i++) {
    const t = i / count;
    const point: Point3 = [from[0] + (to[0] - from[0]) * t, from[1], from[2] + (to[2] - from[2]) * t];
    if (doorLeafDistance(door, amount, point) < minimum - 1e-6) return false;
  }
  return true;
}

/** Search the nearest reachable target; remaining points are visibility-graph bends. */
function visibilityPath(points: Point3[], targetCount: number, clear: (from: Point3, to: Point3) => boolean): Point3[] | null {
  const costs = points.map(() => Infinity), previous = points.map(() => -1), visited = new Set<number>();
  costs[0] = 0;
  while (visited.size < points.length) {
    let next = -1;
    for (let i = 0; i < points.length; i++) if (!visited.has(i) && (next < 0 || costs[i]! < costs[next]!)) next = i;
    if (next < 0 || !Number.isFinite(costs[next])) return null;
    if (next > 0 && next <= targetCount) {
      const path: Point3[] = [];
      for (let i = next; i > 0; i = previous[i]!) path.unshift(points[i]!);
      return path;
    }
    visited.add(next);
    for (let i = 1; i < points.length; i++) {
      if (visited.has(i)) continue;
      const cost = costs[next]! + Math.hypot(points[i]![0] - points[next]![0], points[i]![2] - points[next]![2]);
      if (cost >= costs[i]! || !clear(points[next]!, points[i]!)) continue;
      costs[i] = cost; previous[i] = next;
    }
  }
  return null;
}

/** Rejoin an authored aisle from a queue pocket, using real clear bends around furniture. */
export function doorApproachPath(id: string, door: Readonly<DoorInfo>, amount: number, side: 1 | -1,
  from: Readonly<Point3>, steps: readonly RouteStep[], index: number, navigation: OfficeNavigation,
  portalClear: WalkableSegment, walkable: WalkableSegment, neighbors: readonly WalkingNeighbor[], minimumThrough = DOOR_BODY_CLEARANCE, maximumDepth = Infinity): { index: number; path: Point3[] } | null {
  const targets: { index: number; point: Point3 }[] = [];
  for (let i = index; i < Math.min(steps.length, index + 96); i++) {
    const step = steps[i]!;
    if (step.kind !== 'walk' || step.stairs || Math.abs(step.to[1] - from[1]) > .05
      || doorAxes(door, step.to).through * side < minimumThrough + .02
      || doorAxes(door, step.to).through * side > maximumDepth
      || i > index && steps[i - 1]?.kind === 'walk' && !portalClear((steps[i - 1] as Extract<RouteStep, { kind: 'walk' }>).to, step.to)) break;
    if ((!step.natural?.transit || i + 1 === steps.length) && Math.hypot(step.to[0] - from[0], step.to[2] - from[2]) > .05)
      targets.push({ index: i, point: [...step.to] });
  }
  if (!targets.length) return null;
  const clear = (a: Point3, b: Point3) => waitingSegmentClear(id, door, amount, side, a, b, walkable, neighbors, minimumThrough)
    && portalClear(a, b);
  const authored = [...navigation.waypoints.values()].filter(node => node.kind !== 'door' && node.kind !== 'connector'
    && Math.abs(node.position[1] - from[1]) < .05 && Math.hypot(node.position[0] - from[0], node.position[2] - from[2]) <= 12)
    .map(node => [...node.position] as Point3).filter(point => doorAxes(door, point).through * side <= maximumDepth);
  // A diagonal from a parked body can be pinched between a chair and a walker.
  // Orthogonal joins let it step sideways into an authored aisle first.
  const seen = new Set<string>(), at = doorAxes(door, from);
  const local = [-.4, .4, -.8, .8].map(across => doorPoint(door, at.across + across, at.through, [0, 0, 0]));
  const bends = [...authored, ...local, ...authored.flatMap(point => [[point[0], from[1], from[2]], [from[0], from[1], point[2]]] as Point3[])]
    .filter(point => { const key = `${point[0].toFixed(2)}:${point[2].toFixed(2)}`; if (seen.has(key)) return false; seen.add(key); return clear(point, point); });
  const path = visibilityPath([[...from], ...targets.map(target => target.point), ...bends], targets.length, clear);
  if (!path?.length) return null;
  const end = path[path.length - 1]!;
  const target = targets.find(item => item.point === end);
  return target ? { index: target.index, path } : null;
}

/** Compact waits must stay clear even after the operator swings the whole leaf. */
function futureSwingClear(door: Readonly<DoorInfo>, point: Point3): boolean {
  if (door.sliding) return true;
  // Distance to the leaf is Lipschitz in its angular motion. This margin bounds
  // the unsampled half-interval, rather than assuming a 90-degree opening.
  const count = 16, margin = door.clearWidth * Math.abs(door.openAngle) / (2 * count);
  for (let i = 0; i <= count; i++) if (doorLeafDistance(door, i / count, point) < DOOR_BODY_CLEARANCE + margin) return false;
  return true;
}

/** Small visibility graph finds a real same-face pocket, including narrower corridors. */
export function doorWaitingPath(id: string, door: Readonly<DoorInfo>, amount: number, side: 1 | -1,
  from: Readonly<Point3>, preferred: Point3, walkable?: WalkableSegment, neighbors: readonly WalkingNeighbor[] = [], parkingClear: (point: Point3) => boolean = () => true, localYield = false, navigation?: OfficeNavigation): Point3[] | null {
  const at = doorAxes(door, from), target = doorAxes(door, preferred);
  const depth = Math.max(door.clearWidth + .9, target.through * side);
  const acrosses = [target.across, -target.across, Math.sign(target.across || 1) * .72, -Math.sign(target.across || 1) * .72];
  const targets = acrosses.map(across => doorPoint(door, across, side * depth, [0, 0, 0])).filter(parkingClear);
  const points: Point3[] = [[...from], ...targets];
  for (const through of [depth, depth + .8, Math.max(depth, at.through * side)]) {
    for (const across of [at.across, 0, ...acrosses]) points.push(doorPoint(door, across, side * through, [0, 0, 0]));
  }
  const clear = (a: Point3, b: Point3) => waitingSegmentClear(id, door, amount, side, a, b, walkable, neighbors);
  const deep = visibilityPath(points, targets.length, clear);
  if (deep) return deep;
  // A shallow corridor may have no space at width+.9 depth. Only then use
  // lateral pockets beyond the jamb; the centre of the passage is never a goal.
  const compact: Point3[] = [];
  for (const through of [.8, 1.2, 1.6, 2]) for (const across of acrosses.slice(0, 2)) {
    if (through >= depth || Math.abs(across) < door.clearWidth / 2 + DOOR_BODY_CLEARANCE + .1) continue;
    const point = doorPoint(door, across, side * through, [0, 0, 0]);
    if (parkingClear(point) && futureSwingClear(door, point)) compact.push(point);
  }
  // Give a released walker its aisle without giving up the waiting ticket.
  // Local side pockets also fit rooms where the usual deep columns hit furniture.
  if (localYield) for (const gap of [.8, 1.2, 1.6]) for (const [x, z] of [[-gap, 0], [gap, 0], [0, -gap], [0, gap], [-gap, gap], [gap, -gap], [-gap, -gap], [gap, gap]]) {
    const point: Point3 = [from[0] + x!, from[1], from[2] + z!];
    if (parkingClear(point) && futureSwingClear(door, point)) compact.push(point);
  }
  const bends: Point3[] = [];
  for (const through of [.8, 1.2, 1.6, 2, Math.max(.8, at.through * side)]) {
    for (const across of [at.across, 0, ...acrosses.slice(0, 2)]) bends.push(doorPoint(door, across, side * through, [0, 0, 0]));
  }
  if (localYield && navigation) {
    // A desk aisle may have no lateral pocket until its next authored bay.
    // Keep this bounded and same-face; the supplied clearance also owns portals.
    const authored = [...navigation.waypoints.values()]
      .filter(node => node.kind !== 'door' && node.kind !== 'connector' && !node.id.startsWith('seat:')
        && Math.abs(node.position[1] - from[1]) < .05
        && doorAxes(door, node.position).through * side >= DOOR_BODY_CLEARANCE + .02)
      .map(node => ({ node, distance: Math.hypot(node.position[0] - from[0], node.position[2] - from[2]) }))
      .filter(item => item.distance <= 6).sort((a, b) => a.distance - b.distance || a.node.id.localeCompare(b.node.id)).slice(0, 24)
      .map(item => [...item.node.position] as Point3);
    for (const point of authored) {
      const vacant = neighbors.every(other => other.id === id || Math.abs(other.position[1] - point[1]) > .8
        || Math.hypot(other.position[0] - point[0], other.position[2] - point[2]) >= .56);
      if (vacant && parkingClear(point) && futureSwingClear(door, point) && clear(point, point)) compact.push(point);
      bends.push(point, [point[0], from[1], from[2]], [from[0], from[1], point[2]]);
    }
  }
  if (!compact.length) return null;
  return visibilityPath([[...from], ...compact, ...bends], compact.length, clear);
}
