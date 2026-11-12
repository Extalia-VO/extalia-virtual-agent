import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OfficeAgent } from '../src/office/presence';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { DoorTraffic, type DoorInfo } from '../src/office/scene/interior/doorTraffic';
import { forEachTrackedWalker, getMovingOccupantsSnapshot, getNearbyMovingOccupantsSnapshot, trackMovingOccupant, trackStationaryOccupant } from '../src/office/scene/interior/occupants/movingOccupants';
import { allocateOfficeAgents } from '../src/office/scene/interior/seating';
import type { Point3 } from '../src/office/scene/layout';
import { MovementDirector } from '../src/office/scene/movement/director';
import { HospitalityState } from '../src/office/scene/movement/hospitality';
import { createMover, stepMover, type ElevatorAccess, type MovementEnv, type MoverPhase } from '../src/office/scene/movement/mover';
import { officeNavigation, type SeatApproach } from '../src/office/scene/movement/navGraph';
import { OutdoorKioskState } from '../src/office/scene/movement/outdoorKiosk';

const ids = new Set<string>();
const own = (id: string) => { ids.add(id); return id; };
afterEach(() => { for (const id of ids) { trackMovingOccupant(id, null); trackStationaryOccupant(id, null); } ids.clear(); vi.restoreAllMocks(); });
const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };
const seat: SeatApproach = { seatId: 'example-seat', roomId: 'example-room', floor: 1, seat: [0, 0, 0], staging: [0, 0, -1],
  rotationY: 0, seatStyle: 'sofa', seatHeight: .46, sitMs: 850, standMs: 760 };
const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 1.2, height: 2.55, openAngle: -Math.PI / 2, sliding: false };
const doorSource = { forEachDoor: (visit: (id: string, door: DoorInfo) => void) => visit('example-door', door),
  forEachWalker: (visit: (walker: { id: string; position: Readonly<Point3>; target: Readonly<Point3>; updatedAt: number }) => void) =>
    forEachTrackedWalker((id, position, target, updatedAt) => visit({ id, position, target, updatedAt })) };
const productionEnv = (): MovementEnv => ({ navigation: officeNavigation(), elevators, doors: new DoorTraffic(doorSource, () => performance.now()),
  trackBody: trackStationaryOccupant, trackWalker: trackMovingOccupant, nearbyWalkers: getNearbyMovingOccupantsSnapshot });

function phaseMover(phase: MoverPhase) {
  const mover = createMover(own(`physical-phase-${phase}`), gaitParameters(), [0, 0, 0], 0, false);
  mover.phase = phase; mover.seat = seat; mover.goal = { kind: 'seat', seat };
  mover.steps = [{ kind: 'walk', node: 'example-target', to: [0, 0, 3], stairs: false }];
  if (['waiting', 'boarding', 'riding', 'alighting'].includes(phase)) mover.trip = {
    id: 'A', from: 1, to: 2, exit: [0, 6.4, 3], landing: [0, 0, 0], stage: phase === 'alighting' ? 'approach' : 'slot', requested: true, exited: false };
  if (phase === 'chairing') mover.chair = { kind: 'sit', seat, side: 1, beat: 1, timer: 0, begun: true, path: [] };
  if (phase === 'seatwork') mover.staticSeat = { kind: 'sit', seat, beat: 'align', timer: 0, retry: 0, route: null, path: [], trail: [] };
  if (phase === 'doorwork') mover.door = { kind: 'open', id: 'example-door', door, timer: 0, beat: 'grip', side: -1, entrySide: -1, hand: 1, path: [] };
  return mover;
}

describe('physical body registry across movement phases', () => {
  it.each(['seated', 'standing', 'walking', 'waiting', 'boarding', 'riding', 'alighting', 'sitting', 'vanishing', 'chairing', 'doorwork', 'seatwork'] as const)(
    'publishes a %s body through the production movement callbacks', phase => {
      const mover = phaseMover(phase), env = productionEnv();
      stepMover(mover, 0, env);
      expect(mover.phase).toBe(phase);
      const body = getNearbyMovingOccupantsSnapshot('observer', mover.position).filter(body => body.id === mover.id);
      expect(body).toHaveLength(1); expect(body[0]!.position).toEqual(mover.position);
      trackMovingOccupant(mover.id, null);
      expect(getNearbyMovingOccupantsSnapshot('observer', mover.position).find(body => body.id === mover.id)?.motion).toBe('idle');
    });

  it('keeps fading bodies physical until fully gone, then removes both forms', () => {
    const mover = phaseMover('vanishing'), env = productionEnv(); mover.opacity = .05;
    stepMover(mover, .01, env);
    expect(mover.phase).toBe('vanishing'); expect(getMovingOccupantsSnapshot().some(body => body.id === mover.id)).toBe(true);
    stepMover(mover, .1, env);
    expect(mover.phase).toBe('gone'); expect(getMovingOccupantsSnapshot().some(body => body.id === mover.id)).toBe(false);
  });

  it('prefers fresh movement exactly once and restores the current physical fallback after a paused clock', () => {
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const id = own('physical-clock-pause'), body: Point3 = [.1, 0, 0];
    trackStationaryOccupant(id, body); trackMovingOccupant(id, [8, 0, 0], [10, 0, 0]); body[0] = 30;
    const collectDoor = () => {
      const rows: { id: string; position: Point3; target: Point3; updatedAt: number }[] = [];
      forEachTrackedWalker((id, position, target, updatedAt) => rows.push({ id, position: [...position], target: [...target], updatedAt }));
      return rows.filter(row => row.id === id);
    };
    expect(getMovingOccupantsSnapshot().find(row => row.id === id)?.position).toEqual([8, 0, 0]);
    expect(collectDoor()).toHaveLength(1);
    now = 750; expect(getNearbyMovingOccupantsSnapshot('observer', [0, 0, 0]).find(row => row.id === id)?.position).toEqual([8, 0, 0]);
    now = 60_000;
    for (const rows of [getMovingOccupantsSnapshot(), getNearbyMovingOccupantsSnapshot('observer', [0, 0, 0])]) {
      const matches = rows.filter(row => row.id === id);
      expect(matches).toHaveLength(1); expect(matches[0]!.position).toEqual([.1, 0, 0]);
      expect(matches[0]!.velocity).toEqual([0, 0, 0]); expect(matches[0]!.target).toEqual([.1, 0, 0]);
    }
    expect(collectDoor()).toEqual([{ id, position: [.1, 0, 0], target: [.1, 0, 0], updatedAt: now }]);
    expect(getNearbyMovingOccupantsSnapshot(id, [0, 0, 0]).some(row => row.id === id)).toBe(false);
    expect(getNearbyMovingOccupantsSnapshot('observer', [0, 6.4, 0]).some(row => row.id === id)).toBe(false);
  });

  it('keeps door leaves clear of stationary-only and stale-motion bodies without opening intent', () => {
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const id = own('physical-door-body'), doors = new DoorTraffic(doorSource, () => now);
    trackStationaryOccupant(id, [0, 0, 0]);
    for (const stale of [false, true]) {
      if (stale) { trackMovingOccupant(id, [8, 0, 0], [10, 0, 0]); now += 60_000; }
      expect(doors.occupied(door, 'operator')).toBe(true);
      expect(doors.clearForSwing(door, 'operator', 0, 1)).toBe(false);
      expect(doors.approachers(door, 'operator')).toHaveLength(0);
    }
    trackMovingOccupant(id, null); trackStationaryOccupant(id, null);
    expect(doors.occupied(door, 'operator')).toBe(false); expect(doors.clearForSwing(door, 'operator', 0, 1)).toBe(true);
  });

  it('prepublishes every director body before any actor steps, including targetless arrivals', () => {
    let now = 0; const published: string[] = [], observedCounts: number[] = [];
    const env = productionEnv();
    const director = new MovementDirector({ ...env,
      trackBody: (id, position) => { if (position) published.push(id); trackStationaryOccupant(id, position); },
      trackWalker: (id, position, target) => {
        observedCounts.push(getMovingOccupantsSnapshot().filter(row => row.id.startsWith('physical-director-')).length);
        trackMovingOccupant(id, position, target);
      },
    }, () => now, null, new HospitalityState(), new OutdoorKioskState()); director.wander = false;
    const agents: OfficeAgent[] = [0, 1].map(index => ({ id: own(`physical-director-${index}`), sessionId: 'example-session', agentId: `worker-${index}`,
      displayName: 'Agent', control: 'managed', status: 'working', running: true }));
    try {
      director.update({ allocations: allocateOfficeAgents(agents), agents, reducedMotion: true, gaitOf: () => gaitParameters() });
      for (const mover of director.list) { mover.phase = 'walking'; mover.steps = []; mover.target = null; trackMovingOccupant(mover.id, null); trackStationaryOccupant(mover.id, null); }
      published.length = 0; observedCounts.length = 0; now += 33; director.tick(0);
      expect(published.slice(0, 2)).toEqual(director.list.map(mover => mover.id));
      expect(observedCounts.length).toBeGreaterThan(0); expect(observedCounts.every(count => count === 2)).toBe(true);
      expect(getMovingOccupantsSnapshot().filter(row => row.id.startsWith('physical-director-'))).toHaveLength(2);
    } finally { director.dispose(); }
    expect(getMovingOccupantsSnapshot().some(row => row.id.startsWith('physical-director-'))).toBe(false);
  });
});
