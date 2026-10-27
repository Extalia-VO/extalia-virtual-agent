import { describe, expect, it } from 'vitest';
import {
  CHARACTER_APPEARANCES_SCHEMA, MAX_CHARACTER_APPEARANCES, characterSessionId, decodeCharacterAppearance, decodeCharacterAppearanceStore,
  isCharacterId, type CharacterAppearance,
} from '../src/index.js';

const LOOK: CharacterAppearance = {
  presentation: 'feminine', hairStyle: 'bun', hairColor: '#4D382D', skinTone: '#c79a82',
  outfit: 'business-casual', top: 'blouse', bottom: 'skirt', topColor: '#efe9dc', stature: 'slender', heightCm: 168, gait: 'feminine',
  accessories: { glasses: 'round', watch: 'classic', earrings: 'hoops', bag: 'tote', tie: false, badge: true, headphones: false },
};

const failures = (raw: unknown) => {
  const result = decodeCharacterAppearance(raw);
  return result.ok ? [] : result.errors;
};

describe('character appearance contract', () => {
  it('accepts a complete look and normalizes colors to lowercase', () => {
    const result = decodeCharacterAppearance(LOOK);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ ...LOOK, hairColor: '#4d382d' });
  });

  it('rejects unknown fields, unknown values, bad colors and unbounded sizes', () => {
    expect(failures({ ...LOOK, gender: 'female' })[0]).toMatch(/gender: unknown field/);
    expect(failures({ ...LOOK, accessories: { ...LOOK.accessories, cape: true } })[0]).toMatch(/accessories\.cape: unknown field/);
    expect(failures({ ...LOOK, presentation: 'female' })[0]).toMatch(/presentation/);
    expect(failures({ ...LOOK, hairStyle: 'mohawk' })[0]).toMatch(/hairStyle/);
    expect(failures({ ...LOOK, bottom: 'kilt' })[0]).toMatch(/bottom/);
    expect(failures({ ...LOOK, gait: 'march' })[0]).toMatch(/gait/);
    expect(failures({ ...LOOK, accessories: { ...LOOK.accessories, bag: 'backpack' } })[0]).toMatch(/bag/);
    expect(failures({ ...LOOK, accessories: { ...LOOK.accessories, tie: 'yes' } })[0]).toMatch(/tie/);
    for (const color of ['#fff', 'red', '#12345g', '#1234567', 42]) expect(failures({ ...LOOK, skinTone: color })[0]).toMatch(/skinTone/);
    for (const height of [144, 196, 170.5, '170', Number.NaN]) expect(failures({ ...LOOK, heightCm: height })[0]).toMatch(/heightCm/);
    const { accessories: _accessories, ...withoutAccessories } = LOOK;
    expect(failures(withoutAccessories)[0]).toMatch(/accessories/);
    expect(failures(null)[0]).toMatch(/expected an object/);
    expect(failures([LOOK])[0]).toMatch(/expected an object/);
  });

  it('keeps optional garment colors and height optional', () => {
    const { topColor: _topColor, heightCm: _heightCm, ...plain } = LOOK;
    const result = decodeCharacterAppearance(plain);
    expect(result.ok && result.value).toEqual({ ...plain, hairColor: '#4d382d' });
  });

  it('accepts only bounded, session-scoped character ids', () => {
    expect(isCharacterId('s_abc:primary')).toBe(true);
    expect(isCharacterId('s_abc:worker:2')).toBe(true);
    expect(characterSessionId('s_abc:worker:2')).toBe('s_abc');
    for (const id of ['', 'primary', ':primary', 's_abc:', ' s_abc:primary', 's_abc:pri\nmary', '__proto__', `s:${'x'.repeat(300)}`, 7]) {
      expect(isCharacterId(id)).toBe(false);
    }
  });
});

describe('character appearance store', () => {
  it('round-trips a valid store', () => {
    const store = { schema: CHARACTER_APPEARANCES_SCHEMA, characters: { 's_1:primary': LOOK } };
    const result = decodeCharacterAppearanceStore(JSON.parse(JSON.stringify(store)));
    expect(result.ok && Object.keys(result.value.characters)).toEqual(['s_1:primary']);
  });

  it('rejects the whole file when the schema, an id or any entry is invalid', () => {
    const bad = [
      { schema: 'other', characters: {} },
      { schema: CHARACTER_APPEARANCES_SCHEMA, characters: [] },
      { schema: CHARACTER_APPEARANCES_SCHEMA, characters: {}, extra: true },
      { schema: CHARACTER_APPEARANCES_SCHEMA, characters: { primary: LOOK } },
      { schema: CHARACTER_APPEARANCES_SCHEMA, characters: { 's_1:primary': LOOK, 's_2:primary': { ...LOOK, hairColor: 'brown' } } },
      JSON.parse(`{"schema":"${CHARACTER_APPEARANCES_SCHEMA}","characters":{"__proto__":${JSON.stringify(LOOK)}}}`),
    ];
    for (const raw of bad) expect(decodeCharacterAppearanceStore(raw).ok).toBe(false);
    const crowded = Object.fromEntries(Array.from({ length: MAX_CHARACTER_APPEARANCES + 1 }, (_, index) => [`s_${index}:primary`, LOOK]));
    expect(decodeCharacterAppearanceStore({ schema: CHARACTER_APPEARANCES_SCHEMA, characters: crowded }).ok).toBe(false);
  });
});
