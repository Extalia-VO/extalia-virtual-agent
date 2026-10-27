import type { OfficeAgent } from '../presence';
import type { OfficeAgentAllocation } from '../scene/interior/seating';
import { inOffice } from './kpis';

/**
 * Characters that are present but have no desk because every seat is taken.
 * They are listed instead of silently dropped; the scene draws a character
 * only once it has a seat.
 */
export function agentsWaitingForDesk(presences: readonly OfficeAgent[], allocations: readonly OfficeAgentAllocation[]): OfficeAgent[] {
  const seated = new Set(allocations.map(allocation => allocation.agentId));
  return presences.filter(agent => inOffice(agent) && !seated.has(agent.id));
}
