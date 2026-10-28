import { isKnowledgeIndexEvent, type AgentHostApi, type HostState } from '@extalia/platform';
import type { EventType } from '@extalia/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './remote';
import { createHostStateMonitor } from './hostStateMonitor';

/** Events that change session flags (running, pending approval, title) in HostState. */
const REFRESH_ON = new Set<EventType>([
  'session.started', 'session.updated', 'session.ended', 'prompt.submitted', 'turn.completed', 'turn.failed', 'approval.requested', 'approval.resolved', 'user.intervention',
]);

export interface HostController {
  state: HostState | null;
  error: string | null;
  retry(): void;
  /** Use the state a host call returned. */
  apply(next: HostState): void;
}

export function useHostState(agents: AgentHostApi | undefined): HostController {
  const [state, setState] = useState<HostState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const monitor = useRef<ReturnType<typeof createHostStateMonitor> | undefined>(undefined);

  useEffect(() => {
    if (!agents) return;
    const current = createHostStateMonitor({
      getState: () => agents.getState(),
      onState: next => {
        // Heartbeats should not reconcile the Office when its snapshot is unchanged.
        setState(current => current && JSON.stringify(current) === JSON.stringify(next) ? current : next);
        setError(null);
      },
      onError: failure => setError(errorMessage(failure)),
    });
    monitor.current = current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = agents.subscribe(event => {
      // Knowledge index hints are not session changes (the Knowledge page reloads itself).
      if (!REFRESH_ON.has(event.body.type) || isKnowledgeIndexEvent(event)) return;
      clearTimeout(timer);
      timer = setTimeout(() => current.refresh(), 120);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
      current.dispose();
      if (monitor.current === current) monitor.current = undefined;
    };
  }, [agents]);

  const apply = useCallback((next: HostState) => monitor.current?.apply(next), []);
  const retry = useCallback(() => monitor.current?.refresh(), []);
  return { state, error, retry, apply };
}
