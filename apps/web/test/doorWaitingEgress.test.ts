import { describe, expect, it } from 'vitest';
import { doorAxes, doorPoint, type DoorInfo } from '../src/office/scene/interior/doorTraffic';
import type { Point3 } from '../src/office/scene/layout';
import { DOOR_BODY_CLEARANCE } from '../src/office/scene/movement/doorChoreography';
import { doorParkingClear, doorWaitingPath, waitingSegmentClear } from '../src/office/scene/movement/doorWaitingPath';

const geometry: DoorInfo = { floor: 2, center: [3, 6.4, -6.6], yaw: Math.PI, clearWidth: 1.6, height: 2.55,
  openAngle: -Math.PI / 2, hinge: 'right', sliding: false };

describe('continuous escape from an occupied door apron', () => {
  for (const side of [-1, 1] as const) for (const sliding of [false, true]) {
    it(`regains insufficient depth in small checked steps: side${side}, sliding${sliding}`, () => {
      const door = { ...geometry, sliding }, from = doorPoint(door, 0, side * .105, [0, 0, 0]);
      let point = from;
      for (let i = 0; i < 12; i++) {
        const to = doorPoint(door, 0, side * (.105 + (i + 1) * .03), [0, 0, 0]);
        expect(waitingSegmentClear('waiting', door, 1, side, point, to, () => true, [])).toBe(true);
        expect(doorAxes(door, to).through * side).toBeGreaterThan(doorAxes(door, point).through * side);
        point = to;
      }
      expect(doorAxes(door, point).through * side).toBeGreaterThan(DOOR_BODY_CLEARANCE);
      expect(waitingSegmentClear('waiting', door, 1, side, point, from, () => true, [])).toBe(false);
    });
  }

  it('keeps the real threshold escape blocked by furniture, people, inward travel and the wall plane', () => {
    const from: Point3 = [3.0974559268, 6.4, -6.7047514171], outward: Point3 = [from[0], from[1], from[2] - .03];
    expect(waitingSegmentClear('waiting', geometry, 1, 1, from, outward, () => true, [])).toBe(true);
    expect(waitingSegmentClear('waiting', geometry, 1, 1, from, outward, () => false, [])).toBe(false);
    expect(waitingSegmentClear('waiting', geometry, 1, 1, from, outward, () => true,
      [{ id: 'body', position: [from[0], from[1], from[2] - .57], velocity: [0, 0, 0] }])).toBe(false);
    expect(waitingSegmentClear('waiting', geometry, 1, 1, from, [from[0], from[1], from[2] + .03], () => true, [])).toBe(false);
    expect(waitingSegmentClear('waiting', geometry, 1, 1, from, [from[0], from[1], -6.5], () => true, [])).toBe(false);
  });

  it('reserves the pulling operator stance while retaining enough distinct waiting pockets', () => {
    expect(doorParkingClear(geometry, [4.52, 6.4, -5.8])).toBe(false);
    const parked: { id: string; position: Point3; velocity: Point3 }[] = [];
    for (let index = 0; index < 20; index++) {
      const side = index % 2 ? -1 : 1;
      const from = doorPoint(geometry, 0, side * 1.1, [0, 0, 0]);
      const preferred = doorPoint(geometry, -1.52, side * (2.5 + Math.floor(index / 2) * .8), [0, 0, 0]);
      const path = doorWaitingPath(`waiting-${index}`, geometry, 1, side, from, preferred, () => true, parked);
      expect(path?.length).toBeGreaterThan(0);
      const position = path![path!.length - 1]!;
      expect(doorParkingClear(geometry, position)).toBe(true);
      for (const other of parked) expect(Math.hypot(position[0] - other.position[0], position[2] - other.position[2])).toBeGreaterThanOrEqual(.56);
      parked.push({ id: `waiting-${index}`, position, velocity: [0, 0, 0] });
    }
  });

  it('reserves operator movement beyond the quarter-turn radius for a half-turn leaf', () => {
    const door = { ...geometry, center: [0, 0, 0] as Point3, yaw: 0, openAngle: -Math.PI };
    expect(doorParkingClear(door, [.8, 0, -2.55])).toBe(false);
  });

  it('reserves entry-close feet for partial starting openings', () => {
    const door = { ...geometry, center: [0, 0, 0] as Point3, yaw: 0 };
    expect(doorParkingClear(door, [-1.7, 0, -.375])).toBe(false);
    expect(doorParkingClear({ ...door, openAngle: -Math.PI }, [-1.7, 0, -.35])).toBe(false);
  });

  it('does not use an insufficient apron depth to reduce existing leaf clearance', () => {
    const from = doorPoint(geometry, .6, .105, [0, 0, 0]), nearer = doorPoint(geometry, .79, .135, [0, 0, 0]);
    expect(waitingSegmentClear('waiting', geometry, 1, 1, from, nearer, () => true, [])).toBe(false);
  });
});
