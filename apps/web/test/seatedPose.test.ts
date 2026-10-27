import { describe, expect, it } from 'vitest';
import { createSeatedLegPose, floorSeatedKnee, seatedLegPose, supportedThigh } from '../src/office/scene/avatars/seatedPose';

describe('cushion contact and seated legs', () => {
  it.each([0.43, 0.46, 0.565, 0.76])('keeps thighs supported on a %.3fm seat across limb sizes and leisure offsets', height => {
    for (const scale of [0.78, 0.92, 1.05]) {
      const front = 0.235, radius = 0.08 * scale;
      const pose = seatedLegPose(height, front, 0.092 * scale, 0.4511 * scale,
        0.468 * scale, 0.0689 * scale, radius, createSeatedLegPose());
      for (const offset of [0, 0.06, 0.12]) {
        const pitch = supportedThigh(pose.thigh + offset, pose, 1);
        const yAtFront = pose.hip + Math.cos(pitch) / Math.sin(pitch) * front;
        expect(yAtFront - radius).toBeGreaterThanOrEqual(height - 0.008 - 1e-8);
        const knee = floorSeatedKnee(pitch, pose.knee - 0.18 + pose.thigh + offset - pitch,
          pose.hip, 0.4511 * scale, 0.468 * scale, 0.0689 * scale, 1);
        const ankleY = pose.hip - Math.cos(pitch) * 0.4511 * scale - Math.cos(pitch + knee) * 0.468 * scale;
        expect(ankleY).toBeGreaterThanOrEqual(0.0689 * scale - 1e-8);
      }
      expect(pose.kneeZ - radius).toBeGreaterThan(front);
      expect(pose.ankleY).toBeGreaterThanOrEqual(0.0689 * scale - 1e-8);
    }
  });

  it('plants feet where the cushion and leg length permit, otherwise keeps short legs above the floor', () => {
    const adult = seatedLegPose(0.43, 0.235, 0.09, 0.415, 0.43, 0.063, 0.073, createSeatedLegPose());
    expect(adult.ankleY).toBeCloseTo(0.063, 8);
    const short = seatedLegPose(0.46, 0.235, 0.075, 0.32, 0.35, 0.05, 0.062, createSeatedLegPose());
    expect(short.ankleY).toBeGreaterThan(0.05);
    expect(short.kneeZ - 0.062).toBeGreaterThan(0.235);
  });

  it('uses the actual seat height and leaves standing gait angles intact', () => {
    const one = seatedLegPose(0.43, 0.225, 0.09, 0.41, 0.43, 0.06, 0.073, createSeatedLegPose());
    const two = seatedLegPose(0.56, 0.225, 0.09, 0.41, 0.43, 0.06, 0.073, createSeatedLegPose());
    expect(two.hip - one.hip).toBeCloseTo(0.13, 8);
    expect(supportedThigh(-0.4, two, 0)).toBe(-0.4);
  });

  it('supports a shoe sole below the source origin without moving the seated hip', () => {
    const ankleRest = .06, soleRest = -.075, clearance = ankleRest - soleRest;
    const pose = seatedLegPose(.46, .22, .095, .42, .43, clearance, .07, createSeatedLegPose());
    expect(pose.hip).toBeCloseTo(.555, 9);
    for (const offset of [0, -.12, .08]) {
      const pitch = supportedThigh(pose.thigh + offset, pose, 1);
      const knee = floorSeatedKnee(pitch, -pitch - .15, pose.hip, .42, .43, clearance, 1);
      const ankle = pose.hip - Math.cos(pitch) * .42 - Math.cos(pitch + knee) * .43;
      expect(ankle - clearance).toBeGreaterThanOrEqual(-1e-8);
    }
  });
});
