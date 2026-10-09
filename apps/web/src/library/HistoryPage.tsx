import { sourceLabel, type LibrarySession, type LocalState } from '@extalia/core';
import type { AgentHostApi, HostState, LibraryAction, LibrarySessionSummary } from '@extalia/platform';
import { useEffect, useMemo, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { Segmented } from '../ui/Segmented';
import { countByState, groupLibrary } from './library';
import { LibraryTranscript } from './LibraryTranscript';

type Loaded = { id: string; session?: LibrarySession; error?: string };

function Viewer({ t, language, agents, summary, onState, onClose }: {
  t: Messages;
  language: string;
  agents: AgentHostApi;
  summary: LibrarySessionSummary;
  onState: (next: HostState) => void;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [mode, setMode] = useState<'view' | 'rename' | 'delete'>('view');
  const [title, setTitle] = useState(summary.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const format = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' });

  useEffect(() => {
    let active = true;
    agents.librarySession(summary.id).then(
      session => { if (active) setLoaded({ id: summary.id, session }); },
      failure => { if (active) setLoaded({ id: summary.id, error: errorMessage(failure) }); },
    );
    return () => { active = false; };
  }, [agents, summary.id, summary.messageCount]);

  const act = (action: LibraryAction, newTitle?: string) => {
    setBusy(true);
    setError(null);
    agents.organizeLibrarySession(summary.id, action, newTitle)
      .then(next => { setMode('view'); onState(next); if (action === 'delete') onClose(); })
      .catch(failure => setError(errorMessage(failure)))
      .finally(() => setBusy(false));
  };
  const current = loaded?.id === summary.id ? loaded : null;

  return (
    <article className="card history-viewer" aria-labelledby="history-title">
      <button type="button" className="button small back-to-list" onClick={onClose}><Icon name="chevron" className="flip" />{t.history.backToList}</button>
      {mode === 'rename' ? (
        <form className="input-row" onSubmit={event => { event.preventDefault(); if (title.trim()) act('rename', title.trim()); }}>
          <input type="text" value={title} maxLength={300} aria-label={t.history.rename} autoFocus onChange={event => setTitle(event.target.value)}
            onKeyDown={event => { if (event.key === 'Escape') setMode('view'); }} />
          <button type="submit" className="button primary" disabled={busy || !title.trim()}>{t.common.save}</button>
          <button type="button" className="button" onClick={() => setMode('view')}>{t.common.cancel}</button>
        </form>
      ) : <h2 id="history-title">{summary.title}</h2>}
      <dl className="history-meta">
        <div><dt>{t.history.source}</dt><dd>{sourceLabel(summary.sourceId)}{summary.importMode === 'linked' && <span className="badge">{t.history.linked}</span>}</dd></div>
        {summary.projectLocation && <div><dt>{t.history.project}</dt><dd><code>{summary.projectLocation}</code></dd></div>}
        <div><dt>{t.history.started}</dt><dd>{format.format(new Date(summary.startedAt))} · {t.history.messages(summary.messageCount)}</dd></div>
      </dl>
      {mode === 'delete' ? (
        <div className="confirm" role="alertdialog" aria-label={t.history.deleteConfirm}>
          <p>{t.history.deleteConfirm}</p>
          {summary.importMode === 'linked' && <p className="muted small">{t.history.deleteLinked}</p>}
          <div className="row-actions">
            <button type="button" className="button small danger" autoFocus disabled={busy} onClick={() => act('delete')}>{t.history.delete}</button>
            <button type="button" className="button small" onClick={() => setMode('view')}>{t.common.cancel}</button>
          </div>
        </div>
      ) : mode === 'view' && (
        <div className="row-actions">
          {summary.state !== 'trashed' && <button type="button" className="button small" onClick={() => { setTitle(summary.title); setMode('rename'); }}><Icon name="edit" />{t.history.rename}</button>}
          {summary.state === 'active' && <button type="button" className="button small" disabled={busy} onClick={() => act('archive')}>{t.history.archive}</button>}
          {summary.state !== 'active' && <button type="button" className="button small" disabled={busy} onClick={() => act('restore')}><Icon name="refresh" />{t.history.restore}</button>}
          {summary.state !== 'trashed'
            ? <button type="button" className="button small" disabled={busy} onClick={() => act('trash')}><Icon name="trash" />{t.history.trash}</button>
            : <button type="button" className="button small" disabled={busy} onClick={() => setMode('delete')}><Icon name="trash" />{t.history.delete}</button>}
        </div>
      )}
      {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
      {!current ? <p className="muted" role="status">{t.common.loading}</p>
        : current.error ? <p className="form-error"><Icon name="alert" />{t.history.loadFailed} {current.error}</p>
          : current.session && <LibraryTranscript t={t} messages={current.session.messages} />}
    </article>
  );
}

/** Imported conversations, grouped by workspace, with a read-only viewer. */
export function HistoryPage({ t, language, agents, state, onState, onOpenImport }: {
  t: Messages;
  language: string;
  agents: AgentHostApi;
  state: HostState;
  onState: (next: HostState) => void;
  onOpenImport: () => void;
}) {
  const [filter, setFilter] = useState<LocalState>('active');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const library = useMemo(() => state.library ?? [], [state.library]);
  const groups = useMemo(() => groupLibrary(library, filter, query), [library, filter, query]);
  const counts = countByState(library);
  const selected = library.find(item => item.id === selectedId && item.state === filter);
  const format = new Intl.DateTimeFormat(language, { dateStyle: 'medium' });

  return (
    <div className="page">
      <header className="page-header">
        <h1>{t.history.title}</h1>
        <p className="lead">{t.history.lead}</p>
      </header>
      <div className={`history ${selected ? 'has-selection' : ''}`}>
        <section className="card history-list" aria-label={t.history.title}>
          <div className="history-tools">
            <Segmented legend={t.history.filter} value={filter} className="compact-legend"
              options={(['active', 'archived', 'trashed'] as const).map(value => ({ value, label: `${t.history.filters[value]} ${counts[value]}` }))}
              onChange={setFilter} />
            <input type="search" className="search" value={query} placeholder={t.history.search} aria-label={t.history.search} onChange={event => setQuery(event.target.value)} />
          </div>
          {groups.length === 0 ? (
            <div className="empty-state">
              <p className="muted">{filter === 'active' && !library.length ? t.history.emptyActive : t.history.empty}</p>
              {filter === 'active' && <button type="button" className="button" onClick={onOpenImport}><Icon name="download" />{t.history.importNow}</button>}
            </div>
          ) : groups.map(group => (
            <div key={group.workspaceName ?? ''} className="history-group">
              <h2 className="side-heading">{group.workspaceName ?? t.history.unassigned}</h2>
              <ul className="session-list">
                {group.sessions.map(item => (
                  <li key={item.id} className={`session-row ${item.id === selected?.id ? 'active' : ''}`}>
                    <button type="button" className="session-select" aria-current={item.id === selected?.id ? 'true' : undefined} onClick={() => setSelectedId(item.id)}>
                      <span className="session-title">{item.title}</span>
                      <span className="session-meta">
                        {sourceLabel(item.sourceId)} · {t.history.messages(item.messageCount)} · {format.format(new Date(item.lastMessageAt))}
                        {item.importMode === 'linked' && <> · {t.history.linked}</>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
        {selected
          ? <Viewer key={selected.id} t={t} language={language} agents={agents} summary={selected} onState={onState} onClose={() => setSelectedId(null)} />
          : <section className="card history-viewer placeholder"><p className="muted">{t.history.select}</p></section>}
      </div>
    </div>
  );
}
