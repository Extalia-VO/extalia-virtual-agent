import { describe, expect, it } from 'vitest';
import { isValidElement, type ReactElement } from 'react';
import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, Vector3, type Object3D } from 'three';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { isDeskChair } from '../src/office/scene/interior/deskChairs';
import { deskInputPlacement, deskLayout, KEYBOARD_DIMENSIONS, MOUSE_PAD, RECEPTION_DESK_TOP, RECEPTION_KEYBOARD_BASE, rotateXZ } from '../src/office/scene/interior/deskLayout';
import { ProceduralOfficeChairMeshes } from '../src/office/scene/interior/prefabs/furniture/OfficeChair';
import { relocateRoomPoint } from '../src/office/scene/interior/roomRelocation';
import { RECEPTION_DESK_BLUEPRINT } from '../src/office/scene/interior/spatialBlueprints';
import type { Point3 } from '../src/office/scene/layout';
import { createMover, placeSeated, sendMover, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { WalkingClearance } from '../src/office/scene/movement/naturalClearance';
import { officeNavigation } from '../src/office/scene/movement/navGraph';

const navigation = officeNavigation(), seat = navigation.seats.get('lobby.receptionist')!;
const material = new MeshBasicMaterial();
const box = (size: Readonly<Point3>, position: Readonly<Point3>) => {
  const mesh = new Mesh(new BoxGeometry(...size), material); mesh.position.set(...position); return mesh;
};

/** Read the actual procedural chair mesh tree, retaining every authored transform. */
function chairMeshes(value: unknown, parent: Object3D): void {
  if (Array.isArray(value)) { value.forEach(child => chairMeshes(child, parent)); return; }
  if (!isValidElement(value)) return;
  const element = value as ReactElement<Record<string, unknown>>, props = element.props;
  if (element.type === 'boxGeometry' || element.type === 'cylinderGeometry') {
    expect(parent).toBeInstanceOf(Mesh);
    (parent as Mesh).geometry = element.type === 'boxGeometry'
      ? new BoxGeometry(...props.args as [number, number, number])
      : new CylinderGeometry(...props.args as [number, number, number, number]);
    return;
  }
  if (element.type === 'meshStandardMaterial') return;
  const node = element.type === 'mesh' ? new Mesh(undefined, material) : new Group();
  if (props.position) node.position.set(...props.position as Point3);
  if (props.rotation) node.rotation.set(...props.rotation as Point3);
  parent.add(node); chairMeshes(props.children, node);
}

function fixture() {
  const root = new Group(), reception = new Group(), station = new Group(), chair = new Group(), field = new WalkingClearance();
  const b = RECEPTION_DESK_BLUEPRINT;
  reception.position.set(...relocateRoomPoint('lobby', [b.worldPosition[0], 0, b.worldPosition[1]]));
  reception.rotation.y = b.rotationY;
  station.position.x = b.staffOffsetX; station.userData.officeSeatStation = true;
  chair.position.z = b.chairOffsetZ; chair.rotation.y = Math.PI; chair.userData.officeSeat = true;
  chairMeshes(ProceduralOfficeChairMeshes({}), chair); station.add(chair);
  // The rendered ReceptionDesk backdrop and solid transaction tiers bound the side aisle.
  reception.add(box([5.2, 2.7, .08], [0, 1.45, b.featureWallOffsetZ]));
  const counter = new Group(); counter.position.z = b.counterOffsetZ;
  counter.add(box([1.75, .68, .8], [-1.05, .42, -.02]), box([1.8, .05, .85], [-1.05, .76, 0]),
    box([2.15, .92, .8], [.9, .54, -.02]), box([2.2, .06, .62], [.9, 1.02, -.1]),
    box(b.workShelfSize, b.workShelfCenter));
  station.add(counter); reception.add(station); root.add(reception);
  const rebuild = () => field.rebuild([root]); rebuild();
  return { root, reception, station, chair, counter, field, rebuild };
}

const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };
const onLane = (t: number): Point3 => seat.seat.map((value, i) => value + (seat.staging[i]! - value) * t) as Point3;

describe('fixed office seat owned side lane', () => {
  it('keeps the keyboard and pointer pad supported while leaving body clearance behind the work shelf', () => {
    const b = RECEPTION_DESK_BLUEPRINT;
    const input = deskInputPlacement(RECEPTION_KEYBOARD_BASE, 0, RECEPTION_DESK_TOP, deskLayout(seat.seatId));
    const keys = KEYBOARD_DIMENSIONS[input.keyboardKind];
    for (const [center, yaw, width, depth] of [[input.keyboard, input.keyboardYaw, keys.width, keys.depth],
      [input.pad, input.mouseYaw, MOUSE_PAD.width, MOUSE_PAD.depth]] as const) {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const [x, z] = rotateXZ(sx * width / 2, sz * depth / 2, yaw);
        expect(Math.abs(center[0] + x - b.workShelfCenter[0])).toBeLessThan(b.workShelfSize[0] / 2);
        expect(Math.abs(center[2] + z - b.workShelfCenter[2])).toBeLessThan(b.workShelfSize[2] / 2);
      }
    }
    const chairBehindShelf = b.chairOffsetZ - .04 - (b.counterOffsetZ + b.workShelfCenter[2] + b.workShelfSize[2] / 2);
    expect(chairBehindShelf).toBeGreaterThan(.29);
  });

  it('keeps the fixed reception chair solid outside its complete authored entry and exit lane', () => {
    const h = fixture();
    expect(isDeskChair(seat.seatId)).toBe(false); expect(seat.seatStyle).toBe('office');
    expect(h.field.segmentClear(seat.seat, seat.staging, .29)).toBe(false);
    expect(h.field.segmentClear(onLane(.2), seat.staging, .29)).toBe(false);
    expect(h.field.seatExitClear(seat, seat.seat, seat.staging)).toBe(true);
    expect(h.field.seatEntryClear(seat, seat.staging, seat.seat)).toBe(true);
    expect(h.field.segmentClear(seat.staging, seat.staging, .29)).toBe(true);
  });

  it('rejects forged seat identity, authored endpoints, movable chairs and out-of-lane travel', () => {
    const { field, chair, rebuild } = fixture();
    for (const invalid of [
      { ...seat, seatId: 'unregistered-office-seat' },
      { ...seat, standing: true }, { ...seat, rotationY: seat.rotationY + .1 },
      { ...seat, seat: onLane(.05) }, { ...seat, staging: onLane(.9) },
      navigation.seats.get('engineering.pod-a.seat-se')!,
    ]) expect(field.seatExitClear(invalid, invalid.seat, invalid.staging)).toBe(false);
    for (const [from, to] of [
      [onLane(-.01), onLane(.5)], [onLane(.5), onLane(1.01)], [onLane(.7), onLane(.3)],
      [[seat.seat[0], 0, seat.seat[2] + .13], seat.staging],
      [[seat.seat[0], .1, seat.seat[2]], seat.staging], [[NaN, 0, 0], seat.staging],
    ] as readonly (readonly [Point3, Point3])[]) expect(field.seatExitClear(seat, from, to)).toBe(false);
    expect(field.seatExitClear(seat, seat.seat, seat.staging, -1)).toBe(false);
    expect(field.seatEntryClear(seat, onLane(.2), onLane(.7))).toBe(false);
    chair.userData.officeSeat = false; rebuild();
    expect(field.seatExitClear(seat, seat.seat, seat.staging)).toBe(false);
    chair.userData.officeSeat = true; chair.position.x = 2; rebuild();
    expect(field.seatEntryClear(seat, seat.staging, seat.seat)).toBe(false);
  });

  it('keeps the owning counter, foreign walls, desks and neighboring chairs solid at full body radius', () => {
    for (const kind of ['counter', 'wall', 'desk', 'chair'] as const) {
      const h = fixture(), obstacle = new Group(), point = onLane(.6);
      obstacle.userData.officeSeat = kind === 'chair';
      obstacle.userData.officeSeatStation = kind === 'desk';
      obstacle.add(box([.08, .7, .08], [0, .6, 0]));
      // Its edge intersects the body but not the authored centerline.
      const parent = kind === 'counter' ? h.station : h.root;
      h.root.updateWorldMatrix(true, true);
      const local = parent.worldToLocal(new Vector3(point[0], point[1], point[2] + .27));
      obstacle.position.copy(local); parent.add(obstacle); h.rebuild();
      expect(h.field.seatExitClear(seat, seat.seat, seat.staging), kind).toBe(false);
      expect(h.field.seatEntryClear(seat, seat.staging, seat.seat), kind).toBe(false);
      parent.remove(obstacle); h.rebuild();
      expect(h.field.seatExitClear(seat, seat.seat, seat.staging)).toBe(true);
    }
  });

  it('rejects endpoints on another floor even with a matching moved chair', () => {
    const h = fixture(), upper = { ...seat, floor: 2 as const, seat: [seat.seat[0], 6.4, seat.seat[2]] as Point3,
      staging: [seat.staging[0], 6.4, seat.staging[2]] as Point3 };
    h.reception.position.y = 6.4; h.rebuild();
    expect(h.field.seatExitClear(upper, upper.seat, upper.staging)).toBe(false);
    expect(h.field.seatEntryClear(upper, upper.staging, upper.seat)).toBe(false);
  });

  it('completes repeated duty-break-return trips with actual clearance and no chair sliding or jumps', () => {
    const h = fixture(), target = navigation.seats.get('lounge.dining-2')!;
    expect(target).toBeDefined();
    const env: MovementEnv = { navigation, elevators, walkable: h.field.segmentClear, seatExitClear: h.field.seatExitClear,
      seatEntryClear: h.field.seatEntryClear, nearbyWalkers: () => [] };
    const mover = createMover('fixed-seat-worker', gaitParameters(), seat.seat, seat.rotationY, false);
    placeSeated(mover, seat, env);
    const transform = h.chair.matrixWorld.clone();
    for (let trip = 0; trip < 3; trip++) for (const destination of [target, seat]) {
      expect(sendMover(mover, { kind: 'seat', seat: destination }, env)).toBe(true);
      for (let frame = 0; frame < 3600 && !(mover.phase === 'seated' && mover.seat?.seatId === destination.seatId); frame++) {
        const before: Point3 = [...mover.position]; stepMover(mover, 1 / 30, env);
        expect(Math.hypot(...mover.position.map((value, i) => value - before[i]!) as Point3)).toBeLessThan(.08);
        expect(['gone', 'vanishing', 'chairing']).not.toContain(mover.phase);
        expect(mover.chairPull).toBe(0); expect(mover.opacity).toBe(1);
      }
      expect(mover.phase).toBe('seated'); expect(mover.position).toEqual(destination.seat);
      expect(h.chair.matrixWorld.equals(transform)).toBe(true);
    }
  });

  it('waits for a peer in both directions, then finishes the same owned lane', () => {
    const h = fixture(), target = navigation.seats.get('lounge.dining-2')!;
    let blocked = true;
    const peer = onLane(.5);
    const env: MovementEnv = { navigation, elevators, walkable: h.field.segmentClear,
      seatExitClear: h.field.seatExitClear, seatEntryClear: h.field.seatEntryClear,
      nearbyWalkers: () => blocked ? [{ id: 'stationary-peer', position: peer, velocity: [0, 0, 0] }] : [] };
    const mover = createMover('fixed-seat-peer', gaitParameters(), seat.seat, seat.rotationY, false);
    placeSeated(mover, seat, env);
    const step = () => {
      const before: Point3 = [...mover.position]; stepMover(mover, 1 / 30, env);
      expect(Math.hypot(...mover.position.map((value, i) => value - before[i]!) as Point3)).toBeLessThan(.08);
      if (blocked) expect(Math.hypot(mover.position[0] - peer[0], mover.position[2] - peer[2])).toBeGreaterThanOrEqual(.55);
    };
    expect(sendMover(mover, { kind: 'seat', seat: target }, env)).toBe(true);
    for (let frame = 0; frame < 300; frame++) step();
    expect(mover.seatExit).toBe(seat); expect(mover.backing).toBe(true);
    expect(mover.position[0]).toBeLessThan(peer[0]);
    blocked = false;
    for (let frame = 0; frame < 3600 && mover.phase !== 'seated'; frame++) step();
    expect(mover.position).toEqual(target.seat);
    expect(sendMover(mover, { kind: 'seat', seat }, env)).toBe(true);
    for (let frame = 0; frame < 3600 && mover.phase !== 'sitting'; frame++) step();
    expect(mover.phase).toBe('sitting'); blocked = true;
    for (let frame = 0; frame < 300; frame++) step();
    expect(mover.phase).toBe('sitting'); expect(mover.timer).toBe(-1);
    expect(mover.position[0]).toBeGreaterThan(peer[0]);
    blocked = false;
    for (let frame = 0; frame < 600 && mover.phase !== 'seated'; frame++) step();
    expect(mover.phase).toBe('seated'); expect(mover.position).toEqual(seat.seat);
  });
});
