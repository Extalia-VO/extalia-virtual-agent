/** Contact-aware leg pose, in metres. The character faces +Z. */
export interface SeatedLegPose {
  hip: number;
  thigh: number;
  maxThigh: number;
  knee: number;
  kneeY: number;
  kneeZ: number;
  ankleY: number;
}

/**
 * Keep the thigh above its cushion until the front edge. Feet reach the floor
 * when the limb lengths allow it; shorter legs hang rather than cut through
 * the seat. `hipAboveSeat` is the upper-leg joint clearance, not body scale.
 */
export function seatedLegPose(seatHeight: number, seatFront: number, hipAboveSeat: number,
  thighLength: number, shinLength: number, ankleHeight: number, thighRadius: number, out: SeatedLegPose): SeatedLegPose {
  const hip = seatHeight + hipAboveSeat;
  // A small upholstery compression is intentional; whole-thigh penetration is not.
  const clearance = Math.max(0, hipAboveSeat - thighRadius + 0.008);
  const slope = clearance / Math.max(0.04, seatFront);
  const maxDrop = thighLength * Math.sin(Math.atan(slope));
  const drop = Math.max(-thighLength * 0.2, Math.min(maxDrop, hip - shinLength - ankleHeight));
  const thigh = -Math.acos(Math.max(-1, Math.min(1, drop / thighLength)));
  out.hip = hip; out.thigh = thigh; out.knee = -thigh;
  out.maxThigh = -Math.acos(Math.max(-1, Math.min(1, maxDrop / thighLength)));
  out.kneeY = hip - drop; out.kneeZ = -Math.sin(thigh) * thighLength;
  out.ankleY = out.kneeY - shinLength;
  return out;
}

export function createSeatedLegPose(): SeatedLegPose {
  return { hip: 0, thigh: 0, maxThigh: 0, knee: 0, kneeY: 0, kneeZ: 0, ankleY: 0 };
}

/** Leisure clip offsets must respect the same cushion contact as the base pose. */
export function supportedThigh(angle: number, pose: SeatedLegPose, sit: number): number {
  return Math.min(angle, Math.PI / 2 * (1 - sit) + pose.maxThigh * sit);
}

/** A relaxed clip may lower a knee; flex the calf forward instead of sinking a shoe through the floor. */
export function floorSeatedKnee(thigh: number, knee: number, hip: number, upper: number, lower: number, ankle: number, sit: number): number {
  if (sit < 0.98) return knee;
  const kneeY = hip - Math.cos(thigh) * upper;
  if (kneeY - Math.cos(thigh + knee) * lower >= ankle) return knee;
  const calf = -Math.acos(Math.max(-1, Math.min(1, (kneeY - ankle) / lower)));
  return calf - thigh;
}
