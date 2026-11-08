import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ComboBox, comboMatches } from '../src/ui/ComboBox';

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

  it('caps catalog suggestions without losing custom choices or mistaking a truncated exact match for a custom ID', () => {
    const catalog = Array.from({ length: 220 }, (_, index) => ({ value: `model-${index}`, label: `Model ${index}` }));
    expect(comboMatches(catalog, '').options).toHaveLength(200);
    expect(comboMatches(catalog, 'model-', 3)).toEqual({ options: catalog.slice(0, 3), custom: 'model-' });
    expect(comboMatches(catalog, 'model-219', 0)).toEqual({ options: [] });
    expect(comboMatches(catalog, '  custom/model  ')).toEqual({ options: [], custom: 'custom/model' });
    expect(comboMatches(catalog, '   ').custom).toBeUndefined();
  });
});

describe('library combobox server rendering', () => {
  it.each(['ag/claude-opus-5-5', 'custom/unlisted-model'])('renders saved value %s without a browser or opening a portal', value => {
    const html = renderToStaticMarkup(createElement(ComboBox, {
      id: 'model-picker', label: 'Model', value, options,
      onChange() {}, customLabel: text => `Use ${text}`, emptyLabel: 'No models',
      invalid: true, describedBy: 'model-error', maxLength: 128,
      action: createElement('button', { type: 'button' }, 'Rescan'),
    }));
    expect(html).toContain('role="combobox"');
    expect(html).toContain('for="model-picker"');
    expect(html).toContain(`value="${value}"`);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="model-error"');
    expect(html).toContain('maxLength="128"');
    expect(html).toContain('Rescan');
    expect(html).not.toContain('role="listbox"');
  });
});
