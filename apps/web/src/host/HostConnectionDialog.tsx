import type { Messages } from '../i18n';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../ui/Icon';
import './hostConnection.css';

/** Retain the mounted view and drafts until a fresh host snapshot confirms recovery. */
export function HostConnectionDialog({ t, error, desktop, onRetry }: {
  t: Messages; error: string | null; desktop: boolean; onRetry(): void;
}) {
  if (!error) return null;
  return <Disconnected t={t} desktop={desktop} onRetry={onRetry} />;
}

function Disconnected({ t, desktop, onRetry }: { t: Messages; desktop: boolean; onRetry(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current, previous = document.activeElement;
    node?.showModal();
    return () => { node?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return createPortal(<dialog ref={dialog} className="host-connection-dialog" role="alertdialog" aria-modal="true"
    aria-labelledby="host-connection-title" aria-describedby="host-connection-description" onCancel={event => event.preventDefault()}>
    <div className="host-connection-symbol"><Icon name="alert" /></div>
    <h2 id="host-connection-title">{t.hostConnection.title}</h2>
    <p id="host-connection-description">{desktop ? t.hostConnection.desktop : t.hostConnection.bridge}</p>
    <p className="muted small">{t.hostConnection.snapshot}</p>
    <p className="host-connection-retrying" role="status"><Icon name="refresh" />{t.hostConnection.reconnecting}</p>
    <div className="actions"><button type="button" className="button primary" autoFocus onClick={onRetry}>{t.common.retry}</button></div>
  </dialog>, document.body);
}
