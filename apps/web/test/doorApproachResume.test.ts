import { describe, expect, it } from 'vitest';
import type { NavEdge, Waypoint } from '@extalia/office';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { DoorTraffic, doorAxes, type DoorHit, type DoorInfo, type WalkerInfo } from '../src/office/scene/interior/doorTraffic';
import type { Point3 } from '../src/office/scene/layout';
import { createMover, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import type { OfficeNavigation, RouteStep } from '../src/office/scene/movement/navGraph';
import type { WalkingNeighbor } from '../src/office/scene/movement/naturalWalking';

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };
const DT = 1 / 30;
type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };
function intersects(from: Readonly<Point3>, to: Readonly<Point3>, rect: Rect, radius: number): boolean {
  let enter = 0, exit = 1;
  for (const [axis, min, max] of [[0, rect.minX, rect.maxX], [2, rect.minZ, rect.maxZ]] as const) {
    const start = from[axis], delta = to[axis] - start;
    if (Math.abs(delta) < 1e-8) { if (start < min - radius || start > max + radius) return false; }
    else {
      const a = (min - radius - start) / delta, b = (max + radius - start) / delta;
      enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b));
      if (enter > exit) return false;
    }
  }
  return true;
}

/** Parking moved the head to the other side of a table; the original aisle remains valid from its old origin. */
function fixture(side: 1 | -1 = 1, protectedPrefix?: 'portal' | 'stairs') {
  let now = 0, extraBlock = false, closedAisle = false;
  let neighbors: WalkingNeighbor[] = [];
  const at = (x: number, z: number): Point3 => [x, 0, side * z];
  const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 1.6, height: 2.55, openAngle: Math.PI / 2, sliding: false };
  const portals: DoorHit[] = [{ id: 'main', door }];
  if (protectedPrefix === 'portal') portals.push({ id: 'side-door', door: { ...door, center: at(.75, 1.3), yaw: Math.PI / 2, clearWidth: .8 } });
  const tracked = new Map<string, WalkerInfo>();
  const doors = new DoorTraffic({ forEachDoor: visit => portals.forEach(hit => visit(hit.id, hit.door)), forEachWalker: visit => tracked.forEach(visit) }, () => now);
  const mover = createMover('parked-head', gaitParameters(), at(1.48, 2.3), 0, false);
  const near = at(0, .8), destination = at(0, -4);
  const steps: RouteStep[] = [{ kind: 'walk', node: 'old-aisle', to: at(-3.885, .65), stairs: false },
    ...(protectedPrefix === 'stairs' ? [{ kind: 'walk' as const, node: 'stair-turn', to: [0, .4, side * 1.6] as Point3, stairs: true }] : []),
    { kind: 'walk', node: 'near-door', to: near, stairs: false }, { kind: 'walk', node: 'threshold', to: at(0, 0), stairs: false },
    { kind: 'walk', node: 'inside', to: at(0, -.8), stairs: false }, { kind: 'walk', node: 'goal', to: destination, stairs: false }];
  const waypoints = new Map<string, Waypoint>([['parked', { id: 'parked', floorId: 'floor-1', kind: 'corridor', position: [...mover.position] }]]);
  for (const step of steps) if (step.kind === 'walk') waypoints.set(step.node, { id: step.node, floorId: 'floor-1', kind: ['near-door', 'threshold', 'inside'].includes(step.node) ? 'door' : 'corridor', position: step.to });
  const edges = new Map<string, NavEdge[]>([...waypoints.keys()].map(id => [id, []]));
  let previous = 'parked';
  for (const step of steps) {
    const a = waypoints.get(previous)!.position, b = waypoints.get(step.node)!.position;
    const cost = Math.hypot(...a.map((value, axis) => value - b[axis]!) as Point3);
    edges.get(previous)!.push({ to: step.node, cost }); edges.get(step.node)!.push({ to: previous, cost }); previous = step.node;
  }
  const nodes = new Map([...waypoints].map(([id, point]) => [id, { id, floorId: point.floorId, pos: { x: point.position[0], y: point.position[2] } }]));
  const navigation: OfficeNavigation = { graph: { nodes, edges },
    waypoints, edges: [], connectors: [], seats: new Map(), aisles: new Map(), elevatorEdges: new Map(), entryId: 'parked' };
  const box = (minX: number, maxX: number, minZ: number, maxZ: number): Rect => ({ minX, maxX, minZ: Math.min(side * minZ, side * maxZ), maxZ: Math.max(side * minZ, side * maxZ) });
  const table = box(-.4, .4, 1.9, 2.25), blockedBridge = box(.7, .8, 1.3, 1.6);
  const wall = [box(-8, -.8, -.04, .04), box(.8, 8, -.04, .04)];
  const walkable: NonNullable<MovementEnv['walkable']> = (from, to, radius = .29) =>
    ![table, ...wall, ...(extraBlock ? [blockedBridge] : []), ...(closedAisle ? [box(-8, 8, 1.1, 1.2)] : [])].some(rect => intersects(from, to, rect, radius));
  const goal = { kind: 'leave' as const, node: 'goal' };
  mover.goal = goal; mover.steps = steps; mover.lastNode = 'parked'; mover.phase = 'doorwork';
  mover.door = { id: 'main', door, kind: 'wait', beat: 'reserve', side, entrySide: side, hand: 1, timer: 0, path: null, queueIndex: 1 };
  const tail = at(-1.5, 4.4);
  tracked.set('tail', { id: 'tail', position: tail, target: at(0, 0), updatedAt: now });
  doors.queue('main', door, mover.id, mover.position, side); doors.queue('main', door, 'tail', tail, side);
  const env: MovementEnv = { navigation, elevators, doors, walkable, nearbyWalkers: () => neighbors,
    trackWalker(id, position, target) { if (position && target) tracked.set(id, { id, position: [...position], target: [...target], updatedAt: now }); else tracked.delete(id); } };
  const tick = () => {
    now += DT * 1000;
    doors.queue('main', door, 'tail', tail, side);
    const before: Point3 = [...mover.position];
    stepMover(mover, DT, env);
    expect(Math.hypot(...mover.position.map((value, axis) => value - before[axis]!) as Point3)).toBeLessThan(.08);
    expect(walkable(before, mover.position)).toBe(true);
    expect(mover.goal).toBe(goal);
    expect(mover.recovery.attempts).toBe(0);
    if (doorAxes(door, before).through * side >= 0 && doorAxes(door, mover.position).through * side < 0) expect(doors.queueStatus('main', mover.id).head).toBe(mover.id);
    if (mover.phase !== 'vanishing' && mover.phase !== 'gone') expect(mover.opacity).toBe(1);
  };
  const finish = () => {
    for (let frame = 0; frame < 30 * 25 && mover.phase !== 'gone'; frame++) tick();
    expect(mover.phase).toBe('gone'); expect(mover.position).toEqual(destination);
    expect(doors.queueStatus('main', 'tail')).toMatchObject({ head: 'tail', ahead: 0, count: 1 });
  };
  return { mover, doors, door, side, near, goal, env, tick, finish, walkable, portals,
    blockStatic(value: boolean) { extraBlock = value; }, setNeighbors(value: WalkingNeighbor[]) { neighbors = value; },
    closeAisle(value: boolean) { closedAisle = value; },
    addBend(position: Point3) {
      waypoints.set('safe-bend', { id: 'safe-bend', floorId: 'floor-1', kind: 'corridor', position });
      nodes.set('safe-bend', { id: 'safe-bend', floorId: 'floor-1', pos: { x: position[0], y: position[2] } });
      edges.set('safe-bend', []);
      for (const id of ['parked', 'near-door']) {
        const point = waypoints.get(id)!.position, cost = Math.hypot(point[0] - position[0], point[2] - position[2]);
        edges.get('safe-bend')!.push({ to: id, cost }); edges.get(id)!.push({ to: 'safe-bend', cost });
      }
    } };
}

describe('door approach after queue parking', () => {
  it.each([1, -1] as const)('rejoins the visible same-face prefix around a table while retaining goal and FIFO: side=%s', side => {
    const h = fixture(side);
    expect(h.walkable(h.mover.position, h.mover.steps[0]!.kind === 'walk' ? h.mover.steps[0]!.to : h.near)).toBe(false);
    expect(h.walkable(h.mover.position, h.near)).toBe(true);
    let reachedPrefix = false;
    for (let frame = 0; frame < 90; frame++) {
      h.tick();
      reachedPrefix ||= Math.hypot(h.mover.position[0] - h.near[0], h.mover.position[2] - h.near[2]) < .04;
    }
    expect(reachedPrefix).toBe(true);
    h.finish();
  });

  it('rejoins through a clear authored bend when every direct prefix bridge crosses furniture', () => {
    const h = fixture(), bend: Point3 = [1.48, 0, .65];
    h.blockStatic(true); h.addBend(bend);
    expect(h.walkable(h.mover.position, h.near)).toBe(false);
    expect(h.walkable(h.mover.position, bend)).toBe(true);
    expect(h.walkable(bend, h.near)).toBe(true);
    let visitedBend = false;
    for (let frame = 0; frame < 120; frame++) {
      h.tick();
      visitedBend ||= Math.hypot(h.mover.position[0] - bend[0], h.mover.position[2] - bend[2]) < .05;
    }
    expect(visitedBend).toBe(true);
    h.finish();
  });

  it('retains a statically blocked prefix until the safe direct bridge clears', () => {
    const h = fixture(); h.closeAisle(true);
    for (let frame = 0; frame < 3; frame++) h.tick();
    expect(h.mover.steps[h.mover.stepIndex]?.node).toBe('old-aisle');
    expect(h.doors.queueStatus('main', h.mover.id).head).toBe(h.mover.id);
    h.closeAisle(false); h.finish();
  });

  it('does not take an occupied bridge and resumes the same goal after the peer clears', () => {
    const h = fixture(), body: WalkingNeighbor = { id: 'passing-peer', position: [0, 0, .8], velocity: [0, 0, 0] };
    h.setNeighbors([body]);
    for (let frame = 0; frame < 3; frame++) {
      h.tick();
      expect(Math.hypot(h.mover.position[0] - body.position[0], h.mover.position[2] - body.position[2])).toBeGreaterThan(.6);
    }
    expect(h.mover.steps[h.mover.stepIndex]?.node).toBe('old-aisle');
    h.setNeighbors([]); h.finish();
  });

  it('does not skip an unhandled side portal when reconnecting from a parked position', () => {
    const h = fixture(1, 'portal');
    for (let frame = 0; frame < 3; frame++) h.tick();
    expect(h.mover.steps[h.mover.stepIndex]?.node).toBe('old-aisle');
    expect(h.doors.amount('side-door')).toBe(0);
    expect(h.doors.queueStatus('main', h.mover.id).head).toBe(h.mover.id);
  });

  it('preserves a protected stair transition before later same-floor doorway samples', () => {
    const h = fixture(1, 'stairs');
    for (let frame = 0; frame < 3; frame++) h.tick();
    expect(h.mover.steps[h.mover.stepIndex]?.node).toBe('old-aisle');
    expect(h.mover.steps.some(step => step.kind === 'walk' && step.node === 'stair-turn' && step.stairs)).toBe(true);
    expect(h.mover.goal).toBe(h.goal);
  });
});
