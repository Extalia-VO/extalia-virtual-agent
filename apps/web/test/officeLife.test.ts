import { describe, expect, it } from 'vitest';
import type { OfficeAgent } from '../src/office/presence';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { createActivityPose, isSeatedClip, stepClipDriver, createClipDriver, writeActivityPose, type ActivityClip } from '../src/office/scene/avatars/activityPose';
import { deskClip, deskMode, isBusy, RUN_TYPING_SECONDS } from '../src/office/scene/movement/workClip';
import { chatSpeaker, chooseLeisureKind, chooseSpot, createRoutine, LINGER_MAX_MS, LINGER_MIN_MS, lingerMs, OUTING_MAX_MS, OUTING_MIN_MS, outingMs,
  pickChatPartner, pickChatPlace, stepRoutine, visitMs } from '../src/office/scene/movement/idleRoutine';
import { CHAT_SPOT_PAIRS, chatSpotIds, LEISURE_SPOTS } from '../src/office/scene/movement/leisureSpots';
import { createCalloutStore, CALLOUT_MS, pickCallout } from '../src/office/scene/callouts';
import { chairOffset, DeskChairMotion, isDeskChair } from '../src/office/scene/interior/deskChairs';
import { getOfficeSeats, type OfficeAgentAllocation } from '../src/office/scene/interior/seating';
import { FACILITY_NAV_RESOURCE_IDS, FACILITY_RESERVED_RESOURCE_IDS } from '../src/office/scene/movement/facilityNpcs';
import { officeNavigation } from '../src/office/scene/movement/navGraph';
import { MovementDirector } from '../src/office/scene/movement/director';
import type { ElevatorAccess, MovementEnv } from '../src/office/scene/movement/mover';
import { MESSAGES } from '../src/i18n';

const navigation = officeNavigation();

describe('activity poses', () => {
  it('fills every clip with finite offsets and leaves the base pose for none', () => {
    const clips: ActivityClip[] = ['none', 'desk-idle', 'typing', 'mouse', 'read-screen', 'thinking', 'lean-back', 'watch-output', 'stretch', 'sip',
      'lounge', 'watch-tv', 'cycle', 'chat-talk', 'chat-listen', 'jog', 'lift', 'yoga', 'arcade', 'foosball', 'look-around'];
    for (const clip of clips) for (const time of [0, 1.7, 33.3]) {
      const pose = writeActivityPose(createActivityPose(), clip, time, 0.4, 1.1);
      for (const value of [pose.torsoPitch, pose.headPitch, pose.headYaw, ...pose.arm, ...pose.elbow, ...pose.wrist, ...pose.thigh, ...pose.knee, pose.bob]) expect(Number.isFinite(value)).toBe(true);
    }
    expect(writeActivityPose(createActivityPose(), 'none', 3)).toEqual(createActivityPose());
    // Thinking raises the dominant hand to the chin; lean-back reclines.
    expect(writeActivityPose(createActivityPose(), 'thinking', 2).elbow[1]).toBeLessThan(-1.2);
    expect(writeActivityPose(createActivityPose(), 'lean-back', 2).torsoPitch).toBeLessThan(-0.1);
  });

  it('weights seated clips by the sit blend and standing clips by standing still', () => {
    const settle = (clip: ActivityClip, sit: number, walk: number) => {
      const driver = createClipDriver();
      for (let i = 0; i < 120; i++) stepClipDriver(driver, clip, 2, 1 / 30, sit, walk, 0, 1);
      return driver.shown;
    };
    expect(isSeatedClip('typing')).toBe(true);
    expect(isSeatedClip('chat-talk')).toBe(false);
    expect(settle('thinking', 0, 0).elbow[1]).toBeCloseTo(0, 3);
    expect(settle('thinking', 1, 0).elbow[1]).toBeLessThan(-1);
    expect(settle('chat-talk', 0, 1).arm[0]).toBeCloseTo(0, 3);
  });
});

describe('desk work clips follow the reported activity', () => {
  const at = (mode: Parameters<typeof deskClip>[0], seed = 7) => new Set(Array.from({ length: 240 }, (_, i) => deskClip(mode, i, seed)));

  it('maps activity kinds and statuses to desk modes; observed sessions without recent events are idle', () => {
    expect(deskMode({ status: 'working', activity: 'edit' })).toBe('edit');
    expect(deskMode({ status: 'working', activity: 'search' })).toBe('read');
    expect(deskMode({ status: 'working', activity: 'test' })).toBe('run');
    expect(deskMode({ status: 'thinking' })).toBe('think');
    expect(deskMode({ status: 'waiting', pendingApprovalId: 'p' })).toBe('wait');
    expect(deskMode({ status: 'idle' })).toBe('idle');
    expect(isBusy({ status: 'working', control: 'observed', live: false })).toBe(false);
    expect(isBusy({ status: 'working', control: 'observed', live: true })).toBe(true);
    expect(isBusy({ status: 'idle', pendingApprovalId: 'p' })).toBe(true);
  });

  it('edits type, reads scroll, thinking thinks, commands type then watch, idle never types', () => {
    expect(at('edit').has('typing')).toBe(true);
    expect(at('read').has('mouse')).toBe(true);
    expect(at('read').has('read-screen')).toBe(true);
    expect(at('think').has('thinking')).toBe(true);
    expect(deskClip('run', 100, 3, RUN_TYPING_SECONDS - 1)).toBe('typing');
    expect(at('run').has('watch-output')).toBe(true);
    expect(at('idle').has('typing')).toBe(false);
    // Deterministic, and two characters are not in lockstep.
    expect(deskClip('edit', 50, 11)).toBe(deskClip('edit', 50, 11));
    expect(Array.from({ length: 200 }, (_, i) => deskClip('edit', i, 1) === deskClip('edit', i, 99999)).some(same => !same)).toBe(true);
  });
});

describe('idle routine', () => {
  it('stays seated 1–5 minutes after work, then walks about 6–15 minutes, per character and turn', () => {
    for (const id of ['a', 'b:primary', 'session-9:member-2']) for (const turn of [0, 1, 5]) {
      expect(lingerMs(id, turn)).toBeGreaterThanOrEqual(LINGER_MIN_MS);
      expect(lingerMs(id, turn)).toBeLessThanOrEqual(LINGER_MAX_MS);
      expect(outingMs(id, turn)).toBeGreaterThanOrEqual(OUTING_MIN_MS);
      expect(outingMs(id, turn)).toBeLessThanOrEqual(OUTING_MAX_MS);
      expect(lingerMs(id, turn)).toBe(lingerMs(id, turn));
    }
    expect(new Set([0, 1, 2, 3].map(turn => lingerMs('a', turn))).size).toBeGreaterThan(1);
    expect(visitMs('a', 0, 0, 'chat')).toBeLessThan(visitMs('a', 0, 0, 'tv') + 200_000);
  });

  it('lingers from the moment it sits, goes out, comes back, and real work always wins', () => {
    const routine = createRoutine('x');
    const step = (now: number, extra: Partial<Parameters<typeof stepRoutine>[1]> = {}) => stepRoutine(routine, { now, busy: false, atDesk: true, allowed: true, ...extra });
    expect(step(0, { atDesk: false })).toBe('desk');
    expect(routine.lingerUntil).toBeNull();
    expect(step(1000)).toBe('desk');
    const linger = routine.lingerUntil!;
    expect(linger - 1000).toBe(lingerMs('x', 0));
    expect(step(linger - 1)).toBe('desk');
    expect(step(linger)).toBe('out');
    expect(step(linger + 1000, { atDesk: false })).toBe('out');
    // Work arrives mid walk-about: back to the desk at once.
    expect(step(linger + 2000, { busy: true, atDesk: false })).toBe('desk');
    expect(routine.phase).toBe('busy');
    // Done again: a new turn, lingering only once seated.
    expect(step(linger + 3000, { atDesk: false })).toBe('desk');
    expect(routine.turn).toBe(1);
    expect(routine.lingerUntil).toBeNull();
    // Reduced motion (not allowed) keeps everyone at the desk.
    const still = createRoutine('y');
    for (let t = 0; t < 2_000_000; t += 10_000) expect(stepRoutine(still, { now: t, busy: false, atDesk: true, allowed: false })).toBe('desk');
  });

  it('picks a free place of an available kind, preferring variety, and never a desk or a staff spot', () => {
    const routine = { id: 'a', turn: 0, visits: 0, lastKind: 'tv' as const };
    expect(chooseLeisureKind(routine, new Set(['tv', 'fitness']))).toBe('fitness');
    expect(chooseLeisureKind(routine, new Set(['tv']))).toBe('tv');
    expect(chooseLeisureKind(routine, new Set())).toBeNull();
    const desks = new Set(getOfficeSeats().map(seat => seat.id));
    for (const spot of LEISURE_SPOTS) {
      expect(desks.has(spot.id), spot.id).toBe(false);
      expect(FACILITY_NAV_RESOURCE_IDS.has(spot.id) || FACILITY_RESERVED_RESOURCE_IDS.has(spot.id), spot.id).toBe(false);
      expect(navigation.seats.has(spot.id), spot.id).toBe(true);
    }
    for (const kind of ['chat', 'fitness', 'tv', 'game', 'terrace', 'lounge', 'pantry', 'garden'] as const) expect(LEISURE_SPOTS.some(spot => spot.kind === kind), kind).toBe(true);
    const fitness = LEISURE_SPOTS.filter(spot => spot.kind === 'fitness');
    const taken = new Set(fitness.slice(1).map(spot => spot.id));
    expect(chooseSpot(LEISURE_SPOTS, 'fitness', taken, routine, 1)?.id).toBe(fitness[0]!.id);
    expect(chooseSpot(LEISURE_SPOTS, 'fitness', new Set(fitness.map(spot => spot.id)), routine, 1)).toBeNull();
  });

  it('offers both seated strength stations with their supported activity clips and seated navigation anchors', () => {
    for (const [id, clip] of [['fitness.weight-bench', 'bench-curl'], ['fitness.cable-row', 'cable-row']] as const) {
      expect(LEISURE_SPOTS.find(spot => spot.id === id)).toMatchObject({ kind: 'fitness', floor: 3, clip });
      const seat = navigation.seats.get(id)!;
      expect(seat, id).toBeDefined();
      expect(seat.standing, id).not.toBe(true);
      expect(seat.seatHeight, id).toBeGreaterThan(0.4);
    }
  });

  it('pairs idle characters for a chat on facing spots and alternates who speaks', () => {
    expect(pickChatPartner({ id: 'a', floor: 1, turn: 0 }, [
      { id: 'a', floor: 1, available: true }, { id: 'busy', floor: 1, available: false }, { id: 'far', floor: 3, available: true }, { id: 'near', floor: 1, available: true },
    ])).toBe('near');
    expect(pickChatPartner({ id: 'a', floor: 1, turn: 0 }, [{ id: 'b', floor: 2, available: false }])).toBeNull();
    const places = CHAT_SPOT_PAIRS.map(pair => ({ id: pair.id, floor: pair.floor, spots: chatSpotIds(pair) }));
    const place = pickChatPlace(places, new Set(), [1], { id: 'a', turn: 0 })!;
    expect(place.floor).toBe(1);
    expect(pickChatPlace(places, new Set(places.flatMap(entry => entry.spots)), [1], { id: 'a', turn: 0 })).toBeNull();
    const a = navigation.seats.get(place.spots[0])!, b = navigation.seats.get(place.spots[1])!;
    // Each faces the other.
    expect(Math.abs(Math.atan2(b.seat[0] - a.seat[0], b.seat[2] - a.seat[2]) - a.rotationY)).toBeLessThan(1e-6);
    expect(Math.abs(Math.cos(b.rotationY - a.rotationY) + 1)).toBeLessThan(1e-6);
    const speakers = new Set(Array.from({ length: 20 }, (_, i) => chatSpeaker(0, i * 2000, 'p')));
    expect(speakers).toEqual(new Set([0, 1]));
  });
});

describe('board pick reply', () => {
  it('never repeats a phrase back to back and clears after its time', () => {
    expect(pickCallout(['a', 'b'], ['a'], 0)).toBe('b');
    expect(pickCallout(['a'], ['a'], 0.5)).toBe('a');
    let now = 0, timers: (() => void)[] = [];
    const store = createCalloutStore(() => now, () => 0, run => { timers.push(run); });
    const pool = MESSAGES.en.characterCallouts;
    expect(pool.length).toBeGreaterThanOrEqual(15);
    expect(MESSAGES.id.characterCallouts.length).toBeGreaterThanOrEqual(15);
    let previous = '';
    for (let i = 0; i < 30; i++) {
      const callout = store.say(i % 2 ? 'x' : 'y', pool);
      expect(callout.text).not.toBe(previous);
      previous = callout.text;
    }
    expect(store.current('x')).toBeDefined();
    now = CALLOUT_MS;
    expect(store.current('x')).toBeUndefined();
    const version = store.version();
    for (const run of timers) run();
    timers = [];
    expect(store.version()).toBeGreaterThan(version);
  });
});

describe('desk chairs and doors', () => {
  it('moves only workstation chairs, out while the agent stands beside it and in once seated or gone', () => {
    expect(isDeskChair('engineering.pod-a.seat-ne')).toBe(true);
    expect(isDeskChair('lounge.sofa-1')).toBe(false);
    expect(isDeskChair('entertainment.armchair')).toBe(false);
    expect(isDeskChair('lobby.receptionist')).toBe(false);
    expect(isDeskChair('fitness.bike-1')).toBe(false);
    expect(chairOffset(1, 'x').back).toBeGreaterThan(0.3);
    expect(chairOffset(0, 'x')).toEqual({ back: 0, turn: 0 });
    const motion = new DeskChairMotion();
    for (let i = 0; i < 60; i++) { motion.setTarget('d', 1); motion.advance(1 / 30); }
    expect(motion.pull('d')).toBeGreaterThan(0.95);
    for (let i = 0; i < 90; i++) motion.advance(1 / 30);
    expect(motion.pull('d')).toBe(0);
  });

});

describe('idle characters in the director', () => {
  const lifts: ElevatorAccess = {
    request() {}, waitingSlot: () => 0, canBoard: () => false, standingPosition: () => null, confirmBoarded: () => false,
    canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 25, z: 0 }),
  };
  const make = (status: OfficeAgent['status']) => (id: string): OfficeAgent => ({ id, sessionId: id.split(':')[0]!, agentId: 'primary', displayName: id, control: 'managed', status, running: status !== 'idle' });
  const allocation = (agentId: string, seatId: string): OfficeAgentAllocation => {
    const seat = getOfficeSeats().find(entry => entry.id === seatId)!;
    return { ...seat, agentId, resourceId: seat.id };
  };

  it('walks idle characters to free places (pairing two for a chat) and sends them back the moment work arrives', () => {
    let now = 0;
    const env: MovementEnv = { navigation, elevators: lifts };
    const director = new MovementDirector(env, () => now, null);
    director.lifeScale = 0.3;
    const ids = ['a:primary', 'b:primary'];
    const seats = ['qa.station-1', 'qa.station-2'];
    const allocations = ids.map((id, index) => allocation(id, seats[index]!));
    const update = (status: OfficeAgent['status']) => director.update({ allocations, agents: ids.map(make(status)), reducedMotion: false, gaitOf: () => gaitParameters() });
    update('idle');
    const run = (seconds: number, check?: () => void) => { for (let t = 0; t < seconds; t += 1 / 30) { now += 1000 / 30; director.tick(1 / 30); check?.(); } };
    const desks = new Set(getOfficeSeats().map(seat => seat.id));
    const visited = new Set<string>();
    let chatted = false;
    director.preferKind = 'chat';
    run(700, () => {
      for (const id of ids) {
        const visit = director.lifeState(id)?.visit;
        if (!visit) continue;
        expect(desks.has(visit.spotId)).toBe(false);
        expect(FACILITY_NAV_RESOURCE_IDS.has(visit.spotId)).toBe(false);
        if (visit.arrived) visited.add(visit.spotId);
        const mover = director.list.find(entry => entry.id === id)!;
        if (visit.kind === 'chat' && visit.arrived && mover.motion.clip.startsWith('chat')) chatted = true;
      }
    });
    expect(visited.size).toBeGreaterThan(0);
    expect(chatted).toBe(true);
    // Work arrives: both head straight back and sit at their own desks.
    update('working');
    run(0.5);
    for (const id of ids) {
      const mover = director.list.find(entry => entry.id === id)!;
      const target = mover.pending ?? mover.goal;
      expect(target?.kind === 'seat' && target.seat.seatId).toBe(seats[ids.indexOf(id)]);
    }
    run(90);
    for (const [index, id] of ids.entries()) {
      const mover = director.list.find(entry => entry.id === id)!;
      expect(mover.phase).toBe('seated');
      expect(mover.seat?.seatId).toBe(seats[index]);
      expect(['typing', 'mouse', 'read-screen', 'thinking']).toContain(mover.motion.clip);
    }
  });

  it('keeps everyone at the desk with reduced motion', () => {
    let now = 0;
    const director = new MovementDirector({ navigation, elevators: lifts }, () => now, null);
    director.lifeScale = 0.001;
    const allocations = [allocation('c:primary', 'qa.station-1')];
    director.update({ allocations, agents: [make('idle')('c:primary')], reducedMotion: true, gaitOf: () => gaitParameters() });
    for (let t = 0; t < 60; t += 1 / 30) { now += 1000 / 30; director.tick(1 / 30); }
    expect(director.lifeState('c:primary')?.visit ?? null).toBeNull();
    expect(director.list[0]!.seat?.seatId).toBe('qa.station-1');
  });
});
