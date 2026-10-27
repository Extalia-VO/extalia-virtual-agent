import type { ExtaliaEvent } from '@extalia/protocol';
import { activityFromEvent, latestByCharacter, type OfficeActivity } from '../activityFeed';
import type { OfficeAgent } from '../presence';
import type { OfficeAgentAllocation } from '../scene/interior/seating';
import { BOARD_LIMIT, boardActivities } from './activityBoard';
import { officeKpis, type OfficeKpis } from './kpis';
import { leadAgents } from './leadBar';
import { agentsWaitingForDesk } from './lobby';

export interface OverlayModel {
  kpis: OfficeKpis;
  /** Present characters without a desk. */
  waitingForDesk: OfficeAgent[];
  /** Latest activities of characters in the office, newest first. */
  board: OfficeActivity[];
  /** Latest activity per character. */
  latest: Map<string, OfficeActivity>;
  leads: { shown: OfficeAgent[]; more: number };
}

/** Activities of the loaded events that happened before the Office opened (not toasted, still history). */
export function historyActivities(events: readonly ExtaliaEvent[]): OfficeActivity[] {
  return events.flatMap(event => activityFromEvent(event) ?? []);
}

/** Everything the Office overlay shows, derived from presences, seats and reported events. */
export function buildOverlayModel(input: {
  presences: readonly OfficeAgent[];
  allocations: readonly OfficeAgentAllocation[];
  events: readonly ExtaliaEvent[];
  recent: readonly OfficeActivity[];
  now: number;
}): OverlayModel {
  const known = new Set(input.presences.map(agent => agent.id));
  const all = boardActivities([historyActivities(input.events), input.recent], known, Number.POSITIVE_INFINITY);
  return {
    kpis: officeKpis(input.presences, input.events, input.now),
    waitingForDesk: agentsWaitingForDesk(input.presences, input.allocations),
    board: all.slice(0, BOARD_LIMIT),
    latest: latestByCharacter(all),
    leads: leadAgents(input.presences),
  };
}
