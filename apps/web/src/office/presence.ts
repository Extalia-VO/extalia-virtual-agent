import { generateFullName, stopReasonOf } from '@extalia/core';
import type { SessionContextUsage, SessionSummary } from '@extalia/platform';
import { mcpToolName, type ActivityKind, type AgentPhase, type AgentState, type ExtaliaEvent, type StopReason } from '@extalia/protocol';
import { latestAgentModels, observedSubagentIdentity, sessionLeadModel, sessionOrigin, type AgentOrigin } from './agentOrigin';
import { foldMissionWorkers, type OfficeMissions, type OfficeMissionWork } from './missionPresence';
import { lookIdentity, type LookIdentity } from './scene/avatars/appearance';
import { lingerMs, outingMs } from './scene/movement/idleRoutine';

export type OfficeAgentStatus = AgentState | 'stopping' | 'observing' | 'paused' | 'unavailable';

/** A truthful, renderer-ready presence derived from native sessions and protocol events. */
export interface OfficeAgent {
  /** Session-scoped so native agent ids can safely repeat across sessions. */
  id: string;
  sessionId: string;
  agentId: string;
  displayName: string;
  control: SessionSummary['control'];
  status: OfficeAgentStatus;
  running: boolean;
  activity?: ActivityKind;
  /**
   * v0.0.38: the nuance the source stated (planning, waiting for approval or for the user,
   * compacting, interrupted, error, ended); labels prefer it over the bare status.
   */
  phase?: AgentPhase;
  /** v0.0.38: display name of the MCP tool in use (`server · tool`), for the "Using …" label. */
  toolName?: string;
  /**
   * v0.0.43: why its last turn stopped, when the source said so (out of tokens or quota, rate limited,
   * signed out, …); set with the `error` or `interrupted` phase.
   */
  reason?: StopReason;
  /**
   * v0.0.43 observed only: its last reported state is active (thinking, planning, compacting, a tool in
   * progress, delegating without a working child) but no event arrived for longer than that state allows
   * (`stallAfterMs`): its app may have stopped without saying so. `lastActivityAt` is when it was last heard.
   */
  stalled?: boolean;
  /**
   * v0.0.43: not in the office right now: an observed lead whose session ended or has been quiet for
   * `OBSERVED_RECENT_MS`, or a subagent that left (except managed team members, who stay under their
   * lead). Listed under the board's collapsed "Earlier" group and in search; never counted or drawn.
   */
  earlier?: boolean;
  summary?: string;
  target?: string;
  pendingApprovalId?: string;
  parentId?: string;
  observation?: { status: 'watching' | 'paused' | 'unavailable'; error?: string };
  /**
   * Observed sessions only: the newest reported activity is recent enough (see `OBSERVED_LIVE_MS`)
   * to treat the outside agent as acting right now. History replays are never live.
   */
  live?: boolean;
  /** Observed sessions only: timestamp of the newest reported activity event (v0.0.38: subagents too). */
  lastActivityAt?: string;
  /** v0.0.30: a named lead's session title, shown as its task line (`displayName` is then the agent's full name). */
  title?: string;
  /** v0.0.30: the full name (and explicit gender) its generated look is seeded from; absent → seeded from `id`. */
  look?: LookIdentity;
  /** v0.0.37: the outside app and channel (observed) or the runtime (managed) the agent comes from. */
  origin?: AgentOrigin;
  /** v0.0.37 observed only: the model the agent reported last (lead: session model; subagent: its own events or spawn model). v0.0.47: a mission worker's exact model. */
  model?: string;
  /** v0.0.48: the lead's context in use (tokens, window, compactions); absent for subagents and when no usage is known. */
  context?: SessionContextUsage;
  /**
   * v0.0.47 (ADR 0016): a native mission worker: its mission, task, connection and task state. Queued and never-started
   * workers are listed under their lead but not admitted into the 3D office (`isAdmitted`); unknown work is never idle.
   */
  mission?: OfficeMissionWork;
}

/** v0.0.47: drawn in the 3D office and seated: every presence except a mission worker that has not started (queued or never run). */
export const isAdmitted = (agent: Partial<Pick<OfficeAgent, 'mission'>>): boolean => !agent.mission || agent.mission.admitted;

/** v0.0.30: what the Office knows about a team member (`getSessionTeam`), keyed by session id. */
export interface PresenceMember { id: string; name: string; gender?: unknown }
export type PresenceTeams = ReadonlyMap<string, readonly PresenceMember[]>;

/** v0.0.30: the lead's stable full name and explicit gender, from hosts that assign them (feature-detected). */
export function sessionAgent(session: SessionSummary): { name?: string; gender?: 'female' | 'male' } {
  const meta = session as SessionSummary & { agentName?: unknown; agentGender?: unknown };
  const name = typeof meta.agentName === 'string' ? meta.agentName.trim() : '';
  const gender = meta.agentGender === 'female' || meta.agentGender === 'male' ? meta.agentGender : undefined;
  return { ...(name ? { name } : {}), ...(gender ? { gender } : {}) };
}

/** The name an agent of `session` is called everywhere: the lead's full name, else the session title. */
export function sessionAgentName(session: SessionSummary, fallback = 'Agent'): string {
  return sessionAgent(session).name ?? (session.title.trim() || fallback);
}

/** An observed session whose newest activity event is younger than this counts as live. */
export const OBSERVED_LIVE_MS = 2 * 60_000;
/** A ready observed lead without a new event for this long clears its last nuance (v0.0.44: a ready subagent leaves after `subagentLingerMs`). */
export const OBSERVED_IDLE_MS = 10 * 60_000;
/**
 * v0.0.43: an observed agent last reported at work, waiting for the user or failed, without any new event for
 * this long, is taken as gone: a subagent goes offline, a lead is shown ready.
 */
export const OBSERVED_GONE_MS = 30 * 60_000;
/** v0.0.43: silence allowed while thinking, planning or compacting before an observed agent shows "No response". */
export const STALL_THINKING_MS = 3 * 60_000;
/** v0.0.43: silence allowed while a tool call runs (no completion yet). */
export const STALL_TOOL_MS = 10 * 60_000;
/** v0.0.43: silence allowed while a command or test run is in progress (long builds and test suites). */
export const STALL_LONG_TOOL_MS = 15 * 60_000;
/** v0.0.43: an observed lead whose session had no activity for this long (and is not running) is listed under "Earlier". */
export const OBSERVED_RECENT_MS = 2 * 60 * 60_000;

/**
 * v0.0.44: how long a subagent stays in the office as Ready after its work ended (a stop, `offline` report or
 * last idle report) before it walks out: its first idle turn of the character's idle routine, seated at the desk
 * (1–5 min) then a walk-about (6–15 min). Stable per scoped presence id (7–20 min).
 */
export function subagentLingerMs(id: string): number {
  return lingerMs(id, 1) + outingMs(id, 1);
}

interface AgentRecord {
  agentId: string;
  displayName: string;
  /** Explicit gender a host reported with the subagent (feature-detected). */
  gender?: unknown;
  /** v0.0.37: what `subagent.spawned` said about it. */
  label?: string;
  role?: string;
  model?: string;
  parentId?: string;
  state?: AgentState;
  activity?: ActivityKind;
  phase?: AgentPhase;
  toolName?: string;
  summary?: string;
  target?: string;
  stopped: boolean;
  /** v0.0.44: when its work ended (stop or `offline` report), for the Ready linger of a subagent. */
  stoppedAt?: number;
}

const scopedId = (sessionId: string, agentId: string) => `${sessionId}:${agentId}`;
/** Keeps the time of the first stop of a run (repeated stop reports do not extend the linger). */
const stopTime = (record: AgentRecord, event: ExtaliaEvent) => {
  if (!record.stopped) { delete record.stoppedAt; return; }
  if (record.stoppedAt !== undefined) return;
  const at = Date.parse(event.at);
  if (Number.isFinite(at)) record.stoppedAt = at;
};

const ACTIVITY_EVENTS: ReadonlySet<string> = new Set([
  'agent.state', 'tool.started', 'tool.completed', 'turn.completed', 'turn.failed', 'prompt.submitted', 'model.completed',
  'subagent.spawned', 'subagent.state',
]);

interface ObservedActivity { at: number; state: AgentState; activity?: ActivityKind; phase?: AgentPhase; reason?: StopReason; toolName?: string; summary?: string; target?: string }

/**
 * v0.0.43: how long an observed agent may stay silent in its last reported state before it counts as not
 * responding; undefined when that state never stalls (ready, waiting for approval or for the user, blocked,
 * offline: it is the user's turn or nothing is in progress).
 */
export function stallAfterMs(activity: Pick<ObservedActivity, 'state' | 'activity' | 'phase'>): number | undefined {
  if (activity.state !== 'thinking' && activity.state !== 'working' && activity.state !== 'delegating') return undefined;
  if (activity.phase === 'approval' || activity.phase === 'input') return undefined;
  if (activity.phase === 'planning' || activity.phase === 'compacting' || !activity.activity || activity.activity === 'think') return STALL_THINKING_MS;
  return activity.activity === 'command' || activity.activity === 'test' ? STALL_LONG_TOOL_MS : STALL_TOOL_MS;
}

/** v0.0.43: how long an observed agent's last report stands without a new event (see `OBSERVED_IDLE_MS`, `OBSERVED_GONE_MS`). */
const goneAfterMs = (activity: Pick<ObservedActivity, 'state' | 'phase'>) => activity.state === 'idle' && activity.phase !== 'error' ? OBSERVED_IDLE_MS : OBSERVED_GONE_MS;
/** A stated reason, else one read from the error text (events written before reasons existed). */
const reasonOf = (stated: StopReason | undefined, text: string | undefined): StopReason | undefined => stated ?? stopReasonOf(text);

/**
 * What each agent of an outside session last reported, keyed by agent id ('primary' for the lead),
 * from structured events (`transcript`, `hook`, `dashboard`). `import` events are copied history and
 * never count. Timestamps come from the events, so replaying history cannot look live. A subagent's
 * spawn counts as its first activity (it starts thinking); `subagent.state` reports its state.
 * Events must be sorted oldest first.
 */
export function observedActivities(events: readonly ExtaliaEvent[]): Map<string, ObservedActivity> {
  const result = new Map<string, ObservedActivity>();
  for (const event of events) {
    if (event.source.channel === 'import' || !ACTIVITY_EVENTS.has(event.body.type)) continue;
    const at = Date.parse(event.at);
    if (!Number.isFinite(at)) continue;
    const body = event.body;
    const key = body.type === 'subagent.spawned' || body.type === 'subagent.state' ? body.subagentId : event.agentId ?? 'primary';
    const last = result.get(key);
    const set = (patch: Omit<ObservedActivity, 'at'>) => result.set(key, { at, ...patch });
    switch (body.type) {
      case 'agent.state': {
        const reason = body.phase === 'error' || body.phase === 'interrupted' ? reasonOf(body.reason, body.phase === 'error' ? body.summary : undefined) : undefined;
        set({ state: body.state, ...(body.activity ? { activity: body.activity } : {}), ...(body.phase ? { phase: body.phase } : {}), ...(reason ? { reason } : {}),
          ...(body.summary ? { summary: body.summary } : {}), ...(body.target ? { target: body.target } : {}) });
        break;
      }
      case 'tool.started': {
        // The state event a source sends with the call (same time, same kind) says more: waiting for an answer, planning.
        const prior = last && last.at === at && last.activity === body.kind ? last : undefined;
        const toolName = body.kind === 'tool' ? mcpToolName(body.tool) : undefined;
        set({ state: prior?.state ?? (body.kind === 'delegate' ? 'delegating' : 'working'), activity: body.kind, summary: body.label,
          ...(prior?.phase ? { phase: prior.phase } : {}), ...(toolName ? { toolName } : {}), ...(body.target ? { target: body.target } : {}) });
        break;
      }
      case 'prompt.submitted': case 'tool.completed': case 'model.completed': set({ state: 'thinking' }); break;
      case 'turn.completed': set({ state: 'idle' }); break;
      case 'turn.failed': {
        const reason = reasonOf(body.reason, body.error);
        set({ state: 'idle', phase: reason === 'interrupted' || /interrupt/i.test(body.error) ? 'interrupted' : 'error', ...(reason ? { reason } : {}) });
        break;
      }
      case 'subagent.spawned': if (!last) set({ state: 'thinking' }); break;
      case 'subagent.state': {
        const reason = body.phase === 'error' || body.phase === 'interrupted' ? reasonOf(body.reason, body.phase === 'error' ? body.summary : undefined) : undefined;
        set({ state: body.state, ...(body.phase ? { phase: body.phase } : {}), ...(reason ? { reason } : {}), ...(body.summary ? { summary: body.summary } : {}) });
        break;
      }
      default: break;
    }
  }
  return result;
}

const AT_WORK: ReadonlySet<OfficeAgentStatus> = new Set(['working', 'thinking', 'delegating']);

/**
 * Projects real host sessions into office presences. Managed running state comes
 * from the host summary. Observed sessions are read-only: they are only shown at
 * work when their own structured events (not wall-clock arrival) are recent, and
 * fall back to idle after `OBSERVED_IDLE_MS` without a new event.
 */
export function projectOfficePresence(
  sessions: readonly SessionSummary[],
  events: readonly ExtaliaEvent[],
  now: number = Date.now(),
  teams: PresenceTeams = new Map(),
  missions: OfficeMissions = new Map(),
): OfficeAgent[] {
  const bySession = new Map<string, ExtaliaEvent[]>();
  for (const event of events) {
    const list = bySession.get(event.sessionId) ?? [];
    list.push(event);
    bySession.set(event.sessionId, list);
  }

  return sessions.flatMap(session => {
    const agents = new Map<string, AgentRecord>();
    const lead = sessionAgent(session);
    const title = session.title.trim();
    const primary: AgentRecord = { agentId: 'primary', displayName: lead.name ?? (title || 'Agent'), stopped: false };
    agents.set(primary.agentId, primary);
    let ended = false;
    let stopping = false;
    // v0.0.38: how the last managed turn ended, so a failed or stopped run is labelled after it stops.
    let lastTurnPhase: 'error' | 'interrupted' | undefined;
    let lastTurnReason: StopReason | undefined;
    const pending = new Set<string>();
    const sessionEvents = [...(bySession.get(session.id) ?? [])].sort((a, b) => {
      if (a.seq !== undefined && b.seq !== undefined && a.seq !== b.seq) return a.seq - b.seq;
      return a.at.localeCompare(b.at) || a.id.localeCompare(b.id);
    });

    for (const event of sessionEvents) {
      const body = event.body;
      if (body.type === 'session.ended') ended = true;
      // An outside session can be resumed after it ended.
      if (body.type === 'session.started' && session.control === 'observed' && event.source.channel !== 'import') ended = false;
      if (body.type === 'prompt.submitted' && event.source.channel !== 'import') { stopping = false; lastTurnPhase = undefined; lastTurnReason = undefined; }
      if (body.type === 'user.intervention' && body.action === 'cancel') stopping = true;
      if (body.type === 'approval.requested') pending.add(body.approvalId);
      if (body.type === 'approval.resolved') pending.delete(body.approvalId);
      if (body.type === 'turn.completed') { lastTurnPhase = undefined; lastTurnReason = undefined; }
      if (body.type === 'turn.failed') {
        lastTurnReason = reasonOf(body.reason, body.error);
        lastTurnPhase = stopping || lastTurnReason === 'interrupted' || /interrupt|cancel/i.test(body.error) ? 'interrupted' : 'error';
      }
      if (body.type === 'turn.completed' || body.type === 'turn.failed') stopping = false;

      if (body.type === 'agent.created') {
        const key = event.agentId ?? body.name;
        const current = agents.get(key) ?? { agentId: key, displayName: body.name, stopped: false };
        current.displayName = body.name;
        agents.set(key, current);
      } else if (body.type === 'subagent.spawned') {
        const current = agents.get(body.subagentId) ?? { agentId: body.subagentId, displayName: body.label || body.subagentId, stopped: false };
        current.displayName = body.label || body.subagentId;
        if (body.label) current.label = body.label;
        if (body.role) current.role = body.role;
        const spawnModel = (body as { model?: unknown }).model;
        if (typeof spawnModel === 'string' && spawnModel.trim()) current.model = spawnModel.trim();
        const gender = (body as { gender?: unknown }).gender;
        if (gender !== undefined) current.gender = gender;
        current.parentId = event.agentId;
        agents.set(body.subagentId, current);
      } else if (body.type === 'agent.state') {
        const key = event.agentId ?? 'primary';
        const current = agents.get(key) ?? { agentId: key, displayName: key === 'primary' ? primary.displayName : key, stopped: false };
        current.state = body.state;
        current.activity = body.activity;
        current.phase = body.phase;
        current.summary = body.summary;
        current.target = body.target;
        current.stopped = body.state === 'offline';
        stopTime(current, event);
        agents.set(key, current);
      } else if (body.type === 'subagent.state') {
        const current = agents.get(body.subagentId) ?? { agentId: body.subagentId, displayName: body.subagentId, stopped: false };
        current.state = body.state;
        current.phase = body.phase;
        current.summary = body.summary;
        current.stopped = body.state === 'offline';
        stopTime(current, event);
        agents.set(body.subagentId, current);
      } else if (body.type === 'agent.stopped') {
        const key = event.agentId ?? 'primary';
        const current = agents.get(key) ?? { agentId: key, displayName: key, stopped: false };
        current.stopped = true;
        stopTime(current, event);
        agents.set(key, current);
      }
    }

    const observation = session.control === 'observed' && session.observation
      ? { status: session.observation.status, ...(session.observation.error ? { error: session.observation.error } : {}) }
      : undefined;
    const unavailableStatus = session.control === 'observed'
      ? (observation?.status === 'paused' || !session.observation?.watching ? 'paused'
        : observation?.status === 'unavailable' ? 'unavailable' : undefined)
      : undefined;
    const observedSession = session.control === 'observed' && !unavailableStatus;
    const reported = observedSession ? observedActivities(sessionEvents) : new Map<string, ObservedActivity>();
    const ageOf = (activity: ObservedActivity | undefined) => activity ? Math.max(0, now - activity.at) : undefined;
    const isLive = (activity: ObservedActivity | undefined) => activity !== undefined && ageOf(activity)! <= OBSERVED_LIVE_MS;
    const seen = reported.get('primary');
    const live = isLive(seen);
    // v0.0.38: an observed subagent shows what it reported itself, not its lead's state: Claude Code leads often
    // end their turn while background subagents keep working. Without a report for `OBSERVED_GONE_MS` (at work,
    // waiting or failed; v0.0.43) it has left. v0.0.44: a subagent whose work ended (a stop or `offline` report, or
    // its last report says ready) stays Ready in the office for `subagentLingerMs`, then leaves.
    const subagentStatus = (agent: AgentRecord): { status: OfficeAgentStatus; activity?: ObservedActivity; lingering?: boolean } => {
      if (ended) return { status: 'offline' };
      const own = reported.get(agent.agentId);
      const linger = subagentLingerMs(scopedId(session.id, agent.agentId));
      if (agent.stopped || own?.state === 'offline') {
        const endedAt = own?.state === 'offline' ? own.at : agent.stoppedAt;
        const lingering = !unavailableStatus && endedAt !== undefined && now - endedAt <= linger;
        if (lingering) return { status: 'idle', lingering, ...(own ? { activity: own } : {}) };
        return { status: 'offline', ...(own ? { activity: own } : {}) };
      }
      if (unavailableStatus) return { status: unavailableStatus };
      const ready = own !== undefined && own.state === 'idle' && own.phase !== 'error';
      if (!own || ageOf(own)! > (ready ? linger : goneAfterMs(own))) return { status: 'offline', ...(own ? { activity: own } : {}) };
      return { status: own.state, activity: own };
    };
    // v0.0.43: an observed agent stalls when its last active state outlasts `stallAfterMs` without a new event, unless
    // one of its subagents (any nested agent, for the lead) still works or waits without stalling itself.
    const childrenOf = new Map<string, string[]>();
    if (observedSession) for (const agent of agents.values()) {
      if (agent.agentId === 'primary') continue;
      const parent = agent.parentId && agent.parentId !== agent.agentId && agents.has(agent.parentId) ? agent.parentId : 'primary';
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), agent.agentId]);
    }
    const stalledMemo = new Map<string, boolean>();
    const isStalled = (agentId: string, status: OfficeAgentStatus, own: ObservedActivity | undefined, path: ReadonlySet<string> = new Set()): boolean => {
      if (!observedSession || !own || !AT_WORK.has(status) || path.has(agentId)) return false;
      const cached = stalledMemo.get(agentId);
      if (cached !== undefined) return cached;
      const limit = stallAfterMs(own);
      const within = [...path, agentId];
      const busyChild = () => (childrenOf.get(agentId) ?? []).some(childId => {
        const child = agents.get(childId);
        if (!child) return false;
        const { status: childStatus, activity } = subagentStatus(child);
        return (AT_WORK.has(childStatus) || childStatus === 'waiting') && !isStalled(childId, childStatus, activity, new Set(within));
      });
      const stalled = limit !== undefined && ageOf(own)! > limit && !busyChild();
      stalledMemo.set(agentId, stalled);
      return stalled;
    };
    const subagentLive = observedSession && [...agents.values()].some(agent => {
      if (agent.agentId === 'primary') return false;
      const { status, activity } = subagentStatus(agent);
      return isLive(activity) && (AT_WORK.has(status) || status === 'waiting');
    });
    let observedStatus: OfficeAgentStatus = unavailableStatus ?? (!seen ? 'observing'
      : ageOf(seen)! > goneAfterMs(seen) || seen.state === 'offline' ? 'idle' : seen.state);
    if (seen && observedSession) {
      // The folded activity replaces per-event bookkeeping so a finished tool does not linger.
      primary.state = seen.state; primary.activity = seen.activity; primary.summary = seen.summary; primary.target = seen.target;
      primary.phase = seen.state === 'offline' ? 'ended' : seen.phase; primary.toolName = seen.toolName;
      if (observedStatus === 'idle') {
        primary.activity = undefined; primary.summary = undefined; primary.target = undefined; primary.toolName = undefined;
        if (ageOf(seen)! > goneAfterMs(seen) && seen.state !== 'offline') primary.phase = undefined;
      }
    }
    // A lead whose turn ended while its subagents still work is coordinating them.
    if (observedSession && subagentLive && (observedStatus === 'idle' || observedStatus === 'observing') && primary.phase !== 'ended') {
      observedStatus = 'delegating'; primary.activity = 'delegate'; primary.phase = undefined; primary.summary = undefined; primary.target = undefined;
    }
    const primaryStatus: OfficeAgentStatus = session.control === 'observed' ? observedStatus
      : ended || primary.stopped ? 'offline'
        : !session.running ? 'idle'
          : pending.size || session.pendingApprovalId ? 'waiting'
            : stopping ? 'stopping'
              : primary.state && primary.state !== 'idle' && primary.state !== 'offline' ? primary.state : 'thinking';
    const primaryStalled = session.control === 'observed' && isStalled('primary', primaryStatus, seen);
    if (session.control === 'managed') {
      // A managed run's phase is current only while it runs; an idle lead keeps how its last turn ended.
      if (primaryStatus === 'idle') primary.phase = lastTurnPhase;
      else if (primaryStatus === 'waiting' && (pending.size || session.pendingApprovalId)) primary.phase = 'approval';
      else if (primaryStatus === 'offline' || primaryStatus === 'stopping') primary.phase = undefined;
    }
    // v0.0.43: why the lead's last turn stopped, while its phase says it failed or was interrupted.
    const primaryReason = primary.phase === 'error' || primary.phase === 'interrupted'
      ? session.control === 'managed' ? lastTurnReason : seen?.reason : undefined;
    const primaryPending = session.control === 'managed'
      ? pending.values().next().value ?? session.pendingApprovalId
      : undefined;

    // v0.0.30: a named lead keeps its full name over runtime labels; team members take their names and genders from the team.
    if (lead.name) primary.displayName = lead.name;
    const members = teams.get(session.id) ?? [];
    // v0.0.47: native mission workers (managed sessions): a stable full name seeded by the worker id, unique in the session.
    const missionWork = session.control === 'managed' ? foldMissionWorkers(sessionEvents, session.running, missions) : new Map<string, OfficeMissionWork>();
    const missionLooks = new Map<string, LookIdentity | undefined>();
    if (missionWork.size) {
      const used = new Set<string>([primary.displayName, ...members.map(member => member.name.trim())].filter(Boolean));
      for (const agent of agents.values()) {
        if (agent.agentId === 'primary' || !missionWork.has(agent.agentId)) continue;
        const generated = generateFullName(agent.agentId, used);
        used.add(generated.name);
        agent.displayName = generated.name;
        missionLooks.set(agent.agentId, lookIdentity(generated.name, generated.gender));
      }
    }
    const lookOf = (agent: AgentRecord): LookIdentity | undefined => {
      if (agent.agentId === 'primary') return lead.name ? lookIdentity(lead.name, lead.gender) : undefined;
      const member = members.find(item => item.id === agent.agentId);
      if (member?.name.trim()) { agent.displayName = member.name.trim(); return lookIdentity(member.name, member.gender ?? agent.gender); }
      // A team subagent the team list does not show yet is still seeded by the name it was spawned with.
      return session.team && agent.displayName !== agent.agentId ? lookIdentity(agent.displayName, agent.gender) : undefined;
    };

    // v0.0.37: observed agents carry their source, channel and model; their subagents get person names.
    const origin = sessionOrigin(session);
    const observed = session.control === 'observed';
    const models = observed ? latestAgentModels(sessionEvents) : undefined;
    // The newest model the events report wins; the session summary's lead model only fills in when no event states one.
    const modelOf = (agent: AgentRecord): string | undefined => !models ? undefined
      : agent.agentId === 'primary' ? models.get('primary') ?? sessionLeadModel(session) : models.get(agent.agentId) ?? agent.model;
    const taken = new Set<string>(primary.displayName ? [primary.displayName] : []);
    const observedLook = new Map<string, { look: LookIdentity | undefined; task?: string }>();
    if (observed) for (const agent of agents.values()) {
      if (agent.agentId === 'primary') continue;
      const identity = observedSubagentIdentity({ sessionId: session.id, subagentId: agent.agentId, sourceId: session.observation?.sourceId, label: agent.label, role: agent.role, taken });
      agent.displayName = identity.name;
      taken.add(identity.name);
      observedLook.set(agent.agentId, { look: lookIdentity(identity.name, identity.gender ?? agent.gender), ...(identity.task ? { task: identity.task } : {}) });
    }

    // v0.0.43: an observed lead is in the office while its session runs or had activity (its own or a subagent's;
    // else the host's last-active time) within `OBSERVED_RECENT_MS`; an ended one is listed under "Earlier".
    let newestAt = Number.NEGATIVE_INFINITY;
    for (const activity of reported.values()) newestAt = Math.max(newestAt, activity.at);
    if (newestAt === Number.NEGATIVE_INFINITY) newestAt = Date.parse(session.lastActiveAt);
    const leadEarlier = session.control === 'observed' && (ended || primary.phase === 'ended'
      || (!(live || subagentLive) && !(now - newestAt <= OBSERVED_RECENT_MS)));
    const teamIds = new Set(members.map(member => member.id));

    return [...agents.values()].map(agent => {
      const isPrimary = agent.agentId === 'primary';
      const named = observedLook.get(agent.agentId);
      const work = isPrimary ? undefined : missionWork.get(agent.agentId);
      const look = named ? named.look : work ? missionLooks.get(agent.agentId) : lookOf(agent);
      const model = work?.model ?? modelOf(agent);
      const sub = !isPrimary && session.control === 'observed' ? subagentStatus(agent) : undefined;
      if (sub) {
        const own = sub.activity;
        agent.activity = sub.status === 'idle' || sub.status === 'offline' ? undefined : own?.activity;
        agent.summary = sub.status === 'idle' || sub.status === 'offline' ? undefined : own?.summary ?? agent.summary;
        agent.target = sub.status === 'idle' || sub.status === 'offline' ? undefined : own?.target;
        agent.toolName = agent.activity === 'tool' ? own?.toolName : undefined;
        agent.phase = sub.status === 'offline' || sub.lingering ? undefined : own?.phase;
      }
      const reason = isPrimary ? primaryReason : sub && (agent.phase === 'error' || agent.phase === 'interrupted') ? sub.activity?.reason : undefined;
      // v0.0.44: a managed subagent that stopped stays Ready for its linger before it leaves (not a session end).
      const managedLingering = !isPrimary && !sub && !ended && agent.stopped && agent.stoppedAt !== undefined
        && now - agent.stoppedAt <= subagentLingerMs(scopedId(session.id, agent.agentId));
      if (managedLingering) { agent.activity = undefined; agent.summary = undefined; agent.target = undefined; agent.phase = undefined; }
      // v0.0.47: a mission worker's status follows its task: queued (listed, not admitted), running (its own reports), ended
      // (Ready, or Error when it failed, for its linger, then it leaves) or unknown (shown blocked with a warning, never idle).
      let missionStatus: OfficeAgentStatus | undefined;
      if (work) {
        const lingering = work.endedAt !== undefined && now - work.endedAt <= subagentLingerMs(scopedId(session.id, agent.agentId));
        missionStatus = ended ? 'offline'
          : work.state === 'queued' ? 'idle'
            : work.state === 'running' ? (agent.state && AT_WORK.has(agent.state) ? agent.state : 'thinking')
              : work.state === 'unknown' ? 'blocked'
                : lingering ? 'idle' : 'offline';
        if (work.state !== 'running') { agent.activity = undefined; agent.summary = undefined; agent.target = undefined; agent.toolName = undefined; agent.phase = undefined; }
        if (work.state === 'failed' && missionStatus !== 'offline') agent.phase = 'error';
      }
      const status = isPrimary ? primaryStatus
        : sub ? sub.status
          : missionStatus ? missionStatus
          : managedLingering ? 'idle'
            : ended || agent.stopped ? 'offline'
              : !session.running ? 'idle'
                : agent.state ?? 'working';
      const subLive = sub ? isLive(sub.activity) : false;
      const stalled = isPrimary ? primaryStalled : sub ? isStalled(agent.agentId, sub.status, sub.activity) : false;
      // A subagent that left is history, except a managed team member: the team stays listed under its lead.
      const earlier = isPrimary ? leadEarlier : status === 'offline' && (session.control === 'observed' || !teamIds.has(agent.agentId));
      return {
        id: scopedId(session.id, agent.agentId), sessionId: session.id, agentId: agent.agentId,
        displayName: agent.displayName, control: session.control, status,
        // An observed agent only counts as running while its own recent events say so; Extalia never drives it.
        running: work ? !ended && session.running && work.state === 'running'
          : session.control === 'managed' ? !ended && session.running
          : isPrimary ? AT_WORK.has(status) && (live || subagentLive) : subLive && AT_WORK.has(status),
        ...(session.control === 'observed' && isPrimary && seen ? { live: live || subagentLive, lastActivityAt: new Date(seen.at).toISOString() } : {}),
        ...(sub?.activity ? { live: subLive, lastActivityAt: new Date(sub.activity.at).toISOString() } : {}),
        ...(agent.activity ? { activity: agent.activity } : {}),
        ...(agent.phase ? { phase: agent.phase } : {}),
        ...(agent.toolName ? { toolName: agent.toolName } : {}),
        ...(reason ? { reason } : {}),
        ...(stalled ? { stalled: true } : {}),
        ...(earlier ? { earlier: true } : {}),
        ...(agent.summary ? { summary: agent.summary } : {}),
        ...(agent.target ? { target: agent.target } : {}),
        ...(isPrimary && primaryPending ? { pendingApprovalId: primaryPending } : {}),
        // An outside session's subagent always belongs to someone: its spawner, else the lead (a hook or row may name it before its spawn).
        ...(agent.parentId && (!sub || agents.has(agent.parentId)) ? { parentId: scopedId(session.id, agent.parentId) }
          : sub ? { parentId: scopedId(session.id, 'primary') } : {}),
        ...(observation ? { observation } : {}),
        ...(isPrimary && lead.name && title && title !== lead.name ? { title } : {}),
        ...(named?.task ? { title: named.task } : {}),
        ...(work?.taskTitle ? { title: work.taskTitle } : {}),
        ...(look ? { look } : {}),
        origin,
        ...(model ? { model } : {}),
        ...(isPrimary && session.context ? { context: session.context } : {}),
        ...(work ? { mission: work } : {}),
      };
    });
  });
}
