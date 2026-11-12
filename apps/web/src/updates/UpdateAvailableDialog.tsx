import type { UpdateCapability, UpdateStatus } from '@extalia/platform';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Messages } from '../i18n';
import { errorMessage } from '../host/remote';
import { Icon } from '../ui/Icon';
import './updates.css';

/** One prompt per release per app opening; Later leaves manual update controls available. */
export function UpdateAvailableDialog({ t, updater, status, enabled = true }: {
  t: Messages; updater: UpdateCapability | undefined; status: UpdateStatus | null; enabled?: boolean;
}) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const version = status?.latest;
  if (!enabled || !updater || status?.state !== 'available' || !version || dismissed.includes(version)) return null;
  return <UpdateConfirmation key={version} t={t} updater={updater} status={status} onLater={() => setDismissed(previous => [...previous, version])} />;
}

function UpdateConfirmation({ t, updater, status, onLater }: {
  t: Messages; updater: UpdateCapability; status: UpdateStatus; onLater: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const admitted = useRef(false);
  useEffect(() => {
    const node = dialog.current;
    const previous = document.activeElement;
    node?.showModal();
    return () => { node?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const approve = () => {
    if (admitted.current) return;
    admitted.current = true;
    setWorking(true); setError(undefined);
    void updater.install(status.latest).catch(failure => {
      admitted.current = false; setWorking(false); setError(errorMessage(failure));
    });
  };
  return createPortal(<dialog ref={dialog} className="update-confirmation" aria-labelledby="update-confirm-title" aria-describedby="update-confirm-description" onCancel={event => { event.preventDefault(); if (!working) onLater(); }} onKeyDown={event => {
    if (event.key !== 'Tab') return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <div className="update-confirm-icon"><Icon name="download" /></div>
    <h2 id="update-confirm-title">{t.updates.confirm.title}</h2>
    <p className="update-confirm-version">{t.updates.banner.available(status.latest!)}</p>
    <dl className="facts"><div><dt>{t.updates.current}</dt><dd>{status.current}</dd></div><div><dt>{t.updates.latest}</dt><dd>{status.latest}</dd></div></dl>
    <p id="update-confirm-description" className="muted small">{t.updates.confirm.description}</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="actions">
      <button type="button" autoFocus disabled={working} onClick={onLater}>{t.updates.banner.later}</button>
      <button type="button" className="primary" disabled={working} onClick={approve}>{working ? t.updates.states.downloading : t.updates.banner.update}</button>
    </div>
  </dialog>, document.body);
}
