import { solarFactors, solarPosition, sunDirection, type SolarLocation } from '../../../environment/solarMath';
import { eveningWeight, lightingProfile, type LightingProfile } from './lightingProfiles';
import { resolveInteriorLights, type LightOverride } from './lightOverride';

/** `sun` follows the real sun for the device location; `day`/`night` are the forced app themes. */
export type SceneSky = 'sun' | 'day' | 'night';
type Vec3 = [number, number, number];

export interface SceneFactors {
  exteriorLightFactor: number;
  interiorLightFactor: number;
  daylightFactor: number;
  nightFactor: number;
  twilightFactor: number;
  signageLightFactor: number;
  sunIntensity: number;
}

export interface SceneSolarState {
  sky: SceneSky;
  factors: SceneFactors;
  position: { sunDirection: Vec3; elevation: number; azimuth: number };
  /** Natural light and sky for this moment (see `lightingProfiles.ts`). */
  profile: LightingProfile;
  /** Direction towards the scene's single key light: the sun while it is up, else the moon. */
  keyDirection: Vec3;
}

export interface SceneEnvironmentState {
  lightOverride: LightOverride;
  lightsOn: boolean;
  state: SceneSolarState;
}

const normalize = ([x, y, z]: Vec3): Vec3 => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
/** The Office's calibrated light-theme sun: high, from the entrance side. */
const DAY_DIRECTION = normalize([-25, 45, -30]);
const DAY_ELEVATION = Math.asin(DAY_DIRECTION[1]) * 180 / Math.PI;
/** A high moon over the entrance side keeps facades faintly legible at night. */
const MOON_DIRECTION = normalize([-0.42, 0.78, -0.46]);
const NIGHT_ELEVATION = -20;
const quantize = (value: number, step: number) => Math.round(value / step) * step;

export interface SceneEnvironmentInput {
  sky: SceneSky;
  epochMs: number;
  location: SolarLocation;
  lightOverride: LightOverride;
}

/**
 * Everything the scene reads about daylight and its lights. Sun angles are quantized
 * (0.25° elevation, 0.5° azimuth) so a ticking clock only re-renders on visible change.
 */
export function computeSceneEnvironment({ sky, epochMs, location, lightOverride }: SceneEnvironmentInput): SceneEnvironmentState {
  let elevation: number, azimuth: number, evening: number, direction: Vec3;
  if (sky === 'sun') {
    const sun = solarPosition(epochMs, location);
    elevation = quantize(sun.elevation, 0.25);
    azimuth = quantize(sun.azimuth, 0.5) % 360;
    evening = quantize(eveningWeight(sun.solarMinutes), 0.02);
    direction = sunDirection(elevation, azimuth, location.latitude);
  } else if (sky === 'day') {
    elevation = DAY_ELEVATION; azimuth = 225; evening = 0.5; direction = DAY_DIRECTION;
  } else {
    elevation = NIGHT_ELEVATION; azimuth = 0; evening = 1; direction = sunDirection(NIGHT_ELEVATION, 270, location.latitude);
  }
  const solar = solarFactors(elevation);
  const lights = resolveInteriorLights(lightOverride, solar.interiorDemand, solar.nightFactor);
  const profile = lightingProfile(elevation, evening);
  return {
    lightOverride,
    lightsOn: lights.lightsOn,
    state: {
      sky,
      factors: {
        exteriorLightFactor: solar.exteriorLightFactor,
        interiorLightFactor: lights.interiorLightFactor,
        daylightFactor: solar.daylightFactor,
        nightFactor: solar.nightFactor,
        twilightFactor: solar.twilightFactor,
        signageLightFactor: solar.signageLightFactor,
        sunIntensity: solar.sunIntensity,
      },
      position: { sunDirection: direction, elevation, azimuth },
      profile,
      keyDirection: profile.sunIntensity >= profile.moonIntensity ? direction : MOON_DIRECTION,
    },
  };
}

/**
 * Stable identity for memoizing the context value: below the deepest profile anchor and
 * with the sun down, nothing visible changes, so the night keeps one value.
 */
export function sceneEnvironmentKey({ lightOverride, lightsOn, state }: SceneEnvironmentState): string {
  const { elevation, azimuth } = state.position;
  return [state.sky, lightOverride, lightsOn, Math.max(-18, elevation), state.profile.sunIntensity > 0 ? azimuth : '-',
    state.profile.sky, state.profile.sun].join('|');
}
