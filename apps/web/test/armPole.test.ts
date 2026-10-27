import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { createArmPoleSolution, solveArmPole, type ArmPoleSolution } from '../src/office/scene/avatars/armPole';

function expectFk(solution: ArmPoleSolution, upper: number, lower: number) {
  const elbow = new Vector3(0, -upper, 0).applyQuaternion(solution.upper);
  const forearmWorld = new Quaternion().multiplyQuaternions(solution.upper, solution.lower);
  const wrist = new Vector3(0, -lower, 0).applyQuaternion(forearmWorld).add(elbow);
  expect(elbow.distanceTo(solution.elbow)).toBeLessThan(1e-8);
  expect(wrist.distanceTo(solution.wrist)).toBeLessThan(1e-8);
  expect(solution.elbow.length()).toBeCloseTo(upper, 10);
  expect(solution.elbow.distanceTo(solution.wrist)).toBeCloseTo(lower, 10);
  expect(solution.upper.length()).toBeCloseTo(1, 12);
  expect(solution.lower.length()).toBeCloseTo(1, 12);
}

describe('pole-directed desk arm IK', () => {
  it('reaches typing and mouse targets with exact quaternion forward kinematics', () => {
    for (const target of [[0.0055, -0.154, 0.254], [0.12, -0.15, 0.29], [-0.04, -0.2, 0.35], [0, 0.05, 0.3]] as const) {
      const out = createArmPoleSolution();
      expect(solveArmPole(target, 0.28, 0.2, 1, out)).toBe(out);
      expect(out.error).toBeLessThan(1e-12);
      expectFk(out, 0.28, 0.2);
    }
  });

  it('flares the measured seated elbow outward and reduces the steep forearm', () => {
    const shoulder = new Vector3(-0.1105, 1.016, -0.004);
    const target = new Vector3(-0.105, 0.862, 0.25).sub(shoulder);
    const result = solveArmPole(target, 0.28, 0.2, -1, createArmPoleSolution());
    const elbow = result.elbow.clone().add(shoulder);
    expect(elbow.x).toBeLessThan(shoulder.x - 0.1);
    expect(elbow.y).toBeGreaterThan(0.80);
    expect(Math.abs(0.862 - elbow.y)).toBeLessThan(0.07);
    expect(result.error).toBeLessThan(1e-12);
    expectFk(result, 0.28, 0.2);
  });

  it('mirrors elbow positions and complete bone orientations between sides', () => {
    const left = solveArmPole([-0.04, -0.16, 0.3], 0.28, 0.2, -1, createArmPoleSolution());
    const right = solveArmPole([0.04, -0.16, 0.3], 0.28, 0.2, 1, createArmPoleSolution());
    expect(left.elbow.x).toBeCloseTo(-right.elbow.x, 12);
    expect(left.elbow.y).toBeCloseTo(right.elbow.y, 12);
    expect(left.elbow.z).toBeCloseTo(right.elbow.z, 12);
    for (const axis of [new Vector3(0, -1, 0), new Vector3(0, 0, 1)]) {
      const l = axis.clone().applyQuaternion(left.upper).multiply(new Vector3(-1, 1, 1));
      expect(l.distanceTo(axis.clone().applyQuaternion(right.upper))).toBeLessThan(1e-10);
      const lf = axis.clone().applyQuaternion(left.lower).applyQuaternion(left.upper).multiply(new Vector3(-1, 1, 1));
      expect(lf.distanceTo(axis.clone().applyQuaternion(right.lower).applyQuaternion(right.upper))).toBeLessThan(1e-10);
    }
  });

  it('keeps the mouse elbow below the shoulder and laterally inside the hand on both sides', () => {
    for (const side of [-1, 1] as const) {
      const result = solveArmPole([side * 0.24, -0.16, 0.28], 0.30, 0.22, side, createArmPoleSolution());
      expect(result.elbow.y).toBeLessThan(-0.18);
      expect(side * result.elbow.x).toBeGreaterThan(0);
      expect(side * result.elbow.x).toBeLessThan(0.24);
      expect(result.elbow.z).toBeGreaterThan(0);
      expect(result.error).toBeLessThan(1e-12);
      expectFk(result, 0.30, 0.22);
    }
  });

  it('blends continuously and symmetrically from typing to the outward mouse reach', () => {
    let previous = solveArmPole([0, -0.16, 0.28], 0.30, 0.22, 1, createArmPoleSolution());
    for (let i = 1; i <= 300; i++) {
      const x = i * 0.001;
      const right = solveArmPole([x, -0.16, 0.28], 0.30, 0.22, 1, createArmPoleSolution());
      const left = solveArmPole([-x, -0.16, 0.28], 0.30, 0.22, -1, createArmPoleSolution());
      expect(previous.upper.angleTo(right.upper)).toBeLessThan(0.02);
      expect(previous.lower.angleTo(right.lower)).toBeLessThan(0.025);
      expect(left.elbow.x).toBeCloseTo(-right.elbow.x, 12);
      expect(left.elbow.y).toBeCloseTo(right.elbow.y, 12);
      expect(left.elbow.z).toBeCloseTo(right.elbow.z, 12);
      expect(right.error).toBeLessThan(1e-12);
      expectFk(right, 0.30, 0.22);
      expectFk(left, 0.30, 0.22);
      previous = right;
    }
  });

  it('clamps outer and inner reach while preserving both limb lengths', () => {
    for (const lengths of [[0.28, 0.2], [0.2, 0.28], [0.2, 0.2]] as const) {
      for (const target of [[0, 0, 0], [0, -0.001, 0], [0.2, -0.3, 1.4]] as const) {
        const result = solveArmPole(target, lengths[0], lengths[1], 1, createArmPoleSolution());
        expectFk(result, lengths[0], lengths[1]);
        const distance = Math.hypot(...target);
        const reach = Math.max(Math.abs(lengths[0] - lengths[1]), Math.min(lengths[0] + lengths[1], distance));
        expect(result.wrist.length()).toBeCloseTo(reach, 12);
        expect(result.error).toBeCloseTo(Math.abs(distance - reach), 12);
      }
    }
  });

  it('keeps a finite hinge at pole alignment and straight-arm limits', () => {
    for (const target of [[0.035, -0.0175, -0.01], [0.7, -0.35, -0.2], [0, 0.48, 0], [0, -0.48, 0], [0, 0, 0.48]] as const) {
      expectFk(solveArmPole(target, 0.28, 0.2, 1, createArmPoleSolution()), 0.28, 0.2);
    }
  });

  it('keeps the sleeve basis continuous across small typing movements', () => {
    let previous = solveArmPole([0.0055, -0.154, 0.254], 0.28, 0.2, -1, createArmPoleSolution());
    for (let i = 1; i <= 20; i++) {
      const next = solveArmPole([0.0055 + i * 0.0001, -0.154, 0.254], 0.28, 0.2, -1, createArmPoleSolution());
      expect(previous.upper.angleTo(next.upper)).toBeLessThan(0.002);
      expect(previous.lower.angleTo(next.lower)).toBeLessThan(0.002);
      expectFk(next, 0.28, 0.2);
      previous = next;
    }
  });

  it('rejects invalid target or limb data explicitly', () => {
    expect(() => solveArmPole([NaN, 0, 0], 0.28, 0.2, 1, createArmPoleSolution())).toThrow(RangeError);
    expect(() => solveArmPole([0, 0, 0], 0, 0.2, 1, createArmPoleSolution())).toThrow(RangeError);
  });
});
