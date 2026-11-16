import type { AgentHostApi, HostState, SessionSummary } from '@extalia/platform';
import { useState } from 'react';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { SessionMoveDialog } from './SessionMoveDialog';
import './sessionWorkspaceReview.css';

/** The host owns access comparison; the client only offers an explicit reviewed recovery. */
export function SessionWorkspaceReview({ t, agents, state, session, required = session?.workspaceReviewRequired, onReviewed }: {
  t: Messages;
  agents: AgentHostApi;
  state: HostState;
  session?: SessionSummary;
  /** A rejected send can require review even before the host summary catches up. */
  required?: boolean;
  onReviewed(state: HostState): void;
}) {
  const [openFor, setOpenFor] = useState<string>();
  if (!session || session.control !== 'managed' || session.runtime || !required) return null;
  const supported = Boolean(agents.previewSessionMove && agents.moveSession && state.workspaces.some(workspace => workspace.id === session.workspaceId));
  return <>
    <section className="session-workspace-review" role="alert" aria-label={t.chat.move.reviewCurrent}>
      <Icon name="folder" />
      <div>
        <p>{t.chat.move.changedFolders}</p>
        {supported ? <button type="button" className="button small" disabled={session.running} onClick={() => setOpenFor(session.id)}>
          {t.chat.move.reviewCurrent}
        </button> : <p className="muted small">{t.chat.move.reviewUnavailable}</p>}
        {supported && session.running && <p className="muted small">{t.chat.move.reviewWait}</p>}
      </div>
    </section>
    {supported && openFor === session.id && <SessionMoveDialog key={session.id} t={t} agents={agents} session={session}
      workspaces={state.workspaces} currentWorkspaceOnly onClose={() => setOpenFor(undefined)} onMoved={next => {
        setOpenFor(undefined);
        onReviewed(next);
      }} />}
  </>;
}
