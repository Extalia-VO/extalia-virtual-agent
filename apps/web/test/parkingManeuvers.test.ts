import { describe, expect, it } from 'vitest';
import { mobilityLampPower } from '../src/office/scene/CampusTraffic';
import { PARKING_ACCESS, PARKING_FOOTPRINTS, PARKING_LOTS, type ParkingLot } from '../src/office/scene/campusParkingLots';
import { PARKED_VEHICLES, TRAFFIC_LANES, createTrafficPose, laneLength, vehicleCategory, type MobilityModel, type TrafficCarPose } from '../src/office/scene/campusMobilityLayout';
import {
  LOT_TIMING, MANEUVER_LOTS, arrivalShare, clearRoute, createParkingSim, footprintOf, footprintsOverlap, legPose, lotManeuverCap, lotModelCapacity, maneuverInterval,
  maneuverLamps, occupancyBounds, parkedAt, parkingDebug, stepParking, triggerManeuver, unmanagedParked,
  type Footprint, type ManeuverPose, type ParkingSim, type TrafficContext,
} from '../src/office/scene/parkingManeuvers';

const lot = MANEUVER_LOTS[0]!;
const laneIndex = TRAFFIC_LANES.findIndex(lane => lane.id === lot.laneId);
const lane = TRAFFIC_LANES[laneIndex]!;
const laneOf = (entry: ParkingLot) => TRAFFIC_LANES.find(candidate => candidate.id === entry.laneId)!;
const empty = (): TrafficContext => ({ poses: [], count: 0, seconds: 0, density: .6 });
const options = (minutes: number, density: number, traffic = empty(), cap = 2, reducedMotion = false) => ({ minutes, density, cap, reducedMotion, traffic });
const run = (sim: ParkingSim, seconds: number, opts: ReturnType<typeof options>, each?: (sim: ParkingSim) => void) => {
  for (let i = Math.round(seconds * 10); i > 0; i--) { stepParking(sim, .1, opts); each?.(sim); }
};
const occupied = (sim: ParkingSim, index = 0) => sim.lots[index]!.models.filter(Boolean).length;
const active = (sim: ParkingSim, index = 0) => sim.lots[index]!.maneuvers.filter(m => m.active);
const parkedFootprints = (except: number, entry: ParkingLot = lot): Footprint[] => PARKED_VEHICLES.filter(car => car.id !== entry.bays[except]!.id)
  .map(car => ({ x: car.x, z: car.z, yaw: car.yaw, ...footprintOf(car.model) }));
/** Aisle room beyond a bay (the aisle runs from the throat to its far end). */
const roomBeyond = (entry: ParkingLot, bay: { x: number; z: number }) => { const far = entry.aisle[entry.aisle.length - 1]!; return Math.abs(far[1] - bay.z); };

describe('parking-lot manoeuvres', () => {
  it('manages every parked car of both shared lots (none left static) and sizes per-style instances for arrivals', () => {
    expect(MANEUVER_LOTS).toBe(PARKING_LOTS);
    expect(MANEUVER_LOTS.map(entry => entry.id)).toEqual(['west', 'east']);
    expect(unmanagedParked()).toEqual([]);
    const sim = createParkingSim(20261030);
    expect(sim.lots.reduce((sum, _, index) => sum + occupied(sim, index), 0)).toBe(PARKED_VEHICLES.length);
    for (const state of sim.lots) expect(state.laneIndex).toBeGreaterThanOrEqual(0);
    const capacity = lotModelCapacity();
    for (const car of PARKED_VEHICLES) expect(capacity.get(car.model)!).toBeGreaterThan(PARKED_VEHICLES.filter(other => other.model === car.model).length);
  });

  it('schedules deterministically from the seed and the lot id, 20–60 s apart and busier at rush hour', () => {
    const log = (seed: number) => { const sim = createParkingSim(seed); run(sim, 1800, options(8 * 60, 1)); return sim.log; };
    expect(log(20261030)).toEqual(log(20261030));
    expect(log(20261030)).not.toEqual(log(20261031));
    for (let density = 0; density <= 1; density += .1) for (let u = 0; u <= 1; u += .05) {
      const interval = maneuverInterval(density, u);
      expect(interval).toBeGreaterThanOrEqual(LOT_TIMING.interval[0]);
      expect(interval).toBeLessThanOrEqual(LOT_TIMING.interval[1]);
      if (density >= .1) expect(interval).toBeLessThanOrEqual(maneuverInterval(density - .1, u) + 1e-9);
    }
    const decisions = (minutes: number, density: number) => { const sim = createParkingSim(7); run(sim, 3600, options(minutes, density)); return sim.log; };
    const rush = decisions(8 * 60, 1), night = decisions(2 * 60, .3);
    for (const events of [rush, night]) for (const id of ['west', 'east']) {
      const own = events.filter(event => event.lot === id);
      for (let i = 1; i < own.length; i++) expect(own[i]!.t - own[i - 1]!.t).toBeGreaterThanOrEqual(LOT_TIMING.interval[0] - 1e-6);
    }
    expect(rush.length).toBeGreaterThan(night.length * 1.3);
    expect(arrivalShare(8 * 60)).toBeGreaterThan(.5);
    expect(arrivalShare(18 * 60)).toBeLessThan(.5);
  });

  it('keeps each lot between its occupancy bounds (never empty, never full) through morning arrivals and evening departures', () => {
    for (const minutes of [8 * 60, 18 * 60, 13 * 60]) {
      const sim = createParkingSim(20261030 + minutes);
      let arrivals = 0, departures = 0;
      run(sim, 3 * 3600, options(minutes, 1), s => s.lots.forEach((state, index) => {
        const [min, max] = occupancyBounds(state.lot.bays.length);
        expect(min).toBeGreaterThan(0);
        expect(max).toBeLessThan(state.lot.bays.length);
        const count = occupied(s, index);
        expect(count).toBeGreaterThanOrEqual(min - 1);
        expect(count).toBeLessThanOrEqual(max + 1);
        expect(count).toBeGreaterThan(0);
        expect(count).toBeLessThan(state.lot.bays.length);
      }));
      expect(new Set(sim.log.filter(event => event.started).map(event => event.lot))).toEqual(new Set(['west', 'east']));
      for (const event of sim.log) if (event.started) { if (event.kind === 'arrive') arrivals++; else departures++; }
      if (minutes === 8 * 60) expect(arrivals).toBeGreaterThan(0);
      if (minutes === 18 * 60) expect(departures).toBeGreaterThan(0);
    }
  }, 60_000);

  it.each(PARKING_LOTS.map(entry => [entry.id, entry] as const))('drives continuous %s routes: bay to lane end and lane start to bay, heading on the tangent, height on the drawn ramp', (_, lot) => {
    const lane = laneOf(lot);
    let checked = 0;
    lot.bays.forEach((bay, index) => {
      for (const kind of ['depart', 'arrive'] as const) {
        const route = clearRoute({ lot, lane }, index, kind, 'mobility-sedan', parkedFootprints(index, lot));
        // Only the deepest bays lack the room to pull past and reverse in.
        if (!route) { expect(kind).toBe('arrive'); expect(roomBeyond(lot, bay)).toBeLessThan(LOT_TIMING.minTurn); continue; }
        checked++;
        route.legs.forEach((leg, l) => {
          for (let i = 1; i < leg.count; i++) {
            expect(Math.hypot(leg.x[i]! - leg.x[i - 1]!, leg.z[i]! - leg.z[i - 1]!)).toBeLessThan(.3);
            expect(Math.abs(Math.atan2(Math.sin(leg.yaw[i]! - leg.yaw[i - 1]!), Math.cos(leg.yaw[i]! - leg.yaw[i - 1]!)))).toBeLessThan(.2);
          }
          // Legs join where the car stops to change gear.
          const next = route.legs[l + 1];
          if (next) { expect(Math.hypot(next.x[0]! - leg.x[leg.count - 1]!, next.z[0]! - leg.z[leg.count - 1]!)).toBeLessThan(1e-3); expect(next.gear).toBe(-leg.gear as 1 | -1); }
        });
        const first = route.legs[0]!, last = route.legs[route.legs.length - 1]!;
        const start = legPose(first, 0), end = legPose(last, last.length);
        const yawGap = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
        if (kind === 'depart') {
          expect(Math.hypot(start.x - bay.x, start.z - bay.z)).toBeLessThan(1e-3);
          expect(yawGap(start.yaw, bay.yaw)).toBeLessThan(.02);
          expect(Math.hypot(end.x - lane.to[0], end.z - lane.to[1])).toBeLessThan(1e-3);
          expect(last.exit).toBe(true);
          expect(end.y).toBeCloseTo(lane.top, 5);
          expect(start.y).toBeCloseTo(lot.top, 5);
          // Give way short of the carriageway, then align with the lane.
          expect(route.holdS).toBeGreaterThan(0);
          expect(route.joinS).toBeGreaterThan(route.holdS);
        } else {
          expect(Math.hypot(start.x - lane.from[0], start.z - lane.from[1])).toBeLessThan(1e-3);
          expect(Math.hypot(end.x - bay.x, end.z - bay.z)).toBeLessThan(1e-3);
          expect(yawGap(end.yaw, bay.yaw)).toBeLessThan(.02);
          expect(start.y).toBeCloseTo(lane.top, 5);
          expect(end.y).toBeCloseTo(lot.top, 5);
        }
        // The access ramp: height between road and lot top, changing gently, level inside the lot.
        for (const leg of route.legs) for (let i = 1; i < leg.count; i++) {
          expect(leg.y[i]!).toBeGreaterThanOrEqual(Math.min(lot.top, lane.top) - 1e-6);
          expect(leg.y[i]!).toBeLessThanOrEqual(Math.max(lot.top, lane.top) + 1e-6);
          expect(Math.abs(leg.y[i]! - leg.y[i - 1]!)).toBeLessThan(.05);
          const outward = Math.sign(lot.entry.from[0] - lot.entry.throat[0]) * (leg.x[i]! - lot.entry.throat[0]);
          if (outward <= 0) expect(leg.y[i]!).toBeCloseTo(lot.top, 6);
        }
        // Keep left on the access drive: exits on one side of its centre line, entries on the other.
        const access = route.legs[kind === 'depart' ? route.legs.length - 1 : 0]!;
        for (let i = 0; i < access.count; i++) {
          const outward = Math.sign(lot.entry.from[0] - lot.entry.throat[0]) * (access.x[i]! - lot.entry.throat[0]);
          if (outward < 1 || Math.abs(access.x[i]!) > PARKING_ACCESS.bandStart || Math.abs(access.z[i]! - lot.entry.throat[1]) > PARKING_ACCESS.halfWidth + 2) continue;
          const side = (access.z[i]! - lot.entry.throat[1]) * Math.sign(lot.entry.throat[0]) * (kind === 'depart' ? -1 : 1);
          expect(side).toBeGreaterThan(.9);
          expect(Math.abs(access.z[i]! - lot.entry.throat[1])).toBeLessThan(PARKING_ACCESS.halfWidth - .9);
        }
        // Back-in bays (parked facing the aisle): arrivals reverse in, departures drive straight out.
        expect(route.legs.map(leg => leg.gear)).toEqual(kind === 'depart' ? [1] : [1, -1]);
      }
    });
    expect(checked).toBeGreaterThanOrEqual(lot.bays.length * 2 - 2);
  });

  it('never touches a parked car on the way in or out', () => {
    for (const lot of PARKING_LOTS) lot.bays.forEach((_, index) => {
      for (const kind of ['depart', 'arrive'] as const) for (const model of ['mobility-sedan', 'mobility-suv-family', 'mobility-hatchback'] as MobilityModel[]) {
        const parked = parkedFootprints(index, lot);
        const route = clearRoute({ lot, lane: laneOf(lot) }, index, kind, model, parked);
        if (!route) continue;
        const car = { x: 0, z: 0, yaw: 0, ...footprintOf(model) };
        for (const leg of route.legs) for (let i = 0; i < leg.count; i++) {
          car.x = leg.x[i]!; car.z = leg.z[i]!; car.yaw = leg.yaw[i]!;
          for (const other of parked) expect(footprintsOverlap(car, other)).toBe(false);
        }
      }
    });
    // A route through a bay's neighbour is refused.
    const blocked = clearRoute({ lot, lane }, 2, 'depart', 'mobility-sedan', [{ x: -42.5, z: -8, yaw: 0, half: 2.3, halfWidth: 1 }]);
    expect(blocked).toBeNull();
  });

  it('keeps every car body on the drivable surface: lot court, aisle apron, access drive and the near lane', () => {
    type Rect = { x0: number; x1: number; z0: number; z1: number };
    // Drivable asphalt: the west footprints are all paved; the east footprint also holds the garden footway
    // (x < 39.3) and the north planter (z > 24), so its court is the asphalt slab of the Blender layout.
    const courts: Record<ParkingLot['id'], readonly Rect[]> = {
      west: PARKING_FOOTPRINTS.west,
      east: [{ x0: 39.3, x1: 51.6, z0: -31.5, z1: 24 }],
    };
    for (const lot of PARKING_LOTS) {
      const side = Math.sign(lot.entry.throat[0]), z = lot.entry.throat[1], { halfWidth, returnRadius, plinthEdge, roadEdge } = PARKING_ACCESS;
      const lanes = TRAFFIC_LANES.filter(candidate => candidate.id === lot.laneId);
      const drivable: Rect[] = [...courts[lot.id],
        // Access drive (throat to the carriageway edge; the kerb returns flare at the road) and the inner avenue lane.
        { x0: side < 0 ? -roadEdge : lot.entry.throat[0], x1: side < 0 ? lot.entry.throat[0] : roadEdge, z0: z - halfWidth, z1: z + halfWidth },
        { x0: side < 0 ? -roadEdge : plinthEdge, x1: side < 0 ? -plinthEdge : roadEdge, z0: z - halfWidth - returnRadius, z1: z + halfWidth + returnRadius },
        ...lanes.map(l => ({ x0: Math.min(l.from[0], l.to[0]) - 1.85, x1: Math.max(l.from[0], l.to[0]) + 1.85, z0: Math.min(l.from[1], l.to[1]) - 3.5, z1: Math.max(l.from[1], l.to[1]) + 3.5 }))];
      const inside = (x: number, zz: number) => drivable.some(r => x >= r.x0 - .2 && x <= r.x1 + .2 && zz >= r.z0 - .2 && zz <= r.z1 + .2);
      lot.bays.forEach((_, index) => {
        for (const kind of ['depart', 'arrive'] as const) for (const model of ['mobility-sedan', 'mobility-suv-large', 'mobility-hatchback'] as MobilityModel[]) {
          const route = clearRoute({ lot, lane: laneOf(lot) }, index, kind, model, parkedFootprints(index, lot));
          if (!route) continue;
          const { half, halfWidth: w } = footprintOf(model);
          for (const leg of route.legs) for (let i = 0; i < leg.count; i++) {
            const yaw = leg.yaw[i]!, fx = Math.sin(yaw), fz = Math.cos(yaw);
            for (const [a, b] of [[half, w], [half, -w], [-half, w], [-half, -w], [0, 0]] as const) {
              const x = leg.x[i]! + fx * a + fz * b, zz = leg.z[i]! + fz * a - fx * b;
              if (!inside(x, zz)) throw new Error(`${lot.id} ${lot.bays[index]!.id} ${kind} ${model}: (${x.toFixed(2)}, ${zz.toFixed(2)}) off the drivable surface`);
            }
          }
        }
      });
    }
  });

  it('parks only electric styles in charging bays', () => {
    const sim = createParkingSim(99);
    run(sim, 6 * 3600, options(8 * 60, 1));
    const arrivals = sim.log.filter(event => event.started && event.kind === 'arrive');
    expect(arrivals.length).toBeGreaterThan(5);
    const bays = PARKING_LOTS.flatMap(entry => entry.bays);
    for (const event of arrivals) if (bays.find(bay => bay.id === event.bay)!.ev) expect(vehicleCategory(event.model)).toBe('ev');
    expect(arrivals.some(event => bays.find(bay => bay.id === event.bay)!.ev)).toBe(true);
    for (const state of sim.lots) state.models.forEach((model, bay) => { if (model && state.lot.bays[bay]!.ev) expect(vehicleCategory(model)).toBe('ev'); });
    // Within capacity per style (instance batches are sized for it).
    for (const [model, count] of sim.counts) expect(count).toBeLessThanOrEqual(sim.capacity.get(model)!);
  });

  it('gives way at the lot exit until the lane is clear, stopping short of the carriageway', () => {
    const sim = createParkingSim(20261030);
    const traffic: TrafficCarPose = { ...createTrafficPose(), id: 5, lane: laneIndex, model: 'mobility-sedan', visible: true };
    const route = sim.lots[0]!;
    const context: TrafficContext = { poses: [traffic], count: 1, seconds: 0, density: .6 };
    expect(triggerManeuver(sim, 'west', 'depart', lot.bays[0]!.id)).toBe(true);
    const m = route.maneuvers.find(x => x.active)!;
    const junction = m.route!.mergeLane;
    // A car keeps sitting just upstream of the junction (e.g. queued): the lot car must wait.
    traffic.distance = junction - 12;
    traffic.x = lane.from[0]; traffic.z = lane.from[1] + traffic.distance;
    run(sim, 40, options(13 * 60, .6, context, 0));
    const pose = m.pose;
    expect(m.active).toBe(true);
    expect(pose.phase).toBe('merging');
    expect(pose.waiting).toBe(true);
    expect(m.v).toBe(0);
    // Front bumper short of the carriageway edge and the painted give-way line (0.32 m inside it).
    const front = { x: pose.x + Math.sin(pose.yaw) * m.half, z: pose.z + Math.cos(pose.yaw) * m.half };
    expect(Math.abs(front.x - lane.from[0])).toBeGreaterThan(LOT_TIMING.roadEdge);
    expect(Math.abs(front.x)).toBeLessThan(PARKING_ACCESS.roadEdge - .32);
    expect(Math.abs(front.x)).toBeGreaterThan(PARKING_ACCESS.roadEdge - 1.2);
    expect(Math.abs(lane.from[0]) - PARKING_ACCESS.roadEdge).toBeCloseTo(LOT_TIMING.roadEdge, 6);
    expect(pose.lit).toBe(1);
    expect(pose.stopped).toBe(true);
    // An arrival cannot enter while the exit holds the access drive, nor while a car approaches the lane start.
    expect(triggerManeuver(sim, 'west', 'arrive', undefined, context)).toBe(false);
    // The lane clears: the car merges, reaches lane speed and leaves at the lane end.
    traffic.visible = false;
    let maxSpeed = 0;
    run(sim, 40, options(13 * 60, .6, context, 0), () => { if (m.active) maxSpeed = Math.max(maxSpeed, m.v); });
    expect(maxSpeed).toBeCloseTo(lane.speed, 5);
    expect(m.active).toBe(false);
    expect(parkedAt(route, 0)).toBeNull();
  });

  it('switches lamps on before moving, keeps them on while driving, shows reverse and brake lamps and turns them off after parking', () => {
    // Pure timeline.
    expect(maneuverLamps('parked', 0, false)).toEqual({ on: false, brake: false, reverse: false });
    expect(maneuverLamps('starting', .2, false)).toEqual({ on: true, brake: true, reverse: false });
    expect(maneuverLamps('reversing', 1, false)).toEqual({ on: true, brake: false, reverse: true });
    expect(maneuverLamps('reversing', 1, true)).toEqual({ on: true, brake: true, reverse: true });
    expect(maneuverLamps('driving', 1, false)).toEqual({ on: true, brake: false, reverse: false });
    expect(maneuverLamps('parking', .1, false)).toEqual({ on: true, brake: true, reverse: false });
    expect(maneuverLamps('parking', .38, false).brake).toBe(false);
    expect(maneuverLamps('parking', .6, false).brake).toBe(true);
    expect(maneuverLamps('parking', LOT_TIMING.lightsOff, false)).toEqual({ on: false, brake: false, reverse: false });

    // Departure: lamps on at engine start, the car holds still for `engineStart` seconds.
    const sim = createParkingSim(20261030);
    const bay = lot.bays[0]!;
    expect(triggerManeuver(sim, 'west', 'depart', bay.id)).toBe(true);
    const m = sim.lots[0]!.maneuvers.find(x => x.active)!;
    const timeline: { t: number; pose: ManeuverPose; moved: number }[] = [];
    let t = 0;
    run(sim, 6, options(13 * 60, .6, empty(), 0), () => { t += .1; timeline.push({ t, pose: { ...m.pose }, moved: Math.hypot(m.pose.x - bay.x, m.pose.z - bay.z) }); });
    for (const entry of timeline.filter(e => e.t < LOT_TIMING.engineStart - .05)) {
      expect(entry.pose.lit).toBe(1); expect(entry.pose.phase).toBe('starting'); expect(entry.moved).toBeLessThan(1e-6); expect(entry.pose.stopped).toBe(true);
    }
    const firstMove = timeline.find(e => e.moved > 1e-4)!;
    expect(firstMove.t).toBeGreaterThanOrEqual(LOT_TIMING.engineStart);
    expect(timeline.filter(e => e.t >= firstMove.t).every(e => e.pose.lit === 1)).toBe(true);

    // Arrival into a back-in bay: lamps on, reverse lamp while reversing, brake flash and lamps off a second after parking.
    const arrival = createParkingSim(20261030);
    const free = lot.bays.findIndex((b, i) => !arrival.lots[0]!.models[i] && !b.ev && b.z < 12);
    expect(triggerManeuver(arrival, 'west', 'arrive', lot.bays[free]!.id)).toBe(true);
    const a = arrival.lots[0]!.maneuvers.find(x => x.active)!;
    const phases: { phase: string; lit: number; reverse: boolean; stopped: boolean; distance: number; speed: number }[] = [];
    run(arrival, 120, options(13 * 60, .6, empty(), 0), () => { if (a.active) phases.push({ phase: a.pose.phase, lit: a.pose.lit, reverse: a.pose.reverse, stopped: a.pose.stopped, distance: a.pose.distance, speed: a.pose.speed }); });
    expect(a.active).toBe(false);
    expect(arrival.lots[0]!.models[free]).not.toBeNull();
    expect(parkedAt(arrival.lots[0]!, free)).toBe(arrival.lots[0]!.models[free]);
    const reversing = phases.filter(p => p.phase === 'reversing');
    expect(reversing.length).toBeGreaterThan(10);
    expect(reversing.every(p => p.reverse && p.lit === 1)).toBe(true);
    expect(phases.filter(p => p.phase !== 'reversing').every(p => !p.reverse)).toBe(true);
    expect(phases.filter(p => p.phase === 'arriving').every(p => p.lit === 1)).toBe(true);
    // Wheels roll backwards while reversing (signed odometer).
    const rev = reversing.filter(p => p.speed < 0);
    expect(rev.length).toBeGreaterThan(5);
    expect(rev[rev.length - 1]!.distance).toBeLessThan(rev[0]!.distance);
    const parking = phases.filter(p => p.phase === 'parking');
    expect(parking.length).toBeGreaterThan(5);
    expect(parking.some(p => p.stopped) && parking.some(p => !p.stopped)).toBe(true);
    expect(parking.length * .1).toBeLessThanOrEqual(LOT_TIMING.lightsOff + .15);
    expect(arrival.lots[0]!.maneuvers.every(x => !x.pose.visible && x.pose.lit === 0)).toBe(true);

    // Night, day and the light control scale the lot car's lamps like traffic; parked cars stay dark.
    const model = a.model;
    expect(mobilityLampPower(model, 1, 'auto', true)).toBe(1);
    expect(mobilityLampPower(model, 0, 'auto', true)).toBe(0);
    expect(mobilityLampPower(model, 0, 'on', true)).toBe(1);
    expect(mobilityLampPower(model, 1, 'off', true)).toBe(0);
    expect(mobilityLampPower(model, 1, 'auto', false)).toBe(0);
  });

  it('caps concurrent manoeuvres per tier, lets only one car use the aisle at a time and settles under reduced motion', () => {
    expect(lotManeuverCap(16)).toBe(2);
    expect(lotManeuverCap(6)).toBe(1);
    for (const cap of [1, 2]) {
      const sim = createParkingSim(3);
      run(sim, 3600, options(8 * 60, 1, empty(), cap), s => {
        const moving = active(s);
        expect(moving.length).toBeLessThanOrEqual(cap);
        // One car at most between the bays and the lane (others wait with the engine running or are out on the lane).
        const inLot = moving.filter(m => m.phase !== 'starting' && m.phase !== 'parking' && m.pose.onLane < 0);
        expect(inLot.length).toBeLessThanOrEqual(1);
      });
    }
    const sim = createParkingSim(20261030);
    triggerManeuver(sim, 'west', 'depart', lot.bays[0]!.id);
    run(sim, 3, options(13 * 60, .6));
    expect(active(sim).length).toBeGreaterThan(0);
    const before = occupied(sim);
    run(sim, 600, options(8 * 60, 1, empty(), 2, true));
    expect(active(sim)).toHaveLength(0);
    expect(sim.lots[0]!.maneuvers.every(m => !m.pose.visible)).toBe(true);
    expect(occupied(sim)).toBe(before - 1);
    expect(parkingDebug(sim)[0]!.cars.every(car => car!.state === 'parked')).toBe(true);
  });

  it('uses the lot lane geometry: the junction lies on the lane and the lane length bounds the exit', () => {
    const route = clearRoute({ lot, lane }, 0, 'depart', 'mobility-sedan', parkedFootprints(0))!;
    expect(route.mergeLane).toBeGreaterThan(0);
    expect(route.mergeLane).toBeLessThan(laneLength(lane));
  });
});
