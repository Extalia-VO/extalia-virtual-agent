import * as RadixSelect from '@radix-ui/react-select';
import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export interface SelectOption<T extends string = string> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
  readonly icon?: IconName;
  readonly badge?: string;
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
  /** Optional custom template renderer for option slots */
  readonly renderOption?: (option: SelectOption<T>) => ReactNode;
}

/**
 * Headless Radix UI Select with macOS Liquid Glass theme & template slot support.
 */
export function Select<T extends string = string>({
  id,
  label,
  value,
  options,
  onChange,
  placeholder = 'Select…',
  disabled = false,
  className = '',
  'aria-label': ariaLabel,
  renderOption
}: SelectProps<T>) {
  const selectedOption = options.find(opt => opt.value === value);

  return (
    <div className={`radix-select-wrapper ${className}`}>
      {label && <label htmlFor={id} className="glass-select-label">{label}</label>}
      <RadixSelect.Root value={value} onValueChange={onChange} disabled={disabled}>
        <RadixSelect.Trigger
          id={id}
          className="glass-select-trigger"
          aria-label={ariaLabel ?? label}
        >
          <div className="glass-select-trigger-content">
            {selectedOption?.icon && (
              <span className="glass-select-icon" aria-hidden="true">
                <Icon name={selectedOption.icon} />
              </span>
            )}
            <RadixSelect.Value placeholder={placeholder}>
              {selectedOption ? selectedOption.label : placeholder}
            </RadixSelect.Value>
            {selectedOption?.badge && (
              <span className="badge small">{selectedOption.badge}</span>
            )}
          </div>
          <RadixSelect.Icon className="glass-select-chevron">
            <Icon name="chevron" />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>

        <RadixSelect.Portal>
          <RadixSelect.Content className="glass-select-menu" position="popper" sideOffset={6}>
            <RadixSelect.ScrollUpButton className="glass-select-scroll">
              <Icon name="chevron" className="rotate-180" />
            </RadixSelect.ScrollUpButton>
            <RadixSelect.Viewport className="glass-select-viewport">
              {options.map(option => (
                <RadixSelect.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className="glass-select-option"
                >
                  {renderOption ? (
                    renderOption(option)
                  ) : (
                    <div className="glass-select-option-template">
                      {option.icon && (
                        <span className="glass-select-option-icon" aria-hidden="true">
                          <Icon name={option.icon} />
                        </span>
                      )}
                      <div className="glass-select-option-text">
                        <div className="glass-select-option-header">
                          <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                          {option.badge && <span className="badge small">{option.badge}</span>}
                        </div>
                        {option.description && (
                          <span className="glass-select-option-desc">{option.description}</span>
                        )}
                      </div>
                    </div>
                  )}
                  <RadixSelect.ItemIndicator className="glass-select-check">
                    <Icon name="check" />
                  </RadixSelect.ItemIndicator>
                </RadixSelect.Item>
              ))}
            </RadixSelect.Viewport>
            <RadixSelect.ScrollDownButton className="glass-select-scroll">
              <Icon name="chevron" />
            </RadixSelect.ScrollDownButton>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
    </div>
  );
}
