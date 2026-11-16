import { BoxGeometry, Group, Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import type { Point3 } from '../src/office/scene/layout';
import { createMover, placeSeated, sendMover, stepMover, type ElevatorAccess, type MovementEnv, type Mover } from '../src/office/scene/movement/mover';
import { WalkingClearance } from '../src/office/scene/movement/naturalClearance';
import { advanceNaturalWalk, createNaturalWalkState, type NaturalLeg, type WalkingNeighbor } from '../src/office/scene/movement/naturalWalking';
import { officeNavigation } from '../src/office/scene/movement/navGraph';

const navigation = officeNavigation();
const seat = navigation.seats.get('engineering.pod-a.seat-se')!;
const lifts: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };
const open: MovementEnv = { navigation, elevators: lifts, walkable: () => true, chairMotionClear: () => true, nearbyWalkers: () => [] };
type Beat = 'pull' | 'push' | 'lower' | 'scoot' | 'stand';
const beats: readonly Beat[] = ['pull', 'push', 'lower', 'scoot', 'stand'];
const distance = (a: Readonly<Point3>, b: Readonly<Point3>) => Math.hypot(a[0] - b[0], a[2] - b[2]);

/** Reach a real authored chair beat through its preceding choreography. */
function fixture(beat: Beat) {
  const standing = beat === 'stand' || beat === 'push';
  const mover = createMover(`chair-${beat}`, gaitParameters(), [...seat.staging], seat.rotationY, standing);
  if (standing) {
    placeSeated(mover, seat, open);
    expect(sendMover(mover, { kind: 'leave', node: navigation.entryId }, open)).toBe(true);
  } else {
    mover.goal = { kind: 'seat', seat };
  }
  const ready = () => beat === 'stand' ? mover.phase === 'standing' && mover.timer >= .2
    : mover.phase === 'chairing' && mover.chair?.beat === ({ pull: 2, push: 2, lower: 6, scoot: 7 }[beat])
      && mover.chair.kind === (standing ? 'stand' : 'sit') && mover.chair.timer >= .2;
  for (let frame = 0; frame < 30 * 30 && !ready(); frame++) stepMover(mover, 1 / 30, open);
  expect(ready(), `${beat} was not reached`).toBe(true);
  const proposal = structuredClone(mover);
  stepMover(proposal, .1, open);
  const length = distance(mover.position, proposal.position);
  expect(length).toBeGreaterThan(.003);
  const direction: Point3 = [(proposal.position[0] - mover.position[0]) / length, 0, (proposal.position[2] - mover.position[2]) / length];
  return { mover, proposal, direction };
}

function pose(mover: Mover) {
  return { position: [...mover.position], yaw: mover.yaw, pull: mover.chairPull, sit: mover.motion.sit,
    timer: mover.timer, beat: mover.chair?.beat, chairTimer: mover.chair?.timer, gaitPhase: mover.motion.phase, reach: structuredClone(mover.motion.reach) };
}
function completes(mover: Mover, beat: Beat, env: MovementEnv) {
  const standing = beat === 'stand' || beat === 'push';
  for (let frame = 0; frame < 30 * 30; frame++) {
    stepMover(mover, 1 / 30, env);
    if (standing ? mover.phase === 'walking' : mover.phase === 'seated') break;
  }
  expect(mover.phase).toBe(standing ? 'walking' : 'seated');
  if (!standing) { expect(mover.position).toEqual(seat.seat); expect(mover.chairPull).toBe(0); expect(mover.motion.sit).toBe(1); }
  expect(mover.opacity).toBe(1);
  expect(mover.recovery.attempts).toBe(0);
}

describe('chair root proposals preserve physical body clearance', () => {
  for (const beat of beats) {
    it.each(['stationary', 'moving'] as const)(`freezes ${beat} timer, chair and pose behind a %s body, then resumes`, motion => {
      const { mover, direction } = fixture(beat);
      const other: WalkingNeighbor = { id: 'passing-peer', position: [mover.position[0] + direction[0] * .56001, mover.position[1], mover.position[2] + direction[2] * .56001],
        velocity: motion === 'moving' ? [direction[0] * 3.5, 0, direction[2] * 3.5] : [0, 0, 0] };
      let blocked = true;
      const env = { ...open, nearbyWalkers: () => blocked ? [other] : [] };
      const before = pose(mover), goal = mover.goal, pending = mover.pending;
      for (let frame = 0; frame < 10; frame++) {
        stepMover(mover, .1, env);
        expect(pose(mover)).toEqual(before);
        expect(distance(mover.position, other.position)).toBeGreaterThanOrEqual(.56);
      }
      expect(mover.goal).toBe(goal); expect(mover.pending).toBe(pending);
      blocked = false;
      completes(mover, beat, env);
    });

    it(`holds ${beat} against a foreign rendered solid and resumes after its removal`, () => {
      const { mover, proposal, direction } = fixture(beat);
      const root = new Group(), field = new WalkingClearance();
      const floor = new Mesh(new BoxGeometry(100, .1, 100)); floor.position.set(0, mover.position[1] - .05, 0); root.add(floor);
      const foreign = new Mesh(new BoxGeometry(.02, 1.5, .02));
      const offset = .303 / Math.max(Math.abs(direction[0]), Math.abs(direction[2]));
      foreign.position.set(mover.position[0] + direction[0] * offset, mover.position[1] + .8, mover.position[2] + direction[2] * offset);
      root.add(foreign); field.rebuild([root]);
      expect(field.chairMotionClear(seat, mover.position, mover.position)).toBe(true);
      expect(field.chairMotionClear(seat, mover.position, proposal.position)).toBe(false);
      const env = { ...open, chairMotionClear: field.chairMotionClear };
      const before = pose(mover);
      for (let frame = 0; frame < 10; frame++) { stepMover(mover, .1, env); expect(pose(mover)).toEqual(before); }
      root.remove(foreign); field.rebuild([root]);
      expect(field.chairMotionClear(seat, mover.position, proposal.position)).toBe(true);
      completes(mover, beat, env);
      floor.geometry.dispose(); foreign.geometry.dispose(); field.clear();
    });
  }

  it('does not let stale predicted velocity erase the body occupying the next natural-walk segment', () => {
    const position: Point3 = [0, 0, 0], target: Point3 = [2, 0, 0];
    const leg: NaturalLeg = { from: position, transit: false, startDistance: 0, endDistance: 2, rightFrom: [0, -1], rightTo: [0, -1] };
    const neighbor: WalkingNeighbor = { id: 'stale-forecast', position: [.6, 0, 0], velocity: [3.5, 0, 0] };
    const advance = advanceNaturalWalk('walker', position, target, leg, createNaturalWalkState(), 2, .1, [neighbor], () => true);
    expect(distance(advance.position, neighbor.position)).toBeGreaterThanOrEqual(.56);
    expect(advance.position[0]).toBeLessThanOrEqual(.04 + 1e-6);
    const free = advanceNaturalWalk('walker', position, target, leg, createNaturalWalkState(), 2, .1, [], () => true);
    expect(free.position[0]).toBeGreaterThan(.1);
  });
});
