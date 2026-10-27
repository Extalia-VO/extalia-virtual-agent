import { describe, expect, it } from 'vitest';
import { createMobilityFallbackModels, disposeMobilityLibrary } from '../src/office/scene/CampusMobilityModels';
import { parkingLightPower } from '../src/office/scene/CampusParking';
import { createMobilityLampGeometry, mobilityLampPower, trafficHeadlightBeam } from '../src/office/scene/CampusTraffic';
import { EV_CHARGERS, PARKED_VEHICLES, PARKING, PARKING_BAYS, PARKING_LIGHTS, TRAFFIC_LANES, VEHICLE_MODELS, VEHICLE_SPECS, isMobilityVehicle, trafficPose } from '../src/office/scene/campusMobilityLayout';

describe('campus vehicle and parking night lighting', () => {
  it('keeps parked head and tail lenses diffuse while only active cars emit at night', () => {
    const models = createMobilityFallbackModels();
    try {
      for (const model of VEHICLE_MODELS) {
        const source = models.get(model)!.lamp;
        const geometry = createMobilityLampGeometry(source, model, 2, 1);
        try {
          expect(source.getAttribute('mobilityEmission')).toBeUndefined();
          expect(Array.from(geometry.getAttribute('mobilityEmission').array)).toEqual([0, 0, 1]);
          expect(Array.from(geometry.getAttribute('color').array)).toEqual(Array.from(source.getAttribute('color').array));
          for (const override of ['auto', 'on', 'off'] as const) {
            expect(mobilityLampPower(model, 1, override)).toBe(0);
            expect(mobilityLampPower(model, 1, override, true)).toBe(1);
            expect(mobilityLampPower(model, 0, override, true)).toBe(0);
          }
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

  it('aims four bounded pooled headlights from the actual +Z front onto the nearby road in every lane direction', () => {
    expect(TRAFFIC_LANES).toHaveLength(4);
    for (const lane of TRAFFIC_LANES) {
      const seconds = (lane.period - lane.offset) % lane.period + .5;
      const pose = trafficPose(lane, seconds);
      const beam = trafficHeadlightBeam(lane, pose, 1);
      if (!isMobilityVehicle(lane.model)) throw new Error('Traffic lane requires a car');
      const front = VEHICLE_SPECS[lane.model].length / 2;
      const dx = Math.sin(pose.yaw), dz = Math.cos(pose.yaw);
      expect(beam.position[0]).toBeCloseTo(pose.x + dx * (front + .04));
      expect(beam.position[2]).toBeCloseTo(pose.z + dz * (front + .04));
      expect(beam.position[1]).toBeGreaterThan(beam.aim[1]);
      expect(beam.aim[0]).toBeCloseTo(pose.x + dx * (front + 5));
      expect(beam.aim[2]).toBeCloseTo(pose.z + dz * (front + 5));
      expect(beam.aim[1]).toBeCloseTo(lane.top + .015);
      expect(Math.hypot(...beam.aim.map((value, index) => value - beam.position[index]!))).toBeLessThan(9);
      expect(beam.intensity).toBe(18);
      expect(trafficHeadlightBeam(lane, pose, 0).intensity).toBe(0);
      expect(trafficHeadlightBeam(lane, pose, 1, true).intensity).toBe(0);
      expect(trafficHeadlightBeam(lane, trafficPose(lane, seconds, true), 1).intensity).toBe(0);
      expect(trafficHeadlightBeam(lane, { ...pose, visible: false }, 1).intensity).toBe(0);
    }
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
