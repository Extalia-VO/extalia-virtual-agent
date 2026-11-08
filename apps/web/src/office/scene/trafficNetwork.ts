import {
  ROAD_NETWORK, laneTop, routeTable, turnBetween, turnPose, turnTop, type RoadNetwork, type RouteTable,
} from './campusRoadNetwork';
import {
  DAILY_CATALOG, TRAFFIC_TIMING, TRAFFIC_TONES, VEHICLE_SPECS, carActive, createTrafficPose, hashString, isMobilityVehicle, seededRandom, trafficPool, weightedChoice,
  type CatalogVehicle, type MobilityModel, type TrafficCarPose,
} from './campusMobilityLayout';

/*
 * District traffic on the connected road network: a deterministic, fixed-input simulation (no
 * Three.js). Cars enter at hidden network boundaries in platoons, drive several junctions (straight,
 * left or right by a weighted, per-car seeded choice), then head for a boundary exit, again out of
 * view. Lanes keep car-following spacing; junctions are reserved first come, first served, per
 * conflicting movement, and only when the car can leave the junction again (no blocking the box).
 *
 * The state advances with `stepTrafficNetwork(dt)`: the same seed, styles, inputs and steps give the
 * same poses (the splash capture steps the clock with a fixed timestep). Every array is allocated
 * when the network is created; stepping allocates nothing.
 */

/** A lot car on a lane (parking manoeuvre): network cars keep their distance behind it. */
export interface TrafficObstacle { visible: boolean; occupies: number; along: number; model: MobilityModel }
export interface TrafficStepInput {
  density: number;
  /** Moving cars spawned at entries (render tier), and extra room for cars leaving or heading for a lot. */
  cap: number; headroom: number;
  obstacles?: readonly TrafficObstacle[];
}
export interface NetworkCar {
  slot: number; active: boolean; id: number; model: MobilityModel; tone: string; half: number; long: boolean;
  /** Route segments: a lane index, or `lanes.length + turn index` for a movement through a junction. */
  route: Int16Array; length: number;
  /** Current segment (index into `route`), centre position on it, speed and odometer. */
  k: number; s: number; v: number; odometer: number;
  crossed: boolean; wait: number; braking: boolean;
  /** Junction held (node index, else -1), the route index of the granted turn, and when the car asked. */
  holds: number; granted: number; requested: number;
  /** Heading for a parking lot (lot index and bay hint), else -1; `fromLot`: counts against the lot headroom. */
  lot: number; bay: number; fromLot: boolean;
  seed: number;
}
interface Candidate {
  depart: number; model: MobilityModel; tone: string; half: number; long: boolean;
  lead: boolean; groupRank: number; rank: number; seed: number;
}
interface EntryState { lane: number; next: () => number; long: boolean; candidate: Candidate; groupLeft: number; groupRank: number; groupSeed: number }
interface Dispatch { active: boolean; lot: number; lane: number; bay: number; model: MobilityModel; tone: string; entry: number; seed: number }

export interface TrafficNetwork {
  network: RoadNetwork; seed: number; time: number; serial: number;
  cars: NetworkCar[]; poses: TrafficCarPose[]; count: number;
  entries: EntryState[]; dispatches: Dispatch[];
  exits: RouteTable[]; straight: RouteTable[]; lotTables: Map<number, RouteTable>;
  pool: { cars: readonly CatalogVehicle[]; long: readonly CatalogVehicle[] };
  /** Spawn cap and slot bound per model (lot cars may use the slots above the cap). */
  modelCaps: Map<MobilityModel, number>; modelSlots: Map<MobilityModel, number>; live: Map<MobilityModel, number>;
  /** Last step's caps (for lot hand-offs between steps). */
  cap: number; headroom: number;
  order: Int16Array; ready: Uint8Array;
  /** Hands a car that reached its parking lot's lane to the lot; false keeps it driving. */
  arrive?: (car: NetworkCar) => boolean;
}

/** Weighted turn choice on the walk part of a route. */
export const TURN_WEIGHTS = Object.freeze({ straight: .45, left: .3, right: .25 });
/** Junction decisions before heading for the destination exit. */
export const WALK_RANGE = Object.freeze([2, 4] as const);
const ROUTE_MAX = 48;
const LOOKAHEAD = 60;
const DISPATCH_MAX = 4;
/** Seconds of simulated traffic run before the first frame, so the roads are not empty at start. */
export const TRAFFIC_WARMUP = 150;
export const TRAFFIC_STEP = 1 / 30;

/** Per-model spawn caps (weight share of the cap, at least two) and slot bounds (plus the lot headroom). */
export function trafficModelSlots(styles: readonly CatalogVehicle[], total: number, headroom: number) {
  const { cars, long } = trafficPool(styles), weight = cars.reduce((sum, vehicle) => sum + vehicle.weight, 0);
  const caps = new Map<MobilityModel, number>(), slots = new Map<MobilityModel, number>();
  for (const vehicle of cars) caps.set(vehicle.model, Math.min(total, Math.max(2, Math.ceil(2.5 * total * vehicle.weight / (weight || 1)))));
  for (const vehicle of long) caps.set(vehicle.model, 1);
  for (const vehicle of styles) {
    const cap = caps.get(vehicle.model) ?? 0, lot = vehicle.trafficOnly ? 0 : headroom;
    if (cap + lot > 0) slots.set(vehicle.model, cap + lot);
  }
  return { caps, slots };
}

/** True when an entry's straight run reaches an exit without the zebra crossing (long vehicles only drive straight). */
function straightClear(network: RoadNetwork, lane: number): boolean {
  for (let guard = 0; guard < 64; guard++) {
    const current = network.lanes[lane]!;
    if (current.crossing) return false;
    if (current.exit) return true;
    const turn = network.turnsFrom[lane]!.map(index => network.turns[index]!).find(entry => entry.kind === 'straight');
    if (!turn) return false;
    lane = turn.to;
  }
  return false;
}

function nextCandidate(entry: EntryState, pool: TrafficNetwork['pool'], after: number): Candidate {
  const { groupSizes, headway, gap, longVehicle } = TRAFFIC_TIMING, next = entry.next;
  const between = (range: readonly [number, number], u: number) => range[0] + (range[1] - range[0]) * u;
  let lead = false;
  let depart = after + between(headway, next());
  if (entry.groupLeft <= 0) {
    let u = next(), size = 1;
    for (const share of groupSizes) { if (u < share) break; u -= share; size++; }
    entry.groupLeft = Math.min(size, groupSizes.length);
    entry.groupRank = next();
    entry.groupSeed = Math.floor(next() * 2 ** 31);
    depart = after + between(gap, next());
    lead = true;
  }
  entry.groupLeft--;
  const long = entry.long && pool.long.length > 0 && next() < longVehicle;
  const vehicle = long ? weightedChoice(pool.long, next()) : weightedChoice(pool.cars, next());
  const tone = TRAFFIC_TONES[Math.floor(next() * TRAFFIC_TONES.length)]!;
  const rank = lead ? 0 : next();
  // Followers often keep the leader's route (the platoon stays together), else they pick their own.
  const own = Math.floor(next() * 2 ** 31);
  const seed = lead || next() < TRAFFIC_TIMING.follow ? entry.groupSeed : own;
  return { depart, model: vehicle.model, tone, half: vehicle.spec.length / 2, long, lead, groupRank: entry.groupRank, rank, seed };
}

export function createTrafficNetwork(seed: number, styles: readonly CatalogVehicle[] = DAILY_CATALOG, size = 24,
  limits: { total: number; headroom: number } = { total: 16, headroom: 4 }, network: RoadNetwork = ROAD_NETWORK): TrafficNetwork {
  const pool = trafficPool(styles);
  const { caps, slots } = trafficModelSlots(styles, limits.total, limits.headroom);
  const cars: NetworkCar[] = Array.from({ length: size }, (_, slot) => ({
    slot, active: false, id: -1, model: 'mobility-sedan' as MobilityModel, tone: '#ffffff', half: 2.3, long: false,
    route: new Int16Array(ROUTE_MAX), length: 0, k: 0, s: 0, v: 0, odometer: 0, crossed: false, wait: 0, braking: false,
    holds: -1, granted: -1, requested: -1, lot: -1, bay: -1, fromLot: false, seed: 0,
  }));
  const entries = network.entries.map(lane => {
    const entry: EntryState = {
      lane, next: seededRandom((seed ^ hashString(`entry:${network.lanes[lane]!.id}`)) >>> 0), long: straightClear(network, lane),
      candidate: null as unknown as Candidate, groupLeft: 0, groupRank: 0, groupSeed: 0,
    };
    entry.candidate = nextCandidate(entry, pool, -entry.next() * 20);
    return entry;
  });
  return {
    network, seed, time: 0, serial: 0, cars, poses: Array.from({ length: size }, createTrafficPose), count: 0, entries,
    dispatches: Array.from({ length: DISPATCH_MAX }, () => ({ active: false, lot: -1, lane: -1, bay: -1, model: 'mobility-sedan' as MobilityModel, tone: '#ffffff', entry: -1, seed: 0 })),
    exits: network.exits.map(lane => routeTable(network, lane)), straight: network.exits.map(lane => routeTable(network, lane, true)), lotTables: new Map(),
    pool, modelCaps: caps, modelSlots: slots, live: new Map(), cap: limits.total, headroom: limits.headroom, order: new Int16Array(size), ready: new Uint8Array(size),
  };
}

const segmentLength = (net: TrafficNetwork, segment: number) => {
  const lanes = net.network.lanes;
  return segment < lanes.length ? lanes[segment]!.length : net.network.turns[segment - lanes.length]!.length;
};
const segmentSpeed = (net: TrafficNetwork, segment: number) => {
  const lanes = net.network.lanes;
  return segment < lanes.length ? lanes[segment]!.speed : net.network.turns[segment - lanes.length]!.speed;
};

/**
 * Plans a route from `start` into `out` (segments; returns the count): long vehicles drive straight
 * to the far boundary; other cars take 2–4 weighted turns, then the shortest way to a random exit
 * (not back where they came from). `from` is the route index to write at (extending a route).
 */
export function planRoute(net: TrafficNetwork, start: number, seed: number, out: Int16Array, long: boolean, from = 0): number {
  const { lanes, turns, turnsFrom, nodes } = net.network, L = lanes.length, next = seededRandom(seed >>> 0);
  let n = from, lane = start;
  out[n++] = lane;
  const push = (turn: number) => { out[n++] = L + turn; lane = turns[turn]!.to; out[n++] = lane; };
  if (long) {
    while (!lanes[lane]!.exit && n < ROUTE_MAX - 2) {
      const straight = turnsFrom[lane]!.find(index => turns[index]!.kind === 'straight');
      if (straight === undefined) break;
      push(straight);
    }
    if (lanes[lane]!.exit) return n;
  }
  const walk = WALK_RANGE[0] + Math.floor(next() * (WALK_RANGE[1] - WALK_RANGE[0] + 1));
  for (let j = 0; j < walk && !lanes[lane]!.exit; j++) {
    const options = turnsFrom[lane]!;
    let total = 0;
    for (const index of options) total += TURN_WEIGHTS[turns[index]!.kind];
    let u = next() * total, pick = options[options.length - 1]!;
    for (const index of options) { u -= TURN_WEIGHTS[turns[index]!.kind]; if (u < 0) { pick = index; break; } }
    push(pick);
  }
  if (!lanes[lane]!.exit) {
    const origin = lanes[start]!.entry ? lanes[start]!.fromNode : -1;
    const tables = net.exits, offset = Math.floor(next() * tables.length);
    let table: RouteTable | undefined;
    for (let i = 0; i < tables.length && !table; i++) {
      const candidate = tables[(offset + i) % tables.length]!;
      const exitNode = lanes[candidate.target]!.toNode;
      if (candidate.cost[lane]! < Infinity && (origin < 0 || nodes[exitNode]!.x !== nodes[origin]!.x || nodes[exitNode]!.z !== nodes[origin]!.z)) table = candidate;
    }
    while (table && lane !== table.target && n < ROUTE_MAX - 2) push(turnBetween(net.network, lane, table.next[lane]!));
  }
  return n;
}

function lotTable(net: TrafficNetwork, lane: number): RouteTable {
  let table = net.lotTables.get(lane);
  if (!table) net.lotTables.set(lane, table = routeTable(net.network, lane));
  return table;
}

function freeSlot(net: TrafficNetwork): NetworkCar | undefined {
  for (const car of net.cars) if (!car.active) return car;
  return undefined;
}
function activeCounts(net: TrafficNetwork) {
  let all = 0, lot = 0;
  for (const car of net.cars) if (car.active) { all++; if (car.fromLot) lot++; }
  return { all, lot };
}
/** Free length at the start of `lane` (metres up to the rear of the nearest car or lot car on it). */
function laneEntrySpace(net: TrafficNetwork, lane: number, obstacles: readonly TrafficObstacle[] | undefined, except?: NetworkCar): number {
  let space = net.network.lanes[lane]!.length;
  for (const car of net.cars) if (car.active && car !== except && car.route[car.k] === lane) space = Math.min(space, car.s - car.half);
  if (obstacles) for (const o of obstacles) if (o.visible && o.occupies === lane) space = Math.min(space, o.along - obstacleHalf(o));
  return space;
}
const HALVES = new Map<MobilityModel, number>();
const obstacleHalf = (o: TrafficObstacle) => halfOf(o.model);

function launch(net: TrafficNetwork, car: NetworkCar, id: number, model: MobilityModel, tone: string, half: number, long: boolean) {
  car.active = true; car.id = id; car.model = model; car.tone = tone; car.half = half; car.long = long;
  car.k = 0; car.s = 0; car.v = 0; car.odometer = 0; car.crossed = false; car.wait = 0; car.braking = false;
  car.holds = -1; car.granted = -1; car.requested = -1; car.lot = -1; car.bay = -1; car.fromLot = false;
  net.live.set(model, (net.live.get(model) ?? 0) + 1);
}
function retire(net: TrafficNetwork, car: NetworkCar) {
  car.active = false; car.holds = -1; car.granted = -1; car.requested = -1;
  net.live.set(car.model, Math.max(0, (net.live.get(car.model) ?? 0) - 1));
}

function spawnEntries(net: TrafficNetwork, input: TrafficStepInput) {
  const counts = activeCounts(net);
  for (const entry of net.entries) {
    for (let guard = 0; guard < 4 && entry.candidate.depart <= net.time; guard++) {
      const candidate = entry.candidate;
      let done = !carActive(candidate, input.density);
      if (!done) {
        const lane = net.network.lanes[entry.lane]!;
        const room = laneEntrySpace(net, entry.lane, input.obstacles) >= Math.min(lane.length, candidate.half * 2 + TRAFFIC_TIMING.clearance);
        const fits = counts.all - counts.lot < input.cap && (net.live.get(candidate.model) ?? 0) < (net.modelCaps.get(candidate.model) ?? 0);
        const car = room && fits ? freeSlot(net) : undefined;
        if (car) {
          launch(net, car, net.serial = (net.serial + 1) % 1_000_000, candidate.model, candidate.tone, candidate.half, candidate.long);
          car.seed = candidate.seed;
          car.length = planRoute(net, entry.lane, candidate.seed, car.route, candidate.long);
          car.v = Math.min(lane.speed, segmentSpeed(net, car.route[0]!));
          counts.all++;
          done = true;
        } else done = net.time - candidate.depart > TRAFFIC_TIMING.patience;
      }
      if (!done) break;
      entry.candidate = nextCandidate(entry, net.pool, candidate.depart);
    }
  }
  // Cars heading for a lot wait at their entry until it is free (they never give up).
  for (const job of net.dispatches) {
    if (!job.active) continue;
    const lane = net.network.lanes[job.entry]!, half = halfOf(job.model);
    if (laneEntrySpace(net, job.entry, input.obstacles) < Math.min(lane.length, half * 2 + TRAFFIC_TIMING.clearance)) continue;
    if (counts.all >= input.cap + input.headroom) break;
    const car = freeSlot(net);
    if (!car) break;
    launch(net, car, net.serial = (net.serial + 1) % 1_000_000, job.model, job.tone, half, false);
    car.lot = job.lot; car.bay = job.bay; car.fromLot = true; car.seed = job.seed;
    const table = lotTable(net, job.lane);
    let n = 0, at = job.entry;
    car.route[n++] = at;
    while (at !== job.lane && n < ROUTE_MAX - 2) { const turn = turnBetween(net.network, at, table.next[at]!); car.route[n++] = net.network.lanes.length + turn; at = table.next[at]!; car.route[n++] = at; }
    car.length = n;
    car.v = lane.speed;
    job.active = false;
    counts.all++;
  }
}
/** Half a car's length (metres): spacing, stop lines and junction room. */
function halfOf(model: MobilityModel): number {
  let half = HALVES.get(model);
  if (half === undefined) {
    const spec = isMobilityVehicle(model) ? VEHICLE_SPECS[model] : undefined;
    HALVES.set(model, half = (spec?.length ?? 4.8) / 2);
  }
  return half;
}

/** The car asks for the junction ahead when it is first on its lane and close to the stop line. */
function wantsJunction(net: TrafficNetwork, car: NetworkCar, obstacles: readonly TrafficObstacle[] | undefined): boolean {
  const L = net.network.lanes.length, segment = car.route[car.k]!;
  if (segment >= L || car.k + 1 >= car.length || car.granted === car.k + 1) return false;
  const lane = net.network.lanes[segment]!;
  const toEnd = lane.length - car.s - car.half;
  if (toEnd > Math.max(TRAFFIC_TIMING.request, car.v * car.v / (2 * TRAFFIC_TIMING.decel) + 4)) return false;
  for (const other of net.cars) if (other.active && other !== car && other.route[other.k] === segment && other.s > car.s) return false;
  if (obstacles) for (const o of obstacles) if (o.visible && o.occupies === segment && o.along > car.s) return false;
  return true;
}
function conflicts(net: TrafficNetwork, a: number, b: number): boolean {
  if (a === b) return false;
  const ta = net.network.turns[a]!, tb = net.network.turns[b]!;
  if (ta.node !== tb.node) return false;
  const node = net.network.nodes[ta.node]!;
  return node.conflicts[ta.local * node.turns.length + tb.local] === 1;
}
const turnOf = (net: TrafficNetwork, car: NetworkCar, index: number) => car.route[index]! - net.network.lanes.length;

/** First come, first served junction reservations for conflicting movements, with room to leave. */
function grantJunctions(net: TrafficNetwork, obstacles: readonly TrafficObstacle[] | undefined) {
  let n = 0;
  for (const car of net.cars) {
    if (!car.active) continue;
    if (wantsJunction(net, car, obstacles)) { if (car.requested < 0) car.requested = net.time; net.order[n++] = car.slot; }
    else if (car.granted !== car.k + 1) car.requested = -1;
  }
  // Insertion sort by request time, then slot (n is small; no allocation).
  for (let i = 1; i < n; i++) {
    const slot = net.order[i]!, key = net.cars[slot]!;
    let j = i - 1;
    while (j >= 0 && (net.cars[net.order[j]!]!.requested > key.requested || (net.cars[net.order[j]!]!.requested === key.requested && net.order[j]! > slot))) { net.order[j + 1] = net.order[j]!; j--; }
    net.order[j + 1] = slot;
  }
  // A request is ready when the outgoing lane has room for the car behind everything already heading there.
  const clearance = TRAFFIC_TIMING.clearance;
  for (let i = 0; i < n; i++) {
    const car = net.cars[net.order[i]!]!, turn = turnOf(net, car, car.k + 1), node = net.network.turns[turn]!.node, exit = net.network.turns[turn]!.to;
    let space = laneEntrySpace(net, exit, obstacles);
    for (const other of net.cars) {
      if (!other.active || other === car || other.holds !== node || turnOf(net, other, other.granted) !== turn || other.route[other.k] === exit) continue;
      space -= other.half * 2 + clearance;
    }
    net.ready[i] = space >= Math.min(net.network.lanes[exit]!.length, car.half * 2 + clearance) ? 1 : 0;
  }
  for (let i = 0; i < n; i++) {
    if (!net.ready[i]) continue;
    const car = net.cars[net.order[i]!]!, turn = turnOf(net, car, car.k + 1), node = net.network.turns[turn]!.node;
    let ok = true;
    for (const other of net.cars) {
      if (!ok) break;
      if (!other.active || other === car || other.holds !== node) continue;
      if (conflicts(net, turn, turnOf(net, other, other.granted))) ok = false;
    }
    // Earlier ready askers still waiting keep their place against conflicting movements (a car waiting
    // for room downstream holds nobody back: that could lock a ring of short lanes).
    for (let j = 0; j < i && ok; j++) {
      const before = net.cars[net.order[j]!]!;
      if (net.ready[j] && before.granted !== before.k + 1 && conflicts(net, turn, turnOf(net, before, before.k + 1))) ok = false;
    }
    if (!ok) continue;
    car.holds = node; car.granted = car.k + 1; car.requested = -1;
  }
}

/**
 * Distance the car's centre may still advance: to the car (or lot car) ahead on its route, to the
 * crossing stop and to the stop line of a junction it does not hold. Also caps the speed ahead of
 * slower segments (turns). Returns [limit, speed].
 */
function lookAhead(net: TrafficNetwork, car: NetworkCar, obstacles: readonly TrafficObstacle[] | undefined, out: { limit: number; speed: number }) {
  const L = net.network.lanes.length, clearance = TRAFFIC_TIMING.clearance, decel = TRAFFIC_TIMING.decel;
  let limit = Infinity, speed = segmentSpeed(net, car.route[car.k]!), offset = -car.s;
  for (let j = car.k; j < car.length && offset < LOOKAHEAD; j++) {
    const segment = car.route[j]!;
    if (j > car.k) speed = Math.min(speed, Math.sqrt(segmentSpeed(net, segment) ** 2 + 2 * decel * Math.max(0, offset)));
    let found = Infinity;
    for (const other of net.cars) {
      if (!other.active || other === car || other.route[other.k] !== segment) continue;
      if (j === car.k && (other.s < car.s || (other.s === car.s && other.slot > car.slot))) continue;
      found = Math.min(found, offset + other.s - other.half - car.half - clearance);
    }
    if (segment < L && obstacles) for (const o of obstacles) {
      if (!o.visible || o.occupies !== segment || (j === car.k && o.along <= car.s)) continue;
      found = Math.min(found, offset + o.along - obstacleHalf(o) - car.half - clearance);
    }
    limit = Math.min(limit, found);
    let stop = false;
    if (segment < L) {
      const lane = net.network.lanes[segment]!;
      if (lane.crossing && j === car.k && !car.crossed) limit = Math.min(limit, offset + lane.crossAt - TRAFFIC_TIMING.stopLine - car.half);
      if (j + 1 < car.length && car.granted !== j + 1) { limit = Math.min(limit, offset + lane.length - car.half); stop = true; }
    }
    if (stop || found < Infinity) break;
    offset += segmentLength(net, segment);
  }
  out.limit = limit; out.speed = speed;
  return out;
}

/** Extends a lot-bound car's route to a random exit when the lot cannot take it. */
function continueFromLot(net: TrafficNetwork, car: NetworkCar) {
  const lane = car.route[car.k]!;
  car.length = planRoute(net, lane, car.seed ^ 0x2545f491, car.route, false, car.k);
  car.lot = -1;
}

const ahead = { limit: 0, speed: 0 };
/** Advances the network by `dt` seconds (no allocation). */
export function stepTrafficNetwork(net: TrafficNetwork, dt: number, input: TrafficStepInput): void {
  if (!(dt > 0)) return;
  net.time += dt; net.cap = input.cap; net.headroom = input.headroom;
  const obstacles = input.obstacles, { accel, decel } = TRAFFIC_TIMING, L = net.network.lanes.length;
  spawnEntries(net, input);
  grantJunctions(net, obstacles);
  for (const car of net.cars) {
    if (!car.active) continue;
    // A car that reached its lot's lane (rear clear of the junction) turns into the lot.
    if (car.lot >= 0 && car.k === car.length - 1 && car.s - car.half >= .3) {
      if (net.arrive?.(car)) { retire(net, car); continue; }
      continueFromLot(net, car);
    }
    lookAhead(net, car, obstacles, ahead);
    const limit = Math.max(0, ahead.limit);
    const allowed = Math.min(ahead.speed, Math.sqrt(2 * decel * Math.max(0, limit - .05)));
    const previous = car.v;
    let v = Math.min(car.v + accel * dt, allowed), step = v * dt;
    if (step > limit) { step = limit; v = step / dt; }
    car.v = v; car.braking = v < previous - 1e-3 || v < .05;
    car.odometer += step; car.s += step;
    // The crossing: wait at the stop line while pedestrians cross.
    const segment = car.route[car.k]!;
    if (segment < L && net.network.lanes[segment]!.crossing && !car.crossed) {
      const lane = net.network.lanes[segment]!, stop = lane.crossAt - TRAFFIC_TIMING.stopLine - car.half;
      if (car.s > stop + .5) car.crossed = true;
      else if (stop - car.s < .3 && car.v < .05) { car.wait += dt; if (car.wait >= TRAFFIC_TIMING.wait) car.crossed = true; }
    }
    while (car.k < car.length - 1 && car.s >= segmentLength(net, car.route[car.k]!)) {
      car.s -= segmentLength(net, car.route[car.k]!); car.k++;
      if (car.route[car.k]! < L) { car.crossed = false; car.wait = 0; }
    }
    if (car.holds >= 0 && car.k > car.granted && car.s - car.half >= .3) { car.holds = -1; car.granted = -1; }
    if (car.k === car.length - 1 && car.lot < 0 && car.s >= segmentLength(net, car.route[car.k]!)) retire(net, car);
  }
  writeNetworkPoses(net);
}

/** A car signals from this far before a junction (metres), through the complete turn arc. */
export const SIGNAL_LEAD = 20;
/** Turn-signal side for a junction movement: 1 left (+X of the car), -1 right, 0 straight. */
export const turnSignal = (kind: 'straight' | 'left' | 'right') => kind === 'left' ? 1 : kind === 'right' ? -1 : 0;

const scratchPose = { x: 0, z: 0, yaw: 0 };
function writePose(net: TrafficNetwork, car: NetworkCar, pose: TrafficCarPose) {
  const { lanes, turns } = net.network, L = lanes.length, segment = car.route[car.k]!;
  let top: number;
  if (segment < L) {
    const lane = lanes[segment]!;
    pose.x = lane.from[0] + lane.dx * car.s; pose.z = lane.from[1] + lane.dz * car.s; pose.yaw = Math.atan2(lane.dx, lane.dz);
    top = laneTop(lane, car.s);
    pose.lane = segment; pose.along = car.s;
    const nextLane = car.k + 2 < car.length ? car.route[car.k + 2]! : -1;
    pose.feed = nextLane;
    pose.feedAt = nextLane >= 0 ? -(lane.length - car.s + turns[car.route[car.k + 1]! - L]!.length) : 0;
    const next = car.k + 1 < car.length ? car.route[car.k + 1]! : -1;
    pose.signal = next >= L && lane.length - car.s < SIGNAL_LEAD ? turnSignal(turns[next - L]!.kind) : 0;
  } else {
    const turn = turns[segment - L]!;
    turnPose(turn, car.s, scratchPose);
    pose.x = scratchPose.x; pose.z = scratchPose.z; pose.yaw = scratchPose.yaw;
    top = turnTop(net.network, turn, car.s);
    pose.lane = turn.to; pose.along = car.s - turn.length; pose.feed = -1; pose.feedAt = 0;
    pose.signal = turnSignal(turn.kind);
  }
  pose.id = car.id; pose.model = car.model; pose.tone = car.tone;
  pose.y = top + .015; pose.top = top; pose.stopped = car.braking; pose.distance = car.odometer; pose.visible = true;
}
/** Writes every active car's pose (slot order) into `net.poses`; returns the count. */
export function writeNetworkPoses(net: TrafficNetwork): number {
  let count = 0;
  for (const car of net.cars) if (car.active && count < net.poses.length) writePose(net, car, net.poses[count++]!);
  for (let i = count; i < net.poses.length; i++) net.poses[i]!.visible = false;
  return net.count = count;
}
/** Hides every car (reduced motion) without changing the network state. */
export function hideTrafficNetwork(net: TrafficNetwork): void {
  for (const pose of net.poses) pose.visible = false;
  net.count = 0;
}
/** Runs `seconds` of traffic at the fixed step (warm-up, pinned captures). */
export function advanceTrafficNetwork(net: TrafficNetwork, seconds: number, input: TrafficStepInput, step = TRAFFIC_STEP): void {
  for (let t = 0; t < seconds - 1e-9; t += step) stepTrafficNetwork(net, Math.min(step, seconds - t), input);
}

/** Whether a departing lot car of `model` can join the network now. */
export function canAdoptCar(net: TrafficNetwork, model: MobilityModel): boolean {
  return activeCounts(net).all < net.cap + net.headroom && (net.live.get(model) ?? 0) < (net.modelSlots.get(model) ?? 0) && !!freeSlot(net);
}
/**
 * A departing lot car joins the network on `lane` at `along` with its speed, id, look and odometer;
 * it plans its own way to an exit. Writes its pose at once (same frame). False when there is no room.
 */
export function adoptCar(net: TrafficNetwork, lane: number, along: number, speed: number,
  car: { id: number; model: MobilityModel; tone: string; distance: number }): boolean {
  if (!canAdoptCar(net, car.model)) return false;
  const slot = freeSlot(net)!;
  const half = halfOf(car.model);
  launch(net, slot, car.id, car.model, car.tone, half, false);
  slot.fromLot = true; slot.seed = (hashString(`adopt:${car.id}`) ^ net.seed) >>> 0;
  slot.length = planRoute(net, lane, slot.seed, slot.route, false);
  slot.s = Math.max(0, Math.min(net.network.lanes[lane]!.length, along)); slot.v = speed; slot.odometer = car.distance;
  writeNetworkPoses(net);
  return true;
}
/**
 * A parking lot asks for an arrival: a car of `model` enters at a boundary (chosen by `u` among those
 * that can reach `lane`) and drives to the lot's lane, where `arrive` hands it to the lot.
 */
export function dispatchCar(net: TrafficNetwork, lot: number, lane: number, model: MobilityModel, tone: string, bay: number, u: number): boolean {
  const job = net.dispatches.find(entry => !entry.active);
  if (!job) return false;
  let queued = 0;
  for (const entry of net.dispatches) if (entry.active && entry.model === model) queued++;
  if ((net.live.get(model) ?? 0) + queued >= (net.modelSlots.get(model) ?? 0)) return false;
  const table = lotTable(net, lane), reachable = net.network.entries.filter(entry => table.cost[entry]! < Infinity || entry === lane);
  if (!reachable.length) return false;
  // Prefer nearby entries: the nearer half of the reachable boundaries.
  reachable.sort((a, b) => table.cost[a]! - table.cost[b]! || a - b);
  const near = reachable.slice(0, Math.max(1, Math.ceil(reachable.length / 2)));
  Object.assign(job, { active: true, lot, lane, bay, model, tone, entry: near[Math.min(near.length - 1, Math.floor(u * near.length))]!, seed: (hashString(`lot:${lot}:${net.serial}`) ^ Math.floor(u * 2 ** 30)) >>> 0 });
  return true;
}
/** Development audit: one row per moving car. */
export function networkDebug(net: TrafficNetwork) {
  const { lanes, turns } = net.network, L = lanes.length, round = (value: number) => Math.round(value * 100) / 100;
  return net.cars.filter(car => car.active).map(car => {
    const segment = car.route[car.k]!;
    return {
      id: car.id, model: car.model, at: segment < L ? lanes[segment]!.id : `turn ${turns[segment - L]!.kind} ${lanes[turns[segment - L]!.from]!.id} → ${lanes[turns[segment - L]!.to]!.id}`,
      s: round(car.s), v: round(car.v), holds: car.holds, lot: car.lot,
      route: Array.from(car.route.subarray(0, car.length)).filter(entry => entry < L).map(entry => lanes[entry]!.id),
    };
  });
}
