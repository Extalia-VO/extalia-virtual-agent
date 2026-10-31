import { Bone, BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { applyShoulderCorrectives, shoulderCorrectiveBindings } from '../src/office/scene/avatars/sourceShoulderCorrective';
import { copyFittedMorphTargets } from '../src/office/scene/avatars/sourceSeatedDrape';

function fixture() {
  const root = new Group(), chest = new Bone(), bones = new Map<string, { bone: Bone }>();
  root.add(chest); bones.set('chest', { bone: chest });
  for (const [side, x] of [['left', -.16], ['right', .16]] as const) {
    const upper = new Bone(), elbow = new Bone(); upper.position.set(x, 1.4, 0); elbow.position.set(0, -.3, 0);
    chest.add(upper); upper.add(elbow); bones.set(`${side}UpperArm`, { bone: upper }); bones.set(`${side}LowerArm`, { bone: elbow });
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.morphAttributes.position = Array.from({ length: 5 }, () => new Float32BufferAttribute(new Float32Array(9), 3));
  const mesh = new Mesh(geometry, new MeshStandardMaterial({ name: 'OriginalTop_Shirt' }));
  mesh.morphTargetDictionary = { ExtaliaShoulderLeft_90: 0, ExtaliaShoulderLeft_135: 1, ExtaliaShoulderRight_90: 2, ExtaliaShoulderRight_135: 3, HandCurl: 4 };
  mesh.morphTargetInfluences = [0, 0, 0, 0, .7];
  root.updateMatrixWorld(true);
  return { root, chest, bones, mesh };
}

describe('source shoulder corrective banks', () => {
  it('keeps rest/walking angles zero and interpolates only adjacent authored banks', () => {
    const { mesh, bones } = fixture(), bindings = shoulderCorrectiveBindings([mesh], bones);
    const upper = bones.get('leftUpperArm')!.bone;
    for (const [angle, expected] of [[0, [0, 0]], [25, [0, 0]], [60, [.5, 0]], [112.5, [.5, .5]], [135, [0, 1]], [180, [0, 1]]] as const) {
      upper.rotation.x = angle * Math.PI / 180; applyShoulderCorrectives(bindings);
      expected.forEach((value, index) => expect(mesh.morphTargetInfluences![index]).toBeCloseTo(value, 6));
      expect(mesh.morphTargetInfluences![4]).toBe(.7);
    }
  });

  it('measures each arm independently and cancels posed chest and nonuniform root transforms', () => {
    const { root, chest, mesh, bones } = fixture(), bindings = shoulderCorrectiveBindings([mesh], bones);
    root.position.set(3, -2, 4); root.rotation.set(.2, .7, -.1); root.scale.set(.9, 1.1, 1.05);
    chest.rotation.set(.4, -.2, .3);
    bones.get('leftUpperArm')!.bone.rotation.x = 112.5 * Math.PI / 180;
    bones.get('rightUpperArm')!.bone.rotation.x = 60 * Math.PI / 180;
    applyShoulderCorrectives(bindings);
    [.5, .5, .5, 0].forEach((value, index) => expect(mesh.morphTargetInfluences![index]).toBeCloseTo(value, 6));
    bones.get('leftUpperArm')!.bone.rotation.x = 0; applyShoulderCorrectives(bindings);
    expect(mesh.morphTargetInfluences!.slice(0, 2)).toEqual([0, 0]);
  });

  it('keeps the calibrated walk range zero when an early 30 degree bank is present', () => {
    const { mesh, bones } = fixture();
    mesh.morphTargetDictionary = { ExtaliaShoulderLeft_30: 0, ExtaliaShoulderLeft_60: 1 };
    const bindings = shoulderCorrectiveBindings([mesh], bones), upper = bones.get('leftUpperArm')!.bone;
    for (const [angle, expected] of [[17, [0, 0]], [20, [0, 0]], [25, [.5, 0]], [30, [1, 0]], [45, [.5, .5]]] as const) {
      upper.rotation.x = angle * Math.PI / 180; applyShoulderCorrectives(bindings);
      expected.forEach((value, index) => expect(mesh.morphTargetInfluences![index]).toBeCloseTo(value, 6));
    }
  });

  it('ignores body, malformed or aliased targets and leaves shared geometry untouched', () => {
    const { mesh, bones } = fixture(), positions = mesh.geometry.getAttribute('position').array.slice();
    (mesh.material as MeshStandardMaterial).name = 'Skin_Body';
    expect(shoulderCorrectiveBindings([mesh], bones)).toEqual([]);
    (mesh.material as MeshStandardMaterial).name = 'OriginalTop_Shirt';
    mesh.morphTargetDictionary = { ExtaliaShoulderLeft_90: 0, ExtaliaShoulderRight_90: 0, ExtaliaShoulderLeft_200: 1, ExtaliaShoulderLeft_60: 99 };
    expect(shoulderCorrectiveBindings([mesh], bones)).toEqual([]);
    expect(mesh.geometry.getAttribute('position').array).toEqual(positions);
  });

  it('keeps copied instance influences separate and resets safely when the rig is singular', () => {
    const { mesh, bones, root } = fixture(), clone = new Mesh(mesh.geometry, mesh.material);
    copyFittedMorphTargets(mesh, clone);
    const bindings = shoulderCorrectiveBindings([clone], bones);
    bones.get('leftUpperArm')!.bone.rotation.x = Math.PI / 2; applyShoulderCorrectives(bindings);
    expect(clone.morphTargetInfluences![0]).toBeCloseTo(1, 6); expect(mesh.morphTargetInfluences![0]).toBe(0);
    root.scale.set(0, 0, 0); applyShoulderCorrectives(bindings);
    expect(clone.morphTargetInfluences!.slice(0, 4)).toEqual([0, 0, 0, 0]);
  });
});
