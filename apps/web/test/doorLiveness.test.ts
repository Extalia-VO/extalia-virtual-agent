import { describe, expect, it } from 'vitest';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { doorAxes, doorLeafDistance, doorPoint, DoorTraffic, type DoorInfo, type WalkerInfo } from '../src/office/scene/interior/doorTraffic';
import type { Point3 } from '../src/office/scene/layout';
import { createMover, routeFrom, sendMover, stepMover, type ElevatorAccess, type MovementEnv, type Mover } from '../src/office/scene/movement/mover';
import { officeNavigation, type OfficeNavigation } from '../src/office/scene/movement/navGraph';
import { DOOR_BODY_CLEARANCE } from '../src/office/scene/movement/doorChoreography';
import { walkSpeed } from '../src/office/scene/movement/mover';
import { LEISURE_SPOTS } from '../src/office/scene/movement/leisureSpots';
import { OFFICE_DOOR_PORTALS } from './fixtures/officeDoorPortals';

const navigation = officeNavigation();
const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };

function scene(door: DoorInfo, nav = navigation) {
  let now = 0;
  const walkers: Mover[] = [], tracked = new Map<string, WalkerInfo>();
  const doors = new DoorTraffic({ forEachDoor: visit => visit('door', door), forEachWalker: visit => { for (const walker of tracked.values()) visit(walker); } }, () => now);
  const env: MovementEnv = { navigation: nav, elevators, doors, trackWalker(id, position, target) {
    if (position && target) tracked.set(id, { id, position: [...position], target: [...target], updatedAt: now }); else tracked.delete(id);
  } };
  const add = (id: string, side: 1 | -1, distance: number, end = 3, across = 0) => {
    const point = (through: number): Point3 => doorPoint(door, across, through, [0, 0, 0]);
    const mover = createMover(id, gaitParameters(), point(side * distance), door.yaw, false);
    mover.steps = [0, -side * 0.8, -side * end].map((through, index) => ({ kind: 'walk', node: `route-${id}-${index}`, to: point(through), stairs: false }));
    walkers.push(mover);
    return mover;
  };
  const tick = () => { for (const mover of walkers) stepMover(mover, 1 / 30, env); now += 1000 / 30; };
  const state = () => walkers.map(mover => ({ id: mover.id, position: mover.position, phase: mover.phase, door: mover.door && { kind: mover.door.kind, beat: mover.door.beat, side: mover.door.side, path: mover.door.path }, index: mover.stepIndex }));
  return { add, doors, env, walkers, tick, state };
}

describe('door traffic liveness', () => {
  it('completes actual office leisure routes through rendered portal geometry', () => {
    const portals = OFFICE_DOOR_PORTALS;
    const failures: unknown[] = [];
    for (const spot of LEISURE_SPOTS) {
      const destination = navigation.seats.get(spot.id)!;
      const sources = [...navigation.seats.values()].filter(seat => seat.floor === destination.floor && seat.roomId !== destination.roomId).filter((_, index) => index % 7 === 0);
      for (const source of sources) {
        let now = 0;
        const tracked = new Map<string, WalkerInfo>();
        const doors = new DoorTraffic({ forEachDoor: visit => { for (const portal of portals) visit(portal.id, portal); }, forEachWalker: visit => { for (const walker of tracked.values()) visit(walker); } }, () => now);
        const env: MovementEnv = { navigation, elevators, doors, trackWalker(id, position, target) { if (position && target) tracked.set(id, { id, position: [...position], target: [...target], updatedAt: now }); else tracked.delete(id); } };
        const mover = createMover('wanderer', gaitParameters(), [...source.staging], source.rotationY, false);
        if (!routeFrom(mover, `seat:${source.seatId}:stage`, { kind: 'seat', seat: destination }, env, false)) continue;
        for (let frame = 0; frame < 30 * 180; frame++) {
          for (const portal of portals) if (portal.sliding) doors.slideStep(portal.id, portal, 1 / 30);
          stepMover(mover, 1 / 30, env); now += 1000 / 30;
          if (mover.phase === 'seated' || mover.phase === 'gone') break;
        }
        if (mover.phase !== 'seated') failures.push({ from: source.seatId, to: destination.seatId, position: mover.position,
          phase: mover.phase, door: mover.door && { id: mover.door.id, beat: mover.door.beat, timer: mover.door.timer }, step: mover.steps[mover.stepIndex] });
      }
    }
    expect(failures).toEqual([]);
  });

  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) for (const hinge of ['left', 'right'] as const) {
    for (const { startThrough, direction } of [
      { startThrough: 0, direction: -1 }, { startThrough: 0, direction: 1 },
      { startThrough: -0.1, direction: 1 }, { startThrough: 0.1, direction: -1 },
    ]) {
      it(`retreats a stranded walker before opening: yaw ${yaw}, ${hinge} hinge, ${startThrough} → ${direction}`, () => {
        const door: DoorInfo = { floor: 1, center: [2, 0, -3], yaw, clearWidth: 1.6, height: 2.55,
          openAngle: direction * Math.PI / 2, hinge, sliding: false };
        const s = scene(door);
        const point = (through: number): Point3 => doorPoint(door, 0, through, [0, 0, 0]);
        const mover = s.add('stranded', startThrough <= 0 ? -1 : 1, 2);
        const start = point(startThrough);
        mover.position[0] = start[0]; mover.position[1] = start[1]; mover.position[2] = start[2];
        mover.prev[0] = start[0]; mover.prev[1] = start[1]; mover.prev[2] = start[2];
        mover.steps = [direction * 0.8, direction * 3].map((through, index) => ({ kind: 'walk' as const,
          node: `stranded-${index}`, to: point(through), stairs: false }));
        mover.stepIndex = 0;
        mover.goal = { kind: 'leave', node: `stranded-1` };
        const retreatSide = startThrough === 0 ? -direction : Math.sign(startThrough);
        const dt = 1 / 30, maxStep = walkSpeed(mover) * dt + 1e-6;
        let recovered = false, opened = false;
        for (let frame = 0; frame < 30 * 120; frame++) {
          const before = [...mover.position] as Point3;
          s.tick();
          expect(Math.hypot(mover.position[0] - before[0], mover.position[1] - before[1], mover.position[2] - before[2]), JSON.stringify(s.state())).toBeLessThanOrEqual(maxStep);
          const through = doorAxes(door, mover.position).through;
          const amount = s.doors.amount('door');
          if (amount > 1e-6 && !opened) {
            opened = true;
            expect(recovered).toBe(true);
          }
          const clearance = doorLeafDistance(door, amount, mover.position);
          if (!recovered) {
            expect(through * retreatSide, JSON.stringify({ frame, through, amount, retreatSide, door: mover.door && { beat: mover.door.beat, side: mover.door.side }, position: mover.position })).toBeGreaterThanOrEqual(-1e-5);
            if (clearance >= DOOR_BODY_CLEARANCE) recovered = true;
          } else expect(clearance).toBeGreaterThanOrEqual(DOOR_BODY_CLEARANCE - 0.01);
          if (mover.phase === 'vanishing' || mover.phase === 'gone') break;
        }
        expect(recovered).toBe(true);
        expect(opened).toBe(true);
        expect(mover.phase).toMatch(/^(vanishing|gone)$/);
        expect(mover.door).toBeNull();
        expect(s.doors.claim('door', 'next')).toBe(true);
      });
    }
  }

  for (const portal of OFFICE_DOOR_PORTALS.filter(item => !item.sliding)) for (const epsilon of [-1e-12, 1e-12]) {
    it(`detects epsilon crossing at authored portal ${portal.id}: ${epsilon}`, () => {
      const doors = new DoorTraffic({ forEachDoor: visit => visit(portal.id, portal), forEachWalker() {} }, () => 0);
      const direction = Math.sign(epsilon);
      const from = doorPoint(portal, 0, -direction * 0.8, [0, 0, 0]);
      const target = doorPoint(portal, 0, epsilon, [0, 0, 0]);
      expect(doors.doorAhead(from, target)?.id).toBe(portal.id);
    });
  }

  for (const changeAt of ['open:reserve', 'open:swing', 'open:passage', 'close:grip', 'close:swing', 'close:release']) {
    it(`honors replacement wander goals during ${changeAt} and releases the door`, () => {
      const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 1.6, height: 2.55, openAngle: Math.PI / 2, sliding: false };
      const points: readonly [string, Point3][] = [['entry', [0, 0, -3]], ['threshold', [0, 0, 0]], ['inside', [0, 0, 0.8]], ['far', [0, 0, 3]], ['return', [-2, 0, -3]]];
      const links: readonly (readonly [string, string])[] = [['entry', 'threshold'], ['threshold', 'inside'], ['inside', 'far'], ['entry', 'return']];
      const nav: OfficeNavigation = { ...navigation, entryId: 'entry',
        waypoints: new Map(points.map(([id, position]) => [id, { id, position, floorId: 'floor-1', kind: 'corridor' as const }])),
        graph: { nodes: new Map(points.map(([id, position]) => [id, { id, floorId: 'floor-1', pos: { x: position[0], y: position[2] } }])),
          edges: new Map(points.map(([id]) => [id, links.flatMap(([a, b]) => a === id ? [{ to: b, cost: 3 }] : b === id ? [{ to: a, cost: 3 }] : [])])) } };
      const s = scene(door, nav);
      const mover = s.add('wanderer', -1, 3);
      routeFrom(mover, 'entry', { kind: 'leave', node: 'far' }, s.env, false);
      let changed = false;
      for (let frame = 0; frame < 30 * 120; frame++) {
        s.tick();
        if (!changed && mover.door && `${mover.door.kind}:${mover.door.beat}` === changeAt) {
          expect(sendMover(mover, { kind: 'leave', node: 'far' }, s.env)).toBe(true);
          expect(sendMover(mover, { kind: 'leave', node: 'return' }, s.env)).toBe(true);
          changed = true;
        }
        expect(doorLeafDistance(door, s.doors.amount('door'), mover.position), JSON.stringify(s.state())).toBeGreaterThan(0.33);
        if (mover.phase === 'gone') break;
      }
      expect(changed).toBe(true);
      expect(mover.phase, JSON.stringify(s.state())).toBe('gone');
      expect(mover.position).toEqual([-2, 0, -3]);
      expect(s.doors.claim('door', 'next')).toBe(true);
    });
  }

  for (const seed of Array.from({ length: 16 }, (_, i) => i)) it(`clears staggered nearby traffic ${seed}`, () => {
    const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: seed % 3 === 0 ? 1 : 1.6, height: 2.55,
      openAngle: (seed % 2 ? 1 : -1) * Math.PI * (seed % 4 < 2 ? 0.5 : 0.38), hinge: seed % 4 < 2 ? 'left' : 'right', sliding: false };
    const s = scene(door);
    for (let index = 0; index < 4; index++) s.add(`walker-${index}`, (index + seed) % 2 ? 1 : -1, 0.42 + ((seed * 7 + index * 11) % 24) / 10, index % 2 ? 0.8 : 3, ((seed + index) % 3 - 1) * 0.1);
    for (let frame = 0; frame < 30 * 100; frame++) {
      s.tick();
      for (const mover of s.walkers.filter(mover => mover.phase !== 'gone' && mover.phase !== 'vanishing')) expect(doorLeafDistance(door, s.doors.amount('door'), mover.position), JSON.stringify(s.state())).toBeGreaterThan(0.33);
      if (s.walkers.every(mover => mover.phase === 'gone')) break;
    }
    expect(s.walkers.every(mover => mover.phase === 'gone'), JSON.stringify(s.state())).toBe(true);
    expect(s.doors.claim('door', 'next')).toBe(true);
  });

  for (const hinge of ['left', 'right'] as const) for (const sign of [-1, 1]) {
    it(`clears opposing wanderers with inside route markers: ${hinge}, ${sign}`, () => {
      const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 1.6, height: 2.55, openAngle: sign * Math.PI / 2, hinge, sliding: false };
      const s = scene(door);
      s.add('first', -1, 2.5);
      s.add('opposing', 1, 2.5);
      s.add('following', -1, 3.2, 0.8);
      for (let frame = 0; frame < 30 * 100; frame++) {
        s.tick();
        for (const mover of s.walkers.filter(mover => mover.phase !== 'gone' && mover.phase !== 'vanishing')) expect(doorLeafDistance(door, s.doors.amount('door'), mover.position), JSON.stringify(s.state())).toBeGreaterThan(0.33);
        if (s.walkers.every(mover => mover.phase === 'gone')) break;
      }
      expect(s.walkers.every(mover => mover.phase === 'gone'), JSON.stringify(s.state())).toBe(true);
      expect(s.doors.claim('door', 'next')).toBe(true);
    });
  }
});
