import type { ActivityKind, AgentState, ExtaliaEvent, Usage } from '@extalia/protocol';
import { promptPreview } from '../../chat/messagePresentation';
import type { OfficeAgent } from '../presence';

/**
 * A character's work as a compact timeline: what it was asked, which steps it
 * took and how they ended. Every entry comes from one or two reported events.
 */
export type TimelineEntry =
  | { kind: 'prompt'; id: string; at: string; text: string }
  /** Text the agent app wrote into the turn (a finished background task, a slash command), not a prompt. */
  | { kind: 'notice'; id: string; at: string; text: string; failed: boolean }
  | { kind: 'reply'; id: string; at: string; text: string }
  | { kind: 'tool'; id: string; at: string; label: string; activity: ActivityKind; status: 'running' | 'ok' | 'failed' | 'stopped'; durationMs?: number }
  | { kind: 'delegated'; id: string; at: string; label: string; workerId: string }
  | { kind: 'approval'; id: string; at: string; action: string; decision: 'pending' | 'granted' | 'rejected' | 'expired' }
  | { kind: 'turn'; id: string; at: string; ok: boolean; text?: string; usage?: Usage; durationMs?: number };

export interface TeamMember {
  characterId: string;
  label: string;
  state: AgentState;
}

const between = (from: string, to: string): number | undefined => {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
};

/** Events that belong to the character: the whole session for its lead agent, only its own for a worker. */
export function characterEvents(events: readonly ExtaliaEvent[], agent: Pick<OfficeAgent, 'sessionId' | 'agentId' | 'control'>): ExtaliaEvent[] {
  const session = events.filter(event => event.sessionId === agent.sessionId && event.source.channel !== 'import');
  if (agent.control === 'observed' || agent.agentId === 'primary') return session.filter(event => !event.agentId || event.agentId === 'primary' || event.body.type === 'subagent.spawned');
  return session.filter(event => event.agentId === agent.agentId);
}

export function characterTimeline(events: readonly ExtaliaEvent[], agent: Pick<OfficeAgent, 'sessionId' | 'agentId' | 'control'>): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const tools = new Map<string, Extract<TimelineEntry, { kind: 'tool' }>>();
  const approvals = new Map<string, Extract<TimelineEntry, { kind: 'approval' }>>();
  let turnStart: string | undefined;
  const closeOpen = (status: 'stopped') => {
    for (const tool of tools.values()) if (tool.status === 'running') tool.status = status;
    for (const approval of approvals.values()) if (approval.decision === 'pending') approval.decision = 'expired';
  };
  for (const event of characterEvents(events, agent)) {
    const { body, id, at } = event;
    switch (body.type) {
      case 'prompt.submitted': {
        const preview = promptPreview(body.text);
        if (preview.notice) {
          if (preview.text) entries.push({ kind: 'notice', id, at, text: preview.text, failed: preview.status === 'failed' });
          break;
        }
        turnStart = at;
        entries.push({ kind: 'prompt', id, at, text: preview.text });
        break;
      }
      case 'model.completed':
        if (body.text.trim()) entries.push({ kind: 'reply', id, at, text: body.text });
        break;
      case 'tool.started': {
        const entry: Extract<TimelineEntry, { kind: 'tool' }> = { kind: 'tool', id, at, label: body.target ? `${body.label} ${body.target}` : body.label, activity: body.kind, status: 'running' };
        tools.set(body.toolCallId ?? id, entry);
        entries.push(entry);
        break;
      }
      case 'tool.completed': {
        const entry = (body.toolCallId && tools.get(body.toolCallId)) || [...tools.values()].reverse().find(tool => tool.status === 'running');
        if (entry) {
          entry.status = body.ok ? 'ok' : 'failed';
          const duration = between(entry.at, at);
          if (duration !== undefined) entry.durationMs = duration;
        }
        break;
      }
      case 'subagent.spawned':
        entries.push({ kind: 'delegated', id, at, label: body.label ?? body.role ?? body.subagentId, workerId: `${event.sessionId}:${body.subagentId}` });
        break;
      case 'approval.requested': {
        const entry: Extract<TimelineEntry, { kind: 'approval' }> = { kind: 'approval', id, at, action: body.detail ? `${body.action}: ${body.detail}` : body.action, decision: 'pending' };
        approvals.set(body.approvalId, entry);
        entries.push(entry);
        break;
      }
      case 'approval.resolved': {
        const entry = approvals.get(body.approvalId);
        if (entry) entry.decision = body.decision;
        break;
      }
      case 'turn.completed': case 'turn.failed': {
        closeOpen('stopped');
        const duration = turnStart ? between(turnStart, at) : undefined;
        entries.push({
          kind: 'turn', id, at, ok: body.type === 'turn.completed',
          ...(body.type === 'turn.failed' ? { text: body.error } : body.summary ? { text: body.summary } : {}),
          ...(body.type === 'turn.completed' && body.usage ? { usage: body.usage } : {}),
          ...(duration !== undefined ? { durationMs: duration } : {}),
        });
        turnStart = undefined;
        break;
      }
      default: break;
    }
  }
  return entries;
}

/** Workers a lead agent delegated to, with their latest reported state. */
export function teamRoster(events: readonly ExtaliaEvent[], sessionId: string): TeamMember[] {
  const team = new Map<string, TeamMember>();
  for (const event of events) {
    if (event.sessionId !== sessionId) continue;
    const body = event.body;
    if (body.type === 'subagent.spawned') {
      team.set(body.subagentId, { characterId: `${sessionId}:${body.subagentId}`, label: body.label ?? body.role ?? body.subagentId, state: team.get(body.subagentId)?.state ?? 'working' });
    } else if (body.type === 'subagent.state') {
      const member = team.get(body.subagentId);
      if (member) member.state = body.state;
    }
  }
  return [...team.values()];
}

/** Human duration: 850 ms, 12 s, 3 min 5 s. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`;
}

export type ConsoleShortcut = 'message' | 'activity' | 'locate' | 'follow' | 'appearance';
const SHORTCUTS: Record<string, ConsoleShortcut> = { m: 'message', a: 'activity', l: 'locate', f: 'follow', e: 'appearance' };

/** Single-letter shortcuts only when nothing is being typed and no modifier is held. */
export function shortcutFor(key: string, modifiers: { alt: boolean; ctrl: boolean; meta: boolean }, typing: boolean): ConsoleShortcut | undefined {
  if (typing || modifiers.alt || modifiers.ctrl || modifiers.meta) return undefined;
  return SHORTCUTS[key.toLowerCase()];
}
