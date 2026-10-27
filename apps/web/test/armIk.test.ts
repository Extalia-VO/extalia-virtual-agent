import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { armWrist3D, solveArm3D, wristAngle, wristTwistToDown, type Arm3DSolution } from '../src/office/scene/avatars/armIk';
import { deskReachForSeat, deskReachFromProps, seatRootInParent, toChildFrame } from '../src/office/scene/avatars/deskReach';
import { createHandGoals, writeHandGoals } from '../src/office/scene/avatars/handGoals';

const UPPER = 0.33, LOWER = 0.31;
const solution = (): Arm3DSolution => ({ pitch: 0, elbow: 0, abduction: 0, error: 0 });

function wristOf(s: Arm3DSolution) {
  return armWrist3D(s.pitch, s.abduction, s.elbow, UPPER, LOWER, [0, 0, 0]);
}

describe('three-dimensional arm IK', () => {
  it('reaches targets inside the arm length with millimetre accuracy', () => {
    const targets: [number, number, number][] = [
      [0.1, -0.1, 0.4], [-0.2, -0.13, 0.42], [0.22, -0.2, 0.3], [0.05, -0.05, 0.5], [-0.1, 0.1, 0.35], [0.12, 0.05, 0.45],
    ];
    for (const [x, y, z] of targets) {
      const s = solveArm3D(x, y, z, UPPER, LOWER, solution());
      const w = wristOf(s);
      expect(Math.hypot(w[0] - x, w[1] - y, w[2] - z)).toBeLessThan(2e-3);
      expect(s.error).toBeLessThan(2e-3);
    }
  });

  it('clamps unreachable targets to a straight arm pointing at the target', () => {
    const s = solveArm3D(0, -0.2, 1.2, UPPER, LOWER, solution());
    expect(Number.isFinite(s.pitch) && Number.isFinite(s.elbow) && Number.isFinite(s.abduction)).toBe(true);
    expect(s.error).toBeGreaterThan(0.2);
    // Straight (no bend) and aimed at the target: the wrist lies on the target's direction.
    expect(Math.abs(s.elbow)).toBeLessThan(0.05);
    const w = wristOf(s);
    const len = Math.hypot(...w);
    const dot = (w[2] * 1.2 + w[1] * -0.2) / (len * Math.hypot(1.2, 0.2));
    expect(dot).toBeGreaterThan(0.99);
    expect(len).toBeCloseTo(UPPER + LOWER, 1);
  });

  it('bends the elbow down, below the shoulder-to-wrist line, for a forward target', () => {
    const s = solveArm3D(0, -0.15, 0.4, UPPER, LOWER, solution());
    const [ex, ey] = [UPPER * Math.sin(s.abduction) * 1, -UPPER * Math.cos(s.abduction) * Math.cos(s.pitch)];
    const w = wristOf(s);
    const midY = w[1] / 2;
    expect(ey).toBeLessThan(midY);
    expect(Math.abs(ex)).toBeLessThan(0.01);
  });

  it('turns the upper arm sideways toward a lateral target', () => {
    const inward = solveArm3D(0.18, -0.2, 0.35, UPPER, LOWER, solution());
    const outward = solveArm3D(-0.18, -0.2, 0.35, UPPER, LOWER, solution());
    expect(inward.abduction).toBeGreaterThan(0.1);
    expect(outward.abduction).toBeLessThan(-0.1);
  });

  it('aims the fingers at the requested direction', () => {
    const s = solveArm3D(0.05, -0.13, 0.42, UPPER, LOWER, solution());
    const g: [number, number, number] = [0, -1, 0.3];
    const w = wristAngle(g, s.pitch, s.abduction, s.elbow);
    // Forward kinematics of the hand: Rx(pitch) Rz(abduction) Rx(elbow) Rx(wrist) (0, -1, 0).
    const cw = Math.cos(w), sw = Math.sin(w), ce = Math.cos(s.elbow), se = Math.sin(s.elbow);
    const cb = Math.cos(s.abduction), sb = Math.sin(s.abduction), ca = Math.cos(s.pitch), sa = Math.sin(s.pitch);
    let y = -cw, z = -sw;
    [y, z] = [y * ce - z * se, y * se + z * ce];
    const x = -y * sb; y = y * cb;
    [y, z] = [y * ca - z * sa, y * sa + z * ca];
    const hand: [number, number, number] = [x, y, z];
    const dot = hand[0] * g[0] + hand[1] * g[1] + hand[2] * g[2];
    expect(dot / (Math.hypot(...hand) * Math.hypot(...g))).toBeGreaterThan(0.97);
  });

  it('uses both source rest-world FK bases to aim fingers forward with palms down', () => {
    const target: [number, number, number] = [0, -0.14, 1];
    // Source joint hierarchy quaternions from the left and right office-classic
    // hands. Nail normals identify local +Z as the back, so the palm faces −Z.
    const rests = [
      new Quaternion(-0.8676048656, 0.0385220100, 0.4952136977, 0.0232704277),
      new Quaternion(-0.8676099042, -0.0385224938, -0.4952047992, 0.0232702733),
    ];
    for (const [side, restWorld] of [[-1, rests[0]!], [1, rests[1]!] ] as const) {
      const s = solveArm3D(side * 0.05, -0.13, 0.42, UPPER, LOWER, solution());
      const wrist = wristAngle(target, s.pitch, s.abduction, s.elbow);
      const wristDelta = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), wrist);
      const upperWorld = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), s.pitch)
        .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), s.abduction));
      const elbowWorld = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), s.elbow);
      const finalWorld = upperWorld.multiply(elbowWorld).multiply(wristDelta).multiply(restWorld);
      const finger = new Vector3(0, 1, 0).applyQuaternion(finalWorld).normalize();
      const palm = new Vector3(0, 0, -1).applyQuaternion(finalWorld).normalize();
      const twist = wristTwistToDown(finger.x, finger.y, finger.z, palm.x, palm.y, palm.z);
      finalWorld.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), twist));
      finger.set(0, 1, 0).applyQuaternion(finalWorld).normalize();
      palm.set(0, 0, -1).applyQuaternion(finalWorld).normalize();
      const back = new Vector3(0, 0, 1).applyQuaternion(finalWorld).normalize();
      expect(finger.dot(new Vector3(...target).normalize())).toBeGreaterThan(0.9);
      expect(palm.y).toBeLessThan(-0.9);
      expect(back.y).toBeGreaterThan(0.9);
    }
  });
});

describe('desk reach from prop transforms', () => {
  it('expresses a desk-frame point in a rotated seat frame', () => {
    // Seat facing the desk (yaw π): desk +Z (the desk) is the seat's +Z, and the mouse on desk +X is seat −X.
    const p = toChildFrame([0.48, 0.8, 0.18], [0, 0, 0.75], Math.PI);
    expect(p[0]).toBeCloseTo(-0.48, 6);
    expect(p[1]).toBeCloseTo(0.8, 6);
    expect(p[2]).toBeCloseTo(0.57, 6);
  });

  it('moves the seat root toward the desk along the chair facing', () => {
    const root = seatRootInParent([0, 0.95], Math.PI, 0.2);
    expect(root[0]).toBeCloseTo(0, 6);
    expect(root[1]).toBeCloseTo(0.75, 6);
  });

  it('puts the keyboard in front of a single desk seat within arm reach, and the mouse on the mouse-hand side', () => {
    const reach = deskReachForSeat(undefined);
    const [, ky, kz] = reach.keyboard;
    expect(kz).toBeGreaterThan(0.3);
    expect(kz).toBeLessThan(0.7);
    expect(ky).toBeCloseTo(0.827, 3);
    // The mouse sits close beside a real-size keyboard, on the right hand's side (seat −X).
    expect(reach.mouse[0]).toBeLessThan(-0.2);
    expect(reach.mouse[0]).toBeGreaterThan(-0.3);
    expect(reach.mouseHand).toBe(0);
    expect(reach.cup[0]).toBeGreaterThan(0.5);
  });

  it('keeps laptop and monitor desks on the same external keyboard anchor, give or take each desk\'s own arrangement', () => {
    const single = deskReachForSeat('qa.station-1').keyboard[2];
    const laptop = deskReachForSeat('research.laptop-2').keyboard[2];
    expect(Math.abs(laptop - single)).toBeLessThan(0.05);
  });

  it('keeps pod keyboards within reach of the pod seat', () => {
    const reach = deskReachForSeat('engineering.pod-a.seat-ne');
    const distance = Math.hypot(reach.keyboard[0], reach.keyboard[2]);
    expect(distance).toBeGreaterThan(0.3);
    expect(distance).toBeLessThan(0.7);
  });

  it('keeps the typing wrist within a seated forearm-level reach at every desk kind', () => {
    // A seated typist's wrist sits roughly 0.22–0.5 m in front of the hips; beyond that the arms hang straight in the air.
    for (const seat of ['qa.station-1', 'research.laptop-2', 'engineering.pod-a.seat-ne', 'engineering.pod-c.seat-sw', 'executive.leader']) {
      const [x, , z] = deskReachForSeat(seat).typeWrist;
      const distance = Math.hypot(x, z);
      expect(distance, seat).toBeGreaterThan(0.22);
      expect(distance, seat).toBeLessThan(0.5);
    }
  });

  it('derives the hand targets from the given props alone', () => {
    const reach = deskReachFromProps({ keyboard: [0, 0.8, 0.2], mouse: [0.5, 0.79, 0.2], seatRoot: [0, 0.9], seatYaw: Math.PI });
    expect(reach.typeWrist[1]).toBeCloseTo(0.8 + 0.027 + 0.05, 6);
    expect(reach.mouseHand).toBe(0);
  });
});

describe('hand goals per clip', () => {
  const reach = deskReachForSeat(undefined);

  it('drives typing with both hands over the keys and leaves non-desk clips to the offsets', () => {
    const goals = writeHandGoals(createHandGoals(), 'typing', 3, 0.4, reach, 1, 1, 0);
    expect(goals.weight).toEqual([1, 1]);
    expect(goals.target[0][0]).toBeLessThan(0);
    expect(goals.target[1][0]).toBeGreaterThan(0);
    expect(writeHandGoals(createHandGoals(), 'chat-talk', 3, 0.4, reach, 1, 1, 0).weight).toEqual([0, 0]);
    expect(writeHandGoals(createHandGoals(), 'typing', 3, 0.4, reach, 1, 0, 0).weight).toEqual([0, 0]);
  });

  it('shows the mug only while sipping and the phone only while on the phone', () => {
    expect(writeHandGoals(createHandGoals(), 'sip', 1, 0, reach, 1, 1, 0).mug).toBe(1);
    expect(writeHandGoals(createHandGoals(), 'typing', 1, 0, reach, 1, 1, 0).mug).toBe(0);
    expect(writeHandGoals(createHandGoals(), 'phone', 1, 0, reach, 1, 1, 0).phone).toBe(1);
  });
});
