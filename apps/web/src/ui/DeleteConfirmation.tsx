import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Messages } from '../i18n';
import { Icon } from './Icon';
import './deleteConfirmation.css';

/** A separate, focused decision; opening a delete control never deletes its target. */
export function DeleteConfirmation({ t, title, target, description, busy = false, error, confirmLabel, onConfirm, onCancel }: {
  t: Messages; title: string; target: string; description: string;
  busy?: boolean; error?: string | null; confirmLabel?: string;
  onConfirm(): void; onCancel(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    const element = dialog.current, previous = document.activeElement;
    element?.showModal();
    cancel.current?.focus();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return createPortal(<dialog ref={dialog} className="delete-confirmation-dialog" role="alertdialog" aria-modal="true"
    aria-labelledby={`${id}-title`} aria-describedby={`${id}-target ${id}-description`} aria-busy={busy || undefined}
    onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <header><Icon name="trash" /><h2 id={`${id}-title`}>{title}</h2></header>
    <p id={`${id}-target`} className="delete-confirmation-target">{target}</p>
    <p id={`${id}-description`}>{description}</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    {busy && <p className="muted small" role="status"><Icon name="refresh" className="spin" />{t.deletion.deleting}</p>}
    <footer>
      <button ref={cancel} type="button" className="button" autoFocus disabled={busy} onClick={onCancel}>{t.common.cancel}</button>
      <button type="button" className="button danger" disabled={busy} onClick={() => { if (!busy) onConfirm(); }}>{confirmLabel ?? t.common.delete}</button>
    </footer>
  </dialog>, document.body);
}
