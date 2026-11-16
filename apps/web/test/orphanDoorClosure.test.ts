import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import type { NavEdge, Waypoint } from '@extalia/office';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { DoorTraffic, type DoorInfo, type WalkerInfo } from '../src/office/scene/interior/doorTraffic';
import type { Point3 } from '../src/office/scene/layout';
import { createMover, sendMover, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { officeNavigation, type OfficeNavigation } from '../src/office/scene/movement/navGraph';
import { doorClosePosition, doorWalkPath } from '../src/office/scene/movement/doorChoreography';
import { WalkingClearance } from '../src/office/scene/movement/naturalClearance';

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };
const portal: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 1.6, height: 2.55, openAngle: Math.PI / 2, sliding: false };

function fixture(otherPortal?: DoorInfo) {
  let now = 0, tail = true;
  const positions: [string, Point3][] = [['entry', [0, 0, 0]], ['inside', [0, 0, -.8]], ['turn', [1.5, 0, -1.1]],
    ['destination', [4, 0, -1.1]], ['latest', [4, 0, -2.5]]];
  const waypoints = new Map<string, Waypoint>(positions.map(([id, position]) => [id, { id, position, floorId: 'floor-1', kind: 'corridor' }]));
  const edges = new Map<string, NavEdge[]>(positions.map(([id]) => [id, []]));
  for (let i = 1; i < positions.length; i++) {
    const [a, p] = positions[i - 1]!, [b, q] = positions[i]!, cost = Math.hypot(p[0] - q[0], p[2] - q[2]);
    edges.get(a)!.push({ to: b, cost }); edges.get(b)!.push({ to: a, cost });
  }
  const navigation: OfficeNavigation = { ...officeNavigation(), graph: {
    nodes: new Map(positions.map(([id, p]) => [id, { id, floorId: 'floor-1', pos: { x: p[0], y: p[2] } }])), edges },
    waypoints, edges: [], seats: new Map(), aisles: new Map(), connectors: [], elevatorEdges: new Map(), entryId: 'entry' };
  const mover = createMover('last-actual-passer', gaitParameters(), [0, 0, -1.1], 0, false);
  mover.phase = 'doorwork'; mover.goal = { kind: 'leave', node: 'destination' };
  mover.steps = positions.slice(0, -1).map(([node, to]) => ({ kind: 'walk', node, to, stairs: false }));
  mover.door = { id: 'door', door: portal, kind: 'pass', beat: 'handoff', side: 1, entrySide: 1, hand: 1, timer: 0, path: null, shared: true };
  const doors = new DoorTraffic({ forEachDoor: visit => { visit('door', portal); if (otherPortal) visit('other', otherPortal); }, forEachWalker: visit => {
    if (mover.phase !== 'gone') visit({ id: mover.id, position: mover.position, target: mover.target ?? mover.position, updatedAt: now });
    if (tail) visit({ id: 'future-ticket', position: [0, 0, 3], target: [0, 0, 0], updatedAt: 0 });
  } }, () => now);
  doors.queue('door', portal, mover.id, mover.position, 1); doors.queue('door', portal, 'future-ticket', [0, 0, 3], 1);
  doors.hold('door', mover.id, 1, 2);
  const env: MovementEnv = { navigation, elevators, doors, walkable: () => true, nearbyWalkers: () => [] };
  const tick = () => {
    const before: Point3 = [...mover.position], leaf = doors.amount('door'); now += 1000 / 30; stepMover(mover, 1 / 30, env);
    expect(Math.hypot(...mover.position.map((v, i) => v - before[i]!) as Point3)).toBeLessThan(.08);
    if (doors.amount('door') !== leaf) { expect(mover.phase).toBe('doorwork'); expect(mover.door?.kind).toBe('close'); }
    if (mover.opacity < 1 || mover.phase === 'seated') expect(doors.amount('door')).toBe(0);
  };
  const cancel = () => { tail = false; doors.cancel('door', 'future-ticket'); };
  return { mover, doors, env, tick, cancel, time: () => now, keepTailFresh() { doors.queue('door', portal, 'future-ticket', [0, 0, 3], 1); } };
}

describe('last physical passer closes an orphaned hinged door', () => {
  it('consumes the actual flex aisle bridge around measured desks and finishes its unchanged goal without a scheduled update', () => {
    let now = 0;
    const navigation = officeNavigation(), origin: Point3 = [-9.45, 12.8, -6.332802584022788];
    const door: DoorInfo = { ...portal, floor: 3, center: [-6, 12.8, -9.5], yaw: Math.PI, hinge: 'right', openAngle: -Math.PI / 2 };
    const field = new WalkingClearance(), room = new Group();
    const floor = new Mesh(new BoxGeometry(20, .1, 20), new MeshBasicMaterial()); floor.position.set(-6, 12.75, -6); room.add(floor);
    // Actual rendered flex desktop dimensions and current row placement.
    for (const x of [-8.2, -3.8]) for (const z of [-6.3, -3.25]) {
      const desk = new Mesh(new BoxGeometry(1.65, .06, .82), new MeshBasicMaterial());
      desk.position.set(x, 13.555, z); room.add(desk);
    }
    field.rebuild([room]);
    const walkable = (from: Readonly<Point3>, to: Readonly<Point3>, radius = .29) => field.segmentClear(from, to, radius);
    for (const side of [-1, 1] as const) expect(doorWalkPath(door, 1, origin, doorClosePosition(door, 1, side, [0, 0, 0]), walkable)).toBeNull();
    const mover = createMover('flex-retained-closer', gaitParameters(), origin, 0, false);
    const goal = { kind: 'leave' as const, node: 'seat:flex.station-1:aisle' };
    const destination: Point3 = [...navigation.waypoints.get(goal.node)!.position];
    mover.goal = goal; mover.steps = [{ kind: 'walk', node: goal.node, to: destination, stairs: false }]; mover.target = origin;
    const doors = new DoorTraffic({ forEachDoor: visit => visit('flex', door), forEachWalker: visit => {
      if (mover.phase !== 'gone') visit({ id: mover.id, position: mover.position, target: mover.target ?? mover.position, updatedAt: now });
    } }, () => now);
    doors.hold('flex', mover.id, 1, 2); doors.release('flex', mover.id); doors.passed('flex', door, mover.id);
    const env: MovementEnv = { navigation, elevators, doors, walkable, nearbyWalkers: () => [] };
    let traversedAisle = false, walked = 0;
    for (let frame = 0; frame < 1800 && mover.phase !== 'gone'; frame++) {
      const before: Point3 = [...mover.position]; now += 1000 / 30; stepMover(mover, 1 / 30, env);
      const distance = Math.hypot(mover.position[0] - before[0], mover.position[2] - before[2]); walked += distance;
      expect(distance).toBeLessThan(.08); expect(walkable(before, mover.position), JSON.stringify({ before, after: mover.position, phase: mover.phase, door: mover.door })).toBe(true);
      if (mover.position[2] < -6.9 && mover.position[0] < -8) traversedAisle = true;
      if (mover.opacity < 1) expect(doors.amount('flex')).toBe(0);
    }
    expect(traversedAisle).toBe(true); expect(walked).toBeGreaterThan(5);
    expect(mover.phase).toBe('gone'); expect(mover.position).toEqual(destination); expect(mover.goal).toBe(goal);
    expect(doors.amount('flex')).toBe(0); expect(doors.duty(mover.id)).toBeNull();
  });

  it.each(['cancel', 'expire'] as const)('returns to close before fading when a promised successor will %s', outcome => {
    const h = fixture(); h.tick();
    expect(h.mover.phase).toBe('walking'); expect(h.doors.queueStatus('door')).toMatchObject({ head: 'future-ticket', count: 1 });
    expect(h.doors.duty(h.mover.id)?.id).toBe('door');
    for (let frame = 0; frame < 30 * 30 && h.mover.phase !== 'gone'; frame++) {
      if (outcome === 'cancel' && frame === 5) { h.cancel(); expect(h.doors.amount('door')).toBe(1); }
      h.tick();
    }
    expect(h.mover.phase).toBe('gone'); expect(h.mover.position).toEqual([4, 0, -1.1]);
    expect(h.doors.amount('door')).toBe(0); expect(h.doors.queueStatus('door').count).toBe(0);
  });

  it('finishes physical closure before applying a newer pending destination', () => {
    const h = fixture(), latest = { kind: 'leave' as const, node: 'latest' };
    expect(sendMover(h.mover, latest, h.env)).toBe(true); expect(h.mover.pending).toBe(latest);
    h.cancel();
    for (let frame = 0; frame < 30 * 30 && h.mover.phase !== 'gone'; frame++) h.tick();
    expect(h.mover.phase).toBe('gone'); expect(h.mover.position).toEqual([4, 0, -2.5]);
    expect(h.mover.goal).toBe(latest); expect(h.mover.pending).toBeNull(); expect(h.doors.amount('door')).toBe(0);
  });

  it('returns to an already reached final destination after closing instead of fading at the handle', () => {
    const h = fixture(); h.tick();
    h.mover.goal = { kind: 'leave', node: 'turn' };
    h.mover.steps = [{ kind: 'walk', node: 'turn', to: [1.5, 0, -1.1], stairs: false }]; h.mover.stepIndex = 0;
    for (let frame = 0; frame < 900 && h.mover.phase !== 'gone'; frame++) h.tick();
    expect(h.mover.phase).toBe('gone'); expect(h.mover.position).toEqual([1.5, 0, -1.1]); expect(h.doors.amount('door')).toBe(0);
  });

  it('retains responsibility at a reached seat instead of placing the actor while its promised follower remains', () => {
    const h = fixture(); h.tick();
    const seat = { seatId: 'example-station', roomId: 'example-room', floor: 1 as const, seat: [4, 0, -1.1] as Point3,
      staging: [4, 0, -1.1] as Point3, rotationY: 0, seatHeight: 0, standing: true, sitMs: 600, standMs: 1 };
    h.mover.goal = { kind: 'seat', seat };
    for (let frame = 0; frame < 900 && h.doors.amount('door') > 0; frame++) {
      h.keepTailFresh(); h.tick(); expect(h.mover.phase).not.toBe('seated');
    }
    expect(h.doors.amount('door')).toBe(0);
    h.cancel();
    for (let frame = 0; frame < 900 && h.mover.phase !== 'seated'; frame++) h.tick();
    expect(h.mover.phase).toBe('seated'); expect(h.mover.position).toEqual(seat.seat); expect(h.doors.amount('door')).toBe(0);
  });

  it.each(['elevator', 'stairs'] as const)('waits on the original floor before an %s transition until its retained door closes', transition => {
    const h = fixture(); h.tick();
    const request = vi.fn(); h.env.elevators.request = request;
    h.mover.steps = transition === 'elevator'
      ? [{ kind: 'elevator', node: 'lift-exit', elevatorId: 'A', from: 1, to: 2, exit: [0, 6.4, -1.1] }]
      : [{ kind: 'walk', node: 'stairs', to: [0, 3.2, -1.1], stairs: true }];
    h.mover.stepIndex = 0;
    for (let frame = 0; frame < 900 && h.doors.amount('door') > 0; frame++) {
      h.keepTailFresh(); h.tick(); expect(h.mover.position[1]).toBe(0); expect(h.mover.trip).toBeNull(); expect(request).not.toHaveBeenCalled();
    }
    expect(h.doors.amount('door')).toBe(0);
    h.cancel();
    for (let frame = 0; frame < 90 && (transition === 'elevator' ? !h.mover.trip : h.mover.position[1] === 0); frame++) h.tick();
    if (transition === 'elevator') expect(h.mover.trip?.id).toBe('A'); else expect(h.mover.position[1]).toBeGreaterThan(0);
  });

  it('transfers closure only to the next actual passer, never a cancelled or expired future ticket', () => {
    let now = 0;
    const tracked = new Map<string, WalkerInfo>();
    const doors = new DoorTraffic({ forEachDoor: visit => visit('door', portal), forEachWalker: visit => tracked.forEach(visit) }, () => now);
    doors.queue('door', portal, 'first', [0, 0, 2], 1); doors.hold('door', 'first', 1, 2);
    doors.passed('door', portal, 'first'); doors.finishPass('door', 'first');
    doors.queue('door', portal, 'cancelled', [0, 0, 3], 1); doors.cancel('door', 'cancelled');
    expect(doors.duty('first')?.id).toBe('door'); expect(doors.duty('cancelled')).toBeNull();
    doors.queue('door', portal, 'expired', [0, 0, 3], 1); now += 4000; doors.queueStatus('door');
    expect(doors.duty('first')?.id).toBe('door'); expect(doors.duty('expired')).toBeNull();
    doors.passed('door', portal, 'second');
    expect(doors.duty('first')).toBeNull(); expect(doors.duty('second')?.id).toBe('door');
    expect(doors.amount('door')).toBe(1);
  });

  it('releases only the completed door when a physical passer still owes another closure', () => {
    const doors = new DoorTraffic({ forEachDoor: visit => visit('door', portal), forEachWalker() {} }, () => 0);
    const other = { ...portal, center: [0, 0, 10] as Point3 };
    doors.hold('door', 'passer', 1, 2); doors.hold('other', 'passer', 1, 2);
    doors.passed('door', portal, 'passer'); doors.passed('other', other, 'passer');
    doors.clearDuty('passer', 'door'); expect(doors.duty('passer')?.id).toBe('other');
    doors.clearDuty('passer'); expect(doors.duty('passer')).toBeNull();
  });

  it('hands closure to a fresh operator physically beside the leaf, never a distant claim', () => {
    let now = 0;
    const tracked = new Map<string, WalkerInfo>();
    const doors = new DoorTraffic({ forEachDoor: visit => visit('door', portal), forEachWalker: visit => tracked.forEach(visit) }, () => now);
    doors.hold('door', 'owner', 1, 2); doors.release('door', 'owner'); doors.passed('door', portal, 'owner');
    doors.queue('door', portal, 'next', [0, 0, 10], 1);
    tracked.set('next', { id: 'next', position: [0, 0, 10], target: [0, 0, 0], updatedAt: now });
    expect(doors.claim('door', 'next')).toBe(true); expect(doors.duty('owner')?.id).toBe('door');
    doors.release('door', 'next'); now += 4000;
    tracked.set('next', { id: 'next', position: [-.8, 0, -.4], target: [0, 0, 0], updatedAt: 0 });
    doors.queue('door', portal, 'next', [-.8, 0, -.4], -1);
    expect(doors.claim('door', 'next')).toBe(true); expect(doors.duty('owner')?.id).toBe('door');
    doors.release('door', 'next');
    tracked.set('next', { id: 'next', position: [-.8, 0, -.4], target: [0, 0, 0], updatedAt: now });
    expect(doors.claim('door', 'next')).toBe(true);
    expect(doors.duty('owner')).toBeNull(); expect(doors.duty('next')?.id).toBe('door');
    doors.cancel('door', 'next'); expect(doors.duty('next')?.id).toBe('door');
    expect(doors.claimClosure('door', 'next')).toBe(true); expect(doors.hold('door', 'next', 0, 2)).toBe(0);
    expect(doors.duty('next')).toBeNull();
  });

  it('closes its retained door before entering a foreign portal, with the original goal preserved', () => {
    const h = fixture({ ...portal, center: [2.5, 0, -1.1], yaw: Math.PI / 2 }); h.tick();
    for (let frame = 0; frame < 1200 && h.mover.phase !== 'gone'; frame++) {
      if (frame === 60) h.cancel();
      h.tick();
      if (h.doors.amount('door') > 0) expect(h.mover.position[0]).toBeLessThan(2.5);
    }
    expect(h.mover.phase).toBe('gone'); expect(h.mover.position).toEqual([4, 0, -1.1]);
    expect(h.doors.amount('door')).toBe(0); expect(h.doors.amount('other')).toBe(0);
  });

  it('reserves closure service without reordering future crossings or stealing an active operator', () => {
    const doors = new DoorTraffic({ forEachDoor: visit => visit('door', portal), forEachWalker() {} }, () => 0);
    doors.hold('door', 'owner', 1, 2); doors.release('door', 'owner'); doors.passed('door', portal, 'owner');
    doors.queue('door', portal, 'first', [0, 0, 10], 1); doors.queue('door', portal, 'second', [0, 0, 12], 1);
    expect(doors.claimClosure('door', 'non-owner')).toBe(false);
    expect(doors.claim('door', 'first')).toBe(true); expect(doors.claimClosure('door', 'owner')).toBe(false); doors.release('door', 'first');
    expect(doors.claimClosure('door', 'owner')).toBe(true);
    expect(doors.queueStatus('door', 'first')).toMatchObject({ head: 'owner', ahead: 1, count: 3 });
    expect(doors.queueStatus('door', 'second').ahead).toBe(2);
    expect(doors.queue('door', portal, 'owner', [1, 0, -1], -1).granted).toBe(true);
    expect(doors.hold('door', 'owner', 0, 2)).toBe(0); doors.finishPass('door', 'owner');
    expect(doors.queueStatus('door', 'first')).toMatchObject({ head: 'first', ahead: 0, count: 2 });
    expect(doors.queueStatus('door', 'second').ahead).toBe(1); expect(doors.duty('owner')).toBeNull();
  });

  it('never accepts an exit-side ghost head or a distant head by skipping ahead to a nearby tail', () => {
    const walkers = new Map<string, WalkerInfo>();
    const doors = new DoorTraffic({ forEachDoor: visit => visit('door', portal), forEachWalker: visit => walkers.forEach(visit) }, () => 0);
    doors.queue('door', portal, 'head', [0, 0, 10], 1); doors.queue('door', portal, 'tail', [0, 0, 2], 1);
    walkers.set('head', { id: 'head', position: [0, 0, 10], target: [0, 0, 0], updatedAt: 0 });
    walkers.set('tail', { id: 'tail', position: [0, 0, 2], target: [0, 0, 0], updatedAt: 0 });
    expect(doors.localSuccessor('door', 'owner')).toBeNull();
    walkers.set('head', { id: 'head', position: [0, 0, -1.1], target: [0, 0, 0], updatedAt: 0 });
    expect(doors.localSuccessor('door', 'owner')).toBeNull();
    walkers.set('head', { id: 'head', position: [0, 0, 2], target: [0, 0, 0], updatedAt: 0 });
    expect(doors.localSuccessor('door', 'owner')).toBe('head');
  });

  it('lets two last passers physically reach each other’s doors without a deferred-duty boundary cycle', () => {
    let now = 0;
    const second = { ...portal, center: [6, 0, 0] as Point3 };
    const a = createMover('two-door-a', gaitParameters(), [0, 0, -1.1], 0, false);
    const b = createMover('two-door-b', gaitParameters(), [6, 0, -1.1], 0, false);
    const actors = [a, b];
    a.goal = { kind: 'leave', node: 'a-goal' }; b.goal = { kind: 'leave', node: 'b-goal' };
    a.steps = [[3, 0, -2.5], [6, 0, -2.5], [6, 0, .8], [6, 0, 3]].map((to, i) => ({ kind: 'walk', node: i === 3 ? 'a-goal' : `a-${i}`, to: to as Point3, stairs: false }));
    b.steps = [[3, 0, -4], [0, 0, -4], [0, 0, .8], [0, 0, 3]].map((to, i) => ({ kind: 'walk', node: i === 3 ? 'b-goal' : `b-${i}`, to: to as Point3, stairs: false }));
    const doors = new DoorTraffic({ forEachDoor: visit => { visit('first', portal); visit('second', second); }, forEachWalker: visit => {
      for (const mover of actors) if (mover.phase !== 'gone') {
        const step = mover.steps[mover.stepIndex];
        visit({ id: mover.id, position: mover.position, target: mover.target ?? (step?.kind === 'walk' ? step.to : mover.position), updatedAt: now });
      }
    } }, () => now);
    doors.hold('first', a.id, 1, 2); doors.hold('second', b.id, 1, 2);
    doors.passed('first', portal, a.id); doors.passed('second', second, b.id);
    doors.queue('first', portal, b.id, b.position, -1); doors.queue('second', second, a.id, a.position, -1);
    const waiting = new Set(actors.map(mover => mover.id)), began = new Set<string>();
    const env: MovementEnv = { navigation: officeNavigation(), elevators, doors, walkable: () => true,
      nearbyWalkers: id => actors.filter(other => other.id !== id && other.phase !== 'gone').map(other => ({ id: other.id, position: [...other.position], velocity: [0, 0, 0] })) };
    for (let frame = 0; frame < 30 * 60 && actors.some(mover => mover.phase !== 'gone'); frame++) {
      now += 1000 / 30;
      for (const mover of actors) {
        if (mover.door) began.add(mover.id);
        else if (began.has(mover.id)) waiting.delete(mover.id);
        if (waiting.has(mover.id)) doors.queue(mover === a ? 'second' : 'first', mover === a ? second : portal, mover.id, mover.position, -1);
        const before: Point3 = [...mover.position]; stepMover(mover, 1 / 30, env);
        expect(Math.hypot(...mover.position.map((v, i) => v - before[i]!) as Point3)).toBeLessThan(.08);
      }
    }
    expect(actors.map(mover => mover.phase)).toEqual(['gone', 'gone']);
    expect(a.position).toEqual([6, 0, 3]); expect(b.position).toEqual([0, 0, 3]);
    expect(doors.amount('first')).toBe(0); expect(doors.amount('second')).toBe(0);
  });
});
