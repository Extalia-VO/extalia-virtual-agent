import { afterEach, describe, expect, it, vi } from 'vitest';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import type { Point3 } from '../src/office/scene/layout';
import { liveElevatorAccess } from '../src/office/scene/movement/elevatorAccess';
import { createMover, preferredElevator, sendMover, stepMover, type ElevatorAccess, type MovementEnv, type Mover } from '../src/office/scene/movement/mover';
import { createMovementRecovery, recoveryGoal, transitRecoveryDue, type ElevatorProgress } from '../src/office/scene/movement/movementRecovery';
import { floorY, officeNavigation } from '../src/office/scene/movement/navGraph';
import { confirmElevatorBoarded, confirmElevatorExited, elevatorSnapshot, requestElevator, resetElevator, tickElevator } from '../src/office/scene/prefabs/architecture/elevatorController';

const navigation = officeNavigation();
const point = (id: string): Point3 => [...navigation.waypoints.get(id)!.position];
const progress = (changes: Partial<ElevatorProgress> = {}): ElevatorProgress => ({ y: 0, doors: 0, phase: 'boarding', ownership: 'queued', queueAhead: 12, serviceRevision: 0, ...changes });
function run(seconds: number, frame: () => void) { for (let i = 0; i < Math.ceil(seconds * 30); i++) frame(); }
function setup(observe: ElevatorAccess['progress'] = () => progress(), phase: 'waiting' | 'boarding' | 'riding' | 'alighting' = 'waiting') {
  const release = vi.fn();
  const elevators: ElevatorAccess = { request() {}, waitingSlot: () => 0, canBoard: () => false, standingPosition: () => null,
    confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release, door: () => ({ x: 29, z: 0 }), progress: observe };
  const mover = createMover('stranded', gaitParameters(), point('f1.elevator-A'), 0, false);
  mover.goal = { kind: 'leave', node: 'f2.east-hall' };
  recoveryGoal(mover.recovery, mover.goal.node);
  mover.phase = phase;
  mover.trip = { id: 'A', from: 1, to: 2, exit: point('f2.elevator-A'), landing: point('f1.elevator-A'), stage: phase === 'boarding' ? 'slot' : 'approach', requested: true, exited: false };
  mover.steps = [{ kind: 'elevator', node: 'f2.elevator-A', elevatorId: 'A', from: 1, to: 2, exit: point('f2.elevator-A') }];
  const env: MovementEnv = { navigation, elevators, walkable: () => true, nearbyWalkers: () => [] };
  return { mover, env, release };
}
function noFailedCab(mover: Mover) { expect(mover.steps.some(step => step.kind === 'elevator' && step.elevatorId === 'A')).toBe(false); }
afterEach(() => { for (const id of ['A', 'B'] as const) { resetElevator(id); tickElevator(100, id); } });

describe('progress-aware lift recovery', () => {
  it('protects a real long live-controller queue while other riders are served', () => {
    resetElevator('A'); tickElevator(100, 'A');
    for (let index = 0; index < 60; index++) requestElevator({ riderId: `ahead-${index}`, from: 1, to: 3 }, 'A');
    requestElevator({ riderId: 'stranded', from: 1, to: 2 }, 'A');
    const { mover, env } = setup();
    const liveEnv = { ...env, elevators: liveElevatorAccess };
    run(100, () => {
      tickElevator(1 / 30, 'A');
      const state = elevatorSnapshot('A');
      if (state.doorwayRiderId && state.doorwayRiderId !== mover.id) {
        confirmElevatorBoarded(state.doorwayRiderId, 'A');
        confirmElevatorExited(state.doorwayRiderId, 'A');
      }
      stepMover(mover, 1 / 30, liveEnv);
    });
    expect(mover.phase).toBe('waiting');
    expect(mover.recovery.attempts).toBe(0);
    expect(elevatorSnapshot('A').queue.some(ride => ride.riderId === mover.id)).toBe(true);
    expect(elevatorSnapshot('A').serviceRevision).toBeGreaterThan(12);
  });

  it.each(['y', 'doors', 'serviceRevision', 'queueAhead'] as const)('treats actual %s advancement as progress', field => {
    const state = createMovementRecovery([0, 0, 0]);
    let time = 0;
    run(80, () => {
      time += 1 / 30;
      transitRecoveryDue(state, 'A:wait', 1 / 30, () => progress({ [field]: field === 'queueAhead' ? 100 - Math.floor(time / 10) : field === 'serviceRevision' ? Math.floor(time / 10) : time * .002 }), [0, 0, 0]);
    });
    expect(state.attempts).toBe(0);
  });

  it('samples at bounded cadence, excludes paused time and unknown adapters, caps failed attempts', () => {
    const observe = vi.fn(() => progress());
    const { mover, env } = setup(observe);
    run(80, () => stepMover(mover, 0, env));
    expect(observe).not.toHaveBeenCalled();
    run(90, () => stepMover(mover, 1 / 30, { ...env, walkable: () => false }));
    expect(observe.mock.calls.length).toBeLessThanOrEqual(180);
    expect(mover.recovery.attempts).toBe(3);
    const unknown = setup(() => null);
    run(90, () => stepMover(unknown.mover, 1 / 30, unknown.env));
    expect(unknown.mover.recovery.attempts).toBe(0);
  });

  it('abandons a verified frozen reservation, releases only its rider, and avoids immediate same-cab retry', () => {
    const { mover, env, release } = setup();
    run(22, () => stepMover(mover, 1 / 30, env));
    expect(release).toHaveBeenCalledExactlyOnceWith('stranded', 'A');
    expect(mover.trip?.id).not.toBe('A');
    expect(mover.recovery.avoidedElevators).toEqual(['A']);
    noFailedCab(mover);
  });

  it('preserves failed-cab exclusion through a pending destination handoff with stale recovery state', () => {
    const { mover, env, release } = setup(() => progress({ ownership: 'reserved', doorway: true }), 'boarding');
    expect(preferredElevator(mover.id)).toBe('A');
    const pending = { kind: 'leave' as const, node: 'f3.east-hall' };
    mover.pending = pending;
    run(22, () => stepMover(mover, 1 / 30, env));
    expect(release).toHaveBeenCalledExactlyOnceWith('stranded', 'A');
    expect(mover.goal).toBe(pending);
    expect(mover.recovery.avoidedElevators).toEqual(['A']);
    expect(mover.recovery.attempts).toBe(1);
    noFailedCab(mover);
  });

  it('recovers sustained lost ownership even while the unrelated cab is moving', () => {
    let time = 0;
    const { mover, env, release } = setup(() => progress({ ownership: 'missing', y: time / 10 }));
    run(8, () => { time += 1 / 30; stepMover(mover, 1 / 30, env); });
    expect(release).toHaveBeenCalledExactlyOnceWith('stranded', 'A');
    noFailedCab(mover);
  });

  it('fades a stranded midshaft passenger only onto a supported unoccupied landing and honors pending goal', () => {
    const { mover, env, release } = setup(() => progress({ ownership: 'boarded', y: 2 }), 'riding');
    mover.position[1] = 2;
    const pending = { kind: 'leave' as const, node: 'f1.east-hall' };
    sendMover(mover, pending, env);
    const feet: Point3 = [...mover.position];
    run(21, () => stepMover(mover, 1 / 30, { ...env, walkable: () => false }));
    expect(mover.position).toEqual(feet);
    expect(mover.pending).toBe(pending);
    expect(release).not.toHaveBeenCalled();
    run(21, () => stepMover(mover, 1 / 30, env));
    expect(release).toHaveBeenCalledExactlyOnceWith('stranded', 'A');
    expect([0, floorY(2)]).toContain(mover.position[1]);
    expect(mover.goal).toBe(pending);
    expect(mover.pending).toBeNull();
    noFailedCab(mover);
  });

  it('never chooses an occupied landing or releases ownership after validation fails', () => {
    const { mover, env, release } = setup(() => progress({ ownership: 'boarded' }), 'riding');
    const blocked = { ...env, nearbyWalkers: (_id: string, position: Readonly<Point3>) => [{ id: 'other', position: [...position] as Point3, velocity: [0, 0, 0] as Point3 }] };
    run(23, () => stepMover(mover, 1 / 30, blocked));
    expect(release).not.toHaveBeenCalled();
    expect(mover.trip?.id).toBe('A');
    expect(mover.phase).toBe('riding');
  });

  it('treats a throwing diagnostic adapter as unknown and keeps reservation ownership intact', () => {
    const { mover, env, release } = setup(() => { throw new Error('snapshot unavailable'); });
    expect(() => run(45, () => stepMover(mover, 1 / 30, env))).not.toThrow();
    expect(mover.recovery.attempts).toBe(0);
    expect(release).not.toHaveBeenCalled();
  });

  it('never moves an unboarded rider to the destination floor, even if only that landing is supported', () => {
    const { mover, env, release } = setup(() => progress({ ownership: 'reserved', doorway: true }), 'boarding');
    const feet = [...mover.position];
    run(22, () => stepMover(mover, 1 / 30, { ...env, walkable: from => from[1] === floorY(2) }));
    expect(release).not.toHaveBeenCalled();
    expect(mover.position).toEqual(feet);
    for (let index = 0; index < 22 * 30 && !release.mock.calls.length; index++) stepMover(mover, 1 / 30, env);
    expect(release).toHaveBeenCalledOnce();
    expect(mover.position[1]).toBe(0);
    expect(mover.opacity).toBe(0);
  });

  it.each(['boarding', 'riding', 'alighting'] as const)('does not let peer boarding activity hide its own frozen %s', phase => {
    let revision = 0;
    const { mover, env, release } = setup(() => progress({ ownership: phase === 'boarding' ? 'reserved' : 'boarded', serviceRevision: revision, doorway: phase === 'boarding' }), phase);
    if (phase === 'alighting') mover.pace = 0;
    run(22, () => { revision++; stepMover(mover, 1 / 30, env); });
    expect(release).toHaveBeenCalledExactlyOnceWith('stranded', 'A');
  });

  it('recovers a frozen confirmed-exited body while its healthy cab continues serving other riders', () => {
    let time = 0;
    const { mover, env, release } = setup(() => progress({ ownership: 'missing', y: time / 3, doors: Math.abs(Math.sin(time)),
      phase: Math.floor(time) % 2 ? 'riding' : 'boarding', serviceRevision: Math.floor(time), queueAhead: 100 - Math.floor(time) }), 'alighting');
    mover.trip!.exited = true; mover.trip!.stage = 'approach'; mover.pace = 0;
    mover.position.splice(0, 3, ...point('f2.elevator-A'));
    mover.position[0] += .5;
    const feet = [...mover.position];
    run(19, () => { time += 1 / 30; stepMover(mover, 1 / 30, env); });
    expect(release).not.toHaveBeenCalled();
    expect(mover.position).toEqual(feet);
    for (let index = 0; index < 3 * 30 && !release.mock.calls.length; index++) { time += 1 / 30; stepMover(mover, 1 / 30, env); }
    expect(release).toHaveBeenCalledExactlyOnceWith('stranded', 'A');
    expect(mover.phase).toBe('walking');
    expect(mover.position[1]).toBe(floorY(2));
    expect(mover.opacity).toBe(0);
    noFailedCab(mover);
  });

  it('protects genuine slow post-exit body progress independently of cab activity', () => {
    const state = createMovementRecovery([0, 0, 0]);
    let x = 0;
    run(45, () => {
      x += .001;
      transitRecoveryDue(state, 'A:alighting:approach', 1 / 30, () => progress({ ownership: 'exited', y: x, phase: String(x) }), [x, 0, 0], false);
    });
    expect(state.attempts).toBe(0);
  });

  it('does not mistake reservations arriving behind the rider for controller progress', () => {
    const state = createMovementRecovery([0, 0, 0]);
    let behind = 0;
    run(23, () => { behind++; transitRecoveryDue(state, 'A:wait', 1 / 30, () => ({ ...progress(), behind }), [0, 0, 0]); });
    expect(state.attempts).toBe(1);
  });
});

describe('authored stair recovery', () => {
  function stairs() {
    const { mover, env } = setup();
    mover.phase = 'walking'; mover.trip = null;
    mover.lastNode = 'stairs-1-2.up-start';
    mover.position.splice(0, 3, ...point(mover.lastNode));
    mover.steps = [{ kind: 'walk', node: 'stairs-1-2.up-turn-in', to: point('stairs-1-2.up-turn-in'), stairs: true }];
    return { mover, env };
  }
  it('recognizes slow directional progress through all three dimensions', () => {
    const { mover, env } = stairs();
    mover.pace = .02;
    run(40, () => stepMover(mover, 1 / 30, env));
    expect(mover.position[1]).toBeGreaterThan(0);
    expect(mover.recovery.attempts).toBe(0);
  });

  it('retries a frozen flight by walking its authored reverse path to a supported landing', () => {
    const { mover, env } = stairs();
    mover.pace = 0;
    const start = point(mover.lastNode!);
    const target = mover.steps[0]!;
    if (target.kind !== 'walk') throw new Error('expected stairs');
    mover.position.splice(0, 3, ...start.map((value, index) => (value + target.to[index]!) / 2) as Point3);
    const before = [...mover.position];
    run(7, () => stepMover(mover, 1 / 30, env));
    expect(mover.recovery.attempts).toBe(1);
    expect(mover.position).toEqual(before);
    expect(mover.steps[0]).toMatchObject({ kind: 'walk', node: 'stairs-1-2.up-start', stairs: true });
    expect(mover.recovery.avoidedEdges).toContain('stairs-1-2.up-start|stairs-1-2.up-turn-in');
    mover.pace = 1;
    run(15, () => {
      const previous = [...mover.position];
      stepMover(mover, 1 / 30, env);
      expect(Math.hypot(...mover.position.map((value, axis) => value - previous[axis]!) as Point3)).toBeLessThan(.08);
    });
    expect(mover.position[1]).toBe(0);
  });

  it('does not invent a direct retreat between nonconsecutive switchback nodes', () => {
    const { mover, env } = stairs();
    mover.lastNode = 'f1.stairs-north'; mover.pace = 0;
    const a = point(mover.lastNode), b = point('stairs-1-2.up-turn-in');
    mover.position.splice(0, 3, ...a.map((value, index) => (value + b[index]!) / 2) as Point3);
    const before = [...mover.position];
    run(8, () => stepMover(mover, 1 / 30, env));
    expect(mover.position).toEqual(before);
    expect(mover.recovery.avoidedEdges).toEqual([]);
    expect(mover.steps).toHaveLength(1);
  });

  it('leaves unsupported or off-route midair positions untouched after bounded attempts', () => {
    const { mover, env } = stairs();
    mover.pace = 0; mover.position[0] += 1; mover.position[1] = 2;
    const before = [...mover.position];
    run(30, () => stepMover(mover, 1 / 30, { ...env, walkable: () => false }));
    expect(mover.position).toEqual(before);
    expect(mover.recovery.attempts).toBe(3);
    expect(mover.phase).toBe('walking');
  });
});
