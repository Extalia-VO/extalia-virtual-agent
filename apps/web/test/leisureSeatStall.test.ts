import { describe, expect, it } from 'vitest';
import type { OfficeAgent } from '../src/office/presence';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { getOfficeSeats } from '../src/office/scene/interior/seating';
import { LEISURE_SEAT_STALL_SECONDS, MovementDirector } from '../src/office/scene/movement/director';
import type { ElevatorAccess, MovementEnv } from '../src/office/scene/movement/mover';
import { officeNavigation } from '../src/office/scene/movement/navGraph';

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };

describe('blocked voluntary seat entries', () => {
  it('unwinds a stalled sit approach and returns to its own desk without waiting for a new user task', () => {
    let now = 0, blocked = false;
    const env: MovementEnv = { navigation: officeNavigation(), elevators, walkable: () => !blocked, nearbyWalkers: () => [] };
    const director = new MovementDirector(env, () => now, null);
    director.lifeScale = .3; director.preferKind = 'lounge';
    const agent: OfficeAgent = { id: 'voluntary-reader', sessionId: 'voluntary-reader', agentId: 'primary',
      displayName: 'Reader', control: 'managed', status: 'idle', running: false };
    const desk = getOfficeSeats().find(seat => seat.id === 'qa.station-1')!;
    director.update({ agents: [agent], allocations: [{ ...desk, agentId: agent.id, resourceId: desk.id }],
      reducedMotion: false, gaitOf: () => gaitParameters() });
    const step = () => { now += 1000 / 30; director.tick(1 / 30); };
    try {
      for (let frame = 0; frame < 300 * 30 && director.list[0]?.phase !== 'seatwork'; frame++) step();
      const mover = director.list[0]!;
      expect(mover.phase).toBe('seatwork'); expect(mover.staticSeat?.kind).toBe('sit');
      const visit = director.lifeState(agent.id)!.visit!;
      expect(visit.arrived).toBe(false);
      blocked = true;
      for (let frame = 0; frame < (LEISURE_SEAT_STALL_SECONDS - 1) * 30; frame++) step();
      expect(director.lifeState(agent.id)?.visit?.spotId).toBe(visit.spotId);
      for (let frame = 0; frame < 3 * 30; frame++) step();
      expect(director.lifeState(agent.id)?.visit).toBeNull();
      expect(director.lifeState(agent.id)?.phase).toBe('linger');
      const target = mover.pending ?? mover.goal;
      expect(target?.kind === 'seat' && target.seat.seatId).toBe(desk.id);
      blocked = false;
      for (let frame = 0; frame < 150 * 30 && !(mover.phase === 'seated' && mover.seat?.seatId === desk.id); frame++) {
        const before = [...mover.position]; step();
        expect(Math.hypot(...mover.position.map((value, index) => value - before[index]!))).toBeLessThan(.1);
        expect(mover.opacity).toBe(1);
      }
      expect(mover.phase).toBe('seated'); expect(mover.seat?.seatId).toBe(desk.id);
      expect(agent.status).toBe('idle'); expect(mover.id).toBe(agent.id);
    } finally { director.dispose(); }
  });
});
