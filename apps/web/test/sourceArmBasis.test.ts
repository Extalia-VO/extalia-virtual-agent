import { describe, expect, it } from 'vitest';
import { Bone, Group, Matrix4, Quaternion, Vector3 } from 'three';
import { createArmPoleSolution, solveArmPole } from '../src/office/scene/avatars/armPole';
import { armWrist3D, solveArm3D } from '../src/office/scene/avatars/armIk';
import { createSourceArmRotations, sourceArmGoalFrame, sourceAvatarScale, sourceLimbBasis, writeSourceArmRotations } from '../src/office/scene/avatars/sourceArmBasis';

describe('source arm rest geometry', () => {
  it('keeps desk goals fixed through separate spine/chest pivots and a scaled, rotated avatar', () => {
    const model = new Group(), hips = new Bone(), spine = new Bone(), chest = new Bone();
    model.add(hips); hips.add(spine); spine.add(chest);
    hips.position.y = 1; spine.position.y = 0.18; chest.position.y = 0.25;
    model.updateMatrixWorld(true);
    const restChestFromHip = new Matrix4().makeTranslation(0, -1, 0).multiply(chest.matrixWorld);
    const armPoint = new Vector3(0.25, 0.4, 0.3);
    const chestLocalPoint = armPoint.clone().applyMatrix4(restChestFromHip.clone().invert());
    hips.position.y = 0.6; spine.rotation.x = 0.2; chest.rotation.x = 0.1;
    model.rotation.y = 1.2; model.scale.set(0.9, 0.95, 1.05); model.position.set(4, 6.4, -3);
    model.updateMatrixWorld(true);
    const currentModelPoint = chestLocalPoint.applyMatrix4(chest.matrixWorld).applyMatrix4(model.matrixWorld.clone().invert());
    const frame = sourceArmGoalFrame(new Matrix4(), restChestFromHip, chest.matrixWorld, model.matrixWorld);
    expect(currentModelPoint.applyMatrix4(frame).distanceTo(armPoint)).toBeLessThan(1e-8);
  });

  it.each([-1, 1])('reaches keyboard and mouse targets with authored limb tilt on side %s', side => {
    const upper = new Vector3(side * 0.09, -0.996, -0.002).normalize().multiplyScalar(0.28);
    const lower = new Vector3(side * 0.085, -0.996, -0.003).normalize().multiplyScalar(0.25);
    const rotations = createSourceArmRotations();
    for (const target of [[side * 0.04, -0.16, 0.36], [side * 0.24, -0.12, 0.38]] as const) {
      const solved = solveArm3D(target[0], target[1], target[2], upper.length(), lower.length(), { pitch: 0, elbow: 0, abduction: 0, error: 0 });
      writeSourceArmRotations(rotations, sourceLimbBasis(upper), sourceLimbBasis(lower), solved.pitch, solved.abduction, solved.elbow, 0.3, 1);
      const forearm = new Quaternion().copy(rotations.upper).multiply(rotations.lower);
      const actual = upper.clone().applyQuaternion(rotations.upper).add(lower.clone().applyQuaternion(forearm));
      const ideal = new Vector3(...armWrist3D(solved.pitch, solved.abduction, solved.elbow, upper.length(), lower.length(), [0, 0, 0]));
      expect(actual.distanceTo(ideal)).toBeLessThan(1e-8);
      expect(actual.distanceTo(new Vector3(...target))).toBeLessThan(0.002);
    }
  });

  it.each([-1, 1] as const)('adapts the outward-pole desk solve without adding rest-basis twist on side %s', side => {
    const upper = new Vector3(side * .09, -.996, -.002).normalize().multiplyScalar(.28);
    const lower = new Vector3(side * .085, -.996, -.003).normalize().multiplyScalar(.20);
    const cu = sourceLimbBasis(upper), cl = sourceLimbBasis(lower);
    const target = [side * .005, -.154, .254] as const;
    const result = solveArmPole(target, upper.length(), lower.length(), side, createArmPoleSolution());
    const u = result.upper.clone().multiply(cu.clone().invert());
    const l = cu.clone().multiply(result.lower).multiply(cl.clone().invert());
    const actual = upper.clone().applyQuaternion(u).add(lower.clone().applyQuaternion(u.clone().multiply(l)));
    expect(actual.distanceTo(new Vector3(...target))).toBeLessThan(1e-8);
    expect(upper.clone().applyQuaternion(u).x * side).toBeGreaterThan(.10);
  });

  it('does not squeeze an already metric source body by the procedural nominal stature a second time', () => {
    const neutral = sourceAvatarScale(1.70, [.755, .755, .755]);
    for (const axis of neutral) expect(axis).toBeCloseTo(1.70 / 1.85, 12);
    const variation = sourceAvatarScale(1.70, [.755 * 1.04, .755, .755 * .98]);
    expect(variation[0] / variation[1]).toBeCloseTo(1.04, 10);
    expect(variation[2] / variation[1]).toBeCloseTo(.98, 10);
  });

  it('keeps the original pose when no IK goal has weight', () => {
    const basis = sourceLimbBasis(new Vector3(0.09, -0.996, -0.002));
    const result = writeSourceArmRotations(createSourceArmRotations(), basis, basis, 0, 0, 0, 0, 0);
    for (const q of [result.upper, result.lower, result.hand]) expect(q.angleTo(new Quaternion())).toBeLessThan(1e-8);
  });
});
