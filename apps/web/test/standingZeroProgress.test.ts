import { describe, expect, it } from 'vitest';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import type { Point3 } from '../src/office/scene/layout';
import { createMover, routeFrom, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { seatStageId, type OfficeNavigation, type SeatApproach } from '../src/office/scene/movement/navGraph';
import type { WalkableSegment } from '../src/office/scene/movement/naturalWalking';
import { staticSeatPoint } from '../src/office/scene/movement/staticSeating';

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };

function fixture() {
  const seat: SeatApproach = { seatId: 'monitor-sofa', roomId: 'test', floor: 1, seat: [3, 0, -2], rotationY: 0,
    seatHeight: 0.43, seatFront: 0.235, seatStyle: 'sofa', staging: [4.4, 0, -3.2], sitMs: 1000, standMs: 900 };
  const stage = seatStageId(seat.seatId), exit = staticSeatPoint(seat, 2.5, -1.2);
  const navigation: OfficeNavigation = {
    graph: { nodes: new Map([[stage, { id: stage, floorId: 'floor-1', pos: { x: seat.staging[0], y: seat.staging[2] } }], ['exit', { id: 'exit', floorId: 'floor-1', pos: { x: exit[0], y: exit[2] } }]]),
      edges: new Map([[stage, [{ to: 'exit', cost: 4 }]], ['exit', [{ to: stage, cost: 4 }]]]) },
    waypoints: new Map([[stage, { id: stage, floorId: 'floor-1', kind: 'approach', position: seat.staging }], ['exit', { id: 'exit', floorId: 'floor-1', kind: 'corridor', position: exit }]]),
    seats: new Map([[seat.seatId, seat]]), edges: [], connectors: [], aisles: new Map(), elevatorEdges: new Map(), entryId: 'exit',
  };
  return { seat, stage, navigation };
}

describe('stationary movement recovery', () => {
  it('refreshes a cached blocked sofa approach and finishes at the requested seat without jumping', () => {
    const { seat, stage, navigation } = fixture();
    let blockedTarget: Point3 | null = null;
    const walkable: WalkableSegment = (_from, to) => !blockedTarget || Math.hypot(to[0] - blockedTarget[0], to[2] - blockedTarget[2]) > 0.025;
    const env: MovementEnv = { navigation, elevators, walkable, nearbyWalkers: () => [] };
    const mover = createMover('blocked-seat-approach', gaitParameters(), seat.staging, 0, false);
    expect(routeFrom(mover, stage, { kind: 'seat', seat }, env, false)).toBe(true);
    stepMover(mover, 1 / 60, env); // The empty graph leg enters seatwork.
    for (let i = 0; i < 30 && !mover.staticSeat?.path?.length; i++) stepMover(mover, 1 / 60, env);
    expect(mover.phase).toBe('seatwork');
    expect(mover.staticSeat?.path?.length).toBeGreaterThan(0);
    blockedTarget = [...mover.staticSeat!.path![0]!] as Point3;

    let largestStep = 0;
    for (let i = 0; i < 30 * 35 && mover.phase !== 'seated'; i++) {
      const before = [...mover.position] as Point3;
      stepMover(mover, 1 / 30, env);
      largestStep = Math.max(largestStep, Math.hypot(mover.position[0] - before[0], mover.position[1] - before[1], mover.position[2] - before[2]));
    }
    expect(mover.phase).toBe('seated');
    expect(mover.seat?.seatId).toBe(seat.seatId);
    expect(largestStep).toBeLessThan(0.1);
  });

  it('does not relocate through a permanently blocked seat contact', () => {
    const { seat, stage, navigation } = fixture();
    let contactBlocked = false;
    const env: MovementEnv = { navigation, elevators, walkable: () => true, nearbyWalkers: () => [], seatContactClear: () => !contactBlocked };
    const mover = createMover('protected-seat-contact', gaitParameters(), seat.staging, 0, false);
    expect(routeFrom(mover, stage, { kind: 'seat', seat }, env, false)).toBe(true);
    for (let i = 0; i < 30 * 10 && mover.staticSeat?.beat !== 'contact'; i++) stepMover(mover, 1 / 30, env);
    expect(mover.staticSeat?.beat).toBe('contact');
    contactBlocked = true;
    let largestStep = 0;
    for (let i = 0; i < 30 * 20; i++) {
      const before = [...mover.position] as Point3;
      stepMover(mover, 1 / 30, env);
      largestStep = Math.max(largestStep, Math.hypot(mover.position[0] - before[0], mover.position[1] - before[1], mover.position[2] - before[2]));
    }
    expect(mover.phase).toBe('seatwork');
    expect(mover.staticSeat?.beat).toBe('contact');
    expect(mover.seat?.seatId).toBe(seat.seatId);
    expect(largestStep).toBeLessThan(0.1);
  });
});
