import { Bone, BufferGeometry, Float32BufferAttribute, Group, MeshStandardMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three';
import { describe, expect, it } from 'vitest';
import { declaredWardrobeCoverage, readWardrobeCoverage, underlayerCoverageGeometry } from '../src/office/scene/avatars/sourceWardrobeCoverage';

const COVERAGE = { kind: 'closed-jacket', frontHalfWidth: .045, frontMinDepth: .04, collarMinHeight: 1.52 } as const;

function underlayer(indexed: boolean) {
  const fixtures = [
    ['OfficeTop_Shirt', 0, 1.3, .1, 0], // centre opening
    ['OriginalTop_Shirt', .15, 1.3, .1, 0], // covered front side
    ['OfficeTop_Shirt', 0, 1.3, -.1, 0], // covered back
    ['OriginalTop_Shirt', .15, 1.6, .03, 0], // collar in front
    ['OfficeTop_Shirt', 0, .9, .1, 1], // arm even within centre strip
    ['Skin_Hand', .4, .9, .1, 2], // hands stay
    ['Skin_Body', 0, 1.4, -.1, 0], // covered torso skin
    ['Skin_Leg', .1, .5, .1, 0], // lower skin stays
    ['OfficeBottom_Trousers', .1, .8, -.1, 0],
    ['OfficeShoes_Formal', .1, .1, -.1, 0],
    ['OfficeOuter_Vest', 0, 1.3, .1, 0], // native chest backing
    ['OfficeOuter_Vest', 0, 1.3, -.1, 0],
    ['Skin_Head', 0, 1.7, -.1, 3], // head is never removed
  ] as const;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(fixtures.flatMap(([, x, y, z]) => [x - .003, y - .003, z, x + .003, y - .003, z, x, y + .006, z]), 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(fixtures.flatMap(() => [0, 0, 1, 0, 0, 1]), 2));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(fixtures.flatMap(([, , , , bone]) => [bone, 0, 0, 0, bone, 0, 0, 0, bone, 0, 0, 0]), 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(fixtures.flatMap(() => [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4));
  if (indexed) geometry.setIndex(Array.from({ length: fixtures.length * 3 }, (_, index) => index));
  fixtures.forEach((_, index) => geometry.addGroup(index * 3, 3, index));
  const mesh = new SkinnedMesh(geometry, fixtures.map(([name]) => new MeshStandardMaterial({ name })));
  const bones = ['chest', 'leftLowerArm', 'leftHand', 'head'].map(name => { const bone = new Bone(); bone.name = name; return bone; });
  mesh.bind(new Skeleton(bones));
  return mesh;
}

describe('source-declared jacket underlayer coverage', () => {
  it('accepts only a bounded closed-jacket declaration and leaves open/unknown garments untouched', () => {
    expect(readWardrobeCoverage(COVERAGE)).toEqual(COVERAGE);
    for (const value of [null, {}, [], { ...COVERAGE, kind: 'open-jacket' }, { ...COVERAGE, frontHalfWidth: 50 }, { ...COVERAGE, frontMinDepth: NaN }, { ...COVERAGE, collarMinHeight: -1 }, { ...COVERAGE, extra: true }]) {
      expect(readWardrobeCoverage(value)).toBeUndefined();
    }
    const scene = new Group();
    expect(declaredWardrobeCoverage(scene)).toBeUndefined();
    const mesh = underlayer(true);
    expect(underlayerCoverageGeometry(mesh, undefined)).toBe(mesh.geometry);
    const closed = new Group(), node = new Group(); node.userData.extaliaWardrobeCoverage = COVERAGE; closed.add(node);
    expect(declaredWardrobeCoverage(closed)).toEqual(COVERAGE);
  });

  it.each([true, false])('keeps chest/collar/hands/lower outfit while hiding occluded upper layers (indexed %s)', indexed => {
    const mesh = underlayer(indexed), original = mesh.geometry;
    const filtered = underlayerCoverageGeometry(mesh, COVERAGE);
    expect(filtered.groups.map(group => group.materialIndex)).toEqual([0, 3, 5, 7, 8, 9, 10, 12]);
    expect(original.groups).toHaveLength(13);
    expect(original.index?.count ?? original.getAttribute('position').count).toBe(39);
    expect(filtered.getAttribute('uv').array).toEqual(original.getAttribute('uv').array);
    expect(filtered.getAttribute('skinWeight').array).toEqual(original.getAttribute('skinWeight').array);
    expect(underlayerCoverageGeometry(mesh, COVERAGE)).toBe(filtered);
    expect(underlayerCoverageGeometry(mesh, { ...COVERAGE, frontHalfWidth: .2 }).groups.length).toBeGreaterThan(filtered.groups.length);
  });

  it('applies the declared opening to neckline backing without touching other body meshes', () => {
    const mesh = underlayer(true); mesh.name = 'BodyNeckline';
    // In the neckline-only use case the same opening is applied even when a material has no wardrobe role.
    const material = (mesh.material as MeshStandardMaterial[])[1]!; material.name = 'NeckBacking';
    expect(underlayerCoverageGeometry(mesh, COVERAGE).groups.map(group => group.materialIndex)).not.toContain(1);
    expect(underlayerCoverageGeometry(mesh, COVERAGE).groups.map(group => group.materialIndex)).toContain(3);
  });
});
