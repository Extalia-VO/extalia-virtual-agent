import { describe, expect, it, vi } from 'vitest';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { FacilityNpcDirector, FACILITY_IDLE_ROUTE_LIMIT_MS } from '../src/office/scene/movement/facilityDirector';
import { FACILITY_NPCS, type FacilityNpcDefinition } from '../src/office/scene/movement/facilityNpcs';
import { HospitalityState } from '../src/office/scene/movement/hospitality';
import { createMover, placeSeated, routeFrom, type ElevatorAccess, type Mover } from '../src/office/scene/movement/mover';
import { officeNavigation, seatStageId } from '../src/office/scene/movement/navGraph';
import { elevatorWaitingPosition } from '../src/office/scene/movement/elevatorMovement';

const navigation = officeNavigation();
const elevators: ElevatorAccess = { request() {}, waitingSlot: () => 0, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };

function harness(definition: FacilityNpcDefinition, disconnected = true, characters: Mover[] = []) {
  let now = 0;
  const edges = new Map(disconnected ? [] : navigation.graph.edges);
  const env = { navigation: { ...navigation, graph: { ...navigation.graph, edges } }, elevators };
  const hospitality = new HospitalityState();
  const director = new FacilityNpcDirector(env, () => characters, () => now, [definition], hospitality);
  const run = (seconds: number, check?: () => void) => {
    for (let frame = 0; frame < Math.ceil(seconds * 30); frame++) { now += 1000 / 30; director.tick(1 / 30); check?.(); }
  };
  return { director, npc: director.npcs[0]!, edges, env, run,
    gap(seconds: number) { now += seconds * 1000; director.tick(seconds); } };
}

describe('facility idle route recovery', () => {
  it.each(FACILITY_NPCS)('abandons an unreachable voluntary $role break within a bounded simulated deadline', definition => {
    const h = harness(definition);
    const original = h.npc.mover, home = [...original.position];
    const search = vi.spyOn(h.edges, 'get');
    h.npc.brain.dutySince = -definition.timing.dutyMs;
    try {
      h.run(1);
      expect(h.npc.brain.state).toBe('BREAK');
      h.run(FACILITY_IDLE_ROUTE_LIMIT_MS / 1000 + 1);
      expect(h.npc.brain.state).toBe('ON_DUTY');
      expect(h.npc.brain.destination).toBe(definition.homeResourceId);
      expect(h.npc.mover).toBe(original);
      expect(original.phase).toBe('seated');
      expect(original.position).toEqual(home);
      expect(search.mock.calls.length).toBeGreaterThan(4);
      expect(search.mock.calls.length).toBeLessThan(12);
    } finally { h.director.dispose(); }
  });

  it('retries a restored route and completes a normal break without replacing or relocating the NPC', () => {
    const definition = FACILITY_NPCS[0]!;
    const h = harness(definition);
    h.npc.brain.dutySince = -definition.timing.dutyMs;
    const original = h.npc.mover;
    let previous = [...original.position], maxStep = 0, arrived = false;
    try {
      h.run(6);
      for (const [id, links] of navigation.graph.edges) h.edges.set(id, links);
      h.run(180, () => {
        maxStep = Math.max(maxStep, Math.hypot(...original.position.map((value, index) => value - previous[index]!)));
        previous = [...original.position];
        arrived ||= original.phase === 'seated' && original.seat?.seatId === definition.breakResourceId;
      });
      expect(arrived).toBe(true);
      expect(h.npc.mover).toBe(original);
      expect(maxStep).toBeLessThan(.2);
      expect(h.npc.brain.state).toBe('ON_DUTY');
      expect(original.seat?.seatId).toBe(definition.homeResourceId);
    } finally { h.director.dispose(); }
  });

  it('does not age a failed route by a hidden-tab gap', () => {
    const definition = FACILITY_NPCS[0]!;
    const h = harness(definition);
    h.npc.brain.dutySince = -definition.timing.dutyMs;
    try {
      h.run(1);
      h.gap(600);
      expect(h.npc.brain.state).toBe('BREAK');
      h.run(5);
      expect(h.npc.brain.state).toBe('BREAK');
      h.run(11);
      expect(h.npc.brain.state).toBe('ON_DUTY');
    } finally { h.director.dispose(); }
  });

  it.each(['movement', 'destination'] as const)('restarts the failed-route inactivity budget after real %s changes', change => {
    const definition = FACILITY_NPCS[0]!;
    const h = harness(definition);
    h.npc.brain.dutySince = -definition.timing.dutyMs;
    try {
      h.run(10);
      if (change === 'movement') h.npc.mover.position[0] += .03;
      else { h.npc.brain.state = 'RECREATION'; h.npc.brain.destination = definition.recreationResourceId; }
      h.run(6);
      expect(h.npc.brain.state).toBe(change === 'movement' ? 'BREAK' : 'RECREATION');
      h.run(10);
      expect(h.npc.brain.state).toBe('ON_DUTY');
    } finally { h.director.dispose(); }
  });

  it('preserves an undiagnosed lift wait on a voluntary recreation trip for three minutes', () => {
    const definition = FACILITY_NPCS[0]!;
    const h = harness(definition, false);
    const mover = h.npc.mover, destination = navigation.seats.get(definition.recreationResourceId)!;
    h.npc.brain.state = 'RECREATION'; h.npc.brain.destination = destination.seatId;
    routeFrom(mover, seatStageId(definition.homeResourceId), { kind: 'seat', seat: destination }, h.env, false);
    mover.phase = 'waiting';
    mover.trip = { id: 'A', from: 1, to: 3, exit: [...destination.staging], landing: [...mover.position], stage: 'approach', requested: true, exited: false };
    const trip = mover.trip, landing = [...trip.landing];
    const waiting = elevatorWaitingPosition(trip.landing, elevators.door(trip.id), 0);
    try {
      let previous = [...mover.position], maxStep = 0;
      h.run(5, () => {
        maxStep = Math.max(maxStep, Math.hypot(...mover.position.map((value, axis) => value - previous[axis]!)));
        previous = [...mover.position];
      });
      expect(maxStep).toBeGreaterThan(0); expect(maxStep).toBeLessThan(.2);
      expect(mover.position).toEqual(waiting);
      expect(Math.hypot(mover.position[0] - landing[0]!, mover.position[2] - landing[2]!)).toBeCloseTo(1);
      expect(Math.abs(mover.position[2] - landing[2]!)).toBeGreaterThanOrEqual(1);
      const position = [...mover.position];
      h.run(180, () => {
        expect(mover.position).toEqual(position);
        expect(mover.phase).toBe('waiting'); expect(mover.trip).toBe(trip); expect(mover.recovery.attempts).toBe(0);
      });
      expect(h.npc.brain.state).toBe('RECREATION');
      expect(h.npc.brain.destination).toBe(destination.seatId);
      expect(mover.phase).toBe('waiting');
      expect(mover.trip?.id).toBe('A');
      expect(mover.trip).toBe(trip);
      expect(mover.position).toEqual(position);
      expect(mover.recovery.attempts).toBe(0);
    } finally { h.director.dispose(); }
  });

  it('preserves a genuine standing bar-service wait despite an unreachable work contact', () => {
    const definition = FACILITY_NPCS[1]!;
    const seat = navigation.seats.get('lounge.barstool-1')!;
    const guest = createMover('service-guest', gaitParameters(), [...seat.seat], seat.rotationY, true);
    placeSeated(guest, seat, { navigation, elevators });
    const h = harness(definition, true, [guest]);
    const position = [...h.npc.mover.position];
    try {
      h.run(180);
      expect(h.npc.brain.state).toBe('SERVING');
      expect(h.npc.brain.serving?.id).toBe(guest.id);
      expect(h.npc.brain.destination).toBe('lounge.bar-prep');
      expect(h.npc.mover.position).toEqual(position);
      expect(h.npc.mover.motion.sit).toBe(0);
    } finally { h.director.dispose(); }
  });
});
