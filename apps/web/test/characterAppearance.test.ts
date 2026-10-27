import { CHARACTER_HAIR_STYLES, CHARACTER_PRESENTATIONS, decodeCharacterAppearance, type CharacterAppearance } from '@extalia/core';
import { describe, expect, it } from 'vitest';
import {
  PRESENTATION_PRESETS, applyPresentationPreset, avatarVisual, characterAppearance, characterHeightCm, characterRig, defaultCharacterAppearance,
  presentationPreset,
} from '../src/office/scene/avatars/appearance';
import { gaitParameters, idlePose } from '../src/office/scene/avatars/gait';
import { resolveWardrobe } from '../src/office/scene/avatars/AvatarWardrobe';

const ids = Array.from({ length: 64 }, (_, index) => `s_${index.toString(36)}:primary`);

describe('presentation presets', () => {
  it('give each preset distinct hair, clothing cuts, accessories and gait without a neutral gender', () => {
    expect(CHARACTER_PRESENTATIONS).toEqual(['feminine', 'masculine']);
    const { feminine, masculine } = PRESENTATION_PRESETS;
    expect(feminine.hair.filter(style => masculine.hair.includes(style))).toEqual([]);
    expect(new Set(CHARACTER_PRESENTATIONS.map(p => `${PRESENTATION_PRESETS[p].top}/${PRESENTATION_PRESETS[p].bottom}`)).size).toBe(2);
    expect(new Set(CHARACTER_PRESENTATIONS.map(p => PRESENTATION_PRESETS[p].accessories.bag)).size).toBe(2);
    expect(new Set(CHARACTER_PRESENTATIONS.map(p => PRESENTATION_PRESETS[p].gait)).size).toBe(2);
    expect(feminine).toMatchObject({ top: 'blouse', bottom: 'skirt', accessories: { earrings: 'studs', tie: false } });
    expect(masculine).toMatchObject({ top: 'shirt', bottom: 'trousers', accessories: { earrings: 'none', tie: true } });
    for (const style of [...feminine.hair, ...masculine.hair]) expect(CHARACTER_HAIR_STYLES).toContain(style);
  });

  it('applies a preset deterministically and keeps the user’s own choices', () => {
    const base: CharacterAppearance = {
      ...defaultCharacterAppearance(ids[0]!), skinTone: '#5f4032', hairColor: '#c9a26a', topColor: '#26324a', stature: 'tall', heightCm: 181,
      accessories: { glasses: 'round', watch: 'none', earrings: 'none', bag: 'none', tie: false, badge: false, headphones: true },
    };
    for (const presentation of CHARACTER_PRESENTATIONS) {
      const preset = PRESENTATION_PRESETS[presentation];
      const look = applyPresentationPreset(base, presentation, ids[0]!);
      expect(look).toEqual(applyPresentationPreset(base, presentation, ids[0]!));
      expect(preset.hair).toContain(look.hairStyle);
      expect(look).toMatchObject({ presentation, top: preset.top, bottom: preset.bottom, outfit: preset.outfit, gait: preset.gait,
        skinTone: '#5f4032', hairColor: '#c9a26a', topColor: '#26324a', stature: 'tall', heightCm: 181 });
      expect(look.accessories).toEqual({ ...preset.accessories, glasses: 'round', badge: false, headphones: true });
      expect(decodeCharacterAppearance(look).ok).toBe(true);
    }
    // Different characters may get different cuts within the same preset.
    expect(new Set(ids.map(id => applyPresentationPreset(base, 'feminine', id).hairStyle)).size).toBeGreaterThan(1);
  });
});

describe('generated default look', () => {
  it('assigns masculine or feminine with matching hair and gait, seeded only by the presence id', () => {
    const looks = ids.map(id => defaultCharacterAppearance(id));
    for (const look of looks) {
      expect(['feminine', 'masculine']).toContain(look.presentation);
      expect(look.gait).toBe(look.presentation);
      expect(PRESENTATION_PRESETS[look.presentation].hair).toContain(look.hairStyle);
      expect(look.stature).toBe('default');
      expect(decodeCharacterAppearance(look).ok).toBe(true);
    }
    expect(defaultCharacterAppearance(ids[3]!)).toEqual(defaultCharacterAppearance(ids[3]!));
    // Varied: both feminine and masculine looks occur across generated ids.
    expect(looks.some(look => look.presentation === 'feminine')).toBe(true);
    expect(looks.some(look => look.presentation === 'masculine')).toBe(true);
    // Only explicit metadata sets the presentation; without it the seed alone decides.
    expect(defaultCharacterAppearance(ids[7]!, 'feminine').presentation).toBe('feminine');
    expect(defaultCharacterAppearance(ids[7]!, 'masculine').presentation).toBe('masculine');
    expect(defaultCharacterAppearance(ids[7]!, undefined)).toEqual(defaultCharacterAppearance(ids[7]!));
    expect(characterAppearance(ids[5]!)).toEqual(avatarVisual(ids[5]!, defaultCharacterAppearance(ids[5]!)));
  });

  it('maps legacy presentations onto feminine or masculine presets', () => {
    expect(presentationPreset('female')).toBe('feminine');
    expect(presentationPreset('male')).toBe('masculine');
    expect(presentationPreset('unconfigured')).toBe('masculine');
    expect(presentationPreset(undefined)).toBe('masculine');
  });
});

describe('renderer mapping', () => {
  const look = (patch: Partial<CharacterAppearance>): CharacterAppearance => ({ ...defaultCharacterAppearance(ids[1]!), ...patch });

  it('maps accessories and garment cuts onto the wardrobe', () => {
    const visual = avatarVisual(ids[1]!, look({ top: 'blouse', bottom: 'dress', bottomColor: '#6d2333',
      accessories: { glasses: 'none', watch: 'smart', earrings: 'hoops', bag: 'tote', tie: true, badge: false, headphones: false } }));
    expect(visual.accessories).toMatchObject({ glasses: false, watch: true, watchStyle: 'smart', earrings: 'hoops', bag: 'tote', tie: true, badge: false });
    const dress = resolveWardrobe(visual, 0);
    expect(dress).toMatchObject({ bottomCut: 'dress', neckline: 'scoop', fitted: true, top: '#6d2333', bottom: '#6d2333', tie: false });
    const shirt = resolveWardrobe(avatarVisual(ids[1]!, look({ outfit: 'executive', top: 'shirt', bottom: 'skirt',
      accessories: { ...look({}).accessories, tie: true } })), 0);
    expect(shirt).toMatchObject({ bottomCut: 'skirt', neckline: 'collar', tie: true, fitted: false });
    expect(resolveWardrobe(avatarVisual(ids[1]!, look({ top: 'knit', bottom: 'trousers' })), 0)).toMatchObject({ neckline: 'crew', tie: false });
  });

  it('shapes the frame by presentation and honors an explicit height', () => {
    const rig = (presentation: CharacterAppearance['presentation']) => characterRig(avatarVisual(ids[2]!, look({ presentation })));
    const [feminine, masculine] = [rig('feminine'), rig('masculine')];
    expect(feminine.seed).toBe(masculine.seed);
    expect(feminine.proportions.hipWidth).toBeGreaterThan(masculine.proportions.hipWidth);
    expect(masculine.proportions.shoulderWidth).toBeGreaterThan(feminine.proportions.shoulderWidth);
    expect(characterHeightCm(avatarVisual(ids[2]!, look({ heightCm: 182 })))).toBe(182);
    expect(characterHeightCm(avatarVisual(ids[2]!, look({ stature: 'petite' })))).toBeLessThan(characterHeightCm(avatarVisual(ids[2]!, look({ stature: 'tall' }))));
  });
});

describe('gait', () => {
  it('differs by walking style and defaults to masculine', () => {
    const feminine = gaitParameters({ gait: 'feminine' }), masculine = gaitParameters({ gait: 'masculine' });
    expect(gaitParameters()).toEqual(masculine);
    expect(gaitParameters({ gait: 'strut' as never })).toEqual(masculine);
    expect(feminine.hipSway).toBeGreaterThan(masculine.hipSway);
    expect(feminine.hipRoll).toBeGreaterThan(masculine.hipRoll);
    expect(masculine.strideLength).toBeGreaterThan(feminine.strideLength);
    expect(masculine.armSwing).toBeGreaterThan(feminine.armSwing);
    expect(feminine.cadence).toBeGreaterThan(masculine.cadence);
  });

  it('scales stride with height within bounds', () => {
    const base = gaitParameters({ gait: 'masculine' });
    const tall = gaitParameters({ gait: 'masculine', heightCm: 190 });
    expect(tall.strideLength).toBeCloseTo(base.strideLength * 190 / 170);
    expect(tall.cadence).toBeLessThan(base.cadence);
    expect(gaitParameters({ gait: 'masculine', heightCm: 400 }).strideLength).toBeCloseTo(base.strideLength * 1.15);
  });

  it('drives a visible idle weight shift that stops under reduced motion', () => {
    const feminine = gaitParameters({ gait: 'feminine' }), masculine = gaitParameters({ gait: 'masculine' });
    expect(Object.values(idlePose(feminine, 0, false)).every(value => value === 0)).toBe(true);
    // Peak of the weight shift: a quarter of the eight-step cycle.
    const peak = (gait: typeof feminine) => 2 / gait.cadence;
    const standingF = idlePose(feminine, peak(feminine), false), standingM = idlePose(masculine, peak(masculine), false);
    expect(standingF.pelvisShift).toBeCloseTo(feminine.hipSway);
    expect(standingF.pelvisShift).toBeGreaterThan(standingM.pelvisShift);
    expect(standingF.pelvisRoll).toBeGreaterThan(standingM.pelvisRoll);
    expect(Math.sign(standingF.torsoRoll)).toBe(-Math.sign(standingF.pelvisRoll));
    const seated = idlePose(feminine, peak(feminine), true);
    expect(seated.pelvisShift).toBe(0);
    expect(seated.armSway).toBe(0);
    expect(Math.abs(seated.torsoRoll)).toBeGreaterThan(Math.abs(idlePose(masculine, peak(masculine), true).torsoRoll));
    expect(Math.abs(seated.torsoRoll)).toBeLessThan(Math.abs(standingF.pelvisRoll));
  });
});
