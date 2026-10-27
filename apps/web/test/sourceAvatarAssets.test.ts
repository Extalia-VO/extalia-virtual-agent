import { resolveCharacterHair } from '@extalia/core';
import { describe, expect, it } from 'vitest';
import { bodyAssetUrl, hairAssetUrl, localHairStyles, sourceAvatarUrls } from '../src/office/scene/avatars/sourceAssets';

const bob = resolveCharacterHair('bob');
const bodies = {
  '/local-assets/avatars/bodies/office-classic.glb': 'office.glb',
  '/local-assets/avatars/bodies/business-woman.glb': 'woman.glb',
};
const hairs = { '/local-assets/avatars/hair/female/bob.glb': 'bob.glb' };

describe('local source avatar assets', () => {
  it('yields nothing when the local asset folder is absent (public clone)', () => {
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

  it('loads the real glob without throwing, whether or not local assets exist', () => {
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
});
