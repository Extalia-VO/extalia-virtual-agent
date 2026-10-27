import type { CharacterAppearance } from '@extalia/core';
import type { AgentHostApi, ApprovalDecisionInput, HostState, SessionSummary } from '@extalia/platform';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Composer, type ComposerSend } from '../chat/Composer';
import { attachmentPreviewLoader, sendPromptWithAttachments, uploadAttachments } from '../chat/attachments';
import { projectActivity } from '../chat/transcript';
import { characterTranscript } from './characterHistory';
import { TranscriptView } from '../chat/TranscriptView';
import { useSessionEvents } from '../chat/useSessionEvents';
import type { OfficeAgent } from './presence';
import { Icon } from '../ui/Icon';
import { AppearanceEditor } from './AppearanceEditor';
import type { LookIdentity } from './scene/avatars/appearance';
import { ActivityTimeline } from './console/ActivityTimeline';
import { characterTimeline, shortcutFor, teamRoster } from './console/timeline';

const isTyping = (target: EventTarget | null) => target instanceof HTMLElement
  && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/** The selected character's saved look and the editor's preview/save actions. */
export interface CharacterAppearanceControls {
  saved: CharacterAppearance | undefined;
  /** v0.0.30: the name its generated (unsaved) look is seeded from. */
  identity?: LookIdentity | undefined;
  onPreview(appearance: CharacterAppearance | null): void;
  onSave(appearance: CharacterAppearance | null): Promise<void>;
}

export type ConversationTab = 'messages' | 'activity';

/**
 * Conversation controls for a character's native Extalia session, shown in the
 * session dialog (which owns identity, status header and close). Workers and
 * observed sessions stay observational. Both tabs stay mounted, so switching
 * keeps the scroll position; the composer stays mounted, so it keeps the draft.
 */
export function CharacterConversation({ t, language, agents, state, session, agent, onState, appearance, tab: controlledTab, onTab, readOnlyReason, onLocate, following = false, onToggleFollow, onSelectCharacter }: {
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
  const readOnly = session.control === 'observed' || isWorker || Boolean(readOnlyReason);
  const items = useMemo(() => characterTranscript(events, agent), [events, agent]);
  const activity = useMemo(() => projectActivity(events), [events]);
  const timeline = useMemo(() => characterTimeline(events, agent), [events, agent]);
  const team = useMemo(() => isWorker ? [] : teamRoster(events, session.id), [events, session.id, isWorker]);

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
      const action = shortcutFor(event.key, { alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey }, isTyping(event.target));
      if (!action) return;
      if ((action === 'locate' && !onLocate) || (action === 'follow' && !onToggleFollow) || (action === 'appearance' && !appearance)) return;
      event.preventDefault();
      if (action === 'message') {
        setOwnTab('messages'); tabRef.current?.('messages'); setEditing(false);
        // The composer may only be enabled after the tab switch renders, so try now and on the next two frames.
        const focus = () => document.getElementById('composer-input')?.focus();
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
  const send = ({ text, attachments, patch }: ComposerSend) => readOnly ? Promise.resolve(false) : guard(async () => {
    const ids = await uploadAttachments(agents, session.id, attachments, patch);
    await sendPromptWithAttachments(agents, session.id, text, ids);
    refreshState();
  });
  const decide = async (approvalId: string, decision: ApprovalDecisionInput) => {
    if (readOnly) return;
    if (await guard(() => agents.resolveApproval(session.id, approvalId, decision))) refreshState();
  };

  const panelId = (id: ConversationTab) => `${ids}-${id}`;
  return (
    <section className="chat-main character-conversation" aria-label={agent.displayName}>
      <div className="character-actions" title={c.shortcuts}>
        <div className="character-tabs" role="tablist" aria-label={agent.displayName}>
          {(['messages', 'activity'] as const).map(id => <button key={id} id={`${panelId(id)}-tab`} type="button" role="tab" aria-selected={tab === id && !editing} aria-controls={panelId(id)}
            onClick={() => { setTab(id); setEditing(false); }}>{id === 'messages' ? c.messages : c.activity}{id === 'activity' && team.length > 0 && <span className="badge">{team.length}</span>}</button>)}
        </div>
        {onLocate && <button type="button" className="icon-button small" aria-label={c.locate} title={`${c.locate} (L)`} onClick={onLocate}><Icon name="search" /></button>}
        {onToggleFollow && <button type="button" className={`icon-button small follow-toggle ${following ? 'active' : ''}`} aria-pressed={following} aria-label={following ? t.officeOverlay.follow.stop : t.officeOverlay.follow.start}
          title={`${following ? t.officeOverlay.follow.stop : t.officeOverlay.follow.hint} (F)`} onClick={onToggleFollow}><Icon name="crosshair" /></button>}
        {appearance && <button type="button" className="button small appearance-toggle" aria-expanded={editing} title={`${t.appearance.open} (E)`} onClick={() => setEditing(value => !value)}>
          <Icon name="edit" />{t.appearance.open}
        </button>}
      </div>
      {appearance && editing && <AppearanceEditor t={t.appearance} characterId={agent.id} identity={appearance.identity} saved={appearance.saved}
        onPreview={appearance.onPreview} onSave={appearance.onSave} onClose={() => setEditing(false)} />}
      {readOnlyReason && <p className="muted-note character-ended-note" role="status"><Icon name="alert" />{readOnlyReason}</p>}
      {!readOnlyReason && isWorker && <p className="muted-note">{t.office.workerNote}</p>}
      {!readOnlyReason && session.control === 'observed' && <p className="muted-note">{t.office.observedNote}</p>}
      {loadError && <p className="form-error" role="alert"><Icon name="alert" />{t.chat.loadFailed} {loadError}</p>}
      <div ref={scroller} id={panelId('messages')} className="character-tab-panel" role="tabpanel" aria-labelledby={`${panelId('messages')}-tab`} hidden={editing || tab !== 'messages'}
        onScroll={event => { const element = event.currentTarget; stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>
        {!loading && items.length === 0
          ? <div className="chat-empty"><Icon name="chat" className="empty-icon" /><h3>{t.chat.emptyTitle}</h3><p className="muted">{workspace ? t.chat.emptyLead(workspace.name) : t.chat.noWorkspace}</p></div>
          : <TranscriptView t={t} items={items} language={language} onDecide={decide} previewAttachment={previewAttachment} />}
      </div>
      <div id={panelId('activity')} className="character-tab-panel" role="tabpanel" aria-labelledby={`${panelId('activity')}-tab`} hidden={editing || tab !== 'activity'}>
        <ActivityTimeline t={t} language={language} entries={timeline} team={team} {...(onSelectCharacter ? { onSelectCharacter } : {})} />
      </div>
      <footer className="chat-footer">
        <p className={`chat-status ${running ? 'busy' : ''} ${waiting ? 'waiting' : ''}`} role="status" aria-live="polite">
          {running && !waiting && <span className="pulse" aria-hidden="true" />}{waiting && <Icon name="shield" />}{status}
        </p>
        {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
        {!readOnly && <Composer t={t} agents={agents} session={session} workspaceId={session.workspaceId}
          hermes={workspace?.runtimeId === 'hermes' || session.runtime?.id === 'hermes'} running={running} waiting={waiting} readOnly={false} stopping={activity.stopping}
          onSend={send} onStop={() => { void guard(async () => { await agents.cancel(session.id); refreshState(); }); }} onSessionChanged={refreshState} />}
      </footer>
    </section>
  );
}
