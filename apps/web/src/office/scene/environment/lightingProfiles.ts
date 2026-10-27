/**
 * Sky and natural-light profiles for the Office scene, interpolated by sun elevation.
 * Night keeps only a faint moonlit fill: surfaces are read through the lamps, windows
 * and screens that actually emit light.
 */
export interface LightingProfile {
  /** Canvas background. */
  sky: string;
  fog: string;
  fogNear: number;
  fogFar: number;
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  ambient: string;
  ambientIntensity: number;
  /** Direct sun (the scene's single shadowed key light while the sun is up). */
  sun: string;
  sunIntensity: number;
  /** Moonlight on the same key light while the sun is down. */
  moon: string;
  moonIntensity: number;
}

type ColorKey = 'sky' | 'fog' | 'hemiSky' | 'hemiGround' | 'ambient' | 'sun' | 'moon';
type NumberKey = Exclude<keyof LightingProfile, ColorKey>;
const COLOR_KEYS: readonly ColorKey[] = ['sky', 'fog', 'hemiSky', 'hemiGround', 'ambient', 'sun', 'moon'];
const NUMBER_KEYS: readonly NumberKey[] = ['fogNear', 'fogFar', 'hemiIntensity', 'ambientIntensity', 'sunIntensity', 'moonIntensity'];

interface Anchor {
  elevation: number;
  /** Evening (sunset/dusk) values. */
  profile: LightingProfile;
  /** Morning (dawn/sunrise) differences; omitted keys match the evening. */
  dawn?: Partial<LightingProfile>;
}

const MOON = '#a3b6db';

/** Ascending by elevation. The day anchor keeps the Office's calibrated light-theme look. */
export const LIGHTING_ANCHORS: readonly Anchor[] = [
  { elevation: -18, profile: { sky: '#0a1019', fog: '#0a1019', fogNear: 240, fogFar: 700, hemiSky: '#1f2b4a', hemiGround: '#0a0c12', hemiIntensity: 0.22,
    ambient: '#2a3552', ambientIntensity: 0.1, sun: '#1e293b', sunIntensity: 0, moon: MOON, moonIntensity: 0.3 } },
  { elevation: -9, profile: { sky: '#111a29', fog: '#101826', fogNear: 240, fogFar: 700, hemiSky: '#26365a', hemiGround: '#0c0f16', hemiIntensity: 0.3,
    ambient: '#2c3858', ambientIntensity: 0.12, sun: '#1e293b', sunIntensity: 0, moon: MOON, moonIntensity: 0.3 } },
  { elevation: -4, profile: { sky: '#2c4166', fog: '#283855', fogNear: 240, fogFar: 700, hemiSky: '#4a6396', hemiGround: '#1a1f2c', hemiIntensity: 0.7,
    ambient: '#5a6c96', ambientIntensity: 0.35, sun: '#c25e2e', sunIntensity: 0, moon: MOON, moonIntensity: 0.12 } },
  { elevation: 0, profile: { sky: '#9e7c78', fog: '#8a7373', fogNear: 240, fogFar: 700, hemiSky: '#8c8fb0', hemiGround: '#3a3030', hemiIntensity: 0.9,
    ambient: '#a8949a', ambientIntensity: 0.4, sun: '#ff8a4c', sunIntensity: 1.4, moon: MOON, moonIntensity: 0 },
    dawn: { sky: '#ad9a95', fog: '#958a8b', hemiSky: '#9a9cb8', ambient: '#aca0a6', sun: '#ffa26c' } },
  { elevation: 6, profile: { sky: '#d6bfab', fog: '#cbb8a8', fogNear: 240, fogFar: 700, hemiSky: '#c9c3d0', hemiGround: '#5d5646', hemiIntensity: 1.15,
    ambient: '#f3dcc8', ambientIntensity: 0.75, sun: '#ffb36b', sunIntensity: 2.1, moon: MOON, moonIntensity: 0 },
    dawn: { sky: '#d3cfcb', fog: '#c9c6c3', hemiSky: '#d6d6e0', ambient: '#f5e9de', sun: '#ffcb92' } },
  { elevation: 20, profile: { sky: '#c7dae2', fog: '#c8d8df', fogNear: 240, fogFar: 700, hemiSky: '#dcebf6', hemiGround: '#677356', hemiIntensity: 1.38,
    ambient: '#fff8f0', ambientIntensity: 1.08, sun: '#ffefd9', sunIntensity: 2.3, moon: MOON, moonIntensity: 0 },
    dawn: { sky: '#c4dbe8', fog: '#c6d9e3', hemiSky: '#d6eafa', ambient: '#f6f8fb', sun: '#fff3e2' } },
  { elevation: 45, profile: { sky: '#c4dce8', fog: '#c6dbe6', fogNear: 240, fogFar: 700, hemiSky: '#d8edff', hemiGround: '#687757', hemiIntensity: 1.5,
    ambient: '#ffffff', ambientIntensity: 1.2, sun: '#fff6ea', sunIntensity: 2.5, moon: MOON, moonIntensity: 0 } },
];

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function parseHex(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** Mix two `#rrggbb` colors in sRGB space. */
export function mixHex(from: string, to: string, t: number): string {
  const a = parseHex(from), b = parseHex(to), k = clamp01(t);
  return `#${a.map((channel, index) => Math.round(channel + (b[index]! - channel) * k).toString(16).padStart(2, '0')).join('')}`;
}

export function mixProfiles(from: LightingProfile, to: LightingProfile, t: number): LightingProfile {
  const result = { ...from };
  for (const key of COLOR_KEYS) result[key] = mixHex(from[key], to[key], t);
  for (const key of NUMBER_KEYS) result[key] = from[key] + (to[key] - from[key]) * clamp01(t);
  return result;
}

const anchorProfile = (anchor: Anchor, evening: number) =>
  anchor.dawn ? mixProfiles({ ...anchor.profile, ...anchor.dawn }, anchor.profile, evening) : anchor.profile;

/**
 * Profile for a sun elevation (degrees). `evening` is 0 for the dawn palette, 1 for the
 * dusk palette; see `eveningWeight` for a value that changes continuously over a day.
 */
export function lightingProfile(elevation: number, evening = 1): LightingProfile {
  const first = LIGHTING_ANCHORS[0]!, last = LIGHTING_ANCHORS[LIGHTING_ANCHORS.length - 1]!;
  if (elevation <= first.elevation) return anchorProfile(first, evening);
  if (elevation >= last.elevation) return anchorProfile(last, evening);
  const upper = LIGHTING_ANCHORS.findIndex(anchor => anchor.elevation >= elevation);
  const high = LIGHTING_ANCHORS[upper]!, low = LIGHTING_ANCHORS[upper - 1]!;
  const profile = mixProfiles(anchorProfile(low, evening), anchorProfile(high, evening), (elevation - low.elevation) / (high.elevation - low.elevation));
  // Direct sun ends with the disc itself; the afterglow stays in the sky and fill colors.
  profile.sunIntensity *= clamp01((elevation + 1) / 2);
  return profile;
}

/** 0 at 06:00 solar time, 1 at 18:00, 0.5 at noon and midnight; continuous all day. */
export function eveningWeight(solarMinutes: number): number {
  return 0.5 + 0.5 * Math.sin((solarMinutes / 4 - 180) * Math.PI / 180);
}
