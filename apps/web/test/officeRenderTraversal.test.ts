import { describe, expect, it, vi } from 'vitest';
import { Bone, BoxGeometry, Float32BufferAttribute, Group, MeshStandardMaterial, Scene, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3 } from 'three';
import { batchFittedOutfitMeshes } from '../src/office/scene/avatars/avatarOutfitBatch';
import { disposeAvatarClone } from '../src/office/scene/avatars/avatarCloneResources';
import { installHiddenSceneTransforms } from '../src/office/scene/environment/HiddenSceneTransforms';

describe('Office render traversal', () => {
  it('skips only owned hidden branches and updates their current pose when revealed', () => {
    const scene = new Scene(), hidden = new Group(), ordinary = new Group(), moving = new Group();
    hidden.userData.officeSkipHiddenRenderTransforms = true;
    hidden.visible = ordinary.visible = false;
    hidden.add(moving);
    scene.add(hidden, ordinary);
    const update = vi.spyOn(moving, 'updateMatrixWorld');
    const ordinaryUpdate = vi.spyOn(ordinary, 'updateMatrixWorld');
    const dispose = installHiddenSceneTransforms(scene);
    moving.position.x = 3;
    scene.updateMatrixWorld();
    expect(update).not.toHaveBeenCalled();
    expect(ordinaryUpdate).toHaveBeenCalledOnce();
    expect(moving.getWorldPosition(new Vector3()).x).toBe(3);
    moving.position.x = 5;
    hidden.visible = true;
    scene.updateMatrixWorld();
    expect(moving.matrixWorld.elements[12]).toBe(5);
    dispose();
    hidden.visible = false;
    scene.updateMatrixWorld();
    expect(update).toHaveBeenCalledTimes(2);
  });
});

describe('fitted outfit batching', () => {
  it('preserves skinned vertices and rejects a different palette role or translucent surface', () => {
    const root = new Group(), bone = new Bone();
    root.add(bone);
    const skeleton = new Skeleton([bone]);
    const piece = (name: string, x: number, transparent = false) => {
      const geometry = new BoxGeometry().translate(x, 0, 0);
      geometry.clearGroups();
      const count = geometry.attributes.position!.count;
      const position = geometry.attributes.position!.clone();
      for (let i = 0; i < count; i++) position.setY(i, position.getY(i) + 0.3);
      geometry.morphAttributes.position = [position];
      const skinIndex = new Uint16Array(count * 4), skinWeight = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) skinWeight[i * 4] = 1;
      geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndex, 4));
      geometry.setAttribute('skinWeight', new Float32BufferAttribute(skinWeight, 4));
      const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial({ name, transparent }));
      mesh.name = 'ScanOutfitModel';
      mesh.morphTargetInfluences![0] = 0.65;
      root.add(mesh);
      mesh.bind(skeleton);
      return mesh;
    };
    const a = piece('OriginalTop_P0S0', 0), b = piece('OriginalTop_P1S0', 2);
    const other = piece('OriginalBottom_P0S0', 4), glass = piece('OriginalTop_P2S0', 6, true);
    const source = [a.geometry, b.geometry];
    bone.rotation.z = 0.4;
    root.scale.set(1.1, 0.9, 1.2);
    root.updateMatrixWorld(true);
    const vertices = [a, b].flatMap(mesh => Array.from({ length: mesh.geometry.attributes.position!.count }, (_, index) => mesh.getVertexPosition(index, new Vector3())));
    expect(batchFittedOutfitMeshes([a, b, other, glass])).toEqual([a]);
    expect(b.parent).toBeNull();
    expect(other.parent).toBe(root);
    expect(glass.parent).toBe(root);
    expect(a.geometry.attributes.position!.count).toBe(vertices.length);
    for (const [index, before] of vertices.entries()) expect(a.getVertexPosition(index, new Vector3()).distanceTo(before)).toBeLessThan(1e-6);

    const next = new Group(), nextBone = new Bone(), nextSkeleton = new Skeleton([nextBone]);
    next.add(nextBone);
    const parts = source.map((geometry, i) => {
      const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial({ name: `OriginalTop_P${i}S0` }));
      mesh.name = a.name;
      next.add(mesh);
      mesh.bind(nextSkeleton);
      return mesh;
    });
    expect(batchFittedOutfitMeshes(parts)[0]?.geometry).toBe(a.geometry);
    expect(parts[0]!.skeleton).not.toBe(a.skeleton);
    const dispose = vi.spyOn(a.geometry, 'dispose');
    disposeAvatarClone(root);
    expect(dispose).not.toHaveBeenCalled();
    disposeAvatarClone(next);
  });
});
