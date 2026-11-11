import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { OFFICE_BUILDING, type Point3 } from '../src/office/scene/layout';
import { liveElevatorAccess } from '../src/office/scene/movement/elevatorAccess';
import { elevatorMovementTarget, elevatorSegmentClear, elevatorWaitingPosition } from '../src/office/scene/movement/elevatorMovement';
import { createMover, stepMover, type ElevatorAccess, type MovementEnv, type Mover } from '../src/office/scene/movement/mover';
import { floorY, officeNavigation, type OfficeFloor } from '../src/office/scene/movement/navGraph';
import { elevatorSnapshot, getElevatorGeometry, requestElevator, resetElevator, tickElevator, type ElevatorId } from '../src/office/scene/prefabs/architecture/elevatorController';

const navigation = officeNavigation();
const landing = (floor: OfficeFloor, id: ElevatorId = 'A'): Point3 => [...navigation.waypoints.get(`f${floor}.elevator-${id}`)!.position];
const walkable = (from: Readonly<Point3>, to: Readonly<Point3>) => Math.max(from[0], to[0]) <= OFFICE_BUILDING.east - .29 + 1e-6;
const separation = (a: Readonly<Point3>, b: Readonly<Point3>) => Math.hypot(a[0] - b[0], a[2] - b[2]);
function passenger(id: string, from: OfficeFloor, to: OfficeFloor, slot: number, liftId: ElevatorId = 'A'): Mover {
  const start = landing(from, liftId), exit = landing(to, liftId);
  const mover = createMover(id, gaitParameters(), elevatorWaitingPosition(start, getElevatorGeometry(liftId), slot), 0, false);
  mover.phase = 'waiting';
  mover.goal = { kind: 'leave', node: `exit-${id}` };
  mover.trip = { id: liftId, from, to, landing: start, exit, stage: 'approach', requested: false, exited: false };
  mover.steps = [{ kind: 'elevator', node: `f${to}.elevator-${liftId}`, elevatorId: liftId, from, to, exit },
    { kind: 'walk', node: `exit-${id}`, to: [19, floorY(to), getElevatorGeometry(liftId).z], stairs: false }];
  return mover;
}
function environment(movers: readonly Mover[], elevators: ElevatorAccess = liveElevatorAccess): MovementEnv {
  return { navigation, elevators, walkable, nearbyWalkers: id => movers.filter(mover => mover.id !== id && mover.phase !== 'gone')
    .map(mover => ({ id: mover.id, position: mover.position, velocity: [0, 0, 0] as Point3, target: mover.target ?? undefined })) };
}
function reset() { for (const id of ['A', 'B'] as const) { resetElevator(id); tickElevator(100, id); } }
beforeEach(reset);
afterEach(reset);

describe('safe elevator landing and cabin movement', () => {
  it('keeps the first twenty waiting slots clear of the exit lane and one another on both lifts', () => {
    for (const id of ['A', 'B'] as const) {
      const lift = getElevatorGeometry(id), origin = landing(3, id);
      const points = Array.from({ length: 20 }, (_, slot) => elevatorWaitingPosition(origin, lift, slot));
      for (const [index, point] of points.entries()) {
        expect(Math.abs(point[2] - lift.z)).toBeGreaterThanOrEqual(1);
        expect(walkable(point, point)).toBe(true);
        for (const other of points.slice(index + 1)) expect(separation(point, other)).toBeGreaterThanOrEqual(1.19);
      }
    }
  });

  it('checks interior furniture and the actual door, bridge and cabin limits outside the slab inset', () => {
    const lift = getElevatorGeometry('A'), from = landing(3), threshold: Point3 = [lift.doorX, floorY(3), lift.z];
    expect(walkable(from, threshold)).toBe(false);
    expect(elevatorSegmentClear('A', from, threshold, walkable)).toBe(true);
    expect(elevatorSegmentClear('A', from, threshold, () => false)).toBe(false);
    expect(elevatorSegmentClear('A', from, [threshold[0], threshold[1], threshold[2] + .65], walkable)).toBe(false);
    expect(elevatorSegmentClear('A', threshold, [lift.x + 2, threshold[1], lift.z], walkable)).toBe(false);
    expect(elevatorSegmentClear('A', threshold, [lift.x, threshold[1], lift.z + 1.2], walkable)).toBe(false);
    expect(elevatorSegmentClear('A', threshold, [lift.x, threshold[1], getElevatorGeometry('B').z], walkable)).toBe(false);
  });

  it('routes a landing approach around physical waiting bodies instead of crossing them', () => {
    const from: Point3 = [22, floorY(3), -1.7], to: Point3 = [23.9, floorY(3), -1.7];
    const blocker = { id: 'waiting', position: [23, floorY(3), -1.7] as Point3, velocity: [0, 0, 0] as Point3 };
    const target = elevatorMovementTarget({}, 'boarding', 'A', from, to, .1, walkable, [blocker], true);
    expect(target).not.toBeNull();
    expect(target![2]).not.toBe(to[2]);
    expect(elevatorMovementTarget({}, 'boarding', 'A', from, to, .1, () => false, [blocker], true)).toBeNull();
  });

  it('moves the old slot-zero waiter away from the landing, allowing an alighting passenger through', () => {
    const lift = getElevatorGeometry('A'), exit = landing(3);
    const waiter = passenger('waiting', 3, 1, 0);
    waiter.position.splice(0, 3, ...exit);
    const exiting = passenger('exiting', 1, 3, 0);
    exiting.phase = 'alighting'; exiting.trip!.stage = 'door'; exiting.trip!.requested = true;
    exiting.position.splice(0, 3, lift.doorX + .6, floorY(3), lift.z);
    const confirm = vi.fn(() => true);
    const access: ElevatorAccess = { ...liveElevatorAccess, request() {}, waitingSlot: () => 0, canBoard: () => false,
      canExit: id => id === 'exiting', confirmExited: confirm, release() {}, progress: () => null };
    const movers = [waiter, exiting], env = environment(movers, access);
    for (let frame = 0; frame < 360 && exiting.trip; frame++) {
      for (const mover of movers) stepMover(mover, 1 / 30, env);
      expect(separation(waiter.position, exiting.position)).toBeGreaterThanOrEqual(.56 - 1e-6);
      if (confirm.mock.calls.length) expect(separation(exiting.position, exit)).toBeLessThan(.002);
    }
    expect(confirm).toHaveBeenCalledExactlyOnceWith('exiting', 'A');
    expect(exiting.trip).toBeNull();
    expect(waiter.position).toEqual(elevatorWaitingPosition(exit, lift, 0));
  });

  it('retains ownership and delays exit confirmation while a real body blocks the landing', () => {
    const lift = getElevatorGeometry('A'), exiting = passenger('exiting', 1, 3, 0), blocker = passenger('blocker', 3, 1, 0);
    exiting.phase = 'alighting'; exiting.trip!.stage = 'door'; exiting.trip!.requested = true;
    exiting.position.splice(0, 3, lift.doorX + .6, floorY(3), lift.z);
    blocker.position.splice(0, 3, ...landing(3)); blocker.phase = 'seated'; blocker.steps = []; blocker.trip = null;
    const confirm = vi.fn(() => true), access: ElevatorAccess = { ...liveElevatorAccess, canExit: () => true, confirmExited: confirm, progress: () => null };
    const env = environment([exiting, blocker], access);
    for (let frame = 0; frame < 90; frame++) {
      stepMover(exiting, 1 / 30, env);
      expect(separation(exiting.position, blocker.position)).toBeGreaterThanOrEqual(.56 - 1e-6);
    }
    expect(confirm).not.toHaveBeenCalled();
    expect(exiting.trip?.exited).toBe(false);
    expect(exiting.phase).toBe('alighting');
  });

  it.each(['waiting', 'boarding', 'alighting'] as const)('keeps %s motion behind static clearance without confirming controller work', phase => {
    const mover = passenger('blocked', 1, 3, 0);
    mover.phase = phase;
    mover.trip!.stage = 'approach';
    const floor = phase === 'alighting' ? 3 : 1;
    mover.position.splice(0, 3, landing(floor)[0] - .8, floorY(floor), landing(floor)[2]);
    const before = [...mover.position], trip = mover.trip, goal = mover.goal;
    const boarded = vi.fn(() => true), exited = vi.fn(() => true);
    const access: ElevatorAccess = { ...liveElevatorAccess, request() {}, waitingSlot: () => 0, canBoard: () => phase === 'boarding', canExit: () => true,
      confirmBoarded: boarded, confirmExited: exited, progress: () => null };
    const env = { ...environment([mover], access), walkable: () => false };
    for (let frame = 0; frame < 60; frame++) stepMover(mover, 1 / 30, env);
    expect(mover.position).toEqual(before);
    expect(mover.trip).toBe(trip); expect(mover.goal).toBe(goal);
    expect(boarded).not.toHaveBeenCalled(); expect(exited).not.toHaveBeenCalled();
  });

  it('keeps a boarding token while its approach is occupied instead of passing through the body', () => {
    const mover = passenger('boarding', 1, 3, 0), blocker = passenger('standing', 1, 3, 1);
    mover.phase = 'boarding'; mover.trip!.stage = 'approach';
    blocker.position.splice(0, 3, ...landing(1)); blocker.phase = 'seated'; blocker.trip = null; blocker.steps = [];
    const boarded = vi.fn(() => true), access: ElevatorAccess = { ...liveElevatorAccess, canBoard: () => true, confirmBoarded: boarded, progress: () => null };
    const env = environment([mover, blocker], access);
    for (let frame = 0; frame < 90; frame++) {
      stepMover(mover, 1 / 30, env);
      expect(separation(mover.position, blocker.position)).toBeGreaterThanOrEqual(.56 - 1e-6);
    }
    expect(boarded).not.toHaveBeenCalled();
    expect(mover.phase).toBe('boarding');
    expect(mover.trip?.stage).toBe('approach');
  });

  it('serves twenty actual movers in opposing floor batches with exclusive physical passage and real destinations', () => {
    const movers = Array.from({ length: 20 }, (_, index) => passenger(`rider-${String(index).padStart(2, '0')}`,
      index < 10 ? 1 : 3, index < 10 ? 3 : 1, index % 10));
    const env = environment(movers), reached = new Set<string>();
    // All reservations use the controller's actual queue order and slot indices.
    for (const mover of movers) { const trip = mover.trip!; requestElevator({ riderId: mover.id, from: trip.from, to: trip.to }, 'A'); trip.requested = true; }
    const entered = new Set<string>(), exited = new Set<string>();
    for (let frame = 0; frame < 30 * 480 && reached.size < movers.length; frame++) {
      tickElevator(1 / 30, 'A');
      for (const mover of movers) {
        const before: Point3 = [...mover.position], prior = mover.phase;
        stepMover(mover, 1 / 30, env);
        if (prior !== 'riding') expect(Math.hypot(mover.position[0] - before[0], mover.position[1] - before[1], mover.position[2] - before[2])).toBeLessThanOrEqual(.1);
        if (mover.phase === 'riding') entered.add(mover.id);
        if (prior === 'alighting' && !mover.trip) exited.add(mover.id);
        if (mover.phase === 'vanishing' || mover.phase === 'gone') {
          expect(mover.position[1]).toBeCloseTo(floorY(Number(mover.id.slice(-2)) < 10 ? 3 : 1));
          expect(separation(mover.position, [19, mover.position[1], getElevatorGeometry('A').z])).toBeLessThan(.002);
          reached.add(mover.id);
        }
      }
      for (let a = 0; a < movers.length; a++) for (let b = a + 1; b < movers.length; b++) {
        const first = movers[a]!, second = movers[b]!;
        if (first.phase === 'gone' || second.phase === 'gone' || Math.abs(first.position[1] - second.position[1]) > .8) continue;
        expect(separation(first.position, second.position)).toBeGreaterThanOrEqual(.56 - 1e-5);
      }
    }
    expect([...reached].sort(), JSON.stringify(movers.filter(m => !reached.has(m.id)).map(m => ({ id: m.id, phase: m.phase, at: m.position, stage: m.trip?.stage }))))
      .toEqual(movers.map(m => m.id).sort());
    expect(entered.size).toBe(20); expect(exited.size).toBe(20);
    for (const mover of movers) expect(mover.recovery.attempts).toBe(0);
    expect(elevatorSnapshot('A').passengers).toEqual([]);
    expect(elevatorSnapshot('A').queue).toEqual([]);
  });
});
