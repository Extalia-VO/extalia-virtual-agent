import { describe, expect, it } from 'vitest';
import type { OfficeAgent } from '../src/office/presence';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { getOfficeSeats, type OfficeAgentAllocation } from '../src/office/scene/interior/seating';
import { MovementDirector, SETTLE_MS } from '../src/office/scene/movement/director';
import { createMover, MAX_WALK_SPEED, routeFrom, setPace, stepMover, walkSpeed, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { naturalRoute } from '../src/office/scene/movement/naturalWalking';
import { officeNavigation } from '../src/office/scene/movement/navGraph';
import { MOOD_PACE, OFFICE_PACE, personalPace, PERSONAL_PACE_MAX, PERSONAL_PACE_MIN, strideAndCadence, TRIP_VARIATION, tripPace } from '../src/office/scene/movement/pace';
import { walkingSpeed } from '../src/office/scene/movement/walkCycle';
import type { Point3 } from '../src/office/scene/layout';

const navigation = officeNavigation();
const ids = Array.from({ length: 200 }, (_, index) => `session-${index % 7}:agent-${index}`);
const noLifts: ElevatorAccess = {
  request: () => {}, waitingSlot: () => 0, canBoard: () => false, standingPosition: () => null, confirmBoarded: () => false,
  canExit: () => false, confirmExited: () => false, release: () => {}, door: () => ({ x: 0, z: 0 }),
};
const env: MovementEnv = { navigation, elevators: noLifts };

describe('walking pace', () => {
  it('gives every character a stable personal pace in range, varied across characters', () => {
    const paces = ids.map(personalPace);
    for (const [index, id] of ids.entries()) {
      expect(personalPace(id)).toBe(paces[index]);
      expect(paces[index]).toBeGreaterThanOrEqual(PERSONAL_PACE_MIN);
      expect(paces[index]).toBeLessThanOrEqual(PERSONAL_PACE_MAX);
    }
    // Not all the same: a real spread of slow and fast walkers.
    expect(Math.max(...paces) - Math.min(...paces)).toBeGreaterThan(0.2);
    expect(new Set(paces.map(pace => pace.toFixed(3))).size).toBeGreaterThan(100);
  });

  it('varies each trip a little, strolls during leisure and hurries back to real work', () => {
    for (const id of ids.slice(0, 40)) {
      const trips = Array.from({ length: 12 }, (_, trip) => tripPace(id, trip));
      expect(tripPace(id, 3)).toBe(trips[3]);
      for (const pace of trips) {
        expect(pace / (OFFICE_PACE * personalPace(id))).toBeGreaterThanOrEqual(1 - TRIP_VARIATION - 1e-9);
        expect(pace / (OFFICE_PACE * personalPace(id))).toBeLessThanOrEqual(1 + TRIP_VARIATION + 1e-9);
      }
      expect(new Set(trips).size).toBeGreaterThan(1);
      expect(tripPace(id, 5, 'stroll')).toBeLessThan(tripPace(id, 5, 'walk'));
      expect(tripPace(id, 5, 'hurry')).toBeGreaterThan(tripPace(id, 5, 'walk'));
      expect(tripPace(id, 5, 'hurry') / tripPace(id, 5, 'walk')).toBeCloseTo(MOOD_PACE.hurry);
    }
    // A brisk office walk: about 1.4–1.9 m/s for an ordinary trip with the default gait.
    const speeds = ids.map(id => walkingSpeed(gaitParameters()) * tripPace(id, 1));
    const mean = speeds.reduce((sum, value) => sum + value, 0) / speeds.length;
    expect(mean).toBeGreaterThan(1.45);
    expect(mean).toBeLessThan(1.85);
  });

  it('keeps a visibly distinct stroll, ordinary walk and very brisk hurry', () => {
    const measured = ids.map(id => {
      const speeds = (['stroll', 'walk', 'hurry'] as const).map(mood => {
        const mover = createMover(id, gaitParameters(), [0, 0, 0], 0, false);
        setPace(mover, tripPace(id, 2, mood));
        return walkSpeed(mover);
      });
      return speeds;
    });
    const mean = (column: number) => measured.reduce((sum, row) => sum + row[column]!, 0) / measured.length;
    expect(mean(0)).toBeLessThan(1.25);
    expect(mean(1)).toBeGreaterThan(1.55);
    expect(mean(2)).toBeGreaterThan(2.0);
    expect(mean(2) / mean(0)).toBeGreaterThan(1.75);
    expect(Math.max(...measured.map(row => row[1]!)) - Math.min(...measured.map(row => row[1]!))).toBeGreaterThan(0.6);
  });

  it('preserves commanded speed and planted step distance across hundreds of curve samples at 30/60/120 fps', () => {
    for (const hz of [30, 60, 120]) for (const pace of [0.7, 1.2, 3]) {
      const mover = createMover('sample-speed', gaitParameters(), [0, 0, 0], Math.PI / 2, false);
      const live = { ...env, walkable: () => true };
      mover.steps = naturalRoute(mover.position, [{ kind: 'walk', node: 'straight-end', to: [24, 0, 0], stairs: false }], navigation, 0.5, live.walkable);
      setPace(mover, pace);
      let distance = 0, phase = 0;
      for (let frame = 0; frame < 6 * hz; frame++) {
        const before = [...mover.position] as Point3, oldPhase = mover.motion.phase;
        stepMover(mover, 1 / hz, live);
        distance += Math.hypot(mover.position[0] - before[0], mover.position[2] - before[2]);
        phase += ((mover.motion.phase - oldPhase) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      }
      expect(distance / 6, `${hz} fps, pace ${pace}`).toBeCloseTo(walkSpeed(mover), 5);
      expect(mover.natural.speed).toBeCloseTo(1, 5);
      expect(distance / (phase / Math.PI)).toBeCloseTo(mover.gait.strideLength * mover.motion.stride, 5);
    }
  });

  it('arrives on a clear rounded route near its intended distance/time at every frame rate', () => {
    const ratios: number[] = [];
    for (const hz of [30, 60, 120]) {
      const mover = createMover('curve-speed', gaitParameters(), [0, 0, 0], Math.PI / 2, false);
      const live = { ...env, walkable: () => true };
      mover.steps = naturalRoute(mover.position, [[8, 0], [8, 8], [16, 8]].map(([x, z], i) => ({ kind: 'walk', node: `curve-${i}`, to: [x!, 0, z!], stairs: false })), navigation, 0.5, live.walkable);
      let length = 0, point = mover.position;
      for (const step of mover.steps) if (step.kind === 'walk') { length += Math.hypot(step.to[0] - point[0], step.to[2] - point[2]); point = step.to; }
      setPace(mover, 1.2);
      let frames = 0;
      for (; frames < 60 * hz && mover.phase === 'walking'; frames++) stepMover(mover, 1 / hz, live);
      expect(mover.phase).toBe('vanishing');
      const ratio = length / (frames / hz) / walkSpeed(mover);
      expect(ratio).toBeGreaterThan(0.96);
      expect(ratio).toBeLessThanOrEqual(1.001);
      ratios.push(ratio);
    }
    expect(Math.max(...ratios) - Math.min(...ratios)).toBeLessThan(0.025);
  });

  it('splits the pace between stride and cadence so the feet stay planted', () => {
    for (const pace of [0.7, 1, 1.3, 1.8]) {
      const { stride, cadence } = strideAndCadence(pace);
      expect(stride * cadence).toBeCloseTo(pace);
      if (pace > 1) { expect(stride).toBeGreaterThan(1); expect(cadence).toBeGreaterThan(1); }
    }
  });

  it('walks at its pace, never faster than a hurried walk, with steps matching the distance', () => {
    const gait = gaitParameters();
    const seat = navigation.seats.get(getOfficeSeats()[0]!.id)!;
    for (const pace of [0.9, 1.3, 1.7, 3]) {
      const mover = createMover('m', gait, navigation.waypoints.get(navigation.entryId)!.position as Point3, 0, false);
      expect(routeFrom(mover, navigation.entryId, { kind: 'seat', seat }, env, false)).toBe(true);
      setPace(mover, pace);
      expect(walkSpeed(mover)).toBeCloseTo(Math.min(MAX_WALK_SPEED, walkingSpeed(gait) * pace));
      // The first leg (entrance toward the lobby door) is straight: measure the travel and the steps taken there.
      const first = mover.steps[0]!;
      expect(first.kind).toBe('walk');
      const start: Point3 = [mover.position[0], mover.position[1], mover.position[2]];
      let phase = 0, previous = mover.motion.phase;
      for (let frame = 0; frame < 30; frame++) {
        stepMover(mover, 1 / 60, env);
        phase += ((mover.motion.phase - previous) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
        previous = mover.motion.phase;
      }
      const travelled = Math.hypot(mover.position[0] - start[0], mover.position[2] - start[2]);
      expect(travelled / 0.5).toBeCloseTo(walkSpeed(mover), 1);
      // One step is π radians of the cycle and covers one (scaled) stride.
      const steps = phase / Math.PI;
      expect(travelled / steps).toBeCloseTo(gait.strideLength * mover.motion.stride, 2);
    }
  });
});

describe('walking pace in the office', () => {
  const agent = (id: string, extra: Partial<OfficeAgent> = {}): OfficeAgent => ({
    id, sessionId: id.split(':')[0]!, agentId: id.split(':')[1] ?? 'primary', displayName: id, control: 'managed', status: 'idle', running: false, ...extra,
  });
  const seatAllocation = (agentId: string, seatId: string): OfficeAgentAllocation => {
    const seat = getOfficeSeats().find(candidate => candidate.id === seatId)!;
    return { ...seat, agentId, resourceId: seat.id };
  };

  it('strolls to a leisure place and hurries back when real work arrives', () => {
    let now = 0;
    const director = new MovementDirector(env, () => now, null);
    const gaitOf = () => gaitParameters();
    const allocations = [seatAllocation('a:primary', 'engineering.pod-a.seat-se')];
    const idle = agent('a:primary');
    director.update({ allocations, agents: [idle], reducedMotion: false, gaitOf });
    // Keep the outing long enough to finish the chair maneuver before testing
    // walking pace; a sub-second outing can end while the actor is still at its desk.
    director.lifeScale = 0.1;
    director.preferKind = 'pantry';
    const run = (seconds: number) => { for (let t = 0; t < seconds; t += 1 / 30) { now += 1000 / 30; director.tick(1 / 30); } };
    now = SETTLE_MS + 1;
    for (let frame = 0; frame < 30 * 90; frame++) {
      run(1 / 30);
      if (director.list[0]?.phase === 'walking' && director.walkState('a:primary')?.mood === 'stroll') break;
    }
    expect(director.list[0]?.phase).toBe('walking');
    expect(director.walkState('a:primary')?.mood).toBe('stroll');
    const strolling = director.walkState('a:primary')!.pace;
    expect(strolling).toBeCloseTo(tripPace('a:primary', director.walkState('a:primary')!.trips, 'stroll'));
    director.update({ allocations, agents: [agent('a:primary', { status: 'working', running: true })], reducedMotion: false, gaitOf });
    run(1);
    expect(director.walkState('a:primary')?.mood).toBe('hurry');
    expect(director.walkState('a:primary')!.pace).toBeGreaterThan(strolling);
    run(60);
    expect(director.position('a:primary')).toEqual(navigation.seats.get('engineering.pod-a.seat-se')!.seat);
  });
});
