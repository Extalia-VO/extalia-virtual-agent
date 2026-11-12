import type { AgentHostApi } from '@extalia/platform';
import type { ExtaliaEvent } from '@extalia/protocol';
import { errorMessage } from '../host/remote';
import { mergeEvents } from './transcript';

export interface SessionEventFeedState { events: ExtaliaEvent[]; error: string | null; loading: boolean }

/** Session updates can enrich existing hook IDs or remove private fields; reload them authoritatively. */
export function sessionEventFeed(agents: Pick<AgentHostApi, 'sessionEvents' | 'subscribe'>, sessionId: string,
  changed: (state: SessionEventFeedState) => void): () => void {
  let active = true, reading = false, repeat = false, loaded = false, generation = 0;
  let current: ExtaliaEvent[] = [], duringRead: ExtaliaEvent[] = [];
  const read = async () => {
    if (!active) return;
    if (reading) { repeat = true; return; }
    reading = true;
    const requestedGeneration = generation;
    try {
      const events = await agents.sessionEvents(sessionId);
      if (!active || requestedGeneration !== generation) return;
      // Replace previous history rather than retaining obsolete same-ID bodies or redacted media.
      current = mergeEvents(events, duringRead);
      loaded = true;
      changed({ events: current, error: null, loading: false });
    } catch (error) {
      if (!active || requestedGeneration !== generation) return;
      // A hint may represent a privacy change. Never retain obsolete private history
      // after an authoritative refresh fails; only post-hint stream events remain.
      current = mergeEvents([], duringRead); loaded = true;
      changed({ events: current, error: errorMessage(error), loading: false });
    } finally {
      reading = false;
      if (requestedGeneration === generation) duringRead = [];
      if (repeat && active) { repeat = false; void read(); }
    }
  };
  const unsubscribe = agents.subscribe(event => {
    if (!active || event.sessionId !== sessionId) return;
    if (event.body.type === 'session.updated') {
      generation++; duringRead = [];
      void read(); return;
    }
    if (reading || !loaded) duringRead.push(event);
    if (loaded) {
      current = mergeEvents(current, [event]);
      changed({ events: current, error: null, loading: false });
    }
  });
  void read();
  return () => { active = false; duringRead = []; unsubscribe(); };
}
