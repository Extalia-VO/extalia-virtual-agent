import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import type { Point3 } from '../src/office/scene/layout';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { WalkingClearance } from '../src/office/scene/movement/naturalClearance';
import { officeNavigation, type SeatApproach } from '../src/office/scene/movement/navGraph';
import { createMover, placeSeated, sendMover, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';

const seat: SeatApproach = { seatId: 'fitness.bike-test', roomId: 'fitness', floor: 1, seat: [0, 0, 0], staging: [1.1, 0, 0],
  rotationY: 0, seatStyle: 'office', seatHeight: .9, sitMs: 900, standMs: 900, equipment: true };
function box(size: Point3, position: Point3) {
  const mesh = new Mesh(new BoxGeometry(...size), new MeshBasicMaterial()); mesh.position.set(...position); return mesh;
}
function fixture() {
  const root = new Group(), station = new Group(), saddle = new Group(), anchor = new Group(), field = new WalkingClearance();
  station.name = seat.seatId; station.userData.officeSeatStation = true;
  anchor.userData.officeEquipmentSeat = true;
  saddle.userData.officeSeat = true;
  saddle.add(box([.3, .12, .3], [0, .82, 0]));
  station.add(saddle, box([.7, .6, .5], [.25, .6, 0]), anchor); root.add(station);
  field.rebuild([root]);
  return { root, station, saddle, anchor, field, rebuild: () => field.rebuild([root]) };
}

describe('mounted equipment seat clearance', () => {
  it('permits the full authored dismount and reverse mount lane while ordinary frames remain solid', () => {
    const { field } = fixture();
    expect(field.segmentClear(seat.seat, seat.staging, .29)).toBe(false);
    expect(field.segmentClear([.6, 0, 0], seat.staging, .29)).toBe(false);
    expect(field.seatExitClear(seat, seat.seat, seat.staging)).toBe(true);
    expect(field.seatExitClear(seat, [.6, 0, 0], seat.staging)).toBe(true);
    expect(field.seatEntryClear(seat, seat.staging, seat.seat)).toBe(true);
    expect(field.segmentClear(seat.staging, [1.5, 0, 0], .29)).toBe(true);
    expect(field.seatExitClear({ ...seat, equipment: false }, seat.seat, seat.staging)).toBe(false);
  });

  it('authenticates the explicit rider root and its nearest station by exact identity and world position', () => {
    const h = fixture();
    expect(h.field.seatExitClear({ ...seat, seatId: 'fitness.other-bike' }, seat.seat, seat.staging)).toBe(false);
    h.station.userData.officeSeatStation = false; h.rebuild();
    expect(h.field.seatExitClear(seat, seat.seat, seat.staging)).toBe(false);
    h.station.userData.officeSeatStation = true; h.station.name = 'fitness.other-bike'; h.rebuild();
    expect(h.field.seatExitClear(seat, seat.seat, seat.staging)).toBe(false);
    h.station.name = seat.seatId; h.anchor.position.x = .031; h.rebuild();
    expect(h.field.seatExitClear(seat, seat.seat, seat.staging)).toBe(false);
    h.anchor.position.set(0, .021, 0); h.rebuild();
    expect(h.field.seatExitClear(seat, seat.seat, seat.staging)).toBe(false);
    h.anchor.position.set(0, 0, 0); h.anchor.userData.officeEquipmentSeat = false; h.rebuild();
    expect(h.field.seatExitClear(seat, seat.seat, seat.staging)).toBe(false);
    h.anchor.userData.officeEquipmentSeat = true; h.anchor.userData.officeSeatStation = true; h.anchor.name = 'fitness.foreign-station'; h.rebuild();
    expect(h.field.seatExitClear(seat, seat.seat, seat.staging)).toBe(false);
  });

  it('retains the explicit contact when loaded meshes replace every fallback saddle anchor', () => {
    const h = fixture();
    h.saddle.userData.officeSeat = false; h.rebuild();
    expect(h.field.segmentClear(seat.seat, seat.staging)).toBe(false);
    expect(h.field.seatExitClear(seat, seat.seat, seat.staging)).toBe(true);
    expect(h.field.seatEntryClear(seat, seat.staging, seat.seat)).toBe(true);
    h.station.remove(h.saddle); h.rebuild();
    expect(h.field.seatExitClear(seat, seat.seat, seat.staging)).toBe(true);
    h.station.remove(h.anchor); h.rebuild();
    expect(h.field.seatExitClear(seat, seat.seat, seat.staging)).toBe(false);
  });

  it('rejects lateral, backward, overrun, cross-floor and nonfinite contact paths', () => {
    const { field } = fixture();
    for (const [from, to] of [
      [[0, 0, .121], [1.1, 0, .121]], [[.7, 0, 0], [.5, 0, 0]],
      [[-.02, 0, 0], [.5, 0, 0]], [[.5, 0, 0], [1.12, 0, 0]],
      [[0, .1, 0], [1.1, .1, 0]], [[NaN, 0, 0], seat.staging],
    ] as readonly (readonly [Point3, Point3])[]) expect(field.seatExitClear(seat, from, to)).toBe(false);
    expect(field.seatExitClear({ ...seat, staging: [1.1, .1, 0] }, seat.seat, seat.staging)).toBe(false);
    expect(field.seatExitClear(seat, seat.seat, seat.staging, -1)).toBe(false);
  });

  it('retains full-radius checks against foreign seats, station frames and nearby solids', () => {
    for (const tag of ['none', 'seat', 'station'] as const) {
      const h = fixture(), obstacle = new Group();
      if (tag === 'seat') obstacle.userData.officeSeat = true;
      if (tag === 'station') { obstacle.userData.officeSeatStation = true; obstacle.name = 'fitness.other-bike'; }
      // The centerline is free, but the full .29m body intersects this foreign edge.
      obstacle.add(box([.1, .7, .1], [.75, .7, .25])); h.root.add(obstacle); h.rebuild();
      expect(h.field.seatExitClear(seat, seat.seat, seat.staging)).toBe(false);
      expect(h.field.seatEntryClear(seat, seat.staging, seat.seat)).toBe(false);
      h.root.remove(obstacle); h.rebuild();
      expect(h.field.seatExitClear(seat, seat.seat, seat.staging)).toBe(true);
    }
  });

  it('requires full-radius slab support throughout an upper-floor dismount', () => {
    const h = fixture(), upper = { ...seat, floor: 3 as const, seat: [0, 12.8, 0] as Point3, staging: [1.1, 12.8, 0] as Point3 };
    h.station.position.y = 12.8; h.rebuild();
    expect(h.field.seatExitClear(upper, upper.seat, upper.staging)).toBe(false);
    const slab = box([4, .1, 2], [.55, 12.75, 0]); h.root.add(slab); h.rebuild();
    expect(h.field.seatExitClear(upper, upper.seat, upper.staging)).toBe(true);
    slab.scale.z = .2; h.rebuild();
    expect(h.field.seatExitClear(upper, upper.seat, upper.staging)).toBe(false);
  });

  it('dismounts an actual bike navigation seat through its whole stage before rejoining ordinary travel', () => {
    const navigation = officeNavigation(), bike = navigation.seats.get('fitness.bike-1')!;
    const target = navigation.seats.get('chat.f3-south-hall.a')!;
    expect(bike.equipment).toBe(true);
    const h = fixture(), dx = bike.staging[0] - bike.seat[0], dz = bike.staging[2] - bike.seat[2], length = Math.hypot(dx, dz);
    h.station.name = bike.seatId; h.station.position.set(...bike.seat); h.station.rotation.y = Math.atan2(dx, dz);
    // Turn the synthetic frame along the actual authored side dismount lane.
    const frame = h.station.children[1]!; frame.position.set(0, .6, .25); frame.rotation.y = Math.PI / 2;
    h.root.add(box([60, .1, 60], [0, bike.seat[1] - .05, 0])); h.rebuild();
    const blocker: Point3 = [bike.seat[0] + dx / length * .8, bike.seat[1], bike.seat[2] + dz / length * .8];
    let occupied = true;
    const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
      confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };
    const env: MovementEnv = { navigation, elevators, walkable: h.field.segmentClear,
      seatExitClear: h.field.seatExitClear, seatEntryClear: h.field.seatEntryClear,
      nearbyWalkers: () => occupied ? [{ id: 'other-character', position: blocker, velocity: [0, 0, 0] }] : [] };
    const mover = createMover('bike-rider', gaitParameters(), bike.seat, bike.rotationY, false);
    placeSeated(mover, bike, env);
    expect(sendMover(mover, { kind: 'seat', seat: target }, env)).toBe(true);
    let reachedStage = false, leftControlledContact = false;
    for (let frame = 0; frame < 3600 && !(mover.phase === 'seated' && mover.seat?.seatId === target.seatId); frame++) {
      if (frame === 150) occupied = false;
      const before: Point3 = [...mover.position]; stepMover(mover, 1 / 30, env);
      expect(Math.hypot(...mover.position.map((value, index) => value - before[index]!) as Point3)).toBeLessThan(.08);
      expect(mover.opacity).toBe(1);
      expect(['gone', 'vanishing']).not.toContain(mover.phase);
      if (occupied) expect(Math.hypot(mover.position[0] - blocker[0], mover.position[2] - blocker[2])).toBeGreaterThanOrEqual(.55);
      const stageDistance = Math.hypot(mover.position[0] - bike.staging[0], mover.position[2] - bike.staging[2]);
      reachedStage ||= stageDistance < .08;
      if (!mover.seatExit && Math.hypot(mover.position[0] - bike.seat[0], mover.position[2] - bike.seat[2]) > .7) {
        leftControlledContact = true;
        expect(h.field.segmentClear(mover.position, mover.position, .29)).toBe(true);
      }
      if (frame === 149) expect(reachedStage).toBe(false);
    }
    expect(reachedStage).toBe(true); expect(leftControlledContact).toBe(true);
    expect(mover.phase).toBe('seated'); expect(mover.seat?.seatId).toBe(target.seatId);
    expect(mover.position).toEqual(target.seat);
    expect(sendMover(mover, { kind: 'seat', seat: bike }, env)).toBe(true);
    for (let frame = 0; frame < 3600 && !(mover.phase === 'seated' && mover.seat?.seatId === bike.seatId); frame++) {
      const before: Point3 = [...mover.position]; stepMover(mover, 1 / 30, env);
      expect(Math.hypot(...mover.position.map((value, index) => value - before[index]!) as Point3)).toBeLessThan(.08);
      expect(mover.opacity).toBe(1);
      expect(['gone', 'vanishing']).not.toContain(mover.phase);
    }
    expect(mover.phase).toBe('seated'); expect(mover.seat?.seatId).toBe(bike.seatId);
    expect(mover.position).toEqual(bike.seat);
  });
});
