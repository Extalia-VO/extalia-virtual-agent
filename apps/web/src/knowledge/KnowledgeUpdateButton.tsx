import type { AgentHostApi } from '@extalia/platform';
import { useEffect, useRef, useState } from 'react';
import type { Messages } from '../i18n';
import { errorMessage } from '../host/remote';
import { Icon } from '../ui/Icon';
import { LEARNING_SCHEDULE_REFRESH_EVENT } from './LearningCountdown';

/** The host owns source reads, grounded note publication and the ten-second admission timer. */
export function KnowledgeUpdateButton({ t, agents, workspaceId, disabled = false }: {
  t: Messages; agents: AgentHostApi; workspaceId?: string | undefined; disabled?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const current = useRef(true);
  useEffect(() => { current.current = true; return () => { current.current = false; }; }, []);
  if (!agents.requestKnowledgeUpdate || !workspaceId) return null;
  const request = async () => {
    if (disabled || inFlight.current) return;
    inFlight.current = true;
    setPending(true); setError(undefined);
    try {
      await agents.requestKnowledgeUpdate!(workspaceId);
      window.dispatchEvent(new Event(LEARNING_SCHEDULE_REFRESH_EVENT));
    } catch (failure) {
      if (current.current) setError(errorMessage(failure));
    } finally {
      inFlight.current = false;
      if (current.current) setPending(false);
    }
  };
  return <div className="knowledge-update-team">
    <button type="button" className="button small" disabled={disabled || pending} title={t.knowledge.updateTeamHint}
      onClick={() => { void request(); }}><Icon name="bulb" />{pending ? t.knowledge.updateTeamPending : t.knowledge.updateTeam}</button>
    {error && <p className="form-error small" role="alert">{error}</p>}
  </div>;
}
