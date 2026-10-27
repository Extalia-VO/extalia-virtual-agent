import { resolveCharacterHair, type CharacterHairAsset } from '@extalia/core';
import { presentationPreset, type AvatarVisualConfig } from './appearance';

export function sourceHairAsset(visual: AvatarVisualConfig): CharacterHairAsset {
  const presentation = presentationPreset(visual.presentation);
  const style = visual.hairVariant ?? (presentation === 'feminine' ? 'bob' : presentation === 'masculine' ? 'side-part' : 'medium');
  const aliases: Record<string, string> = { 'shoulder-bob': 'bob', 'executive-medium': 'medium', 'source-native': presentation === 'feminine' ? 'high-ponytail' : 'side-part' };
  return resolveCharacterHair(aliases[style] ?? style, presentation);
}
