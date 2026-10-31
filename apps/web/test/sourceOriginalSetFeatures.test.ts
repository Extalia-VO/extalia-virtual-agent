import { Group } from 'three';
import { describe, expect, it } from 'vitest';
import { originalSetFeatures, resolvedOriginalSetFeatures } from '../src/office/scene/avatars/sourceOriginalSetFeatures';

describe('source original full-set declarations', () => {
  it('replaces native eyewear only when the owning full garment actually binds', () => {
    const outfit = new Group(), child = new Group();
    child.userData.extaliaOwnEyewear = true; outfit.add(child);
    expect(resolvedOriginalSetFeatures(outfit, {}, {}).ownEyewear).toBe(true);
    expect(resolvedOriginalSetFeatures(undefined, { top: outfit }, { top: true }).ownEyewear).toBeUndefined();
    expect(resolvedOriginalSetFeatures(undefined, {}, {}).ownEyewear).toBeUndefined();
    const malformed = new Group(); malformed.userData.extaliaOwnEyewear = 'true';
    expect(originalSetFeatures(malformed).ownEyewear).toBeUndefined();
  });

  it('only accepts exact boolean feature flags and leaves legacy sets unchanged', () => {
    for (const value of [undefined, false, 'true', 1, {}, []]) {
      const scene = new Group();
      scene.userData.extaliaOwnNeckline = value;
      scene.userData.extaliaNativeFootwear = value;
      scene.userData.extaliaOwnHands = value;
      expect(originalSetFeatures(scene)).toEqual({ nativeFootwear: false, ownNeckline: false, ownHands: false });
    }
    expect(originalSetFeatures(new Group())).toEqual({ nativeFootwear: false, ownNeckline: false, ownHands: false });
  });

  it('reads declarations from actual multi-material source nodes and caches them per asset', () => {
    const scene = new Group(), clothing = new Group(), child = new Group();
    clothing.userData.extaliaOwnNeckline = true;
    child.userData.extaliaNativeFootwear = true;
    child.userData.extaliaOwnHands = true;
    clothing.add(child); scene.add(clothing);
    const features = originalSetFeatures(scene);
    expect(features).toEqual({ nativeFootwear: true, ownNeckline: true, ownHands: true });
    expect(originalSetFeatures(scene)).toBe(features);
    expect(originalSetFeatures(new Group())).toEqual({ nativeFootwear: false, ownNeckline: false, ownHands: false });
  });
  it('uses the neckline of successfully bound tops/outers and keeps native backing on failed layers', () => {
    const top = new Group(), outer = new Group();
    top.userData.extaliaOwnNeckline = true; top.userData.extaliaNativeFootwear = true;
    outer.userData.extaliaOwnNeckline = true;
    expect(resolvedOriginalSetFeatures(undefined, { top, outer }, {})).toEqual({ ownNeckline: false, nativeFootwear: false, ownHands: false });
    expect(resolvedOriginalSetFeatures(undefined, { top, outer }, { top: false, outer: false })).toEqual({ ownNeckline: false, nativeFootwear: false, ownHands: false });
    expect(resolvedOriginalSetFeatures(undefined, { top }, { top: true })).toEqual({ ownNeckline: true, nativeFootwear: false, ownHands: false });
    expect(resolvedOriginalSetFeatures(undefined, { outer }, { outer: true })).toEqual({ ownNeckline: true, nativeFootwear: false, ownHands: false });
    expect(resolvedOriginalSetFeatures(undefined, {}, { outer: true })).toEqual({ ownNeckline: false, nativeFootwear: false, ownHands: false });
    const full = new Group(); full.userData.extaliaNativeFootwear = true;
    expect(resolvedOriginalSetFeatures(full, { top }, { top: true })).toEqual({ ownNeckline: true, nativeFootwear: true, ownHands: false });
  });

  it('replaces native hands only for a successfully bound full set, never a failed set or piece', () => {
    const outfit = new Group(), top = new Group(), outer = new Group();
    for (const scene of [outfit, top, outer]) scene.userData.extaliaOwnHands = true;
    expect(resolvedOriginalSetFeatures(outfit, {}, {}).ownHands).toBe(true);
    // SourceHumanoid passes undefined when a requested full outfit fails to bind.
    expect(resolvedOriginalSetFeatures(undefined, {}, {}).ownHands).toBe(false);
    expect(resolvedOriginalSetFeatures(undefined, { top, outer }, { top: true, outer: true }).ownHands).toBe(false);
    expect(resolvedOriginalSetFeatures(undefined, { top, outer }, { top: false, outer: false }).ownHands).toBe(false);
  });
});
