import { workspaceRuntime, type Workspace } from '@extalia/core';
import type { AgentHostApi, HostState, SessionMovePreview, SessionSummary } from '@extalia/platform';
import { useEffect, useId, useRef, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { Select } from '../ui/Select';
import './sessionMove.css';

export function SessionMoveDialog({ t, agents, session, workspaces, onClose, onMoved }: {
  t: Messages;
  agents: AgentHostApi;
  session: SessionSummary;
  workspaces: Workspace[];
  onClose(): void;
  onMoved(state: HostState, workspaceId: string): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const request = useRef(0);
  const [workspaceId, setWorkspaceId] = useState(session.workspaceId);
  const [preview, setPreview] = useState<SessionMovePreview>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const text = t.chat.move;
  useEffect(() => {
    const element = dialog.current;
    const requests = request;
    element?.showModal();
    return () => { requests.current++; element?.close(); };
  }, []);
  const review = async () => {
    const revision = ++request.current;
    setBusy(true); setError(undefined); setPreview(undefined); setConfirmed(false);
    try {
      const next = await agents.previewSessionMove!(session.id, workspaceId);
      if (revision === request.current) setPreview(next);
    } catch (failure) { if (revision === request.current) setError(errorMessage(failure)); }
    finally { if (revision === request.current) setBusy(false); }
  };
  const move = async () => {
    if (!preview || !confirmed) return;
    setBusy(true); setError(undefined);
    try {
      const state = await agents.moveSession!(session.id, { workspaceId: preview.destination.id, reviewId: preview.reviewId });
      onMoved(state, preview.destination.id);
    } catch (failure) { setError(errorMessage(failure)); setPreview(undefined); setConfirmed(false); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} className="session-move-dialog" aria-labelledby={titleId} onCancel={event => {
    event.preventDefault(); if (!busy) onClose();
  }}>
    <header className="session-move-header">
      <h2 id={titleId}>{text.title}</h2>
      <button type="button" className="icon-button" aria-label={t.common.close} disabled={busy} onClick={onClose}><Icon name="close" /></button>
    </header>
    <p className="muted small">{text.description}</p>
    <p className="session-move-title">{session.title || t.chat.untitled}</p>
    <Select label={text.destination} value={workspaceId} disabled={busy}
      options={workspaces.filter(workspace => workspaceRuntime(workspace) === 'extalia-native' && workspace.projectLocation).map(workspace => ({
        value: workspace.id, label: workspace.name, description: workspace.projectLocation, icon: 'folder' as const,
      }))} onChange={id => { request.current++; setWorkspaceId(id); setPreview(undefined); setConfirmed(false); setError(undefined); }} />
    {preview && <section className="session-move-review" aria-label={text.review}>
      <p><strong>{preview.source.name}</strong> → <strong>{preview.destination.name}</strong></p>
      <h3>{text.folders}</h3>
      <ul>{preview.accessibleFolders.map(folder => <li key={`${folder.workspaceId}:${folder.path}`}>
        <code>{folder.path}</code><span className="badge">{folder.access === 'read-write' ? text.readWrite : text.readOnly}</span>
      </li>)}</ul>
      <p className="small">{text.crossAccess}: {text.policies[preview.destination.crossWorkspaceAccess]}</p>
      <p className="small">{text.fileWrites}: {text.permissions[preview.destination.permissions.fileWrite]} · {text.commands}: {text.permissions[preview.destination.permissions.commands]}</p>
      <p className="small"><strong>{t.composer.permission}: {t.composer.mode[preview.permissionMode].label}</strong><br />{t.composer.mode[preview.permissionMode].description}</p>
      <p className="small">{text.context}</p>
      <label className="session-move-consent"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />{text.confirm}</label>
    </section>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <footer className="row-actions">
      <button type="button" className="button" disabled={busy} onClick={onClose}>{t.common.cancel}</button>
      {preview ? <button type="button" className="button primary" disabled={busy || !confirmed} onClick={() => { void move(); }}>{busy ? text.applying : text.apply}</button>
        : <button type="button" className="button primary" disabled={busy || !workspaceId} onClick={() => { void review(); }}>{busy ? text.reviewing : text.review}</button>}
    </footer>
  </dialog>;
}
