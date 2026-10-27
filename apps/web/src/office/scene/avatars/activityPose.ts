/**
 * Procedural activity poses for the office characters: seated desk work
 * (typing, mouse scrolling, reading, thinking, watching output), idle desk
 * moments and the leisure activities of an idle character (lounge, TV, bar,
 * fitness, games, chatting). A pose is a set of joint offsets over the
 * renderer's own base pose (seated hands-on-desk, or standing), so the same
 * clip drives the procedural humanoid and the local GLB rigs. Pure and
 * allocation-free: `writeActivityPose` fills an existing object.
 *
 * Clips are chosen by the movement layer from reported activity only
 * (`workClip`); a pose never implies work that is not happening.
 */

export type ActivityClip =
  | 'none'
  // Seated at a desk.
  | 'desk-idle' | 'typing' | 'mouse' | 'read-screen' | 'thinking' | 'lean-back' | 'watch-output' | 'stretch' | 'sip' | 'phone'
  // Seated elsewhere.
  | 'lounge' | 'watch-tv' | 'cycle' | 'bench-curl' | 'cable-row' | 'eat' | 'console-play'
  // Standing.
  | 'chat-talk' | 'chat-listen' | 'jog' | 'lift' | 'yoga' | 'arcade' | 'foosball' | 'look-around' | 'bar-prep' | 'bar-shake' | 'bar-serve';

const SEATED_CLIPS: ReadonlySet<ActivityClip> = new Set<ActivityClip>([
  'desk-idle', 'typing', 'mouse', 'read-screen', 'thinking', 'lean-back', 'watch-output', 'stretch', 'sip', 'phone', 'lounge', 'watch-tv', 'cycle', 'bench-curl', 'cable-row', 'eat', 'console-play',
]);

/** Seated clips blend in with the sit amount; standing clips while standing still. */
export function isSeatedClip(clip: ActivityClip): boolean {
  return SEATED_CLIPS.has(clip);
}

/** Joint offsets (radians, metres). Index 0 is the renderer's left limb, 1 its right (dominant) limb. */
export interface ActivityPose {
  /** Positive leans the torso forward. */
  torsoPitch: number;
  torsoYaw: number;
  /** Positive looks down. */
  headPitch: number;
  headYaw: number;
  /** Upper-arm pitch; negative raises the arm forward. */
  arm: [number, number];
  /** Upper-arm abduction; positive moves the arm away from the body. */
  armOut: [number, number];
  /** Elbow; negative flexes the forearm further forward/up. */
  elbow: [number, number];
  /** Hand pitch. */
  wrist: [number, number];
  /** Thigh pitch; negative lifts the knee forward. */
  thigh: [number, number];
  /** Knee; positive flexes. */
  knee: [number, number];
  /** Vertical body offset. */
  bob: number;
}

export function createActivityPose(): ActivityPose {
  return { torsoPitch: 0, torsoYaw: 0, headPitch: 0, headYaw: 0, arm: [0, 0], armOut: [0, 0], elbow: [0, 0], wrist: [0, 0], thigh: [0, 0], knee: [0, 0], bob: 0 };
}

function reset(out: ActivityPose): ActivityPose {
  out.torsoPitch = 0; out.torsoYaw = 0; out.headPitch = 0; out.headYaw = 0; out.bob = 0;
  out.arm[0] = 0; out.arm[1] = 0; out.armOut[0] = 0; out.armOut[1] = 0; out.elbow[0] = 0; out.elbow[1] = 0;
  out.wrist[0] = 0; out.wrist[1] = 0; out.thigh[0] = 0; out.thigh[1] = 0; out.knee[0] = 0; out.knee[1] = 0;
  return out;
}

/** A smooth gesture envelope with a quiet interval between beats (0…1). */
const pulse = (time: number, frequency: number, phase: number) => ((1 + Math.sin(time * frequency + phase)) * 0.5) ** 6;
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => { const x = clamp01(value); return x * x * (3 - 2 * x); };

/** Hands resting near the keyboard edge instead of on the keys. */
function restHands(out: ActivityPose, amount = 1) {
  out.arm[0] = 0.1 * amount; out.arm[1] = 0.1 * amount;
  out.elbow[0] = 0.22 * amount; out.elbow[1] = 0.22 * amount;
}

/**
 * Pose of `clip` at `time` seconds. `phase` (radians) and `expression` (≈0.8–1.2)
 * come from the character's rig personality, so two characters never move in lockstep.
 */
export function writeActivityPose(out: ActivityPose, clip: ActivityClip, time: number, phase = 0, expression = 1): ActivityPose {
  reset(out);
  const breath = Math.sin(time * 1.3 + phase);
  const gaze = Math.sin(time * 0.43 + phase) * Math.sin(time * 0.19 + phase * 0.7);
  switch (clip) {
    case 'none':
      return out;
    case 'desk-idle': {
      restHands(out);
      out.torsoPitch = -0.02 + breath * 0.006;
      out.headYaw = gaze * 0.12;
      out.headPitch = 0.03 + gaze * 0.02;
      out.wrist[1] = 0.04 * Math.sin(time * 0.6 + phase);
      return out;
    }
    case 'typing': {
      // Bursts of keystrokes with short pauses; each hand taps on its own rhythm.
      const burst = smooth((Math.sin(time * 1.17 + phase) + 0.35) / 0.8);
      const left = Math.max(0, Math.sin(time * 8.9 + phase)) ** 5 * burst;
      const right = Math.max(0, Math.sin(time * 7.7 + phase + 1.4)) ** 5 * burst;
      out.torsoPitch = 0.07 + breath * 0.008;
      out.torsoYaw = Math.sin(time * 0.72 + phase) * 0.015;
      out.headPitch = 0.1 + (1 - burst) * 0.04;
      out.headYaw = gaze * 0.03;
      out.arm[0] = -0.04 + left * 0.03; out.arm[1] = -0.04 + right * 0.03;
      out.elbow[0] = -0.06 - left * 0.07; out.elbow[1] = -0.06 - right * 0.07;
      out.armOut[0] = -0.04 + 0.02 * Math.sin(time * 2.4 + phase); out.armOut[1] = -0.04 + 0.02 * Math.sin(time * 2.1 + phase + 1);
      out.wrist[0] = expression * (0.03 * Math.sin(time * 12.1 + phase) + 0.025 * left);
      out.wrist[1] = expression * (0.03 * Math.sin(time * 10.7 + phase + 2) + 0.025 * right);
      return out;
    }
    case 'mouse': {
      // Dominant hand moves the mouse and flicks the wheel; the other rests.
      const cursor = Math.sin(time * 1.55 + phase);
      const scroll = Math.max(0, Math.sin(time * 5.2 + phase)) ** 3 * pulse(time, 0.9, phase + 1);
      out.torsoPitch = 0.06 + breath * 0.007;
      out.torsoYaw = cursor * 0.025;
      out.headPitch = 0.08 + Math.abs(cursor) * 0.02;
      out.headYaw = cursor * 0.06 + gaze * 0.02;
      out.arm[0] = 0.08; out.elbow[0] = 0.2;
      out.arm[1] = -0.05 + cursor * 0.05; out.armOut[1] = 0.12 + cursor * 0.06; out.elbow[1] = -0.04;
      out.wrist[1] = 0.015 * scroll + 0.008 * cursor;
      return out;
    }
    case 'read-screen': {
      // Leaning in, eyes sweeping along lines, hands off the keys.
      restHands(out, 0.8);
      const line = (time * 0.42 + phase) % 1;
      out.torsoPitch = 0.1 + breath * 0.008;
      out.headPitch = 0.05 + 0.03 * line;
      out.headYaw = -0.08 + 0.16 * smooth(line * 1.25) + gaze * 0.01;
      out.wrist[1] = 0.02 * Math.sin(time * 0.7 + phase);
      return out;
    }
    case 'thinking': {
      // Hand to the chin, gaze drifting away from the screen.
      const chin = pulse(time, 0.38, phase);
      const away = Math.sin(time * 0.31 + phase);
      out.torsoPitch = -0.03 + breath * 0.008;
      out.torsoYaw = away * 0.03;
      out.headPitch = -0.08 + chin * 0.05;
      out.headYaw = 0.1 * away + gaze * 0.05;
      out.arm[0] = 0.12; out.elbow[0] = 0.25;
      out.arm[1] = -0.42 - chin * 0.06; out.armOut[1] = -0.22; out.elbow[1] = -1.3 - chin * 0.1;
      out.wrist[1] = -0.25 - chin * 0.05;
      return out;
    }
    case 'lean-back': {
      // Reclined against the chair back, hands in the lap.
      out.torsoPitch = -0.17 + breath * 0.008;
      out.headPitch = -0.08 + gaze * 0.02;
      out.headYaw = gaze * 0.08;
      out.arm[0] = 0.32; out.arm[1] = 0.32; out.elbow[0] = 0.62; out.elbow[1] = 0.62;
      out.armOut[0] = 0.04; out.armOut[1] = 0.04;
      out.thigh[0] = 0.08; out.thigh[1] = 0.1; out.knee[0] = -0.12; out.knee[1] = -0.16;
      return out;
    }
    case 'watch-output': {
      // A command or test is running: lean in, still hands, eyes on the output.
      const nod = pulse(time, 0.7, phase);
      out.torsoPitch = 0.12 + breath * 0.006;
      out.headPitch = 0.04 + nod * 0.05;
      out.headYaw = gaze * 0.03;
      out.arm[0] = 0.04; out.arm[1] = 0.02; out.elbow[0] = 0.12; out.elbow[1] = 0.05;
      return out;
    }
    case 'stretch': {
      // A short seated stretch, arms up and back down.
      const reach = Math.sin(Math.PI * clamp01(((time * 0.21 + phase) % 1) * 1.6));
      out.torsoPitch = -0.1 * reach;
      out.headPitch = -0.16 * reach;
      out.arm[0] = -2.3 * reach; out.arm[1] = -2.3 * reach;
      out.elbow[0] = 0.85 * reach; out.elbow[1] = 0.85 * reach;
      out.armOut[0] = 0.12 * reach; out.armOut[1] = 0.12 * reach;
      return out;
    }
    case 'sip': {
      // Coffee from the desk: dominant hand to the mouth and back.
      const lift = Math.sin(Math.PI * clamp01(((time * 0.18 + phase) % 1) * 1.5));
      restHands(out);
      out.arm[1] = 0.1 - 0.45 * lift; out.elbow[1] = 0.22 - 1.55 * lift; out.armOut[1] = 0.05 + 0.1 * lift;
      out.wrist[1] = -0.2 * lift;
      out.headPitch = -0.08 * lift;
      out.torsoPitch = -0.04;
      return out;
    }
    case 'eat': {
      const bite = pulse(time, 0.75, phase);
      out.torsoPitch = 0.04; out.headPitch = 0.06 + bite * 0.03;
      out.arm[0] = -0.25; out.elbow[0] = -1.05;
      out.arm[1] = -0.35 - bite * 0.1; out.elbow[1] = -1.1 - bite * 0.4;
      return out;
    }
    case 'console-play': {
      const tap = Math.sin(time * 7.4 + phase);
      out.torsoPitch = 0.05 + breath * 0.008; out.headPitch = -0.025;
      out.arm[0] = -0.3; out.arm[1] = -0.3;
      out.elbow[0] = -1.12; out.elbow[1] = -1.12;
      out.wrist[0] = tap * 0.025; out.wrist[1] = -tap * 0.025;
      return out;
    }
    case 'bar-prep':
    case 'bar-shake':
    case 'bar-serve': {
      const shake = clip === 'bar-shake' ? Math.sin(time * 10 + phase) : Math.sin(time * 2.2 + phase) * 0.2;
      out.torsoPitch = clip === 'bar-serve' ? 0.12 : 0.04;
      out.arm[0] = -0.7 + shake * 0.12; out.arm[1] = -0.7 - shake * 0.12;
      out.elbow[0] = -0.8 + shake * 0.1; out.elbow[1] = -0.8 - shake * 0.1;
      out.headPitch = clip === 'bar-serve' ? 0 : 0.16;
      return out;
    }
    case 'phone': {
      // Seated, phone held at chest height in both hands, head tipped down to the screen.
      const flick = pulse(time, 0.9, phase);
      restHands(out, 0.4);
      out.torsoPitch = 0.12 + breath * 0.006;
      out.headPitch = 0.42 + 0.03 * Math.sin(time * 0.5 + phase);
      out.headYaw = gaze * 0.05;
      out.arm[0] = -0.5; out.arm[1] = -0.5; out.elbow[0] = -1.35; out.elbow[1] = -1.35;
      out.armOut[0] = 0.12; out.armOut[1] = 0.12;
      out.wrist[1] = -0.2 + 0.1 * flick;
      return out;
    }
    case 'lounge':
    case 'watch-tv': {
      const laugh = clip === 'watch-tv' ? Math.abs(Math.sin(time * 7.5 + phase)) * pulse(time, 0.3, phase) : 0;
      out.torsoPitch = -0.16 - laugh * 0.05 + breath * 0.008;
      out.headPitch = (clip === 'watch-tv' ? -0.02 : -0.05) - laugh * 0.08;
      out.headYaw = clip === 'watch-tv' ? gaze * 0.03 : gaze * 0.14;
      out.bob = laugh * 0.01;
      out.arm[0] = 0.34; out.arm[1] = 0.3 - laugh * 0.1; out.elbow[0] = 0.62; out.elbow[1] = 0.55 - laugh * 0.3;
      out.armOut[0] = 0.1; out.armOut[1] = 0.1;
      out.thigh[0] = 0.12; out.thigh[1] = 0.06; out.knee[0] = -0.18; out.knee[1] = -0.08;
      return out;
    }
    case 'cycle': {
      const pedal = Math.sin(time * 3.4 + phase);
      out.torsoPitch = 0.16 + breath * 0.008;
      out.arm[0] = -0.2; out.arm[1] = -0.2; out.elbow[0] = 0.3; out.elbow[1] = 0.3;
      out.thigh[0] = 0.18 * pedal; out.thigh[1] = -0.18 * pedal;
      out.knee[0] = 0.25 * Math.max(0, pedal); out.knee[1] = 0.25 * Math.max(0, -pedal);
      return out;
    }
    case 'chat-talk': {
      // Open-palm conversational hands, alternating, with small torso turns.
      const left = pulse(time, 1.15, phase), right = pulse(time, 1.15, phase + Math.PI);
      out.torsoYaw = 0.05 * (right - left);
      out.headYaw = 0.06 * Math.sin(time * 0.7 + phase);
      out.headPitch = -0.02 + 0.04 * pulse(time, 2.1, phase);
      out.arm[0] = -0.28 - 0.42 * left * expression; out.arm[1] = -0.28 - 0.42 * right * expression;
      out.elbow[0] = -0.75 - 0.25 * left; out.elbow[1] = -0.75 - 0.25 * right;
      out.armOut[0] = 0.04 + 0.14 * left; out.armOut[1] = 0.04 + 0.14 * right;
      out.wrist[0] = -0.15 * left; out.wrist[1] = -0.15 * right;
      return out;
    }
    case 'chat-listen': {
      // Hands loosely clasped, an attentive nod now and then.
      const nod = pulse(time, 0.7, phase);
      out.torsoPitch = 0.02;
      out.headPitch = 0.04 + nod * 0.12;
      out.headYaw = gaze * 0.04;
      out.arm[0] = -0.26; out.arm[1] = -0.26; out.elbow[0] = -0.62; out.elbow[1] = -0.62;
      out.armOut[0] = -0.2; out.armOut[1] = -0.2;
      return out;
    }
    case 'jog': {
      const stride = Math.sin(time * 8.4 + phase);
      out.bob = 0.025 * stride * stride;
      out.torsoPitch = 0.07;
      out.arm[0] = 0.4 * stride; out.arm[1] = -0.4 * stride;
      out.elbow[0] = -1.1; out.elbow[1] = -1.1;
      out.thigh[0] = -0.45 * stride; out.thigh[1] = 0.45 * stride;
      out.knee[0] = 0.75 * Math.max(0, stride) ** 2; out.knee[1] = 0.75 * Math.max(0, -stride) ** 2;
      return out;
    }
    case 'bench-curl':
    case 'lift': {
      const curl = 0.5 + 0.5 * Math.sin(time * 1.65 + phase);
      out.torsoPitch = 0.02 + breath * 0.006;
      out.arm[0] = -0.12 - 0.2 * curl; out.arm[1] = -0.12 - 0.2 * curl;
      out.elbow[0] = -0.2 - 1.7 * curl; out.elbow[1] = -0.2 - 1.7 * curl;
      out.armOut[0] = 0.08; out.armOut[1] = 0.08;
      return out;
    }
    case 'cable-row': {
      const pull = (1 - Math.cos(time * 2.4)) / 2;
      out.torsoPitch = 0.08 + (1 - pull) * 0.08;
      out.headPitch = 0.03;
      return out;
    }
    case 'yoga': {
      const sway = Math.sin(time * 0.62 + phase);
      out.torsoYaw = 0.12 * sway;
      out.torsoPitch = -0.04;
      out.headPitch = -0.08;
      out.arm[0] = -2.55 + 0.08 * sway; out.arm[1] = -2.55 - 0.08 * sway;
      out.armOut[0] = 0.25; out.armOut[1] = 0.25; out.elbow[0] = 0.06; out.elbow[1] = 0.06;
      return out;
    }
    case 'arcade': {
      const tap = Math.sin(time * 6.2 + phase);
      out.torsoPitch = 0.05 + breath * 0.006;
      out.headPitch = 0.02 + 0.02 * tap;
      out.headYaw = gaze * 0.04;
      out.arm[0] = -0.85 + 0.05 * tap; out.arm[1] = -0.8 - 0.05 * tap;
      out.elbow[0] = -0.75 - 0.05 * tap; out.elbow[1] = -0.7 + 0.05 * tap;
      out.wrist[0] = 0.08 * tap; out.wrist[1] = 0.1 * Math.sin(time * 4.7 + phase);
      return out;
    }
    case 'foosball': {
      const reach = Math.sin(time * 2.8 + phase);
      out.torsoPitch = 0.14 + Math.abs(reach) * 0.04;
      out.torsoYaw = 0.07 * reach;
      out.headYaw = 0.07 * reach;
      out.arm[0] = -0.75 - Math.max(0, reach) * 0.18; out.arm[1] = -0.75 - Math.max(0, -reach) * 0.18;
      out.elbow[0] = -0.5; out.elbow[1] = -0.5;
      out.wrist[0] = 0.12 * reach; out.wrist[1] = -0.12 * reach;
      return out;
    }
    case 'look-around': {
      out.headYaw = 0.42 * Math.sin(time * 0.35 + phase);
      out.headPitch = -0.04 + 0.03 * Math.sin(time * 0.9 + phase);
      out.torsoYaw = 0.08 * Math.sin(time * 0.35 + phase - 0.4);
      out.arm[0] = 0.05; out.arm[1] = 0.05; out.armOut[0] = 0.06; out.armOut[1] = 0.06;
      return out;
    }
  }
}

/** Move `current` toward `target` by `k` (0…1): smooth hand-offs between clips. */
export function blendActivityPose(current: ActivityPose, target: ActivityPose, k: number): ActivityPose {
  const t = clamp01(k);
  current.torsoPitch += (target.torsoPitch - current.torsoPitch) * t;
  current.torsoYaw += (target.torsoYaw - current.torsoYaw) * t;
  current.headPitch += (target.headPitch - current.headPitch) * t;
  current.headYaw += (target.headYaw - current.headYaw) * t;
  current.bob += (target.bob - current.bob) * t;
  for (let side = 0; side < 2; side++) {
    current.arm[side]! += (target.arm[side]! - current.arm[side]!) * t;
    current.armOut[side]! += (target.armOut[side]! - current.armOut[side]!) * t;
    current.elbow[side]! += (target.elbow[side]! - current.elbow[side]!) * t;
    current.wrist[side]! += (target.wrist[side]! - current.wrist[side]!) * t;
    current.thigh[side]! += (target.thigh[side]! - current.thigh[side]!) * t;
    current.knee[side]! += (target.knee[side]! - current.knee[side]!) * t;
  }
  return current;
}

/** Scale every offset by `amount` in place (fades a clip with the sit or walk blend). */
export function scaleActivityPose(pose: ActivityPose, amount: number): ActivityPose {
  const a = clamp01(amount);
  if (a === 1) return pose;
  pose.torsoPitch *= a; pose.torsoYaw *= a; pose.headPitch *= a; pose.headYaw *= a; pose.bob *= a;
  for (let side = 0; side < 2; side++) {
    pose.arm[side]! *= a; pose.armOut[side]! *= a; pose.elbow[side]! *= a; pose.wrist[side]! *= a; pose.thigh[side]! *= a; pose.knee[side]! *= a;
  }
  return pose;
}

/** Live clip state shared by the movement layer and both renderers. */
export interface ClipDriver {
  /** Smoothed pose currently shown. */
  readonly shown: ActivityPose;
  readonly target: ActivityPose;
}

export function createClipDriver(): ClipDriver {
  return { shown: createActivityPose(), target: createActivityPose() };
}

/**
 * Advance a renderer's clip pose by `delta` seconds and return the offsets to
 * apply, already weighted by how seated (seated clips) or how still and
 * standing (standing clips) the character is right now.
 */
export function stepClipDriver(driver: ClipDriver, clip: ActivityClip, time: number, delta: number, sit: number, walk: number, phase: number, expression: number): ActivityPose {
  writeActivityPose(driver.target, clip, time, phase, expression);
  const weight = clip === 'none' ? 0 : isSeatedClip(clip) ? sit : (1 - sit) * (1 - walk);
  scaleActivityPose(driver.target, weight);
  return blendActivityPose(driver.shown, driver.target, 1 - Math.exp(-Math.max(0, delta) * 5));
}
