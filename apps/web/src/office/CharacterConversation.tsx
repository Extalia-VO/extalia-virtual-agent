import { ObservedCodexControls } from '../observe/ObservedCodexControls';
import { ObservedCodexQueueControls } from '../observe/ObservedCodexQueueControls';
import { ObservedCodexPromptComposer } from '../observe/ObservedCodexPromptComposer';
import { ObservedCodexNativeQueue } from '../observe/ObservedCodexNativeQueue';
import { ObservedCodexPermissionControls } from '../observe/ObservedCodexPermissionControls';
import { ObservedReplyControls } from '../observe/ObservedReplyControls';
import { ObservedHermesControls } from '../observe/ObservedHermesControls';
import { ObservedSessionControl } from '../observe/ObservedSessionControl';
import { observedSessionControlFor, type ObservedSessionControlView } from '../observe/observedSessionControlModel';
import type { CharacterAppearance } from '@extalia/core';
import type { AgentHostApi, ApprovalDecisionInput, HostState, SessionSummary } from '@extalia/platform';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Composer, type ComposerSend } from '../chat/Composer';
import { PromptSuggestions } from '../chat/PromptSuggestions';
import { attachmentPreviewLoader, sendPromptWithAttachments, uploadAttachments } from '../chat/attachments';
import { projectActivity } from '../chat/transcript';
import { characterTranscript } from './characterHistory';
import { TranscriptView } from '../chat/TranscriptView';
import { MessageFileProvider } from '../chat/MessageFilePreview';
import { projectChangedFiles } from '../chat/changedFiles';
import { ChangedFilesView } from '../chat/ChangedFilesView';
import { useSessionEvents } from '../chat/useSessionEvents';
import type { OfficeAgent } from './presence';
import { Icon } from '../ui/Icon';
import { AppearanceEditor } from './AppearanceEditor';
import type { StaffRole } from './scene/avatars/outfitCatalog';
import type { LookIdentity } from './scene/avatars/appearance';
import { ActivityTimeline } from './console/ActivityTimeline';
import { characterEvents, characterTimeline, shortcutFor, teamRoster } from './console/timeline';

const noSubscription = () => () => undefined;
const emptyControlView: ObservedSessionControlView = { phase: 'loading', draft: '', selected: '', busy: false };
const getEmptyControlView = () => emptyControlView;
import { modelChoicesKey, sessionRuntime } from '../chat/sessionRuntime';
import { WorkspaceRuntimeNotice } from '../chat/WorkspaceRuntimeNotice';
import './characterConversationLayout.css';

const TOOLS_MEDIA = '(min-width: 1100px)';
const wideToolsSnapshot = () => typeof window !== 'undefined' && window.matchMedia(TOOLS_MEDIA).matches;
const subscribeToolsMedia = (listener: () => void) => {
  const media = window.matchMedia(TOOLS_MEDIA);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
};

const isTyping = (target: EventTarget | null) => target instanceof HTMLElement
  && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/** The selected character's saved look and the editor's preview/save actions. */
export interface CharacterAppearanceControls {
  saved: CharacterAppearance | undefined;
  /** v0.0.30: the name its generated (unsaved) look is seeded from. */
  identity?: LookIdentity | undefined;
  onPreview(appearance: CharacterAppearance | null): void;
  onSave(appearance: CharacterAppearance | null): Promise<void>;
  /** Facility staff: the role uniform is locked (see `staffAppearance`). */
  uniform?: StaffRole | undefined;
  /** What "Default outfit" and Reset return to, when not the generated look. */
  defaults?: CharacterAppearance | undefined;
}

export type ConversationTab = 'messages' | 'activity' | 'files';
export interface CharacterConversationToolsState {
  available: boolean;
  open: boolean;
  wide: boolean;
}

/**
 * Conversation controls for a character's native Extalia session, shown in the
 * session dialog (which owns identity, status header and close). Workers and
 * observed execution stays in its source app; Codex has a separate text sender. Tabs stay mounted, so switching
 * keeps the scroll position; the composer stays mounted, so it keeps the draft.
 */
export function CharacterConversation({ t, language, agents, state, session, agent, onState, appearance, tab: controlledTab, onTab, readOnlyReason, onLocate, following = false, onToggleFollow, onSelectCharacter, onToolsStateChange }: {
  t: Messages;
  language: string;
  agents: AgentHostApi;
  state: HostState;
  session: SessionSummary;
  agent: OfficeAgent;
  onState: (next: HostState) => void;
  /** Appearance is visual only, so observed characters and workers can be restyled too. */
  appearance?: CharacterAppearanceControls | undefined;
  /** Controlled tab (e.g. the dialog opened on Activity); uncontrolled when absent. */
  tab?: ConversationTab | undefined;
  onTab?: ((tab: ConversationTab) => void) | undefined;
  /** The session ended or disappeared while shown: history stays readable, controls go away. */
  readOnlyReason?: string | undefined;
  /** Move the camera back to this character. */
  onLocate?: (() => void) | undefined;
  /** Whether the camera keeps following this character, and the toggle (locating frames it once). */
  following?: boolean;
  onToggleFollow?: (() => void) | undefined;
  /** Select another character, e.g. a worker from the team list. */
  onSelectCharacter?: ((characterId: string) => void) | undefined;
  /** Let the containing dialog size itself to the tools' actual layout state. */
  onToolsStateChange?: ((state: CharacterConversationToolsState) => void) | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [ownTab, setOwnTab] = useState<ConversationTab>('messages');
  const tab = controlledTab ?? ownTab;
  const tabRef = useRef(onTab);
  useEffect(() => { tabRef.current = onTab; });
  const setTab = (next: ConversationTab) => { setOwnTab(next); tabRef.current?.(next); };
  const ids = useId();
  const c = t.characterConsole;
  const { events, error: loadError, loading } = useSessionEvents(agents, session.id);
  const previewAttachment = useMemo(() => attachmentPreviewLoader(agents, session.id), [agents, session.id]);
  const isWorker = agent.agentId !== 'primary';
  const wide = useSyncExternalStore(subscribeToolsMedia, wideToolsSnapshot, () => true);
  const [toolsChoice, setToolsChoice] = useState<{ wide: boolean; open: boolean }>();
  const sessionControl = session.control;
  const sessionId = session.id;
  const controlModel = useMemo(() => sessionControl === 'observed' ? observedSessionControlFor(agents, sessionId) : undefined, [agents, sessionControl, sessionId]);
  const controlView = useSyncExternalStore(controlModel?.subscribe ?? noSubscription, controlModel?.getSnapshot ?? getEmptyControlView, getEmptyControlView);
  const controlHub = !!agents.observedControlStatus && !!agents.dispatchObservedControl && controlView.phase !== 'unsupported';
  const hasTools = !isWorker && !readOnlyReason && (session.control !== 'observed' || !controlHub
    || session.observation?.sourceId === 'codex' || session.observation?.sourceId === 'hermes');
  const toolsOpen = hasTools && (toolsChoice?.wide === wide ? toolsChoice.open : wide);
  const toolsStateChange = useRef(onToolsStateChange);
  const toolsState = useRef<CharacterConversationToolsState>({ available: hasTools, open: toolsOpen, wide });
  useLayoutEffect(() => { toolsStateChange.current = onToolsStateChange; }, [onToolsStateChange]);
  useLayoutEffect(() => {
    toolsState.current = { available: hasTools, open: toolsOpen, wide };
    toolsStateChange.current?.(toolsState.current);
  }, [hasTools, toolsOpen, wide]);
  useLayoutEffect(() => () => {
    toolsStateChange.current?.({ available: false, open: false, wide: toolsState.current.wide });
  }, []);
  const toolsToggle = useRef<HTMLButtonElement>(null);
  const toolsClose = useRef<HTMLButtonElement>(null);
  const closeTools = () => {
    setToolsChoice({ wide, open: false });
    requestAnimationFrame(() => toolsToggle.current?.focus({ preventScroll: true }));
  };
  useLayoutEffect(() => { if (toolsOpen && !wide) toolsClose.current?.focus({ preventScroll: true }); }, [toolsOpen, wide]);
  const readOnly = session.control === 'observed' || isWorker || Boolean(readOnlyReason);
  const items = useMemo(() => characterTranscript(events, agent), [events, agent]);
  const activity = useMemo(() => projectActivity(events), [events]);
  const timeline = useMemo(() => characterTimeline(events, agent), [events, agent]);
  const team = useMemo(() => isWorker ? [] : teamRoster(events, session.id), [events, session.id, isWorker]);
  const workspaceRoot = session.observation?.projectPath ?? state.workspaces.find(item => item.id === session.workspaceId)?.projectLocation;
  // A lead answers for its whole team's edits; a worker shows its own.
  const files = useMemo(() => projectChangedFiles(isWorker ? characterEvents(events, agent) : events, workspaceRoot), [events, agent, isWorker, workspaceRoot]);

  // Messages follow new output only while the reader is at the bottom.
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stick.current && tab === 'messages') element.scrollTop = element.scrollHeight;
  }, [items, tab]);

  // M / A / L / F / E act on this character unless the user is typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector('[data-message-file-preview], .attachment-viewer')) return;
      const action = shortcutFor(event.key, { alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey }, isTyping(event.target));
      if (!action) return;
      if ((action === 'locate' && !onLocate) || (action === 'follow' && !onToggleFollow) || (action === 'appearance' && !appearance)) return;
      event.preventDefault();
      if (action === 'message') {
        setOwnTab('messages'); tabRef.current?.('messages'); setEditing(false);
        // The composer may only be enabled after the tab switch renders, so try now and on the next two frames.
        const focus = () => (document.querySelector<HTMLTextAreaElement>('.observed-session-control textarea:not([readonly]), .observed-codex-prompt textarea') ?? document.getElementById('composer-input'))?.focus();
        focus(); requestAnimationFrame(() => { focus(); requestAnimationFrame(focus); });
      }
      else if (action === 'activity') { setOwnTab('activity'); tabRef.current?.('activity'); setEditing(false); }
      else if (action === 'locate') onLocate?.();
      else if (action === 'follow') onToggleFollow?.();
      else setEditing(value => !value);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onLocate, onToggleFollow, appearance]);
  const [error, setError] = useState<string | null>(null);
  const workspace = state.workspaces.find(item => item.id === session.workspaceId);
  const running = !readOnlyReason && (isWorker || session.control === 'observed' ? agent.running : loading ? session.running : activity.running);
  const waiting = !readOnly && Boolean(activity.pendingApprovalId ?? (loading ? session.pendingApprovalId : undefined));
  const status = readOnlyReason ? t.chat.status.offline
    : session.control === 'observed'
      ? agent.status === 'paused' ? t.observer.paused : agent.status === 'unavailable' ? t.observer.unavailable
        : agent.status === 'observing' ? t.office.observing
          : agent.status === 'working' && agent.activity ? `${t.chat.activity[agent.activity]}${agent.target ? ` ${agent.target}` : ''}…`
            : t.chat.status[agent.status]
      : isWorker
        ? agent.status === 'stopping' ? t.chat.status.stopping
          : agent.status === 'waiting' ? t.chat.status.waiting
            : agent.status === 'observing' ? t.office.observing
              : agent.status === 'paused' ? t.observer.paused
                : agent.status === 'unavailable' ? t.observer.unavailable
                  : t.chat.status[agent.status]
        : activity.stopping ? t.chat.status.stopping
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

  const refreshState = () => { void agents.getState().then(onState).catch(() => undefined); };
  const send = ({ text, attachments, patch, learnSkill }: ComposerSend) => readOnly ? Promise.resolve(false) : guard(async () => {
    const ids = await uploadAttachments(agents, session.id, attachments, patch);
    await sendPromptWithAttachments(agents, session.id, text, ids, learnSkill);
    refreshState();
  });
  const decide = async (approvalId: string, decision: ApprovalDecisionInput) => {
    if (readOnly) return false;
    const sent = await guard(() => agents.resolveApproval(session.id, approvalId, decision));
    if (sent) refreshState();
    return sent;
  };

  const panelId = (id: ConversationTab) => `${ids}-${id}`;
  return (
    <section className="chat-main character-conversation character-conversation-layout" aria-label={agent.displayName} data-tools-open={toolsOpen || undefined}>
      <div className="character-conversation-main" inert={toolsOpen && !wide || undefined}>
      <div className="character-actions" title={c.shortcuts}>
        <div className="character-tabs" role="tablist" aria-label={agent.displayName}>
          {(['messages', 'activity', 'files'] as const).map(id => <button key={id} id={`${panelId(id)}-tab`} type="button" role="tab" aria-selected={tab === id && !editing} aria-controls={panelId(id)}
            onClick={() => { setTab(id); setEditing(false); }}>{c[id]}{id === 'activity' && team.length > 0 && <span className="badge">{team.length}</span>}{id === 'files' && files.length > 0 && <span className="badge">{files.length}</span>}</button>)}
        </div>
        {hasTools && <button ref={toolsToggle} type="button" className="button small character-tools-toggle" aria-expanded={toolsOpen} aria-controls={`${ids}-tools`}
          aria-label={toolsOpen ? c.hideTools : c.showTools} title={toolsOpen ? c.hideTools : c.showTools}
          onClick={() => { if (toolsOpen) closeTools(); else setToolsChoice({ wide, open: true }); }}><Icon name="settings" />{c.tools}</button>}
        {onLocate && <button type="button" className="icon-button small" aria-label={c.locate} title={`${c.locate} (L)`} onClick={onLocate}><Icon name="search" /></button>}
        {onToggleFollow && <button type="button" className={`icon-button small follow-toggle ${following ? 'active' : ''}`} aria-pressed={following} aria-label={following ? t.officeOverlay.follow.stop : t.officeOverlay.follow.start}
          title={`${following ? t.officeOverlay.follow.stop : t.officeOverlay.follow.hint} (F)`} onClick={onToggleFollow}><Icon name="crosshair" /></button>}
        {appearance && <button type="button" className="button small appearance-toggle" aria-expanded={editing} title={`${t.appearance.open} (E)`} onClick={() => setEditing(value => !value)}>
          <Icon name="edit" />{t.appearance.open}
        </button>}
      </div>
      {appearance && editing && <AppearanceEditor t={t.appearance} characterId={agent.id} identity={appearance.identity} saved={appearance.saved} uniform={appearance.uniform} defaults={appearance.defaults}
        onPreview={appearance.onPreview} onSave={appearance.onSave} onClose={() => setEditing(false)} />}
      {readOnlyReason && <p className="muted-note character-ended-note" role="status"><Icon name="alert" />{readOnlyReason}</p>}
      {!readOnlyReason && isWorker && <p className="muted-note">{t.office.workerNote}</p>}
      {!readOnlyReason && session.control === 'observed' && <p className="muted-note">{session.observation?.sourceId === 'codex' ? t.observedCodex.officeNote : t.office.observedNote}</p>}
      {loadError && <p className="form-error" role="alert"><Icon name="alert" />{t.chat.loadFailed} {loadError}</p>}
      <div ref={scroller} id={panelId('messages')} className="character-tab-panel" role="tabpanel" aria-labelledby={`${panelId('messages')}-tab`} hidden={editing || tab !== 'messages'}
        onScroll={event => { const element = event.currentTarget; stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>
        {!loading && items.length === 0
          ? <div className="chat-empty"><Icon name="chat" className="empty-icon" /><h3>{t.chat.emptyTitle}</h3><p className="muted">{workspace ? t.chat.emptyLead(workspace.name) : t.chat.noWorkspace}</p></div>
          : <MessageFileProvider key={session.id} t={t} agents={agents} workspaces={state.workspaces} workspaceId={session.workspaceId} projectPath={session.observation?.projectPath ?? workspace?.projectLocation}>
              <TranscriptView t={t} items={items} language={language} onDecide={decide} previewAttachment={previewAttachment} approvalsEnabled={!readOnly} />
            </MessageFileProvider>}
      </div>
      <div id={panelId('activity')} className="character-tab-panel" role="tabpanel" aria-labelledby={`${panelId('activity')}-tab`} hidden={editing || tab !== 'activity'}>
        <ActivityTimeline t={t} language={language} entries={timeline} team={team} {...(onSelectCharacter ? { onSelectCharacter } : {})} />
      </div>
      <div id={panelId('files')} className="character-tab-panel" role="tabpanel" aria-labelledby={`${panelId('files')}-tab`} hidden={editing || tab !== 'files'}>
        <MessageFileProvider key={session.id} t={t} agents={agents} workspaces={state.workspaces} workspaceId={session.workspaceId} projectPath={workspaceRoot}>
          <ChangedFilesView t={t} language={language} files={files} />
        </MessageFileProvider>
      </div>
      <footer className="chat-footer">
        <p className={`chat-status ${running ? 'busy' : ''} ${waiting ? 'waiting' : ''}`} role="status" aria-live="polite">
          {running && !waiting && <span className="pulse" aria-hidden="true" />}{waiting && <Icon name="shield" />}{status}
        </p>
        {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
        {!isWorker && !readOnlyReason && session.control === 'observed' && controlHub &&
          <ObservedSessionControl key={`control:${session.id}`} t={t} agents={agents} session={session} compact />}
        {!isWorker && !readOnlyReason && session.control === 'observed' && !controlHub && session.observation?.sourceId === 'codex' &&
          <ObservedCodexPromptComposer key={session.id} t={t} agents={agents} session={session} showNativeQueue={false} />}
        {!readOnly && <Composer t={t} agents={agents} session={session} workspaceId={session.workspaceId}
          hermes={sessionRuntime(workspace, session) === 'hermes'} modelScopeKey={modelChoicesKey(state, workspace, session)} running={running} waiting={waiting} readOnly={false} stopping={activity.stopping}
          onSend={send} onStop={() => { void guard(async () => { await agents.cancel(session.id); refreshState(); }); }} onSessionChanged={refreshState} />}
        {!isWorker && !readOnlyReason && session.control === 'observed' && (controlHub || session.observation?.sourceId !== 'codex') &&
          <PromptSuggestions t={t} agents={agents} session={session} copyOnly />}

      </footer>
      </div>
      {hasTools && <aside id={`${ids}-tools`} className="character-conversation-tools" inert={!toolsOpen || undefined} aria-hidden={!toolsOpen || undefined} aria-labelledby={`${ids}-tools-title`}
        data-conversation-drawer={!wide && toolsOpen ? 'true' : undefined}>
        <header className="character-tools-head"><h3 id={`${ids}-tools-title`}>{c.tools}</h3>
          <button ref={toolsClose} type="button" className="icon-button small" data-conversation-tools-close aria-label={c.hideTools} title={c.hideTools} onClick={closeTools}><Icon name="close" /></button>
        </header>
        <div className="character-tools-content">
        {!isWorker && !readOnlyReason && session.control === 'observed' && session.observation?.sourceId === 'codex' &&
          <ObservedCodexNativeQueue key={`source-queue:${session.id}`} t={t} agents={agents} session={session} disabled={!toolsOpen} />}
        {!isWorker && !readOnlyReason && session.control === 'observed' && session.observation?.sourceId === 'codex' &&
          <details className="observed-codex-office"><summary>{t.observedCodexPrompt.settings}</summary>
            <ObservedCodexQueueControls key={session.id} t={t} agents={agents} session={session} settingsOnly />
          </details>}
        {!isWorker && !readOnlyReason && session.control === 'observed' && session.observation?.sourceId === 'codex' &&
          <details className="observed-codex-office"><summary>{t.observedCodexPermission.title}</summary>
            <ObservedCodexPermissionControls key={session.id} t={t} agents={agents} session={session} />
          </details>}
        {!isWorker && !readOnlyReason && session.control === 'observed' && session.observation?.sourceId === 'codex' &&
          <details className="observed-codex-office"><summary>{t.observedCodex.title}</summary>
            <ObservedCodexControls key={session.id} t={t} agents={agents} session={session} />
          </details>}
        {!isWorker && !readOnlyReason && session.control === 'observed' &&
          session.observation?.sourceId === 'hermes' && <details className="observed-codex-office"><summary>{t.observedHermes.title}</summary>
            <ObservedHermesControls key={session.id} t={t} agents={agents} session={session} settingsOnly={controlHub} />
          </details>}
        {!isWorker && !readOnlyReason && session.control === 'observed' && !controlHub &&
          <details className="observed-codex-office"><summary>{t.observedReply.title}</summary>
            <ObservedReplyControls key={session.id} t={t} agents={agents} session={session} />
          </details>}
        {workspace && !readOnly && <WorkspaceRuntimeNotice t={t} state={state} workspace={workspace} session={session} />}
        </div>
      </aside>}
    </section>
  );
}
