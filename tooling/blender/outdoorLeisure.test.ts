import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { BoxGeometry, Group, Mesh, MeshBasicMaterial } = await import(webRequire.resolve('three'));
const { GLTFLoader } = await import(webRequire.resolve('three/examples/jsm/loaders/GLTFLoader.js'));
import type { OfficeAgent } from '../../apps/web/src/office/presence';
import { gaitParameters } from '../../apps/web/src/office/scene/avatars/gait';
import { getOfficeSeats, type OfficeAgentAllocation } from '../../apps/web/src/office/scene/interior/seating';
import { OFFICE_RESOURCES } from '../../apps/web/src/office/scene/interior/resourceRegistry';
import { OUTDOOR_FACILITIES_BLUEPRINT as outdoor } from '../../apps/web/src/office/scene/spatialBlueprints';
import { MovementDirector } from '../../apps/web/src/office/scene/movement/director';
import { HospitalityState } from '../../apps/web/src/office/scene/movement/hospitality';
import { LEISURE_SPOTS } from '../../apps/web/src/office/scene/movement/leisureSpots';
import { createMover, routeFrom, sendMover, stepMover, type ElevatorAccess, type MovementEnv } from '../../apps/web/src/office/scene/movement/mover';
import { WalkingClearance } from '../../apps/web/src/office/scene/movement/naturalClearance';
import { officeNavigation, planRoute, seatStageId } from '../../apps/web/src/office/scene/movement/navGraph';
import { KIOSK_PICKUP_MS, KIOSK_PREPARE_MS, OutdoorKioskState } from '../../apps/web/src/office/scene/movement/outdoorKiosk';
import { staticSeatRoute } from '../../apps/web/src/office/scene/movement/staticSeating';
import { OUTDOOR_SOLIDS, type OutdoorSolidKind } from '../../apps/web/src/office/scene/movement/OutdoorSolids';

const navigation = officeNavigation();
const outdoorSpots = LEISURE_SPOTS.filter(spot => spot.id.startsWith('outdoor.'));
const lifts: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };

describe('outdoor leisure and café pickup', () => {
  it('offers every authored outdoor seat and counter with an outside route from the entrance', () => {
    const resources = OFFICE_RESOURCES.filter(resource => resource.id.startsWith('outdoor.'));
    expect(outdoorSpots.map(spot => spot.id).sort()).toEqual(resources.map(resource => resource.id).sort());
    for (const spot of outdoorSpots) {
      const seat = navigation.seats.get(spot.id)!;
      const route = planRoute(navigation.entryId, seatStageId(spot.id), navigation)!;
      expect(route, spot.id).not.toBeNull();
      expect(route.steps.every(step => step.kind === 'walk' && !step.stairs && step.to[1] === 0), spot.id).toBe(true);
      for (const step of route.steps) if (step.kind === 'walk') {
        expect(Math.abs(step.to[0]) >= 21 || Math.abs(step.to[2]) >= 19, spot.id).toBe(true);
      }
      if (spot.id === 'outdoor.cafe-counter' || spot.id === 'outdoor.garden-art') expect(seat.standing).toBe(true);
      else expect(seat.seatHeight).toBeGreaterThan(.4);
    }
  });

  it('does not prepare before arrival, reserves one customer and retains full pickup time', () => {
    const state = new OutdoorKioskState();
    expect(state.request('a', 0)).toBe(true);
    expect(state.request('b', 10)).toBe(false);
    state.advance(100_000);
    expect(state.snapshot()?.status).toBe('walking');
    state.arrive('b', 100_000);
    expect(state.snapshot()?.status).toBe('walking');
    state.arrive('a', 100_000);
    state.advance(100_000 + KIOSK_PREPARE_MS - 1);
    expect(state.snapshot()?.status).toBe('preparing');
    state.advance(100_000 + KIOSK_PREPARE_MS);
    expect(state.snapshot()?.status).toBe('pickup');
    state.advance(100_000 + KIOSK_PREPARE_MS + KIOSK_PICKUP_MS);
    expect(state.snapshot()?.status).toBe('collected');
    state.release('b');
    expect(state.snapshot()?.actorId).toBe('a');
    state.release('a');
    expect(state.snapshot()).toBeNull();
    expect(state.request('b', 200_000)).toBe(true);
    state.clear();
    expect(state.snapshot()).toBeNull();
  });

  it('physically visits the counter, picks up a drink, sits outside, and returns when real work arrives', () => {
    let now = 0;
    const kiosk = new OutdoorKioskState();
    const director = new MovementDirector({ navigation, elevators: lifts }, () => now, null, new HospitalityState(), kiosk);
    director.lifeScale = .3; director.preferKind = 'cafe';
    const id = 'outdoor-guest:primary';
    const desk = getOfficeSeats().find(seat => seat.id === 'qa.station-1')!;
    const allocations: OfficeAgentAllocation[] = [{ ...desk, agentId: id, resourceId: desk.id }];
    const update = (status: OfficeAgent['status'], reducedMotion = false) => director.update({ allocations,
      agents: [{ id, sessionId: 'outdoor-guest', agentId: 'primary', displayName: 'Outdoor guest', control: 'managed', status, running: status !== 'idle' }],
      reducedMotion, gaitOf: () => gaitParameters() });
    const seen = new Set<string>();
    let pickedUp = false, sipped = false;
    update('idle');
    for (let i = 0; i < 50_000 && !sipped; i++) {
      now += 1000 / 30; director.tick(1 / 30);
      const visit = director.lifeState(id)?.visit;
      if (visit?.arrived) seen.add(visit.spotId);
      const mover = director.list[0]!;
      if (mover.seat?.seatId === 'outdoor.cafe-counter' && mover.motion.clip === 'bar-serve') pickedUp = true;
      if (pickedUp && mover.seat?.seatId.startsWith('outdoor.cafe-table-') && mover.phase === 'seated' && mover.motion.clip === 'sip') sipped = true;
    }
    expect(pickedUp).toBe(true);
    expect(sipped).toBe(true);
    expect(seen.has('outdoor.cafe-counter')).toBe(true);
    expect(kiosk.snapshot()).toBeNull();
    update('working');
    for (let i = 0; i < 10_000 && director.list[0]?.seat?.seatId !== desk.id; i++) { now += 1000 / 30; director.tick(1 / 30); }
    expect(director.lifeState(id)?.visit).toBeNull();
    expect(director.list[0]?.seat?.seatId).toBe(desk.id);
    update('idle', true);
    for (let i = 0; i < 1000; i++) { now += 1000 / 30; director.tick(1 / 30); }
    expect(director.lifeState(id)?.visit ?? null).toBeNull();
    director.dispose();
    expect(kiosk.snapshot()).toBeNull();
  });

  it('keeps the pickup exclusive and cancels preparation when work, reduced motion or removal takes over', () => {
    let now = 0;
    const kiosk = new OutdoorKioskState();
    const director = new MovementDirector({ navigation, elevators: lifts }, () => now, null, new HospitalityState(), kiosk);
    director.lifeScale = .3; director.preferKind = 'cafe';
    const ids = ['cafe-a:primary', 'cafe-b:primary'];
    const desks = ['qa.station-1', 'qa.station-2'];
    const allocations = ids.map((agentId, index) => {
      const desk = getOfficeSeats().find(seat => seat.id === desks[index])!;
      return { ...desk, agentId, resourceId: desk.id };
    });
    const agents = (busy?: string): OfficeAgent[] => ids.map(id => ({ id, sessionId: id.split(':')[0]!, agentId: 'primary',
      displayName: 'Café guest', control: 'managed', status: id === busy ? 'working' : 'idle', running: id === busy }));
    const update = (busy?: string, reducedMotion = false) => director.update({ allocations, agents: agents(busy), reducedMotion, gaitOf: () => gaitParameters() });
    const tick = () => {
      now += 1000 / 30; director.tick(1 / 30);
      const counterVisitors = ids.filter(id => director.lifeState(id)?.visit?.spotId === 'outdoor.cafe-counter');
      expect(counterVisitors.length).toBeLessThanOrEqual(1);
    };
    update();
    for (let i = 0; i < 30_000 && kiosk.snapshot()?.status !== 'preparing'; i++) tick();
    expect(kiosk.snapshot()?.status).toBe('preparing');
    const recalled = kiosk.snapshot()!.actorId;
    update(recalled);
    for (let i = 0; i < 30; i++) tick();
    expect(kiosk.snapshot()?.actorId).not.toBe(recalled);
    expect(director.lifeState(recalled)?.visit).toBeNull();
    update(undefined, true);
    for (let i = 0; i < 30; i++) tick();
    expect(kiosk.snapshot()).toBeNull();
    expect(ids.every(id => director.lifeState(id)?.visit == null)).toBe(true);
    update();
    for (let i = 0; i < 30_000 && kiosk.snapshot()?.status !== 'preparing'; i++) tick();
    expect(kiosk.snapshot()?.status).toBe('preparing');
    director.update({ allocations: [], agents: [], reducedMotion: false, gaitOf: () => gaitParameters() });
    for (let i = 0; i < 60; i++) tick();
    expect(kiosk.snapshot()).toBeNull();
    director.dispose();
  });
});

const localFile = new URL('../../apps/web/local-assets/landscape/exterior-landscape.glb', import.meta.url);
describe.skipIf(!existsSync(localFile))('actual Blender outdoor furniture clearance', () => {
  it('keeps authored outside approaches and each sit/stand lane clear of tables, benches and kiosk', async () => {
    const library = (await new GLTFLoader().parseAsync(new Uint8Array(readFileSync(localFile)).buffer, '')).scene;
    const root = new Group();
    const add = (name: string, position: readonly [number, number, number], yaw = 0, seat = false, parent = root) => {
      const model = library.getObjectByName(name)!.clone(true);
      model.position.set(...position); model.rotation.y = yaw;
      if (seat) model.userData.officeSeat = true;
      parent.add(model);
      return model;
    };
    const solids = (kind: OutdoorSolidKind, parent: InstanceType<typeof Group>) => OUTDOOR_SOLIDS[kind].forEach(solid => {
      const mesh = new Mesh(new BoxGeometry(...solid.size), new MeshBasicMaterial({ visible: false }));
      mesh.position.set(solid.position[0], solid.position[1], solid.position[2]); parent.add(mesh);
    });
    const envelope = new Mesh(new BoxGeometry(46, 3, 38), new MeshBasicMaterial());
    envelope.position.set(2, 1.5, 0); root.add(envelope);
    outdoor.forecourtLamps.forEach(lamp => add('exterior-walk-lamp', [lamp.x, 0, lamp.z]));
    outdoor.plinthBenches.forEach(bench => add('exterior-plinth-bench', bench.position, bench.rotationY, true));
    outdoor.parkBenches.forEach(bench => add('exterior-park-bench', bench.position, bench.rotationY, true));
    outdoor.arrivalGardens.forEach(garden => {
      const group = new Group(); group.position.set(garden.position[0], garden.position[1], garden.position[2]); root.add(group);
      add('exterior-garden-planter', [0, 0, 0], 0, false, group).userData.officePassable = true;
      solids('planter', group);
      outdoor.gardenSeatSlots.forEach(x => add('exterior-garden-seat', [x, 0, outdoor.gardenSeatZ], 0, true, group));
    });
    outdoor.picnicTables.forEach(table => {
      const group = new Group(); group.position.set(table.position[0], table.position[1], table.position[2]); group.rotation.y = table.rotationY; root.add(group);
      add('exterior-picnic-table', [0, 0, 0], 0, false, group).userData.officePassable = true;
      add('exterior-parasol', [0, 0, 0], 0, false, group).userData.officePassable = true;
      solids('picnic-table', group); solids('parasol', group);
      outdoor.picnicSeatSides.forEach(z => add('exterior-picnic-bench', [0, 0, z], 0, true, group));
    });
    outdoor.patios.forEach(patio => {
      const group = new Group(); group.position.set(patio.position[0], patio.position[1], patio.position[2]); root.add(group);
      add('exterior-patio-table', [0, 0, 0], 0, false, group).userData.officePassable = true;
      solids('patio-table', group);
      outdoor.patioChairAngles.forEach(a => add('exterior-patio-chair', [Math.sin(a) * outdoor.patioChairRadius, 0,
        Math.cos(a) * outdoor.patioChairRadius], a + Math.PI, true, group));
    });
    add('exterior-cafe-kiosk', outdoor.cafeKiosk.position, outdoor.cafeKiosk.rotationY);
    add('exterior-garden-decor', outdoor.gardenArt.position, outdoor.gardenArt.rotationY);
    const field = new WalkingClearance(); field.rebuild([root]);
    expect(field.segmentClear([-29, 0, -23.3], [-29, 0, -23.3], .29)).toBe(false);
    expect(field.segmentClear([-5.2, 0, 25.5], [-5.2, 0, 25.5], .29)).toBe(false);
    expect(field.segmentClear([-8.8, 0, -26], [-8.8, 0, -26], .29)).toBe(false);
    expect(field.segmentClear([-34.2, 0, -25.4], [-34.2, 0, -25.4], .29)).toBe(false);
    for (const lamp of outdoor.forecourtLamps) {
      expect(field.segmentClear([lamp.x, 0, lamp.z], [lamp.x, 0, lamp.z], .29)).toBe(false);
    }
    const blocked: string[] = [];
    for (const spot of outdoorSpots) {
      const seat = navigation.seats.get(spot.id)!;
      const route = planRoute(navigation.entryId, seatStageId(spot.id), navigation)!;
      let from = navigation.waypoints.get(navigation.entryId)!.position;
      for (const step of route.steps) if (step.kind === 'walk') {
        if (!field.segmentClear(from, step.to, .29)) blocked.push(`${spot.id}:${step.node}`);
        from = step.to;
      }
      if (!seat.standing && !staticSeatRoute('probe', seat, seat.staging, navigation, field.segmentClear, [],
        (a, b, radius) => field.seatContactClear(seat, a, b, radius))) blocked.push(`${spot.id}:sit`);
      const env: MovementEnv = { navigation, elevators: lifts, walkable: field.segmentClear,
        seatContactClear: (target, a, b, radius) => field.seatContactClear(target, a, b, radius) };
      const mover = createMover(`probe:${spot.id}`, gaitParameters(), [...navigation.waypoints.get(navigation.entryId)!.position], 0, true);
      expect(routeFrom(mover, navigation.entryId, { kind: 'seat', seat }, env, false), spot.id).toBe(true);
      for (let i = 0; i < 15_000 && mover.phase !== 'seated'; i++) stepMover(mover, 1 / 30, env);
      expect(mover.phase, spot.id).toBe('seated');
      expect(mover.position, spot.id).toEqual(seat.seat);
      sendMover(mover, { kind: 'leave', node: navigation.entryId }, env);
      for (let i = 0; i < 15_000 && mover.phase !== 'gone'; i++) stepMover(mover, 1 / 30, env);
      expect(mover.phase, `${spot.id} departure`).toBe('gone');
    }
    expect(blocked).toEqual([]);
  });
});
