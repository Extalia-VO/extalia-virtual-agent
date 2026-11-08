import { Matrix4, Triangle, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createMobilityFallbackModels, disposeMobilityLibrary } from '../src/office/scene/CampusMobilityModels';
import { VEHICLE_MODELS, VEHICLE_SPECS } from '../src/office/scene/campusMobilityLayout';
import {
  indicatorLensMatrix, SIGNAL_DUTY, SIGNAL_HZ, SIGNAL_LENS_DEPTH, SIGNAL_LENS_HEIGHT, SIGNAL_LENS_WIDTH, SIGNAL_MOUNT,
  signalLit, vehicleIndicatorAnchors,
} from '../src/office/scene/campusVehicleLamps';

describe('body-fixed amber turn indicators', () => {
  it('rotates the entire sloped lens tangent frame with the body, including its local up and width axes', () => {
    const up = new Vector3(0, 1, 0), matrix = new Matrix4(), reference = new Matrix4();
    for (const normal of [[0, .6, .8], [.3, .4, Math.sqrt(.75)], [0, -.6, -.8]] as const) {
      const anchor = { x: .65, y: .8, z: 2.1, normal };
      indicatorLensMatrix({ x: 0, y: 0, z: 0, yaw: 0 }, anchor, reference);
      const localFrame = [0, 1, 2].map(axis => new Vector3().setFromMatrixColumn(reference, axis).normalize());
      for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, .73]) {
        indicatorLensMatrix({ x: 4, y: 2, z: -3, yaw }, anchor, matrix);
        for (const axis of [0, 1, 2]) {
          const actual = new Vector3().setFromMatrixColumn(matrix, axis).normalize();
          const expected = localFrame[axis]!.clone().applyAxisAngle(up, yaw);
          expect(actual.distanceTo(expected), `axis ${axis}, normal ${normal}, yaw ${yaw}`).toBeLessThan(1e-10);
        }
      }
    }
    indicatorLensMatrix({ x: 0, y: 0, z: 0, yaw: Math.PI / 2 }, { x: .65, y: .8, z: 2.1, normal: [0, .6, .8] }, matrix);
    expect(new Vector3().setFromMatrixColumn(matrix, 0).normalize().distanceTo(new Vector3(0, 0, -1))).toBeLessThan(1e-10);
  });

  it('mounts compact front/rear strips on their own lens surfaces and keeps the correct side at every yaw', () => {
    const models = createMobilityFallbackModels();
    const matrix = new Matrix4(), centre = new Vector3(), forward = new Vector3(), local = new Vector3();
    const triangle = new Triangle(), nearest = new Vector3();
    try {
      for (const model of VEHICLE_MODELS) {
        const geometry = models.get(model)!.lamp, position = geometry.getAttribute('position'), tail = geometry.getAttribute('mobilityTail');
        const index = geometry.index, count = index?.count ?? position.count;
        const anchors = vehicleIndicatorAnchors(geometry, VEHICLE_SPECS[model]!);
        for (const [rear, pair] of [[false, anchors.head], [true, anchors.tail]] as const) for (const [side, anchor] of pair.entries()) {
          expect(anchor.x * (side === 0 ? 1 : -1), model).toBeGreaterThan(0);
          expect(anchor.normal[2] * (rear ? -1 : 1), model).toBeGreaterThan(.3);
          let surfaceDistance = Infinity;
          local.set(anchor.x, anchor.y, anchor.z);
          for (let offset = 0; offset + 2 < count; offset += 3) {
            const a = index ? index.getX(offset) : offset;
            if ((tail.getX(a) > .5) !== rear) continue;
            triangle.a.fromBufferAttribute(position, a);
            triangle.b.fromBufferAttribute(position, index ? index.getX(offset + 1) : offset + 1);
            triangle.c.fromBufferAttribute(position, index ? index.getX(offset + 2) : offset + 2);
            triangle.closestPointToPoint(local, nearest);
            surfaceDistance = Math.min(surfaceDistance, local.distanceTo(nearest));
          }
          expect(surfaceDistance, model).toBeLessThan(1e-6);
          for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, .73]) {
            const pose = { x: 11, y: -.5, z: 21, yaw };
            indicatorLensMatrix(pose, anchor, matrix);
            centre.setFromMatrixPosition(matrix).sub(new Vector3(pose.x, pose.y, pose.z));
            const left = centre.x * Math.cos(yaw) - centre.z * Math.sin(yaw);
            const along = centre.x * Math.sin(yaw) + centre.z * Math.cos(yaw);
            expect(left).toBeCloseTo(anchor.x + anchor.normal[0] * SIGNAL_MOUNT);
            expect(along).toBeCloseTo(anchor.z + anchor.normal[2] * SIGNAL_MOUNT);
            expect(left * (side === 0 ? 1 : -1), model).toBeGreaterThan(0);
            expect(along * (rear ? -1 : 1), model).toBeGreaterThan(0);
            forward.set(0, 0, 1).transformDirection(matrix);
            expect(forward.x * Math.sin(yaw) + forward.z * Math.cos(yaw)).toBeCloseTo(anchor.normal[2]);
            expect(new Vector3().setFromMatrixScale(matrix).toArray()).toEqual(expect.arrayContaining([
              expect.closeTo(SIGNAL_LENS_WIDTH, 8), expect.closeTo(SIGNAL_LENS_HEIGHT, 8), expect.closeTo(SIGNAL_LENS_DEPTH, 8),
            ]));
          }
        }
      }
      expect(SIGNAL_LENS_WIDTH).toBeLessThanOrEqual(.15);
      expect(SIGNAL_LENS_HEIGHT).toBeLessThanOrEqual(.06);
      expect(SIGNAL_LENS_DEPTH + SIGNAL_MOUNT).toBeLessThan(.015);
    } finally { disposeMobilityLibrary(models); }
  });

  it('uses a deterministic simulated-time blink, held while traffic is pinned, with steady reduced motion', () => {
    expect(signalLit(0, 0)).toBe(true);
    expect(signalLit(SIGNAL_DUTY / SIGNAL_HZ + .01, 0)).toBe(false);
    expect(signalLit(1 / SIGNAL_HZ, 0)).toBe(true);
    const pinnedSeconds = 12.375;
    const held = signalLit(pinnedSeconds, 17);
    for (const renderTime of [0, 1, 100, 10_000]) {
      // Render time advances independently; a pinned traffic time remains unchanged.
      expect(signalLit(pinnedSeconds, 17), `render frame ${renderTime}`).toBe(held);
    }
    expect(signalLit(0, 7)).not.toBe(signalLit(0, 0));
    for (const seconds of [0, .2, .5, 100]) expect(signalLit(seconds, 9, true)).toBe(true);
  });
});
