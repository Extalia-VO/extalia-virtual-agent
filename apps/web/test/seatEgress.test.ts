import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import type { NavEdge, Waypoint } from '@extalia/office';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import type { Point3 } from '../src/office/scene/layout';
import { createMover, placeSeated, sendMover, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { WalkingClearance } from '../src/office/scene/movement/naturalClearance';
import { seatStageId, type OfficeNavigation, type SeatApproach } from '../src/office/scene/movement/navGraph';

function fixture(yaw = 0, y = 0) {
  const root = new Group(), chair = new Group(), field = new WalkingClearance();
  root.position.y = y;
  chair.rotation.y = yaw;
  chair.userData.officeSeat = true;
  // Actual meeting-chair bounds extend .3383m behind the avatar root. The
  // ordinary .29m body radius therefore still intersects after a .6m backstep.
  const geometry = new Mesh(new BoxGeometry(.6674, 1.12, .6398), new MeshBasicMaterial());
  geometry.position.set(0, .56, -.0184); chair.add(geometry); root.add(chair);
  const rear = (distance: number): Point3 => [-Math.sin(yaw) * distance, y, -Math.cos(yaw) * distance];
  const seat: SeatApproach = { seatId: 'example-meeting-seat', roomId: 'example-meeting', floor: y ? 2 : 1,
    seat: [0, y, 0], staging: rear(1), rotationY: yaw, seatStyle: 'meeting', seatHeight: .46, sitMs: 860, standMs: 760 };
  const rebuild = () => field.rebuild([root]);
  return { root, chair, field, rear, seat, rebuild };
}

function obstacle(root: Group, position: Point3, size: Point3 = [.5, 1.2, .2], seat = false) {
  const group = new Group(); group.position.set(...position); group.userData.officeSeat = seat;
  const mesh = new Mesh(new BoxGeometry(...size), new MeshBasicMaterial()); mesh.position.y = size[1] / 2;
  group.add(mesh); root.add(group); return group;
}

describe('controlled meeting-chair egress clearance', () => {
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) it(`clears its own rear chair contact at yaw ${yaw}`, () => {
    const h = fixture(yaw); h.rebuild();
    expect(h.field.segmentClear(h.rear(.6), h.seat.staging, .29)).toBe(false);
    expect(h.field.segmentClear(h.seat.staging, h.seat.staging, .29)).toBe(true);
    expect(h.field.seatExitClear(h.seat, h.seat.seat, h.rear(.6))).toBe(true);
    expect(h.field.seatExitClear(h.seat, h.rear(.6), h.seat.staging)).toBe(true);
    expect(h.field.seatExitClear({ ...h.seat, seatStyle: 'guest' }, h.rear(.6), h.seat.staging)).toBe(true);
  });

  it('never masks a neighboring chair or ordinary furniture in the departure lane', () => {
    for (const isChair of [false, true]) {
      const h = fixture(); obstacle(h.root, [.2, 0, -.85], [.5, 1.2, .2], isChair); h.rebuild();
      expect(h.field.seatExitClear(h.seat, h.rear(.6), h.seat.staging)).toBe(false);
    }
  });

  it('does not permit a side cut, overrun, inward motion or another floor', () => {
    const h = fixture(); h.rebuild();
    expect(h.field.seatExitClear(h.seat, h.rear(.6), [.2, 0, -1])).toBe(false);
    expect(h.field.seatExitClear(h.seat, h.rear(.6), h.rear(1.2))).toBe(false);
    expect(h.field.seatExitClear(h.seat, h.rear(.8), h.rear(.4))).toBe(false);
    expect(h.field.seatExitClear(h.seat, h.rear(.6), [0, 6.4, -1])).toBe(false);
    expect(h.field.seatExitClear({ ...h.seat, staging: [1, 0, 0] }, h.seat.seat, [1, 0, 0])).toBe(false);
    expect(h.field.seatExitClear({ ...h.seat, staging: [0, 0, 1] }, h.seat.seat, [0, 0, 1])).toBe(false);
  });

  it('requires an actual matching seat owner rather than bypassing an arbitrary collider', () => {
    const h = fixture(); delete h.chair.userData.officeSeat; h.rebuild();
    expect(h.field.seatExitClear(h.seat, h.rear(.6), h.seat.staging)).toBe(false);
    const unrelated = fixture(); unrelated.chair.position.x = 2; unrelated.rebuild();
    expect(unrelated.field.seatExitClear(unrelated.seat, unrelated.rear(.6), unrelated.seat.staging)).toBe(false);
  });

  it('keeps supported floor checks while ignoring its own chair only', () => {
    const h = fixture(0, 6.4);
    const floor = new Mesh(new BoxGeometry(4, .1, 4), new MeshBasicMaterial()); floor.position.y = -.05; h.root.add(floor); h.rebuild();
    expect(h.field.seatExitClear(h.seat, h.rear(.6), h.seat.staging)).toBe(true);
    h.root.remove(floor); h.rebuild();
    expect(h.field.seatExitClear(h.seat, h.rear(.6), h.seat.staging)).toBe(false);
  });

  it('does not add rear-contact authority to other seating styles or invalid inputs', () => {
    const h = fixture(); h.rebuild();
    for (const seatStyle of ['office', 'sofa', 'armchair', 'barstool', 'bench', 'patio', 'none'] as const)
      expect(h.field.seatExitClear({ ...h.seat, seatStyle }, h.rear(.6), h.seat.staging)).toBe(false);
    expect(h.field.seatExitClear(h.seat, [NaN, 0, -.6], h.seat.staging)).toBe(false);
    expect(h.field.seatExitClear(h.seat, h.rear(.6), h.seat.staging, -1)).toBe(false);
    // Upholstered front contact retains its existing, separate lane rule.
    expect(h.field.seatContactClear({ ...h.seat, seatStyle: 'sofa' }, h.rear(.6), h.seat.staging)).toBe(false);
  });
});

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };

function departure() {
  const h = fixture(), stage = seatStageId(h.seat.seatId);
  const positions: [string, Point3][] = [[stage, h.seat.staging], ['aisle', [0, 0, -2]], ['exit-a', [2, 0, -2]], ['exit-b', [-2, 0, -2]]];
  const waypoints = new Map<string, Waypoint>(positions.map(([id, position]) => [id, { id, floorId: 'floor-1', kind: id === stage ? 'approach' : 'corridor', position }]));
  const graphEdges = new Map<string, NavEdge[]>([[stage, [{ to: 'aisle', cost: 1 }]], ['aisle', [{ to: stage, cost: 1 }, { to: 'exit-a', cost: 2 }, { to: 'exit-b', cost: 2 }]],
    ['exit-a', [{ to: 'aisle', cost: 2 }]], ['exit-b', [{ to: 'aisle', cost: 2 }]]]);
  const navigation: OfficeNavigation = { graph: { nodes: new Map(positions.map(([id, p]) => [id, { id, floorId: 'floor-1', pos: { x: p[0], y: p[2] } }])), edges: graphEdges },
    waypoints, edges: [], seats: new Map([[h.seat.seatId, h.seat]]), aisles: new Map(), connectors: [], elevatorEdges: new Map(), entryId: 'exit-a' };
  h.rebuild();
  const env: MovementEnv = { navigation, elevators, walkable: h.field.segmentClear, seatExitClear: h.field.seatExitClear,
    seatEntryClear: h.field.seatEntryClear, nearbyWalkers: () => [] };
  const mover = createMover('meeting-departure', gaitParameters(), h.seat.seat, 0, true);
  placeSeated(mover, h.seat, env);
  const step = () => {
    const before: Point3 = [...mover.position];
    stepMover(mover, 1 / 30, env);
    const distance = Math.hypot(...mover.position.map((value, axis) => value - before[axis]!) as Point3);
    expect(distance).toBeLessThan(.08);
    if (distance > 1e-6) expect(h.field.segmentClear(before, mover.position, .29) || h.field.seatExitClear(h.seat, before, mover.position, .29)).toBe(true);
    expect(mover.recovery.attempts).toBe(0);
    if (mover.opacity < 1) expect(['vanishing', 'gone']).toContain(mover.phase);
  };
  const untilExit = () => {
    for (let frame = 0; frame < 300 && !(mover.seatExit && Math.abs(mover.position[2]) > .25); frame++) step();
    expect(mover.seatExit).toBe(h.seat); expect(mover.backing).toBe(true);
  };
  const finish = (destination: 'exit-a' | 'exit-b') => {
    for (let frame = 0; frame < 900 && mover.phase !== 'gone'; frame++) step();
    expect(mover.phase).toBe('gone');
    expect(mover.position).toEqual(waypoints.get(destination)!.position);
    expect(mover.seatExit).toBeNull(); expect(mover.pending).toBeNull();
  };
  return { ...h, env, mover, step, untilExit, finish };
}

describe('meeting-seat departure state integration', () => {
  it('backs out beyond its full chair envelope and reaches the original goal without recovery or jumps', () => {
    const h = departure(), goal = { kind: 'leave' as const, node: 'exit-a' };
    expect(sendMover(h.mover, goal, h.env)).toBe(true); h.untilExit();
    expect(h.mover.steps[h.mover.stepIndex]?.kind === 'walk' && h.mover.steps[h.mover.stepIndex]?.to).toEqual(h.seat.staging);
    h.finish('exit-a'); expect(h.mover.goal).toBe(goal);
  });

  it('holds a newer goal until the controlled exit has reached its clear stage', () => {
    const h = departure();
    sendMover(h.mover, { kind: 'leave', node: 'exit-a' }, h.env); h.untilExit();
    const latest = { kind: 'leave' as const, node: 'exit-b' };
    expect(sendMover(h.mover, latest, h.env)).toBe(true); expect(h.mover.pending).toBe(latest);
    for (let frame = 0; frame < 300 && h.mover.seatExit; frame++) {
      expect(h.mover.position[0]).toBeCloseTo(0); h.step();
    }
    h.finish('exit-b'); expect(h.mover.goal).toBe(latest);
  });

  it('never masks a wall during a live departure and resumes when that obstruction is removed', () => {
    const h = departure(), wall = obstacle(h.root, [0, 0, -.9]); h.rebuild();
    const goal = { kind: 'leave' as const, node: 'exit-a' };
    sendMover(h.mover, goal, h.env);
    for (let frame = 0; frame < 300; frame++) h.step();
    expect(h.mover.seatExit).toBe(h.seat); expect(h.mover.position[2]).toBeGreaterThan(-.52);
    expect(h.mover.opacity).toBe(1);
    h.root.remove(wall); h.rebuild(); h.finish('exit-a'); expect(h.mover.goal).toBe(goal);
  });

  it('keeps another body out of the rear lane rather than backing through it', () => {
    const h = departure(); let blocked = true;
    const env: MovementEnv = { ...h.env, nearbyWalkers: () => blocked ? [{ id: 'waiting-neighbor', position: [0, 0, -1], velocity: [0, 0, 0] }] : [] };
    sendMover(h.mover, { kind: 'leave', node: 'exit-a' }, env);
    for (let frame = 0; frame < 300; frame++) {
      const before: Point3 = [...h.mover.position]; stepMover(h.mover, 1 / 30, env);
      expect(Math.hypot(...h.mover.position.map((value, axis) => value - before[axis]!) as Point3)).toBeLessThan(.08);
      expect(Math.hypot(h.mover.position[0], h.mover.position[2] + 1)).toBeGreaterThan(.54);
    }
    expect(h.mover.seatExit).toBe(h.seat); expect(h.mover.opacity).toBe(1);
    blocked = false; h.finish('exit-a');
  });

  it('clears stale exit state when reduced motion places the actor seated, then accepts a later trip', () => {
    const h = departure();
    sendMover(h.mover, { kind: 'leave', node: 'exit-a' }, h.env); h.untilExit();
    sendMover(h.mover, { kind: 'leave', node: 'exit-b' }, h.env);
    // Directors use this same placement when reduced motion is enabled.
    placeSeated(h.mover, h.seat, h.env);
    expect(h.mover.seatExit).toBeNull(); expect(h.mover.pending).toBeNull(); expect(h.mover.backing).toBe(false);
    expect(h.mover.phase).toBe('seated'); expect(h.mover.position).toEqual(h.seat.seat);
    const next = { kind: 'leave' as const, node: 'exit-b' };
    expect(sendMover(h.mover, next, h.env)).toBe(true); h.finish('exit-b'); expect(h.mover.goal).toBe(next);
  });
});

describe('controlled meeting-chair entry clearance', () => {
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) it(`enters only its own rear contact at yaw ${yaw}`, () => {
    const h = fixture(yaw); h.rebuild();
    expect(h.field.segmentClear(h.seat.staging, h.seat.seat, .29)).toBe(false);
    expect(h.field.seatEntryClear(h.seat, h.seat.staging, h.rear(.6))).toBe(true);
    expect(h.field.seatEntryClear(h.seat, h.rear(.6), h.seat.seat)).toBe(true);
    expect(h.field.seatEntryClear({ ...h.seat, seatStyle: 'guest' }, h.seat.staging, h.seat.seat)).toBe(true);
    expect(h.field.seatEntryClear(h.seat, h.rear(.4), h.rear(.8))).toBe(false);
  });

  it('rejects lateral, extended, wrong-floor and unauthored entries', () => {
    const h = fixture(); h.rebuild();
    expect(h.field.seatEntryClear(h.seat, [.2, 0, -1], h.seat.seat)).toBe(false);
    expect(h.field.seatEntryClear(h.seat, h.rear(1.2), h.seat.seat)).toBe(false);
    expect(h.field.seatEntryClear(h.seat, [0, 6.4, -1], h.seat.seat)).toBe(false);
    expect(h.field.seatEntryClear({ ...h.seat, seatStyle: 'sofa' }, h.seat.staging, h.seat.seat)).toBe(false);
    delete h.chair.userData.officeSeat; h.rebuild();
    expect(h.field.seatEntryClear(h.seat, h.seat.staging, h.seat.seat)).toBe(false);
  });

  it('retains foreign furniture and chair collisions throughout the inward lane', () => {
    for (const isChair of [false, true]) {
      const h = fixture(); obstacle(h.root, [.2, 0, -.85], [.5, 1.2, .2], isChair); h.rebuild();
      expect(h.field.seatEntryClear(h.seat, h.seat.staging, h.seat.seat)).toBe(false);
    }
  });

  it('requires floor support even on an otherwise clear inward lane', () => {
    const h = fixture(0, 6.4); h.rebuild();
    expect(h.field.seatEntryClear(h.seat, h.seat.staging, h.seat.seat)).toBe(false);
    const floor = new Mesh(new BoxGeometry(4, .1, 4), new MeshBasicMaterial()); floor.position.y = -.05; h.root.add(floor); h.rebuild();
    expect(h.field.seatEntryClear(h.seat, h.seat.staging, h.seat.seat)).toBe(true);
  });
});

function arrival() {
  const h = departure(), mover = createMover('meeting-arrival', gaitParameters(), [2, 0, -2], 0, false);
  mover.lastNode = 'exit-a';
  const step = () => {
    const before: Point3 = [...mover.position]; stepMover(mover, 1 / 30, h.env);
    const distance = Math.hypot(...mover.position.map((value, axis) => value - before[axis]!) as Point3);
    expect(distance).toBeLessThan(.08);
    if (distance > 1e-6) expect(h.field.segmentClear(before, mover.position, .29) || h.field.seatEntryClear(h.seat, before, mover.position, .29)).toBe(true);
    expect(mover.recovery.attempts).toBe(0); expect(mover.opacity).toBe(1);
  };
  const finish = () => {
    for (let frame = 0; frame < 900 && mover.phase !== 'seated'; frame++) step();
    expect(mover.phase).toBe('seated'); expect(mover.position).toEqual(h.seat.seat);
    expect(mover.motion.sit).toBe(1);
  };
  expect(sendMover(mover, { kind: 'seat', seat: h.seat }, h.env)).toBe(true);
  return { ...h, mover, step, finish };
}

describe('meeting-seat arrival state integration', () => {
  it('reaches the authored rear stage and enters its own chair without jumps or recovery', () => {
    const h = arrival(); let sawRearApproach = false;
    for (let frame = 0; frame < 900 && h.mover.phase !== 'seated'; frame++) {
      if (h.mover.phase === 'sitting' && h.mover.timer < 0) {
        sawRearApproach = true; expect(h.mover.position[0]).toBeCloseTo(0);
        expect(h.mover.position[2]).toBeGreaterThanOrEqual(-1.01);
      }
      h.step();
    }
    expect(sawRearApproach).toBe(true); h.finish();
  });

  it('waits at the rear stage for foreign furniture instead of entering through it', () => {
    const h = arrival(), wall = obstacle(h.root, [0, 0, -.45], [.5, 1.2, .1]); h.rebuild();
    for (let frame = 0; frame < 300; frame++) h.step();
    expect(h.mover.phase).toBe('sitting'); expect(h.mover.timer).toBeLessThan(0);
    expect(h.mover.position[2]).toBeLessThan(-.77);
    h.root.remove(wall); h.rebuild(); h.finish();
  });

  it('waits for an occupied chair rather than overlapping its stationary occupant', () => {
    const h = arrival(); let blocked = true;
    const env: MovementEnv = { ...h.env, nearbyWalkers: () => blocked ? [{ id: 'seated-neighbor', position: [0, 0, 0], velocity: [0, 0, 0] }] : [] };
    for (let frame = 0; frame < 300; frame++) {
      const before: Point3 = [...h.mover.position]; stepMover(h.mover, 1 / 30, env);
      expect(Math.hypot(...h.mover.position.map((value, axis) => value - before[axis]!) as Point3)).toBeLessThan(.08);
      expect(Math.hypot(h.mover.position[0], h.mover.position[2])).toBeGreaterThan(.54);
      expect(h.mover.opacity).toBe(1); expect(h.mover.recovery.attempts).toBe(0);
    }
    expect(h.mover.phase).toBe('sitting'); expect(h.mover.timer).toBeLessThan(0);
    blocked = false;
    for (let frame = 0; frame < 300 && h.mover.phase !== 'seated'; frame++) stepMover(h.mover, 1 / 30, env);
    expect(h.mover.phase).toBe('seated'); expect(h.mover.position).toEqual(h.seat.seat);
  });
});
