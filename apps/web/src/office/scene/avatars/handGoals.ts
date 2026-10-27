/**
 * Hand goals of a seated desk clip: where each wrist should be, in seat-root
 * metres, and how strongly inverse kinematics (rather than the joint offsets of
 * `activityPose.ts`) drives each arm. Props follow the goals: a mug is lifted
 * while sipping, a phone is held while on the phone. Pure and allocation-free;
 * `HandGoals` objects are reused.
 */
import type { ActivityClip } from './activityPose';
import type { DeskReach, XYZ } from './deskReach';

/** A mutable wrist goal, seat-root metres. */
type Goal = [number, number, number];

/** Clips whose hands follow the desk (everything else keeps the offset pose). */
const IK_CLIPS: ReadonlySet<ActivityClip> = new Set<ActivityClip>(['desk-idle', 'typing', 'mouse', 'read-screen', 'thinking', 'lean-back', 'watch-output', 'sip', 'phone', 'eat', 'console-play']);

/** Legacy seated callers without a movement clip still need real desk contacts. */
export function resolveDeskHandClip(clip: ActivityClip, sit: number, typing: boolean): ActivityClip {
  return clip === 'none' && sit > 0.001 ? typing ? 'typing' : 'desk-idle' : clip;
}

export function usesHandGoals(clip: ActivityClip): boolean {
  return IK_CLIPS.has(clip);
}

export interface HandGoals {
  /** Wrist targets, index 0 (−X, anatomical right facing +Z) and 1 (+X), seat-root metres. */
  readonly target: [Goal, Goal];
  /** IK strength per arm, 0…1. */
  readonly weight: [number, number];
  /** Finger axis and palm normal in the unscaled seat frame, independent of torso lean. */
  readonly direction: [Goal, Goal];
  readonly palm: [Goal, Goal];
  /** Relaxed finger flexion in radians; index/middle/ring/little. */
  readonly curl: [[number, number, number, number], [number, number, number, number]];
  /** Mug (sip) and phone visibility, 0…1. */
  mug: number;
  phone: number;
  /** Which hand holds the mug while sipping. */
  mugHand: 0 | 1;
}

export function createHandGoals(): HandGoals {
  return { target: [[0, 0, 0], [0, 0, 0]], weight: [0, 0], direction: [[0, 0, 1], [0, 0, 1]], palm: [[0, -1, 0], [0, -1, 0]], curl: [[.15, .2, .24, .28], [.15, .2, .24, .28]], mug: 0, phone: 0, mugHand: 1 };
}

/** Where the phone is held: centred on the chest, both wrists either side of it. */
export const PHONE_CENTRE: XYZ = [0, 0.98, 0.2];
const PHONE_HAND_X = 0.075;
/** Wrists either side of the letter block's centre (a real 19 mm-pitch board: home keys about 17 cm apart). */
const TYPING_HALF_SPAN = 0.105;
/** The mouth, for sipping: the cup-holding wrist ends here. */
const MOUTH: XYZ = [0, 1.12, 0.14];

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => { const x = clamp01(value); return x * x * (3 - 2 * x); };
const pulse = (time: number, frequency: number, phase: number) => ((1 + Math.sin(time * frequency + phase)) * 0.5) ** 6;

function set(out: [Goal, Goal], index: 0 | 1, x: number, y: number, z: number) {
  const target = out[index];
  target[0] = x; target[1] = y; target[2] = z;
}

/**
 * Write the goals of `clip` at `time` for a character at `reach`. `gesture` is the
 * character's own gesture amount; `sit` and `walk` come from the movement layer.
 * Clips outside `IK_CLIPS` write zero weights and no props.
 */
export function writeHandGoals(out: HandGoals, clip: ActivityClip, time: number, phase: number, reach: DeskReach, gesture: number, sit: number, walk: number, seatHeight = 0.45): HandGoals {
  const seatLift = seatHeight - 0.45;
  const weight = usesHandGoals(clip) ? clamp01(sit) * (1 - clamp01(walk)) : 0;
  out.weight[0] = weight; out.weight[1] = weight;
  out.mug = clip === 'sip' && weight > 0 ? 1 : 0;
  out.phone = clip === 'phone' && weight > 0 ? 1 : 0;
  const m = reach.mouseHand, other = (1 - m) as 0 | 1;
  const tw = reach.typeWrist;
  const t = out.target;
  const forward = reach.keyboardForward;
  for (const hand of [0, 1] as const) {
    set(out.direction, hand, forward[0], -0.065, forward[2]);
    set(out.palm, hand, 0, -1, 0);
    for (let finger = 0; finger < 4; finger++) out.curl[hand][finger] = 0.18 + finger * 0.035;
  }
  switch (clip) {
    case 'typing': {
      // Both hands on the keys, each finger tap a short dip of the wrist.
      const burst = smooth((Math.sin(time * 1.17 + phase) + 0.35) / 0.8);
      const left = Math.max(0, Math.sin(time * 8.9 + phase)) ** 5 * burst;
      const right = Math.max(0, Math.sin(time * 7.7 + phase + 1.4)) ** 5 * burst;
      set(t, 0, tw[0] - forward[2] * TYPING_HALF_SPAN, tw[1] - 0.003 * left * gesture, tw[2] + forward[0] * TYPING_HALF_SPAN);
      set(t, 1, tw[0] + forward[2] * TYPING_HALF_SPAN, tw[1] - 0.003 * right * gesture, tw[2] - forward[0] * TYPING_HALF_SPAN);
      for (const hand of [0, 1] as const) for (let finger = 0; finger < 4; finger++) {
        const tap = Math.max(0, Math.sin(time * (8.2 + finger * .7) + phase + hand * 1.7 + finger * 2)) ** 8 * burst;
        out.curl[hand][finger] = .22 + finger * .025 + tap * .12 * gesture;
      }
      break;
    }
    case 'mouse': {
      // The mouse hand moves the pointer and flicks the wheel; the other rests on the keyboard edge.
      const cursor = Math.sin(time * 1.55 + phase);
      const scroll = Math.max(0, Math.sin(time * 5.2 + phase)) ** 3 * pulse(time, 0.9, phase + 1);
      const mw = reach.mouseWrist;
      set(t, m, mw[0] + 0.002 * cursor, mw[1], mw[2] + 0.002 * Math.sin(time * 1.1 + phase));
      set(t, other, tw[0] + (other === 1 ? 1 : -1) * forward[2] * TYPING_HALF_SPAN, tw[1], tw[2] - (other === 1 ? 1 : -1) * forward[0] * TYPING_HALF_SPAN);
      set(out.direction, m, reach.mouseForward[0], -.12, reach.mouseForward[2]);
      out.curl[m][0] = .24 + .06 * scroll * gesture;
      out.curl[m][1] = .3; out.curl[m][2] = .44; out.curl[m][3] = .52;
      break;
    }
    case 'read-screen':
    case 'watch-output': {
      // Hands remain over the keys, with a small drift while reading.
      const drift = clip === 'read-screen' ? 0.01 * Math.sin(time * 0.42 + phase) : 0.005 * Math.sin(time * 0.6 + phase);
      set(t, 0, tw[0] - forward[2] * TYPING_HALF_SPAN + drift, tw[1], tw[2] + forward[0] * TYPING_HALF_SPAN);
      set(t, 1, tw[0] + forward[2] * TYPING_HALF_SPAN - drift, tw[1], tw[2] - forward[0] * TYPING_HALF_SPAN);
      break;
    }
    case 'desk-idle': {
      // Quiet hands rest on the chair's arm pads, clear of the keyboard chassis.
      set(t, 0, -.22, .735, .08); set(t, 1, .22, .735, .08);
      break;
    }
    case 'thinking': {
      // The hand that is not on the mouse goes to the chin; the other rests.
      const chin = pulse(time, 0.38, phase);
      const side = other === 1 ? 1 : -1;
      set(t, other, side * (0.055 + 0.005 * chin), 0.99 + 0.005 * chin, 0.17);
      set(t, m, reach.mouseWrist[0], reach.mouseWrist[1], reach.mouseWrist[2]);
      set(out.direction, other, -side * .12, .96, -.25);
      set(out.palm, other, -side, -.15, .1);
      set(out.direction, m, reach.mouseForward[0], -.12, reach.mouseForward[2]);
      for (let finger = 0; finger < 4; finger++) out.curl[other][finger] = .62 + finger * .05;
      break;
    }
    case 'sip': {
      // The cup-holding hand lifts the mug from the desk to the mouth and back; the other rests.
      const grab = reach.cup;
      const holder = (grab[0] > 0 ? 1 : 0) as 0 | 1;
      const lift = smooth(Math.sin(Math.PI * clamp01(((time * 0.18 + phase) % 1) * 1.5)));
      const mouthX = holder === 1 ? 0.04 : -0.04;
      const offsetX = holder === 0 ? .045 : -.045;
      const gx = grab[0] - offsetX, gy = grab[1] - .015 + seatLift, gz = grab[2] - .045;
      set(t, holder, gx + (mouthX - gx) * lift, gy + (MOUTH[1] + seatLift - .11 - gy) * lift, gz + (MOUTH[2] - .045 - gz) * lift);
      set(t, holder === 1 ? 0 : 1, holder === 1 ? -0.22 : 0.22, .735, .08);
      set(out.direction, holder, 0, .8, .6);
      set(out.palm, holder, holder === 1 ? -1 : 1, 0, 0);
      for (let finger = 0; finger < 4; finger++) out.curl[holder][finger] = 1.05;
      out.mugHand = holder;
      break;
    }
    case 'console-play': {
      set(t, 0, -0.095, 0.89 + seatLift, 0.25);
      set(t, 1, 0.095, 0.89 + seatLift, 0.25);
      set(out.direction, 0, .7, -.1, .7); set(out.direction, 1, -.7, -.1, .7);
      for (const hand of [0, 1] as const) for (let finger = 0; finger < 4; finger++) out.curl[hand][finger] = .8 + finger * .05;
      break;
    }
    case 'eat': {
      const bite = smooth(pulse(time, 0.75, phase));
      set(t, 0, -.14, .8 + seatLift, .24);
      set(t, 1, .11 - .05 * bite, .8 + seatLift + .28 * bite, .25 - .1 * bite);
      set(out.direction, 1, 0, .8, .6);
      set(out.palm, 1, -1, 0, 0);
      for (const hand of [0, 1] as const) for (let finger = 0; finger < 4; finger++) out.curl[hand][finger] = .9;
      break;
    }
    case 'phone': {
      // Both hands hold the phone at chest height; the thumb flicks are wrist motion.
      set(t, 0, PHONE_CENTRE[0] - PHONE_HAND_X, PHONE_CENTRE[1], PHONE_CENTRE[2]);
      set(t, 1, PHONE_CENTRE[0] + PHONE_HAND_X, PHONE_CENTRE[1], PHONE_CENTRE[2]);
      set(out.direction, 0, 1, -.1, 0); set(out.direction, 1, -1, -.1, 0);
      for (const hand of [0, 1] as const) for (let finger = 0; finger < 4; finger++) out.curl[hand][finger] = .7;
      break;
    }
    case 'lean-back': {
      // Reclined: hands settle in the lap.
      set(t, 0, -0.14, 0.58, 0.2);
      set(t, 1, 0.14, 0.58, 0.2);
      break;
    }
    default:
      break;
  }
  return out;
}

/** Move the shown goals toward the target by `k` (0…1): hands glide between clips. */
export function blendHandGoals(shown: HandGoals, target: HandGoals, k: number): HandGoals {
  const t = clamp01(k);
  for (const i of [0, 1] as const) {
    const s = shown.target[i], g = target.target[i];
    s[0] += (g[0] - s[0]) * t; s[1] += (g[1] - s[1]) * t; s[2] += (g[2] - s[2]) * t;
    for (const axis of [0, 1, 2] as const) {
      shown.direction[i][axis] += (target.direction[i][axis]! - shown.direction[i][axis]!) * t;
      shown.palm[i][axis] += (target.palm[i][axis]! - shown.palm[i][axis]!) * t;
    }
    for (let finger = 0; finger < 4; finger++) shown.curl[i][finger] = shown.curl[i][finger]! + (target.curl[i][finger]! - shown.curl[i][finger]!) * t;
    shown.weight[i] += (target.weight[i] - shown.weight[i]) * t;
  }
  shown.mug += (target.mug - shown.mug) * t;
  shown.phone += (target.phone - shown.phone) * t;
  if (target.mug > 0.5 || shown.mug > 0.05) shown.mugHand = target.mugHand;
  return shown;
}
