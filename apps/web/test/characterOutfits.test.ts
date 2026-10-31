import { CHARACTER_OUTFITS, decodeCharacterAppearance, decodeCharacterAppearanceStore, type CharacterAppearance } from '@extalia/core';
import { describe, expect, it } from 'vitest';
import { avatarVisual, defaultCharacterAppearance } from '../src/office/scene/avatars/appearance';
import {
  appearanceChoice, applyOutfitChoice, applyOutfitPiece, choiceValue, defaultOutfit, EVERYDAY_STYLES, OUTFIT_PALETTES, outfitChoices, outfitModels, outfitModelUrl,
  pieceChoices, pieceModels, randomizeOutfit, rendezvous, seededOutfitChoice, seededOutfitParts, seededPalette, STAFF_UNIFORMS, staffAppearance,
} from '../src/office/scene/avatars/outfitCatalog';
import { resolveWardrobe, SCAN_OUTFIT_MODEL, scanAccessorySlots, scanOutfitSlot } from '../src/office/scene/avatars/wardrobe';
import { sourceAvatarUrls } from '../src/office/scene/avatars/sourceAssets';
import { resolveCharacterHair } from '@extalia/core';
import { FACILITY_NPCS, facilityAppearance } from '../src/office/scene/movement/facilityNpcs';

const ids = Array.from({ length: 200 }, (_, index) => `s_${index.toString(36)}:primary`);
const file = (group: string, id: string, root = 'public') => [`/${root}-assets/avatars/outfits/${group}/${id}.glb`, `/assets/${group}-${id}.glb`] as const;
const CATALOG = Object.fromEntries([
  file('female', 'reception-uniform'), file('male', 'reception-uniform'),
  file('female', 'bartender-uniform'), file('male', 'bartender-uniform'),
  file('female', 'outfit-dress'), file('female', 'outfit-sport'), file('male', 'outfit-streetwear'),
]);
const PALETTE_COLORS = new Set(Object.values(OUTFIT_PALETTES).flat().flatMap(palette => Object.values(palette)));
const pieceFile = (group: string, slot: string, id: string) => [`/public-assets/avatars/wardrobe/${group}/${slot}/${id}.glb`, `/assets/${group}-${slot}-${id}.glb`] as const;
const PIECES = Object.fromEntries([
  pieceFile('female', 'top', 'blouse'), pieceFile('female', 'top', 'knit'),
  pieceFile('female', 'bottom', 'skirt'), pieceFile('female', 'bottom', 'jeans'), pieceFile('female', 'outer', 'blazer'),
  pieceFile('male', 'top', 'shirt'), pieceFile('male', 'bottom', 'trousers'), pieceFile('male', 'outer', 'vest'),
]);

describe('independent fitted garments', () => {
  it('combines partial catalogs with native body defaults without requiring a separate top', () => {
    const partial = Object.fromEntries([pieceFile('female', 'bottom', 'short-jeans'), pieceFile('female', 'outer', 'cloth-jacket')]);
    const first = seededOutfitParts('partial-source', 'feminine', partial)!;
    expect(first.top).toBeUndefined();
    expect(first.bottom).toBe('short-jeans');
    expect(['none', 'cloth-jacket']).toContain(first.outer);
    expect(seededOutfitParts('partial-source', 'feminine', partial)).toEqual(first);
    expect(seededOutfitParts('partial-source', 'masculine', partial)).toBeUndefined();
  });

  it('offers only published garments of the selected body and slot', () => {
    expect(pieceChoices('feminine', 'top', PIECES).map(piece => piece.id)).toEqual(['blouse', 'knit']);
    expect(pieceChoices('masculine', 'bottom', PIECES).map(piece => piece.id)).toEqual(['trousers']);
    expect(pieceModels({ ...PIECES, '/local-assets/avatars/wardrobe/female/top/blouse.glb': '/private.glb' })
      .find(piece => piece.group === 'female' && piece.slot === 'top' && piece.id === 'blouse')?.url).toBe('/assets/female-top-blouse.glb');
    expect(pieceModels({ '/public-assets/avatars/wardrobe/female/shoes/boots.glb': '/boots.glb' })).toEqual([]);
  });

  it('keeps other slots when changing one and clears them when choosing a complete outfit', () => {
    const look = applyOutfitChoice(defaultCharacterAppearance(ids[0]!), 'model:outfit-dress');
    const top = applyOutfitPiece(look, 'top', 'shirt');
    const bottom = applyOutfitPiece(top, 'bottom', 'jeans');
    const outer = applyOutfitPiece(bottom, 'outer', 'none');
    expect(outer.outfitParts).toEqual({ top: 'shirt', bottom: 'jeans', outer: 'none' });
    expect(outer.outfitModel).toBeUndefined();
    expect(top.outfitParts).toEqual({ top: 'shirt' });
    expect(applyOutfitPiece(outer, 'top', undefined).outfitParts).toEqual({ bottom: 'jeans', outer: 'none' });
    for (const value of ['model:outfit-dress', 'style:casual']) expect(applyOutfitChoice(outer, value).outfitParts).toBeUndefined();
  });

  it('generates varied stable combinations independently per slot and body', () => {
    const looks = ids.map(id => seededOutfitParts(id, 'feminine', PIECES));
    expect(ids.map(id => seededOutfitParts(id, 'feminine', PIECES))).toEqual(looks);
    for (const slot of ['top', 'bottom', 'outer'] as const) expect(new Set(looks.map(parts => parts?.[slot])).size).toBe(2);
    const grown = { ...PIECES, ...Object.fromEntries([pieceFile('female', 'bottom', 'shorts')]) };
    expect(ids.map(id => seededOutfitParts(id, 'feminine', grown)?.top)).toEqual(looks.map(parts => parts?.top));
    expect(ids.map(id => seededOutfitParts(id, 'feminine', grown)?.outer)).toEqual(looks.map(parts => parts?.outer));
    expect(seededOutfitParts('stable', 'masculine', PIECES)).toMatchObject({ top: 'shirt', bottom: 'trousers' });
    expect(seededOutfitParts('stable', 'feminine', {})).toBeUndefined();
  });

  it('randomizes all available slots and restores the seeded combination without changing the person', () => {
    const look: CharacterAppearance = { ...defaultCharacterAppearance(ids[0]!, 'feminine'), outfitParts: seededOutfitParts(ids[0]!, 'feminine', PIECES)! };
    delete look.outfitModel;
    const next = randomizeOutfit(look, ids[0]!, 1, CATALOG, PIECES);
    for (const slot of ['top', 'bottom', 'outer'] as const) expect(next.outfitParts?.[slot]).not.toBe(look.outfitParts?.[slot]);
    expect(next.hairStyle).toBe(look.hairStyle);
    expect(next.accessories).toBe(look.accessories);
    expect(decodeCharacterAppearance(next).ok).toBe(true);
    expect(defaultOutfit(next, look)).toEqual(look);
    expect(staffAppearance('receptionist', FACILITY_NPCS[0]!.appearance, next).outfitParts).toBeUndefined();
  });
});

describe('outfit catalog', () => {
  it('reads outfit models from the bundled files, per gender group, flagging staff uniforms', () => {
    const models = outfitModels(CATALOG);
    expect(models.map(model => `${model.group}/${model.id}`)).toEqual([
      'female/bartender-uniform', 'female/outfit-dress', 'female/outfit-sport', 'female/reception-uniform',
      'male/bartender-uniform', 'male/outfit-streetwear', 'male/reception-uniform',
    ]);
    expect(models.filter(model => model.staff).map(model => model.staff)).toEqual(['bartender', 'receptionist', 'bartender', 'receptionist']);
    expect(outfitModelUrl('outfit-dress', 'female', CATALOG)).toBe('/assets/female-outfit-dress.glb');
    expect(outfitModelUrl('outfit-dress', 'male', CATALOG)).toBeUndefined();
    // Public files win over a private copy of the same outfit.
    const both = { ...CATALOG, [file('female', 'outfit-dress', 'local')[0]]: '/private.glb' };
    expect(outfitModelUrl('outfit-dress', 'female', both)).toBe('/assets/female-outfit-dress.glb');
  });

  it('offers every style plus only the own group’s everyday models, never a uniform', () => {
    const feminine = outfitChoices('feminine', CATALOG).map(choiceValue);
    const masculine = outfitChoices('masculine', CATALOG).map(choiceValue);
    expect(feminine).toEqual([...CHARACTER_OUTFITS.map(style => `style:${style}`), 'model:outfit-dress', 'model:outfit-sport']);
    expect(masculine).toEqual([...CHARACTER_OUTFITS.map(style => `style:${style}`), 'model:outfit-streetwear']);
    // A new catalog file appears without code changes.
    const grown = Object.fromEntries([...Object.entries(CATALOG), file('female', 'outfit-cheongsam')]);
    expect(outfitChoices('feminine', grown).map(choiceValue)).toContain('model:outfit-cheongsam');
  });

  it('switches between styles and models without losing the portrait style', () => {
    const look = defaultCharacterAppearance(ids[1]!, 'feminine');
    const dressed = applyOutfitChoice(look, 'model:outfit-dress');
    expect(dressed).toMatchObject({ outfitModel: 'outfit-dress', outfit: look.outfit });
    expect(appearanceChoice(dressed)).toBe('model:outfit-dress');
    const styled = applyOutfitChoice(dressed, 'style:creative');
    expect(styled.outfitModel).toBeUndefined();
    expect(styled.outfit).toBe('creative');
    expect(avatarVisual('x:y', dressed).clothing?.model).toBe('outfit-dress');
  });
});

describe('random first outfit', () => {
  it('is deterministic per id, varied across ids and gender-appropriate', () => {
    const picks = ids.map(id => seededOutfitChoice(id, 'feminine', CATALOG));
    expect(ids.map(id => seededOutfitChoice(id, 'feminine', CATALOG))).toEqual(picks);
    const values = new Set(picks.map(choiceValue));
    // Every everyday style and both female models occur; no signature look, male model or uniform.
    expect(values).toEqual(new Set([...EVERYDAY_STYLES.map(style => `style:${style}`), 'model:outfit-dress', 'model:outfit-sport']));
    const male = new Set(ids.map(id => choiceValue(seededOutfitChoice(id, 'masculine', CATALOG))));
    expect(male.has('model:outfit-dress')).toBe(false);
    expect(male.has('model:outfit-streetwear')).toBe(true);
  });

  it('keeps most looks when the catalog grows (only characters the new outfit wins for change)', () => {
    const grown = Object.fromEntries([...Object.entries(CATALOG), file('female', 'outfit-cheongsam')]);
    const changed = ids.filter(id => choiceValue(seededOutfitChoice(id, 'feminine', CATALOG)) !== choiceValue(seededOutfitChoice(id, 'feminine', grown)));
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.length).toBeLessThan(ids.length * 0.25);
    for (const id of changed) expect(choiceValue(seededOutfitChoice(id, 'feminine', grown))).toBe('model:outfit-cheongsam');
  });

  it('generates a valid look without saving anything, with tasteful seeded zone palettes', () => {
    for (const id of ids.slice(0, 40)) {
      const look = defaultCharacterAppearance(id);
      expect(defaultCharacterAppearance(id)).toEqual(look);
      expect(decodeCharacterAppearance(look).ok).toBe(true);
      // Colours are not stored in a generated look: the wardrobe draws them from the palettes.
      expect(look.topColor ?? look.bottomColor ?? look.outerColor ?? look.accentColor).toBeUndefined();
      const wardrobe = resolveWardrobe(avatarVisual(id, look), 0);
      if (look.outfit !== 'ceo' && look.outfit !== 'architect') {
        expect(PALETTE_COLORS.has(wardrobe.top) && PALETTE_COLORS.has(wardrobe.jacket) && PALETTE_COLORS.has(wardrobe.accent)).toBe(true);
      }
    }
    expect(seededPalette('a:b', 'casual')).toEqual(seededPalette('a:b', 'casual'));
    expect(OUTFIT_PALETTES.casual).toContainEqual(seededPalette('a:b', 'casual'));
    expect(OUTFIT_PALETTES.office).toContainEqual(seededPalette('a:b', 'executive'));
  });

  it('picks by highest random weight', () => {
    expect(rendezvous('seed', [], String)).toBeUndefined();
    expect(rendezvous('seed', ['a', 'b', 'c'], String)).toBe(rendezvous('seed', ['c', 'b', 'a'], String));
  });
});

describe('randomize and default outfit', () => {
  it('re-rolls the outfit and every zone colour reproducibly, keeping the person', () => {
    const look = defaultCharacterAppearance(ids[3]!, 'masculine');
    const first = randomizeOutfit(look, ids[3]!, 1, CATALOG, {});
    expect(randomizeOutfit(look, ids[3]!, 1, CATALOG, {})).toEqual(first);
    expect(appearanceChoice(first)).not.toBe(appearanceChoice(look));
    expect(first.outfitModel === undefined || first.outfitModel === 'outfit-streetwear').toBe(true);
    for (const key of ['topColor', 'bottomColor', 'outerColor', 'accentColor'] as const) expect(PALETTE_COLORS.has(first[key]!)).toBe(true);
    expect(first).toMatchObject({ hairStyle: look.hairStyle, skinTone: look.skinTone, presentation: look.presentation, accessories: look.accessories });
    const rolls = new Set(Array.from({ length: 12 }, (_, roll) => appearanceChoice(randomizeOutfit(look, ids[3]!, roll + 1, CATALOG, {}))));
    expect(rolls.size).toBeGreaterThan(3);
    expect(decodeCharacterAppearance(first).ok).toBe(true);
  });

  it('returns to the generated first outfit and its colours', () => {
    const look = defaultCharacterAppearance(ids[5]!, 'feminine');
    const edited = { ...randomizeOutfit(look, ids[5]!, 4, CATALOG), hairColor: '#7a2f2a' };
    const reset = defaultOutfit(edited, look);
    expect(reset).toEqual({ ...look, hairColor: '#7a2f2a' });
  });
});

describe('staff uniforms', () => {
  it('dress the receptionist and the bartender in their role uniform', () => {
    const roles = Object.fromEntries(FACILITY_NPCS.map(npc => [npc.role, npc.appearance.outfitModel]));
    expect(roles).toEqual({ receptionist: STAFF_UNIFORMS.receptionist, bartender: STAFF_UNIFORMS.bartender });
    for (const npc of FACILITY_NPCS) expect(decodeCharacterAppearance(npc.appearance).ok).toBe(true);
  });

  it('lock the uniform whatever is saved; hair, skin and the accent colour carry over', () => {
    const npc = FACILITY_NPCS.find(item => item.role === 'receptionist')!;
    const saved: CharacterAppearance = { ...npc.appearance, outfit: 'casual', outfitModel: 'outfit-dress', topColor: '#ff0000', outerColor: '#00ff00',
      accentColor: '#7c2a35', hairColor: '#c9a26a', accessories: { ...npc.appearance.accessories, badge: false, glasses: 'round' } };
    const look = facilityAppearance(npc, saved);
    expect(look).toMatchObject({ outfitModel: 'reception-uniform', outfit: 'executive', topColor: npc.appearance.topColor,
      outerColor: npc.appearance.outerColor, accentColor: '#7c2a35', hairColor: '#c9a26a' });
    expect(look.accessories).toMatchObject({ badge: true, glasses: 'round' });
    expect(facilityAppearance(npc)).toEqual(staffAppearance('receptionist', npc.appearance));
  });

  it('wear the uniform mesh slot, which carries its own badge', () => {
    const slots = new Set(['ScanOutfit', 'ScanOutfitCasual', SCAN_OUTFIT_MODEL]);
    expect(scanOutfitSlot('executive', slots, 'reception-uniform')).toBe(SCAN_OUTFIT_MODEL);
    expect(scanOutfitSlot('casual', new Set(['ScanOutfit', 'ScanOutfitCasual']), 'reception-uniform')).toBe('ScanOutfitCasual');
    expect(scanAccessorySlots({ badge: true }, SCAN_OUTFIT_MODEL, 'reception-uniform').has('AccBadge')).toBe(false);
    expect(scanAccessorySlots({ badge: true }, SCAN_OUTFIT_MODEL, 'outfit-dress').has('AccBadge')).toBe(true);
    expect(scanAccessorySlots({ badge: true }, 'ScanOutfit').has('AccBadge')).toBe(true);
  });

  it('load the uniform of the body’s own gender group', () => {
    const bodies = { '/public-assets/avatars/bodies/female/female-casual.glb': '/f.glb', '/public-assets/avatars/bodies/male/office-classic.glb': '/m.glb' };
    const hair = { '/public-assets/avatars/hair/female/bob-detail.glb': '/h.glb', '/public-assets/avatars/hair/male/short-fade-detail.glb': '/hm.glb' };
    const receptionist = avatarVisual('facility:receptionist', FACILITY_NPCS[0]!.appearance);
    const urls = sourceAvatarUrls({ ...receptionist, modelVariant: 'female-casual' }, resolveCharacterHair('bob', 'feminine'), bodies, hair, CATALOG);
    expect(urls?.outfit).toBe('/assets/female-reception-uniform.glb');
    const plain = sourceAvatarUrls({ presentation: 'feminine', modelVariant: 'female-casual' }, resolveCharacterHair('bob', 'feminine'), bodies, hair, CATALOG);
    expect(plain?.outfit).toBeUndefined();
  });
});

describe('persistence', () => {
  it('stores the outfit model and zone colours strictly', () => {
    const look: CharacterAppearance = { ...applyOutfitChoice(defaultCharacterAppearance(ids[7]!), 'model:outfit-dress'), outerColor: '#2C3445', accentColor: '#10b9ac' };
    const decoded = decodeCharacterAppearance(look);
    expect(decoded.ok && decoded.value).toMatchObject({ outfitModel: 'outfit-dress', outerColor: '#2c3445', accentColor: '#10b9ac' });
    expect(decodeCharacterAppearance({ ...look, outfitModel: 'Outfit Dress' }).ok).toBe(false);
    expect(decodeCharacterAppearance({ ...look, outfitModel: '../x' }).ok).toBe(false);
    expect(decodeCharacterAppearance({ ...look, accentColor: 'teal' }).ok).toBe(false);
    const store = decodeCharacterAppearanceStore({ schema: 'extalia.character-appearances.v1', characters: { 'facility:receptionist': look } });
    expect(store.ok).toBe(true);
  });
});
