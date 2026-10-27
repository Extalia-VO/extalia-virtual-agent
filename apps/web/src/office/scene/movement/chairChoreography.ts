/**
 * Geometry and timing of a person pulling a workstation chair out to sit down,
 * and pushing it back under the desk after standing up. Pure: the mover walks
 * the character through these beats, and the chair only moves while a hand
 * holds its back (`pull` is the fraction of the chair's slide that the mover
 * reports each frame).
 *
 * Chair-local frame (see `OfficeChair`): origin on the seat at the seat's
 * height, the sitter faces +Z, the backrest is behind the sitter at -Z. A pulled
 * chair slides back along -Z by `CHAIR_SLIDE`.
 */
import type { Point3 } from '../layout';
import { chairOffset, chairTurnSign } from '../interior/deskChairs';
import { OFFICE_CHAIR_SEAT_BLUEPRINT as CHAIR } from '../interior/furnitureSeatBlueprint';
import type { SeatApproach } from './navGraph';

/** Hand on the upper backrest, just behind the back panel (tucked chair frame). */
export const GRIP_HEIGHT = 1.0;
export const GRIP_BACK_Z = CHAIR.backZ - CHAIR.backThickness / 2 - CHAIR.rootForward
  - (GRIP_HEIGHT - CHAIR.cushionHeight - CHAIR.taskBackHeight / 2) * Math.sin(0.08);
/** The right hand takes hold on its own shoulder side, so the reach stays in the arm's plane. */
export const GRIP_HAND_X = 0.19;
/** Where the walker stands behind the tucked chair to take hold of it (feet, tucked frame). */
export const GRIP_STAND: readonly [number, number] = [0, -0.82];
/** Beside a pulled chair, clear of its back corner: the walker steps round the chair here. */
export const SIDE_STEP: readonly [number, number] = [0.76, -0.70];
/** Enter through the open front, clear of the arm pads, before lowering backward. */
export const CHAIR_FRONT_APPROACH = 0.60;
export type ChairSide = 1 | -1;
type ChairSeat = Pick<SeatApproach, 'seat' | 'rotationY'> & Partial<Pick<SeatApproach, 'seatId' | 'seatFront'>>;
/** Executive resources use a different root anchor from task chairs. */
export const chairRootForward = (seat: ChairSeat): number => CHAIR.cushionSize[2] / 2 + CHAIR.cushionCenter[2] - (seat.seatFront ?? CHAIR.seatFront);
/** Armrest pads (both hands push on them when standing up). */
export const ARMREST = { x: (CHAIR.armOuterWidth - CHAIR.armPadSize[0]) / 2,
  y: CHAIR.armPadTop, z: CHAIR.armPadZ - CHAIR.rootForward } as const;
/** Front edge of the seat, where both hands rest while the chair is scooted in. */
export const SEAT_EDGE = { x: CHAIR.cushionSize[0] / 2 - 0.05, y: CHAIR.cushionHeight, z: CHAIR.seatFront } as const;

/** Beat durations in seconds, within the natural 0.6–1.2 s range of a sub-step. */
export const BEAT_S = {
  /** Turn to the chair and reach to its back. */
  grip: 0.45,
  /** The chair rolls out while the hand holds it. */
  pull: 0.9,
  /** Hand comes off the chair. */
  letGo: 0.35,
  /** Turn to face the workstation before lowering into the open front. */
  align: 0.45,
  /** Sitting down onto the pulled chair. */
  lower: 0.85,
  /** Hands on the seat edge, the chair and the sitter slide in together. */
  scoot: 0.9,
  /** Standing up: the legs push, the chair rolls back under the body. */
  stand: 1.1,
  /** Hands on the armrests ramp in before the chair starts to roll. */
  armrestRamp: 0.2,
} as const;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
/** Smooth 0…1 ease: slow start and stop, as a person moves a chair. */
export const smooth01 = (value: number) => { const x = clamp01(value); return x * x * (3 - 2 * x); };

/** A chair-attached point at `pull` (0 tucked … 1 out), given in the tucked chair frame. */
export function chairWorld(seat: ChairSeat, pull: number, x: number, y: number, z: number, out: Point3, side: ChairSide = chairTurnSign(seat.seatId ?? '')): Point3 {
  const { back, turn } = chairOffset(pull, seat.seatId ?? '', side);
  // Resources anchor the avatar root 2 cm ahead of the mesh origin. Rotate
  // around the mesh origin, exactly like DeskChairInstances, then slide back.
  const ct = Math.cos(turn), st = Math.sin(turn), forward = chairRootForward(seat);
  const lx = x * ct + (z + forward) * st;
  const lz = -x * st + (z + forward) * ct - forward - back;
  const c = Math.cos(seat.rotationY), s = Math.sin(seat.rotationY);
  out[0] = seat.seat[0] + lx * c + lz * s;
  out[1] = seat.seat[1] + y;
  out[2] = seat.seat[2] - lx * s + lz * c;
  return out;
}

/** Contact descriptors above use the canonical task-chair anchor; keep them on the mesh for other anchors. */
export function chairContactWorld(seat: ChairSeat, pull: number, x: number, y: number, z: number, out: Point3, side: ChairSide): Point3 {
  return chairWorld(seat, pull, x, y, z + CHAIR.rootForward - chairRootForward(seat), out, side);
}

/** A fixed point of the room (not attached to the chair), given in the tucked chair frame. */
export function roomPoint(seat: Pick<SeatApproach, 'seat' | 'rotationY'>, x: number, z: number, out: Point3): Point3 {
  return chairWorld(seat, 0, x, 0, z, out);
}

/** The world point of the chair's sitting centre at `pull` (where the sitter's feet are). */
export function sittingCentre(seat: ChairSeat, pull: number, out: Point3, side?: ChairSide): Point3 {
  return chairWorld(seat, pull, 0, 0, 0, out, side);
}

export function chairYaw(seat: ChairSeat, pull: number, side: ChairSide): number {
  return seat.rotationY + chairOffset(pull, seat.seatId ?? '', side).turn;
}

/** Reproducible per-maneuver variation: not locked to one side for a given desk. */
export function chairManeuverSide(id: string, sequence: number): ChairSide {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  hash = Math.imul(hash ^ Math.imul(sequence + 1, 0x9e3779b9), 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  return ((hash ^ (hash >>> 16)) & 1) ? 1 : -1;
}

/** The same signed front opening is used to enter and to leave the swiveled chair. */
export function chairWalkPath(seat: SeatApproach, beat: string, side: ChairSide): Point3[] {
  const at = (x: number, z: number) => chairWorld(seat, 1, x, 0, z, [0, 0, 0], side);
  const rearSide = () => at(side * SIDE_STEP[0], SIDE_STEP[1]);
  const frontSide = () => at(side * SIDE_STEP[0], 0.54);
  const front = () => at(0, CHAIR_FRONT_APPROACH);
  const grip = () => at(GRIP_STAND[0], GRIP_STAND[1]);
  if (beat === 'grip-walk') return [roomPoint(seat, GRIP_STAND[0], GRIP_STAND[1], [0, 0, 0])];
  if (beat === 'walk-out') return [frontSide(), rearSide(), grip()];
  if (beat === 'walk-sit') return [rearSide(), frontSide(), front()];
  return [];
}

/** Express a world point in a character's own frame: feet at the origin, facing `yaw`, +Z forward. */
export function toCharacterFrame(origin: Readonly<Point3>, yaw: number, world: Readonly<Point3>, out: [number, number, number]): [number, number, number] {
  const dx = world[0] - origin[0], dz = world[2] - origin[2];
  const c = Math.cos(yaw), s = Math.sin(yaw);
  out[0] = dx * c - dz * s;
  out[1] = world[1] - origin[1];
  out[2] = dx * s + dz * c;
  return out;
}

/** Yaw that faces a point from `from` (XZ). Characters face +Z at yaw 0. */
export function yawToward(from: Readonly<Point3>, to: Readonly<Point3>): number {
  return Math.atan2(to[0] - from[0], to[2] - from[2]);
}

/**
 * Pull of the chair while a standing person pushes off the seat: the hands are
 * on the armrests first (the first quarter of the stand-up), then the chair rolls
 * back under the body and comes to rest as the body reaches its full height.
 */
export function standPull(fraction: number): number {
  const start = BEAT_S.armrestRamp / BEAT_S.stand;
  // Roll out before the hands leave the pads and the feet step into the front opening.
  return smooth01((fraction - start) / (0.65 - start));
}

/** Pull while a seated person scoots the chair in: the hands settle on the seat edge before it moves. */
export function scootPull(elapsedS: number): number {
  const start = BEAT_S.armrestRamp;
  return 1 - smooth01((elapsedS - start) / (BEAT_S.scoot - start));
}
