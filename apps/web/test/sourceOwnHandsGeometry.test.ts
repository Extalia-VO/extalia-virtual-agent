import { Bone, BufferGeometry, Float32BufferAttribute, MeshStandardMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three';
import { describe, expect, it } from 'vitest';
import { nativeBodyWithoutHands } from '../src/office/scene/avatars/sourceOwnHandsGeometry';

function body(indexed: boolean) {
  // Head, left hand, right hand, forearm, and a wrist boundary dominated by the forearm.
  const ownership = [[0, [1, 1, 1]], [1, [.9, .7, .6]], [2, [1, 1, 1]], [1, [.2, .2, .2]], [1, [0, .4, .8]]] as const;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(ownership.flatMap((_, i) => [i, 0, 0, i + .1, 0, 0, i, .1, 0]), 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(ownership.flatMap(() => [0, 0, 1, 0, 0, 1]), 2));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(ownership.flatMap(([bone]) => [bone, 3, 0, 0, bone, 3, 0, 0, bone, 3, 0, 0]), 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(ownership.flatMap(([, values]) => values.flatMap(weight => [weight, 1 - weight, 0, 0])), 4));
  geometry.morphAttributes.position = [new Float32BufferAttribute(Array.from(geometry.getAttribute('position').array, value => value + .01), 3)];
  geometry.morphTargetsRelative = true;
  if (indexed) geometry.setIndex(Array.from({ length: ownership.length * 3 }, (_, i) => i));
  ownership.forEach((_, i) => geometry.addGroup(i * 3, 3, i));
  const mesh = new SkinnedMesh(geometry, ownership.map((_, i) => new MeshStandardMaterial({ name: i === 0 ? 'Skin_Head' : 'Skin_Hand' })));
  mesh.name = 'Body';
  const bones = ['head', 'leftHand', 'rightHand', 'leftLowerArm'].map(name => { const bone = new Bone(); bone.name = name; return bone; });
  mesh.bind(new Skeleton(bones));
  return mesh;
}

describe('original glove coverage of native hands', () => {
  it.each([true, false])('removes both hand-dominant triangles and preserves head/wrist data (indexed %s)', indexed => {
    const mesh = body(indexed), source = mesh.geometry;
    const geometry = nativeBodyWithoutHands(mesh, true);
    expect(geometry.index?.array).toEqual(new Uint16Array([0, 1, 2, 9, 10, 11, 12, 13, 14]));
    expect(geometry.groups.map(group => group.materialIndex)).toEqual([0, 3, 4]);
    expect(source.groups).toHaveLength(5);
    expect(source.index?.count ?? source.getAttribute('position').count).toBe(15);
    for (const name of ['position', 'uv', 'skinIndex', 'skinWeight']) expect(geometry.getAttribute(name).array).toEqual(source.getAttribute(name).array);
    expect(geometry.morphAttributes.position?.[0]?.array).toEqual(source.morphAttributes.position?.[0]?.array);
    expect(geometry.morphTargetsRelative).toBe(true);
    expect(nativeBodyWithoutHands(mesh, true)).toBe(geometry);
    expect(nativeBodyWithoutHands(mesh, false)).toBe(source);
  });

  it('leaves original gloves and undeclared/unskinned body geometry untouched', () => {
    const mesh = body(true), source = mesh.geometry;
    mesh.name = 'ScanOutfitModel';
    expect(nativeBodyWithoutHands(mesh, true)).toBe(source);
    mesh.name = 'Body'; source.deleteAttribute('skinWeight');
    expect(nativeBodyWithoutHands(mesh, true)).toBe(source);
  });

  it('keys cached results by bone ownership rather than reusing another skeleton mask', () => {
    const mesh = body(true), source = mesh.geometry;
    const filtered = nativeBodyWithoutHands(mesh, true);
    mesh.skeleton.bones[1]!.name = 'chest'; mesh.skeleton.bones[2]!.name = 'hips';
    expect(nativeBodyWithoutHands(mesh, true)).toBe(source);
    expect(filtered.index?.count).toBe(9);
  });
});
