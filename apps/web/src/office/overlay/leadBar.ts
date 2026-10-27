import type { OfficeActivity } from '../activityFeed';
import type { Messages } from '../../i18n';
import type { OfficeAgent } from '../presence';
import { characterIntent } from '../scene/characterIntent';
import { semanticBubble } from '../semanticBubble';
import { inOffice } from './kpis';

export const LEAD_BAR_LIMIT = 4;

const PRIORITY: Partial<Record<OfficeAgent['status'], number>> = {
  waiting: 0, blocked: 0, working: 1, delegating: 1, thinking: 1, stopping: 1, observing: 2, idle: 3, paused: 4, unavailable: 4,
};

/** Lead characters that are in the office, the ones needing attention first. Workers belong to their lead. */
export function leadAgents(presences: readonly OfficeAgent[], limit = LEAD_BAR_LIMIT): { shown: OfficeAgent[]; more: number } {
  const leads = presences.filter(agent => agent.agentId === 'primary' && !agent.parentId && inOffice(agent))
    .map((agent, index) => ({ agent, index }))
    .sort((a, b) => Number(Boolean(b.agent.pendingApprovalId)) - Number(Boolean(a.agent.pendingApprovalId))
      || (PRIORITY[a.agent.status] ?? 3) - (PRIORITY[b.agent.status] ?? 3) || a.index - b.index)
    .map(item => item.agent);
  return { shown: leads.slice(0, limit), more: Math.max(0, leads.length - limit) };
}

/**
 * One line on what a lead is doing: its latest step while it works, otherwise its
 * intent or outcome; empty when the status says it all. Only the safe phrase for
 * the step is shown, never raw command, path or reply text.
 */
export function currentLine(t: Messages, agent: OfficeAgent, latest: OfficeActivity | undefined): string {
  const intent = characterIntent(agent, t);
  if (agent.running && latest && (latest.kind === 'tool' || latest.kind === 'approval' || latest.kind === 'delegated')) return semanticBubble(latest, t) ?? '';
  if (intent) return intent;
  if (latest?.kind === 'failed') return semanticBubble(latest, t) ?? '';
  if (latest?.kind === 'done') return t.officeUx.toast.done;
  // Nothing more to say than the status the card already shows.
  return '';
}
