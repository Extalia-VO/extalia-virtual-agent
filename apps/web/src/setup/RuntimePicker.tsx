import type { RuntimeId } from '@extalia/core';
import { useId } from 'react';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { RuntimeIcon } from './RuntimeIcon';

/**
 * Agent runtime as selectable cards, used by the wizard and the workspace editor. It is a radio group,
 * so arrow keys move between the cards. Hermes Agent is disabled while it is not installed, and the
 * install hint shows under the cards.
 */
export function RuntimePicker({ t, legend, value, offered, hermesInstalled, runtimesReady, rechecking = false, onChange, onRecheck }: {
  t: Messages;
  legend: string;
  value: RuntimeId;
  offered: readonly RuntimeId[];
  hermesInstalled: boolean;
  /** The host has answered whether Hermes Agent is installed; until then it is being looked for. */
  runtimesReady: boolean;
  rechecking?: boolean;
  onChange: (runtime: RuntimeId) => void;
  /** Look for Hermes Agent again. */
  onRecheck?: () => void;
}) {
  const name = useId();
  const helpId = `${name}-help`;
  const showHelp = offered.includes('hermes') && !hermesInstalled;
  return (
    <fieldset className="preset-picker runtime-picker">
      <legend>{legend}</legend>
      <div className="preset-grid runtime-grid">
        {offered.map(runtime => {
          const checked = value === runtime;
          const unavailable = runtime === 'hermes' && !hermesInstalled;
          // A card that is already selected stays enabled, so its state can be seen and changed.
          const disabled = unavailable && !checked;
          return (
            <label key={runtime} className="preset-card provider-card runtime-card" aria-disabled={disabled || undefined}>
              <input type="radio" name={name} value={runtime} checked={checked} disabled={disabled}
                aria-describedby={unavailable && showHelp ? helpId : undefined} onChange={() => onChange(runtime)} />
              <span className="provider-card-head" aria-hidden="true">
                <span className="preset-brand"><RuntimeIcon runtime={runtime} /></span>
                {unavailable && runtimesReady ? <span className="chip">{t.setup.runtimeNotSelectable}</span>
                  : checked ? <span className="runtime-check"><Icon name="check" /></span> : null}
              </span>
              <span className="preset-name">{t.workspace.runtimes[runtime]}</span>
              <span className="preset-hint">{t.workspace.runtimeHints[runtime]}</span>
            </label>
          );
        })}
      </div>
      {showHelp && (
        <div className="runtime-help" id={helpId} role="status">
          <p className="note"><Icon name={runtimesReady ? 'alert' : 'refresh'} />{runtimesReady ? t.setup.runtimeHermesMissing : t.setup.runtimeChecking}</p>
          {runtimesReady && onRecheck && (
            <button type="button" className="button small" disabled={rechecking} onClick={onRecheck}>
              <Icon name="refresh" className={rechecking ? 'spin' : ''} />{t.setup.runtimeCheckAgain}
            </button>
          )}
        </div>
      )}
    </fieldset>
  );
}
