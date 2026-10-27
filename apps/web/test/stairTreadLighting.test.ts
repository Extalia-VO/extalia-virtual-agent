import { Color } from 'three';
import { describe, expect, it } from 'vitest';
import { stairTreadFixtures } from '../src/office/scene/prefabs/architecture/Staircase';
import { FLOOR_HEIGHT, OFFICE_STAIRCASE } from '../src/office/scene/layout';
import { computeSceneEnvironment } from '../src/office/scene/environment/sceneEnvironment';
import { bakeFixtureIrradiance, IRRADIANCE_GRID_DIMENSIONS, IRRADIANCE_GRID_MAX, IRRADIANCE_GRID_MIN, type BakedFixture } from '../src/office/scene/interior/lighting/fixtureIrradiance';

const warm = new Color('#fff0db').toArray() as [number, number, number];
const { width, rise, gap, runPerFlight: run, stepsPerFlight: steps } = OFFICE_STAIRCASE;
const tread = run / steps, stepRise = rise / 2 / steps;
const fixtures = stairTreadFixtures();
function worldFixtures(floorY: number, factor = 1): BakedFixture[] {
  return fixtures.map(fixture => ({ ...fixture, color: warm, floorY, intensity: fixture.intensity * factor,
    position: [OFFICE_STAIRCASE.x + fixture.position[0], floorY + fixture.position[1], OFFICE_STAIRCASE.z + fixture.position[2]],
    aim: [OFFICE_STAIRCASE.x + fixture.aim[0], floorY + fixture.aim[1], OFFICE_STAIRCASE.z + fixture.aim[2]],
  }));
}

/** Texture3D LinearFilter sampling, including the half-cell texture-centre offset. */
function sample(radiance: Float32Array, point: [number, number, number]) {
  const coordinate = point.map((value, axis) => (value - IRRADIANCE_GRID_MIN[axis]!) /
    (IRRADIANCE_GRID_MAX[axis]! - IRRADIANCE_GRID_MIN[axis]!) * IRRADIANCE_GRID_DIMENSIONS[axis]! - 0.5);
  let luminance = 0;
  for (const dx of [0, 1]) for (const dy of [0, 1]) for (const dz of [0, 1]) {
    const cell = [dx, dy, dz].map((offset, axis) => Math.max(0, Math.min(IRRADIANCE_GRID_DIMENSIONS[axis]! - 1,
      Math.floor(coordinate[axis]!) + offset)));
    const weight = [dx, dy, dz].reduce((product, offset, axis) => {
      const fraction = coordinate[axis]! - Math.floor(coordinate[axis]!);
      return product * (offset ? fraction : 1 - fraction);
    }, 1);
    const index = ((cell[2]! * IRRADIANCE_GRID_DIMENSIONS[1] + cell[1]!) * IRRADIANCE_GRID_DIMENSIONS[0] + cell[0]!) * 4;
    luminance += weight * (radiance[index]! * .2126 + radiance[index + 1]! * .7152 + radiance[index + 2]! * .0722);
  }
  return luminance;
}

describe('per-tread cached strip lighting', () => {
  it('places three warm samples on every actual strip across both flights and both stair levels', () => {
    expect(fixtures).toHaveLength(108);
    expect(new Set(fixtures.map(fixture => fixture.name)).size).toBe(108);
    let contacts = 0;
    for (const floorY of [0, FLOOR_HEIGHT]) for (const [flight, direction] of [[1, 1], [2, -1]] as const) {
      const baseY = direction === 1 ? 0 : rise / 2;
      const centerX = -direction * (width + gap) / 2;
      for (let i = 0; i < steps; i++) {
        const row = fixtures.filter(fixture => fixture.name.startsWith(`stair-tread-strip-${flight}-${i + 1}-`));
        expect(row).toHaveLength(3); contacts++;
        const surfaceY = floorY + baseY + stepRise * (i + 1);
        const centerZ = direction * (-run / 2 + tread * (i + .5));
        for (const [sampleIndex, fixture] of row.entries()) {
          expect(fixture.position[0]).toBeCloseTo(centerX + (width - .16) * (sampleIndex - 1) / 3, 8);
          expect(floorY + fixture.position[1]).toBeCloseTo(surfaceY - .107, 8);
          expect(fixture.position[2]).toBeCloseTo(centerZ - direction * (tread / 2 + .004), 8);
          expect(fixture.aim[0]).toBe(fixture.position[0]);
          expect(fixture.aim[1]).toBeLessThan(fixture.position[1]);
          expect(direction * (fixture.aim[2] - fixture.position[2])).toBeLessThan(0);
          expect(fixture.distance).toBeGreaterThanOrEqual(1.5); expect(fixture.distance).toBeLessThanOrEqual(1.8);
          expect(fixture.angle).toBeGreaterThanOrEqual(1.2); expect(fixture.angle).toBeLessThanOrEqual(1.4);
          expect(fixture.intensity).toBeLessThan(1);
        }
      }
    }
    expect(contacts).toBe(72);
  });

  it('adapts strip positions to semantic stair dimensions', () => {
    const custom = stairTreadFixtures({ width: 3.2, rise: 7.2, run: 6, steps: 20 });
    expect(custom).toHaveLength(120);
    const expected = [-(3.2 + gap) / 2 - (3.2 - .16) / 3, 7.2 / 2 / 20 - .107, -6 / 2 - .004];
    expected.forEach((value, axis) => expect(custom[0]!.position[axis]).toBeCloseTo(value, 8));
    expect(custom.at(-1)!.position[1]).toBeCloseTo(7.2 - .107, 8);
  });

  it('blends a bounded warm spill over lower tread edges and centers in the existing coarse cache', () => {
    for (const floorY of [0, FLOOR_HEIGHT]) {
      const { radiance } = bakeFixtureIrradiance(worldFixtures(floorY));
      const values: number[] = [], ratios: number[] = [];
      for (const direction of [1, -1]) for (let i = 0; i < steps; i++) {
        const centerX = OFFICE_STAIRCASE.x - direction * (width + gap) / 2;
        const sourceY = floorY + (direction === 1 ? 0 : rise / 2) + stepRise * (i + 1);
        const sourceZ = OFFICE_STAIRCASE.z + direction * (-run / 2 + tread * (i + .5));
        // These positions are on the lower tread (or the arrival pad for the first strip).
        // Metre-scale voxels blend adjacent strips; they do not resolve individual light pools.
        const row = [-.43, 0, .43].map(across => sample(radiance,
          [centerX + width * across, sourceY - stepRise + .018, sourceZ - direction * tread * .85]));
        values.push(...row); ratios.push(Math.max(...row) / Math.min(...row));
      }
      expect(Math.min(...values)).toBeGreaterThan(.01);
      expect(Math.max(...values)).toBeLessThan(20);
      expect(Math.max(...ratios)).toBeLessThan(5);
    }
  });

  it('obeys night/manual power, preserves day fill and contributes zero with night lamps off', () => {
    for (const floorY of [0, FLOOR_HEIGHT]) for (const sky of ['day', 'night'] as const) for (const lightOverride of ['auto', 'on', 'off'] as const) {
      const { state: { factors } } = computeSceneEnvironment({ sky, lightOverride, epochMs: 0, location: { latitude: 0, longitude: 0 } });
      const { radiance } = bakeFixtureIrradiance(worldFixtures(floorY, factors.interiorLightFactor));
      const source = worldFixtures(floorY)[30]!;
      const value = sample(radiance, source.aim);
      if (lightOverride === 'off' && sky === 'night') expect(value).toBe(0);
      else expect(value).toBeGreaterThan(.01);
      if (floorY > 0) expect(sample(radiance, [OFFICE_STAIRCASE.x, floorY - 1, OFFICE_STAIRCASE.z])).toBe(0);
    }
  });
});
