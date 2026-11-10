import type { ActivityKind, ExtaliaEvent } from '@extalia/protocol';
import { isAdmitted, type OfficeAgent } from './presence';

/** Structural subset accepted from the approval inbox; no host or runtime dependency. */
export interface CameraPendingApproval {
  id: string;
  sessionId: string;
  requestedAt: string;
  agentId?: string;
}

interface Attention { characterId: string; at: string; key: string }
interface ApprovalAttention extends Attention { sessionId: string }
interface PhaseAttention extends Attention { phase: 'input' | 'approval'; activity?: ActivityKind }
const characterId = (sessionId: string, agentId = 'primary') => `${sessionId}:${agentId}`;
const approvalKey = (sessionId: string, id: string) => JSON.stringify([sessionId, id]);
const byTime = (a: Attention, b: Attention) => a.at.localeCompare(b.at) || a.characterId.localeCompare(b.characterId) || a.key.localeCompare(b.key);
const eventOrder = (a: ExtaliaEvent, b: ExtaliaEvent) => {
  if (a.seq !== undefined && b.seq !== undefined && a.seq !== b.seq) return a.seq - b.seq;
  // Same-timestamp hook steps retain delivery order; opaque IDs are not a clock.
  return a.at.localeCompare(b.at);
};

/**
 * Characters with actual outstanding requests, oldest first and once per avatar.
 * Replay is ordered within each session; timestamps order outstanding requests
 * across characters. Identified approvals survive ordinary state/turn changes
 * until matching resolution or session end. Later activity supersedes phase-only waits.
 * This is camera attention, never evidence that Extalia can answer an outside app.
 */
export function cameraAttentionIds(
  agents: readonly OfficeAgent[],
  events: readonly ExtaliaEvent[],
  pending: readonly CameraPendingApproval[],
): string[] {
  const visible = new Map(agents.filter(agent => isAdmitted(agent) && !agent.earlier
    && !['offline', 'paused', 'unavailable'].includes(agent.status)
    && (!agent.observation || agent.observation.status === 'watching')).map(agent => [agent.id, agent]));
  const sessions = new Map<string, ExtaliaEvent[]>();
  for (const event of events) {
    if (event.source.channel === 'import') continue;
    const list = sessions.get(event.sessionId) ?? [];
    list.push(event);
    sessions.set(event.sessionId, list);
  }
  const approvals = new Map<string, ApprovalAttention>();
  const knownApprovals = new Map<string, string>();
  const phases = new Map<string, PhaseAttention | undefined>();

  for (const [sessionId, sessionEvents] of sessions) {
    const seen = new Set<string>();
    for (const event of [...sessionEvents].sort(eventOrder)) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      const body = event.body;
      const id = characterId(sessionId, body.type === 'subagent.state' || body.type === 'subagent.spawned' ? body.subagentId : event.agentId);
      if (body.type === 'approval.requested') {
        const key = approvalKey(sessionId, body.approvalId);
        // Repeated delivery must not change the original requesting character or age.
        if (!knownApprovals.has(key)) {
          knownApprovals.set(key, id);
          approvals.set(key, { characterId: id, sessionId, at: event.at, key });
        }
      } else if (body.type === 'approval.resolved') {
        const key = approvalKey(sessionId, body.approvalId);
        const owner = knownApprovals.get(key) ?? id;
        knownApprovals.set(key, owner);
        approvals.delete(key);
        if (phases.get(owner)?.phase !== 'input') phases.set(owner, undefined);
      } else if (body.type === 'agent.state' || body.type === 'subagent.state') {
        phases.set(id, body.state === 'waiting' && (body.phase === 'input' || body.phase === 'approval')
          ? { characterId: id, at: event.at, key: event.id, phase: body.phase, ...(body.type === 'agent.state' && body.activity ? { activity: body.activity } : {}) }
          : undefined);
      } else if (body.type === 'session.ended') {
        for (const [key, approval] of approvals) if (approval.sessionId === sessionId) approvals.delete(key);
        for (const agent of agents) if (agent.sessionId === sessionId) phases.set(agent.id, undefined);
      } else if (body.type === 'tool.started') {
        const phase = phases.get(id);
        // Question tools emit waiting + tool.started together; that start is not an answer.
        if (!phase || phase.at !== event.at || phase.activity !== body.kind) phases.set(id, undefined);
      } else if (body.type === 'prompt.submitted' || body.type === 'tool.completed' || body.type === 'model.thinking'
        || body.type === 'model.delta' || body.type === 'model.completed' || body.type === 'turn.completed'
        || body.type === 'turn.failed' || body.type === 'agent.stopped' || body.type === 'subagent.spawned') {
        phases.set(id, undefined);
      }
    }
  }

  const attention: Attention[] = [...approvals.values()];
  for (const request of pending) {
    const key = approvalKey(request.sessionId, request.id);
    if (knownApprovals.has(key)) continue;
    const id = characterId(request.sessionId, request.agentId);
    // Without a protocol request, only the managed host's current summary is authoritative.
    if (visible.get(id)?.control === 'managed') attention.push({ characterId: id, at: request.requestedAt, key });
  }
  for (const agent of visible.values()) {
    const key = agent.pendingApprovalId ? approvalKey(agent.sessionId, agent.pendingApprovalId) : undefined;
    if (agent.control === 'managed' && key && !knownApprovals.has(key)) {
      attention.push({ characterId: agent.id, at: agent.lastActivityAt ?? '\uffff', key });
    }
    if (agent.status !== 'waiting') continue;
    if (phases.has(agent.id)) {
      const phase = phases.get(agent.id);
      if (phase) attention.push(phase);
    } else if (agent.phase === 'input' || agent.phase === 'approval') {
      attention.push({ characterId: agent.id, at: agent.lastActivityAt ?? '\uffff', key: 'phase' });
    }
  }
  return [...new Set(attention.filter(item => visible.has(item.characterId)).sort(byTime).map(item => item.characterId))];
}
