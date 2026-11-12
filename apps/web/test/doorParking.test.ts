import { describe, expect, it } from 'vitest';
import { DoorTraffic, doorAxes, doorHandedness, doorLeafDistance, doorPoint, type DoorInfo, type WalkerInfo } from '../src/office/scene/interior/doorTraffic';
import type { Point3 } from '../src/office/scene/layout';
import { DOOR_BODY_CLEARANCE } from '../src/office/scene/movement/doorChoreography';
import { doorWaitingPath, waitingSegmentClear } from '../src/office/scene/movement/doorWaitingPath';
import type { WalkableSegment, WalkingNeighbor } from '../src/office/scene/movement/naturalWalking';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { createMover, stepMover, type ElevatorAccess, type Mover, type MovementEnv } from '../src/office/scene/movement/mover';
import { officeNavigation } from '../src/office/scene/movement/navGraph';

const base: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 1.6, height: 2.55, openAngle: -Math.PI / 2, sliding: false };
const at = (door: DoorInfo, across: number, through: number): Point3 => doorPoint(door, across, through, [0, 0, 0]);
function shallowCorridor(door: DoorInfo, side: 1 | -1): WalkableSegment {
  return (a, b, radius = .29) => [a, b].every(point => {
    const p = doorAxes(door, point);
    return p.through * side >= radius + .08 && p.through * side <= 2.2 - radius && Math.abs(p.across) <= 2.2 - radius;
  });
}

describe('compact doorway waiting pockets', () => {
  for (const hinge of ['left', 'right'] as const) for (const side of [-1, 1] as const) for (const swing of [-1, 1]) {
    it(`steps aside in a shallow approach without occupying the future swing: ${hinge}/${side}/${swing}`, () => {
      const door = { ...base, hinge, yaw: .7, openAngle: swing * Math.PI / 2 };
      const from = at(door, 0, side * 1.3);
      const preferred = at(door, doorHandedness(door) * (door.clearWidth / 2 + .72), side * (door.clearWidth + .9));
      const clear = shallowCorridor(door, side);
      const neighbors: WalkingNeighbor[] = [{ id: 'operator', position: at(door, 0, side * .5), velocity: [0, 0, 0] }];
      expect(clear(from, preferred)).toBe(false);
      const path = doorWaitingPath('waiter', door, 0, side, from, preferred, clear, neighbors);
      expect(path).not.toBeNull();
      const end = path!.at(-1)!;
      expect(Math.abs(doorAxes(door, end).across)).toBeGreaterThan(door.clearWidth / 2 + DOOR_BODY_CLEARANCE);
      expect(doorAxes(door, end).through * side).toBeLessThan(door.clearWidth + .9);
      let previous = from;
      for (const point of path!) {
        expect(waitingSegmentClear('waiter', door, 0, side, previous, point, clear, neighbors)).toBe(true);
        previous = point;
      }
      for (let sample = 0; sample <= 100; sample++) expect(doorLeafDistance(door, sample / 100, end)).toBeGreaterThanOrEqual(DOOR_BODY_CLEARANCE);
    });
  }

  it('keeps the original deep waiting pocket when it is reachable', () => {
    const preferred = at(base, 1.52, 2.5);
    const path = doorWaitingPath('waiter', base, 0, 1, at(base, 0, 3), preferred, () => true)!;
    expect(doorAxes(base, path.at(-1)!).through).toBe(2.5);
  });

  it('refuses a narrow center lane instead of parking in the passage', () => {
    const clear: WalkableSegment = (a, b) => [a, b].every(p => Math.abs(p[0]) < .4 && p[2] < 1.9);
    expect(doorWaitingPath('waiter', base, 0, 1, [0, 0, 1.3], [1.52, 0, 2.5], clear)).toBeNull();
  });

  it('uses the other clear side pocket and refuses two occupied side pockets', () => {
    const clear = shallowCorridor(base, 1);
    const right: WalkingNeighbor = { id: 'right-waiter', position: [1.52, 0, 1.2], velocity: [0, 0, 0] };
    const left: WalkingNeighbor = { id: 'left-waiter', position: [-1.52, 0, 1.2], velocity: [0, 0, 0] };
    const path = doorWaitingPath('waiter', base, 0, 1, [0, 0, 1.3], [1.52, 0, 2.5], clear, [right])!;
    expect(path).not.toBeNull();
    expect(path.at(-1)![0]).toBeLessThan(-1);
    expect(doorWaitingPath('waiter', base, 0, 1, [0, 0, 1.3], [1.52, 0, 2.5], clear, [right, left])).toBeNull();
  });

  it('refuses a compact pocket that a longer future leaf swing would sweep through', () => {
    const door = { ...base, openAngle: -Math.PI };
    const clear: WalkableSegment = (a, b) => [a, b].every(p => p[2] >= .4 && p[2] < 1.7 && p[0] <= .2);
    expect(doorWaitingPath('waiter', door, 0, 1, [0, 0, 1.3], [1.52, 0, 2.5], clear)).toBeNull();
  });

  it('never crosses to the opposite side to reach a parking pocket', () => {
    expect(waitingSegmentClear('waiter', base, 0, 1, [0, 0, 1.3], [1.52, 0, -.8], () => true, [])).toBe(false);
  });
});

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };

describe('physical compact doorway queue', () => {
  for (const hinge of ['left', 'right'] as const) for (const firstSide of [-1, 1]) for (const apron of [null, 2.35, 2.45]) {
    it(`clears four opposing actors when deep parking is blocked: ${hinge}/${firstSide}/apron=${apron}`, () => {
      const door = { ...base, hinge };
      let now = 0;
      const actors: Mover[] = [], tracked = new Map<string, WalkerInfo>();
      const doors = new DoorTraffic({ forEachDoor: visit => visit('door', door), forEachWalker: visit => tracked.forEach(visit) }, () => now);
      for (let i = 0; i < 4; i++) {
        const side = firstSide * (i % 2 ? -1 : 1);
        const mover = createMover(`compact-${i}`, gaitParameters(), at(door, 0, side * (i < 2 ? .45 : 1.1)), 0, false);
        mover.goal = { kind: 'leave', node: `exit-${i}` };
        mover.steps = [0, -side * .8, -side * (apron ? 1.85 : 4)].map((through, j) => ({ kind: 'walk', node: `exit-${i}-${j}`, to: at(door, 0, through), stairs: false }));
        actors.push(mover);
        tracked.set(mover.id, { id: mover.id, position: [...mover.position], target: at(door, 0, 0), updatedAt: now });
      }
      const walkable: WalkableSegment = (from, to, radius = .29) => {
        const count = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[2] - from[2]) / .05));
        for (let i = 0; i <= count; i++) {
          const t = i / count, x = from[0] + (to[0] - from[0]) * t, z = from[2] + (to[2] - from[2]) * t;
          if (Math.abs(x) > 2.2 - radius || Math.abs(z) < radius + .08 && Math.abs(x) > door.clearWidth / 2 - radius) return false;
          if (apron !== null && Math.abs(z) > apron - radius) return false;
          // The central route continues into the room, but furniture prevents
          // every original deep lateral waiting target.
          if (Math.abs(z) > 2.65 - radius && Math.abs(x) > .75 - radius) return false;
        }
        return true;
      };
      const env: MovementEnv = { navigation: officeNavigation(), elevators, doors, walkable,
        nearbyWalkers: id => actors.filter(m => m.id !== id && m.phase !== 'gone').map(m => ({ id: m.id, position: [...m.position], velocity: [0, 0, 0] })),
        trackWalker(id, position, target) { if (position && target) tracked.set(id, { id, position: [...position], target: [...target], updatedAt: now }); else tracked.delete(id); },
      };
      expect(walkable([0, 0, 1.1], [.72, 0, 2.5])).toBe(false);
      if (apron !== null) {
        expect(walkable([0, 0, 2.25], [0, 0, 2.25])).toBe(false);
        expect(walkable([0, 0, 1.1], [0, 0, 1.1])).toBe(true);
      }
      const crossed: string[] = [];
      let compactWait = false, opened = false;
      for (let frame = 0; frame < 30 * 120 && actors.some(m => m.phase !== 'gone'); frame++) {
        for (const [i, actor] of actors.entries()) {
          const before = [...actor.position] as Point3;
          stepMover(actor, 1 / 30, env);
          expect(Math.hypot(...actor.position.map((value, axis) => value - before[axis]!) as Point3)).toBeLessThan(.08);
          expect(walkable(before, actor.position)).toBe(true);
          const side = firstSide * (i % 2 ? -1 : 1);
          if (!crossed.includes(actor.id) && doorAxes(door, actor.position).through * side < -.1) crossed.push(actor.id);
          compactWait ||= actor.door?.kind === 'wait' && Math.abs(actor.position[0]) > 1 && Math.abs(actor.position[2]) < 2;
        }
        for (let i = 0; i < actors.length; i++) for (let j = i + 1; j < actors.length; j++) {
          const a = actors[i]!, b = actors[j]!;
          if (a.phase !== 'gone' && b.phase !== 'gone') expect(Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]), `${a.id}/${b.id}`).toBeGreaterThan(.54);
        }
        opened ||= doors.amount('door') >= .99;
        if (opened && crossed.length < actors.length - 1) expect(doors.amount('door')).toBeGreaterThan(.98);
        now += 1000 / 30;
      }
      expect(actors.map(m => ({ id: m.id, phase: m.phase, position: m.position, act: m.door && { beat: m.door.beat, kind: m.door.kind } }))).toEqual(actors.map(m => ({ id: m.id, phase: 'gone', position: m.position, act: null })));
      expect(compactWait).toBe(true);
      expect(crossed).toEqual(actors.map(m => m.id));
      expect(doors.amount('door')).toBe(0);
    });
  }
});
