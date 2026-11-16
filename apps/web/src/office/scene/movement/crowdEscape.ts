import type { Point3 } from '../layout';
import type { WalkableSegment, WalkingNeighbor } from './naturalWalking';
import { recoverySegmentClear } from './movementRecovery';

/** One deliberate short retreat; the caller keeps its seat, route and FIFO ticket. */
export function crowdEscape(id: string, position: Readonly<Point3>, target: Readonly<Point3>, neighbors: readonly WalkingNeighbor[],
  clear: WalkableSegment, portalClear: (from: Readonly<Point3>, to: Readonly<Point3>) => boolean, rejoin: Readonly<Point3> = target): Point3 | null {
  const heading = Math.atan2(target[0] - position[0], target[2] - position[2]);
  let best: Point3 | null = null, score = -Infinity;
  for (const length of [.75, 1.1, 1.5]) for (const turn of [Math.PI / 2, -Math.PI / 2, Math.PI, Math.PI * .75, -Math.PI * .75]) {
    const angle = heading + turn;
    const point: Point3 = [position[0] + Math.sin(angle) * length, position[1], position[2] + Math.cos(angle) * length];
    if (!portalClear(position, point) || !portalClear(point, rejoin)
      || !recoverySegmentClear(id, position, point, clear, neighbors)
      || !clear(point, rejoin, .29)) continue;
    const separation = Math.min(2, ...neighbors.filter(other => other.id !== id && Math.abs(other.position[1] - point[1]) < .8)
      .map(other => Math.hypot(other.position[0] - point[0], other.position[2] - point[2])));
    const candidate = separation - length * .12;
    if (candidate > score) { best = point; score = candidate; }
  }
  return best;
}
