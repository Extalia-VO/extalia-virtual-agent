import type { Group, Mesh } from 'three';
import type { LoadedWardrobeParts, WardrobePartSlot } from './sourceWardrobeGeometry';
import { isFootwearMaterialName } from './sourceNativeFootwear';

/** Each piece is independently wearable; a missing top never suppresses a selected outer. */
export function attachWardrobePieces(
  pieces: Partial<Record<WardrobePartSlot, Group>>,
  attach: (slot: WardrobePartSlot, scene: Group) => boolean,
): LoadedWardrobeParts {
  const loaded: Partial<Record<WardrobePartSlot, boolean>> = {};
  for (const slot of ['top', 'bottom', 'outer'] as const) {
    const scene = pieces[slot];
    if (scene && attach(slot, scene)) loaded[slot] = true;
  }
  return loaded;
}

const footwearCache = new WeakMap<Group, boolean>();

/** Original separates may intentionally reuse the body's corrected shoes and ankles. */
export function wardrobePieceHasFootwear(scene: Group): boolean {
  if (footwearCache.has(scene)) return footwearCache.get(scene)!;
  let footwear = false;
  scene.traverse(node => {
    const mesh = node as Mesh;
    if (mesh.isMesh && (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).some(material => isFootwearMaterialName(material.name))) footwear = true;
  });
  footwearCache.set(scene, footwear);
  return footwear;
}
