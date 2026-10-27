import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ReactTypes from 'react';
import { Treadmill, fitnessStationInUse } from '../src/office/scene/interior/prefabs/furniture/GymEquipment';
import { FITNESS_BLUEPRINT } from '../src/office/scene/interior/spatialBlueprints';
import { fitnessMechanism } from '../src/office/scene/interior/fitnessMechanics';
import { resourceById } from '../src/office/scene/interior/resourceRegistry';
import { getMovingOccupantsSnapshot, trackMovingOccupant } from '../src/office/scene/interior/occupants/movingOccupants';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { OfficeOccupants } from '../src/office/scene/movement/OfficeOccupants';
import type { MovementDirector } from '../src/office/scene/movement/director';
import { createMover, placeSeated, sendMover, stepMover, type ElevatorAccess, type MovementEnv, type Mover } from '../src/office/scene/movement/mover';
import { officeNavigation, seatApproach } from '../src/office/scene/movement/navGraph';

type Frame = (frame: { clock: { elapsedTime: number } }, delta: number) => void;
const state = vi.hoisted(() => ({ preference: { matches: false }, environment: { reducedMotion: false }, frames: [] as Array<{ run: Frame; priority: number }>, cleanups: [] as Array<() => void> }));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof ReactTypes>(),
  useMemo: (factory: () => unknown) => factory(),
  useRef: (initial: unknown) => ({ current: initial }),
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: () => 0,
  useLayoutEffect: (effect: () => void) => effect(),
  useEffect: (effect: () => (() => void) | void) => { const cleanup = effect(); if (cleanup) state.cleanups.push(cleanup); },
}));
vi.mock('@react-three/fiber', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  useFrame: (run: Frame, priority = 0) => { state.frames.push({ run, priority }); },
}));
vi.mock('../src/office/scene/Environment', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  useSolarEnvironment: () => state.environment,
}));
vi.mock('../src/office/scene/interior/FurnishedFloorContext', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  // Leisure users retain their home-desk allocations; equipment still appears AVAILABLE here.
  useResourceVisualState: () => 'AVAILABLE',
}));

const id = FITNESS_BLUEPRINT.treadmills[0]!.id;
const lifts: ElevatorAccess = {
  request() {}, waitingSlot: () => 0, canBoard: () => false, standingPosition: () => null, confirmBoarded: () => false,
  canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 25, z: 0 }),
};
const env: MovementEnv = { navigation: officeNavigation(), elevators: lifts, trackWalker: trackMovingOccupant };
function arrived(actorId = 'leisure-runner'): Mover {
  const seat = seatApproach(resourceById(id)!);
  const mover = createMover(actorId, gaitParameters(), [...seat.seat], seat.rotationY, false);
  placeSeated(mover, seat, env);
  return mover;
}
/** Exercise the actual OfficeOccupants frame publisher around the real mover state machine. */
function mountScene(movers: Mover[]) {
  const director = {
    list: movers, update() {}, tick: (delta: number) => movers.forEach(mover => stepMover(mover, delta, env)),
    roster: () => [], subscribe: () => () => {}, version: () => 0,
  } as unknown as MovementDirector;
  OfficeOccupants({ director, agents: [], allocations: [], view: 3, selectedId: null, onSelect() {}, reducedMotion: false });
  const frame = state.frames.at(-1)!;
  const cleanup = state.cleanups.at(-1)!;
  return () => { state.frames.splice(state.frames.indexOf(frame), 1); cleanup(); };
}
function frame(time: number) { [...state.frames].sort((a, b) => a.priority - b.priority).forEach(callback => callback.run({ clock: { elapsedTime: time } }, .1)); }

beforeEach(() => {
  state.frames.length = 0; state.cleanups.length = 0; state.preference.matches = false; state.environment.reducedMotion = false;
  vi.stubGlobal('matchMedia', () => state.preference);
  Object.assign(fitnessMechanism(id)!, { active: false, phase: 0, travel: 0, pull: 0 });
  Treadmill({ resourceId: id });
});
afterEach(() => { state.cleanups.forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });

describe('fitness equipment settled-mover usage', () => {
  it('publishes a settled mover after the real walker registry removes it, then stops when it leaves for another station', () => {
    frame(0); expect(fitnessMechanism(id)!.phase).toBe(0);
    const mover = arrived();
    trackMovingOccupant(mover.id, mover.position, mover.seat!.seat);
    expect(getMovingOccupantsSnapshot().some(occupant => occupant.id === mover.id)).toBe(true);
    mountScene([mover]); frame(.21);
    expect(mover.phase).toBe('seated'); expect(mover.target).toBeNull();
    expect(getMovingOccupantsSnapshot().some(occupant => occupant.id === mover.id)).toBe(false);
    expect(fitnessStationInUse(id)).toBe(true);
    expect(fitnessMechanism(id)!.active).toBe(true); expect(fitnessMechanism(id)!.phase).toBeCloseTo(.34);
    expect(fitnessMechanism(id)!.travel).toBeCloseTo(.16);
    sendMover(mover, { kind: 'seat', seat: seatApproach(resourceById(FITNESS_BLUEPRINT.bikes[0]!.id)!) }, env);
    frame(.42);
    expect(fitnessStationInUse(id)).toBe(false); expect(fitnessMechanism(id)!.active).toBe(false);
    expect(fitnessMechanism(id)!.phase).toBeCloseTo(.34);
  });

  it('removes a mounted scene registration on unmount while preserving another mounted scene owner', () => {
    const unmountA = mountScene([arrived('runner-a')]);
    const unmountB = mountScene([arrived('runner-b')]); frame(0);
    expect(fitnessStationInUse(id)).toBe(true);
    unmountA(); expect(fitnessStationInUse(id)).toBe(true);
    unmountB(); expect(fitnessStationInUse(id)).toBe(false);
    frame(.21); expect(fitnessMechanism(id)!.active).toBe(false); expect(fitnessMechanism(id)!.phase).toBeCloseTo(.34);
  });

  it('rejects walking, remote-floor, pending departure and differently targeted movers', () => {
    const mover = arrived(); mountScene([mover]);
    mover.goal = { kind: 'seat', seat: seatApproach(resourceById(FITNESS_BLUEPRINT.bikes[0]!.id)!) };
    frame(0); expect(fitnessStationInUse(id)).toBe(false);
    placeSeated(mover, seatApproach(resourceById(id)!), env); mover.pending = { kind: 'leave', node: env.navigation.entryId };
    expect(fitnessStationInUse(id)).toBe(false);
    mover.pending = null; mover.position[1] += 6.4;
    expect(fitnessStationInUse(id)).toBe(false);
    mover.position[1] -= 6.4; mover.phase = 'walking';
    expect(fitnessStationInUse(id)).toBe(false); expect(fitnessMechanism(id)!.phase).toBe(0);
  });

  it('freezes mechanics for the explicit scene reduced-motion setting even when the native preference allows motion', () => {
    mountScene([arrived()]); state.environment.reducedMotion = true; frame(0);
    expect(state.preference.matches).toBe(false); expect(fitnessStationInUse(id)).toBe(true);
    expect(fitnessMechanism(id)!.active).toBe(false); expect(fitnessMechanism(id)!.phase).toBe(0);
    state.environment.reducedMotion = false; frame(.21);
    expect(fitnessMechanism(id)!.active).toBe(true); expect(fitnessMechanism(id)!.phase).toBeCloseTo(.34);
  });

  it('freezes mechanics for reduced motion even with a real arrived user', () => {
    mountScene([arrived()]); state.preference.matches = true; frame(0);
    expect(fitnessStationInUse(id)).toBe(true);
    expect(fitnessMechanism(id)!.active).toBe(false); expect(fitnessMechanism(id)!.travel).toBe(0);
    state.preference.matches = false; frame(.21);
    expect(fitnessMechanism(id)!.active).toBe(true); expect(fitnessMechanism(id)!.travel).toBeCloseTo(.16);
  });
});
