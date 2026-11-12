import type { AgentHostApi, HostState, SessionSummary } from '@extalia/platform';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../host/remote';

/** Compatibility with hosts that reject changed access before publishing an updated summary. */
export function isWorkspaceReviewFailure(failure: unknown): boolean {
  const message = errorMessage(failure);
  return message.startsWith('Workspace folders or access boundaries changed.')
    || message.startsWith('An isolated workspace needs a fresh session without imported conversation context,');
}

/** Refresh diagnostics only: never retry a rejected prompt or approve changed access. */
export function useWorkspaceReviewRecovery({ agents, session, onState }: {
  agents: AgentHostApi;
  session?: SessionSummary;
  onState(state: HostState): void;
}) {
  const native = session?.control === 'managed' && !session.runtime;
  const scope = useMemo(() => ({ agents, id: session?.id, workspaceId: session?.workspaceId, native }),
    [agents, session?.id, session?.workspaceId, native]);
  const committed = useRef<typeof scope | undefined>(scope);
  const revision = useRef(0);
  const [rejected, setRejected] = useState<typeof scope>();
  useLayoutEffect(() => {
    const requests = revision;
    committed.current = scope;
    return () => { committed.current = undefined; requests.current++; };
  }, [scope]);
  return {
    required: native && (session?.workspaceReviewRequired === true || rejected === scope),
    async recover(failure: unknown): Promise<void> {
      if (!native || !scope.id || !isWorkspaceReviewFailure(failure) || committed.current !== scope) return;
      const request = ++revision.current;
      setRejected(scope);
      try {
        const next = await agents.getState();
        if (committed.current === scope && request === revision.current) onState(next);
      } catch { /* Keep the explicit review action and the original send error available. */ }
    },
    clear() {
      if (committed.current !== scope) return;
      revision.current++;
      setRejected(undefined);
    },
  };
}
