import { describe, expect, it } from 'vitest';
import type { OfficeAgent } from '../src/office/presence';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { getOfficeSeats, type OfficeAgentAllocation } from '../src/office/scene/interior/seating';
import { MovementDirector } from '../src/office/scene/movement/director';
import { HospitalityState } from '../src/office/scene/movement/hospitality';
import { OutdoorKioskState } from '../src/office/scene/movement/outdoorKiosk';
import { placeSeated, routeFrom, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { officeNavigation } from '../src/office/scene/movement/navGraph';

const navigation = officeNavigation();
const elevators: ElevatorAccess = { request() {}, waitingSlot: () => 0, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };

function harness(control: OfficeAgent['control'] = 'managed', scale = .01, pair = false) {
  let now = 0, blocked = false;
  const hospitality = new HospitalityState();
  const env: MovementEnv = { navigation, elevators, walkable: () => !blocked, nearbyWalkers: () => [] };
  const director = new MovementDirector(env, () => now, null, hospitality, new OutdoorKioskState());
  director.lifeScale = scale; director.preferKind = pair ? 'chat' : 'fitness';
  const agents: OfficeAgent[] = (pair ? ['idle-one', 'idle-two'] : ['idle-one']).map(id =>
    ({ id, sessionId: id, agentId: 'primary', displayName: id, control, status: 'idle', running: false }));
  const allocations: OfficeAgentAllocation[] = agents.map((agent, index) => {
    const seat = getOfficeSeats().find(seat => seat.id === `qa.station-${index + 1}`)!;
    return { ...seat, agentId: agent.id, resourceId: seat.id };
  });
  director.update({ allocations, agents, reducedMotion: false, gaitOf: () => gaitParameters() });
  const run = (seconds: number) => {
    for (let frame = 0; frame < Math.ceil(seconds * 30); frame++) { now += 1000 / 30; director.tick(1 / 30); }
  };
  for (let second = 0; second < 310 && !director.lifeState(agents[0]!.id)?.visit; second++) run(1);
  return { director, env, hospitality, run, time: () => now, block() { blocked = true; } };
}

function waitInLift(h: ReturnType<typeof harness>, index = 0) {
  const mover = h.director.list[index]!, goal = mover.pending ?? mover.goal;
  mover.phase = 'waiting'; mover.door = null; mover.chair = null; mover.staticSeat = null;
  mover.trip = { id: 'A', from: 1, to: 3, exit: [...navigation.waypoints.get('f3.elevator-A')!.position],
    landing: [...mover.position], stage: 'approach', requested: true, exited: false };
  mover.pending = goal;
  return { mover, trip: mover.trip, goal };
}

describe('idle visit deadlines respect intent', () => {
  it.each(['managed', 'observed'] as const)('retains a %s avatar’s undiagnosed lift queue beyond travel and outing deadlines', control => {
    const h = harness(control);
    const { mover, trip, goal } = waitInLift(h);
    const visit = h.director.lifeState(mover.id)!.visit!;
    try {
      h.run(190);
      expect(h.director.lifeState(mover.id)?.visit?.spotId).toBe(visit.spotId);
      expect(h.director.lifeState(mover.id)?.phase).toBe('outing');
      expect(mover.trip).toBe(trip);
      expect(mover.pending).toBe(goal);
      expect(mover.phase).toBe('waiting');
      expect(mover.recovery.attempts).toBe(0);
    } finally { h.director.dispose(); }
  });

  it('still replans an ordinary blocked voluntary trip after its travel budget expires', () => {
    const h = harness('managed', 1);
    const mover = h.director.list[0]!, goal = mover.pending ?? mover.goal;
    expect(goal?.kind).toBe('seat');
    mover.chair = null; mover.staticSeat = null; mover.door = null; mover.trip = null;
    expect(routeFrom(mover, 'f1.corridor-qa', goal!, h.env, true)).toBe(true);
    h.block();
    const trips = h.director.walkState(mover.id)!.trips;
    try {
      h.run(145);
      expect(h.director.walkState(mover.id)!.trips).toBe(trips);
      h.run(10);
      expect(h.director.walkState(mover.id)!.trips).toBeGreaterThan(trips);
    } finally { h.director.dispose(); }
  });

  it('preserves an arrived pantry guest’s expected service and ends its normal dwell after delivery', () => {
    const h = harness();
    // Finish the initial walk-about and start one at the pantry.
    h.director.preferKind = 'pantry'; h.director.resetLife();
    const mover = h.director.list[0]!;
    placeSeated(mover, navigation.seats.get('qa.station-1')!, h.env);
    for (let second = 0; second < 5 && !h.director.lifeState(mover.id)?.visit; second++) h.run(1);
    const visit = h.director.lifeState(mover.id)!.visit!;
    expect(visit.kind).toBe('pantry');
    placeSeated(mover, navigation.seats.get(visit.spotId)!, h.env);
    try {
      h.run(190);
      expect(h.director.lifeState(mover.id)?.visit?.spotId).toBe(visit.spotId);
      expect(h.hospitality.serviceFor(mover.id)?.status).toBe('waiting');
      h.hospitality.deliver(mover.id, h.time());
      h.run(.5);
      expect(h.director.lifeState(mover.id)?.visit?.spotId).toBe(visit.spotId);
      h.run(3);
      expect(h.director.lifeState(mover.id)?.visit?.spotId).not.toBe(visit.spotId);
    } finally { h.director.dispose(); }
  });

  it('keeps a reciprocal chat waiting for its lift-bound partner and finishes a reached standing chat normally', () => {
    const h = harness('managed', .01, true);
    const a = h.director.list[0]!, b = h.director.list[1]!;
    for (let second = 0; second < 300 && !h.director.lifeState(a.id)?.visit?.partnerId; second++) h.run(1);
    const visitA = h.director.lifeState(a.id)!.visit!, visitB = h.director.lifeState(b.id)!.visit!;
    expect(visitA.partnerId).toBe(b.id);
    placeSeated(a, navigation.seats.get(visitA.spotId)!, h.env);
    waitInLift(h, 1);
    try {
      h.run(190);
      expect(h.director.lifeState(a.id)?.visit?.spotId).toBe(visitA.spotId);
      expect(a.motion.clip).toBe('look-around');
      placeSeated(b, navigation.seats.get(visitB.spotId)!, h.env);
      h.run(2);
      expect(h.director.lifeState(a.id)?.visit?.spotId).not.toBe(visitA.spotId);
    } finally { h.director.dispose(); }
  });
});
