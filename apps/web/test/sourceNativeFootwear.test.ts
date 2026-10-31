import { Bone, BufferGeometry, Float32BufferAttribute, Group, MeshStandardMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three';
import { describe, expect, it } from 'vitest';
import { nativeFootwearGeometry, requestsNativeFootwear, wardrobeFootSoleProfile } from '../src/office/scene/avatars/sourceNativeFootwear';

function native(indexed: boolean) {
  const names = ['OfficeShoes_Formal', 'Skin_Ankle', 'Skin_Leg', 'OfficeBottom_Cuff', 'OfficeTop_Shirt'];
  const heights = [.08, .14, .3, .1, 1.3];
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(heights.flatMap(y => [0, y, 0, .01, y, 0, 0, y + .01, .01]), 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(names.flatMap(() => [0, 0, 1, 0, 0, 1]), 2));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(names.flatMap(() => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(names.flatMap(() => [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4));
  if (indexed) geometry.setIndex(Array.from({ length: names.length * 3 }, (_, index) => index));
  names.forEach((_, index) => geometry.addGroup(index * 3, 3, index));
  const mesh = new SkinnedMesh(geometry, names.map(name => new MeshStandardMaterial({ name })));
  const foot = new Bone(); foot.name = 'leftFoot'; mesh.bind(new Skeleton([foot]));
  return mesh;
}

describe('original full sets reusing canonical native footwear', () => {
  it('requires the exact boolean opt-in on a source node, including multi-material parent groups', () => {
    for (const value of [undefined, false, 'true', 1, {}, []]) {
      const scene = new Group(); scene.userData.extaliaNativeFootwear = value;
      expect(requestsNativeFootwear(scene)).toBe(false);
    }
    const scene = new Group(), node = new Group(); node.userData.extaliaNativeFootwear = true; scene.add(node);
    expect(requestsNativeFootwear(scene)).toBe(true);
  });

  it.each([true, false])('retains only shoes and native low ankle backing without changing source bindings (indexed %s)', indexed => {
    const mesh = native(indexed), source = mesh.geometry;
    const feet = nativeFootwearGeometry(mesh)!;
    expect(feet.groups.map(group => group.materialIndex)).toEqual([0, 1]);
    expect(feet.index!.count).toBe(6);
    expect(source.groups).toHaveLength(5);
    expect(source.index?.count ?? source.getAttribute('position').count).toBe(15);
    expect(feet.getAttribute('skinWeight').array).toEqual(source.getAttribute('skinWeight').array);
    expect(feet.getAttribute('skinIndex').array).toEqual(source.getAttribute('skinIndex').array);
    expect(feet.getAttribute('uv').array).toEqual(source.getAttribute('uv').array);
    expect(nativeFootwearGeometry(mesh)).toBe(feet);
  });

  it('uses native corrected sole heights for opted-in originals and retains legacy full-set behaviour', () => {
    const nativeSoles = new Map([['leftFoot', -.015], ['rightFoot', -.02]]);
    const fittedSoles = new Map([['leftFoot', -.4]]);
    const profiles = new Map([['ScanOutfit', nativeSoles], ['ScanOutfitModel', fittedSoles]]);
    expect(wardrobeFootSoleProfile(profiles, 'ScanOutfitModel', true)).toBe(nativeSoles);
    expect(wardrobeFootSoleProfile(profiles, 'ScanOutfitModel', false)).toBe(fittedSoles);
    expect(wardrobeFootSoleProfile(new Map([['ScanOutfitModel', fittedSoles]]), 'ScanOutfitModel', true)).toBe(fittedSoles);
    expect(wardrobeFootSoleProfile(undefined, 'ScanOutfitModel', true)).toBeUndefined();
  });
});
