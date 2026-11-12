import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh } from 'three';
import { OFFICE_BUILDING, type Point3 } from '../src/office/scene/layout';
import { createBuildingFootprintGeometry } from '../src/office/scene/interior/buildingFootprintGeometry';
import { elevatorMovementTarget, elevatorSegmentClear, elevatorWaitingRetreatTarget } from '../src/office/scene/movement/elevatorMovement';
import { floorY, officeNavigation, seatStageId } from '../src/office/scene/movement/navGraph';
import { WalkingClearance } from '../src/office/scene/movement/naturalClearance';
import type { WalkingNeighbor } from '../src/office/scene/movement/naturalWalking';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { createMover, stepMover, type MovementEnv, type Mover } from '../src/office/scene/movement/mover';
import { liveElevatorAccess } from '../src/office/scene/movement/elevatorAccess';
import { elevatorSnapshot, getElevatorGeometry, getElevatorWaitingSlot, requestElevator, reserveElevatorWaitingSlot, resetElevator, tickElevator } from '../src/office/scene/prefabs/architecture/elevatorController';

const navigation = officeNavigation();
const landing: Point3 = [...navigation.waypoints.get('f3.elevator-A')!.position];
const distance = (a: Readonly<Point3>, b: Readonly<Point3>) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const body = (id: string, position: Readonly<Point3>): WalkingNeighbor => ({ id, position, velocity: [0, 0, 0] });
function fixture() {
  const root = new Group(), field = new WalkingClearance();
  const geometry = createBuildingFootprintGeometry({ size: [OFFICE_BUILDING.width, OFFICE_BUILDING.depth], origin: [OFFICE_BUILDING.centerX, 0],
    profile: 'upper', thickness: .1 })!;
  const slab = new Mesh(geometry); slab.position.set(OFFICE_BUILDING.centerX, floorY(3) - .1, 0); root.add(slab);
  field.rebuild([root]);
  return { root, field, dispose() { root.traverse(node => { if (node instanceof Mesh) node.geometry.dispose(); }); field.clear(); } };
}
function advance(from: Point3, to: Readonly<Point3>): void {
  const length = distance(from, to), fraction = Math.min(1, .035 / Math.max(length, 1e-9));
  from[0] += (to[0] - from[0]) * fraction; from[2] += (to[2] - from[2]) * fraction;
}

describe('checked waiting retreat from a blocked elevator approach', () => {
  it('clears the exact opposing waiter/token landing conflict through physical steps', () => {
    const h = fixture(), waiter: Point3 = [23.9, 12.8, -1.77461], token: Point3 = [23.97506, 12.8, -2.36];
    const slot: Point3 = [23.9, 12.8, -2.7], tokenOwner = {}, waiterOwner = {};
    const rider: Point3 = [getElevatorGeometry('A').x, floorY(3), getElevatorGeometry('A').z];
    try {
      expect(elevatorMovementTarget(waiterOwner, 'retreat-waiter', 'A', waiter, slot, 1 / 30,
        h.field.segmentClear, [body('doorway-token', token), body('cab-rider', rider)], true)).toBeNull();
      expect(elevatorMovementTarget(tokenOwner, 'doorway-token', 'A', token, landing, 1 / 30,
        h.field.segmentClear, [body('retreat-waiter', waiter), body('cab-rider', rider)], true)).toBeNull();
      let moved = false, reachedHold = false;
      for (let frame = 0; frame < 160; frame++) {
        const beforeWaiter: Point3 = [...waiter];
        const retreat = elevatorWaitingRetreatTarget('retreat-waiter', 'A', waiter, landing,
          h.field.segmentClear, [body('doorway-token', token), body('cab-rider', rider)], 1 / 30);
        if (retreat) advance(waiter, retreat);
        moved ||= distance(beforeWaiter, waiter) > 0;
        expect(distance(beforeWaiter, waiter)).toBeLessThanOrEqual(.035 + 1e-8);
        expect(elevatorSegmentClear('A', beforeWaiter, waiter, h.field.segmentClear)).toBe(true);
        const next = elevatorMovementTarget(tokenOwner, 'doorway-token', 'A', token, landing, 1 / 30,
          h.field.segmentClear, [body('retreat-waiter', waiter), body('cab-rider', rider)], true);
        const beforeToken: Point3 = [...token];
        if (next) advance(token, next);
        expect(distance(beforeToken, token)).toBeLessThanOrEqual(.035 + 1e-8);
        expect(elevatorSegmentClear('A', beforeToken, token, h.field.segmentClear)).toBe(true);
        expect(distance(waiter, token)).toBeGreaterThanOrEqual(.56 - 1e-6);
        reachedHold ||= distance(waiter, [landing[0] - 1.2, landing[1], landing[2]]) < .025;
      }
      expect(moved).toBe(true); expect(reachedHold).toBe(true);
      expect(distance(token, landing)).toBeLessThan(.025);
      for (let repeat = 0; repeat < 10; repeat++) expect(elevatorWaitingRetreatTarget('retreat-waiter', 'A', waiter, landing,
        h.field.segmentClear, [body('doorway-token', token)], 1 / 30)).toBeNull();
    } finally { h.dispose(); }
  });

  it('selects a stable farther west hold when the first is occupied, instead of oscillating toward it', () => {
    const h = fixture(), start: Point3 = [...landing], first: Point3 = [landing[0] - 1.2, landing[1], landing[2]];
    const neighbors = [body('occupied-first-hold', first)];
    try {
      const target = elevatorWaitingRetreatTarget('farther-waiter', 'A', start, landing, h.field.segmentClear, neighbors, 1 / 30);
      expect(target).not.toBeNull();
      expect(target && target[0]).toBeLessThan(landing[0]);
      for (let frame = 0; frame < 240; frame++) {
        const next = elevatorWaitingRetreatTarget('farther-waiter', 'A', start, landing, h.field.segmentClear, neighbors, 1 / 30);
        if (next) advance(start, next);
        expect(distance(start, first)).toBeGreaterThanOrEqual(.56 - 1e-6);
      }
      const atHold = [1.2, 2.4, 3.6].some(west => [-1.2, 0, 1.2].some(side => distance(start,
        [landing[0] - west, landing[1], landing[2] + side]) < .025));
      expect(atHold).toBe(true);
      // A newly free earlier candidate must not make a settled waiter shuffle.
      expect(elevatorWaitingRetreatTarget('farther-waiter', 'A', start, landing, h.field.segmentClear, [], 1 / 30)).toBeNull();
    } finally { h.dispose(); }
  });

  it('does not bypass foreign solids or invent an escape without a checked floor route', () => {
    const h = fixture(), start: Point3 = [...landing];
    const wall = new Mesh(new BoxGeometry(.1, 1.8, 8)); wall.position.set(landing[0] - .6, landing[1] + .9, landing[2]);
    h.root.add(wall); h.field.rebuild([h.root]);
    try {
      expect(elevatorWaitingRetreatTarget('static-blocked-waiter', 'A', start, landing, h.field.segmentClear, [], 1)).toBeNull();
      expect(elevatorWaitingRetreatTarget('no-floor-waiter', 'A', start, landing, undefined, [], 1)).toBeNull();
      expect(elevatorWaitingRetreatTarget('unwalkable-waiter', 'A', start, landing, () => false, [], 1)).toBeNull();
    } finally { h.dispose(); }
  });

  it('keeps non-token retreat out of shafts, other floors and distant queue positions', () => {
    const h = fixture(), lift = getElevatorGeometry('A');
    try {
      for (const point of [[lift.x, landing[1], lift.z], [landing[0], floorY(1), landing[2]],
        [landing[0] - 5, landing[1], landing[2]], [NaN, landing[1], landing[2]]] as Point3[]) {
        expect(elevatorWaitingRetreatTarget('unsafe-waiter', 'A', point, landing, h.field.segmentClear, [], 1)).toBeNull();
      }
    } finally { h.dispose(); }
  });

  it('physically delivers the already-boarded rider when a reserved waiter blocks the next boarding token', () => {
    const h = fixture(), boarded = ['cab-rider-12'], exited = new Set<string>(), released: string[] = [], requests: string[] = [];
    resetElevator('A'); tickElevator(100, 'A');
    try {
      // Landing-slot reservation is independent of calling the cab. This public
      // API order reproduces waiter16's slot0 while token18 precedes it in FIFO.
      expect(reserveElevatorWaitingSlot({ riderId: 'reserved-waiter-16', from: 3, to: 1 }, 'A')).toBe(0);
      for (const riderId of ['cab-rider-12', 'doorway-token-18', 'reserved-waiter-16']) requestElevator({ riderId, from: 3, to: 1 }, 'A');
      tickElevator(100, 'A');
      expect(liveElevatorAccess.canBoard('cab-rider-12', 'A')).toBe(true);
      expect(liveElevatorAccess.confirmBoarded('cab-rider-12', 'A')).toBe(true);
      expect(liveElevatorAccess.canBoard('doorway-token-18', 'A')).toBe(true);
      expect(liveElevatorAccess.canBoard('reserved-waiter-16', 'A')).toBe(false);
      const exit: Point3 = [...navigation.waypoints.get('f1.elevator-A')!.position];
      const targetIds = ['chat.f1-lounge-hall.a', 'chat.f1-lounge-hall.b', 'outdoor.garden-art'];
      const makeRider = (id: string, position: Point3, phase: Mover['phase'], targetIndex: number): Mover => {
        const target = navigation.seats.get(targetIds[targetIndex]!)!;
        const mover = createMover(id, gaitParameters(), position, 0, false);
        mover.phase = phase; mover.goal = { kind: 'seat', seat: target };
        mover.trip = { id: 'A', from: 3, to: 1, landing: [...landing], exit: [...exit], stage: 'approach', requested: true, exited: false };
        mover.steps = [{ kind: 'elevator', node: 'f1.elevator-A', elevatorId: 'A', from: 3, to: 1, exit: [...exit] },
          { kind: 'walk', node: seatStageId(target.seatId), to: [...target.staging], stairs: false }];
        return mover;
      };
      const movers = [
        makeRider('cab-rider-12', liveElevatorAccess.standingPosition('cab-rider-12', 'A')!, 'riding', 0),
        makeRider('reserved-waiter-16', [23.9, 12.8, -1.77461], 'waiting', 1),
        makeRider('doorway-token-18', [23.97506, 12.8, -2.36], 'boarding', 2),
      ];
      const env: MovementEnv = { navigation, walkable: h.field.segmentClear,
        nearbyWalkers: id => movers.filter(mover => mover.id !== id).map(mover => body(mover.id, mover.position)),
        elevators: { ...liveElevatorAccess,
          request: (id, from, to, lift) => { requests.push(id); liveElevatorAccess.request(id, from, to, lift); },
          release: (id, lift) => { released.push(id); liveElevatorAccess.release(id, lift); },
          confirmBoarded: (id, lift) => { const accepted = liveElevatorAccess.confirmBoarded(id, lift); if (accepted) boarded.push(id); return accepted; },
          confirmExited: (id, lift) => { const accepted = liveElevatorAccess.confirmExited(id, lift); if (accepted) exited.add(id); return accepted; },
        } };
      for (let frame = 0; frame < 6000 && exited.size < 3; frame++) {
        tickElevator(1 / 30, 'A');
        for (const mover of movers) {
          const before: Point3 = [...mover.position]; stepMover(mover, 1 / 30, env);
          expect(Math.hypot(...mover.position.map((value, index) => value - before[index]!) as Point3)).toBeLessThan(.13);
          expect(mover.opacity).toBe(1); expect(['gone', 'vanishing']).not.toContain(mover.phase);
          expect(mover.recovery.attempts).toBe(0);
        }
        if (!boarded.includes('reserved-waiter-16')) expect(getElevatorWaitingSlot('reserved-waiter-16', 'A')).toBe(0);
        for (let a = 0; a < movers.length; a++) for (let b = a + 1; b < movers.length; b++) {
          if (Math.abs(movers[a]!.position[1] - movers[b]!.position[1]) < .8) expect(distance(movers[a]!.position, movers[b]!.position)).toBeGreaterThanOrEqual(.56 - 1e-6);
        }
      }
      expect(boarded).toEqual(['cab-rider-12', 'doorway-token-18', 'reserved-waiter-16']);
      expect([...exited].sort()).toEqual(movers.map(mover => mover.id).sort());
      expect(movers[0]!.position[1]).toBeCloseTo(floorY(1));
      expect(movers[0]!.trip).toBeNull();
      expect(released).toEqual([]); expect(requests).toEqual([]);
      expect(elevatorSnapshot('A').passengers).toEqual([]); expect(elevatorSnapshot('A').queue).toEqual([]);
    } finally { resetElevator('A'); h.dispose(); }
  });
});
