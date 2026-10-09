import type { SessionSummary } from '@extalia/platform';
import { useState } from 'react';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';

function formatWhen(iso: string, language: string, today: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = date.toDateString() === today;
  return new Intl.DateTimeFormat(language, sameDay ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' }).format(date);
}

function SessionRow({ t, session, active, language, today, onSelect, onRename, onDelete }: {
  t: Messages;
  session: SessionSummary;
  active: boolean;
  language: string;
  today: string;
  onSelect: () => void;
  onRename: (title: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [mode, setMode] = useState<'view' | 'rename' | 'delete'>('view');
  const [title, setTitle] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const label = session.title || t.chat.untitled;
  const act = (action: () => Promise<void>) => { setBusy(true); action().then(() => setMode('view'), () => undefined).finally(() => setBusy(false)); };

  if (mode === 'rename') {
    return (
      <li className="session-row editing">
        <form onSubmit={event => { event.preventDefault(); if (title.trim()) act(() => onRename(title.trim())); }}>
          <input type="text" value={title} maxLength={120} aria-label={t.chat.renameLabel} autoFocus disabled={busy}
            onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setMode('view'); }} />
          <div className="row-actions">
            <button type="submit" className="button small primary" disabled={busy || !title.trim()}>{t.common.save}</button>
            <button type="button" className="button small" onClick={() => setMode('view')}>{t.common.cancel}</button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className={`session-row ${active ? 'active' : ''}`}>
      <button type="button" className="session-select" aria-current={active ? 'true' : undefined} onClick={onSelect}>
        <span className="session-title">{label}</span>
        <span className="session-meta">
          {session.pendingApprovalId ? <span className="badge warn"><Icon name="shield" />{t.chat.waiting}</span>
            : session.running ? <span className="badge running"><span className="pulse" aria-hidden="true" />{t.chat.running}</span>
              : <time dateTime={session.lastActiveAt}>{formatWhen(session.lastActiveAt, language, today)}</time>}
        </span>
      </button>
      {mode === 'delete' ? (
        <div className="confirm" role="alertdialog" aria-label={t.chat.deleteConfirm}>
          <p>{t.chat.deleteConfirm}</p>
          <div className="row-actions">
            <button type="button" className="button small danger" disabled={busy} autoFocus onClick={() => act(onDelete)}>{t.common.delete}</button>
            <button type="button" className="button small" disabled={busy} onClick={() => setMode('view')}>{t.common.cancel}</button>
          </div>
        </div>
      ) : (
        <div className="row-tools" role="group" aria-label={t.chat.actions(label)}>
          <button type="button" className="icon-button small" aria-label={`${t.chat.rename}: ${label}`} title={t.chat.rename} onClick={() => { setTitle(session.title); setMode('rename'); }}><Icon name="edit" /></button>
          <button type="button" className="icon-button small" aria-label={`${t.common.delete}: ${label}`} title={t.common.delete} onClick={() => setMode('delete')}><Icon name="trash" /></button>
        </div>
      )}
    </li>
  );
}

export function SessionList({ t, sessions, activeId, language, onSelect, onRename, onDelete }: {
  t: Messages;
  sessions: SessionSummary[];
  activeId: string | undefined;
  language: string;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [today] = useState(() => new Date().toDateString());
  if (!sessions.length) return <p className="muted small session-empty">{t.chat.noSessions}</p>;
  return (
    <ul className="session-list">
      {sessions.map(session => (
        <SessionRow key={session.id} t={t} session={session} active={session.id === activeId} language={language} today={today}
          onSelect={() => onSelect(session.id)} onRename={title => onRename(session.id, title)} onDelete={() => onDelete(session.id)} />
      ))}
    </ul>
  );
}
