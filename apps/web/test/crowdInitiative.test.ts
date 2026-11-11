import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import type { NavEdge, Waypoint } from '@extalia/office';
import { DoorTraffic } from '../src/office/scene/interior/doorTraffic';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import type { Point3 } from '../src/office/scene/layout';
import { CrowdWatch } from '../src/office/scene/movement/crowdWatch';
import { beginCrowdYield, createMover, crowdWatchActor, routeFrom, sendMover, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { officeNavigation, type OfficeNavigation, type SeatApproach } from '../src/office/scene/movement/navGraph';
import { WalkingClearance } from '../src/office/scene/movement/naturalClearance';

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };

describe('physical crowd initiative', () => {
  it.each([2, 3])('repairs a stationary %i-body overlap with one continuous retreat and keeps the goal', count => {
    const mover = createMover('initiative', gaitParameters(), [0, 0, 0], 0, false);
    const goal = { kind: 'leave' as const, node: 'destination' };
    mover.goal = goal;
    mover.steps = [{ kind: 'walk', node: 'destination', to: [4, 0, 0], stairs: false }];
    const protectedBodies = Array.from({ length: count - 1 }, (_, i) => createMover(`settled-${i}`, gaitParameters(), [.3, 0, i * .3], 0, true));
    const all = [mover, ...protectedBodies];
    const env: MovementEnv = { navigation: officeNavigation(), elevators, walkable: () => true,
      nearbyWalkers: id => all.filter(other => other.id !== id && other.phase !== 'gone').map(other => ({ id: other.id, position: [...other.position], velocity: [0, 0, 0] })) };
    const watch = new CrowdWatch();
    let beganAt = Infinity, largestStep = 0, yielding = false;
    for (let frame = 0; frame < 30 * 15 && mover.phase !== 'gone'; frame++) {
      const decision = watch.update(all.map(actor => crowdWatchActor(actor, Boolean(mover.crowdYield))), 1 / 30);
      if (decision.initiative && !mover.crowdYield) {
        expect(decision.initiative.actorId).toBe(mover.id);
        expect(decision.initiative.members).toHaveLength(count);
        if (beginCrowdYield(mover, env)) beganAt = Math.min(beganAt, frame / 30);
        else watch.failed(mover.id);
      }
      const before: Point3 = [...mover.position];
      stepMover(mover, 1 / 30, env);
      yielding ||= Boolean(mover.crowdYield);
      largestStep = Math.max(largestStep, Math.hypot(...mover.position.map((value, axis) => value - before[axis]!) as Point3));
      expect(mover.goal).toBe(goal);
      expect(protectedBodies.every(body => body.phase === 'seated')).toBe(true);
    }
    expect(beganAt).toBeGreaterThanOrEqual(3);
    expect(beganAt).toBeLessThan(5);
    expect(yielding).toBe(true);
    expect(largestStep).toBeLessThan(.08);
    expect(mover.phase).toBe('gone');
    expect(mover.position).toEqual([4, 0, 0]);
  });

  it('retains a FIFO ticket when the nominee makes room without crossing a portal', () => {
    const mover = createMover('queued', gaitParameters(), [0, 0, 2], 0, false);
    mover.phase = 'doorwork'; mover.goal = { kind: 'leave', node: 'destination' };
    mover.steps = [{ kind: 'walk', node: 'approach', to: [0, 0, 1], stairs: false }];
    const door = { floor: 1 as const, center: [0, 0, 0] as Point3, yaw: 0, clearWidth: 1.6, height: 2.55, openAngle: Math.PI / 2, sliding: false };
    mover.door = { id: 'portal', door, kind: 'wait', beat: 'reserve', side: 1, entrySide: 1, hand: 1, timer: 0, path: null };
    const act = mover.door;
    let now = 0;
    const doors = new DoorTraffic({ forEachDoor: visit => visit('portal', door), forEachWalker() {} }, () => now);
    doors.queue('portal', door, mover.id, mover.position, 1);
    doors.queue('portal', door, 'following', [1, 0, 3], 1);
    let trap: Point3 | null = null;
    const env: MovementEnv = { navigation: officeNavigation(), elevators, doors, walkable: (a, b) => a[2] >= .7 && b[2] >= .7,
      nearbyWalkers: () => [{ id: 'blocking', position: [0, 0, 1.7], velocity: [0, 0, 0] },
        ...(trap ? [{ id: 'new-obstacle', position: trap, velocity: [0, 0, 0] as Point3 }] : [])] };
    expect(beginCrowdYield(mover, env)).toBe(true);
    const toward = mover.crowdYield!.point, dx = toward[0] - mover.position[0], dz = toward[2] - mover.position[2], length = Math.hypot(dx, dz);
    trap = [mover.position[0] + dx / length * .56, 0, mover.position[2] + dz / length * .56];
    // Keep this retreat active beyond the normal three-second FIFO freshness.
    for (let frame = 0; frame < 30 * 3.8 && mover.crowdYield; frame++) {
      now += 1000 / 30;
      doors.queue('portal', door, 'following', [1, 0, 3], 1);
      stepMover(mover, 1 / 30, env);
      expect(doors.queueStatus('portal', mover.id)).toMatchObject({ head: mover.id, ahead: 0, count: 2 });
    }
    expect(now).toBeGreaterThan(3000);
    expect(mover.door).toBe(act);
    expect(mover.phase).toBe('doorwork');
    expect(mover.goal).toEqual({ kind: 'leave', node: 'destination' });
    expect(mover.position[2]).toBeGreaterThan(.7);
  });

  it('allows a same-face retreat when the future queued goal crosses its owned door', () => {
    const mover = createMover('queued-future-crossing', gaitParameters(), [0, 0, 1.1], 0, false);
    mover.phase = 'doorwork'; mover.goal = { kind: 'leave', node: 'destination' };
    mover.steps = [{ kind: 'walk', node: 'destination', to: [0, 0, -4], stairs: false }];
    const door = { floor: 1 as const, center: [0, 0, 0] as Point3, yaw: 0, clearWidth: 1.6, height: 2.55, openAngle: Math.PI / 2, sliding: false };
    mover.door = { id: 'portal', door, kind: 'wait', beat: 'reserve', side: 1, entrySide: 1, hand: 1, timer: 0, path: null };
    const doors = new DoorTraffic({ forEachDoor: visit => visit('portal', door), forEachWalker() {} }, () => 0);
    doors.queue('portal', door, 'head', [0, 0, -.5], -1);
    doors.queue('portal', door, mover.id, mover.position, 1);
    const env: MovementEnv = { navigation: officeNavigation(), elevators, doors, walkable: () => true,
      nearbyWalkers: () => [{ id: 'head', position: [0, 0, .5], velocity: [0, 0, 0] }] };
    expect(beginCrowdYield(mover, env)).toBe(true);
    expect(mover.crowdYield!.point[2]).toBeGreaterThan(0);
    expect(mover.door.beat).toBe('reserve');
    expect(doors.queueStatus('portal', mover.id)).toMatchObject({ head: 'head', ahead: 1, count: 2 });
  });

  it('never nominates stairs, lift riders or a held chair even when they overlap', () => {
    const mover = createMover('protected', gaitParameters(), [0, 0, 0], 0, false);
    mover.steps = [{ kind: 'walk', node: 'stairs', to: [0, 1, 2], stairs: true }];
    const env: MovementEnv = { navigation: officeNavigation(), elevators, walkable: () => true };
    expect(crowdWatchActor(mover).eligible).toBe(false);
    expect(beginCrowdYield(mover, env)).toBe(false);
    mover.phase = 'riding';
    expect(crowdWatchActor(mover).eligible).toBe(false);
  });

  it('cancels an old retreat when a new walking goal is accepted and completes the new destination continuously', () => {
    const positions: [string, Point3][] = [['origin', [0, 0, 0]], ['old', [4, 0, 0]], ['new', [-4, 0, 0]]];
    const waypoints = new Map<string, Waypoint>(positions.map(([id, position]) => [id, { id, floorId: 'floor-1', kind: 'corridor', position }]));
    const edges = new Map<string, NavEdge[]>([['origin', [{ to: 'old', cost: 4 }, { to: 'new', cost: 4 }]],
      ['old', [{ to: 'origin', cost: 4 }]], ['new', [{ to: 'origin', cost: 4 }]]]);
    const navigation: OfficeNavigation = { ...officeNavigation(), graph: {
      nodes: new Map(positions.map(([id, point]) => [id, { id, floorId: 'floor-1', pos: { x: point[0], y: point[2] } }])), edges },
      waypoints, edges: [], seats: new Map(), aisles: new Map(), connectors: [], elevatorEdges: new Map(), entryId: 'origin' };
    const env: MovementEnv = { navigation, elevators, walkable: () => true, nearbyWalkers: () => [] };
    const mover = createMover('new-goal-during-yield', gaitParameters(), [0, 0, 0], 0, false);
    const original = { kind: 'leave' as const, node: 'old' }, latest = { kind: 'leave' as const, node: 'new' };
    expect(routeFrom(mover, 'origin', original, env, false)).toBe(true);
    expect(beginCrowdYield(mover, env)).toBe(true);
    for (let frame = 0; frame < 6; frame++) stepMover(mover, 1 / 30, env);
    const before: Point3 = [...mover.position]; expect(Math.hypot(...before)).toBeGreaterThan(.05);
    expect(sendMover(mover, latest, env)).toBe(true);
    expect(mover.crowdYield).toBeNull(); expect(mover.position).toEqual(before); expect(mover.goal).toBe(latest);
    for (let frame = 0; frame < 900 && mover.phase !== 'gone'; frame++) {
      const prior: Point3 = [...mover.position]; stepMover(mover, 1 / 30, env);
      expect(Math.hypot(...mover.position.map((value, axis) => value - prior[axis]!) as Point3)).toBeLessThan(.08);
      expect(mover.goal).toBe(latest); expect(mover.crowdYield).toBeNull();
      if (mover.opacity < 1) expect(['vanishing', 'gone']).toContain(mover.phase);
    }
    expect(mover.phase).toBe('gone'); expect(mover.position).toEqual([-4, 0, 0]);
  });

  it.each(['walking', 'chairing'] as const)('rejoins a %s path through its checked origin when a partial retreat times out behind a corner', phase => {
    const root = new Group(), field = new WalkingClearance();
    const wall = (position: Point3, size: Point3) => {
      const mesh = new Mesh(new BoxGeometry(...size), new MeshBasicMaterial()); mesh.position.set(...position); root.add(mesh);
    };
    wall([-.4, .6, -3], [.2, 1.2, 8]); wall([3, .6, .4], [8, 1.2, .2]); wall([1, .6, -.5], [.1, 1.2, .1]); field.rebuild([root]);
    const mover = createMover(`partial-retreat-${phase}`, gaitParameters(), [0, 0, 0], 0, false);
    const origin: Point3 = [0, 0, 0], target: Point3 = [4, 0, 0];
    const goal = { kind: 'leave' as const, node: 'destination' }; mover.goal = goal; mover.lastNode = 'origin';
    mover.steps = [{ kind: 'walk', node: 'destination', to: target, stairs: false,
      natural: { from: [...origin], startDistance: 0, endDistance: 4, rightFrom: [0, -1], rightTo: [0, -1], transit: false } }];
    const seat: SeatApproach = { seatId: 'example-seat', roomId: 'example-room', floor: 1, seat: origin, staging: target,
      rotationY: 0, seatHeight: .46, seatStyle: 'office', sitMs: 850, standMs: 760 };
    if (phase === 'chairing') { mover.phase = phase; mover.seat = seat; mover.chair = { kind: 'sit', seat, side: 1, beat: 0, timer: 0, begun: true, path: [target] }; }
    const chair = mover.chair; let trap: Point3 | null = null;
    const env: MovementEnv = { navigation: officeNavigation(), elevators, walkable: field.segmentClear,
      chairMotionClear: (_seat, from, to, radius) => field.segmentClear(from, to, radius),
      nearbyWalkers: () => trap ? [{ id: 'late-blocker', position: trap, velocity: [0, 0, 0] }] : [] };
    expect(field.segmentClear(origin, target, .29)).toBe(true);
    expect(beginCrowdYield(mover, env)).toBe(true);
    const retreat = [...mover.crowdYield!.point] as Point3;
    expect(field.segmentClear(retreat, target, .29)).toBe(true);
    const step = () => {
      const before: Point3 = [...mover.position]; stepMover(mover, 1 / 30, env);
      expect(Math.hypot(...mover.position.map((value, axis) => value - before[axis]!) as Point3)).toBeLessThan(.08);
      expect(field.segmentClear(before, mover.position, .29)).toBe(true); expect(mover.goal).toBe(goal);
      expect(mover.opacity).toBe(1); expect(mover.recovery.attempts).toBe(0);
    };
    for (let frame = 0; frame < 150 && mover.crowdYield; frame++) {
      step();
      if (!trap && mover.position[2] < -.35) trap = [mover.position[0], 0, mover.position[2] - .58];
    }
    expect(trap).not.toBeNull(); expect(mover.crowdYield).toBeNull();
    expect(Math.hypot(...mover.position.map((value, axis) => value - retreat[axis]!) as Point3)).toBeGreaterThan(.5);
    expect(field.segmentClear(mover.position, target, .29)).toBe(false);
    expect(field.segmentClear(mover.position, origin, .29)).toBe(true);
    if (phase === 'walking') {
      expect(mover.steps[mover.stepIndex]).toMatchObject({ kind: 'walk', to: origin });
      const continued = mover.steps[mover.stepIndex + 1];
      expect(continued?.kind === 'walk' && continued.natural?.from).toEqual(origin);
    } else { expect(mover.chair).toBe(chair); expect(chair!.path).toEqual([origin, target]); }
    trap = null;
    for (let frame = 0; frame < 450 && Math.hypot(mover.position[0] - target[0], mover.position[2] - target[2]) > .01; frame++) step();
    expect(mover.position).toEqual(target);
    if (phase === 'chairing') expect(mover.chair).toBe(chair);
  });
});
