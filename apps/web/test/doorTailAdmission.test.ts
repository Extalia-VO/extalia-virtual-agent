import { describe, expect, it } from 'vitest';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { DoorTraffic, type DoorInfo } from '../src/office/scene/interior/doorTraffic';
import type { Point3 } from '../src/office/scene/layout';
import { createMover, DOOR_QUEUE_RANGE_M, routeFrom, stepMover, walkingTravelTarget, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { officeNavigation } from '../src/office/scene/movement/navGraph';
import { OFFICE_DOOR_PORTALS } from './fixtures/officeDoorPortals';

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };
function fixture(options: { foreign?: boolean; diagonal?: boolean; opposite?: boolean; behind?: boolean; otherFloor?: boolean; ghost?: boolean; operator?: boolean; intervening?: boolean; fartherIntervening?: boolean; wall?: boolean } = {}) {
  const navigation = officeNavigation(), door = OFFICE_DOOR_PORTALS.find(portal => portal.id === 'floor-2.meeting-a.entry')!;
  const foreign = OFFICE_DOOR_PORTALS.find(portal => portal.id === 'floor-2.meeting-b.entry')!;
  const mover = createMover('arriving', gaitParameters(), options.diagonal ? [3.3637885348, 6.4, -8.4164368003] : [-2.476, 6.4, -7.02], 0, false);
  const tailPosition: Point3 = options.diagonal ? [2.7267252801, 6.4, -7.1843077462] : [options.behind ? -1.5 : -3.05, options.otherFloor ? 12.8 : 6.4, -7.02];
  const tail = createMover('tail', gaitParameters(), tailPosition, 0, false);
  const queuedDoor = options.foreign ? foreign : door, entrySide = options.opposite ? -1 : 1;
  const portals: { id: string; door: DoorInfo }[] = [{ id: door.id, door }, { id: foreign.id, door: foreign }];
  if (options.intervening) portals.push({ id: 'intermediate', door: { ...door, center: [-2.75, 6.4, -7.02], yaw: Math.PI / 2 } });
  if (options.fartherIntervening) portals.push({ id: 'far-intermediate', door: { ...door, center: [-12.75, 6.4, -8.2], yaw: Math.PI / 2 } });
  let now = 0;
  const doors = new DoorTraffic({ forEachDoor: visit => portals.forEach(portal => visit(portal.id, portal.door)),
    forEachWalker: visit => [mover, tail].forEach(m => visit({ id: m.id, position: m.position, target: m.target ?? m.position, updatedAt: now })) }, () => now);
  if (options.operator) doors.claim(queuedDoor.id, 'leaf-operator');
  if (!options.ghost) doors.queue(queuedDoor.id, queuedDoor, tail.id, tail.position, entrySide);
  const env: MovementEnv = { navigation, elevators, doors,
    walkable: (a, b) => !options.wall || Math.max(a[0], b[0]) < -2.9 || Math.min(a[0], b[0]) > -2.8,
    nearbyWalkers: () => [{ id: tail.id, position: tail.position, velocity: [0, 0, 0], target: tail.position,
      queueDoor: { id: queuedDoor.id, entrySide } }] };
  const goal = { kind: 'seat' as const, seat: navigation.seats.get('meeting-a.seat-5')! };
  expect(routeFrom(mover, 'f2.corridor-mission', goal, env, false)).toBe(true);
  return { mover, tail, door, doors, goal, tick: () => { now += 1000 / 30; stepMover(mover, 1 / 30, env); } };
}

describe('admitting the visible tail of the next planned door', () => {
  it('joins a real immediately-ahead tail beyond ten metres without replaying the previous corridor origin', () => {
    const f = fixture(), before = [...f.mover.position];
    expect(Math.hypot(f.mover.position[0] - f.door.center[0], f.mover.position[2] - f.door.center[2])).toBeGreaterThan(DOOR_QUEUE_RANGE_M);
    f.tick();
    expect(f.mover.phase).toBe('doorwork'); expect(f.mover.door?.id).toBe(f.door.id);
    expect(f.mover.position).toEqual(before); expect(f.mover.goal).toEqual(f.goal);
    f.tick();
    expect(f.doors.queueStatus(f.door.id, f.mover.id)).toMatchObject({ head: f.tail.id, ahead: 1, count: 2 });
    expect(f.mover.door?.kind).toBe('wait'); expect(f.mover.opacity).toBe(1);
  });

  it('does not treat the measured off-lane diagonal peer as a blocked queue tail', () => {
    const f = fixture({ diagonal: true });
    expect(Math.hypot(f.tail.position[0] - f.mover.position[0], f.tail.position[2] - f.mover.position[2])).toBeCloseTo(1.3870802415);
    f.tick(); expect(f.mover.phase).toBe('walking'); expect(f.mover.door).toBeNull();
    expect(f.doors.queueStatus(f.door.id, f.mover.id)).toMatchObject({ head: f.tail.id, ahead: 1, count: 1 });
  });

  it('rejects a farther diagonal body that fits the previous rectangular lane bounds', () => {
    const f = fixture(), target = walkingTravelTarget(f.mover)!;
    const dx = target[0] - f.mover.position[0], dz = target[2] - f.mover.position[2], length = Math.hypot(dx, dz);
    f.tail.position[0] = f.mover.position[0] + dx / length * 2.45 - dz / length * .7;
    f.tail.position[2] = f.mover.position[2] + dz / length * 2.45 + dx / length * .7;
    expect(Math.hypot(f.tail.position[0] - f.mover.position[0], f.tail.position[2] - f.mover.position[2])).toBeGreaterThan(2.5);
    f.tick(); expect(f.mover.phase).toBe('walking'); expect(f.mover.door).toBeNull();
  });

  it.each([
    { foreign: true }, { opposite: true }, { behind: true }, { otherFloor: true }, { ghost: true }, { ghost: true, operator: true }, { wall: true },
  ])('does not enroll an unrelated, opposite, behind, unregistered or inaccessible tail: %j', options => {
    const f = fixture(options); f.tick();
    expect(f.mover.phase).toBe('walking'); expect(f.mover.door).toBeNull();
    expect(f.doors.queueStatus(f.door.id, f.mover.id).ahead).toBe(f.doors.queueStatus(f.door.id).count);
  });

  it('does not reserve a later queue through a prior portal that is itself beyond ten metres', () => {
    const f = fixture({ fartherIntervening: true });
    f.tick();
    expect(f.mover.phase).toBe('walking'); expect(f.mover.door).toBeNull();
    for (let frame = 0; frame < 15; frame++) f.tick();
    expect(f.mover.door).toBeNull();
    // The waiting body must clear before this walker can approach the prior portal.
    f.tail.position[2] = -11;
    for (let frame = 0; frame < 30 && f.mover.phase === 'walking'; frame++) f.tick();
    expect(f.mover.door?.id).toBe('far-intermediate');
    expect(f.doors.queueStatus(f.door.id, f.mover.id)).toMatchObject({ head: f.tail.id, ahead: 1, count: 1 });
  });

  it('reserves an intervening physical portal before a more distant planned queue', () => {
    const f = fixture({ intervening: true });
    for (let frame = 0; frame < 6 && f.mover.phase === 'walking'; frame++) f.tick();
    expect(f.mover.door?.id).toBe('intermediate');
    expect(f.doors.queueStatus(f.door.id, f.mover.id)).toMatchObject({ head: f.tail.id, ahead: 1, count: 1 });
  });
});
