import { sourceLabel } from '@extalia/core';
import type { AgentHostApi, ApprovalDecisionInput, FileSystemCapability, HostState } from '@extalia/platform';
import { useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { Composer, type ComposerSend } from './Composer';
import { attachmentPreviewLoader, sendPromptWithAttachments, uploadAttachments } from './attachments';
import { resolveChat, type ChatSelection } from './selection';
import { SessionList } from './SessionList';
import { projectActivity, projectTranscript } from './transcript';
import { TranscriptView } from './TranscriptView';
import { ConversationTabs } from './ChangedFilesView';
import { projectChangedFiles } from './changedFiles';
import { MessageFileProvider } from './MessageFilePreview';
import { useSessionEvents } from './useSessionEvents';
import { Select } from '../ui/Select';
import { ProjectSkillsNotice } from '../skills/ProjectSkills';
import { WorkspacesSection } from '../pages/settings/WorkspacesSection';
import { createComposerSession } from './sessionHandoff';

export function ChatPage({ t, language, agents, picker, state, onState, selection, onSelect, onOpenSettings, onReviewSkills }: {
  t: Messages;
  language: string;
  agents: AgentHostApi;
  picker?: FileSystemCapability;
  state: HostState;
  onState: (next: HostState) => void;
  selection: ChatSelection;
  onSelect: (next: ChatSelection) => void;
  onOpenSettings: () => void;
  /** Opens the Skills page; the notice has already asked it to focus the workspace. */
  onReviewSkills: (workspaceId: string) => void;
}) {
  const { workspace, sessions, session } = useMemo(() => resolveChat(state, selection), [state, selection]);
  const { events, error: loadError, loading } = useSessionEvents(agents, session?.id);
  const sessionId = session?.id;
  const previewAttachment = useMemo(() => sessionId ? attachmentPreviewLoader(agents, sessionId) : undefined, [agents, sessionId]);
  const items = useMemo(() => projectTranscript(events), [events]);
  const changedFiles = useMemo(() => projectChangedFiles(events, session?.observation?.projectPath ?? workspace?.projectLocation), [events, session, workspace]);
  const activity = useMemo(() => projectActivity(events), [events]);
  const [error, setError] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const stick = useRef(true);

  useEffect(() => {
    const onScroll = () => {
      const element = document.scrollingElement ?? document.documentElement;
      stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 160;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => { stick.current = true; }, [session?.id]);
  useEffect(() => {
    // Follow new output only while the reader is at the bottom.
    if (stick.current) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [items]);

  if (!workspace) {
    return (
      <div className="page">
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
  const focusComposer = () => requestAnimationFrame(() => document.getElementById('composer-input')?.focus());

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
  const send = ({ text, choice, attachments, patch, learnSkill, bindSession }: ComposerSend) => guard(async () => {
    let id = session?.id;
    if (!id) {
      id = await createComposerSession({ agents, workspaceId: workspace.id, choice, bindSession, onState, onSelect, interrupted: t.chat.turnInterrupted });
    }
    const ids = await uploadAttachments(agents, id, attachments, patch);
    await sendPromptWithAttachments(agents, id, text, ids, learnSkill);
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
    <div className={`chat ${listOpen ? 'list-open' : ''}`}>
      <div className="chat-head">
        <button type="button" className="button small sessions-toggle" aria-expanded={listOpen} aria-controls="chat-sessions" onClick={() => setListOpen(!listOpen)}>
          <Icon name={listOpen ? 'close' : 'menu'} />{listOpen ? t.chat.hideSessions : t.chat.showSessions}
        </button>
        <h1 id="chat-title" className="chat-title">{session ? session.title || t.chat.untitled : t.chat.newSession}</h1>
        {session?.continuedFrom && <span className="badge">{t.handoff.badge(sourceLabel(session.continuedFrom.sourceId))}</span>}
        {session?.transient && <span className="badge warn" title={t.handoff.notSavedHint}>{t.handoff.notSaved}</span>}
        <span className="chat-workspace" title={workspace.projectLocation}><Icon name="folder" />{workspace.name}</span>
      </div>

      <aside className="chat-side" id="chat-sessions" aria-label={t.chat.sessions}>
        <div className="field">
          <Select
            label={t.chat.workspace}
            value={workspace.id}
            options={state.workspaces.map(item => ({
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
        <SessionList t={t} sessions={sessions} activeId={session?.id} language={language}
          onSelect={id => { onSelect({ workspaceId: workspace.id, sessionId: id }); setListOpen(false); }} onRename={rename} onDelete={remove} />
      </aside>

      <section className="chat-main" aria-labelledby="chat-title">
        <ProjectSkillsNotice t={t} agents={agents} workspace={workspace} onReview={onReviewSkills} />
        {loadError && <p className="form-error" role="alert"><Icon name="alert" />{t.chat.loadFailed} {loadError}</p>}
        {!loading && items.length === 0 ? (
          <div className="chat-empty">
            <Icon name="chat" className="empty-icon" />
            <h2>{t.chat.emptyTitle}</h2>
            <p className="muted">{t.chat.emptyLead(workspace.name)}</p>
          </div>
        ) : (
          <MessageFileProvider key={session?.id ?? 'new'} t={t} agents={agents} workspaces={state.workspaces} workspaceId={workspace.id} projectPath={session?.observation?.projectPath ?? workspace.projectLocation}>
            <ConversationTabs t={t} language={language} files={changedFiles}>
              <TranscriptView t={t} items={items} language={language} onDecide={decide} previewAttachment={previewAttachment} approvalsEnabled={!readOnly} />
            </ConversationTabs>
          </MessageFileProvider>
        )}

        <div className="chat-footer">
          <p className={`chat-status ${running ? 'busy' : ''} ${waiting ? 'waiting' : ''}`} role="status" aria-live="polite">
            {running && !waiting && <span className="pulse" aria-hidden="true" />}
            {waiting && <Icon name="shield" />}
            {statusText}
          </p>
          {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
          <Composer t={t} agents={agents} session={session} workspaceId={workspace.id} hermes={workspace.runtimeId === 'hermes' || session?.runtime?.id === 'hermes'}
            running={running} waiting={waiting} readOnly={readOnly} stopping={activity.stopping}
            onSend={send} onStop={() => { if (session) void guard(() => agents.cancel(session.id)); }} onSessionChanged={refreshState} />
        </div>
      </section>
    </div>
  );
}
