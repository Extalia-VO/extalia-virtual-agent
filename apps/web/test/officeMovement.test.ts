import { describe, expect, it } from 'vitest';
import type { OfficeAgent } from '../src/office/presence';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { DoorTraffic, type DoorInfo } from '../src/office/scene/interior/doorTraffic';
import { getOfficeSeats, allocateOfficeAgents, type OfficeAgentAllocation } from '../src/office/scene/interior/seating';
import { OFFICE_ROOMS } from '../src/office/scene/interior/worldRegistry';
import { F1_LAYOUT, F2_LAYOUT, F3_LAYOUT } from '../src/office/scene/interior/floor1Layout';
import { CAMPUS_ENTRY_LAYOUT, FLOOR_HEIGHT, OFFICE_BUILDING, type Point3 } from '../src/office/scene/layout';
import { GLASS_ELEVATORS, type ElevatorId } from '../src/office/scene/prefabs/architecture/elevatorController';
import { floorAt, floorY, officeNavigation, planRoute, seatStageId, withElevator } from '../src/office/scene/movement/navGraph';
import { createMover, MAX_WALK_SPEED, preferredElevator, routeFrom, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { ADMISSION_SPACING_MS, DEPARTURE_GRACE_MS, EMPTY_START_MS, ENTRY_SPACING_MS, floorPortals, MovementDirector, nearestPortal, SETTLE_MS, visibleOnFloor } from '../src/office/scene/movement/director';
import { createCharacterPositionStore } from '../src/office/scene/movement/positionStore';
import { FACILITY_NAV_RESOURCE_IDS } from '../src/office/scene/movement/facilityNpcs';
import { LEISURE_SPOTS } from '../src/office/scene/movement/leisureSpots';
import { advanceWalkDistance, advanceWalkPhase, angleDelta, createWalkPose, turnToward, walkingSpeed, writeWalkPose } from '../src/office/scene/movement/walkCycle';

const navigation = officeNavigation();
const agent = (id: string, extra: Partial<OfficeAgent> = {}): OfficeAgent => ({
  id, sessionId: id.split(':')[0]!, agentId: id.split(':')[1] ?? 'primary', displayName: id, control: 'managed', status: 'working', running: true, ...extra,
});
const seatAllocation = (agentId: string, seatId: string): OfficeAgentAllocation => {
  const seat = getOfficeSeats().find(candidate => candidate.id === seatId)!;
  return { ...seat, agentId, resourceId: seat.id };
};

/** A cab model good enough for the rider state machine: it boards at once and travels 2 m/s. */
function fakeElevators() {
  const rides = new Map<string, { from: number; to: number; id: ElevatorId; y: number; boarded: boolean }>();
  const access: ElevatorAccess = {
    request: (riderId, from, to, id) => { if (!rides.has(riderId)) rides.set(riderId, { from, to, id, y: floorY(from), boarded: false }); },
    waitingSlot: () => 0,
    canBoard: riderId => Boolean(rides.get(riderId) && !rides.get(riderId)!.boarded),
    standingPosition: (riderId, id) => {
      const ride = rides.get(riderId);
      const lift = GLASS_ELEVATORS.find(entry => entry.id === id)!;
      return ride ? [lift.x + 0.675, ride.y, lift.z - 0.9] : null;
    },
    confirmBoarded: riderId => { const ride = rides.get(riderId); if (!ride) return false; ride.boarded = true; return true; },
    canExit: riderId => { const ride = rides.get(riderId); return Boolean(ride?.boarded && ride.y === floorY(ride.to as 1 | 2 | 3)); },
    confirmExited: riderId => rides.delete(riderId),
    release: riderId => { rides.delete(riderId); },
    door: id => { const lift = GLASS_ELEVATORS.find(entry => entry.id === id)!; return { x: lift.doorX, z: lift.z }; },
  };
  const advance = (seconds: number) => {
    for (const ride of rides.values()) {
      if (!ride.boarded) continue;
      const target = floorY(ride.to as 1 | 2 | 3);
      const step = 2 * seconds;
      ride.y = Math.abs(target - ride.y) <= step ? target : ride.y + Math.sign(target - ride.y) * step;
    }
  };
  return { access, advance, rides };
}

function harness() {
  let now = 0;
  const lifts = fakeElevators();
  const env: MovementEnv = { navigation, elevators: lifts.access };
  const director = new MovementDirector(env, () => now);
  const gaitOf = () => gaitParameters();
  const run = (seconds: number, onFrame?: () => void) => {
    for (let t = 0; t < seconds; t += 1 / 30) { now += 1000 / 30; lifts.advance(1 / 30); director.tick(1 / 30); onFrame?.(); }
  };
  return { director, lifts, run, gaitOf, at: (ms: number) => { now = ms; }, get now() { return now; } };
}

describe('director door cleanup', () => {
  it.each(['remove', 'dispose'] as const)('releases the door operator and closing duty on %s', cleanup => {
    const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 1.2, height: 2.55, openAngle: -Math.PI / 2, sliding: false };
    const doors = new DoorTraffic({ forEachDoor: visit => visit('door', door), forEachWalker() {} }, () => 0);
    const director = new MovementDirector({ navigation, elevators: fakeElevators().access, doors }, () => 0);
    const agents = [agent('a:primary')];
    director.update({ allocations: allocateOfficeAgents(agents), agents, reducedMotion: false, gaitOf: () => gaitParameters() });
    const mover = director.list[0]!;
    mover.phase = 'doorwork';
    mover.door = { kind: 'close', id: 'door', door, timer: 0, beat: 'swing', side: 1, entrySide: -1, hand: 1, path: null };
    doors.hold('door', mover.id, 1, 1);
    doors.moved(mover.id, [0, 0, -0.4], [0, 0, 0.4]);
    expect(doors.claim('door', 'next')).toBe(false);
    expect(doors.duty(mover.id)).not.toBeNull();

    if (cleanup === 'dispose') director.dispose();
    else director.update({ allocations: [], agents: [], reducedMotion: true, gaitOf: () => gaitParameters() });

    expect(doors.claim('door', 'next')).toBe(true);
    expect(doors.duty(mover.id)).toBeNull();
  });
});

describe('office walking graph', () => {
  it('joins every workstation to an aisle of its own room and reaches it from the entrance and back', () => {
    const seats = getOfficeSeats();
    // Agent seats plus the facility staff stations and break spots, and the idle characters' leisure furniture and chat spots.
    expect(navigation.seats.size).toBe(new Set([...seats.map(seat => seat.id), ...FACILITY_NAV_RESOURCE_IDS, ...LEISURE_SPOTS.map(spot => spot.id)]).size);
    for (const seat of navigation.seats.values()) {
      if (seat.roomId === 'chat') {
        expect(planRoute(navigation.entryId, seatStageId(seat.seatId)), seat.seatId).not.toBeNull();
        continue;
      }
      const attach = navigation.waypoints.get(`seat:${seat.seatId}:aisle`)!.position;
      expect(Math.hypot(attach[0] - seat.staging[0], attach[2] - seat.staging[2]), seat.seatId).toBeLessThan(2.6);
      const room = OFFICE_ROOMS.find(entry => entry.id === seat.roomId)!;
      expect(Math.abs(seat.staging[0] - room.center[0])).toBeLessThanOrEqual(room.size[0] / 2);
      expect(Math.abs(seat.staging[2] - room.center[2])).toBeLessThanOrEqual(room.size[1] / 2);
      expect(planRoute(navigation.entryId, seatStageId(seat.seatId)), seat.seatId).not.toBeNull();
      expect(planRoute(seatStageId(seat.seatId), navigation.entryId), seat.seatId).not.toBeNull();
    }
  });

  it('changes floors only by the stair lanes or a glass elevator, in the right direction', () => {
    for (const seat of navigation.seats.values()) {
      const route = planRoute(navigation.entryId, seatStageId(seat.seatId))!;
      const back = planRoute(seatStageId(seat.seatId), navigation.entryId)!;
      let y = 0;
      for (const step of route.steps) {
        if (step.kind === 'elevator') { expect(step.from).toBe(floorAt(y)); y = step.exit[1]; continue; }
        if (Math.abs(step.to[1] - y) > 1e-6) expect(step.stairs).toBe(true);
        y = step.to[1];
      }
      expect(y).toBeCloseTo((seat.floor - 1) * FLOOR_HEIGHT);
      // Going up never uses a down lane, and leaving never climbs an up lane.
      expect(route.nodeIds.some(id => /stairs-\d-\d\.down/.test(id))).toBe(false);
      expect(back.nodeIds.some(id => /stairs-\d-\d\.up/.test(id))).toBe(false);
    }
    const stairsTrip = planRoute(navigation.entryId, seatStageId('mission-control.station-2'))!;
    expect(stairsTrip.steps.some(step => step.kind === 'walk' && step.stairs)).toBe(true);
    const liftTrip = planRoute(navigation.entryId, seatStageId('multi-engine.station-2'))!;
    expect(liftTrip.steps.filter(step => step.kind === 'elevator')).toHaveLength(1);
    const other = withElevator(liftTrip.steps, 'B');
    const ride = other.find(step => step.kind === 'elevator')!;
    expect(ride.kind === 'elevator' && ride.elevatorId).toBe('B');
    expect(ride.node).toBe('f3.elevator-B');
    expect(other[other.indexOf(ride) - 1]!.node).toBe('f1.elevator-B');
    expect(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(id => preferredElevator(`session-${id}:primary`)))).toEqual(new Set(['A', 'B']));
  });

  it('never walks through a room wall except at its doorway', () => {
    type Wall = { a: [number, number]; b: [number, number]; gaps: [number, number][] };
    const layouts = { 1: F1_LAYOUT, 2: F2_LAYOUT, 3: F3_LAYOUT } as const;
    const extraDoors: Record<string, [number, number][]> = { engineering: [[11, -1.2], [-5, 8.6]] };
    const wallsOf = (floor: 1 | 2 | 3): Wall[] => {
      const walls: Wall[] = [];
      for (const [id, rect] of Object.entries(layouts[floor])) {
        if (id === 'lobby' || id === 'lounge') continue; // open plan
        const room = OFFICE_ROOMS.find(entry => entry.id === id && entry.floor === floor);
        const doors = [...(room ? [[room.door[0], room.door[2]] as [number, number]] : []), ...(extraDoors[id] ?? [])];
        const corners: [number, number][] = [[rect.west, rect.north], [rect.east, rect.north], [rect.east, rect.south], [rect.west, rect.south]];
        for (let i = 0; i < 4; i++) walls.push({ a: corners[i]!, b: corners[(i + 1) % 4]!, gaps: doors });
      }
      // Building envelope: lobby entrance and the elevator landings.
      const { west, east, north, south } = OFFICE_BUILDING;
      walls.push({ a: [west, north], b: [east, north], gaps: floor === 1 ? [[CAMPUS_ENTRY_LAYOUT.centerX, north]] : [] });
      walls.push({ a: [east, north], b: [east, south], gaps: [] });
      walls.push({ a: [west, south], b: [east, south], gaps: [] });
      walls.push({ a: [west, north], b: [west, south], gaps: [] });
      return walls;
    };
    const cross = (p: [number, number], q: [number, number], wall: Wall): [number, number] | null => {
      const r = [q[0] - p[0], q[1] - p[1]], s = [wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]];
      const denominator = r[0]! * s[1]! - r[1]! * s[0]!;
      if (Math.abs(denominator) < 1e-9) return null;
      const t = ((wall.a[0] - p[0]) * s[1]! - (wall.a[1] - p[1]) * s[0]!) / denominator;
      const u = ((wall.a[0] - p[0]) * r[1]! - (wall.a[1] - p[1]) * r[0]!) / denominator;
      return t >= -1e-9 && t <= 1 + 1e-9 && u > 1e-6 && u < 1 - 1e-6 ? [p[0] + r[0]! * t, p[1] + r[1]! * t] : null;
    };
    const crossings: string[] = [];
    for (const edge of navigation.edges) {
      const a = navigation.waypoints.get(edge.from)!.position, b = navigation.waypoints.get(edge.to)!.position;
      if (Math.abs(a[1] - b[1]) > 1e-6) continue;
      const floor = floorAt(a[1]);
      if (edge.from.startsWith('f1.entry') || edge.to.startsWith('f1.entry') || /elevator-[AB]$/.test(edge.from) && /elevator-[AB]$/.test(edge.to)) continue;
      for (const wall of wallsOf(floor)) {
        const hit = cross([a[0], a[2]], [b[0], b[2]], wall);
        if (hit && !wall.gaps.some(([x, z]) => Math.hypot(hit[0] - x, hit[1] - z) <= 0.75)) crossings.push(`${edge.from} → ${edge.to} at ${hit.map(v => v.toFixed(2))}`);
      }
    }
    expect(crossings).toEqual([]);
  });
});

describe('walk cycle', () => {
  it('derives the walking pace from stride length and cadence', () => {
    // Characters without a gait walk with the masculine profile (there is no neutral gait any more).
    const fallback = gaitParameters(), masculine = gaitParameters({ gait: 'masculine' }), feminine = gaitParameters({ gait: 'feminine' });
    expect(walkingSpeed(fallback)).toBeCloseTo(0.76 * 1.75);
    expect(walkingSpeed(masculine)).toBeCloseTo(masculine.strideLength * masculine.cadence);
    expect(walkingSpeed(feminine)).toBeLessThan(walkingSpeed(masculine));
    // One second advances `cadence` steps of π radians; walking backwards runs the cycle in reverse.
    expect(advanceWalkPhase(0, fallback, 0.5)).toBeCloseTo(0.5 * 1.75 * Math.PI);
    expect(advanceWalkPhase(0.1, fallback, 0.1, -1)).toBeCloseTo(((0.1 - 0.1 * 1.75 * Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2));
    for (let t = 0; t < 5; t += 0.37) {
      const phase = advanceWalkPhase(0, fallback, t);
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(Math.PI * 2);
    }
  });

  it('clocks short furniture-handling steps from distance, with no phase drift while stationary', () => {
    const gait=gaitParameters(), start=.7, step=gait.strideLength*.55;
    expect(advanceWalkDistance(start,gait,0,1,.55)).toBeCloseTo(start,12);
    expect(advanceWalkDistance(start,gait,step,1,.55)).toBeCloseTo(start+Math.PI,12);
    const back=advanceWalkDistance(start,gait,-step,1,.55);
    expect(advanceWalkDistance(back,gait,step,1,.55)).toBeCloseTo(start,12);
    let split=start;
    for(let i=0;i<60;i++)split=advanceWalkDistance(split,gait,-.8/60,1.3,.55);
    expect(split).toBeCloseTo(advanceWalkDistance(start,gait,-.8,1.3,.55),10);
  });

  it('swings legs and arms in opposition and rests at amount 0', () => {
    const gait = gaitParameters({ gait: 'feminine' });
    const pose = createWalkPose();
    writeWalkPose(pose, gait, 1.1, 0);
    expect([...pose.hip, ...pose.knee, ...pose.arm, pose.elbow, pose.pelvisShift, pose.pelvisRoll, pose.torsoTwist, pose.bob].every(value => Math.abs(value) < 1e-12)).toBe(true);
    for (let phase = 0; phase < Math.PI * 2; phase += 0.4) {
      writeWalkPose(pose, gait, phase, 1);
      expect(pose.hip[0]).toBeCloseTo(-pose.hip[1]);
      expect(pose.arm[0]).toBeCloseTo(-pose.arm[1]);
      // Left leg forward (negative) goes with the left arm back (positive).
      if (Math.abs(pose.hip[0]) > 1e-6) expect(Math.sign(pose.arm[0])).toBe(-Math.sign(pose.hip[0]));
      expect(pose.knee[0]).toBeGreaterThanOrEqual(0);
      expect(Math.abs(pose.arm[0])).toBeLessThanOrEqual(gait.armSwing + 1e-9);
      expect(Math.abs(pose.pelvisShift)).toBeLessThanOrEqual(gait.hipSway + 1e-9);
    }
    const longer = createWalkPose();
    writeWalkPose(longer, gaitParameters({ gait: 'masculine' }), Math.PI / 2, 1);
    writeWalkPose(pose, gaitParameters({ gait: 'feminine' }), Math.PI / 2, 1);
    expect(Math.abs(longer.hip[0])).toBeGreaterThan(Math.abs(pose.hip[0]));
  });

  it('turns smoothly along the shortest way', () => {
    expect(angleDelta(3, -3)).toBeCloseTo(Math.PI * 2 - 6);
    expect(turnToward(0, 2, 4, 0.1)).toBeCloseTo(0.4);
    // Across ±π: a short turn, not a full spin.
    expect(angleDelta(turnToward(3.1, -3.1, 4, 0.1), -3.1)).toBeCloseTo(0);
    expect(angleDelta(3.1, turnToward(3.1, -2.5, 4, 0.1))).toBeCloseTo(0.4);
    expect(turnToward(1, 1.05, 4, 0.1)).toBe(1.05);
  });
});

describe('arrival and departure', () => {
  it('seats presences that are there when the Office opens, without walking', () => {
    const h = harness();
    const agents = [agent('a:primary'), agent('b:primary')];
    h.director.update({ allocations: allocateOfficeAgents(agents), agents, reducedMotion: false, gaitOf: h.gaitOf });
    h.run(2);
    expect(h.director.list.map(mover => mover.phase)).toEqual(['seated', 'seated']);
    expect(h.director.moving('a:primary')).toBe(false);
  });

  it('walks the first presence in when the Office has been open and empty', () => {
    const h = harness();
    h.director.update({ allocations: [], agents: [], reducedMotion: false, gaitOf: h.gaitOf });
    h.at(EMPTY_START_MS + 1);
    const agents = [agent('a:primary')];
    h.director.update({ allocations: allocateOfficeAgents(agents), agents, reducedMotion: false, gaitOf: h.gaitOf });
    h.run(1 / 30);
    expect(h.director.moving('a:primary')).toBe(true);
  });

  it('walks a new presence in from the entrance to its seat and sits down', () => {
    const h = harness();
    const first = [agent('a:primary')];
    h.director.update({ allocations: allocateOfficeAgents(first), agents: first, reducedMotion: false, gaitOf: h.gaitOf });
    h.at(SETTLE_MS + 1);
    const agents = [...first, agent('b:primary')];
    const allocations = allocateOfficeAgents(agents, allocateOfficeAgents(first));
    h.director.update({ allocations, agents, reducedMotion: false, gaitOf: h.gaitOf });
    const entry = navigation.waypoints.get(navigation.entryId)!.position;
    // It appears at the entrance on the next frame.
    expect(h.director.position('b:primary')).toBeUndefined();
    h.run(1 / 30);
    const start = h.director.position('b:primary')!;
    expect(Math.hypot(start[0] - entry[0], start[2] - entry[2])).toBeLessThan(0.1);
    expect(h.director.moving('b:primary')).toBe(true);
    const seat = navigation.seats.get(allocations.find(item => item.agentId === 'b:primary')!.resourceId)!;
    let maxStep = 0, previous: Point3 = [...h.director.position('b:primary')!] as Point3;
    // A second lead takes the executive leader desk on F2 (seating policy), a longer walk than an F1 pod.
    h.run(150, () => {
      const now = h.director.position('b:primary')!;
      maxStep = Math.max(maxStep, Math.hypot(now[0] - previous[0], now[2] - previous[2]));
      previous = [now[0], now[1], now[2]];
    });
    expect(h.director.list.find(mover => mover.id === 'b:primary')!.phase).toBe('seated');
    expect(h.director.position('b:primary')).toEqual(seat.seat);
    // Never faster than a hurried walk per frame.
    expect(maxStep).toBeLessThanOrEqual(MAX_WALK_SPEED / 30 + 1e-9);
  });

  it('lets simultaneous arrivals through the entrance one after another', () => {
    const h = harness();
    h.director.update({ allocations: allocateOfficeAgents([agent('a:primary')]), agents: [agent('a:primary')], reducedMotion: false, gaitOf: h.gaitOf });
    h.at(SETTLE_MS + 1);
    const agents = ['a', 'b', 'c', 'd'].map(id => agent(`${id}:primary`));
    h.director.update({ allocations: allocateOfficeAgents(agents, allocateOfficeAgents(agents.slice(0, 1))), agents, reducedMotion: false, gaitOf: h.gaitOf });
    const appeared: Record<string, number> = {};
    h.run(6, () => { for (const id of ['b', 'c', 'd']) if (appeared[id] === undefined && h.director.position(`${id}:primary`)) appeared[id] = h.now; });
    expect(Object.keys(appeared).sort()).toEqual(['b', 'c', 'd']);
    const times = Object.values(appeared).sort((x, y) => x - y);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(ENTRY_SPACING_MS - 40);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(ENTRY_SPACING_MS - 40);
  });

  it('waits out brief disappearances, then stands up and walks out of the building', () => {
    const h = harness();
    const agents = [agent('a:primary'), agent('b:primary')];
    const allocations = allocateOfficeAgents(agents);
    h.director.update({ allocations, agents, reducedMotion: false, gaitOf: h.gaitOf });
    h.at(SETTLE_MS + 1);
    // History reloads can drop a presence for a moment: nobody moves.
    h.director.update({ allocations: allocations.slice(0, 1), agents: agents.slice(0, 1), reducedMotion: false, gaitOf: h.gaitOf });
    h.run(DEPARTURE_GRACE_MS / 2000);
    h.director.update({ allocations, agents, reducedMotion: false, gaitOf: h.gaitOf });
    h.run(DEPARTURE_GRACE_MS / 1000 + 1);
    expect(h.director.list.every(mover => mover.phase === 'seated')).toBe(true);
    // Gone for good: stand up after the grace period and leave through the lobby door.
    const versions: number[] = [];
    h.director.subscribe(() => versions.push(h.director.version()));
    h.director.update({ allocations: allocations.slice(0, 1), agents: agents.slice(0, 1), reducedMotion: false, gaitOf: h.gaitOf });
    h.run(DEPARTURE_GRACE_MS / 1000 - 0.2);
    expect(h.director.list.find(mover => mover.id === 'b:primary')!.phase).toBe('seated');
    let passedDoor = false;
    // Leads sit upstairs in the executive rooms, so the walk out takes longer than from an F1 pod.
    h.run(150, () => {
      const position = h.director.position('b:primary');
      if (position && Math.abs(position[2] - CAMPUS_ENTRY_LAYOUT.lobbyDoorZ) < 0.05 && Math.abs(position[0]) < 1) passedDoor = true;
    });
    expect(passedDoor).toBe(true);
    expect(h.director.roster().map(entry => entry.mover.id)).toEqual(['a:primary']);
    expect(h.director.position('b:primary')).toBeUndefined();
    expect(versions.length).toBeGreaterThan(0);
  });

  it('picks the arrival and exit point of a floor nearest to a desk: the entrance, an elevator or the stairs', () => {
    expect(floorPortals(navigation, 1)).toContain(navigation.entryId);
    for (const floor of [2, 3] as const) expect(floorPortals(navigation, floor)).not.toContain(navigation.entryId);
    const seats = [...navigation.seats.values()].filter(seat => getOfficeSeats().some(desk => desk.id === seat.seatId));
    const used = new Set<string>();
    for (const seat of seats) {
      const floor = floorAt(seat.seat[1]);
      const portal = nearestPortal(navigation, floor, seatStageId(seat.seatId));
      expect(portal, seat.seatId).not.toBeNull();
      expect(floorPortals(navigation, floor)).toContain(portal);
      // Stable, and the same point serves as the exit from that desk.
      expect(nearestPortal(navigation, floor, seatStageId(seat.seatId))).toBe(portal);
      expect(floorPortals(navigation, floor)).toContain(nearestPortal(navigation, floor, seatStageId(seat.seatId), true));
      // Nearest: no other portal of the floor is a shorter walk.
      const cost = planRoute(portal!, seatStageId(seat.seatId))!.cost;
      for (const other of floorPortals(navigation, floor)) {
        const route = planRoute(other, seatStageId(seat.seatId));
        if (route && !route.steps.some(step => step.kind === 'elevator' || (step.kind === 'walk' && step.stairs))) expect(route.cost).toBeGreaterThanOrEqual(cost - 1e-9);
      }
      used.add(portal!);
    }
    // Desks near the lobby use the entrance; others the elevators or the stairs.
    expect(used.has(navigation.entryId)).toBe(true);
    expect([...used].some(id => id.includes('elevator') || id.includes('stairs'))).toBe(true);
  });

  it('brings a subagent in at its floor\'s arrival point and lets it leave through the nearest exit, never back into its lead', () => {
    const h = harness();
    const lead = agent('s:primary');
    h.director.update({ allocations: allocateOfficeAgents([lead]), agents: [lead], reducedMotion: false, gaitOf: h.gaitOf });
    h.at(SETTLE_MS + 1);
    const worker = agent('s:worker-1', { parentId: 's:primary' });
    const allocations = allocateOfficeAgents([lead, worker], allocateOfficeAgents([lead]));
    h.director.update({ allocations, agents: [lead, worker], reducedMotion: false, gaitOf: h.gaitOf });
    const leadSeat = navigation.seats.get(allocations.find(item => item.agentId === lead.id)!.resourceId)!;
    const seat = navigation.seats.get(allocations.find(item => item.agentId === worker.id)!.resourceId)!;
    const floor = floorAt(seat.seat[1]);
    const arrival = navigation.waypoints.get(nearestPortal(navigation, floor, seatStageId(seat.seatId))!)!.position;
    // Admitted through the spawn queue on the next frame, at the arrival point, fading in.
    expect(h.director.position(worker.id)).toBeUndefined();
    h.run(1 / 30);
    const start = h.director.position(worker.id)!;
    expect(Math.hypot(start[0] - arrival[0], start[1] - arrival[1], start[2] - arrival[2])).toBeLessThan(0.1);
    const mover = () => h.director.list.find(entry => entry.id === worker.id)!;
    expect(mover().opacity).toBeLessThan(1);
    h.run(150);
    expect(mover().phase).toBe('seated');
    expect(mover().opacity).toBe(1);
    expect(h.director.position(worker.id)).toEqual(seat.seat);

    // Its work and linger are over (presence removed it): it walks to its floor's exit and fades out there.
    h.director.update({ allocations: allocations.filter(item => item.agentId === lead.id), agents: [lead], reducedMotion: false, gaitOf: h.gaitOf });
    let closestToLead = Infinity, last: Point3 | null = null, vanished = false, fade = 1;
    h.run(150, () => {
      const position = h.director.position(worker.id);
      const current = h.director.list.find(entry => entry.id === worker.id);
      if (current?.phase === 'vanishing') { vanished = true; fade = Math.min(fade, current.opacity); }
      if (position) {
        closestToLead = Math.min(closestToLead, Math.hypot(position[0] - leadSeat.staging[0], position[1] - leadSeat.staging[1], position[2] - leadSeat.staging[2]));
        last = [position[0], position[1], position[2]];
      }
    });
    expect(h.director.position(worker.id)).toBeUndefined();
    expect(vanished).toBe(true);
    expect(fade).toBeLessThan(0.2);
    const exits = floorPortals(navigation, floor).map(id => navigation.waypoints.get(id)!.position);
    expect(Math.min(...exits.map(exit => Math.hypot(exit[0] - last![0], exit[1] - last![1], exit[2] - last![2])))).toBeLessThan(0.05);
    expect(closestToLead).toBeGreaterThan(1);
  });

  it('admits at most about three arrivals per second, spaced per arrival point', () => {
    const h = harness();
    const lead = agent('s:primary');
    h.director.update({ allocations: allocateOfficeAgents([lead]), agents: [lead], reducedMotion: false, gaitOf: h.gaitOf });
    h.at(SETTLE_MS + 1);
    const crowd = [lead, ...Array.from({ length: 8 }, (_, index) => agent(`s:w${index}`, { parentId: 's:primary' }))];
    const allocations = allocateOfficeAgents(crowd, allocateOfficeAgents([lead]));
    h.director.update({ allocations, agents: crowd, reducedMotion: false, gaitOf: h.gaitOf });
    const appeared = new Map<string, number>();
    h.run(15, () => { for (const entry of crowd.slice(1)) if (!appeared.has(entry.id) && h.director.position(entry.id)) appeared.set(entry.id, h.now); });
    expect(appeared.size).toBe(8);
    const times = [...appeared.values()].sort((a, b) => a - b);
    for (let index = 1; index < times.length; index++) expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(ADMISSION_SPACING_MS - 40);
    for (const time of times) expect(times.filter(other => other >= time && other < time + 1000).length).toBeLessThanOrEqual(3);
    // Two arrivals at the same point never overlap.
    const byPoint = new Map<string, number[]>();
    for (const entry of crowd.slice(1)) {
      const seat = navigation.seats.get(allocations.find(item => item.agentId === entry.id)!.resourceId)!;
      const point = nearestPortal(navigation, floorAt(seat.seat[1]), seatStageId(seat.seatId))!;
      byPoint.set(point, [...(byPoint.get(point) ?? []), appeared.get(entry.id)!].sort((a, b) => a - b));
    }
    for (const list of byPoint.values()) for (let index = 1; index < list.length; index++) expect(list[index]! - list[index - 1]!).toBeGreaterThanOrEqual(ENTRY_SPACING_MS - 40);
  });

  it('rides a glass elevator through the controller to an upper floor', () => {
    const h = harness();
    h.director.update({ allocations: [], agents: [], reducedMotion: false, gaitOf: h.gaitOf });
    const first = agent('z:primary');
    h.director.update({ allocations: [seatAllocation(first.id, 'research.laptop-1')], agents: [first], reducedMotion: false, gaitOf: h.gaitOf });
    // Settled on load; a later visitor bound for floor 3 walks.
    h.at(SETTLE_MS + 1);
    const visitor = agent('v:primary');
    const allocations = [seatAllocation(first.id, 'research.laptop-1'), seatAllocation(visitor.id, 'multi-engine.station-2')];
    h.director.update({ allocations, agents: [first, visitor], reducedMotion: false, gaitOf: h.gaitOf });
    const phases = new Set<string>();
    const floors = new Set<string>();
    h.run(120, () => {
      const mover = h.director.list.find(entry => entry.id === visitor.id)!;
      phases.add(mover.phase);
      floors.add(`${mover.floorLow}-${mover.floorHigh}`);
      if (mover.phase === 'riding') expect(visibleOnFloor(mover, 2) || mover.position[1] < 5.9 || mover.position[1] > 6.9).toBe(true);
    });
    const mover = h.director.list.find(entry => entry.id === visitor.id)!;
    expect(['waiting', 'boarding', 'riding', 'alighting'].every(phase => phases.has(phase))).toBe(true);
    expect(floors.has('1-3')).toBe(true);
    expect(mover.phase).toBe('seated');
    expect(mover.position[1]).toBeCloseTo(2 * FLOOR_HEIGHT);
    expect(h.lifts.rides.size).toBe(0);
  });

  it('walks to a changed seat only after the change has settled, and turns back when a presence returns', () => {
    const h = harness();
    const a = agent('a:primary');
    h.director.update({ allocations: [seatAllocation(a.id, 'engineering.pod-a.seat-se')], agents: [a], reducedMotion: false, gaitOf: h.gaitOf });
    h.at(SETTLE_MS + 1);
    h.director.update({ allocations: [seatAllocation(a.id, 'engineering.pod-b.seat-se')], agents: [a], reducedMotion: false, gaitOf: h.gaitOf });
    h.run(DEPARTURE_GRACE_MS / 1000 - 0.2);
    expect(h.director.list[0]!.phase).toBe('seated');
    h.run(30);
    expect(h.director.position(a.id)).toEqual(navigation.seats.get('engineering.pod-b.seat-se')!.seat);
    // Leaves, then comes back while walking out: it turns around and sits again.
    h.director.update({ allocations: [], agents: [], reducedMotion: false, gaitOf: h.gaitOf });
    h.run(DEPARTURE_GRACE_MS / 1000 + 3);
    expect(h.director.moving(a.id)).toBe(true);
    h.director.update({ allocations: [seatAllocation(a.id, 'engineering.pod-b.seat-se')], agents: [a], reducedMotion: false, gaitOf: h.gaitOf });
    h.run(30);
    expect(h.director.list[0]!.phase).toBe('seated');
  });

  it('dispatches a character to the Library/Skills workstation when updating skills and returns to desk when done', () => {
    const h = harness();
    const a = agent('a:primary');
    h.director.update({ allocations: allocateOfficeAgents([a]), agents: [a], reducedMotion: false, gaitOf: h.gaitOf });
    h.at(SETTLE_MS + 1);
    const homeSeat = h.director.position(a.id);

    // Agent begins skill task (toolName = 'skill_manage')
    const skillAgent = { ...a, toolName: 'skill_manage', activity: 'knowledge' as const, status: 'working' as const };
    h.director.update({ allocations: allocateOfficeAgents([a]), agents: [skillAgent], reducedMotion: false, gaitOf: h.gaitOf });
    h.run(120);
    const librarySeat = navigation.seats.get('library.laptop')!;
    expect(h.director.position(a.id)).toEqual(librarySeat.seat);

    // Agent finishes skill task, returns to idle
    const doneAgent = { ...a, toolName: undefined, activity: undefined, status: 'idle' as const };
    h.director.update({ allocations: allocateOfficeAgents([a]), agents: [doneAgent], reducedMotion: false, gaitOf: h.gaitOf });
    h.run(120);
    expect(h.director.position(a.id)).toEqual(homeSeat);
  });

  it('appears and disappears at the seat with reduced motion', () => {
    const h = harness();
    const a = agent('a:primary'), b = agent('b:primary');
    h.director.update({ allocations: allocateOfficeAgents([a]), agents: [a], reducedMotion: true, gaitOf: h.gaitOf });
    h.at(SETTLE_MS * 4);
    const allocations = allocateOfficeAgents([a, b], allocateOfficeAgents([a]));
    h.director.update({ allocations, agents: [a, b], reducedMotion: true, gaitOf: h.gaitOf });
    expect(h.director.list.find(mover => mover.id === b.id)!.phase).toBe('seated');
    h.director.update({ allocations: allocations.slice(0, 1), agents: [a], reducedMotion: true, gaitOf: h.gaitOf });
    expect(h.director.position(b.id)).toBeUndefined();
    // Switching reduced motion on mid-walk snaps walkers to their seats.
    h.director.update({ allocations, agents: [a, b], reducedMotion: false, gaitOf: h.gaitOf });
    h.run(2);
    expect(h.director.moving(b.id)).toBe(true);
    h.director.update({ allocations, agents: [a, b], reducedMotion: true, gaitOf: h.gaitOf });
    expect(h.director.moving(b.id)).toBe(false);
  });

  it('steps a mover without allocating new tuples', () => {
    const lifts = fakeElevators();
    const env: MovementEnv = { navigation, elevators: lifts.access };
    const mover = createMover('m', gaitParameters(), navigation.waypoints.get(navigation.entryId)!.position as Point3, 0, false);
    const seat = navigation.seats.get('engineering.pod-b.seat-sw')!;
    expect(routeFrom(mover, navigation.entryId, { kind: 'seat', seat }, env, false)).toBe(true);
    const position = mover.position, motion = mover.motion;
    for (let i = 0; i < 300; i++) stepMover(mover, 1 / 60, env);
    expect(mover.position).toBe(position);
    expect(mover.motion).toBe(motion);
  });
});

describe('seat allocation and live positions', () => {
  it('keeps existing characters at their desks when someone new arrives', () => {
    const before = [agent('m:primary'), agent('t:primary')];
    const previous = allocateOfficeAgents(before);
    const after = [...before, agent('a:primary')];
    const fresh = allocateOfficeAgents(after);
    const sticky = allocateOfficeAgents(after, previous);
    // Sorting alone would shuffle desks; the previous allocation keeps them.
    expect(fresh.find(item => item.agentId === 'm:primary')!.resourceId).not.toBe(previous.find(item => item.agentId === 'm:primary')!.resourceId);
    for (const kept of previous) expect(sticky.find(item => item.agentId === kept.agentId)!.resourceId).toBe(kept.resourceId);
    expect(new Set(sticky.map(item => item.resourceId)).size).toBe(3);
    // A freed desk is reused by the next arrival.
    const left = allocateOfficeAgents([after[1]!, after[2]!], sticky);
    const next = allocateOfficeAgents([...left.map(item => after.find(entry => entry.id === item.agentId)!), agent('z:primary')], left);
    expect(next.find(item => item.agentId === 'z:primary')!.resourceId).toBe(sticky.find(item => item.agentId === 'm:primary')!.resourceId);
  });

  it('exposes live positions through a page-owned store', () => {
    const h = harness();
    const store = createCharacterPositionStore();
    expect(store.position('a:primary')).toBeUndefined();
    let notified = 0;
    store.subscribe(() => notified++);
    store.bind(h.director);
    const a = agent('a:primary');
    h.director.update({ allocations: allocateOfficeAgents([a]), agents: [a], reducedMotion: false, gaitOf: h.gaitOf });
    expect(store.position('a:primary')).toEqual(navigation.seats.get(allocateOfficeAgents([a])[0]!.resourceId)!.seat);
    // A lone lead agent sits at the CEO desk in the F3 executive studio (seating policy).
    expect(store.floor('a:primary')).toBe(3);
    expect(notified).toBeGreaterThan(0);
    store.bind(null);
    expect(store.position('a:primary')).toBeUndefined();
  });
});
