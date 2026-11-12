import { describe, expect, it } from 'vitest';
import { DoorTraffic, type DoorInfo, type WalkerInfo } from '../src/office/scene/interior/doorTraffic';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { createMover, placeSeated, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { officeNavigation } from '../src/office/scene/movement/navGraph';

const ENGINEERING = 'engineering-south', LIBRARY = 'library', OPERATIONS = 'operations';
const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 1.6, height: 2.55, openAngle: Math.PI / 2, sliding: false };
function fixture() {
  const walkers = new Map<string, WalkerInfo>();
  const doors = new Map<string, DoorInfo>([[ENGINEERING, door], [OPERATIONS, { ...door, center: [0, 0, 1] }]]);
  const traffic = new DoorTraffic({ forEachDoor: visit => doors.forEach((geometry, id) => visit(id, geometry)),
    forEachWalker: visit => walkers.forEach(visit) }, () => 0);
  return { traffic, walkers, doors };
}

describe('registered foreign door group yield priority', () => {
  it('orders foreign heads acyclically while retaining same-door and unregistered local behavior', () => {
    const { traffic } = fixture();
    traffic.setActiveDoor('z-engineering-head', ENGINEERING);
    traffic.setActiveDoor('a-operations-head', OPERATIONS);
    expect(traffic.mayYieldTo(ENGINEERING, 'a-operations-head')).toBe(false);
    expect(traffic.mayYieldTo(OPERATIONS, 'z-engineering-head')).toBe(true);
    expect(traffic.mayYieldTo(ENGINEERING, 'z-engineering-head')).toBe(true);
    expect(traffic.mayYieldTo(ENGINEERING, 'unregistered-body')).toBe(true);
    traffic.setActiveDoor('library-head', LIBRARY);
    const groups = [[ENGINEERING, 'z-engineering-head'], [LIBRARY, 'library-head'], [OPERATIONS, 'a-operations-head']] as const;
    for (const [active] of groups) for (const [peerDoor, peer] of groups) expect(traffic.mayYieldTo(active, peer)).toBe(active >= peerDoor);
  });

  it('gives every follower the group priority regardless of its actor id or queue position', () => {
    const { traffic } = fixture();
    const engineering = ['z-head', 'zz-following', '000-tail'], operations = ['a-head', '000-following', 'zzz-tail'];
    for (const id of engineering) traffic.setActiveDoor(id, ENGINEERING);
    for (const id of operations) traffic.setActiveDoor(id, OPERATIONS);
    for (const id of operations) expect(traffic.mayYieldTo(ENGINEERING, id)).toBe(false);
    for (const id of engineering) expect(traffic.mayYieldTo(OPERATIONS, id)).toBe(true);
    for (const id of engineering) expect(traffic.mayYieldTo(ENGINEERING, id)).toBe(true);
  });

  it('does not infer active intent from incidental auto-enrolled approach tickets', () => {
    const h = fixture(), operations = h.doors.get(OPERATIONS)!;
    h.walkers.set('engineering-peer', { id: 'engineering-peer', position: [0, 0, 2], target: [0, 0, 0], updatedAt: 0 });
    h.walkers.set('operations-owner', { id: 'operations-owner', position: [0, 0, -1], target: [0, 0, 1], updatedAt: 0 });
    h.traffic.queue(OPERATIONS, operations, 'operations-owner', [0, 0, -1], -1);
    expect(h.traffic.queueStatus(OPERATIONS, 'engineering-peer')).toMatchObject({ head: 'engineering-peer', ahead: 0, count: 2 });
    h.traffic.queue(ENGINEERING, door, 'engineering-peer', [0, 0, 2], 1);
    expect(h.traffic.queueStatus(ENGINEERING, 'operations-owner')).toMatchObject({ head: 'operations-owner', ahead: 0, count: 2 });
    // A queue ticket by itself never grants a foreign group priority.
    expect(h.traffic.mayYieldTo(ENGINEERING, 'engineering-peer')).toBe(true);
    h.traffic.setActiveDoor('engineering-peer', ENGINEERING);
    h.traffic.setActiveDoor('operations-owner', OPERATIONS);
    expect(h.traffic.mayYieldTo(OPERATIONS, 'engineering-peer')).toBe(true);
    expect(h.traffic.mayYieldTo(ENGINEERING, 'operations-owner')).toBe(false);
    expect(h.traffic.queueStatus(OPERATIONS).head).toBe('engineering-peer');
    expect(h.traffic.queueStatus(ENGINEERING).head).toBe('operations-owner');
  });

  it('guards old cleanup, clears matching finish/cancel, and preserves active work through hand release', () => {
    const { traffic } = fixture();
    traffic.setActiveDoor('walker', ENGINEERING);
    traffic.setActiveDoor('walker', OPERATIONS);
    traffic.clearActiveDoor('walker', ENGINEERING);
    expect(traffic.mayYieldTo(ENGINEERING, 'walker')).toBe(false);
    traffic.finishPass(ENGINEERING, 'walker');
    expect(traffic.mayYieldTo(ENGINEERING, 'walker')).toBe(false);
    traffic.cancel(ENGINEERING, 'walker');
    expect(traffic.mayYieldTo(ENGINEERING, 'walker')).toBe(false);
    traffic.release(OPERATIONS, 'walker');
    expect(traffic.mayYieldTo(ENGINEERING, 'walker')).toBe(false);
    traffic.finishPass(OPERATIONS, 'walker');
    expect(traffic.mayYieldTo(ENGINEERING, 'walker')).toBe(true);
    traffic.setActiveDoor('walker', OPERATIONS); traffic.cancel(OPERATIONS, 'walker');
    expect(traffic.mayYieldTo(ENGINEERING, 'walker')).toBe(true);
  });

  it('clears explicit null/removal lifecycle intent without touching another actor', () => {
    const { traffic } = fixture();
    traffic.setActiveDoor('removed', OPERATIONS); traffic.setActiveDoor('retained', OPERATIONS);
    traffic.clearActiveDoor('removed');
    expect(traffic.mayYieldTo(ENGINEERING, 'removed')).toBe(true);
    expect(traffic.mayYieldTo(ENGINEERING, 'retained')).toBe(false);
    traffic.setActiveDoor('retained', null);
    expect(traffic.mayYieldTo(ENGINEERING, 'retained')).toBe(true);
  });

  it('clears a finished closing act without changing its retained physical close duty', () => {
    const { traffic, doors } = fixture();
    traffic.setActiveDoor('closer', OPERATIONS);
    traffic.hold(OPERATIONS, 'closer', 1, 2);
    traffic.passed(OPERATIONS, doors.get(OPERATIONS)!, 'closer');
    expect(traffic.claimClosure(OPERATIONS, 'closer')).toBe(true);
    expect(traffic.mayYieldTo(ENGINEERING, 'closer')).toBe(false);
    traffic.finishPass(OPERATIONS, 'closer');
    expect(traffic.closing(OPERATIONS, 'closer')).toBe(false);
    expect(traffic.mayYieldTo(ENGINEERING, 'closer')).toBe(true);
    expect(traffic.duty('closer')?.id).toBe(OPERATIONS);
  });

  it('cleans matching physical intent when a mover is placed at a seat', () => {
    const { traffic, doors } = fixture(), mover = createMover('reseated', gaitParameters(), [0, 0, -1], 0, false);
    const navigation = officeNavigation();
    const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
      confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };
    const env: MovementEnv = { navigation, elevators, doors: traffic };
    mover.phase = 'doorwork';
    mover.door = { id: OPERATIONS, door: doors.get(OPERATIONS)!, kind: 'wait', beat: 'reserve', side: 1, entrySide: 1, hand: 1, timer: 0, path: null };
    traffic.setActiveDoor(mover.id, OPERATIONS);
    expect(traffic.mayYieldTo(ENGINEERING, mover.id)).toBe(false);
    placeSeated(mover, navigation.seats.get('qa.station-1')!, env);
    expect(mover.phase).toBe('seated'); expect(mover.door).toBeNull();
    expect(traffic.mayYieldTo(ENGINEERING, mover.id)).toBe(true);
  });
});
