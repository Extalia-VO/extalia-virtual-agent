import { describe, expect, it, vi } from 'vitest';
import type { NavEdge, Waypoint } from '@extalia/office';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { DoorTraffic, type DoorInfo } from '../src/office/scene/interior/doorTraffic';
import type { Point3 } from '../src/office/scene/layout';
import { createMover, placeSeated, sendMover, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { seatStageId, type OfficeNavigation, type SeatApproach } from '../src/office/scene/movement/navGraph';

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };
const seat: SeatApproach = { seatId: 'lounge-sofa', roomId: 'lounge', floor: 1, seat: [0, 0, 0], staging: [1.4, 0, -1.2],
  rotationY: 0, seatHeight: .43, seatFront: .23, seatStyle: 'sofa', sitMs: 900, standMs: 900 };

function fixture(id = 'managed-actor') {
  const stage = seatStageId(seat.seatId);
  const points = [[stage, seat.staging], ['aisle', [2.4, 0, -1.2]], ['exit', [4, 0, -1.2]]] as const;
  const graphEdges = new Map<string, NavEdge[]>([[stage, []], ['aisle', [{ to: 'exit', cost: 1.6 }]], ['exit', [{ to: 'aisle', cost: 1.6 }]]]);
  const waypoints = new Map<string, Waypoint>(points.map(([id, p]): [string, Waypoint] => [id, {
    id, floorId: 'floor-1', kind: id === stage ? 'approach' : 'corridor', position: [p[0], p[1], p[2]],
  }]));
  const navigation: OfficeNavigation = {
    graph: { nodes: new Map(points.map(([id, p]) => [id, { id, floorId: 'floor-1', pos: { x: p[0], y: p[2] } }])),
      edges: graphEdges },
    waypoints,
    seats: new Map([[seat.seatId, seat]]), edges: [], connectors: [], aisles: new Map(), elevatorEdges: new Map(), entryId: 'exit',
  };
  const walkable = vi.fn(() => true);
  const env: MovementEnv = { navigation, elevators, walkable, nearbyWalkers: () => [] };
  const mover = createMover(id, gaitParameters(), seat.seat, 0, true);
  placeSeated(mover, seat, env);
  const run = (seconds: number) => { for (let frame = 0; frame < seconds * 30; frame++) stepMover(mover, 1 / 30, env); };
  const depart = () => {
    expect(sendMover(mover, { kind: 'leave', node: 'exit' }, env)).toBe(true);
    for (let frame = 0; frame < 600 && mover.phase !== 'seated'; frame++) stepMover(mover, 1 / 30, env);
    expect(mover.phase).toBe('seated');
    expect(mover.motion.sit).toBe(0);
    expect(mover.position).toEqual(seat.staging);
  };
  return { mover, env, navigation, graphEdges, waypoints, walkable, run, depart };
}

describe('completed static-seat departure recovery', () => {
  it.each(['managed-actor', 'npc-visitor'])('rejoins a visible aisle after %s exits an isolated seat stage', id => {
    const h = fixture(id);
    h.depart();
    const goal = h.mover.goal;
    for (let frame = 0; frame < 600; frame++) {
      const before = [...h.mover.position] as Point3;
      stepMover(h.mover, 1 / 30, h.env);
      expect(Math.hypot(...h.mover.position.map((value, axis) => value - before[axis]!) as Point3)).toBeLessThan(.08);
      expect(h.mover.position[1]).toBe(0);
    }
    expect(h.mover.phase).toBe('gone');
    expect(h.mover.goal).toBe(goal);
    expect(h.mover.recovery.attempts).toBe(1);
  });

  it('caps impossible departures without repeated per-frame graph searches or disappearing', () => {
    const h = fixture();
    h.depart();
    h.walkable.mockReturnValue(false);
    h.run(15);
    expect(h.mover.recovery.attempts).toBe(3);
    h.walkable.mockClear();
    const routeReads = vi.spyOn(h.graphEdges, 'get');
    h.run(60);
    expect(h.walkable).not.toHaveBeenCalled();
    expect(routeReads).toHaveBeenCalledTimes(6);
    expect(h.mover.position).toEqual(seat.staging);
    expect(h.mover.opacity).toBe(1);
  });

  it('retries a restored authored route without needing free-space diagnostics', () => {
    const h = fixture();
    h.depart();
    h.graphEdges.set(seatStageId(seat.seatId), [{ to: 'aisle', cost: 1 }]);
    const env: MovementEnv = { navigation: h.navigation, elevators };
    for (let frame = 0; frame < 600; frame++) stepMover(h.mover, 1 / 30, env);
    expect(h.mover.phase).toBe('gone');
    expect(h.mover.recovery.departure).toBeNull();
  });

  it('resumes the same intent after all three recovery attempts when the authored route returns later', () => {
    const h = fixture();
    h.depart();
    h.walkable.mockReturnValue(false);
    const goal = h.mover.goal;
    h.run(30);
    expect(h.mover.recovery.attempts).toBe(3);
    expect(h.mover.position).toEqual(seat.staging);
    const routeReads = vi.spyOn(h.graphEdges, 'get');
    stepMover(h.mover, 1000, h.env);
    expect(routeReads).not.toHaveBeenCalled();
    h.walkable.mockReturnValue(true);
    h.graphEdges.set(seatStageId(seat.seatId), [{ to: 'aisle', cost: 1 }]);
    h.run(10.1);
    expect(h.mover.recovery.departure).toBeNull();
    h.run(10);
    expect(h.mover.phase).toBe('gone');
    expect(h.mover.goal).toBe(goal);
    expect(h.mover.recovery.attempts).toBe(3);
  });

  it('retains the newest pending intent when it arrives during the completed departure wait', () => {
    const h = fixture();
    h.depart();
    const pending = { kind: 'leave' as const, node: 'aisle' };
    expect(sendMover(h.mover, pending, h.env)).toBe(true);
    expect(h.mover.phase).toBe('seated');
    expect(h.mover.position).toEqual(seat.staging);
    h.run(20);
    expect(h.mover.goal).toBe(pending);
    expect(h.mover.pending).toBeNull();
    expect(h.mover.position).toEqual([2.4, 0, -1.2]);
    expect(h.mover.phase).toBe('gone');
  });

  it('does not discard an intent queued during the seat-exit animation when its stage route fails', () => {
    const h = fixture();
    expect(sendMover(h.mover, { kind: 'leave', node: 'exit' }, h.env)).toBe(true);
    const pending = { kind: 'leave' as const, node: 'aisle' };
    expect(sendMover(h.mover, pending, h.env)).toBe(true);
    for (let frame = 0; frame < 600 && h.mover.phase !== 'seated'; frame++) stepMover(h.mover, 1 / 30, h.env);
    expect(h.mover.pending).toBe(pending);
    expect(h.mover.position).toEqual(seat.staging);
    h.run(20);
    expect(h.mover.goal).toBe(pending);
    expect(h.mover.position).toEqual([2.4, 0, -1.2]);
    expect(h.mover.phase).toBe('gone');
  });

  it('does not bypass an owned doorway to rejoin an aisle', () => {
    const h = fixture();
    h.depart();
    const door: DoorInfo = { center: [1.9, 0, -1.2], floor: 1, yaw: Math.PI / 2, clearWidth: 1.2,
      height: 2.5, openAngle: -Math.PI / 2, sliding: false };
    const doors = new DoorTraffic({ forEachDoor: visit => visit('door', door), forEachWalker() {} }, () => 0);
    doors.claim('door', 'operator');
    const env: MovementEnv = { ...h.env, doors };
    for (let frame = 0; frame < 600; frame++) stepMover(h.mover, 1 / 30, env);
    expect(h.mover.position).toEqual(seat.staging);
    expect(h.mover.recovery.attempts).toBe(3);
    expect(doors.claim('door', 'next')).toBe(false);
    expect(doors.claim('door', 'operator')).toBe(true);
  });

  it('does not choose an occupied aisle or a waypoint on another floor', () => {
    const h = fixture();
    h.depart();
    for (const id of ['aisle', 'exit']) {
      const node = h.waypoints.get(id)!;
      h.waypoints.set(id, { ...node, position: [node.position[0], 6.4, node.position[2]] });
    }
    h.run(15);
    expect(h.mover.position).toEqual(seat.staging);
    expect(h.mover.recovery.attempts).toBe(3);

    const blocked = fixture();
    blocked.depart();
    const env: MovementEnv = { ...blocked.env, nearbyWalkers: () => [{ id: 'waiting-visitor', position: [2.4, 0, -1.2], velocity: [0, 0, 0] }] };
    for (let frame = 0; frame < 600; frame++) stepMover(blocked.mover, 1 / 30, env);
    expect(blocked.mover.position).toEqual(seat.staging);
    expect(blocked.mover.recovery.attempts).toBe(3);
  });

  it('keeps occupied seats and standing service stations stationary', () => {
    for (const occupied of [seat, { ...seat, seatId: 'service-counter', standing: true }]) {
      const h = fixture();
      placeSeated(h.mover, occupied, h.env);
      h.run(90);
      expect(h.mover.phase).toBe('seated');
      expect(h.mover.position).toEqual(occupied.seat);
      expect(h.mover.recovery.attempts).toBe(0);
    }
  });
});
