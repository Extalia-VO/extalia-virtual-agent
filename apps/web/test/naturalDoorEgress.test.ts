import { describe, expect, it } from 'vitest';
import { doorOpenPosition } from '../src/office/scene/movement/doorChoreography';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { DoorTraffic } from '../src/office/scene/interior/doorTraffic';
import type { Point3 } from '../src/office/scene/layout';
import { createMover, doorTravelTarget, stepMover, walkingTravelTarget, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { officeNavigation, type RouteStep } from '../src/office/scene/movement/navGraph';
import { OFFICE_DOOR_PORTALS } from './fixtures/officeDoorPortals';

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };
const west = (x: number): Extract<RouteStep, { kind: 'walk' }> => ({ kind: 'walk', node: 'corridor', stairs: false, to: [x - .18, 6.4, -8.07],
  natural: { from: [x, 6.4, -8.07], transit: true, startDistance: 0, endDistance: .18, rightFrom: [0, 1], rightTo: [0, 1] } });
function departed() {
  const mover = createMover('departed', gaitParameters(), [2.302, 6.4, -7.146], 0, false);
  mover.phase = 'walking'; mover.steps = Array.from({ length: 16 }, (_, i) => west(2.477 - i * .18));
  mover.target = [...west(2.477).to];
  Object.assign(mover.natural, { index: 0, progress: .175, offset: .924, speed: 0, blockedTime: 0, lateralSpeed: .06857 });
  return mover;
}

describe('natural route egress intent', () => {
  it('advertises forward travel independently of a displaced body recentering toward a short marker', () => {
    const mover = departed(), original = structuredClone(mover.steps);
    expect(walkingTravelTarget(mover)).toEqual([mover.position[0] - 2.5, 6.4, mover.position[2]]);
    expect(mover.target).toEqual(original[0]!.to);
    expect(mover.steps).toEqual(original);
    mover.position[2] -= .1; mover.natural.offset -= .1;
    expect(walkingTravelTarget(mover)?.[0]).toBeCloseTo(mover.position[0] - 2.5);
    expect(walkingTravelTarget(mover)?.[2]).toBe(mover.position[2]);
  });

  it('stops its intent before an exact contact or a turn and leaves nonwalking/contact motions alone', () => {
    const mover = departed();
    mover.steps = [west(2.477), west(2.297), { kind: 'walk', node: 'seat:contact', stairs: false, to: [0, 6.4, -8.07] }];
    expect(mover.position[0] - walkingTravelTarget(mover)![0]).toBeCloseTo(.185);
    mover.steps[1] = { kind: 'walk', node: 'turn', stairs: false, to: [2.297, 6.4, -7.89],
      natural: { from: [2.297, 6.4, -8.07], transit: true, startDistance: 0, endDistance: .18, rightFrom: [1, 0], rightTo: [1, 0] } };
    expect(walkingTravelTarget(mover)).toBeUndefined();
    mover.steps = [west(2.477), west(2.297)]; mover.backing = true;
    expect(walkingTravelTarget(mover)).toBeUndefined();
    mover.backing = false; mover.phase = 'doorwork';
    expect(walkingTravelTarget(mover)).toBeUndefined();
  });

  it('reads live leaf progress rather than a desired opening target when advertising a held maneuver', () => {
    const head = createMover('operator', gaitParameters(), [3, 6.4, -7], 0, false);
    const door = OFFICE_DOOR_PORTALS.find(portal => portal.id === 'floor-2.meeting-b.entry')!;
    const traffic = new DoorTraffic({ forEachDoor: visit => visit(door.id, door), forEachWalker() {} }, () => 0);
    head.phase = 'doorwork'; head.door = { id: door.id, door, kind: 'open', beat: 'swing', side: 1, entrySide: 1,
      hand: 0, timer: 0, path: null, openAmount: 1 };
    expect(doorTravelTarget(head, traffic)).toEqual(doorOpenPosition(door, .15, 1, [0, 0, 0]));
    traffic.hold(door.id, head.id, 1, .5 / .9);
    expect(doorTravelTarget(head, traffic)).toEqual(doorOpenPosition(door, .65, 1, [0, 0, 0]));
  });

  it('clears a held head crossing from the opposite face before its first successful movement', () => {
    const head = createMover('head', gaitParameters(), [3.376, 6.4, -6.146], 0, false);
    const waiter = createMover('waiter', gaitParameters(), [3.097, 6.4, -6.705], 0, false);
    const door = OFFICE_DOOR_PORTALS.find(portal => portal.id === 'floor-2.meeting-b.entry')!;
    const movers = [head, waiter]; let now = 0;
    const traffic = new DoorTraffic({ forEachDoor: visit => visit(door.id, door), forEachWalker: visit => movers.forEach(m =>
      visit({ id: m.id, position: m.position, target: m.position, updatedAt: now })) }, () => now);
    for (const m of movers) {
      m.phase = 'doorwork';
      m.door = { id: door.id, door, kind: m === head ? 'open' : 'wait', beat: m === head ? 'handoff' : 'reserve',
        side: m === head ? -1 : 1, entrySide: m === head ? -1 : 1, hand: 0, timer: 0, path: [] };
      traffic.queue(door.id, door, m.id, m.position, m.door.entrySide);
      traffic.setActiveDoor(m.id, door.id);
    }
    traffic.hold(door.id, head.id, 1, 2);
    expect(head.target).toBeNull();
    const env: MovementEnv = { navigation: officeNavigation(), elevators, doors: traffic, walkable: () => true,
      nearbyWalkers: id => movers.filter(m => m.id !== id).map(m => ({ id: m.id, position: m.position, velocity: [0, 0, 0],
        travelTarget: doorTravelTarget(m, traffic), travelDoor: m.door?.id })) };
    for (let frame = 0; frame < 90; frame++) {
      now += 1000 / 30; traffic.queue(door.id, door, head.id, head.position, -1); stepMover(waiter, 1 / 30, env);
      expect(Math.hypot(waiter.position[0] - head.position[0], waiter.position[2] - head.position[2])).toBeGreaterThanOrEqual(.56);
    }
    expect(waiter.door?.queueYield?.id).toBe(head.id);
    expect(waiter.position[2]).toBeLessThan(-7);
    expect(traffic.queueStatus(door.id).head).toBe(head.id);
  });

  it('clears a parked column for a departing walker while preserving the head ticket and passing breadcrumb', () => {
    const peer = departed(), waiter = createMover('parked', gaitParameters(), [1.48, 6.4, -7.4], 0, false);
    const head = createMover('head', gaitParameters(), [1.48, 6.4, -9.1], 0, false);
    const door = OFFICE_DOOR_PORTALS.find(portal => portal.id === 'floor-2.meeting-b.entry')!;
    const movers = [peer, waiter, head]; let now = 0;
    const target = (m: typeof peer): Readonly<Point3> => m.target ?? m.position;
    const traffic = new DoorTraffic({ forEachDoor: visit => visit(door.id, door), forEachWalker: visit => movers.forEach(m =>
      visit({ id: m.id, position: m.position, target: target(m), updatedAt: now })) }, () => now);
    traffic.queue(door.id, door, head.id, head.position, 1);
    traffic.queue(door.id, door, waiter.id, waiter.position, 1);
    traffic.hold(door.id, head.id, 1, 2);
    waiter.phase = 'doorwork'; waiter.door = { id: door.id, door, kind: 'wait', beat: 'reserve', side: 1, entrySide: 1,
      hand: 1, timer: 30, path: [], queueIndex: 1 };
    const env: MovementEnv = { navigation: officeNavigation(), elevators, doors: traffic, walkable: () => true,
      nearbyWalkers: id => movers.filter(m => m.id !== id).map(m => ({ id: m.id, position: m.position, velocity: [0, 0, 0],
        target: target(m), travelTarget: walkingTravelTarget(m) })) };
    // The actual recentering target points south: the old projection misses the parked body (> .8 m).
    const dx = peer.target![0] - peer.position[0], dz = peer.target![2] - peer.position[2];
    expect(Math.abs((waiter.position[0] - peer.position[0]) * dz - (waiter.position[2] - peer.position[2]) * dx) / Math.hypot(dx, dz)).toBeGreaterThan(.8);
    now += 1000 / 30; stepMover(waiter, 1 / 30, env);
    expect(waiter.door?.queueYield).toMatchObject({ id: peer.id, direction: [-1, 0] });
    expect(traffic.queueStatus(door.id).head).toBe(head.id);
    const origin = [...waiter.door!.queueYield!.origin];
    const before = [...waiter.position];
    for (let frame = 0; frame < 120; frame++) {
      now += 1000 / 30; traffic.queue(door.id, door, head.id, head.position, 1); stepMover(waiter, 1 / 30, env);
    }
    expect(Math.hypot(waiter.position[0] - before[0]!, waiter.position[2] - before[2]!)).toBeGreaterThan(.2);
    expect(waiter.door?.queueYield?.origin).toEqual(origin);
    expect(traffic.queueStatus(door.id).head).toBe(head.id);
    expect(waiter.opacity).toBe(1);
  });
});
