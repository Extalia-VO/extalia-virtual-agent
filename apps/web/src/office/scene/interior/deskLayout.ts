/**
 * How each desk is set up: keyboard size and placement, which side the mouse
 * is on, and the small furniture on the desktop. Real people arrange their
 * desks differently, so every seat gets its own stable arrangement from its
 * resource id. Pure and shared by the desk prefabs (what is drawn) and the
 * avatars' hand targets (where the hands go), so they can never disagree.
 *
 * Desk frame: metres, +Y up; the keyboard frame's +Z points at the sitter and
 * the sitter's right hand is +X in that keyboard frame (-X when facing +Z).
 */

export type XYZ = readonly [number, number, number];
type XZ = readonly [number, number];

export type KeyboardKind = 'compact' | 'full';

/** Real key spacing (19 mm). */
export const KEY_PITCH = 0.019;

/** Real keyboard footprints: a compact (75%) board, and a full board with a number pad. */
export const KEYBOARD_DIMENSIONS: Readonly<Record<KeyboardKind, { width: number; depth: number }>> = Object.freeze({
  compact: { width: 0.31, depth: 0.125 },
  full: { width: 0.44, depth: 0.135 },
});
/** Chassis height; keycaps sit at +0.021 and are 0.012 tall (key tops at +0.027). */
export const KEYBOARD_HEIGHT = 0.028;
/** The 14-key letter block of a full board sits left of its centre (the number pad is on the right). */
export const FULL_ALPHA_OFFSET = -KEYBOARD_DIMENSIONS.full.width / 2 + 0.012 + 7 * KEY_PITCH;

/** A real mouse (6.4 × 11.6 cm, 3.8 cm tall) on a 22 × 19 cm pad. */
export const MOUSE_DIMENSIONS = Object.freeze({ width: 0.064, height: 0.038, length: 0.116 });
export const MOUSE_PAD = Object.freeze({ width: 0.22, depth: 0.19, thickness: 0.004 });
/** Mouse body centre above the pad's resting origin. */
export const MOUSE_CENTRE_Y = MOUSE_PAD.thickness + MOUSE_DIMENSIONS.height / 2;

export type DeskAccessoryKind =
  | 'drawer-unit' | 'letter-tray' | 'file-holder' | 'books' | 'plant'
  | 'photo' | 'notebook' | 'headphones' | 'pen-cup' | 'sticky-notes'
  | 'desk-shelf' | 'flower-vase' | 'ornament-lamp';

export interface DeskLayout {
  readonly keyboardKind: KeyboardKind;
  /** Keyboard shift from the desk's nominal spot, in the keyboard frame (x toward sitter-right, z toward the sitter). */
  readonly keyboardOffset: XZ;
  readonly keyboardYaw: number;
  /** Sitter-relative side: +1 right, -1 left. Runtime layouts use the right hand. */
  readonly mouseSide: 1 | -1;
  /** Gap between keyboard edge and mouse (kept small so the mouse hand stays close), and how far forward the mouse sits. */
  readonly mouseGap: number;
  readonly mouseForward: number;
  readonly mouseYaw: number;
  /** Mouse centre within its pad, varied independently from the pad placement. */
  readonly mouseOnPad: XZ;
  /** One item per desk slot, in the slot order of the desk kind (null: left empty). */
  readonly accessories: readonly (DeskAccessoryKind | null)[];
  /** Colour variation for the accessories. */
  readonly tint: number;
}

/** The arrangement for a desk without a seat id: centred compact board, mouse on the right. */
export const DEFAULT_DESK_LAYOUT: DeskLayout = Object.freeze({
  keyboardKind: 'compact', keyboardOffset: [0, 0] as const, keyboardYaw: 0,
  mouseSide: 1, mouseGap: 0.035, mouseForward: 0.015, mouseYaw: 0, mouseOnPad: [-0.07, 0.005] as const,
  accessories: ['letter-tray', 'pen-cup', null, null] as const, tint: 0,
} satisfies DeskLayout);

/** The leader's desk is set up once (its decor is part of the executive desk): centred board, mouse on the right. */
export const EXECUTIVE_DESK_LAYOUT: DeskLayout = Object.freeze({
  ...DEFAULT_DESK_LAYOUT, accessories: [],
});

function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return value >>> 0;
}

/** A stable sample in [min, max) per seat and trait. */
function sample(seat: string, trait: string, min: number, max: number): number {
  return min + (hash(`${seat}|${trait}`) / 4294967296) * (max - min);
}

function pick<T>(seat: string, trait: string, items: readonly T[]): T {
  return items[Math.min(items.length - 1, Math.floor(sample(seat, trait, 0, items.length)))]!;
}

/** Slot kinds: large items fit the back corners, flat ones the front. */
const BACK_LEFT: readonly (DeskAccessoryKind | null)[] = ['drawer-unit', 'letter-tray', 'file-holder', 'books', 'plant', 'desk-shelf'];
const BACK_RIGHT: readonly (DeskAccessoryKind | null)[] = ['pen-cup', 'plant', 'flower-vase', 'headphones', 'books', 'ornament-lamp', 'photo'];

const cache = new Map<string, DeskLayout>();

/** The arrangement of the desk a seat belongs to; the same id always gives the same desk. */
export function deskLayout(seatId: string | undefined): DeskLayout {
  if (!seatId) return DEFAULT_DESK_LAYOUT;
  const executive = seatId === 'executive.leader' || seatId === 'executive-studio.ceo';
  const known = cache.get(seatId);
  if (known) return known;
  const mouseSide = 1;
  const layout: DeskLayout = Object.freeze({
    keyboardKind: !executive && sample(seatId, 'board', 0, 1) < 0.35 ? 'full' : 'compact',
    keyboardOffset: executive ? [0, 0] as const : [sample(seatId, 'kx', -0.02, 0.02), sample(seatId, 'kz', -0.008, 0.008)] as const,
    keyboardYaw: executive ? 0 : sample(seatId, 'kyaw', -0.035, 0.035),
    mouseSide,
    mouseGap: sample(seatId, 'gap', 0.025, 0.045),
    mouseForward: sample(seatId, 'mz', 0.005, 0.025),
    mouseYaw: sample(seatId, 'myaw', -0.08, 0.08),
    mouseOnPad: [-sample(seatId, 'pad-x', 0.066, 0.075), sample(seatId, 'pad-z', -0.015, 0.025)] as const,
    // The front corners are reserved for the pointer and cup; organizers stay behind them.
    accessories: executive ? [] : [
      pick(seatId, 'slot-a', BACK_LEFT),
      pick(seatId, 'slot-b', BACK_RIGHT),
      null, null,
    ],
    tint: sample(seatId, 'tint', 0, 1),
  });
  cache.set(seatId, layout);
  return layout;
}

/** The leader desk's nominal keyboard spot (ExecutiveWorkstation, desk frame; the leader sits at −Z). */
export const EXECUTIVE_DESK_TOP = 0.8455;
export const EXECUTIVE_KEYBOARD_BASE = [0.25, EXECUTIVE_DESK_TOP + KEYBOARD_HEIGHT / 2, -0.38] as const;
/** Reception hardware uses counter-local coordinates; the shelf top remains .76 m. */
export const RECEPTION_DESK_TOP = 0.76;
export const RECEPTION_KEYBOARD_BASE = [0, RECEPTION_DESK_TOP + 0.015, 0.82] as const;

/** Same rotation as the registry: a child-to-parent yaw about +Y. */
export function rotateXZ(x: number, z: number, yaw: number): XZ {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [x * c + z * s, -x * s + z * c];
}

export interface DeskInputPlacement {
  /** Keyboard group origin (chassis centre) and yaw, in the desk frame. */
  readonly keyboard: XYZ;
  readonly keyboardYaw: number;
  readonly keyboardKind: KeyboardKind;
  /** Centre of the letter block, where typing hands go (keyboard origin height). */
  readonly typing: XYZ;
  /** Mouse pad origin (resting on the desk at `deskTop`), the mouse body centre, and the mouse yaw. */
  readonly pad: XYZ;
  readonly mouse: XYZ;
  readonly mouseYaw: number;
  /** The mouse in the pad's own frame (x, z). */
  readonly mouseOnPad: XZ;
}

/**
 * Where the keyboard and mouse of a desk go, from the desk's nominal keyboard
 * spot (`base`, keyboard origin) and the keyboard's yaw on that desk.
 */
export function deskInputPlacement(base: XYZ, baseYaw: number, deskTop: number, layout: DeskLayout): DeskInputPlacement {
  const { width } = KEYBOARD_DIMENSIONS[layout.keyboardKind];
  // The keyboard model's +X is sitter-right, with the number pad on that side.
  // Shift the full chassis while keeping its letter block centred on the sitter.
  const alpha = layout.keyboardKind === 'full' ? FULL_ALPHA_OFFSET : 0;
  const [ox, oz] = rotateXZ(layout.keyboardOffset[0] - alpha, layout.keyboardOffset[1], baseYaw);
  const keyboard: XYZ = [base[0] + ox, base[1], base[2] + oz];
  const keyboardYaw = baseYaw + layout.keyboardYaw;
  const [ax, az] = rotateXZ(alpha, 0, keyboardYaw);
  const typing: XYZ = [keyboard[0] + ax, keyboard[1], keyboard[2] + az];
  const along = layout.mouseSide * (width / 2 + layout.mouseGap + MOUSE_DIMENSIONS.width / 2);
  const [mx, mz] = rotateXZ(along, layout.mouseForward, keyboardYaw);
  const mouseYaw = keyboardYaw + layout.mouseYaw;
  // The mouse rests on the pad's inner half, toward the keyboard and the sitter, so the
  // pad's inner edge stays clear of the keyboard even with the mouse close beside it.
  const mouseOnPad: XZ = [layout.mouseSide * layout.mouseOnPad[0], layout.mouseOnPad[1]];
  const [px, pz] = rotateXZ(-mouseOnPad[0], -mouseOnPad[1], mouseYaw);
  const mouse: XYZ = [keyboard[0] + mx, deskTop + MOUSE_CENTRE_Y, keyboard[2] + mz];
  return {
    keyboard, keyboardYaw, keyboardKind: layout.keyboardKind, typing,
    mouse, mouseYaw, mouseOnPad,
    pad: [mouse[0] + px, deskTop, mouse[2] + pz],
  };
}

export interface DeskSlot { readonly position: XZ; readonly yaw: number }

/** Accessory slots of a single desk (SingleWorkstation, Touchdown), desk frame; the sitter is at +Z. */
export const SINGLE_DESK_SLOTS: readonly DeskSlot[] = Object.freeze([
  { position: [-0.69, -0.19], yaw: 0 },
  { position: [0.69, -0.2], yaw: -0.08 },
  { position: [-0.42, 0.2], yaw: 0.2 },
  { position: [0.69, 0.17], yaw: -0.35 },
]);

/**
 * Accessory slots of a quadrant pod station (station frame; the sitter faces the
 * column at the origin, the mouse sits toward +X −Z): the two arm ends, the spot
 * left of the keyboard, and the back corner by the column.
 */
export const POD_DESK_SLOTS: readonly DeskSlot[] = Object.freeze([
  { position: [1.27, 0.24], yaw: Math.PI / 4 - 0.5 },
  { position: [0.24, 1.27], yaw: Math.PI / 4 + 0.5 },
  { position: [0.8, 1.3], yaw: Math.PI / 4 + 0.15 },
  { position: [0.38, 0.38], yaw: Math.PI / 4 },
]);
