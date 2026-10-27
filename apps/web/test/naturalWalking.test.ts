import { DoorTraffic, type WalkerInfo } from '../src/office/scene/interior/doorTraffic';
import { OFFICE_DOOR_PORTALS } from './fixtures/officeDoorPortals';
import { describe, expect, it, vi } from 'vitest';
import type { Point3 } from '../src/office/scene/layout';
import { getNearbyMovingOccupantsSnapshot, getMovingOccupantsSnapshot, trackMovingOccupant } from '../src/office/scene/interior/occupants/movingOccupants';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { createMover, routeFrom, sendMover, setPace, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { advanceNaturalWalk, createNaturalWalkState, naturalRoute, reconnectNaturalRoute, walkingSeed, type WalkingNeighbor, type WalkableSegment } from '../src/office/scene/movement/naturalWalking';
import { tripPace } from '../src/office/scene/movement/pace';
import { officeNavigation, type OfficeNavigation, type RouteStep } from '../src/office/scene/movement/navGraph';

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };
const step = (node: string, x: number, z: number): RouteStep => ({ kind: 'walk', node, to: [x, 0, z], stairs: false });
const nav = officeNavigation();
const open = () => true;

function simulation(starts: Point3[], ends: Point3[], safe: WalkableSegment = open, pace = 1, personal = true) {
  const movers = starts.map((p, i) => createMover(`walker-${i}`, gaitParameters(), p, 0, false));
  const snapshots = new Map<string, WalkingNeighbor>();
  const env: MovementEnv = { navigation: nav, elevators, walkable: safe,
    nearbyWalkers: id => [...snapshots.values()].filter(other => other.id !== id) };
  movers.forEach((mover, i) => {
    const end = ends[i]!;
    mover.steps = naturalRoute(mover.position, [step(`end-${i}`, end[0], end[2])], nav, walkingSeed(mover.id, 0), safe);
    setPace(mover, (personal ? tripPace(mover.id, 0) : 1) * pace);
  });
  let minimum = Infinity, maximumStep = 0, maximumTurn = 0;
  const paths: Point3[][] = movers.map(() => []);
  for (let frame = 0; frame < 30 * 60; frame++) {
    for (const mover of movers) snapshots.set(mover.id, { id: mover.id, position: [...mover.position], velocity: snapshots.get(mover.id)?.velocity ?? [0, 0, 0] });
    for (const [i, mover] of movers.entries()) {
      const previous = [...mover.position] as Point3;
      stepMover(mover, 1 / 30, env);
      const velocity: Point3 = [(mover.position[0] - previous[0]) * 30, 0, (mover.position[2] - previous[2]) * 30];
      snapshots.set(mover.id, { id: mover.id, position: [...mover.position], velocity });
      maximumStep = Math.max(maximumStep, Math.hypot(...velocity) / 30);
      paths[i]!.push([...mover.position]);
    }
    for (let i = 0; i < movers.length; i++) for (let j = i + 1; j < movers.length; j++) minimum = Math.min(minimum, Math.hypot(movers[i]!.position[0] - movers[j]!.position[0], movers[i]!.position[2] - movers[j]!.position[2]));
    if (movers.every(mover => mover.phase === 'gone')) break;
  }
  for (const path of paths) for (let i = 2; i < path.length; i++) {
    const a = path[i - 2]!, b = path[i - 1]!, c = path[i]!;
    const u = [b[0] - a[0], b[2] - a[2]], v = [c[0] - b[0], c[2] - b[2]];
    const lengths = Math.hypot(...u) * Math.hypot(...v);
    if (lengths > 1e-6) maximumTurn = Math.max(maximumTurn, Math.acos(Math.max(-1, Math.min(1, (u[0]! * v[0]! + u[1]! * v[1]!) / lengths))));
  }
  return { movers, minimum, maximumStep, maximumTurn, paths };
}

describe('natural free-space walking', () => {
  it('has stable different trip trajectories and retains exact portal and chair endpoints', () => {
    const source: Point3 = [0, 0, 0];
    const steps = [step('f1.east-hall', 8, 0), step('f1.library-door', 8, 8), step('seat:test:stage', 14, 8)];
    const a = naturalRoute(source, steps, nav, walkingSeed('a', 0), open);
    expect(a).toEqual(naturalRoute(source, steps, nav, walkingSeed('a', 0), open));
    expect(a).not.toEqual(naturalRoute(source, steps, nav, walkingSeed('b', 0), open));
    expect(a).not.toEqual(naturalRoute(source, steps, nav, walkingSeed('a', 1), open));
    for (const endpoint of [steps[1]!, steps[2]!]) expect(a.some(s => s.kind === 'walk' && endpoint.kind === 'walk' && s.to.every((value, index) => value === endpoint.to[index]))).toBe(true);
    const corner = naturalRoute(source, steps, nav, 0.5, open).filter(s => s.kind === 'walk' && s.node === 'f1.east-hall');
    expect(corner.some(s => s.kind === 'walk' && s.to[0] < 8 && s.to[2] > 0.05)).toBe(true);
  });

  it('samples geometry, reduces variation in tight passages, and preserves unsupported legacy routes', () => {
    const route = [step('corridor-end', 12, 0)];
    const safe = (from: Readonly<Point3>, to: Readonly<Point3>, radius = 0.29) => Math.max(Math.abs(from[2]), Math.abs(to[2])) + radius <= 0.39;
    const varied = naturalRoute([0, 0, 0], route, nav, 0.99, safe);
    let previous: Readonly<Point3> = [0, 0, 0];
    expect(varied.every(s => { if (s.kind !== 'walk') return false; const clear = safe(previous, s.to); previous = s.to; return clear; })).toBe(true);
    expect(naturalRoute([0, 0, 0], route, nav, 0.99)).toEqual(route);
    const stairs: RouteStep = { kind: 'walk', node: 'stairs-1-2.up-start', to: [1, 1, 2], stairs: true };
    expect(naturalRoute([0, 0, 0], [stairs], nav, 0.99, open)).toEqual([stairs]);
    expect(naturalRoute([0, 0, 0], route, nav, 0.99, () => false)).toEqual(route);
  });

  it('rounds actual corner positions continuously with no frame teleport', () => {
    const navigation: OfficeNavigation = { ...nav, waypoints: new Map(nav.waypoints) };
    const mover = createMover('round', gaitParameters(), [0, 0, 0], Math.PI / 2, false);
    mover.steps = naturalRoute(mover.position, [step('corner', 6, 0), step('finish', 6, 6)], navigation, 0.5, open);
    const env: MovementEnv = { navigation, elevators, walkable: open };
    const path: Point3[] = [];
    for (let i = 0; i < 30 * 30 && mover.phase !== 'gone'; i++) {
      const before = [...mover.position]; stepMover(mover, 1 / 30, env);
      expect(Math.hypot(mover.position[0] - before[0]!, mover.position[2] - before[2]!)).toBeLessThan(0.08);
      path.push([...mover.position]);
    }
    expect(mover.phase).toBe('gone');
    expect(path.some(p => p[0] > 5.3 && p[0] < 5.9 && p[2] > 0.1)).toBe(true);
    expect(mover.position).toEqual([6, 0, 6]);
  });

  it('lets head-on and crossing walkers pass without body overlap or deadlock', () => {
    for (const [starts, ends] of [
      [[[-6, 0, 0], [6, 0, 0]], [[6, 0, 0], [-6, 0, 0]]],
      [[[-6, 0, 0], [0, 0, -6]], [[6, 0, 0], [0, 0, 6]]],
      [[[-6, 0, -0.3], [-7, 0, 0.3]], [[6, 0, -0.3], [6, 0, 0.3]]],
    ] as [Point3[], Point3[]][]) {
      const result = simulation(starts, ends);
      expect(result.movers.map(m => m.phase)).toEqual(['gone', 'gone']);
      expect(result.minimum).toBeGreaterThanOrEqual(0.53);
      expect(result.maximumStep).toBeLessThan(0.105);
    }
  });

  it('preserves real hinged-door choreography while following sampled routes', () => {
    const destinations = ['qa.desk-1', 'entertainment.console-1', 'library.librarian', 'lounge.bar-1'];
    const seats = [...nav.seats.values()].filter(s => destinations.includes(s.seatId) || s.roomId === 'qa' || s.roomId === 'entertainment').slice(0, 12);
    const failures: unknown[] = [];
    for (const destination of seats) {
      let now = 0;
      const tracked = new Map<string, WalkerInfo>();
      const doors = new DoorTraffic({ forEachDoor: visit => { for (const portal of OFFICE_DOOR_PORTALS) visit(portal.id, portal); }, forEachWalker: visit => { for (const actor of tracked.values()) visit(actor); } }, () => now);
      const env: MovementEnv = { navigation: nav, elevators, doors, walkable: open,
        trackWalker(id, position, target) { if (position && target) tracked.set(id, { id, position: [...position], target: [...target], updatedAt: now }); else tracked.delete(id); } };
      const source = nav.waypoints.get('f1.east-hall')!.position;
      const mover = createMover('natural-door', gaitParameters(), [...source], 0, false);
      routeFrom(mover, 'f1.east-hall', { kind: 'seat', seat: destination }, env, false);
      for (let frame = 0; frame < 30 * 180 && mover.phase !== 'seated'; frame++) { stepMover(mover, 1 / 30, env); now += 1000 / 30; }
      if (mover.phase !== 'seated') failures.push({ destination: destination.seatId, position: mover.position, door: mover.door, step: mover.steps[mover.stepIndex] });
    }
    expect(seats.length).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });

  it('clears four simultaneous intersecting streams without a permanent yield loop', () => {
    const starts: Point3[] = [[-6, 0, 0], [6, 0, 0], [0, 0, -6], [0, 0, 6]];
    const ends: Point3[] = [[6, 0, 0], [-6, 0, 0], [0, 0, 6], [0, 0, -6]];
    const result = simulation(starts, ends);
    expect(result.movers.map(m => ({ phase: m.phase, position: m.position })), JSON.stringify(result.movers.map(m=>({id:m.id,p:m.position,n:m.natural,step:m.steps[m.stepIndex]})))).toEqual(ends.map(position => ({ phase: 'gone', position })));
    expect(result.minimum).toBeGreaterThanOrEqual(0.53);
  });

  it('clears six simultaneous two-way walkers in a bounded hall', () => {
    const starts: Point3[] = [-0.9, 0, 0.9].flatMap(z => [[-6, 0, z] as Point3, [6, 0, z] as Point3]);
    const ends = starts.map(([x, y, z]) => [-x, y, z] as Point3);
    const safe: WalkableSegment = (a, b, radius = 0.29) => Math.max(Math.abs(a[2]), Math.abs(b[2])) + radius <= 1.5;
    const result = simulation(starts, ends, safe);
    expect(result.movers.map(m => ({ phase: m.phase, position: m.position })), JSON.stringify(result.movers.map(m=>({id:m.id,p:m.position,n:m.natural,step:m.steps[m.stepIndex]})))).toEqual(ends.map(position => ({ phase: 'gone', position })));
    expect(result.minimum).toBeGreaterThanOrEqual(0.53);
    expect(result.maximumStep).toBeLessThanOrEqual(2.2 / 30 + 1e-6);
  });

  it('also clears the six abreast bounded-hall encounter at exactly equal walking speeds', () => {
    const starts: Point3[] = [-0.9, 0, 0.9].flatMap(z => [[-6, 0, z] as Point3, [6, 0, z] as Point3]);
    const ends = starts.map(([x, y, z]) => [-x, y, z] as Point3);
    const safe: WalkableSegment = (a, b, radius = 0.29) => Math.max(Math.abs(a[2]), Math.abs(b[2])) + radius <= 1.5;
    const result = simulation(starts, ends, safe, 1, false);
    expect(result.movers.map(m => ({ phase: m.phase, position: m.position })), JSON.stringify(result.movers.map(m=>({id:m.id,p:m.position,n:m.natural,step:m.steps[m.stepIndex]})))).toEqual(ends.map(position => ({ phase: 'gone', position })));
    expect(result.minimum).toBeGreaterThanOrEqual(0.54);
  });

  it('retains stopped walking bodies in the real frame registry while six routes pass', () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const movers = Array.from({ length: 6 }, (_, i) => {
      const reverse = i >= 3, k = i % 3;
      const a = nav.waypoints.get(reverse ? 'f1.corridor-qa' : 'f1.corridor-library')!.position;
      const mover = createMover(`natural-crowd-${i}`, gaitParameters(), [a[0] + (reverse ? 1 : -1) * k * 0.95, a[1], a[2] + (k - 1) * 0.25], reverse ? -Math.PI / 2 : Math.PI / 2, false);
      setPace(mover, tripPace(mover.id, 0));
      return mover;
    });
    const bounded: WalkableSegment = (a, b, radius = 0.29) => Math.max(Math.abs(a[2] - 10), Math.abs(b[2] - 10)) + radius <= 1.4;
    const env: MovementEnv = { navigation: nav, elevators, walkable: bounded,
      nearbyWalkers: getNearbyMovingOccupantsSnapshot, trackWalker: trackMovingOccupant };
    try {
      movers.forEach((mover, i) => routeFrom(mover, i >= 3 ? 'f1.corridor-qa' : 'f1.corridor-library', { kind: 'leave', node: i >= 3 ? 'f1.corridor-library' : 'f1.corridor-qa' }, env, false));
      let minimum = Infinity;
      for (let frame = 0; frame < 60 * 90 && !movers.every(m => m.phase === 'gone'); frame++) {
        now += 1000 / 60;
        for (const mover of movers) {
          stepMover(mover, 1 / 60, env);
          if (mover.phase === 'walking' && mover.motion.walk <= 0.05) {
            expect(getMovingOccupantsSnapshot().some(body => body.id === mover.id)).toBe(true);
          }
        }
        for (let i = 0; i < movers.length; i++) for (let j = i + 1; j < movers.length; j++) {
          const a = movers[i]!, b = movers[j]!;
          if (a.phase === 'walking' && b.phase === 'walking') minimum = Math.min(minimum, Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]));
        }
      }
      expect(minimum).toBeGreaterThanOrEqual(0.54);
      expect(movers.map(m => ({ phase: m.phase, p: m.position })), JSON.stringify(movers.map(m => ({ id:m.id, p:m.position, n:m.natural, step:m.steps[m.stepIndex] })))).toEqual(movers.map((_, i) => ({ phase: 'gone', p: [...nav.waypoints.get(i >= 3 ? 'f1.corridor-library' : 'f1.corridor-qa')!.position] })));
    } finally {
      for (const mover of movers) trackMovingOccupant(mover.id, null);
      clock.mockRestore();
    }
  });

  it('shares the maximum walking-speed budget with lateral passing', () => {
    const result = simulation([[-6, 0, 0], [6, 0, 0]], [[6, 0, 0], [-6, 0, 0]], open, 3);
    expect(result.movers.map(m => m.phase)).toEqual(['gone', 'gone']);
    expect(result.minimum).toBeGreaterThanOrEqual(0.53);
    expect(result.maximumStep).toBeLessThanOrEqual(2.2 / 30 + 1e-6);
  });

  it('passes in a bounded hall without stepping through its walls', () => {
    const safe = (from: Readonly<Point3>, to: Readonly<Point3>, radius = 0.29) => Math.max(Math.abs(from[2]), Math.abs(to[2])) + radius <= 1.05;
    const result = simulation([[-6, 0, 0], [6, 0, 0]], [[6, 0, 0], [-6, 0, 0]], safe);
    expect(result.movers.map(m => m.phase)).toEqual(['gone', 'gone']);
    expect(result.minimum).toBeGreaterThanOrEqual(0.53);
    expect(result.paths.every(path => path.every(p => Math.abs(p[2]) + 0.29 <= 1.05))).toBe(true);
  });

  it('reconnects safely around a newly occupied static area without teleporting', () => {
    const safe: WalkableSegment = (a, b, radius = 0.29) => {
      const samples = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2]) / 0.08));
      for (let i = 0; i <= samples; i++) {
        const t = i / samples, x = a[0] + (b[0] - a[0]) * t, z = a[2] + (b[2] - a[2]) * t;
        if (Math.abs(x) < 0.4 + radius && Math.abs(z) < 0.4 + radius) return false;
      }
      return true;
    };
    const mover = createMover('static-reconnect', gaitParameters(), [-6, 0, 0], Math.PI / 2, false);
    mover.steps = naturalRoute(mover.position, [step('end', 6, 0)], nav, 0.5, open);
    const env: MovementEnv = { navigation: nav, elevators, walkable: safe };
    let lateral = 0;
    for (let frame = 0; frame < 30 * 60 && mover.phase !== 'gone'; frame++) {
      const before = [...mover.position] as Point3, yaw = mover.yaw;
      stepMover(mover, 1 / 30, env);
      expect(safe(before, mover.position)).toBe(true);
      expect(Math.hypot(mover.position[0] - before[0], mover.position[2] - before[2])).toBeLessThan(0.1);
      expect(Math.abs(Math.atan2(Math.sin(mover.yaw - yaw), Math.cos(mover.yaw - yaw)))).toBeLessThanOrEqual(6.2 / 30 + 1e-6);
      lateral = Math.max(lateral, Math.abs(mover.position[2]));
    }
    expect(mover.phase, JSON.stringify({ position: mover.position, step: mover.steps[mover.stepIndex], natural: mover.natural })).toBe('gone');
    expect(lateral).toBeGreaterThan(0.7);
  });

  it('publishes a walking body even when a clearance stop fades its walk pose out', () => {
    const mover = createMover('yielding-registry', gaitParameters(), [-6, 0, 0], Math.PI / 2, false);
    mover.steps = naturalRoute(mover.position, [step('end', 6, 0)], nav, 0.5, open);
    const env: MovementEnv = { navigation: nav, elevators, walkable: () => false, trackWalker: trackMovingOccupant };
    try {
      for (let i = 0; i < 30; i++) stepMover(mover, 1 / 60, env);
      expect(mover.motion.walk).toBe(0);
      expect(getMovingOccupantsSnapshot().some(body => body.id === mover.id)).toBe(true);
    } finally { trackMovingOccupant(mover.id, null); }
  });

  it('replans a changed goal from visible real waypoints during a synthetic local detour', () => {
    const mover = createMover('replan-detour', gaitParameters(), [-6, 0, 10], Math.PI / 2, false);
    mover.lastNode = 'natural-local-detour';
    mover.steps = naturalRoute(mover.position, [step('natural-local-detour', -4, 10)], nav, 0.5, open, false);
    const env: MovementEnv = { navigation: nav, elevators, walkable: open };
    expect(sendMover(mover, { kind: 'leave', node: 'f1.corridor-qa' }, env)).toBe(true);
    expect(mover.goal).toEqual({ kind: 'leave', node: 'f1.corridor-qa' });
    for (let i = 0; i < 60 * 60 && mover.phase !== 'gone'; i++) stepMover(mover, 1 / 60, env);
    expect(mover.phase).toBe('gone');
    expect(mover.position).toEqual([...nav.waypoints.get('f1.corridor-qa')!.position]);
    const blocked = createMover('replan-wait', gaitParameters(), [-6, 0, 10], 0, false);
    blocked.steps = naturalRoute(blocked.position, [step('natural-local-detour', -4, 10)], nav, 0.5, open, false);
    const previous = blocked.steps;
    const goal = { kind: 'leave' as const, node: 'f1.corridor-qa' };
    expect(sendMover(blocked, goal, { ...env, walkable: () => false })).toBe(true);
    expect(blocked.steps).toBe(previous);
    expect(blocked.pending).toBe(goal);
  });

  it('keeps short local detours steerable rather than treating them as exact contact tails', () => {
    const steps = naturalRoute([-1, 0, 0], [step('end', 1, 0)], nav, 0.5, open, false);
    const reconnect = reconnectNaturalRoute([-1, 0, 0], steps, 0, nav, 0.5, open);
    expect(reconnect).not.toBeNull();
    expect(reconnect!.steps.every(s => s.kind === 'walk' && Boolean(s.natural))).toBe(true);
  });

  it('recentres the captured offset-boundary case and resumes after its first safe stop', () => {
    const target: Point3 = [-2.6763987772480244, 0, 10.974563190997584];
    const leg = { from: [-2.6198736517226826, 0, 10.932530246893716] as Point3, transit: false, startDistance: 0.8105707793485444, endDistance: 1.6226861041141738,
      rightFrom: [0.7846554921695047, 0.6199320596712453] as const, rightTo: [0.36782077592613605, 0.9298967022186364] as const };
    const state = { ...createNaturalWalkState(), progress: 0.06564459956371763, offset: 0.06056961720963394, speed: 0, lateralSpeed: 0.026666666666666505 };
    let position: Point3 = [-2.648344516240868, 0, 11.027224008365177], arrived = false;
    const clear: WalkableSegment = (_a, b) => b[2] <= 11.0273;
    for (let i = 0; i < 120; i++) {
      const next = advanceNaturalWalk('boundary', position, target, leg, state, 1.33, 1 / 60, [], clear);
      expect(clear(position, next.position)).toBe(true);
      position = next.position; state.progress = next.progress; state.offset = next.offset; state.speed = next.speed; state.lateralSpeed = next.lateralSpeed;
      if (next.arrived) { arrived = true; break; }
    }
    expect(arrived).toBe(true);
  });

  it('uses the natural route in the actual mover route planner, not a visual-only offset', () => {
    const mover = createMover('actual-route', gaitParameters(), [14.6, 0, -5], 0, false);
    const env: MovementEnv = { navigation: nav, elevators, walkable: open };
    expect(routeFrom(mover, 'f1.east-hall', { kind: 'leave', node: 'f1.corridor-qa' }, env, false)).toBe(true);
    expect(mover.steps.some(step => step.kind === 'walk' && step.natural)).toBe(true);
    const first = mover.steps;
    expect(routeFrom(mover, 'f1.east-hall', { kind: 'leave', node: 'f1.corridor-qa' }, env, false)).toBe(true);
    expect(mover.steps).not.toEqual(first);
  });
});
