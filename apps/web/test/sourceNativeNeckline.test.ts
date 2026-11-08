import { Bone, BufferGeometry, Float32BufferAttribute, MeshStandardMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three';
import { describe, expect, it } from 'vitest';
import { sourceNativeNeckline } from '../src/office/scene/avatars/sourceNativeNeckline';

function original(centres = [[0, 1.50, .003]]) {
  const geometry = new BufferGeometry(), count = centres.length * 3;
  geometry.setAttribute('position', new Float32BufferAttribute(centres.flatMap(([x, y, z]) => [x! - .01, y!, z!, x! + .01, y!, z!, x!, y! + .015, z!]), 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(new Array(count * 2).fill(.25), 2));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Array(count * 4).fill(0), 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(Array.from({ length: count }, () => [1, 0, 0, 0]).flat(), 4));
  geometry.morphTargetsRelative = true;
  geometry.morphAttributes.position = [new Float32BufferAttribute(new Array(count * 3).fill(.002), 3)];
  geometry.setIndex(Array.from({ length: count }, (_, i) => i));
  const mesh: SkinnedMesh = new SkinnedMesh(geometry, new MeshStandardMaterial({ name: 'Skin_Original' })); mesh.name = 'WardrobePieceTop';
  const neck = new Bone(); neck.name = 'neck'; const hand = new Bone(); hand.name = 'leftHand';
  mesh.bind(new Skeleton([neck, hand])); return mesh;
}

function native() {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([-.08, 1.45, 0, .08, 1.45, 0, .08, 1.58, 0, -.08, 1.45, 0, .08, 1.58, 0, -.08, 1.58, 0], 3));
  const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial({ name: 'Skin_Native' })); mesh.name = 'BodyNeckline'; return mesh;
}

describe('native neckline after refitting an original collar', () => {
  it('removes duplicate neck skin only, preserving cloth, shoulders, arms and every shared attribute', () => {
    const mesh = original([[0, 1.50, .003], [0, 1.50, .003], [.16, 1.50, .003], [0, 1.50, .003]]), source = mesh.geometry;
    mesh.material = [new MeshStandardMaterial({ name: 'Skin_Original' }), new MeshStandardMaterial({ name: 'OriginalTop_Collar' })];
    source.addGroup(0, 3, 0); source.addGroup(3, 3, 1); source.addGroup(6, 6, 0);
    for (let vertex = 9; vertex < 12; vertex++) source.getAttribute('skinIndex').setX(vertex, 1);
    const before = source.clone(), fitted = sourceNativeNeckline(mesh, [native()]);
    expect(Array.from(fitted.index!.array)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(fitted.groups).toEqual([{ start: 0, count: 3, materialIndex: 1 }, { start: 3, count: 6, materialIndex: 0 }]);
    for (const name of ['position', 'uv', 'skinIndex', 'skinWeight']) {
      expect(fitted.getAttribute(name).array).toEqual(before.getAttribute(name).array);
      expect(source.getAttribute(name).array).toEqual(before.getAttribute(name).array);
    }
    expect(fitted.morphAttributes.position![0]!.array).toEqual(before.morphAttributes.position![0]!.array);
    expect(source.index!.array).toEqual(before.index!.array); expect(source.groups).toEqual(before.groups);
  });

  it('retains skin where actual native coverage is absent, too distant or crossed by a source triangle', () => {
    const mesh = original();
    expect(sourceNativeNeckline(mesh, [])).toBe(mesh.geometry);
    const wrong = native(); wrong.name = 'Body'; expect(sourceNativeNeckline(mesh, [wrong])).toBe(mesh.geometry);
    const distant = native(); distant.geometry.translate(0, 0, -.02);
    expect(sourceNativeNeckline(mesh, [distant])).toBe(mesh.geometry);
    const cornerOutside = original(); cornerOutside.geometry.getAttribute('position').setX(2, .12);
    expect(sourceNativeNeckline(cornerOutside, [native()])).toBe(cornerOutside.geometry);
    const shoulder = original([[.145, 1.49, .003]]);
    expect(sourceNativeNeckline(shoulder, [native()])).toBe(shoulder.geometry);
    mesh.name = 'BodyNeckline'; expect(sourceNativeNeckline(mesh, [native()])).toBe(mesh.geometry);
  });

  it('caches only the selected native geometry and bind frame', () => {
    const mesh = original(), neckline = native(), first = sourceNativeNeckline(mesh, [neckline]);
    expect(first.index!.count).toBe(0); expect(sourceNativeNeckline(mesh, [neckline])).toBe(first);
    neckline.bindMatrix.makeTranslation(0, 0, .03);
    expect(sourceNativeNeckline(mesh, [neckline])).toBe(mesh.geometry);
    mesh.bindMatrix.makeTranslation(0, 0, .03);
    expect(sourceNativeNeckline(mesh, [neckline]).index!.count).toBe(0);
    mesh.bindMatrix.identity(); neckline.bindMatrix.identity();
    expect(sourceNativeNeckline(mesh, [neckline])).toBe(first);
    const another = original(); expect(sourceNativeNeckline(another, [])).toBe(another.geometry);
  });
});
