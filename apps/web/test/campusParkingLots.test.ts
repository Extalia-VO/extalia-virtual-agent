import { describe, expect, it } from 'vitest';
import {
  PARKING_ACCESS, PARKING_ACCESS_NOTCHES, PARKING_FOOTPRINTS, PARKING_LOT_CHARGERS, PARKING_LOT_LAMPS, PARKING_LOTS,
  accessSurfaceY, insideParkingFootprint, parkingLot, parkingSurfaceY, rectsWithout, type ParkingLot,
} from '../src/office/scene/campusParkingLots';
import {
  ALL_PARKING_BAYS, EV_CHARGERS, PARKED_VEHICLES, PARKING, PARKING_BAYS, PARKING_LIGHTS, TRAFFIC_LANES, VEHICLE_SPECS, isMobilityVehicle, vehicleCategory,
} from '../src/office/scene/campusMobilityLayout';
import { parkingSlabs } from '../src/office/scene/CampusParking';

const BAY = { depth: PARKING.bayDepth, width: PARKING.bayWidth };
/** Paved courts the bays must stay inside (west: the original slab; east: the Blender lot inside its kerbs). */
const COURT = { west: { x0: PARKING.west, x1: PARKING.east, z0: PARKING.north, z1: PARKING.south }, east: { x0: 39.3, x1: 51.6, z0: -25.2, z1: 24 } } as const;
type Bay = ParkingLot['bays'][number];
/** Bay footprint: `depth` along the car's facing axis (yaw), `width` across it. */
function bayRect(bay: Bay) {
  const alongX = Math.abs(Math.sin(bay.yaw)) > .5;
  const hx = (alongX ? BAY.depth : BAY.width) / 2, hz = (alongX ? BAY.width : BAY.depth) / 2;
  return { x0: bay.x - hx, x1: bay.x + hx, z0: bay.z - hz, z1: bay.z + hz };
}
function segmentDistance(p: readonly [number, number], a: readonly [number, number], b: readonly [number, number]) {
  const dx = b[0] - a[0], dz = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
}
const polylineDistance = (p: readonly [number, number], line: readonly (readonly [number, number])[]) =>
  Math.min(...line.slice(1).map((point, i) => segmentDistance(p, line[i]!, point)));

describe('shared campus parking lots (Blender layout markers)', () => {
  it('exports exactly the shared contract shape for the west and east lots', () => {
    expect(PARKING_LOTS.map(lot => lot.id)).toEqual(['west', 'east']);
    for (const lot of PARKING_LOTS) {
      expect(Object.keys(lot).sort()).toEqual(['aisle', 'bays', 'entry', 'id', 'laneId', 'top']);
      expect(Object.keys(lot.entry).sort()).toEqual(['from', 'throat']);
      for (const bay of lot.bays) expect(Object.keys(bay).sort()).toEqual(['ev', 'id', 'x', 'yaw', 'z']);
      expect(lot.top).toBe(PARKING.top);
      expect(Object.isFrozen(lot) && Object.isFrozen(lot.bays)).toBe(true);
      expect(new Set(lot.bays.map(bay => bay.id)).size).toBe(lot.bays.length);
    }
    expect(parkingLot('east').bays).toHaveLength(14);
    expect(new Set(ALL_PARKING_BAYS.map(bay => bay.id)).size).toBe(32);
  });

  it('keeps the migrated west lot exactly where it was', () => {
    const before = [-10.2, -7, -3.8, -.6, 2.6, 5.8, 9, 12.2, 15.4].flatMap((z, index) => ([-1, 1] as const).map(side => ({
      id: `parking-${side}-${index}`, x: side < 0 ? -47.25 : -37.75, z, yaw: side < 0 ? Math.PI / 2 : -Math.PI / 2,
      ev: side < 0 && index >= 6, occupied: (index + (side > 0 ? 2 : 0)) % 3 !== 1,
    })));
    expect(parkingLot('west').bays).toEqual(before.map(({ occupied: _occupied, ...bay }) => bay));
    expect(PARKING_BAYS.map(({ lot: _lot, ...bay }) => bay)).toEqual(before);
    expect(PARKING_LIGHTS.map(pole => ({ ...pole }))).toEqual([-13, 3, 18].flatMap(z => [
      { id: `parking-west-${z}`, x: -51, z, poolX: -46.8 }, { id: `parking-east-${z}`, x: -34.2, z, poolX: -38.4 }]));
    expect(EV_CHARGERS.filter(charger => charger.x < 0).map(({ id, x, z, yaw }) => ({ id, x, z, yaw })))
      .toEqual(before.filter(bay => bay.ev).map(bay => ({ id: `charger-${bay.id}`, x: -50.45, z: bay.z, yaw: Math.PI / 2 })));
  });

  it('keeps every bay inside its lot, without overlaps, and reachable from the aisle', () => {
    for (const lot of PARKING_LOTS) {
      const court = COURT[lot.id], rects = lot.bays.map(bayRect);
      rects.forEach((rect, i) => {
        expect(rect.x0, lot.bays[i]!.id).toBeGreaterThanOrEqual(court.x0 - 1e-9);
        expect(rect.x1, lot.bays[i]!.id).toBeLessThanOrEqual(court.x1 + 1e-9);
        expect(rect.z0, lot.bays[i]!.id).toBeGreaterThanOrEqual(court.z0 - 1e-9);
        expect(rect.z1, lot.bays[i]!.id).toBeLessThanOrEqual(court.z1 + 1e-9);
        rects.slice(i + 1).forEach(other => {
          const overlap = Math.min(rect.x1, other.x1) - Math.max(rect.x0, other.x0) > 1e-6 && Math.min(rect.z1, other.z1) - Math.max(rect.z0, other.z0) > 1e-6;
          expect(overlap).toBe(false);
        });
      });
      for (const bay of lot.bays) {
        // The car faces the aisle (reverse-parked): its nose edge opens onto the aisle centreline.
        const nose = [bay.x + Math.sin(bay.yaw) * BAY.depth / 2, bay.z + Math.cos(bay.yaw) * BAY.depth / 2] as const;
        expect(polylineDistance(nose, lot.aisle), bay.id).toBeLessThan(3.2);
        // The way from the bay centre to the aisle crosses no other bay.
        const target = [nose[0] + Math.sin(bay.yaw) * 2, nose[1] + Math.cos(bay.yaw) * 2] as const;
        for (const [j, rect] of rects.entries()) if (lot.bays[j] !== bay) {
          for (let t = 0; t <= 1; t += .05) {
            const x = bay.x + (target[0] - bay.x) * t, z = bay.z + (target[1] - bay.z) * t;
            expect(x > rect.x0 + 1e-6 && x < rect.x1 - 1e-6 && z > rect.z0 + 1e-6 && z < rect.z1 - 1e-6).toBe(false);
          }
        }
      }
      // The aisle starts at the throat and stays on the paved court or the access apron.
      expect(lot.aisle[0]).toEqual(lot.entry.throat);
      for (const point of lot.aisle) expect(insideParkingFootprint(point[0], point[1])).toBe(true);
    }
  });

  it('joins each entry to an adjacent avenue lane with left turns, clear of junction crosswalks and the walk ramps', () => {
    for (const lot of PARKING_LOTS) {
      const lane = TRAFFIC_LANES.find(entry => entry.id === lot.laneId)!;
      expect(lane, lot.id).toBeDefined();
      expect(lane.crossing).toBe(false);
      const [fx, fz] = lot.entry.from, [tx, tz] = lot.entry.throat;
      // `from` lies on the lane centre, between its ends; the access is straight and perpendicular to the lane.
      expect(segmentDistance(lot.entry.from, lane.from, lane.to)).toBeLessThan(1e-9);
      expect(fz).toBe(tz);
      expect(Math.sign(fx)).toBe(Math.sign(tx));
      // Inner lane, nearest the campus; arrival and departure are both left turns (left-hand traffic).
      expect(Math.abs(fx)).toBeCloseTo(58.35);
      const laneDir = [Math.sign(lane.to[0] - lane.from[0]), Math.sign(lane.to[1] - lane.from[1])] as const;
      const inward = [Math.sign(tx - fx), 0] as const;
      const left = (d: readonly [number, number]) => [d[1] + 0, -d[0] + 0] as const;
      expect(left(laneDir)).toEqual(inward);
      expect(left([-inward[0], 0])).toEqual([0, laneDir[1]]);
      // Far from the avenue junction crosswalks (z = -60 ± 6.5) and beside, not across, the z = -35 walk ramp.
      expect(Math.abs(fz + 60)).toBeGreaterThan(6.5 + 3 + PARKING_ACCESS.halfWidth);
      expect(Math.abs(fz + 35) - PARKING_ACCESS.halfWidth - PARKING_ACCESS.returnRadius).toBeGreaterThan(2.4);
    }
  });

  it('gives EV bays EVs and a charger at the bay head, and fits every parked car inside its bay', () => {
    for (const lot of PARKING_LOTS) {
      const ev = lot.bays.filter(bay => bay.ev);
      expect(ev, lot.id).toHaveLength(3);
      expect(PARKING_LOT_CHARGERS[lot.id].map(charger => charger.z)).toEqual(ev.map(bay => bay.z));
      for (const charger of PARKING_LOT_CHARGERS[lot.id]) {
        const bay = ev.find(entry => entry.z === charger.z)!;
        // Behind the bay's rear edge (the head), beyond the reverse-parked car's tail.
        const rear = bay.x - Math.sin(bay.yaw) * BAY.depth / 2;
        expect(Math.sign(charger.x - rear)).toBe(-Math.sign(Math.sin(bay.yaw)));
        expect(Math.abs(charger.x - rear)).toBeLessThan(1);
      }
    }
    const bays = new Map(ALL_PARKING_BAYS.map(bay => [bay.id, bay]));
    for (const car of PARKED_VEHICLES) {
      const bay = bays.get(car.id)!;
      if (!isMobilityVehicle(car.model)) throw new Error('Parking requires a vehicle');
      if (bay.ev) expect(vehicleCategory(car.model)).toBe('ev');
      const spec = VEHICLE_SPECS[car.model]!;
      const rect = bayRect(bay), court = COURT[bay.lot];
      expect(car.x + spec.length / 2).toBeLessThan(court.x1 + .4);
      expect(car.x - spec.length / 2).toBeGreaterThan(court.x0 - .4);
      expect(car.z - spec.width / 2).toBeGreaterThan(rect.z0 - .1);
      expect(car.z + spec.width / 2).toBeLessThan(rect.z1 + .1);
      for (const charger of EV_CHARGERS) expect(Math.hypot(charger.x - car.x, charger.z - car.z)).toBeGreaterThan(spec.length / 2 - .1);
    }
    expect(PARKED_VEHICLES.filter(car => bays.get(car.id)!.lot === 'east').length).toBeGreaterThanOrEqual(8);
  });

  it('places four to six east lamp posts clear of bays, chargers, parked cars and the aisle', () => {
    const lamps = PARKING_LOT_LAMPS.east, lot = parkingLot('east');
    expect(lamps.length).toBeGreaterThanOrEqual(4);
    expect(lamps.length).toBeLessThanOrEqual(6);
    for (const lamp of lamps) {
      expect(insideParkingFootprint(lamp.x, lamp.z)).toBe(true);
      for (const bay of lot.bays) { const r = bayRect(bay); expect(lamp.x > r.x0 - .15 && lamp.x < r.x1 + .15 && lamp.z > r.z0 && lamp.z < r.z1).toBe(false); }
      for (const charger of EV_CHARGERS) expect(Math.hypot(lamp.x - charger.x, lamp.z - charger.z)).toBeGreaterThan(1);
      for (const car of PARKED_VEHICLES) expect(Math.hypot(lamp.x - car.x, lamp.z - car.z)).toBeGreaterThan(3);
      expect(polylineDistance([lamp.x, lamp.z], lot.aisle)).toBeGreaterThan(4);
    }
  });

  it('describes one continuous access surface from the lot top to the road top', () => {
    const { throat, bandStart, roadEdge, top, walkTop, roadTop } = PARKING_ACCESS;
    expect(accessSurfaceY(throat)).toBe(top);
    expect(accessSurfaceY(bandStart)).toBeCloseTo(walkTop, 9);
    expect(accessSurfaceY(roadEdge)).toBeCloseTo(roadTop, 9);
    let steepest = 0;
    for (let u = throat - 2; u < roadEdge + 2; u += .01) {
      const step = Math.abs(accessSurfaceY(u + .01) - accessSurfaceY(u));
      steepest = Math.max(steepest, step / .01);
      expect(step).toBeLessThan(.002); // no steps anywhere
    }
    expect(steepest).toBeLessThan(.1);
    for (const lot of PARKING_LOTS) {
      expect(parkingSurfaceY(lot, ...lot.entry.throat)).toBe(lot.top);
      expect(parkingSurfaceY(lot, ...lot.entry.from)).toBe(roadTop);
      expect(parkingSurfaceY(lot, lot.aisle.at(-1)![0], lot.aisle.at(-1)![1])).toBe(lot.top);
      const mid = (lot.entry.throat[0] + Math.sign(lot.entry.throat[0]) * bandStart) / 2;
      expect(parkingSurfaceY(lot, mid, lot.entry.throat[1])).toBeLessThan(top);
    }
  });

  it('cuts the plinth only where the ramps descend and keeps the west lot hardscape off the access apron', () => {
    expect(PARKING_ACCESS_NOTCHES).toHaveLength(2);
    const plinth = { x0: -52, x1: 52, z0: -47, z1: 47 };
    const pieces = rectsWithout(plinth, PARKING_ACCESS_NOTCHES);
    const area = (r: { x0: number; x1: number; z0: number; z1: number }) => (r.x1 - r.x0) * (r.z1 - r.z0);
    expect(pieces.reduce((sum, r) => sum + area(r), 0)).toBeCloseTo(area(plinth) - PARKING_ACCESS_NOTCHES.reduce((sum, r) => sum + area(r), 0), 6);
    for (const notch of PARKING_ACCESS_NOTCHES) for (const piece of pieces)
      expect(Math.min(notch.x1, piece.x1) - Math.max(notch.x0, piece.x0) > 1e-9 && Math.min(notch.z1, piece.z1) - Math.max(notch.z0, piece.z0) > 1e-9).toBe(false);
    // Runtime slabs stop where the Blender apron (z < -25.5) begins: no coplanar overlap, no z-fighting.
    for (const slab of parkingSlabs()) expect(slab.z - slab.d / 2).toBeGreaterThanOrEqual(-25.5 - 1e-9);
    expect(Object.keys(PARKING_FOOTPRINTS)).toEqual(['west', 'east']);
  });
});
