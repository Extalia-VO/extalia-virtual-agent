/**
 * Two-bone arm IK for the office characters, in the arm's own sagittal plane.
 *
 * Joint convention (both renderers): an upper arm pivots on the shoulder with
 * `rotation.x = pitch`, so its direction is `(y, z) = (-cos pitch, -sin pitch)`
 * (negative pitch raises the arm forward, the character faces +Z). The forearm
 * is a child with `rotation.x = elbow` relative to the upper arm; a straight
 * arm has elbow 0 and a folded one approaches -π. Pure and allocation-free:
 * `solveArmPlane` writes into an existing result object.
 */

export interface ArmSolution {
  /** Upper-arm pitch (rotation.x of the shoulder joint). */
  pitch: number;
  /** Forearm flexion relative to the upper arm (rotation.x of the elbow joint), ≤ 0. */
  elbow: number;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/**
 * Pitch and elbow that put the wrist as close as the reach allows to the target,
 * given as `dy` (up) and `dz` (forward) from the shoulder. The elbow bends down
 * (below the line from shoulder to wrist). Returns true when the target is in reach.
 */
export function solveArmPlane(dy: number, dz: number, upper: number, lower: number, out: ArmSolution): boolean {
  const distance = Math.hypot(dy, dz);
  const minReach = Math.abs(upper - lower) + 1e-3;
  const maxReach = upper + lower - 1e-3;
  const reach = clamp(distance, minReach, maxReach);
  // Direction from the shoulder to the target, in pitch units.
  const toTarget = Math.atan2(-dz, -dy);
  const cosShoulder = clamp((upper * upper + reach * reach - lower * lower) / (2 * upper * reach), -1, 1);
  const spread = Math.acos(cosShoulder);
  // Two solutions (elbow up or down); the lower elbow wins.
  const first = toTarget + spread, second = toTarget - spread;
  const elbowY = (pitch: number) => -Math.cos(pitch) * upper;
  out.pitch = elbowY(first) <= elbowY(second) ? first : second;
  const cosElbow = clamp((upper * upper + lower * lower - reach * reach) / (2 * upper * lower), -1, 1);
  out.elbow = Math.acos(cosElbow) - Math.PI;
  return distance <= maxReach;
}

/** Wrist position of a solved arm in the same plane (for tests and placement checks). */
export function armWristPlane(solution: Readonly<ArmSolution>, upper: number, lower: number): [number, number] {
  const elbowY = -Math.cos(solution.pitch) * upper, elbowZ = -Math.sin(solution.pitch) * upper;
  const forearm = solution.pitch + solution.elbow;
  return [elbowY - Math.cos(forearm) * lower, elbowZ - Math.sin(forearm) * lower];
}
