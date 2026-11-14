import { sourceLabel, type PortableSession } from '@extalia/core';
import { ObservedInputCards } from '../observe/ObservedInputCards';
import { useObservedInputs } from '../observe/ObservedInputProvider';
import { useObservedRead } from '../observe/useObservedRead';
import type { AgentHostApi, HostState, SessionSummary } from '@extalia/platform';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { SessionList } from '../chat/SessionList';
import { SessionBrowser } from '../sessions/SessionBrowser';
import { observeProject, type ObserveSessionFilter } from '../observe/observeSessionGroups';
import { ObservedWorkspaceLinkButton } from '../observe/ObservedWorkspaceLinkDialog';
import { ObservedCodexNativeQueue } from '../observe/ObservedCodexNativeQueue';
import { OriginMark } from '../ui/OriginMark';
import { observedSource } from '../office/agentOrigin';
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
import { supportsObservedPromptQueue } from '../observe/observedCodexPromptModel';
import { ObservedCodexPermissionControls } from '../observe/ObservedCodexPermissionControls';
import { ManualReplyControls, ObservedReplyControls } from '../observe/ObservedReplyControls';
import { ObservedMemoryPanel } from '../observe/ObservedMemoryPanel';
import { ObservedAntigravityRecovery } from '../observe/ObservedAntigravityRecovery';
import { ObservedHermesControls } from '../observe/ObservedHermesControls';
import { ObservedSessionControl, ObservedSessionTools, ManualObservedInboxControls } from '../observe/ObservedSessionControl';
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
  const inputContext = useObservedInputs();
  const [section, setSection] = useState<ObserveSection>('sessions');
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ObserveSessionFilter>('all');
  const [mobileList, setMobileList] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolsSeen, setToolsSeen] = useState<Set<string>>(() => new Set());
  const transcriptRegion = useRef<HTMLDivElement>(null);
  const followScroll = useRef({ sessionId: '', pinned: true });
  const [jumpSession, setJumpSession] = useState<string>();
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
  const selectedId = selected ? String(selected.id) : undefined;
  const selectedOutputRevision = selected?.observation?.outputRevision;
  const selectedProjectPath = selected?.observation?.projectPath ? String(selected.observation.projectPath) : undefined;
  const [loaded, setLoaded] = useState<{ scope: typeof scope; id: string; session?: PortableSession; outputRevision?: string; error?: string }>();
  const [operation, setOperation] = useState<{ scope: typeof scope; busy: boolean; error?: string }>({ scope, busy: false });
  const busy = operation.scope === scope && operation.busy;
  const error = operation.scope === scope ? operation.error : undefined;
  const { events, error: eventError } = useSessionEvents(agents, selectedId);
  const transcript = useMemo(() => projectTranscript(events), [events]);
  const changedFiles = useMemo(() => projectChangedFiles(events, selectedProjectPath), [events, selectedProjectPath]);
  const previewAttachment = useMemo(() => selectedId ? attachmentPreviewLoader(agents, selectedId) : undefined, [agents, selectedId]);

  useEffect(() => {
    if (!selected?.id) return;
    const id = selected.id;
    let active = true, version = 0;
    const load = () => {
      const started = ++version;
      agents.observationSession(id).then(session => { if (active && started === version) setLoaded({ scope, id, session, outputRevision: selectedOutputRevision }); },
        failure => { if (active && started === version) setLoaded({ scope, id, error: errorMessage(failure) }); });
    };
    const stop = agents.subscribe(event => { if (event.sessionId === id && event.body.type === 'session.updated') load(); });
    load();
    return () => { active = false; stop(); };
  }, [agents, scope, selected?.id, selectedOutputRevision]);

  const run = async (action: () => Promise<HostState>) => {
    const lease = scope.acquire();
    if (!lease) return;
    setOperation({ scope, busy: true });
    try { const state = await action(); if (lease.isCurrent()) onState(state); }
    catch (failure) { if (lease.isCurrent()) setOperation({ scope, busy: false, error: errorMessage(failure) }); throw failure; }
    finally { if (lease.isCurrent()) setOperation(current => ({ ...current, busy: false })); lease.release(); }
  };
  const observation = selected?.observation;
  const controlModel = useMemo(() => selectedId ? observedSessionControlFor(agents, selectedId) : undefined, [agents, selectedId]);
  const controlView = useSyncExternalStore(controlModel?.subscribe ?? noSubscription, controlModel?.getSnapshot ?? getEmptyControlView, getEmptyControlView);
  const controlHub = !!agents.observedControlStatus && !!agents.dispatchObservedControl && controlView.phase !== 'unsupported';
  const content = loaded?.scope === scope && loaded?.id === selected?.id ? loaded : undefined;
  const attentionIds = useMemo(() => new Set(Object.entries(inputContext?.view.entries ?? {}).filter(([, entry]) => entry.requests.some(request => request.identityVerified && (request.state === 'pending' || request.state === 'unknown'))).map(([id]) => id)), [inputContext?.view.entries]);
  const browserAttentionIds = useMemo(() => [...attentionIds], [attentionIds]);
  const browserRefresh = JSON.stringify(sessions.map(item => [item.id, item.title, item.lastActiveAt, item.running, item.pendingApprovalId, item.observation?.watching, item.observation?.outputRevision, item.observation?.unreadOutput]));
  const project = selected ? observeProject(selected, state.workspaces) : undefined;
  const memoryWorkspace = selected ? state.workspaces.find(workspace => workspace.id === selected.workspaceId) : undefined;
  const memoryScopeKey = JSON.stringify([state.profile?.id, memoryWorkspace?.profileId, memoryWorkspace?.projectLocation, memoryWorkspace?.additionalProjectLocations, memoryWorkspace?.permissions, memoryWorkspace?.crossWorkspaceAccess]);
  const contentKey = transcript.length ? transcript.at(-1)!.id : content?.session?.messages.at(-1)?.index.toString() ?? '';
  useLayoutEffect(() => {
    const panel = transcriptRegion.current?.querySelector<HTMLElement>(':scope > .conversation-panel');
    if (!panel || !selectedId) return;
    if (followScroll.current.sessionId !== selectedId) followScroll.current = { sessionId: selectedId, pinned: true };
    if (contentKey && panel.clientHeight && followScroll.current.pinned) panel.scrollTop = panel.scrollHeight;
  }, [selectedId, contentKey, toolsOpen, section]);
  useEffect(() => {
    const panel = transcriptRegion.current?.querySelector<HTMLElement>(':scope > .conversation-panel');
    if (!panel || !selectedId) return;
    const onScroll = () => {
      if (panel.hidden || !panel.clientHeight) return;
      const pinned = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 100;
      followScroll.current.pinned = pinned;
      setJumpSession(pinned ? undefined : selectedId);
    };
    panel.addEventListener('scroll', onScroll, { passive: true });
    return () => { panel.removeEventListener('scroll', onScroll); };
  }, [selectedId]);

  const latestAssistant = content?.session?.messages.slice().reverse().find(message => message.role === 'assistant')?.content;
  const renderedAssistant = transcript.length ? transcript.slice().reverse().find(item => item.kind === 'assistant')?.text : latestAssistant;
  useObservedRead({ agents, sessionId: selectedId, revision: selectedOutputRevision, loadedRevision: content?.outputRevision,
    unread: observation?.unreadOutput, latestAssistant, renderedAssistant, active: section === 'sessions', viewKey: JSON.stringify([mobileList, toolsOpen]), region: transcriptRegion, follow: followScroll });

  const openTools = () => { if (selectedId) setToolsSeen(current => new Set(current).add(selectedId)); setToolsOpen(true); };
  const choose = (id: string) => { setChosen(id); setMobileList(false); setToolsOpen(false); };
  const nativeControls = selected && <div className="observe-native-tools">
    {selected.observation?.sourceId === 'codex' && <>
      <details className="observed-codex-entry"><summary>{t.observedCodexPrompt.settings}</summary><ObservedCodexQueueControls key={selected.id} t={t} agents={agents} session={selected} settingsOnly /></details>
      <details className="observed-codex-entry"><summary>{t.observedCodexPermission.title}</summary><ObservedCodexPermissionControls key={selected.id} t={t} agents={agents} session={selected} /></details>
      <details className="observed-codex-entry"><summary>{t.observedCodex.title}</summary><ObservedCodexControls key={selected.id} t={t} agents={agents} session={selected} showQuestions={!(inputContext?.view.entries[selected.id]?.phase === 'ready' || inputContext?.view.entries[selected.id]?.phase === 'private' || inputContext?.view.entries[selected.id]?.requests.some(request => request.origin === 'codex-native'))} /></details>
      <ObservedCodexNativeQueue key={`native-queue:${selected.id}`} t={t} agents={agents} session={selected} />
    </>}
    {selected.observation?.sourceId === 'antigravity' && <>
      <ObservedCodexNativeQueue key={`native-queue:${selected.id}`} t={t} agents={agents} session={selected} />
      <ObservedAntigravityRecovery t={t.observedAntigravity} agents={agents} session={selected} disabled={busy} onChanged={() => { void controlModel?.refresh(); }} />
    </>}
    {selected.observation?.sourceId === 'hermes' && <ObservedHermesControls key={selected.id} t={t} agents={agents} session={selected} settingsOnly={controlHub} />}
    {!controlHub && <ObservedReplyControls key={selected.id} t={t} agents={agents} session={selected} />}
  </div>;
  const sessionFacts = selected && <div className="observe-session-facts"><h3>{t.observer.sessionDetails}</h3><dl>
            <div><dt>{t.observer.harness}</dt><dd>{sourceLabel(observation?.sourceId || '')}</dd></div>
            <div><dt>{t.observer.workspace}</dt><dd>{project?.workspaceName || t.observer.unlinkedWorkspace}</dd></div>
            <div><dt>{t.observer.folder}</dt><dd>{project?.projectPath ? <code>{project.projectPath}</code> : t.observer.unknownProject}</dd></div>
            {selected.model && <div><dt>{t.observer.model}</dt><dd><code>{selected.model}</code></dd></div>}
            <div><dt>{t.observer.status}</dt><dd>{observation && t.observer[observation.status]}</dd></div>
            {observation?.lastCheckedAt && <div><dt>{t.observer.lastUpdated}</dt><dd><time dateTime={observation.lastCheckedAt}>{new Intl.DateTimeFormat(language, { timeStyle: 'medium' }).format(new Date(observation.lastCheckedAt))}</time></dd></div>}
          </dl></div>;
  const conversation = selected && <MessageFileProvider key={selected.id} t={t} agents={agents} workspaces={state.workspaces} workspaceId={selected.workspaceId} projectPath={observation?.projectPath}>
    <ConversationTabs t={t} language={language} files={changedFiles}>
      {transcript.length ? <TranscriptView t={t} items={transcript} language={language} onDecide={async () => false} previewAttachment={previewAttachment} />
        : content?.session ? <LibraryTranscript t={t} messages={content.session.messages} />
          : content?.error ? <p className="form-error" role="alert">{content.error}</p> : <p className="muted observe-loading" role="status">{t.common.loading}</p>}
    </ConversationTabs>
  </MessageFileProvider>;
  return <div className="page observe-page">
    <header className="observe-page-header">
      <div className="observe-page-heading"><h1>{t.observer.title}</h1><span className="badge">{sessions.length}</span></div>
      <div className="observe-navigation-bar">
        <div className="observe-tabs" role="tablist" aria-label={t.observer.sections.label}>
          {OBSERVE_SECTIONS.map(item => <button key={item} type="button" role="tab" id={`${tabsId}-${item}-tab`} aria-controls={`${tabsId}-${item}-panel`} aria-selected={section === item} tabIndex={section === item ? 0 : -1} onClick={() => setSection(item)} onKeyDown={event => moveTab(event, item)}>{t.observer.sections[item]}</button>)}
        </div>
        {section === 'sessions' && <button type="button" className="button small observe-mobile-list-toggle" aria-label={t.observer.browseSessions} title={t.observer.browseSessions} aria-expanded={mobileList} aria-controls={`${tabsId}-session-list`} onClick={() => setMobileList(!mobileList)}><Icon name="panel" /><span className="observe-toolbar-label">{t.observer.browseSessions}</span></button>}
      </div>
      <div className="observe-page-actions">
        <button type="button" className="button small primary observe-discovery-toggle" aria-label={discoveryOpen ? t.observer.closeDiscovery : t.observer.add} title={discoveryOpen ? t.observer.closeDiscovery : t.observer.add} aria-expanded={discoveryOpen} aria-controls={`${tabsId}-discovery`} onClick={() => { setDiscoveryOpen(!discoveryOpen); setSection('sessions'); }}><Icon name="plus" /><span className="observe-toolbar-label">{discoveryOpen ? t.observer.closeDiscovery : t.observer.add}</span></button>
        {onOpenAgentSettings && <button type="button" className="icon-button small" aria-label={t.pageRoles.manageAgentApps} title={t.pageRoles.manageAgentApps} onClick={onOpenAgentSettings}><Icon name="settings" /></button>}
        {onOpenImport && <button type="button" className="icon-button small" aria-label={t.pageRoles.openImport} title={t.pageRoles.openImport} onClick={onOpenImport}><Icon name="files" /></button>}
      </div>
    </header>
    {discoveryOpen && <section className="observe-discovery" id={`${tabsId}-discovery`} aria-labelledby={`${tabsId}-discovery-title`}>
      <div className="section-head"><h2 id={`${tabsId}-discovery-title`}>{t.observer.discoveryTitle}</h2></div>
      <p className="muted small">{t.observer.addHint}</p>
      <AddObservedSessions t={t} language={language} agents={agents} onWatched={(next, selectedId) => { onState(next); if (selectedId) choose(selectedId); setDiscoveryOpen(false); setSection('sessions'); }} />
    </section>}
    {error && <p role="alert" className="form-error">{error}</p>}

    <div className="observe-panel" role="tabpanel" id={`${tabsId}-sessions-panel`} aria-labelledby={`${tabsId}-sessions-tab`} hidden={section !== 'sessions'} tabIndex={0}>
      <div className={`observe-workspace${toolsOpen ? ' tools-open' : ''}${mobileList ? ' list-open' : ''}`}>
        <aside className="observe-session-nav" id={`${tabsId}-session-list`} aria-label={t.observer.browseSessions}>
          <div className="observe-session-search"><label className="observe-search-field"><Icon name="search" /><input type="search" value={query} aria-label={t.observer.searchSessions} placeholder={t.observer.searchSessions} onChange={event => setQuery(event.target.value)} /></label>
            <select value={filter} aria-label={t.observer.filterSessions} onChange={event => setFilter(event.target.value as ObserveSessionFilter)}>{(['all', 'running', 'attention', 'paused'] as const).map(value => <option key={value} value={value}>{t.observer.filters[value]}</option>)}</select>
          </div>
          <div className="observe-session-groups">
            <SessionBrowser t={t} agents={agents} state={state} collection="observed" query={query} status={filter} attentionIds={browserAttentionIds} refreshKey={browserRefresh} emptyLabel={sessions.length ? t.observer.noMatches : t.observer.empty}
              renderRows={rows => rows.length ? <SessionList t={t} sessions={rows.filter((row): row is SessionSummary => 'lastActiveAt' in row)} activeId={selectedId} compactIndicators language={language} onSelect={choose} onRename={async (id, title) => { await run(() => agents.renameSession(id, title)); }} onDelete={async id => { await run(() => agents.deleteSession(id)); }} /> : null} />
          </div>
        </aside>
        <section className="observe-conversation" aria-label={t.characterConsole.messages}>
          {!selected ? <div className="observe-empty"><Icon name="chat" /><h2>{t.observer.select}</h2><p className="muted">{t.observer.lead}</p></div> : <>
            <header className="observe-session-header">
              <div className="observe-session-heading"><h2 title={selected.title}>{selected.title || t.chat.untitled}</h2>
                <div className="observe-session-meta"><span className="observe-harness-label"><OriginMark mark={observedSource(observation?.sourceId).mark} />{sourceLabel(observation?.sourceId || '')}</span><span className={`observe-session-status${selected.pendingApprovalId || attentionIds.has(selected.id) ? ' attention' : selected.running ? ' running' : ''}`} role="status">{selected.pendingApprovalId || attentionIds.has(selected.id) ? t.chat.waiting : selected.running ? t.chat.running : observation && t.observer[observation.status]}</span>
                  <div className="observe-session-location"><Icon name="folder" /><span title={project?.projectPath}>{project?.folderName || project?.workspaceName || t.observer.unknownProject}</span>{!project?.workspaceId && project?.projectPath && <span className="badge">{t.observer.folderOnly}</span>}<ObservedWorkspaceLinkButton t={t} agents={agents} state={state} session={selected} onState={onState} /></div>
                </div>
              </div>
              <div className="observe-session-actions">
                <button type="button" className="icon-button small" disabled={busy} aria-label={observation?.watching ? t.observer.pause : t.observer.resume} title={observation?.watching ? t.observer.pause : t.observer.resume} onClick={() => { void run(() => agents.setObservation(selected.id, !observation?.watching)).catch(() => undefined); }}><Icon name={observation?.watching ? 'stop' : 'refresh'} /></button>
                {content?.session?.messages.length ? <ContinueInExtalia compact t={t} agents={agents} state={state} source={{ kind: 'observed', id: selected.id }} {...(observation?.projectPath ? { projectPath: observation.projectPath } : {})} onContinued={onContinued} onOpenSettings={onOpenSettings} /> : null}
                <button type="button" className="icon-button small observe-tools-toggle" aria-label={t.characterConsole.tools} title={t.characterConsole.tools} aria-expanded={toolsOpen} aria-controls={`${tabsId}-tools`} onClick={openTools}><Icon name="settings" /></button>
              </div>
            </header>
            <div className="observe-transcript-region" ref={transcriptRegion}>{eventError && <p className="observe-activity-error note small" role="alert">{t.observer.activityUnavailable}</p>}{conversation}{jumpSession === selected.id && <button type="button" className="button small observe-jump-latest" onClick={() => { const panel = transcriptRegion.current?.querySelector<HTMLElement>(':scope > .conversation-panel'); if (panel) panel.scrollTop = panel.scrollHeight; followScroll.current.pinned = true; setJumpSession(undefined); }}>{t.observer.latestMessages}<Icon name="chevron" /></button>}</div>
            <footer className="observe-composer-region">
              {observation?.error && <p role="alert" className="form-error">{observation.error}</p>}
              <ObservedInputCards t={t} sessionId={selected.id} />
              {supportsObservedPromptQueue(selected.observation?.sourceId) ? <ObservedCodexPromptComposer key={`codex-prompt:${selected.id}`} t={t} agents={agents} session={selected} disabled={busy} showNativeQueue={false} />
                : controlHub ? <ObservedSessionControl key={`control:${selected.id}`} t={t} agents={agents} session={selected} disabled={busy} compact onOpenTools={openTools} /> : <p className="muted small">{t.observer.readOnly}</p>}
              {!supportsObservedPromptQueue(selected.observation?.sourceId) && <PromptSuggestions t={t} agents={agents} session={selected} disabled={busy} copyOnly />}
            </footer>
          </>}
        </section>
        {selected && <aside className="observe-tools-panel" id={`${tabsId}-tools`} aria-label={t.characterConsole.tools} hidden={!toolsOpen}>
          <header className="observe-tools-heading"><h2>{t.characterConsole.tools}</h2><button type="button" className="icon-button small" aria-label={t.observer.closeTools} onClick={() => setToolsOpen(false)}><Icon name="close" /></button></header>
          {sessionFacts}
          {memoryWorkspace && !memoryWorkspace.providerProfileId && <p className="muted small">{t.observer.captureOnly}</p>}
          {toolsSeen.has(selected.id) && <ObservedMemoryPanel agents={agents} session={selected} scopeKey={memoryScopeKey} t={t.observedMemory} disabled={busy} />}
          {toolsSeen.has(selected.id) && (controlHub ? <ObservedSessionTools key={`tools:${selected.id}`} t={t} agents={agents} session={selected} disabled={busy} nativeControls={nativeControls} /> : nativeControls)}
          <p className="muted small observe-tools-note"><Icon name="shield" />{t.observer.note}</p>
        </aside>}
        {selected && !toolsOpen && <aside className="observe-facts-rail" aria-label={t.observer.sessionDetails}>{sessionFacts}</aside>}
      </div>
    </div>
    <div className="observe-panel observe-pairing-panel" role="tabpanel" id={`${tabsId}-pairing-panel`} aria-labelledby={`${tabsId}-pairing-tab`} hidden={section !== 'pairing'} tabIndex={0}>
      {controlHub && <ManualObservedInboxControls t={t} agents={agents} />}
      <ManualReplyControls t={t} agents={agents} />
    </div>
  </div>;
}
