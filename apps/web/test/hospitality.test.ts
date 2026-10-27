import { describe, expect, it } from 'vitest';
import { HospitalityState, CONSOLE_SEATS } from '../src/office/scene/movement/hospitality';
import { FacilityNpcDirector } from '../src/office/scene/movement/facilityDirector';
import { MovementDirector } from '../src/office/scene/movement/director';
import { createMover, placeSeated, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { officeNavigation } from '../src/office/scene/movement/navGraph';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { getOfficeSeats } from '../src/office/scene/interior/seating';
import { OFFICE_OBSTACLES } from '../src/office/scene/interior/resourceRegistry';
import type { OfficeAgent } from '../src/office/presence';
import type { OfficeAgentAllocation } from '../src/office/scene/interior/seating';
import { FACILITY_NPCS, createFacilityBrain, stepFacilityBrain } from '../src/office/scene/movement/facilityNpcs';
import { createHandGoals, writeHandGoals } from '../src/office/scene/avatars/handGoals';
import { deskReachForSeat } from '../src/office/scene/avatars/deskReach';

const navigation = officeNavigation();
const elevators: ElevatorAccess = {
  request() {}, waitingSlot: () => 0, canBoard: () => false, standingPosition: () => null, confirmBoarded: () => false,
  canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 25, z: 0 }),
};
const env: MovementEnv = { navigation, elevators };
const makeAgent = (id: string, status: OfficeAgent['status'] = 'idle'): OfficeAgent => ({ id, sessionId: id, agentId: 'primary', displayName: id, control: 'managed', status, running: status !== 'idle' });
const allocation = (agentId: string, seatId: string): OfficeAgentAllocation => {
  const seat = getOfficeSeats().find(entry => entry.id === seatId)!;
  return { ...seat, agentId, resourceId: seat.id };
};

it('pauses the service clock in transit and drops a guest who returns to work', () => {
  const definition = FACILITY_NPCS.find(npc => npc.role === 'bartender')!;
  const brain = createFacilityBrain(definition, 0);
  stepFacilityBrain(brain, { now: 0, demand: ['guest'], arrived: true, allowBreaks: false });
  stepFacilityBrain(brain, { now: 15_000, demand: ['guest'], arrived: false, allowBreaks: false, serviceReady: false });
  expect(brain.serving?.since).toBe(15_000);
  expect(brain.serving?.id).toBe('guest');
  stepFacilityBrain(brain, { now: 16_000, demand: [], arrived: true, allowBreaks: false });
  expect(brain.serving).toBeNull();
});

it('prepares and delivers queued food and drink only at the physical handoff station', () => {
  let now = 0;
  const state = new HospitalityState();
  const guests = ['lounge.barstool-1', 'lounge.barstool-4'].map((id, index) => {
    const seat = navigation.seats.get(id)!;
    const mover = createMover(`guest-${index}`, gaitParameters(), [...seat.seat], seat.rotationY, true);
    placeSeated(mover, seat, env);
    return mover;
  });
  const director = new FacilityNpcDirector(env, () => guests, () => now, FACILITY_NPCS, state);
  const bar = director.npcs.find(npc => npc.definition.role === 'bartender')!;
  const counter = OFFICE_OBSTACLES.find(obstacle => obstacle.id === 'lounge.bartender-counter')!;
  const contacts = new Set<string>();
  const delivered: string[] = [];
  let previous = [...bar.mover.position];
  for (let frame = 0; frame < 30 * 120; frame++) {
    now += 1000 / 30; director.tick(1 / 30);
    expect(Math.hypot(...bar.mover.position.map((value, index) => value - previous[index]!))).toBeLessThan(.2);
    previous = [...bar.mover.position];
    const insideCounter = Math.abs(bar.mover.position[0] - counter.center[0]) < counter.size[0] / 2 + .25 &&
      Math.abs(bar.mover.position[2] - counter.center[2]) < counter.size[1] / 2 + .25;
    expect(insideCounter).toBe(false);
    if (bar.mover.phase === 'seated') contacts.add(bar.mover.seat!.seatId);
    for (const guest of guests) {
      const service = state.serviceFor(guest.id);
      if (service?.status !== 'delivered' || delivered.includes(guest.id)) continue;
      expect(bar.mover.phase).toBe('seated');
      expect(bar.mover.seat?.seatId).toBe(service.resourceId.replace('.barstool-', '.bar-serve-'));
      expect(bar.mover.position[0]).toBeCloseTo(guest.position[0], 6);
      expect(service.deliveredAt).toBeGreaterThan(12_000);
      delivered.push(guest.id);
    }
  }
  expect(contacts).toContain('lounge.bar-prep');
  expect(contacts).toContain('lounge.bar-serve-1');
  expect(contacts).toContain('lounge.bar-serve-4');
  expect(delivered).toEqual(['guest-0', 'guest-1']);
  expect(state.serviceFor('guest-0')?.item).toBe('drink');
  expect(state.serviceFor('guest-1')?.item).toBe('food');
  guests.length = 0; now += 300; director.tick(.3);
  expect(state.serviceFor('guest-0')).toBeUndefined();
  director.dispose();
});

it('keeps the bartender waiting when a work contact is unreachable instead of teleporting', () => {
  let now = 0;
  const state = new HospitalityState();
  const disconnected = { ...navigation, graph: { ...navigation.graph, edges: new Map() } };
  const unreachableEnv = { ...env, navigation: disconnected };
  const seat = navigation.seats.get('lounge.barstool-1')!;
  const guest = createMover('waiting-guest', gaitParameters(), [...seat.seat], seat.rotationY, true);
  placeSeated(guest, seat, unreachableEnv);
  const director = new FacilityNpcDirector(unreachableEnv, () => [guest], () => now, FACILITY_NPCS, state);
  const bar = director.npcs.find(npc => npc.definition.role === 'bartender')!;
  const home = [...bar.mover.position];
  for (let frame = 0; frame < 30 * 40; frame++) { now += 1000 / 30; director.tick(1 / 30); }
  expect(bar.brain.destination).toBe('lounge.bar-prep');
  expect(bar.mover.position).toEqual(home);
  expect(state.serviceFor(guest.id)?.status).toBe('waiting');
  director.dispose();
});

describe('local shared console play', () => {
  it('waits for two arrivals, shares one simulation, then clears when either player leaves', () => {
    const state = new HospitalityState();
    expect(state.reserveGame(['a', 'b'], 0)).toBe(true);
    expect(state.reserveGame(['c', 'd'], 1)).toBe(false);
    state.arriveGame('a', 100);
    expect(state.entertainment()?.startedAt).toBeNull();
    state.arriveGame('b', 200);
    const session = state.entertainment()!;
    state.advance(12_000, .1);
    expect(session.startedAt).toBe(200);
    expect(session.score).toEqual([1, 0]);
    expect(session.ball[0]).toBeGreaterThanOrEqual(0);
    expect(session.ball[0]).toBeLessThanOrEqual(1);
    state.releaseActor('b');
    expect(state.entertainment()).toBeNull();
    expect(state.reserveGame(['c', 'd'], 20_000)).toBe(true);
  });

  it('seats two idle guests with controllers and cancels both reservations for real work or reduced motion', () => {
    let now = 0;
    const state = new HospitalityState();
    const director = new MovementDirector(env, () => now, null, state);
    director.lifeScale = .5; director.preferKind = 'game';
    const ids = ['local-a', 'local-b'];
    const allocations = ids.map((id, i) => allocation(id, `qa.station-${i + 1}`));
    const update = (status: OfficeAgent['status'], reducedMotion = false) => director.update({ allocations, agents: ids.map(id => makeAgent(id, status)), reducedMotion, gaitOf: () => gaitParameters() });
    update('idle');
    let playing = false;
    for (let frame = 0; frame < 30 * 900; frame++) {
      now += 1000 / 30; director.tick(1 / 30);
      if (state.entertainment()?.startedAt != null && director.list.every(mover => mover.motion.clip === 'console-play')) { playing = true; break; }
    }
    expect(playing).toBe(true);
    expect(director.list.map(mover => mover.seat?.seatId).sort()).toEqual([...CONSOLE_SEATS].sort());
    update('working');
    for (let frame = 0; frame < 20; frame++) { now += 1000 / 30; director.tick(1 / 30); }
    expect(state.entertainment()).toBeNull();
    for (const mover of director.list) expect((mover.pending ?? mover.goal)?.kind).toBe('seat');
    update('idle', true); director.tick(.5);
    expect(director.list.every(mover => mover.phase === 'seated' && mover.seat?.seatId.startsWith('qa.'))).toBe(true);
    expect(state.entertainment()).toBeNull();
    director.dispose();
  });
});

it('rotates the occupied stool upper seat and its avatar around the same stationary shaft', () => {
  let now = 0;
  const state = new HospitalityState();
  const director = new MovementDirector(env, () => now, null, state);
  const id = 'stool-guest';
  director.update({ allocations: [allocation(id, 'qa.station-1')], agents: [makeAgent(id)], reducedMotion: false, gaitOf: () => gaitParameters() });
  director.preferKind = 'pantry'; director.lifeScale = .2;
  const mover = director.list[0]!;
  for (let frame = 0; frame < 30 * 800; frame++) {
    now += 1000 / 30; director.tick(1 / 30);
    if (mover.phase === 'seated' && mover.seat?.seatId.startsWith('lounge.barstool-')) break;
  }
  const seat = mover.seat!;
  expect(seat.seatId).toMatch(/^lounge.barstool-/);
  for (let frame = 0; frame < 30; frame++) { now += 1000 / 60; director.tick(1 / 60); }
  expect(state.serviceFor(id)?.status).toBe('waiting');
  expect(mover.motion.clip).toBe('watch-tv');
  state.deliver(id, now);
  now += 500; director.tick(.5);
  expect(mover.motion.clip).toBe(state.serviceFor(id)?.item === 'food' ? 'eat' : 'sip');
  const angle = state.stool(seat.seatId).angle;
  expect(Math.abs(angle)).toBeGreaterThan(.001);
  expect(mover.yaw).toBeCloseTo(seat.rotationY + angle, 8);
  const cx = seat.seat[0] - Math.sin(seat.rotationY) * .04;
  const cz = seat.seat[2] - Math.cos(seat.rotationY) * .04;
  expect(Math.hypot(mover.position[0] - cx, mover.position[2] - cz)).toBeCloseTo(.04, 8);
  director.dispose();
  expect(state.stool(seat.seatId).angle).toBe(0);
});

it('keeps food and controller hand goals supported at elevated bar and sofa seat heights', () => {
  const reach = deskReachForSeat(undefined);
  const desk = writeHandGoals(createHandGoals(), 'sip', 1, 0, reach, 1, 1, 0, .45);
  const stool = writeHandGoals(createHandGoals(), 'sip', 1, 0, reach, 1, 1, 0, .76);
  expect(stool.target[stool.mugHand][1] - desk.target[desk.mugHand][1]).toBeCloseTo(.31);
  expect(writeHandGoals(createHandGoals(), 'console-play', 1, 0, reach, 1, 1, 0).weight).toEqual([1, 1]);
  expect(writeHandGoals(createHandGoals(), 'eat', 1, 0, reach, 1, 1, 0).mug).toBe(0);
});
