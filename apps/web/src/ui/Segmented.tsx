import { useId } from 'react';

/** A radio group drawn as a segmented control; arrow keys move between options natively. */
export function Segmented<T extends string>({ legend, value, options, onChange, className = '' }: {
  legend: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  const name = useId();
  return (
    <fieldset className={`segmented-field ${className}`}>
      <legend>{legend}</legend>
      <div className="segmented">
        {options.map(option => (
          <label key={option.value} className="segment">
            <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
