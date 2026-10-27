import type { OfficeAgent } from '../../presence';
import { OFFICE_RESOURCES } from './resourceRegistry';
import { FACILITY_RESERVED_RESOURCE_IDS } from '../movement/facilityNpcs';
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

/**
 * Chair anchors are authored together with the furnished room geometry. Stations
 * owned by facility staff (the reception desk) are never offered to agents.
 */
export function getOfficeSeats(): OfficeSeat[] {
  return OFFICE_RESOURCES.filter(resource => resource.kind === 'workstation' && !FACILITY_RESERVED_RESOURCE_IDS.has(resource.id)).map(resource => ({
    id: resource.id, floor: resource.floor, position: [...resource.position],
    rotationY: resource.rotationY, seatHeight: resource.interaction.seatHeight,
  }));
}

/** What a room's desks are for, so a subagent sits where its kind of work happens. */
export type SeatFunction = 'lead' | 'code' | 'review' | 'research' | 'ops';

const ROOM_FUNCTIONS: Readonly<Record<string, SeatFunction>> = {
  'executive-studio': 'lead', executive: 'lead',
  engineering: 'code', 'source-control': 'code', 'multi-engine': 'code', flex: 'code',
  qa: 'review', review: 'review',
  research: 'research', library: 'research', knowledge: 'research', architecture: 'research',
  operations: 'ops', 'mission-control': 'ops', sanctuary: 'ops',
};

/** Leadership desks in order: the first lead agent gets the CEO desk, the next the executive leader desk. */
export const LEAD_SEAT_ORDER: readonly string[] = ['executive-studio.ceo', 'executive.leader'];

const ROOM_OF = new Map(OFFICE_RESOURCES.map(resource => [resource.id, resource.roomId]));

/** The function of a workstation's room; undefined for rooms without one (they take any agent as a fallback). */
export function seatFunction(seatId: string): SeatFunction | undefined {
  const roomId = ROOM_OF.get(seatId);
  return roomId ? ROOM_FUNCTIONS[roomId] : undefined;
}

/** A session's lead (primary) agent; everything it spawned, or any other named agent, works in the work rooms. */
export function isLeadAgent(agent: Pick<OfficeAgent, 'agentId' | 'parentId'>): boolean {
  return agent.agentId === 'primary' && !agent.parentId;
}

const ROLE_KEYWORDS: readonly [SeatFunction, RegExp][] = [
  ['review', /\b(review|qa|test|verif|audit|lint|check)/i],
  ['research', /\b(research|explor|search|investigat|doc|librar|knowledge|web|read|analy|plan|architect|design)/i],
  ['ops', /\b(ops|deploy|infra|release|build|command|shell|monitor|run|ci\b|migrat)/i],
  ['code', /\b(code|coding|engineer|implement|fix|edit|refactor|dev|frontend|backend|ui\b|write|patch)/i],
];
const ACTIVITY_FUNCTIONS: Partial<Record<NonNullable<OfficeAgent['activity']>, SeatFunction>> = {
  edit: 'code', tool: 'code', test: 'review', search: 'research', read: 'research', web: 'research', knowledge: 'research', command: 'ops',
};

/**
 * The kind of desk a subagent should take: its role/label first (stable for the
 * agent), then what it is doing when it arrives; undefined means any free desk.
 */
export function subagentSeatFunction(agent: Pick<OfficeAgent, 'displayName' | 'activity' | 'summary'>): SeatFunction | undefined {
  for (const text of [agent.displayName, agent.summary]) {
    if (!text) continue;
    const match = ROLE_KEYWORDS.find(([, pattern]) => pattern.test(text));
    if (match) return match[0];
  }
  return agent.activity ? ACTIVITY_FUNCTIONS[agent.activity] : undefined;
}

/** FNV-1a: a stable pseudo-random pick per agent id, so the same subagent lands on the same desk for the same free set. */
function stableHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const pick = <T>(list: readonly T[], id: string): T | undefined => list.length ? list[stableHash(id) % list.length] : undefined;

/**
 * A visual arrangement of real session presences, never a runtime task allocation.
 * Lead (primary) agents take the leadership desks in `LEAD_SEAT_ORDER` (managed
 * sessions first, then by id), extra leads any free workstation. Subagents take
 * a stable pseudo-random free desk in a room that fits their role or activity
 * (`subagentSeatFunction`), else any free work desk, leadership desks last.
 * Facility stations are never offered (see `getOfficeSeats`).
 * With `previous`, presences keep the seat they already have, so an arrival
 * never makes other characters change desks; a lead is not promoted later.
 */
export function allocateOfficeAgents(agents: readonly OfficeAgent[], previous?: readonly OfficeAgentAllocation[]): OfficeAgentAllocation[] {
  const seats = getOfficeSeats();
  const byId = (a: OfficeAgent, b: OfficeAgent) => a.id.localeCompare(b.id);
  const present = agents.filter(agent => agent.status !== 'offline');
  const leads = present.filter(isLeadAgent).sort((a, b) => Number(a.control === 'observed') - Number(b.control === 'observed') || byId(a, b));
  const others = present.filter(agent => !isLeadAgent(agent)).sort(byId);
  const order = [...leads, ...others];
  const assigned = new Map<string, OfficeSeat>();
  const taken = new Set<string>();
  const kept = new Map(previous?.map(entry => [entry.agentId, entry.resourceId]));
  for (const agent of order) {
    const seat = seats.find(candidate => candidate.id === kept.get(agent.id));
    if (seat && !taken.has(seat.id)) { assigned.set(agent.id, seat); taken.add(seat.id); }
  }
  const leadership = new Set(LEAD_SEAT_ORDER);
  for (const agent of order) {
    if (assigned.has(agent.id)) continue;
    const free = seats.filter(seat => !taken.has(seat.id));
    const work = free.filter(seat => !leadership.has(seat.id));
    let seat: OfficeSeat | undefined;
    if (isLeadAgent(agent)) {
      seat = LEAD_SEAT_ORDER.map(id => free.find(candidate => candidate.id === id)).find(Boolean) ?? pick(work, agent.id);
    } else {
      const fn = subagentSeatFunction(agent);
      const fitting = fn ? work.filter(candidate => seatFunction(candidate.id) === fn) : [];
      seat = pick(fitting.length ? fitting : work.length ? work : free, agent.id);
    }
    if (!seat) break;
    assigned.set(agent.id, seat);
    taken.add(seat.id);
  }
  // Output order is input-independent (sorted by id), as before.
  return present.slice().sort(byId).flatMap(agent => {
    const seat = assigned.get(agent.id);
    return seat ? [{ ...seat, agentId: agent.id, resourceId: seat.id }] : [];
  });
}
