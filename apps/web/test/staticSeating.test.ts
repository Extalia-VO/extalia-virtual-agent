import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import type { Point3 } from '../src/office/scene/layout';
import { createMover, placeSeated, routeFrom, sendMover, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { officeNavigation, seatApproach, seatStageId, type OfficeNavigation, type SeatApproach } from '../src/office/scene/movement/navGraph';
import type { WalkingNeighbor, WalkableSegment } from '../src/office/scene/movement/naturalWalking';
import { isStaticSeat, STATIC_BODY_SEPARATION, staticSeatContact, staticSeatNeighborsClear, staticSeatPoint, staticSeatRoute } from '../src/office/scene/movement/staticSeating';
import { angleDelta } from '../src/office/scene/movement/walkCycle';
import { OFFICE_RESOURCES } from '../src/office/scene/interior/resourceRegistry';
import { WalkingClearance } from '../src/office/scene/movement/naturalClearance';

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null, confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };
const local = (seat: SeatApproach, p: Readonly<Point3>) => {
  const dx = p[0] - seat.seat[0], dz = p[2] - seat.seat[2];
  return [dx * Math.cos(seat.rotationY) - dz * Math.sin(seat.rotationY), dx * Math.sin(seat.rotationY) + dz * Math.cos(seat.rotationY)];
};
function seatFixture(yaw = 0, side = 1, style: SeatApproach['seatStyle'] = 'sofa'): SeatApproach {
  const seat: SeatApproach = { seatId: 'test-sofa', roomId: 'test', floor: 1, seat: [3, 0, -2], rotationY: yaw,
    seatHeight: 0.43, seatFront: 0.235, seatStyle: style, staging: [0, 0, 0], sitMs: 1000, standMs: 900 };
  return { ...seat, staging: staticSeatPoint(seat, side * 1.4, -1.2) };
}
function navigationFor(seat: SeatApproach, neighbors: SeatApproach[] = []): OfficeNavigation {
  const stage = seatStageId(seat.seatId), exit = staticSeatPoint(seat, 2.5, -1.2);
  return {
    graph: { nodes: new Map([[stage, { id: stage, floorId: 'floor-1', pos: { x: seat.staging[0], y: seat.staging[2] } }], ['exit', { id: 'exit', floorId: 'floor-1', pos: { x: exit[0], y: exit[2] } }]]),
      edges: new Map([[stage, [{ to: 'exit', cost: 4 }]], ['exit', [{ to: stage, cost: 4 }]]]) },
    waypoints: new Map([[stage, { id: stage, floorId: 'floor-1', kind: 'approach', position: seat.staging }], ['exit', { id: 'exit', floorId: 'floor-1', kind: 'corridor', position: exit }]]),
    seats: new Map([seat, ...neighbors].map(item => [item.seatId, item])), edges: [], connectors: [], aisles: new Map(), elevatorEdges: new Map(), entryId: 'exit',
  };
}
/** Deliberately rejects cushion contact with a body radius, just like render bounds. */
function furnitureClearance(seat: SeatApproach, halfWidth = 0.6): WalkableSegment {
  return (a, b, radius = 0.29) => {
    const from = local(seat, a), to = local(seat, b);
    for (let i = 0; i <= 100; i++) {
      const t = i / 100, x = from[0]! + (to[0]! - from[0]!) * t, z = from[1]! + (to[1]! - from[1]!) * t;
      if (Math.abs(x) < halfWidth + radius && z > -0.65 - radius && z < seat.seatFront! + radius) return false;
    }
    return true;
  };
}
const body = (id: string, position: Point3): WalkingNeighbor => ({ id, position, velocity: [0, 0, 0] });
function arriving(seat: SeatApproach, neighbors: WalkingNeighbor[] = [], slots: SeatApproach[] = []) {
  const env: MovementEnv = { navigation: navigationFor(seat, slots), elevators, walkable: furnitureClearance(seat, slots.length ? 1.4 : 0.6), nearbyWalkers: () => neighbors };
  const mover = createMover('visitor', gaitParameters(), seat.staging, 0, false);
  expect(routeFrom(mover, seatStageId(seat.seatId), { kind: 'seat', seat }, env, false)).toBe(true);
  const run = (seconds: number, inspect?: () => void, dt = 1 / 60) => { for (let i = 0; i < seconds / dt; i++) { stepMover(mover, dt, env); inspect?.(); } };
  return { mover, env, run };
}

describe('fixed seating front lanes', () => {
  it('copies static seat style without changing desk, fitness or standing interactions', () => {
    for (const resource of OFFICE_RESOURCES) {
      const seat = seatApproach(resource);
      expect(isStaticSeat(seat), resource.id).toBe(['sofa', 'armchair', 'bench', 'patio'].includes(resource.interaction.seatStyle));
      if (resource.kind === 'fitness-station' || seat.standing) expect(isStaticSeat(seat)).toBe(false);
    }
  });

  it('routes mirrored side/back staging around furniture, with the same geometry after rotation', () => {
    for (const yaw of [0, Math.PI / 2, Math.PI, Math.PI * 1.3]) for (const side of [-1, 1]) {
      const seat = seatFixture(yaw, side), clear = furnitureClearance(seat);
      expect(clear(seat.staging, staticSeatContact(seat))).toBe(false);
      const route = staticSeatRoute('visitor', seat, seat.staging, navigationFor(seat), clear)!;
      expect(route).not.toBeNull();
      let previous = seat.staging;
      for (const point of route.path) { expect(clear(previous, point)).toBe(true); previous = point; }
      expect(local(seat, route.apron)[0]).toBeCloseTo(0);
      expect(local(seat, route.contact)[1]).toBeGreaterThan(seat.seatFront!);
      expect(clear(route.apron, route.contact)).toBe(false);
    }
  });

  it('uses a close front apron when a coffee table leaves a narrow clear standing lane', () => {
    for (const yaw of [Math.PI / 2, -Math.PI / 2]) {
      const seat = seatFixture(yaw, 1, 'armchair'), chairClear = furnitureClearance(seat);
      const clear: WalkableSegment = (a, b, radius) => {
        if (!chairClear(a, b, radius)) return false;
        const from = local(seat, a), to = local(seat, b);
        for (let i = 0; i <= 100; i++) {
          const t = i / 100, x = from[0]! + (to[0]! - from[0]!) * t, z = from[1]! + (to[1]! - from[1]!) * t;
          if (Math.abs(x) < 0.92 && z >= 0.59 && z <= 1.8) return false;
        }
        return true;
      };
      const route = staticSeatRoute('visitor', seat, seat.staging, navigationFor(seat), clear)!;
      expect(route).not.toBeNull();
      expect(local(seat, route.apron)[1]).toBeCloseTo(seat.seatFront! + 0.34);
      let previous = seat.staging;
      for (const point of route.path) { expect(clear(previous, point)).toBe(true); previous = point; }
    }
  });

  it('rounds conservative world bounds of a rotated long sofa before using its masked front contact', () => {
    for (const yaw of [Math.PI / 4, -Math.PI / 4]) {
      const base = seatFixture(yaw), seat = { ...base, seatFront: 0.31, staging: staticSeatPoint(base, 1.8, -1.6) };
      const slots = [-0.8, 0.8].map((x, i) => ({ ...seat, seatId: `slot-${i}`, seat: staticSeatPoint(seat, x, 0) }));
      const root = new Group(), sofa = new Group(), field = new WalkingClearance();
      sofa.userData.officeSeat = true;
      sofa.position.set(...seat.seat); sofa.rotation.y = yaw;
      const mesh = (size: [number, number, number], at: [number, number, number]) => {
        const item = new Mesh(new BoxGeometry(...size), new MeshBasicMaterial()); item.position.set(...at); sofa.add(item);
      };
      mesh([2.8, 0.6, 0.2], [0, 0.7, -0.6]);
      for (const x of [-0.8, 0, 0.8]) mesh([0.78, 0.2, 0.82], [x, 0.33, -0.1]);
      root.add(sofa); field.rebuild([root]);
      const contactClear: WalkableSegment = (from, to, radius) => field.seatContactClear(seat, from, to, radius);
      const route = staticSeatRoute('visitor', seat, seat.staging, navigationFor(seat, slots), field.segmentClear, [], contactClear)!;
      expect(route).not.toBeNull();
      let previous = seat.staging;
      for (const point of route.path) { expect(field.segmentClear(previous, point, 0.29)).toBe(true); previous = point; }
      expect(field.segmentClear(route.apron, route.contact, 0.29)).toBe(false);
      expect(contactClear(route.apron, route.contact, 0.29)).toBe(true);
    }
  });

  it('turns in place before lowering, freezes gait and uses only a small backward hip translation', () => {
    for (const style of ['sofa', 'armchair', 'bench', 'patio'] as const) for (const yaw of [0, Math.PI / 2, -Math.PI * 0.7]) for (const dt of [1 / 60, 0.1]) {
      const seat = seatFixture(yaw, -1, style), h = arriving(seat);
      let lowered = false, phase = 0;
      h.run(25, () => {
        if (h.mover.staticSeat?.beat === 'align') expect(local(seat, h.mover.position)[1]).toBeCloseTo(seat.seatFront! + 0.10);
        if (h.mover.motion.sit > 0 && h.mover.phase !== 'seated') {
          if (!lowered) { lowered = true; phase = h.mover.motion.phase; }
          expect(Math.abs(angleDelta(h.mover.yaw, seat.rotationY))).toBeLessThan(1e-6);
          expect(h.mover.motion.walk).toBe(0);
          expect(h.mover.motion.phase).toBe(phase);
          expect(local(seat, h.mover.position)[0]).toBeCloseTo(0);
          expect(local(seat, h.mover.position)[1]).toBeGreaterThanOrEqual(-1e-8);
          expect(local(seat, h.mover.position)[1]).toBeLessThan(0.5);
        } else if (h.mover.motion.walk > 0.01) {
          const [x, z] = local(seat, h.mover.position);
          expect(Math.abs(x!) > 0.6 || z! >= seat.seatFront! + 0.10 - 1e-6 || z! <= -0.65).toBe(true);
        }
      }, dt);
      expect(lowered).toBe(true);
      expect(h.mover.phase).toBe('seated');
      expect(h.mover.position).toEqual(seat.seat);
    }
  });

  it('reaches the middle of a three-seat sofa through its own front lane with both neighbors occupied', () => {
    for (const yaw of [0, Math.PI / 2, -Math.PI / 3]) {
      const base = seatFixture(yaw), seat = { ...base, staging: staticSeatPoint(base, 2, -1.2) };
      const slots = [-0.8, 0.8].map((x, i) => ({ ...seat, seatId: `neighbor-${i}`, seat: staticSeatPoint(seat, x, 0) }));
      const neighbors = slots.map(item => body(item.seatId, item.seat));
      const h = arriving(seat, neighbors, slots);
      h.run(30, () => {
        for (const other of neighbors) expect(Math.hypot(h.mover.position[0] - other.position[0], h.mover.position[2] - other.position[2])).toBeGreaterThanOrEqual(STATIC_BODY_SEPARATION - 1e-6);
      });
      expect(h.mover.phase).toBe('seated');
      expect(h.mover.position).toEqual(seat.seat);
    }
  });

  it('yields safely to a blocked front lane, retries after release and can cancel a blocked approach', () => {
    const seat = seatFixture(), neighbors = [body('blocking', staticSeatPoint(seat, 0, 0.6))], h = arriving(seat, neighbors);
    h.run(5);
    expect(h.mover.phase).toBe('seatwork');
    expect(h.mover.position).toEqual(seat.staging);
    expect(h.mover.motion.sit).toBe(0);
    expect(h.mover.motion.walk).toBe(0);
    neighbors.length = 0;
    h.run(25);
    expect(h.mover.phase).toBe('seated');

    const blocked = arriving(seat, [body('occupant', seat.seat)]);
    blocked.run(2);
    expect(sendMover(blocked.mover, { kind: 'leave', node: 'exit' }, blocked.env)).toBe(true);
    blocked.run(10);
    expect(blocked.mover.phase).toBe('gone');
  });

  it('checks swept predicted neighbors instead of only the target endpoint', () => {
    const from: Point3 = [0, 0, 0], to: Point3 = [1, 0, 0];
    expect(staticSeatNeighborsClear('visitor', from, to, [body('middle', [0.5, 0, 0])])).toBe(false);
    const crossing: WalkingNeighbor = { id: 'crossing', position: [0.5, 0, 1], velocity: [0, 0, -2] };
    expect(staticSeatNeighborsClear('visitor', from, to, [crossing], 1)).toBe(false);
    expect(staticSeatNeighborsClear('visitor', from, to, [crossing], 0)).toBe(true);
    expect(staticSeatNeighborsClear('visitor', from, to, [body('other-floor', [0.5, 6.4, 0])])).toBe(true);
  });

  it('recalls a visitor safely during exterior walking, front contact, alignment or lowering', () => {
    for (const beat of ['approach', 'contact', 'align', 'lower'] as const) {
      const seat = seatFixture(), h = arriving(seat);
      let reached = false;
      for (let i = 0; i < 1800; i++) {
        stepMover(h.mover, 1 / 60, h.env);
        if (h.mover.staticSeat?.beat === beat && (beat !== 'approach' || h.mover.motion.walk > 0.1)) { reached = true; break; }
      }
      expect(reached, beat).toBe(true);
      const before = [...h.mover.position] as Point3;
      expect(sendMover(h.mover, { kind: 'leave', node: 'exit' }, h.env)).toBe(true);
      expect(h.mover.position).toEqual(before);
      h.run(30);
      expect(h.mover.phase, beat).toBe('gone');
    }
  });

  it('lets the latest same-seat request cancel a departure queued during lowering', () => {
    const seat = seatFixture(), h = arriving(seat);
    for (let i = 0; i < 1800 && h.mover.staticSeat?.beat !== 'lower'; i++) stepMover(h.mover, 1 / 60, h.env);
    expect(h.mover.staticSeat?.beat).toBe('lower');
    sendMover(h.mover, { kind: 'leave', node: 'exit' }, h.env);
    sendMover(h.mover, { kind: 'seat', seat }, h.env);
    expect(h.mover.pending).toBeNull();
    h.run(30);
    expect(h.mover.phase).toBe('seated');
    expect(h.mover.position).toEqual(seat.seat);
  });

  it('uses furniture-specific contact clearance so an unrelated table blocks both entry and rise', () => {
    const seat = seatFixture(), h = arriving(seat);
    let blocked = true;
    const contactClear: WalkableSegment = (from, to) => {
      const a = local(seat, from)[1]!, b = local(seat, to)[1]!;
      return !blocked || Math.max(a, b) < 0.39 || Math.min(a, b) > 0.44;
    };
    const env: MovementEnv = { ...h.env, seatContactClear: (_seat, from, to, radius) => contactClear(from, to, radius) };
    expect(staticSeatRoute('visitor', seat, seat.staging, env.navigation, env.walkable, [], contactClear)).toBeNull();
    for (let i = 0; i < 300; i++) stepMover(h.mover, 1 / 60, env);
    expect(h.mover.position).toEqual(seat.staging);
    expect(h.mover.motion.sit).toBe(0);
    blocked = false;
    for (let i = 0; i < 1800 && h.mover.phase !== 'seated'; i++) stepMover(h.mover, 1 / 60, env);
    expect(h.mover.phase).toBe('seated');
    blocked = true;
    sendMover(h.mover, { kind: 'leave', node: 'exit' }, env);
    for (let i = 0; i < 300; i++) stepMover(h.mover, 1 / 60, env);
    expect(h.mover.position).toEqual(seat.seat);
    expect(h.mover.motion.sit).toBe(1);
    blocked = false;
    for (let i = 0; i < 1800 && h.mover.phase !== 'gone'; i++) stepMover(h.mover, 1 / 60, env);
    expect(h.mover.phase).toBe('gone');
  });

  it('rises forward without gait, waits for exit clearance and walks forward before rounding a behind-stage seat', () => {
    for (const yaw of [0, Math.PI / 2, Math.PI * 1.3]) {
      const seat = seatFixture(yaw, -1), h = arriving(seat), neighbors = [body('blocking', staticSeatPoint(seat, 0, 0.6))];
      const env: MovementEnv = { ...h.env, nearbyWalkers: () => neighbors };
      placeSeated(h.mover, seat, env);
      sendMover(h.mover, { kind: 'leave', node: 'exit' }, env);
      for (let i = 0; i < 120; i++) stepMover(h.mover, 1 / 60, env);
      expect(h.mover.motion.sit).toBe(1);
      expect(h.mover.position).toEqual(seat.seat);
      neighbors.length = 0;
      let rising = false, frontWalk = false, lastZ = 0;
      for (let i = 0; i < 1800 && h.mover.phase !== 'gone'; i++) {
        stepMover(h.mover, 1 / 60, env);
        const [, z] = local(seat, h.mover.position);
        if (h.mover.staticSeat?.beat === 'rise') {
          rising = true;
          expect(z).toBeGreaterThanOrEqual(lastZ - 1e-8);
          expect(h.mover.motion.walk).toBe(0);
          expect(h.mover.yaw).toBe(seat.rotationY);
          lastZ = z!;
        }
        if (h.mover.staticSeat?.beat === 'exit-contact' && h.mover.motion.walk > 0) {
          frontWalk = true;
          expect(z).toBeGreaterThanOrEqual(lastZ - 1e-8);
          expect(Math.abs(angleDelta(h.mover.yaw, seat.rotationY))).toBeLessThan(1e-6);
          lastZ = z!;
        }
      }
      expect(rising).toBe(true);
      expect(frontWalk).toBe(true);
      expect(h.mover.phase).toBe('gone');
    }
  });

  it('keeps desk-chair and standing-station arrival on their established choreography', () => {
    const navigation = officeNavigation();
    for (const id of ['engineering.pod-a.seat-se', 'lounge.bartender']) {
      const seat = navigation.seats.get(id)!, env: MovementEnv = { navigation, elevators };
      const mover = createMover(id, gaitParameters(), seat.staging, seat.rotationY, false);
      routeFrom(mover, seatStageId(id), { kind: 'seat', seat }, env, false);
      stepMover(mover, 1 / 60, env);
      expect(mover.staticSeat).toBeNull();
      expect(mover.phase).toBe(seat.standing ? 'sitting' : 'chairing');
    }
  });
});
