import { Color, MeshStandardMaterial, Texture } from 'three';
import { describe, expect, it } from 'vitest';
import { tintOriginalGarmentMaterial } from '../src/office/scene/avatars/sourceOriginalMaterials';

describe('source garment material colours', () => {
  it('keeps native colour and texture settings on Auto, and restores them after explicit tinting', () => {
    const asset = new MeshStandardMaterial({ name: 'OriginalTop_Dress', color: new Color(.19, .37, .61), map: new Texture(), normalMap: new Texture(), roughness: .31, metalness: .06 });
    const instance = asset.clone(), original = asset.color.toArray();
    expect(tintOriginalGarmentMaterial(instance, { style: 'executive' })).toBe(true);
    expect(instance.color.toArray()).toEqual(original);
    tintOriginalGarmentMaterial(instance, { top: '#ab3245' });
    expect(instance.color.getHexString()).toBe('ab3245');
    tintOriginalGarmentMaterial(instance, { top: '#217ea8' });
    tintOriginalGarmentMaterial(instance, {});
    expect(instance.color.toArray()).toEqual(original);
    expect(asset.color.toArray()).toEqual(original);
    expect(instance.map).toBe(asset.map);
    expect(instance.normalMap).toBe(asset.normalMap);
    expect(instance.roughness).toBe(.31);
    expect(instance.metalness).toBe(.06);
    const second = asset.clone();
    tintOriginalGarmentMaterial(second, undefined);
    expect(second.color.toArray()).toEqual(original);
  });

  it.each([
    ['OriginalTop_Shirt', 'top'], ['OriginalBottom_Jeans', 'bottom'],
    ['OriginalOuter_Jacket', 'outerwear'], ['OriginalAccent_Trim', 'accent'], ['OriginalShoes_CasualJeans', 'shoes'],
  ] as const)('only uses the explicit matching zone for %s', (name, zone) => {
    const material = new MeshStandardMaterial({ name, color: '#a4b5c6' });
    tintOriginalGarmentMaterial(material, { [zone]: '#123456' });
    expect(material.color.getHexString()).toBe('123456');
    tintOriginalGarmentMaterial(material, zone === 'top' ? {} : { top: '#ff0000' });
    expect(material.color.getHexString()).toBe('a4b5c6');
  });

  it('does not interpret style names as tints or alter the Office material palette path', () => {
    const outer = new MeshStandardMaterial({ name: 'OriginalOuter_Jacket', color: '#b4a392' });
    tintOriginalGarmentMaterial(outer, { outerwear: 'coat' });
    expect(outer.color.getHexString()).toBe('b4a392');
    const office = new MeshStandardMaterial({ name: 'OfficeTop_Shirt', color: '#f0e0d0' });
    expect(tintOriginalGarmentMaterial(office, { top: '#000000' })).toBe(false);
    expect(office.color.getHexString()).toBe('f0e0d0');
  });
  it.each(['reception-uniform', 'bartender-uniform'])('preserves authored uniform colours despite the fixed role palette for %s', model => {
    const clothing = { model, top: '#f3f0e8', bottom: '#1d2230', outerwear: '#1d2230', accent: '#10b9ac' };
    for (const zone of ['Top', 'Bottom', 'Outer']) {
      const material = new MeshStandardMaterial({ name: `Original${zone}_Uniform`, color: '#b6b0a8', map: new Texture() });
      const map = material.map;
      expect(tintOriginalGarmentMaterial(material, clothing)).toBe(true);
      expect(material.color.getHexString()).toBe('b6b0a8');
      expect(material.map).toBe(map);
    }
    const accent = new MeshStandardMaterial({ name: 'OriginalAccent_Uniform', color: '#c0b0a0' });
    tintOriginalGarmentMaterial(accent, clothing);
    expect(accent.color.getHexString()).toBe('10b9ac');
  });

});
