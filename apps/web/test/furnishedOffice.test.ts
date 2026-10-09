import { describe, expect, it } from 'vitest';
import type { OfficeAgent } from '../src/office/presence';
import { getOfficeSeats, allocateOfficeAgents } from '../src/office/scene/interior/seating';
import { OFFICE_RESOURCES } from '../src/office/scene/interior/resourceRegistry';
import { roomsOnFloor, roomById } from '../src/office/scene/interior/worldRegistry';
import { screenForLocation, missionControlScreen } from '../src/office/scene/interior/screenData';

const agent = (id: string, status: OfficeAgent['status'] = 'working'): OfficeAgent => ({
  id, agentId: 'primary', sessionId: id, displayName: id, control: 'managed', status, running: status === 'working',
});

describe('furnished office geometry and real session projection', () => {
  it('preserves full three-floor room envelopes and authored chair anchors', () => {
    expect(roomsOnFloor(1).filter(room => !room.exterior)).toHaveLength(9);
    expect(roomsOnFloor(2)).toHaveLength(8);
    expect(roomsOnFloor(3)).toHaveLength(8);
    expect(roomById('engineering')?.size).toEqual([32, 19.6]);
    expect(roomById('meeting-a')?.size).toEqual([16, 14]);
    expect(roomById('fitness')?.size[0]).toBe(20);
    expect(roomById('executive-studio')?.size).toEqual([18, 9.3]);
    const seats = getOfficeSeats();
    expect(new Set(seats.map(seat => seat.floor))).toEqual(new Set([1, 2, 3]));
    expect([1, 2, 3].map(floor => seats.filter(seat => seat.floor === floor).length)).toEqual([25, 9, 18]);
    expect(OFFICE_RESOURCES.filter(resource => resource.roomId === "meeting-a" && resource.kind === "meeting-seat")).toHaveLength(10);
    expect(OFFICE_RESOURCES.filter(resource => resource.roomId === "meeting-b" && resource.kind === "meeting-seat")).toHaveLength(14);
    expect(seats.filter(seat => seat.id.startsWith('engineering.pod-'))).toHaveLength(16);
    expect(new Set(seats.map(seat => seat.id)).size).toBe(seats.length);
    for (const seat of seats) {
      const resource = OFFICE_RESOURCES.find(resource => resource.id === seat.id)!;
      expect(seat.position).toEqual(resource.position);
      expect(seat.position[1]).toBe((seat.floor - 1) * 6.4);
      expect(seat.seatHeight).toBeGreaterThan(0);
      expect(seat.rotationY).toBe(resource.rotationY);
    }
    seats[0]!.position[0] = 999;
    expect(getOfficeSeats()[0]!.position[0]).not.toBe(999);
  });

  it('allocates only actual presences without overlapping seats or invented overflow', () => {
    expect(allocateOfficeAgents([])).toEqual([]);
    const seats = getOfficeSeats();
    const agents = Array.from({ length: seats.length + 10 }, (_, index) => agent(`session-${index}`));
    const allocations = allocateOfficeAgents([...agents, agent('ended', 'offline')]);
    expect(allocations).toHaveLength(seats.length);
    expect(new Set(allocations.map(entry => entry.resourceId)).size).toBe(seats.length);
    expect(allocations.some(entry => entry.agentId === 'ended')).toBe(false);
    expect(allocateOfficeAgents([...agents].reverse())).toEqual(allocateOfficeAgents(agents));
  });

  it('keeps empty displays idle and uses session text unchanged when occupied', () => {
    const empty = { agents: [], allocations: [], language: 'en' as const };
    expect(screenForLocation(empty, 'floor-1.team-workspace.pod-a.seat-ne').sessionBacked).toBeUndefined();
    expect(missionControlScreen(empty).sessionBacked).toBe(false);
    const observed = { ...agent('session-1', 'observing'), control: 'observed' as const, running: false,
      displayName: 'Research Session', summary: 'User supplied summary' };
    const allocations = allocateOfficeAgents([observed]);
    const occupied = screenForLocation({ agents: [observed], allocations, language: 'id' }, allocations[0]!.resourceId);
    expect(occupied.title).toBe('Research Session');
    expect(occupied.subtitle).toBe('User supplied summary');
    expect(occupied.status).toBe('observing');
    expect(occupied.sessionBacked).toBe(true);
  });
});
