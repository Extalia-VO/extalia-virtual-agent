import type { CharacterHairStyle, CharacterPresentation } from './characterAppearance.js';

export type CharacterHairGroup = 'male' | 'female';
export type CharacterHairWarning = 'legacy-bun' | 'unknown-style';

export interface CharacterHairAsset {
  id: CharacterHairStyle;
  mesh: string;
  group: CharacterHairGroup;
  /** File key for `assets/hair/<group>/<assetKey>.glb`. */
  assetKey: string;
  /** Legacy values may intentionally resolve to a supported replacement. */
  fallback: boolean;
  /** Legacy ids that should load the aliased mesh without adding a duplicate UI option. */
  aliasOf?: CharacterHairStyle;
  warning?: CharacterHairWarning;
  /**
   * A detailed (hair-card) version of the style, `assets/hair/<group>/<assetKey>.glb`, used in
   * place of the light mesh when it is present locally.
   */
  detail?: { assetKey: string; mesh: string };
}

const assets: Readonly<Record<CharacterHairStyle, CharacterHairAsset>> = {
  'short-fade': { id: 'short-fade', mesh: 'Hair_short_fade', group: 'male', assetKey: 'short-fade', fallback: false,
    detail: { assetKey: 'short-fade-detail', mesh: 'Hair_detail_short_fade' } },
  'slicked-back': { id: 'slicked-back', mesh: 'Hair_slicked_back', group: 'male', assetKey: 'slicked-back', fallback: false,
    detail: { assetKey: 'slicked-back-detail', mesh: 'Hair_detail_slicked_back' } },
  'side-part': { id: 'side-part', mesh: 'Hair_side_part', group: 'male', assetKey: 'side-part', fallback: false,
    detail: { assetKey: 'side-part-detail', mesh: 'Hair_detail_side_part' } },
  undercut: { id: 'undercut', mesh: 'Hair_undercut', group: 'male', assetKey: 'undercut', fallback: false,
    detail: { assetKey: 'undercut-detail', mesh: 'Hair_detail_undercut' } },
  'textured-crop': { id: 'textured-crop', mesh: 'Hair_textured_crop', group: 'male', assetKey: 'textured-crop', fallback: false,
    detail: { assetKey: 'textured-crop-detail', mesh: 'Hair_detail_textured_crop' } },
  curly: { id: 'curly', mesh: 'Hair_curly', group: 'male', assetKey: 'curly', fallback: false },
  afro: { id: 'afro', mesh: 'Hair_afro', group: 'male', assetKey: 'afro', fallback: false },
  bob: { id: 'bob', mesh: 'Hair_shoulder_bob', group: 'female', assetKey: 'bob', fallback: false,
    detail: { assetKey: 'bob-detail', mesh: 'Hair_detail_bob' } },
  wavy: { id: 'wavy', mesh: 'Hair_wavy', group: 'female', assetKey: 'wavy', fallback: false },
  long: { id: 'long', mesh: 'Hair_wavy', group: 'female', assetKey: 'wavy', fallback: false, aliasOf: 'wavy' },
  ponytail: { id: 'ponytail', mesh: 'Hair_ponytail', group: 'female', assetKey: 'ponytail', fallback: false,
    detail: { assetKey: 'ponytail-detail', mesh: 'Hair_detail_ponytail' } },
  'high-ponytail': { id: 'high-ponytail', mesh: 'Hair_high_ponytail', group: 'female', assetKey: 'high-ponytail', fallback: false,
    detail: { assetKey: 'high-ponytail-detail', mesh: 'Hair_detail_high_ponytail' } },
  medium: { id: 'medium', mesh: 'Hair_executive_medium', group: 'female', assetKey: 'medium', fallback: false,
    detail: { assetKey: 'medium-detail', mesh: 'Hair_detail_medium' } },
  // A real style again: the detailed bun when present, else the light bob mesh.
  bun: { id: 'bun', mesh: 'Hair_shoulder_bob', group: 'female', assetKey: 'bob', fallback: false,
    detail: { assetKey: 'bun-detail', mesh: 'Hair_detail_bun' } },
};

const presentationGroup: Readonly<Record<CharacterPresentation, CharacterHairGroup>> = {
  masculine: 'male',
  feminine: 'female',
};

/** The styles of the character's own presentation (male or female hair), detailed styles first. */
export function getCharacterHairOptions(presentation: CharacterPresentation): CharacterHairAsset[] {
  const group = presentationGroup[presentation];
  return Object.values(assets).filter(option => !option.aliasOf && !option.fallback && option.group === group)
    .sort((a, b) => Number(Boolean(b.detail)) - Number(Boolean(a.detail)) || a.id.localeCompare(b.id))
    .map(option => ({ ...option }));
}

/** Resolve saved styles to a real source mesh, preserving legacy ids for storage. */
export function resolveCharacterHair(style: CharacterHairStyle | string, presentation?: CharacterPresentation): CharacterHairAsset {
  if (Object.hasOwn(assets, style)) return { ...assets[style as CharacterHairStyle] };
  if (presentation === 'masculine') {
    return { id: 'side-part', mesh: 'Hair_side_part', group: 'male', assetKey: 'side-part', fallback: true, warning: 'unknown-style' };
  }
  return { id: 'medium', mesh: 'Hair_executive_medium', group: 'female', assetKey: 'medium', fallback: true, warning: 'unknown-style' };
}
