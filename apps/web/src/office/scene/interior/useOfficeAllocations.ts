import { useState } from 'react';
import type { OfficeAgent } from '../../presence';
import { allocateOfficeAgents, type OfficeAgentAllocation } from './seating';

/**
 * Seat allocation that stays put: characters keep their desks while others
 * arrive or leave, so only the arriving or leaving character walks.
 */
export function useOfficeAllocations(agents: readonly OfficeAgent[]): readonly OfficeAgentAllocation[] {
  // Seats depend on the roster and explicit meeting membership, not the array's identity:
  // callers may pass a fresh but equal list on every render.
  const key = seatingKey(agents);
  const [state, setState] = useState(() => ({ key, allocations: allocateOfficeAgents(agents) }));
  if (state.key === key) return state.allocations;
  const allocations = allocateOfficeAgents(agents, state.allocations);
  // Adjusting state while rendering is React's pattern for state derived from changing props.
  setState({ key, allocations });
  return allocations;
}

/** Stable roster and meeting membership; contribution text/rounds never reshuffle seats. */
export function seatingKey(agents: readonly OfficeAgent[]): string {
  return agents.filter(agent => agent.status !== 'offline').map(agent => JSON.stringify([agent.id, agent.meeting?.meetingId, agent.meeting?.roomId, agent.meeting?.participants])).sort().join('|');
}
