import { describe, expect, it } from 'vitest';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { DoorTraffic } from '../src/office/scene/interior/doorTraffic';
import type { Point3 } from '../src/office/scene/layout';
import { createMover, routeFrom, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { officeNavigation } from '../src/office/scene/movement/navGraph';
import { OFFICE_DOOR_PORTALS } from './fixtures/officeDoorPortals';

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };

describe('retained yields between adjacent door groups', () => {
  it('breaks reciprocal parked yields without letting a follower bypass its own head', () => {
    const navigation = officeNavigation();
    const engineering = OFFICE_DOOR_PORTALS.find(door => door.id === 'floor-1.engineering.south')!;
    const operations = OFFICE_DOOR_PORTALS.find(door => door.id === 'floor-1.operations.entry')!;
    const entries = [
      { id: 'foreign-middle', door: operations, position: [-5.149247, 0, 10.907761] as Point3, seatId: 'operations.station-1' },
      { id: 'z-local-head', door: engineering, position: [-8.099155, 0, 9.999814] as Point3, seatId: 'engineering.pod-a.seat-nw' },
      { id: 'a-local-follower', door: engineering, position: [-7.99284, 0, 9.06866] as Point3, seatId: 'engineering.pod-d.seat-nw' },
    ];
    const movers = entries.map(entry => createMover(entry.id, gaitParameters(), entry.position, 0, false));
    const targetOf = (mover: typeof movers[number]): Readonly<Point3> => {
      const step = mover.steps[mover.stepIndex];
      return mover.target ?? (step?.kind === 'walk' ? step.to : mover.position);
    };
    let now = 0;
    const doors = new DoorTraffic({ forEachDoor: visit => [engineering, operations].forEach(door => visit(door.id, door)),
      forEachWalker: visit => movers.filter(mover => mover.phase !== 'gone').forEach(mover => visit({ id: mover.id, position: mover.position,
        target: targetOf(mover), updatedAt: now })) }, () => now);
    const env: MovementEnv = { navigation, elevators, doors, walkable: () => true,
      nearbyWalkers: id => movers.filter(mover => mover.id !== id && mover.phase !== 'gone').map(mover => ({ id: mover.id,
        position: mover.position, target: targetOf(mover),
        velocity: [0, 0, 0] as Point3 })) };
    for (const [index, mover] of movers.entries()) {
      const entry = entries[index]!, seat = navigation.seats.get(entry.seatId)!;
      expect(routeFrom(mover, 'f1.corridor-operations', { kind: 'seat', seat }, env, false)).toBe(true);
      mover.phase = 'doorwork';
      mover.door = { id: entry.door.id, door: entry.door, kind: 'wait', beat: 'reserve', side: index === 0 ? -1 : 1,
        entrySide: index === 0 ? -1 : 1, hand: 1, timer: 30, path: [], queueIndex: index === 2 ? 1 : 0,
        queueYield: { id: entries[index === 0 ? 1 : 0]!.id, origin: [...mover.position], direction: index === 0 ? [1, 0] : [-1, 0] } };
      doors.setActiveDoor(mover.id, entry.door.id);
      doors.queue(entry.door.id, entry.door, mover.id, mover.position, mover.door.entrySide);
    }
    const head = movers[1]!, follower = movers[2]!;
    expect(doors.queueStatus(engineering.id).head).toBe(head.id);
    now += 1000 / 30; stepMover(head, 1 / 30, env);
    expect(head.door?.queueYield).toBeUndefined();
    expect(doors.queueStatus(engineering.id).head).toBe(head.id);
    stepMover(follower, 1 / 30, env);
    expect(follower.door?.queueYield).toBeUndefined();
    for (let frame = 0; frame < 30 * 150 && !movers.every((mover, index) => mover.phase === 'seated' && mover.seat?.seatId === entries[index]!.seatId); frame++) {
      now += 1000 / 30;
      for (const mover of movers) {
        const before: Point3 = [...mover.position]; stepMover(mover, 1 / 30, env);
        expect(Math.hypot(...mover.position.map((value, axis) => value - before[axis]!) as Point3)).toBeLessThan(.1);
        expect(mover.opacity).toBe(1);
      }
      for (let first = 0; first < movers.length; first++) for (let second = first + 1; second < movers.length; second++) {
        expect(Math.hypot(movers[first]!.position[0] - movers[second]!.position[0], movers[first]!.position[2] - movers[second]!.position[2])).toBeGreaterThanOrEqual(.56 - 1e-6);
      }
    }
    for (const [index, mover] of movers.entries()) {
      expect(mover.phase).toBe('seated'); expect(mover.seat?.seatId).toBe(entries[index]!.seatId);
    }
    for (const door of [engineering, operations]) {
      expect(doors.queueStatus(door.id).count).toBe(0); expect(doors.amount(door.id)).toBe(0);
    }
  });
});
