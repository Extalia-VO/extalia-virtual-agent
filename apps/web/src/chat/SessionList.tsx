import { sourceLabel } from '@extalia/core';
import type { SessionSummary } from '@extalia/platform';
import { useRef, useState, type HTMLAttributes } from 'react';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { DeleteConfirmation } from '../ui/DeleteConfirmation';

function formatWhen(iso: string, language: string, today: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = date.toDateString() === today;
  return new Intl.DateTimeFormat(language, sameDay ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' }).format(date);
}

function SessionRow({ t, session, active, language, today, onSelect, onRename, onDelete, onMove, onSettings, rowDrag, actionsDisabled, showSource, compactIndicators }: {
  t: Messages;
  session: SessionSummary;
  active: boolean;
  language: string;
  today: string;
  onSelect: () => void;
  onRename: (title: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onMove?: () => void;
  onSettings?: () => void;
  rowDrag?: Pick<HTMLAttributes<HTMLLIElement>, 'draggable' | 'onDragStart' | 'onDragEnd'>;
  actionsDisabled?: boolean;
  showSource?: boolean;
  compactIndicators?: boolean;
}) {
  const [mode, setMode] = useState<'view' | 'rename' | 'delete'>('view');
  const [title, setTitle] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [failed, setFailed] = useState(false);
  const label = session.title || t.chat.untitled;
  const canMove = Boolean(onMove && session.control === 'managed' && !session.runtime);
  const act = (action: () => Promise<void>) => {
    if (locked.current || actionsDisabled) return;
    locked.current = true; setBusy(true); setFailed(false);
    void Promise.resolve().then(action).then(() => setMode('view'), () => setFailed(true))
      .finally(() => { locked.current = false; setBusy(false); });
  };

  if (mode === 'rename') {
    return (
      <li className="session-row editing">
        <form onSubmit={event => { event.preventDefault(); if (title.trim()) act(() => onRename(title.trim())); }}>
          <input type="text" value={title} maxLength={120} aria-label={t.chat.renameLabel} autoFocus disabled={busy || actionsDisabled}
            onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setMode('view'); }} />
          <div className="row-actions">
            <button type="submit" className="button small primary" disabled={busy || actionsDisabled || !title.trim()}>{t.common.save}</button>
            <button type="button" className="button small" disabled={actionsDisabled} onClick={() => setMode('view')}>{t.common.cancel}</button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li {...rowDrag} draggable={mode === 'delete' ? false : rowDrag?.draggable} className={`session-row ${active ? 'active' : ''} ${canMove || onSettings ? 'has-move' : ''}${compactIndicators ? ' compact-indicators' : ''}`}>
      <button type="button" className="session-select" aria-current={active ? 'true' : undefined} onClick={onSelect}>
        <span className="session-title">{label}</span>
        {compactIndicators && <span className="session-row-indicators">
          {session.running && <span className="session-browser-spinner spin" role="img" aria-label={t.chat.running} title={t.chat.running} />}
          {session.pendingApprovalId && <span className="session-browser-attention" role="img" aria-label={t.chat.waiting} title={t.chat.waiting}><Icon name="shield" /></span>}
          {session.observation?.unreadOutput && <span className="session-browser-unread" role="img" aria-label={t.sessionBrowser.unread} title={t.sessionBrowser.unread} />}
        </span>}
        <span className="session-meta">
          {!compactIndicators && showSource && session.observation?.sourceId && <span className="session-source">{sourceLabel(session.observation.sourceId)} · </span>}
          {compactIndicators ? <time dateTime={session.lastActiveAt}>{formatWhen(session.lastActiveAt, language, today)}</time> : session.pendingApprovalId ? <span className="badge warn"><Icon name="shield" />{t.chat.waiting}</span>
            : session.running ? <span className="badge running"><span className="pulse" aria-hidden="true" />{t.chat.running}</span>
              : <time dateTime={session.lastActiveAt}>{formatWhen(session.lastActiveAt, language, today)}</time>}
        </span>
      </button>
      {mode === 'delete' && (
        <DeleteConfirmation t={t} title={t.deletion.sessionTitle} target={label}
          description={session.control === 'observed' ? t.deletion.observedDescription : t.chat.deleteConfirm}
          busy={busy} error={failed ? t.deletion.failed : undefined}
          onConfirm={() => act(onDelete)} onCancel={() => setMode('view')} />
      )}
        <div className="row-tools" role="group" aria-label={t.chat.actions(label)}>
          {onSettings ? <button type="button" className="icon-button small" aria-label={`${t.chat.sessionSettings.title}: ${label}`} title={t.chat.sessionSettings.title} disabled={actionsDisabled} onClick={onSettings}><Icon name="settings" /></button>
            : canMove && <button type="button" className="icon-button small" aria-label={`${t.chat.move.title}: ${label}`} title={t.chat.move.title} disabled={session.running || actionsDisabled} onClick={onMove}><Icon name="folder" /></button>}
          <button type="button" className="icon-button small" aria-label={`${t.chat.rename}: ${label}`} title={t.chat.rename} disabled={actionsDisabled} onClick={() => { setTitle(session.title); setMode('rename'); }}><Icon name="edit" /></button>
          <button type="button" className="icon-button small" aria-label={`${t.common.delete}: ${label}`} title={t.common.delete} disabled={actionsDisabled} onClick={() => { setFailed(false); setMode('delete'); }}><Icon name="trash" /></button>
        </div>
    </li>
  );
}

export function SessionList({ t, sessions, activeId, language, onSelect, onRename, onDelete, onMove, onSettings, rowDrag, actionsDisabled, showSource, compactIndicators }: {
  t: Messages;
  sessions: SessionSummary[];
  activeId: string | undefined;
  language: string;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onMove?: (session: SessionSummary) => void;
  onSettings?: (session: SessionSummary) => void;
  rowDrag?: (session: SessionSummary) => Pick<HTMLAttributes<HTMLLIElement>, 'draggable' | 'onDragStart' | 'onDragEnd'> | undefined;
  actionsDisabled?: boolean;
  showSource?: boolean;
  compactIndicators?: boolean;
}) {
  const [today] = useState(() => new Date().toDateString());
  if (!sessions.length) return <p className="muted small session-empty">{t.chat.noSessions}</p>;
  return (
    <ul className="session-list">
      {sessions.map(session => (
        <SessionRow key={session.id} t={t} session={session} active={session.id === activeId} language={language} today={today} showSource={showSource} compactIndicators={compactIndicators}
          rowDrag={rowDrag?.(session)} actionsDisabled={actionsDisabled}
          onSelect={() => onSelect(session.id)} onRename={title => onRename(session.id, title)} onDelete={() => onDelete(session.id)} {...(onMove ? { onMove: () => onMove(session) } : {})}
          {...(onSettings && session.control === 'managed' && !session.runtime && !session.transient ? { onSettings: () => onSettings(session) } : {})} />
      ))}
    </ul>
  );
}
