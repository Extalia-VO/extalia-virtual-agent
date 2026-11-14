import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComboBox } from '../src/ui/ComboBox';

const hook = vi.hoisted(() => ({ config: {} as Record<string, unknown>, input: {} as Record<string, unknown>, toggle: {} as Record<string, unknown> }));
vi.mock('downshift', () => ({ useCombobox: Object.assign((config: Record<string, unknown>) => {
  hook.config = config;
  return {
    isOpen: true, highlightedIndex: 0,
    getLabelProps: () => ({}), getMenuProps: () => ({}), getItemProps: () => ({}),
    getInputProps: (props: Record<string, unknown>) => { hook.input = props; return props; },
    getToggleButtonProps: (props: Record<string, unknown>) => { hook.toggle = props; return props; },
    openMenu: vi.fn(), closeMenu: vi.fn(), setHighlightedIndex: vi.fn(),
  };
}, { stateChangeTypes: { InputBlur: 'blur', InputKeyDownEscape: 'escape', InputChange: 'change', InputClick: 'click' } }) }));
beforeEach(() => { hook.config = {}; hook.input = {}; hook.toggle = {}; });

describe('disabled model combobox events', () => {
  const draw = (disabled: boolean) => {
    const onChange = vi.fn();
    const html = renderToStaticMarkup(createElement(ComboBox, { id: 'model', label: 'Model', value: 'saved-model',
      options: [{ value: '', label: 'Connection default' }], disabled, onChange, customLabel: value => `Use ${value}`, emptyLabel: 'No models' }));
    return { html, onChange };
  };
  it('hides an already-open menu and fences typing, selecting and reopening when disabled', () => {
    const { html, onChange } = draw(true);
    expect(html).not.toContain('combo-menu'); expect(html).toContain('aria-expanded="false"');
    expect(hook.input.disabled).toBe(true); expect(hook.toggle.disabled).toBe(true);
    expect(hook.input['aria-activedescendant']).toBeUndefined(); expect(hook.input['aria-controls']).toBeUndefined();
    (hook.input.onChange as (event: unknown) => void)({ target: { value: 'new-model' } });
    (hook.config.onSelectedItemChange as (value: unknown) => void)({ selectedItem: { value: 'new-model' } });
    expect(onChange).not.toHaveBeenCalled();
    const state = { isOpen: true, inputValue: 'saved-model', selectedItem: null };
    expect((hook.config.stateReducer as (state: unknown, action: unknown) => unknown)(state, { type: 'click', changes: { isOpen: true, inputValue: 'new-model' } }))
      .toEqual({ ...state, isOpen: false });
  });
  it('preserves custom IDs and the empty inheritance value for enabled callers', () => {
    const { onChange } = draw(false);
    (hook.input.onChange as (event: unknown) => void)({ target: { value: 'custom/model' } });
    (hook.config.onSelectedItemChange as (value: unknown) => void)({ selectedItem: { value: '' } });
    expect(onChange.mock.calls).toEqual([['custom/model'], ['']]);
  });
});
