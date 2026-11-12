import { describe, expect, it, vi } from 'vitest';
import { Bone, BoxGeometry, BufferGeometry, Float32BufferAttribute, Group, MeshBasicMaterial, MeshStandardMaterial, Skeleton, SkinnedMesh, Texture, Uint16BufferAttribute } from 'three';
import type { Mesh } from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { disposeAvatarClone, ownAvatarCloneGeometry } from '../src/office/scene/avatars/avatarCloneResources';
import { sourceWaistBacking } from '../src/office/scene/avatars/sourceWaistBacking';
import { attachSourceHandCurl } from '../src/office/scene/avatars/sourceHandCurl';

function sourceAsset() {
  const root = new Group(), bone = new Bone(); root.add(bone); root.updateMatrixWorld(true);
  const geometry = new BoxGeometry(), map = new Texture(), material = new MeshBasicMaterial({ map });
  const skeleton = new Skeleton([bone]); skeleton.computeBoneTexture();
  for (let index = 0; index < 2; index++) {
    const mesh = new SkinnedMesh(geometry, material); mesh.bind(skeleton); root.add(mesh);
  }
  return { root, geometry, map, material, skeleton };
}

function avatar(source: Group) {
  const root = clone(source) as Group, skins: SkinnedMesh[] = [];
  root.traverse(child => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(item => item.clone()) : mesh.material.clone();
    const skin = child as SkinnedMesh;
    if (skin.isSkinnedMesh) { skin.skeleton.computeBoneTexture(); skins.push(skin); }
  });
  return { root, skins };
}

describe('source avatar clone resource ownership', () => {
  it('releases unique cloned bone textures and materials while retaining library data and another avatar', () => {
    const source = sourceAsset(), a = avatar(source.root), b = avatar(source.root);
    const geometryDispose = vi.spyOn(source.geometry, 'dispose'), mapDispose = vi.spyOn(source.map, 'dispose');
    const sourceMaterialDispose = vi.spyOn(source.material, 'dispose');
    const sourceTexture = source.skeleton.boneTexture, sourceBoneDispose = vi.spyOn(sourceTexture!, 'dispose');
    const borrowed = b.skins.map(skin => skin.skeleton.boneTexture);
    const materials = a.skins.map(skin => vi.spyOn(skin.material as MeshBasicMaterial, 'dispose'));
    const textures = a.skins.map(skin => vi.spyOn(skin.skeleton.boneTexture!, 'dispose'));
    // A fitted lining/native-footwear mesh can reuse an instance skeleton and material.
    const lining = new SkinnedMesh(source.geometry, a.skins[0]!.material);
    lining.bind(a.skins[0]!.skeleton, a.skins[0]!.bindMatrix.clone()); a.root.add(lining);
    disposeAvatarClone(a.root);
    for (const texture of textures) expect(texture).toHaveBeenCalledOnce();
    for (const material of materials) expect(material).toHaveBeenCalledOnce();
    expect(a.skins.every(skin => skin.skeleton.boneTexture === null)).toBe(true);
    expect(b.skins.map(skin => skin.skeleton.boneTexture)).toEqual(borrowed);
    expect(source.skeleton.boneTexture).toBe(sourceTexture);
    expect(geometryDispose).not.toHaveBeenCalled(); expect(mapDispose).not.toHaveBeenCalled();
    expect(sourceMaterialDispose).not.toHaveBeenCalled(); expect(sourceBoneDispose).not.toHaveBeenCalled();
    disposeAvatarClone(b.root); source.skeleton.dispose(); source.material.dispose(); source.map.dispose(); source.geometry.dispose();
  });

  it('cleans up again after a StrictMode-style replay recreates instance bone textures', () => {
    const source = sourceAsset(), owned = avatar(source.root);
    const first = owned.skins.map(skin => vi.spyOn(skin.skeleton.boneTexture!, 'dispose'));
    disposeAvatarClone(owned.root); disposeAvatarClone(owned.root);
    for (const texture of first) expect(texture).toHaveBeenCalledOnce();
    for (const skin of owned.skins) skin.skeleton.computeBoneTexture();
    const replay = owned.skins.map(skin => vi.spyOn(skin.skeleton.boneTexture!, 'dispose'));
    disposeAvatarClone(owned.root);
    for (const texture of replay) expect(texture).toHaveBeenCalledOnce();
    expect(owned.skins.every(skin => skin.skeleton.boneTexture === null)).toBe(true);
    source.skeleton.dispose(); source.material.dispose(); source.map.dispose(); source.geometry.dispose();
  });

  it('releases explicitly owned attached geometry once per cleanup and retains borrowed geometry', () => {
    const source = sourceAsset(), owned = avatar(source.root), other = avatar(source.root);
    const privateGeometry = source.geometry.clone(), detachedGeometry = source.geometry.clone();
    ownAvatarCloneGeometry(owned.root, privateGeometry);
    ownAvatarCloneGeometry(owned.root, detachedGeometry);
    for (const skin of owned.skins) skin.geometry = privateGeometry;
    const privateDispose = vi.spyOn(privateGeometry, 'dispose'), detachedDispose = vi.spyOn(detachedGeometry, 'dispose');
    const borrowedDispose = vi.spyOn(source.geometry, 'dispose');
    disposeAvatarClone(other.root);
    expect(privateDispose).not.toHaveBeenCalled();
    disposeAvatarClone(owned.root);
    expect(privateDispose).toHaveBeenCalledOnce();
    expect(detachedDispose).not.toHaveBeenCalled(); expect(borrowedDispose).not.toHaveBeenCalled();
    // StrictMode can render this same private geometry again after its first cleanup.
    disposeAvatarClone(owned.root);
    expect(privateDispose).toHaveBeenCalledTimes(2);
    detachedGeometry.dispose(); source.skeleton.dispose(); source.material.dispose(); source.map.dispose(); source.geometry.dispose();
  });

  it('owns the final morph derivative of private backing without releasing its borrowed source', () => {
    const source = new BufferGeometry();
    const panel = [-.12, 1.05, .12, .12, 1.05, .12, .12, 1.17, .12, -.12, 1.17, .12];
    source.setAttribute('position', new Float32BufferAttribute([...panel, ...panel, ...panel], 3));
    source.setAttribute('normal', new Float32BufferAttribute(Array.from({ length: 12 }, () => [0, 0, 1]).flat(), 3));
    source.setAttribute('skinIndex', new Uint16BufferAttribute(Array.from({ length: 12 }, (_, i) => [i >= 8 ? 2 : 0, 0, 0, 0]).flat(), 4));
    source.setAttribute('skinWeight', new Float32BufferAttribute(Array.from({ length: 12 }, () => [1, 0, 0, 0]).flat(), 4));
    source.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11]);
    const names = ['OfficeOuter_Vest', 'Skin_Waist', 'OfficeTop_Cuff'];
    names.forEach((_, i) => source.addGroup(i * 6, 6, i));
    const mesh = new SkinnedMesh(source, names.map(name => new MeshStandardMaterial({ name })));
    mesh.name = 'ScanOutfit';
    const bones = ['hips', 'leftLowerArm', 'leftHand', 'rightLowerArm', 'rightHand'].map(name => {
      const bone = new Bone(); bone.name = name; return bone;
    });
    bones[0]!.position.y = 1; bones[0]!.add(bones[1]!, bones[3]!);
    bones[1]!.add(bones[2]!); bones[3]!.add(bones[4]!);
    bones[2]!.position.y = bones[4]!.position.y = -.05;
    const root = new Group(); root.add(bones[0]!, mesh); root.updateMatrixWorld(true);
    mesh.bind(new Skeleton(bones));
    const lower = new BufferGeometry();
    lower.setAttribute('position', new Float32BufferAttribute([-.15, 1.02, .14, .15, 1.02, .14, .15, .75, .14], 3));
    const bottomMaterial = new MeshStandardMaterial({ name: 'OriginalBottom_Jeans' });
    const bottom = new SkinnedMesh(lower, bottomMaterial);
    const backing = sourceWaistBacking(mesh, bottom); mesh.geometry = backing;
    expect(backing).not.toBe(source);
    expect(attachSourceHandCurl(mesh, '/avatars/office-classic.glb', [.22, .22])).toBeDefined();
    expect(mesh.geometry).not.toBe(backing);
    // SourceHumanoid registers after its coverage and morph processors finish.
    ownAvatarCloneGeometry(root, mesh.geometry);
    const sourceDispose = vi.spyOn(source, 'dispose'), backingDispose = vi.spyOn(backing, 'dispose');
    const finalDispose = vi.spyOn(mesh.geometry, 'dispose');
    disposeAvatarClone(root);
    expect(finalDispose).toHaveBeenCalledOnce(); expect(sourceDispose).not.toHaveBeenCalled();
    expect(backingDispose).not.toHaveBeenCalled();
    backing.dispose(); source.dispose(); lower.dispose(); bottomMaterial.dispose();
  });
});
