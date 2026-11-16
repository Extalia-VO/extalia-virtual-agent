import type { AgentHostApi } from '@extalia/platform';
import type { ExtaliaEvent } from '@extalia/protocol';
import { useEffect, useState } from 'react';
import { sessionEventFeed } from './sessionEventFeed';

interface Loaded { sessionId: string; events: ExtaliaEvent[]; error: string | null; loading: boolean }

/** History from the host merged with live events; the subscription starts first so nothing falls in between. */
export function useSessionEvents(agents: AgentHostApi, sessionId: string | undefined): Omit<Loaded, 'sessionId'> {
  const [loaded, setLoaded] = useState<Loaded>({ sessionId: '', events: [], error: null, loading: false });

  useEffect(() => {
    if (!sessionId) return;
    return sessionEventFeed(agents, sessionId, value => setLoaded({ sessionId, ...value }));
  }, [agents, sessionId]);

  if (!sessionId) return { events: [], error: null, loading: false };
  // Until the new session's history arrives, show nothing from the previous one.
  if (loaded.sessionId !== sessionId) return { events: [], error: null, loading: true };
  return { events: loaded.events, error: loaded.error, loading: loaded.loading };
}
