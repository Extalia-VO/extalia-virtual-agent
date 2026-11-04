/**
 * Hair that Extalia renders: the detailed GLB hair-card models of each gender group. Procedural
 * hair is no longer chosen for anyone; a saved style without a detailed model (curly, afro,
 * wavy, long) is shown with its nearest detailed model while the saved value stays untouched.
 * Renderer-independent (no three.js).
 */
import {
  getCharacterHairOptions, resolveCharacterHair,
  type CharacterHairAsset, type CharacterHairStyle, type CharacterPresentation,
} from '@extalia/core';

/** Detailed hair styles of a presentation's own group (bob, bun, high-ponytail, ... / short-fade, ...). */
export function detailedHairStyles(presentation: CharacterPresentation): CharacterHairStyle[] {
  return getCharacterHairOptions(presentation).filter(option => option.detail).map(option => option.id);
}

/** Nearest detailed model of styles that only had a light or procedural mesh. */
export const LEGACY_HAIR_MAP: Readonly<Partial<Record<string, CharacterHairStyle>>> = {
  curly: 'textured-crop', afro: 'textured-crop', wavy: 'medium', long: 'medium',
};

/** The style a saved or generated hair value is drawn with: always one that has a detailed GLB. */
export function glbHairStyle(style: CharacterHairStyle | string, presentation: CharacterPresentation): CharacterHairStyle {
  const mapped = LEGACY_HAIR_MAP[style] ?? style;
  const asset: CharacterHairAsset = resolveCharacterHair(mapped, presentation);
  // An unknown value resolves to its group's default style, which has a detailed model.
  if (asset.detail || resolveCharacterHair(asset.id, presentation).detail) return asset.id;
  return detailedHairStyles(asset.group === 'female' ? 'feminine' : 'masculine')[0] ?? asset.id;
}
