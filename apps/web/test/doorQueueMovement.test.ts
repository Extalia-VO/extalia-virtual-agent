import { describe, expect, it } from 'vitest';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { DoorTraffic, doorAxes, doorPoint, type DoorInfo, type WalkerInfo } from '../src/office/scene/interior/doorTraffic';
import type { Point3 } from '../src/office/scene/layout';
import { createMover, stepMover, type ElevatorAccess, type Mover, type MovementEnv } from '../src/office/scene/movement/mover';
import { officeNavigation } from '../src/office/scene/movement/navGraph';

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };

describe('physical doorway queue', () => {
  for (const sliding of [false, true]) it(`parks opposing traffic, admits one at a time and closes after the last passer: sliding=${sliding}`, () => {
    let now = 0;
    const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 1.6, height: 2.55, openAngle: Math.PI / 2, sliding };
    const tracked = new Map<string, WalkerInfo>();
    const traffic = new DoorTraffic({ forEachDoor: visit => visit('door', door), forEachWalker: visit => { for (const walker of tracked.values()) visit(walker); } }, () => now);
    const actors: Mover[] = [];
    const sides = new Map<string, number>();
    const at = (x: number, z: number): Point3 => doorPoint(door, x, z, [0, 0, 0]);
    for (let i = 0; i < 6; i++) {
      const side = i % 2 ? -1 : 1;
      const mover = createMover(`actor-${i}`, gaitParameters(), at(0, side * (2.8 + Math.floor(i / 2) * 1.1)), 0, false);
      mover.goal = { kind: 'leave', node: `exit-${i}` };
      mover.steps = [0, -side * .8, -side * 6].map((z, index) => ({ kind: 'walk', node: `exit-${i}-${index}`, to: at(0, z), stairs: false }));
      actors.push(mover); sides.set(mover.id, side);
      tracked.set(mover.id, { id: mover.id, position: [...mover.position], target: at(0, 0), updatedAt: now });
    }
    const env: MovementEnv = { navigation: officeNavigation(), elevators, doors: traffic,
      trackWalker(id, position, target) { if (position && target) tracked.set(id, { id, position: [...position], target: [...target], updatedAt: now }); else tracked.delete(id); },
      walkable(from, to, radius = .29) {
        for (let i = 0; i <= 12; i++) {
          const t = i / 12, x = from[0] + (to[0] - from[0]) * t, z = from[2] + (to[2] - from[2]) * t;
          if (Math.abs(z) < radius + .08 && Math.abs(x) > door.clearWidth / 2 - radius) return false;
        }
        return true;
      },
      nearbyWalkers: id => actors.filter(other => other.id !== id && other.phase !== 'gone').map(other => ({ id: other.id, position: [...other.position], velocity: [0, 0, 0] })),
    };
    const crossed: string[] = [];
    let parked = false;
    let opened = false;
    for (let frame = 0; frame < 30 * 180; frame++) {
      if (sliding) traffic.slideStep('door', door, 1 / 30);
      for (const actor of actors) {
        const before = [...actor.position] as Point3;
        stepMover(actor, 1 / 30, env);
        expect(Math.hypot(actor.position[0] - before[0], actor.position[2] - before[2])).toBeLessThan(.08);
        if (!crossed.includes(actor.id) && doorAxes(door, actor.position).through * sides.get(actor.id)! < -.1) crossed.push(actor.id);
        if (actor.door?.kind === 'wait' && Math.abs(actor.position[0]) > .65) parked = true;
      }
      for (let i = 0; i < actors.length; i++) for (let j = i + 1; j < actors.length; j++) {
        const a = actors[i]!, b = actors[j]!;
        if (a.phase === 'gone' || b.phase === 'gone') continue;
        expect(Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]), `${a.id}/${b.id}`).toBeGreaterThan(.54);
      }
      if (traffic.amount('door') >= .99) opened = true;
      if (opened && crossed.length < actors.length) expect(traffic.amount('door')).toBeGreaterThan(.98);
      now += 1000 / 30;
      if (actors.every(actor => actor.phase === 'gone')) break;
    }
    expect(actors.map(actor => ({ id: actor.id, phase: actor.phase, pos: actor.position, door: actor.door && { kind: actor.door.kind, beat: actor.door.beat } }))).toEqual(actors.map(actor => ({ id: actor.id, phase: 'gone', pos: actor.position, door: null })));
    // The four already approaching keep FIFO order; distant tails can arrive
    // in either order because their gait speeds differ.
    expect(crossed.slice(0, 4)).toEqual(actors.slice(0, 4).map(actor => actor.id));
    expect(new Set(crossed)).toEqual(new Set(actors.map(actor => actor.id)));
    expect(parked).toBe(true);
    for (let frame = 0; frame < 90; frame++) { now += 1000 / 30; if (sliding) traffic.slideStep('door', door, 1 / 30); }
    expect(traffic.amount('door')).toBeLessThan(.01);
  });
});
