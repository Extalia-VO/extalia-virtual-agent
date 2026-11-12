import { describe, expect, it, vi } from 'vitest';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { DoorTraffic, type DoorInfo } from '../src/office/scene/interior/doorTraffic';
import type { Point3 } from '../src/office/scene/layout';
import { createMover, routeFrom, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { createMovementRecovery, recoveryDue, recoverySegmentClear } from '../src/office/scene/movement/movementRecovery';
import type { OfficeNavigation } from '../src/office/scene/movement/navGraph';

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };

function navigation(points: readonly Point3[]): OfficeNavigation {
  const waypoints = new Map(points.map((position, index) => [`node-${index}`, { id: `node-${index}`, floorId: 'floor-1', kind: 'corridor' as const, position }]));
  return {
    graph: {
      nodes: new Map([...waypoints].map(([id, point]) => [id, { id, floorId: point.floorId, pos: { x: point.position[0], y: point.position[2] } }])),
      edges: new Map([...waypoints].map(([id, point]) => [id, [...waypoints].filter(([other]) => other !== id).map(([to, other]) => ({ to, cost: Math.hypot(point.position[0] - other.position[0], point.position[2] - other.position[2]) }))])),
    },
    waypoints, edges: [], connectors: [], aisles: new Map(), seats: new Map(), elevatorEdges: new Map(), entryId: 'node-0',
  };
}
function run(seconds: number, frame: () => void) { for (let index = 0; index < Math.ceil(seconds * 30); index++) frame(); }

describe('bounded movement recovery', () => {
  it('counts only accumulated simulation time and caps failed recovery attempts', () => {
    const state = createMovementRecovery([0, 0, 0]);
    recoveryDue(state, [0, 0, 0], 'walk', 0, 0, 3, 4);
    expect(recoveryDue(state, [0, 0, 0], 'walk', 0, 1000, 3, 4)).toBe(false);
    run(40, () => recoveryDue(state, [0, 0, 0], 'walk', 0, 1 / 30, 3, 4));
    expect(state.attempts).toBe(3);
  });

  it('recognizes slow real progress but rejects sideways jitter', () => {
    const slow = createMovementRecovery([0, 0, 0]);
    let x = 0;
    run(30, () => { x += 0.001; recoveryDue(slow, [x, 0, 0], 'walk', 0, 1 / 30, 3, 4 - x); });
    expect(slow.attempts).toBe(0);
    const jitter = createMovementRecovery([0, 0, 0]);
    let sign = 1;
    run(12, () => { sign *= -1; recoveryDue(jitter, [0, 0, sign * .04], 'walk', 0, 1 / 30, 3, Math.hypot(4, .04)); });
    expect(jitter.attempts).toBe(3);
  });

  it('does not recover idle, seated, elevator, or advancing door animation waits', () => {
    const state = createMovementRecovery([0, 0, 0]);
    run(30, () => recoveryDue(state, [0, 0, 0], null, 0, 1 / 30, 3));
    let leaf = 0;
    run(20, () => { leaf += .001; recoveryDue(state, [0, 0, 0], 'door:swing', leaf, 1 / 30, 6); });
    expect(state.attempts).toBe(0);
    const env: MovementEnv = { navigation: navigation([[0, 0, 0], [3, 0, 0]]), elevators, walkable: () => false, nearbyWalkers: () => [] };
    for (const phase of ['seated', 'waiting', 'riding', 'chairing', 'seatwork'] as const) {
      const mover = createMover('idle', gaitParameters(), [0, 0, 0], 0, false);
      mover.phase = phase;
      if (phase === 'waiting' || phase === 'riding') mover.trip = { id: 'A', from: 1, to: 2, exit: [0, 4, 0], landing: [0, 0, 0], stage: 'approach', requested: true, exited: false };
      run(12, () => stepMover(mover, 1 / 30, env));
      expect(mover.recovery.attempts).toBe(0);
    }
  });

  it('detours a blocked exact leg without crossing furniture or changing the goal', () => {
    const nav = navigation([[0, 0, 0], [3, 0, 0]]);
    const clear = (from: Readonly<Point3>, to: Readonly<Point3>, radius = .29) => {
      for (let sample = 0; sample <= 20; sample++) {
        const t = sample / 20, x = from[0] + (to[0] - from[0]) * t, z = from[2] + (to[2] - from[2]) * t;
        if (Math.abs(x - 1) < radius + .1 && Math.abs(z) < radius + .25) return false;
      }
      return true;
    };
    const env: MovementEnv = { navigation: nav, elevators, walkable: clear, nearbyWalkers: () => [] };
    const mover = createMover('blocked', gaitParameters(), [0, 0, 0], 0, false);
    const goal = { kind: 'leave' as const, node: 'node-1' };
    routeFrom(mover, 'node-0', goal, env, false);
    mover.steps = [{ kind: 'walk', node: 'node-1', to: [3, 0, 0], stairs: false }];
    run(20, () => { const before: Point3 = [...mover.position]; stepMover(mover, 1 / 30, env); expect(clear(before, mover.position)).toBe(true); });
    expect(mover.phase).toBe('gone');
    expect(mover.goal).toBe(goal);
    expect(mover.recovery.attempts).toBe(1);
  });

  it('leaves an impossible escape blocked after three attempts without searching every frame', () => {
    const walkable = vi.fn(() => false);
    const env: MovementEnv = { navigation: navigation([[0, 0, 0], [3, 0, 0]]), elevators, walkable, nearbyWalkers: () => [] };
    const mover = createMover('trapped', gaitParameters(), [0, 0, 0], 0, false);
    routeFrom(mover, 'node-0', { kind: 'leave', node: 'node-1' }, env, false);
    run(30, () => stepMover(mover, 1 / 30, env));
    expect(mover.position).toEqual([0, 0, 0]);
    expect(mover.recovery.attempts).toBe(3);
    expect(mover.phase).toBe('walking');
  });

  it('rechecks an exhausted walk when a safe alternative aisle becomes available later', () => {
    const base = navigation([[0, 0, 0], [4, 0, 0], [0, 0, 2], [4, 0, 2]]);
    const edges = new Map(base.graph.edges);
    const nav = { ...base, graph: { ...base.graph, edges } };
    edges.set('node-0', [{ to: 'node-1', cost: 4 }]);
    edges.set('node-2', [{ to: 'node-3', cost: 4 }]);
    edges.set('node-3', [{ to: 'node-1', cost: 2 }]);
    let restored = false;
    const clear = (from: Readonly<Point3>, to: Readonly<Point3>) => restored &&
      !(Math.min(from[0], to[0]) < 2 && Math.max(from[0], to[0]) > 1 && Math.min(from[2], to[2]) < 1);
    const env: MovementEnv = { navigation: nav, elevators, walkable: clear, nearbyWalkers: () => [] };
    const mover = createMover('late-aisle', gaitParameters(), [0, 0, 0], 0, false);
    const goal = { kind: 'leave' as const, node: 'node-1' };
    routeFrom(mover, 'node-0', goal, env, false);
    run(30, () => stepMover(mover, 1 / 30, env));
    expect(mover.recovery.attempts).toBe(3);
    expect(mover.position).toEqual([0, 0, 0]);
    restored = true;
    run(40, () => {
      const before: Point3 = [...mover.position];
      stepMover(mover, 1 / 30, env);
      expect(Math.hypot(...mover.position.map((value, axis) => value - before[axis]!) as Point3)).toBeLessThan(.08);
      expect(clear(before, mover.position)).toBe(true);
    });
    expect(mover.phase).toBe('gone');
    expect(mover.goal).toBe(goal);
    expect(mover.recovery.attempts).toBe(3);
  });

  it('retreats and yields through a one-body portal while preserving both destinations', () => {
    const nav = navigation([[-3, 0, 0], [3, 0, 0]]);
    const movers = [createMover('a', gaitParameters(), [-3, 0, 0], 0, false), createMover('b', gaitParameters(), [3, 0, 0], 0, false)];
    const env: MovementEnv = { navigation: nav, elevators,
      walkable: (from, to, radius = .29) => {
        for (let sample = 0; sample <= 30; sample++) {
          const t = sample / 30, x = from[0] + (to[0] - from[0]) * t, z = from[2] + (to[2] - from[2]) * t;
          if (Math.abs(x) < .6 + radius && Math.abs(z) + radius > .4) return false;
        }
        return true;
      },
      nearbyWalkers: id => movers.filter(mover => mover.id !== id && mover.phase !== 'gone' && mover.phase !== 'vanishing')
        .map(mover => ({ id: mover.id, position: [...mover.position] as Point3, velocity: [0, 0, 0] as Point3 })),
    };
    for (const [index, mover] of movers.entries()) {
      routeFrom(mover, `node-${index}`, { kind: 'leave', node: `node-${1 - index}` }, env, false);
      mover.steps = [{ kind: 'walk', node: `node-${1 - index}`, to: [...movers[1 - index]!.position], stairs: false }];
    }
    let yielded = false;
    run(60, () => {
      for (const mover of movers) { stepMover(mover, 1 / 30, env); yielded ||= Boolean(mover.recovery.yielding); }
      if (movers.every(mover => mover.phase !== 'gone' && mover.phase !== 'vanishing')) {
        expect(Math.hypot(movers[0]!.position[0] - movers[1]!.position[0], movers[0]!.position[2] - movers[1]!.position[2])).toBeGreaterThanOrEqual(.55);
      }
    });
    expect(yielded).toBe(true);
    expect(movers.map(mover => mover.phase)).toEqual(['gone', 'gone']);
    expect(movers.map(mover => mover.goal)).toEqual([{ kind: 'leave', node: 'node-1' }, { kind: 'leave', node: 'node-0' }]);
  });

  it('validates body clearance at endpoints and along the sweep', () => {
    const body = [{ id: 'other', position: [1, 0, 0] as Point3, velocity: [0, 0, 0] as Point3 }];
    expect(recoverySegmentClear('walker', [0, 0, 0], [2, 0, 0], () => true, body)).toBe(false);
    expect(recoverySegmentClear('walker', [0, 0, 0], [1, 0, .2], () => true, body)).toBe(false);
    expect(recoverySegmentClear('walker', [0, 0, 0], [0, 0, 1], () => true, body)).toBe(true);
    expect(recoverySegmentClear('walker', [0, 0, 0], [0, 0, 1], () => false, body)).toBe(false);
  });

  it('releases transient interactions, closes its physical door and honors the pending goal', () => {
    const door: DoorInfo = { center: [0, 0, 0], floor: 1, yaw: 0, clearWidth: 1.2, height: 2.5, openAngle: -Math.PI / 2, sliding: false };
    const doors = new DoorTraffic({ forEachDoor: visit => visit('door', door), forEachWalker() {} }, () => 0);
    const swing = vi.spyOn(doors, 'clearForSwing').mockReturnValue(false);
    const release = vi.fn();
    const trackWalker = vi.fn(), trackBody = vi.fn();
    const env: MovementEnv = { navigation: navigation([[1, 0, 1.3], [3, 0, 1.3], [3, 0, 2.5]]), elevators: { ...elevators, release }, doors, walkable: () => true, nearbyWalkers: () => [], trackWalker, trackBody };
    const mover = createMover('owner', gaitParameters(), [0, 0, 1.3], 0, false);
    mover.goal = { kind: 'leave', node: 'obsolete-node' };
    const pending = { kind: 'leave' as const, node: 'node-2' };
    mover.pending = pending;
    mover.trip = { id: 'A', from: 1, to: 2, exit: [0, 4, 0], landing: [0, 0, 1.3], stage: 'approach', requested: true, exited: false };
    mover.phase = 'doorwork';
    mover.door = { id: 'door', door, kind: 'open', beat: 'swing', timer: 0, side: 1, entrySide: 1, hand: 1, path: null };
    doors.hold('door', mover.id, 1, 1);
    doors.moved(mover.id, [0, 0, -.4], [0, 0, .4]);
    mover.recovery.goal = 'node-2'; mover.recovery.attempts = 2;
    for (let frame = 0; frame < 250 && mover.phase === 'doorwork'; frame++) stepMover(mover, 1 / 30, env);
    expect(mover.phase).toBe('walking');
    expect(mover.position).toEqual([0, 0, 1.3]);
    expect(mover.goal).toBe(pending); expect(mover.pending).toBe(pending);
    expect(mover.trip).toBeNull(); expect(mover.door).toBeNull();
    expect(release).toHaveBeenCalledWith(mover.id, 'A');
    expect(doors.duty(mover.id)?.id).toBe('door');
    expect(doors.claim('door', 'next')).toBe(true);
    doors.release('door', 'next'); // Release the probe's hand reservation.
    swing.mockReturnValue(true); // The physical obstruction has cleared.
    expect(mover.opacity).toBe(1);
    for (let frame = 0; frame < 30 * 30 && (mover.phase as string) !== 'gone'; frame++) {
      const before: Point3 = [...mover.position];
      stepMover(mover, 1 / 30, env);
      expect(Math.hypot(...mover.position.map((value, axis) => value - before[axis]!) as Point3)).toBeLessThan(.08);
      if ((mover.phase as string) !== 'gone' && (mover.phase as string) !== 'vanishing') expect(mover.opacity).toBe(1);
    }
    expect(mover.phase).toBe('gone');
    expect(mover.position).toEqual([3, 0, 2.5]);
    expect(doors.amount('door')).toBe(0);
    expect(doors.duty(mover.id)).toBeNull();
    expect(trackWalker.mock.calls.some(([id, position]) => id === mover.id && position !== null)).toBe(true);
  });

  it('keeps a hinged-door queue waiting while another avatar owns the leaf', () => {
    const door: DoorInfo = { center: [0, 0, 0], floor: 1, yaw: 0, clearWidth: 1.2, height: 2.5, openAngle: -Math.PI / 2, sliding: false };
    const doors = new DoorTraffic({ forEachDoor: visit => visit('door', door), forEachWalker() {} }, () => 0);
    doors.claim('door', 'operator');
    const mover = createMover('queued', gaitParameters(), [0, 0, 1.85], 0, false);
    mover.goal = { kind: 'leave', node: 'node-1' }; mover.phase = 'doorwork';
    mover.door = { id: 'door', door, kind: 'wait', beat: 'reserve', timer: 0, side: 1, entrySide: 1, hand: 1, path: null };
    const env: MovementEnv = { navigation: navigation([[1, 0, 1.85], [3, 0, 1.85]]), elevators, doors, walkable: () => true, nearbyWalkers: () => [] };
    run(30, () => stepMover(mover, 1 / 30, env));
    expect(mover.phase).toBe('doorwork'); expect(mover.recovery.attempts).toBe(0);
    expect(doors.claim('door', 'next')).toBe(false);
  });
});
