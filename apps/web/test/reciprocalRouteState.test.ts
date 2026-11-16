import { describe, expect, it } from 'vitest';
import type { Point3 } from '../src/office/scene/layout';
import { CrowdWatch, type CrowdWatchActor } from '../src/office/scene/movement/crowdWatch';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { createMover, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { officeNavigation } from '../src/office/scene/movement/navGraph';
import { createMovementRecovery, recoveryGoal } from '../src/office/scene/movement/movementRecovery';
import { encounterDue, encounterPassed, encounterPath, type EncounterMemory } from '../src/office/scene/movement/encounterRecovery';

const memory = (): EncounterMemory => ({ peer: 'peer', origin: [0, 0, 0], direction: [1, 0], bestRemaining: 5, stalled: 0, attempts: 0, retryIn: 0 });

describe('reciprocal encounter memory', () => {
  it.each([.35, 1.5])('nominates a close opposing pair with %fm cyclic motion that defeats the stationary timer', amplitude => {
    const watch = new CrowdWatch();
    let first = Infinity;
    for (let frame = 0; frame < 30 * 30; frame++) {
      const shift = Math.sin(frame / 30 * Math.PI / 2) * amplitude;
      const actor = (id: string, x: number, goal: number): CrowdWatchActor => ({ id, floor: 1, position: [x + shift, 0, 0],
        target: [goal, 0, 0], destination: [goal, 0, 0], movementIntent: true, eligible: true, intentionalWait: false });
      const decision = watch.update([actor('first', 0, 4), actor('second', .8, -4)], 1 / 30);
      if (decision.initiative) first = Math.min(first, frame / 30);
    }
    expect(first).toBeGreaterThanOrEqual(12);
    expect(first).toBeLessThan(18);
  });

  it('does not erase the progress floor when a retreat returns through an old position', () => {
    const state = memory(); let probes = 0;
    for (let frame = 0; frame < 30 * 60; frame++) probes += Number(encounterDue(state, 5 + Math.sin(frame / 30 * Math.PI / 2) * .35, 1 / 30));
    expect(probes).toBe(3);
    expect(state.attempts).toBe(3);
    expect(state.bestRemaining).toBeLessThan(5);
  });

  it('allows real progress and ignores hidden-tab wall time or nonfinite input', () => {
    const state = memory();
    for (let frame = 0; frame < 30 * 20; frame++) expect(encounterDue(state, 5 - frame / 30 * .1, 1 / 30)).toBe(false);
    expect(state.attempts).toBe(0);
    const before = state.stalled;
    encounterDue(state, 5, Number.NaN); encounterDue(state, 5, Infinity);
    expect(state.stalled).toBe(before);
    encounterDue(state, 5, 300);
    expect(state.stalled - before).toBeCloseTo(.1);
  });

  it('requires the peer to pass the fixed encounter plane or actually leave the corridor', () => {
    const state = memory();
    expect(encounterPassed(state, [.3, 0, 0])).toBe(false);
    expect(encounterPassed(state, [-1, 0, 0], [-1.8, 0, 0])).toBe(false);
    expect(encounterPassed(state, [.8, 0, 2.5], [0, 0, 2.5])).toBe(false);
    expect(encounterPassed(state, [.3, 0, .9])).toBe(false);
    expect(encounterPassed(state, [-1, 0, 0])).toBe(true);
    expect(encounterPassed(state, [.3, 0, 2.1])).toBe(true);
  });

  it('finds a multi-turn bypass while preserving the exact endpoint and all checked edges', () => {
    const obstacle = { minX: -2.7, maxX: 2.7, minZ: -.35, maxZ: .35 };
    const clear = (a: Readonly<Point3>, b: Readonly<Point3>) => {
      for (let sample = 0; sample <= 80; sample++) {
        const t = sample / 80, x = a[0] + (b[0] - a[0]) * t, z = a[2] + (b[2] - a[2]) * t;
        if (x > obstacle.minX - .29 && x < obstacle.maxX + .29 && z > obstacle.minZ - .29 && z < obstacle.maxZ + .29) return false;
      }
      return Math.abs(a[2]) <= 3.3 && Math.abs(b[2]) <= 3.3;
    };
    const from: Point3 = [-.6, 0, -1], to: Point3 = [.6, 0, 1];
    const path = encounterPath(from, to, clear);
    expect(path).not.toBeNull(); expect(path!.length).toBeGreaterThan(2); expect(path!.at(-1)).toEqual(to);
    let previous = from;
    for (const next of path!) { expect(clear(previous, next)).toBe(true); previous = next; }
    expect(path!.some(at => Math.abs(at[0]) > 2.99)).toBe(true);
  });

  it.each([1, 1.5])('keeps a %fm retreat handoff beyond the former six-second timer and releases after a physical pass', retreat => {
    const actor = createMover('yielding', gaitParameters(), [0, 0, 0], 0, false);
    const goal = { kind: 'leave' as const, node: 'destination' };
    actor.goal = goal; recoveryGoal(actor.recovery, goal.node); actor.steps = [{ kind: 'walk', node: 'destination', to: [4, 0, 0], stairs: false }];
    actor.crowdYield = { point: [0, 0, retreat], origin: [0, 0, 0], elapsed: 0, settled: 0, peer: 'passing', direction: [1, 0] };
    let peer: Point3 = [.8, 0, 0];
    const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
      confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };
    const env: MovementEnv = { navigation: officeNavigation(), elevators,
      // A corner forces the checked return through the origin before the aisle.
      walkable: (a, b) => Math.abs(a[0] - b[0]) < 1e-8 || Math.abs(a[2] - b[2]) < 1e-8,
      nearbyWalkers: () => [{ id: 'passing', position: peer, velocity: [0, 0, 0], target: [-4, 0, 0] }] };
    for (let frame = 0; frame < 30 * 9; frame++) stepMover(actor, 1 / 30, env);
    expect(actor.crowdYield).toBeNull(); // Other clusters can use the shared crowd initiative.
    expect(actor.recovery.yielding?.neighbor).toBe('passing');
    expect(actor.position[2]).toBeCloseTo(retreat); expect(actor.position[0]).toBeCloseTo(0);
    expect(actor.goal).toBe(goal);
    peer = [-1, 0, 0];
    for (let frame = 0; frame < 30 * 10 && actor.phase !== 'gone'; frame++) stepMover(actor, 1 / 30, env);
    expect(actor.phase).toBe('gone'); expect(actor.position).toEqual([4, 0, 0]);
  });

  it('retains encounter choices on a local replan and clears them for a new destination', () => {
    const state = createMovementRecovery([0, 0, 0]);
    recoveryGoal(state, 'first'); state.encounter = memory(); state.encounterSearches = 3;
    recoveryGoal(state, 'first'); expect(state.encounter).not.toBeNull(); expect(state.encounterSearches).toBe(3);
    recoveryGoal(state, 'second'); expect(state.encounter).toBeNull(); expect(state.encounterSearches).toBe(0);
  });

  it('refuses an impossible or cross-floor escape', () => {
    expect(encounterPath([0, 0, 0], [3, 0, 0], () => false)).toBeNull();
    expect(encounterPath([0, 0, 0], [3, 1, 0], () => true)).toBeNull();
  });
});
