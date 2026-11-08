import { describe, expect, it } from 'vitest';
import { OrthographicCamera, Plane, Raycaster, Vector2, Vector3 } from 'three';
import { buildingMinimumZoom, buildingOverviewPose } from '../src/office/scene/cameraFocus';
import { CITY_GROUND } from '../src/office/scene/campusGroundBounds';
import type { Point3 } from '../src/office/scene/layout';

function groundSamples(width: number, height: number, position: Point3, target: Point3, zoom: number) {
  const camera = new OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, .1, 600);
  camera.position.set(...position); camera.lookAt(...target); camera.zoom = zoom;
  camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  const plane = new Plane(new Vector3(0, 1, 0), -CITY_GROUND.y);
  const ray = new Raycaster();
  return [-1, 1].flatMap(x => [-1, 1].map(y => {
    ray.setFromCamera(new Vector2(x, y), camera);
    const hit = ray.ray.intersectPlane(plane, new Vector3());
    return hit ? { radius: Math.hypot(hit.x, hit.z), depth: hit.clone().project(camera).z } : null;
  }));
}

describe('Building zoom-out limit', () => {
  it('keeps the lower ground in front of the near plane for a shallow, zoomed-out camera', () => {
    const position: Point3 = [-40, 31, -81], target: Point3 = [-7, 5.5, -3.5];
    expect(groundSamples(1440, 916, position, target, 9).some(sample => !sample || sample.depth < -1)).toBe(true);
    const minimum = buildingMinimumZoom(1440, 916, position, target);
    for (const sample of groundSamples(1440, 916, position, target, minimum)) {
      expect(sample).not.toBeNull();
      expect(sample!.depth).toBeGreaterThanOrEqual(-1);
      expect(sample!.radius).toBeLessThan(CITY_GROUND.radius - 11);
    }
  });
  for (const [width, height] of [[1440, 900], [1280, 720], [1920, 1080], [390, 844]] as const) {
    it(`keeps the circular ground rim outside the viewport at ${width}×${height}`, () => {
      const pose = buildingOverviewPose(width, height);
      const min = buildingMinimumZoom(width, height, pose.position, pose.target);
      expect(min).toBeGreaterThan(2);
      if (width >= 700) expect(min).toBeLessThan(pose.zoom);
      for (const sample of groundSamples(width, height, pose.position, pose.target, min)) {
        expect(sample).not.toBeNull();
        expect(sample!.radius).toBeLessThan(CITY_GROUND.radius - 11);
        expect(sample!.depth).toBeGreaterThanOrEqual(-1);
        expect(sample!.depth).toBeLessThanOrEqual(1);
      }
      const outside = groundSamples(width, height, pose.position, pose.target, min * .95);
      expect(outside.some(sample => !sample || sample.radius > CITY_GROUND.radius - 12 || sample.depth < -1)).toBe(true);
    });
  }

  it('adapts to a panned and rotated Building view, keeping the neighborhood in frame', () => {
    const pose = buildingOverviewPose(1440, 900);
    const target: Point3 = [55, 5, -30];
    const position: Point3 = [target[0] + 45, target[1] + 30, target[2] + 65];
    const min = buildingMinimumZoom(1440, 900, position, target);
    expect(min).toBeLessThan(pose.zoom);
    for (const sample of groundSamples(1440, 900, position, target, min)) {
      expect(sample).not.toBeNull();
      expect(sample!.radius).toBeLessThan(CITY_GROUND.radius - 11);
      expect(sample!.depth).toBeGreaterThanOrEqual(-1);
    }
  });
});
