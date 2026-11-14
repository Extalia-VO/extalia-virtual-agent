import { sourceLabel, type LibrarySession, type LocalState } from '@extalia/core';
import type { AgentHostApi, HostState, LibraryAction, LibrarySessionSummary } from '@extalia/platform';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { DeleteConfirmation } from '../ui/DeleteConfirmation';
import { Segmented } from '../ui/Segmented';
import { ContinueInExtalia } from './ContinueInExtalia';
import { countByState } from './library';
import { SessionBrowser } from '../sessions/SessionBrowser';
import { LibraryTranscript } from './LibraryTranscript';
import { MessageFileProvider } from '../chat/MessageFilePreview';

type Loaded = { id: string; session?: LibrarySession; error?: string };

/** Leaving the library for a new session that continues one of its conversations. */
export interface ContinueHandlers {
  onContinued: (sessionId: string, workspaceId: string) => void;
  onOpenSettings: () => void;
}

function Viewer({ t, language, agents, state, summary, onState, onClose, onContinued, onOpenSettings }: ContinueHandlers & {
  t: Messages;
  language: string;
  agents: AgentHostApi;
  state: HostState;
  summary: LibrarySessionSummary;
  onState: (next: HostState) => void;
  onClose: () => void;
}) {
  const owner = useRef({ active: true, busy: false, agents });
  useLayoutEffect(() => { owner.current.agents = agents; }, [agents]);
  useEffect(() => { const operation = owner.current; operation.active = true; return () => { operation.active = false; }; }, []);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [mode, setMode] = useState<'view' | 'rename' | 'delete' | 'trash'>('view');
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

  const act = async (action: LibraryAction, newTitle?: string) => {
    const operation = owner.current;
    if (!operation.active || operation.busy || operation.agents !== agents) return;
    operation.busy = true;
    setBusy(true);
    setError(null);
    try {
      const next = await agents.organizeLibrarySession(summary.id, action, newTitle);
      if (!operation.active || operation.agents !== agents) return;
      setMode('view'); onState(next); if (action === 'delete') onClose();
    } catch (failure) {
      if (operation.active && operation.agents === agents) setError(errorMessage(failure));
    } finally {
      operation.busy = false;
      if (operation.active) setBusy(false);
    }
  };
  const cancelConfirmation = () => { if (!owner.current.busy) { setMode('view'); setError(null); } };
  const current = loaded?.id === summary.id ? loaded : null;

  return (
    <article className="card history-viewer" aria-labelledby="history-title">
      <button type="button" className="button small back-to-list" disabled={busy} onClick={onClose}><Icon name="chevron" className="flip" />{t.history.backToList}</button>
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
      {(mode === 'delete' || mode === 'trash') && <DeleteConfirmation t={t}
        title={mode === 'delete' ? t.deletion.historyTitle : t.deletion.trashTitle} target={summary.title}
        description={mode === 'delete' ? `${t.history.deleteConfirm}${summary.importMode === 'linked' ? ` ${t.history.deleteLinked}` : ''}` : t.deletion.trashDescription}
        confirmLabel={mode === 'delete' ? t.history.delete : t.history.trash} busy={busy} error={error}
        onConfirm={() => { void act(mode === 'delete' ? 'delete' : 'trash'); }} onCancel={cancelConfirmation} />}
      {mode !== 'rename' && (
        <div className="row-actions">
          {summary.state !== 'trashed' && <button type="button" className="button small" onClick={() => { setTitle(summary.title); setMode('rename'); }}><Icon name="edit" />{t.history.rename}</button>}
          {summary.state === 'active' && <button type="button" className="button small" disabled={busy} onClick={() => act('archive')}>{t.history.archive}</button>}
          {summary.state !== 'active' && <button type="button" className="button small" disabled={busy} onClick={() => act('restore')}><Icon name="refresh" />{t.history.restore}</button>}
          {summary.state !== 'trashed'
            ? <button type="button" className="button small" disabled={busy} onClick={() => { setError(null); setMode('trash'); }}><Icon name="trash" />{t.history.trash}</button>
            : <button type="button" className="button small" disabled={busy} onClick={() => { setError(null); setMode('delete'); }}><Icon name="trash" />{t.history.delete}</button>}
        </div>
      )}
      {error && mode !== 'delete' && mode !== 'trash' && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
      {mode === 'view' && summary.state !== 'trashed' && (
        <ContinueInExtalia t={t} agents={agents} state={state} source={{ kind: 'library', id: summary.id }}
          {...(summary.projectLocation ? { projectPath: summary.projectLocation } : {})} onContinued={onContinued} onOpenSettings={onOpenSettings} />
      )}
      {!current ? <p className="muted" role="status">{t.common.loading}</p>
        : current.error ? <p className="form-error"><Icon name="alert" />{t.history.loadFailed} {current.error}</p>
          : current.session && <MessageFileProvider key={summary.id} t={t} agents={agents} workspaces={state.workspaces} projectPath={summary.projectLocation}>
              <LibraryTranscript t={t} messages={current.session.messages} />
            </MessageFileProvider>}
    </article>
  );
}

/** Imported conversations, grouped by workspace, with a read-only viewer. */
export function HistoryPage({ t, language, agents, state, onState, onOpenImport, onContinued, onOpenSettings }: ContinueHandlers & {
  t: Messages;
  language: string;
  agents: AgentHostApi;
  state: HostState;
  onState: (next: HostState) => void;
  onOpenImport: () => void;
}) {
  const [filter, setFilter] = useState<LocalState>('active');
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<LibrarySessionSummary | null>(null);
  const [revision, setRevision] = useState(0);
  const library = useMemo(() => state.library ?? [], [state.library]);
  const counts = countByState(library);
  const candidate = chosen ? library.find(item => item.id === chosen.id) ?? chosen : undefined;
  const selected = candidate?.state === filter ? candidate : undefined;
  const browserRefresh = JSON.stringify([revision, state.sessionBrowser, library.map(item => [item.id, item.title, item.state, item.lastMessageAt])]);
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
              options={(['active', 'archived', 'trashed'] as const).map(value => ({ value, label: state.sessionBrowser ? t.history.filters[value] : `${t.history.filters[value]} ${counts[value]}` }))}
              onChange={setFilter} />
            <input type="search" className="search" value={query} placeholder={t.history.search} aria-label={t.history.search} onChange={event => setQuery(event.target.value)} />
          </div>
          <SessionBrowser t={t} agents={agents} state={state} collection="library" query={query} libraryState={filter} refreshKey={browserRefresh} emptyLabel={filter === 'active' ? t.history.emptyActive : t.history.empty}
            renderRows={rows => <ul className="session-list">{rows.filter((row): row is LibrarySessionSummary => 'lastMessageAt' in row).map(item => <li key={item.id} className={`session-row ${item.id === selected?.id ? 'active' : ''}`}>
              <button type="button" className="session-select" aria-current={item.id === selected?.id ? 'true' : undefined} onClick={() => setChosen(item)}>
                <span className="session-title">{item.title}</span><span className="session-meta">{sourceLabel(item.sourceId)} · {t.history.messages(item.messageCount)} · {format.format(new Date(item.lastMessageAt))}{item.importMode === 'linked' && <> · {t.history.linked}</>}</span>
              </button></li>)}</ul>} />
          {filter === 'active' && <button type="button" className="button small" onClick={onOpenImport}><Icon name="download" />{t.history.importNow}</button>}
        </section>
        {selected
          ? <Viewer key={selected.id} t={t} language={language} agents={agents} state={state} summary={selected} onState={next => { setRevision(value => value + 1); setChosen(current => next.library?.find(item => item.id === current?.id) ?? current); onState(next); }} onClose={() => setChosen(null)}
            onContinued={onContinued} onOpenSettings={onOpenSettings} />
          : <section className="card history-viewer placeholder"><p className="muted">{t.history.select}</p></section>}
      </div>
    </div>
  );
}
