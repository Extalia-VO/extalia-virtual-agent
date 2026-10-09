import { sourceLabel, type PortableSession } from '@extalia/core';
import type { AgentHostApi, HostState } from '@extalia/platform';
import { useEffect, useState } from 'react';
import { SessionList } from '../chat/SessionList';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { LibraryTranscript } from '../library/LibraryTranscript';
import { Icon } from '../ui/Icon';

export function ObserverPage({ t, language, agents, state, onState, onAdd }: {
  t: Messages; language: string; agents: AgentHostApi; state: HostState; onState: (state: HostState) => void; onAdd: () => void;
}) {
  const sessions = state.sessions.filter(item => item.control === 'observed');
  const [chosen, setChosen] = useState<string>();
  const selected = sessions.find(item => item.id === chosen) ?? sessions[0];
  const [loaded, setLoaded] = useState<{ id: string; session?: PortableSession; error?: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!selected?.id) return;
    const id = selected.id;
    let active = true, version = 0;
    const load = () => {
      const started = ++version;
      agents.observationSession(id).then(session => { if (active && started === version) setLoaded({ id, session }); },
        failure => { if (active && started === version) setLoaded({ id, error: errorMessage(failure) }); });
    };
    const stop = agents.subscribe(event => { if (event.sessionId === id && event.body.type === 'session.updated') load(); });
    load();
    return () => { active = false; stop(); };
  }, [agents, selected?.id]);

  const run = async (action: () => Promise<HostState>) => {
    setBusy(true); setError(undefined);
    try { onState(await action()); } catch (failure) { setError(errorMessage(failure)); throw failure; }
    finally { setBusy(false); }
  };
  const observation = selected?.observation;
  const content = loaded?.id === selected?.id ? loaded : undefined;
  return <div className="page">
    <header className="page-header"><h1>{t.observer.title}</h1><p className="lead">{t.observer.lead}</p><p className="note"><Icon name="shield" />{t.observer.note}</p>
      <div className="actions"><button type="button" className="primary" onClick={onAdd}><Icon name="plus" />{t.observer.add}</button></div>
    </header>
    {error && <p role="alert" className="form-error">{error}</p>}
    <div className="history-layout">
      <section className="card history-list">
        {!sessions.length ? <p className="muted">{t.observer.empty}</p> : <SessionList t={t} sessions={sessions} activeId={selected?.id} language={language}
          onSelect={setChosen} onRename={async (id, title) => { await run(() => agents.renameSession(id, title)); }} onDelete={async id => { await run(() => agents.deleteSession(id)); }} />}
      </section>
      <section className="card history-viewer">
        {!selected ? <p className="muted">{t.observer.select}</p> : <>
          <div className="section-head"><h2>{selected.title}</h2><span className="badge">{sourceLabel(observation?.sourceId ?? '')} · {t.observer.label}</span></div>
          {observation?.projectPath && <code className="entity-path">{observation.projectPath}</code>}
          <p role="status" className="muted small">{observation && t.observer[observation.status]}{observation?.lastCheckedAt ? ` · ${new Intl.DateTimeFormat(language, { timeStyle: 'medium' }).format(new Date(observation.lastCheckedAt))}` : ''}</p>
          {observation?.error && <p role="alert" className="form-error">{observation.error}</p>}
          <div className="actions"><button type="button" disabled={busy} onClick={() => { void run(() => agents.setObservation(selected.id, !observation?.watching)).catch(() => undefined); }}>
            <Icon name={observation?.watching ? 'stop' : 'refresh'} />{observation?.watching ? t.observer.pause : t.observer.resume}
          </button></div>
          {content?.error ? <p className="form-error" role="alert">{content.error}</p> : !content?.session ? <p>{t.common.loading}</p> : <LibraryTranscript t={t} messages={content.session.messages} />}
        </>}
      </section>
    </div>
  </div>;
}
