import { describe, expect, it, vi } from 'vitest';
import type { Point3 } from '../src/office/scene/layout';
import { FACILITY_NPCS } from '../src/office/scene/movement/facilityNpcs';
import { FacilityNpcDirector } from '../src/office/scene/movement/facilityDirector';
import { floorY, officeNavigation, planRoute, seatStageId } from '../src/office/scene/movement/navGraph';
import { routeFrom, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';

const navigation = officeNavigation();
const elevators: ElevatorAccess = { request() {}, waitingSlot: () => 0, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };

it('protects every authored stair leg, including flat turns at half-floor height', () => {
  let flatMidLandings = 0;
  for (const connector of navigation.connectors.filter(connector => connector.kind === 'stairs')) {
    const route = planRoute(connector.waypoints[0]!, connector.waypoints.at(-1)!, navigation)!;
    let previous = navigation.waypoints.get(connector.waypoints[0]!)!.position;
    for (const step of route.steps) {
      expect(step.kind).toBe('walk');
      if (step.kind !== 'walk') continue;
      expect(step.stairs, step.node).toBe(true);
      if (Math.abs(step.to[1] - previous[1]) < .001 && [1, 2, 3].every(floor => Math.abs(step.to[1] - floorY(floor as 1 | 2 | 3)) > .05)) flatMidLandings++;
      previous = step.to;
    }
  }
  expect(flatMidLandings).toBeGreaterThanOrEqual(8);
});

describe('facility NPC shared movement recovery', () => {
  it.each(FACILITY_NPCS)('recovers a blocked $role through the actual facility director without replacing it', definition => {
    const home = navigation.seats.get(definition.homeResourceId)!;
    const [x, y, z] = home.staging;
    const clear = (from: Readonly<Point3>, to: Readonly<Point3>, radius = .29) => {
      for (let sample = 0; sample <= 20; sample++) {
        const t = sample / 20, px = from[0] + (to[0] - from[0]) * t, pz = from[2] + (to[2] - from[2]) * t;
        if (Math.abs(px - (x - 1.5)) < radius + .1 && Math.abs(pz - z) < radius + .25) return false;
      }
      return true;
    };
    const env: MovementEnv = { navigation, elevators, walkable: clear, nearbyWalkers: () => [] };
    const director = new FacilityNpcDirector(env, () => [], () => 0, [definition]);
    try {
      const original = director.npcs[0]!, mover = original.mover;
      mover.position[0] = x - 3; mover.position[1] = y; mover.position[2] = z;
      mover.phase = 'walking';
      mover.steps = [{ kind: 'walk', node: seatStageId(home.seatId), to: [...home.staging], stairs: false }];
      mover.stepIndex = 0;
      for (let frame = 0; frame < 30 * 40; frame++) director.tick(1 / 30);
      expect(director.npcs).toHaveLength(1);
      expect(director.npcs[0]).toBe(original);
      expect(director.npcs[0]!.mover).toBe(mover);
      expect(mover.id).toBe(definition.id);
      expect(mover.recovery.attempts).toBeGreaterThan(0);
      expect(mover.phase).toBe('seated');
      expect(mover.seat?.seatId).toBe(home.seatId);
      expect(original.brain.state).toBe('ON_DUTY');
    } finally { director.dispose(); }
  });

  it('leaves a genuinely waiting NPC alone when the adapter cannot diagnose lift progress', () => {
    const release = vi.fn();
    const env: MovementEnv = { navigation, elevators: { ...elevators, release }, walkable: () => true, nearbyWalkers: () => [] };
    const definition = FACILITY_NPCS[0]!;
    const director = new FacilityNpcDirector(env, () => [], () => 0, [definition]);
    try {
      const mover = director.npcs[0]!.mover;
      mover.phase = 'waiting';
      mover.trip = { id: 'A', from: 1, to: 3, exit: [0, 12.8, 0], landing: [...mover.position], stage: 'approach', requested: true, exited: false };
      const position = [...mover.position];
      for (let frame = 0; frame < 30 * 90; frame++) director.tick(1 / 30);
      expect(mover.phase).toBe('waiting');
      expect(mover.position).toEqual(position);
      expect(mover.trip?.id).toBe('A');
      expect(mover.recovery.attempts).toBe(0);
      expect(release).not.toHaveBeenCalled();
    } finally { director.dispose(); }
  });
});

it('rescues a frozen onboard NPC through the facility director and returns it to duty', () => {
  const release = vi.fn();
  const origin = navigation.waypoints.get('f3.elevator-A')!.position;
  const destination = navigation.waypoints.get('f1.elevator-A')!.position;
  const slot: Point3 = [origin[0] + 2, 5, origin[2]];
  const env: MovementEnv = {
    navigation, walkable: () => true, nearbyWalkers: () => [],
    elevators: { ...elevators, release, standingPosition: () => slot,
      progress: () => ({ y: 5, doors: 0, phase: 'riding', ownership: 'boarded', queueAhead: null, serviceRevision: 0, doorway: false }) },
  };
  const definition = FACILITY_NPCS[0]!;
  const director = new FacilityNpcDirector(env, () => [], () => 0, [definition]);
  try {
    const original = director.npcs[0]!, mover = original.mover;
    mover.position[0] = slot[0]; mover.position[1] = slot[1]; mover.position[2] = slot[2];
    expect(routeFrom(mover, 'f3.elevator-A', mover.goal!, env, false)).toBe(true);
    mover.phase = 'riding';
    mover.trip = { id: 'A', from: 3, to: 1, exit: [...destination], landing: [...origin], stage: 'slot', requested: true, exited: false };
    mover.steps = [{ kind: 'elevator', node: 'f1.elevator-A', elevatorId: 'A', from: 3, to: 1, exit: [...destination] }];
    mover.stepIndex = 0; mover.lastNode = 'f3.elevator-A';
    for (let frame = 0; frame < 30 * 90; frame++) director.tick(1 / 30);
    expect(director.npcs[0]).toBe(original);
    expect(original.mover).toBe(mover);
    expect(mover.id).toBe(definition.id);
    expect(release).toHaveBeenCalledExactlyOnceWith(definition.id, 'A');
    expect(mover.recovery.avoidedElevators).toContain('A');
    expect(mover.trip).toBeNull();
    expect(mover.phase).toBe('seated');
    expect(mover.seat?.seatId).toBe(definition.homeResourceId);
    expect(original.brain.state).toBe('ON_DUTY');
  } finally { director.dispose(); }
});
