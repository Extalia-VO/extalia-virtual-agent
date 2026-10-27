import { describe, expect, it } from 'vitest';
import type { OfficeAgent } from '../src/office/presence';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { DoorTraffic, type DoorInfo } from '../src/office/scene/interior/doorTraffic';
import { allocateOfficeAgents, getOfficeSeats } from '../src/office/scene/interior/seating';
import { OFFICE_OBSTACLES, OFFICE_RESOURCES, resourceById } from '../src/office/scene/interior/resourceRegistry';
import { relocateRoomPoint } from '../src/office/scene/interior/roomRelocation';
import { BARTENDER_BAR_BLUEPRINT, RECEPTION_DESK_BLUEPRINT } from '../src/office/scene/interior/spatialBlueprints';
import { GLASS_ELEVATORS, type ElevatorId } from '../src/office/scene/prefabs/architecture/elevatorController';
import { floorAt, floorY, officeNavigation, planRoute, seatStageId } from '../src/office/scene/movement/navGraph';
import { createMover, routeFrom, stepMover, type ElevatorAccess, type MovementEnv, type Mover } from '../src/office/scene/movement/mover';
import {
  FACILITY_NAV_RESOURCE_IDS, FACILITY_NPCS, FACILITY_RESERVED_RESOURCE_IDS, barServicePhase, createFacilityBrain, facilityDefinitionsValid,
  isBarDemand, isPermittedFacilityDestination, isReceptionDemand, stepFacilityBrain, type CharacterSample, type FacilityNpcDefinition,
} from '../src/office/scene/movement/facilityNpcs';
import { FacilityNpcDirector } from '../src/office/scene/movement/facilityDirector';
import { facilityCard, isFacilityStaffId } from '../src/office/scene/movement/facilityStatus';
import { combinePositionSources } from '../src/office/scene/movement/positionStore';
import { MESSAGES } from '../src/i18n';

const navigation = officeNavigation();
const receptionist = FACILITY_NPCS.find(npc => npc.role === 'receptionist')!;
const bartender = FACILITY_NPCS.find(npc => npc.role === 'bartender')!;
const agent = (id: string): OfficeAgent => ({ id, sessionId: id, agentId: 'primary', displayName: id, control: 'managed', status: 'working', running: true });
const sample = (extra: Partial<CharacterSample>): CharacterSample => ({
  id: 'a', floor: 1, x: 0, z: -17, moving: true, headingToSeat: true, seatRoomId: 'engineering', enteredFromEntrance: true, ...extra,
});

describe('facility staff definitions', () => {
  it('are explicit receptionist and bartender roles at their F1 stations', () => {
    expect(FACILITY_NPCS.map(npc => npc.role)).toEqual(['receptionist', 'bartender']);
    expect(receptionist).toMatchObject({ presentation: 'female', homeResourceId: 'lobby.receptionist', homeFloor: 1 });
    expect(receptionist.appearance.presentation).toBe('feminine');
    expect(bartender).toMatchObject({ presentation: 'male', homeResourceId: 'lounge.bartender', homeFloor: 1 });
    expect(bartender.appearance.presentation).toBe('masculine');
    expect(new Set(FACILITY_NPCS.map(npc => npc.id)).size).toBe(FACILITY_NPCS.length);
    expect(facilityDefinitionsValid()).toBe(true);
  });

  it('only go to F1 or the F3 terrace and fitness rooms, never F2 or an ordinary workstation', () => {
    for (const npc of FACILITY_NPCS) for (const id of npc.allowedDestinations) {
      const resource = resourceById(id)!;
      expect(resource, id).toBeDefined();
      expect(resource.floor, id).not.toBe(2);
      if (resource.floor === 3) expect(['rooftop-terrace', 'fitness'], id).toContain(resource.roomId);
      if (id !== npc.homeResourceId) expect(resource.kind, id).not.toBe('workstation');
    }
    const home = receptionist.homeResourceId;
    expect(isPermittedFacilityDestination(resourceById('meeting-a.seat-1'), home)).toBe(false);
    expect(isPermittedFacilityDestination(resourceById('multi-engine.station-1'), home)).toBe(false);
    expect(isPermittedFacilityDestination(resourceById('sky-lounge.armchair'), home)).toBe(false);
    expect(isPermittedFacilityDestination(resourceById('engineering.pod-a.seat-se'), home)).toBe(false);
    expect(isPermittedFacilityDestination(resourceById('lounge.sofa-1'), home)).toBe(true);
    expect(isPermittedFacilityDestination(resourceById('fitness.treadmill-1'), home)).toBe(true);
    expect(isPermittedFacilityDestination(undefined, home)).toBe(false);
    const broken: FacilityNpcDefinition = { ...receptionist, allowedDestinations: [...receptionist.allowedDestinations, 'review.station-1'] };
    expect(facilityDefinitionsValid([broken])).toBe(false);
  });

  it('are never seated by agent allocation, and agents never take their stations', () => {
    expect([...FACILITY_RESERVED_RESOURCE_IDS].sort()).toEqual(['lobby.receptionist', 'lounge.bartender']);
    const seats = getOfficeSeats();
    expect(seats.some(seat => FACILITY_RESERVED_RESOURCE_IDS.has(seat.id))).toBe(false);
    const crowd = Array.from({ length: seats.length + 5 }, (_, index) => agent(`session-${index}`));
    const allocations = allocateOfficeAgents(crowd);
    expect(allocations.some(entry => FACILITY_RESERVED_RESOURCE_IDS.has(entry.resourceId))).toBe(false);
    // A stale allocation (e.g. kept across a reload) on the reception desk is not honoured.
    const stale = [{ ...allocations[0]!, resourceId: 'lobby.receptionist', id: 'lobby.receptionist' }];
    expect(allocateOfficeAgents(crowd.slice(0, 1), stale)[0]!.resourceId).not.toBe('lobby.receptionist');
    // Facility break spots are not workstations either.
    for (const id of FACILITY_NAV_RESOURCE_IDS) if (!FACILITY_RESERVED_RESOURCE_IDS.has(id)) expect(seats.some(seat => seat.id === id)).toBe(false);
  });
});

describe('facility stations and routes', () => {
  it('seats the receptionist facing both desk monitors', () => {
    const seat = navigation.seats.get('lobby.receptionist')!;
    const desk = relocateRoomPoint('lobby', [RECEPTION_DESK_BLUEPRINT.worldPosition[0], 0, RECEPTION_DESK_BLUEPRINT.worldPosition[1]]);
    const forward = [Math.sin(seat.rotationY), Math.cos(seat.rotationY)] as const;
    for (const offset of RECEPTION_DESK_BLUEPRINT.monitorOffsetsX) {
      const monitor = [desk[0] + RECEPTION_DESK_BLUEPRINT.staffOffsetX + offset, desk[2] + RECEPTION_DESK_BLUEPRINT.counterOffsetZ + RECEPTION_DESK_BLUEPRINT.monitorOffsetZ];
      const dx = monitor[0]! - seat.seat[0], dz = monitor[1]! - seat.seat[2];
      const ahead = dx * forward[0] + dz * forward[1], lateral = Math.abs(dx * forward[1] - dz * forward[0]);
      expect(ahead).toBeGreaterThan(0.5);
      expect(ahead).toBeLessThan(1.4);
      expect(lateral).toBeLessThan(0.5);
    }
    expect(seat.standing).toBeFalsy();
    expect(seat.seatHeight).toBeGreaterThan(0.4);
  });

  it('reaches the bar service point from behind the counter, not through it', () => {
    const seat = navigation.seats.get('lounge.bartender')!;
    expect(seat.standing).toBe(true);
    // Faces the guests (+Z) and stands between the back bar and the counter.
    expect(seat.rotationY).toBeCloseTo(BARTENDER_BAR_BLUEPRINT.rotationY);
    const counter = OFFICE_OBSTACLES.find(item => item.id === 'lounge.bartender-counter')!;
    const half = [counter.size[0] / 2, counter.size[1] / 2] as const;
    expect(seat.seat[2]).toBeLessThan(counter.center[2] - half[1]);
    const route = planRoute('f1.lounge-east', seatStageId('lounge.bartender'))!;
    expect(route).not.toBeNull();
    let from: readonly number[] = navigation.waypoints.get('f1.lounge-east')!.position;
    for (const step of route.steps) {
      if (step.kind !== 'walk') throw new Error('no lift inside the lounge');
      // Sample the leg and keep every point out of the counter footprint (plus a body radius).
      for (let t = 0; t <= 1; t += 0.05) {
        const x = from[0]! + (step.to[0] - from[0]!) * t, z = from[2]! + (step.to[2] - from[2]!) * t;
        const inside = Math.abs(x - counter.center[0]) < half[0] + 0.25 && Math.abs(z - counter.center[2]) < half[1] + 0.25;
        expect(inside, `${step.node} at ${x.toFixed(2)},${z.toFixed(2)}`).toBe(false);
      }
      from = step.to;
    }
  });

  it('routes every station and break spot both ways without entering F2 rooms', () => {
    for (const npc of FACILITY_NPCS) {
      for (const id of npc.allowedDestinations) {
        expect(navigation.seats.has(id), id).toBe(true);
        for (const [a, b] of [[npc.homeResourceId, id], [id, npc.homeResourceId]] as const) {
          if (a === b) continue;
          const route = planRoute(seatStageId(a), seatStageId(b));
          expect(route, `${a} → ${b}`).not.toBeNull();
          const onF2 = route!.nodeIds.filter(node => {
            const position = navigation.waypoints.get(node)!.position;
            return Math.abs(position[1] - floorY(2)) < 0.05;
          });
          expect(onF2.every(node => /^f2\.(stairs-(north|south)|elevator-[AB])$/.test(node) || node.startsWith('stairs-')), `${a} → ${b}: ${onF2.join(', ')}`).toBe(true);
        }
      }
    }
  });

  it('keeps the new staff lanes as dead ends, so agent routes do not change', () => {
    const lanes = ['f1.bar-east-approach', 'f1.lounge-dining-lane', 'f3.terrace-hall', 'f3.fitness-hall'];
    for (const seat of getOfficeSeats()) {
      const route = planRoute(navigation.entryId, seatStageId(seat.id))!;
      expect(route.nodeIds.some(node => lanes.includes(node)), seat.id).toBe(false);
    }
  });
});

describe('facility demand', () => {
  it('reception reacts to real arrivals from the entrance only', () => {
    expect(isReceptionDemand(sample({}))).toBe(true);
    expect(isReceptionDemand(sample({ enteredFromEntrance: false }))).toBe(false);
    expect(isReceptionDemand(sample({ moving: false }))).toBe(false);
    expect(isReceptionDemand(sample({ headingToSeat: false }))).toBe(false);
    expect(isReceptionDemand(sample({ floor: 2 }))).toBe(false);
    expect(isReceptionDemand(sample({ z: -5 }))).toBe(false);
  });

  it('the bar reacts to lounge guests only, never to lobby visitors (R7)', () => {
    expect(isBarDemand(sample({ seatRoomId: 'lounge', moving: false, z: -5.9, x: 21 }))).toBe(true);
    expect(isBarDemand(sample({}))).toBe(false);
    expect(isBarDemand(sample({ seatRoomId: 'lounge', floor: 3 }))).toBe(false);
    expect(isReceptionDemand(sample({ seatRoomId: 'lounge', moving: false, z: -5.9, x: 21, enteredFromEntrance: false }))).toBe(false);
  });

  it('ports the bar service timeline', () => {
    expect([0, 2_500, 9_000, 13_000, 17_000, 30_000].map(barServicePhase)).toEqual(['notice', 'brew', 'shake', 'serve', 'return', 'return']);
  });
});

describe('facility duty state machine', () => {
  const quick: FacilityNpcDefinition = { ...receptionist, timing: { dutyMs: 1000, quietMs: 500, breakMs: 2000, recreationMs: 3000, serviceMs: 400, queueGraceMs: 600, urgency: 1.3 } };
  const step = (brain: ReturnType<typeof createFacilityBrain>, now: number, demand: string[] = [], arrived = true, allowBreaks = true) =>
    stepFacilityBrain(brain, { now, demand, arrived, allowBreaks });

  it('stays on duty, then alternates an F1 break with F3 recreation and returns', () => {
    const brain = createFacilityBrain(quick, 0);
    step(brain, 900);
    expect(brain.state).toBe('ON_DUTY');
    step(brain, 1000);
    expect(brain.state).toBe('BREAK');
    expect(brain.destination).toBe(quick.breakResourceId);
    step(brain, 1100, [], false);
    expect(brain.dwellSince).toBeNull();
    step(brain, 1500); // arrived
    step(brain, 3400);
    expect(brain.state).toBe('BREAK');
    step(brain, 3500);
    expect(brain.state).toBe('RETURNING');
    expect(brain.destination).toBe(quick.homeResourceId);
    expect(brain.urgent).toBe(false);
    step(brain, 3600, [], false);
    expect(brain.state).toBe('RETURNING');
    step(brain, 4000);
    expect(brain.state).toBe('ON_DUTY');
    step(brain, 5000);
    expect(brain.state).toBe('RECREATION');
    expect(brain.destination).toBe(quick.recreationResourceId);
  });

  it('takes no break with breaks disabled or while guests keep arriving', () => {
    const brain = createFacilityBrain(quick, 0);
    step(brain, 5000, [], true, false);
    expect(brain.state).toBe('ON_DUTY');
    const busy = createFacilityBrain({ ...quick, timing: { ...quick.timing, serviceMs: 0 } }, 0);
    for (let now = 0; now <= 5000; now += 250) step(busy, now, now % 1000 === 0 ? [`guest-${now}`] : []);
    expect(['ON_DUTY', 'SERVING']).toContain(busy.state);
    expect(busy.breaks).toBe(0);
  });

  it('returns urgently for an arrival, then serves concurrent guests in arrival order', () => {
    const brain = createFacilityBrain(quick, 0);
    step(brain, 1000);
    step(brain, 1200); // at the break spot
    step(brain, 1300, ['a'], true);
    expect(brain.state).toBe('RETURNING');
    expect(brain.urgent).toBe(true);
    step(brain, 1400, ['a', 'b'], false);
    expect(brain.queue.map(entry => entry.id)).toEqual(['a', 'b']);
    step(brain, 1500, ['a', 'b'], true);
    expect(brain.state).toBe('SERVING');
    expect(brain.serving?.id).toBe('a');
    expect(brain.urgent).toBe(false);
    step(brain, 1700, ['a', 'b', 'c']);
    expect(brain.serving?.id).toBe('a');
    step(brain, 1900, ['a', 'b', 'c']);
    expect(brain.serving?.id).toBe('b');
    step(brain, 2300, ['a', 'b', 'c']);
    expect(brain.serving?.id).toBe('c');
    step(brain, 2700, ['a', 'b', 'c']);
    expect(brain.state).toBe('ON_DUTY');
    // Guests still in the area are not served twice; a later visit is welcomed again.
    step(brain, 2800, ['a']);
    expect(brain.state).toBe('ON_DUTY');
    step(brain, 2900, []);
    step(brain, 3000, ['a']);
    expect(brain.state).toBe('SERVING');
  });

  it('drops a queued guest who left before service and goes back on duty', () => {
    const brain = createFacilityBrain(quick, 0);
    step(brain, 1000);
    step(brain, 1100, ['gone'], true);
    expect(brain.state).toBe('RETURNING');
    step(brain, 1500, [], false);
    step(brain, 1800, [], true);
    expect(brain.state).toBe('ON_DUTY');
    expect(brain.queue).toEqual([]);
  });

  it('is deterministic', () => {
    const run = () => {
      const brain = createFacilityBrain(quick, 0);
      const trace: string[] = [];
      for (let now = 0; now < 12_000; now += 100) {
        step(brain, now, now > 4000 && now < 4600 ? ['x'] : [], now % 700 < 400);
        trace.push(`${brain.state}:${brain.destination}:${brain.serving?.id ?? ''}`);
      }
      return trace;
    };
    expect(run()).toEqual(run());
  });
});

/** Cab model: boards at once and travels 2 m/s. */
function fakeElevators(): { access: ElevatorAccess; advance(seconds: number): void } {
  const rides = new Map<string, { to: number; y: number; boarded: boolean }>();
  const lift = (id: ElevatorId) => GLASS_ELEVATORS.find(entry => entry.id === id)!;
  return {
    access: {
      request: (riderId, from, to) => { if (!rides.has(riderId)) rides.set(riderId, { to, y: floorY(from), boarded: false }); },
      waitingSlot: () => 0,
      canBoard: riderId => Boolean(rides.get(riderId) && !rides.get(riderId)!.boarded),
      standingPosition: (riderId, id) => { const ride = rides.get(riderId); return ride ? [lift(id).x + 0.675, ride.y, lift(id).z - 0.9] : null; },
      confirmBoarded: riderId => { const ride = rides.get(riderId); if (!ride) return false; ride.boarded = true; return true; },
      canExit: riderId => { const ride = rides.get(riderId); return Boolean(ride?.boarded && ride.y === floorY(ride.to as 1 | 2 | 3)); },
      confirmExited: riderId => rides.delete(riderId),
      release: riderId => { rides.delete(riderId); },
      door: id => ({ x: lift(id).doorX, z: lift(id).z }),
    },
    advance(seconds) {
      for (const ride of rides.values()) {
        if (!ride.boarded) continue;
        const target = floorY(ride.to as 1 | 2 | 3), stepY = 2 * seconds;
        ride.y = Math.abs(target - ride.y) <= stepY ? target : ride.y + Math.sign(target - ride.y) * stepY;
      }
    },
  };
}

describe('facility director', () => {
  it('releases door ownership and closing duties when disposed during a maneuver', () => {
    const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 1.2, height: 2.55, openAngle: -Math.PI / 2, sliding: false };
    const doors = new DoorTraffic({ forEachDoor: visit => visit('door', door), forEachWalker() {} }, () => 0);
    const director = new FacilityNpcDirector({ navigation, elevators: fakeElevators().access, doors }, () => [], () => 0);
    const mover = director.npcs[0]!.mover;
    mover.phase = 'doorwork';
    mover.door = { kind: 'close', id: 'door', door, timer: 0, beat: 'swing', side: 1, entrySide: -1, hand: 1, path: null };
    doors.hold('door', mover.id, 1, 1);
    doors.moved(mover.id, [0, 0, -0.4], [0, 0, 0.4]);
    expect(doors.claim('door', 'next')).toBe(false);
    expect(doors.duty(mover.id)).not.toBeNull();

    director.dispose();

    expect(doors.claim('door', 'next')).toBe(true);
    expect(doors.duty(mover.id)).toBeNull();
  });

  const quickDefinitions = FACILITY_NPCS.map(npc => ({ ...npc, timing: { ...npc.timing, dutyMs: 2000, quietMs: 0, breakMs: 3000, recreationMs: 3000 } }));
  function harness(definitions: readonly FacilityNpcDefinition[] = FACILITY_NPCS) {
    let now = 0;
    const lifts = fakeElevators();
    const env: MovementEnv = { navigation, elevators: lifts.access };
    const characters: Mover[] = [];
    const director = new FacilityNpcDirector(env, () => characters, () => now, definitions);
    const run = (seconds: number, onFrame?: () => void) => {
      for (let t = 0; t < seconds; t += 1 / 30) {
        now += 1000 / 30; lifts.advance(1 / 30);
        for (const mover of characters) stepMover(mover, 1 / 30, env);
        director.tick(1 / 30); onFrame?.();
      }
    };
    return { director, env, characters, run };
  }
  const npc = (director: FacilityNpcDirector, role: 'receptionist' | 'bartender') => director.npcs.find(entry => entry.definition.role === role)!;

  it('starts both staff at their stations, working, with no walk-in; a remount does not duplicate them', () => {
    const h = harness();
    const desk = npc(h.director, 'receptionist'), bar = npc(h.director, 'bartender');
    expect(h.director.npcs).toHaveLength(2);
    expect(desk.mover.position).toEqual(navigation.seats.get('lobby.receptionist')!.seat);
    expect(desk.mover.motion.sit).toBe(1);
    expect(bar.mover.position).toEqual(navigation.seats.get('lounge.bartender')!.seat);
    expect(bar.mover.motion.sit).toBe(0);
    h.run(2);
    expect(desk.brain.state).toBe('ON_DUTY');
    expect(desk.mover.phase).toBe('seated');
    expect(bar.mover.phase).toBe('seated');
    expect(harness().director.npcs.map(entry => entry.definition.id)).toEqual(h.director.npcs.map(entry => entry.definition.id));
  });

  it('walks to F3 recreation without teleporting or entering F2 rooms, then hurries back for an arrival and serves', () => {
    const h = harness(quickDefinitions);
    const desk = npc(h.director, 'receptionist');
    let previous: number[] = [...desk.mover.position];
    let maxStep = 0;
    let onF2Room = false;
    const track = () => {
      const p = desk.mover.position;
      maxStep = Math.max(maxStep, Math.hypot(p[0] - previous[0]!, p[1] - previous[1]!, p[2] - previous[2]!));
      previous = [...p];
      // On the F2 level only at the stairs or the elevator hall (x > 16).
      if (Math.abs(p[1] - floorY(2)) < 0.05 && p[0] < 16) onF2Room = true;
    };
    // First break (F1), then recreation (F3).
    h.run(2.5, track);
    expect(desk.brain.state).toBe('BREAK');
    h.run(60, track);
    let reachedTerrace = false;
    for (let i = 0; i < 240 && !reachedTerrace; i++) {
      h.run(1, track);
      reachedTerrace = desk.brain.state === 'RECREATION' && desk.mover.phase === 'seated' && desk.mover.seat?.seatId === 'rooftop-terrace.armchair-3';
    }
    expect(reachedTerrace).toBe(true);
    expect(floorAt(desk.mover.position[1])).toBe(3);
    // A real character arrives through the entrance.
    const visitor = createMover('visitor:primary', gaitParameters(), [...navigation.waypoints.get(navigation.entryId)!.position], 0, false);
    routeFrom(visitor, navigation.entryId, { kind: 'seat', seat: navigation.seats.get('engineering.pod-a.seat-se')! }, h.env, false);
    h.characters.push(visitor);
    h.run(1, track);
    expect(desk.brain.state).toBe('RETURNING');
    expect(desk.brain.urgent).toBe(true);
    expect(npc(h.director, 'bartender').brain.queue).toEqual([]);
    let served = false;
    for (let i = 0; i < 180 && !served; i++) { h.run(1, track); served = desk.brain.state === 'SERVING' || (desk.brain.state === 'ON_DUTY' && desk.mover.phase === 'seated'); }
    expect(served).toBe(true);
    expect(desk.mover.seat?.seatId).toBe('lobby.receptionist');
    expect(maxStep).toBeLessThan(0.5);
    expect(onF2Room).toBe(false);
  });

  it('keeps staff at their stations with reduced motion', () => {
    const h = harness(quickDefinitions);
    h.director.setReducedMotion(true);
    h.run(10);
    for (const entry of h.director.npcs) {
      expect(entry.brain.state).toBe('ON_DUTY');
      expect(entry.mover.seat?.seatId).toBe(entry.definition.homeResourceId);
    }
  });

  it('never registers staff stations as agent seats', () => {
    expect(OFFICE_RESOURCES.filter(resource => FACILITY_RESERVED_RESOURCE_IDS.has(resource.id))).toHaveLength(2);
    expect(allocateOfficeAgents([agent('first')])[0]!.resourceId).not.toBe('lobby.receptionist');
  });
});

describe('facility staff card', () => {
  it('shows role and duty in English and Indonesian, with no session', () => {
    const card = facilityCard(MESSAGES.en, { definition: receptionist, state: 'ON_DUTY' });
    expect(card).toEqual({ id: receptionist.id, displayName: 'Receptionist', role: 'Facility staff', state: 'working', summary: 'Working at the reception desk' });
    expect(facilityCard(MESSAGES.id, { definition: bartender, state: 'BREAK' })).toMatchObject({ displayName: 'Bartender', role: 'Staf fasilitas', state: 'break' });
    expect(facilityCard(MESSAGES.en, { definition: bartender, state: 'SERVING' }).summary).toBe('Preparing a drink for a guest');
    expect(facilityCard(MESSAGES.en, { definition: receptionist, state: 'RETURNING' }).state).toBe('working');
    expect(isFacilityStaffId(receptionist.id)).toBe(true);
    expect(isFacilityStaffId('session-1:primary')).toBe(false);
  });

  it('locates staff through the shared position source', () => {
    const env: MovementEnv = { navigation, elevators: fakeElevators().access };
    const director = new FacilityNpcDirector(env, () => [], () => 0);
    const empty = { position: () => undefined, floor: () => undefined, moving: () => false, subscribe: () => () => {}, version: () => 0 };
    const live = combinePositionSources(empty, director);
    expect(live.position(bartender.id)).toEqual(navigation.seats.get('lounge.bartender')!.seat);
    expect(live.floor(bartender.id)).toBe(1);
    expect(live.moving(bartender.id)).toBe(false);
    expect(live.position('nobody')).toBeUndefined();
  });
});
