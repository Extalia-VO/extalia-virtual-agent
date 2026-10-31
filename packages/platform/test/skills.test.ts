import { describe, expect, it } from 'vitest';
import { BUILTIN_SKILL_CATEGORIES, MAX_BUILTIN_SKILL_BODY, normalizeBuiltinSkills } from '../src/skills.js';

describe('built-in skill catalog metadata', () => {
  it('keeps legacy lists valid, sorted and de-duplicated with the last entry winning', () => {
    expect(normalizeBuiltinSkills([
      { name: 'write-tests', description: ' Tests. ' },
      { name: 'code-review', description: 'Old.', category: 'quality', body: 'Old body.' },
      { name: 'code-review', description: ' Review. ' },
    ])).toEqual([{ name: 'code-review', description: 'Review.' }, { name: 'write-tests', description: 'Tests.' }]);
  });

  it('accepts only the bounded category vocabulary and clones presentation data', () => {
    expect(BUILTIN_SKILL_CATEGORIES).toEqual(['planning', 'development', 'quality', 'security', 'documentation', 'delivery']);
    const input = BUILTIN_SKILL_CATEGORIES.map((category, index) => ({
      name: `skill-${index}`, description: 'Summary.', category, body: ' \n# Instructions\n\tRead carefully.\r\n ', source: 'workspace', permissions: ['terminal'],
    }));
    const result = normalizeBuiltinSkills(input);
    expect(result.map(skill => skill.category)).toEqual(BUILTIN_SKILL_CATEGORIES);
    expect(result.every(skill => skill.body === '# Instructions\n\tRead carefully.')).toBe(true);
    expect(result.every(skill => Object.keys(skill).sort().join(',') === 'body,category,description,name')).toBe(true);
    result[0]!.description = 'Edited response.';
    result[0]!.body = 'Edited body.';
    expect(input[0]!.description).toBe('Summary.');
    expect(input[0]!.body).toContain('# Instructions');
    input[1]!.body = 'Edited source.';
    expect(result[1]!.body).toBe('# Instructions\n\tRead carefully.');
  });

  it.each([undefined, null, '', 'Quality', 'future-category', 'quality '.repeat(1000), 42, {}, ['quality']])('omits an unknown category (%j) without guessing', category => {
    expect(normalizeBuiltinSkills([{ name: 'code-review', description: 'Review.', category }]))
      .toEqual([{ name: 'code-review', description: 'Review.' }]);
  });

  it('accepts instruction bodies at the exact bound and omits oversized bodies rather than truncating them', () => {
    expect(normalizeBuiltinSkills([{ name: 'valid', description: '', body: 'x'.repeat(MAX_BUILTIN_SKILL_BODY) }])[0]!.body)
      .toHaveLength(MAX_BUILTIN_SKILL_BODY);
    expect(normalizeBuiltinSkills([{ name: 'oversized', description: '', body: 'x'.repeat(MAX_BUILTIN_SKILL_BODY + 1) }]))
      .toEqual([{ name: 'oversized', description: '' }]);
  });

  it.each([undefined, null, '', ' \n\t ', 42, {}, [], () => 'execute', 'a\0b', 'a\u001bb', 'a\u007fb', 'a\u009fb'])('omits a malformed optional body (%j) and preserves valid category metadata', body => {
    expect(normalizeBuiltinSkills([{ name: 'code-review', description: 'Review.', category: 'quality', body }]))
      .toEqual([{ name: 'code-review', description: 'Review.', category: 'quality' }]);
  });

  it('keeps markup as literal inspection text without interpreting it', () => {
    const body = '<script>throw new Error("must remain text")</script>\n$(echo sample)';
    expect(normalizeBuiltinSkills([{ name: 'review', description: 'Review.', body }])[0]!.body).toBe(body);
  });
});
