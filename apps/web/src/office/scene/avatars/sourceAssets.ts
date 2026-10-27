import { getCharacterHairOptions, type CharacterHairAsset } from '@extalia/core';
import { presentationPreset, type AvatarModelVariant, type AvatarVisualConfig } from './appearance';

/**
 * Source-derived GLB models are local-only: they live in the git-ignored folder
 * `apps/web/local-assets/avatars/` (see README.md) and are never committed. The
 * globs resolve to an empty map when the folder does not exist, so a public
 * clone builds, tests and renders with the procedural character instead.
 */
const bodyUrls = import.meta.glob<string>('/local-assets/avatars/bodies/**/*.glb', { eager: true, query: '?url', import: 'default' });
const hairUrls = import.meta.glob<string>('/local-assets/avatars/hair/*/*.glb', { eager: true, query: '?url', import: 'default' });

type UrlMap = Readonly<Record<string, string>>;

/**
 * Development only: `?avatars=procedural` ignores the local models so renders that ship
 * (the splash loop, see docs/design/splash.md) never contain unlicensed source avatars.
 */
const proceduralOnly = import.meta.env.DEV && typeof location !== 'undefined'
  && new URLSearchParams(location.search).get('avatars') === 'procedural';

export function bodyGenderGroup(variant: AvatarModelVariant): 'male' | 'female' {
  return variant === 'business-woman' || variant === 'female-casual' ? 'female' : 'male';
}

/** Bundled URL of a local body model, or `undefined` when the local asset is absent. */
export function bodyAssetUrl(variant: AvatarModelVariant, urls: UrlMap = bodyUrls): string | undefined {
  const gender = bodyGenderGroup(variant);
  return urls[`/local-assets/avatars/bodies/${gender}/${variant}.glb`]
    ?? urls[`/local-assets/avatars/bodies/${variant}.glb`];
}

/** Bundled URL of a local hair model (the detailed one when present), or `undefined` when absent. */
export function hairAssetUrl(asset: CharacterHairAsset, urls: UrlMap = hairUrls): string | undefined {
  return detailedHairUrl(asset, urls) ?? urls[`/local-assets/avatars/hair/${asset.group}/${asset.assetKey}.glb`];
}

/** The detailed (hair-card) model of a style, when present locally. */
export function detailedHairUrl(asset: CharacterHairAsset, urls: UrlMap = hairUrls): string | undefined {
  return asset.detail ? urls[`/local-assets/avatars/hair/${asset.group}/${asset.detail.assetKey}.glb`] : undefined;
}

/**
 * Bodies whose head is a face shell without a skull (the light hair meshes cover it). Detailed
 * hair needs a whole head, so these looks wear it on the same-gender body that has one.
 */
const PARTIAL_HEAD_BODIES: Readonly<Partial<Record<AvatarModelVariant, AvatarModelVariant>>> = { 'business-woman': 'female-casual' };

export interface SourceAvatarUrls { body: string; hair: string }

/**
 * URLs needed by `SourceHumanoid` for one look. Returns `undefined` unless both the body and the
 * hair model are present locally, in which case the caller renders the procedural character.
 */
export function sourceAvatarUrls(
  visual: Pick<AvatarVisualConfig, 'presentation' | 'modelVariant'>, hair: CharacterHairAsset,
  bodies: UrlMap = bodyUrls, hairs: UrlMap = hairUrls,
): SourceAvatarUrls | undefined {
  if (proceduralOnly) return undefined;
  const variant = visual.modelVariant ?? (presentationPreset(visual.presentation) === 'feminine' ? 'business-woman' : 'office-classic');
  const detailed = detailedHairUrl(hair, hairs);
  const wholeHead = detailed ? PARTIAL_HEAD_BODIES[variant] : undefined;
  const body = (wholeHead && bodyAssetUrl(wholeHead, bodies)) || bodyAssetUrl(variant, bodies);
  const hairUrl = detailed ?? hairAssetUrl(hair, hairs) ?? groupHairUrl(hair, hairs);
  return body && hairUrl ? { body, hair: hairUrl } : undefined;
}

/** A style without a local model wears the group's first local style (detailed styles first). */
function groupHairUrl(hair: CharacterHairAsset, urls: UrlMap): string | undefined {
  for (const option of getCharacterHairOptions(hair.group === 'female' ? 'feminine' : 'masculine')) {
    const url = hairAssetUrl(option, urls);
    if (url) return url;
  }
  return undefined;
}

/**
 * The hair styles that have a local model, or `undefined` when no local hair is installed (the
 * procedural character then draws every style, so the editor offers them all).
 */
export function localHairStyles(urls: UrlMap = hairUrls): ReadonlySet<string> | undefined {
  if (proceduralOnly || Object.keys(urls).length === 0) return undefined;
  const styles = new Set<string>();
  for (const presentation of ['masculine', 'feminine'] as const) {
    for (const option of getCharacterHairOptions(presentation)) if (hairAssetUrl(option, urls)) styles.add(option.id);
  }
  return styles;
}
