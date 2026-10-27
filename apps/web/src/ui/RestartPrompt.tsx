import type { HostState, RestartCapability } from '@extalia/platform';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { activeAgentWork, restartPlan } from '../restart/restartPlan';
import { useHasUnsavedDrafts } from '../restart/unsavedDrafts';
import { Icon } from './Icon';

/**
 * Restart Extalia (Desktop) or reload this page (Web). Running agent work or unsaved
 * text gets a confirmation first. Neither action touches the Bridge, the CLI, Hermes
 * or outside agent apps; approvals in those apps are separate.
 */
export function RestartPrompt({ t, restart, hostState, reason, onDismiss }: {
  t: Messages;
  restart: RestartCapability | undefined;
  hostState: HostState | null;
  /** Why a restart is suggested; shown first. */
  reason?: string;
  /** Adds a "Later" button. Omit it when the prompt is not optional. */
  onDismiss?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const primary = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const draftsPending = useHasUnsavedDrafts();
  const activeWork = activeAgentWork(hostState);

  // Focus moves into the confirmation so keyboard users land on the safe choice.
  useEffect(() => { if (confirming) cancel.current?.focus(); }, [confirming]);

  if (!restart) return null;

  const plan = restartPlan(restart.kind, { activeWork, unsavedDraft: draftsPending });
  const label = plan.label === 'restartNow' ? t.restart.restartNow : t.restart.reloadPage;
  const lead = restart.kind === 'relaunch' ? t.restart.desktopLead : t.restart.webLead;

  const perform = () => {
    setConfirming(false);
    setWorking(true);
    setError(undefined);
    // A relaunch ends the process, so a pending promise is normal; only a refusal reaches the catch.
    restart.restart(plan.options).catch(failure => {
      setWorking(false);
      setError(errorMessage(failure));
    });
  };

  const closeConfirmation = () => {
    setConfirming(false);
    primary.current?.focus();
  };

  const onDialogKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    closeConfirmation();
  };

  return (
    <div className="restart-prompt" role="region" aria-label={t.restart.title} aria-busy={working || undefined}>
      {reason && <p>{reason}</p>}
      <p className="muted small">{lead}</p>
      <p className="muted small">{t.restart.outsideNote}</p>
      <div className="actions">
        <button ref={primary} type="button" className="primary" disabled={working} onClick={() => (plan.confirm ? setConfirming(true) : perform())}>
          <Icon name="refresh" />{label}
        </button>
        {onDismiss && <button type="button" onClick={onDismiss}>{t.restart.later}</button>}
      </div>
      {confirming && (
        <div className="restart-confirm" role="alertdialog" aria-labelledby="restart-confirm-title" aria-describedby="restart-confirm-reasons" onKeyDown={onDialogKey}>
          <p id="restart-confirm-title"><strong>{t.restart.confirmQuestion}</strong></p>
          <ul id="restart-confirm-reasons">
            {plan.reasons.map(item => (
              <li key={item}>{item === 'activeWork' ? t.restart.activeWork[restart.kind](activeWork) : t.restart.unsavedDraft}</li>
            ))}
          </ul>
          <div className="actions">
            <button ref={cancel} type="button" onClick={closeConfirmation}>{t.common.cancel}</button>
            <button type="button" className="primary" onClick={perform}>{label}</button>
          </div>
        </div>
      )}
      <p role="status" aria-live="polite">{working ? (restart.kind === 'relaunch' ? t.restart.restarting : t.restart.reloading) : ''}</p>
      {error && <p role="alert" className="form-error"><Icon name="alert" />{error}</p>}
    </div>
  );
}
