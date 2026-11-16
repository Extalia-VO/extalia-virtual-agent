import { expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement } from 'react';
import type * as ReactModule from 'react';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import type { Point3 } from '../src/office/scene/layout';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { officeNavigation } from '../src/office/scene/movement/navGraph';
import { createMover, routeFrom, sendMover, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { WalkingClearance } from '../src/office/scene/movement/naturalClearance';
import { StrengthSeat, Treadmill } from '../src/office/scene/interior/prefabs/furniture/GymEquipment';

vi.mock('react', async original => ({ ...await original<typeof ReactModule>(),
  useRef: (value: unknown) => ({ current: value }), useMemo: (factory: () => unknown) => factory() }));
vi.mock('@react-three/fiber', () => ({ useFrame() {} }));
vi.mock('../src/office/scene/Environment', () => ({ useSolarEnvironment: () => ({ reducedMotion: false }) }));
vi.mock('../src/office/scene/interior/InteriorPart', () => ({ InteriorPart: () => null }));
vi.mock('../src/office/scene/interior/prefabs/screens/StaticScreenLight', () => ({ StaticScreenLight: () => null }));

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };
const box = (size: Point3, position: Point3) => { const mesh = new Mesh(new BoxGeometry(...size), new MeshBasicMaterial()); mesh.position.set(...position); return mesh; };

it.each(['fitness.cable-row', 'fitness.weight-bench'])('%s keeps its authored contact outside replaceable models through mounting and full dismount', id => {
  const navigation = officeNavigation(), seat = navigation.seats.get(id)!;
  const tree = StrengthSeat({ resourceId: id, cable: id.endsWith('cable-row') });
  const props = tree.props as { name: string; userData: { officeSeatStation: boolean }; children: unknown[] };
  expect(props.name).toBe(id); expect(props.userData.officeSeatStation).toBe(true);
  // Only a direct child survives a model replacing its entire InteriorPart subtree.
  const marker = props.children.find(child => isValidElement(child)
    && (child.props as { userData?: { officeEquipmentSeat?: boolean } }).userData?.officeEquipmentSeat) as ReactElement<{ position: Point3; userData: object }> | undefined;
  expect(marker).toBeDefined(); expect(marker!.type).toBe('group');
  const root = new Group(), station = new Group(), anchor = new Group(), field = new WalkingClearance();
  station.name = props.name; station.userData = props.userData; station.position.set(...seat.seat);
  anchor.position.set(...marker!.props.position); anchor.userData = marker!.props.userData;
  station.add(anchor, box([.95, .7, 1.05], [0, .5, 0]));
  root.add(station, box([80, .1, 80], [0, seat.seat[1] - .05, 0])); field.rebuild([root]);
  expect(field.segmentClear(seat.seat, seat.staging)).toBe(false);
  expect(field.seatEntryClear(seat, seat.staging, seat.seat)).toBe(true);
  expect(field.seatExitClear(seat, seat.seat, seat.staging)).toBe(true);
  const foreign = box([.1, .8, .1], [seat.seat[0] + .7, seat.seat[1] + .5, seat.seat[2] + .25]); root.add(foreign); field.rebuild([root]);
  expect(field.seatExitClear(seat, seat.seat, seat.staging)).toBe(false);
  expect(field.seatEntryClear(seat, seat.staging, seat.seat)).toBe(false);
  root.remove(foreign); field.rebuild([root]);
  const env: MovementEnv = { navigation, elevators, walkable: field.segmentClear, seatEntryClear: field.seatEntryClear,
    seatExitClear: field.seatExitClear, nearbyWalkers: () => [] };
  const start: Point3 = [seat.staging[0] + .7, seat.staging[1], seat.staging[2]];
  const mover = createMover('strength-contact', gaitParameters(), start, seat.rotationY, false);
  expect(routeFrom(mover, `seat:${id}:stage`, { kind: 'seat', seat }, env, true)).toBe(true);
  let reachedExitStage = false;
  for (let frame = 0; frame < 30 * 20 && mover.phase !== 'seated'; frame++) {
    const before: Point3 = [...mover.position]; stepMover(mover, 1 / 30, env);
    expect(Math.hypot(...mover.position.map((value, axis) => value - before[axis]!) as Point3)).toBeLessThan(.08);
  }
  expect(mover.phase).toBe('seated'); expect(mover.position).toEqual(seat.seat);
  expect(sendMover(mover, { kind: 'leave', node: 'f3.fitness-center' }, env)).toBe(true);
  for (let frame = 0; frame < 30 * 40 && mover.phase !== 'gone'; frame++) {
    const before: Point3 = [...mover.position], ownedExit = mover.seatExit;
    stepMover(mover, 1 / 30, env);
    expect(Math.hypot(...mover.position.map((value, axis) => value - before[axis]!) as Point3)).toBeLessThan(.08);
    if (ownedExit && mover.seatExit) expect(field.seatExitClear(ownedExit, before, mover.position)).toBe(true);
    else if (ownedExit) {
      // One frame may finish contact and spend its remaining budget on the next leg.
      expect(field.seatExitClear(ownedExit, before, seat.staging)).toBe(true);
      expect(field.segmentClear(seat.staging, mover.position)).toBe(true);
      reachedExitStage = true;
    }
  }
  expect(reachedExitStage).toBe(true); expect(mover.phase).toBe('gone');
});

it('routes every authored fitness graph edge around the actual cable-tower posts', () => {
  const navigation = officeNavigation(), seat = navigation.seats.get('fitness.cable-row')!;
  const elements = (value: unknown): ReactElement<Record<string, unknown>>[] => {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!isValidElement(value)) return [];
    const element = value as ReactElement<Record<string, unknown>>;
    return [element, ...elements(element.props.children)];
  };
  const tree = StrengthSeat({ resourceId: seat.seatId, cable: true });
  const tower = elements(tree).find(element => element.props.model === 'cable-tower')!;
  expect(tower).toBeDefined();
  const root = new Group(), field = new WalkingClearance();
  root.add(box([80, .1, 80], [0, seat.seat[1] - .05, 0]));
  let posts = 0;
  for (const mesh of elements(tower.props.children).filter(element => element.type === 'mesh')) {
    const geometry = elements(mesh.props.children).find(element => element.type === 'boxGeometry')!;
    const position = mesh.props.position as Point3, size = geometry.props.args as Point3;
    root.add(box(size, [seat.seat[0] + position[0], seat.seat[1] + position[1], seat.seat[2] + position[2]]));
    posts++;
  }
  expect(posts).toBe(3); field.rebuild([root]);
  // The original diagonal really intersected a rendered post at a full body radius.
  expect(field.segmentClear([15, 12.8, 9], [19.2, 12.8, 9.4], .29)).toBe(false);
  const invalid: string[] = [];
  for (const [from, edges] of navigation.graph.edges) for (const edge of edges) {
    const fitness = (id: string) => id.startsWith('f3.fitness-') || id.startsWith('seat:fitness.');
    if (!fitness(from) || !fitness(edge.to)) continue;
    const a = navigation.waypoints.get(from)!, b = navigation.waypoints.get(edge.to)!;
    if (!field.segmentClear(a.position, b.position, .29)) invalid.push(`${from} -> ${edge.to}`);
  }
  expect(invalid).toEqual([]);
});


it.each(['fitness.treadmill-1', 'fitness.treadmill-2'])('%s retains solid rails/console with a genuinely walkable rear entry and departure', id => {
  const navigation = officeNavigation(), seat = navigation.seats.get(id)!;
  const tree = Treadmill({ resourceId: id });
  const direct = (tree.props as { children: unknown[] }).children;
  const proxy = direct.find(child => isValidElement(child)
    && (child.props as { userData?: { officeCollisionFootprint?: unknown } }).userData?.officeCollisionFootprint) as ReactElement<{ userData: object }>;
  expect(proxy).toBeDefined();
  const root = new Group(), station = new Group(), frame = new Group(), field = new WalkingClearance();
  station.name = id; station.userData.officeSeatStation = true;
  station.position.set(seat.seat[0], seat.seat[1], seat.seat[2] - .35);
  frame.userData = proxy.props.userData;
  // Authored GLB frame materials merge the low deck with tall rails into this
  // coarse box; only the frame's explicit U footprint replaces that false solid.
  frame.add(box([1.4, 1.136, 1.95], [0, .653, 0])); station.add(frame);
  root.add(station, box([80, .1, 80], [0, seat.seat[1] - .05, 0])); field.rebuild([root]);
  const rear: Point3 = [seat.seat[0], seat.seat[1], seat.seat[2] + 1.2];
  expect(field.segmentClear(seat.seat, seat.seat, .29)).toBe(true);
  expect(field.segmentClear(rear, seat.seat, .29)).toBe(true);
  expect(field.segmentClear(seat.seat, [seat.seat[0] + 1, seat.seat[1], seat.seat[2]], .29)).toBe(false);
  expect(field.segmentClear(seat.seat, [seat.seat[0], seat.seat[1], seat.seat[2] - 1.5], .29)).toBe(false);
  const aisle = navigation.waypoints.get(`seat:${id}:aisle`)!;
  expect(aisle.position[2]).toBeGreaterThan(seat.seat[2]);
  expect(field.segmentClear(aisle.position, seat.staging, .29)).toBe(true);
  expect(seat.staging).toEqual(seat.seat); // No unchecked nonzero contact transition.
  const foreign = box([.1, .8, .1], [seat.seat[0] + .2, seat.seat[1] + .5, seat.seat[2] + .6]); root.add(foreign); field.rebuild([root]);
  expect(field.segmentClear(rear, seat.seat, .29)).toBe(false);
  root.remove(foreign); field.rebuild([root]);
  const env: MovementEnv = { navigation, elevators, walkable: field.segmentClear, nearbyWalkers: () => [] };
  const mover = createMover('treadmill-contact', gaitParameters(), [...aisle.position], seat.rotationY, false);
  expect(routeFrom(mover, aisle.id, { kind: 'seat', seat }, env, false)).toBe(true);
  for (let frameIndex = 0; frameIndex < 30 * 20 && mover.phase !== 'seated'; frameIndex++) {
    const before: Point3 = [...mover.position]; stepMover(mover, 1 / 30, env);
    expect(field.segmentClear(before, mover.position)).toBe(true);
    expect(Math.hypot(...mover.position.map((value, axis) => value - before[axis]!) as Point3)).toBeLessThan(.08);
  }
  expect(mover.phase).toBe('seated'); expect(mover.position).toEqual(seat.seat);
  expect(sendMover(mover, { kind: 'leave', node: 'f3.fitness-center' }, env)).toBe(true);
  for (let frameIndex = 0; frameIndex < 30 * 40 && mover.phase !== 'gone'; frameIndex++) {
    const before: Point3 = [...mover.position]; stepMover(mover, 1 / 30, env);
    expect(field.segmentClear(before, mover.position)).toBe(true);
    expect(Math.hypot(...mover.position.map((value, axis) => value - before[axis]!) as Point3)).toBeLessThan(.08);
  }
  expect(mover.phase).toBe('gone');
});
