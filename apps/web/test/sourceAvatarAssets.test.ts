import { getCharacterHairOptions, resolveCharacterHair } from '@extalia/core';
import { describe, expect, it } from 'vitest';
import { publicBodyAliases, reviewedPrivateAvatarFiles } from '../src/office/scene/avatars/publicAvatarFiles';
import { bodyAssetUrl, detailedHairUrl, hairAssetUrl, localHairStyles, sourceAvatarUrls } from '../src/office/scene/avatars/sourceAssets';

const bob = resolveCharacterHair('bob');
const bodies = {
  '/local-assets/avatars/bodies/office-classic.glb': 'office.glb',
  '/local-assets/avatars/bodies/business-woman.glb': 'woman.glb',
};
const hairs = { '/local-assets/avatars/hair/female/bob.glb': 'bob.glb' };

describe('Blender avatar asset resolution', () => {
  const publicBodies = publicBodyAliases({
    '/public-assets/avatars/bodies/male/office-classic.glb': 'public-office.glb',
    '/public-assets/avatars/bodies/female/female-casual.glb': 'public-casual.glb',
  });
  const hairOptions = [...getCharacterHairOptions('masculine'), ...getCharacterHairOptions('feminine')];
  const publicHairs = Object.fromEntries(hairOptions.filter(option => option.detail).map(option => {
    const key = option.detail!.assetKey;
    return [`/public-assets/avatars/hair/${option.group}/${key}.glb`, `public-${key}.glb`];
  }));

  it('aliases four outfit variants to two physical body models only when their source files exist', () => {
    expect(publicBodyAliases({})).toEqual({});
    expect(Object.keys(publicBodies)).toHaveLength(4);
    expect(new Set(Object.values(publicBodies)).size).toBe(2);
    expect(bodyAssetUrl('business-man', publicBodies)).toBe(bodyAssetUrl('office-classic', publicBodies));
    expect(bodyAssetUrl('business-woman', publicBodies)).toBe(bodyAssetUrl('female-casual', publicBodies));
    const oneBody = publicBodyAliases({ '/public-assets/avatars/bodies/male/office-classic.glb': 'office.glb' });
    expect(Object.keys(oneBody)).toHaveLength(2);
    expect(bodyAssetUrl('business-woman', oneBody)).toBeUndefined();
  });

  it('resolves every saved catalog look to Blender bodies and detailed hair using same-group fallbacks', () => {
    expect(hairOptions).toHaveLength(13);
    expect(Object.keys(publicHairs)).toHaveLength(10);
    for (const variant of ['office-classic', 'business-man', 'business-woman', 'female-casual'] as const) {
      for (const hair of hairOptions) {
        const urls = sourceAvatarUrls({ presentation: variant === 'business-woman' || variant === 'female-casual' ? 'feminine' : 'masculine', modelVariant: variant }, hair, publicBodies, publicHairs);
        expect(urls?.body, `${variant}/${hair.id}`).toBe(bodyAssetUrl(variant, publicBodies));
        expect(urls?.hair, `${variant}/${hair.id}`).toBeTruthy();
        expect(Object.values(publicHairs)).toContain(urls?.hair);
        if (hair.detail) expect(urls?.hair).toBe(`public-${hair.detail.assetKey}.glb`);
      }
    }
    expect([...localHairStyles(publicHairs)!].sort()).toEqual(hairOptions.filter(option => option.detail).map(option => option.id).sort());
    for (const style of ['curly', 'afro'] as const) {
      expect(sourceAvatarUrls({ presentation: 'masculine' }, resolveCharacterHair(style), publicBodies, publicHairs)?.hair).toBe('public-short-fade-detail.glb');
    }
    for (const style of ['wavy', 'long'] as const) {
      expect(sourceAvatarUrls({ presentation: 'feminine' }, resolveCharacterHair(style), publicBodies, publicHairs)?.hair).toBe('public-bob-detail.glb');
    }
  });

  it('always chooses public bodies and hair before private development fallbacks', () => {
    const privateDetail = { ...hairs, '/local-assets/avatars/hair/female/bob-detail.glb': 'private-detailed-bob.glb' };
    const mixedBodies = { ...bodies, ...publicBodies };
    const mixedHair = { ...privateDetail, ...publicHairs };
    expect(sourceAvatarUrls({ presentation: 'feminine', modelVariant: 'business-woman' }, bob, mixedBodies, mixedHair)).toEqual({ body: 'public-casual.glb', hair: 'public-bob-detail.glb' });
    expect(detailedHairUrl(bob, mixedHair)).toBe('public-bob-detail.glb');
    const publicDetailedHair = { ...mixedHair, '/public-assets/avatars/hair/female/bob-detail.glb': 'public-detailed-bob.glb' };
    expect(sourceAvatarUrls({ presentation: 'feminine', modelVariant: 'business-woman' }, bob, mixedBodies, publicDetailedHair)).toEqual({ body: 'public-casual.glb', hair: 'public-detailed-bob.glb' });
    expect(hairAssetUrl(bob, { '/public-assets/avatars/hair/shared/bob.glb': 'shared-bob.glb', ...privateDetail })).toBe('shared-bob.glb');
  });

  it('retains the error fallback when required model files are unavailable', () => {
    expect(bodyAssetUrl('office-classic', {})).toBeUndefined();
    expect(hairAssetUrl(bob, {})).toBeUndefined();
    expect(sourceAvatarUrls({ presentation: 'masculine' }, bob, {}, {})).toBeUndefined();
  });

  it('requires both the body and the hair model, otherwise the procedural character renders', () => {
    expect(sourceAvatarUrls({ presentation: 'feminine' }, bob, bodies, {})).toBeUndefined();
    expect(sourceAvatarUrls({ presentation: 'feminine' }, bob, {}, hairs)).toBeUndefined();
    expect(sourceAvatarUrls({ presentation: 'feminine' }, resolveCharacterHair('afro'), bodies, hairs)).toBeUndefined();
  });

  it('selects the body by presentation or explicit model variant', () => {
    expect(sourceAvatarUrls({ presentation: 'feminine' }, bob, bodies, hairs)).toEqual({ body: 'woman.glb', hair: 'bob.glb' });
    expect(sourceAvatarUrls({ presentation: 'masculine' }, bob, bodies, hairs)).toEqual({ body: 'office.glb', hair: 'bob.glb' });
    expect(sourceAvatarUrls({ presentation: 'masculine', modelVariant: 'business-woman' }, bob, bodies, hairs)?.body).toBe('woman.glb');
    expect(sourceAvatarUrls({ presentation: 'masculine', modelVariant: 'business-man' }, bob, bodies, hairs)).toBeUndefined();
  });

  it('prefers the detailed hair model and wears it on a body with a whole head', () => {
    const bun = resolveCharacterHair('bun');
    const withDetail = { ...hairs, '/local-assets/avatars/hair/female/bun-detail.glb': 'bun-detail.glb' };
    const withCasual = { ...bodies, '/local-assets/avatars/bodies/female-casual.glb': 'casual.glb' };
    // Without the detailed file the light mesh (bob) is used on the look's own body.
    expect(sourceAvatarUrls({ presentation: 'feminine' }, bun, withCasual, hairs)).toEqual({ body: 'woman.glb', hair: 'bob.glb' });
    // The business-woman head is a face shell: detailed hair moves the look to the whole-head female body.
    expect(sourceAvatarUrls({ presentation: 'feminine' }, bun, withCasual, withDetail)).toEqual({ body: 'casual.glb', hair: 'bun-detail.glb' });
    // Without that body, the look keeps its own body.
    expect(sourceAvatarUrls({ presentation: 'feminine' }, bun, bodies, withDetail)).toEqual({ body: 'woman.glb', hair: 'bun-detail.glb' });
    expect(hairAssetUrl(bun, withDetail)).toBe('bun-detail.glb');
  });

  it('loads the default asset module without throwing, whether or not local assets exist', () => {
    const urls = sourceAvatarUrls({ presentation: 'masculine' }, resolveCharacterHair('medium'));
    expect(urls === undefined || (typeof urls.body === 'string' && typeof urls.hair === 'string')).toBe(true);
  });

  it('dresses a style without a local model in the group\'s local detailed hair, and offers only local styles', () => {
    const detailedOnly = {
      '/local-assets/avatars/hair/male/textured-crop-detail.glb': 'crop.glb',
      '/local-assets/avatars/hair/female/high-ponytail-detail.glb': 'ponytail.glb',
    };
    expect(sourceAvatarUrls({ presentation: 'masculine' }, resolveCharacterHair('afro'), bodies, detailedOnly)?.hair).toBe('crop.glb');
    expect(sourceAvatarUrls({ presentation: 'feminine' }, bob, bodies, detailedOnly)?.hair).toBe('ponytail.glb');
    expect([...localHairStyles(detailedOnly) ?? []].sort()).toEqual(['high-ponytail', 'textured-crop']);
    // No local hair at all: the procedural character draws every style, so nothing is filtered.
    expect(localHairStyles({})).toBeUndefined();
  });
  it('resolves pieces per body and slot, preferring public files without hiding missing-slot fallbacks', () => {
    const pieces = {
      '/public-assets/avatars/wardrobe/female/top/tee.glb': 'female-tee.glb',
      '/local-assets/avatars/wardrobe/female/top/tee.glb': 'private-tee.glb',
      '/public-assets/avatars/wardrobe/male/bottom/jeans.glb': 'male-jeans.glb',
      '/public-assets/avatars/wardrobe/female/outer/vest.glb': 'female-vest.glb',
    };
    const urls = sourceAvatarUrls({ presentation: 'feminine', clothing: { model: 'old-outfit', parts: { top: 'tee', bottom: 'jeans', outer: 'vest' } } }, bob, bodies, hairs, {}, pieces);
    expect(urls).toEqual({ body: 'woman.glb', hair: 'bob.glb', parts: { top: 'female-tee.glb', outer: 'female-vest.glb' } });
    expect(sourceAvatarUrls({ presentation: 'feminine', clothing: { parts: {} } }, bob, bodies, hairs, {}, pieces)?.parts).toEqual({});
    expect(sourceAvatarUrls({ presentation: 'feminine', clothing: { parts: { outer: 'none' } } }, bob, bodies, hairs, {}, pieces)?.parts).toEqual({});
    expect(sourceAvatarUrls({ presentation: 'feminine' }, bob, bodies, hairs, {}, pieces)?.parts).toBeUndefined();
  });

  it('uses complete fitted defaults for mix mode without depending on a vest to cover the chest', () => {
    const pieces = {
      '/public-assets/avatars/wardrobe/male/top/shirt.glb': 'fitted-shirt.glb',
      '/public-assets/avatars/wardrobe/male/bottom/trousers.glb': 'fitted-trousers.glb',
    };
    const urls = sourceAvatarUrls({ presentation: 'masculine', clothing: { parts: { outer: 'none' } } }, bob, bodies, hairs, {}, pieces);
    expect(urls?.parts).toEqual({ top: 'fitted-shirt.glb', bottom: 'fitted-trousers.glb' });
    expect(sourceAvatarUrls({ presentation: 'masculine', clothing: { parts: { top: 'unavailable' } } }, bob, bodies, hairs, {}, pieces)?.parts).toEqual(urls?.parts);
  });

  it('keeps unreviewed or non-standalone garment drafts out of local character catalogs', () => {
    const published = {
      '/public-assets/avatars/wardrobe/female/outer/cloth-jacket.glb': 'public-jacket.glb',
      '/public-assets/avatars/wardrobe/male/bottom/jeans.glb': 'public-jeans.glb',
    };
    const privateFiles = {
      '/local-assets/avatars/wardrobe/female/outer/cloth-jacket.glb': 'private-jacket.glb',
      '/local-assets/avatars/wardrobe/female/top/sourcecloth-shirt.glb': 'incomplete-inner.glb',
      '/local-assets/avatars/wardrobe/female/bottom/jeans.glb': 'wrong-body-draft.glb',
      '/local-assets/avatars/wardrobe/male/bottom/jeans.glb': 'private-jeans.glb',
    };
    expect(reviewedPrivateAvatarFiles(privateFiles, published)).toEqual({
      '/local-assets/avatars/wardrobe/female/outer/cloth-jacket.glb': 'private-jacket.glb',
      '/local-assets/avatars/wardrobe/male/bottom/jeans.glb': 'private-jeans.glb',
    });
    expect(sourceAvatarUrls({ presentation: 'feminine', clothing: { parts: { outer: 'cloth-jacket' } } }, bob, bodies, hairs, {}, { ...reviewedPrivateAvatarFiles(privateFiles, published), ...published })?.parts?.outer).toBe('public-jacket.glb');
  });

  it('resolves original source ids across independent slots and full outfits with public precedence', () => {
    const pieces = {
      '/local-assets/avatars/wardrobe/male/top/blue-plaid-shirt.glb': 'private-plaid.glb',
      '/public-assets/avatars/wardrobe/male/top/blue-plaid-shirt.glb': 'public-plaid.glb',
      '/public-assets/avatars/wardrobe/male/outer/denim-jacket.glb': 'public-denim.glb',
      '/public-assets/avatars/wardrobe/male/bottom/source-jeans.glb': 'public-jeans.glb',
    };
    const outfits = { '/public-assets/avatars/outfits/male/outfit-black-business-suit.glb': 'public-suit.glb' };
    const mix = sourceAvatarUrls({ presentation: 'masculine', clothing: { parts: {
      top: 'blue-plaid-shirt', bottom: 'source-jeans', outer: 'denim-jacket',
    } } }, bob, bodies, hairs, outfits, pieces);
    expect(mix?.parts).toEqual({ top: 'public-plaid.glb', bottom: 'public-jeans.glb', outer: 'public-denim.glb' });
    expect(sourceAvatarUrls({ presentation: 'masculine', clothing: { model: 'outfit-black-business-suit' } }, bob, bodies, hairs, outfits, pieces)?.outfit).toBe('public-suit.glb');
  });

});
