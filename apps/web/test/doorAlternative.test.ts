import { describe, expect, it } from 'vitest';
import type { NavEdge, Waypoint } from '@extalia/office';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { DoorTraffic, type DoorHit, type WalkerInfo } from '../src/office/scene/interior/doorTraffic';
import type { Point3 } from '../src/office/scene/layout';
import { crossesDoorPortal, doorAlternativeRoute } from '../src/office/scene/movement/doorAlternativeRoute';
import { createMover, routeFrom, sendMover, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import type { OfficeNavigation } from '../src/office/scene/movement/navGraph';

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };

function fixture(third = false) {
  let now = 0;
  const entries = [['a', 0], ['b', 6], ...(third ? [['c', -7] as const] : [])] as const;
  const portals: DoorHit[] = entries.map(([key, x]) => ({ id: `door-${key}`, door: { floor: 1, center: [x, 0, 0], yaw: 0,
    clearWidth: 1.6, height: 2.55, openAngle: Math.PI / 2, sliding: key !== 'a' } }));
  const waypoints = new Map<string, Waypoint>(), edges = new Map<string, NavEdge[]>();
  const connect = (a: string, b: string) => {
    const from = waypoints.get(a)!.position, to = waypoints.get(b)!.position;
    const cost = Math.hypot(from[0] - to[0], from[2] - to[2]);
    edges.get(a)!.push({ to: b, cost }); edges.get(b)!.push({ to: a, cost });
  };
  for (const [key, x] of entries) {
    for (const [suffix, z] of [['out', -3], ['door', 0], ['in', 3]] as const) {
      const id = `${key}-${suffix}`;
      waypoints.set(id, { id, floorId: 'floor-1', kind: suffix === 'door' ? 'door' : 'corridor', position: [x, 0, z] });
      edges.set(id, []);
    }
    connect(`${key}-out`, `${key}-door`); connect(`${key}-door`, `${key}-in`);
    if (key !== 'a') { connect('a-out', `${key}-out`); connect('a-in', `${key}-in`); }
  }
  const navigation: OfficeNavigation = { graph: { nodes: new Map([...waypoints].map(([id, node]) => [id, { id, floorId: 'floor-1', pos: { x: node.position[0], y: node.position[2] } }])), edges },
    waypoints, edges: [], connectors: [], aisles: new Map(), seats: new Map(), elevatorEdges: new Map(), entryId: 'a-out' };
  const tracked = new Map<string, WalkerInfo>();
  const traffic = new DoorTraffic({ forEachDoor: visit => portals.forEach(hit => visit(hit.id, hit.door)), forEachWalker: visit => tracked.forEach(visit) }, () => now);
  const walkable = (from: Readonly<Point3>, to: Readonly<Point3>, radius = .29) => {
    for (let i = 0; i <= 100; i++) {
      const t = i / 100, x = from[0] + (to[0] - from[0]) * t, z = from[2] + (to[2] - from[2]) * t;
      if (Math.abs(z) <= radius + .05 && !portals.some(hit => Math.abs(x - hit.door.center[0]) <= hit.door.clearWidth / 2 - radius)) return false;
    }
    return true;
  };
  const input = { id: 'rerouter', position: [0, 0, -2.8] as Point3, current: portals[0]!, side: -1 as const, destination: 'a-in', navigation,
    doors: traffic, walkable, neighbors: [], avoidedEdges: [], avoidedDoors: [] };
  return { portals, waypoints, navigation, edges, traffic, tracked, walkable, input, advance() { now += 1000 / 30; } };
}

describe('alternative doorway routes', () => {
  it('maps physical crossings including long arcs and threshold endpoints without matching waypoint names', () => {
    const hit: DoorHit = { id: 'physical', door: { floor: 1, center: [2, 0, 0], yaw: 0, clearWidth: 1.6, height: 2.5, openAngle: 1.5, sliding: false } };
    expect(crossesDoorPortal(hit, [2, 0, -20], [2, 0, 20])).toBe(true);
    expect(crossesDoorPortal(hit, [2, 0, -2], [2, 0, 0])).toBe(true);
    expect(crossesDoorPortal(hit, [2, 0, 0], [2, 0, 2])).toBe(true);
    expect(crossesDoorPortal(hit, [5, 0, -2], [5, 0, 2])).toBe(false);
    expect(crossesDoorPortal(hit, [2, 6.4, -2], [2, 6.4, 2])).toBe(false);
    expect(crossesDoorPortal(hit, [1.5, 0, 0], [2.5, 0, 0])).toBe(false);
  });

  it('removes both graph directions through the original portal and plans through another door', () => {
    const h = fixture(), result = doorAlternativeRoute(h.input)!;
    expect(result.firstDoor).toBe('door-b');
    for (const key of ['a-out|a-door', 'a-door|a-out', 'a-in|a-door', 'a-door|a-in']) expect(result.avoidedEdges).toContain(key);
    expect(h.edges.get('a-out')!.some(edge => edge.to === 'a-door')).toBe(true);
    expect(h.traffic.queueStatus('door-b').count).toBe(0); // Planning alone does not enroll or reserve.
  });

  it('chooses the less-congested alternative while preserving the occupied door queue', () => {
    const h = fixture(true), b = h.portals[1]!;
    for (let i = 0; i < 4; i++) h.traffic.queue(b.id, b.door, `waiting-${i}`, [6, 0, -3 - i], -1);
    const result = doorAlternativeRoute(h.input)!;
    expect(result.firstDoor).toBe('door-c');
    expect(h.traffic.queueStatus('door-b', 'waiting-0')).toMatchObject({ head: 'waiting-0', count: 4, ahead: 0 });
  });

  it('refuses an alternate reached only through a blocked or occupied initial bridge', () => {
    const h = fixture();
    expect(doorAlternativeRoute({ ...h.input, walkable: () => false })).toBeNull();
    const neighbors = [{ id: 'standing-body', position: [0, 0, -3] as Point3, velocity: [0, 0, 0] as Point3 }];
    expect(doorAlternativeRoute({ ...h.input, neighbors })).toBeNull();
  });

  it('does not join a waypoint across the original threshold or on another floor', () => {
    const h = fixture();
    const onlyInside = new Map([...h.waypoints].filter(([id]) => id.endsWith('-in') || id.endsWith('-door')));
    const navigation = { ...h.navigation, waypoints: onlyInside };
    expect(doorAlternativeRoute({ ...h.input, navigation })).toBeNull();
    const upstairs = new Map([...h.waypoints].map(([id, node]) => [id, { ...node, position: [node.position[0], 6.4, node.position[2]] as Point3 }]));
    expect(doorAlternativeRoute({ ...h.input, navigation: { ...h.navigation, waypoints: upstairs } })).toBeNull();
  });

  it('does not use a connector before reaching an alternate doorway or return to a previously avoided door', () => {
    const h = fixture();
    const raised = new Map(h.waypoints);
    raised.set('b-out', { ...raised.get('b-out')!, kind: 'connector', position: [6, 6.4, -3] });
    expect(doorAlternativeRoute({ ...h.input, navigation: { ...h.navigation, waypoints: raised } })).toBeNull();
    expect(doorAlternativeRoute({ ...h.input, avoidedDoors: ['door-b'] })).toBeNull();
  });

  it('keeps the original ticket and goal when no alternative path is safe', () => {
    const h = fixture(), mover = createMover('rerouter', gaitParameters(), h.input.position, 0, false);
    const goal = { kind: 'leave' as const, node: 'a-in' };
    const env: MovementEnv = { navigation: h.navigation, elevators, doors: h.traffic, walkable: () => false, nearbyWalkers: () => [] };
    routeFrom(mover, 'a-out', goal, env, false);
    h.traffic.claim('door-a', 'existing-operator');
    for (let frame = 0; frame < 30 * 30; frame++) { stepMover(mover, 1 / 30, env); h.advance(); }
    expect(mover.phase).toBe('doorwork');
    expect(mover.goal).toBe(goal);
    expect(h.traffic.queueStatus('door-a', mover.id)).toMatchObject({ head: 'existing-operator', ahead: 1 });
    expect(mover.recovery.avoidedDoors).toEqual([]);
    expect(mover.position[2]).toBeLessThan(-.34);
  });

  it('detours a granted head away from a partially open frozen slider before generic relocation', () => {
    const h = fixture();
    h.portals[0] = { ...h.portals[0]!, door: { ...h.portals[0]!.door, sliding: true } };
    const mover = createMover('rerouter', gaitParameters(), h.input.position, 0, false);
    const goal = { kind: 'leave' as const, node: 'a-in' };
    let currentMs = 0, redirectedAt: number | null = null, crossedAlternate = false;
    const env: MovementEnv = { navigation: h.navigation, elevators, doors: h.traffic, walkable: h.walkable, nearbyWalkers: () => [],
      trackWalker(id, position, target) { if (position && target) h.tracked.set(id, { id, position: [...position], target: [...target], updatedAt: currentMs }); else h.tracked.delete(id); } };
    h.traffic.hold('door-a', 'initial-opener', 1, 1 / 3);
    h.traffic.release('door-a', 'initial-opener');
    expect(h.traffic.amount('door-a')).toBeCloseTo(.3);
    routeFrom(mover, 'a-out', goal, env, false);
    for (let frame = 0; frame < 30 * 50; frame++) {
      const alternate = h.portals[1]!;
      h.traffic.slideStep(alternate.id, alternate.door, 1 / 30);
      const before: Point3 = [...mover.position];
      stepMover(mover, 1 / 30, env);
      expect(Math.hypot(...mover.position.map((value, axis) => value - before[axis]!) as Point3)).toBeLessThan(.08);
      expect(h.walkable(before, mover.position)).toBe(true);
      if (!crossedAlternate && Math.abs(mover.position[0]) < 1) expect(mover.position[2]).toBeLessThan(-.34);
      if (redirectedAt === null && mover.recovery.avoidedDoors.includes('door-a')) redirectedAt = frame / 30;
      crossedAlternate ||= mover.position[2] > .1 && Math.abs(mover.position[0] - 6) < 1;
      h.advance(); currentMs += 1000 / 30;
      if (mover.phase === 'gone') break;
    }
    expect(redirectedAt).not.toBeNull();
    expect(redirectedAt!).toBeLessThan(6);
    expect(mover.recovery.attempts).toBe(0);
    expect(mover.recovery.avoidedDoors).toEqual(['door-a']);
    expect(h.traffic.amount('door-a')).toBeCloseTo(.3);
    expect(h.traffic.queueStatus('door-a').count).toBe(0);
    expect(crossedAlternate).toBe(true);
    expect(mover.phase).toBe('gone');
    expect(mover.goal).toBe(goal);
  });

  it('never crosses an alternative whose sliding controller stays shut', () => {
    const h = fixture(), mover = createMover('rerouter', gaitParameters(), h.input.position, 0, false);
    const goal = { kind: 'leave' as const, node: 'a-in' };
    let currentMs = 0;
    const env: MovementEnv = { navigation: h.navigation, elevators, doors: h.traffic, walkable: h.walkable, nearbyWalkers: () => [],
      trackWalker(id, position, target) { if (position && target) h.tracked.set(id, { id, position: [...position], target: [...target], updatedAt: currentMs }); else h.tracked.delete(id); } };
    routeFrom(mover, 'a-out', goal, env, false);
    h.traffic.claim('door-a', 'existing-operator');
    for (let frame = 0; frame < 30 * 70; frame++) {
      stepMover(mover, 1 / 30, env);
      expect(mover.position[2]).toBeLessThanOrEqual(-.34);
      h.advance(); currentMs += 1000 / 30;
    }
    expect(mover.recovery.avoidedDoors).toEqual(['door-a']);
    expect(h.traffic.amount('door-b')).toBe(0);
    expect(mover.phase).not.toMatch(/^(gone|vanishing)$/);
    expect(mover.goal).toBe(goal);
  });

  it.each([false, true])('walks to an alternative without jumping and joins its queue (newest pending goal=%s)', newest => {
    const h = fixture(), mover = createMover('rerouter', gaitParameters(), h.input.position, 0, false);
    const goal = { kind: 'leave' as const, node: 'a-in' };
    const env: MovementEnv = { navigation: h.navigation, elevators, doors: h.traffic, walkable: h.walkable, nearbyWalkers: () => [],
      trackWalker(id, position, target) { if (position && target) h.tracked.set(id, { id, position: [...position], target: [...target], updatedAt: currentMs }); else h.tracked.delete(id); } };
    let currentMs = 0;
    routeFrom(mover, 'a-out', goal, env, false);
    h.traffic.claim('door-a', 'existing-operator');
    const alternate = h.portals[1]!;
    const latest = newest ? { kind: 'leave' as const, node: 'b-in' } : goal;
    let joinedBehind = false, rerouted = false, crossedAlternate = false;
    for (let frame = 0; frame < 30 * 100; frame++) {
      if (newest && frame === 90) expect(sendMover(mover, latest, env)).toBe(true);
      // Retain an already-waiting person until the rerouted actor reaches this queue.
      if (!joinedBehind) h.traffic.queue(alternate.id, alternate.door, 'earlier-arrival', [6, 0, -2], -1);
      else h.traffic.finishPass(alternate.id, 'earlier-arrival');
      h.traffic.slideStep(alternate.id, alternate.door, 1 / 30);
      const before: Point3 = [...mover.position];
      stepMover(mover, 1 / 30, env);
      expect(Math.hypot(...mover.position.map((value, axis) => value - before[axis]!) as Point3)).toBeLessThan(.08);
      expect(h.walkable(before, mover.position)).toBe(true);
      rerouted ||= mover.recovery.avoidedDoors.includes('door-a');
      if (mover.door?.id === 'door-b' && !joinedBehind) {
        expect(h.traffic.queueStatus('door-b', mover.id)).toMatchObject({ head: 'earlier-arrival', ahead: 1 });
        expect(mover.position[2]).toBeLessThan(-.34);
        joinedBehind = true;
      }
      crossedAlternate ||= mover.position[2] > .1 && Math.abs(mover.position[0] - 6) < 1;
      h.advance(); currentMs += 1000 / 30;
      if (mover.phase === 'gone') break;
    }
    expect({ phase: mover.phase, position: mover.position, door: mover.door?.id, avoided: mover.recovery.avoidedDoors }).toMatchObject({ phase: 'gone', avoided: ['door-a'] });
    expect(rerouted && joinedBehind && crossedAlternate).toBe(true);
    expect(mover.goal).toBe(latest);
    expect(mover.pending).toBeNull();
    expect(h.traffic.queueStatus('door-a')).toMatchObject({ head: 'existing-operator', count: 1 });
  });
});
