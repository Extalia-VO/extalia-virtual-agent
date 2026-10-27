import { describe, expect, it } from 'vitest';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { getOfficeSeats } from '../src/office/scene/interior/seating';
import { isDeskChair, CHAIR_SLIDE } from '../src/office/scene/interior/deskChairs';
import { DoorTraffic, doorLeafDistance, DOOR_PASS_OPEN, SLIDE_HOLD_MS, type DoorInfo, type WalkerInfo } from '../src/office/scene/interior/doorTraffic';
import { officeNavigation, seatStageId, type SeatApproach } from '../src/office/scene/movement/navGraph';
import { createMover, routeFrom, sendMover, stepMover, type ElevatorAccess, type Mover, type MovementEnv } from '../src/office/scene/movement/mover';
import { chairWorld, GRIP_STAND, SIDE_STEP, standPull, roomPoint, sittingCentre, ARMREST, SEAT_EDGE } from '../src/office/scene/movement/chairChoreography';
import { OFFICE_CHAIR_SEAT_BLUEPRINT } from '../src/office/scene/interior/furnitureSeatBlueprint';
import { createCharacterMotion } from '../src/office/scene/movement/walkCycle';
import type { Point3 } from '../src/office/scene/layout';

const navigation = officeNavigation();
const noElevators: ElevatorAccess = {
  request() {}, waitingSlot: () => 0, canBoard: () => false, standingPosition: () => null, confirmBoarded: () => false,
  canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }),
};

/** A desk chair on the entry floor, so no elevator is needed. */
const deskSeat = (): SeatApproach => {
  const resource = getOfficeSeats().find(seat => seat.floor === 1 && isDeskChair(seat.id))!;
  return navigation.seats.get(resource.id)!;
};

describe('desk chair beats', () => {
  it('keeps stand-up and scoot hand contacts on the resized chair surfaces', () => {
    expect(ARMREST.y).toBe(OFFICE_CHAIR_SEAT_BLUEPRINT.armPadTop);
    expect(ARMREST.y).toBeLessThan(0.785);
    expect(ARMREST.x + OFFICE_CHAIR_SEAT_BLUEPRINT.armPadSize[0] / 2).toBeCloseTo(OFFICE_CHAIR_SEAT_BLUEPRINT.armOuterWidth / 2, 8);
    expect(SEAT_EDGE.y).toBe(OFFICE_CHAIR_SEAT_BLUEPRINT.cushionHeight);
    expect(SEAT_EDGE.z).toBe(OFFICE_CHAIR_SEAT_BLUEPRINT.seatFront);
  });

  it('only a held chair moves: it slides out with the hand and back in when pushed, and rests otherwise', () => {
    const seat = deskSeat();
    const env: MovementEnv = { navigation, elevators: noElevators };
    // Walk in from the staging point and sit down.
    const mover = createMover('sitter', gaitParameters(), [seat.staging[0], seat.staging[1], seat.staging[2]], seat.rotationY, false);
    mover.seat = seat;
    expect(routeFrom(mover, seatStageId(seat.seatId), { kind: 'seat', seat }, env, false)).toBe(true);
    const phases: string[] = [];
    const pulls: number[] = [];
    const holds: number[] = [];
    let seated = false;
    for (let frame = 0; frame < 30 * 14 && !seated; frame++) {
      stepMover(mover, 1 / 30, env);
      phases.push(mover.phase);
      pulls.push(mover.chairPull);
      holds.push(Math.max(mover.motion.reach[0].weight, mover.motion.reach[1].weight));
      seated = mover.phase === 'seated';
    }
    expect(seated).toBe(true);
    expect(phases).toContain('chairing');
    // The chair is out only during the beats that hold it (never while walking or seated).
    pulls.forEach((pull, index) => { if (pull > 1e-6) expect(['chairing', 'sitting', 'walking'].includes(phases[index]!)).toBe(true); });
    expect(Math.max(...pulls)).toBeCloseTo(1, 1);
    expect(pulls[pulls.length - 1]).toBe(0);
    // Whenever the chair moves, a hand is on it.
    for (let i = 1; i < pulls.length; i++) {
      if (Math.abs(pulls[i]! - pulls[i - 1]!) > 1e-4) expect(holds[i]!).toBeGreaterThan(0.5);
    }
    // Scooting in: both hands on the seat edge; the sitter ends on its seat.
    expect(mover.motion.reach[0].weight).toBe(0);
    expect(Math.hypot(mover.position[0] - seat.seat[0], mover.position[2] - seat.seat[2])).toBeLessThan(1e-3);
    expect(mover.motion.sit).toBe(1);
  });

  it('standing up rolls the chair back under the body, then the chair is pushed back in before the walk away', () => {
    const seat = deskSeat();
    const env: MovementEnv = { navigation, elevators: noElevators };
    const mover = createMover('stander', gaitParameters(), [...seat.seat] as Point3, seat.rotationY, true);
    mover.seat = seat;
    mover.motion.sit = 1;
    mover.phase = 'seated';
    expect(sendMover(mover, { kind: 'leave', node: navigation.entryId }, env)).toBe(true);
    const phases: string[] = [];
    const pulls: number[] = [];
    const sits: number[] = [];
    for (let frame = 0; frame < 30 * 12; frame++) {
      stepMover(mover, 1 / 30, env);
      phases.push(mover.phase);
      pulls.push(mover.chairPull);
      sits.push(mover.motion.sit);
      if ((mover.phase as string) === 'walking' && phases.includes('chairing') && mover.chairPull === 0) break;
    }
    // Standing: the chair rolls back while the body rises.
    const standing = phases.indexOf('standing');
    const chairing = phases.indexOf('chairing');
    expect(standing).toBeGreaterThanOrEqual(0);
    expect(chairing).toBeGreaterThan(standing);
    expect(pulls[chairing - 1]!).toBeCloseTo(1, 1);
    expect(sits[standing]!).toBeGreaterThan(0.9);
    // Pushed in: pull goes 1 → 0 only while held, then the walk away begins.
    const lastChair = phases.lastIndexOf('chairing');
    expect(pulls[lastChair]!).toBe(0);
    expect(phases[phases.length - 1]).toBe('walking');
    expect(mover.motion.sit).toBe(0);
  });

  it('places the chair parts consistently with the sitter (pulled chair, sitting centre, grip on the back)', () => {
    const seat = deskSeat();
    const out: [number, number, number] = [0, 0, 0];
    const tucked = sittingCentre(seat, 0, out);
    const pulled = sittingCentre(seat, 1, [0, 0, 0]);
    // The avatar root also follows the 2 cm offset rotating around the mesh pivot.
    expect(Math.hypot(pulled[0] - tucked[0], pulled[2] - tucked[2])).toBeGreaterThanOrEqual(CHAIR_SLIDE);
    expect(Math.hypot(pulled[0] - tucked[0], pulled[2] - tucked[2])).toBeLessThan(CHAIR_SLIDE + 0.02);
    const stand = roomPoint(seat, GRIP_STAND[0], GRIP_STAND[1], [0, 0, 0]);
    const side = roomPoint(seat, SIDE_STEP[0], SIDE_STEP[1], [0, 0, 0]);
    expect(Math.hypot(stand[0] - seat.seat[0], stand[2] - seat.seat[2])).toBeGreaterThan(0.8);
    expect(Math.hypot(side[0] - seat.seat[0], side[2] - seat.seat[2])).toBeGreaterThan(0.6);
    const back = chairWorld(seat, 1, 0, 1, -0.36, [0, 0, 0]);
    expect(Math.hypot(back[0] - seat.seat[0], back[2] - seat.seat[2])).toBeGreaterThan(0.6);
    expect(standPull(0)).toBe(0);
    expect(standPull(1)).toBe(1);
    expect(createCharacterMotion(false).reach[1].weight).toBe(0);
  });
});

interface Walker { mover: Mover; route: [number, number, number][] }

/** A door at the origin facing +Z, walkers as movers on plain walks, and the door's traffic. */
function doorScene() {
  let now = 0;
  const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 1.2, height: 2.55, openAngle: -Math.PI * 0.38, sliding: false };
  const walkers: Walker[] = [];
  const traffic = new DoorTraffic({
    forEachDoor: visit => visit('door', door),
    forEachWalker: visit => {
      for (const { mover } of walkers) {
        const step = mover.steps[mover.stepIndex];
        if (!['walking', 'doorwork'].includes(mover.phase) || !step || step.kind !== 'walk') continue;
        const info: WalkerInfo = { id: mover.id, position: mover.position, target: step.to, updatedAt: now };
        visit(info);
      }
    },
  }, () => now);
  const env: MovementEnv = { navigation, elevators: noElevators, doors: traffic };
  const add = (id: string, from: [number, number, number], to: [number, number, number]) => {
    const mover = createMover(id, gaitParameters(), from, 0, false);
    mover.phase = 'walking';
    mover.steps = [{ kind: 'walk', node: 'x', to, stairs: false }];
    mover.goal = { kind: 'leave', node: navigation.entryId };
    walkers.push({ mover, route: [from, to] });
    return mover;
  };
  const tick = () => { for (const { mover } of walkers) stepMover(mover, 1 / 30, env); now += 1000 / 30; };
  return { door, traffic, add, tick, walkers, get now() { return now; } };
}

describe('hinged doors', () => {
  it('finishes foot-limited swings at canonical fully closed/open amounts', () => {
    const {traffic}=doorScene();
    traffic.hold('door','a',1,.5);
    expect(traffic.hold('door','a',0,.5-1e-12)).toBe(0);
    traffic.hold('door','a',1,1/.9-1e-12);
    expect(traffic.amount('door')).toBe(1);
  });

  it('a lone walker stops, opens the door by hand, goes through and turns back to close it', () => {
    const scene = doorScene();
    const a = scene.add('a', [0, 0, -2], [0, 0, 2]);
    const kinds: string[] = [];
    const amounts: number[] = [];
    for (let frame = 0; frame < 30 * 30; frame++) {
      scene.tick();
      if (a.phase === 'doorwork') kinds.push(a.door!.kind);
      amounts.push(scene.traffic.amount('door'));
      if (a.position[2] > 0.6 && a.phase === 'walking' && scene.traffic.amount('door') < 0.02) break;
    }
    expect(kinds).toContain('open');
    expect(kinds).toContain('close');
    expect(kinds.indexOf('open')).toBeLessThan(kinds.indexOf('close'));
    // A push entry keeps hand contact through the full opening, then closes.
    expect(Math.max(...amounts)).toBeGreaterThanOrEqual(0.95);
    expect(amounts[amounts.length - 1]!).toBeLessThan(0.02);
    expect(a.position[2]).toBeGreaterThan(0.6);
  });

  it('finishes a partial pull without extending its released tug for a late arrival', () => {
    const scene = doorScene();
    const first = scene.add('first', [0, 0, 2], [0, 0, -3]);
    let late: ReturnType<typeof scene.add> | null = null;
    let sawPartial = false, frozenTarget = 0;
    for (let frame = 0; frame < 30 * 90; frame++) {
      scene.tick();
      if (!late && first.door?.kind === 'open' && first.door.beat === 'swing' && scene.traffic.amount('door') > .1) {
        frozenTarget = first.door.openAmount!;
        expect(frozenTarget).toBeGreaterThanOrEqual(.5);
        expect(frozenTarget).toBeLessThan(.8);
        late = scene.add('late', [0, 0, 3.2], [0, 0, -3]);
      }
      if (late && first.door?.kind === 'open') {
        expect(first.door.openAmount).toBe(frozenTarget);
        expect(scene.traffic.amount('door')).toBeLessThanOrEqual(frozenTarget);
        sawPartial ||= scene.traffic.amount('door') === frozenTarget;
      }
      if (late && first.phase === 'gone' && late.phase === 'gone') break;
    }
    expect(sawPartial).toBe(true);
    expect(first.phase).toBe('gone');
    expect(late?.phase).toBe('gone');
    expect(scene.traffic.amount('door')).toBe(0);
    expect(scene.traffic.claim('door', 'next')).toBe(true);
  });

  it('two characters at one door: the door stays open while the other is still coming, and the last one through closes it', () => {
    const scene = doorScene();
    const a = scene.add('a', [0, 0, -2], [0, 0, 2]);
    const b = scene.add('b', [0, 0, 3.2], [0, 0, -2]);
    let aCrossFrame = -1;
    let bCrossFrame = -1;
    let aClosed = false;
    let bClosed = false;
    let minWhileOtherComing = 1;
    for (let frame = 0; frame < 30 * 25; frame++) {
      scene.tick();
      if (a.phase === 'doorwork' && a.door!.kind === 'close') aClosed = true;
      if (b.phase === 'doorwork' && b.door!.kind === 'close') bClosed = true;
      if (aCrossFrame < 0 && a.position[2] > 0.3) aCrossFrame = frame;
      if (bCrossFrame < 0 && b.position[2] < -0.3) bCrossFrame = frame;
      // Keep the leaf open until the last walker takes it to close. A pull
      // behind the walker can finish as that person's body clears the frame.
      if (aCrossFrame >= 0 && bCrossFrame < 0 && !bClosed) minWhileOtherComing = Math.min(minWhileOtherComing, scene.traffic.amount('door'));
      if (a.position[2] > 1 && b.position[2] < -1.5 && scene.traffic.amount('door') < 0.02) break;
    }
    // The operator passes first; the other walker waits outside the leaf sweep.
    expect(bCrossFrame).toBeGreaterThanOrEqual(0);
    expect(bCrossFrame).toBeGreaterThan(aCrossFrame);
    expect(minWhileOtherComing).toBeGreaterThanOrEqual(DOOR_PASS_OPEN - 0.05);
    // Only the last one through closes the door behind them.
    expect(aClosed).toBe(false);
    expect(bClosed).toBe(true);
    expect(scene.traffic.amount('door')).toBeLessThan(0.02);
    expect(a.position[2]).toBeGreaterThan(1);
    expect(b.position[2]).toBeLessThan(-1.5);
  });

  it('two characters from opposite sides both get through and nobody is left waiting for ever', () => {
    const scene = doorScene();
    const a = scene.add('a', [0, 0, -2.5], [0, 0, 2.5]);
    const b = scene.add('b', [0.2, 0, 2.5], [0.2, 0, -2.5]);
    for (let frame = 0; frame < 30 * 30; frame++) scene.tick();
    expect(a.position[2]).toBeGreaterThan(2.4);
    expect(b.position[2]).toBeLessThan(-2.4);
    expect(scene.traffic.amount('door')).toBeLessThan(0.02);
  });

  it('rejoins a route with an inside marker without walking back through the open leaf after handoff', () => {
    const scene = doorScene();
    const a = scene.add('a', [0, 0, -3], [0, 0, 3]);
    a.steps.unshift(
      { kind: 'walk', node: 'threshold', to: [0, 0, 0], stairs: false },
      { kind: 'walk', node: 'inside', to: [0, 0, 0.8], stairs: false },
    );
    const b = scene.add('b', [0, 0, 3.2], [0, 0, -3]);
    let handedOff = false;
    for (let frame = 0; frame < 30 * 45; frame++) {
      scene.tick();
      const amount = scene.traffic.amount('door');
      if (amount > 0.99 && a.phase === 'walking' && a.position[2] > 0) handedOff = true;
      for (const mover of [a, b]) expect(doorLeafDistance(scene.door, amount, mover.position)).toBeGreaterThan(0.33);
    }
    expect(handedOff).toBe(true);
    expect(a.position[2]).toBeGreaterThan(2.9);
    expect(b.position[2]).toBeLessThan(-2.9);
    expect(scene.traffic.amount('door')).toBe(0);
  });

  it('a door is never swung by someone who is not holding it', () => {
    const scene = doorScene();
    scene.add('a', [0, 0, -8], [0, 0, 8]);
    for (let frame = 0; frame < 30; frame++) scene.tick();
    expect(scene.traffic.amount('door')).toBe(0);
    expect(scene.traffic.request('door', scene.door, 'nobody')).toBe('open');
    // Someone's hand is on the leaf, partly open: a stranger waits instead of swinging it.
    expect(scene.traffic.hold('door', 'other', 1, 0.5)).toBeCloseTo(0.45, 2);
    expect(scene.traffic.request('door', scene.door, 'nobody')).toBe('wait');
  });
});

describe('sliding doors', () => {
  it('opens for an approaching walker and closes shortly after the last one has passed', () => {
    let now = 0;
    const walker = { id: 'w', position: [0, 0, -3] as [number, number, number], target: [0, 0, 3] as [number, number, number], updatedAt: 0 };
    let walkerPresent = true;
    const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 2.4, height: 2.6, openAngle: 0, sliding: true };
    const traffic = new DoorTraffic({
      forEachDoor: visit => visit('slide', door),
      forEachWalker: visit => { if (walkerPresent) visit({ ...walker, updatedAt: now }); },
    }, () => now);
    const step = (seconds: number) => { for (let i = 0; i < seconds * 30; i++) { traffic.slideStep('slide', door, 1 / 30); now += 1000 / 30; } };
    step(0.1);
    walkerPresent = true;
    walker.position[2] = -1.2;
    step(1);
    expect(traffic.amount('slide')).toBeGreaterThan(0.9);
    // The walker has gone through; the leaf stays open for a moment, then closes.
    walkerPresent = false;
    step(0.3);
    expect(traffic.amount('slide')).toBeGreaterThan(0.5);
    step(SLIDE_HOLD_MS / 1000 + 1.5);
    expect(traffic.amount('slide')).toBeLessThan(0.05);
  });
});
