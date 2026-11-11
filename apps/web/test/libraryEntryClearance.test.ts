import { expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import { WalkingClearance } from '../src/office/scene/movement/naturalClearance';
import { officeNavigation, planRoute } from '../src/office/scene/movement/navGraph';
import { naturalRoute } from '../src/office/scene/movement/naturalWalking';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { createMover, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import type { Point3 } from '../src/office/scene/layout';

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };

it('uses the authored library entry turn around the rendered plant corner', () => {
  const root = new Group(), plant = new Mesh(new BoxGeometry(.634, .319, .634), new MeshBasicMaterial());
  plant.position.set(-15.4, 1.6875, 12.2); root.add(plant);
  const field = new WalkingClearance(); field.rebuild([root]);
  const navigation = officeNavigation(), inside = navigation.waypoints.get('f1.library-inside')!.position;
  const north = navigation.waypoints.get('f1.library-aisle-north')!.position;
  expect(field.segmentClear(inside, north, .29)).toBe(false);
  const route = planRoute('f1.library-inside', 'f1.library-aisle-south', navigation)!;
  expect(route.steps.some(step => step.node === 'f1.library-entry-turn')).toBe(true);
  let from = inside;
  for (const step of route.steps) {
    expect(step.kind).toBe('walk');
    if (step.kind !== 'walk') throw new Error('Unexpected room connector');
    expect(field.segmentClear(from, step.to, .29)).toBe(true); from = step.to;
  }
  // The turn is an ordinary recoverable approach, but curve shaping must retain it.
  expect(navigation.waypoints.get('f1.library-entry-turn')!.kind).toBe('approach');
  for (const seed of [.05, .3, .6, .95]) {
    const steps = naturalRoute(inside, route.steps, navigation, seed, field.segmentClear);
    expect(steps.find(step => step.node === 'f1.library-entry-turn')).not.toHaveProperty('natural');
    let from = inside;
    for (const step of steps) if (step.kind === 'walk') {
      expect(field.segmentClear(from, step.to, .29)).toBe(true); from = step.to;
    }
  }
});

it('walks an exhausted character away from the plant into the recoverable protected entry turn', () => {
  const root = new Group(), plant = new Mesh(new BoxGeometry(.634, .319, .634), new MeshBasicMaterial());
  plant.position.set(-15.4, 1.6875, 12.2); root.add(plant);
  const field = new WalkingClearance(); field.rebuild([root]);
  const navigation = officeNavigation(), turn = navigation.waypoints.get('f1.library-entry-turn')!.position;
  const mover = createMover('corner-recovery', gaitParameters(), [-16.007162935484992, 0, 12.481941044088307], 0, false);
  const goal = { kind: 'leave' as const, node: 'f1.library-aisle-south' };
  mover.goal = goal; mover.recovery.goal = goal.node; mover.recovery.attempts = 3;
  mover.steps = [{ kind: 'walk', node: 'f1.library-aisle-north', to: [-15.6, 0, 13], stairs: false }];
  const env: MovementEnv = { navigation, elevators, walkable: field.segmentClear, nearbyWalkers: () => [] };
  let reachedTurn = false;
  for (let frame = 0; frame < 900 && mover.phase !== 'gone'; frame++) {
    const before: Point3 = [...mover.position]; stepMover(mover, 1 / 30, env);
    expect(field.segmentClear(before, mover.position, .29)).toBe(true);
    expect(Math.hypot(...mover.position.map((v, i) => v - before[i]!) as Point3)).toBeLessThan(.08);
    if (mover.phase !== 'vanishing' && (mover.phase as string) !== 'gone') expect(mover.opacity).toBe(1);
    reachedTurn ||= Math.hypot(mover.position[0] - turn[0], mover.position[2] - turn[2]) < .03;
  }
  expect(reachedTurn).toBe(true); expect(mover.phase).toBe('gone');
  expect(mover.position).toEqual(navigation.waypoints.get(goal.node)!.position);
  expect(mover.goal).toBe(goal); expect(mover.recovery.attempts).toBe(3);
});
