import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, type BufferGeometry, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import type { OfficeAgent } from '../src/office/presence';
import { F1_LAYOUT } from '../src/office/scene/interior/floor1Layout';
import { PLANTER_BOUNDS } from '../src/office/scene/interior/planterLayout';
import { ArmChair, Sofa } from '../src/office/scene/interior/prefabs/furniture/Sofa';
import { ProceduralOfficeChairMeshes } from '../src/office/scene/interior/prefabs/furniture/OfficeChair';
import { OFFICE_RESOURCES } from '../src/office/scene/interior/resourceRegistry';
import { relocateRoomPoint } from '../src/office/scene/interior/roomRelocation';
import { allocateOfficeAgents, getOfficeSeats } from '../src/office/scene/interior/seating';
import { SINGLE_WORKSTATION_BLUEPRINT, TEAM_POD_LAYOUT, TEAM_POD_SEAT, TEAM_POD_STATIONS, TEAM_WORKSPACE_DECOR, TEAM_WORKSPACE_LOUNGES, TEAM_WORKSPACE_ORIGIN, TEAM_WORKSPACE_TOUCHDOWNS } from '../src/office/scene/interior/spatialBlueprints';
import { TEAM_POD_DESKTOP, TEAM_POD_STRUCTURE_FOOTPRINT } from '../src/office/scene/interior/teamPodDesktopGeometry';
import type { Point3 } from '../src/office/scene/layout';
import { officeNavigation, planRoute, seatApproach, seatStageId } from '../src/office/scene/movement/navGraph';
import { WalkingClearance } from '../src/office/scene/movement/naturalClearance';
import { staticSeatRoute } from '../src/office/scene/movement/staticSeating';
import { isDeskChair } from '../src/office/scene/interior/deskChairs';
import { resourceIdForLocation, screenForLocation } from '../src/office/scene/interior/screenData';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { createMover, routeFrom, sendMover, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';

const navigation = officeNavigation();
const podIds = ['pod-a', 'pod-b', 'pod-c', 'pod-d', 'pod-e', 'pod-f'];
const expectedIds = podIds.flatMap(pod => ['seat-se', 'seat-sw', 'seat-nw', 'seat-ne'].map(seat => `engineering.${pod}.${seat}`));
const origin = relocateRoomPoint('engineering', [TEAM_WORKSPACE_ORIGIN[0], 0, TEAM_WORKSPACE_ORIGIN[1]]);
const point = (x: number, z: number): Point3 => [origin[0] + x, 0, origin[2] + z];

/** Build the pure procedural chair/upholstery meshes with their authored transforms. */
function addMeshes(parent: Object3D, node: ReactNode): void {
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    const { type, props } = child as ReactElement<Record<string, unknown>>;
    if (typeof type === 'string' && (type.endsWith('Geometry') || type.endsWith('Material'))) continue;
    let object: Object3D;
    if (type === 'mesh') {
      let geometry = props.geometry as BufferGeometry | undefined;
      for (const nested of Children.toArray(props.children as ReactNode)) {
        if (!isValidElement(nested)) continue;
        const element = nested as ReactElement<{ args: number[] }>;
        if (element.type === 'boxGeometry') geometry = new BoxGeometry(...element.props.args as [number, number, number]);
        if (element.type === 'cylinderGeometry') geometry = new CylinderGeometry(...element.props.args as [number, number, number, number]);
      }
      if (!geometry) throw new Error('Missing fixture mesh geometry');
      object = new Mesh(geometry, new MeshBasicMaterial());
    } else object = new Group();
    if (props.position) object.position.fromArray(props.position as number[]);
    if (props.rotation) object.rotation.set(...props.rotation as [number, number, number]);
    if (props.userData) object.userData = props.userData as Record<string, unknown>;
    parent.add(object);
    addMeshes(object, props.children as ReactNode);
  }
}

function furnishedClearance(instancedDeskChairs = false): WalkingClearance {
  const root = new Group(), room = new Group();
  room.position.fromArray(origin); root.add(room);
  const box = (parent: Object3D, position: readonly [number, number, number], size: readonly [number, number, number], yaw = 0) => {
    const mesh = new Mesh(new BoxGeometry(...size), new MeshBasicMaterial());
    mesh.position.fromArray(position); mesh.rotation.y = yaw; parent.add(mesh);
  };
  for (const pod of TEAM_POD_LAYOUT) {
    const group = new Group(); group.position.set(pod.position[0], 0, pod.position[1]); group.rotation.y = pod.rotationY; room.add(group);
    const structure = new Group(); structure.userData.officeCollisionFootprint = TEAM_POD_STRUCTURE_FOOTPRINT; group.add(structure);
    box(structure, [0, TEAM_POD_DESKTOP.top - TEAM_POD_DESKTOP.thickness / 2, 0],
      [2 * TEAM_POD_DESKTOP.halfExtent, TEAM_POD_DESKTOP.thickness, 2 * TEAM_POD_DESKTOP.halfExtent]);
    for (const station of TEAM_POD_STATIONS) {
      const quadrant = new Group(), chair = new Group(); quadrant.rotation.y = station.rotationY;
      chair.position.set(TEAM_POD_SEAT.chairPosition[0], 0, TEAM_POD_SEAT.chairPosition[1]); chair.rotation.y = TEAM_POD_SEAT.chairRotationY;
      if (instancedDeskChairs && isDeskChair(resourceIdForLocation(`floor-1.team-workspace.${pod.id}.${station.id}`))) chair.userData.officeCollision = false;
      group.add(quadrant); quadrant.add(chair); addMeshes(chair, ProceduralOfficeChairMeshes({}));
    }
  }
  for (const desk of TEAM_WORKSPACE_TOUCHDOWNS) {
    const group = new Group(); group.position.set(desk.position[0], 0, desk.position[1]); group.rotation.y = desk.rotationY; room.add(group);
    box(group, [0, SINGLE_WORKSTATION_BLUEPRINT.topY, 0], SINGLE_WORKSTATION_BLUEPRINT.topSize);
    const chair = new Group(); chair.position.fromArray(SINGLE_WORKSTATION_BLUEPRINT.chairPosition); chair.rotation.y = SINGLE_WORKSTATION_BLUEPRINT.chairRotationY;
    group.add(chair); addMeshes(chair, ProceduralOfficeChairMeshes({}));
  }
  const lounges = TEAM_WORKSPACE_LOUNGES;
  addMeshes(room, Sofa({ position: [...lounges.westSofa.position], rotationY: lounges.westSofa.rotationY }));
  for (const chair of [lounges.westChair, ...lounges.eastChairs]) addMeshes(room, ArmChair({ position: [...chair.position], rotationY: chair.rotationY }));
  for (const coffee of [TEAM_WORKSPACE_DECOR.westCoffee, TEAM_WORKSPACE_DECOR.eastCoffee]) box(room, [coffee[0], .38, coffee[2]], [1.25, .07, .7], Math.PI / 2);
  for (const plant of TEAM_WORKSPACE_DECOR.plants) {
    const width = PLANTER_BOUNDS.floor.width * 1.04;
    box(room, [plant[0], .5, plant[2]], [width, 1, width]);
  }
  // Wall equipment remains outside the perimeter walking lanes.
  box(room, [8.7, .6, -9.35], [1.5, 1.2, .8]);
  box(room, [15.74, .7, -3.9], [.5, 1.4, 2.2]);
  box(room, [15.78, 1.07, 4.5], [.5, 2.15, 2.2]);
  const field = new WalkingClearance(); field.rebuild([root]); return field;
}

describe('six-pod team workspace navigation', () => {
  it('completes real furnished movement into every pod seat', () => {
    const field = furnishedClearance(true);
    const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
      confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };
    const env: MovementEnv = { navigation, elevators, walkable: field.segmentClear, nearbyWalkers: () => [] };
    for (const id of expectedIds) {
      const start = 'f1.engineering-north-inside';
      const mover = createMover(`arrival-${id}`, gaitParameters(), [...navigation.waypoints.get(start)!.position], 0, false);
      expect(routeFrom(mover, start, { kind: 'seat', seat: navigation.seats.get(id)! }, env, false)).toBe(true);
      for (let frame = 0; frame < 30 * 120 && mover.phase !== 'seated'; frame++) stepMover(mover, 1 / 30, env);
      expect(mover.phase, JSON.stringify({ id, position: mover.position, target: mover.steps[mover.stepIndex], recovery: mover.recovery })).toBe('seated');
      const destination = navigation.seats.get(expectedIds[(expectedIds.indexOf(id) + 4) % expectedIds.length]!)!;
      expect(sendMover(mover, { kind: 'seat', seat: destination }, env)).toBe(true);
      for (let frame = 0; frame < 30 * 120 && (mover.phase !== 'seated' || mover.seat?.seatId !== destination.seatId); frame++) stepMover(mover, 1 / 30, env);
      expect({ phase: mover.phase, seat: mover.seat?.seatId }, JSON.stringify({ id, position: mover.position, target: mover.steps[mover.stepIndex], recovery: mover.recovery })).toEqual({ phase: 'seated', seat: destination.seatId });
      expect(mover.recovery.attempts, id).toBe(0);
    }
  });
  it('offers 24 distinct real pod seats and preserves every existing pod seat identity', () => {
    const seats = getOfficeSeats(), pods = seats.filter(seat => seat.id.startsWith('engineering.pod-'));
    expect(pods.map(seat => seat.id).sort()).toEqual([...expectedIds].sort());
    expect(new Set(pods.map(seat => seat.position.join(','))).size).toBe(24);
    for (const seat of pods) expect(OFFICE_RESOURCES.find(resource => resource.id === seat.id)?.kind).toBe('workstation');
    const agents: OfficeAgent[] = seats.map((_, i) => ({ id: `session:worker-${i}`, sessionId: 'session', agentId: `worker-${i}`, parentId: 'primary', displayName: 'Engineer', control: 'managed', status: 'working', running: true }));
    const previous = pods.slice(0, 16).map((seat, i) => ({ ...seat, agentId: agents[i]!.id, resourceId: seat.id }));
    const allocations = allocateOfficeAgents(agents, previous);
    expect(allocations).toHaveLength(seats.length);
    expect(new Set(allocations.map(allocation => allocation.resourceId)).size).toBe(seats.length);
    expect(allocations.filter(allocation => allocation.resourceId.startsWith('engineering.pod-'))).toHaveLength(24);
    for (const seat of previous) expect(allocations.find(allocation => allocation.agentId === seat.agentId)?.resourceId).toBe(seat.resourceId);
    for (const pod of TEAM_POD_LAYOUT) for (const station of TEAM_POD_STATIONS) {
      const id = `engineering.${pod.id}.${station.id}`;
      const data = screenForLocation({ agents, allocations, language: 'en' }, `floor-1.team-workspace.${pod.id}.${station.id}`);
      expect(data.resourceId).toBe(id);
      expect(data.sessionBacked).toBe(true);
      expect(isDeskChair(data.resourceId)).toBe(true);
    }
    expect(resourceIdForLocation('floor-1.team-workspace.pod-unknown.seat-se')).toBeUndefined();
  });

  it('keeps the cross aisle and between-column doglegs clear of furnished solid bounds', () => {
    const field = furnishedClearance();
    expect(field.segmentClear(point(-10.6, 0), point(15.2, 0), .29)).toBe(true);
    for (const x of [-4, 4]) expect(field.segmentClear(point(x, -7.15), point(x, 7.25), .29)).toBe(true);
    // A route through the old centre column is now physically obstructed by pods E and F.
    expect(field.segmentClear(point(0, -7.15), point(0, 0), .29)).toBe(false);
    expect(field.segmentClear(point(0, 0), point(0, 7.25), .29)).toBe(false);
    for (const edge of navigation.aisles.get('engineering')!) {
      const a = navigation.waypoints.get(edge.from)!.position, b = navigation.waypoints.get(edge.to)!.position;
      expect(field.segmentClear(a, b, .29), `${edge.from} → ${edge.to}`).toBe(true);
    }
  });

  it('reaches every pod and touchdown desk from the lobby and inter-floor entries using clear in-room stage joins', () => {
    const field = furnishedClearance(), room = F1_LAYOUT.engineering;
    for (const id of [...expectedIds, ...TEAM_WORKSPACE_TOUCHDOWNS.map(desk => desk.id)]) for (const from of [navigation.entryId, 'f2.stairs-south', 'f3.elevator-A', 'f3.elevator-B']) {
      const seat = navigation.seats.get(id)!;
      expect(field.segmentClear(seat.staging, seat.staging, .29), id).toBe(true);
      const route = planRoute(from, seatStageId(id))!;
      expect(route, `${from} → ${id}`).not.toBeNull();
      const entered = route.nodeIds.findIndex(node => /^f1\.engineering-(north|east|south)-inside$/.test(node));
      expect(entered).toBeGreaterThanOrEqual(0);
      const nodes = route.nodeIds.slice(entered);
      for (const node of nodes) {
        const p = navigation.waypoints.get(node)!.position;
        expect(p[0] - .29, node).toBeGreaterThan(room.west);
        expect(p[0] + .29, node).toBeLessThan(room.east);
        expect(p[2] - .29, node).toBeGreaterThan(room.north);
        expect(p[2] + .29, node).toBeLessThan(room.south);
      }
      for (let i = 1; i < nodes.length; i++) {
        const a = navigation.waypoints.get(nodes[i - 1]!)!.position, b = navigation.waypoints.get(nodes[i]!)!.position;
        expect(field.segmentClear(a, b, .29), `${id}: ${nodes[i - 1]} → ${nodes[i]}`).toBe(true);
      }
      expect(planRoute(seatStageId(id), from), `${id} → ${from}`).not.toBeNull();
    }
  });

  it('keeps all relocated upholstered stages clear inside the walls and reaches their open front lanes', () => {
    const field = furnishedClearance(), room = F1_LAYOUT.engineering;
    const seats = OFFICE_RESOURCES.filter(resource => resource.roomId === 'engineering' && ['sofa', 'armchair'].includes(resource.interaction.seatStyle)).map(seatApproach);
    expect(seats.map(seat => seat.seatId).sort()).toEqual(['engineering.armchair', 'engineering.lounge-1', 'engineering.lounge-2', 'engineering.sofa-1', 'engineering.sofa-2']);
    // West furniture is semantic seating without a leisure graph stop; include
    // every sofa slot so front-lane planning accounts for its neighboring cushion.
    const furnishedNavigation = { ...navigation, seats: new Map([...navigation.seats, ...seats.map(seat => [seat.seatId, seat] as const)]) };
    for (const seat of seats) {
      const id = seat.seatId;
      expect(seat.staging[0] - .29).toBeGreaterThan(room.west);
      expect(seat.staging[0] + .29).toBeLessThan(room.east);
      expect(seat.staging[2] - .29).toBeGreaterThan(room.north);
      expect(seat.staging[2] + .29).toBeLessThan(room.south);
      expect(field.segmentClear(seat.staging, seat.staging, .29), id).toBe(true);
      const attach = navigation.waypoints.get(`seat:${id}:aisle`)?.position;
      if (attach) expect(field.segmentClear(attach, seat.staging, .29), id).toBe(true);
      const route = staticSeatRoute('visitor', seat, seat.staging, furnishedNavigation, field.segmentClear, [], (a, b, radius) => field.seatContactClear(seat, a, b, radius));
      expect(route, id).not.toBeNull();
      let previous = seat.staging;
      for (const next of route!.path) { expect(field.segmentClear(previous, next, .29), id).toBe(true); previous = next; }
      expect(field.seatContactClear(seat, route!.apron, route!.contact, .29), id).toBe(true);
      expect(field.seatContactClear(seat, route!.contact, seat.seat, .29), id).toBe(true);
    }
  });
});
