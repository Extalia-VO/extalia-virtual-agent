import { resolveCharacterHair, type CharacterAppearance, type CharacterPresentation } from '@extalia/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultCharacterAppearance } from '../src/office/scene/avatars/appearance';
import { detailedHairStyles, glbHairStyle } from '../src/office/scene/avatars/hairCatalog';
import { sourceHairAsset } from '../src/office/scene/avatars/hairAssets';
import {
  allocateGeneratedLooks, generatedLookOf, randomizeHair, setLookCatalog, setLookRoster, setLookSalt, type GeneratedLook, type LookRosterEntry,
} from '../src/office/scene/avatars/lookAllocation';
import { DRESS_CODE, dressCode, outfitModels, pieceModels, presentationGroup } from '../src/office/scene/avatars/outfitCatalog';
import { avatarVisual } from '../src/office/scene/avatars/appearance';
import { detailedHairUrl, sourceAvatarUrls } from '../src/office/scene/avatars/sourceAssets';
import { FACILITY_NPCS, facilityAppearance } from '../src/office/scene/movement/facilityNpcs';

/** The shipped avatar files, as the bundler would list them (the unit-test root has no bundled catalog). */
const rooted = (files: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(files).map(([path, url]) => [path.replace('../', '/'), url]));
const OUTFITS = rooted(import.meta.glob<string>('../public-assets/avatars/outfits/*/*.glb', { eager: true, query: '?url', import: 'default' }));
const PIECES = rooted(import.meta.glob<string>('../public-assets/avatars/wardrobe/*/*/*.glb', { eager: true, query: '?url', import: 'default' }));
const HAIR = rooted(import.meta.glob<string>('../public-assets/avatars/hair/*/*-detail.glb', { eager: true, query: '?url', import: 'default' }));
const entries = (count: number, presentation: CharacterPresentation, prefix = 'c'): LookRosterEntry[] =>
  Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}`, seed: `${prefix}${index}:primary`, presentation }));

/** Casual items a generated look holds (complete outfit as a whole, fitted top, fitted outer). */
function casualItems(look: GeneratedLook): string[] {
  const group = presentationGroup(look.presentation), items: string[] = [];
  if (look.outfitModel && dressCode(look.outfitModel) === 'casual') items.push(`${group}/model/${look.outfitModel}`);
  if (look.outfitParts?.top) items.push(`${group}/top/${look.outfitParts.top}`);
  if (look.outfitParts?.outer && look.outfitParts.outer !== 'none') items.push(`${group}/outer/${look.outfitParts.outer}`);
  return items;
}

beforeEach(() => { setLookCatalog({ outfits: OUTFITS, pieces: PIECES }); });
afterEach(() => { setLookRoster([]); setLookSalt(undefined); setLookCatalog(undefined); });

describe('dress code table', () => {
  it('classifies every shipped outfit model and wardrobe piece explicitly', () => {
    const ids = new Set([...outfitModels(OUTFITS).map(model => model.id), ...pieceModels(PIECES).map(piece => piece.id)]);
    expect(ids.size).toBeGreaterThan(20);
    for (const id of ids) expect(Object.hasOwn(DRESS_CODE, id), id).toBe(true);
    // The table lists no file that does not exist.
    for (const id of Object.keys(DRESS_CODE)) expect(ids.has(id), id).toBe(true);
  });

  it('keeps uniforms and suits formal, everyday garments casual, unknown ids casual', () => {
    const formal = Object.entries(DRESS_CODE).filter(([, code]) => code === 'formal').map(([id]) => id).sort();
    expect(formal).toEqual(['bartender-uniform', 'outfit-black-business-suit', 'outfit-mens-two-piece-suit', 'outfit-prom-suit', 'outfit-victorian-bartender', 'reception-uniform']);
    for (const id of ['outfit-printed-hoodie-jeans', 'outfit-sweatshirt-jacket-workwear', 'outfit-original-dress', 'outfit-source-denim-dress', 'outfit-source-jumper-skirt',
      'green-white-hoodie', 'denim-jacket', 'jeans', 'source-pink-hoodie', 'source-gothic-skirt']) expect(dressCode(id), id).toBe('casual');
    expect(dressCode('outfit-future-garment')).toBe('casual');
  });
});

describe('casual clothing is unique, formal clothing is shared', () => {
  for (const presentation of ['masculine', 'feminine'] as const) {
    it(`gives ${presentation} characters pairwise distinct casual items until the pool is exhausted, then formal`, () => {
      const characters = entries(16, presentation);
      const looks = allocateGeneratedLooks(characters, 'salt');
      const held = new Set<string>();
      let casual = 0, formal = 0;
      for (const character of characters) {
        const look = looks.get(character.seed)!;
        if (look.formal) { formal++; continue; }
        casual++;
        expect(look.outfitModel !== undefined || look.outfitParts !== undefined).toBe(true);
        for (const item of casualItems(look)) { expect(held.has(item), item).toBe(false); held.add(item); }
      }
      expect(casual).toBeGreaterThan(2);
      expect(formal).toBeGreaterThan(0);
      // Formal clothing is shared, and a formal look never holds a casual item.
      for (const character of characters) { const look = looks.get(character.seed)!; if (look.formal) expect(casualItems(look)).toEqual([]); }
      // Everyone before the pool ran out wore casual: with fewer characters than the capacity nobody is formal.
      const few = allocateGeneratedLooks(entries(casual, presentation), 'salt');
      expect([...few.values()].every(look => !look.formal)).toBe(true);
    });
  }

  it('lets several characters wear the same formal outfit', () => {
    const looks = [...allocateGeneratedLooks(entries(12, 'masculine'), 'salt').values()].filter(look => look.formal);
    expect(looks.length).toBeGreaterThan(4);
    const models = looks.map(look => look.outfitModel);
    expect(new Set(models).size).toBeLessThan(models.length);
    for (const model of models) expect(dressCode(model!)).toBe('formal');
  });

  it('respects saved looks: they are never allocated and block their casual items', () => {
    const base = entries(3, 'masculine');
    const alone = allocateGeneratedLooks(base, 'salt');
    const first = alone.get(base[0]!.seed)!;
    const saved: CharacterAppearance = { ...defaultCharacterAppearance('saved-one', 'masculine'), hairStyle: 'undercut', ...(first.outfitModel
      ? { outfitModel: first.outfitModel } : { outfitParts: { ...first.outfitParts } }) };
    const intruder: LookRosterEntry = { id: 'saved', seed: 'saved:primary', presentation: 'masculine', saved };
    const looks = allocateGeneratedLooks([intruder, ...base], 'salt');
    expect(looks.has(intruder.seed)).toBe(false);
    for (const character of base) {
      const look = looks.get(character.seed)!;
      for (const item of casualItems(look)) expect(casualItems(first).includes(item) && !look.formal).toBe(false);
      expect(look.hairStyle).not.toBe('undercut');
    }
    // A saved formal suit blocks nothing.
    const suit: CharacterAppearance = { ...saved, outfitModel: 'outfit-black-business-suit' };
    delete suit.outfitParts;
    const withSuit = allocateGeneratedLooks([{ ...intruder, saved: suit }, ...base], 'salt').get(base[0]!.seed)!;
    expect({ model: withSuit.outfitModel, parts: withSuit.outfitParts }).toEqual({ model: first.outfitModel, parts: first.outfitParts });
  });

  it('keeps each look when a character joins, and when another leaves', () => {
    const base = entries(5, 'feminine');
    const first = allocateGeneratedLooks(base, 'salt');
    const joined = allocateGeneratedLooks([...entries(2, 'feminine', 'a'), ...base], 'salt', { previous: first });
    for (const character of base) expect(joined.get(character.seed)).toEqual(first.get(character.seed));
    const left = allocateGeneratedLooks(base.slice(1), 'salt', { previous: joined });
    for (const character of base.slice(1)) expect(left.get(character.seed)).toEqual(first.get(character.seed));
  });

  it('is deterministic for the same roster and salt', () => {
    const characters = [...entries(7, 'masculine'), ...entries(7, 'feminine', 'f')];
    expect(allocateGeneratedLooks(characters, 's')).toEqual(allocateGeneratedLooks([...characters].reverse(), 's'));
  });

  it('falls back to a staff uniform only when a group has no other formal outfit', () => {
    const outfits = { '/public-assets/avatars/outfits/female/reception-uniform.glb': '/r.glb', '/public-assets/avatars/outfits/female/outfit-a.glb': '/a.glb' };
    const looks = [...allocateGeneratedLooks(entries(4, 'feminine'), 's', { outfits, pieces: {} }).values()];
    expect(looks.filter(look => !look.formal).map(look => look.outfitModel)).toEqual(['outfit-a']);
    expect(looks.filter(look => look.formal).every(look => look.outfitModel === 'reception-uniform')).toBe(true);
    expect([...allocateGeneratedLooks(entries(2, 'feminine'), 's', { outfits: {}, pieces: {} }).values()].every(look => look.formal && !look.outfitModel && !look.outfitParts)).toBe(true);
  });
});

describe('generated hair', () => {
  const store = (presentation: CharacterPresentation) => detailedHairStyles(presentation);

  it('uses the five detailed GLB styles of the group, each with an existing model file', () => {
    expect(store('feminine').sort()).toEqual(['bob', 'bun', 'high-ponytail', 'medium', 'ponytail']);
    expect(store('masculine').sort()).toEqual(['short-fade', 'side-part', 'slicked-back', 'textured-crop', 'undercut']);
    for (const presentation of ['feminine', 'masculine'] as const) {
      for (const look of allocateGeneratedLooks(entries(30, presentation), 's').values()) {
        expect(store(presentation)).toContain(look.hairStyle);
        expect(detailedHairUrl(resolveCharacterHair(look.hairStyle, presentation), HAIR)).toBeTruthy();
      }
    }
  });

  it('is distinct among visible characters while the pool lasts, and repeats evenly afterwards', () => {
    for (const presentation of ['feminine', 'masculine'] as const) {
      const five = [...allocateGeneratedLooks(entries(5, presentation), 'x').values()].map(look => look.hairStyle);
      expect(new Set(five).size).toBe(5);
      const ten = [...allocateGeneratedLooks(entries(10, presentation), 'x').values()].map(look => look.hairStyle);
      expect(new Set(ten).size).toBe(5);
    }
  });

  it('avoids hair held by saved looks and by staff', () => {
    const npcs = FACILITY_NPCS.map((npc): LookRosterEntry => { const look = facilityAppearance(npc); return { id: npc.id, seed: npc.id, presentation: look.presentation, saved: look }; });
    const looks = allocateGeneratedLooks([...npcs, ...entries(4, 'feminine'), ...entries(4, 'masculine', 'm')], 'x');
    const female = [...looks.values()].filter(look => look.presentation === 'feminine').map(look => look.hairStyle);
    const male = [...looks.values()].filter(look => look.presentation === 'masculine').map(look => look.hairStyle);
    expect(female).not.toContain('bob');
    expect(male).not.toContain('short-fade');
    expect(new Set(female).size).toBe(4);
    expect(new Set(male).size).toBe(4);
  });

  it('changes with the session salt', () => {
    const characters = entries(8, 'feminine');
    const a = allocateGeneratedLooks(characters, 'session-a'), b = allocateGeneratedLooks(characters, 'session-b');
    expect(characters.some(character => a.get(character.seed)!.hairStyle !== b.get(character.seed)!.hairStyle)).toBe(true);
    // Outfits do not depend on the salt.
    for (const character of characters) expect(casualItems(a.get(character.seed)!)).toEqual(casualItems(b.get(character.seed)!));
  });

  it('re-rolls hair among GLB styles in the editor, never keeping the current one', () => {
    const look = defaultCharacterAppearance('editor:primary', 'masculine');
    const seen = new Set<string>();
    for (let roll = 1; roll <= 20; roll++) {
      const next = randomizeHair(look, 'editor:primary', roll);
      expect(next.hairStyle).not.toBe(look.hairStyle);
      expect(store('masculine')).toContain(next.hairStyle);
      seen.add(next.hairStyle);
    }
    expect(seen.size).toBeGreaterThan(1);
    expect(randomizeHair({ ...look, hairStyle: 'afro' }, 'editor:primary', 1).hairStyle).not.toBe('textured-crop');
  });
});

describe('no procedural clothing or hair in generated looks', () => {
  it('always wears GLB outfit models or wardrobe pieces and a detailed GLB hair', () => {
    for (let index = 0; index < 120; index++) {
      for (const presentation of ['masculine', 'feminine'] as const) {
        const look = defaultCharacterAppearance(`id${index}:primary`, presentation);
        expect(look.outfitModel !== undefined || look.outfitParts !== undefined, `${index}`).toBe(true);
        expect(detailedHairStyles(presentation)).toContain(look.hairStyle);
        const urls = sourceAvatarUrls(avatarVisual('x', look), sourceHairAsset(avatarVisual('x', look)), { '/public-assets/avatars/bodies/male/office-classic.glb': '/m.glb', '/public-assets/avatars/bodies/female/female-casual.glb': '/f.glb' }, HAIR, OUTFITS, PIECES);
        expect(urls?.hair).toBeTruthy();
        if (look.outfitModel) expect(urls?.outfit).toBeTruthy();
      }
    }
  });

  it('maps saved procedural hair to the nearest detailed GLB style without rewriting the saved value', () => {
    expect(glbHairStyle('curly', 'masculine')).toBe('textured-crop');
    expect(glbHairStyle('afro', 'masculine')).toBe('textured-crop');
    expect(glbHairStyle('wavy', 'feminine')).toBe('medium');
    expect(glbHairStyle('long', 'feminine')).toBe('medium');
    expect(glbHairStyle('bun', 'feminine')).toBe('bun');
    expect(glbHairStyle('not-a-style', 'masculine')).toBe('side-part');
    const saved: CharacterAppearance = { ...defaultCharacterAppearance('old:primary', 'masculine'), hairStyle: 'curly' };
    const visual = avatarVisual('old:primary', saved);
    expect(sourceHairAsset(visual).id).toBe('textured-crop');
    expect(saved.hairStyle).toBe('curly');
    expect(sourceHairAsset({ ...visual, hairVariant: 'long', presentation: 'feminine' }).id).toBe('medium');
  });
});

describe('shared store', () => {
  it('resolves the same allocation for every consumer of the roster', () => {
    setLookSalt('store');
    const characters = entries(6, 'masculine');
    expect(setLookRoster(characters)).toBe(true);
    expect(setLookRoster(characters)).toBe(false);
    const looks = characters.map(character => defaultCharacterAppearance(character.seed, 'masculine'));
    const held = new Set<string>();
    for (const [index, look] of looks.entries()) {
      expect(look.outfitModel ?? look.outfitParts).toEqual(generatedLookOf(characters[index]!.seed, 'masculine').outfitModel ?? generatedLookOf(characters[index]!.seed, 'masculine').outfitParts);
      const items = casualItems({ presentation: 'masculine', formal: false, hairStyle: look.hairStyle, ...(look.outfitModel ? { outfitModel: look.outfitModel } : {}), ...(look.outfitParts ? { outfitParts: look.outfitParts } : {}) });
      for (const item of items) { expect(held.has(item)).toBe(false); held.add(item); }
    }
    expect(new Set(looks.map(look => look.hairStyle)).size).toBe(5);
  });
});
