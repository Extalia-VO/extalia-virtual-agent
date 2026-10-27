import { describe, expect, it } from 'vitest';
import {
  ACTIVE_DESK_PRIORITY, assignLightSlots, clusterLightCandidates, DESK_SCREEN_SPOT, deviceIrradiancePower, glowLayers, isForwardOnly, isNight,
  MIN_SPILL_PROJECTED_HEIGHT, screenCastStrength, screenGlowStrength, SCREEN_LIGHT_BUDGET, screenLightPriority, screenSpotIntensity, screenSpotShape,
  selectScreenLights, tiltedAim, WALL_SCREEN_SPOT, type LightCandidate,
} from '../src/office/scene/interior/prefabs/screens/screenLightBudget';
import { displayEmission, LOCKED_BACKLIGHT, measureScreenPixels } from '../src/office/scene/interior/prefabs/screens/screenPhotometry';
import { glowGeometry } from '../src/office/scene/interior/prefabs/screens/screenGlow';
import { bakeFixtureIrradiance, IRRADIANCE_GRID_DIMENSIONS, IRRADIANCE_GRID_MAX, IRRADIANCE_GRID_MIN } from '../src/office/scene/interior/lighting/fixtureIrradiance';
import { composeIrradiance } from '../src/office/scene/interior/lighting/composeIrradiance';
import { DataUtils } from 'three';

const candidate = (id: string, intensity = 10, projectedHeight = 40): LightCandidate => ({ id, intensity, projectedHeight });

describe('screen light budget', () => {
  it('uses a small fixed pool of real lights', () => {
    expect(SCREEN_LIGHT_BUDGET).toBeGreaterThan(0);
    expect(SCREEN_LIGHT_BUDGET).toBeLessThanOrEqual(8);
    const crowd = Array.from({ length: 80 }, (_, index) => candidate(`s${index}`, 5 + index));
    expect(selectScreenLights(crowd)).toHaveLength(SCREEN_LIGHT_BUDGET);
    expect(selectScreenLights(crowd, 3)).toHaveLength(3);
    expect(selectScreenLights(crowd, 0)).toEqual([]);
  });

  it('prefers big, bright panels and skips dark, tiny or unlit ones', () => {
    const picked = selectScreenLights([
      candidate('dim', 1, 40), candidate('bright', 30, 40), candidate('large', 10, 120), candidate('tiny', 40, MIN_SPILL_PROJECTED_HEIGHT - 1),
      candidate('off', 0, 80), candidate('mid', 10, 40),
    ], 3);
    expect(picked).toEqual(['large', 'bright', 'mid']);
    expect(picked).not.toContain('tiny');
    expect(picked).not.toContain('off');
  });

  it('is deterministic and keeps a screen on its light instead of flickering between near-ties', () => {
    const tied = [candidate('b'), candidate('a')];
    expect(selectScreenLights(tied, 1)).toEqual(['a']);
    const close = [candidate('x', 10, 40), candidate('y', 10, 41)];
    expect(selectScreenLights(close, 1)).toEqual(['y']);
    expect(selectScreenLights(close, 1, new Set(['x']))).toEqual(['x']);
  });

  it('assigns pool slots so surviving screens keep their light', () => {
    const first = assignLightSlots(['a', 'b', 'c'], [], 4);
    expect(first).toEqual(['a', 'b', 'c', null]);
    const second = assignLightSlots(['c', 'd', 'a'], first, 4);
    expect(second[0]).toBe('a');
    expect(second[2]).toBe('c');
    expect(second[1]).toBe('d');
    expect(second[3]).toBeNull();
    expect(assignLightSlots(['a', 'b', 'c', 'd', 'e'], [], 3)).toEqual(['a', 'b', 'c']);
  });
});

describe('desk clustering', () => {
  it('lets the monitors of one desk share a light, so the budget covers desks', () => {
    const merged = clusterLightCandidates([
      { ...candidate('m1', 10, 40), cluster: 'desk-a' }, { ...candidate('m2', 6, 55), cluster: 'desk-a' }, { ...candidate('tv', 30, 90) },
      { ...candidate('m3', 12, 40), cluster: 'desk-b' },
    ]);
    expect(merged.map(entry => entry.id)).toEqual(['desk-a', 'tv', 'desk-b']);
    expect(merged[0]).toMatchObject({ intensity: 16, projectedHeight: 55, members: [0, 1] });
    expect(merged[1]).toMatchObject({ members: [2] });
    // A three-monitor desk outranks a single-monitor desk of equal panels.
    const desks = clusterLightCandidates([
      { ...candidate('a1', 8, 40), cluster: 'a' }, { ...candidate('a2', 8, 40), cluster: 'a' }, { ...candidate('a3', 8, 40), cluster: 'a' },
      { ...candidate('b1', 8, 40), cluster: 'b' },
    ]);
    expect(selectScreenLights(desks, 1)).toEqual(['a']);
  });
});

describe('active desks first', () => {
  it('gives the pooled lights to desks where an agent works before idle desks and wall boards', () => {
    expect(screenLightPriority({ mode: 'live' }, false)).toBe(ACTIVE_DESK_PRIORITY);
    expect(screenLightPriority({ mode: 'locked' }, false)).toBe(1);
    expect(screenLightPriority({ mode: 'live' }, true)).toBe(1);
    const picked = selectScreenLights([
      candidate('idle-a', 10, 50), candidate('idle-b', 10, 50), { ...candidate('busy', 8, 40), priority: ACTIVE_DESK_PRIORITY },
    ], 1);
    expect(picked).toEqual(['busy']);
  });

  it('lets one busy monitor lift its whole desk cluster', () => {
    const merged = clusterLightCandidates([
      { ...candidate('m1', 8, 40), cluster: 'desk', priority: 1 }, { ...candidate('m2', 8, 40), cluster: 'desk', priority: ACTIVE_DESK_PRIORITY },
      { ...candidate('other', 8, 40) },
    ]);
    expect(merged[0]).toMatchObject({ priority: ACTIVE_DESK_PRIORITY });
    expect(merged[1]?.priority).toBeUndefined();
  });
});

describe('screen-cast light gating', () => {
  it('casts only at night with the room lamps off', () => {
    expect(screenCastStrength(0, false)).toBe(0); // daylight, lamps forced off: emissive only
    expect(screenCastStrength(0, true)).toBe(0);
    expect(screenCastStrength(1, true)).toBe(0); // night, lamps on (On, or Auto after dusk)
    expect(screenCastStrength(1, false)).toBe(1); // night, lamps off
    expect(screenCastStrength(0.49, false)).toBe(0);
    const dusk = screenCastStrength(0.65, false);
    expect(dusk).toBeGreaterThan(0);
    expect(dusk).toBeLessThan(1);
    expect(screenCastStrength(2, false)).toBe(1);
    expect(screenCastStrength(Number.NaN, false)).toBe(0);
    expect(screenGlowStrength).toBe(screenCastStrength);
    expect(isNight(0.49)).toBe(false);
    expect(isNight(0.5)).toBe(true);
  });

  it('turns every glow layer and the baked device light off unless the room is dark', () => {
    for (const [night, lampsOn] of [[0, false], [0, true], [1, true], [0.3, false]] as const) {
      expect(glowLayers(screenCastStrength(night, lampsOn))).toEqual({ halo: 0, pool: 0, spill: 0 });
      expect(deviceIrradiancePower(screenCastStrength(night, lampsOn))).toBe(0);
    }
    const dark = glowLayers(screenCastStrength(1, false));
    expect(dark.halo).toBeGreaterThan(0);
    expect(dark.pool).toBeGreaterThan(0);
    expect(dark.spill).toBe(1);
    expect(deviceIrradiancePower(1)).toBe(1);
    expect(deviceIrradiancePower(0.64)).toBe(0.6);
  });

  it('caps the pooled spot so a bright desk never blows out the person sitting there', () => {
    expect(screenSpotShape(0.5)).toBe(DESK_SCREEN_SPOT);
    expect(screenSpotShape(2)).toBe(WALL_SCREEN_SPOT);
    expect(screenSpotIntensity(DESK_SCREEN_SPOT, 1000, 1)).toBe(DESK_SCREEN_SPOT.maxIntensity);
    expect(screenSpotIntensity(WALL_SCREEN_SPOT, 1000, 1)).toBe(WALL_SCREEN_SPOT.maxIntensity);
    expect(screenSpotIntensity(DESK_SCREEN_SPOT, 1000, 0)).toBe(0);
    expect(screenSpotIntensity(DESK_SCREEN_SPOT, 5, 1)).toBeCloseTo(5 * DESK_SCREEN_SPOT.scale);
    expect(DESK_SCREEN_SPOT.maxIntensity).toBeLessThanOrEqual(1);
  });
});

describe('forward-only screen emitters', () => {
  const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

  it('keeps every spot cone in front of the panel plane', () => {
    expect(isForwardOnly(DESK_SCREEN_SPOT)).toBe(true);
    expect(isForwardOnly(WALL_SCREEN_SPOT)).toBe(true);
    expect(isForwardOnly({ tilt: 1, angle: 0.7 })).toBe(false);
  });

  it('leans the beam down from the panel normal, also for a tilted laptop lid', () => {
    for (const normal of [[0, 0, 1], [1, 0, 0], [0.69, 0.22, -0.69], [0, 0.4, -0.92]] as const) {
      const aim = tiltedAim(normal, DESK_SCREEN_SPOT.tilt);
      const n = Math.hypot(...normal);
      expect(Math.hypot(...aim)).toBeCloseTo(1, 6);
      expect(Math.acos(dot(aim, normal) / n)).toBeCloseTo(DESK_SCREEN_SPOT.tilt, 5);
      expect(aim[1]).toBeLessThan(normal[1] / n);
      // The cone's widest ray still points away from the wall/panel back.
      expect(Math.cos(DESK_SCREEN_SPOT.tilt + DESK_SCREEN_SPOT.angle)).toBeGreaterThan(0);
    }
    expect(tiltedAim([0, -1, 0], 0.5)).toEqual([0, -1, 0]);
  });

  it('builds single-sided glow facing forward (halo) and up (desk pool), invisible from behind', () => {
    const geometry = glowGeometry(2.8, 1.55, 0.06, { center: [0, -1.1, 0.72], width: 3, depth: 1.35 });
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex()!;
    const p = (i: number) => [position.getX(i), position.getY(i), position.getZ(i)];
    let halo = 0, pool = 0;
    for (let t = 0; t < index.count; t += 3) {
      const [a, b, c] = [p(index.getX(t)), p(index.getX(t + 1)), p(index.getX(t + 2))];
      const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      const normal = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      if (Math.abs(a[1]! - b[1]!) < 1e-6 && Math.abs(a[1]! - c[1]!) < 1e-6 && Math.abs(a[1]! + 1.1) < 1e-6) { expect(normal[1]).toBeGreaterThan(0); pool++; }
      else { expect(normal[2]).toBeGreaterThan(0); halo++; }
    }
    expect(halo).toBeGreaterThan(0);
    expect(pool).toBeGreaterThan(0);
  });

  it('clips baked wall-display light so nothing reaches the wall or the room behind it', () => {
    const source = { position: [0.5, 1.6, 0] as [number, number, number], aim: [0.5, 1.6, 1] as [number, number, number],
      intensity: 20, color: [1, 1, 1] as [number, number, number], distance: 5, angle: 1.15, penumbra: 0.9 };
    const lit = (field: { radiance: Float32Array }, z: number) => {
      const [nx, ny] = IRRADIANCE_GRID_DIMENSIONS;
      const x = Math.floor(0.5 - IRRADIANCE_GRID_MIN[0]), y = Math.floor((1.6 - IRRADIANCE_GRID_MIN[1]) / ((IRRADIANCE_GRID_MAX[1] - IRRADIANCE_GRID_MIN[1]) / ny));
      const cz = Math.floor(z - IRRADIANCE_GRID_MIN[2]);
      return field.radiance[((cz * ny + y) * nx + x) * 4]!;
    };
    const open = bakeFixtureIrradiance([source]);
    const clipped = bakeFixtureIrradiance([{ ...source, frontClip: 0.95, minDistance: 0.6 }]);
    // Behind the panel nothing is lit in either case; with the clip the cell straddling the wall is dark too.
    expect(lit(open, -0.5)).toBe(0);
    expect(lit(clipped, -0.5)).toBe(0);
    expect(lit(clipped, 0.5)).toBe(0);
    expect(lit(open, 0.5)).toBeGreaterThan(0);
    expect(lit(open, 2.5)).toBeGreaterThan(0);
    expect(lit(clipped, 2.5)).toBeGreaterThan(0);
  });

  it('composes device light only at the requested power', () => {
    const cells = IRRADIANCE_GRID_DIMENSIONS[0] * IRRADIANCE_GRID_DIMENSIONS[1] * IRRADIANCE_GRID_DIMENSIONS[2];
    const devices = { radiance: new Float32Array(cells * 4).fill(2), direction: new Uint8Array(cells * 4).fill(128) };
    const radiance = new Uint16Array(cells * 4), direction = new Uint8Array(cells * 4);
    composeIrradiance(undefined, devices, 1, radiance, direction, 0);
    expect(DataUtils.fromHalfFloat(radiance[0]!)).toBe(0);
    composeIrradiance(undefined, devices, 1, radiance, direction, 0.5);
    expect(DataUtils.fromHalfFloat(radiance[0]!)).toBeCloseTo(1);
  });
});

describe('photometry of shared content', () => {
  const solid = (r: number, g: number, b: number, count = 16 * 9) => Uint8ClampedArray.from(Array.from({ length: count }).flatMap(() => [r, g, b, 255]));

  it('measures luminance and colour once per picture', () => {
    expect(measureScreenPixels(solid(0, 0, 0)).luminance).toBe(0);
    expect(measureScreenPixels(solid(255, 255, 255)).luminance).toBeCloseTo(1, 3);
    const teal = measureScreenPixels(solid(20, 160, 140));
    expect(teal.color[1]).toBe(1);
    expect(teal.color[0]).toBeLessThan(teal.color[1]);
    expect(measureScreenPixels([]).luminance).toBe(0);
  });

  it('lets a bright page light the room more than a dark editor, and a locked screen less than an active one', () => {
    const page = measureScreenPixels(solid(245, 248, 249)).luminance;
    const editor = measureScreenPixels(solid(22, 37, 45)).luminance;
    const area = 0.72 * 0.43;
    expect(displayEmission(area, page)).toBeGreaterThan(displayEmission(area, editor));
    expect(displayEmission(area, editor)).toBeGreaterThan(0);
    expect(displayEmission(area, editor * LOCKED_BACKLIGHT)).toBeLessThan(displayEmission(area, editor));
    expect(displayEmission(area, 0)).toBe(0);
  });
});
