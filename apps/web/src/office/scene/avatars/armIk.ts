/**
 * Three-dimensional two-bone arm IK for seated desk work. Builds on the planar
 * solver in `ik.ts`: the upper arm first swings sideways (`abduction`, a Z
 * turn), then pitches forward (X), and the forearm flexes at the elbow (X).
 * The joint order matches both renderers' Euler `XYZ` (or `YXZ` with no yaw)
 * composition, so `Rx(pitch) · Rz(abduction)` is the upper arm and
 * `Rx(pitch) · Rz(abduction) · Rx(elbow)` the forearm.
 *
 * Targets are the wrist position relative to the shoulder, in the frame the
 * arm hangs from (the torso), in the same units as the limb lengths. The
 * solve is a few fixed-point corrections of the planar solution, measured
 * against forward kinematics below. Pure and allocation-free.
 */
import type { ArmSolution } from './ik';

export interface Arm3DSolution extends ArmSolution {
  /** Upper-arm sideways turn (rotation.z); positive moves the wrist toward +X. */
  abduction: number;
  /** Remaining wrist error in the same units as the limbs (≈0 when reachable). */
  error: number;
}

const ITERATIONS = 12;
/** Reach margin: tight, so a fully stretched arm stays straight (ik.ts uses 1 mm, which bends it ~6°). */
const REACH_MARGIN = 1e-6;

/**
 * The sagittal-plane solution of ik.ts (same conventions) for a wrist at (dy, dz)
 * from the shoulder: the lower-elbow branch, the elbow flexed by the law of cosines.
 */
function solvePlane(dy: number, dz: number, upper: number, lower: number, out: ArmSolution): void {
  const distance = Math.hypot(dy, dz);
  const reach = Math.max(Math.abs(upper - lower) + REACH_MARGIN, Math.min(upper + lower - REACH_MARGIN, distance));
  const toTarget = Math.atan2(-dz, -dy);
  const spread = Math.acos(Math.max(-1, Math.min(1, (upper * upper + reach * reach - lower * lower) / (2 * upper * reach))));
  const first = toTarget + spread, second = toTarget - spread;
  out.pitch = -Math.cos(first) * upper <= -Math.cos(second) * upper ? first : second;
  out.elbow = Math.acos(Math.max(-1, Math.min(1, (upper * upper + lower * lower - reach * reach) / (2 * upper * lower)))) - Math.PI;
}
const MAX_ABDUCTION = 1.25;

/** Wrist position of an arm with the given joint angles, relative to the shoulder. Writes into `out`. */
export function armWrist3D(pitch: number, abduction: number, elbow: number, upper: number, lower: number, out: [number, number, number]): [number, number, number] {
  const ca = Math.cos(pitch), sa = Math.sin(pitch), cb = Math.cos(abduction), sb = Math.sin(abduction);
  const ce = Math.cos(elbow), se = Math.sin(elbow);
  // Elbow: Rx(pitch) Rz(abduction) (0, -upper, 0).
  const ex = upper * sb, ey = -upper * cb * ca, ez = -upper * cb * sa;
  // Forearm direction in the upper frame: Rx(elbow) (0, -lower, 0), then the upper arm's Rz and Rx.
  // Rz(b)(x, y, z) = (x cb - y sb, x sb + y cb, z); Rx(a)(x, y, z) = (x, y ca - z sa, y sa + z ca).
  const fy = -lower * ce, fz = -lower * se;
  const vx = -fy * sb, vy = fy * cb, vz = fz;
  out[0] = ex + vx;
  out[1] = ey + vy * ca - vz * sa;
  out[2] = ez + vy * sa + vz * ca;
  return out;
}

const scratch: [number, number, number] = [0, 0, 0];

/**
 * Solve the arm so the wrist reaches `(x, y, z)` (relative to the shoulder) as
 * closely as the limbs allow. The elbow bends down (the planar solver's choice).
 * A target beyond the arm's length is first pulled onto the reach sphere, so the
 * arm stretches straight toward it instead of drifting.
 */
export function solveArm3D(x: number, y: number, z: number, upper: number, lower: number, out: Arm3DSolution): Arm3DSolution {
  const plane: ArmSolution = { pitch: 0, elbow: 0 };
  const maxReach = upper + lower - REACH_MARGIN;
  const distance = Math.hypot(x, y, z);
  const scale = distance > maxReach && distance > 0 ? maxReach / distance : 1;
  const aimX = x * scale, aimY = y * scale, aimZ = z * scale;
  let tx = aimX, ty = aimY, tz = aimZ;
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const abduction = Math.max(-MAX_ABDUCTION, Math.min(MAX_ABDUCTION, Math.atan2(tx, Math.hypot(ty, tz))));
    solvePlane(ty, tz, upper, lower, plane);
    const wrist = armWrist3D(plane.pitch, abduction, plane.elbow, upper, lower, scratch);
    const ex = aimX - wrist[0], ey = aimY - wrist[1], ez = aimZ - wrist[2];
    out.pitch = plane.pitch; out.elbow = plane.elbow; out.abduction = abduction;
    if (Math.hypot(ex, ey, ez) < 1e-5) break;
    tx += ex; ty += ey; tz += ez;
  }
  const wrist = armWrist3D(out.pitch, out.abduction, out.elbow, upper, lower, scratch);
  out.error = Math.hypot(x - wrist[0], y - wrist[1], z - wrist[2]);
  return out;
}

/**
 * Wrist (hand rotation.x) that points the fingers along `direction` in the torso
 * frame, given the arm's solved joints. The hand's rest axis is the forearm's
 * −Y; this turns it about the forearm's X axis toward the direction.
 */
export function wristAngle(direction: readonly [number, number, number], pitch: number, abduction: number, elbow: number): number {
  // Bring the direction into the forearm frame: undo Rx(pitch), Rz(abduction), Rx(elbow), in that order.
  const [gx, gy, gz] = direction;
  const ca = Math.cos(pitch), sa = Math.sin(pitch), cb = Math.cos(abduction), sb = Math.sin(abduction);
  const ce = Math.cos(elbow), se = Math.sin(elbow);
  const y1 = gy * ca + gz * sa, z1 = -gy * sa + gz * ca;
  const y2 = -gx * sb + y1 * cb;
  const y3 = y2 * ce + z1 * se, z3 = -y2 * se + z1 * ce;
  return Math.atan2(-z3, -y3);
}

/** Signed pronation that turns a current palm normal toward gravity without moving the fingertip axis. */
export function wristTwistToDown(fx0: number, fy0: number, fz0: number, px0: number, py0: number, pz0: number): number {
  const fl = Math.hypot(fx0, fy0, fz0);
  const pl = Math.hypot(px0, py0, pz0);
  if (fl < 1e-8 || pl < 1e-8) return 0;
  const fx = fx0 / fl, fy = fy0 / fl, fz = fz0 / fl;
  const px = px0 / pl, py = py0 / pl, pz = pz0 / pl;
  // Project world-down into the plane perpendicular to the fingers so the
  // target remains a valid palm normal even when the fingers angle downward.
  const downDot = -fy;
  let dx = -downDot * fx, dy = -1 - downDot * fy, dz = -downDot * fz;
  const dl = Math.hypot(dx, dy, dz);
  if (dl < 1e-8) return 0;
  dx /= dl; dy /= dl; dz /= dl;
  const cx = py * dz - pz * dy, cy = pz * dx - px * dz, cz = px * dy - py * dx;
  return Math.atan2(fx * cx + fy * cy + fz * cz, px * dx + py * dy + pz * dz);
}
