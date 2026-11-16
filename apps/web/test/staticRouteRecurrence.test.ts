import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import type { Point3 } from '../src/office/scene/layout';
import { createMover, routeFrom, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { WalkingClearance } from '../src/office/scene/movement/naturalClearance';
import type { OfficeNavigation } from '../src/office/scene/movement/navGraph';

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };

describe('ordinary static-route recurrence without nearby peers', () => {
  it.each([
    { alternate: true, stageGoal: false, clearsAt: Infinity, scenario: 'takes the clear authored corridor around a blocked later edge' },
    { alternate: false, stageGoal: false, clearsAt: 40, scenario: 'retains its intent when no alternate exists and resumes after furniture moves' },
    { alternate: true, stageGoal: true, clearsAt: Infinity, scenario: 'validates ordinary walking to a seat stage before controlled contact begins' },
  ])('$scenario', ({ alternate, stageGoal, clearsAt }) => {
    const root = new Group(), field = new WalkingClearance();
    // The cheapest graph path has a valid first leg, then crosses this shelf.
    // Its 5 m depth also prevents a single sideways recovery bend from clearing it.
    const geometry = new BoxGeometry(.4, 1.8, 5), material = new MeshBasicMaterial();
    const shelf = new Mesh(geometry, material); shelf.position.set(1.6, .9, 0); root.add(shelf);
    field.rebuild([root]);
    const points: Point3[] = [[-4, 0, 0], [0, 0, 0], [4, 0, 0], [-4, 0, 4], [4, 0, 4]];
    const nodeId = (index: number) => stageGoal && index === 2 ? 'seat:fixture:stage' : `aisle-${index}`;
    const links: readonly (readonly [number, number])[] = alternate
      ? [[0, 1], [1, 2], [0, 3], [3, 4], [4, 2]] : [[0, 1], [1, 2]];
    const waypoints = new Map(points.map((position, i) => [nodeId(i), {
      id: nodeId(i), floorId: 'floor-1', kind: 'corridor' as const, position,
    }]));
    const navigation: OfficeNavigation = {
      graph: {
        nodes: new Map([...waypoints].map(([id, node]) => [id, { id, floorId: node.floorId, pos: { x: node.position[0], y: node.position[2] } }])),
        edges: new Map(points.map((point, i) => [nodeId(i), links.filter(link => link[0] === i || link[1] === i).map(link => {
          const other = link[0] === i ? link[1] : link[0];
          return { to: nodeId(other), cost: Math.hypot(point[0] - points[other]![0], point[2] - points[other]![2]) };
        })])),
      },
      waypoints, edges: [], connectors: [], aisles: new Map(), seats: new Map(), elevatorEdges: new Map(), entryId: 'aisle-0',
    };
    const mover = createMover('solo', gaitParameters(), points[0]!, 0, false);
    const goal = { kind: 'leave' as const, node: nodeId(2) };
    const env: MovementEnv = { navigation, elevators, walkable: field.segmentClear, nearbyWalkers: () => [] };
    let blockedSweeps = 0, maxStep = 0, frames = 0;
    try {
      expect(field.segmentClear(points[0]!, points[1]!, .29)).toBe(true);
      expect(field.segmentClear(points[1]!, points[2]!, .29)).toBe(false);
      for (const [from, to] of [[0, 3], [3, 4], [4, 2]]) expect(field.segmentClear(points[from!]!, points[to!]!, .29)).toBe(true);
      expect(routeFrom(mover, 'aisle-0', goal, env, false)).toBe(true);
      for (; frames < 30 * 120 && mover.phase !== 'gone'; frames++) {
        if (frames === clearsAt * 30) {
          expect(mover.phase).toBe('walking');
          expect(mover.goal).toEqual(goal);
          root.remove(shelf); field.rebuild([root]);
        }
        const before: Point3 = [...mover.position];
        stepMover(mover, 1 / 30, env);
        maxStep = Math.max(maxStep, Math.hypot(...mover.position.map((value, axis) => value - before[axis]!) as Point3));
        if (!field.segmentClear(before, mover.position, .29)) blockedSweeps++;
      }
      expect({ blockedSweeps, goal: mover.goal }).toEqual({ blockedSweeps: 0, goal });
      expect(maxStep).toBeLessThan(.08);
      expect({ phase: mover.phase, seconds: frames / 30 }).toEqual({ phase: 'gone', seconds: expect.any(Number) });
      expect(Math.hypot(...mover.position.map((value, axis) => value - points[2]![axis]!) as Point3)).toBeLessThan(1e-8);
    } finally { field.clear(); geometry.dispose(); material.dispose(); }
  });
});
