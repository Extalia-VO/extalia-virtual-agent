import type { ArmReach } from '../movement/walkCycle';

/**
 * Blends a hand that reaches for a chair back, an armrest or a door handle
 * (the movement layer's `ArmReach`) into the desk hand goal of the same arm.
 * Both are in the character's own frame (feet at the origin, facing +Z), so the
 * renderer's torso-frame solve handles them alike. Writes the goal into `out`
 * and returns the IK weight for that arm. Pure and allocation-free.
 */
export function mixReachGoal(desk: readonly [number, number, number], deskWeight: number, reach: Readonly<ArmReach>, out: [number, number, number]): number {
  const r = Math.max(0, Math.min(1, reach.weight));
  for (let k = 0; k < 3; k++) out[k] = deskWeight > 1e-3 ? desk[k]! * (1 - r) + reach.target[k]! * r : reach.target[k]!;
  return Math.max(deskWeight, r);
}
