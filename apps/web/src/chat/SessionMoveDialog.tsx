import { workspaceRuntime, type Workspace } from '@extalia/core';
import type { AgentHostApi, HostState, SessionMovePreview, SessionSummary } from '@extalia/platform';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { Select } from '../ui/Select';
import './sessionMove.css';

export function SessionMoveDialog({ t, agents, session, workspaces, currentWorkspaceOnly = false, onClose, onMoved }: {
  t: Messages;
  agents: AgentHostApi;
  session: SessionSummary;
  workspaces: Workspace[];
  /** Inline recovery re-reviews only this conversation’s current workspace. */
  currentWorkspaceOnly?: boolean;
  onClose(): void;
  onMoved(state: HostState, workspaceId: string): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const request = useRef(0);
  const [workspaceId, setWorkspaceId] = useState(session.workspaceId);
  const targetWorkspaceId = currentWorkspaceOnly ? session.workspaceId : workspaceId;
  const context = JSON.stringify([session, workspaces]);
  const viewContext = useMemo(() => ({ context }), [context]);
  const committed = useRef(viewContext);
  useLayoutEffect(() => { committed.current = viewContext; }, [viewContext]);
  const [reviewed, setReviewed] = useState<{ context: string; owner: { context: string }; preview: SessionMovePreview }>();
  // A concurrent folder/session change cannot leave an old confirmation usable.
  // The host independently verifies the exact review at application time.
  const preview = reviewed?.context === context && reviewed.owner === viewContext ? reviewed.preview : undefined;
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
    const owner = viewContext;
    if (owner !== committed.current) return;
    const revision = ++request.current;
    setBusy(true); setError(undefined); setReviewed(undefined); setConfirmed(false);
    try {
      const next = await agents.previewSessionMove!(session.id, targetWorkspaceId);
      if (revision === request.current && owner === committed.current) setReviewed({ context, owner, preview: next });
    } catch (failure) { if (revision === request.current && owner === committed.current) setError(errorMessage(failure)); }
    finally { if (revision === request.current) setBusy(false); }
  };
  const move = async () => {
    if (!preview || !confirmed) return;
    const owner = viewContext;
    if (owner !== committed.current) return;
    const revision = ++request.current;
    setBusy(true); setError(undefined);
    try {
      const state = await agents.moveSession!(session.id, { workspaceId: preview.destination.id, reviewId: preview.reviewId });
      if (revision === request.current) {
        if (owner === committed.current) onMoved(state, preview.destination.id);
        else { setReviewed(undefined); setConfirmed(false); }
      }
    } catch (failure) {
      if (revision === request.current) {
        if (owner === committed.current) setError(errorMessage(failure));
        setReviewed(undefined); setConfirmed(false);
      }
    }
    finally { if (revision === request.current) setBusy(false); }
  };
  return <dialog ref={dialog} className="session-move-dialog" aria-labelledby={titleId} onCancel={event => {
    event.preventDefault(); if (!busy) onClose();
  }}>
    <header className="session-move-header">
      <h2 id={titleId}>{currentWorkspaceOnly ? text.reviewCurrent : text.title}</h2>
      <button type="button" className="icon-button" aria-label={t.common.close} disabled={busy} onClick={onClose}><Icon name="close" /></button>
    </header>
    <p className="muted small">{text.description}</p>
    <p className="session-move-title">{session.title || t.chat.untitled}</p>
    <Select label={text.destination} value={targetWorkspaceId} disabled={busy}
      options={workspaces.filter(workspace => workspace.projectLocation && (workspaceRuntime(workspace) === 'extalia-native' || workspace.id === session.workspaceId) && (!currentWorkspaceOnly || workspace.id === session.workspaceId)).map(workspace => ({
        value: workspace.id, label: workspace.name, description: workspace.projectLocation, icon: 'folder' as const,
      }))} onChange={id => { request.current++; setWorkspaceId(id); setReviewed(undefined); setConfirmed(false); setError(undefined); }} />
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
        : <button type="button" className="button primary" disabled={busy || !targetWorkspaceId} onClick={() => { void review(); }}>{busy ? text.reviewing : text.review}</button>}
    </footer>
  </dialog>;
}
