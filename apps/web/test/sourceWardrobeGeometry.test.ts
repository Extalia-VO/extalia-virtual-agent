import { describe, expect, it } from 'vitest';
import { Bone, BufferGeometry, Float32BufferAttribute, MeshStandardMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three';
import { sourceWardrobeGeometry, wardrobeReplacementParts } from '../src/office/scene/avatars/sourceWardrobeGeometry';

function sample(indexed = true) {
  const names = ['OfficeTop_Test', 'OfficeBottom_Test', 'OfficeShoes_Test', 'OfficeOuter_Test', 'OfficeLining_Test', 'Skin_Test', 'Skin_Test', 'Skin_Test', 'Skin_Test'];
  const heights = [1.3, .6, .1, 1.3, 1.3, 1.4, .8, .5, .1];
  const geometry = new BufferGeometry();
  const vertices = heights.flatMap((height, i) => [i * .03, height, 0, i * .03 + .01, height, 0, i * .03, height + .01, .01]);
  geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(vertices.map(() => .5), 3));
  // The seventh triangle is a hanging forearm below the waist; it belongs to the top.
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(names.flatMap((_, triangle) => Array.from({ length: 3 }, () => [triangle === 6 ? 1 : 0, 0, 0, 0]).flat()), 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(Array.from({ length: names.length * 3 }, (_, vertex) => vertex >= 18 && vertex < 21 ? [.4, .6, 0, 0] : [1, 0, 0, 0]).flat(), 4));
  geometry.morphAttributes.position = [new Float32BufferAttribute(vertices.map(value => value + .01), 3)];
  if (indexed) geometry.setIndex(Array.from({ length: names.length * 3 }, (_, index) => index));
  names.forEach((_, index) => geometry.addGroup(index * 3, 3, index));
  const mesh = new SkinnedMesh(geometry, names.map(name => new MeshStandardMaterial({ name })));
  const hip = new Bone(); hip.name = 'hips'; const arm = new Bone(); arm.name = 'rightLowerArm';
  mesh.bind(new Skeleton([hip, arm]));
  return mesh;
}

function retained(mesh: SkinnedMesh, parts: Parameters<typeof sourceWardrobeGeometry>[1]) {
  return sourceWardrobeGeometry(mesh, parts).groups.map(group => group.materialIndex);
}

describe('scanned outfit replacement by independent fitted pieces', () => {
  it.each([true, false])('replaces top and its arm skin without losing lower skin or footwear (indexed %s)', indexed => {
    const mesh = sample(indexed), original = mesh.geometry;
    const filtered = sourceWardrobeGeometry(mesh, { top: true, outer: true });
    expect(retained(mesh, { top: true, outer: true })).toEqual([1, 2, 7, 8]);
    expect(original.groups).toHaveLength(9);
    expect(original.index?.count ?? original.getAttribute('position').count).toBe(27);
    expect(filtered.getAttribute('skinIndex').array).toEqual(original.getAttribute('skinIndex').array);
    expect(filtered.getAttribute('skinWeight').array).toEqual(original.getAttribute('skinWeight').array);
    expect(filtered.morphAttributes.position?.[0]?.array).toEqual(original.morphAttributes.position?.[0]?.array);
    expect(sourceWardrobeGeometry(mesh, { top: true, outer: true })).toBe(filtered);
    expect(retained(mesh, { bottom: true, outer: true })).toEqual([0, 5, 6]);
  });

  it('keeps the missing slot as a scanned fallback and removes only the outer when mixing defaults', () => {
    const mesh = sample();
    expect(retained(mesh, { outer: true })).toEqual([0, 1, 2, 5, 6, 7, 8]);
    expect(retained(mesh, { top: true })).toEqual([1, 2, 3, 4, 7, 8]);
    expect(retained(mesh, { top: true, bottom: true, outer: true })).toEqual([]);
    expect(sourceWardrobeGeometry(mesh, {})).toBe(mesh.geometry);
  });
  it('retains native upper coverage when a fitted top fails while other pieces succeed', () => {
    expect(wardrobeReplacementParts({ bottom: true }, true, 'none')).toEqual({ bottom: true, outer: false });
    expect(wardrobeReplacementParts({ bottom: true, outer: true }, true, 'vest')).toEqual({ bottom: true, outer: false });
    expect(wardrobeReplacementParts({ top: true, bottom: true }, true, 'none')).toEqual({ top: true, bottom: true, outer: true });
    expect(wardrobeReplacementParts({ top: true }, true, 'missing-jacket')).toEqual({ top: true, outer: false });
    expect(wardrobeReplacementParts({ top: true }, false)).toEqual({});
  });

  it('keeps native corrected shoes and ankle skin when an original bottom supplies no footwear', () => {
    const mesh = sample();
    const nativeFootwear = sourceWardrobeGeometry(mesh, { bottom: true, outer: true, footwear: false });
    expect(nativeFootwear.groups.map(group => group.materialIndex)).toEqual([0, 2, 5, 6, 8]);
    expect(retained(mesh, { bottom: true, outer: true, footwear: true })).toEqual([0, 5, 6]);
    expect(sourceWardrobeGeometry(mesh, { bottom: true, outer: true, footwear: false })).toBe(nativeFootwear);
  });

});
