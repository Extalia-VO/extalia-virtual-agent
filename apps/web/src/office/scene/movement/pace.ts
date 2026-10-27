/**
 * Walking pace of a character: how fast it walks compared with its gait's
 * relaxed stride × cadence. People differ (a stable personal pace from the
 * character id), no two trips are quite alike (a small per-trip variation),
 * someone called back to real work hurries, and a walk-about is a stroll.
 *
 * Pure and deterministic, like the idle routine.
 */
import { lifeRandom } from './idleRoutine';

/**
 * The office reads as a brisk, purposeful walk: real office walking is about
 * 1.4 m/s, and the orthographic overview makes the same pace look slower than
 * it is, so the gait's relaxed pace is lifted by this factor.
 */
export const OFFICE_PACE = 1.24;
/** Range of the personal pace factor (slow walkers … fast walkers). */
export const PERSONAL_PACE_MIN = 0.78;
export const PERSONAL_PACE_MAX = 1.28;
/** A trip is at most this much slower or faster than the character's usual pace. */
export const TRIP_VARIATION = 0.10;

/** Why the character walks: a stroll during leisure, an ordinary walk, or a hurry back to real work. */
export type WalkMood = 'stroll' | 'walk' | 'hurry';
export const MOOD_PACE: Readonly<Record<WalkMood, number>> = { stroll: 0.68, walk: 1, hurry: 1.42 };

/** Hand-operated door tempo follows actual m/s, including gait, trip mood and the walking speed cap. */
export function doorInteractionTempo(speed: number): number {
  return Math.max(0.4, Math.min(1.6, (Number.isFinite(speed) ? speed : 1.4) / 1.4));
}

/** Stable personal pace factor of a character, in [PERSONAL_PACE_MIN, PERSONAL_PACE_MAX]. */
export function personalPace(id: string): number {
  // Mean of two draws: most people walk near the middle, a few are notably slow or fast.
  const r = (lifeRandom(id, 0, 800) + lifeRandom(id, 0, 801)) / 2;
  return PERSONAL_PACE_MIN + (PERSONAL_PACE_MAX - PERSONAL_PACE_MIN) * r;
}

/** Pace multiplier over the gait's relaxed pace for trip number `trip` of a character. */
export function tripPace(id: string, trip: number, mood: WalkMood = 'walk'): number {
  const variation = 1 + (lifeRandom(id, trip, 810) * 2 - 1) * TRIP_VARIATION;
  return OFFICE_PACE * personalPace(id) * variation * MOOD_PACE[mood];
}

/**
 * Split a pace multiplier between stride length and cadence so the feet stay
 * planted: faster walkers take both longer and quicker steps (speed = stride ×
 * cadence, so the product of both scales equals the pace).
 */
export function strideAndCadence(pace: number): { stride: number; cadence: number } {
  const p = Math.max(0.1, pace);
  const stride = Math.pow(p, 0.45);
  return { stride, cadence: p / stride };
}
