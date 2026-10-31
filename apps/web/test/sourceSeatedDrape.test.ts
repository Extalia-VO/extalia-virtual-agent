import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, MeshStandardMaterial, SkinnedMesh } from 'three';
import { applySeatedDrape, copyFittedMorphTargets, seatedDrapeBindings, SEATED_DRAPE_MORPH, SEATED_DRAPE_TALL_MORPH, SEATED_DRAPE_SHORT_MORPH } from '../src/office/scene/avatars/sourceSeatedDrape';

function fixture(name = 'OriginalBottom_P0S1') {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0, 1, .2], 3));
  geometry.morphTargetsRelative = true;
  geometry.morphAttributes.position = [new Float32BufferAttribute([0, -.2, .1], 3)];
  const material = new MeshStandardMaterial(); material.name = name;
  const source = new SkinnedMesh(geometry, material);
  source.morphTargetDictionary = { [SEATED_DRAPE_MORPH]: 0 };
  return { source, geometry, material };
}

describe('source seated cloth corrective', () => {
  it('interpolates a separately authored short profile only below the standard height', () => {
    const { source, geometry, material } = fixture();
    geometry.morphAttributes.position!.push(new Float32BufferAttribute([0, -.1, .08], 3));
    source.updateMorphTargets();
    source.morphTargetDictionary = { [SEATED_DRAPE_MORPH]: 0, [SEATED_DRAPE_SHORT_MORPH]: 1 };
    const bindings = seatedDrapeBindings([source]);
    applySeatedDrape(bindings, 1, 1.45); expect(source.morphTargetInfluences).toEqual([0, 1]);
    applySeatedDrape(bindings, .6, 1.575);
    expect(source.morphTargetInfluences?.[0]).toBeCloseTo(.3);
    expect(source.morphTargetInfluences?.[1]).toBeCloseTo(.3);
    applySeatedDrape(bindings, 1, 1.95); expect(source.morphTargetInfluences).toEqual([1, 0]);
    applySeatedDrape(bindings, 0, 1.45); expect(source.morphTargetInfluences).toEqual([0, 0]);
    geometry.dispose(); material.dispose();
  });

  it('interpolates separately baked tall cloth without doubling its displacement', () => {
    const { source, geometry, material } = fixture();
    geometry.morphAttributes.position!.push(new Float32BufferAttribute([0, -.3, .15], 3));
    source.updateMorphTargets();
    source.morphTargetDictionary = { [SEATED_DRAPE_MORPH]: 0, [SEATED_DRAPE_TALL_MORPH]: 1 };
    const bindings = seatedDrapeBindings([source]);
    applySeatedDrape(bindings, 1, 1.7); expect(source.morphTargetInfluences).toEqual([1, 0]);
    applySeatedDrape(bindings, .6, 1.825);
    expect(source.morphTargetInfluences?.[0]).toBeCloseTo(.3);
    expect(source.morphTargetInfluences?.[1]).toBeCloseTo(.3);
    applySeatedDrape(bindings, 1, 1.95); expect(source.morphTargetInfluences).toEqual([0, 1]);
    applySeatedDrape(bindings, 1, 1.45); expect(source.morphTargetInfluences).toEqual([1, 0]);
    applySeatedDrape(bindings, 0, 1.95); expect(source.morphTargetInfluences).toEqual([0, 0]);
    geometry.dispose(); material.dispose();
  });

  it('copies GLTF target names and isolates influences across character instances', () => {
    const { source, geometry, material } = fixture();
    const first = new SkinnedMesh(geometry, material), second = new SkinnedMesh(geometry, material);
    copyFittedMorphTargets(source, first); copyFittedMorphTargets(source, second);
    const bindings = seatedDrapeBindings([first]);
    applySeatedDrape(bindings, 1);
    expect(first.morphTargetInfluences).toEqual([1]);
    expect(source.morphTargetInfluences).toEqual([0]);
    expect(second.morphTargetInfluences).toEqual([0]);
    expect(first.morphTargetDictionary).not.toBe(source.morphTargetDictionary);
    applySeatedDrape(bindings, .4); expect(first.morphTargetInfluences).toEqual([.4]);
    applySeatedDrape(bindings, 0); expect(first.morphTargetInfluences).toEqual([0]);
    expect(Array.from(geometry.getAttribute('position').array)).toEqual([0, 1, expect.closeTo(.2)]);
    geometry.dispose(); material.dispose();
  });

  it('does not drive body or unrelated morphs and bounds malformed seated inputs', () => {
    const cloth = fixture(), body = fixture('Skin_Body');
    expect(seatedDrapeBindings([body.source])).toEqual([]);
    const binding = seatedDrapeBindings([cloth.source]);
    for (const [sit, expected] of [[-1, 0], [2, 1], [NaN, 0], [Infinity, 0]]) {
      applySeatedDrape(binding, sit!); expect(cloth.source.morphTargetInfluences).toEqual([expected]);
    }
    cloth.source.morphTargetDictionary = { Smile: 0 };
    expect(seatedDrapeBindings([cloth.source])).toEqual([]);
    for (const item of [cloth, body]) { item.geometry.dispose(); item.material.dispose(); }
  });
});
