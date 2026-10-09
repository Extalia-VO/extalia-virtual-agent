import type { AgentHostApi, ApprovalDecisionInput, HostState } from '@extalia/platform';
import { useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { Composer } from './Composer';
import { resolveChat, type ChatSelection } from './selection';
import { SessionList } from './SessionList';
import { projectActivity, projectTranscript } from './transcript';
import { TranscriptView } from './TranscriptView';
import { useSessionEvents } from './useSessionEvents';

export function ChatPage({ t, language, agents, state, onState, selection, onSelect, onOpenSettings }: {
  t: Messages;
  language: string;
  agents: AgentHostApi;
  state: HostState;
  onState: (next: HostState) => void;
  selection: ChatSelection;
  onSelect: (next: ChatSelection) => void;
  onOpenSettings: () => void;
}) {
  const { workspace, sessions, session } = useMemo(() => resolveChat(state, selection), [state, selection]);
  const { events, error: loadError, loading } = useSessionEvents(agents, session?.id);
  const items = useMemo(() => projectTranscript(events), [events]);
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

  const send = (text: string) => guard(async () => {
    let id = session?.id;
    if (!id) {
      const created = await agents.createSession(workspace.id);
      onState(await agents.getState());
      onSelect({ workspaceId: workspace.id, sessionId: created.id });
      id = created.id;
    }
    await agents.sendPrompt(id, text);
  });

  const decide = async (approvalId: string, decision: ApprovalDecisionInput) => {
    if (session) await guard(() => agents.resolveApproval(session.id, approvalId, decision));
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
        <span className="chat-workspace" title={workspace.projectLocation}><Icon name="folder" />{workspace.name}</span>
      </div>

      <aside className="chat-side" id="chat-sessions" aria-label={t.chat.sessions}>
        <div className="field">
          <label htmlFor="chat-workspace">{t.chat.workspace}</label>
          <select id="chat-workspace" value={workspace.id} onChange={event => onSelect({ workspaceId: event.target.value })}>
            {state.workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
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

        {loadError && <p className="form-error" role="alert"><Icon name="alert" />{t.chat.loadFailed} {loadError}</p>}
        {!loading && items.length === 0 ? (
          <div className="chat-empty">
            <Icon name="chat" className="empty-icon" />
            <h2>{t.chat.emptyTitle}</h2>
            <p className="muted">{t.chat.emptyLead(workspace.name)}</p>
          </div>
        ) : (
          <TranscriptView t={t} items={items} language={language} onDecide={decide} />
        )}

        <div className="chat-footer">
          <p className={`chat-status ${running ? 'busy' : ''} ${waiting ? 'waiting' : ''}`} role="status" aria-live="polite">
            {running && !waiting && <span className="pulse" aria-hidden="true" />}
            {waiting && <Icon name="shield" />}
            {statusText}
          </p>
          {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
          <Composer t={t} running={running} waiting={waiting} readOnly={readOnly} stopping={activity.stopping}
            onSend={send} onStop={() => { if (session) void guard(() => agents.cancel(session.id)); }} />
        </div>
      </section>
    </div>
  );
}
