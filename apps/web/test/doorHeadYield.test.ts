import type { NavEdge, Waypoint } from '@extalia/office';
import { describe, expect, it } from 'vitest';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { DoorTraffic, doorAxes, type DoorHit, type DoorInfo, type WalkerInfo } from '../src/office/scene/interior/doorTraffic';
import type { Point3 } from '../src/office/scene/layout';
import { createMover, stepMover, type ElevatorAccess, type MovementEnv, type Mover } from '../src/office/scene/movement/mover';
import type { OfficeNavigation } from '../src/office/scene/movement/navGraph';
import type { WalkingNeighbor } from '../src/office/scene/movement/naturalWalking';

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };
const DT = 1 / 30;
const distance = (a: Readonly<Point3>, b: Readonly<Point3>) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const targetOf = (actor: Mover) => {
  const step = actor.steps[actor.stepIndex];
  return actor.target ?? (step?.kind === 'walk' ? step.to : undefined);
};

/** A single-file desk aisle opens into a real bay beyond the old 1.6 m search. */
function fixture(side: 1 | -1 = -1, bayDepth = 4.4) {
  const at = (x: number, z: number): Point3 => [x, 0, side * z];
  const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 1.6, height: 2.55, openAngle: Math.PI / 2, sliding: false };
  const portals: DoorHit[] = [{ id: 'main', door }];
  const positions: [string, Point3, Waypoint['kind']][] = [['head-start', at(0, 1), 'corridor'], ['waiting-start', at(0, 1.6), 'corridor'],
    ['bend', at(0, bayDepth), 'corridor'], ['bay', at(1.2, bayDepth), 'corridor'], ['inside', at(0, .8), 'door'],
    ['threshold', at(0, 0), 'door'], ['outside', at(0, -.8), 'door'], ['head-goal', at(0, 5.5), 'corridor'], ['waiting-goal', at(0, -5), 'corridor']];
  const waypoints = new Map<string, Waypoint>(positions.map(([id, position, kind]) => [id, { id, floorId: 'floor-1', position, kind }]));
  const graphEdges = new Map<string, NavEdge[]>(positions.map(([id]) => [id, []]));
  for (const [a, b] of [['bay', 'bend'], ['bend', 'waiting-start'], ['waiting-start', 'head-start'], ['head-start', 'inside'],
    ['inside', 'threshold'], ['threshold', 'outside'], ['outside', 'waiting-goal'], ['bend', 'head-goal']]) {
    const cost = distance(waypoints.get(a!)!.position, waypoints.get(b!)!.position);
    graphEdges.get(a!)!.push({ to: b!, cost }); graphEdges.get(b!)!.push({ to: a!, cost });
  }
  const navigation: OfficeNavigation = { graph: { nodes: new Map(positions.map(([id, point]) => [id, { id, floorId: 'floor-1', pos: { x: point[0], y: point[2] } }])), edges: graphEdges },
    waypoints, edges: [], connectors: [], seats: new Map(), aisles: new Map(), elevatorEdges: new Map(), entryId: 'waiting-goal' };
  let now = 0;
  const tracked = new Map<string, WalkerInfo>();
  const doors = new DoorTraffic({ forEachDoor: visit => portals.forEach(hit => visit(hit.id, hit.door)), forEachWalker: visit => tracked.forEach(visit) }, () => now);
  const head = createMover('head', gaitParameters(), at(0, 1), 0, false);
  const waiting = createMover('waiting', gaitParameters(), at(0, 1.6), 0, false);
  head.goal = { kind: 'leave', node: 'head-goal' };
  head.steps = [{ kind: 'walk', node: 'head-goal', to: at(0, 5.5), stairs: false }];
  head.phase = 'doorwork';
  head.door = { id: 'main', door, kind: 'open', beat: 'handoff', side: -side as 1 | -1, entrySide: -side as 1 | -1, hand: 1, timer: 0, path: null };
  waiting.goal = { kind: 'leave', node: 'waiting-goal' };
  waiting.steps = ['inside', 'threshold', 'outside', 'waiting-goal'].map(node => ({ kind: 'walk', node, to: [...waypoints.get(node)!.position], stairs: false }));
  waiting.phase = 'doorwork';
  waiting.door = { id: 'main', door, kind: 'wait', beat: 'reserve', side, entrySide: side, hand: 1, timer: 0, path: null, queueIndex: 1 };
  const actors = [head, waiting];
  for (const actor of actors) tracked.set(actor.id, { id: actor.id, position: [...actor.position], target: [...targetOf(actor)!], updatedAt: now });
  doors.queue('main', door, head.id, head.position, -side as 1 | -1);
  doors.queue('main', door, waiting.id, waiting.position, side);
  doors.claim('main', head.id); doors.hold('main', head.id, 1, 10);
  let neighbors: ((id: string) => WalkingNeighbor[]) | undefined;
  const walkable: NonNullable<MovementEnv['walkable']> = (from, to, radius = .29) => {
    const count = Math.max(1, Math.ceil(distance(from, to) / .03));
    for (let sample = 0; sample <= count; sample++) {
      const t = sample / count, x = from[0] + (to[0] - from[0]) * t, z = (from[2] + (to[2] - from[2]) * t) * side;
      // Keep the shallow handle-contact pocket usable; the long desk aisle
      // still cannot fit two passing bodies or an ordinary lateral wait.
      const halfWidth = x < 0 && z < 1.75 ? .79 : .61;
      if (z > .8 && z < 4 && Math.abs(x) + radius > halfWidth) return false;
      if (Math.abs(z) < radius + .08 && Math.abs(x) > door.clearWidth / 2 - radius) return false;
    }
    return true;
  };
  const env: MovementEnv = { navigation, elevators, doors, walkable,
    nearbyWalkers: id => neighbors ? neighbors(id) : actors.filter(actor => actor.id !== id && actor.phase !== 'gone').map(actor => ({
      id: actor.id, position: [...actor.position], velocity: [0, 0, 0], target: targetOf(actor) })),
    trackWalker(id, position, target) { if (position && target) tracked.set(id, { id, position: [...position], target: [...target], updatedAt: now }); else tracked.delete(id); } };
  const tick = (onlyWaiter = false) => {
    now += DT * 1000;
    if (onlyWaiter) doors.queue('main', door, head.id, head.position, -side as 1 | -1);
    for (const actor of onlyWaiter ? [waiting] : actors) {
      const before: Point3 = [...actor.position]; stepMover(actor, DT, env);
      expect(distance(before, actor.position)).toBeLessThan(.08);
      expect(walkable(before, actor.position)).toBe(true);
      if (actor.phase !== 'gone') expect(actor.opacity).toBeGreaterThan(0);
      if (actor === waiting && doorAxes(door, before).through * side >= 0 && doorAxes(door, actor.position).through * side < 0)
        expect(doors.queueStatus('main', actor.id).head).toBe(actor.id);
    }
    if (actors.every(actor => actor.phase !== 'gone')) expect(distance(head.position, waiting.position)).toBeGreaterThanOrEqual(.56 - 1e-6);
  };
  return { head, waiting, actors, env, doors, portals, at, tick, side, setNeighbors(value: (id: string) => WalkingNeighbor[]) { neighbors = value; } };
}

describe('queued waiter clears its head after physical passage', () => {
  it.each([-1, 1] as const)('breaks the two-actor handoff cycle through an authored bay: side=%s', side => {
    const h = fixture(side), headGoal = h.head.goal, waitingGoal = h.waiting.goal;
    let yielded = false, usedBay = false, released = false;
    const timeline: unknown[] = [];
    for (let frame = 0; frame < 30 * 40 && h.actors.some(actor => actor.phase !== 'gone'); frame++) {
      const prior = h.doors.queueStatus('main').head;
      h.tick();
      if (frame % 30 === 0) timeline.push({ seconds: frame / 30, actors: h.actors.map(actor => ({ id: actor.id, at: [...actor.position], beat: actor.door?.beat, kind: actor.door?.kind,
        path: structuredClone(actor.door?.path), yield: structuredClone(actor.door?.queueYield), step: actor.stepIndex, recovery: actor.recovery.attempts })) });
      yielded ||= h.waiting.door?.queueYield?.id === h.head.id;
      usedBay ||= h.waiting.position[0] >= .8 && h.waiting.position[2] * side >= 4;
      const queue = h.doors.queueStatus('main');
      if (prior === h.head.id && queue.head !== h.head.id) { released = true; expect(queue.head).toBe(h.waiting.id); }
      if (!released) expect(queue.head).toBe(h.head.id);
      expect(h.head.goal).toBe(headGoal); expect(h.waiting.goal).toBe(waitingGoal);
    }
    expect(yielded).toBe(true);
    expect(usedBay, JSON.stringify(timeline)).toBe(true);
    expect(released).toBe(true);
    expect(h.actors.map(actor => actor.phase)).toEqual(['gone', 'gone']);
    expect(h.head.position).toEqual(h.at(0, 5.5)); expect(h.waiting.position).toEqual(h.at(0, -5));
    expect(h.doors.queueStatus('main').count).toBe(0); expect(h.doors.amount('main')).toBeLessThan(.01);
    expect(h.actors.map(actor => actor.recovery.attempts)).toEqual([0, 0]);
  });

  it('retains the cached yield while the head still holds its ticket and stops publishing a travel target', () => {
    const h = fixture();
    h.tick(true);
    expect(h.waiting.door?.queueYield?.id).toBe(h.head.id);
    h.setNeighbors(() => [{ id: h.head.id, position: h.head.position, velocity: [0, 0, 0] }]);
    for (let frame = 0; frame < 30; frame++) {
      h.tick(true);
      expect(h.waiting.door?.queueYield?.id).toBe(h.head.id);
      expect(h.doors.queueStatus('main', h.waiting.id)).toMatchObject({ head: h.head.id, ahead: 1, count: 2 });
    }
  });

  it.each(['approaching', 'parallel', 'opposite-face', 'queued-peer'] as const)('does not create circular yields to a %s peer', mode => {
    const h = fixture();
    let position = h.head.position, target = h.at(0, 5.5), id = h.head.id;
    if (mode === 'approaching') target = h.at(0, 0);
    if (mode === 'parallel') target = h.at(1, 1);
    if (mode === 'opposite-face') { position = h.at(0, -1); target = h.at(0, -5.5); }
    if (mode === 'queued-peer') {
      id = 'queued-peer'; position = h.at(0, 1); h.doors.queue('main', h.head.door!.door, id, position, h.side);
    }
    h.setNeighbors(() => [{ id, position, target, velocity: [0, 0, 0] }]);
    h.tick(true);
    expect(h.waiting.door?.queueYield).toBeUndefined();
    expect(h.doors.queueStatus('main', h.waiting.id).head).toBe(h.head.id);
  });

  it.each(['occupied-bay', 'foreign-portal', 'beyond-budget'] as const)('keeps its ticket and body behind a blocked escape: %s', mode => {
    const h = fixture(-1, mode === 'beyond-budget' ? 8.5 : 4.4);
    if (mode === 'foreign-portal') h.portals.push({ id: 'other', door: { ...h.head.door!.door, center: h.at(0, 3) } });
    if (mode === 'occupied-bay') h.setNeighbors(() => [{ id: h.head.id, position: h.head.position, target: h.at(0, 5.5), velocity: [0, 0, 0] },
      { id: 'seated-body', position: h.at(1.2, 4.4), velocity: [0, 0, 0] }]);
    const before = [...h.waiting.position];
    for (let frame = 0; frame < 30; frame++) h.tick(true);
    expect(h.waiting.position).toEqual(before);
    expect(h.doors.queueStatus('main', h.waiting.id)).toMatchObject({ head: h.head.id, ahead: 1, count: 2 });
  });
});
