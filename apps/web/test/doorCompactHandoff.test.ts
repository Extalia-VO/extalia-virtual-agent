import { describe, expect, it } from 'vitest';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { DoorTraffic, type DoorInfo } from '../src/office/scene/interior/doorTraffic';
import type { Point3 } from '../src/office/scene/layout';
import { createMover, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { officeNavigation } from '../src/office/scene/movement/navGraph';

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };

function fixture(blockForward = false) {
  let now = 0;
  const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 1.6, height: 2.55, openAngle: Math.PI / 2, sliding: false };
  const doors = new DoorTraffic({ forEachDoor: visit => visit('door', door), forEachWalker() {} }, () => now);
  const mover = createMover('head', gaitParameters(), [0, 0, -1.1], 0, false);
  const goal = { kind: 'leave' as const, node: 'goal' };
  mover.goal = goal; mover.phase = 'doorwork';
  mover.steps = [[0, 0, 0], [0, 0, -.8], [1.5, 0, -1.1], [3, 0, -1.1]].map((to, i) =>
    ({ kind: 'walk' as const, node: i === 3 ? 'goal' : `step-${i}`, to: to as Point3, stairs: false }));
  mover.door = { id: 'door', door, kind: 'pass', beat: 'handoff', side: 1, entrySide: 1, hand: 1, timer: 0, path: null, shared: true };
  doors.queue('door', door, mover.id, mover.position, 1);
  doors.queue('door', door, 'tail', [0, 0, 3], 1);
  doors.hold('door', mover.id, 1, 2);
  const neighbors = [{ id: 'apron-body', position: [0, 0, -2.25] as Point3, velocity: [0, 0, 0] as Point3 },
    ...(blockForward ? [{ id: 'forward-body', position: [1.1, 0, -1.1] as Point3, velocity: [0, 0, 0] as Point3 }] : [])];
  const env: MovementEnv = { navigation: officeNavigation(), elevators, doors,
    walkable: (from, to) => !blockForward || Math.max(from[0], to[0]) < .6, nearbyWalkers: () => neighbors };
  const tick = () => { const before: Point3 = [...mover.position]; now += 1000 / 30; stepMover(mover, 1 / 30, env);
    expect(Math.hypot(...mover.position.map((v, i) => v - before[i]!) as Point3)).toBeLessThan(.08);
    for (const body of neighbors) expect(Math.hypot(mover.position[0] - body.position[0], mover.position[2] - body.position[2])).toBeGreaterThan(.56);
    expect(mover.goal).toBe(goal); expect(mover.recovery.attempts).toBe(0);
  };
  return { mover, doors, tick };
}

describe('compact doorway handoff into a turning aisle', () => {
  it('hands off after a full crossing and follows the clear original turn while the far apron is occupied', () => {
    const h = fixture(); h.tick();
    expect(h.mover.phase).toBe('walking');
    expect(h.doors.queueStatus('door', 'tail')).toMatchObject({ head: 'tail', ahead: 0, count: 1 });
    for (let i = 0; i < 180 && (h.mover.phase as string) !== 'gone'; i++) h.tick();
    expect(h.mover.phase).toBe('gone'); expect(h.mover.position).toEqual([3, 0, -1.1]);
  });

  it('retains the crossing ticket when the forward aisle is closed and far apron is occupied', () => {
    const h = fixture(true);
    for (let i = 0; i < 30; i++) h.tick();
    expect(h.mover.phase).toBe('doorwork');
    expect(h.doors.queueStatus('door', h.mover.id)).toMatchObject({ head: h.mover.id, ahead: 0, count: 2 });
    expect(h.mover.opacity).toBe(1);
  });

  it('closes after the final passer when a nearby body is not a queued successor', () => {
    let now = 0, occupied = true;
    const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 1.6, height: 2.55, openAngle: Math.PI / 2, sliding: false };
    const body: Point3 = [.8, 0, -.7];
    const doors = new DoorTraffic({ forEachDoor: visit => visit('door', door), forEachWalker: visit => {
      if (occupied) visit({ id: 'nearby', position: body, target: body, updatedAt: now });
    } }, () => now);
    const mover = createMover('last', gaitParameters(), [0, 0, -1.1], 0, false);
    mover.goal = { kind: 'leave', node: 'goal' }; mover.phase = 'doorwork';
    mover.steps = [{ kind: 'walk', node: 'inside', to: [0, 0, -.8], stairs: false }, { kind: 'walk', node: 'goal', to: [3, 0, -1.1], stairs: false }];
    mover.door = { id: 'door', door, kind: 'pass', beat: 'handoff', side: 1, entrySide: 1, hand: 1, timer: 0, path: null, shared: true };
    doors.queue('door', door, mover.id, mover.position, 1); doors.hold('door', mover.id, 1, 2);
    const env: MovementEnv = { navigation: officeNavigation(), elevators, doors, walkable: () => true,
      nearbyWalkers: () => occupied ? [{ id: 'nearby', position: body, velocity: [0, 0, 0] }] : [] };
    for (let frame = 0; frame < 900 && (mover.phase as string) !== 'gone'; frame++) {
      if (frame === 30) occupied = false;
      const before: Point3 = [...mover.position]; now += 1000 / 30; stepMover(mover, 1 / 30, env);
      expect(Math.hypot(...mover.position.map((v, i) => v - before[i]!) as Point3)).toBeLessThan(.08);
    }
    expect(mover.phase).toBe('gone'); expect(mover.position).toEqual([3, 0, -1.1]);
    expect(doors.amount('door')).toBe(0); expect(doors.queueStatus('door').count).toBe(0);
  });
});
