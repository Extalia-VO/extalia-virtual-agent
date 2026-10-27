import { describe, expect, it } from 'vitest';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { FLOOR_HEIGHT } from '../src/office/scene/layout';
import { visibleOnFloor } from '../src/office/scene/movement/director';
import { createMover } from '../src/office/scene/movement/mover';
import { floorAt } from '../src/office/scene/movement/navGraph';
import { elevatorCabVisible } from '../src/office/scene/prefabs/architecture/GlassElevator';

describe('follow visibility through vertical transit', () => {
  it.each([[1, 3], [3, 1]] as const)('keeps both rider and cabin visible on the live floor during F%s to F%s through-trips', (from, to) => {
    const mover = createMover('rider', gaitParameters(), [0, (from - 1) * FLOOR_HEIGHT, 0], 0, false);
    mover.phase = 'riding';
    mover.trip = { id: 'A', from, to, exit: [0, (to - 1) * FLOOR_HEIGHT, 0], landing: [0, (from - 1) * FLOOR_HEIGHT, 0],
      stage: 'slot', requested: true, exited: false };
    const passenger = { riderId: mover.id, from, to, slot: 0, boarded: true };
    const seen = new Set<number>();
    for (let frame = 0; frame <= 240; frame++) {
      mover.position[1] = ((from - 1) + (to - from) * frame / 240) * FLOOR_HEIGHT;
      const floor = floorAt(mover.position[1]);
      seen.add(floor);
      expect(visibleOnFloor(mover, floor), `rider at ${mover.position[1]}`).toBe(true);
      expect(elevatorCabVisible({ y: mover.position[1], passengers: [passenger] }, floor), `cab at ${mover.position[1]}`).toBe(true);
      expect(visibleOnFloor(mover, from)).toBe(true);
      expect(visibleOnFloor(mover, to)).toBe(true);
    }
    expect([...seen].sort()).toEqual([1, 2, 3]);
  });

  it('keeps a stair walker visible at the nearest floor while retaining ordinary floor isolation', () => {
    const mover = createMover('walker', gaitParameters(), [0, 0, 0], 0, false);
    for (const lower of [1, 2] as const) {
      mover.floorLow = lower;
      mover.floorHigh = lower === 1 ? 2 : 3;
      for (let frame = 0; frame <= 100; frame++) {
        mover.position[1] = (lower - 1 + frame / 100) * FLOOR_HEIGHT;
        expect(visibleOnFloor(mover, floorAt(mover.position[1]))).toBe(true);
      }
    }
    mover.floorLow = mover.floorHigh = 2;
    expect(visibleOnFloor(mover, 1)).toBe(false);
    expect(visibleOnFloor(mover, 3)).toBe(false);
    expect(elevatorCabVisible({ y: 0, passengers: [] }, 3)).toBe(false);
    expect(elevatorCabVisible({ y: 0, passengers: [] }, 'stack')).toBe(true);
  });
});
