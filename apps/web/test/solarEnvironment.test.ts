import { describe, expect, it } from 'vitest';
import { solarFactors, solarPosition, sunDirection, SUNRISE_ELEVATION } from '../src/environment/solarMath';
import { solarLocationForZone, zoneOffsetMinutes } from '../src/environment/deviceLocation';
import { isDaytime } from '../src/environment/solarTime';
import { eveningWeight, LIGHTING_ANCHORS, lightingProfile, mixHex } from '../src/office/scene/environment/lightingProfiles';
import { computeSceneEnvironment } from '../src/office/scene/environment/sceneEnvironment';

const WIB = { latitude: 5.5483, longitude: 95.3238 };
const LONDON = { latitude: 51.51, longitude: -0.13 };
/** Epoch of a wall-clock time at a fixed UTC offset (hours). */
const at = (iso: string, offsetHours: number) => Date.parse(`${iso}Z`) - offsetHours * 3_600_000;

function sunsetMinutes(location: typeof WIB, day: string, offsetHours: number): number {
  for (let minute = 12 * 60; minute < 24 * 60; minute++) {
    const hh = String(Math.floor(minute / 60)).padStart(2, '0'), mm = String(minute % 60).padStart(2, '0');
    if (solarPosition(at(`${day}T${hh}:${mm}:00`, offsetHours), location).elevation <= SUNRISE_ELEVATION) return minute;
  }
  return Number.NaN;
}

describe('solar position', () => {
  it('matches the reference sunset and solar noon within minutes', () => {
    // NOAA: sunset 18:27 WIB on 10 October 2026 at the WIB reference point.
    expect(sunsetMinutes(WIB, '2026-10-10', 7)).toBeGreaterThanOrEqual(18 * 60 + 24);
    expect(sunsetMinutes(WIB, '2026-10-10', 7)).toBeLessThanOrEqual(18 * 60 + 30);
    // London, June solstice, solar noon around 12:02 UTC: 90 - 51.51 + 23.44 ≈ 61.9°, due south.
    const noon = solarPosition(Date.parse('2026-06-21T12:02:00Z'), LONDON);
    expect(noon.elevation).toBeCloseTo(61.9, 0);
    expect(Math.abs(noon.azimuth - 180)).toBeLessThan(3);
  });

  it('rises in the east, sets in the west and flags the morning', () => {
    const morning = solarPosition(at('2026-10-10T08:00:00', 7), WIB);
    const evening = solarPosition(at('2026-10-10T17:00:00', 7), WIB);
    expect(morning.azimuth).toBeGreaterThan(45);
    expect(morning.azimuth).toBeLessThan(135);
    expect(morning.rising).toBe(true);
    expect(evening.azimuth).toBeGreaterThan(225);
    expect(evening.azimuth).toBeLessThan(315);
    expect(evening.rising).toBe(false);
  });

  it('orients the campus front towards the midday sun in both hemispheres', () => {
    const north = sunDirection(40, 180, 50);
    const south = sunDirection(40, 0, -33);
    expect(north[2]).toBeLessThan(-0.7);
    expect(south[2]).toBeLessThan(-0.7);
    expect(Math.hypot(...north)).toBeCloseTo(1, 6);
    // Sunset falls on the -X side, sunrise on +X.
    expect(sunDirection(2, 270, 50)[0]).toBeLessThan(-0.9);
    expect(sunDirection(2, 90, -33)[0]).toBeGreaterThan(0.9);
  });

  it('agrees with the Solar app theme', () => {
    const noon = new Date(at('2026-10-10T12:30:00', 7));
    const night = new Date(at('2026-10-10T21:00:00', 7));
    expect(isDaytime(noon, WIB)).toBe(true);
    expect(isDaytime(night, WIB)).toBe(false);
  });
});

describe('solar factors', () => {
  it('reaches day and night extremes', () => {
    expect(solarFactors(60)).toMatchObject({ daylightFactor: 1, nightFactor: 0, exteriorLightFactor: 0, interiorDemand: 0, twilightFactor: 0 });
    expect(solarFactors(-20)).toMatchObject({ daylightFactor: 0, nightFactor: 1, exteriorLightFactor: 1, interiorDemand: 1, sunIntensity: 0 });
  });

  it('changes continuously through dusk', () => {
    let previous = solarFactors(20);
    for (let elevation = 19.75; elevation >= -20; elevation -= 0.25) {
      const next = solarFactors(elevation);
      for (const key of Object.keys(next) as (keyof typeof next)[]) {
        expect(Math.abs(next[key] - previous[key])).toBeLessThan(0.05);
        expect(next[key]).toBeGreaterThanOrEqual(0);
        expect(next[key]).toBeLessThanOrEqual(1);
      }
      // Site lights never switch off while the sky darkens.
      expect(next.exteriorLightFactor).toBeGreaterThanOrEqual(previous.exteriorLightFactor);
      previous = next;
    }
  });
});

describe('lighting profiles', () => {
  it('mixes colors in sRGB', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#102030', '#102030', 0.3)).toBe('#102030');
  });

  it('holds the end anchors and keeps the day look', () => {
    const day = LIGHTING_ANCHORS[LIGHTING_ANCHORS.length - 1]!.profile;
    expect(lightingProfile(70)).toEqual(day);
    expect(day).toMatchObject({ sky: '#c4dce8', ambientIntensity: 1.2, hemiIntensity: 1.5, sunIntensity: 2.5 });
    const night = lightingProfile(-40);
    expect(night.sunIntensity).toBe(0);
    expect(night.moonIntensity).toBeGreaterThan(0);
    expect(night.ambientIntensity + night.hemiIntensity).toBeLessThan(0.4);
  });

  it('interpolates without jumps and drops the direct sun below the horizon', () => {
    let previous = lightingProfile(50, 1);
    for (let elevation = 49.9; elevation >= -25; elevation -= 0.1) {
      const next = lightingProfile(elevation, 1);
      for (const key of ['hemiIntensity', 'ambientIntensity', 'sunIntensity', 'moonIntensity'] as const) {
        expect(Math.abs(next[key] - previous[key])).toBeLessThan(0.12);
      }
      previous = next;
    }
    expect(lightingProfile(-1.5).sunIntensity).toBe(0);
    // Below the blue hour there is no dawn/dusk difference.
    expect(lightingProfile(-6, 0)).toEqual(lightingProfile(-6, 1));
  });

  it('uses dawn colors in the morning and dusk colors in the evening', () => {
    expect(lightingProfile(0, 0).sky).not.toBe(lightingProfile(0, 1).sky);
    expect(lightingProfile(45, 0)).toEqual(lightingProfile(45, 1));
    expect(eveningWeight(360)).toBeCloseTo(0, 6);
    expect(eveningWeight(720)).toBeCloseTo(0.5, 6);
    expect(eveningWeight(1080)).toBeCloseTo(1, 6);
  });
});

describe('device solar location', () => {
  it('uses the zone table, then the standard offset and region', () => {
    expect(solarLocationForZone('Asia/Jakarta')).toMatchObject({ latitude: 5.5483, longitude: 95.3238, source: 'zone' });
    const vilnius = solarLocationForZone('Europe/Vilnius', Date.parse('2026-07-01T00:00:00Z'));
    expect(vilnius).toMatchObject({ latitude: 50, longitude: 30, source: 'estimate' });
    expect(solarLocationForZone('Etc/GMT-3')).toMatchObject({ latitude: 0, longitude: 45 });
    expect(solarLocationForZone('Not/A_Zone')).toMatchObject({ latitude: 0, longitude: 0, source: 'estimate' });
  });

  it('reads offsets through Intl, including daylight saving time', () => {
    expect(zoneOffsetMinutes('Asia/Jakarta', Date.parse('2026-01-01T00:00:00Z'))).toBe(420);
    expect(zoneOffsetMinutes('Europe/Berlin', Date.parse('2026-07-01T00:00:00Z'))).toBe(120);
    expect(zoneOffsetMinutes('Not/A_Zone', 0)).toBeUndefined();
  });
});

describe('scene environment', () => {
  const base = { epochMs: at('2026-10-10T21:00:00', 7), location: WIB, lightOverride: 'auto' as const };

  it('follows forced day and night themes', () => {
    const day = computeSceneEnvironment({ ...base, sky: 'day' });
    expect(day.state.factors).toMatchObject({ daylightFactor: 1, nightFactor: 0, exteriorLightFactor: 0, interiorLightFactor: 0.3 });
    expect(day.lightsOn).toBe(false);
    expect(day.state.profile.sunIntensity).toBe(2.5);
    const night = computeSceneEnvironment({ ...base, sky: 'night' });
    expect(night.state.factors).toMatchObject({ daylightFactor: 0, nightFactor: 1, exteriorLightFactor: 1, interiorLightFactor: 1 });
    expect(night.lightsOn).toBe(true);
    expect(night.state.keyDirection[1]).toBeGreaterThan(0.5);
  });

  it('follows the sun for the device location', () => {
    const evening = computeSceneEnvironment({ ...base, sky: 'sun' });
    expect(evening.state.position.elevation).toBeLessThan(-30);
    expect(evening.state.factors.nightFactor).toBe(1);
    const noon = computeSceneEnvironment({ ...base, sky: 'sun', epochMs: at('2026-10-10T12:30:00', 7) });
    expect(noon.state.position.elevation).toBeGreaterThan(70);
    expect(noon.state.factors.daylightFactor).toBe(1);
    expect(noon.lightsOn).toBe(false);
  });

  it('switches only the interior with the lights override', () => {
    const off = computeSceneEnvironment({ ...base, sky: 'night', lightOverride: 'off' });
    expect(off.lightsOn).toBe(false);
    expect(off.state.factors.interiorLightFactor).toBe(0);
    expect(off.state.factors.exteriorLightFactor).toBe(1);
    const on = computeSceneEnvironment({ ...base, sky: 'day', lightOverride: 'on' });
    expect(on.lightsOn).toBe(true);
    expect(on.state.factors.interiorLightFactor).toBe(1);
    expect(on.state.factors.exteriorLightFactor).toBe(0);
  });
});
