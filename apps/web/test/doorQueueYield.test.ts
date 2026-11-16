import { describe, expect, it } from 'vitest';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { DoorTraffic, type DoorInfo } from '../src/office/scene/interior/doorTraffic';
import type { Point3 } from '../src/office/scene/layout';
import { createMover, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { officeNavigation } from '../src/office/scene/movement/navGraph';

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };

describe('same-ticket aisle yielding', () => {
  it.each(['queued', 'settled'] as const)('releases a cached yield when that peer is %s', mode => {
    const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 1.6, height: 2.55, openAngle: Math.PI / 2, sliding: false };
    const doors = new DoorTraffic({ forEachDoor: visit => visit('door', door), forEachWalker() {} }, () => 0);
    const mover = createMover('head', gaitParameters(), [1.52, 0, 2.5], 0, false);
    mover.goal = { kind: 'leave', node: 'outside' }; mover.phase = 'doorwork';
    mover.steps = [{ kind: 'walk', node: 'approach', to: [0, 0, .8], stairs: false }, { kind: 'walk', node: 'outside', to: [0, 0, -4], stairs: false }];
    mover.door = { id: 'door', door, kind: 'wait', beat: 'reserve', side: 1, entrySide: 1, hand: 1, timer: 0, path: [], queueIndex: 0,
      queueYield: { id: 'peer', origin: [...mover.position], direction: [0, 1] } };
    doors.queue('door', door, mover.id, mover.position, 1);
    if (mode === 'queued') doors.queue('door', door, 'peer', [0, 0, 2.5], 1);
    const env: MovementEnv = { navigation: officeNavigation(), elevators, doors, walkable: () => true,
      nearbyWalkers: () => [{ id: 'peer', position: [0, 0, 2.5], velocity: [0, 0, 0], ...(mode === 'queued' ? { target: [0, 0, 4] as Point3 } : {}) }] };
    stepMover(mover, 1 / 30, env);
    expect(mover.door?.queueYield).toBeUndefined();
    expect(doors.queueStatus('door', mover.id)).toMatchObject({ head: mover.id, ahead: 0, count: mode === 'queued' ? 2 : 1 });
    expect(mover.motion.walk).toBeGreaterThan(0);
  });

  for (const head of [false, true]) for (const side of [-1, 1] as const) it(`clears a released walker's corridor without giving up queue order: head=${head}, side=${side}`, () => {
    let now = 0;
    const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 1.6, height: 2.55, openAngle: Math.PI / 2, sliding: false };
    const doors = new DoorTraffic({ forEachDoor: visit => visit('door', door), forEachWalker() {} }, () => now);
    const waiting = createMover('waiting', gaitParameters(), [.72, 0, side * 2.5], 0, false);
    const passed = createMover('passed', gaitParameters(), [.72, 0, side * 1.7], 0, false);
    waiting.goal = { kind: 'leave', node: 'outside' };
    waiting.steps = [{ kind: 'walk', node: 'outside', to: [0, 0, -side * 6], stairs: false }];
    waiting.phase = 'doorwork';
    waiting.door = { id: 'door', door, kind: 'wait', beat: 'reserve', side, entrySide: side, hand: 1, timer: 0, path: null };
    passed.goal = { kind: 'leave', node: 'destination' };
    passed.steps = [{ kind: 'walk', node: 'destination', to: [.72, 0, side * 4.5], stairs: false }];
    if (!head) doors.queue('door', door, 'owner', [0, 0, -side * 2.5], -side as 1 | -1);
    doors.queue('door', door, waiting.id, waiting.position, side);
    const actors = [waiting, passed];
    const env: MovementEnv = { navigation: officeNavigation(), elevators, doors,
      walkable: (a, b) => [a, b].every(p => Math.abs(p[0]) < 2.2 && Math.abs(p[2]) < 7),
      nearbyWalkers: id => actors.filter(m => m.id !== id && m.phase !== 'gone').map(m => {
        const step = m.steps[m.stepIndex], target = m.phase === 'walking' ? m.target ?? (step?.kind === 'walk' ? step.to : null) : null;
        return { id: m.id, position: [...m.position], velocity: [0, 0, 0], ...(target ? { target: [...target] as Point3 } : {}) };
      }) };
    let yielded = false;
    for (let frame = 0; frame < 150 && passed.phase !== 'gone'; frame++) {
      now += 1000 / 30;
      if (!head) doors.queue('door', door, 'owner', [0, 0, -side * 2.5], -side as 1 | -1);
      for (const actor of actors) {
        const before: Point3 = [...actor.position]; stepMover(actor, 1 / 30, env);
        expect(Math.hypot(...actor.position.map((v, i) => v - before[i]!) as Point3)).toBeLessThan(.08);
      }
      yielded ||= Boolean(waiting.door?.queueYield);
      expect(doors.queueStatus('door', waiting.id)).toMatchObject({ head: head ? waiting.id : 'owner', ahead: head ? 0 : 1 });
      if ((passed.phase as string) !== 'gone') expect(Math.hypot(waiting.position[0] - passed.position[0], waiting.position[2] - passed.position[2])).toBeGreaterThan(.56);
    }
    expect(yielded).toBe(true);
    expect(passed.phase).toBe('gone'); expect(passed.position).toEqual([.72, 0, side * 4.5]);
    expect(actors.map(m => m.recovery.attempts)).toEqual([0, 0]);
  });
});
