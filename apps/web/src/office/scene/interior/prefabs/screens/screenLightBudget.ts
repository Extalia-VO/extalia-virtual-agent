/**
 * Light budgeting for screen glow. The cached irradiance volume (FixtureLighting) already carries the
 * diffuse spill of every powered screen; this module decides which few screens additionally get a
 * real spot light (for faces, keyboards and desk detail) and how strong the whole effect is.
 */

/**
 * Real lights shared by every screen in the scene; the shader light count never changes. The screens of
 * one desk share a light, so four lights cover four desks (or a TV and three desks) around the view.
 */
export const SCREEN_LIGHT_BUDGET = 8;
/** Screens smaller than this many pixels on screen are not worth a light. */
export const MIN_SPILL_PROJECTED_HEIGHT = 2.5;
/** The score of the screen that already holds a light is boosted to stop pool slots from flickering. */
export const SELECTION_HYSTERESIS = 1.15;

/** Dusk threshold: from here an unpowered-by-lamp screen counts as being in the dark. */
export const NIGHT_THRESHOLD = 0.5;
export const isNight = (nightFactor: number) => nightFactor >= NIGHT_THRESHOLD;

const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

/** Night level at which screen-cast light reaches full strength (it starts at `NIGHT_THRESHOLD`). */
export const SCREEN_CAST_FULL_NIGHT = 0.85;

/**
 * How strongly screens cast light on their surroundings (spot lights, baked device irradiance,
 * halo and desk-pool quads), 0..1. Only a dark room shows it: it is 0 by day and whenever the room
 * lamps are on (the `On` override, or `Auto` after dusk), and eases in between dusk and full night
 * with the lamps off. Daylight with the lamps forced off is still daylight. The panels themselves
 * stay emissive at all times; this only gates the light they throw.
 */
export function screenCastStrength(nightFactor: number, lightsOn: boolean): number {
  if (lightsOn) return 0;
  const night = clamp01(nightFactor);
  if (night < NIGHT_THRESHOLD) return 0;
  const t = clamp01((night - NIGHT_THRESHOLD) / (SCREEN_CAST_FULL_NIGHT - NIGHT_THRESHOLD));
  return t * t * (3 - 2 * t);
}

/** @deprecated Kept for callers of the old name; screen glow is now exactly the cast strength. */
export const screenGlowStrength = screenCastStrength;

export interface GlowLayers { halo: number; pool: number; spill: number }

/** Opacity of the cheap glow quads and the multiplier for the shared spot lights. */
export function glowLayers(strength: number): GlowLayers {
  const s = clamp01(strength);
  return { halo: 0.26 * s, pool: 0.3 * s, spill: s };
}

/** Quantised cast strength for the baked device irradiance, so a dusk fade recomposes in a few steps. */
export function deviceIrradiancePower(strength: number): number {
  return Math.round(clamp01(strength) * 10) / 10;
}

/**
 * Pooled spot light of a lit screen. It sits just in front of the panel and leans down from the
 * panel's normal by `tilt`, so a desk light lands on the keyboard and hands rather than on the face
 * of the person sitting there, and a wall display lights the floor and seats in front of it.
 * `tilt + angle` stays below 90°, so no part of the cone reaches behind the panel.
 */
export interface ScreenSpotShape {
  /** Downward lean of the beam from the panel normal, radians. */
  tilt: number;
  /** Half-angle of the cone, radians. */
  angle: number;
  penumbra: number;
  /** Distance from the panel to the aim point along the beam, metres. */
  throw: number;
  /** Light range, metres. */
  distance: number;
  /** Candela per unit of emitter intensity, before the cap. */
  scale: number;
  /** Ceiling on the light's intensity, so a bright multi-monitor desk never blows out skin and shirts. */
  maxIntensity: number;
}

/** Desk monitors and laptops: a short, soft beam onto the desk surface. */
export const DESK_SCREEN_SPOT: ScreenSpotShape = { tilt: 0.78, angle: 0.62, penumbra: 1, throw: 0.62, distance: 1.9, scale: 0.04, maxIntensity: 0.6 };
/** Wall boards and TVs: a wider, longer beam onto the floor and seating in front. */
export const WALL_SCREEN_SPOT: ScreenSpotShape = { tilt: 0.5, angle: 0.72, penumbra: 1, throw: 2.4, distance: 5.5, scale: 0.08, maxIntensity: 3.2 };
/** Panels at least this big (√(w·h), metres) are lit as wall displays. */
export const WALL_SCREEN_SIZE = 0.9;
/** Keeps a cone's far edge this far in front of the panel plane (radians short of 90°). */
export const FORWARD_MARGIN = 0.08;

export function screenSpotShape(panelSize: number): ScreenSpotShape {
  return panelSize >= WALL_SCREEN_SIZE ? WALL_SCREEN_SPOT : DESK_SCREEN_SPOT;
}

export function screenSpotIntensity(shape: ScreenSpotShape, emitterIntensity: number, strength: number): number {
  return Math.min(shape.maxIntensity, Math.max(0, emitterIntensity) * shape.scale) * clamp01(strength);
}

/** True when every ray of the cone leaves through the front of the panel. */
export function isForwardOnly(shape: Pick<ScreenSpotShape, 'tilt' | 'angle'>): boolean {
  return shape.tilt >= 0 && shape.angle > 0 && shape.tilt + shape.angle <= Math.PI / 2 - FORWARD_MARGIN;
}

/**
 * Unit beam direction: the panel normal `n` leaned down by `tilt` inside its vertical plane. A laptop
 * lid tilted back keeps the same lean relative to its own normal, so the cone never wraps behind it.
 */
export function tiltedAim(normal: readonly [number, number, number], tilt: number): [number, number, number] {
  const length = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  const nx = normal[0] / length, ny = normal[1] / length, nz = normal[2] / length;
  // Downward direction perpendicular to the normal: -up with its normal component removed.
  let dx = ny * nx, dy = ny * ny - 1, dz = ny * nz;
  const down = Math.hypot(dx, dy, dz);
  if (down < 1e-6) return [nx, ny, nz];
  dx /= down; dy /= down; dz /= down;
  const c = Math.cos(tilt), s = Math.sin(tilt);
  return [nx * c + dx * s, ny * c + dy * s, nz * c + dz * s];
}

export interface LightCandidate {
  id: string;
  /** Emitter intensity (see `displayEmission`). */
  intensity: number;
  /** Panel height in screen pixels. */
  projectedHeight: number;
  /** Weight from `screenLightPriority`; 1 when unset. */
  priority?: number | undefined;
}

/** Spot-light weight of a busy desk (an agent works there) over idle desks and wall boards. */
export const ACTIVE_DESK_PRIORITY = 2;

export function screenLightPriority(resolved: { mode: string }, wall: boolean): number {
  return !wall && resolved.mode === 'live' ? ACTIVE_DESK_PRIORITY : 1;
}

export function lightScore(candidate: LightCandidate, hadLight: boolean): number {
  const priority = Number.isFinite(candidate.priority) ? Math.max(0, candidate.priority!) : 1;
  return candidate.projectedHeight * Math.sqrt(Math.max(0, candidate.intensity)) * priority * (hadLight ? SELECTION_HYSTERESIS : 1);
}

/**
 * The screens that get a real light this round: lit, big enough on screen, best score first, at most
 * `budget`. Ties break on id so the choice is deterministic.
 */
export function selectScreenLights(
  candidates: readonly LightCandidate[],
  budget: number = SCREEN_LIGHT_BUDGET,
  previous: ReadonlySet<string> = new Set(),
): string[] {
  return candidates
    .filter(candidate => candidate.intensity > 0.001 && candidate.projectedHeight >= MIN_SPILL_PROJECTED_HEIGHT)
    .map(candidate => ({ id: candidate.id, score: lightScore(candidate, previous.has(candidate.id)) }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Math.max(0, budget))
    .map(entry => entry.id);
}

/** Keep a screen on the same pool light across rounds; only newcomers take freed slots. */
export function assignLightSlots(selected: readonly string[], previous: readonly (string | null)[], budget: number = SCREEN_LIGHT_BUDGET): (string | null)[] {
  const keep = new Set(selected);
  const slots: (string | null)[] = Array.from({ length: budget }, (_, index) => {
    const id = previous[index] ?? null;
    return id !== null && keep.has(id) ? id : null;
  });
  const placed = new Set(slots.filter((id): id is string => id !== null));
  for (const id of selected) {
    if (placed.has(id)) continue;
    const free = slots.indexOf(null);
    if (free < 0) break;
    slots[free] = id;
    placed.add(id);
  }
  return slots;
}

export interface ClusteredLight extends LightCandidate {
  /** Indexes into the candidate list that this light stands for. */
  members: number[];
}

/**
 * Merge candidates of the same cluster (the monitors of one desk) into one light: intensities add, the
 * panel size and priority are the largest of the group. Candidates without a cluster stay on their own.
 */
export function clusterLightCandidates(candidates: readonly (LightCandidate & { cluster?: string | undefined })[]): ClusteredLight[] {
  const groups = new Map<string, ClusteredLight>();
  candidates.forEach((candidate, index) => {
    const id = candidate.cluster ?? candidate.id;
    const group = groups.get(id);
    if (!group) {
      groups.set(id, {
        id, intensity: candidate.intensity, projectedHeight: candidate.projectedHeight, members: [index],
        ...(candidate.priority !== undefined ? { priority: candidate.priority } : {}),
      });
    } else {
      group.intensity += candidate.intensity;
      group.projectedHeight = Math.max(group.projectedHeight, candidate.projectedHeight);
      if (candidate.priority !== undefined) group.priority = Math.max(group.priority ?? 1, candidate.priority);
      group.members.push(index);
    }
  });
  return [...groups.values()];
}
