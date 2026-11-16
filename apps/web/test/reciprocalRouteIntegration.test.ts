import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import type { Point3 } from '../src/office/scene/layout';
import { CrowdWatch } from '../src/office/scene/movement/crowdWatch';
import { beginCrowdYield, createMover, crowdWatchActor, routeFrom, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { WalkingClearance } from '../src/office/scene/movement/naturalClearance';
import type { OfficeNavigation } from '../src/office/scene/movement/navGraph';

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };

/** Two long shelves leave a single-body aisle and clear space around their ends. */
function furnishedAisles(alternateGraph: boolean) {
  const root = new Group(), field = new WalkingClearance();
  for (const z of [-1, 1]) {
    const shelf = new Mesh(new BoxGeometry(5.4, 1.8, 1), new MeshBasicMaterial());
    shelf.position.set(0, .9, z); root.add(shelf);
  }
  field.rebuild([root]);
  const points: Point3[] = [[-4, 0, 0], [4, 0, 0], [-4, 0, 2.6], [4, 0, 2.6]];
  const graphPoints = alternateGraph ? points : points.slice(0, 2);
  const links = alternateGraph ? [[0, 1], [0, 2], [2, 3], [3, 1]] : [[0, 1]];
  const waypoints = new Map(graphPoints.map((position, i) => [`aisle-${i}`, { id: `aisle-${i}`, floorId: 'floor-1', kind: 'corridor' as const, position }]));
  const navigation: OfficeNavigation = {
    graph: {
      nodes: new Map([...waypoints].map(([id, node]) => [id, { id, floorId: node.floorId, pos: { x: node.position[0], y: node.position[2] } }])),
      edges: new Map(graphPoints.map((point, i) => [`aisle-${i}`, links.filter(link => link.includes(i)).map(link => {
        const other = link[0] === i ? link[1]! : link[0]!;
        return { to: `aisle-${other}`, cost: Math.hypot(point[0] - points[other]![0], point[2] - points[other]![2]) };
      })])),
    },
    waypoints, edges: [], connectors: [], aisles: new Map(), seats: new Map(), elevatorEdges: new Map(), entryId: 'aisle-0',
  };
  return { field, navigation, points };
}

describe('reciprocal furniture-aisle routes', () => {
  it('recovers after a temporary crowd leaves the bypass, even after earlier escape searches fail', () => {
    const { field, navigation, points } = furnishedAisles(false);
    const mover = createMover('walking', gaitParameters(), [-1.2, 0, 0], 0, false);
    const goal = { kind: 'leave' as const, node: 'aisle-1' };
    let seconds = 0, blockedSweeps = 0, minSeparation = Infinity, maxStep = 0;
    const bodies = () => [{ id: 'protected', position: [0, 0, 0] as Point3, velocity: [0, 0, 0] as Point3 },
      ...(seconds < 48 ? [{ id: 'temporary-crowd', position: [-3.3, 0, 0] as Point3, velocity: [0, 0, 0] as Point3 }] : [])];
    const env: MovementEnv = { navigation, elevators, walkable: field.segmentClear, nearbyWalkers: bodies };
    expect(routeFrom(mover, 'aisle-0', goal, env, false)).toBe(true);
    for (let frame = 0; frame < 30 * 150 && mover.phase !== 'gone'; frame++) {
      seconds = frame / 30;
      const before: Point3 = [...mover.position]; stepMover(mover, 1 / 30, env);
      maxStep = Math.max(maxStep, Math.hypot(...mover.position.map((value, axis) => value - before[axis]!) as Point3));
      if (!field.segmentClear(before, mover.position, .29)) blockedSweeps++;
      for (const body of bodies()) minSeparation = Math.min(minSeparation, Math.hypot(mover.position[0] - body.position[0], mover.position[2] - body.position[2]));
      if (seconds < 48) expect(['walking', 'doorwork']).toContain(mover.phase);
    }
    expect({ blockedSweeps, phase: mover.phase, goal: mover.goal }).toEqual({ blockedSweeps: 0, phase: 'gone', goal });
    expect(maxStep).toBeLessThan(.08); expect(minSeparation).toBeGreaterThanOrEqual(.55);
    expect(Math.hypot(...mover.position.map((value, axis) => value - points[1]![axis]!) as Point3)).toBeLessThan(1e-8);
  });

  it('takes a multi-turn route around a protected occupant instead of repeatedly retrying the same aisle', () => {
    const { field, navigation, points } = furnishedAisles(false);
    const mover = createMover('walking', gaitParameters(), points[0]!, 0, false);
    const goal = { kind: 'leave' as const, node: 'aisle-1' };
    const env: MovementEnv = { navigation, elevators, walkable: field.segmentClear,
      nearbyWalkers: () => [{ id: 'protected', position: [0, 0, 0], velocity: [0, 0, 0] }],
    };
    expect(routeFrom(mover, 'aisle-0', goal, env, false)).toBe(true);
    let maxStep = 0, minSeparation = Infinity, blockedSweeps = 0;
    for (let frame = 0; frame < 30 * 120 && mover.phase !== 'gone'; frame++) {
      const before: Point3 = [...mover.position];
      stepMover(mover, 1 / 30, env);
      maxStep = Math.max(maxStep, Math.hypot(...mover.position.map((value, axis) => value - before[axis]!) as Point3));
      minSeparation = Math.min(minSeparation, Math.hypot(mover.position[0], mover.position[2]));
      if (!field.segmentClear(before, mover.position, .29)) blockedSweeps++;
    }
    expect(blockedSweeps).toBe(0);
    expect(maxStep).toBeLessThan(.08);
    expect(minSeparation).toBeGreaterThanOrEqual(.55);
    expect({ phase: mover.phase, goal: mover.goal }).toEqual({ phase: 'gone', goal });
    expect(Math.hypot(...mover.position.map((value, axis) => value - points[1]![axis]!) as Point3)).toBeLessThan(1e-8);
  });

  it.each([[false, false], [true, false], [false, true], [true, true]] as const)('finishes opposing routes instead of retreating and rejoining the same shelf aisle (reverse update: %s, alternate graph: %s)', (reverse, alternateGraph) => {
    const { field, navigation, points } = furnishedAisles(alternateGraph);
    const movers = [createMover('crossing-a', gaitParameters(), points[0]!, 0, false), createMover('crossing-b', gaitParameters(), points[1]!, 0, false)];
    const goals = [{ kind: 'leave' as const, node: 'aisle-1' }, { kind: 'leave' as const, node: 'aisle-0' }];
    const env: MovementEnv = { navigation, elevators, walkable: field.segmentClear,
      nearbyWalkers: id => movers.filter(other => other.id !== id && other.phase !== 'gone').map(other => ({ id: other.id,
        position: [...other.position] as Point3, velocity: other.position.map((value, axis) => (value - other.prev[axis]!) * 30) as Point3,
        ...(other.target ? { target: other.target } : {}),
      })),
    };
    for (const [i, mover] of movers.entries()) expect(routeFrom(mover, `aisle-${i}`, goals[i]!, env, false)).toBe(true);
    const watch = new CrowdWatch();
    let minSeparation = Infinity, maxStep = 0, blockedSweeps = 0, prematureFades = 0;
    for (let frame = 0; frame < 30 * 120 && movers.some(mover => mover.phase !== 'gone'); frame++) {
      const yielding = movers.some(mover => mover.crowdYield);
      const decision = watch.update(movers.filter(mover => mover.phase !== 'gone').map(mover => crowdWatchActor(mover, yielding)), 1 / 30);
      if (!yielding && decision.initiative) {
        const mover = movers.find(actor => actor.id === decision.initiative!.actorId)!;
        if (!beginCrowdYield(mover, env)) watch.failed(mover.id);
      }
      for (const mover of reverse ? [...movers].reverse() : movers) {
        const before: Point3 = [...mover.position];
        stepMover(mover, 1 / 30, env);
        maxStep = Math.max(maxStep, Math.hypot(...mover.position.map((value, axis) => value - before[axis]!) as Point3));
        if (!field.segmentClear(before, mover.position, .29)) blockedSweeps++;
        const destination = navigation.waypoints.get(goals[movers.indexOf(mover)]!.node)!.position;
        if (mover.opacity < 1 && Math.hypot(mover.position[0] - destination[0], mover.position[2] - destination[2]) > .03) prematureFades++;
      }
      if (movers.every(mover => mover.phase !== 'gone')) minSeparation = Math.min(minSeparation,
        Math.hypot(movers[0]!.position[0] - movers[1]!.position[0], movers[0]!.position[2] - movers[1]!.position[2]));
    }
    expect({ blockedSweeps, prematureFades }).toEqual({ blockedSweeps: 0, prematureFades: 0 });
    expect(maxStep).toBeLessThan(.08);
    expect(minSeparation).toBeGreaterThanOrEqual(.55);
    expect(movers.map(mover => ({ phase: mover.phase, goal: mover.goal }))).toEqual([
      { phase: 'gone', goal: goals[0] }, { phase: 'gone', goal: goals[1] },
    ]);
    for (const [index, mover] of movers.entries()) expect(Math.hypot(...mover.position.map((value, axis) => value - points[1 - index]![axis]!) as Point3)).toBeLessThan(1e-8);
  });
});
