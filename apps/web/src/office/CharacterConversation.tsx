import type { AgentHostApi, ApprovalDecisionInput, HostState, SessionSummary } from '@extalia/platform';
import { useMemo, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Composer } from '../chat/Composer';
import { projectActivity } from '../chat/transcript';
import { characterTranscript } from './characterHistory';
import { TranscriptView } from '../chat/TranscriptView';
import { useSessionEvents } from '../chat/useSessionEvents';
import type { OfficeAgent } from './presence';
import { Icon } from '../ui/Icon';

/** Conversation controls for a character's native Extalia session. Workers remain observational. */
export function CharacterConversation({ t, language, agents, state, session, agent, onState }: {
  t: Messages;
  language: string;
  agents: AgentHostApi;
  state: HostState;
  session: SessionSummary;
  agent: OfficeAgent;
  onState: (next: HostState) => void;
}) {
  const { events, error: loadError, loading } = useSessionEvents(agents, session.id);
  const isWorker = agent.agentId !== 'primary';
  const readOnly = session.control === 'observed' || isWorker;
  const items = useMemo(() => characterTranscript(events, agent), [events, agent]);
  const activity = useMemo(() => projectActivity(events), [events]);
  const [error, setError] = useState<string | null>(null);
  const workspace = state.workspaces.find(item => item.id === session.workspaceId);
  const running = isWorker ? agent.running : session.control === 'observed' ? false : loading ? session.running : activity.running;
  const waiting = !readOnly && Boolean(activity.pendingApprovalId ?? (loading ? session.pendingApprovalId : undefined));
  const status = session.control === 'observed'
    ? agent.status === 'paused' ? t.observer.paused : agent.status === 'unavailable' ? t.observer.unavailable : t.office.observing
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
  const send = (text: string) => readOnly ? Promise.resolve(false) : guard(async () => {
    await agents.sendPrompt(session.id, text);
    refreshState();
  });
  const decide = async (approvalId: string, decision: ApprovalDecisionInput) => {
    if (readOnly) return;
    if (await guard(() => agents.resolveApproval(session.id, approvalId, decision))) refreshState();
  };

  return (
    <section className="chat-main character-conversation" aria-label={agent.displayName}>
      <header className="chat-head">
        <h2 className="chat-title">{agent.displayName}</h2>
        <span className="chat-workspace"><Icon name="folder" />{workspace?.name ?? session.title}</span>
      </header>
      {isWorker && <p className="muted-note">{t.office.workerNote}</p>}
      {session.control === 'observed' && <p className="muted-note">{t.office.observedNote}</p>}
      {loadError && <p className="form-error" role="alert"><Icon name="alert" />{t.chat.loadFailed} {loadError}</p>}
      {!loading && items.length === 0
        ? <div className="chat-empty"><Icon name="chat" className="empty-icon" /><h3>{t.chat.emptyTitle}</h3><p className="muted">{workspace ? t.chat.emptyLead(workspace.name) : t.chat.noWorkspace}</p></div>
        : <TranscriptView t={t} items={items} language={language} onDecide={decide} />}
      <footer className="chat-footer">
        <p className={`chat-status ${running ? 'busy' : ''} ${waiting ? 'waiting' : ''}`} role="status" aria-live="polite">
          {running && !waiting && <span className="pulse" aria-hidden="true" />}{waiting && <Icon name="shield" />}{status}
        </p>
        {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
        {!readOnly && <Composer t={t} running={running} waiting={waiting} readOnly={false} stopping={activity.stopping}
          onSend={send} onStop={() => { void guard(async () => { await agents.cancel(session.id); refreshState(); }); }} />}
      </footer>
    </section>
  );
}
