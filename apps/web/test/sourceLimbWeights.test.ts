import { describe, expect, it } from 'vitest';
import { Bone, BufferGeometry, Float32BufferAttribute, Matrix4, MeshStandardMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3 } from 'three';
import { sourceLimbWeights } from '../src/office/scene/avatars/sourceLimbWeights';

function fixture(points: number[][], influences: number[][], name = 'ScanOutfit_1') {
  const upper = new Bone(), lower = new Bone(), foot = new Bone(), other = new Bone();
  upper.name = 'leftUpperLeg'; lower.name = 'leftLowerLeg'; foot.name = 'leftFoot'; other.name = 'hips';
  upper.add(lower); lower.add(foot); foot.position.y = -0.5; upper.updateMatrixWorld(true);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(points.flat(), 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(points.flatMap(() => [0, 0, 1]), 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(points.flatMap(() => [0, 1, 2, 3]), 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(influences.flat(), 4));
  geometry.morphTargetsRelative = true;
  geometry.morphAttributes.position = [new Float32BufferAttribute(points.flatMap(() => [0, .01, 0]), 3)];
  const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial()); mesh.name = name;
  const skeleton = new Skeleton([upper, lower, foot, other]); mesh.bind(skeleton, new Matrix4());
  return { mesh, geometry, skeleton, dispose() { geometry.dispose(); (mesh.material as MeshStandardMaterial).dispose(); skeleton.dispose(); } };
}

describe('conservative cloth hinge weight correction', () => {
  it('transfers leaked thigh weights below the knee, including pure-thigh vertices with an unused slot', () => {
    const f = fixture([[0, -.2, 0], [.02, -.3, 0]], [[.8, .2, 0, 0], [1, 0, 0, 0]]);
    const before = Array.from(f.geometry.getAttribute('skinWeight').array);
    const geometry = sourceLimbWeights(f.mesh)!;
    try {
      expect(geometry).not.toBe(f.geometry);
      expect(Array.from(f.geometry.getAttribute('skinWeight').array)).toEqual(before);
      for (let i = 0; i < 2; i++) {
        expect(geometry.getAttribute('skinWeight').getX(i)).toBe(0);
        expect(geometry.getAttribute('skinWeight').getY(i)).toBe(1);
        expect(geometry.getAttribute('skinIndex').getY(i)).toBe(1);
      }
      for (const key of ['position', 'normal']) expect(Array.from(geometry.getAttribute(key).array)).toEqual(Array.from(f.geometry.getAttribute(key).array));
      expect(Array.from(geometry.morphAttributes.position![0]!.array)).toEqual(Array.from(f.geometry.morphAttributes.position![0]!.array));
      expect(sourceLimbWeights(f.mesh)).toBe(geometry);
      // Rest-pose skinning remains the identity even though the moving limb ownership changed.
      const point = new Vector3().fromBufferAttribute(geometry.getAttribute('position'), 0);
      const skinned = point.clone().applyMatrix4(f.skeleton.bones[1]!.matrixWorld.clone().multiply(f.skeleton.boneInverses[1]!));
      expect(skinned.distanceTo(point)).toBeLessThan(1e-10);
    } finally { geometry.dispose(); f.dispose(); }
  });

  it('preserves clean weights, body meshes, foot/palm influences, above-joint and remote geometry', () => {
    const points = [[0, -.2, 0], [0, -.2, 0], [0, .1, 0], [.2, -.2, 0], [0, -.6, 0], [0, -.2, 0]];
    const weights = [[0, 1, 0, 0], [.8, .19, .01, 0], [.8, .2, 0, 0], [.8, .2, 0, 0], [.8, .2, 0, 0], [.8, .17, 0, .03]];
    const f = fixture(points, weights);
    try {
      expect(sourceLimbWeights(f.mesh)).toBeUndefined();
      f.mesh.name = 'Body';
      expect(sourceLimbWeights(f.mesh)).toBeUndefined();
    } finally { f.dispose(); }
  });

  it('applies the same conservative correction to forearm cloth while preserving hand influences', () => {
    const f = fixture([[0, -.1, 0], [0, -.1, 0]], [[.9, .1, 0, 0], [.8, .19, .01, 0]], 'SourceTop_3');
    const [upper, lower, hand] = f.skeleton.bones;
    upper!.name = 'leftUpperArm'; lower!.name = 'leftLowerArm'; hand!.name = 'leftHand';
    hand!.position.y = -.25; upper!.updateMatrixWorld(true); f.skeleton.calculateInverses();
    const geometry = sourceLimbWeights(f.mesh)!;
    try {
      expect(geometry.getAttribute('skinWeight').getX(0)).toBe(0);
      expect(geometry.getAttribute('skinWeight').getY(0)).toBe(1);
      for (let slot = 0; slot < 4; slot++) expect(geometry.getAttribute('skinWeight').getComponent(1, slot))
        .toBe(f.geometry.getAttribute('skinWeight').getComponent(1, slot));
    } finally { geometry.dispose(); f.dispose(); }
  });

  it('keeps normalized totals and a continuous joint blend, with zero upper influence by t=.24', () => {
    const ts = [-.01, 0, .001, .06, .12, .239, .24, .4];
    const f = fixture(ts.map(t => [0, -t * .5, 0]), ts.map(() => [1, 0, 0, 0]));
    const geometry = sourceLimbWeights(f.mesh)!;
    try {
      const weights = geometry.getAttribute('skinWeight');
      let previous = 1;
      for (let i = 0; i < ts.length; i++) {
        const upper = weights.getX(i), total = [0, 1, 2, 3].reduce((sum, slot) => sum + weights.getComponent(i, slot), 0);
        expect(total).toBeCloseTo(1, 6);
        expect(upper).toBeLessThanOrEqual(previous + 1e-7); previous = upper;
      }
      expect(weights.getX(1)).toBe(1);
      expect(weights.getX(2)).toBeGreaterThan(.999);
      expect(weights.getX(6)).toBeCloseTo(0, 7);
      expect(weights.getX(7)).toBe(0);
    } finally { geometry.dispose(); f.dispose(); }
  });
});
