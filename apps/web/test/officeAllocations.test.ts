import { describe, expect, it } from 'vitest';
import type { OfficeAgent } from '../src/office/presence';
import { seatingKey } from '../src/office/scene/interior/useOfficeAllocations';
import { allocateOfficeAgents, LEAD_SEAT_ORDER, seatFunction, subagentSeatFunction, type OfficeAgentAllocation } from '../src/office/scene/interior/seating';
import { FACILITY_RESERVED_RESOURCE_IDS } from '../src/office/scene/movement/facilityNpcs';

const agent = (id: string, status: OfficeAgent['status'] = 'idle'): OfficeAgent =>
  ({ id, sessionId: id.split(':')[0]!, agentId: 'primary', displayName: id, control: 'managed', status, running: false });

describe('office seating key', () => {
  it('is equal for fresh but equivalent lists, so allocation never re-renders in a loop', () => {
    expect(seatingKey([agent('b:primary'), agent('a:primary')])).toBe(seatingKey([agent('a:primary'), agent('b:primary', 'working')]));
  });
  it('changes when a character arrives or goes offline', () => {
    const base = seatingKey([agent('a:primary')]);
    expect(seatingKey([agent('a:primary'), agent('b:primary')])).not.toBe(base);
    expect(seatingKey([agent('a:primary', 'offline')])).not.toBe(base);
  });
});

describe('office seating policy: leads in the executive rooms, subagents in fitting work rooms', () => {
  const lead = (session: string, extra: Partial<OfficeAgent> = {}): OfficeAgent => ({ ...agent(`${session}:primary`, 'working'), ...extra });
  const sub = (session: string, id: string, extra: Partial<OfficeAgent> = {}): OfficeAgent => ({
    id: `${session}:${id}`, sessionId: session, agentId: id, displayName: id, control: 'managed', status: 'working', running: true, parentId: `${session}:primary`, ...extra,
  });
  const seatOf = (allocations: readonly OfficeAgentAllocation[], id: string) => allocations.find(entry => entry.agentId === id)!.resourceId;

  it('gives the first lead the CEO desk, the next the executive leader desk, and the rest normal workstations', () => {
    const leads = [lead('c'), lead('a'), lead('b', { control: 'observed' })];
    const allocations = allocateOfficeAgents(leads);
    // Managed sessions come before observed ones, then by id.
    expect(seatOf(allocations, 'a:primary')).toBe(LEAD_SEAT_ORDER[0]);
    expect(seatOf(allocations, 'c:primary')).toBe(LEAD_SEAT_ORDER[1]);
    expect(LEAD_SEAT_ORDER).not.toContain(seatOf(allocations, 'b:primary'));
    expect(seatFunction(seatOf(allocations, 'b:primary'))).not.toBe('lead');
  });

  it('seats subagents in a room that fits their role or activity, stably per id', () => {
    const agents = [
      lead('s'),
      sub('s', 'w1', { displayName: 'Review the test setup for coverage settings' }),
      sub('s', 'w2', { displayName: 'Research the docs' }),
      sub('s', 'w3', { displayName: 'worker-3', activity: 'command' }),
      sub('s', 'w4', { displayName: 'worker-4', activity: 'edit' }),
    ];
    const allocations = allocateOfficeAgents(agents);
    expect(seatOf(allocations, 's:primary')).toBe('executive-studio.ceo');
    expect(seatFunction(seatOf(allocations, 's:w1'))).toBe('review');
    expect(seatFunction(seatOf(allocations, 's:w2'))).toBe('research');
    expect(seatFunction(seatOf(allocations, 's:w3'))).toBe('ops');
    expect(seatFunction(seatOf(allocations, 's:w4'))).toBe('code');
    // Deterministic: same input (in any order) gives the same desks; no reshuffle between renders.
    expect(allocateOfficeAgents([...agents].reverse())).toEqual(allocations);
    expect(allocateOfficeAgents(agents, allocations)).toEqual(allocations);
    expect(subagentSeatFunction({ displayName: 'worker-9' })).toBeUndefined();
  });

  it('falls back to any free work desk when the fitting room is full, and never uses facility or leadership desks first', () => {
    const reviewers = Array.from({ length: 6 }, (_, index) => sub('s', `r${index}`, { displayName: `Review part ${index}` }));
    const allocations = allocateOfficeAgents([lead('s'), ...reviewers]);
    const seats = reviewers.map(item => seatOf(allocations, item.id));
    expect(new Set(seats).size).toBe(6);
    // Four QA/review desks exist; the other two reviewers take other work desks.
    expect(seats.filter(id => seatFunction(id) === 'review')).toHaveLength(4);
    expect(seats.some(id => LEAD_SEAT_ORDER.includes(id) || FACILITY_RESERVED_RESOURCE_IDS.has(id))).toBe(false);
  });

  it('keeps everyone at their desk while they stay; a lead is not moved when the CEO desk frees up', () => {
    const first = allocateOfficeAgents([lead('a'), lead('b'), sub('a', 'w1', { displayName: 'Fix the parser' })]);
    const after = allocateOfficeAgents([lead('b'), sub('a', 'w1', { displayName: 'Fix the parser' })], first);
    expect(seatOf(after, 'b:primary')).toBe(seatOf(first, 'b:primary'));
    expect(seatOf(after, 'a:w1')).toBe(seatOf(first, 'a:w1'));
    // The next lead to arrive takes the freed CEO desk.
    const next = allocateOfficeAgents([lead('b'), lead('z'), sub('a', 'w1', { displayName: 'Fix the parser' })], after);
    expect(seatOf(next, 'z:primary')).toBe('executive-studio.ceo');
  });
});
