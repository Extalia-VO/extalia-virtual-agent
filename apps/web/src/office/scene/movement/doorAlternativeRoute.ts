import type { NavEdge } from '@extalia/office';
import { doorAxes, type DoorHit, type DoorTraffic } from '../interior/doorTraffic';
import type { Point3 } from '../layout';
import { planRoute, type OfficeNavigation } from './navGraph';
import { waitingSegmentClear } from './doorWaitingPath';
import type { WalkableSegment, WalkingNeighbor } from './naturalWalking';

const EPSILON = 1e-6;
/** Exact portal-plane test, without the approach-distance limit used by live walkers. */
export function crossesDoorPortal(hit: DoorHit, from: Readonly<Point3>, to: Readonly<Point3>): boolean {
  if (Math.abs(from[1] - hit.door.center[1]) > .1 || Math.abs(to[1] - from[1]) > .1) return false;
  const a = doorAxes(hit.door, from), b = doorAxes(hit.door, to);
  const start = Math.abs(a.through) <= EPSILON ? 0 : a.through;
  const end = Math.abs(b.through) <= EPSILON ? 0 : b.through;
  if (start === end || start * end > 0) return false;
  const t = start / (start - end);
  return Math.abs(a.across + (b.across - a.across) * t) <= hit.door.clearWidth / 2 + .25;
}

export interface DoorAlternative {
  readonly start: string;
  readonly firstDoor: string;
  readonly cost: number;
  readonly avoidedEdges: string[];
  readonly navigation: OfficeNavigation;
}

/**
 * Select an authored route through a different portal. The initial join must be
 * walkable on this face and clear of bodies/leaf; every portal retains its normal
 * door interaction and local FIFO. This planner never enrolls or moves a body.
 */
export function doorAlternativeRoute(input: {
  id: string; position: Readonly<Point3>; current: DoorHit; side: 1 | -1; destination: string;
  navigation: OfficeNavigation; doors: DoorTraffic; walkable: WalkableSegment;
  neighbors: readonly WalkingNeighbor[]; avoidedEdges: readonly string[]; avoidedDoors: readonly string[];
}): DoorAlternative | null {
  const { navigation, current, doors, position, walkable } = input;
  const portals = doors.portals();
  const forbidden = new Set([...input.avoidedDoors, current.id]);
  const blocked = new Set(input.avoidedEdges);
  const graphEdges = new Map<string, NavEdge[]>();
  const queueCosts = new Map(portals.map(hit => [hit.id, doors.queueStatus(hit.id, input.id).count * 5]));
  for (const [from, edges] of navigation.graph.edges) {
    const a = navigation.waypoints.get(from)?.position;
    graphEdges.set(from, edges.flatMap(edge => {
      const b = navigation.waypoints.get(edge.to)?.position;
      const hits = a && b ? portals.filter(hit => crossesDoorPortal(hit, a, b)) : [];
      if (hits.some(hit => forbidden.has(hit.id))) blocked.add(`${from}|${edge.to}`);
      if (blocked.has(`${from}|${edge.to}`)) return [];
      const penalty = hits.reduce((sum, hit) => sum + (queueCosts.get(hit.id) ?? 0), 0);
      return [{ ...edge, cost: edge.cost + penalty }];
    }));
  }
  const filtered = { ...navigation, graph: { ...navigation.graph, edges: graphEdges } };
  const candidates = [...navigation.waypoints.values()]
    .filter(node => node.kind !== 'door' && node.kind !== 'connector' && !node.id.startsWith('seat:')
      && Math.abs(node.position[1] - position[1]) < .05)
    .map(node => ({ node, distance: Math.hypot(node.position[0] - position[0], node.position[2] - position[2]) }))
    .filter(item => item.distance <= 6).sort((a, b) => a.distance - b.distance || a.node.id.localeCompare(b.node.id)).slice(0, 16);
  let best: DoorAlternative | null = null;
  for (const { node, distance } of candidates) {
    if (!waitingSegmentClear(input.id, current.door, doors.amount(current.id), input.side, position, node.position as Point3, walkable, input.neighbors)
      || portals.some(hit => crossesDoorPortal(hit, position, node.position))) continue;
    const route = planRoute(node.id, input.destination, filtered);
    if (!route) continue;
    let from: Readonly<Point3> = node.position;
    let firstDoor: string | null = null;
    for (const step of route.steps) {
      // Reach a real alternative on this floor before using any connector.
      if (step.kind !== 'walk' || step.stairs || Math.abs(step.to[1] - position[1]) > .05 || !walkable(from, step.to, .29)) break;
      const hit = portals.find(portal => crossesDoorPortal(portal, from, step.to));
      if (hit) { firstDoor = hit.id; break; }
      from = step.to;
    }
    if (!firstDoor || forbidden.has(firstDoor)) continue;
    const cost = distance + route.cost;
    if (!best || cost < best.cost - EPSILON) best = { start: node.id, firstDoor, cost, avoidedEdges: [...blocked], navigation: filtered };
  }
  return best;
}
