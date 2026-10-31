import { Bone, BufferGeometry, Float32BufferAttribute, MeshStandardMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three';
import { describe, expect, it } from 'vitest';
import { sourceWaistBacking } from '../src/office/scene/avatars/sourceWaistBacking';

function fixture() {
  const geometry = new BufferGeometry();
  const panel = [-.12, 1.05, .12, .12, 1.05, .12, .12, 1.17, .12, -.12, 1.17, .12];
  geometry.setAttribute('position', new Float32BufferAttribute([...panel, ...panel, ...panel], 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(Array.from({ length: 12 }, () => [0, 0, 1]).flat(), 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(Array.from({ length: 12 }, (_, i) => [i % 2, Math.floor(i / 2) % 2]).flat(), 2));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(Array.from({ length: 12 }, (_, i) => [i >= 8 ? 1 : 0, 0, 0, 0]).flat(), 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(Array.from({ length: 12 }, () => [1, 0, 0, 0]).flat(), 4));
  geometry.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11]);
  ['OfficeOuter_Vest', 'Skin_Waist', 'OfficeTop_Cuff'].forEach((_, i) => geometry.addGroup(i * 6, 6, i));
  const mesh = new SkinnedMesh(geometry, ['OfficeOuter_Vest', 'Skin_Waist', 'OfficeTop_Cuff'].map(name => new MeshStandardMaterial({ name })));
  const hips = new Bone(), arm = new Bone(); hips.name = 'hips'; hips.position.y = 1; arm.name = 'leftLowerArm';
  hips.updateMatrixWorld(); arm.updateMatrixWorld(); mesh.bind(new Skeleton([hips, arm])); mesh.name = 'ScanOutfit';
  const lower = new BufferGeometry();
  lower.setAttribute('position', new Float32BufferAttribute([-.15, 1.02, .14, .15, 1.02, .14, .15, .75, .14], 3));
  const bottom = new SkinnedMesh(lower, new MeshStandardMaterial({ name: 'OriginalBottom_Jeans' }));
  return { mesh, bottom };
}

describe('native waist backing beneath original separates', () => {
  it('extends only a nearby native torso hem beneath the real waistband', () => {
    const { mesh, bottom } = fixture(), source = mesh.geometry;
    const original = source.getAttribute('position').array.slice(), garment = bottom.geometry.getAttribute('position').array.slice();
    const fitted = sourceWaistBacking(mesh, bottom), points = fitted.getAttribute('position');
    expect(fitted).not.toBe(source);
    expect(points.getY(0)).toBeCloseTo(1.005, 6);
    expect(points.getY(2)).toBeCloseTo(1.17, 6);
    for (let vertex = 4; vertex < 12; vertex++) {
      expect(points.getY(vertex)).toBe(source.getAttribute('position').getY(vertex));
      expect(fitted.getAttribute('normal').getZ(vertex)).toBe(1);
    }
    expect(source.getAttribute('position').array).toEqual(original);
    expect(bottom.geometry.getAttribute('position').array).toEqual(garment);
    for (const name of ['uv', 'skinIndex', 'skinWeight']) expect(fitted.getAttribute(name).array).toEqual(source.getAttribute(name).array);
    expect(fitted.index?.array).toEqual(source.index?.array);
    expect(fitted.groups).toEqual(source.groups);
  });

  it('keeps original garments, unloaded fallback bottoms, shared skin and distant hems untouched', () => {
    const { mesh, bottom } = fixture();
    mesh.name = 'ScanOutfitModel'; expect(sourceWaistBacking(mesh, bottom)).toBe(mesh.geometry);
    mesh.name = 'ScanOutfit';
    (bottom.material as MeshStandardMaterial).name = 'OfficeBottom_Trousers'; expect(sourceWaistBacking(mesh, bottom)).toBe(mesh.geometry);
    (bottom.material as MeshStandardMaterial).name = 'OriginalBottom_Jeans';
    mesh.geometry.addGroup(0, 6, 1); expect(sourceWaistBacking(mesh, bottom)).toBe(mesh.geometry);
    const distant = fixture(); distant.bottom.geometry.translate(0, -.1, 0);
    expect(sourceWaistBacking(distant.mesh, distant.bottom)).toBe(distant.mesh.geometry);
  });

  it('fits in each bind frame without reusing another bottom placement', () => {
    const { mesh, bottom } = fixture();
    bottom.bindMatrix.makeTranslation(0, .02, 0);
    expect(sourceWaistBacking(mesh, bottom).getAttribute('position').getY(0)).toBeCloseTo(1.025, 6);
    bottom.bindMatrix.identity();
    expect(sourceWaistBacking(mesh, bottom).getAttribute('position').getY(0)).toBeCloseTo(1.005, 6);
  });
});
