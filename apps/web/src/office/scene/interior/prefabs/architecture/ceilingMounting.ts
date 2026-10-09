import { FLOOR_HEIGHT, OFFICE_STAIRCASE } from "../../../layout";

export type CeilingFloor = 1 | 2 | 3;
/** Matches the actual 0.32 m upper-floor slabs and the roof envelope's 0.28 m slab. */
export const STRUCTURAL_ROOF_UNDERSIDE_Y = 19.13 - 0.28 / 2;
export const STRUCTURAL_CEILING_HEIGHTS = Object.freeze({
  1: FLOOR_HEIGHT - 0.32,
  2: FLOOR_HEIGHT - 0.32,
  3: STRUCTURAL_ROOF_UNDERSIDE_Y - FLOOR_HEIGHT * 2
});
export function ceilingYForFloor(floor: CeilingFloor) { return STRUCTURAL_CEILING_HEIGHTS[floor]; }
/** The bar's suspension attaches to the actual intermediate landing underside. */
export const UNDER_STAIR_SOFFIT_Y = OFFICE_STAIRCASE.rise / 2 - 0.17;

/** The housing's top face touches the ceiling; its lens/beam stays below it. */
function mountsAt(y: number) {
  return Object.freeze({
    room: { anchorY: y - 0.04, sourceY: y - 0.065 },
    lobby: { anchorY: y - 0.04, sourceY: y - 0.065 },
    executive: { trimY: y - 0.01, lensY: y - 0.022, sourceY: y - 0.04 },
    corridor: { anchorY: y - 0.0325, sourceY: y - 0.0555 },
    troffer: { anchorY: y - 0.04, sourceY: y - 0.065 },
    meeting: { canopyY: y - 0.0225, bodyY: 2.62, sourceY: 2.557 }
  });
}
const floorMounts = { 1: mountsAt(ceilingYForFloor(1)), 2: mountsAt(ceilingYForFloor(2)), 3: mountsAt(ceilingYForFloor(3)) };
export function ceilingMountsForFloor(floor: CeilingFloor) { return floorMounts[floor]; }

/** Keep illumination at an authored task/floor height when a downlight is raised. */
export function raisedDownlightIntensity(intensity: number, previousY: number, mountedY: number, targetY = 0, previousRange?: number) {
  const oldDistance = Math.max(0.1, previousY - targetY);
  const newDistance = Math.max(0.1, mountedY - targetY);
  let cutoffCompensation = 1;
  if (previousRange !== undefined) {
    const newRange = raisedDownlightRange(previousRange, previousY, mountedY, targetY);
    const cutoff = (distance: number, range: number) => Math.max(0, 1 - (distance / range) ** 4) ** 2;
    cutoffCompensation = cutoff(oldDistance, previousRange) / Math.max(0.001, cutoff(newDistance, newRange));
  }
  return intensity * (newDistance / oldDistance) ** 2 * cutoffCompensation;
}

/** Keep the authored footprint and range at the receiving surface, rather than flooding a larger area. */
export function raisedDownlightAngle(angle: number, previousY: number, mountedY: number, targetY = 0) {
  return Math.atan(Math.tan(angle) * Math.max(0.1, previousY - targetY) / Math.max(0.1, mountedY - targetY));
}
export function raisedDownlightRange(distance: number, previousY: number, mountedY: number, targetY = 0) {
  return Math.sqrt(Math.max(0.01, distance ** 2 + (mountedY - targetY) ** 2 - (previousY - targetY) ** 2));
}

/** Decorative shades keep their original height while their suspension reaches the ceiling. */
export function ceilingPendantDrop(previousCanopyY: number, previousDrop: number, mountedCeilingY: number) {
  return mountedCeilingY - (previousCanopyY - previousDrop);
}
