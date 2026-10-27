import { describe, expect, it } from 'vitest';
import { Bone, BufferGeometry, Float32BufferAttribute, Matrix4, MeshStandardMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three';
import { attachSourceHandCurl, isCanonicalSourceHandAsset, sourceHandCurlGeometry, sourceHandCurlInfluence, sourceHandCurlLengths } from '../src/office/scene/avatars/sourceHandCurl';

function handGeometry(relative = true) {
  const geometry = new BufferGeometry();
  // Wrist, palm, thumb and three distal-finger vertices in calibrated left-hand space.
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0, .09, 0, -.05, .14, -.05, -.01, .2, 0, .02, .18, 0, 0, .15, .01], 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(Array.from({ length: 6 }, () => [0, 1, 0, 0]).flat(), 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(Array.from({ length: 6 }, () => [1, 0, 0, 0]).flat(), 4));
  geometry.setIndex([0, 1, 2, 1, 3, 2, 1, 4, 3, 1, 5, 4]);
  geometry.computeVertexNormals();
  geometry.morphTargetsRelative = relative;
  return geometry;
}
const bindings = [{ side: 0 as const, joint: 0, handFromMesh: new Matrix4() }, { side: 1 as const, joint: 1, handFromMesh: new Matrix4() }];

describe('canonical terminal-hand relaxed curl', () => {
  it.each([true, false])('preserves original/wrist/palm/thumb while curling distal fingers toward the palm (relative=%s)', relative => {
    const source = handGeometry(relative), original = Array.from(source.getAttribute('position').array);
    const normal = Array.from(source.getAttribute('normal').array);
    const result = sourceHandCurlGeometry(source, bindings)!;
    try {
      expect(result.geometry).not.toBe(source);
      expect(source.morphAttributes.position).toBeUndefined();
      expect(Array.from(source.getAttribute('position').array)).toEqual(original);
      expect(Array.from(source.getAttribute('normal').array)).toEqual(normal);
      const target = result.geometry.morphAttributes.position![result.targets[0]]!;
      const base = source.getAttribute('position');
      const value = (index: number, axis: number) => target.getComponent(index, axis) + (relative ? base.getComponent(index, axis) : 0);
      for (const index of [0, 1, 2]) for (const axis of [0, 1, 2]) expect(value(index, axis)).toBeCloseTo(base.getComponent(index, axis), 7);
      expect(value(3, 2)).toBeLessThan(base.getZ(3) - .04);
      expect(value(3, 1)).toBeLessThan(base.getY(3));
      for (const attribute of result.geometry.morphAttributes.normal!) expect(Array.from(attribute.array).every(Number.isFinite)).toBe(true);
      expect(sourceHandCurlGeometry(source, bindings)!.geometry).toBe(result.geometry);
      expect(sourceHandCurlInfluence([0, 0, 0, 0], 1)).toBe(0);
      expect(sourceHandCurlInfluence([.75, .75, .75, .75], 0)).toBe(0);
      expect(sourceHandCurlInfluence([.75, .75, .75, .75], 1)).toBe(1);
      expect(sourceHandCurlInfluence([NaN, .3, .3, .3], 1)).toBeCloseTo(.3);
    } finally { source.dispose(); result.geometry.dispose(); }
  });

  it('requires explicit canonical assets and terminal hand bindings, leaving unknown rigs unchanged', () => {
    expect(isCanonicalSourceHandAsset('/assets/business-woman-ab12cd.glb')).toBe(true);
    expect(isCanonicalSourceHandAsset('/assets/unknown.glb')).toBe(false);
    const geometry = handGeometry(), material = new MeshStandardMaterial();
    const mesh = new SkinnedMesh(geometry, material);
    try {
      expect(attachSourceHandCurl(mesh, '/assets/unknown.glb')).toBeUndefined();
      expect(attachSourceHandCurl(mesh, '/assets/business-man.glb')).toBeUndefined();
      expect(mesh.geometry).toBe(geometry);
    } finally { geometry.dispose(); material.dispose(); }
  });

  it('shares cached immutable targets while preserving existing morphs and independent instance controls', () => {
    const source = handGeometry();
    const female = new Float32BufferAttribute(new Float32Array(18), 3); female.name = 'Female';
    source.morphAttributes.position = [female];
    const leftLower = new Bone(), rightLower = new Bone(), left = new Bone(), right = new Bone();
    leftLower.name = 'leftLowerArm'; rightLower.name = 'rightLowerArm'; left.name = 'leftHand'; right.name = 'rightHand';
    leftLower.add(left); rightLower.add(right); leftLower.updateMatrixWorld(true); rightLower.updateMatrixWorld(true);
    const skeleton = new Skeleton([left, right]);
    const material = new MeshStandardMaterial();
    const meshes = [new SkinnedMesh(source, material), new SkinnedMesh(source, material)];
    for (const mesh of meshes) { mesh.bind(skeleton, new Matrix4()); mesh.morphTargetInfluences![0] = .37; mesh.updateMatrixWorld(true); }
    const lengths = sourceHandCurlLengths(meshes);
    expect(lengths[0]).toBeCloseTo(.2);
    const first = attachSourceHandCurl(meshes[0]!, '/assets/business-man.glb', lengths)!;
    const second = attachSourceHandCurl(meshes[1]!, '/assets/business-man.glb', lengths)!;
    try {
      expect(first.geometry).toBe(second.geometry);
      expect(first.targets).toEqual([1, 2]);
      expect(source.morphAttributes.position).toHaveLength(1);
      expect(meshes[0]!.morphTargetDictionary!.Female).toBe(0);
      expect(meshes[0]!.morphTargetInfluences![0]).toBe(.37);
      expect(first.geometry.morphAttributes.normal).toHaveLength(3);
      expect(meshes[0]!.morphTargetDictionary).not.toBe(meshes[1]!.morphTargetDictionary);
      expect(meshes[0]!.morphTargetInfluences).not.toBe(meshes[1]!.morphTargetInfluences);
      meshes[0]!.morphTargetInfluences![1] = .8;
      expect(meshes[1]!.morphTargetInfluences![1]).toBe(0);
      expect(source.morphAttributes.position![0]!.name).toBe('Female');
      const nail = source.clone(); nail.getAttribute('position').setY(3, .18);
      const nailCurl = sourceHandCurlGeometry(nail, bindings.map(binding => ({ ...binding, length: lengths[binding.side] })))!;
      for (const axis of [0, 1, 2]) expect(nailCurl.geometry.morphAttributes.position![1]!.getComponent(4, axis))
        .toBe(first.geometry.morphAttributes.position![1]!.getComponent(4, axis));
      nail.dispose(); nailCurl.geometry.dispose();
    } finally { source.dispose(); first.geometry.dispose(); material.dispose(); skeleton.dispose(); }
  });
});
