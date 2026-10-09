import type { Point3 } from './layout';

/** Floor views look at the building from this direction (south-east, above). */
const FLOOR_VIEW_DIRECTION: Point3 = [33, 29.3, 38];
const FOCUS_DISTANCE = 52;
/** Orthographic zoom for a selected character: about 60 px for a standing person. */
export const CHARACTER_FOCUS_ZOOM = 36;
/** Seated characters are looked at around chest height. */
const FOCUS_HEIGHT = 0.95;

export interface CameraPose {
  position: Point3;
  target: Point3;
  zoom: number;
}

/**
 * Where the camera goes to show a character at `seat`, keeping the floor view's
 * angle. `shiftPx` moves the camera in screen space (right, up) so the character
 * appears beside an overlay instead of under it.
 */
export function characterFocusPose(seat: Point3, zoom = CHARACTER_FOCUS_ZOOM, shiftPx: [number, number] = [0, 0]): CameraPose {
  const length = Math.hypot(...FLOOR_VIEW_DIRECTION);
  const back = FLOOR_VIEW_DIRECTION.map(value => value / length) as Point3;
  // Camera axes: forward = -back; right = forward × worldUp; up = right × forward.
  const right: Point3 = [back[2], 0, -back[0]].map(value => value / Math.hypot(back[0], back[2])) as Point3;
  const up: Point3 = [-(right[1] * back[2] - right[2] * back[1]), -(right[2] * back[0] - right[0] * back[2]), -(right[0] * back[1] - right[1] * back[0])];
  const shift = (axis: 0 | 1 | 2) => (right[axis] * shiftPx[0] + up[axis] * shiftPx[1]) / zoom;
  const target: Point3 = [seat[0] + shift(0), seat[1] + FOCUS_HEIGHT + shift(1), seat[2] + shift(2)];
  const position: Point3 = [target[0] + back[0] * FOCUS_DISTANCE, target[1] + back[1] * FOCUS_DISTANCE, target[2] + back[2] * FOCUS_DISTANCE];
  return { position, target, zoom };
}

/** Screen shift that keeps a focused character clear of the conversation panel (right on wide screens, bottom on phones). */
export function panelClearance(width: number, height: number): [number, number] {
  return width >= 700 ? [Math.min(210, width * 0.2), 0] : [0, -height * 0.22];
}

/** Ease-out cubic progress of a camera move; reduced motion jumps straight to the end. */
export function cameraProgress(elapsedSeconds: number, durationSeconds: number, reducedMotion: boolean): number {
  if (reducedMotion || durationSeconds <= 0) return 1;
  const raw = Math.min(1, Math.max(0, elapsedSeconds / durationSeconds));
  return 1 - (1 - raw) ** 3;
}
