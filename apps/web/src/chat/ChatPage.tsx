import { ObservedInputCards } from '../observe/ObservedInputCards';
import { sourceLabel } from '@extalia/core';
import type { AgentHostApi, ApprovalDecisionInput, FileSystemCapability, HostState, SessionSummary } from '@extalia/platform';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { Composer, type ComposerSend } from './Composer';
import { ObservedCodexPromptComposer } from '../observe/ObservedCodexPromptComposer';
import { supportsObservedPromptQueue } from '../observe/observedCodexPromptModel';
import { ObservedSessionControl } from '../observe/ObservedSessionControl';
import { ObservedHermesControls } from '../observe/ObservedHermesControls';
import { attachmentPreviewLoader, sendPromptWithAttachments, uploadAttachments } from './attachments';
import { resolveChat, type ChatSelection } from './selection';
import { NativeSessionTree } from './NativeSessionTree';
import { SessionMoveDialog } from './SessionMoveDialog';
import { SessionWorkspaceReview } from './SessionWorkspaceReview';
import { useWorkspaceReviewRecovery } from './workspaceReviewRecovery';
import { SessionHandoverDialog } from './SessionHandoverDialog';
import { ObservedWorkspaceLinkButton } from '../observe/ObservedWorkspaceLinkDialog';
import { sessionFileRoots } from './sessionFileScopes';
import { projectActivity, projectTranscript, type WorkerItem } from './transcript';
import { NativeChatActivity, nativeMessageItems } from './NativeChatActivity';
import { useObserveScroll } from '../observe/useObserveScroll';
import { TranscriptView } from './TranscriptView';
import { ConversationTabs } from './ChangedFilesView';
import { projectChangedFiles } from './changedFiles';
import { MessageFileProvider } from './MessageFilePreview';
import { useSessionEvents } from './useSessionEvents';
import { Select } from '../ui/Select';
import { ProjectSkillsNotice } from '../skills/ProjectSkills';
import { WorkspacesSection } from '../pages/settings/WorkspacesSection';
import { createComposerSession } from './sessionHandoff';
import { MemoryContextPanel, memoryContextScope } from './MemoryContextPanel';
import { modelChoicesKey, sessionRuntime } from './sessionRuntime';
import { WorkspaceRuntimeNotice } from './WorkspaceRuntimeNotice';
import { ChatTeamControls } from './ChatTeamControls';
import { useChatTeam } from './chatTeam';
import { ChatSessionInfo } from './ChatSessionInfo';
import './chatLayout.css';

/** Viewport width affects presentation only; keep controls mounted when a drawer opens. */
function useChatMedia(query: string) {
  const [matches, setMatches] = useState(() => typeof window === 'undefined' || typeof window.matchMedia !== 'function' || window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query), update = () => setMatches(media.matches);
    media.addEventListener('change', update); update();
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}

export function ChatPage({ t, language, agents, picker, state, onState, selection, onSelect, onOpenSettings, onOpenSession, onReviewSkills, onOpenKnowledge, onLearningTarget }: {
  t: Messages;
  language: string;
  agents: AgentHostApi;
  picker?: FileSystemCapability;
  state: HostState;
  onState: (next: HostState) => void;
  selection: ChatSelection;
  onSelect: (next: ChatSelection) => void;
  onOpenSettings: () => void;
  onOpenSession?: (session: SessionSummary) => void;
  /** Opens the Skills page; the notice has already asked it to focus the workspace. */
  onReviewSkills: (workspaceId: string) => void;
  onOpenKnowledge?: () => void;
  /** Normal-flow home for the shared learning notification, including empty project setup. */
  onLearningTarget?: (target: HTMLDivElement | null) => void;
}) {
  const { workspace, session } = useMemo(() => resolveChat(state, selection), [state, selection]);
  const { events, error: loadError, loading } = useSessionEvents(agents, session?.id);
  const sessionId = session?.id;
  const leadName = session?.agentName || (session?.observation?.sourceId
    ? sourceLabel(session.observation.sourceId) : session?.control === 'observed' ? undefined : session?.title);
  const previewAttachment = useMemo(() => sessionId ? attachmentPreviewLoader(agents, sessionId) : undefined, [agents, sessionId]);
  const fileRoots = useMemo(() => sessionFileRoots(events, session?.workspaceFileScopes), [events, session?.workspaceFileScopes]);
  const items = useMemo(() => projectTranscript(events, fileRoots), [events, fileRoots]);
  const messageItems = useMemo(() => nativeMessageItems(items), [items]);
  const changedFiles = useMemo(() => projectChangedFiles(events, session?.observation?.projectPath ?? session?.projectLocation ?? workspace?.projectLocation, fileRoots), [events, session, workspace, fileRoots]);
  const activity = useMemo(() => projectActivity(events), [events]);
  const [error, setError] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const sourceScope = JSON.stringify([state.profile?.id, state.dataDirectory, state.storage?.dataDirectory]);
  const selectionKey = JSON.stringify({ workspaceId: selection.workspaceId, sessionId: selection.sessionId });
  const [moving, setMoving] = useState<{ id: string; agents: AgentHostApi; scope: string; selectionKey: string; wasActive: boolean }>();
  const movingSession = moving?.agents === agents && moving.scope === sourceScope ? state.sessions.find(row => row.id === moving.id) : undefined;
  const moveOwner = useRef({ agents, sourceScope, selectionKey });
  useEffect(() => { moveOwner.current = { agents, sourceScope, selectionKey }; }, [agents, sourceScope, selectionKey]);
  const [handoverOpen, setHandoverOpen] = useState(false);
  const transcriptRegion = useRef<HTMLDivElement>(null);
  const inspectorClose = useRef<HTMLButtonElement>(null);
  const inspectorRegion = useRef<HTMLElement>(null);
  const inspectorReturnFocus = useRef<HTMLElement | null>(null);
  const inspectorId = useId();
  const inspectorWide = useChatMedia('(min-width: 1280px)');
  const navigationWide = useChatMedia('(min-width: 901px)');
  const inspectorOwner = useMemo(() => ({ agents, sourceScope, sessionId, workspaceId: workspace?.id }), [agents, sourceScope, sessionId, workspace?.id]);
  const [inspector, setInspector] = useState<{ owner: typeof inspectorOwner; open: boolean; workerId?: string }>();
  const currentInspector = inspector?.owner === inspectorOwner ? inspector : undefined;
  const drawerOpen = !inspectorWide && Boolean(currentInspector?.open);
  const sessionsOverlayOpen = !navigationWide && listOpen;
  const [pinned, setPinned] = useState(true);
  const viewport = useObserveScroll({ region: transcriptRegion, selector: ':scope > .conversation-panel', owner: inspectorOwner,
    sessionKey: sessionId ?? `new:${workspace?.id ?? ''}`, contentReady: !loading && !loadError, onPinnedChange: setPinned });
  const openInspector = (worker?: WorkerItem) => {
    if (!drawerOpen && typeof document !== 'undefined' && typeof HTMLElement !== 'undefined' && document.activeElement instanceof HTMLElement) inspectorReturnFocus.current = document.activeElement;
    setListOpen(false); setInspector({ owner: inspectorOwner, open: true, ...(worker ? { workerId: worker.id } : {}) });
  };
  const closeInspector = () => {
    setInspector(current => current?.owner === inspectorOwner ? { ...current, open: false } : current);
    requestAnimationFrame(() => { if (inspectorReturnFocus.current?.isConnected) inspectorReturnFocus.current.focus({ preventScroll: true }); });
  };
  useEffect(() => {
    if (drawerOpen) inspectorClose.current?.focus({ preventScroll: true });
    else if (inspectorWide && typeof document !== 'undefined' && document.activeElement === inspectorClose.current) inspectorRegion.current?.focus({ preventScroll: true });
  }, [drawerOpen, inspectorWide]);
  const memoryDetails = useRef<HTMLDetailsElement>(null);
  const memoryDetailsId = useId();
  const teamControl = useChatTeam({ agents, state, workspace, session, onState });
  const workspaceReview = useWorkspaceReviewRecovery({ agents, session, onState });


  if (!workspace) {
    return (
      <div className="page">
        <div className="chat-learning-slot" ref={onLearningTarget} />
        <section className="card empty-state">
          <Icon name="folder" className="empty-icon" />
          <p>{t.chat.noWorkspace}</p>
          <div className="actions"><button type="button" className="primary" onClick={onOpenSettings}><Icon name="settings" />{t.chat.openSettings}</button></div>
        </section>
        <WorkspacesSection t={t} agents={agents} picker={picker} state={state} showGate={false} onState={next => {
          onState(next);
          if (next.workspaces[0]) onSelect({ workspaceId: next.workspaces[0].id, sessionId: null });
        }} />
      </div>
    );
  }

  const running = loading ? Boolean(session?.running) : activity.running;
  const waiting = Boolean(activity.pendingApprovalId ?? (loading ? session?.pendingApprovalId : undefined));
  const readOnly = session?.control === 'observed';
  const memoryScope = memoryContextScope(state, workspace, session);
  const openMemoryContext = () => {
    openInspector();
    if (!memoryDetails.current) return;
    memoryDetails.current.open = true;
    requestAnimationFrame(() => memoryDetails.current?.querySelector('summary')?.focus());
  };
  const focusComposer = () => requestAnimationFrame(() => (document.querySelector<HTMLTextAreaElement>('.observed-codex-prompt textarea') ?? document.getElementById('composer-input'))?.focus());

  const statusText = activity.stopping ? t.chat.status.stopping
    : !running ? t.chat.status.idle
      : waiting ? t.chat.status.waiting
        : activity.state === 'working' && activity.activity
          ? `${t.chat.activity[activity.activity]}${activity.target ? ` ${activity.target}` : ''}…`
          : t.chat.status[activity.state];

  async function guard(action: () => Promise<void>): Promise<boolean> {
    setError(null);
    try { await action(); return true; }
    catch (failure) { setError(errorMessage(failure)); return false; }
  }

  // v0.0.49: the session is created first (with the chosen model, effort and permission mode), then the files upload, then the prompt goes.
  const send = ({ text, choice, attachments, patch, learnSkill, bindSession }: ComposerSend) => workspaceReview.required ? Promise.resolve(false) : guard(async () => {
    if (teamControl.isUpdating() || teamControl.open) throw new Error(t.chat.team.updating);
    let id = session?.id;
    if (!id) {
      id = await createComposerSession({ agents, workspaceId: workspace.id, choice,
        ...(teamControl.supported ? { team: teamControl.team ?? null } : {}), bindSession, onState, onSelect, interrupted: t.chat.turnInterrupted });
    }
    try {
      const ids = await uploadAttachments(agents, id, attachments, patch);
      await sendPromptWithAttachments(agents, id, text, ids, learnSkill);
    } catch (failure) { await workspaceReview.recover(failure); throw failure; }
  });
  const refreshState = () => { void agents.getState().then(onState).catch(() => undefined); };

  const decide = async (approvalId: string, decision: ApprovalDecisionInput) => {
    if (!session || readOnly) return false;
    return guard(() => agents.resolveApproval(session.id, approvalId, decision));
  };

  const rename = async (id: string, title: string) => {
    if (!(await guard(async () => onState(await agents.renameSession(id, title))))) throw new Error('rename failed');
  };
  const remove = async (id: string) => {
    if (!(await guard(async () => onState(await agents.deleteSession(id))))) throw new Error('delete failed');
    if (id === session?.id) onSelect({ workspaceId: workspace.id });
  };

  return (
    <div className={`chat chat-session-page ${listOpen ? 'list-open' : ''} ${drawerOpen ? 'inspector-open' : ''}`}>
      <aside className="chat-side" id="chat-sessions" aria-label={t.chat.sessions} inert={drawerOpen || undefined}>
        <button type="button" className="icon-button small chat-sessions-close" aria-label={t.chat.hideSessions} onClick={() => { setListOpen(false); focusComposer(); }}><Icon name="close" /></button>
        <div className="field">
          <Select
            label={t.chat.workspace}
            value={workspace.id}
            options={state.workspaces.filter(item => item.mode !== 'observe').map(item => ({
              value: item.id,
              label: item.name,
              description: item.projectLocation,
              icon: 'folder' as const
            }))}
            onChange={id => onSelect({ workspaceId: id })}
          />
        </div>
        <button type="button" className="button new-session" aria-pressed={!session}
          onClick={() => { onSelect({ workspaceId: workspace.id, sessionId: null }); setListOpen(false); focusComposer(); }}>
          <Icon name="plus" />{t.chat.newSession}
        </button>
        <h2 className="side-heading">{t.chat.sessions}</h2>
        <NativeSessionTree t={t} agents={agents} state={state} workspaceId={workspace.id} activeId={session?.id} language={language} locked={Boolean(movingSession)} onState={onState}
          onSelect={next => { onSelect(next); setListOpen(false); if (next.sessionId === null) focusComposer(); }} onRename={rename} onDelete={remove}
          onSettings={row => setMoving({ id: row.id, agents, scope: sourceScope, selectionKey, wasActive: row.id === session?.id })} />
      </aside>

      <section className="chat-main chat-session-main" aria-labelledby="chat-title">
        <div className="chat-conversation" ref={transcriptRegion} inert={sessionsOverlayOpen || drawerOpen || undefined}>
        <MessageFileProvider key={session?.id ?? 'new'} t={t} agents={agents} workspaces={state.workspaces} workspaceId={workspace.id} projectPath={session?.observation?.projectPath ?? session?.projectLocation ?? workspace.projectLocation}>
          <ConversationTabs t={t} language={language} files={changedFiles} header={<div className="chat-head">
            <button type="button" className="button small sessions-toggle" aria-expanded={listOpen} aria-controls="chat-sessions" onClick={() => setListOpen(!listOpen)}>
              <Icon name={listOpen ? 'close' : 'menu'} />{listOpen ? t.chat.hideSessions : t.chat.showSessions}
            </button>
            <button type="button" className="icon-button small chat-inspector-toggle" aria-label={t.observer.inspector} title={t.observer.inspector} aria-expanded={drawerOpen} aria-controls={inspectorId} onClick={() => openInspector()}><Icon name="users" /></button>
            <h1 id="chat-title" className="chat-title">{session ? session.title || t.chat.untitled : t.chat.newSession}</h1>
            {session?.continuedFrom && <span className="badge">{t.handoff.badge(sourceLabel(session.continuedFrom.sourceId))}</span>}
            {session?.transient && <span className="badge warn" title={t.handoff.notSavedHint}>{t.handoff.notSaved}</span>}
            <span className="chat-workspace" title={session?.projectLocation ?? workspace.projectLocation}><Icon name="folder" />{workspace.name}</span>
            {session && agents.previewHandover && <button type="button" className="button small" onClick={() => setHandoverOpen(true)}>{t.sessionHandover.title}</button>}
            {!pinned && messageItems.length > 0 && <button type="button" className="button small chat-jump-latest" onClick={() => viewport.jumpToLatest()}>{t.observer.latestMessages}<Icon name="chevron" /></button>}
            {session?.control === 'observed' && <ObservedWorkspaceLinkButton agents={agents} session={session} state={state} t={t} onState={next => {
              onState(next); const linked = next.sessions.find(item => item.id === session.id);
              if (linked) onSelect({ workspaceId: linked.workspaceId, sessionId: linked.id });
            }} />}
          </div>}>
            {loadError && <p className="form-error" role="alert"><Icon name="alert" />{t.chat.loadFailed} {loadError}</p>}
            <WorkspaceRuntimeNotice t={t} state={state} workspace={workspace} session={session} onNewSession={() => {
              onSelect({ workspaceId: workspace.id, sessionId: null }); setListOpen(false); focusComposer();
            }} />
            {!loading && messageItems.length === 0 ? (
              <div className="chat-empty">
                <Icon name="chat" className="empty-icon" />
                <h2>{t.chat.emptyTitle}</h2>
                <p className="muted">{t.chat.emptyLead(workspace.name)}</p>
              </div>
            ) : (
              <TranscriptView t={t} items={messageItems} language={language} onDecide={decide} previewAttachment={previewAttachment} approvalsEnabled={!readOnly} onOpenWorker={openInspector} selectedWorkerId={currentInspector?.workerId} />
            )}

          </ConversationTabs>
        </MessageFileProvider>


        <div className="chat-footer">
          <p className={`chat-status ${running ? 'busy' : ''} ${waiting ? 'waiting' : ''}`} role="status" aria-live="polite">
            {running && !waiting && <span className="pulse" aria-hidden="true" />}
            {waiting && <Icon name="shield" />}
            {statusText}
          </p>
          <SessionWorkspaceReview t={t} agents={agents} state={state} session={session} required={workspaceReview.required} onReviewed={next => {
            workspaceReview.clear(); setError(null); onState(next); focusComposer();
          }} />
          {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
          {session?.control === 'observed' && <ObservedInputCards t={t} sessionId={session.id} />}

          <div className="chat-learning-slot" ref={onLearningTarget} />

          {session?.control === 'observed' && supportsObservedPromptQueue(session.observation?.sourceId)
            ? <ObservedCodexPromptComposer key={session.id} t={t} agents={agents} session={session} />
            : session?.control === 'observed' && agents.observedControlStatus && agents.dispatchObservedControl
              ? <ObservedSessionControl key={session.id} t={t} agents={agents} session={session} />
              : <Composer t={t} agents={agents} session={session} workspaceId={workspace.id} hermes={sessionRuntime(workspace, session) === 'hermes'} modelScopeKey={modelChoicesKey(state, workspace, session)}
            running={running} waiting={waiting} readOnly={readOnly} stopping={activity.stopping} sendBlocked={workspaceReview.required}
            onOpenContext={memoryScope ? openMemoryContext : undefined} contextPanelId={memoryScope ? memoryDetailsId : undefined}
            onSend={send} onStop={() => { if (session) void guard(() => agents.cancel(session.id)); }} onSessionChanged={refreshState} />}
        </div>
        </div>
        {drawerOpen && <button type="button" className="chat-inspector-backdrop" aria-label={t.observer.closeInspector} tabIndex={-1} onClick={closeInspector} />}
        <MessageFileProvider key={`inspector:${session?.id ?? 'new'}`} t={t} agents={agents} workspaces={state.workspaces} workspaceId={workspace.id} projectPath={session?.observation?.projectPath ?? session?.projectLocation ?? workspace.projectLocation}>
        <aside ref={inspectorRegion} tabIndex={-1} className="chat-context-rail" id={inspectorId} aria-label={t.observer.inspector} onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented && drawerOpen) { event.preventDefault(); closeInspector(); } }}>
          <header className="chat-inspector-head"><h2>{t.observer.inspector}</h2><button ref={inspectorClose} type="button" className="icon-button small chat-inspector-close" aria-label={t.observer.closeInspector} onClick={closeInspector}><Icon name="close" /></button></header>
          <div className="chat-inspector-content">
          {currentInspector?.workerId && <button type="button" className="button small native-worker-close" onClick={() => setInspector({ owner: inspectorOwner, open: true })}><Icon name="close" />{t.tool.hideWorkerPreview}</button>}
          <NativeChatActivity key={session?.id ?? `new:${workspace.id}`} t={t} language={language} items={items} events={events} primaryName={leadName} live={!loading && !loadError && (session?.control !== 'observed' || Boolean(session.observation?.watching && session.observation.status === 'watching'))} sessionId={sessionId} scopeKey={`${sourceScope}:${workspace.id}`} selectedWorkerId={currentInspector?.workerId} onOpenWorker={openInspector} previewAttachment={previewAttachment} team={teamControl.team} />
          <ProjectSkillsNotice t={t} agents={agents} workspace={workspace} onReview={onReviewSkills} />
          {memoryScope && <MemoryContextPanel key={memoryScope.key} t={t} language={language} id={memoryDetailsId} detailsRef={memoryDetails}
            agents={agents} workspaceId={workspace.id} ownerKey={memoryScope.key} draftKey={memoryScope.draftKey}
            workspaceName={workspace.name} connection={memoryScope.connection} context={memoryScope.context}
            onOpenSettings={onOpenSettings} onOpenSkills={() => onReviewSkills(workspace.id)} onOpenKnowledge={onOpenKnowledge} />}
          <ChatTeamControls t={t} agents={agents} state={state} workspace={workspace} session={session} running={running} control={teamControl} />
          <details className="chat-session-information"><summary>{t.chat.sessionInfo.title}</summary><ChatSessionInfo t={t} state={state} workspace={workspace} session={session} status={statusText} files={changedFiles} /></details>
          </div>
        </aside>

        </MessageFileProvider>
      </section>
      {movingSession && <SessionMoveDialog key={`${sourceScope}:${movingSession.id}`} t={t} agents={agents} session={movingSession} workspaces={state.workspaces}
        onClose={() => setMoving(undefined)} onMoved={(next, workspaceId) => {
          const owner = moveOwner.current;
          if (owner.agents !== agents || owner.sourceScope !== sourceScope) return;
          if (movingSession.id === session?.id) workspaceReview.clear();
          setError(null); onState(next); setMoving(undefined);
          if (moving?.wasActive && owner.selectionKey === moving.selectionKey) { onSelect({ workspaceId, sessionId: movingSession.id }); setListOpen(false); focusComposer(); }
        }} />}
      {handoverOpen && session && <SessionHandoverDialog agents={agents} state={state} session={session} t={t.sessionHandover} cliResumeMessages={t.observedCliResume} antigravityMessages={t.observedAntigravity}
        workspaceLinkMessages={t.observedWorkspaceLink} onState={next => { onState(next); const updated = next.sessions.find(item => item.id === session.id); if (updated) onSelect({ workspaceId: updated.workspaceId, sessionId: updated.id }); }}
        onOpenSettings={() => { setHandoverOpen(false); onOpenSettings(); }}
        destinationSetup={(destination, changed) => destination.observation?.sourceId === 'hermes' ? <ObservedHermesControls t={t} agents={agents} session={destination} settingsOnly onChanged={changed} /> : undefined}
        onOpenDestination={id => { void guard(async () => { const next = await agents.getState(); onState(next); const destination = next.sessions.find(item => item.id === id); if (destination) { setHandoverOpen(false); if (onOpenSession) onOpenSession(destination); else onSelect({ workspaceId: destination.workspaceId, sessionId: id }); } }); }}
        onClose={() => setHandoverOpen(false)} onApplied={receipt => {
          if (receipt.state === 'native-ready') void guard(async () => {
            const next = await agents.getState();
            setHandoverOpen(false); onState(next);
            if (receipt.targetSessionId) onSelect({ workspaceId: workspace.id, sessionId: receipt.targetSessionId });
          });
        }} />}
    </div>
  );
}
