import type { AgentHostApi } from '@extalia/platform';
import type { ExtaliaEvent } from '@extalia/protocol';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { mergeEvents } from '../chat/transcript';
import { errorMessage } from '../host/remote';
import { OFFICE_EVENT_TYPES } from './activityFeed';

// Presence, toasts and bubbles share one event selection.
const RELEVANT = OFFICE_EVENT_TYPES;
/** One shared value while history loads, so consumers' memos stay stable between renders. */
const NOT_LOADED: { events: ExtaliaEvent[]; error?: string } = { events: [], error: undefined };
/** Announcements name agents, their parents and models; v0.0.38 keeps them past the activity window so busy subagents stay nested. */
const IDENTITY: ReadonlySet<string> = new Set(['agent.created', 'subagent.spawned', 'task.created']);
const ACTIVITY: ReadonlySet<string> = new Set(['agent.state', 'subagent.state', 'tool.started', 'tool.completed', 'prompt.submitted', 'model.completed', 'turn.completed', 'turn.failed']);
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
  const activeMeetings = new Map<string, { start: ExtaliaEvent; contributions: Map<string, ExtaliaEvent> }>();
  const sessionLifecycle = new Map<string, ExtaliaEvent>();
  const closedMeetings = new Map<string, { start?: ExtaliaEvent; terminal: ExtaliaEvent }>();
  const agentEvidence = new Map<string, { identity?: ExtaliaEvent; stopped?: ExtaliaEvent; activity: ExtaliaEvent[] }>();
  const meetingKey = (sessionId: string, meetingId: string) => JSON.stringify([sessionId, meetingId]);
  for (const event of relevant) {
    const body = event.body;
    if (body.type === 'meeting.started') {
      const key = meetingKey(event.sessionId, body.meetingId);
      if (!activeMeetings.has(key) && !closedMeetings.has(key)) activeMeetings.set(key, { start: event, contributions: new Map() });
    } else if (body.type === 'meeting.contribution') {
      const meeting = activeMeetings.get(meetingKey(event.sessionId, body.meetingId));
      if (meeting && event.agentId && meeting.start.body.type === 'meeting.started' && meeting.start.body.participants.includes(event.agentId)) meeting.contributions.set(`${body.round}:${event.agentId}`, event);
    } else if (body.type === 'meeting.completed') {
      const key = meetingKey(event.sessionId, body.meetingId);
      closedMeetings.set(key, { terminal: event });
      activeMeetings.delete(key);
    }
    if (body.type === 'session.started' || body.type === 'session.ended') sessionLifecycle.set(event.sessionId, event);
    if (body.type === 'session.ended' || body.type === 'turn.failed' || (body.type === 'user.intervention' && body.action === 'cancel')) {
      for (const [key, meeting] of activeMeetings) if (meeting.start.sessionId === event.sessionId) {
        closedMeetings.set(key, { start: meeting.start, terminal: event });
        activeMeetings.delete(key);
      }
    }
    const agentId = body.type === 'subagent.state' || body.type === 'subagent.spawned' ? body.subagentId : event.agentId ?? 'primary';
    const evidenceKey = JSON.stringify([event.sessionId, agentId]);
    const evidence = agentEvidence.get(evidenceKey) ?? { activity: [] };
    if (body.type === 'agent.created' || body.type === 'subagent.spawned') evidence.identity = event;
    if (body.type === 'agent.state' || body.type === 'subagent.state') {
      if (body.state !== 'offline') evidence.stopped = undefined;
    }
    // Keep the first stop timestamp until an explicit state starts another run.
    if (body.type === 'agent.stopped' && !evidence.stopped) evidence.stopped = event;
    if (event.source.channel !== 'import') {
      if (ACTIVITY.has(body.type)) {
        const prior = evidence.activity.at(-1);
        evidence.activity = body.type === 'tool.started' && prior?.body.type === 'agent.state'
          && prior.at === event.at && prior.body.activity === body.kind ? [prior, event] : [event];
      } else if (body.type === 'subagent.spawned' && !evidence.activity.length) evidence.activity = [event];
    }
    agentEvidence.delete(evidenceKey);
    agentEvidence.set(evidenceKey, evidence);
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
      const owner = pending.get(body.approvalId)?.agentId ?? agentId;
      latestState.delete(owner);
      const resolved = agentEvidence.get(JSON.stringify([event.sessionId, owner]));
      // Resolution retires the owner's phase-only wait as well as its request.
      // Other activity remains source evidence; never manufacture a new state.
      if (resolved) resolved.activity = resolved.activity.filter(value => !((value.body.type === 'agent.state' || value.body.type === 'subagent.state') && value.body.state === 'waiting'));
      pending.delete(body.approvalId);
    } else if (body.type === 'session.ended') { pending.clear(); latestState.clear(); }
  }
  // Keep the causal membership records for every active meeting even when unrelated
  // agents exceed both ordinary windows. Closed starts receive no extra retention;
  // a terminal later than a recent start remains in that same recent window.
  const meetingEvents = [...activeMeetings.values()].flatMap(meeting => [meeting.start, ...meeting.contributions.values()]);
  // A duplicate start inside the recent window must keep its closing evidence,
  // including the original start when cancellation/failure closed it implicitly.
  const closingEvidence = recent.flatMap(event => {
    if (event.body.type !== 'meeting.started') return [];
    const closed = closedMeetings.get(meetingKey(event.sessionId, event.body.meetingId));
    return closed ? [closed.terminal, ...(closed.start ? [closed.start] : [])] : [];
  });
  const meetingParticipants = new Map<string, number>();
  for (const start of [...activeMeetings.values()].map(meeting => meeting.start).concat(closingEvidence)) if (start.body.type === 'meeting.started') {
    for (const id of start.body.participants) meetingParticipants.set(JSON.stringify([start.sessionId, id]), relevant.indexOf(start));
  }
  const participantIdentity = new Map<string, ExtaliaEvent>();
  relevant.forEach((event, index) => {
    const body = event.body;
    const id = body.type === 'subagent.spawned' ? body.subagentId
      : body.type === 'agent.created' || body.type === 'agent.state' ? event.agentId ?? 'primary'
      : body.type === 'subagent.state' ? body.subagentId : undefined;
    if (id === undefined) return;
    const key = JSON.stringify([event.sessionId, id]), before = meetingParticipants.get(key);
    if (before === undefined || index >= before) return;
    const current = participantIdentity.get(key);
    if (!current || body.type === 'agent.created' || body.type === 'subagent.spawned'
      || current.body.type === 'agent.state' || current.body.type === 'subagent.state') participantIdentity.set(key, event);
  });
  // One quiet agent's last report and terminal evidence must outlive a busy
  // sibling's window. Preserve source timestamps; retention never refreshes work.
  const evidenceKey = (event: ExtaliaEvent) => JSON.stringify([event.sessionId,
    event.body.type === 'subagent.spawned' || event.body.type === 'subagent.state' ? event.body.subagentId : event.agentId ?? 'primary']);
  const roster = new Set([...identities, ...recent, ...meetingEvents, ...participantIdentity.values()].map(evidenceKey));
  for (const key of [...agentEvidence.keys()].slice(-200)) roster.add(key);
  const liveness = [...roster].flatMap(key => {
    const evidence = agentEvidence.get(key);
    return evidence ? [evidence.identity, evidence.stopped, ...evidence.activity].filter((event): event is ExtaliaEvent => event !== undefined) : [];
  });
  const retained = new Set([...identities, ...pending.values(), ...latestState.values(), ...meetingEvents, ...liveness,
    ...participantIdentity.values(), ...closingEvidence, ...sessionLifecycle.values(), ...recent]);
  return relevant.filter(event => retained.has(event));
};

type OfficeHistory = { events: ExtaliaEvent[]; error?: string };
type OfficeHistories = ReadonlyMap<string, OfficeHistory>;
type OfficeHistoryEntry = OfficeHistory & { loaded: boolean; request?: object };

/** Host-scoped cache; membership changes do not restart retained requests. */
export function createOfficeEventHydration(agents: Pick<AgentHostApi, 'subscribe' | 'sessionEvents'> | undefined) {
  const histories = new Map<string, OfficeHistoryEntry>();
  const listeners = new Set<() => void>();
  let snapshot: OfficeHistories = new Map();
  let active: object | undefined;
  const publish = () => {
    snapshot = new Map([...histories].map(([id, history]) => [id, { events: history.events, error: history.error }]));
    for (const listener of listeners) listener();
  };
  const hydrate = (id: string, history: OfficeHistoryEntry) => {
    if (!agents || !active || history.loaded || history.request) return;
    const run = active, request = {};
    history.request = request;
    const current = () => active === run && histories.get(id) === history && history.request === request;
    const failed = (failure: unknown) => {
      if (!current()) return;
      history.request = undefined;
      history.error = errorMessage(failure);
      publish();
    };
    try {
      void agents.sessionEvents(id).then(events => {
        if (!current()) return;
        history.events = retainOfficeEvents(mergeEvents(events.filter(event => event.sessionId === id), history.events));
        history.loaded = true;
        history.request = undefined;
        history.error = undefined;
        publish();
      }, failed);
    } catch (failure) { failed(failure); }
  };
  return {
    getSnapshot: () => snapshot,
    isLoaded: (id: string) => histories.get(id)?.loaded === true,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start: () => {
      const run = {};
      active = run;
      const stop = agents?.subscribe(event => {
        if (active !== run || !RELEVANT.has(event.body.type)) return;
        const history = histories.get(event.sessionId);
        if (!history) return;
        history.events = retainOfficeEvents(mergeEvents(history.events, [event]));
        publish();
      });
      for (const [id, history] of histories) hydrate(id, history);
      return () => {
        if (active !== run) return;
        active = undefined;
        stop?.();
        for (const history of histories.values()) history.request = undefined;
      };
    },
    setSessionIds: (ids: readonly string[]) => {
      const selected = new Set(ids);
      for (const id of histories.keys()) if (!selected.has(id)) histories.delete(id);
      for (const id of selected) if (!histories.has(id)) histories.set(id, { events: [], loaded: false });
      publish();
      for (const [id, history] of histories) hydrate(id, history);
    },
  };
}

/** Also projects the new selection before effects run, so removed sessions never flash. */
export function selectOfficeEvents(histories: OfficeHistories, ids: readonly string[]): OfficeHistory {
  const selected = ids.map(id => histories.get(id));
  const events = selected.flatMap(history => history?.events ?? []);
  const error = selected.find(history => history?.error)?.error;
  return events.length || error ? { events, error } : NOT_LOADED;
}

/** Subscribe before hydration; callers also retain current Native standby teams for truthful idle state. */
export function useOfficeEvents(agents: AgentHostApi | undefined, sessionIds: readonly string[]) {
  const key = JSON.stringify([...new Set(sessionIds)].sort());
  const hydration = useMemo(() => createOfficeEventHydration(agents), [agents]);
  const histories = useSyncExternalStore(hydration.subscribe, hydration.getSnapshot, hydration.getSnapshot);
  useEffect(() => hydration.start(), [hydration]);
  useEffect(() => hydration.setSessionIds(JSON.parse(key)), [hydration, key]);
  return useMemo(() => {
    const ids: string[] = JSON.parse(key);
    return { ...selectOfficeEvents(histories, ids), loadedSessionIds: new Set(ids.filter(hydration.isLoaded)) };
  }, [hydration, histories, key]);
}
