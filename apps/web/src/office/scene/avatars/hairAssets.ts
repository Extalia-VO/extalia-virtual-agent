import { resolveCharacterHair, type CharacterHairAsset } from '@extalia/core';
import { presentationPreset, type AvatarVisualConfig } from './appearance';
import { glbHairStyle } from './hairCatalog';

export function sourceHairAsset(visual: AvatarVisualConfig): CharacterHairAsset {
  const presentation = presentationPreset(visual.presentation);
  const style = visual.hairVariant ?? (presentation === 'feminine' ? 'bob' : presentation === 'masculine' ? 'side-part' : 'medium');
  const aliases: Record<string, string> = { 'shoulder-bob': 'bob', 'executive-medium': 'medium', 'source-native': presentation === 'feminine' ? 'high-ponytail' : 'side-part' };
  // Styles without a detailed model (curly, afro, wavy, long) wear their nearest detailed one.
  return resolveCharacterHair(glbHairStyle(aliases[style] ?? style, presentation), presentation);
}
