import { describe, expect, it } from 'vitest';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { doorAxes, DoorTraffic, type WalkerInfo } from '../src/office/scene/interior/doorTraffic';
import type { Point3 } from '../src/office/scene/layout';
import { createMover, routeFrom, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { officeNavigation } from '../src/office/scene/movement/navGraph';
import { OFFICE_DOOR_PORTALS } from './fixtures/officeDoorPortals';

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };

describe('front entrance opposing traffic recovery', () => {
  it.each(['stationary', 'measured'] as const)('clears reciprocal entry/exit goals with actual portal nodes and %s body velocities', velocityMode => {
    const navigation = officeNavigation();
    const outside = navigation.waypoints.get('f1.entry-outside')!;
    const inside = navigation.waypoints.get('f1.lobby-inside')!;
    const entrance = OFFICE_DOOR_PORTALS.find(portal => portal.sliding && Math.abs(portal.center[0]) < .1 && Math.abs(portal.center[2] + 19) < .1)!;
    expect(entrance).toBeDefined();
    let now = 0;
    const tracked = new Map<string, WalkerInfo>();
    const doors = new DoorTraffic({ forEachDoor: visit => visit(entrance.id, entrance), forEachWalker: visit => { for (const walker of tracked.values()) visit(walker); } }, () => now);
    const movers = [createMover('arriving', gaitParameters(), [...outside.position], 0, false), createMover('leaving', gaitParameters(), [...inside.position], Math.PI, false)];
    const velocities = new Map<string, Point3>();
    const env: MovementEnv = {
      navigation, elevators, doors,
      // Clear lobby corridor / forecourt, bounded by the actual entrance walls.
      walkable: (from, to, radius = .29) => {
        for (let sample = 0; sample <= 20; sample++) {
          const t = sample / 20, x = from[0] + (to[0] - from[0]) * t, z = from[2] + (to[2] - from[2]) * t;
          if (Math.abs(z + 19) < radius + .1 && Math.abs(x) > entrance.clearWidth / 2 - radius) return false;
        }
        return true;
      },
      nearbyWalkers: (id, point) => movers.filter(mover => mover.id !== id && mover.phase !== 'gone' && mover.phase !== 'vanishing' && Math.abs(mover.position[1] - point[1]) < .8)
        .map(mover => ({ id: mover.id, position: [...mover.position] as Point3, velocity: velocityMode === 'measured' ? velocities.get(mover.id) ?? [0, 0, 0] as Point3 : [0, 0, 0] as Point3 })),
      trackWalker: (id, position, target) => { if (position && target) tracked.set(id, { id, position: [...position], target: [...target], updatedAt: now }); else tracked.delete(id); },
    };
    expect(routeFrom(movers[0]!, outside.id, { kind: 'leave', node: inside.id }, env, false)).toBe(true);
    expect(routeFrom(movers[1]!, inside.id, { kind: 'leave', node: outside.id }, env, false)).toBe(true);

    for (let frame = 0; frame < 30 * 60; frame++) {

      const before = movers.map(mover => [...mover.position] as Point3);
      doors.slideStep(entrance.id, entrance, 1 / 30);
      for (const mover of movers) stepMover(mover, 1 / 30, env);
      for (const [index, mover] of movers.entries()) velocities.set(mover.id, [(mover.position[0] - before[index]![0]) * 30, 0, (mover.position[2] - before[index]![2]) * 30]);
      if (movers.every(mover => mover.phase !== 'gone' && mover.phase !== 'vanishing')) expect(Math.hypot(movers[0]!.position[0] - movers[1]!.position[0], movers[0]!.position[2] - movers[1]!.position[2])).toBeGreaterThanOrEqual(.54);
      now += 1000 / 30;
      if (movers.every(mover => mover.phase === 'gone')) break;
    }

    const outcome = movers.map(mover => ({ id: mover.id, phase: mover.phase, position: mover.position, goal: mover.goal, step: mover.steps[mover.stepIndex] }));
    expect(outcome, JSON.stringify(outcome)).toMatchObject([
      { id: 'arriving', phase: 'gone', goal: { kind: 'leave', node: inside.id } },
      { id: 'leaving', phase: 'gone', goal: { kind: 'leave', node: outside.id } },
    ]);
    expect(tracked.size).toBe(0);
  });
});

it('never recovers through an entrance leaf that stays shut', () => {
  const navigation = officeNavigation();
  const outside = navigation.waypoints.get('f1.entry-outside')!;
  const entrance = OFFICE_DOOR_PORTALS.find(portal => portal.id === 'floor-1.lobby.exterior')!;
  const doors = new DoorTraffic({ forEachDoor: visit => visit(entrance.id, entrance), forEachWalker() {} }, () => 0);
  const env: MovementEnv = { navigation, elevators, doors, walkable: () => true, nearbyWalkers: () => [] };
  const mover = createMover('closed-entrance', gaitParameters(), [...outside.position], 0, false);
  const goal = { kind: 'leave' as const, node: 'f1.lobby-inside' };
  routeFrom(mover, outside.id, goal, env, false);
  const side = Math.sign(doorAxes(entrance, outside.position).through);
  for (let frame = 0; frame < 30 * 30; frame++) {
    stepMover(mover, 1 / 30, env);
    expect(doorAxes(entrance, mover.position).through * side).toBeGreaterThanOrEqual(.28);
  }
  expect(doors.amount(entrance.id)).toBe(0);
  expect(mover.goal).toBe(goal);
  expect(mover.id).toBe('closed-entrance');
  expect(mover.phase).not.toMatch(/^(gone|vanishing)$/);
  expect(mover.recovery.attempts).toBe(3);
});
