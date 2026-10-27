import { Quaternion, Vector3 } from 'three';
import { FITNESS_BLUEPRINT } from './spatialBlueprints';
import type { Mover } from '../movement/mover';

export interface FitnessMechanism { phase: number; travel: number; pull: number; active: boolean }
const mechanisms = new Map<string, FitnessMechanism>();
/** Finite, scene-local equipment phases. Both avatar contacts and equipment read these values. */
export function fitnessMechanism(id?: string): FitnessMechanism | undefined {
  if (!id?.startsWith('fitness.')) return undefined;
  let state = mechanisms.get(id);
  if (!state) { state = { phase: 0, travel: 0, pull: 0, active: false }; mechanisms.set(id, state); }
  return state;
}
export function advanceFitnessMechanism(state: FitnessMechanism, active: boolean, delta: number): void {
  state.active = active;
  if (!active) return;
  state.phase += Math.max(0, Math.min(delta, 0.1)) * 3.4;
  state.travel += Math.max(0, Math.min(delta, 0.1)) * 1.6;
  state.pull = (1 - Math.cos(state.phase * 2.4 / 3.4)) / 2;
}
export function bikePedalPosition(side: number, phase: number): [number, number, number] {
  return [side * 0.27, side * 0.18 * Math.cos(phase), side * 0.18 * Math.sin(phase)];
}
/** Bike avatar faces the opposite direction to its equipment, with its root on the saddle. */
export function bikeFootGoal(side: number, phase: number, ankleAboveSole: number): [number, number, number] {
  const pedal = bikePedalPosition(-side, phase);
  return [-pedal[0], 0.38 + pedal[1] + 0.0175 + ankleAboveSole, FITNESS_BLUEPRINT.bikeSeat[1] - pedal[2]];
}
export function fitnessHandGoal(id: string | undefined, side: number, state: FitnessMechanism | undefined): [number, number, number] | undefined {
  if (id?.startsWith('fitness.bike-')) return [side * 0.24, 1.22, FITNESS_BLUEPRINT.bikeSeat[1] + 0.08];
  if (id === FITNESS_BLUEPRINT.cableRow.id) return [side * 0.23, FITNESS_BLUEPRINT.cableHandle[1], FITNESS_BLUEPRINT.cableHandle[2] - (state?.pull ?? 0) * 0.3];
  return undefined;
}

export function createFitnessLegSolution() { return { upper: new Quaternion(), lower: new Quaternion(), ankle: new Vector3(), knee: new Vector3(), error: 0 }; }
const down = new Vector3(0, -1, 0), direction = new Vector3(), pole = new Vector3(), upperDirection = new Vector3(), lowerDirection = new Vector3(), hinge = new Vector3(), bend = new Quaternion();
/** Two-bone leg solve with the knee pole forward, preserving actual metric pedal endpoints. */
export function solveFitnessLeg(target: readonly [number, number, number], upper: number, lower: number, out: ReturnType<typeof createFitnessLegSolution>) {
  const distance = Math.hypot(...target), reach = Math.max(Math.abs(upper - lower) + 1e-6, Math.min(upper + lower - 1e-6, distance));
  if (distance > 1e-8) direction.set(...target).divideScalar(distance); else direction.copy(down);
  pole.set(0, 0, 1).addScaledVector(direction, -direction.z);
  if (pole.lengthSq() < 1e-10) pole.set(0, 1, 0).addScaledVector(direction, -direction.y);
  pole.normalize();
  const along = (upper * upper - lower * lower + reach * reach) / (2 * reach);
  out.knee.copy(direction).multiplyScalar(along).addScaledVector(pole, Math.sqrt(Math.max(0, upper * upper - along * along)));
  out.ankle.copy(direction).multiplyScalar(reach);
  upperDirection.copy(out.knee).normalize(); lowerDirection.subVectors(out.ankle, out.knee).normalize();
  out.upper.setFromUnitVectors(down, upperDirection);
  hinge.crossVectors(pole, direction).normalize(); bend.setFromAxisAngle(hinge, Math.acos(Math.max(-1, Math.min(1, upperDirection.dot(lowerDirection)))));
  out.lower.copy(out.upper).invert().multiply(bend).multiply(out.upper).normalize();
  out.error = Math.hypot(target[0] - out.ankle.x, target[1] - out.ankle.y, target[2] - out.ankle.z);
  return out;
}

/** Stationary exercise users are intentionally absent from the door/crowd walker registry. */
export type FitnessPresenceSource = Pick<Mover,
  'id' | 'phase' | 'seat' | 'goal' | 'pending' | 'position' | 'motion' | 'opacity'>;
const fitnessPresenceOwners = new Map<object, readonly FitnessPresenceSource[]>();
/** Publish the live movers after their frame step; each mounted scene owns its registration. */
export function publishFitnessPresence(owner: object, movers: readonly FitnessPresenceSource[]): void {
  fitnessPresenceOwners.set(owner, movers);
}
export function clearFitnessPresence(owner: object): void { fitnessPresenceOwners.delete(owner); }
export function fitnessPresenceInUse(resourceId: string, target: readonly [number, number, number]): boolean {
  if (!resourceId.startsWith("fitness.")) return false;
  for (const movers of fitnessPresenceOwners.values()) for (const mover of movers) {
    if (mover.phase !== 'seated' || mover.opacity <= 0 || mover.pending || mover.motion.walk > .05 ||
      mover.seat?.seatId !== resourceId || mover.goal?.kind !== 'seat' || mover.goal.seat.seatId !== resourceId) continue;
    if (Math.abs(mover.position[1] - target[1]) < .35 && Math.abs(mover.seat.seat[1] - target[1]) < .35 &&
      Math.hypot(mover.position[0] - target[0], mover.position[2] - target[2]) < .35 &&
      Math.hypot(mover.seat.seat[0] - target[0], mover.seat.seat[2] - target[2]) < .35) return true;
  }
  return false;
}
