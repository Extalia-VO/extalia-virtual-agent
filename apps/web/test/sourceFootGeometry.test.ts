import { describe, expect, it } from 'vitest';
import { Bone, BufferGeometry, Float32BufferAttribute, Group, MeshStandardMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3 } from 'three';
import { fitSourceFootGeometry } from '../src/office/scene/avatars/sourceFootGeometry';

function fixture(translation = new Vector3()) {
  const group = new Group(); group.position.copy(translation);
  const bones = ['leftFoot', 'rightFoot'].map((name, i) => { const bone = new Bone(); bone.name = name; bone.position.set(i ? .1 : -.1, .06, 0); group.add(bone); return bone; });
  group.updateMatrixWorld(true); const skeleton = new Skeleton(bones);
  const meshes: SkinnedMesh[] = [];
  const make = (role: string, points: number[][], name = `ScanOutfit_${meshes.length}`) => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(points.flat(), 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(points.flatMap(() => [0, 1, 0]), 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(points.flatMap(() => [.2, .3]), 2));
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(points.flatMap(point => [point[0]! < 0 ? 0 : 1, 0, 0, 0]), 4));
    geometry.setAttribute('skinWeight', new Float32BufferAttribute(points.flatMap(() => [1, 0, 0, 0]), 4));
    geometry.setIndex(points.map((_, i) => i));
    geometry.morphTargetsRelative = true; geometry.morphAttributes.position = [new Float32BufferAttribute(points.flatMap(() => [0, .001, 0]), 3)];
    const material = new MeshStandardMaterial(); material.name = role;
    const mesh = new SkinnedMesh(geometry, material); mesh.name = name; group.add(mesh); group.updateMatrixWorld(true); mesh.bind(skeleton, mesh.matrixWorld); meshes.push(mesh); return mesh;
  };
  const both = (points: number[][]) => [-.1, .1].flatMap(x => points.map(p => [p[0]! + x, p[1]!, p[2]!]));
  const shoes = make('OfficeShoes_Test', both([[-.03, .01, .1], [.03, .01, .1], [0, .06, .1], [-.03, .01, .15], [.03, .01, .15], [0, .06, .15]]));
  const bottom = make('OfficeBottom_Test', both([
    [-.03, .19, -.04], [.03, .19, -.04], [-.03, .2, .04], [.03, .2, .04], [-.03, .23, -.04], [.03, .23, .04],
    [0, .02, .15], [0, .24, .15], [0, .08, .02],
  ]));
  const skin = make('Skin_Outfit_Test', both([[0, .085, .1], [.01, .06, .1], [0, .15, .1]]));
  return { meshes, make, shoes, bottom, skin, dispose() { for (const mesh of meshes) { mesh.geometry.dispose(); (mesh.material as MeshStandardMaterial).dispose(); } skeleton.dispose(); } };
}

function corrected(result: ReturnType<typeof fitSourceFootGeometry>, mesh: SkinnedMesh) { return result.corrections.find(c => c.mesh === mesh)?.geometry; }

describe('source outfit foot geometry fitting', () => {
  it('fits excessive cuffs and insteps on both sides while preserving shoes, calves and ankle skin', () => {
    const f = fixture();
    try {
      const result = fitSourceFootGeometry(f.meshes), bottom = corrected(result, f.bottom)!, skin = corrected(result, f.skin)!;
      expect(corrected(result, f.shoes)).toBeUndefined();
      for (const offset of [0, 9]) {
        expect(bottom.getAttribute('position').getZ(offset + 6)).toBeCloseTo(.05, 6);
        expect(bottom.getAttribute('position').getZ(offset + 7)).toBeCloseTo(.15, 6);
        expect(bottom.getAttribute('position').getZ(offset + 8)).toBeCloseTo(.02, 6);
      }
      for (const offset of [0, 3]) {
        expect(skin.getAttribute('position').getY(offset)).toBeCloseTo(.085, 6);
        expect(skin.getAttribute('position').getY(offset)).toBeGreaterThan(.01);
        expect(skin.getAttribute('position').getY(offset + 1)).toBeLessThan(skin.getAttribute('position').getY(offset));
        expect(skin.getAttribute('position').getY(offset + 2)).toBeCloseTo(.15, 6);
        expect(skin.getAttribute('position').getZ(offset)).toBeGreaterThan(.025);
        expect(skin.getAttribute('position').getZ(offset)).toBeLessThan(.04);
        expect(skin.getAttribute('position').getZ(offset + 2)).toBeCloseTo(.1, 6);
      }
      expect(result.soleByOutfit.get('ScanOutfit')?.get('leftFoot')).toBeCloseTo(.01, 6);
      expect(result.soleByOutfit.get('ScanOutfit')?.get('rightFoot')).toBeCloseTo(.01, 6);
    } finally { f.dispose(); }
  });

  it('uses rest-world transforms, preserves original attributes and caches corrections', () => {
    const f = fixture(new Vector3(.4, .3, .2));
    const originals = f.meshes.map(mesh => mesh.geometry.clone());
    try {
      const result = fitSourceFootGeometry(f.meshes), again = fitSourceFootGeometry(f.meshes);
      expect(result.corrections.length).toBe(2);
      expect(result.soleByOutfit.get('ScanOutfit')?.get('leftFoot')).toBeCloseTo(.31, 6);
      for (const { mesh, geometry } of result.corrections) {
        expect(corrected(again, mesh)).toBe(geometry);
        for (const key of ['skinIndex', 'skinWeight', 'uv']) expect(Array.from(geometry.getAttribute(key).array)).toEqual(Array.from(mesh.geometry.getAttribute(key).array));
        expect(Array.from(geometry.index!.array)).toEqual(Array.from(mesh.geometry.index!.array));
        expect(Array.from(geometry.morphAttributes.position![0]!.array)).toEqual(Array.from(mesh.geometry.morphAttributes.position![0]!.array));
        for (const key of ['position', 'normal']) expect(Array.from(geometry.getAttribute(key).array).every(Number.isFinite)).toBe(true);
        const normal = geometry.getAttribute('normal');
        for (let i = 0; i < normal.count; i++) { const length = new Vector3().fromBufferAttribute(normal, i).length(); expect(length === 0 || Math.abs(length - 1) < 1e-6).toBe(true); }
      }
      f.meshes.forEach((mesh, i) => { for (const key of ['position', 'normal']) expect(Array.from(mesh.geometry.getAttribute(key).array)).toEqual(Array.from(originals[i]!.getAttribute(key).array)); });
    } finally { originals.forEach(g => g.dispose()); f.dispose(); }
  });

  it('never borrows shoes from another wardrobe variant', () => {
    const f = fixture();
    try {
      f.shoes.name = 'UnknownMesh';
      const casualShoes = f.make('OfficeShoes_Test', [[-.1, .025, .1], [-.08, .025, .13], [-.12, .06, .1]], 'ScanOutfitCasual_4');
      const result = fitSourceFootGeometry(f.meshes);
      expect(result.corrections).toEqual([]);
      expect(result.soleByOutfit.get('ScanOutfit')?.size).toBe(0);
      expect(result.soleByOutfit.get('ScanOutfitCasual')?.get('leftFoot')).toBeCloseTo(.025, 6);
      expect(corrected(result, casualShoes)).toBeUndefined();
    } finally { f.dispose(); }
  });

  it('keeps unknown roles, clean geometry and other wardrobe variants intact', () => {
    const f = fixture();
    try {
      const clean = f.make('OfficeBottom_Test', [[-.1, .08, .02], [-.09, .085, .025], [-.11, .08, .025]]);
      const unknown = f.make('OtherMaterial', [[-.1, .08, .2], [-.09, .085, .2], [-.11, .08, .2]]);
      const casual = f.make('OfficeBottom_Test', [[-.1, .08, .2], [-.09, .085, .2], [-.11, .08, .2]], 'ScanOutfitCasual_2');
      const result = fitSourceFootGeometry(f.meshes);
      expect(corrected(result, clean)).toBeUndefined(); expect(corrected(result, unknown)).toBeUndefined(); expect(corrected(result, casual)).toBeUndefined();
      f.meshes.forEach(mesh => { mesh.name = 'UnknownMesh'; });
      expect(fitSourceFootGeometry(f.meshes).corrections).toEqual([]);
    } finally { f.dispose(); }
  });

  it('tucks distal skin without folding or flattening its volume, and keeps its height', () => {
    const f = fixture();
    const xs = [0, .025, .04, .05], zs = [.02, .04, .1, .16];
    try {
      const skin = f.make('Skin_Outfit_Test', xs.flatMap(x => zs.map(z => [-.1 + x, .08, z])));
      const geometry = corrected(fitSourceFootGeometry(f.meshes), skin)!;
      const position = geometry.getAttribute('position');
      for (let x = 0; x < xs.length; x++) for (let z = 0; z < zs.length; z++) {
        const i = x * zs.length + z;
        expect(position.getY(i)).toBeCloseTo(.08, 6);
        if (z) expect(position.getZ(i)).toBeGreaterThan(position.getZ(i - 1));
        if (x) expect(position.getX(i)).toBeGreaterThan(position.getX(i - zs.length));
      }
    } finally { f.dispose(); }
  });
});
