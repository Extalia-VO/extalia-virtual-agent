import * as RadixSelect from '@radix-ui/react-select';
import { useId, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { FlagIcon } from './FlagIcon';

export interface SelectOption<T extends string = string> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
  readonly icon?: IconName;
  readonly flag?: 'en' | 'id';
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
  readonly title?: string;
  readonly className?: string;
  readonly 'aria-label'?: string;
  readonly 'aria-describedby'?: string;
  readonly 'aria-invalid'?: boolean;
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
  title,
  className = '',
  'aria-label': ariaLabel,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
  renderOption
}: SelectProps<T>) {
  const generatedId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const triggerId = id ?? generatedId;
  const selectedOption = options.find(opt => opt.value === value);
  // Radix reserves an empty value for its placeholder. Encode every option,
  // so a real empty choice (workspace root / All) cannot collide with an ID.
  const itemValue = (optionValue: T) => `option:${optionValue}`;

  return (
    <div className={`radix-select-wrapper ${className}`}>
      {label && <label htmlFor={triggerId} className="glass-select-label">{label}</label>}
      <RadixSelect.Root value={selectedOption ? itemValue(value) : ''} onOpenChange={open => {
        // Native modal dialogs make everything outside their top layer inert.
        if (open) setPortalContainer(trigger.current?.closest('dialog') ?? null);
      }} onValueChange={next => {
        const option = options.find(candidate => itemValue(candidate.value) === next);
        if (option && !option.disabled) onChange(option.value);
      }} disabled={disabled}>
        <RadixSelect.Trigger
          ref={trigger}
          id={triggerId}
          className="glass-select-trigger"
          title={title}
          aria-label={ariaLabel ?? label}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
        >
          <div className="glass-select-trigger-content">
            {selectedOption?.flag && (
              <span className="glass-select-flag" aria-hidden="true">
                <FlagIcon language={selectedOption.flag} />
              </span>
            )}
            {selectedOption?.icon && !selectedOption?.flag && (
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

        <RadixSelect.Portal container={portalContainer}>
          <RadixSelect.Content className="glass-select-menu" position="popper" sideOffset={6}>
            <RadixSelect.ScrollUpButton className="glass-select-scroll">
              <Icon name="chevron" className="rotate-180" />
            </RadixSelect.ScrollUpButton>
            <RadixSelect.Viewport className="glass-select-viewport">
              {options.map(option => (
                <RadixSelect.Item
                  key={option.value}
                  value={itemValue(option.value)}
                  textValue={option.label}
                  disabled={option.disabled}
                  className="glass-select-option"
                >
                  {renderOption ? (
                    renderOption(option)
                  ) : (
                    <div className="glass-select-option-template">
                      {option.flag && (
                        <span className="glass-select-flag" aria-hidden="true">
                          <FlagIcon language={option.flag} />
                        </span>
                      )}
                      {option.icon && !option.flag && (
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
