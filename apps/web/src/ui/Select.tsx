import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from './Icon';

export interface SelectOption<T extends string = string> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

export interface SelectProps<T extends string = string> {
  readonly id?: string;
  readonly label?: string;
  readonly value: T;
  readonly options: readonly SelectOption<T>[];
  readonly onChange: (value: T) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly 'aria-label'?: string;
}

/**
 * macOS-style Liquid Glass Custom Select with keyboard navigation and popover menu.
 */
export function Select<T extends string = string>({
  id: explicitId,
  label,
  value,
  options,
  onChange,
  placeholder,
  disabled = false,
  className = '',
  'aria-label': ariaLabel
}: SelectProps<T>) {
  const generatedId = useId();
  const id = explicitId ?? generatedId;
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const selectedOption = options.find(opt => opt.value === value);

  // Close when clicking outside
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div
      ref={containerRef}
      className={`glass-select-container ${className} ${disabled ? 'disabled' : ''} ${open ? 'open' : ''}`}
    >
      {label && (
        <label htmlFor={id} className="glass-select-label">
          {label}
        </label>
      )}
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel ?? label}
        className="glass-select-trigger"
        onClick={() => setOpen(!open)}
      >
        <span className="glass-select-value">
          {selectedOption ? selectedOption.label : (placeholder ?? '—')}
        </span>
        <span className="glass-select-chevron" aria-hidden="true">
          <Icon name="chevron" />
        </span>
      </button>

      {open && (
        <ul
          className="glass-select-menu"
          role="listbox"
          tabIndex={-1}
          aria-labelledby={id}
        >
          {options.map(option => {
            const isSelected = option.value === value;
            return (
              <li
                key={option.value}
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled}
                className={`glass-select-option ${isSelected ? 'selected' : ''} ${option.disabled ? 'disabled' : ''}`}
                onClick={() => {
                  if (option.disabled) return;
                  onChange(option.value);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                <div className="glass-select-option-content">
                  <span className="glass-select-option-label">{option.label}</span>
                  {option.description && (
                    <span className="glass-select-option-desc">{option.description}</span>
                  )}
                </div>
                {isSelected && (
                  <span className="glass-select-check">
                    <Icon name="check" />
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
