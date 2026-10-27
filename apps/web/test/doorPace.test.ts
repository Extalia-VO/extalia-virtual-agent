import { describe, expect, it } from 'vitest';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { doorAxes, doorLeafDistance, doorPoint, DoorTraffic, DOOR_SWING_RATE, type DoorInfo } from '../src/office/scene/interior/doorTraffic';
import type { Point3 } from '../src/office/scene/layout';
import { DOOR_BODY_CLEARANCE, doorSwingSide } from '../src/office/scene/movement/doorChoreography';
import { createMover, setPace, stepMover, walkSpeed, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { officeNavigation } from '../src/office/scene/movement/navGraph';
import { doorInteractionTempo } from '../src/office/scene/movement/pace';
import { advanceWalkDistance, angleDelta } from '../src/office/scene/movement/walkCycle';

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };
function scene(door: DoorInfo, side: 1 | -1, pace: number, dt = 1 / 60, gait = gaitParameters()) {
  let now = 0;
  const mover = createMover('walker', gait, doorPoint(door, 0, side * 3, [0, 0, 0]), door.yaw, false);
  mover.steps = [{ kind: 'walk', node: 'exit', to: doorPoint(door, 0, -side * 3, [0, 0, 0]), stairs: false }];
  setPace(mover, pace);
  const doors = new DoorTraffic({ forEachDoor: visit => visit('door', door), forEachWalker: visit => {
    if (mover.phase === 'gone') return;
    const step = mover.steps[mover.stepIndex];
    visit({ id: mover.id, position: mover.position, target: step?.kind === 'walk' ? step.to : mover.position, updatedAt: now });
  } }, () => now);
  const env: MovementEnv = { navigation: officeNavigation(), elevators, doors };
  return { mover, doors, tick: () => { stepMover(mover, dt, env); now += dt * 1000; } };
}
const doorFixture = (hinge: 'left' | 'right', sign: number): DoorInfo => ({ floor: 1, center: [2, 0, -3], yaw: Math.PI / 3,
  clearWidth: 1.15, height: 2.55, openAngle: sign * Math.PI / 2, hinge, sliding: false });

describe('door interaction pace', () => {
  it('uses actual walking speed, including body gait and the shared speed cap', () => {
    const feminine = scene(doorFixture('left', -1), 1, 1, 1 / 60, gaitParameters({ gait: 'feminine', heightCm: 155 })).mover;
    const masculine = scene(doorFixture('left', -1), 1, 1, 1 / 60, gaitParameters({ gait: 'masculine', heightCm: 190 })).mover;
    expect(doorInteractionTempo(walkSpeed(masculine))).toBeGreaterThan(doorInteractionTempo(walkSpeed(feminine)));
    setPace(feminine, 100); setPace(masculine, 100);
    expect(doorInteractionTempo(walkSpeed(masculine))).toBeCloseTo(doorInteractionTempo(walkSpeed(feminine)));
    expect(doorInteractionTempo(0)).toBeGreaterThan(0);
    expect(Number.isFinite(doorInteractionTempo(NaN))).toBe(true);
  });

  for (const hinge of ['left', 'right'] as const) for (const sign of [-1, 1]) for (const side of [-1, 1] as const) {
    it.each([1 / 60, .1])(`coordinates slow/normal/fast entry and closure: ${hinge}, swing ${sign}, side ${side}, dt %f`, dt => {
      const durations: number[] = [];
      for (const pace of [.5, 1, 2]) {
        const door = doorFixture(hinge, sign), s = scene(door, side, pace, dt);
        let work = 0, grip = 0, release = 0, opened = false, closed = false, stationarySwing = false;
        let prior = 0;
        for (let frame = 0; frame < 60 * 90 && s.mover.phase !== 'gone'; frame++) {
          const before: Point3 = [...s.mover.position], phase = s.mover.motion.phase, oldBeat = s.mover.door?.beat;
          s.tick();
          const amount = s.doors.amount('door'), distance = Math.hypot(s.mover.position[0] - before[0], s.mover.position[2] - before[2]);
          if (s.mover.phase === 'doorwork') work += dt;
          if (oldBeat === 'grip') grip += dt;
          if (oldBeat === 'release') release += dt;
          expect(distance).toBeLessThanOrEqual(walkSpeed(s.mover) * dt + 1e-6);
          expect(doorLeafDistance(door, amount, s.mover.position)).toBeGreaterThanOrEqual(DOOR_BODY_CLEARANCE - .006);
          if (oldBeat === 'swing' && amount !== prior) for (let sample = 1; sample < 5; sample++) {
            const t = sample / 5;
            const between: Point3 = [before[0] + (s.mover.position[0] - before[0]) * t, before[1], before[2] + (s.mover.position[2] - before[2]) * t];
            expect(doorLeafDistance(door, prior + (amount - prior) * t, between)).toBeGreaterThanOrEqual(DOOR_BODY_CLEARANCE - .006);
          }
          const p = doorAxes(door, s.mover.position);
          for (const jamb of [-door.clearWidth / 2, door.clearWidth / 2]) expect(Math.hypot(p.across - jamb, p.through)).toBeGreaterThanOrEqual(.33);
          if (oldBeat === 'swing' && amount !== prior && distance < 1e-9) {
            stationarySwing = true;
            expect(s.mover.motion.phase).toBeCloseTo(phase, 10);
          }
          if (oldBeat === 'swing' && distance > 1e-7) {
            const dot = (s.mover.position[0] - before[0]) * Math.sin(s.mover.yaw) + (s.mover.position[2] - before[2]) * Math.cos(s.mover.yaw);
            const expected = advanceWalkDistance(phase, s.mover.gait, (dot < 0 ? -1 : 1) * distance, s.mover.motion.stride, .75);
            expect(Math.abs(angleDelta(expected, s.mover.motion.phase))).toBeLessThan(1e-6);
          }
          if (oldBeat && ['reserve', 'approach', 'passage', 'handoff'].includes(oldBeat) && distance > 1e-7) {
            const expected = advanceWalkDistance(phase, s.mover.gait, distance, s.mover.motion.stride);
            expect(Math.abs(angleDelta(expected, s.mover.motion.phase))).toBeLessThan(1e-6);
          }
          opened ||= amount > .5; closed ||= opened && amount === 0; prior = amount;
        }
        expect(s.mover.phase).toBe('gone'); expect(closed).toBe(true);
        expect(grip).toBeGreaterThanOrEqual(.7 / doorInteractionTempo(walkSpeed(s.mover)) - 3 * dt);
        expect(release).toBeGreaterThanOrEqual(.25 / doorInteractionTempo(walkSpeed(s.mover)) - 2 * dt);
        if (side === doorSwingSide(door)) expect(stationarySwing).toBe(true);
        durations.push(work);
      }
      expect(durations[1]!).toBeLessThan(durations[0]! * .8);
      expect(durations[2]!).toBeLessThan(durations[1]! * .85);
    });
  }

  it('adapts during the same swing when the trip pace changes, without jumping the leaf or feet', () => {
    const door = doorFixture('left', -1), side = -doorSwingSide(door) as 1 | -1, dt = 1 / 60;
    const s = scene(door, side, .6, dt);
    let changed = false, slowRate = 0, fastRate = 0;
    for (let frame = 0; frame < 60 * 60 && s.mover.phase !== 'gone'; frame++) {
      const before = s.doors.amount('door'), position: Point3 = [...s.mover.position];
      if (!changed && s.mover.door?.kind === 'open' && s.mover.door.beat === 'swing' && before > .25) {
        setPace(s.mover, 2); changed = true;
      }
      s.tick();
      const delta = s.doors.amount('door') - before;
      expect(Math.hypot(s.mover.position[0] - position[0], s.mover.position[2] - position[2])).toBeLessThanOrEqual(walkSpeed(s.mover) * dt + 1e-6);
      if (delta <= 0 || before > .8) continue;
      expect(delta).toBeLessThanOrEqual(DOOR_SWING_RATE * doorInteractionTempo(walkSpeed(s.mover)) * dt + 1e-8);
      if (changed) fastRate = Math.max(fastRate, delta / dt); else slowRate = Math.max(slowRate, delta / dt);
    }
    expect(changed).toBe(true); expect(fastRate).toBeGreaterThan(slowRate * 1.8);
    expect(s.mover.phase).toBe('gone');
  });
});
