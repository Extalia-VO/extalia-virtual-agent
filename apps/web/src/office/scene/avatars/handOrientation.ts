import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three';

type XYZ = readonly [number, number, number];
const DEFAULT_PALM: XYZ = [0, 0, -1];
const EPSILON = 1e-10;

export interface HandOrientationInput {
  /** Actual posed parent of the hand, including all avatar scale and torso transforms. */
  parentWorld: Matrix4;
  /** Seat root before the avatar's body scale; direction and palm are expressed here. */
  rootWorld: Matrix4;
  direction: XYZ;
  /** Palm surface normal, not a tangent vector; projected perpendicular to direction. */
  palm: XYZ;
  localFinger: XYZ;
  localPalm?: XYZ;
}

export function createHandOrientationScratch() {
  return {
    parentInRoot: new Matrix4(), rootInParent: new Matrix4(), normal: new Matrix3(),
    sourceFrame: new Matrix4(), desiredFrame: new Matrix4(),
    sourceFinger: new Vector3(), sourcePalm: new Vector3(), sourceCross: new Vector3(),
    finger: new Vector3(), palm: new Vector3(), cross: new Vector3(),
    source: new Quaternion(), desired: new Quaternion(), inverse: new Quaternion(), delta: new Quaternion(),
  };
}
export type HandOrientationScratch = ReturnType<typeof createHandOrientationScratch>;

function normalize(vector: Vector3): boolean {
  const length = vector.length();
  if (!Number.isFinite(length) || length <= EPSILON) return false;
  vector.multiplyScalar(1 / length);
  return true;
}

function orthogonalize(palm: Vector3, finger: Vector3): boolean {
  palm.addScaledVector(finger, -palm.dot(finger));
  return normalize(palm);
}

/** Desired hand-local quaternion; leaves out untouched when the frame is degenerate. */
export function writeHandOrientation(out: Quaternion, input: HandOrientationInput, scratch: HandOrientationScratch): boolean {
  const { parentWorld, rootWorld, direction, palm, localFinger, localPalm = DEFAULT_PALM } = input;
  if (!parentWorld.elements.every(Number.isFinite) || !rootWorld.elements.every(Number.isFinite)
    || Math.abs(parentWorld.determinant()) <= EPSILON || Math.abs(rootWorld.determinant()) <= EPSILON) return false;
  scratch.finger.fromArray(direction); scratch.palm.fromArray(palm);
  scratch.sourceFinger.fromArray(localFinger); scratch.sourcePalm.fromArray(localPalm);
  if (!normalize(scratch.finger) || !orthogonalize(scratch.palm, scratch.finger)
    || !normalize(scratch.sourceFinger) || !orthogonalize(scratch.sourcePalm, scratch.sourceFinger)) return false;

  scratch.parentInRoot.copy(rootWorld).invert().multiply(parentWorld);
  scratch.rootInParent.copy(scratch.parentInRoot).invert();
  // Tangents use A^-1. Surface normals use A^T, so they remain perpendicular
  // under the real nonuniform avatar scale rather than a lossy extracted rotation.
  scratch.finger.transformDirection(scratch.rootInParent);
  scratch.normal.setFromMatrix4(scratch.parentInRoot).transpose();
  scratch.palm.applyMatrix3(scratch.normal);
  if (!normalize(scratch.finger) || !orthogonalize(scratch.palm, scratch.finger)) return false;
  scratch.sourceCross.crossVectors(scratch.sourceFinger, scratch.sourcePalm);
  scratch.cross.crossVectors(scratch.finger, scratch.palm);
  scratch.sourceFrame.makeBasis(scratch.sourceFinger, scratch.sourcePalm, scratch.sourceCross);
  scratch.desiredFrame.makeBasis(scratch.finger, scratch.palm, scratch.cross);
  scratch.source.setFromRotationMatrix(scratch.sourceFrame).invert();
  scratch.desired.setFromRotationMatrix(scratch.desiredFrame).multiply(scratch.source).normalize();
  out.copy(scratch.desired);
  return true;
}

/** Signed twist of the hand correction about the forearm's local wrist-offset axis. */
export function handPronationAngle(current: Quaternion, desired: Quaternion, axis: Readonly<Vector3>, scratch: HandOrientationScratch): number {
  scratch.finger.copy(axis);
  if (!normalize(scratch.finger)) return 0;
  scratch.delta.copy(desired).multiply(scratch.inverse.copy(current).invert()).normalize();
  const q = scratch.delta;
  const sign = q.w < 0 ? -1 : 1;
  const projection = sign * (q.x * scratch.finger.x + q.y * scratch.finger.y + q.z * scratch.finger.z);
  const scalar = sign * q.w;
  if (!Number.isFinite(projection) || !Number.isFinite(scalar) || Math.hypot(projection, scalar) <= EPSILON) return 0;
  return 2 * Math.atan2(projection, scalar);
}
