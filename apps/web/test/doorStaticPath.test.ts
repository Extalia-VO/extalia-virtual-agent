import { describe, expect, it } from 'vitest';
import { doorAxes, doorHandedness, doorLeafDistance, doorPoint, type DoorInfo } from '../src/office/scene/interior/doorTraffic';
import type { Point3 } from '../src/office/scene/layout';
import { DOOR_BODY_CLEARANCE, doorOpenPosition, doorWalkPath } from '../src/office/scene/movement/doorChoreography';
import type { WalkableSegment } from '../src/office/scene/movement/naturalWalking';

const base: DoorInfo = { floor: 1, center: [4, 0, -3], yaw: 0, clearWidth: 1.6, height: 2.55, openAngle: -Math.PI / 2, sliding: false };

describe('static-aware door visibility paths', () => {
  for (const hinge of ['left', 'right'] as const) for (const yaw of [0, .8]) {
    it(`finds a clear bend when furniture blocks the leaf-only shortest path: ${hinge}/${yaw}`, () => {
      const q = hinge === 'right' ? -1 : 1;
      const door = { ...base, hinge, yaw, openAngle: -q * Math.PI / 2 };
      const from = doorOpenPosition(door, 1, 1, [0, 0, 0]);
      const to = doorPoint(door, 0, 2.25, [0, 0, 0]);
      const walkable: WalkableSegment = (a, b, radius = .29) => {
        const start = doorAxes(door, a), end = doorAxes(door, b);
        for (let i = 0; i <= 100; i++) {
          const t = i / 100, x = q * (start.across + (end.across - start.across) * t), z = start.through + (end.through - start.through) * t;
          if (Math.abs(x - .58) < .08 + radius && Math.abs(z - 1.46) < .08 + radius) return false;
        }
        return true;
      };
      const unchecked = doorWalkPath(door, 1, from, to)!;
      expect(unchecked).toHaveLength(1);
      expect(walkable(from, unchecked[0]!)).toBe(false);
      const path = doorWalkPath(door, 1, from, to, walkable);
      expect(path).not.toBeNull();
      expect(path!.at(-1)).toEqual(to);
      expect(path!.length).toBeGreaterThan(1);
      let previous: Readonly<Point3> = from;
      for (const point of path!) {
        expect(walkable(previous, point)).toBe(true);
        for (let i = 0; i <= 100; i++) {
          const t = i / 100;
          const feet: Point3 = [previous[0] + (point[0] - previous[0]) * t, previous[1], previous[2] + (point[2] - previous[2]) * t];
          expect(doorLeafDistance(door, 1, feet)).toBeGreaterThanOrEqual(DOOR_BODY_CLEARANCE - 1e-6);
        }
        previous = point;
      }
      expect(doorHandedness(door)).toBe(q);
    });
  }

  it('keeps the maneuver blocked when static geometry admits no candidate path', () => {
    expect(doorWalkPath(base, 1, [5.16, 0, -2.32], [4, 0, -.75], () => false)).toBeNull();
  });
});
