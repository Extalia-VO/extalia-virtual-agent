import type { Point3 } from '../layout';
import { planRoute, type OfficeNavigation } from './navGraph';
import type { WalkableSegment } from './naturalWalking';

const protectedNode = (id: string, navigation: OfficeNavigation) => {
  const kind = navigation.waypoints.get(id)?.kind;
  // A seat's graph stage is an ordinary standing point. Controlled contact
  // legs are added by the mover after graph routing and are never inspected here.
  return kind === 'door' || kind === 'connector';
};

/**
 * Validate whole ordinary routes during planning, not every rendered frame.
 * A safe first leg must not repeatedly lead back to a blocked later edge.
 * This planner lives for one planning decision: moved furniture is reconsidered
 * next time, and transient bodies never become rejected static graph edges.
 */
export function createStaticRoutePlanner(navigation: OfficeNavigation, walkable?: WalkableSegment,
  protectedSegment: (from: Readonly<Point3>, to: Readonly<Point3>) => boolean = () => false) {
  let available = navigation;
  const rejected = new Set<string>();
  const checked = new Map<string, boolean>();
  return (from: string, to: string, initial?: NonNullable<ReturnType<typeof planRoute>>): ReturnType<typeof planRoute> => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const route = attempt === 0 && initial ? initial : planRoute(from, to, available);
      if (!route || !walkable) return route;
      let changed = false;
      for (let index = 1; index < route.nodeIds.length; index++) {
        const a = route.nodeIds[index - 1]!, b = route.nodeIds[index]!;
        const step = route.steps[index - 1];
        if (step?.kind !== 'walk' || step.stairs || protectedNode(a, navigation) || protectedNode(b, navigation)) continue;
        const start = navigation.waypoints.get(a)!.position, end = navigation.waypoints.get(b)!.position;
        if (Math.abs(start[1] - end[1]) > .05 || protectedSegment(start, end)) continue;
        const key = `${a}|${b}`;
        let clear = checked.get(key);
        if (clear === undefined) { clear = walkable(start, end, .29); checked.set(key, clear); }
        if (clear) continue;
        rejected.add(key); changed = true;
      }
      if (!changed) return route;
      available = { ...navigation, graph: { ...navigation.graph,
        edges: new Map([...navigation.graph.edges].map(([id, edges]) => [id, edges.filter(edge => !rejected.has(`${id}|${edge.to}`))])),
      } };
    }
    // An impossible or unusually complex route retains its intent in the mover;
    // the planner never grants an unchecked shortcut or changes a contact owner.
    return null;
  };
}
