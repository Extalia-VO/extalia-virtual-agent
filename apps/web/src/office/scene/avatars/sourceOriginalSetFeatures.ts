import type { Group } from 'three';

export interface OriginalSetFeatures { nativeFootwear: boolean; ownNeckline: boolean; ownHands: boolean; ownEyewear?: true }
const cache = new WeakMap<Group, OriginalSetFeatures>();

/** Original garments explicitly declare which native backing they replace. */
export function originalSetFeatures(scene: Group): OriginalSetFeatures {
  const cached = cache.get(scene);
  if (cached) return cached;
  const features: OriginalSetFeatures = { nativeFootwear: false, ownNeckline: false, ownHands: false };
  // Multi-material glTF node extras can sit on a parent group rather than each primitive.
  scene.traverse(node => {
    if (node.userData.extaliaNativeFootwear === true) features.nativeFootwear = true;
    if (node.userData.extaliaOwnNeckline === true) features.ownNeckline = true;
    if (node.userData.extaliaOwnHands === true) features.ownHands = true;
    if (node.userData.extaliaOwnEyewear === true) features.ownEyewear = true;
  });
  cache.set(scene, features);
  return features;
}

/** Only successfully bound layers may replace the native neckline backing. */
export function resolvedOriginalSetFeatures(
  fullSet: Group | undefined,
  pieces: Partial<Record<'top' | 'outer', Group>>,
  loaded: Readonly<Partial<Record<'top' | 'outer', boolean>>>,
): OriginalSetFeatures {
  const full = fullSet ? originalSetFeatures(fullSet) : undefined;
  return {
    nativeFootwear: full?.nativeFootwear === true,
    // Gloves replace native hands only as part of a successfully bound complete set.
    ownHands: full?.ownHands === true,
    ...(full?.ownEyewear === true ? { ownEyewear: true as const } : {}),
    ownNeckline: full?.ownNeckline === true
      || loaded.top === true && pieces.top !== undefined && originalSetFeatures(pieces.top).ownNeckline
      || loaded.outer === true && pieces.outer !== undefined && originalSetFeatures(pieces.outer).ownNeckline,
  };
}
