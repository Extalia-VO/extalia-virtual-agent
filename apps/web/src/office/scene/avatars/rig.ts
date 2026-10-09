/** Renderer-independent humanoid metadata. Lengths are metres, angles radians. */
export type HumanoidJointName =
  | "root" | "hips" | "spine" | "head"
  | "leftUpperArm" | "leftLowerArm" | "leftHand"
  | "rightUpperArm" | "rightLowerArm" | "rightHand"
  | "leftUpperLeg" | "leftLowerLeg" | "leftFoot"
  | "rightUpperLeg" | "rightLowerLeg" | "rightFoot";

export type RigVector3 = readonly [number, number, number];

export interface HumanoidJointMetadata {
  readonly name: HumanoidJointName;
  readonly parent: HumanoidJointName | null;
  /** Local rest offset from the parent pivot, before instance scale. */
  readonly restOffset: RigVector3;
  readonly rotationAxes: readonly ("x" | "y" | "z")[];
}

/** Existing named-bone bindings remain valid for a future imported asset. */
export interface HumanoidRigContract {
  skeletonId: string;
  rootBone?: string;
  hipsBone?: string;
  spineBone?: string;
  headBone?: string;
  leftHandBone?: string;
  rightHandBone?: string;
  leftFootBone?: string;
  rightFootBone?: string;
  joints?: Readonly<Record<HumanoidJointName, HumanoidJointMetadata>>;
}

export interface HumanoidProportions {
  readonly standingHipHeight: number;
  readonly seatedHipHeight: number;
  readonly thighLength: number;
  readonly shinLength: number;
  readonly upperArmLength: number;
  readonly forearmLength: number;
  readonly shoulderWidth: number;
  readonly shoulderHeight: number;
  readonly hipWidth: number;
  readonly headHeight: number;
  readonly headRadius: number;
}

export interface HumanoidMotionPersonality {
  /** Stable initial time offset in seconds; never use list order as a phase. */
  readonly phaseOffset: number;
  readonly tempo: number;
  readonly breathRate: number;
  readonly swayAmount: number;
  readonly gestureAmount: number;
  /** -1 favours the left hand; +1 favours the right hand. */
  readonly handedness: -1 | 1;
  /** Joint damping response in inverse seconds. */
  readonly response: number;
}

export interface HumanoidRigProfile {
  readonly instanceId: string;
  readonly seed: number;
  readonly stature: HumanoidStature;
  readonly frame: HumanoidFrame;
  readonly skeleton: HumanoidRigContract & {
    joints: Readonly<Record<HumanoidJointName, HumanoidJointMetadata>>;
  };
  /** Local +Y is up and +Z is forward; scale applies around the feet. */
  readonly scale: RigVector3;
  /** Overall stature, also available separately for uniform mesh scaling. */
  readonly uniformScale: number;
  readonly proportions: HumanoidProportions;
  readonly motion: HumanoidMotionPersonality;
}

/** Authored body archetype; each one is a bounded multiplier over the seeded rig. */
export type HumanoidStature = "default" | "commanding" | "tall" | "athletic" | "slender" | "petite";

interface StatureModifier {
  readonly height: number;
  readonly shoulders: number;
  readonly width: number;
  readonly depth: number;
  readonly limbs: number;
}

/** Bounded so seated hips, desk reach and door clearances stay valid at every stature. */
export const HUMANOID_STATURE_MODIFIERS: Readonly<Record<HumanoidStature, StatureModifier>> = Object.freeze({
  default: { height: 1, shoulders: 1, width: 1, depth: 1, limbs: 1 },
  commanding: { height: 1.06, shoulders: 1.08, width: 1.05, depth: 1.04, limbs: 1.02 },
  tall: { height: 1.07, shoulders: 1.01, width: 0.98, depth: 0.99, limbs: 1.03 },
  athletic: { height: 1.03, shoulders: 1.07, width: 1.03, depth: 1.02, limbs: 1.01 },
  slender: { height: 1.02, shoulders: 0.94, width: 0.94, depth: 0.95, limbs: 1.01 },
  petite: { height: 0.93, shoulders: 0.95, width: 0.96, depth: 0.97, limbs: 0.98 }
});

/** Presentation frame: shoulder/hip balance and a small height bias, independent of stature. */
export type HumanoidFrame = "feminine" | "masculine" | "neutral";

interface FrameModifier {
  readonly height: number;
  readonly shoulders: number;
  readonly hips: number;
}

/** Bounded like statures, so seated hips and desk reach stay valid for every combination. */
export const HUMANOID_FRAME_MODIFIERS: Readonly<Record<HumanoidFrame, FrameModifier>> = Object.freeze({
  neutral: { height: 1, shoulders: 1, hips: 1 },
  feminine: { height: 0.97, shoulders: 0.92, hips: 1.1 },
  masculine: { height: 1.02, shoulders: 1.07, hips: 0.96 }
});

export function isHumanoidStature(value: unknown): value is HumanoidStature {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(HUMANOID_STATURE_MODIFIERS, value);
}

export interface HumanoidRigProfileOptions {
  /** Optional seed namespace. The instance ID still participates in the seed. */
  seed?: string | number;
  /** Body archetype applied over seeded variation; never changes the seed itself. */
  stature?: HumanoidStature;
  /** Presentation frame applied over stature; never changes the seed either. */
  frame?: HumanoidFrame;
  uniformScale?: number;
  /** Explicit final XYZ scale; overrides generated scale, without changing proportions. */
  scale?: RigVector3;
  proportions?: Partial<HumanoidProportions>;
  motion?: Partial<HumanoidMotionPersonality>;
}

/** Matches the existing procedural mesh, so no external skeleton is required. */
export const HUMANOID_BASE_PROPORTIONS: HumanoidProportions = Object.freeze({
  standingHipHeight: 0.83,
  seatedHipHeight: 0.62,
  thighLength: 0.39,
  shinLength: 0.44,
  upperArmLength: 0.33,
  forearmLength: 0.31,
  shoulderWidth: 0.45,
  shoulderHeight: 0.59,
  hipWidth: 0.21,
  headHeight: 0.88,
  headRadius: 0.18
});

/** Stable across re-renders, remounts and changes in the agent list order. */
export function humanoidInstanceSeed(instanceId: string, namespace: string | number = "humanoid-v1"): number {
  const input = JSON.stringify([String(namespace), instanceId]);
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash = Math.imul(hash ^ input.charCodeAt(i), 16777619);
  }
  return hash >>> 0;
}

function createJointMetadata(p: HumanoidProportions): Record<HumanoidJointName, HumanoidJointMetadata> {
  const joint = (name: HumanoidJointName, parent: HumanoidJointName | null,
    restOffset: RigVector3, rotationAxes: HumanoidJointMetadata["rotationAxes"]): HumanoidJointMetadata =>
    ({ name, parent, restOffset, rotationAxes });
  return {
    root: joint("root", null, [0, 0, 0], ["y"]),
    hips: joint("hips", "root", [0, p.standingHipHeight, 0], []),
    spine: joint("spine", "hips", [0, 0, 0], ["x", "y"]),
    head: joint("head", "spine", [0, p.headHeight, 0], ["x", "y"]),
    leftUpperArm: joint("leftUpperArm", "spine", [-p.shoulderWidth / 2, p.shoulderHeight, 0], ["x", "z"]),
    leftLowerArm: joint("leftLowerArm", "leftUpperArm", [0, -p.upperArmLength, 0], ["x"]),
    leftHand: joint("leftHand", "leftLowerArm", [0, -p.forearmLength, 0], ["x"]),
    rightUpperArm: joint("rightUpperArm", "spine", [p.shoulderWidth / 2, p.shoulderHeight, 0], ["x", "z"]),
    rightLowerArm: joint("rightLowerArm", "rightUpperArm", [0, -p.upperArmLength, 0], ["x"]),
    rightHand: joint("rightHand", "rightLowerArm", [0, -p.forearmLength, 0], ["x"]),
    leftUpperLeg: joint("leftUpperLeg", "hips", [-p.hipWidth / 2, 0, 0], ["x"]),
    leftLowerLeg: joint("leftLowerLeg", "leftUpperLeg", [0, -p.thighLength, 0], ["x"]),
    leftFoot: joint("leftFoot", "leftLowerLeg", [0, -p.shinLength, 0], []),
    rightUpperLeg: joint("rightUpperLeg", "hips", [p.hipWidth / 2, 0, 0], ["x"]),
    rightLowerLeg: joint("rightLowerLeg", "rightUpperLeg", [0, -p.thighLength, 0], ["x"]),
    rightFoot: joint("rightFoot", "rightLowerLeg", [0, -p.shinLength, 0], [])
  };
}

/**
 * Allocate one profile per agent instance (including instances sharing an identity).
 * Every call owns its metadata; no animation state or random generator is shared.
 * Consumers keep their own clock and use motion tempo/phase to avoid lockstep.
 */
export function createHumanoidRigProfile(instanceId: string, options: HumanoidRigProfileOptions = {}): HumanoidRigProfile {
  if (!instanceId.trim()) throw new Error("A humanoid rig requires a non-empty instance ID");
  const seed = humanoidInstanceSeed(instanceId, options.seed);
  // Labelled samples keep each trait stable when additional traits are introduced.
  const sample = (label: string, min: number, max: number) =>
    min + (humanoidInstanceSeed(label, seed) / 4294967296) * (max - min);
  const base = HUMANOID_BASE_PROPORTIONS;
  const stature: HumanoidStature = options.stature ?? "default";
  if (!isHumanoidStature(stature)) throw new Error(`Unknown humanoid stature: ${String(stature)}`);
  const build = HUMANOID_STATURE_MODIFIERS[stature];
  const frame: HumanoidFrame = options.frame ?? "neutral";
  const shape = HUMANOID_FRAME_MODIFIERS[frame];
  if (!shape) throw new Error(`Unknown humanoid frame: ${String(frame)}`);
  const thighLength = options.proportions?.thighLength ?? base.thighLength * sample("thigh", 0.96, 1.04) * build.limbs;
  const shinLength = options.proportions?.shinLength ?? base.shinLength * sample("shin", 0.97, 1.03) * build.limbs;
  const proportions: HumanoidProportions = {
    ...base,
    thighLength,
    shinLength,
    // Keep the standing feet on the floor and the seated hips at cushion height.
    standingHipHeight: thighLength + shinLength,
    upperArmLength: base.upperArmLength * sample("upper-arm", 0.96, 1.04) * build.limbs,
    forearmLength: base.forearmLength * sample("forearm", 0.96, 1.04) * build.limbs,
    shoulderWidth: base.shoulderWidth * sample("shoulders", 0.95, 1.05) * build.shoulders * shape.shoulders,
    shoulderHeight: base.shoulderHeight * sample("torso", 0.97, 1.03),
    hipWidth: base.hipWidth * sample("hips", 0.97, 1.03) * build.width * shape.hips,
    headHeight: base.headHeight * sample("neck", 0.97, 1.03),
    headRadius: base.headRadius * sample("head", 0.97, 1.03),
    ...options.proportions
  };
  for (const [key, value] of Object.entries(proportions)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid humanoid proportion: ${key}`);
  }
  // Furniture is authored to architectural dimensions; keep avatars slightly below the
  // nominal procedural height so lounge seating and desks read at human scale.
  const uniformScale = options.uniformScale ?? 0.88 * sample("height", 0.97, 1.03) * build.height * shape.height;
  if (!Number.isFinite(uniformScale) || uniformScale <= 0) throw new Error("Humanoid uniform scale must be positive and finite");
  const scale: RigVector3 = options.scale ? [...options.scale] : [
    uniformScale * sample("width", 0.96, 1.04) * build.width, uniformScale, uniformScale * sample("depth", 0.97, 1.03) * build.depth
  ];
  if (scale.some(value => !Number.isFinite(value) || value <= 0)) throw new Error("Humanoid scale must be positive and finite");
  const motion: HumanoidMotionPersonality = {
    phaseOffset: sample("phase", 0, 997),
    tempo: sample("tempo", 0.89, 1.11),
    breathRate: sample("breath", 0.86, 1.14),
    swayAmount: sample("sway", 0.7, 1.2),
    gestureAmount: sample("gesture", 0.8, 1.16),
    handedness: sample("hand", 0, 1) < 0.18 ? -1 : 1,
    response: sample("response", 7, 10),
    ...options.motion
  };
  for (const [key, value] of Object.entries(motion)) {
    if (!Number.isFinite(value)) throw new Error(`Invalid humanoid motion parameter: ${key}`);
  }
  if (motion.tempo <= 0 || motion.breathRate <= 0 || motion.response <= 0 ||
    motion.swayAmount < 0 || motion.gestureAmount < 0 || ![-1, 1].includes(motion.handedness)) {
    throw new Error("Invalid humanoid motion personality");
  }
  return {
    instanceId, seed, stature, frame, scale, uniformScale, proportions, motion,
    skeleton: {
      skeletonId: `procedural-humanoid:${instanceId}`,
      rootBone: "root", hipsBone: "hips", spineBone: "spine", headBone: "head",
      leftHandBone: "leftHand", rightHandBone: "rightHand",
      leftFootBone: "leftFoot", rightFootBone: "rightFoot",
      joints: createJointMetadata(proportions)
    }
  };
}
