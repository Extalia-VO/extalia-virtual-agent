import type { AgentHostApi } from '@extalia/platform';
import type { ExtaliaEvent } from '@extalia/protocol';
import { useEffect, useState } from 'react';
import { mergeEvents } from '../chat/transcript';
import { errorMessage } from '../host/remote';

const RELEVANT = new Set(['agent.created', 'agent.state', 'agent.stopped', 'subagent.spawned', 'subagent.state', 'session.ended', 'prompt.submitted', 'turn.completed', 'turn.failed', 'approval.requested', 'approval.resolved', 'user.intervention']);
const retain = (events: readonly ExtaliaEvent[]) => events.filter(event => RELEVANT.has(event.body.type)).slice(-400);

/** Subscribe before hydration; only active or selected sessions need event history. */
export function useOfficeEvents(agents: AgentHostApi | undefined, sessionIds: readonly string[]) {
  const key = JSON.stringify([...sessionIds].sort());
  const [loaded, setLoaded] = useState<{ key: string; events: ExtaliaEvent[]; error?: string }>({ key: '', events: [] });
  useEffect(() => {
    if (!agents) return;
    const ids = new Set<string>(JSON.parse(key));
    let active = true;
    const histories = new Map<string, ExtaliaEvent[]>();
    const errors = new Map<string, string>();
    const update = () => { if (active) setLoaded({ key, events: [...histories.values()].flat(), error: errors.values().next().value }); };
    const stop = agents.subscribe(event => {
      if (!active || !ids.has(event.sessionId) || !RELEVANT.has(event.body.type)) return;
      histories.set(event.sessionId, retain(mergeEvents(histories.get(event.sessionId) ?? [], [event])));
      update();
    });
    for (const id of ids) agents.sessionEvents(id).then(events => {
      if (!active) return;
      histories.set(id, retain(mergeEvents(events, histories.get(id) ?? [])));
      update();
    }, failure => { errors.set(id, errorMessage(failure)); update(); });
    return () => { active = false; stop(); };
  }, [agents, key]);
  return loaded.key === key ? loaded : { events: [], error: undefined };
}
