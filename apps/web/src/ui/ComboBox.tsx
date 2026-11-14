import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { autoUpdate, flip, FloatingPortal, offset, shift, size, useFloating } from '@floating-ui/react';
import { useCombobox } from 'downshift';
import { Icon } from './Icon';

export interface ComboOption {
  readonly value: string;
  readonly label: string;
  /** Options with the same group are listed under one heading. */
  readonly group?: string;
  readonly description?: string;
  readonly badge?: string;
}

/** The options shown for `query`: matching ones (label or value), then a "use what I typed" entry when nothing matches exactly. */
export function comboMatches(options: readonly ComboOption[], query: string, limit = 200): { options: ComboOption[]; custom?: string } {
  const text = query.trim();
  const needle = text.toLowerCase();
  const matches = needle ? options.filter(option => option.value.toLowerCase().includes(needle) || option.label.toLowerCase().includes(needle)) : [...options];
  const exact = options.some(option => option.value === text);
  return { options: matches.slice(0, limit), ...(text && !exact ? { custom: text } : {}) };
}

/**
 * A text field with a glass list of suggestions, styled like `Select`. Any typed value is allowed;
 * the list only helps. ARIA combobox pattern: arrows move, Enter picks, Escape closes.
 */
export function ComboBox({ id, label, value, options, onChange, onBlur, placeholder, customLabel, emptyLabel, action, invalid, describedBy, maxLength = 200, disabled = false }: {
  id: string;
  label: string;
  value: string;
  options: readonly ComboOption[];
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  /** Text of the entry that keeps what was typed, e.g. `Use “x”`. */
  customLabel: (text: string) => string;
  emptyLabel: string;
  /** A button beside the field, e.g. rescan. */
  action?: ReactNode;
  invalid?: boolean;
  describedBy?: string;
  maxLength?: number;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState<string>();

  // Opening shows the catalog; typing filters it without restricting the saved value.
  const { options: shown, custom } = useMemo(() => comboMatches(options, query ?? ''), [options, query]);
  const entries = useMemo(() => [...shown.map(option => ({ value: option.value, option })), ...(custom ? [{ value: custom, option: undefined }] : [])], [shown, custom]);
  const selectedItem = useMemo(() => {
    const option = options.find(option => option.value === value);
    return option ? { value, option } : null;
  }, [options, value]);
  const {
    isOpen, highlightedIndex, getLabelProps, getInputProps, getToggleButtonProps,
    getMenuProps, getItemProps, openMenu, closeMenu, setHighlightedIndex,
  } = useCombobox({
    id,
    inputId: id,
    items: entries,
    selectedItem,
    inputValue: value,
    itemToString: item => item?.value ?? '',
    itemToKey: item => item?.value,
    defaultHighlightedIndex: entries.length ? Math.max(0, entries.findIndex(entry => entry.value === value)) : -1,
    stateReducer(state, { type, changes }) {
      if (disabled) return { ...state, isOpen: false };
      switch (type) {
        // Free text is already saved while typing. Blur must never pick the highlighted suggestion,
        // and a second Escape must not clear an arbitrary model ID.
        case useCombobox.stateChangeTypes.InputBlur:
        case useCombobox.stateChangeTypes.InputKeyDownEscape:
          return { ...changes, inputValue: state.inputValue, selectedItem: state.selectedItem };
        case useCombobox.stateChangeTypes.InputChange:
          return { ...changes, highlightedIndex: 0 };
        case useCombobox.stateChangeTypes.InputClick:
          return state.isOpen ? state : { ...changes, isOpen: true };
        default:
          return changes;
      }
    },
    onIsOpenChange({ isOpen, type }) {
      if (!isOpen || type !== useCombobox.stateChangeTypes.InputChange) setQuery(undefined);
    },
    onSelectedItemChange({ selectedItem: item }) {
      if (item && !disabled) onChange(item.value);
    },
  });
  // Async catalog refreshes can remove the active option without a keyboard action.
  // Reconcile through Downshift so its next Enter/arrow action uses a valid index.
  useEffect(() => {
    if (highlightedIndex >= entries.length) setHighlightedIndex(entries.length - 1);
  }, [entries.length, highlightedIndex, setHighlightedIndex]);
  useEffect(() => { if (disabled) closeMenu(); }, [disabled, closeMenu]);
  const { refs: { setReference, setFloating }, floatingStyles } = useFloating({
    open: isOpen && !disabled,
    placement: 'bottom-start',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(6),
      flip({ padding: 12 }),
      shift({ padding: 12 }),
      size({
        padding: 12,
        apply({ rects, availableWidth, availableHeight, elements }) {
          Object.assign(elements.floating.style, {
            width: `${Math.max(0, Math.min(rects.reference.width, availableWidth))}px`,
            maxHeight: `${Math.max(0, Math.min(340, availableHeight))}px`,
          });
        },
      }),
    ],
  });
  // Downshift supports an unmounted menu; Floating UI mounts it in a clipping-safe portal.
  const menuProps = getMenuProps({ ref: setFloating, 'aria-label': label }, { suppressRefError: true });

  let lastGroup: string | undefined;
  const menu = isOpen && !disabled && <FloatingPortal preserveTabOrder={false}>
    <div {...menuProps} className="glass-select-menu combo-menu" style={floatingStyles}>
      {entries.length === 0 && <div className="combo-empty">{emptyLabel}</div>}
      {entries.map((entry, index) => {
        const group = entry.option?.group;
        const heading = group && group !== lastGroup ? group : undefined;
        lastGroup = group ?? lastGroup;
        const selected = entry.option ? entry.value === value : false;
        return <div key={`${entry.option ? 'o' : 'c'}:${entry.value}`} role="presentation">
          {heading && <div className="combo-group" role="presentation">{heading}</div>}
          <div {...getItemProps({ item: entry, index, onClick: () => document.getElementById(id)?.focus() })} data-index={index}
            className="glass-select-option combo-option" data-highlighted={index === highlightedIndex ? '' : undefined} data-state={selected ? 'checked' : undefined}>
            <div className="glass-select-option-template">
              <span className="glass-select-option-icon" aria-hidden="true"><Icon name={entry.option ? 'spark' : 'edit'} /></span>
              <div className="glass-select-option-text">
                <div className="glass-select-option-header">
                  <span>{entry.option ? entry.option.label : customLabel(entry.value)}</span>
                  {entry.option?.badge && <span className="badge small">{entry.option.badge}</span>}
                </div>
                {entry.option?.description && <span className="glass-select-option-desc">{entry.option.description}</span>}
              </div>
            </div>
            {selected && <span className="glass-select-check"><Icon name="check" /></span>}
          </div>
        </div>;
      })}
    </div>
  </FloatingPortal>;

  return (
    <div className="radix-select-wrapper combo">
      <label {...getLabelProps()} className="glass-select-label">{label}</label>
      <div className="combo-row">
        <div ref={setReference} className="glass-select-trigger combo-trigger" data-state={isOpen && !disabled ? 'open' : 'closed'}>
          <input {...getInputProps({
            // Avoid a dangling ARIA reference in the render before reconciliation runs.
            ...(disabled || !entries[highlightedIndex] ? { 'aria-activedescendant': undefined } : {}),
            ...(disabled ? { 'aria-controls': undefined } : {}),
            disabled,
            onChange: event => { if (!disabled) { setQuery(event.target.value); onChange(event.target.value); } },
            onFocus: () => { if (!disabled) { setQuery(undefined); openMenu(); } },
            onBlur: () => onBlur?.(),
            onKeyDown: event => {
              if (event.key === 'Tab') closeMenu();
              if (event.key === 'Escape' && isOpen) event.stopPropagation();
            },
          })} type="text" aria-invalid={invalid || undefined} aria-describedby={describedBy} aria-expanded={isOpen && !disabled}
            placeholder={placeholder} maxLength={maxLength} spellCheck={false} />
          <button {...getToggleButtonProps({ disabled, onPointerDown: event => event.preventDefault() })}
            type="button" className="combo-toggle" aria-hidden="true">
            <Icon name="chevron" className="glass-select-chevron" />
          </button>
        </div>
        {action}
      </div>
      {menu}
    </div>
  );
}
