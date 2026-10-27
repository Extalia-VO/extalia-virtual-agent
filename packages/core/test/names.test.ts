import { describe, expect, it } from 'vitest';
import { FAMILY_NAMES, FEMALE_FIRST_NAMES, MALE_FIRST_NAMES, generateFullName } from '../src/index.js';

describe('generateFullName', () => {
  it('is deterministic per seed and gives a first and family name of the chosen gender', () => {
    const first = generateFullName('s_abc123', new Set());
    expect(generateFullName('s_abc123', new Set())).toEqual(first);
    const [given, family] = first.name.split(' ');
    expect(FAMILY_NAMES).toContain(family);
    expect(first.gender === 'female' ? FEMALE_FIRST_NAMES : MALE_FIRST_NAMES).toContain(given);
    const female = generateFullName('s_abc123', new Set(), 'female');
    expect(female.gender).toBe('female');
    expect(FEMALE_FIRST_NAMES).toContain(female.name.split(' ')[0]);
    expect(MALE_FIRST_NAMES).toContain(generateFullName('s_abc123', new Set(), 'male').name.split(' ')[0]);
  });

  it('spreads seeds over both genders and many names', () => {
    const results = Array.from({ length: 200 }, (_, index) => generateFullName(`seed-${index}`, new Set()));
    expect(new Set(results.map(result => result.gender)).size).toBe(2);
    expect(new Set(results.map(result => result.name)).size).toBeGreaterThan(180);
  });

  it('never returns a taken name (case-insensitive), even when every pair of a gender is used', () => {
    const taken = new Set<string>();
    for (let index = 0; index < 500; index++) {
      const { name } = generateFullName(`session-${index}`, taken);
      expect(taken.has(name.toLowerCase())).toBe(false);
      taken.add(name.toLowerCase());
    }
    expect(taken.size).toBe(500);
    const collide = generateFullName('x', new Set());
    expect(generateFullName('x', new Set([collide.name.toUpperCase()]), collide.gender).name).not.toBe(collide.name);
    const all = new Set(FEMALE_FIRST_NAMES.flatMap(given => FAMILY_NAMES.map(family => `${given} ${family}`)));
    expect(generateFullName('full', all, 'female').name).toMatch(/ 2$/);
  });

  it('keeps first names unique within each list and the lists disjoint', () => {
    expect(new Set(FEMALE_FIRST_NAMES).size).toBe(FEMALE_FIRST_NAMES.length);
    expect(new Set(MALE_FIRST_NAMES).size).toBe(MALE_FIRST_NAMES.length);
    expect(new Set(FAMILY_NAMES).size).toBe(FAMILY_NAMES.length);
    expect(FEMALE_FIRST_NAMES.filter(name => MALE_FIRST_NAMES.includes(name))).toEqual([]);
  });
});
