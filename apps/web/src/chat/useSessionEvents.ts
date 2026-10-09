import type { AgentHostApi } from '@extalia/platform';
import type { ExtaliaEvent } from '@extalia/protocol';
import { useEffect, useState } from 'react';
import { errorMessage } from '../host/remote';
import { mergeEvents } from './transcript';

interface Loaded { sessionId: string; events: ExtaliaEvent[]; error: string | null; loading: boolean }

/** History from the host merged with live events; the subscription starts first so nothing falls in between. */
export function useSessionEvents(agents: AgentHostApi, sessionId: string | undefined): Omit<Loaded, 'sessionId'> {
  const [loaded, setLoaded] = useState<Loaded>({ sessionId: '', events: [], error: null, loading: false });

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    let history: ExtaliaEvent[] | null = null;
    let early: ExtaliaEvent[] = [];
    const unsubscribe = agents.subscribe(event => {
      if (!active || event.sessionId !== sessionId) return;
      if (history === null) { early.push(event); return; }
      setLoaded(current => current.sessionId === sessionId ? { ...current, events: mergeEvents(current.events, [event]) } : current);
    });
    agents.sessionEvents(sessionId).then(
      events => {
        if (!active) return;
        history = mergeEvents(events, early);
        early = [];
        setLoaded({ sessionId, events: history, error: null, loading: false });
      },
      error => {
        if (!active) return;
        history = early;
        setLoaded({ sessionId, events: early, error: errorMessage(error), loading: false });
      },
    );
    return () => { active = false; unsubscribe(); };
  }, [agents, sessionId]);

  if (!sessionId) return { events: [], error: null, loading: false };
  // Until the new session's history arrives, show nothing from the previous one.
  if (loaded.sessionId !== sessionId) return { events: [], error: null, loading: true };
  return { events: loaded.events, error: loaded.error, loading: loaded.loading };
}
