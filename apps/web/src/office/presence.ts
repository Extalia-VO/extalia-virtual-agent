import type { SessionSummary } from '@extalia/platform';
import type { ActivityKind, AgentState, ExtaliaEvent } from '@extalia/protocol';

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
  summary?: string;
  target?: string;
  pendingApprovalId?: string;
  parentId?: string;
  observation?: { status: 'watching' | 'paused' | 'unavailable'; error?: string };
}

interface AgentRecord {
  agentId: string;
  displayName: string;
  parentId?: string;
  state?: AgentState;
  activity?: ActivityKind;
  summary?: string;
  target?: string;
  stopped: boolean;
}

const scopedId = (sessionId: string, agentId: string) => `${sessionId}:${agentId}`;

/**
 * Projects real host sessions into office presences. Managed running state comes
 * from the host summary; observed transcript events describe activity but never
 * claim that a session is currently running.
 */
export function projectOfficePresence(
  sessions: readonly SessionSummary[],
  events: readonly ExtaliaEvent[],
): OfficeAgent[] {
  const bySession = new Map<string, ExtaliaEvent[]>();
  for (const event of events) {
    const list = bySession.get(event.sessionId) ?? [];
    list.push(event);
    bySession.set(event.sessionId, list);
  }

  return sessions.flatMap(session => {
    const agents = new Map<string, AgentRecord>();
    const primary: AgentRecord = { agentId: 'primary', displayName: session.title.trim() || 'Agent', stopped: false };
    agents.set(primary.agentId, primary);
    let ended = false;
    let stopping = false;
    const pending = new Set<string>();
    const sessionEvents = [...(bySession.get(session.id) ?? [])].sort((a, b) => {
      if (a.seq !== undefined && b.seq !== undefined && a.seq !== b.seq) return a.seq - b.seq;
      return a.at.localeCompare(b.at) || a.id.localeCompare(b.id);
    });

    for (const event of sessionEvents) {
      const body = event.body;
      if (body.type === 'session.ended') ended = true;
      if (body.type === 'prompt.submitted' && event.source.channel !== 'import') stopping = false;
      if (body.type === 'user.intervention' && body.action === 'cancel') stopping = true;
      if (body.type === 'approval.requested') pending.add(body.approvalId);
      if (body.type === 'approval.resolved') pending.delete(body.approvalId);
      if (body.type === 'turn.completed' || body.type === 'turn.failed') stopping = false;

      if (body.type === 'agent.created') {
        const key = event.agentId ?? body.name;
        const current = agents.get(key) ?? { agentId: key, displayName: body.name, stopped: false };
        current.displayName = body.name;
        agents.set(key, current);
      } else if (body.type === 'subagent.spawned') {
        const current = agents.get(body.subagentId) ?? { agentId: body.subagentId, displayName: body.label || body.subagentId, stopped: false };
        current.displayName = body.label || body.subagentId;
        current.parentId = event.agentId;
        agents.set(body.subagentId, current);
      } else if (body.type === 'agent.state') {
        const key = event.agentId ?? 'primary';
        const current = agents.get(key) ?? { agentId: key, displayName: key === 'primary' ? primary.displayName : key, stopped: false };
        current.state = body.state;
        current.activity = body.activity;
        current.summary = body.summary;
        current.target = body.target;
        current.stopped = body.state === 'offline';
        agents.set(key, current);
      } else if (body.type === 'subagent.state') {
        const current = agents.get(body.subagentId) ?? { agentId: body.subagentId, displayName: body.subagentId, stopped: false };
        current.state = body.state;
        current.summary = body.summary;
        current.stopped = body.state === 'offline';
        agents.set(body.subagentId, current);
      } else if (body.type === 'agent.stopped') {
        const key = event.agentId ?? 'primary';
        const current = agents.get(key) ?? { agentId: key, displayName: key, stopped: false };
        current.stopped = true;
        agents.set(key, current);
      }
    }

    const observation = session.control === 'observed' && session.observation
      ? { status: session.observation.status, ...(session.observation.error ? { error: session.observation.error } : {}) }
      : undefined;
    const primaryStatus: OfficeAgentStatus = session.control === 'observed'
      ? (observation?.status === 'paused' || !session.observation?.watching ? 'paused'
        : observation?.status === 'unavailable' ? 'unavailable' : 'observing')
      : ended || primary.stopped ? 'offline'
        : !session.running ? 'idle'
          : pending.size || session.pendingApprovalId ? 'waiting'
            : stopping ? 'stopping'
              : primary.state && primary.state !== 'idle' && primary.state !== 'offline' ? primary.state : 'thinking';
    const primaryPending = session.control === 'managed'
      ? pending.values().next().value ?? session.pendingApprovalId
      : undefined;

    return [...agents.values()].map(agent => {
      const isPrimary = agent.agentId === 'primary';
      const status = isPrimary ? primaryStatus
        : session.control === 'observed' ? primaryStatus
          : ended || agent.stopped ? 'offline'
            : !session.running ? 'idle'
              : agent.state ?? 'working';
      return {
        id: scopedId(session.id, agent.agentId), sessionId: session.id, agentId: agent.agentId,
        displayName: agent.displayName, control: session.control, status,
        // An observed transcript is a record, not evidence of current execution.
        running: session.control === 'managed' && !ended && session.running,
        ...(agent.activity ? { activity: agent.activity } : {}),
        ...(agent.summary ? { summary: agent.summary } : {}),
        ...(agent.target ? { target: agent.target } : {}),
        ...(isPrimary && primaryPending ? { pendingApprovalId: primaryPending } : {}),
        ...(agent.parentId ? { parentId: scopedId(session.id, agent.parentId) } : {}),
        ...(observation ? { observation } : {}),
      };
    });
  });
}
