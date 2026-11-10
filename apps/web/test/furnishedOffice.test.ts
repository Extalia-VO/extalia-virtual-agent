import { MESSAGES } from '../src/i18n';
import { describe, expect, it } from 'vitest';
import type { OfficeAgent } from '../src/office/presence';
import { getOfficeSeats, allocateOfficeAgents } from '../src/office/scene/interior/seating';
import { OFFICE_RESOURCES } from '../src/office/scene/interior/resourceRegistry';
import { ROOM_RELOCATIONS } from '../src/office/scene/interior/roomRelocation';
import { roomsOnFloor, roomById } from '../src/office/scene/interior/worldRegistry';
import { screenForLocation, missionControlScreen, meetingScreen } from '../src/office/scene/interior/screenData';

const agent = (id: string, status: OfficeAgent['status'] = 'working'): OfficeAgent => ({
  id, agentId: 'primary', sessionId: id, displayName: id, control: 'managed', status, running: status === 'working',
});

describe('furnished office geometry and real session projection', () => {
  it('places workstation avatar roots at the chair-forward anchor used by desk IK', () => {
    const resource = OFFICE_RESOURCES.find(candidate => candidate.id === 'qa.station-1')!;
    // The chair now sits under the avatar root: chair z=.64, facing π, offset .02m.
    // Keep the avatar at its prior desk-local z=.62 so hand reach stays unchanged.
    expect(resource.position[2] - 10.7 - ROOM_RELOCATIONS.qa![1]).toBeCloseTo(0.64 - 0.02, 6);
  });

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
    // The reception desk belongs to the facility receptionist, so F1 offers 32 agent seats.
    expect([1, 2, 3].map(floor => seats.filter(seat => seat.floor === floor).length)).toEqual([32, 9, 18]);
    expect(seats.some(seat => seat.id === 'lobby.receptionist')).toBe(false);
    expect(OFFICE_RESOURCES.filter(resource => resource.roomId === "meeting-a" && resource.kind === "meeting-seat")).toHaveLength(10);
    expect(OFFICE_RESOURCES.filter(resource => resource.roomId === "meeting-b" && resource.kind === "meeting-seat")).toHaveLength(14);
    expect(seats.filter(seat => seat.id.startsWith('engineering.pod-'))).toHaveLength(24);
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

  it('keeps empty displays idle and shows only the safe activity phrase when occupied', () => {
    const empty = { agents: [], allocations: [], language: 'en' as const };
    expect(screenForLocation(empty, 'floor-1.team-workspace.pod-a.seat-ne').sessionBacked).toBeUndefined();
    expect(missionControlScreen(empty).sessionBacked).toBe(false);
    const observed = { ...agent('session-1', 'observing'), control: 'observed' as const, running: false,
      displayName: 'Research Session', summary: 'User supplied summary' };
    const allocations = allocateOfficeAgents([observed]);
    const occupied = screenForLocation({ agents: [observed], allocations, language: 'id' }, allocations[0]!.resourceId);
    expect(occupied.title).toBe('Research Session');
    expect(occupied.subtitle).toBe(MESSAGES.id.officeUx.semantic.working);
    expect(JSON.stringify(occupied)).not.toContain('User supplied summary');
    expect(occupied.status).toBe('observing');
    expect(occupied.sessionBacked).toBe(true);
  });
});


describe('live meeting screens', () => {
  it('shows only allocated meeting participants, localized topic and round, then returns to standby', () => {
    const participants = ['primary', 'member'];
    const agents: OfficeAgent[] = participants.map(id => ({ ...agent(`s:${id}`), sessionId: 's', agentId: id, displayName: id,
      meeting: { meetingId: 'sync', participants, topic: 'Design review', round: 2 } }));
    const outsider = { ...agent('other:primary'), sessionId: 'other' };
    const allocations = allocateOfficeAgents([...agents, outsider]);
    for (const language of ['en', 'id'] as const) {
      const screen = meetingScreen({ agents: [...agents, outsider], allocations, language }, 'meeting-a');
      expect(screen.title).toBe(MESSAGES[language].office.meeting);
      expect(screen.subtitle).toBe(`Design review · ${MESSAGES[language].office.meetingRound(2)}`);
      expect(screen.meeting).toEqual({ sessionId: 's', meetingId: 'sync' });
      expect(screen.rows?.map(row => row.label)).toEqual(['member', 'primary']);
      expect(JSON.stringify(screen)).not.toContain('other');
      expect(meetingScreen({ agents, allocations, language }, 'meeting-b').sessionBacked).toBeUndefined();
      expect(meetingScreen({ agents: [], allocations: [], language }, 'meeting-a').sessionBacked).toBeUndefined();
    }
  });
});
