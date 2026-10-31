import { promptPreview } from '../chat/messagePresentation';
import type { ActivityKind, ExtaliaEvent } from '@extalia/protocol';

/**
 * What a character just did, derived from protocol events. Office toasts and
 * avatar bubbles share this feed so both say the same thing about the same
 * event. Nothing here is invented: every item maps to one reported event.
 */
export type OfficeActivityKind = 'prompt' | 'reply' | 'tool' | 'approval' | 'delegated' | 'done' | 'failed';

export interface OfficeActivity {
  /** The event id, so repeated deliveries collapse into one item. */
  id: string;
  /** Office presence id (`<sessionId>:<agentId>`), the same id characters use. */
  characterId: string;
  sessionId: string;
  kind: OfficeActivityKind;
  /** Short, single-line text for a toast or bubble. */
  text: string;
  /** Tool category when `kind` is `tool`. */
  activity?: ActivityKind;
  at: string;
}

/** Event types the Office keeps for presence, toasts and bubbles. */
export const OFFICE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent.created', 'agent.state', 'agent.stopped', 'subagent.spawned', 'subagent.state', 'session.ended',
  'prompt.submitted', 'model.completed', 'tool.started', 'tool.completed', 'turn.completed', 'turn.failed',
  'approval.requested', 'approval.resolved', 'user.intervention',
  // v0.0.47 (ADR 0016): native mission task lifecycle, for mission workers' presence (no activity line of their own).
  'task.created', 'task.assigned', 'task.completed',
]);

const TEXT_LIMIT = 140;

/** One line, without Markdown noise, cut at a word boundary. */
export function activityText(text: string, limit = TEXT_LIMIT): string {
  const line = text.replace(/```[\s\S]*?```/g, ' ').replace(/[`*_#>]+/g, '').replace(/\s+/g, ' ').trim();
  if (line.length <= limit) return line;
  const cut = line.slice(0, limit - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The activity an event stands for, or nothing for bookkeeping events. Events
 * carried over from another agent (`import` channel) are history, not news.
 */
export function activityFromEvent(event: ExtaliaEvent): OfficeActivity | undefined {
  if (event.source.channel === 'import') return undefined;
  const body = event.body;
  // v0.0.47: a native mission's worker is only queued when announced; the hand-off belongs to the lead that supervises it.
  // ADR 0028: write-capable workers (`write-worker`) are announced the same way.
  const missionSpawn = body.type === 'subagent.spawned' && Boolean(event.correlationId) && (body.role === 'read-only-worker' || body.role === 'write-worker');
  const agentId = body.type === 'subagent.spawned' && !missionSpawn ? body.subagentId : event.agentId ?? 'primary';
  const base = { id: event.id, characterId: `${event.sessionId}:${agentId}`, sessionId: event.sessionId, at: event.at };
  switch (body.type) {
    case 'prompt.submitted': {
      const preview = promptPreview(body.text);
      return preview.text ? { ...base, characterId: `${event.sessionId}:primary`, kind: 'prompt', text: activityText(preview.text) } : undefined;
    }
    case 'model.completed': return body.text.trim() ? { ...base, kind: 'reply', text: activityText(body.text) } : undefined;
    case 'tool.started': return { ...base, kind: 'tool', text: activityText(body.target && !body.label.includes(body.target) ? `${body.label} ${body.target}` : body.label), activity: body.kind };
    case 'approval.requested': return { ...base, kind: 'approval', text: activityText(body.detail ? `${body.action}: ${body.detail}` : body.action) };
    case 'subagent.spawned': return { ...base, kind: 'delegated', text: activityText(body.label ?? body.role ?? body.subagentId) };
    case 'turn.completed': return { ...base, kind: 'done', text: activityText(body.summary ?? '') };
    case 'turn.failed': return { ...base, kind: 'failed', text: activityText(body.error) };
    default: return undefined;
  }
}

/** Activities of `events` whose event ids are not in `seen`, in event order. */
export function newActivities(events: readonly ExtaliaEvent[], seen: ReadonlySet<string>): OfficeActivity[] {
  return events.flatMap(event => {
    if (seen.has(event.id)) return [];
    const activity = activityFromEvent(event);
    return activity ? [activity] : [];
  });
}

/** The most recent activity per character, for bubbles that show only the latest line. */
export function latestByCharacter(activities: readonly OfficeActivity[]): Map<string, OfficeActivity> {
  const latest = new Map<string, OfficeActivity>();
  for (const activity of activities) {
    const current = latest.get(activity.characterId);
    if (!current || current.at <= activity.at) latest.set(activity.characterId, activity);
  }
  return latest;
}
