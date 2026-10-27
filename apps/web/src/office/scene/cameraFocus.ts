import { FLOOR_HEIGHT, OFFICE_BUILDING, type Point3 } from './layout';
import { CITY_GROUND } from './campusGroundBounds';

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

/** What the Office asks the camera to frame: a point on a floor (e.g. the middle of a room) and how much room to show. */
export interface FocusPoint {
  point: Point3;
  /** Footprint in metres (x, z) to frame; omitted frames a character-sized area. */
  size?: readonly [number, number];
}

/**
 * Orthographic zoom that frames a room of `size` metres (x, z) in the free part
 * of the viewport. The floor view looks along a diagonal, so a room's screen
 * width is roughly 0.7 × (x + z).
 */
export function roomFocusZoom(size: readonly [number, number], viewportWidth: number): number {
  const usable = viewportWidth >= 700 ? viewportWidth * 0.55 : viewportWidth * 0.92;
  const extent = Math.max(6, (size[0] + size[1]) * 0.7);
  return Math.min(CHARACTER_FOCUS_ZOOM, Math.max(8, usable / extent));
}

/** Floor overviews look a little steeper than character focus so a whole floor plate reads at once. */
const FLOOR_OVERVIEW_DIRECTION: Point3 = [33, 40, 38];
const FLOOR_OVERVIEW_DISTANCE = 60;
/** A floor plate (metres): the building's walls plus head height of its furniture. */
const FLOOR_PLATE = { ...OFFICE_BUILDING, height: 3.2 } as const;

/** Pixels the Office overlays cover around the 3D stage: board on the right, dock and agent cards at the bottom. */
export interface StageInsets { left: number; right: number; top: number; bottom: number }

export function officeOverlayInsets(width: number, height: number): StageInsets {
  return width >= 700
    ? { left: 16, top: 16, right: Math.min(280, width * 0.38) + 40, bottom: Math.min(200, height * 0.32) }
    : { left: 8, top: 8, right: 8, bottom: Math.min(260, height * 0.34) };
}

/** Floor views reserve the compact dock/cards, with a small gap beside the agent board. */
export function floorOverlayInsets(width: number, height: number): StageInsets {
  return width >= 700
    ? { left: 16, top: 16, right: Math.min(280, width * 0.38) + 32, bottom: Math.min(180, height * 0.28) }
    : officeOverlayInsets(width, height);
}

function viewAxes(direction: Point3) {
  const length = Math.hypot(...direction);
  const back = direction.map(value => value / length) as Point3;
  const flat = Math.hypot(back[0], back[2]);
  const right: Point3 = [back[2] / flat, 0, -back[0] / flat];
  // up = right × forward, with forward = -back.
  const up: Point3 = [-(right[1] * back[2] - right[2] * back[1]), -(right[2] * back[0] - right[0] * back[2]), -(right[0] * back[1] - right[1] * back[0])];
  return { back, right, up };
}

const dot = (a: Point3, b: Point3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** An axis-aligned box in world metres. */
interface Box { west: number; east: number; north: number; south: number; bottom: number; top: number }

/**
 * Camera pose that shows `box` as large as possible, looking along `direction`, in the part of the
 * stage the overlays leave free: the box's corners are projected on the view plane, the orthographic
 * zoom fits them (times `fill`), and the target shifts so the box sits in the middle of the free area.
 */
function fitBoxPose(box: Box, direction: Point3, distance: number, width: number, height: number, insets: StageInsets, fill = 0.97): CameraPose {
  const { back, right, up } = viewAxes(direction);
  const center: Point3 = [(box.west + box.east) / 2, (box.bottom + box.top) / 2, (box.north + box.south) / 2];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const x of [box.west, box.east]) for (const z of [box.north, box.south]) for (const y of [box.bottom, box.top]) {
    const offset: Point3 = [x - center[0], y - center[1], z - center[2]];
    const px = dot(offset, right), py = dot(offset, up);
    minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
  }
  const freeWidth = Math.max(120, width - insets.left - insets.right);
  const freeHeight = Math.max(120, height - insets.top - insets.bottom);
  const zoom = Math.max(3, Math.min(65, fill * Math.min(freeWidth / (maxX - minX), freeHeight / (maxY - minY))));
  // Middle of the projected box, then the free area's offset from the stage centre (in world units).
  const shiftX = (minX + maxX) / 2 + (insets.right - insets.left) / 2 / zoom;
  const shiftY = (minY + maxY) / 2 - (insets.bottom - insets.top) / 2 / zoom;
  const target: Point3 = [0, 1, 2].map(axis => center[axis as 0 | 1 | 2] + right[axis as 0 | 1 | 2] * shiftX + up[axis as 0 | 1 | 2] * shiftY) as Point3;
  const position: Point3 = [target[0] + back[0] * distance, target[1] + back[1] * distance, target[2] + back[2] * distance];
  return { position, target, zoom };
}

/** A whole floor (floor surface at `level`) framed in the free stage area. */
export function floorOverviewPose(level: number, width: number, height: number, insets: StageInsets = floorOverlayInsets(width, height)): CameraPose {
  return fitBoxPose({ ...FLOOR_PLATE, bottom: level, top: level + FLOOR_PLATE.height }, FLOOR_OVERVIEW_DIRECTION, FLOOR_OVERVIEW_DISTANCE, width, height, insets);
}

/** All occupied floors, including their walls and furniture, fitted to the same usable canvas. */
export function stackOverviewPose(width: number, height: number, insets: StageInsets = floorOverlayInsets(width, height)): CameraPose {
  return fitBoxPose({ ...FLOOR_PLATE, bottom: 0, top: FLOOR_HEIGHT * 2 + FLOOR_PLATE.height }, FLOOR_OVERVIEW_DIRECTION, FLOOR_OVERVIEW_DISTANCE, width, height, insets);
}

/**
 * The Building view (first view of the Office): the office building with its roof and the entrance
 * plaza, seen from the north-west at about 17° so the whole building fills the stage.
 */
const BUILDING_VIEW_DIRECTION: Point3 = [-34, 26, -79];
// Close enough that the skyline towers between the street and the campus stay behind the camera.
const BUILDING_VIEW_DISTANCE = 88;
/** The building (three floors and the roof plant) plus the front plaza and its sign. */
const BUILDING_FRAME: Box = { west: -21, east: 25, north: -30, south: 19, bottom: 0, top: 22 };

export function buildingOverviewPose(width: number, height: number, insets: StageInsets = officeOverlayInsets(width, height)): CameraPose {
  return fitBoxPose(BUILDING_FRAME, BUILDING_VIEW_DIRECTION, BUILDING_VIEW_DISTANCE, width, height, insets, 0.94);
}

/**
 * Smallest zoom whose viewport rays all meet the city's ground inside its rim.
 * Include the current pan, elevation and orbit instead of assuming the default pose.
 * A 12 m inset also clears the straight edges between the ground disc's vertices.
 * Infinity means the central ray is outside the disc; freeze zoom until panned back.
 */
export function buildingMinimumZoom(width: number, height: number, position: Point3, target: Point3): number {
  const direction = position.map((value, axis) => value - target[axis]!) as Point3;
  const { back, right, up } = viewAxes(direction);
  const vertical = Math.max(0.01, back[1]);
  const radius = CITY_GROUND.radius * Math.cos(Math.PI / CITY_GROUND.segments) - 12;
  // Intersection of the central viewing ray with the ground (x,z).
  const center = [target[0] - back[0] * (target[1] - CITY_GROUND.y) / vertical,
    target[2] - back[2] * (target[1] - CITY_GROUND.y) / vertical];
  const inside = radius * radius - center[0]! ** 2 - center[1]! ** 2;
  // A view aimed beyond the backdrop cannot be repaired by zooming out.
  if (inside <= 0) return Infinity;
  let minimum = 2;
  for (const sx of [-width / 2, width / 2]) for (const sy of [-height / 2, height / 2]) {
    const x = right[0] * sx + (up[0] - back[0] * up[1] / vertical) * sy;
    const z = right[2] * sx + (up[2] - back[2] * up[1] / vertical) * sy;
    // Solve |center + corner / zoom|² <= radius² for positive zoom.
    const dot = center[0]! * x + center[1]! * z;
    minimum = Math.max(minimum, (dot + Math.sqrt(dot * dot + inside * (x * x + z * z))) / inside);
  }
  return Math.min(260, minimum);
}
