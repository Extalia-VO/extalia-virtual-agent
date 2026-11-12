import type { Point3 } from '../layout';

/** Destination-scoped memory: changing a sampled leg or retracing a retreat is not progress. */
export interface EncounterMemory {
  peer: string;
  origin: Point3;
  direction: readonly [number, number];
  bestRemaining: number;
  stalled: number;
  attempts: number;
  retryIn: number;
}

export function encounterPassed(memory: Pick<EncounterMemory, 'origin' | 'direction'>, peer: Readonly<Point3>, current: Readonly<Point3> = memory.origin): boolean {
  const dx = peer[0] - memory.origin[0], dz = peer[2] - memory.origin[2];
  const along = dx * memory.direction[0] + dz * memory.direction[1];
  const across = Math.abs(dx * memory.direction[1] - dz * memory.direction[0]);
  const px = peer[0] - current[0], pz = peer[2] - current[2];
  const relativeAlong = px * memory.direction[0] + pz * memory.direction[1];
  const relativeAcross = Math.abs(px * memory.direction[1] - pz * memory.direction[0]);
  return along < -.8 && relativeAlong < -.5
    || Math.hypot(dx, dz) > 2 && across > 1.1 && Math.hypot(px, pz) > 2 && relativeAcross > 1.1;
}

/** A lower remaining distance must beat the previous best, never just the last retreat. */
export function encounterDue(memory: EncounterMemory, remaining: number, seconds: number, threshold = 12): boolean {
  const dt = Number.isFinite(seconds) ? Math.min(.1, Math.max(0, seconds)) : 0;
  memory.retryIn = Math.max(0, memory.retryIn - dt);
  if (remaining < memory.bestRemaining - .25) { memory.bestRemaining = remaining; memory.stalled = 0; }
  else memory.stalled += dt;
  if (memory.stalled < threshold || memory.retryIn > 0 || memory.attempts >= 3) return false;
  memory.attempts++; memory.retryIn = 12;
  return true;
}

/**
 * Bounded local A*: find a genuinely different ordinary-floor chord around a
 * persistent encounter. Every edge, including start/end joins, is swept by the
 * caller against furniture, bodies, floor support and protected portals.
 */
export function encounterPath(from: Readonly<Point3>, target: Readonly<Point3>, clear: (a: Readonly<Point3>, b: Readonly<Point3>) => boolean): Point3[] | null {
  if (Math.abs(from[1] - target[1]) > .05) return null;
  const length = Math.hypot(target[0] - from[0], target[2] - from[2]);
  if (length < .5 || length > 9) return null;
  const tx = (target[0] - from[0]) / length, tz = (target[2] - from[2]) / length;
  const spacing = .65, margin = 3.25;
  const columns = Math.ceil((length + margin * 2) / spacing), rows = 11;
  const point = (column: number, row: number): Point3 => {
    const along = -margin + column * spacing, side = (row - 5) * spacing;
    return [from[0] + tx * along + tz * side, from[1], from[2] + tz * along - tx * side];
  };
  const points: Point3[] = [[...from], [...target]];
  const coordinates = new Map<string, number>();
  for (let column = 0; column <= columns; column++) for (let row = 0; row < rows; row++) {
    const at = point(column, row);
    if (!clear(at, at)) continue;
    coordinates.set(`${column}:${row}`, points.length); points.push(at);
  }
  const edges = new Map<number, number[]>();
  for (const [key, index] of coordinates) {
    const [column, row] = key.split(':').map(Number) as [number, number];
    const next: number[] = [];
    for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
      if (dx === 0 && dz === 0) continue;
      const neighbor = coordinates.get(`${column + dx}:${row + dz}`);
      if (neighbor !== undefined) next.push(neighbor);
    }
    edges.set(index, next);
  }
  for (const endpoint of [0, 1]) {
    const near = points.map((at, index) => ({ index, distance: Math.hypot(at[0] - points[endpoint]![0], at[2] - points[endpoint]![2]) }))
      .filter(item => item.index > 1 && item.distance <= spacing * 1.6).sort((a, b) => a.distance - b.distance).slice(0, 12);
    edges.set(endpoint, near.map(item => item.index));
    for (const item of near) edges.get(item.index)!.push(endpoint);
  }
  const distance = (a: number, b: number) => Math.hypot(points[a]![0] - points[b]![0], points[a]![2] - points[b]![2]);
  const costs = new Map<number, number>([[0, 0]]), previous = new Map<number, number>(), pending = new Set([0]), done = new Set<number>();
  while (pending.size) {
    let current = -1, score = Infinity;
    for (const index of pending) { const next = costs.get(index)! + distance(index, 1); if (next < score) { score = next; current = index; } }
    if (current === 1) {
      const route: Point3[] = [];
      while (current !== 0) { route.unshift(points[current]!); current = previous.get(current)!; }
      // Only remove corners whose complete chord is proven clear.
      let anchor: Readonly<Point3> = from;
      const result: Point3[] = [];
      for (let index = 0; index < route.length;) {
        let end = route.length - 1;
        while (end > index && !clear(anchor, route[end]!)) end--;
        result.push(route[end]!); anchor = route[end]!; index = end + 1;
      }
      return result;
    }
    pending.delete(current); done.add(current);
    for (const next of edges.get(current) ?? []) {
      if (done.has(next) || !clear(points[current]!, points[next]!)) continue;
      const cost = costs.get(current)! + distance(current, next);
      if (cost >= (costs.get(next) ?? Infinity)) continue;
      costs.set(next, cost); previous.set(next, current); pending.add(next);
    }
  }
  return null;
}
