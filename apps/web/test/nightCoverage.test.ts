import { Color } from 'three';
import { describe, expect, it } from 'vitest';
import { CIRCULATION_LIGHT_ROWS } from '../src/office/scene/interior/prefabs/architecture/CirculationLighting';
import { TERRACE_LANTERN_FIXTURES, terraceEntryFixture } from '../src/office/scene/interior/prefabs/architecture/RooftopTerrace';
import { officeCeilingPatches } from '../src/office/scene/interior/prefabs/architecture/OfficeCeilings';
import { ceilingMountsForFloor, ceilingYForFloor, raisedDownlightAngle, raisedDownlightIntensity, raisedDownlightRange } from '../src/office/scene/interior/prefabs/architecture/ceilingMounting';
import { stairUndersideFixtures } from '../src/office/scene/prefabs/architecture/Staircase';
import { FLOOR_HEIGHT, OFFICE_STAIRCASE } from '../src/office/scene/layout';
import { computeSceneEnvironment } from '../src/office/scene/environment/sceneEnvironment';
import { bakeFixtureIrradiance, IRRADIANCE_GRID_DIMENSIONS, IRRADIANCE_GRID_MAX, IRRADIANCE_GRID_MIN, type BakedFixture } from '../src/office/scene/interior/lighting/fixtureIrradiance';

const warm = new Color('#fff0db').toArray() as [number, number, number];
const terraceWarm = new Color('#ffdfb3').toArray() as [number, number, number];

function circulationFixtures(floor: 1 | 2 | 3): BakedFixture[] {
  const y = (floor - 1) * FLOOR_HEIGHT;
  const { sourceY } = ceilingMountsForFloor(floor).corridor;
  return CIRCULATION_LIGHT_ROWS[floor].flatMap(row => row.stops.map(stop => {
    const targetY = row.targetY ?? 0;
    const range = row.range ?? 5.5;
    const zone = row.lightZone ?? row.size;
    const x = row.axis === 'x' ? stop : row.center[0];
    const z = row.axis === 'z' ? stop : row.center[1];
    return { position: [x, y + sourceY, z], aim: [x, y + targetY, z],
      intensity: raisedDownlightIntensity(row.intensity ?? 36, 2.757, sourceY, targetY, range),
      distance: raisedDownlightRange(range, 2.757, sourceY, targetY),
      angle: raisedDownlightAngle(1.05, 2.757, sourceY, targetY), penumbra: 0.65, color: warm,
      floorY: row.floorY ?? y,
      bounds: { west: row.center[0] - zone[0] / 2, east: row.center[0] + zone[0] / 2,
        north: row.center[1] - zone[1] / 2, south: row.center[1] + zone[1] / 2 }
    } satisfies BakedFixture;
  }));
}

/** Match texture3D LinearFilter sampling: voxel centres are half a cell inside the grid bounds. */
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
    luminance += weight * (radiance[index]! * 0.2126 + radiance[index + 1]! * 0.7152 + radiance[index + 2]! * 0.0722);
  }
  return luminance;
}

const terraceEntry = terraceEntryFixture(ceilingYForFloor(3));
const terraceFixtures: BakedFixture[] = [...TERRACE_LANTERN_FIXTURES.map<BakedFixture>(fixture => ({
  position: [fixture.position[0], FLOOR_HEIGHT * 2 + fixture.position[1] + 2.209, fixture.position[2]],
  aim: [fixture.aim[0], FLOOR_HEIGHT * 2 + fixture.aim[1], fixture.aim[2]],
  intensity: fixture.intensity, distance: fixture.distance, angle: fixture.angle, penumbra: 0.65,
  floorY: FLOOR_HEIGHT * 2, color: terraceWarm
})), { ...terraceEntry,
  position: [terraceEntry.position[0], terraceEntry.position[1] + FLOOR_HEIGHT * 2, terraceEntry.position[2]],
  aim: [terraceEntry.aim[0], terraceEntry.aim[1] + FLOOR_HEIGHT * 2, terraceEntry.aim[2]],
  color: terraceWarm, penumbra: 0.65, floorY: FLOOR_HEIGHT * 2 }];

const underStairFixtures: BakedFixture[] = stairUndersideFixtures().map(fixture => ({ ...fixture,
  position: [OFFICE_STAIRCASE.x + fixture.position[0], fixture.position[1], OFFICE_STAIRCASE.z + fixture.position[2]],
  aim: [OFFICE_STAIRCASE.x + fixture.aim[0], fixture.aim[1], OFFICE_STAIRCASE.z + fixture.aim[2]],
  floorY: 0, color: warm
}));

describe('bounded circulation and terrace night coverage', () => {
  it('covers the full east room apron and blends into the existing spine on F2/F3', () => {
    for (const floor of [2, 3] as const) {
      const { radiance } = bakeFixtureIrradiance(circulationFixtures(floor));
      const values = [];
      for (let x = 11.5; x <= 16.5; x += 0.5) for (let z = -6.3; z <= 0; z += 0.45) {
        values.push(sample(radiance, [x, (floor - 1) * FLOOR_HEIGHT + 0, z]));
      }
      expect(Math.min(...values), `F${floor} apron minimum`).toBeGreaterThan(1);
      expect(Math.max(...values) / Math.min(...values), `F${floor} apron/spine seam`).toBeLessThan(5);
      expect(officeCeilingPatches(floor).some(patch => patch.id === 'east-room-apron')).toBe(true);
    }
    expect(officeCeilingPatches(1).some(patch => patch.id === 'east-room-apron')).toBe(false);
  });

  it('lights actual F1 floor beneath the upper return flight with tread-mounted sources', () => {
    const { radiance } = bakeFixtureIrradiance(underStairFixtures);
    for (let z = -13; z <= -8.8; z += 0.35) {
      expect(sample(radiance, [23.5, 0, z]), `under stair z=${z}`).toBeGreaterThan(0.8);
    }
    const treadHeight = OFFICE_STAIRCASE.rise / 2 / OFFICE_STAIRCASE.stepsPerFlight;
    for (const fixture of stairUndersideFixtures()) {
      expect(fixture.position[1]).toBeGreaterThan(3);
      // Housing top meets the underside of a real tread (90 mm below its walking surface).
      const surfaceY = fixture.position[1] + 0.147;
      expect((surfaceY - OFFICE_STAIRCASE.rise / 2) / treadHeight).toBeCloseTo(Math.round((surfaceY - OFFICE_STAIRCASE.rise / 2) / treadHeight));
      expect(fixture.position[1] + 0.057).toBeCloseTo(surfaceY - 0.09);
    }
  });

  it('covers terrace walking strips, west entry and central passage while keeping the doorway clear', () => {
    const { radiance } = bakeFixtureIrradiance(terraceFixtures);
    const values = [];
    // Open front walking edge, rear passing strip, and the centre connecting both seat clusters.
    for (const z of [13.5, 18]) {
      const strip = [];
      for (let x = -19.5; x <= 24; x += 0.5) {
        strip.push(sample(radiance, [x, FLOOR_HEIGHT * 2 + 0, z]));
      }
      values.push(...strip);
      // Soft overlapping pools must not introduce a sharp black seam between adjacent half-metre samples.
      for (let index = 1; index < strip.length; index++) {
        expect(Math.max(strip[index]! / strip[index - 1]!, strip[index - 1]! / strip[index]!)).toBeLessThan(2.5);
      }
    }
    for (let x = -4; x <= 6; x += 0.5) for (let z = 15.5; z <= 18; z += 0.5) {
      values.push(sample(radiance, [x, FLOOR_HEIGHT * 2 + 0, z]));
    }
    expect(Math.min(...values)).toBeGreaterThan(0.3);
    expect(sample(radiance, [-19.5, FLOOR_HEIGHT * 2 + 0, 13.5])).toBeGreaterThan(0.3);
    for (const fixture of TERRACE_LANTERN_FIXTURES) {
      expect(fixture.position[0] < -0.5 || fixture.position[0] > 2.5).toBe(true);
    }
  });

  it('keeps sources local, prevents lower-storey leakage and emits nothing when all source factors are zero', () => {
    const fixtures = [...circulationFixtures(2), ...terraceFixtures];
    const { radiance } = bakeFixtureIrradiance(fixtures);
    expect(sample(radiance, [13, 0, -3])).toBe(0);
    expect(sample(bakeFixtureIrradiance(terraceFixtures).radiance, [1, FLOOR_HEIGHT + 0, 17])).toBe(0);
    expect(sample(bakeFixtureIrradiance(underStairFixtures).radiance, [23.5, FLOOR_HEIGHT + 0, -11.5])).toBe(0);
    expect(sample(radiance, [-1, FLOOR_HEIGHT * 2 + 0, 28])).toBe(0);
    const off = bakeFixtureIrradiance([...fixtures, ...underStairFixtures].map(fixture => ({ ...fixture, intensity: fixture.intensity * 0 })));
    expect(sample(off.radiance, [13, FLOOR_HEIGHT + 0, -3])).toBe(0);
    expect(sample(off.radiance, [1, FLOOR_HEIGHT * 2 + 0, 17])).toBe(0);
    expect(sample(off.radiance, [23.5, 0, -11.5])).toBe(0);
  });

  it('keeps terrace photocells independent of the manual interior switch', () => {
    for (const sky of ['night', 'day'] as const) for (const lightOverride of ['off', 'on'] as const) {
      const { state: { factors } } = computeSceneEnvironment({ sky, lightOverride, epochMs: 0,
        location: { latitude: 0, longitude: 0 } });
      const interior = [...circulationFixtures(2), ...underStairFixtures].map(fixture => ({ ...fixture,
        intensity: fixture.intensity * factors.interiorLightFactor }));
      const exterior = terraceFixtures.map(fixture => ({ ...fixture, intensity: fixture.intensity * factors.exteriorLightFactor }));
      const { radiance } = bakeFixtureIrradiance([...interior, ...exterior]);
      const hall = sample(radiance, [13, FLOOR_HEIGHT, -3]);
      const terrace = sample(radiance, [1, FLOOR_HEIGHT * 2, 17]);
      if (lightOverride === 'off' && sky === 'night') expect(hall).toBe(0);
      else if (lightOverride === 'on') expect(hall).toBeGreaterThan(1);
      else expect(hall).toBeGreaterThan(0);
      if (sky === 'night') expect(terrace).toBeGreaterThan(0.3);
      else expect(terrace).toBe(0);
    }
  });
});
