import { describe, expect, it } from 'vitest';
import { Bone, Euler, Group, Matrix3, Matrix4, Quaternion, Vector3, type Object3D } from 'three';
import { createHandOrientationScratch, handPronationAngle, writeHandOrientation } from '../src/office/scene/avatars/handOrientation';
import { createSourceArmRotations, sourceArmGoalFrame, sourceLimbBasis, writeSourceArmRotations } from '../src/office/scene/avatars/sourceArmBasis';
import { solveArm3D } from '../src/office/scene/avatars/armIk';

type XYZ = readonly [number, number, number];
const PALM: XYZ = [0, 0, -1];

function checkAxes(hand: Object3D, root: Object3D, localFinger: XYZ, direction: XYZ, palm: XYZ) {
  root.updateWorldMatrix(true, true);
  const inRoot = root.matrixWorld.clone().invert().multiply(hand.matrixWorld);
  const wantedFinger = new Vector3(...direction).normalize();
  const wantedPalm = new Vector3(...palm).addScaledVector(wantedFinger, -new Vector3(...palm).dot(wantedFinger)).normalize();
  const finger = new Vector3(...localFinger).transformDirection(inRoot);
  const normal = new Vector3(...PALM).applyMatrix3(new Matrix3().getNormalMatrix(inRoot)).normalize();
  expect(finger.length()).toBeCloseTo(1, 10);
  expect(normal.length()).toBeCloseTo(1, 10);
  expect(finger.dot(wantedFinger)).toBeGreaterThan(0.999999);
  expect(normal.dot(wantedPalm)).toBeGreaterThan(0.999999);
  expect(Math.abs(finger.dot(normal))).toBeLessThan(1e-9);
}

describe('hand orientation in the actual posed parent frame', () => {
  it.each([1, -1] as const)('aligns finger/palm axes for local finger Y=%s despite yaw, torso lean and nonuniform body scale', sign => {
    const root = new Group(), body = new Group(), torso = new Group(), forearm = new Group(), hand = new Group();
    root.position.set(4, 6.4, -3); root.rotation.y = 1.14;
    body.scale.set(0.82, 1.06, 0.94); torso.rotation.set(0.28, -0.19, 0.13);
    forearm.rotation.set(-0.7, 0.38, -0.21); forearm.position.set(-0.15, 1.1, 0);
    root.add(body); body.add(torso); torso.add(forearm); forearm.add(hand);
    const scratch = createHandOrientationScratch();
    for (const [direction, palm] of [
      [[0, -0.14, 1], [0, -1, 0]], [[0.15, 0.7, 0.4], [0, 0, -1]], [[-0.4, -0.2, 0.8], [0.3, -1, 0.1]],
    ] as const) {
      root.updateMatrixWorld(true);
      const out = new Quaternion();
      expect(writeHandOrientation(out, { parentWorld: forearm.matrixWorld, rootWorld: root.matrixWorld,
        direction, palm, localFinger: [0, sign, 0] }, scratch)).toBe(true);
      expect(out.length()).toBeCloseTo(1, 10);
      hand.quaternion.copy(out);
      checkAxes(hand, root, [0, sign, 0], direction, palm);
    }
  });

  it('uses the configured authored local palm axis and ignores vector magnitudes', () => {
    const q = new Quaternion(), scratch = createHandOrientationScratch();
    expect(writeHandOrientation(q, { parentWorld: new Matrix4(), rootWorld: new Matrix4(),
      direction: [0, 0, 8], palm: [0, -5, 0], localFinger: [0, 3, 0], localPalm: [2, 0, 0] }, scratch)).toBe(true);
    expect(new Vector3(0, 1, 0).applyQuaternion(q).distanceTo(new Vector3(0, 0, 1))).toBeLessThan(1e-9);
    expect(new Vector3(1, 0, 0).applyQuaternion(q).distanceTo(new Vector3(0, -1, 0))).toBeLessThan(1e-9);
  });

  it('leaves the output unchanged for singular matrices and degenerate direction/palm frames', () => {
    const out = new Quaternion().setFromEuler(new Euler(0.2, 0.3, -0.1)), original = out.clone();
    const valid = { parentWorld: new Matrix4(), rootWorld: new Matrix4(), direction: [0, 0, 1] as XYZ,
      palm: [0, -1, 0] as XYZ, localFinger: [0, 1, 0] as XYZ };
    for (const input of [
      { ...valid, direction: [0, 0, 0] as XYZ }, { ...valid, palm: [0, 0, 2] as XYZ },
      { ...valid, direction: [NaN, 0, 1] as XYZ }, { ...valid, localFinger: [0, 0, 0] as XYZ },
      { ...valid, parentWorld: new Matrix4().makeScale(1, 0, 1) },
    ]) {
      expect(writeHandOrientation(out, input, createHandOrientationScratch())).toBe(false);
      expect(out.toArray()).toEqual(original.toArray());
    }
  });

  it('extracts signed shortest pronation around the real wrist-offset axis', () => {
    const current = new Quaternion().setFromEuler(new Euler(-0.3, 0.2, 0.1));
    for (const angle of [-2.2, -0.6, 0.4, 2.4]) {
      const axis = new Vector3(0.03, 0.25, -0.01).normalize();
      const desired = new Quaternion().setFromAxisAngle(axis, angle).multiply(current);
      expect(handPronationAngle(current, desired, axis, createHandOrientationScratch())).toBeCloseTo(angle, 10);
    }
    expect(handPronationAngle(current, current, new Vector3(), createHandOrientationScratch())).toBe(0);
  });

  it('transfers roll to the forearm without moving the wrist and retains exact final orientation', () => {
    const root = new Group(), body = new Group(), forearm = new Bone(), hand = new Bone();
    root.rotation.y = -0.8; body.scale.set(0.89, 0.92, 0.9);
    forearm.rotation.set(-0.8, 0.3, 0.15); hand.position.set(0.01, 0.26, -0.003);
    root.add(body); body.add(forearm); forearm.add(hand);
    const direction: XYZ = [0, -0.14, 1], palm: XYZ = [0, -1, 0];
    const scratch = createHandOrientationScratch(), desired = new Quaternion();
    root.updateMatrixWorld(true);
    const position = hand.getWorldPosition(new Vector3());
    const input = { parentWorld: forearm.matrixWorld, rootWorld: root.matrixWorld, direction, palm, localFinger: [0, 1, 0] as XYZ };
    expect(writeHandOrientation(desired, input, scratch)).toBe(true);
    const before = handPronationAngle(hand.quaternion, desired, hand.position, scratch);
    const roll = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, before * 0.75));
    forearm.quaternion.multiply(new Quaternion().setFromAxisAngle(hand.position.clone().normalize(), roll));
    root.updateMatrixWorld(true);
    expect(hand.getWorldPosition(new Vector3()).distanceTo(position)).toBeLessThan(1e-10);
    expect(writeHandOrientation(desired, input, scratch)).toBe(true);
    const remaining = handPronationAngle(hand.quaternion, desired, hand.position, scratch);
    expect(Math.abs(remaining)).toBeLessThan(Math.abs(before));
    hand.quaternion.copy(desired);
    checkAxes(hand, root, [0, 1, 0], direction, palm);
  });
});

/** Authored +Y limb chains with two representative metric proportions. */
function skeleton(upperLength: number, lowerLength: number) {
  const scene = new Group(), hips = new Bone(), spine = new Bone(), chest = new Bone();
  hips.name = 'hips'; spine.name = 'spine'; chest.name = 'chest';
  hips.position.y = 1; spine.position.y = .18; chest.position.y = .25;
  scene.add(hips); hips.add(spine); spine.add(chest);
  const nodes: Object3D[] = [scene, hips, spine, chest];
  for (const side of [-1, 1] as const) {
    const name = side < 0 ? 'left' : 'right';
    const upper = new Bone(), lower = new Bone(), hand = new Bone();
    upper.name = `${name}UpperArm`; lower.name = `${name}LowerArm`; hand.name = `${name}Hand`;
    upper.position.set(side * .18, .07, 0);
    upper.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(side * .08, -.996, -.002).normalize());
    lower.position.y = upperLength; lower.rotation.z = side * .02;
    hand.position.y = lowerLength;
    chest.add(upper); upper.add(lower); lower.add(hand); nodes.push(upper, lower, hand);
  }
  scene.updateMatrixWorld(true);
  const bone = (name: string) => {
    const value = nodes.find(object => object.name === name);
    if (!value) throw new Error(`Missing source joint ${name}`);
    return value;
  };
  return { scene, bone, nodes };
}

for (const [upperLength, lowerLength] of [[.28, .22], [.31, .25]] as const) {
  it(`keeps authored +Y source wrists on the desk through pronation (${upperLength}/${lowerLength})`, () => {
    const { scene, bone, nodes } = skeleton(upperLength, lowerLength);
    const position = (name: string) => bone(name).getWorldPosition(new Vector3());
    const hip = position('hips');
    const chestRest = new Matrix4().makeTranslation(-hip.x, -hip.y, -hip.z).multiply(bone('chest').matrixWorld);
    const rest = new Map<Object3D, { local: Quaternion; world: Quaternion }>(nodes.map(object => [object, { local: object.quaternion.clone(), world: object.getWorldQuaternion(new Quaternion()) }]));
    const rotate = (object: Object3D, delta: Quaternion) => {
      const original = rest.get(object)!;
      object.quaternion.copy(original.local).multiply(original.world.clone().invert().multiply(delta).multiply(original.world));
    };
    const arms = ['left', 'right'].map(side => {
      const upper = position(`${side}UpperArm`), lower = position(`${side}LowerArm`), hand = position(`${side}Hand`);
      return { side, shoulder: upper.clone().sub(hip), upper: upper.distanceTo(lower), lower: lower.distanceTo(hand),
        upperBasis: sourceLimbBasis(lower.clone().sub(upper)), lowerBasis: sourceLimbBasis(hand.clone().sub(lower)) };
    });
    const root = new Group(), scaled = new Group();
    root.position.set(3, 6.4, -2); root.rotation.y = 0.87;
    scaled.scale.set(0.89, 0.92, 0.9); root.add(scaled); scaled.add(scene);
    bone('hips').position.y = 0.46 / 0.92 + 0.11;
    rotate(bone('spine'), new Quaternion().setFromEuler(new Euler(0.23, 0.12, -0.04, 'YXZ')));
    rotate(bone('chest'), new Quaternion().setFromEuler(new Euler(0.18, -0.08, 0.03, 'YXZ')));
    root.updateMatrixWorld(true);
    const frame = sourceArmGoalFrame(new Matrix4(), chestRest, bone('chest').matrixWorld, scene.matrixWorld);
    for (const arm of arms) {
      const goal = new Vector3(arm.side === 'left' ? -0.085 : 0.22, 0.86, 0.36);
      const relative = goal.clone().divide(scaled.scale).applyMatrix4(frame).sub(arm.shoulder);
      const solved = solveArm3D(relative.x, relative.y, relative.z, arm.upper, arm.lower, { pitch: 0, elbow: 0, abduction: 0, error: 0 });
      const rotations = writeSourceArmRotations(createSourceArmRotations(), arm.upperBasis, arm.lowerBasis,
        solved.pitch, solved.abduction, solved.elbow, 0, 1);
      rotate(bone(`${arm.side}UpperArm`), rotations.upper); rotate(bone(`${arm.side}LowerArm`), rotations.lower); rotate(bone(`${arm.side}Hand`), rotations.hand);
      root.updateMatrixWorld(true);
      const hand = bone(`${arm.side}Hand`), parent = hand.parent!;
      expect(hand.children).toHaveLength(0);
      const before = hand.getWorldPosition(new Vector3());
      expect(before.clone().applyMatrix4(root.matrixWorld.clone().invert()).distanceTo(goal)).toBeLessThan(0.0002);
      const scratch = createHandOrientationScratch(), desired = new Quaternion();
      const direction: XYZ = [0, -0.14, 1], palm: XYZ = [0, -1, 0];
      const input = { parentWorld: parent.matrixWorld, rootWorld: root.matrixWorld, direction, palm, localFinger: [0, 1, 0] as XYZ };
      expect(writeHandOrientation(desired, input, scratch)).toBe(true);
      const roll = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, handPronationAngle(hand.quaternion, desired, hand.position, scratch) * 0.75));
      parent.quaternion.multiply(new Quaternion().setFromAxisAngle(hand.position.clone().normalize(), roll));
      root.updateMatrixWorld(true);
      expect(hand.getWorldPosition(new Vector3()).distanceTo(before)).toBeLessThan(1e-10);
      expect(writeHandOrientation(desired, input, scratch)).toBe(true);
      hand.quaternion.copy(desired);
      checkAxes(hand, root, [0, 1, 0], direction, palm);
      expect(hand.getWorldPosition(new Vector3()).applyMatrix4(root.matrixWorld.clone().invert()).distanceTo(goal)).toBeLessThan(0.0002);
    }
  });
}
