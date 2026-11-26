import { workspaceRuntime, type Workspace } from '@extalia/core';
import type { AgentHostApi, HostState, SessionMovePreview, SessionSummary } from '@extalia/platform';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { Select } from '../ui/Select';
import { nativeSession, registeredSessionFolders } from './nativeSessionTreeModel';
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
  const isAttach = session.workspaceId === null;
  const singleWorkspaceSection = currentWorkspaceOnly || isAttach;
  const destinations = workspaces.filter(workspace => workspace.mode !== 'observe' && (workspaceRuntime(workspace) === 'extalia-native' || workspace.id === session.workspaceId) && workspace.projectLocation && (!currentWorkspaceOnly || workspace.id === session.workspaceId));
  const [workspaceId, setWorkspaceId] = useState<string | null>(() => session.workspaceId ?? destinations[0]?.id ?? null);
  const [section, setSection] = useState<'folder' | 'workspace'>(singleWorkspaceSection ? 'workspace' : 'folder');
  const targetWorkspaceId = currentWorkspaceOnly ? session.workspaceId : workspaceId;
  const context = JSON.stringify([session, workspaces, targetWorkspaceId, currentWorkspaceOnly]);
  const viewContext = useMemo(() => ({ context, agents }), [agents, context]);
  const committed = useRef(viewContext);
  useLayoutEffect(() => { committed.current = viewContext; }, [viewContext]);
  const source = workspaces.find(workspace => workspace.id === session.workspaceId);
  const currentFolder = session.projectLocation ?? source?.projectLocation ?? '';
  const [folder, setFolder] = useState(currentFolder);
  const locked = useRef(false);
  const [reviewed, setReviewed] = useState<{ context: string; owner: { context: string }; preview: SessionMovePreview }>();
  // Confirmation belongs to the exact committed session and workspace view.
  const preview = reviewed?.context === context && reviewed.owner === viewContext ? reviewed.preview : undefined;
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const text = t.chat.move;
  const settings = t.chat.sessionSettings;
  const blocked = session.running || Boolean(session.pendingApprovalId) || Boolean(session.transient) || !nativeSession(session);
  const attachMode = isAttach || preview?.kind === 'attach';
  useEffect(() => {
    const element = dialog.current;
    const requests = request;
    element?.showModal();
    return () => { requests.current++; element?.close(); };
  }, [agents, session.id]);
  const changeSection = (next: 'folder' | 'workspace') => {
    if (locked.current) return;
    request.current++; setSection(next); setReviewed(undefined); setConfirmed(false); setError(undefined);
  };
  const review = async () => {
    if (locked.current || blocked || !targetWorkspaceId || !agents.previewSessionMove || !agents.moveSession || !destinations.some(workspace => workspace.id === targetWorkspaceId)) return;
    const owner = viewContext;
    if (owner !== committed.current) return;
    locked.current = true;
    const revision = ++request.current;
    setBusy(true); setError(undefined); setReviewed(undefined); setConfirmed(false);
    try {
      const next = await agents.previewSessionMove!(session.id, targetWorkspaceId);
      if (revision === request.current && owner === committed.current) setReviewed({ context, owner, preview: next });
    } catch (failure) { if (revision === request.current && owner === committed.current) setError(errorMessage(failure)); }
    finally { locked.current = false; if (revision === request.current) setBusy(false); }
  };
  const move = async () => {
    if (locked.current || blocked || !preview || !confirmed || !agents.moveSession) return;
    const owner = viewContext;
    if (owner !== committed.current) return;
    const revision = ++request.current;
    locked.current = true;
    setBusy(true); setError(undefined);
    try {
      const state = await agents.moveSession!(session.id, { workspaceId: preview.destination.id, reviewId: preview.reviewId });
      if (revision === request.current) {
        if (owner === committed.current) onMoved(state, preview.destination.id);
        else { setReviewed(undefined); setConfirmed(false); }
      }
    } catch (failure) { if (revision === request.current) { if (owner === committed.current) setError(errorMessage(failure)); setReviewed(undefined); setConfirmed(false); } }
    finally { locked.current = false; if (revision === request.current) setBusy(false); }
  };
  const applyFolder = async () => {
    if (currentWorkspaceOnly || locked.current || blocked || !session.workspaceId || !source || source.mode === 'observe' || !agents.setSessionProjectRoot || !registeredSessionFolders(source).includes(folder) || folder === currentFolder) return;
    const owner = viewContext;
    if (owner !== committed.current) return;
    const revision = ++request.current;
    const sourceWorkspaceId = session.workspaceId;
    locked.current = true; setBusy(true); setError(undefined);
    try {
      const state = await agents.setSessionProjectRoot(session.id, { workspaceId: sourceWorkspaceId, projectLocation: folder });
      if (revision === request.current && owner === committed.current) onMoved(state, sourceWorkspaceId);
    } catch (failure) { if (revision === request.current && owner === committed.current) setError(errorMessage(failure)); }
    finally { locked.current = false; if (revision === request.current) setBusy(false); }
  };
  return <dialog ref={dialog} className="session-move-dialog" aria-labelledby={titleId} onCancel={event => {
    event.preventDefault(); if (!locked.current) onClose();
  }}>
    <header className="session-move-header">
      <h2 id={titleId}>{currentWorkspaceOnly ? text.reviewCurrent : isAttach ? text.attachTitle : settings.title}</h2>
      <button type="button" className="icon-button" aria-label={t.common.close} disabled={busy} onClick={onClose}><Icon name="close" /></button>
    </header>
    <p className="session-move-title">{session.title || t.chat.untitled}</p>
    {!singleWorkspaceSection && <div className="session-settings-tabs" role="tablist" aria-label={settings.title} onKeyDown={event => {
      if (busy || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'folder' : event.key === 'End' ? 'workspace' : section === 'folder' ? 'workspace' : 'folder';
      changeSection(next);
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next === 'folder' ? 0 : 1]?.focus();
    }}>
      <button type="button" role="tab" id={`${titleId}-folder-tab`} aria-controls={`${titleId}-folder`} aria-selected={section === 'folder'} tabIndex={!singleWorkspaceSection && section === 'folder' ? 0 : -1} disabled={busy} onClick={() => changeSection('folder')}>{settings.folder}</button>
      <button type="button" role="tab" id={`${titleId}-workspace-tab`} aria-controls={`${titleId}-workspace`} aria-selected={section === 'workspace'} tabIndex={section === 'workspace' ? 0 : -1} disabled={busy} onClick={() => changeSection('workspace')}>{settings.workspace}</button>
    </div>}
    {blocked && <p className="muted small" role="status">{settings.busy}</p>}
    {!singleWorkspaceSection && section === 'folder' ? <section role="tabpanel" id={`${titleId}-folder`} aria-labelledby={`${titleId}-folder-tab`}>
      <p className="muted small">{settings.folderHint}</p>
      <Select label={settings.folder} value={folder} disabled={busy || blocked || !agents.setSessionProjectRoot}
        options={(source ? registeredSessionFolders(source) : []).map(path => ({ value: path, label: path, icon: 'folder' as const }))}
        onChange={path => { setFolder(path); setError(undefined); }} />
      {!agents.setSessionProjectRoot && <p className="muted small">{settings.unavailable}</p>}
    </section> : <section role={singleWorkspaceSection ? undefined : 'tabpanel'} id={`${titleId}-workspace`} aria-labelledby={singleWorkspaceSection ? titleId : `${titleId}-workspace-tab`}>
    <p className="muted small">{isAttach ? text.attachDescription : `${settings.crossHint} ${text.description}`}</p>
    {destinations.length === 0 ? <p className="muted small">{text.noDestinations}</p> : (
      <Select label={text.destination} value={targetWorkspaceId ?? ''} placeholder={text.chooseDestination} disabled={busy || blocked}
        options={destinations.map(workspace => ({
          value: workspace.id, label: workspace.name, description: workspace.projectLocation, icon: 'folder' as const,
        }))} onChange={id => { request.current++; setWorkspaceId(id); setReviewed(undefined); setConfirmed(false); setError(undefined); }} />
    )}
    {preview && <section className="session-move-review" aria-label={text.review}>
      <p><strong>{preview.source ? preview.source.name : t.chat.unassigned.label}</strong> → <strong>{preview.destination.name}</strong></p>
      <h3>{text.folders}</h3>
      <ul>{preview.accessibleFolders.map(folder => <li key={`${folder.workspaceId}:${folder.path}`}>
        <code>{folder.path}</code><span className="badge">{folder.access === 'read-write' ? text.readWrite : text.readOnly}</span>
      </li>)}</ul>
      <p className="small">{text.crossAccess}: {text.policies[preview.destination.crossWorkspaceAccess]}</p>
      <p className="small">{text.fileWrites}: {text.permissions[preview.destination.permissions.fileWrite]} · {text.commands}: {text.permissions[preview.destination.permissions.commands]}</p>
      <p className="small"><strong>{t.composer.permission}: {t.composer.mode[preview.permissionMode].label}</strong><br />{t.composer.mode[preview.permissionMode].description}</p>
      <p className="small">{attachMode ? text.attachContext : text.context}</p>
      <label className="session-move-consent"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />{attachMode ? text.attachConfirm : text.confirm}</label>
    </section>}
    </section>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <footer className="row-actions">
      <button type="button" className="button" disabled={busy} onClick={onClose}>{t.common.cancel}</button>
      {!singleWorkspaceSection && section === 'folder' ? <button type="button" className="button primary" disabled={busy || blocked || !agents.setSessionProjectRoot || !source || !registeredSessionFolders(source).includes(folder) || folder === currentFolder} onClick={() => { void applyFolder(); }}>{busy ? text.applying : settings.folderApply}</button>
        : preview ? <button type="button" className="button primary" disabled={busy || blocked || !confirmed} onClick={() => { void move(); }}>{attachMode ? (busy ? text.attaching : text.attachApply) : (busy ? text.applying : text.apply)}</button>
          : <button type="button" className="button primary" disabled={busy || blocked || !agents.previewSessionMove || !agents.moveSession || !destinations.some(workspace => workspace.id === targetWorkspaceId)} onClick={() => { void review(); }}>{busy ? text.reviewing : text.review}</button>}
    </footer>
  </dialog>;
}
