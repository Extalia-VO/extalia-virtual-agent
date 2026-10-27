import { describe, expect, it } from 'vitest';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { DoorTraffic, doorAxes, doorLeafDistance, doorPoint, type DoorInfo, type WalkerInfo } from '../src/office/scene/interior/doorTraffic';
import type { Point3 } from '../src/office/scene/layout';
import { createMover, routeFrom, stepMover, walkSpeed, type ElevatorAccess, type MovementEnv, type Mover } from '../src/office/scene/movement/mover';
import { officeNavigation, type RouteStep } from '../src/office/scene/movement/navGraph';
import { createNaturalWalkState, naturalRoute } from '../src/office/scene/movement/naturalWalking';
import { DOOR_BODY_CLEARANCE, doorSwingSide } from '../src/office/scene/movement/doorChoreography';
import { LEISURE_SPOTS } from '../src/office/scene/movement/leisureSpots';
import { OFFICE_DOOR_PORTALS } from './fixtures/officeDoorPortals';

const navigation = officeNavigation();
const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };

function assertJoined(mover: Mover, context = '') {
  expect(mover.natural).toEqual(createNaturalWalkState());
  const step = mover.steps[mover.stepIndex];
  if (step?.kind === 'walk') expect(step.natural, context).toBeUndefined();
}

describe('natural routes after door choreography', () => {
  for (const transitionKind of ['stairs', 'elevator'] as const) {
    for (const virtual of [false, true]) it(`retains a leaf-covered ${virtual ? 'virtual' : 'exact'} marker before ${transitionKind}`, () => {
      const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 1.2, height: 2.55, openAngle: -Math.PI * .38, sliding: false };
      const mover = createMover('boundary', gaitParameters(), [0, 0, 1.85], 0, false);
      const marker: RouteStep = { kind: 'walk', node: 'inside', to: [0, 0, .8], stairs: false,
        ...(virtual ? { natural: { from: [0, 0, .6] as Point3, transit: true, startDistance: 0, endDistance: .2, rightFrom: [1, 0] as const, rightTo: [1, 0] as const } } : {}) };
      const transition: RouteStep = transitionKind === 'stairs'
        ? { kind: 'walk', node: 'stairs', to: [0, 6.4, 2], stairs: true }
        : { kind: 'elevator', node: 'lift', elevatorId: 'A', from: 1, to: 2, exit: [0, 6.4, 2] };
      mover.steps = [marker, transition];
      mover.phase = 'doorwork';
      mover.door = { kind: 'close', id: 'door', door, timer: 1, beat: 'release', side: 1, entrySide: -1, hand: 1, path: null };
      const doors = new DoorTraffic({ forEachDoor: visit => visit('door', door), forEachWalker() {} }, () => 0);
      doors.hold('door', mover.id, 1, 2);
      const env: MovementEnv = { navigation, elevators, doors, walkable: () => true };
      const before = [...mover.position];
      expect(doorLeafDistance(door, 1, marker.to)).toBeLessThan(DOOR_BODY_CLEARANCE);

      stepMover(mover, 1 / 30, env);
      expect(mover.phase).toBe('doorwork');
      expect(mover.position).toEqual(before);
      expect(mover.stepIndex).toBe(0);
      expect(mover.steps[0]).toBe(marker);
      expect(mover.steps[1]).toBe(transition);
      expect(doors.claim('door', 'next-walker')).toBe(false);

      // Once the leaf closes, the retained marker is reachable and must be
      // joined before the original stairs or elevator can be processed.
      doors.hold('door', mover.id, 0, 2);
      stepMover(mover, 1 / 30, env);
      expect(mover.phase).toBe('walking');
      expect(mover.steps[mover.stepIndex]).toEqual({ kind: 'walk', node: 'inside', to: marker.to, stairs: false });
      expect(mover.steps[1]).toBe(transition);
      expect(mover.position).toEqual(before);
      assertJoined(mover);
    });
  }

  for (const hinge of ['left', 'right'] as const) for (const sign of [-1, 1]) {
    it(`hands off past a leaf-covered inside marker: ${hinge}, ${sign}`, () => {
      const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 1.2, height: 2.55, openAngle: sign * Math.PI * .38, hinge, sliding: false };
      const exitSide = doorSwingSide(door), entrySide = -exitSide as 1 | -1;
      const point = (through: number): Point3 => doorPoint(door, 0, through, [0, 0, 0]);
      const inside = point(exitSide * .8), goal = point(exitSide * 3);
      const mover = createMover('handoff', gaitParameters(), point(exitSide * (door.clearWidth + .65)), 0, false);
      mover.steps = [{ kind: 'walk', node: 'inside', to: inside, stairs: false }, { kind: 'walk', node: 'destination', to: goal, stairs: false }];
      mover.goal = { kind: 'leave', node: 'destination' };
      mover.phase = 'doorwork';
      mover.door = { kind: 'pass', id: 'door', door, timer: 0, beat: 'handoff', side: entrySide, entrySide, hand: 1, path: null };
      const doors = new DoorTraffic({ forEachDoor: visit => visit('door', door), forEachWalker: visit => {
        visit({ id: 'following', position: point(entrySide * 2), target: point(0), updatedAt: 0 });
      } }, () => 0);
      doors.hold('door', mover.id, 1, 2);
      expect(doorLeafDistance(door, 1, inside)).toBeLessThan(DOOR_BODY_CLEARANCE);
      const before = [...mover.position];
      stepMover(mover, 1 / 30, { navigation, elevators, doors, walkable: () => true });
      expect(mover.phase).toBe('walking');
      expect(mover.door).toBeNull();
      expect(doors.amount('door')).toBe(1);
      expect(mover.position).toEqual(before);
      expect(mover.steps[mover.stepIndex]).toEqual({ kind: 'walk', node: 'destination', to: goal, stairs: false });
      assertJoined(mover);
    });
  }

  it('releases final close duty after the route is exhausted and finishes leaving', () => {
    const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 1.6, height: 2.55, openAngle: Math.PI / 2, sliding: false };
    const mover = createMover('final-closer', gaitParameters(), [.377, 0, .42], 0, false);
    mover.steps = [];
    mover.goal = { kind: 'leave', node: 'destination' };
    mover.phase = 'doorwork';
    mover.door = { kind: 'close', id: 'door', door, timer: 1, beat: 'release', side: 1, entrySide: -1, hand: 1, path: null };
    const doors = new DoorTraffic({ forEachDoor: visit => visit('door', door), forEachWalker() {} }, () => 0);
    expect(doors.claim('door', mover.id)).toBe(true);
    expect(doors.claim('door', 'next-walker')).toBe(false);
    const env: MovementEnv = { navigation, elevators, doors, walkable: () => false };
    const release = [...mover.position];

    stepMover(mover, 1 / 30, env);
    expect(mover.phase).toBe('walking');
    expect(mover.door).toBeNull();
    expect(doors.amount('door')).toBe(0);
    expect(doors.claim('door', 'next-walker')).toBe(true);
    expect(mover.position).toEqual(release);
    expect(mover.goal).toEqual({ kind: 'leave', node: 'destination' });

    stepMover(mover, 1 / 30, env);
    expect(mover.phase).toBe('vanishing');
    expect(mover.position).toEqual(release);
  });

  for (const blocked of [false, true]) it(`retains exact contacts after dense crossed samples, obstruction ${blocked}`, () => {
    const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 1.6, height: 2.55, openAngle: Math.PI / 2, sliding: false };
    const mover = createMover('dense-route', gaitParameters(), [.377, 0, .42], 0, false);
    const approach: RouteStep[] = Array.from({ length: 24 }, (_, index) => ({ kind: 'walk', node: 'old-approach', stairs: false,
      to: [0, 0, -.6 + index * .02], natural: { from: [0, 0, -.62 + index * .02], transit: true,
        startDistance: index * .02, endDistance: 1, rightFrom: [1, 0], rightTo: [1, 0] } }));
    const tail: RouteStep[] = [
      { kind: 'walk', node: 'destination-side', to: [0, 0, .8], stairs: false },
      { kind: 'walk', node: 'stairs', to: [0, 6.4, 2], stairs: true },
      { kind: 'elevator', node: 'lift', elevatorId: 'A', from: 2, to: 3, exit: [0, 12.8, 2] },
      { kind: 'walk', node: 'seat:destination:stage', to: [2, 12.8, 2], stairs: false },
    ];
    mover.steps = [...approach, { kind: 'walk', node: 'threshold', to: [0, 0, 0], stairs: false }, ...tail];
    mover.goal = { kind: 'leave', node: 'seat:destination:stage' };
    mover.phase = 'doorwork';
    mover.door = { kind: 'close', id: 'door', door, timer: 1, beat: 'release', side: 1, entrySide: -1, hand: 1, path: null };
    Object.assign(mover.natural, { index: 12, progress: .01, offset: .2, speed: .4, blockedTime: 1, lateralSpeed: .1 });
    const doors = new DoorTraffic({ forEachDoor: visit => visit('door', door), forEachWalker() {} }, () => 0);
    let obstructed = blocked;
    const env: MovementEnv = { navigation, elevators, doors, walkable: () => !obstructed };
    const release = [...mover.position];
    stepMover(mover, 1 / 30, env);
    expect(mover.position).toEqual(release);
    if (blocked) {
      expect(mover.phase).toBe('doorwork');
      expect(mover.steps[mover.stepIndex]).toBe(tail[0]);
      obstructed = false;
      stepMover(mover, 1 / 30, env);
    }
    expect(mover.phase).toBe('walking');
    assertJoined(mover);
    expect(mover.steps[mover.stepIndex]).toEqual(tail[0]);
    for (let index = 1; index < tail.length; index++) expect(mover.steps.at(index - tail.length)).toBe(tail[index]);
    expect(mover.goal).toEqual({ kind: 'leave', node: 'seat:destination:stage' });
  });

  for (const hinge of ['left', 'right'] as const) for (const sign of [-1, 1]) for (const side of [-1, 1]) {
    it(`rejoins after closure and shared handoff: ${hinge}, ${sign}, ${side}`, () => {
      for (const shared of [false, true]) {
        let now = 0;
        const door: DoorInfo = { floor: 1, center: [2, 0, -3], yaw: Math.PI / 3, clearWidth: 1.6,
          height: 2.55, openAngle: sign * Math.PI / 2, hinge, sliding: false };
        const point = (through: number): Point3 => doorPoint(door, 0, through, [0, 0, 0]);
        const mover = createMover('wanderer', gaitParameters(), point(side * 3), door.yaw, false);
        const steps: RouteStep[] = [0, -side * .8, -side * 5].map((through, index) => ({ kind: 'walk', node: index === 0 ? 'f1.engineering-south-door' : `route-${index}`, to: point(through), stairs: false }));
        mover.steps = naturalRoute(mover.position, steps, navigation, .7, () => true);
        mover.goal = { kind: 'leave', node: 'route-2' };
        expect(mover.steps.some(step => step.kind === 'walk' && step.natural)).toBe(true);
        const follower: WalkerInfo = { id: 'follower', position: point(side * 2.5), target: point(0), updatedAt: now };
        let holding = shared;
        const doors = new DoorTraffic({ forEachDoor: visit => visit('door', door), forEachWalker: visit => {
          if (holding) visit({ ...follower, updatedAt: now });
        } }, () => now);
        const env: MovementEnv = { navigation, elevators, doors, walkable: () => true };
        let joined = false, closed = false, handedOff = false;
        for (let frame = 0; frame < 30 * 100 && mover.phase !== 'gone'; frame++) {
          const before = [...mover.position] as Point3, act = mover.door;
          stepMover(mover, 1 / 30, env); now += 1000 / 30;
          expect(Math.hypot(mover.position[0] - before[0], mover.position[2] - before[2])).toBeLessThanOrEqual(walkSpeed(mover) / 30 + 1e-6);
          expect(doorLeafDistance(door, doors.amount('door'), mover.position)).toBeGreaterThanOrEqual(.33);
          if (act && !mover.door) {
            assertJoined(mover); joined = true;
            handedOff ||= doors.amount('door') > .99;
            closed ||= doors.amount('door') === 0;
            holding = false;
            const released = [...mover.position] as Point3;
            stepMover(mover, 1 / 30, env); now += 1000 / 30;
            expect(Math.hypot(mover.position[0] - released[0], mover.position[2] - released[2])).toBeGreaterThan(1e-5);
          }
        }
        expect(joined).toBe(true);
        expect(shared ? handedOff : closed).toBe(true);
        expect(mover.phase).toBe('gone');
        expect(mover.position).toEqual(point(-side * 5));
      }
    });
  }

  it('rejoins each completed door interaction on all 592 actual office leisure routes', () => {
    let routes = 0, joins = 0, curvedRoutes = 0;
    // Conservative wall planes reject optional chords outside the authored
    // apertures; exact graph contacts remain available as the fallback.
    // Door leaves themselves remain owned by DoorTraffic and choreography.
    const walkable: NonNullable<MovementEnv['walkable']> = (from, to, radius = .29) => {
      const count = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[2] - from[2]) / .05));
      for (const portal of OFFICE_DOOR_PORTALS) {
        if (Math.abs(from[1] - portal.center[1]) > .1) continue;
        for (let sample = 0; sample <= count; sample++) {
          const t = sample / count;
          const at = doorAxes(portal, [from[0] + (to[0] - from[0]) * t, from[1], from[2] + (to[2] - from[2]) * t]);
          if (Math.abs(at.through) < radius && Math.abs(at.across) > portal.clearWidth / 2 - radius) return false;
        }
      }
      return true;
    };
    for (const spot of LEISURE_SPOTS) {
      const destination = navigation.seats.get(spot.id)!;
      const sources = [...navigation.seats.values()].filter(seat => seat.floor === destination.floor && seat.roomId !== destination.roomId).filter((_, index) => index % 7 === 0);
      for (const source of sources) {
        let now = 0;
        const tracked = new Map<string, WalkerInfo>();
        const doors = new DoorTraffic({ forEachDoor: visit => { for (const portal of OFFICE_DOOR_PORTALS) visit(portal.id, portal); },
          forEachWalker: visit => { for (const walker of tracked.values()) visit(walker); } }, () => now);
        const env: MovementEnv = { navigation, elevators, doors, walkable, trackWalker(id, position, target) {
          if (position && target) tracked.set(id, { id, position: [...position], target: [...target], updatedAt: now }); else tracked.delete(id);
        } };
        const mover = createMover('wanderer', gaitParameters(), [...source.staging], source.rotationY, false);
        if (!routeFrom(mover, `seat:${source.seatId}:stage`, { kind: 'seat', seat: destination }, env, false)) continue;
        routes++;
        if (mover.steps.some(step => step.kind === 'walk' && step.natural)) curvedRoutes++;
        for (let frame = 0; frame < 30 * 180; frame++) {
          const act = mover.door;
          for (const portal of OFFICE_DOOR_PORTALS) if (portal.sliding) doors.slideStep(portal.id, portal, 1 / 30);
          stepMover(mover, 1 / 30, env); now += 1000 / 30;
          if (act && !mover.door && !act.door.sliding) { assertJoined(mover, JSON.stringify({ from: source.seatId, to: destination.seatId, act, position: mover.position })); joins++; }
          if (mover.phase === 'seated' || mover.phase === 'gone') break;
        }
        expect(mover.phase, `${source.seatId} → ${destination.seatId}`).toBe('seated');
      }
    }
    expect(routes).toBe(592);
    expect(joins).toBeGreaterThan(200);
    expect(curvedRoutes).toBeGreaterThan(0);
  });
});
