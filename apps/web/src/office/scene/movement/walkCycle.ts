import type { GaitParameters } from '../avatars/gait';
import type { ActivityClip } from '../avatars/activityPose';

/**
 * Live motion of one character, written by the movement layer every frame and
 * read by the character renderers. Mutated in place: no per-frame allocation.
 */
/** One hand reaching for a point (a chair back, an armrest, a door handle); the renderers solve the arm for it. */
export interface ArmReach {
  /** 0 = not reaching (the walk and activity poses drive the arm) … 1 = reaching in full. */
  weight: number;
  /** Target in the character's own frame: metres from the feet, facing +Z, before the body scale. */
  readonly target: [number, number, number];
}

export interface CharacterMotion {
  /** 0 standing … 1 seated; blends hip height, thighs and arms between both poses. */
  sit: number;
  /** 0 still … 1 full walk cycle. */
  walk: number;
  /** Walk cycle phase in radians; one cycle (2π) is two steps. */
  phase: number;
  /** Activity animation over the seated or standing pose (desk work, leisure, chat); `none` for the plain pose. */
  clip: ActivityClip;
  /** Stride length over the gait's relaxed stride: faster walkers take longer steps (see `pace.ts`). */
  stride: number;
  /** Per hand: index 0 is the character's left (-X), 1 its right (+X). Written by the movement layer, read by the renderers. */
  reach: [ArmReach, ArmReach];
}

export function createCharacterMotion(seated: boolean): CharacterMotion {
  return {
    sit: seated ? 1 : 0, walk: 0, phase: 0, clip: 'none', stride: 1,
    reach: [{ weight: 0, target: [0, 0, 0] }, { weight: 0, target: [0, 0, 0] }],
  };
}

/** Joint offsets of the walk cycle over the standing pose (radians and metres). */
export interface WalkPose {
  /** Thigh pitch per side; negative swings the leg forward (left index 0, right index 1). */
  hip: [number, number];
  /** Knee flexion per side, ≥ 0. */
  knee: [number, number];
  /** Upper-arm pitch per side, opposite to the leg on the same side. */
  arm: [number, number];
  /** Extra elbow flexion while swinging, ≤ 0 like the rest pose. */
  elbow: number;
  /** Lateral pelvis travel over the stance foot. */
  pelvisShift: number;
  pelvisRoll: number;
  /** Shoulders counter-rotate against the pelvis. */
  torsoTwist: number;
  /** Vertical body travel: highest at mid-stance. */
  bob: number;
}

export function createWalkPose(): WalkPose {
  return { hip: [0, 0], knee: [0, 0], arm: [0, 0], elbow: 0, pelvisShift: 0, pelvisRoll: 0, torsoTwist: 0, bob: 0 };
}

/** Relaxed walking speed in m/s: one stride length per step at the gait's cadence. */
export function walkingSpeed(gait: Pick<GaitParameters, 'strideLength' | 'cadence'>): number {
  return gait.strideLength * gait.cadence;
}

/** Phase advance for `seconds` of walking at `speedScale` of the relaxed pace (negative steps backwards). */
export function advanceWalkPhase(phase: number, gait: Pick<GaitParameters, 'cadence'>, seconds: number, speedScale = 1): number {
  const next = phase + seconds * gait.cadence * Math.PI * speedScale;
  const cycle = Math.PI * 2;
  return ((next % cycle) + cycle) % cycle;
}

/** Distance-driven steps for handling furniture: shortened strides follow actual root travel. */
export function advanceWalkDistance(phase: number, gait: Pick<GaitParameters, 'strideLength'>, metres: number, strideScale = 1, amount = 1): number {
  const stepLength = gait.strideLength * Math.max(.5, Math.min(1.6, strideScale)) * Math.max(.05, Math.min(1, amount));
  const cycle = Math.PI * 2;
  const next = phase + metres * Math.PI / Math.max(.01, stepLength);
  return ((next % cycle) + cycle) % cycle;
}

const REFERENCE_LEG = 0.83;
const KNEE_SWING = 0.62;
const KNEE_STANCE = 0.06;

/**
 * Pure walk-cycle math from the character's gait: thigh swing follows stride
 * length over leg length, arms swing with `armSwing`, the pelvis sways and
 * rolls with `hipSway`/`hipRoll`. `amount` 0 returns the standing pose.
 * `strideScale` lengthens the steps of a faster pace (`CharacterMotion.stride`).
 */
export function writeWalkPose(out: WalkPose, gait: GaitParameters, phase: number, amount: number, legLength = REFERENCE_LEG, strideScale = 1): WalkPose {
  const a = Math.max(0, Math.min(1, amount));
  const s = Math.sin(phase), c = Math.cos(phase);
  const strideLength = gait.strideLength * Math.max(0.5, Math.min(1.6, strideScale));
  // Half a stride ahead of and behind the hip at full swing.
  const swing = Math.asin(Math.min(0.9, strideLength / 2 / Math.max(0.3, legLength))) * 0.8 * a;
  out.hip[0] = -swing * s;
  out.hip[1] = swing * s;
  // Knee flexion peaks early in each leg's swing (left swings forward while cos φ > 0).
  out.knee[0] = (Math.max(0, Math.cos(phase + Math.PI / 4)) * KNEE_SWING + KNEE_STANCE) * a;
  out.knee[1] = (Math.max(0, Math.cos(phase + Math.PI + Math.PI / 4)) * KNEE_SWING + KNEE_STANCE) * a;
  // Arms swing a little wider with longer steps.
  const armSwing = gait.armSwing * Math.sqrt(strideLength / gait.strideLength);
  out.arm[0] = armSwing * s * a;
  out.arm[1] = -armSwing * s * a;
  out.elbow = -0.16 * a;
  out.pelvisShift = gait.hipSway * c * a;
  out.pelvisRoll = gait.hipRoll * c * a;
  out.torsoTwist = 0.05 * s * a;
  out.bob = 0.012 * (strideLength / 0.7) * Math.cos(2 * phase) * a;
  return out;
}

/** Shortest signed angle from `from` to `to`, in (-π, π]. */
export function angleDelta(from: number, to: number): number {
  const delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) return delta - Math.PI * 2;
  if (delta <= -Math.PI) return delta + Math.PI * 2;
  return delta;
}

/** Turn toward `target` at no more than `rate` rad/s. */
export function turnToward(current: number, target: number, rate: number, seconds: number): number {
  const delta = angleDelta(current, target);
  const step = rate * seconds;
  return Math.abs(delta) <= step ? target : current + Math.sign(delta) * step;
}

/** Facing that looks along +X/+Z travel (avatars face local +Z). */
export function headingOf(dx: number, dz: number): number {
  return Math.atan2(dx, dz);
}

export const smoothstep = (t: number) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};
