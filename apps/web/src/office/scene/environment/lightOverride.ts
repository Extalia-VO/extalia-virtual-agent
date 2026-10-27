/**
 * Interior lights: `auto` follows the time of day, `on` forces evening lamps,
 * and `off` suppresses evening lamps while preserving daylight fill. Site lighting stays on its
 * own photocell and is not affected; exit signs and screens keep their own power.
 */
export type LightOverride = 'auto' | 'on' | 'off';
export const LIGHT_OVERRIDES: readonly LightOverride[] = ['auto', 'on', 'off'];

/** Fixtures stay softly lit by day in `auto` (daylight-dimmed), as in a staffed office. */
export const DAYLIGHT_INTERIOR_LEVEL = 0.3;

export interface InteriorLights {
  /** The building's lights are switched on for the evening (auto) or forced on. */
  lightsOn: boolean;
  /** Artificial interior light level 0..1 that fixtures, lamps and lit windows read. */
  interiorLightFactor: number;
}

/** `demand` is 0 in daylight and 1 after dusk (`SolarFactors.interiorDemand`). */
export function resolveInteriorLights(override: LightOverride, demand: number, nightFactor = demand): InteriorLights {
  const level = Math.min(1, Math.max(0, demand));
  const automatic = DAYLIGHT_INTERIOR_LEVEL + (1 - DAYLIGHT_INTERIOR_LEVEL) * level;
  if (override === 'on') return { lightsOn: true, interiorLightFactor: 1 };
  if (override === 'off') return { lightsOn: false, interiorLightFactor: automatic * (1 - Math.max(0, Math.min(1, nightFactor))) };
  return { lightsOn: level >= 0.5, interiorLightFactor: automatic };
}

/** The evening switch cannot turn off the sun; solar dusk blends the night treatment gradually. */
export function nightLightOverrideWeight(override: LightOverride, nightFactor: number): number {
  return override === 'off' ? Math.max(0, Math.min(1, nightFactor)) : 0;
}

export const LIGHT_OVERRIDE_STORAGE_KEY = 'extalia.office.lights';

export function isLightOverride(value: unknown): value is LightOverride {
  return value === 'auto' || value === 'on' || value === 'off';
}

/** Per-device choice; storage may be unavailable (private mode, blocked site data). */
export function loadLightOverride(storage?: Pick<Storage, 'getItem'>): LightOverride {
  try {
    const value = (storage ?? globalThis.localStorage)?.getItem(LIGHT_OVERRIDE_STORAGE_KEY);
    return isLightOverride(value) ? value : 'auto';
  } catch {
    return 'auto';
  }
}

export function saveLightOverride(value: LightOverride, storage?: Pick<Storage, 'setItem' | 'removeItem'>): void {
  try {
    const store = storage ?? globalThis.localStorage;
    if (value === 'auto') store?.removeItem(LIGHT_OVERRIDE_STORAGE_KEY);
    else store?.setItem(LIGHT_OVERRIDE_STORAGE_KEY, value);
  } catch {
    /* Storage full or blocked: the choice lasts for this session only. */
  }
}
