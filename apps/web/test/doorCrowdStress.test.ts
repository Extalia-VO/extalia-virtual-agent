import { describe, expect, it } from 'vitest';
import type { NavEdge, Waypoint } from '@extalia/office';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { DoorTraffic, doorAxes, type DoorInfo, type WalkerInfo } from '../src/office/scene/interior/doorTraffic';
import type { Point3 } from '../src/office/scene/layout';
import { createMover, setPace, stepMover, type ElevatorAccess, type Mover, type MovementEnv } from '../src/office/scene/movement/mover';
import type { OfficeNavigation } from '../src/office/scene/movement/navGraph';
import type { WalkableSegment } from '../src/office/scene/movement/naturalWalking';

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };
const DT = 1 / 30;
interface Actor { mover: Mover; side: 1 | -1; goal: Point3; goalNode: string; admission: number; active: boolean }
interface Scenario { count: 10 | 20; width: number; roomWidth: number; meeting: boolean }

function crowd(scenario: Scenario) {
  let now = 0;
  const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: scenario.width, height: 2.55, openAngle: Math.PI / 2, sliding: false };
  const tracked = new Map<string, WalkerInfo>();
  const doors = new DoorTraffic({ forEachDoor: visit => visit('crowd-door', door), forEachWalker: visit => tracked.forEach(visit) }, () => now);
  const actors: Actor[] = [];
  const waypoints = new Map<string, Waypoint>(), graphEdges = new Map<string, NavEdge[]>();
  const add = (id: string, position: Point3) => {
    waypoints.set(id, { id, floorId: 'floor-1', kind: Math.abs(position[2]) < .9 ? 'door' : 'corridor', position });
    graphEdges.set(id, []);
  };
  const connect = (a: string, b: string) => {
    const p = waypoints.get(a)!.position, q = waypoints.get(b)!.position;
    const cost = Math.hypot(p[0] - q[0], p[2] - q[2]);
    graphEdges.get(a)!.push({ to: b, cost }); graphEdges.get(b)!.push({ to: a, cost });
  };
  for (let i = 0; i < scenario.count; i++) {
    const late = scenario.meeting && i >= scenario.count - 4;
    const side: 1 | -1 = scenario.meeting ? late ? -1 : 1 : i % 2 ? -1 : 1;
    const column = i % 2 ? -1 : 1;
    const start: Point3 = scenario.meeting
      ? late ? [0, 0, -1.5 - (i - scenario.count + 4) * .8] : [column * 1.75, 0, 4 + Math.floor(i / 2) * .8]
      : [0, 0, side * (1.5 + Math.floor(i / 2) * .8)];
    const goal: Point3 = late ? [column * 1.75, 0, 12.3] : [0, 0, -side * 12];
    const id = `crowd-${i.toString().padStart(2, '0')}`;
    const points: Point3[] = scenario.meeting
      ? late ? [[0, 0, -.8], [0, 0, 0], [0, 0, .8], [column * 1.75, 0, 2.3], goal]
        : [[column * 1.75, 0, 2.3], [0, 0, .8], [0, 0, 0], [0, 0, -.8], goal]
      : [[0, 0, side * .8], [0, 0, 0], [0, 0, -side * .8], goal];
    const mover = createMover(id, gaitParameters(), start, 0, false);
    setPace(mover, [.8, 1, 1.2][i % 3]!);
    add(`${id}-start`, start);
    let previous = `${id}-start`;
    mover.steps = points.map((to, j) => {
      const node = `${id}-step-${j}`;
      add(node, to); connect(previous, node); previous = node;
      return { kind: 'walk', node, to, stairs: false };
    });
    mover.lastNode = `${id}-start`;
    mover.goal = { kind: 'leave', node: previous };
    actors.push({ mover, side, goal, goalNode: previous, admission: late ? 12 + (i - scenario.count + 4) * 2.5 : 0, active: !late });
  }
  const navigation: OfficeNavigation = { graph: { nodes: new Map([...waypoints].map(([id, node]) => [id, { id, floorId: node.floorId, pos: { x: node.position[0], y: node.position[2] } }])), edges: graphEdges },
    waypoints, edges: [], seats: new Map(), connectors: [], aisles: new Map(), elevatorEdges: new Map(), entryId: actors[0]!.mover.lastNode! };
  const walkable: WalkableSegment = (from, to, radius = .29) => {
    const samples = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[2] - from[2]) / .05));
    for (let i = 0; i <= samples; i++) {
      const t = i / samples, x = from[0] + (to[0] - from[0]) * t, z = from[2] + (to[2] - from[2]) * t;
      if (Math.abs(x) > scenario.roomWidth / 2 - radius || Math.abs(z) > 14 - radius) return false;
      if (Math.abs(z) < radius + .08 && Math.abs(x) > door.clearWidth / 2 - radius) return false;
      if (scenario.meeting && Math.abs(x) < .75 + radius && z > 3.5 - radius && z < 11.5 + radius) return false;
    }
    return true;
  };
  const present = () => actors.filter(actor => actor.active && actor.mover.phase !== 'gone');
  const env: MovementEnv = { navigation, elevators, doors, walkable,
    nearbyWalkers: id => present().filter(actor => actor.mover.id !== id).map(({ mover }) => {
      const step = mover.steps[mover.stepIndex], target = mover.phase === 'walking' ? mover.target ?? (step?.kind === 'walk' ? step.to : null) : null;
      return { id: mover.id, position: [...mover.position], velocity: [0, 0, 0], ...(target ? { target: [...target] as Point3 } : {}) };
    }),
    trackWalker(id, position, target) { if (position && target) tracked.set(id, { id, position: [...position], target: [...target], updatedAt: now }); else tracked.delete(id); },
  };
  for (const actor of present()) tracked.set(actor.mover.id, { id: actor.mover.id, position: [...actor.mover.position], target: actor.mover.steps[0]!.kind === 'walk' ? actor.mover.steps[0]!.to : [0, 0, 0], updatedAt: now });
  const diagnostics = () => present().map(({ mover }) => ({ id: mover.id, phase: mover.phase, position: mover.position, next: mover.steps[mover.stepIndex], recovery: mover.recovery.attempts,
    door: mover.door && { kind: mover.door.kind, beat: mover.door.beat, queue: doors.queueStatus('crowd-door', mover.id) }, monitor: mover.monitor.reason }));
  return { actors, doors, door, env, walkable, present, diagnostics, time: () => now / 1000, advance() { now += DT * 1000; } };
}

function runScenario(scenario: Scenario) {
  const h = crowd(scenario), crossed = new Set<string>();
  let maximumStep = 0, minimumSeparation = Infinity, violation: string | null = null;
  for (const actor of h.present()) expect(h.walkable(actor.mover.position, actor.mover.position)).toBe(true);
  for (let frame = 0; frame < 30 * 480 && h.actors.some(actor => actor.mover.phase !== 'gone'); frame++) {
    for (const actor of h.actors) if (!actor.active && h.time() >= actor.admission) {
      const clear = h.present().every(other => Math.hypot(other.mover.position[0] - actor.mover.position[0], other.mover.position[2] - actor.mover.position[2]) >= .7);
      if (clear) { actor.active = true; expect(h.walkable(actor.mover.position, actor.mover.position)).toBe(true); }
    }
    for (const { mover, side, goal } of h.present()) {
      const before: Point3 = [...mover.position];
      stepMover(mover, DT, h.env);
      const moved = Math.hypot(...mover.position.map((value, axis) => value - before[axis]!) as Point3);
      maximumStep = Math.max(maximumStep, moved);
      if (!h.walkable(before, mover.position)) violation = `Static sweep ${mover.id}`;
      if (moved >= .08) violation = `Unbounded step ${mover.id}: ${moved}`;
      const atGoal = Math.hypot(...mover.position.map((value, axis) => value - goal[axis]!) as Point3) < .002;
      if (mover.opacity < 1 && !(atGoal && (mover.phase === 'vanishing' || mover.phase === 'gone'))) violation = `Recovery fade ${mover.id}`;
      if (!crossed.has(mover.id) && doorAxes(h.door, mover.position).through * side < -.1) {
        const queue = h.doors.queueStatus('crowd-door', mover.id);
        if (queue.head !== mover.id || queue.ahead !== 0) violation = `FIFO overtake ${mover.id}: ${JSON.stringify(queue)}`;
        crossed.add(mover.id);
      }
    }
    const present = h.present();
    for (let i = 0; i < present.length; i++) for (let j = i + 1; j < present.length; j++) {
      const a = present[i]!.mover, b = present[j]!.mover;
      minimumSeparation = Math.min(minimumSeparation, Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]));
    }
    if (minimumSeparation <= .54) violation = `Body overlap ${minimumSeparation}`;
    const inPassage = present.filter(({ mover }) => {
      const point = doorAxes(h.door, mover.position);
      return Math.abs(point.through) < .55 && Math.abs(point.across) < h.door.clearWidth / 2 - .29;
    });
    if (inPassage.length > 1) violation = `Shared doorway passage: ${inPassage.map(actor => actor.mover.id).join(', ')}`;
    if (violation) break;
    h.advance();
  }
  const evidence = JSON.stringify({ scenario, seconds: h.time(), maximumStep, minimumSeparation, violation, crossed: [...crossed], actors: h.diagnostics() });
  expect(violation, evidence).toBeNull();
  expect(h.actors.map(actor => actor.mover.phase), evidence).toEqual(h.actors.map(() => 'gone'));
  expect(crossed.size, evidence).toBe(scenario.count);
  for (const actor of h.actors) {
    expect(actor.active, evidence).toBe(true);
    expect(Math.hypot(...actor.mover.position.map((value, axis) => value - actor.goal[axis]!) as Point3), evidence).toBeLessThan(.002);
    expect(actor.mover.goal?.kind === 'leave' && actor.mover.goal.node, evidence).toBe(actor.goalNode);
  }
  expect(h.doors.amount('crowd-door'), evidence).toBeLessThan(.01);
}

describe('ten to twenty actor doorway stress', () => {
  it('drains ten mixed-speed opposing walkers through a narrow room doorway', () => runScenario({ count: 10, width: 1.2, roomWidth: 3, meeting: false }));
  it('drains twenty mixed-speed opposing walkers without cutting the queue', () => runScenario({ count: 20, width: 1.6, roomWidth: 4.4, meeting: false }));
  it('drains a ten-person meeting outflow with returning late arrivals around the table', () => runScenario({ count: 10, width: 1.2, roomWidth: 7, meeting: true }));
  it('drains a twenty-person meeting outflow with returning late arrivals around the table', () => runScenario({ count: 20, width: 1.6, roomWidth: 7, meeting: true }));
});
