import { describe, expect, it } from 'vitest';
import {
  AVENUE_X, JUNCTION_SETBACK, LANE_OFFSET, ROAD_NETWORK, ROAD_RUNS, ROAD_TOP, STREET, VISIBLE_DISTRICT, ARRIVAL_CROSSWALK,
  onNeighborhoodRoad, onSkylineStreet, routeTable, turnPose,
} from '../src/office/scene/campusRoadNetwork';
import { DAILY_CATALOG, PARKED_VEHICLES, TRAFFIC_TIMING, VEHICLE_SPECS, dailyStyles, isMobilityVehicle } from '../src/office/scene/campusMobilityLayout';
import {
  MANEUVER_LOTS, adoptArrival, createParkingSim, stepParking, triggerManeuver, type ParkingSim, type TrafficContext,
} from '../src/office/scene/parkingManeuvers';
import {
  TRAFFIC_STEP, adoptCar, advanceTrafficNetwork, canAdoptCar, createTrafficNetwork, dispatchCar, planRoute, stepTrafficNetwork,
  type NetworkCar, type TrafficNetwork, type TrafficStepInput,
} from '../src/office/scene/trafficNetwork';

const CAR = DAILY_CATALOG.find(vehicle => !vehicle.trafficOnly)!.model;
const SEEDS = [20261030, 7];
const FULL: TrafficStepInput = { density: 1, cap: 16, headroom: 4 };
const STEP = 1 / 20;
const { lanes, turns, nodes } = ROAD_NETWORK;
const L = lanes.length;

/** True when a point lies on a road surface: a drawn neighborhood street or a skyline street. */
const onRoad = (x: number, z: number, margin = 0) => onNeighborhoodRoad(x, z, margin) || onSkylineStreet(x, z, margin);
const insideDistrict = (x: number, z: number, margin = 0) => x > VISIBLE_DISTRICT.minX - margin && x < VISIBLE_DISTRICT.maxX + margin
  && z > VISIBLE_DISTRICT.minZ - margin && z < VISIBLE_DISTRICT.maxZ + margin;

interface Box { x: number; z: number; yaw: number; hl: number; hw: number }
/** Separating-axis test of two oriented rectangles. */
function overlap(a: Box, b: Box): boolean {
  for (const yaw of [a.yaw, a.yaw + Math.PI / 2, b.yaw, b.yaw + Math.PI / 2]) {
    const ax = Math.sin(yaw), az = Math.cos(yaw);
    const project = (c: Box) => {
      const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
      const r = c.hl * Math.abs(fx * ax + fz * az) + c.hw * Math.abs(fz * ax - fx * az), m = c.x * ax + c.z * az;
      return [m - r, m + r] as const;
    };
    const [a0, a1] = project(a), [b0, b1] = project(b);
    if (a1 < b0 || b1 < a0) return false;
  }
  return true;
}
const boxOf = (net: TrafficNetwork, index: number): Box => {
  const pose = net.poses[index]!, spec = isMobilityVehicle(pose.model) ? VEHICLE_SPECS[pose.model] : undefined;
  return { x: pose.x, z: pose.z, yaw: pose.yaw, hl: (spec?.length ?? 4.8) / 2, hw: (spec?.width ?? 2) / 2 * .92 };
};

describe('road network graph', () => {
  it('connects every entry to an exit and uses every lane on some route', () => {
    expect(ROAD_NETWORK.entries.length).toBeGreaterThanOrEqual(6);
    expect(ROAD_NETWORK.exits.length).toBe(ROAD_NETWORK.entries.length);
    const tables = ROAD_NETWORK.exits.map(exit => routeTable(ROAD_NETWORK, exit));
    for (const entry of ROAD_NETWORK.entries) expect(tables.some(table => table.cost[entry]! < Infinity), lanes[entry]!.id).toBe(true);
    // A lane is used when some entry reaches it and it reaches some exit.
    const fromEntry = new Uint8Array(L);
    const stack = [...ROAD_NETWORK.entries];
    for (const entry of stack) fromEntry[entry] = 1;
    while (stack.length) for (const index of ROAD_NETWORK.turnsFrom[stack.pop()!]!) { const to = turns[index]!.to; if (!fromEntry[to]) { fromEntry[to] = 1; stack.push(to); } }
    for (const lane of lanes) {
      expect(fromEntry[lane.index], `${lane.id} reachable from an entry`).toBe(1);
      expect(tables.some(table => table.cost[lane.index]! < Infinity), `${lane.id} reaches an exit`).toBe(true);
    }
    // Every junction lane has a way on (no dead ends inside the network) and no U-turns.
    for (const lane of lanes) {
      if (lane.exit) expect(ROAD_NETWORK.turnsFrom[lane.index]).toHaveLength(0);
      else expect(ROAD_NETWORK.turnsFrom[lane.index]!.length).toBeGreaterThan(0);
    }
    for (const turn of turns) expect(lanes[turn.from]!.reverse).not.toBe(turn.to);
  });

  it('keeps lane endpoints on road surfaces and traffic boundaries outside the visible district', () => {
    for (const lane of lanes) {
      for (const [x, z] of [lane.from, lane.to]) expect(onRoad(x, z), `${lane.id} end ${x},${z}`).toBe(true);
      for (let s = 0; s <= lane.length; s += 1) expect(onRoad(lane.from[0] + lane.dx * s, lane.from[1] + lane.dz * s), `${lane.id} @${s}`).toBe(true);
    }
    for (const index of ROAD_NETWORK.entries) {
      const lane = lanes[index]!;
      expect(insideDistrict(lane.from[0], lane.from[1], VISIBLE_DISTRICT.margin), `${lane.id} entry`).toBe(false);
      expect(lane.top).not.toBe(ROAD_TOP);
    }
    for (const index of ROAD_NETWORK.exits) {
      const lane = lanes[index]!;
      expect(insideDistrict(lane.to[0], lane.to[1], VISIBLE_DISTRICT.margin), `${lane.id} exit`).toBe(false);
    }
    for (const node of nodes) expect(node.boundary).toBe(!insideDistrict(node.x, node.z));
    // Interior lanes stop short of the junction centres, clear of their zebra crossings.
    for (const lane of lanes) if (!lane.entry && !lane.exit) expect(lane.length).toBeGreaterThan(8);
    expect(JUNCTION_SETBACK).toBeGreaterThan(STREET / 2);
  });

  it('turns through junctions on arcs that stay inside the crossing roads, at plausible speeds', () => {
    const pose = { x: 0, z: 0, yaw: 0 };
    const kinds = new Set<string>();
    for (const turn of turns) {
      kinds.add(turn.kind);
      const a = lanes[turn.from]!, b = lanes[turn.to]!;
      expect(a.toNode).toBe(turn.node);
      expect(b.fromNode).toBe(turn.node);
      expect(turn.length).toBeGreaterThan(0);
      expect(turn.speed).toBeGreaterThan(2);
      expect(turn.speed).toBeLessThanOrEqual(Math.max(a.speed, b.speed));
      let previous = -1;
      for (let s = 0; s <= turn.length + 1e-9; s += turn.length / 12) {
        turnPose(turn, s, pose);
        expect(onRoad(pose.x, pose.z), `${a.id} → ${b.id} @${s.toFixed(1)}`).toBe(true);
        // Heading changes smoothly: the yaw never jumps between samples.
        if (previous !== -1) expect(Math.abs(Math.atan2(Math.sin(pose.yaw - previous), Math.cos(pose.yaw - previous)))).toBeLessThan(.9);
        previous = pose.yaw;
      }
      turnPose(turn, 0, pose);
      expect(Math.hypot(pose.x - a.to[0], pose.z - a.to[1])).toBeLessThan(1e-3);
      expect(Math.abs(Math.atan2(Math.sin(pose.yaw - Math.atan2(a.dx, a.dz)), Math.cos(pose.yaw - Math.atan2(a.dx, a.dz))))).toBeLessThan(1e-3);
      turnPose(turn, turn.length, pose);
      expect(Math.hypot(pose.x - b.from[0], pose.z - b.from[1])).toBeLessThan(1e-3);
    }
    expect(kinds).toEqual(new Set(['straight', 'left', 'right']));
  });

  it('marks crossing movements of a junction as conflicts and parallel ones as free', () => {
    for (const node of nodes) {
      const n = node.turns.length;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) expect(node.conflicts[i * n + j]).toBe(node.conflicts[j * n + i]);
      for (const index of node.turns) {
        const turn = turns[index]!;
        for (const other of node.turns) {
          const o = turns[other]!;
          // The two straight movements of one street, opposite ways, do not meet.
          if (turn.kind === 'straight' && o.kind === 'straight' && turn.from === lanes[o.from]!.reverse) expect(node.conflicts[turn.local * n + o.local]).toBe(0);
        }
      }
    }
    const crossing = nodes.find(node => !node.boundary && node.turns.length >= 8)!;
    expect(crossing.conflicts.some(value => value === 1)).toBe(true);
  });

  it('draws the front-road zebra crossing on the two front lanes passing the arrival crossing only', () => {
    const crossing = lanes.filter(lane => lane.crossing);
    expect(crossing.length).toBe(2);
    for (const lane of crossing) {
      expect(lane.road).toBe('front');
      const x = lane.from[0] + lane.dx * lane.crossAt;
      expect(x).toBeCloseTo(ARRIVAL_CROSSWALK.x);
    }
    expect(ROAD_RUNS.length).toBeGreaterThan(5);
    expect(AVENUE_X).toBe(60);
    expect(LANE_OFFSET).toBeGreaterThan(0);
  });
});

describe('traffic network simulation', () => {
  it('plans routes from every entry that end at an exit, with 2-4 junction decisions for cars', () => {
    const net = createTrafficNetwork(1);
    const out = new Int16Array(64);
    for (const entry of ROAD_NETWORK.entries) for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) for (const long of [false, true]) {
      const n = planRoute(net, entry, seed * 7919, out, long);
      expect(out[0]).toBe(entry);
      expect(lanes[out[n - 1]!]!.exit, `${lanes[entry]!.id} seed ${seed}`).toBe(true);
      for (let i = 0; i + 2 < n; i += 2) {
        const turn = turns[out[i + 1]! - L]!;
        expect([turn.from, turn.to]).toEqual([out[i], out[i + 2]]);
        if (long) expect(turn.kind).toBe('straight');
      }
    }
  });

  it('is deterministic: the same seed and steps give the same poses, a different seed does not', () => {
    const styles = dailyStyles(SEEDS[0]!);
    const run = (seed: number, chunks: number) => {
      const net = createTrafficNetwork(seed, styles);
      for (let i = 0; i < chunks; i++) advanceTrafficNetwork(net, 90 / chunks, FULL, TRAFFIC_STEP);
      return net.poses.slice(0, net.count).map(pose => [pose.id, pose.model, pose.tone, +pose.x.toFixed(5), +pose.z.toFixed(5), +pose.yaw.toFixed(5), pose.stopped]);
    };
    const first = run(5, 1);
    expect(first.length).toBeGreaterThan(0);
    expect(run(5, 1)).toEqual(first);
    expect(run(6, 1)).not.toEqual(first);
  });

  it('never lets two cars overlap and never leaves a car waiting for long, at several densities', () => {
    let peak = 0, visibleSteps = 0, steps = 0;
    for (const seed of SEEDS) for (const density of [1, .5]) {
      const net = createTrafficNetwork(seed, dailyStyles(seed));
      const input = { density, cap: 16, headroom: 4 };
      const still = new Map<number, number>();
      let longestWait = 0;
      for (let i = 0; i < 300 / STEP; i++) {
        stepTrafficNetwork(net, STEP, input);
        peak = Math.max(peak, net.count);
        for (let a = 0; a < net.count; a++) {
          const pose = net.poses[a]!, car = net.cars.find(entry => entry.active && entry.id === pose.id)!;
          const wait = car.v < .05 ? (still.get(pose.id) ?? 0) + STEP : 0;
          still.set(pose.id, wait);
          longestWait = Math.max(longestWait, wait);
          if (insideDistrict(pose.x, pose.z)) visibleSteps++;
          const boxA = boxOf(net, a);
          for (let b = a + 1; b < net.count; b++) if (overlap(boxA, boxOf(net, b))) throw new Error(`cars ${pose.id} and ${net.poses[b]!.id} overlap at ${(i * STEP).toFixed(2)} s (seed ${seed}, density ${density})`);
        }
        steps++;
      }
      expect(longestWait, `seed ${seed} density ${density}`).toBeLessThan(40);
    }
    expect(peak).toBeGreaterThan(6);
    expect(peak).toBeLessThanOrEqual(16);
    expect(visibleSteps / steps).toBeGreaterThan(1);
  });

  it('spawns and retires cars only beyond the visible district, with continuous motion in between', () => {
    const seed = SEEDS[0]!, net = createTrafficNetwork(seed, dailyStyles(seed));
    const last = new Map<number, { x: number; z: number; yaw: number }>();
    let spawned = 0, retired = 0, turned = 0;
    for (let i = 0; i < 400 / STEP; i++) {
      stepTrafficNetwork(net, STEP, FULL);
      const present = new Set<number>();
      for (let c = 0; c < net.count; c++) {
        const pose = net.poses[c]!;
        present.add(pose.id);
        const before = last.get(pose.id);
        if (!before) { spawned++; expect(insideDistrict(pose.x, pose.z, VISIBLE_DISTRICT.margin - 4), `spawn ${pose.x},${pose.z}`).toBe(false); }
        else {
          expect(Math.hypot(pose.x - before.x, pose.z - before.z)).toBeLessThan(10 * STEP * 1.2);
          const dyaw = Math.abs(Math.atan2(Math.sin(pose.yaw - before.yaw), Math.cos(pose.yaw - before.yaw)));
          expect(dyaw).toBeLessThan(.5);
          if (dyaw > .01) turned++;
        }
        last.set(pose.id, { x: pose.x, z: pose.z, yaw: pose.yaw });
      }
      for (const [id, pose] of last) if (!present.has(id)) {
        retired++;
        expect(insideDistrict(pose.x, pose.z, VISIBLE_DISTRICT.margin - 4), `retire ${pose.x},${pose.z}`).toBe(false);
        last.delete(id);
      }
    }
    expect(spawned).toBeGreaterThan(15);
    expect(retired).toBeGreaterThan(10);
    expect(turned).toBeGreaterThan(50);
  });

  it('sends cars through junctions in more than one direction', () => {
    const seed = SEEDS[0]!, net = createTrafficNetwork(seed, dailyStyles(seed));
    const kinds = new Set<string>(), roads = new Set<string>();
    for (let i = 0; i < 300 / STEP; i++) {
      stepTrafficNetwork(net, STEP, FULL);
      for (const car of net.cars) if (car.active) {
        const segment = car.route[car.k]!;
        if (segment >= L) kinds.add(turns[segment - L]!.kind); else roads.add(lanes[segment]!.road);
      }
    }
    expect(kinds).toEqual(new Set(['straight', 'left', 'right']));
    expect(roads.size).toBeGreaterThanOrEqual(5);
  });

  it('stops cars before the stop line of the front-road zebra crossing and queues followers behind them', () => {
    let stopped = 0;
    for (const seed of SEEDS) {
      const net = createTrafficNetwork(seed, dailyStyles(seed));
      for (let i = 0; i < 600 / STEP; i++) {
        stepTrafficNetwork(net, STEP, FULL);
        for (const car of net.cars) {
          if (!car.active) continue;
          const segment = car.route[car.k]!;
          if (segment >= L || !lanes[segment]!.crossing) continue;
          const lane = lanes[segment]!, front = car.s + car.half;
          // Front bumper never passes the stop line while still waiting for the pedestrians.
          if (!car.crossed) expect(front).toBeLessThanOrEqual(lane.crossAt - TRAFFIC_TIMING.stopLine + .6);
          if (car.v < .05 && !car.crossed) {
            stopped++;
            const behind = net.cars.find(other => other.active && other !== car && other.route[other.k] === segment && other.s < car.s && car.s - other.s < 9);
            if (behind) { expect(car.s - car.half - (behind.s + behind.half)).toBeGreaterThanOrEqual(TRAFFIC_TIMING.clearance - .3); }
          }
        }
      }
    }
    expect(stopped).toBeGreaterThan(5);
  });

  it('holds a queue behind a waiting car with the brake lamps on, and moves on after the crossing wait', () => {
    const net = createTrafficNetwork(3, dailyStyles(3));
    const lane = lanes.findIndex(entry => entry.crossing);
    expect(lane).toBeGreaterThanOrEqual(0);
    // Put a car on the crossing lane by adopting it just before the stop line.
    const at = lanes[lane]!.crossAt - TRAFFIC_TIMING.stopLine - 6;
    expect(adoptCar(net, lane, at, 6, { id: 900001, model: CAR, tone: '#fff', distance: 0 })).toBe(true);
    let braked = false, waited = 0, crossedAt = -1;
    for (let i = 0; i < 40 / STEP; i++) {
      stepTrafficNetwork(net, STEP, { density: 0, cap: 0, headroom: 4 });
      const car = net.cars.find(entry => entry.active && entry.id === 900001);
      if (!car) break;
      if (car.route[car.k] === lane && !car.crossed && car.v < .05) { braked ||= net.poses.find(pose => pose.id === 900001)!.stopped; waited += STEP; }
      if (car.crossed && crossedAt < 0) crossedAt = i * STEP;
    }
    expect(braked).toBe(true);
    expect(waited).toBeGreaterThan(TRAFFIC_TIMING.wait - 1);
    expect(waited).toBeLessThan(TRAFFIC_TIMING.wait + 3);
    expect(crossedAt).toBeGreaterThan(0);
  });
});

describe('parking lots on the network', () => {
  /** The lots wired to a network the way the scene does it: arrivals dispatched in, departures adopted. */
  function world(seed: number) {
    const parking: ParkingSim = createParkingSim(seed, MANEUVER_LOTS, PARKED_VEHICLES, DAILY_CATALOG);
    const input = { density: 1, cap: 16, headroom: 4, obstacles: parking.lots.flatMap(lot => lot.maneuvers.map(maneuver => maneuver.pose)) };
    const net = createTrafficNetwork(seed, DAILY_CATALOG, 24, { total: 16, headroom: 8 });
    net.arrive = (car: NetworkCar) => adoptArrival(parking, car.lot, { model: car.model, tone: car.tone, bay: car.bay, s: car.s, v: car.v, distance: car.odometer });
    const traffic: TrafficContext = {
      poses: net.poses, count: 0, seconds: 0, density: 1,
      canAdopt: model => canAdoptCar(net, model),
      adopt: (lane, along, speed, car) => adoptCar(net, lane, along, speed, car),
      dispatch: (lot, lane, model, tone, bay, u) => dispatchCar(net, lot, lane, model, tone, bay, u),
    };
    const options = { minutes: 8 * 60, density: 1, cap: 2, reducedMotion: false, traffic };
    const step = (dt: number) => {
      stepTrafficNetwork(net, dt, input);
      traffic.count = net.count; traffic.seconds += dt;
      stepParking(parking, dt, options);
    };
    return { parking, net, traffic, options, step };
  }

  it('brings arrivals in from a hidden entry to the lot and sends departures to a hidden exit', () => {
    const { parking, net, traffic, step } = world(SEEDS[0]!);
    // Force one departure and one arrival per lot now, then let the schedule run on.
    for (const lot of MANEUVER_LOTS) { triggerManeuver(parking, lot.id, 'depart', undefined, traffic); }
    const lotCars = new Map<number, { first: { x: number; z: number }; lot: number; last: { x: number; z: number } }>();
    const adopted = new Map<number, { x: number; z: number }>();
    const retiredAtExit: number[] = [];
    let handedOver = 0, dispatched = 0;
    const wasAdopted = new Set<number>();
    for (let i = 0; i < 900 / STEP && (handedOver < 2 || retiredAtExit.length < 2 || i < 120 / STEP); i++) {
      const before = new Map<number, { x: number; z: number; lot: number; fromLot: boolean }>();
      for (let c = 0; c < net.count; c++) {
        const pose = net.poses[c]!, car = net.cars.find(entry => entry.active && entry.id === pose.id)!;
        before.set(pose.id, { x: pose.x, z: pose.z, lot: car.lot, fromLot: car.fromLot });
      }
      step(STEP);
      const present = new Set<number>();
      for (let c = 0; c < net.count; c++) {
        const pose = net.poses[c]!, car = net.cars.find(entry => entry.active && entry.id === pose.id)!;
        present.add(pose.id);
        if (car.lot >= 0 && !lotCars.has(pose.id)) { dispatched++; lotCars.set(pose.id, { first: { x: pose.x, z: pose.z }, lot: car.lot, last: { x: pose.x, z: pose.z } }); }
        if (car.fromLot && car.lot < 0 && !wasAdopted.has(pose.id) && !lotCars.has(pose.id)) { wasAdopted.add(pose.id); adopted.set(pose.id, { x: pose.x, z: pose.z }); }
        const known = lotCars.get(pose.id); if (known) { known.last.x = pose.x; known.last.z = pose.z; }
      }
      for (const [id, was] of before) if (!present.has(id)) {
        if (was.lot >= 0) {
          handedOver++;
          const lotLane = lanes[parking.lots[was.lot]!.laneIndex]!;
          // Handed to the lot on its own lane, in view of the campus.
          expect(Math.hypot(was.x - (lotLane.from[0] + lotLane.to[0]) / 2, was.z - (lotLane.from[1] + lotLane.to[1]) / 2)).toBeLessThan(lotLane.length);
        } else if (wasAdopted.has(id) || was.fromLot) {
          retiredAtExit.push(id);
          expect(insideDistrict(was.x, was.z, VISIBLE_DISTRICT.margin - 4), `adopted car ${id} left at ${was.x},${was.z}`).toBe(false);
        }
      }
    }
    expect(dispatched).toBeGreaterThanOrEqual(1);
    for (const [id, car] of lotCars) expect(insideDistrict(car.first.x, car.first.z, VISIBLE_DISTRICT.margin - 4), `arrival ${id} appeared at ${car.first.x},${car.first.z}`).toBe(false);
    expect(handedOver).toBeGreaterThanOrEqual(1);
    expect(adopted.size).toBeGreaterThanOrEqual(1);
    expect(retiredAtExit.length).toBeGreaterThanOrEqual(1);
  });

  it('dispatches a car to a lot from a boundary entry and delivers it to the lot lane', () => {
    const net = createTrafficNetwork(11, DAILY_CATALOG, 24, { total: 16, headroom: 8 });
    const lot = MANEUVER_LOTS[0]!, lotLane = lanes.findIndex(lane => lane.id === lot.laneId);
    expect(lotLane).toBeGreaterThanOrEqual(0);
    let delivered: NetworkCar | undefined, first: { x: number; z: number } | undefined, entry = -1;
    net.arrive = car => { delivered = { ...car, route: car.route.slice() }; return true; };
    expect(dispatchCar(net, 0, lotLane, CAR, '#fff', 3, .4)).toBe(true);
    for (let i = 0; i < 240 / STEP && !delivered; i++) {
      stepTrafficNetwork(net, STEP, { density: 0, cap: 0, headroom: 4 });
      const car = net.cars.find(entry => entry.active && entry.lot >= 0);
      if (car && !first) { first = { x: net.poses[0]!.x, z: net.poses[0]!.z }; entry = car.route[0]!; }
    }
    expect(first).toBeDefined();
    expect(lanes[entry]!.entry).toBe(true);
    expect(insideDistrict(first!.x, first!.z, VISIBLE_DISTRICT.margin - 4)).toBe(false);
    expect(delivered).toBeDefined();
    expect(delivered!.route[delivered!.k]).toBe(lotLane);
    expect(delivered!.lot).toBe(0);
    expect(delivered!.bay).toBe(3);
    expect(delivered!.s - delivered!.half).toBeGreaterThanOrEqual(.3);
  });

  it('lets an adopted departing lot car plan its way to a boundary exit', () => {
    const net = createTrafficNetwork(12, DAILY_CATALOG, 24, { total: 16, headroom: 8 });
    const lotLane = lanes.findIndex(lane => lane.id === MANEUVER_LOTS[1]!.laneId);
    expect(adoptCar(net, lotLane, 12, 4, { id: 777, model: CAR, tone: '#fff', distance: 120 })).toBe(true);
    expect(net.poses[0]).toMatchObject({ id: 777, visible: true, distance: 120 });
    let end: { x: number; z: number } | undefined;
    for (let i = 0; i < 300 / STEP && net.count; i++) {
      const pose = net.poses[0]!;
      end = { x: pose.x, z: pose.z };
      stepTrafficNetwork(net, STEP, { density: 0, cap: 0, headroom: 4 });
    }
    expect(net.count).toBe(0);
    expect(insideDistrict(end!.x, end!.z, VISIBLE_DISTRICT.margin - 4)).toBe(false);
  });

  it('refuses extra arrivals and departures when the network is full', () => {
    const net = createTrafficNetwork(13, DAILY_CATALOG, 4, { total: 2, headroom: 1 });
    net.cap = 2; net.headroom = 1;
    const lane = ROAD_NETWORK.entries[0]!;
    let admitted = 0;
    for (let i = 0; i < 8; i++) if (adoptCar(net, lane, 10 + i * 20, 5, { id: 100 + i, model: CAR, tone: '#fff', distance: 0 })) admitted++;
    expect(admitted).toBeLessThanOrEqual(3);
    expect(canAdoptCar(net, CAR)).toBe(false);
  });
});
