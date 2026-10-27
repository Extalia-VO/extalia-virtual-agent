/**
 * Pure solar geometry for the Office day/night cycle and the "Solar" app theme.
 * NOAA low-precision formulas (about ±1 minute for sunrise/sunset); no network and
 * no geolocation: callers pass a location (see `deviceLocation.ts`).
 */

export interface SolarLocation {
  readonly latitude: number;
  readonly longitude: number;
}

export interface SolarPosition {
  /** Degrees above the horizon (negative below). */
  elevation: number;
  /** Degrees clockwise from north (0 north, 90 east, 180 south, 270 west). */
  azimuth: number;
  /** Local apparent solar time in minutes (720 = solar noon). */
  solarMinutes: number;
  /** Before solar noon: dawn/morning palettes rather than dusk/evening ones. */
  rising: boolean;
}

export interface SolarFactors {
  /** 0 at civil dusk (-6°), 1 once the sun is 12° up. */
  daylightFactor: number;
  /** Peaks around sunrise/sunset, 0 by -12° and +15°. */
  twilightFactor: number;
  /** 0 at the horizon, 1 by nautical dusk (-12°). */
  nightFactor: number;
  /** Direct sun strength, 0 below the horizon to 1 at the zenith. */
  sunIntensity: number;
  /** Site lighting (paths, bollards, street lights): photocell on from +4°, full at -4°. */
  exteriorLightFactor: number;
  /** Signage and facade accents: from +6°, full at -2° (never fully off). */
  signageLightFactor: number;
  /** Interior lights as the clock would set them: 0 by day, 1 after dusk (from +10° to -4°). */
  interiorDemand: number;
}

const DEG = Math.PI / 180;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Fractional-year terms: equation of time (minutes) and declination (radians). */
function solarYear(epochMs: number): { equationOfTime: number; declination: number } {
  const date = new Date(epochMs);
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((epochMs - startOfYear) / 86_400_000) + 1;
  const hours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const gamma = (2 * Math.PI / 365) * (dayOfYear - 1 + (hours - 12) / 24);
  const equationOfTime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const declination = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  return { equationOfTime, declination };
}

/** Sun position at an instant. Uses UTC only, so the host time zone never skews it. */
export function solarPosition(epochMs: number, location: SolarLocation): SolarPosition {
  const { equationOfTime, declination } = solarYear(epochMs);
  const date = new Date(epochMs);
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const solarMinutes = (((utcMinutes + equationOfTime + 4 * location.longitude) % 1440) + 1440) % 1440;
  const hourAngle = (solarMinutes / 4 - 180) * DEG;
  const latitude = location.latitude * DEG;
  const cosZenith = Math.min(1, Math.max(-1,
    Math.sin(latitude) * Math.sin(declination) + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle)));
  const zenith = Math.acos(cosZenith);
  const elevation = 90 - zenith / DEG;
  // Azimuth from north, clockwise (Reda & Andreas form; stable at the poles of the hour angle).
  const azimuth = ((Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(latitude) - Math.tan(declination) * Math.cos(latitude)) / DEG) + 180 + 360) % 360;
  return { elevation, azimuth, solarMinutes, rising: solarMinutes < 720 };
}

/** The sun's upper limb crosses the horizon at -0.833° (refraction plus solar radius). */
export const SUNRISE_ELEVATION = -0.833;

/**
 * Continuous lighting factors from the sun's elevation. Every factor is a clamped
 * linear ramp, so nothing jumps between dawn, day, dusk and night.
 */
export function solarFactors(elevation: number): SolarFactors {
  const twilight = clamp01((elevation + 12) / 27);
  return {
    daylightFactor: clamp01((elevation + 6) / 18),
    twilightFactor: elevation <= -12 || elevation >= 15 ? 0 : Math.sin(twilight * Math.PI),
    nightFactor: clamp01(-elevation / 12),
    sunIntensity: elevation <= 0 ? 0 : Math.sin(elevation * DEG),
    exteriorLightFactor: clamp01((4 - elevation) / 8),
    signageLightFactor: Math.max(0.05, clamp01((6 - elevation) / 8)),
    interiorDemand: clamp01((10 - elevation) / 14),
  };
}

/**
 * Scene direction towards the sun (+Y up). The campus has no real-world bearing, so it is
 * oriented with its front facade (-Z, towards the default camera) facing the equator:
 * the midday sun lights the entrance in both hemispheres, and it sets on the -X side.
 */
export function sunDirection(elevation: number, azimuth: number, latitude: number): [number, number, number] {
  const e = elevation * DEG, a = azimuth * DEG;
  const horizontal = Math.cos(e);
  const x = Math.sin(a) * horizontal;
  const z = (latitude >= 0 ? 1 : -1) * Math.cos(a) * horizontal;
  const y = Math.sin(e);
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}
