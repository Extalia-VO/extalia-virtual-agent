import { getCharacterHairOptions, type CharacterHairAsset } from '@extalia/core';
import { presentationPreset, type AvatarModelVariant, type AvatarVisualConfig } from './appearance';

// Vite selects public Blender models; explicit local development adds private fallback files.
import { bodyUrls, hairUrls } from './sourceAvatarFiles';

type UrlMap = Readonly<Record<string, string>>;

export function bodyGenderGroup(variant: AvatarModelVariant): 'male' | 'female' {
  return variant === 'business-woman' || variant === 'female-casual' ? 'female' : 'male';
}

/** Bundled URL of a public Blender body, with a private fallback in local development. */
export function bodyAssetUrl(variant: AvatarModelVariant, urls: UrlMap = bodyUrls): string | undefined {
  return publicBodyUrl(variant, urls) ?? bodyUrl('/local-assets', variant, urls);
}

function bodyUrl(root: string, variant: AvatarModelVariant, urls: UrlMap): string | undefined {
  return urls[`${root}/avatars/bodies/${bodyGenderGroup(variant)}/${variant}.glb`]
    ?? urls[`${root}/avatars/bodies/${variant}.glb`];
}

function publicBodyUrl(variant: AvatarModelVariant, urls: UrlMap): string | undefined {
  return bodyUrl('/public-assets', variant, urls);
}

/** Prefer every public hair style over private fallback models, including private detailed hair. */
export function hairAssetUrl(asset: CharacterHairAsset, urls: UrlMap = hairUrls): string | undefined {
  return hairUrl('/public-assets', asset, urls) ?? hairUrl('/local-assets', asset, urls);
}

function hairUrl(root: string, asset: CharacterHairAsset, urls: UrlMap): string | undefined {
  return detailUrl(root, asset, urls) ?? urls[`${root}/avatars/hair/${asset.group}/${asset.assetKey}.glb`]
    ?? urls[`${root}/avatars/hair/shared/${asset.assetKey}.glb`];
}

function detailUrl(root: string, asset: CharacterHairAsset, urls: UrlMap): string | undefined {
  return asset.detail ? urls[`${root}/avatars/hair/${asset.group}/${asset.detail.assetKey}.glb`]
    ?? urls[`${root}/avatars/hair/shared/${asset.detail.assetKey}.glb`] : undefined;
}

/** Detailed hair is optional: the public primary style always takes precedence over private files. */
export function detailedHairUrl(asset: CharacterHairAsset, urls: UrlMap = hairUrls): string | undefined {
  return detailUrl('/public-assets', asset, urls)
    ?? (hairUrl('/public-assets', asset, urls) ? undefined : detailUrl('/local-assets', asset, urls));
}

/**
 * Bodies whose head is a face shell without a skull (the light hair meshes cover it). Detailed
 * hair needs a whole head, so these looks wear it on the same-gender body that has one.
 */
const PARTIAL_HEAD_BODIES: Readonly<Partial<Record<AvatarModelVariant, AvatarModelVariant>>> = { 'business-woman': 'female-casual' };

export interface SourceAvatarUrls { body: string; hair: string }

/**
 * URLs needed by `SourceHumanoid` for one look. Returns `undefined` unless both the body and the
 * hair model are present. Missing or failed assets retain the procedural error fallback.
 */
export function sourceAvatarUrls(
  visual: Pick<AvatarVisualConfig, 'presentation' | 'modelVariant'>, hair: CharacterHairAsset,
  bodies: UrlMap = bodyUrls, hairs: UrlMap = hairUrls,
): SourceAvatarUrls | undefined {
  const variant = visual.modelVariant ?? (presentationPreset(visual.presentation) === 'feminine' ? 'business-woman' : 'office-classic');
  const detailed = detailedHairUrl(hair, hairs);
  // The public business-woman variant aliases the complete female-casual body.
  // Keep the original whole-head substitution for any individually supplied source variant.
  const wholeHead = detailed ? PARTIAL_HEAD_BODIES[variant] : undefined;
  const body = (wholeHead && bodyAssetUrl(wholeHead, bodies)) || bodyAssetUrl(variant, bodies);
  const hairUrl = hairAssetUrl(hair, hairs) ?? groupHairUrl(hair, hairs);
  return body && hairUrl ? { body, hair: hairUrl } : undefined;
}

/** An unavailable style wears the group's first available Blender style. */
function groupHairUrl(hair: CharacterHairAsset, urls: UrlMap): string | undefined {
  for (const option of getCharacterHairOptions(hair.group === 'female' ? 'feminine' : 'masculine')) {
    const url = hairAssetUrl(option, urls);
    if (url) return url;
  }
  return undefined;
}

/**
 * Blender hair styles available to the shared appearance editor. An unavailable model set
 * leaves the full catalog visible while the character uses its error fallback.
 */
export function localHairStyles(urls: UrlMap = hairUrls): ReadonlySet<string> | undefined {
  if (Object.keys(urls).length === 0) return undefined;
  const styles = new Set<string>();
  for (const presentation of ['masculine', 'feminine'] as const) {
    for (const option of getCharacterHairOptions(presentation)) if (hairAssetUrl(option, urls)) styles.add(option.id);
  }
  return styles;
}
