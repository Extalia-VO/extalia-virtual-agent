import { describe, expect, it } from 'vitest';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import type { DoorInfo } from '../src/office/scene/interior/doorTraffic';
import type { Point3 } from '../src/office/scene/layout';
import { createMover, type Mover } from '../src/office/scene/movement/mover';
import { createMovementMonitor, movementDiagnostic, MOVEMENT_MONITOR_GRACE_SECONDS, stepMovementMonitor } from '../src/office/scene/movement/movementMonitor';
import type { SeatApproach } from '../src/office/scene/movement/navGraph';

const seat: SeatApproach = { seatId: 'lounge.sofa', roomId: 'lounge', floor: 1, seat: [0, 0, 0], staging: [0, 0, 1.4],
  rotationY: 0, seatHeight: .43, seatStyle: 'sofa', seatFront: .23, sitMs: 900, standMs: 900 };
const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 1.6, height: 2.55, openAngle: Math.PI / 2, sliding: false };

function fixture() {
  const mover = createMover('worker', gaitParameters(), [0, 0, 0], 0, false);
  mover.goal = { kind: 'seat', seat };
  mover.steps = [{ kind: 'walk', node: 'destination', to: [0, 0, 3], stairs: false }];
  const state = createMovementMonitor();
  const sample = (dt = .1, before: Point3 = [...mover.position]) => stepMovementMonitor(state, mover, dt, before);
  const stationary = (seconds: number, update?: (mover: Mover, frame: number) => void) => {
    for (let frame = 0; frame < Math.ceil(seconds * 10); frame++) { update?.(mover, frame); sample(); }
  };
  return { mover, state, sample, stationary };
}

describe('measured zero-speed movement monitor', () => {
  it('copies diagnostic positions and exposes the newest pending destination without taking action', () => {
    const h = fixture(); h.mover.pending = { kind: 'leave', node: 'next-aisle' };
    h.stationary(4);
    const snapshot = movementDiagnostic(h.state, h.mover);
    expect(snapshot).toMatchObject({ id: 'worker', phase: 'walking', speed: 0, actionable: true,
      destination: 'next-aisle', reason: 'blocked-route', recoveryAttempts: 0 });
    (snapshot.position as Point3)[0] = 99;
    expect(h.mover.position[0]).toBe(0);
    expect(h.mover.pending).toEqual({ kind: 'leave', node: 'next-aisle' });
  });
  it('measures actual 3D foot velocity instead of the requested walking blend', () => {
    const h = fixture();
    h.mover.motion.walk = 1;
    h.stationary(MOVEMENT_MONITOR_GRACE_SECONDS + .2);
    expect(h.state).toMatchObject({ speed: 0, actionable: true, reason: 'blocked-route' });
    const before: Point3 = [...h.mover.position];
    h.mover.position[1] += .1;
    h.sample(.1, before);
    expect(h.state.speed).toBeCloseTo(1);
  });

  it('accumulates small genuine progress and does not let side-to-side jitter reset a blocked route', () => {
    const h = fixture();
    h.sample();
    for (let frame = 0; frame < 40; frame++) {
      const before: Point3 = [...h.mover.position];
      h.mover.position[0] = frame % 2 ? -.015 : .015;
      h.sample(.1, before);
    }
    expect(h.state.actionable).toBe(true);
    h.mover.position[0] = 0; h.mover.position[2] = .03;
    h.sample(.1, [0, 0, 0]);
    expect(h.state.stationarySeconds).toBe(0);
    expect(h.state.actionable).toBe(false);
  });

  it('keeps measuring progress through short changing curve targets and resets grace for a genuinely new intent', () => {
    const h = fixture(); h.sample();
    for (let frame = 0; frame < 100; frame++) {
      const before: Point3 = [...h.mover.position];
      h.mover.position[2] += .01;
      h.mover.steps = [{ kind: 'walk', node: 'curve', to: [0, 0, h.mover.position[2] + .1], stairs: false }];
      h.sample(.1, before);
      expect(h.state.actionable).toBe(false);
    }
    h.stationary(4);
    expect(h.state.actionable).toBe(true);
    h.mover.pending = { kind: 'leave', node: 'new-aisle' }; h.sample();
    expect(h.state).toMatchObject({ stationarySeconds: 0, actionable: false });
  });

  it('keeps ordinary seated work and intentional standing service stations settled', () => {
    for (const standing of [false, true]) {
      const h = fixture();
      h.mover.phase = 'seated'; h.mover.seat = { ...seat, standing };
      h.mover.motion.sit = standing ? 0 : 1;
      h.stationary(60);
      expect(h.state).toMatchObject({ speed: 0, actionable: false, reason: 'settled' });
    }
  });

  it('detects an orphan standing pose at a real seat instead of treating it as settled work', () => {
    const h = fixture();
    h.mover.phase = 'seated'; h.mover.seat = seat; h.mover.motion.sit = 0;
    h.mover.goal = null;
    h.stationary(4);
    expect(h.state).toMatchObject({ actionable: true, reason: 'blocked-seat' });
  });

  it.each(['reserve', 'resume'] as const)('protects a real door %s wait even while its timer advances', beat => {
    const h = fixture();
    h.mover.phase = 'doorwork';
    h.mover.door = { id: 'door', door, kind: 'wait', beat, timer: 0, side: 1, entrySide: 1, hand: 1, path: null, queueIndex: 2 };
    h.stationary(60, mover => { mover.door!.timer += .1; });
    expect(h.state).toMatchObject({ speed: 0, actionable: false, reason: 'door-queue' });
    expect(h.state.stationarySeconds).toBeGreaterThan(59);
  });

  it('does not protect a stationary queue head solely because its reserve timer increments', () => {
    const h = fixture();
    h.mover.phase = 'doorwork';
    h.mover.door = { id: 'door', door, kind: 'open', beat: 'reserve', timer: 0, side: 1, entrySide: 1, hand: 1, path: null, queueIndex: 0 };
    h.stationary(4, mover => { mover.door!.timer += .1; });
    expect(h.state).toMatchObject({ actionable: true, reason: 'blocked-route' });
  });

  it('protects an owned elevator wait and measures vertical travel', () => {
    const h = fixture();
    h.mover.phase = 'waiting';
    h.mover.trip = { id: 'A', from: 1, to: 2, exit: [0, 6.4, 0], landing: [0, 0, 0], stage: 'door', requested: true, exited: false };
    h.stationary(120);
    expect(h.state).toMatchObject({ actionable: false, reason: 'transit' });
    h.mover.phase = 'riding'; h.mover.position[1] = .2;
    h.sample(.1, [0, 0, 0]);
    expect(h.state.speed).toBeCloseTo(2);
    expect(h.state.reason).toBe('transit');
    h.mover.trip = null; h.mover.phase = 'waiting'; h.stationary(4);
    expect(h.state.actionable).toBe(true);
  });

  it('accepts finite standing, sitting and chair hand-beat progress at zero foot speed', () => {
    for (const phase of ['standing', 'sitting', 'chairing'] as const) {
      const h = fixture(); h.mover.phase = phase; h.mover.seat = seat;
      if (phase === 'chairing') h.mover.chair = { kind: 'sit', seat, side: 1, beat: 1, timer: 0, begun: true, path: [] };
      h.sample();
      for (let frame = 0; frame < 4; frame++) {
        if (h.mover.chair) h.mover.chair.timer += .1; else h.mover.timer += .1;
        h.sample();
        expect(h.state).toMatchObject({ speed: 0, actionable: false, reason: 'interaction', stationarySeconds: 0 });
      }
    }
  });

  it.each(['approach', 'contact', 'exit-contact', 'exit'] as const)('flags a cached static-seat %s path despite retry/timer ticks', beat => {
    const h = fixture();
    h.mover.phase = 'seatwork';
    h.mover.staticSeat = { kind: 'sit', seat, beat, timer: 0, retry: 0, route: null, path: [[0, 0, 1]], trail: [[0, 0, 0]] };
    h.stationary(4, (mover, frame) => { mover.staticSeat!.retry = frame % 4 * .1; mover.staticSeat!.timer += .1; });
    expect(h.state).toMatchObject({ speed: 0, actionable: true, reason: 'blocked-seat' });
  });

  it('does not let a static align timer hide a neighbor-blocked lower transition forever', () => {
    const h = fixture(); h.mover.phase = 'seatwork';
    h.mover.staticSeat = { kind: 'sit', seat, beat: 'align', timer: 0, retry: 0, route: null, path: [], trail: [] };
    h.stationary(5, mover => { mover.staticSeat!.timer += .1; });
    expect(h.state).toMatchObject({ actionable: true, reason: 'blocked-seat' });
    h.mover.staticSeat.beat = 'lower'; h.mover.staticSeat.timer = 0;
    h.sample();
    expect(h.state.actionable).toBe(false);
  });

  it('caps simulation time and refuses negative/nonfinite time without modifying its mover', () => {
    const h = fixture(); h.sample();
    const original = JSON.stringify(h.mover);
    h.sample(3600);
    expect(h.state.stationarySeconds).toBeCloseTo(.1);
    for (const dt of [-1, NaN, Infinity]) h.sample(dt);
    expect(h.state.stationarySeconds).toBeCloseTo(.1);
    expect(h.state.actionable).toBe(false);
    expect(JSON.stringify(h.mover)).toBe(original);
  });
});
