import type { AgentHostApi } from '@extalia/platform';
import type { ExtaliaEvent } from '@extalia/protocol';
import { useEffect, useState } from 'react';
import { mergeEvents } from '../chat/transcript';
import { errorMessage } from '../host/remote';
import { OFFICE_EVENT_TYPES } from './activityFeed';

// Presence, toasts and bubbles share one event selection.
const RELEVANT = OFFICE_EVENT_TYPES;
/** One shared value while history loads, so consumers' memos stay stable between renders. */
const NOT_LOADED: { events: ExtaliaEvent[]; error?: string } = { events: [], error: undefined };
/** Announcements name agents, their parents and models; v0.0.38 keeps them past the activity window so busy subagents stay nested. */
const IDENTITY: ReadonlySet<string> = new Set(['agent.created', 'subagent.spawned', 'task.created']);
export const retainOfficeEvents = (events: readonly ExtaliaEvent[]) => {
  const relevant = events.filter(event => RELEVANT.has(event.body.type));
  const recent = relevant.slice(-400);
  if (recent.length === relevant.length) return recent;
  const kept = new Set(recent);
  const identities = relevant.filter(event => IDENTITY.has(event.body.type) && !kept.has(event)).slice(-200);
  // An unresolved request must survive a busy sibling's activity window. A matching
  // resolution (or session end) retires it; never let a replay resurrect it.
  const pending = new Map<string, ExtaliaEvent>();
  const latestState = new Map<string, ExtaliaEvent>();
  for (const event of relevant) {
    const body = event.body;
    const agentId = body.type === 'subagent.state' || body.type === 'subagent.spawned' ? body.subagentId : event.agentId ?? 'primary';
    if (body.type === 'agent.state' || body.type === 'subagent.state') {
      if (body.state === 'waiting' && (body.phase === 'input' || body.phase === 'approval')) latestState.set(agentId, event);
      else latestState.delete(agentId);
    } else if (body.type === 'tool.started') {
      const waiting = latestState.get(agentId);
      const phase = waiting?.body;
      if (!waiting || waiting.at !== event.at || phase?.type !== 'agent.state' || phase.activity !== body.kind) latestState.delete(agentId);
    } else if (['prompt.submitted', 'tool.completed', 'model.thinking', 'model.delta', 'model.completed', 'turn.completed', 'turn.failed', 'agent.stopped', 'subagent.spawned'].includes(body.type)) {
      latestState.delete(agentId);
    }
    if (body.type === 'approval.requested') pending.set(body.approvalId, event);
    else if (body.type === 'approval.resolved') {
      latestState.delete(pending.get(body.approvalId)?.agentId ?? agentId);
      pending.delete(body.approvalId);
    } else if (body.type === 'session.ended') { pending.clear(); latestState.clear(); }
  }
  const retained = new Set([...identities, ...pending.values(), ...latestState.values(), ...recent]);
  return relevant.filter(event => retained.has(event));
};

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
      histories.set(event.sessionId, retainOfficeEvents(mergeEvents(histories.get(event.sessionId) ?? [], [event])));
      update();
    });
    for (const id of ids) agents.sessionEvents(id).then(events => {
      if (!active) return;
      histories.set(id, retainOfficeEvents(mergeEvents(events, histories.get(id) ?? [])));
      update();
    }, failure => { errors.set(id, errorMessage(failure)); update(); });
    return () => { active = false; stop(); };
  }, [agents, key]);
  return loaded.key === key ? loaded : NOT_LOADED;
}
