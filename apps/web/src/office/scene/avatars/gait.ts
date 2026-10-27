import type { CharacterGait } from "@extalia/core";

/**
 * Walking-style parameters. The idle weight shift and the walk cycle
 * (`movement/walkCycle.ts`) both use these values, so a character keeps one
 * recognisable movement style.
 */
export interface GaitParameters {
  readonly style: CharacterGait;
  /** Metres covered by one step at a relaxed pace. */
  readonly strideLength: number;
  /** Lateral pelvis travel either side of centre, in metres. */
  readonly hipSway: number;
  /** Pelvis roll accompanying the sway, in radians. */
  readonly hipRoll: number;
  /** Arm swing either side of the rest pose, in radians. */
  readonly armSwing: number;
  /** Steps per second. */
  readonly cadence: number;
}

const GAIT_PROFILES: Readonly<Record<CharacterGait, Omit<GaitParameters, "style">>> = {
  feminine: { strideLength: 0.64, hipSway: 0.022, hipRoll: 0.05, armSwing: 0.2, cadence: 1.95 },
  masculine: { strideLength: 0.76, hipSway: 0.008, hipRoll: 0.016, armSwing: 0.32, cadence: 1.75 },
};

const REFERENCE_HEIGHT_CM = 170;

/** Pure: the gait of an appearance; taller characters take longer, slightly slower steps. */
export function gaitParameters(appearance?: { gait?: CharacterGait; heightCm?: number }): GaitParameters {
  const style = appearance?.gait && Object.hasOwn(GAIT_PROFILES, appearance.gait) ? appearance.gait : "masculine";
  const base = GAIT_PROFILES[style];
  const height = appearance?.heightCm;
  const ratio = height !== undefined && Number.isFinite(height) ? Math.max(0.85, Math.min(1.15, height / REFERENCE_HEIGHT_CM)) : 1;
  return { style, ...base, strideLength: base.strideLength * ratio, cadence: base.cadence / Math.sqrt(ratio) };
}

/** Offsets applied over the rest pose; all zero at time 0 (reduced motion passes 0). */
export interface IdlePose {
  /** Lateral pelvis shift in metres (feet stay planted). */
  readonly pelvisShift: number;
  readonly pelvisRoll: number;
  /** Counter-roll keeping the shoulders over the feet. */
  readonly torsoRoll: number;
  /** Relaxed arm sway in radians (standing only). */
  readonly armSway: number;
}

/** One weight shift spans about eight steps of the character's cadence. */
const IDLE_CYCLE_STEPS = 8;

/** Standing idle shifts weight from foot to foot; seated idle keeps only a soft torso sway. */
export function idlePose(gait: GaitParameters, time: number, seated: boolean): IdlePose {
  const phase = (time * gait.cadence * Math.PI * 2) / IDLE_CYCLE_STEPS;
  const shift = Math.sin(phase);
  if (seated) return { pelvisShift: 0, pelvisRoll: 0, torsoRoll: shift * gait.hipRoll * 0.3, armSway: 0 };
  return {
    pelvisShift: shift * gait.hipSway,
    pelvisRoll: shift * gait.hipRoll,
    torsoRoll: -shift * gait.hipRoll * 0.7,
    armSway: Math.sin(phase * 2) * gait.armSwing * 0.12,
  };
}
