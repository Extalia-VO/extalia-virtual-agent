import { describe, expect, it } from 'vitest';
import { CHARACTER_HAIR_STYLES, decodeCharacterAppearance, getCharacterHairOptions, resolveCharacterHair } from '../src/index.js';

const appearance = (hairStyle: string) => ({
  presentation: 'masculine', hairStyle, hairColor: '#292426', skinTone: '#c79a82', outfit: 'business-casual',
  top: 'shirt', bottom: 'trousers', stature: 'default', gait: 'masculine',
  accessories: { glasses: 'none', watch: 'none', earrings: 'none', bag: 'none', tie: false, badge: false, headphones: false },
});

describe('source hair catalog', () => {
  it('maps every non-legacy style to a real grouped source mesh', () => {
    const options = [...getCharacterHairOptions('masculine'), ...getCharacterHairOptions('feminine')];
    expect(options.map(option => option.id).sort()).toEqual(CHARACTER_HAIR_STYLES.filter(style => style !== 'long').sort());
    expect(options.every(option => !option.fallback)).toBe(true);
    expect(options.map(option => option.mesh)).not.toContain('');
    expect(options.filter(option => option.group === 'male')).toHaveLength(7);
    expect(options.filter(option => option.group === 'female')).toHaveLength(6);
  });

  it('offers only the presentation\'s own hair, detailed styles first', () => {
    const male = getCharacterHairOptions('masculine'), female = getCharacterHairOptions('feminine');
    expect(male.every(option => option.group === 'male')).toBe(true);
    expect(female.every(option => option.group === 'female')).toBe(true);
    expect(male.slice(0, 5).map(option => option.id).sort()).toEqual(['short-fade', 'side-part', 'slicked-back', 'textured-crop', 'undercut']);
    expect(female.slice(0, 5).map(option => option.id).sort()).toEqual(['bob', 'bun', 'high-ponytail', 'medium', 'ponytail']);
    // Styles without a detailed model come after every detailed one.
    expect(male.slice(5).every(option => !option.detail) && female.slice(5).every(option => !option.detail)).toBe(true);
    expect([...male, ...female].filter(option => option.detail).every(option => option.detail!.mesh.startsWith('Hair_detail_'))).toBe(true);
  });

  it('keeps legacy aliases and bun values decodable while resolving real source meshes', () => {
    expect(resolveCharacterHair('long')).toMatchObject({ id: 'long', mesh: 'Hair_wavy', assetKey: 'wavy', group: 'female', fallback: false });
    // Bun is a real style again: its detailed mesh when present, else the light bob mesh.
    expect(resolveCharacterHair('bun')).toMatchObject({ id: 'bun', mesh: 'Hair_shoulder_bob', assetKey: 'bob', group: 'female', fallback: false, detail: { assetKey: 'bun-detail' } });
    expect(decodeCharacterAppearance(appearance('bun')).ok).toBe(true);
    expect(decodeCharacterAppearance(appearance('high-ponytail')).ok).toBe(true);
  });

  it('treats inherited object keys as unknown rather than hair styles', () => {
    expect(resolveCharacterHair('toString')).toMatchObject({ id: 'medium', group: 'female', fallback: true, warning: 'unknown-style' });
    expect(resolveCharacterHair('__proto__', 'masculine')).toMatchObject({ id: 'side-part', group: 'male', fallback: true, warning: 'unknown-style' });
  });
});
