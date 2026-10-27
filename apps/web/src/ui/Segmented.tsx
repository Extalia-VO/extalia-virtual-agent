import { useId, type ReactNode } from 'react';

export interface SegmentedOption<T extends string = string> {
  readonly value: T;
  readonly label: string;
  readonly icon?: ReactNode;
}

/** A radio group drawn as a segmented control; arrow keys move between options natively. */
export function Segmented<T extends string>({
  legend,
  value,
  options,
  onChange,
  hint,
  className = ''
}: {
  legend: string;
  value: T;
  options: readonly (SegmentedOption<T> | { value: T; label: string })[];
  onChange: (value: T) => void;
  /** Explains the current choice; read out with the group. */
  hint?: ReactNode;
  className?: string;
}) {
  const name = useId();
  return (
    <fieldset className={`segmented-field ${className}`} aria-describedby={hint ? `${name}-hint` : undefined}>
      <legend>{legend}</legend>
      <div className="segmented">
        {options.map(option => {
          const opt = option as SegmentedOption<T>;
          return (
            <label key={opt.value} className="segment">
              <input
                type="radio"
                name={name}
                value={opt.value}
                checked={value === opt.value}
                onChange={() => onChange(opt.value)}
              />
              <span className="segment-label">
                {opt.icon && <span className="segment-icon" aria-hidden="true">{opt.icon}</span>}
                {opt.label}
              </span>
            </label>
          );
        })}
      </div>
      {hint && <p className="segmented-hint muted small" id={`${name}-hint`} aria-live="polite">{hint}</p>}
    </fieldset>
  );
}
