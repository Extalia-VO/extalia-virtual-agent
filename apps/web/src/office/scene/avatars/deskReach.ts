/**
 * Where a seated character's hands go at its desk. Desk props are authored in
 * the desk's own frame (keyboard, mouse, cup, chair); this module expresses
 * them in the seat-root frame the character is drawn in (origin on the seat
 * anchor, +Z forward toward the desk, metres, +Y up). Pure: the same desk
 * always gives the same numbers, and results are cached per seat.
 *
 * The constants mirror the prefabs they describe (SingleWorkstation,
 * TeamPod4 DeviceSet, ExecutiveWorkstation, DeskAccessories); a change there
 * should change them here.
 */
import { EXECUTIVE_OFFICE_BLUEPRINT, RECEPTION_DESK_BLUEPRINT, SINGLE_WORKSTATION_BLUEPRINT, TEAM_POD_SEAT } from '../interior/spatialBlueprints';
import { deskInputPlacement, deskLayout, EXECUTIVE_KEYBOARD_BASE, EXECUTIVE_DESK_TOP, RECEPTION_DESK_TOP, RECEPTION_KEYBOARD_BASE, type DeskLayout } from '../interior/deskLayout';
import TEAM_POD_PROFILE from '../interior/teamPodDesktopProfile.json';

export type XYZ = readonly [number, number, number];
type XZ = readonly [number, number];

/** Seat anchor offset for executive seats (the default office anchor). */
export const DEFAULT_SEAT_FORWARD = 0.04;

/** Keycap top above the keyboard's group origin (Keyboard.tsx: keycaps at +0.021, 0.012 tall). */
const KEY_TOP = 0.027;
/** Mouse top above its body centre (deskLayout MOUSE_DIMENSIONS). */
const MOUSE_TOP = 0.038;
/** Desk surface height and the mouse/keyboard group heights used by the single desk. */
const SINGLE_DESK_TOP = 0.785;
const SINGLE_KEYBOARD_Y = 0.8;
/** Wrist height above a key or pad: the fingers reach the surface from here. */
const WRIST_ABOVE_KEYS = 0.05;
const WRIST_ABOVE_MOUSE = 0.025;
/** The wrist trails the fingertips: this far nearer the sitter than the keys or the mouse. */
const WRIST_BEHIND_KEYS = 0.10;
const WRIST_BEHIND_MOUSE = 0.08;

const POD_DIAGONAL = Math.PI / 4;
const POD_DESK_TOP = TEAM_POD_PROFILE.top;

/** Executive leader desk (ExecutiveWorkstation): keyboard and mouse in the desk frame; the leader seat comes from the blueprint. */
const EXECUTIVE_SEAT: XZ = [EXECUTIVE_OFFICE_BLUEPRINT.leaderSeat.position[0], EXECUTIVE_OFFICE_BLUEPRINT.leaderSeat.position[2]];

/** Hand targets for one desk, in seat-root metres. */
export interface DeskReach {
  /** Centre of the keyboard's letter block (the board's centre on compact boards) at key-top height. */
  readonly keyboard: XYZ;
  /** Mouse centre at pad height. */
  readonly mouse: XYZ;
  /** Wrist target while typing: fingers reach the keys. */
  readonly typeWrist: XYZ;
  /** Wrist target on the mouse. */
  readonly mouseWrist: XYZ;
  /** The cup a sitter can lift (single desks), at desk height. */
  readonly cup: XYZ;
  /** Where a resting forearm meets the desk, nearer the sitter than the keyboard. */
  readonly rest: XYZ;
  /** Geometric limb index: 0 is anatomical right (−X facing +Z), 1 is +X. */
  readonly mouseHand: 0 | 1;
  /** Finger aim across the real device, in the seat frame (+Z away from the sitter). */
  readonly keyboardForward: XYZ;
  readonly mouseForward: XYZ;
}

/** Same rotation as the registry: a child-to-parent yaw about +Y. */
function rotateXZ(x: number, z: number, yaw: number): XZ {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [x * c + z * s, -x * s + z * c];
}

/** A point in a parent frame, expressed in a child frame with origin `origin` and yaw `yaw`. */
export function toChildFrame(point: XYZ, origin: XYZ, yaw: number): XYZ {
  const [x, z] = rotateXZ(point[0] - origin[0], point[2] - origin[2], -yaw);
  return [x, point[1] - origin[1], z];
}

/**
 * The seat root of a chair, in the frame of the chair's parent (desk or station).
 * `forward` moves the sitter toward the desk along the chair's facing.
 */
export function seatRootInParent(chairXZ: XZ, chairYaw: number, forward: number): XZ {
  const [dx, dz] = rotateXZ(0, forward, chairYaw);
  return [chairXZ[0] + dx, chairXZ[1] + dz];
}

/** Build the hand targets from desk-frame prop positions and the seat root in the same frame. */
export function deskReachFromProps(input: {
  keyboard: XYZ; mouse: XYZ; cup?: XYZ | undefined;
  seatRoot: XZ; seatYaw: number; keyboardTopOffset?: number; mouseTopOffset?: number;
  keyboardYaw?: number; mouseYaw?: number;
}): DeskReach {
  const root: XYZ = [input.seatRoot[0], 0, input.seatRoot[1]];
  const keyboard = toChildFrame([input.keyboard[0], input.keyboard[1] + KEY_TOP, input.keyboard[2]], root, input.seatYaw);
  const mouse = toChildFrame([input.mouse[0], input.mouse[1] + (input.mouseTopOffset ?? MOUSE_TOP / 2), input.mouse[2]], root, input.seatYaw);
  const cup = input.cup ? toChildFrame(input.cup, root, input.seatYaw) : [2 * keyboard[0] - mouse[0], keyboard[1], keyboard[2]] as const;
  const mouseHand: 0 | 1 = mouse[0] < 0 ? 0 : 1;
  const forward = (yaw: number | undefined): XYZ => {
    if (yaw === undefined) return [0, 0, 1];
    const [x, z] = rotateXZ(0, -1, yaw - input.seatYaw);
    return [x, 0, z];
  };
  const keyboardForward = forward(input.keyboardYaw), mouseForward = forward(input.mouseYaw);
  return {
    keyboardForward, mouseForward,
    keyboard,
    mouse,
    typeWrist: [keyboard[0] - keyboardForward[0] * WRIST_BEHIND_KEYS, keyboard[1] + WRIST_ABOVE_KEYS, keyboard[2] - keyboardForward[2] * WRIST_BEHIND_KEYS],
    mouseWrist: [mouse[0] - mouseForward[0] * WRIST_BEHIND_MOUSE, mouse[1] + WRIST_ABOVE_MOUSE, mouse[2] - mouseForward[2] * WRIST_BEHIND_MOUSE],
    cup: [cup[0], cup[1], cup[2]],
    rest: [keyboard[0], keyboard[1], keyboard[2] - 0.15],
    mouseHand,
  };
}

/** Hand targets from where this desk's layout puts the keyboard and mouse. */
function reachFor(base: XYZ, baseYaw: number, deskTop: number, layout: DeskLayout, seatRoot: XZ, seatYaw: number, cup?: XYZ): DeskReach {
  const input = deskInputPlacement(base, baseYaw, deskTop, layout);
  return deskReachFromProps({ keyboard: input.typing, mouse: input.mouse, cup, seatRoot, seatYaw, mouseTopOffset: MOUSE_TOP / 2, keyboardYaw: input.keyboardYaw, mouseYaw: input.mouseYaw });
}

/** Single desk (SingleWorkstation, Touchdown, laptop and dual-monitor variants) with the chair at the blueprint's place. */
function singleDesk(layout: DeskLayout): DeskReach {
  const chair = SINGLE_WORKSTATION_BLUEPRINT.chairPosition;
  const root = seatRootInParent([chair[0], chair[2]], SINGLE_WORKSTATION_BLUEPRINT.chairRotationY, SINGLE_WORKSTATION_BLUEPRINT.seatForward);
  return reachFor([0, SINGLE_KEYBOARD_Y, SINGLE_WORKSTATION_BLUEPRINT.keyboardZ], 0, SINGLE_DESK_TOP, layout,
    root, SINGLE_WORKSTATION_BLUEPRINT.chairRotationY, [-0.60, SINGLE_DESK_TOP, 0.18]);
}

/** A quadrant pod station: keyboard and pointer in the station frame, chair at the pod seat. */
function podDesk(layout: DeskLayout): DeskReach {
  const root = seatRootInParent(TEAM_POD_SEAT.chairPosition as XZ, TEAM_POD_SEAT.chairRotationY, TEAM_POD_SEAT.seatForward);
  return reachFor(TEAM_POD_SEAT.keyboardPosition, POD_DIAGONAL, POD_DESK_TOP, layout, root, TEAM_POD_SEAT.chairRotationY);
}

/** The executive leader desk, as placed. */
function executiveDesk(layout: DeskLayout): DeskReach {
  const root = seatRootInParent(EXECUTIVE_SEAT, 0, DEFAULT_SEAT_FORWARD);
  return reachFor(EXECUTIVE_KEYBOARD_BASE, Math.PI, EXECUTIVE_DESK_TOP, layout, root, 0);
}

/** Reception is authored inside its counter group, behind the transaction body. */
function receptionDesk(layout: DeskLayout): DeskReach {
  const b = RECEPTION_DESK_BLUEPRINT;
  const root = seatRootInParent([0, b.chairOffsetZ - b.counterOffsetZ], Math.PI, DEFAULT_SEAT_FORWARD);
  return reachFor(RECEPTION_KEYBOARD_BASE, 0, RECEPTION_DESK_TOP, layout, root, Math.PI);
}

const POD_SEAT = /^engineering\.(pod-[a-z])\.(seat-[a-z]{2})$/;
const cache = new Map<string, DeskReach>();
const SINGLE = singleDesk(deskLayout(undefined));

/**
 * Hand targets for the desk a seat belongs to, following that desk's own
 * keyboard and mouse arrangement (deskLayout). Unknown seats get the single
 * desk, the most common layout; laptop desks use the same external keyboard.
 */
export function deskReachForSeat(seatId: string | undefined): DeskReach {
  if (!seatId) return SINGLE;
  const known = cache.get(seatId);
  if (known) return known;
  const layout = deskLayout(seatId);
  const reach = seatId === 'lobby.receptionist' ? receptionDesk(layout)
    : seatId === 'executive.leader' || seatId === 'executive-studio.ceo' ? executiveDesk(layout)
    : POD_SEAT.test(seatId) ? podDesk(layout) : singleDesk(layout);
  cache.set(seatId, reach);
  return reach;
}
