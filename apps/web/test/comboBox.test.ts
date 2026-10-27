import { describe, expect, it } from 'vitest';
import { comboMatches } from '../src/ui/ComboBox';

const options = [
  { value: '', label: 'Profile default' },
  { value: 'ag/claude-opus-5-5', label: 'ag/claude-opus-5-5', group: 'ag' },
  { value: 'ag/gemini-3.8-flash-high', label: 'ag/gemini-3.8-flash-high', group: 'ag' },
  { value: 'or/qwen-3', label: 'or/qwen-3', group: 'or' },
];

describe('model combo box filtering', () => {
  it('shows everything without a query and filters case-insensitively by value or label', () => {
    expect(comboMatches(options, '').options).toHaveLength(4);
    expect(comboMatches(options, '').custom).toBeUndefined();
    expect(comboMatches(options, 'OPUS').options.map(option => option.value)).toEqual(['ag/claude-opus-5-5']);
    expect(comboMatches(options, 'default').options.map(option => option.value)).toEqual(['']);
  });

  it('offers what was typed as a custom model unless it matches an option exactly', () => {
    expect(comboMatches(options, 'my/local-model')).toEqual({ options: [], custom: 'my/local-model' });
    expect(comboMatches(options, 'ag/').custom).toBe('ag/');
    expect(comboMatches(options, 'or/qwen-3').custom).toBeUndefined();
  });
});
