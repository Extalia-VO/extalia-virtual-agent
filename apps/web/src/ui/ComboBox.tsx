import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
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
export function ComboBox({ id, label, value, options, onChange, onBlur, placeholder, customLabel, emptyLabel, action, invalid, describedBy, maxLength = 200 }: {
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
}) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string>();
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState<{ left: number; top: number; width: number; maxHeight: number }>();

  // While typing, filter by the text; when just opened, show everything with the current value highlighted.
  const { options: shown, custom } = useMemo(() => comboMatches(options, query ?? ''), [options, query]);
  const entries = useMemo(() => [...shown.map(option => ({ value: option.value, option })), ...(custom ? [{ value: custom, option: undefined }] : [])], [shown, custom]);

  const place = () => {
    // Align with the whole glass trigger, not just the text inside it.
    const box = input.current?.parentElement?.getBoundingClientRect();
    if (!box) return;
    const below = window.innerHeight - box.bottom - 12;
    const above = box.top - 12;
    const up = below < 220 && above > below;
    const maxHeight = Math.max(160, Math.min(340, up ? above : below));
    setRect({ left: box.left, width: box.width, top: up ? box.top - 6 - maxHeight : box.bottom + 6, maxHeight });
  };
  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!input.current?.parentElement?.contains(target) && !list.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const show = () => {
    setQuery(undefined);
    const current = shown.findIndex(option => option.value === value);
    setActive(Math.max(0, current));
    setOpen(true);
  };
  const pick = (next: string) => {
    onChange(next);
    setQuery(undefined);
    setOpen(false);
    input.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) { show(); return; }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive(index => (index + step + entries.length) % Math.max(1, entries.length));
    } else if (event.key === 'Enter' && open && entries[active]) {
      event.preventDefault();
      pick(entries[active]!.value);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === 'Tab') setOpen(false);
  };

  let lastGroup: string | undefined;
  const menu = open && rect && createPortal(
    <div ref={list} id={listId} role="listbox" aria-label={label} className="glass-select-menu combo-menu"
      style={{ position: 'fixed', left: rect.left, top: rect.top, width: rect.width, maxHeight: rect.maxHeight }}>
      {entries.length === 0 && <div className="combo-empty">{emptyLabel}</div>}
      {entries.map((entry, index) => {
        const group = entry.option?.group;
        const heading = group && group !== lastGroup ? group : undefined;
        lastGroup = group ?? lastGroup;
        const selected = entry.option ? entry.value === value : false;
        return <div key={`${entry.option ? 'o' : 'c'}:${entry.value}`} role="presentation">
          {heading && <div className="combo-group" role="presentation">{heading}</div>}
          <div id={`${listId}-${index}`} role="option" aria-selected={selected} data-index={index}
            className="glass-select-option combo-option" data-highlighted={index === active ? '' : undefined} data-state={selected ? 'checked' : undefined}
            onPointerMove={() => setActive(index)} onPointerDown={event => event.preventDefault()} onClick={() => pick(entry.value)}>
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
    </div>,
    document.body,
  );

  return (
    <div className="radix-select-wrapper combo">
      <label htmlFor={id} className="glass-select-label">{label}</label>
      <div className="combo-row">
        <div className="glass-select-trigger combo-trigger" data-state={open ? 'open' : 'closed'}>
          <input ref={input} id={id} type="text" role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
            aria-activedescendant={open && entries[active] ? `${listId}-${active}` : undefined}
            aria-invalid={invalid || undefined} aria-describedby={describedBy}
            value={query ?? value} placeholder={placeholder} maxLength={maxLength} spellCheck={false} autoComplete="off"
            onChange={event => { setQuery(event.target.value); onChange(event.target.value); setActive(0); if (!open) setOpen(true); }}
            onFocus={() => { if (!open) show(); }} onClick={() => { if (!open) show(); }}
            onBlur={() => { setQuery(undefined); onBlur?.(); }} onKeyDown={onKeyDown} />
          <button type="button" className="combo-toggle" tabIndex={-1} aria-hidden="true"
            onPointerDown={event => event.preventDefault()} onClick={() => { if (open) setOpen(false); else { show(); input.current?.focus(); } }}>
            <Icon name="chevron" className="glass-select-chevron" />
          </button>
        </div>
        {action}
      </div>
      {menu}
    </div>
  );
}
