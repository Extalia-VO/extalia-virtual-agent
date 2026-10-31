import { describe, expect, it } from 'vitest';
import { normalizePromptLearnSkill } from '../src/index.js';

describe('explicit per-message skill-learning choice', () => {
  it('defaults off and accepts only explicit boolean values beside attachment options', () => {
    for (const raw of [undefined, null, {}, { learnSkill: undefined }, { learnSkill: false }, { attachmentIds: ['attachment'] }]) expect(normalizePromptLearnSkill(raw)).toBe(false);
    expect(normalizePromptLearnSkill({ learnSkill: true, attachmentIds: ['attachment'] })).toBe(true);
    expect(normalizePromptLearnSkill(Object.create({ learnSkill: true }))).toBe(false);
  });
  it.each([true, 'true', [], { learnSkill: 'true' }, { learnSkill: 1 }, { learnSkill: null }, { learnSkill: {} }])('refuses ambiguous learning input %j', raw => {
    expect(() => normalizePromptLearnSkill(raw)).toThrow();
  });
});
