import type { OfficeAgent } from '../../presence';
import { OFFICE_RESOURCES } from './resourceRegistry';
import type { Point3 } from '../layout';

export interface OfficeSeat {
  id: string;
  floor: 1 | 2 | 3;
  position: Point3;
  rotationY: number;
  seatHeight: number;
}
export interface OfficeAgentAllocation extends OfficeSeat {
  agentId: string;
  resourceId: string;
}

/** Chair anchors are authored together with the furnished room geometry. */
export function getOfficeSeats(): OfficeSeat[] {
  return OFFICE_RESOURCES.filter(resource => resource.kind === 'workstation').map(resource => ({
    id: resource.id, floor: resource.floor, position: [...resource.position],
    rotationY: resource.rotationY, seatHeight: resource.interaction.seatHeight,
  }));
}

/** A visual arrangement of real session presences, never a runtime task allocation. */
export function allocateOfficeAgents(agents: readonly OfficeAgent[]): OfficeAgentAllocation[] {
  const seats = getOfficeSeats();
  return agents.filter(agent => agent.status !== 'offline').slice().sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, seats.length).map((agent, index) => {
      const seat = seats[index]!;
      return { ...seat, agentId: agent.id, resourceId: seat.id };
    });
}
