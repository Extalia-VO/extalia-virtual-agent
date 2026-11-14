import { describe, expect, it, vi } from 'vitest';
import { Bone, BufferGeometry, Float32BufferAttribute, Group, MeshStandardMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3 } from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { shareAvatarSkeletons } from '../src/office/scene/avatars/avatarSkeletonSharing';
import { disposeAvatarClone } from '../src/office/scene/avatars/avatarCloneResources';

function fixture() {
  const root = new Group(), hips = new Bone(), leg = new Bone(), hand = new Bone();
  hips.name = 'hips'; leg.name = 'leftUpperLeg'; hand.name = 'leftHand';
  hips.position.y = 1; leg.position.y = -.5; hand.position.set(.5, .3, 0);
  hips.add(leg, hand); root.add(hips); root.updateMatrixWorld(true);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, .2, -.5, .1, .6, .4, .2], 3));
  geometry.setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute([0, 1, 2, 0, 1, 0, 2, 0, 2, 0, 1, 0], 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute([.6, .3, .1, 0, .8, .2, 0, 0, .9, .1, 0, 0], 4));
  geometry.setIndex([0, 1, 2]);
  geometry.morphTargetsRelative = true;
  geometry.morphAttributes.position = [new Float32BufferAttribute([.1, 0, 0, 0, .05, 0, 0, 0, .1], 3)];
  const first = new Skeleton([hips, leg, hand]);
  const second = new Skeleton([hips, leg, hand], first.boneInverses.map(matrix => matrix.clone()));
  const meshes = [first, second].map((skeleton, i) => {
    const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial({ color: i ? '#cc6688' : '#4488bb' }));
    mesh.position.x = i ? .3 : -.2; root.add(mesh); root.updateMatrixWorld(true);
    mesh.bind(skeleton, mesh.matrixWorld.clone()); mesh.morphTargetInfluences![0] = i ? .75 : .25;
    return mesh;
  });
  return { root, hips, leg, hand, meshes, geometry };
}
function positions(root: Group, meshes: SkinnedMesh[]) {
  root.updateMatrixWorld(true);
  for (const skeleton of new Set(meshes.map(mesh => mesh.skeleton))) skeleton.update();
  return meshes.map(mesh => Array.from({ length: mesh.geometry.getAttribute('position').count }, (_, i) => mesh.getVertexPosition(i, new Vector3()).toArray()));
}
function cloneAvatar(root: Group) {
  const owned = clone(root) as Group, meshes: SkinnedMesh[] = [];
  owned.traverse(object => {
    if (!(object as SkinnedMesh).isSkinnedMesh) return;
    const mesh = object as SkinnedMesh;
    mesh.material = (mesh.material as MeshStandardMaterial).clone(); meshes.push(mesh);
  });
  return { root: owned, meshes };
}

describe('exact skeleton sharing inside an owned avatar clone', () => {
  it.each(['rest', 'walk', 'seated', 'hand'] as const)('preserves actual skinned and morphed vertex positions for the %s pose', pose => {
    const f = fixture();
    if (pose === 'walk') { f.hips.rotation.y = .35; f.leg.rotation.x = .65; f.hand.rotation.z = -.3; }
    if (pose === 'seated') { f.hips.rotation.x = -.15; f.hips.position.y = .55; f.leg.rotation.x = -1.4; }
    if (pose === 'hand') { f.hand.rotation.set(.6, -.4, .3); f.hand.position.z = .2; f.root.scale.set(.9, 1.1, 1.05); f.root.rotation.y = .4; }
    const expected = positions(f.root, f.meshes);
    const references = f.meshes.map(mesh => ({ geometry: mesh.geometry, material: mesh.material, bind: mesh.bindMatrix.clone(),
      inverse: mesh.bindMatrixInverse.clone(), influences: mesh.morphTargetInfluences, dictionary: mesh.morphTargetDictionary }));
    expect(shareAvatarSkeletons(f.root)).toEqual({ before: 2, after: 1, meshes: 2 });
    const actual = positions(f.root, f.meshes);
    actual.forEach((vertices, m) => vertices.forEach((vertex, i) => vertex.forEach((value, axis) => expect(value).toBeCloseTo(expected[m]![i]![axis]!, 12))));
    f.meshes.forEach((mesh, i) => {
      expect(mesh.geometry).toBe(references[i]!.geometry); expect(mesh.material).toBe(references[i]!.material);
      expect(mesh.bindMatrix.equals(references[i]!.bind)).toBe(true); expect(mesh.bindMatrixInverse.equals(references[i]!.inverse)).toBe(true);
      expect(mesh.morphTargetInfluences).toBe(references[i]!.influences); expect(mesh.morphTargetDictionary).toBe(references[i]!.dictionary);
    });
    f.meshes[0]!.morphTargetInfluences![0] = .9; expect(f.meshes[1]!.morphTargetInfluences![0]).toBe(.75);
    expect(shareAvatarSkeletons(f.root)).toEqual({ before: 1, after: 1, meshes: 2 });
    disposeAvatarClone(f.root); f.geometry.dispose();
  });

  it.each(['inverse', 'bone-order', 'bone-object', 'external-bones', 'non-finite'] as const)('refuses incompatible %s bindings', kind => {
    const f = fixture(), skeleton = f.meshes[1]!.skeleton;
    if (kind === 'inverse') skeleton.boneInverses[1]!.elements[12]! += 1e-8;
    if (kind === 'bone-order') [skeleton.bones[1], skeleton.bones[2]] = [skeleton.bones[2]!, skeleton.bones[1]!];
    if (kind === 'bone-object') { const replacement = f.leg.clone(); f.hips.add(replacement); skeleton.bones[1] = replacement; }
    if (kind === 'external-bones') f.root.remove(f.hips);
    if (kind === 'non-finite') skeleton.boneInverses[0]!.elements[0] = NaN;
    const original = f.meshes.map(mesh => mesh.skeleton);
    expect(shareAvatarSkeletons(f.root)).toEqual({ before: 2, after: 2, meshes: 2 });
    expect(f.meshes.map(mesh => mesh.skeleton)).toEqual(original);
    disposeAvatarClone(f.root); f.geometry.dispose();
  });

  it('keeps library and other-avatar bones/textures independent and disposes redundant clone textures once', () => {
    const source = fixture(), a = cloneAvatar(source.root), b = cloneAvatar(source.root);
    const sourceSkeletons = source.meshes.map(mesh => mesh.skeleton);
    for (const skeleton of [...sourceSkeletons, ...a.meshes.map(mesh => mesh.skeleton), ...b.meshes.map(mesh => mesh.skeleton)]) skeleton.computeBoneTexture();
    const sourceTextures = sourceSkeletons.map(skeleton => skeleton.boneTexture), otherTextures = b.meshes.map(mesh => mesh.skeleton.boneTexture);
    const canonical = a.meshes[0]!.skeleton, redundant = a.meshes[1]!.skeleton;
    const otherRotation = b.meshes[0]!.skeleton.bones[1]!.rotation.x;
    const keptDispose = vi.spyOn(canonical.boneTexture!, 'dispose'), retiredDispose = vi.spyOn(redundant.boneTexture!, 'dispose');
    const geometryDispose = vi.spyOn(source.geometry, 'dispose');
    expect(shareAvatarSkeletons(a.root).after).toBe(1);
    expect(retiredDispose).toHaveBeenCalledOnce(); expect(keptDispose).not.toHaveBeenCalled();
    expect(shareAvatarSkeletons(b.root).after).toBe(1);
    expect(a.meshes[0]!.skeleton).not.toBe(b.meshes[0]!.skeleton);
    a.meshes[0]!.skeleton.bones[1]!.rotation.x = .7;
    expect(b.meshes[0]!.skeleton.bones[1]!.rotation.x).toBe(otherRotation); expect(source.leg.rotation.x).toBe(0);
    disposeAvatarClone(a.root); disposeAvatarClone(a.root);
    expect(keptDispose).toHaveBeenCalledOnce(); expect(retiredDispose).toHaveBeenCalledOnce();
    expect(sourceSkeletons.map(skeleton => skeleton.boneTexture)).toEqual(sourceTextures);
    expect(b.meshes[0]!.skeleton.boneTexture).toBe(otherTextures[0]); expect(geometryDispose).not.toHaveBeenCalled();
    canonical.computeBoneTexture(); const replay = vi.spyOn(canonical.boneTexture!, 'dispose');
    disposeAvatarClone(a.root); expect(replay).toHaveBeenCalledOnce();
    disposeAvatarClone(b.root); disposeAvatarClone(source.root); source.geometry.dispose();
  });

  it('leaves an unbound skinned mesh unchanged', () => {
    const root = new Group(), mesh = new SkinnedMesh(); root.add(mesh);
    expect(shareAvatarSkeletons(root)).toEqual({ before: 0, after: 0, meshes: 0 });
    expect(mesh.skeleton).toBeUndefined(); mesh.geometry.dispose(); (mesh.material as MeshStandardMaterial).dispose();
  });

  it('releases a texture aliased by two discarded skeletons exactly once', () => {
    const f = fixture(), first = f.meshes[0]!.skeleton, second = f.meshes[1]!.skeleton;
    const third = new Skeleton([...first.bones], first.boneInverses.map(matrix => matrix.clone()));
    const mesh = new SkinnedMesh(f.geometry, new MeshStandardMaterial()); mesh.bind(third, f.meshes[0]!.bindMatrix.clone()); f.root.add(mesh);
    first.computeBoneTexture(); second.computeBoneTexture(); third.boneTexture = second.boneTexture;
    const kept = vi.spyOn(first.boneTexture!, 'dispose'), discarded = vi.spyOn(second.boneTexture!, 'dispose');
    expect(shareAvatarSkeletons(f.root)).toEqual({ before: 3, after: 1, meshes: 3 });
    expect(discarded).toHaveBeenCalledOnce(); expect(kept).not.toHaveBeenCalled();
    expect(second.boneTexture).toBeNull(); expect(third.boneTexture).toBeNull();
    disposeAvatarClone(f.root); expect(discarded).toHaveBeenCalledOnce(); expect(kept).toHaveBeenCalledOnce(); f.geometry.dispose();
  });

  it('does not dispose a texture already shared with a retained skeleton', () => {
    const f = fixture(), first = f.meshes[0]!.skeleton, second = f.meshes[1]!.skeleton;
    first.computeBoneTexture(); second.boneTexture = first.boneTexture;
    const dispose = vi.spyOn(first.boneTexture!, 'dispose');
    shareAvatarSkeletons(f.root); expect(dispose).not.toHaveBeenCalled();
    disposeAvatarClone(f.root); expect(dispose).toHaveBeenCalledOnce(); f.geometry.dispose();
  });
});
