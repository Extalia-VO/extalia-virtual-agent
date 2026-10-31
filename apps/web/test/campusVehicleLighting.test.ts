import { Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createMobilityFallbackModels, disposeMobilityLibrary } from '../src/office/scene/CampusMobilityModels';
import { parkingLightPower } from '../src/office/scene/CampusParking';
import {
  allocateHeadlightSpots, createMobilityLampGeometry, HEAD_GAIN, headlightSpotCount, HEADLIGHT_SPOT_BUDGET, lampEmissionScale, mobilityLampPower,
  nearestTrafficCars, roadLightMask, TAIL_BRAKE, TAIL_RUNNING, trafficHeadlightBeam, viewFocus, wheelMatrix,
} from '../src/office/scene/CampusTraffic';
import { RENDER_BUDGET_LEVELS } from '../src/office/scene/environment/renderBudget';
import {
  EV_CHARGERS, PARKED_VEHICLES, PARKING, PARKING_BAYS, PARKING_LIGHTS, TRAFFIC_LANES, TRAFFIC_SCHEDULE, VEHICLE_MODELS, VEHICLE_SPECS,
  createTrafficPose, isMobilityVehicle, updateTraffic, wheelSpin, type TrafficCarPose,
} from '../src/office/scene/campusMobilityLayout';
import {
  BEAM_LENGTH, BEAM_TUCK, BEAM_WIDTH, carPoint, HEAD_GLARE_SIZE, HEADLIGHT_SPOT, headlightPoolLevels, lampGlareLevels, REAR_POOL_LENGTH, REAR_POOL_TUCK, REAR_POOL_WIDTH,
  SPOT_REACH, vehicleLampAnchors, type VehicleLampAnchors,
} from '../src/office/scene/campusVehicleLamps';
import type { MobilityModel } from '../src/office/scene/campusMobilityLayout';

/** Plausible, mirrored lamp pairs at the nose and tail of the measured body (published GLBs: tooling/blender/campusVehicleLamps.test.ts). */
function expectLampPairs(model: MobilityModel, lamps: VehicleLampAnchors) {
  const { length, height, track } = VEHICLE_SPECS[model]!;
  for (const [pair, front] of [[lamps.head, true], [lamps.tail, false]] as const) {
    const [left, right] = pair;
    expect(left.x, model).toBeGreaterThan(0);
    expect(right.x, model).toBeLessThan(0);
    expect(Math.abs(left.x + right.x), model).toBeLessThan(.12);
    for (const lamp of pair) {
      expect(Math.abs(lamp.x), model).toBeGreaterThanOrEqual(.3 * track - 1e-9);
      expect(Math.abs(lamp.x), model).toBeLessThanOrEqual(.5 * track + 1e-9);
      expect(lamp.y, model).toBeGreaterThan(.3);
      expect(lamp.y, model).toBeLessThan(height * .8);
      if (front) { expect(lamp.z, model).toBeGreaterThan(length / 2 - .5); expect(lamp.z, model).toBeLessThan(length / 2 + .06); }
      else { expect(lamp.z, model).toBeLessThan(-length / 2 + .5); expect(lamp.z, model).toBeGreaterThan(-length / 2 - .06); }
    }
  }
}

describe('campus vehicle and parking night lighting', () => {
  it('keeps parked head and tail lenses diffuse while moving cars follow dusk, night and the light control', () => {
    const models = createMobilityFallbackModels();
    try {
      for (const model of VEHICLE_MODELS) {
        const source = models.get(model)!.lamp;
        const geometry = createMobilityLampGeometry(source, model, 2, 1);
        try {
          expect(source.getAttribute('mobilityEmission')).toBeUndefined();
          expect(Array.from(geometry.getAttribute('mobilityEmission').array)).toEqual([0, 0, 1]);
          expect(Array.from(geometry.getAttribute('mobilityBrake').array)).toEqual([0, 0, 0]);
          expect(geometry.getAttribute('mobilityTail').count).toBe(geometry.getAttribute('position').count);
          expect(Array.from(geometry.getAttribute('color').array)).toEqual(Array.from(source.getAttribute('color').array));
          for (const override of ['auto', 'on', 'off'] as const) expect(mobilityLampPower(model, 1, override)).toBe(0);
          // Day: unlit; dusk/blue hour: partial; night: full. On/Off force it either way.
          expect(mobilityLampPower(model, 0, 'auto', true)).toBe(0);
          expect(mobilityLampPower(model, .45, 'auto', true)).toBe(.45);
          expect(mobilityLampPower(model, 1, 'auto', true)).toBe(1);
          expect(mobilityLampPower(model, 0, 'on', true)).toBe(1);
          expect(mobilityLampPower(model, 1, 'off', true)).toBe(0);
        } finally { geometry.dispose(); }
      }
      for (const model of ['mobility-charger', 'mobility-cycle-shelter'] as const) {
        const geometry = createMobilityLampGeometry(models.get(model)!.lamp, model, 2, 0);
        try { expect(Array.from(geometry.getAttribute('mobilityEmission').array)).toEqual([1, 1]); }
        finally { geometry.dispose(); }
        expect(mobilityLampPower(model, .7, 'auto')).toBe(.7);
        expect(mobilityLampPower(model, 1, 'off')).toBe(0);
        expect(mobilityLampPower(model, 0, 'on')).toBe(1);
      }
    } finally { disposeMobilityLibrary(models); }
  });

  it('brightens only tail lamps while braking', () => {
    expect(lampEmissionScale(false, false)).toBe(HEAD_GAIN);
    expect(lampEmissionScale(false, true)).toBe(HEAD_GAIN);
    expect(HEAD_GAIN).toBeGreaterThan(1);
    expect(lampEmissionScale(true, false)).toBe(TAIL_RUNNING);
    expect(lampEmissionScale(true, true)).toBe(TAIL_BRAKE);
    expect(TAIL_BRAKE).toBeGreaterThan(TAIL_RUNNING * 3);
  });

  it('spins wheels by distance over radius, holds them while waiting and keeps them still under reduced motion', () => {
    expect(wheelSpin(2 * Math.PI * .35, .35)).toBeCloseTo(2 * Math.PI);
    expect(wheelSpin(5, 0)).toBe(0);
    // Every car's distance only grows and holds while it waits (at the crossing or queued); reduced motion empties the road.
    const admitted = TRAFFIC_SCHEDULE.map(lane => new Uint8Array(lane.cars.length).fill(1));
    const pool = Array.from({ length: 64 }, createTrafficPose);
    const previous = new Map<number, { distance: number; stopped: boolean; t: number }>();
    let waiting = 0;
    for (let t = 0; t < 330; t += .05) {
      const count = updateTraffic(TRAFFIC_SCHEDULE, admitted, t, 1, pool);
      for (const pose of pool.slice(0, count)) {
        const before = previous.get(pose.id);
        if (before && t - before.t < .06) {
          expect(pose.distance).toBeGreaterThanOrEqual(before.distance - 1e-9);
          if (pose.stopped && before.stopped) { expect(pose.distance).toBeCloseTo(before.distance, 6); waiting++; }
        }
        previous.set(pose.id, { distance: pose.distance, stopped: pose.stopped, t });
      }
    }
    expect(waiting).toBeGreaterThan(10);
    expect(updateTraffic(TRAFFIC_SCHEDULE, admitted, 10, 1, pool, true)).toBe(0);
  });

  it('places the instanced wheel on its hub, faces the rim outwards and rolls both sides forwards', () => {
    const car = new Matrix4().makeRotationY(Math.PI / 2).setPosition(10, 0, 5);
    const left = { x: .8, y: .35, z: 1.4, side: 1 as const }, right = { x: -.8, y: .35, z: 1.4, side: -1 as const };
    for (const hub of [left, right]) {
      const placed = wheelMatrix(car, hub, 0);
      expect(new Vector3().setFromMatrixPosition(placed).toArray().map(v => +v.toFixed(5))).toEqual(new Vector3(hub.x, hub.y, hub.z).applyMatrix4(car).toArray().map(v => +v.toFixed(5)));
      // The rim face (+X in template space) points away from the car centre.
      const outward = new Vector3(1, 0, 0).transformDirection(placed);
      const side = new Vector3(hub.side, 0, 0).transformDirection(car);
      expect(outward.dot(side)).toBeCloseTo(1);
      // A quarter turn moves the top of the tyre towards the car's front (+Z) on both sides.
      const top = new Vector3(0, .35, 0).applyMatrix4(wheelMatrix(new Matrix4(), hub, .1));
      expect(top.z).toBeGreaterThan(0);
    }
  });

  it('limits real headlight spots to two, nearest to the camera, and none on the lowest render tier', () => {
    expect(HEADLIGHT_SPOT_BUDGET).toBe(2);
    expect(headlightSpotCount(RENDER_BUDGET_LEVELS[0]!.liveBeams, 1)).toBe(2);
    expect(headlightSpotCount(RENDER_BUDGET_LEVELS.at(-1)!.liveBeams, 1)).toBe(0);
    expect(headlightSpotCount(6, 0)).toBe(0);
    const cars = [
      { id: 'far', x: 50, z: 0, visible: true }, { id: 'near', x: 2, z: 0, visible: true },
      { id: 'hidden', x: 0, z: 0, visible: false }, { id: 'mid', x: 10, z: 0, visible: true },
    ];
    expect(allocateHeadlightSpots(cars, { x: 0, z: 0 }, 2)).toEqual(['near', 'mid']);
    expect(allocateHeadlightSpots(cars, { x: 0, z: 0 }, 9)).toHaveLength(2);
    expect(allocateHeadlightSpots(cars, { x: 0, z: 0 }, 0)).toEqual([]);
    // The runtime variant writes car ids in place, without allocating.
    const poses = cars.map((car, index) => ({ ...car, id: [7, 3, 5, 9][index]! }));
    const out = [-1, -1];
    expect(nearestTrafficCars(poses, poses.length, { x: 0, z: 0 }, 2, out)).toBe(2);
    expect(out).toEqual([3, 9]);
    expect(nearestTrafficCars(poses, poses.length, { x: 0, z: 0 }, 1, out)).toBe(1);
    expect(out).toEqual([3, -1]);
    expect(nearestTrafficCars(poses, poses.length, { x: 0, z: 0 }, 0, out)).toBe(0);
    expect(out).toEqual([-1, -1]);
    expect(nearestTrafficCars(poses, 1, { x: 0, z: 0 }, 2, out)).toBe(1);
    expect(out).toEqual([7, -1]);
  });

  it('paints road light pools only for visible moving cars and brightens the tail glow when braking', () => {
    expect(headlightPoolLevels(0, true, false)).toEqual({ head: 0, tail: 0 });
    expect(headlightPoolLevels(1, false, true)).toEqual({ head: 0, tail: 0 });
    const cruising = headlightPoolLevels(1, true, false), braking = headlightPoolLevels(1, true, true);
    expect(cruising.head).toBeGreaterThan(cruising.tail);
    expect(braking.tail).toBeGreaterThan(cruising.tail * 2);
    expect(headlightPoolLevels(.5, true, false).head).toBeCloseTo(cruising.head / 2);
  });

  it('aims bounded pooled headlights from measured lamp height onto the road in every lane direction', () => {
    expect(TRAFFIC_LANES).toHaveLength(6);
    expect(SPOT_REACH).toBe(12);
    // A narrow, far-reaching cone that does not spill shadows or reach beyond the road.
    expect(HEADLIGHT_SPOT.angle).toBeLessThan(.5);
    expect(HEADLIGHT_SPOT.distance).toBeGreaterThan(SPOT_REACH);
    expect(HEADLIGHT_SPOT.distance).toBeLessThanOrEqual(30);
    const models = createMobilityFallbackModels();
    try {
      const pool = Array.from({ length: 64 }, createTrafficPose), admitted = TRAFFIC_SCHEDULE.map(lane => new Uint8Array(lane.cars.length).fill(1));
      const seen = new Set<number>();
      for (let t = 0; t < 330 && seen.size < TRAFFIC_LANES.length; t += 1) {
        const count = updateTraffic(TRAFFIC_SCHEDULE, admitted, t, 1, pool);
        for (const pose of pool.slice(0, count).filter(candidate => !seen.has(candidate.lane))) {
          seen.add(pose.lane);
          const lane = TRAFFIC_LANES[pose.lane]!;
          if (!isMobilityVehicle(pose.model)) throw new Error('Traffic lane requires a car');
          const lamps = vehicleLampAnchors(models.get(pose.model)!.lamp, VEHICLE_SPECS[pose.model]!);
          const beam = trafficHeadlightBeam(lane, pose, lamps, 1);
          const front = Math.max(...lamps.head.map(lamp => lamp.z));
          const height = (lamps.head[0].y + lamps.head[1].y) / 2;
          const dx = Math.sin(pose.yaw), dz = Math.cos(pose.yaw);
          expect(beam.position.x).toBeCloseTo(pose.x + dx * (front + .05));
          expect(beam.position.z).toBeCloseTo(pose.z + dz * (front + .05));
          expect(beam.position.y).toBeCloseTo(pose.y + height);
          expect(beam.position.y).toBeGreaterThan(beam.aim.y);
          expect(beam.aim.x).toBeCloseTo(pose.x + dx * (front + SPOT_REACH));
          expect(beam.aim.z).toBeCloseTo(pose.z + dz * (front + SPOT_REACH));
          expect(beam.aim.y).toBeCloseTo(lane.top);
          expect(Math.hypot(beam.aim.x - beam.position.x, beam.aim.y - beam.position.y, beam.aim.z - beam.position.z)).toBeLessThan(HEADLIGHT_SPOT.distance);
          expect(beam.intensity).toBe(HEADLIGHT_SPOT.intensity);
          expect(trafficHeadlightBeam(lane, pose, lamps, .5).intensity).toBeCloseTo(HEADLIGHT_SPOT.intensity / 2);
          expect(trafficHeadlightBeam(lane, pose, lamps, 2).intensity).toBe(HEADLIGHT_SPOT.intensity);
          expect(trafficHeadlightBeam(lane, pose, lamps, -1).intensity).toBe(0);
          expect(trafficHeadlightBeam(lane, pose, lamps, 0).intensity).toBe(0);
          expect(trafficHeadlightBeam(lane, pose, lamps, 1, true).intensity).toBe(0);
          expect(trafficHeadlightBeam(lane, { ...pose, visible: false } satisfies TrafficCarPose, lamps, 1).intensity).toBe(0);
        }
      }
      expect(seen.size).toBe(TRAFFIC_LANES.length);
    } finally { disposeMobilityLibrary(models); }
  });

  it('derives two head and two tail lamp anchors from each fallback car', () => {
    const fallback = createMobilityFallbackModels();
    try {
      for (const model of VEHICLE_MODELS) expectLampPairs(model, vehicleLampAnchors(fallback.get(model)!.lamp, VEHICLE_SPECS[model]!));
    } finally { disposeMobilityLibrary(fallback); }
  });

  it('places one flat beam per headlamp from under the bumper along the heading, and rear pools close behind the tail lamps', () => {
    const lamps: VehicleLampAnchors = { head: [{ x: .6, y: .7, z: 2.3 }, { x: -.6, y: .7, z: 2.3 }], tail: [{ x: .65, y: .9, z: -2.3 }, { x: -.65, y: .9, z: -2.3 }] };
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, .6]) {
      const pose = { x: 10, y: -.675, z: -60, yaw };
      const forward = { x: Math.sin(yaw), z: Math.cos(yaw) }, left = { x: Math.cos(yaw), z: -Math.sin(yaw) };
      const along = (p: { x: number; z: number }) => (p.x - pose.x) * forward.x + (p.z - pose.z) * forward.z;
      const across = (p: { x: number; z: number }) => (p.x - pose.x) * left.x + (p.z - pose.z) * left.z;
      const beams = lamps.head.map(lamp => carPoint(pose, lamp, -BEAM_TUCK));
      const pools = lamps.tail.map(lamp => carPoint(pose, lamp, REAR_POOL_TUCK));
      for (const [index, origin] of beams.entries()) {
        expect(along(origin)).toBeCloseTo(2.3 - BEAM_TUCK);
        expect(across(origin)).toBeCloseTo(lamps.head[index]!.x);
      }
      for (const [index, origin] of pools.entries()) {
        expect(along(origin)).toBeCloseTo(-2.3 + REAR_POOL_TUCK);
        expect(across(origin)).toBeCloseTo(lamps.tail[index]!.x);
      }
      expect(carPoint(pose, lamps.head[0]).y).toBeCloseTo(pose.y + .7);
    }
    // Rear pools stay within 1.5 m of the bumper; beams fade out within 10–14 m.
    expect(REAR_POOL_LENGTH - REAR_POOL_TUCK).toBeLessThanOrEqual(1.5);
    expect(REAR_POOL_WIDTH).toBeLessThan(1.5);
    expect(BEAM_LENGTH - BEAM_TUCK).toBeGreaterThanOrEqual(10);
    expect(BEAM_LENGTH - BEAM_TUCK).toBeLessThanOrEqual(14);
    // The beam mask starts narrow and bright at the lamp, widens, and is dark at the far end and edges.
    const near = roadLightMask('beam', 0, .06), mid = roadLightMask('beam', 0, .45);
    expect(near).toBeGreaterThan(mid);
    expect(roadLightMask('beam', 0, .999)).toBeLessThan(.01);
    expect(roadLightMask('beam', .6, .06)).toBe(0);
    expect(roadLightMask('beam', .6, .7)).toBeGreaterThan(0);
    expect(roadLightMask('beam', 1, .5)).toBe(0);
    expect(BEAM_WIDTH / 2 * (.14 + .86 * Math.pow(.06, .7))).toBeLessThan(.6);
    for (let v = 0; v <= 1; v += .05) for (let u = -1; u <= 1; u += .1) {
      expect(roadLightMask('beam', u, v)).toBeLessThanOrEqual(1);
      expect(roadLightMask('rear', u, v)).toBeLessThanOrEqual(1);
    }
    // Two overlapping beams stay well short of white.
    expect(headlightPoolLevels(1, true, false).head * 2).toBeLessThan(.6);
  });

  it('shows lamp glare only while lit and brightens the brake glare', () => {
    expect(lampGlareLevels(1, false, false)).toMatchObject({ head: 0, tail: 0 });
    expect(lampGlareLevels(0, true, true)).toMatchObject({ head: 0, tail: 0 });
    const cruise = lampGlareLevels(1, true, false), brake = lampGlareLevels(1, true, true);
    expect(cruise.head).toBeGreaterThan(cruise.tail);
    expect(brake.tail).toBeGreaterThan(cruise.tail * 1.5);
    expect(brake.tailSize).toBeGreaterThan(cruise.tailSize);
    expect(HEAD_GLARE_SIZE).toBeLessThan(1);
  });

  it('allocates spots around the view centre of the orthographic office camera', () => {
    // Looking down at 45° from (0, 10, 10) meets the road (y = 0) at the origin.
    const focus = viewFocus({ x: 0, y: 10, z: 10 }, { x: 0, y: -Math.SQRT1_2, z: -Math.SQRT1_2 }, 0);
    expect(focus.x).toBeCloseTo(0);
    expect(focus.z).toBeCloseTo(0);
    expect(viewFocus({ x: 3, y: 10, z: 4 }, { x: 1, y: 0, z: 0 }, 0)).toEqual({ x: 3, z: 4 });
    const cars = [{ id: 'under-camera', x: 0, z: 9, visible: true }, { id: 'centre', x: .5, z: 0, visible: true }, { id: 'side', x: 5, z: 0, visible: true }];
    expect(allocateHeadlightSpots(cars, focus, 2)).toEqual(['centre', 'side']);
  });

  it('follows night and manual controls for the parking poles', () => {
    expect(parkingLightPower(.7, 'auto')).toBe(.7);
    expect(parkingLightPower(1, 'off')).toBe(0);
    expect(parkingLightPower(0, 'on')).toBe(1);
  });

  it('spaces six parking poles along both edges without blocking bays, chargers, the aisle or footway', () => {
    expect(PARKING_LIGHTS).toHaveLength(6);
    expect(new Set(PARKING_LIGHTS.map(pole => pole.z)).size).toBe(3);
    for (const pole of PARKING_LIGHTS) {
      expect(pole.x).toBeGreaterThan(PARKING.west);
      expect(pole.x).toBeLessThan(PARKING.east);
      expect(Math.abs(pole.x - PARKING.aisleX)).toBeGreaterThan(7);
      expect(Math.abs(pole.x - PARKING.footwayX)).toBeGreaterThan(1.5);
      for (const bay of PARKING_BAYS) {
        const insideBay = Math.abs(pole.x - bay.x) < PARKING.bayDepth / 2 + .15 && Math.abs(pole.z - bay.z) < PARKING.bayWidth / 2 + .15;
        expect(insideBay).toBe(false);
      }
      for (const charger of EV_CHARGERS) expect(Math.hypot(pole.x - charger.x, pole.z - charger.z)).toBeGreaterThan(1);
      for (const car of PARKED_VEHICLES) expect(Math.hypot(pole.x - car.x, pole.z - car.z)).toBeGreaterThan(3);
      expect(pole.poolX).toBeGreaterThan(PARKING.west);
      expect(pole.poolX).toBeLessThan(PARKING.east);
    }
  });
});
