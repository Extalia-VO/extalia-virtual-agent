import type { AgentHostApi, HostState } from '@extalia/platform';
import type { EventType } from '@extalia/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './remote';

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
  const [attempt, setAttempt] = useState(0);
  // Responses that started before a newer state arrived are stale and ignored.
  const version = useRef(0);

  const load = useCallback((reportErrors: boolean) => {
    if (!agents) return;
    const started = ++version.current;
    agents.getState().then(
      next => { if (started === version.current) { setState(next); setError(null); } },
      failure => { if (reportErrors && started === version.current) setError(errorMessage(failure)); },
    );
  }, [agents]);

  useEffect(() => { load(true); }, [load, attempt]);

  useEffect(() => {
    if (!agents) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = agents.subscribe(event => {
      if (!REFRESH_ON.has(event.body.type)) return;
      clearTimeout(timer);
      timer = setTimeout(() => load(false), 120);
    });
    return () => { clearTimeout(timer); unsubscribe(); };
  }, [agents, load]);

  const apply = useCallback((next: HostState) => { version.current++; setState(next); }, []);
  const retry = useCallback(() => { setError(null); setAttempt(value => value + 1); }, []);
  return { state, error, retry, apply };
}
