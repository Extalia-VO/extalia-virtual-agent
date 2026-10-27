import type { CharacterAppearance, CharacterHairStyle } from '@extalia/core';
import { avatarVisual, lookSeed, resolvedAppearance, type LookIdentity } from '../scene/avatars/appearance';
import { resolveWardrobe, type ResolvedWardrobe } from '../scene/avatars/wardrobe';

/** Hair silhouettes of the 2D portrait (viewBox 44 x 50), contoured to hug the head and temples without gaps. */
export const PORTRAIT_HAIR_PATHS = {
  'short-fade': 'M 13.4 18.5 C 12.8 10.5 16.5 6.2 22 6.2 C 27.5 6.2 31.2 10.5 30.6 18.5 L 29.5 15 C 28 12.8 25.2 12 22 12 C 18.8 12 16 12.8 14.5 15 Z',
  'slicked-back': 'M 13.2 18.5 C 12.5 9.5 16.2 5.4 22 5.4 C 28.2 5.4 31.5 9.5 30.8 18.5 L 29.4 14.5 C 27.2 11.8 24.8 11.2 22 11.2 C 19.2 11.2 16.8 11.8 14.6 14.5 Z',
  'side-part': 'M 13.2 18.5 C 12.4 9.5 16.2 5.8 22.8 5.8 C 28.2 5.8 31.4 9.5 30.8 18.5 L 29.4 14.8 C 27.5 12.5 25.5 11.5 23.8 10.8 C 21.2 13.5 17.5 14.2 14.5 15.5 Z',
  undercut: 'M 13.5 18 C 13.2 14 13.8 10 15 7.5 C 16.5 4.8 23.5 4.2 28.2 6.2 C 30.5 7.2 31.2 10.5 30.5 18 L 29.4 14.8 C 27.5 12.6 24.5 12 21.5 12.4 C 18 12.8 15.2 14.2 14.4 15.8 Z',
  'textured-crop': 'M 13.2 18 C 12.6 11 15 6.5 18.5 5.6 C 20.5 4.8 23.5 4.8 25.8 5.6 C 29.2 6.5 31.4 11 30.8 18 L 29.2 15 C 27 13.6 24.5 13.2 22 13.5 C 19.5 13.2 17 13.6 14.8 15 Z',
  'shoulder-bob': 'M 12.2 28 C 11.2 22 11.5 14 13.2 9.5 C 15 5.8 18.2 5.2 22 5.2 C 25.8 5.2 29 5.8 30.8 9.5 C 32.5 14 32.8 22 31.8 28 L 29.6 26.5 C 30 21 29.8 16.5 29 14.2 C 27 12.2 24.5 11.6 22 12 C 19.5 11.6 17 12.2 15 14.2 C 14.2 16.5 14 21 14.4 26.5 Z',
  'executive-medium': 'M 12.4 25.5 C 11.6 19 12 12 14 8.2 C 16 5.6 18.8 5.2 22 5.2 C 25.2 5.2 28 5.6 30 8.2 C 32 12 32.4 19 31.6 25.5 L 29.5 24.5 C 29.8 19.5 29.5 16 28.8 14 C 26.8 11.8 24.2 11.4 21.5 12.2 C 18.5 12.8 16.2 13.5 15.2 14.8 C 14.5 16.8 14.2 19.8 14.5 24.5 Z',
  curly: 'M 12.4 19 C 10.2 16.5 10.8 12.5 12.8 10.2 C 12.5 7 15.2 5 18.2 5.4 C 19.8 3.4 24.2 3.4 25.8 5.4 C 28.8 5 31.5 7 31.2 10.2 C 33.2 12.5 33.8 16.5 31.6 19 L 29.5 15.2 C 27.8 12.8 25 12 22 12.4 C 19 12 16.2 12.8 14.5 15.2 Z',
  ponytail: 'M 13.2 18.5 C 12.6 10 16.4 5.6 22 5.6 C 27.6 5.6 31.4 10 30.8 18.5 L 29.4 14.6 C 27.6 12 25 11.4 22 11.6 C 19 11.4 16.4 12 14.6 14.6 Z M 28.5 8.5 C 32.5 7 35.8 10.5 36.2 16 C 36.5 21 34.8 25.5 32.8 28 C 33.2 22.5 32.5 16.5 29.8 12.5 Z',
  wavy: 'M 11.8 32 C 10.5 26 11.2 19 12.4 13 C 13.5 7.5 17 5 22 5 C 27 5 30.5 7.5 31.6 13 C 32.8 19 33.5 26 32.2 32 L 29.6 30.5 C 30.2 25 29.8 19 29 14.5 C 27.2 12 24.5 11.4 21.5 11.8 C 18.5 12.2 16.2 13 15 14.8 C 14.2 19 13.8 25 14.4 30.5 Z',
  afro: 'M 11.5 20.5 C 8.2 19 7.5 14.5 9.8 11.2 C 8.8 7.2 12 4.2 15.8 4.6 C 18 1.8 26 1.8 28.2 4.6 C 32 4.2 35.2 7.2 34.2 11.2 C 36.5 14.5 35.8 19 32.5 20.5 L 29.8 15.2 C 28 12.4 25.2 11.6 22 11.6 C 18.8 11.6 16 12.4 14.2 15.2 Z',
} as const;
export type PortraitHairShape = keyof typeof PORTRAIT_HAIR_PATHS;

/** Portrait silhouette per saved hair style; each follows the same mesh the 3D character uses. */
const HAIR_SHAPES: Readonly<Record<CharacterHairStyle, PortraitHairShape>> = {
  long: 'wavy', wavy: 'wavy', ponytail: 'ponytail', 'high-ponytail': 'ponytail',
  // The 3D character falls back to the bob mesh for the legacy bun.
  bun: 'shoulder-bob', bob: 'shoulder-bob', medium: 'executive-medium',
  curly: 'curly', afro: 'afro', 'textured-crop': 'textured-crop', 'side-part': 'side-part',
  'short-fade': 'short-fade', undercut: 'undercut', 'slicked-back': 'slicked-back',
};

export function portraitHairShape(style: CharacterHairStyle): PortraitHairShape {
  return HAIR_SHAPES[style] ?? 'executive-medium';
}

/** Hair drawn behind the shoulders and neck. */
const BACK_HAIR: ReadonlySet<PortraitHairShape> = new Set(['shoulder-bob', 'executive-medium', 'wavy', 'ponytail']);

export interface PortraitModel {
  presentation: CharacterAppearance['presentation'];
  skin: string;
  hair: string;
  hairShape: PortraitHairShape;
  backHair: boolean;
  /** Visible garment: the outer layer when there is one, otherwise the top. */
  garment: string;
  top: string;
  accent: string;
  neckline: ResolvedWardrobe['neckline'];
  hasLayer: boolean;
  tie: boolean;
  glasses: CharacterAppearance['accessories']['glasses'];
  earrings: CharacterAppearance['accessories']['earrings'];
  headphones: boolean;
  badge: boolean;
}

/**
 * What the 2D portrait draws for a character: its saved look, or the look
 * generated from its full name (`identity`) or presence id — the same one the
 * 3D character shows.
 */
export function portraitModel(id: string, appearance?: CharacterAppearance, identity?: LookIdentity): PortraitModel {
  const look = resolvedAppearance(id, appearance, identity);
  const wardrobe = resolveWardrobe(avatarVisual(lookSeed(id, identity), look), 0);
  const hairShape = portraitHairShape(look.hairStyle);
  return {
    presentation: look.presentation,
    skin: look.skinTone,
    hair: look.hairColor,
    hairShape,
    backHair: BACK_HAIR.has(hairShape),
    garment: wardrobe.layer === 'none' ? wardrobe.top : wardrobe.jacket,
    top: wardrobe.top,
    accent: wardrobe.accent,
    neckline: wardrobe.neckline,
    hasLayer: wardrobe.layer !== 'none',
    tie: wardrobe.tie,
    glasses: look.accessories.glasses,
    earrings: look.accessories.earrings,
    headphones: look.accessories.headphones,
    badge: look.accessories.badge,
  };
}
