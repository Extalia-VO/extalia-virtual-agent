import { sourceLabel, type PortableSession } from '@extalia/core';
import type { AgentHostApi, HostState } from '@extalia/platform';
import { useEffect, useId, useMemo, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { SessionList } from '../chat/SessionList';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { ContinueInExtalia } from '../library/ContinueInExtalia';
import type { ContinueHandlers } from '../library/HistoryPage';
import { LibraryTranscript } from '../library/LibraryTranscript';
import { NativeSessionPicker } from '../library/NativeSessionPicker';
import { LIVE_SELECTION_LIMIT, nativeSelectableIds, useNativeDiscovery, useOperationScope } from '../library/nativeDiscovery';
import { Icon } from '../ui/Icon';
import { MessageFileProvider } from '../chat/MessageFilePreview';
import { useSessionEvents } from '../chat/useSessionEvents';
import { PromptSuggestions } from '../chat/PromptSuggestions';
import { projectTranscript } from '../chat/transcript';
import { TranscriptView } from '../chat/TranscriptView';
import { ConversationTabs } from '../chat/ChangedFilesView';
import { projectChangedFiles } from '../chat/changedFiles';
import { attachmentPreviewLoader } from '../chat/attachments';
import './observer.css';
import { ObservedCodexControls } from '../observe/ObservedCodexControls';
import { ObservedCodexQueueControls } from '../observe/ObservedCodexQueueControls';
import { ObservedCodexPromptComposer } from '../observe/ObservedCodexPromptComposer';
import { ObservedCodexPermissionControls } from '../observe/ObservedCodexPermissionControls';
import { ManualReplyControls, ObservedReplyControls } from '../observe/ObservedReplyControls';
import { ObservedHermesControls } from '../observe/ObservedHermesControls';
import { ObservedSessionControl, ManualObservedInboxControls } from '../observe/ObservedSessionControl';
import { observedSessionControlFor, type ObservedSessionControlView } from '../observe/observedSessionControlModel';
import { OBSERVE_SECTIONS, observeTabForKey, type ObserveSection } from '../observe/observerTabs';

const noSubscription = () => () => undefined;
const emptyControlView: ObservedSessionControlView = { phase: 'loading', draft: '', selected: '', busy: false };
const getEmptyControlView = () => emptyControlView;

function AddObservedSessions({ t, language, agents, onWatched }: {
  t: Messages; language: string; agents: AgentHostApi; onWatched: (state: HostState, selectedId?: string) => void;
}) {
  const discovery = useNativeDiscovery(agents, 'observe');
  const { scope, scan, selected, consent } = discovery;
  const [operation, setOperation] = useState<{ scope: typeof scope; busy: boolean; error?: string }>({ scope, busy: false });
  const busy = operation.scope === scope && operation.busy;
  const error = operation.scope === scope ? operation.error : undefined;
  async function watch() {
    if (!scan || !consent || !selected.size || selected.size > LIVE_SELECTION_LIMIT) return;
    const candidates = scan.sessions.filter(item => selected.has(item.id));
    if (nativeSelectableIds(candidates, 'observe').length !== selected.size) return;
    const lease = scope.acquire();
    if (!lease) return;
    setOperation({ scope, busy: true });
    try {
      const state = await agents.observeImports(scan.scanId, [...selected]);
      if (!lease.isCurrent()) return;
      const watched = state.sessions.find(session => session.control === 'observed' && candidates.some(candidate =>
        session.observation?.sourceId === candidate.sourceId && session.observation.nativeSessionId === candidate.nativeSessionId));
      onWatched(state, watched?.id);
    } catch (failure) {
      if (lease.isCurrent()) setOperation({ scope, busy: false, error: errorMessage(failure) });
    } finally {
      if (lease.isCurrent()) setOperation(current => ({ ...current, busy: false }));
      lease.release();
    }
  }
  return <div className="observe-discovery">
    <NativeSessionPicker t={t} language={language} discovery={discovery} purpose="observe" busy={busy}>
      <p className="muted small" role="status">{t.observer.watchLimit}</p>
      <div className="actions"><button type="button" className="primary" disabled={busy || !consent || !selected.size || selected.size > LIVE_SELECTION_LIMIT} onClick={() => { void watch(); }}>
        <Icon name={busy ? 'refresh' : 'plus'} />{t.observer.watch}
      </button></div>
    </NativeSessionPicker>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!!scan?.diagnostics.length && <section className="card settings-section"><h3>{t.imports.diagnostics}</h3><ul className="diagnostics">{scan.diagnostics.map((item, index) => <li className="muted small" key={index}>{item.message}</li>)}</ul></section>}
  </div>;
}

export function ObserverPage({ t, language, agents, state, initialSessionId, onState, onContinued, onOpenSettings, onOpenAgentSettings, onOpenImport }: ContinueHandlers & {
  t: Messages; language: string; agents: AgentHostApi; state: HostState; onState: (state: HostState) => void;
  initialSessionId?: string;
  onOpenAgentSettings?: () => void;
  onOpenImport?: () => void;
}) {
  const scope = useOperationScope(agents);
  const sessions = state.sessions.filter(item => item.control === 'observed');
  const [section, setSection] = useState<ObserveSection>('sessions');
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const tabsId = useId();
  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, current: ObserveSection) => {
    const next = observeTabForKey(current, event.key);
    if (next === undefined) return;
    event.preventDefault();
    setSection(next);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=tab]')[OBSERVE_SECTIONS.indexOf(next)]?.focus();
  };
  const [chosen, setChosen] = useState<string | undefined>(initialSessionId);
  const selected = sessions.find(item => item.id === chosen) ?? sessions[0];
  const selectedId = selected?.id;
  const [loaded, setLoaded] = useState<{ scope: typeof scope; id: string; session?: PortableSession; error?: string }>();
  const [operation, setOperation] = useState<{ scope: typeof scope; busy: boolean; error?: string }>({ scope, busy: false });
  const busy = operation.scope === scope && operation.busy;
  const error = operation.scope === scope ? operation.error : undefined;
  const { events } = useSessionEvents(agents, selectedId);
  const transcript = useMemo(() => projectTranscript(events), [events]);
  const changedFiles = useMemo(() => projectChangedFiles(events, selected?.observation?.projectPath), [events, selected?.observation?.projectPath]);
  const previewAttachment = useMemo(() => selectedId ? attachmentPreviewLoader(agents, selectedId) : undefined, [agents, selectedId]);

  useEffect(() => {
    if (!selected?.id) return;
    const id = selected.id;
    let active = true, version = 0;
    const load = () => {
      const started = ++version;
      agents.observationSession(id).then(session => { if (active && started === version) setLoaded({ scope, id, session }); },
        failure => { if (active && started === version) setLoaded({ scope, id, error: errorMessage(failure) }); });
    };
    const stop = agents.subscribe(event => { if (event.sessionId === id && event.body.type === 'session.updated') load(); });
    load();
    return () => { active = false; stop(); };
  }, [agents, scope, selected?.id]);

  const run = async (action: () => Promise<HostState>) => {
    const lease = scope.acquire();
    if (!lease) return;
    setOperation({ scope, busy: true });
    try { const state = await action(); if (lease.isCurrent()) onState(state); }
    catch (failure) { if (lease.isCurrent()) setOperation({ scope, busy: false, error: errorMessage(failure) }); throw failure; }
    finally { if (lease.isCurrent()) setOperation(current => ({ ...current, busy: false })); lease.release(); }
  };
  const observation = selected?.observation;
  const selectedId = selected?.id;
  const controlModel = useMemo(() => selectedId ? observedSessionControlFor(agents, selectedId) : undefined, [agents, selectedId]);
  const controlView = useSyncExternalStore(controlModel?.subscribe ?? noSubscription, controlModel?.getSnapshot ?? getEmptyControlView, getEmptyControlView);
  const controlHub = !!agents.observedControlStatus && !!agents.dispatchObservedControl && controlView.phase !== 'unsupported';
  const content = loaded?.scope === scope && loaded?.id === selected?.id ? loaded : undefined;
  return <div className="page">
    <header className="page-header"><h1>{t.observer.title}</h1><p className="lead">{t.pageRoles.observe}</p><p className="note"><Icon name="shield" />{t.observer.note}</p>
      <p className="muted small">{t.pageRoles.importHint}</p>
      <div className="actions">
        <button type="button" className="primary" aria-expanded={discoveryOpen} aria-controls={`${tabsId}-discovery`} onClick={() => { setDiscoveryOpen(!discoveryOpen); setSection('sessions'); }}><Icon name="plus" />{discoveryOpen ? t.observer.closeDiscovery : t.observer.add}</button>
        {onOpenAgentSettings && <button type="button" onClick={onOpenAgentSettings}>{t.pageRoles.manageAgentApps}</button>}
        {onOpenImport && <button type="button" onClick={onOpenImport}>{t.pageRoles.openImport}</button>}
      </div>
    </header>
    {discoveryOpen && <section className="observe-discovery" id={`${tabsId}-discovery`} aria-labelledby={`${tabsId}-discovery-title`}>
      <h2 id={`${tabsId}-discovery-title`}>{t.observer.discoveryTitle}</h2>
      <p className="muted small">{t.observer.addHint}</p>
      <AddObservedSessions t={t} language={language} agents={agents} onWatched={(next, selectedId) => {
        onState(next); if (selectedId) setChosen(selectedId); setDiscoveryOpen(false); setSection('sessions');
      }} />
    </section>}
    {error && <p role="alert" className="form-error">{error}</p>}
    <div className="observe-tabs" role="tablist" aria-label={t.observer.sections.label}>
      {OBSERVE_SECTIONS.map(item => <button key={item} type="button" role="tab" id={`${tabsId}-${item}-tab`}
        aria-controls={`${tabsId}-${item}-panel`} aria-selected={section === item} tabIndex={section === item ? 0 : -1}
        onClick={() => setSection(item)} onKeyDown={event => moveTab(event, item)}>
        {t.observer.sections[item]}{item === 'sessions' && sessions.length > 0 && <span className="badge">{sessions.length}</span>}
      </button>)}
    </div>
    <div className="observe-panel" role="tabpanel" id={`${tabsId}-sessions-panel`} aria-labelledby={`${tabsId}-sessions-tab`} hidden={section !== 'sessions'} tabIndex={0}>
      <div className="history-layout">
        <section className="card history-list">
          {!sessions.length ? <p className="muted">{t.observer.empty}</p> : <SessionList t={t} sessions={sessions} activeId={selected?.id} language={language}
            onSelect={setChosen} onRename={async (id, title) => { await run(() => agents.renameSession(id, title)); }} onDelete={async id => { await run(() => agents.deleteSession(id)); }} />}
        </section>
        <section className="card history-viewer">
          {!selected ? <p className="muted">{t.observer.select}</p> : <>
            <div className="section-head"><h2>{selected.title}</h2><span className="badge">{sourceLabel(observation?.sourceId ?? '')} · {t.observer.label}{observation?.auto ? ` · ${t.observer.autoBadge}` : ''}</span></div>
            {observation?.projectPath && <code className="entity-path">{observation.projectPath}</code>}
            <p role="status" className="muted small">{observation && t.observer[observation.status]}{observation?.lastCheckedAt ? ` · ${new Intl.DateTimeFormat(language, { timeStyle: 'medium' }).format(new Date(observation.lastCheckedAt))}` : ''}</p>
            {observation?.error && <p role="alert" className="form-error">{observation.error}</p>}
            <div className="actions"><button type="button" disabled={busy} onClick={() => { void run(() => agents.setObservation(selected.id, !observation?.watching)).catch(() => undefined); }}>
              <Icon name={observation?.watching ? 'stop' : 'refresh'} />{observation?.watching ? t.observer.pause : t.observer.resume}
            </button></div>
            {controlHub && <ObservedSessionControl key={`control:${selected.id}`} t={t} agents={agents} session={selected} disabled={busy} />}
            {!controlHub && selected.observation?.sourceId === 'codex' && <ObservedCodexPromptComposer key={`codex-prompt:${selected.id}`} t={t} agents={agents} session={selected} disabled={busy} />}
            {(controlHub || selected.observation?.sourceId !== 'codex') && <PromptSuggestions t={t} agents={agents} session={selected} disabled={busy} copyOnly />}
            {selected.observation?.sourceId === 'codex' && <details className="observed-codex-entry">
              <summary>{t.observedCodexPrompt.settings}</summary>
              <ObservedCodexQueueControls key={selected.id} t={t} agents={agents} session={selected} settingsOnly />
            </details>}
            {selected.observation?.sourceId === 'codex' && <details className="observed-codex-entry">
              <summary>{t.observedCodexPermission.title}</summary>
              <ObservedCodexPermissionControls key={selected.id} t={t} agents={agents} session={selected} />
            </details>}
            {selected.observation?.sourceId === 'codex' && <details className="observed-codex-entry">
              <summary>{t.observedCodex.title}</summary>
              <ObservedCodexControls key={selected.id} t={t} agents={agents} session={selected} />
            </details>}
            {selected.observation?.sourceId === 'hermes' && <details className="observed-codex-entry">
              <summary>{t.observedHermes.title}</summary>
              <ObservedHermesControls key={selected.id} t={t} agents={agents} session={selected} settingsOnly={controlHub} />
            </details>}
            {!controlHub && <details className="observed-codex-entry">
              <summary>{t.observedReply.title}</summary>
              <ObservedReplyControls key={selected.id} t={t} agents={agents} session={selected} />
            </details>}
            {content?.session?.messages.length ? (
              <ContinueInExtalia t={t} agents={agents} state={state} source={{ kind: 'observed', id: selected.id }}
                {...(observation?.projectPath ? { projectPath: observation.projectPath } : {})} onContinued={onContinued} onOpenSettings={onOpenSettings} />
            ) : null}
            {transcript.length || content?.session
              ? <MessageFileProvider key={selected.id} t={t} agents={agents} workspaces={state.workspaces} workspaceId={selected.workspaceId} projectPath={observation?.projectPath}>
                  {transcript.length
                    ? <ConversationTabs t={t} language={language} files={changedFiles}><TranscriptView t={t} items={transcript} language={language} onDecide={async () => false} previewAttachment={previewAttachment} /></ConversationTabs>
                    : <LibraryTranscript t={t} messages={content?.session?.messages ?? []} />}
                </MessageFileProvider>
              : content?.error ? <p className="form-error" role="alert">{content.error}</p> : <p>{t.common.loading}</p>}
          </>}
        </section>
      </div>
    </div>
    <div className="observe-panel" role="tabpanel" id={`${tabsId}-pairing-panel`} aria-labelledby={`${tabsId}-pairing-tab`} hidden={section !== 'pairing'} tabIndex={0}>
      {controlHub && <ManualObservedInboxControls t={t} agents={agents} />}
      <ManualReplyControls t={t} agents={agents} />
    </div>
  </div>;
}
