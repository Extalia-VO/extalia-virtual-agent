import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { chairOffset, DeskChairMotion, isDeskChair } from '../src/office/scene/interior/deskChairs';
import { OFFICE_CHAIR_SEAT_BLUEPRINT as CHAIR } from '../src/office/scene/interior/furnitureSeatBlueprint';
import { ARMREST, chairContactWorld, chairManeuverSide, chairRootForward, chairWalkPath, chairWorld, sittingCentre, type ChairSide } from '../src/office/scene/movement/chairChoreography';
import { createMover, placeSeated, routeFrom, sendMover, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { officeNavigation, seatStageId, type SeatApproach } from '../src/office/scene/movement/navGraph';
import type { Point3 } from '../src/office/scene/layout';

const navigation = officeNavigation();
const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null, confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };
const env: MovementEnv = { navigation, elevators };
const original = [...navigation.seats.values()].find(s => s.floor === 1 && isDeskChair(s.seatId))!;

/** Same transform composition as the actual chair instance, independent of chairWorld. */
function renderedChair(seat: SeatApproach, pull: number, side: ChairSide): Matrix4 {
  const { back, turn } = chairOffset(pull, seat.seatId, side);
  return new Matrix4().makeTranslation(...seat.seat)
    .multiply(new Matrix4().makeRotationY(seat.rotationY))
    .multiply(new Matrix4().makeTranslation(0, 0, -chairRootForward(seat)))
    .multiply(new Matrix4().makeTranslation(0, 0, -back))
    .multiply(new Matrix4().makeRotationY(turn));
}
const distanceBox = (p: Vector3, x: number, z: number, halfX: number, halfZ: number) => Math.hypot(Math.max(0, Math.abs(p.x - x) - halfX), Math.max(0, Math.abs(p.z - z) - halfZ));
function clearOfChair(point: Readonly<Point3>, inverse: Matrix4) {
  const p = new Vector3(...point).applyMatrix4(inverse);
  expect(distanceBox(p, 0, CHAIR.backZ, 0.265, 0.08)).toBeGreaterThan(0.23);
  for (const side of [-1, 1]) expect(distanceBox(p, side * 0.28, CHAIR.armPadZ, 0.04, 0.15)).toBeGreaterThan(0.23);
  expect(Math.hypot(p.x, p.z)).toBeGreaterThan(CHAIR.baseDiameter / 2 + 0.15);
}

describe('chair entry and exit', () => {
  it('shares the rendered mesh pivot, nonlinear slide and signed swivel for every contact', () => {
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) for (const side of [-1, 1] as const) for (const pull of [0, 0.15, 0.5, 0.85, 1]) {
      const seat = { ...original, seat: [3, 0, -7] as Point3, rotationY: yaw };
      const matrix = renderedChair(seat, pull, side);
      for (const point of [[0, 0, 0], [0.19, 1, -0.30], [-0.28, 0.71, 0.015], [0.28, 0.71, 0.015]]) {
        const rendered = new Vector3(point[0], point[1], point[2]! + CHAIR.rootForward).applyMatrix4(matrix);
        const actual = chairWorld(seat, pull, point[0]!, point[1]!, point[2]!, [0, 0, 0], side);
        expect(new Vector3(...actual).distanceTo(rendered)).toBeLessThan(1e-9);
      }
    }
  });

  it('varies the selected side between maneuvers while reproducing a chosen maneuver', () => {
    for (const id of ['actor', 'another-actor']) {
      const sides = Array.from({ length: 24 }, (_, n) => chairManeuverSide(id, n));
      expect(new Set(sides)).toEqual(new Set([-1, 1]));
      expect(sides).toEqual(Array.from({ length: 24 }, (_, n) => chairManeuverSide(id, n)));
    }
  });

  it('keeps executive armrest contacts on the mesh with its different seat anchor', () => {
    const seat = navigation.seats.get('executive.leader')!;
    expect(chairRootForward(seat)).toBeCloseTo(0.04, 8);
    for (const side of [-1, 1] as const) for (const pull of [0, 0.5, 1]) {
      const world = chairContactWorld(seat, pull, ARMREST.x, ARMREST.y, ARMREST.z, [0, 0, 0], side);
      const mesh = new Vector3(...world).applyMatrix4(renderedChair(seat, pull, side).invert());
      expect(mesh.x).toBeCloseTo(ARMREST.x, 8);
      expect(mesh.y).toBeCloseTo(CHAIR.armPadTop, 8);
      expect(mesh.z).toBeCloseTo(CHAIR.armPadZ, 8);
    }
  });

  for (const side of [-1, 1] as const) it(`enters and exits through side ${side}, clearing the rotated arms, back and base`, () => {
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const seat = { ...original, seat: [0, 0, 0] as Point3, rotationY: yaw };
      const inverse = renderedChair(seat, 1, side).invert();
      const front = chairWalkPath(seat, 'walk-sit', side).at(-1)!;
      const grip = chairWorld(seat, 1, 0, 0, -0.82, [0, 0, 0], side);
      for (const beat of ['walk-sit', 'walk-out']) {
        let previous = beat === 'walk-sit' ? grip : front;
        const path = chairWalkPath(seat, beat, side);
        const first = new Vector3(...path[0]!).applyMatrix4(inverse);
        expect(first.x * side).toBeGreaterThan(0.7);
        for (const target of path) {
          for (let t = 0; t <= 1; t += 0.02) clearOfChair(previous.map((v, i) => v + (target[i]! - v) * t) as Point3, inverse);
          previous = target;
        }
      }
    }
  });

  for (const side of [-1, 1] as const) it(`keeps side ${side} and rendered pose synchronized through a complete sit/stand`, () => {
    const mover = createMover('actor', gaitParameters(), [...original.staging], original.rotationY, false);
    while (chairManeuverSide(mover.id, mover.chairSequence) !== side) mover.chairSequence++;
    routeFrom(mover, seatStageId(original.seatId), { kind: 'seat', seat: original }, env, false);
    const motion = new DeskChairMotion();
    let sitting = false, standing = false, previousPull = 0;
    for (let frame = 0; frame < 60 * 40; frame++) {
      stepMover(mover, 1 / 60, env);
      motion.setTarget(original.seatId, mover.chairPull, mover.chairSide); motion.advance(1 / 60);
      expect(motion.side(original.seatId)).toBe(mover.chairSide);
      expect(motion.pull(original.seatId)).toBe(mover.chairPull);
      const act = mover.chair;
      if (act) {
        expect(act.side).toBe(mover.chairSide);
        if (act.kind === 'sit') expect(act.side).toBe(side);
        const walks = act.kind === 'sit' ? [0, 4] : [0];
        // On an arriving frame the next beat may have begun but has not moved yet.
        if (walks.includes(act.beat) && act.begun) clearOfChair(mover.position, renderedChair(original, mover.chairPull, mover.chairSide).invert());
        if (act.kind === 'sit' && act.beat === 7 && act.begun) {
          const centre = sittingCentre(original, mover.chairPull, [0, 0, 0], mover.chairSide);
          expect(Math.hypot(centre[0] - mover.position[0], centre[2] - mover.position[2])).toBeLessThan(1e-9);
        }
      }
      if (mover.phase === 'standing' && mover.motion.sit < 0.1) {
        expect(mover.chairPull).toBe(1);
        expect(mover.motion.reach.every(r => r.weight === 0)).toBe(true);
      }
      if (Math.abs(previousPull - mover.chairPull) > 1e-6) expect(Math.max(...mover.motion.reach.map(r => r.weight))).toBeGreaterThan(0.5);
      previousPull = mover.chairPull;
      if (!sitting && mover.phase === 'seated') { sitting = true; sendMover(mover, { kind: 'leave', node: navigation.entryId }, env); }
      if (sitting && mover.phase === 'walking' && !mover.chair) { standing = true; break; }
    }
    expect(sitting).toBe(true); expect(standing).toBe(true);
    expect(mover.chairPull).toBe(0);
  });

  it('clears a half-finished chair maneuver when reduced motion places the character', () => {
    const mover = createMover('actor', gaitParameters(), [...original.staging], original.rotationY, false);
    routeFrom(mover, seatStageId(original.seatId), { kind: 'seat', seat: original }, env, false);
    for (let frame = 0; frame < 120; frame++) stepMover(mover, 1 / 60, env);
    expect(mover.chair).not.toBeNull();
    placeSeated(mover, original, env);
    expect(mover.chairPull).toBe(0); expect(mover.chair).toBeNull();
    expect(mover.motion.reach.every(r => r.weight === 0)).toBe(true);
  });
});
