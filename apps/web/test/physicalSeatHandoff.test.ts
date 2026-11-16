import { describe, expect, it } from 'vitest';
import type { NavEdge, Waypoint } from '@extalia/office';
import type { OfficeAgent } from '../src/office/presence';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import type { Point3 } from '../src/office/scene/layout';
import type { OfficeAgentAllocation } from '../src/office/scene/interior/seating';
import { ADMISSION_WAVE_MS, DEPARTURE_GRACE_MS, MovementDirector, SETTLE_MS } from '../src/office/scene/movement/director';
import { HospitalityState } from '../src/office/scene/movement/hospitality';
import { sendMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { seatStageId, type OfficeNavigation, type SeatApproach } from '../src/office/scene/movement/navGraph';
import { OutdoorKioskState } from '../src/office/scene/movement/outdoorKiosk';

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };
const actor = (id: string): OfficeAgent => ({ id, sessionId: 'example-session', agentId: id, displayName: id, control: 'managed', status: 'working', running: true });

function harness() {
  let now = 0;
  const seats: SeatApproach[] = [0, 4, 8].map((x, index) => ({ seatId: `qa.station-${index + 1}`, roomId: 'qa', floor: 1,
    seat: [x, 0, 0], staging: [x, 0, -1.4], rotationY: 0, seatStyle: 'office', seatHeight: .46, sitMs: 860, standMs: 760 }));
  const positions: [string, Point3][] = [['entry', [0, 0, -6]], ['aisle', [0, 0, -3]],
    ...seats.map(seat => [seatStageId(seat.seatId), seat.staging] as [string, Point3])];
  const waypoints = new Map<string, Waypoint>(positions.map(([id, position]) => [id, { id, position, floorId: 'floor-1', kind: id.startsWith('seat:') ? 'approach' : 'corridor' }]));
  const edges = new Map<string, NavEdge[]>(positions.map(([id]) => [id, []]));
  const connect = (a: string, b: string) => {
    const p = waypoints.get(a)!.position, q = waypoints.get(b)!.position, cost = Math.hypot(p[0] - q[0], p[2] - q[2]);
    edges.get(a)!.push({ to: b, cost }); edges.get(b)!.push({ to: a, cost });
  };
  connect('entry', 'aisle'); for (const seat of seats) connect('aisle', seatStageId(seat.seatId));
  const navigation: OfficeNavigation = { graph: { nodes: new Map(positions.map(([id, p]) => [id, { id, floorId: 'floor-1', pos: { x: p[0], y: p[2] } }])), edges },
    waypoints, edges: [], seats: new Map(seats.map(seat => [seat.seatId, seat])), aisles: new Map(), connectors: [], elevatorEdges: new Map(), entryId: 'entry' };
  const blockers = new Map<string, Point3>();
  const foreignClaims = new Set<string>();
  const env: MovementEnv = { navigation, elevators, walkable: () => true,
    canUseSeat: (_id, seat) => !foreignClaims.has(seat.seatId),
    nearbyWalkers: id => [...blockers, ...director.list.filter(mover => mover.phase !== 'gone').map(mover => [mover.id, mover.position] as [string, Point3])]
      .filter(([other]) => other !== id).map(([other, position]) => ({ id: other, position: [...position], velocity: [0, 0, 0] })) };
  const director = new MovementDirector(env, () => now, null, new HospitalityState(), new OutdoorKioskState()); director.wander = false;
  const update = (claims: [string, number][], reducedMotion = false) => {
    const allocations: OfficeAgentAllocation[] = claims.map(([id, index]) => {
      const seat = seats[index]!; return { id: seat.seatId, resourceId: seat.seatId, agentId: id, floor: seat.floor,
        position: [...seat.seat], rotationY: seat.rotationY, seatHeight: seat.seatHeight };
    });
    director.update({ allocations, agents: claims.map(([id]) => actor(id)), reducedMotion, gaitOf: () => gaitParameters() });
  };
  const run = (seconds: number, check = () => {}) => {
    for (let frame = 0; frame < Math.ceil(seconds * 30); frame++) {
      const before = new Map(director.list.map(mover => [mover.id, [...mover.position] as Point3]));
      now += 1000 / 30; director.tick(1 / 30);
      for (const mover of director.list) {
        const previous = before.get(mover.id);
        if (previous) expect(Math.hypot(...mover.position.map((v, i) => v - previous[i]!) as Point3), mover.id).toBeLessThan(.18);
      }
      for (let a = 0; a < director.list.length; a++) for (let b = a + 1; b < director.list.length; b++) {
        const p = director.list[a]!.position, q = director.list[b]!.position;
        if (Math.abs(p[1] - q[1]) < .9) expect(Math.hypot(p[0] - q[0], p[2] - q[2])).toBeGreaterThanOrEqual(.58 - 1e-6);
      }
      check();
    }
  };
  return { director, seats, blockers, foreignClaims, env, update, run, time: () => now };
}

describe('physical seat handoff and admission', () => {
  it('retains a startup replacement until the outgoing desk occupant completes the physical handoff', () => {
    const h = harness();
    try {
      h.update([['outgoing', 0]]); h.director.tick(0);
      h.update([['replacement', 0]]);
      expect(h.director.position('replacement')).toBeUndefined();
      h.run(DEPARTURE_GRACE_MS / 1000 - .1, () => expect(h.director.position('replacement')).toBeUndefined());
      expect(h.director.list[0]!.phase).toBe('seated');
      let sawChairHandoff = false;
      h.run(30, () => {
        const outgoing = h.director.list.find(mover => mover.id === 'outgoing');
        if (outgoing && ['standing', 'chairing'].includes(outgoing.phase)) {
          sawChairHandoff = true; expect(h.director.position('replacement')).toBeUndefined();
        }
      });
      expect(sawChairHandoff).toBe(true);
      expect(h.director.position('outgoing')).toBeUndefined();
      expect(h.director.position('replacement')).toEqual(h.seats[0]!.seat);
      expect(h.director.list[0]!.phase).toBe('seated');
    } finally { h.director.dispose(); }
  });

  it('does not walk a late arrival into a desk still occupied by its departing owner', () => {
    const h = harness();
    try {
      h.update([['outgoing', 0]]); h.run((SETTLE_MS + 100) / 1000);
      h.update([['replacement', 0]]);
      h.run(DEPARTURE_GRACE_MS / 1000 - .1, () => expect(h.director.position('replacement')).toBeUndefined());
      h.run(40);
      expect(h.director.position('outgoing')).toBeUndefined();
      expect(h.director.position('replacement')).toEqual(h.seats[0]!.seat);
      expect(h.director.list[0]!.phase).toBe('seated');
    } finally { h.director.dispose(); }
  });

  it.each([false, true])('retains a blocked initial arrival with reduced motion %s, skips its head, and retries without a new update', reducedMotion => {
    const h = harness();
    try {
      h.blockers.set('stationary-visitor', [...h.seats[0]!.staging]);
      h.update([['blocked', 0], ['independent', 1]], reducedMotion); h.director.tick(0);
      expect(h.director.position('blocked')).toBeUndefined();
      expect(h.director.position('independent')).toEqual(h.seats[1]!.seat);
      h.run(60, () => expect(h.director.position('blocked')).toBeUndefined());
      h.blockers.clear(); h.run(ADMISSION_WAVE_MS / 1000 + .1);
      expect(h.director.position('blocked')).toEqual(h.seats[0]!.seat);
      expect(h.director.list.find(mover => mover.id === 'blocked')!.phase).toBe('seated');
    } finally { h.director.dispose(); }
  });

  it('removes a reduced-motion outgoing actor before admitting its replacement at the exact desk', () => {
    const h = harness();
    try {
      h.update([['outgoing', 0]]); h.director.tick(0); h.run(2);
      h.update([['replacement', 0]], true); h.run(2);
      expect(h.director.position('outgoing')).toBeUndefined();
      expect(h.director.position('replacement')).toEqual(h.seats[0]!.seat);
      expect(h.director.list).toHaveLength(1);
    } finally { h.director.dispose(); }
  });

  it('defers an existing reduced-motion reseat and completes after its stationary blocker clears', () => {
    const h = harness();
    try {
      h.update([['worker', 0]]); h.director.tick(0);
      h.blockers.set('stationary-visitor', [...h.seats[1]!.seat]);
      h.update([['worker', 1]], true); h.run(10);
      expect(h.director.position('worker')).toEqual(h.seats[0]!.seat);
      h.blockers.clear(); h.director.tick(0);
      expect(h.director.position('worker')).toEqual(h.seats[1]!.seat);
      h.director.tick(0); expect(h.director.position('worker')).toEqual(h.seats[1]!.seat);
    } finally { h.director.dispose(); }
  });

  it('cancels a queued placement when its allocation is removed instead of spawning a stale presence', () => {
    const h = harness();
    try {
      h.blockers.set('stationary-visitor', [...h.seats[0]!.seat]);
      h.update([['withdrawn', 0]], true); h.run(2);
      h.update([], true); h.blockers.clear(); h.run(3);
      expect(h.director.list).toHaveLength(0); expect(h.director.position('withdrawn')).toBeUndefined();
    } finally { h.director.dispose(); }
  });
  it('retains an in-flight chair lease for an already admitted newcomer', () => {
    const h = harness();
    try {
      h.update([['holder', 0], ['newcomer', 1]]); h.run(3);
      const holder = h.director.list.find(mover => mover.id === 'holder')!;
      const newcomer = h.director.list.find(mover => mover.id === 'newcomer')!;
      const seat = h.seats[0]!;
      // The stage is clear, but another character still owns stand-up.
      holder.phase = 'standing'; holder.seat = { ...seat, standMs: 5000 };
      holder.timer = 0; holder.fromSit = 1;
      holder.goal = { kind: 'seat', seat: h.seats[2]! };
      h.director.wander = false;
      newcomer.phase = 'walking'; newcomer.motion.sit = 0; newcomer.goal = { kind: 'seat', seat };
      newcomer.seat = seat; newcomer.steps = []; newcomer.stepIndex = 0;
      newcomer.lastNode = seatStageId(seat.seatId);
      newcomer.position.splice(0, 3, ...seat.staging);
      h.run(.5, () => {
        expect(holder.phase).toBe('standing');
        expect(newcomer.phase).toBe('walking');
        expect(newcomer.chair).toBeNull();
        expect(newcomer.goal).toEqual({ kind: 'seat', seat });
      });
      // Releasing the physical interaction allows the retained goal to finish.
      holder.phase = 'seated'; holder.seat = h.seats[2]!; holder.motion.sit = 1;
      holder.position.splice(0, 3, ...h.seats[2]!.seat);
      h.run(10);
      expect(newcomer.phase).toBe('seated');
      expect(newcomer.position).toEqual(seat.seat);
    } finally { h.director.dispose(); }
  });

  it('settles a reduced-motion two-seat swap as one validated batch', () => {
    const h = harness();
    try {
      h.update([['a', 0], ['b', 1]]); h.director.tick(0);
      h.update([['a', 1], ['b', 0]], true);
      expect(h.director.position('a')).toEqual(h.seats[1]!.seat);
      expect(h.director.position('b')).toEqual(h.seats[0]!.seat);
      expect(h.director.list.map(mover => mover.phase)).toEqual(['seated', 'seated']);
      h.run(2);
      expect(h.director.list.every(mover => mover.chair === null && mover.staticSeat === null && mover.motion.sit === 1)).toBe(true);
    } finally { h.director.dispose(); }
  });

  it('settles all moving participants of a reduced-motion three-seat permutation together', () => {
    const h = harness();
    try {
      h.update([['a', 0], ['b', 1], ['c', 2]]); h.run(3);
      const expected = new Map([['a', h.seats[1]!], ['b', h.seats[2]!], ['c', h.seats[0]!]]);
      for (const mover of h.director.list) expect(sendMover(mover, { kind: 'seat', seat: expected.get(mover.id)! }, h.env)).toBe(true);
      h.run(.3);
      expect(h.director.list.every(mover => mover.phase === 'standing')).toBe(true);
      h.update([['a', 1], ['b', 2], ['c', 0]], true);
      for (const mover of h.director.list) {
        expect(mover.position).toEqual(expected.get(mover.id)!.seat);
        expect(mover.goal).toEqual({ kind: 'seat', seat: expected.get(mover.id) });
        expect(mover.phase).toBe('seated'); expect(mover.pending).toBeNull(); expect(mover.motion.sit).toBe(1);
      }
      h.run(2);
    } finally { h.director.dispose(); }
  });

  it('keeps an externally blocked permutation entirely pending and retries after the body clears', () => {
    const h = harness();
    try {
      h.update([['a', 0], ['b', 1]]); h.director.tick(0);
      // This foreign visitor is outside the batch and does not overlap either seated root.
      h.blockers.set('foreign-visitor', [...h.seats[0]!.staging]);
      h.update([['a', 1], ['b', 0]], true);
      h.run(5, () => {
        expect(h.director.position('a')).toEqual(h.seats[0]!.seat);
        expect(h.director.position('b')).toEqual(h.seats[1]!.seat);
      });
      h.blockers.clear(); h.director.tick(0);
      expect(h.director.position('a')).toEqual(h.seats[1]!.seat);
      expect(h.director.position('b')).toEqual(h.seats[0]!.seat);
    } finally { h.director.dispose(); }
  });

  it('retains outside interaction claims while validating a reduced-motion permutation', () => {
    const h = harness();
    try {
      h.update([['a', 0], ['b', 1]]); h.director.tick(0);
      h.foreignClaims.add(h.seats[0]!.seatId);
      h.update([['a', 1], ['b', 0]], true); h.run(2);
      expect(h.director.position('a')).toEqual(h.seats[0]!.seat);
      expect(h.director.position('b')).toEqual(h.seats[1]!.seat);
      h.foreignClaims.clear(); h.director.tick(0);
      expect(h.director.position('a')).toEqual(h.seats[1]!.seat);
      expect(h.director.position('b')).toEqual(h.seats[0]!.seat);
    } finally { h.director.dispose(); }
  });

  it('rejects duplicate reduced-motion targets and accepts a corrected unique batch', () => {
    const h = harness();
    try {
      h.update([['a', 0], ['b', 1]]); h.director.tick(0);
      h.update([['a', 2], ['b', 2]], true); h.run(2);
      expect(h.director.position('a')).toEqual(h.seats[0]!.seat);
      expect(h.director.position('b')).toEqual(h.seats[1]!.seat);
      h.update([['a', 2], ['b', 0]], true);
      expect(h.director.position('a')).toEqual(h.seats[2]!.seat);
      expect(h.director.position('b')).toEqual(h.seats[0]!.seat);
    } finally { h.director.dispose(); }
  });

});
