import { describe, expect, it } from 'vitest';
import { buildingOverviewPose, floorOverviewPose, floorOverlayInsets, officeOverlayInsets, stackOverviewPose } from '../src/office/scene/cameraFocus';

/** Screen position (px from the top-left) of a world point for an orthographic pose. */
function project(pose: ReturnType<typeof floorOverviewPose>, point: [number, number, number], width: number, height: number) {
  const back = pose.position.map((value, axis) => value - pose.target[axis]!) as [number, number, number];
  const length = Math.hypot(...back); const b = back.map(value => value / length);
  const flat = Math.hypot(b[0]!, b[2]!); const right = [b[2]! / flat, 0, -b[0]! / flat];
  const up = [-(right[1]! * b[2]! - right[2]! * b[1]!), -(right[2]! * b[0]! - right[0]! * b[2]!), -(right[0]! * b[1]! - right[1]! * b[0]!)];
  const offset = point.map((value, axis) => value - pose.target[axis]!);
  const x = offset.reduce((sum, value, axis) => sum + value * right[axis]!, 0), y = offset.reduce((sum, value, axis) => sum + value * up[axis]!, 0);
  return { x: width / 2 + x * pose.zoom, y: height / 2 - y * pose.zoom };
}

describe('floor overview framing', () => {
  for (const [width, height] of [[1440, 900], [1280, 720], [1920, 1080], [390, 844]] as const) {
    it(`keeps the whole floor plate inside the free stage area at ${width}×${height}`, () => {
      const insets = floorOverlayInsets(width, height);
      for (const level of [0, 6.4, 12.8]) {
        const pose = floorOverviewPose(level, width, height);
        for (const x of [-21, 25]) for (const z of [-19, 19]) for (const y of [level, level + 3.2]) {
          const p = project(pose, [x, y, z], width, height);
          expect(p.x).toBeGreaterThanOrEqual(insets.left - 1);
          expect(p.x).toBeLessThanOrEqual(width - insets.right + 1);
          expect(p.y).toBeGreaterThanOrEqual(insets.top - 1);
          expect(p.y).toBeLessThanOrEqual(height - insets.bottom + 1);
        }
      }
    });
    it(`fits All floors to the free canvas at ${width}×${height}`, () => {
      const insets = floorOverlayInsets(width, height);
      const pose = stackOverviewPose(width, height);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const x of [-21, 25]) for (const z of [-19, 19]) for (const y of [0, 16]) {
        const p = project(pose, [x, y, z], width, height);
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        expect(p.x).toBeGreaterThanOrEqual(insets.left);
        expect(p.x).toBeLessThanOrEqual(width - insets.right);
        expect(p.y).toBeGreaterThanOrEqual(insets.top);
        expect(p.y).toBeLessThanOrEqual(height - insets.bottom);
      }
      // One dimension fills 97% of its usable extent instead of leaving a distant miniature.
      expect(Math.max((maxX - minX) / (width - insets.left - insets.right), (maxY - minY) / (height - insets.top - insets.bottom))).toBeCloseTo(.97, 6);
      expect(pose.zoom).toBeLessThanOrEqual(floorOverviewPose(0, width, height).zoom);
    });
  }

  it('frames the Building view closer than the old fixed campus framing, with the whole building in the free area', async () => {
    const { buildingOverviewPose } = await import('../src/office/scene/cameraFocus');
    const width = 1340, height = 760, insets = officeOverlayInsets(width, height);
    const pose = buildingOverviewPose(width, height, insets);
    expect(pose.zoom).toBeGreaterThan(Math.min(width / 115, height / 70));
    for (const x of [-21, 25]) for (const z of [-30, 19]) for (const y of [0, 22]) {
      const p = project(pose, [x, y, z], width, height);
      expect(p.x).toBeGreaterThanOrEqual(insets.left - 1);
      expect(p.x).toBeLessThanOrEqual(width - insets.right + 1);
      expect(p.y).toBeGreaterThanOrEqual(insets.top - 1);
      expect(p.y).toBeLessThanOrEqual(height - insets.bottom + 1);
    }
  });

  it('zooms in further than the old fixed framing on a desktop stage', () => {
    expect(floorOverviewPose(0, 1440, 900).zoom).toBeGreaterThan(Math.min(1440 / 78, 900 / 56));
    expect(floorOverviewPose(0, 1440, 900).zoom).toBeGreaterThan(floorOverviewPose(0, 1440, 900, officeOverlayInsets(1440, 900)).zoom);
    expect(stackOverviewPose(1440, 900).zoom).toBeGreaterThan(Math.min(1440 / 78, 900 / 68));
  });

  it('retains the Building default pose and zoom independently of floor calibration', () => {
    expect(buildingOverviewPose(1440, 900)).toMatchInlineSnapshot(`
      {
        "position": [
          -40.487794872627674,
          31.075733887512328,
          -80.69284651751546,
        ],
        "target": [
          -7.187804116358011,
          5.611035073894348,
          -3.319338583830058,
        ],
        "zoom": 16.34153330653797,
      }
    `);
  });
});
