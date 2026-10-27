import { Quaternion, Vector3 } from 'three';

export interface ArmPoleSolution {
  /** Canonical −Y upper arm, rotated into the shoulder's parent frame. */
  upper: Quaternion;
  /** Canonical −Y forearm rotation relative to `upper`. */
  lower: Quaternion;
  /** Joint positions relative to the shoulder, in its parent frame. */
  elbow: Vector3;
  wrist: Vector3;
  /** Distance from the requested target to the reachable wrist. */
  error: number;
}

export function createArmPoleSolution(): ArmPoleSolution {
  return { upper: new Quaternion(), lower: new Quaternion(), elbow: new Vector3(), wrist: new Vector3(), error: 0 };
}

const DOWN = new Vector3(0, -1, 0);
const direction = new Vector3();
const pole = new Vector3();
const upperDirection = new Vector3();
const lowerDirection = new Vector3();
const hinge = new Vector3();
const bend = new Quaternion();

/**
 * Two-bone desk-work IK. Targets and lengths use the same units and the torso
 * frame (+Z forward); side is −1 on the left and +1 on the right. The outward,
 * slightly down/back pole selects the elbow without constraining shoulder yaw.
 * As the hand reaches outward, the pole blends down to keep the elbow tucked
 * below the shoulder rather than lifting it behind the arm.
 * Unreachable targets clamp to the closed reach annulus; a coincident target
 * uses down as its deterministic aim. Lengths must be positive and finite.
 *
 * The upper rotation is the shortest swing from canonical down. The forearm
 * inherits its twist through the bend-plane hinge, including at straight/folded
 * limits, instead of independently choosing a potentially different roll.
 * Writes only to `out`; synchronous calls reuse scratch objects without allocation.
 */
export function solveArmPole(
  target: Readonly<Vector3> | readonly [number, number, number],
  upperLength: number,
  lowerLength: number,
  side: -1 | 1,
  out: ArmPoleSolution,
): ArmPoleSolution {
  const x = 'x' in target ? target.x : target[0];
  const y = 'y' in target ? target.y : target[1];
  const z = 'z' in target ? target.z : target[2];
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)
    || !Number.isFinite(upperLength) || !Number.isFinite(lowerLength)
    || upperLength <= 0 || lowerLength <= 0) {
    throw new RangeError('Arm IK requires a finite target and positive finite limb lengths');
  }
  const distance = Math.hypot(x, y, z);
  const reach = Math.max(Math.abs(upperLength - lowerLength), Math.min(upperLength + lowerLength, distance));
  if (distance > 0) direction.set(x / distance, y / distance, z / distance);
  else direction.copy(DOWN);

  const outwardReach = Math.max(0, side * x) / upperLength;
  const blendPosition = Math.max(0, Math.min(1, (outwardReach - 0.2) / 0.6));
  const blend = blendPosition * blendPosition * (3 - 2 * blendPosition);
  pole.set(side * (0.7 - 0.65 * blend), -0.35 - 0.5 * blend, -0.2 + 0.1 * blend);
  pole.addScaledVector(direction, -pole.dot(direction));
  if (pole.lengthSq() < 1e-12) {
    // The preferred pole is parallel to the aim. Down remains independent of
    // that pole, so this fallback is deterministic and mirror-symmetric.
    pole.copy(DOWN).addScaledVector(direction, -DOWN.dot(direction));
  }
  pole.normalize();
  const along = reach > 0
    ? (upperLength * upperLength - lowerLength * lowerLength + reach * reach) / (2 * reach)
    : 0;
  const height = Math.sqrt(Math.max(0, upperLength * upperLength - along * along));
  out.elbow.copy(direction).multiplyScalar(along).addScaledVector(pole, height);
  out.wrist.copy(direction).multiplyScalar(reach);
  upperDirection.copy(out.elbow).normalize();
  lowerDirection.subVectors(out.wrist, out.elbow).normalize();

  out.upper.setFromUnitVectors(DOWN, upperDirection);
  hinge.crossVectors(pole, direction).normalize();
  const angle = Math.acos(Math.max(-1, Math.min(1, upperDirection.dot(lowerDirection))));
  bend.setFromAxisAngle(hinge, angle);
  // Forearm world = bend * upper; lower local = upper⁻¹ * forearm world.
  out.lower.copy(out.upper).invert().multiply(bend).multiply(out.upper).normalize();
  out.error = Math.hypot(x - out.wrist.x, y - out.wrist.y, z - out.wrist.z);
  return out;
}
