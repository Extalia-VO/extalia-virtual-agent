import { BoxGeometry, Group, Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { DoorTraffic, type DoorHit, type WalkerInfo } from '../src/office/scene/interior/doorTraffic';
import type { Point3 } from '../src/office/scene/layout';
import { createMover, sendMover, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { recoveryGoal } from '../src/office/scene/movement/movementRecovery';
import { WalkingClearance } from '../src/office/scene/movement/naturalClearance';
import { officeNavigation } from '../src/office/scene/movement/navGraph';
import type { WalkingNeighbor } from '../src/office/scene/movement/naturalWalking';
import { OFFICE_DOOR_PORTALS } from './fixtures/officeDoorPortals';

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };
const DT = 1 / 30;
const distance = (a: Readonly<Point3>, b: Readonly<Point3>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function fixture(closed = false) {
  const navigation = officeNavigation(), root = new Group(), field = new WalkingClearance();
  const feet: Point3 = [6.707525128363975, 6.4, -1.0725024927059243];
  const aisle = navigation.waypoints.get('seat:meeting-b.seat-10:aisle')!.position;
  const bend: Point3 = [feet[0], 6.4, aisle[2]];
  const goal = { kind: 'leave' as const, node: 'f2.stairs-north' }, destination = navigation.waypoints.get(goal.node)!.position;
  const box = (min: Point3, max: Point3) => {
    const mesh = new Mesh(new BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]));
    mesh.position.set((max[0] + min[0]) / 2, (max[1] + min[1]) / 2, (max[2] + min[2]) / 2); root.add(mesh); return mesh;
  };
  box([-21, 6.3, -19], [25, 6.4, 19]);
  // Measured foreign chair bounds from the rendered meeting24 failure.
  box([5.736327416897, 6.4, -1.473297822475], [6.403672583103, 7.52, -.833511310816]);
  // Adjacent furniture makes the free feet pocket reachable only through its north opening.
  box([7.1, 6.4, -1.48], [7.7, 7.52, -.83]); box([5, 6.4, -.3], [8.5, 7.52, .1]);
  const cap = box([6.4, 6.4, -1.85], [7.1, 7.52, -1.81]);
  if (!closed) root.remove(cap);
  field.rebuild([root]);
  let now = 0, neighbors: WalkingNeighbor[] = [];
  const tracked = new Map<string, WalkerInfo>();
  const portals: DoorHit[] = OFFICE_DOOR_PORTALS.filter(portal => portal.id === 'floor-2.meeting-b.entry').map(portal => ({ id: portal.id, door: portal }));
  const doors = new DoorTraffic({ forEachDoor: visit => portals.forEach(hit => visit(hit.id, hit.door)), forEachWalker: visit => tracked.forEach(visit) }, () => now);
  const mover = createMover('retained-departure', gaitParameters(), [...feet], 0, false);
  mover.goal = { kind: 'seat', seat: navigation.seats.get('meeting-b.seat-2')! };
  mover.seat = mover.goal.seat;
  mover.steps = [{ kind: 'walk', node: 'seat:meeting-b.seat-8:aisle', to: [...navigation.waypoints.get('seat:meeting-b.seat-8:aisle')!.position], stairs: false }];
  mover.pending = goal;
  recoveryGoal(mover.recovery, goal.node); mover.recovery.attempts = 3;
  const env: MovementEnv = { navigation, elevators, doors, walkable: field.segmentClear, nearbyWalkers: () => neighbors,
    trackWalker(id, position, target) { if (position && target) tracked.set(id, { id, position: [...position], target: [...target], updatedAt: now }); else tracked.delete(id); } };
  const step = () => {
    now += DT * 1000;
    const before: Point3 = [...mover.position]; stepMover(mover, DT, env);
    expect(distance(before, mover.position)).toBeLessThan(.08);
    expect(field.segmentClear(before, mover.position, .29)).toBe(true);
    expect(mover.recovery.attempts).toBe(3);
    if (distance(mover.position, destination) > .001) expect(mover.opacity).toBe(1);
  };
  const finish = () => {
    for (let frame = 0; frame < 30 * 90 && mover.phase !== 'gone'; frame++) step();
    expect(mover.phase).toBe('gone'); expect(mover.position).toEqual(destination); expect(mover.pending).toBeNull(); expect(mover.goal).toBe(goal);
  };
  return { mover, env, goal, feet, bend, aisle, portals, field, step, finish,
    open() { root.remove(cap); field.rebuild([root]); }, setNeighbors(value: WalkingNeighbor[]) { neighbors = value; },
    dispose() { root.traverse(node => { if (node instanceof Mesh) node.geometry.dispose(); }); cap.geometry.dispose(); field.clear(); } };
}

describe('pending movement intent retries from actual feet', () => {
  it('rejoins the actual authored meeting aisle through the measured safe bend and reaches the pending leave goal', () => {
    const h = fixture();
    try {
      expect(h.field.segmentClear(h.feet, h.aisle, .29)).toBe(false);
      expect(h.field.segmentClear(h.feet, h.bend, .29)).toBe(true);
      expect(h.field.segmentClear(h.bend, h.aisle, .29)).toBe(true);
      expect(sendMover(h.mover, h.goal, h.env)).toBe(true);
      expect(h.mover.position).toEqual(h.feet);
      expect(h.mover.steps[0]).toMatchObject({ kind: 'walk', node: 'movement-pending-bend', to: h.bend });
      expect(h.mover.steps[1]?.node).toMatch(/^seat:meeting-b\.seat-\d+:aisle$/);
      h.finish();
    } finally { h.dispose(); }
  });

  it('retains the pending goal while every escape is blocked, then retries at the bounded ten-second cadence', () => {
    const h = fixture(true);
    try {
      const oldGoal = h.mover.goal;
      expect(sendMover(h.mover, h.goal, h.env)).toBe(true);
      expect(h.mover.goal).toBe(oldGoal); expect(h.mover.pending).toBe(h.goal);
      const retries: number[] = [];
      let previous = 0;
      for (let frame = 0; frame < 30 * 34; frame++) {
        h.step(); expect(h.mover.position).toEqual(h.feet);
        if (h.mover.stationaryRecheck > previous) { retries.push(h.mover.stationaryRecheck); previous = h.mover.stationaryRecheck; }
      }
      expect(retries).toHaveLength(3);
      for (let index = 1; index < retries.length; index++) expect(retries[index]! - retries[index - 1]!).toBeGreaterThanOrEqual(10);
      h.open();
      for (let frame = 0; frame < 30 * 3; frame++) { h.step(); expect(h.mover.position).toEqual(h.feet); }
      h.finish();
    } finally { h.dispose(); }
  });

  it.each(['body', 'portal'] as const)('does not cut through a %s to join a new goal', mode => {
    const h = fixture();
    try {
      if (mode === 'body') h.setNeighbors([{ id: 'foreign-body', position: h.bend, velocity: [0, 0, 0] }]);
      else h.portals.push({ id: 'foreign-door', door: { floor: 2, center: [h.feet[0], 6.4, -1.8], yaw: 0, clearWidth: .8, height: 2.55, openAngle: Math.PI / 2, sliding: false } });
      const oldGoal = h.mover.goal;
      expect(sendMover(h.mover, h.goal, h.env)).toBe(true);
      expect(h.mover.goal).toBe(oldGoal); expect(h.mover.pending).toBe(h.goal); expect(h.mover.position).toEqual(h.feet);
    } finally { h.dispose(); }
  });
});
