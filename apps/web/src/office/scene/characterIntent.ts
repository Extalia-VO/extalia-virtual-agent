import type { Messages } from '../../i18n';
import { semanticCategory, semanticPhrase } from '../semanticBubble';
import type { OfficeAgent } from '../presence';

/**
 * One short line on what a character is doing, read only from its presence
 * (status, activity, target). Empty when the presence says nothing active, so
 * no detail is invented. Activity wording is the same safe phrase the bubbles
 * use, so a raw path or command never reaches the name tag.
 */
export function characterIntent(agent: Pick<OfficeAgent, 'status' | 'activity' | 'target'> & Partial<Pick<OfficeAgent, 'stalled'>>, t: Messages): string {
  // v0.0.43: silent mid-work: say so rather than repeat what it was last doing.
  if (agent.stalled && agent.status !== 'offline') return t.chat.detail.noResponse;
  switch (agent.status) {
    case 'observing': return t.office.observed;
    case 'waiting': return t.chat.waiting;
    case 'stopping': return t.chat.status.stopping;
    case 'blocked': return t.chat.status.blocked;
    case 'thinking': return activityLabel(agent, t) ?? t.chat.status.thinking;
    case 'working': return activityLabel(agent, t) ?? t.chat.status.working;
    case 'delegating': return activityLabel(agent, t) ?? t.chat.status.delegating;
    // idle, offline, paused and unavailable characters show no intent.
    default: return '';
  }
}

function activityLabel(agent: Pick<OfficeAgent, 'activity' | 'target'>, t: Messages): string | undefined {
  if (!agent.activity) return undefined;
  // The target only informs the category (git, test); it is never shown.
  const category = semanticCategory({ kind: 'tool', activity: agent.activity, text: agent.target });
  return category ? semanticPhrase(category, t) : undefined;
}
