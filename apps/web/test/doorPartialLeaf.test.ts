import { describe, expect, it } from 'vitest';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { DoorTraffic, DOOR_SWING_RATE, doorLeafDistance } from '../src/office/scene/interior/doorTraffic';
import type { Point3 } from '../src/office/scene/layout';
import { createMover, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { officeNavigation } from '../src/office/scene/movement/navGraph';
import { OFFICE_DOOR_PORTALS } from './fixtures/officeDoorPortals';

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };

describe('authored approach beside a partial hinged leaf', () => {
  it.each([.15, .35, .44037])('opens a partial leaf %s before walking into its blocked inside marker', amount => {
    const portal = OFFICE_DOOR_PORTALS.find(portal => portal.id === 'floor-3.multi-engine.entry')!;
    expect(portal).toBeDefined();
    const door = portal;
    let now = 0;
    const doors = new DoorTraffic({ forEachDoor: visit => visit(portal.id, door), forEachWalker() {} }, () => now);
    doors.claim(portal.id, 'previous'); doors.hold(portal.id, 'previous', 1, amount / DOOR_SWING_RATE); doors.release(portal.id, 'previous');
    const mover = createMover('partial-leaf-head', gaitParameters(), [.80118, 12.8, -13.53470], 0, false);
    mover.goal = { kind: 'leave', node: 'f3.corridor-multi' };
    mover.steps = [ [.92155, 12.8, -13.48241], [1.25, 12.8, -13.45], [1.25, 12.8, -11.15] ].map((to, index) => ({
      kind: 'walk', node: index === 2 ? 'f3.corridor-multi' : 'f3.multi-inside', to: to as Point3, stairs: false }));
    mover.phase = 'doorwork';
    mover.door = { id: portal.id, door, kind: 'open', beat: 'reserve', side: -1, entrySide: -1, hand: 1, timer: 0, path: null };
    const env: MovementEnv = { navigation: officeNavigation(), elevators, doors, walkable: () => true, nearbyWalkers: () => [] };
    let opened = false, largestStep = 0;
    for (let frame = 0; frame < 30 * 40 && (mover.phase as string) !== 'gone'; frame++) {
      const before: Point3 = [...mover.position];
      now += 1000 / 30; stepMover(mover, 1 / 30, env);
      largestStep = Math.max(largestStep, Math.hypot(...mover.position.map((value, axis) => value - before[axis]!) as Point3));
      opened ||= doors.amount(portal.id) > amount + .01;
      expect(doorLeafDistance(door, doors.amount(portal.id), mover.position)).toBeGreaterThan(.32);
    }
    expect(opened, JSON.stringify({phase:mover.phase,pos:mover.position,act:mover.door,leaf:doors.amount(portal.id),recovery:mover.recovery})).toBe(true);
    expect(largestStep).toBeLessThan(.1);
    expect(mover.phase).toBe('gone');
    expect(mover.position).toEqual([1.25, 12.8, -11.15]);
    expect(doors.amount(portal.id)).toBe(0);
    expect(doors.queueStatus(portal.id).count).toBe(0);
  });
});
