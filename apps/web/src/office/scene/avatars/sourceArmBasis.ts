import { Euler, Quaternion, Vector3, type Matrix4 } from 'three';

const DOWN = new Vector3(0, -1, 0);

/** Current model-space goals to the rest arm frame, measured from the hips. */
export function sourceArmGoalFrame(out: Matrix4, restChestFromHip: Matrix4, posedChestWorld: Matrix4, modelWorld: Matrix4): Matrix4 {
  return out.copy(posedChestWorld).invert().premultiply(restChestFromHip).multiply(modelWorld);
}

/** Maps the solver's hanging limb onto a source model's authored rest direction. */
export function sourceLimbBasis(direction: Vector3): Quaternion {
  return new Quaternion().setFromUnitVectors(DOWN, direction.clone().normalize());
}

export function createSourceArmRotations() {
  return { upper: new Quaternion(), lower: new Quaternion(), hand: new Quaternion(),
    upperBasis: new Quaternion(), lowerBasis: new Quaternion(), inverse: new Quaternion(), euler: new Euler() };
}

/**
 * Source deltas are expressed in the model's rest-world frame. Remove each
 * segment's authored tilt before applying the ideal solver's joint chain:
 * U = Rx(p)Rz(a)Cu⁻¹, L = CuRx(e)Cl⁻¹, H = ClRx(w)Cl⁻¹.
 * Thus both actual segment directions follow the solver's forward kinematics.
 */
export function writeSourceArmRotations(out: ReturnType<typeof createSourceArmRotations>,
  upperBasis: Quaternion, lowerBasis: Quaternion, pitch: number, abduction: number, elbow: number, wrist: number, weight: number) {
  out.upperBasis.identity().slerp(upperBasis, weight);
  out.lowerBasis.identity().slerp(lowerBasis, weight);
  out.upper.setFromEuler(out.euler.set(pitch, 0, abduction, 'XYZ'))
    .multiply(out.inverse.copy(out.upperBasis).invert());
  out.lower.setFromEuler(out.euler.set(elbow, 0, 0))
    .premultiply(out.upperBasis).multiply(out.inverse.copy(out.lowerBasis).invert());
  out.hand.setFromEuler(out.euler.set(wrist, 0, 0))
    .premultiply(out.lowerBasis).multiply(out.inverse.copy(out.lowerBasis).invert());
  return out;
}

/** Source bodies already have metric stature; keep only the procedural profile's aspect variation. */
export function sourceAvatarScale(heightMeters: number, profileScale: readonly [number, number, number]): [number, number, number] {
  const scale = heightMeters / 1.85;
  return [scale * profileScale[0] / profileScale[1], scale, scale * profileScale[2] / profileScale[1]];
}
