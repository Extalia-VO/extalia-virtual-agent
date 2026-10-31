import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, MeshStandardMaterial, SkinnedMesh } from 'three';
import { copyFittedMorphTargets } from '../src/office/scene/avatars/sourceSeatedDrape';
import { applyWalkDrape, walkDrapeBindings, WALK_DRAPE_MORPH } from '../src/office/scene/avatars/sourceWalkDrape';

function fixture(name = 'OriginalBottom_P0S1') {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0, 1, .2], 3));
  geometry.morphTargetsRelative = true;
  geometry.morphAttributes.position = [0, 1, 2].map(() => new Float32BufferAttribute([0, .02, .01], 3));
  const material = new MeshStandardMaterial(); material.name = name;
  const source = new SkinnedMesh(geometry, material);
  source.morphTargetDictionary = { ExtaliaSeatedDrape: 0, [WALK_DRAPE_MORPH]: 1, Smile: 2 };
  source.morphTargetInfluences = [.7, 0, .3];
  return { source, geometry, material };
}

describe('source walking cloth corrective', () => {
  it('hands the walking envelope over to the seated profile without changing other targets or source geometry', () => {
    const { source, geometry, material } = fixture();
    const bindings = walkDrapeBindings([source]);
    for (const [walk, sit, expected] of [[0, 0, 0], [1, 0, 1], [.8, .25, .6], [1, 1, 0], [0, 1, 0]]) {
      applyWalkDrape(bindings, walk!, sit!);
      expect(source.morphTargetInfluences?.[1]).toBeCloseTo(expected!);
      expect(source.morphTargetInfluences?.[0]).toBe(.7);
      expect(source.morphTargetInfluences?.[2]).toBe(.3);
    }
    expect(Array.from(geometry.getAttribute('position').array)).toEqual([0, 1, expect.closeTo(.2)]);
    geometry.dispose(); material.dispose();
  });

  it('does not drive body targets or invalid position morphs', () => {
    const body = fixture('Skin_Body'), cloth = fixture();
    expect(walkDrapeBindings([body.source])).toEqual([]);
    for (const index of [-1, .5, 99]) {
      cloth.source.morphTargetDictionary![WALK_DRAPE_MORPH] = index;
      expect(walkDrapeBindings([cloth.source])).toEqual([]);
    }
    cloth.source.morphTargetDictionary![WALK_DRAPE_MORPH] = 1;
    cloth.source.morphTargetDictionary!.Smile = 1;
    expect(walkDrapeBindings([cloth.source])).toEqual([]);
    cloth.source.morphTargetDictionary!.Smile = 2;
    cloth.geometry.morphAttributes.position![1] = new Float32BufferAttribute([0, 0, 0, 1, 1, 1], 3);
    expect(walkDrapeBindings([cloth.source])).toEqual([]);
    for (const item of [body, cloth]) { item.geometry.dispose(); item.material.dispose(); }
  });

  it('bounds malformed motion and keeps character instance influences independent', () => {
    const { source, geometry, material } = fixture();
    const first = new SkinnedMesh(geometry, material), second = new SkinnedMesh(geometry, material);
    copyFittedMorphTargets(source, first); copyFittedMorphTargets(source, second);
    const bindings = walkDrapeBindings([first]);
    for (const [walk, sit, expected] of [[2, -1, 1], [-1, 0, 0], [NaN, 0, 0], [Infinity, 0, 0], [1, NaN, 1], [1, 2, 0]]) {
      applyWalkDrape(bindings, walk!, sit!);
      expect(first.morphTargetInfluences?.[1]).toBe(expected);
      expect(second.morphTargetInfluences?.[1]).toBe(0);
      expect(source.morphTargetInfluences?.[1]).toBe(0);
    }
    geometry.dispose(); material.dispose();
  });
});
