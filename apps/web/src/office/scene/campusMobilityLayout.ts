import { QA_HOOKS } from './qaHooks';
import { FRONT_APPROACH } from './campusSiteLayout';
import { PARKING_LOT_CHARGERS, PARKING_LOT_LAMPS, PARKING_LOTS, type ParkingLot, type ParkingLotId } from './campusParkingLots';
import CATALOG from './campusVehicles.json';

/** A runtime model name: `mobility-<style>` (cars, pickups, charger, cycle shelter). */
export type MobilityModel = `mobility-${string}`;
export type MobilityVehicle = MobilityModel;
export type VehicleCategory = 'ev' | 'conventional';
/**
 * One published campus car (generated from `tooling/blender/campus-vehicles.json`). `trafficOnly`
 * vehicles (the long rigid truck, the limousine) never park; `nonCommercial` (CC-BY-NC/-NC-SA) and
 * `licenseUnverified` (author and licence pending owner confirmation) mark the licence groups the
 * commercial-assets switch leaves out.
 */
export interface CatalogVehicle {
  style: string; model: MobilityModel; category: VehicleCategory; weight: number;
  trafficOnly?: boolean; nonCommercial?: boolean; licenseUnverified?: boolean;
  spec: Pick<VehicleSpec, 'length' | 'width' | 'height' | 'wheel' | 'wheelbase' | 'track'>;
}
export const VEHICLE_CATALOG: readonly CatalogVehicle[] = (CATALOG.vehicles as CatalogVehicle[]).map(vehicle => ({ ...vehicle }));
/**
 * The single licence switch: building with `EXTALIA_COMMERCIAL_ASSETS_ONLY=1` keeps non-commercial
 * and unverified cars out of parking and traffic (default: included, owner decision 2026-10-29).
 */
export const COMMERCIAL_ASSETS_ONLY: boolean = typeof __EXTALIA_COMMERCIAL_ASSETS_ONLY__ !== 'undefined' && __EXTALIA_COMMERCIAL_ASSETS_ONLY__ === true;
export function licensedCatalog(catalog: readonly CatalogVehicle[] = VEHICLE_CATALOG, commercialOnly = COMMERCIAL_ASSETS_ONLY): CatalogVehicle[] {
  return catalog.filter(vehicle => !commercialOnly || (!vehicle.nonCommercial && !vehicle.licenseUnverified));
}
/** Every vehicle is reference-derived (one licensed GLB each); the procedural single-cab truck is retired. */
export const DERIVED_VEHICLE_MODELS: readonly MobilityModel[] = VEHICLE_CATALOG.map(vehicle => vehicle.model);
/** Derived pickups (double/crew cabs, mid-size, full-size, off-road, electric): the retired truck's stand-ins. */
export const PICKUPS: readonly MobilityModel[] = VEHICLE_CATALOG.filter(vehicle => !vehicle.trafficOnly && /(^|-)pickup($|-)/.test(vehicle.style)).map(vehicle => vehicle.model);
export const VEHICLE_MODELS: readonly MobilityVehicle[] = DERIVED_VEHICLE_MODELS;
export const MOBILITY_MODELS: readonly MobilityModel[] = [...VEHICLE_MODELS, 'mobility-charger', 'mobility-cycle-shelter'];
/** Models in the MIT project-generated `landscape/campus-mobility.glb` (site fixtures only). */
export const GENERATED_MOBILITY_MODELS: readonly MobilityModel[] = ['mobility-charger', 'mobility-cycle-shelter'];
/** The retired single-cab truck resolves to the day's mid-size pickup, else the double-cab `pickup`, else the day's pickup. */
export const TRUCK_STAND_INS: readonly MobilityModel[] = ['mobility-pickup-midsize', 'mobility-pickup'];
export function truckStandIn(styles: readonly CatalogVehicle[]): MobilityModel {
  const today = new Set(styles.map(vehicle => vehicle.model));
  return TRUCK_STAND_INS.find(model => today.has(model)) ?? PICKUPS.find(model => today.has(model)) ?? 'mobility-pickup';
}
export function resolveMobilityModel(name: string): MobilityModel | undefined {
  const model = (LEGACY_MOBILITY_MODELS[name] ?? name) as MobilityModel;
  return MOBILITY_MODELS.includes(model) ? model : undefined;
}
export function vehicleCategory(model: MobilityModel): VehicleCategory {
  return VEHICLE_CATALOG.find(vehicle => vehicle.model === model)?.category ?? 'conventional';
}
export interface VehicleSpec {
  /** Overall size in metres including mirrors; wheels touch y=0 and the car faces +Z. */
  length: number; width: number; height: number;
  /** Wheel radius, axle distance and wheel centre track. */
  wheel: number; wheelbase: number; track: number;
  /** Procedural fallback cabin layout. */
  cabinZ: number; cabinLength: number; cabinBase: number; windows: number; cargo: boolean;
}
/** A plausible fallback cabin for a measured car: tall cars get a long, three-window cabin. */
export function fallbackCabin(spec: CatalogVehicle['spec']): Pick<VehicleSpec, 'cabinZ' | 'cabinLength' | 'cabinBase' | 'windows'> {
  const tall = spec.height > 1.7, low = spec.height < 1.3;
  return {
    cabinZ: -spec.length * (low ? .07 : .04), cabinLength: spec.length * (tall ? .72 : low ? .42 : .54),
    cabinBase: Math.min(spec.height - .4, spec.wheel * 2 + .15), windows: tall && spec.length > 4.8 ? 3 : low ? 1 : 2,
  };
}
/** Fallback layouts that differ from `fallbackCabin`: derived pickups keep a cab over an open bed. */
const FALLBACK_LAYOUTS: Readonly<Record<string, Pick<VehicleSpec, 'cabinZ' | 'cabinLength' | 'cabinBase' | 'windows' | 'cargo'>>> = {
  ...Object.fromEntries(VEHICLE_CATALOG.filter(vehicle => PICKUPS.includes(vehicle.model)).map(({ model, spec }) => [model, {
    cabinZ: spec.length * .075, cabinLength: spec.length * .51, cabinBase: Math.min(spec.height - .4, spec.wheel * 2 + .15), windows: 2, cargo: true,
  }])),
  'mobility-pickup': { cabinZ: .40, cabinLength: 2.74, cabinBase: .83, windows: 2, cargo: true },
};
/** Derived cars use the measured export; cabin fields only shape the bounded procedural fallback. */
export const VEHICLE_SPECS: Readonly<Record<MobilityVehicle, VehicleSpec>> = Object.freeze(
  Object.fromEntries(VEHICLE_CATALOG.map(vehicle => [vehicle.model, { ...vehicle.spec, ...fallbackCabin(vehicle.spec), cargo: false, ...FALLBACK_LAYOUTS[vehicle.model] }])),
);
export function isMobilityVehicle(model: MobilityModel): model is MobilityVehicle { return Object.hasOwn(VEHICLE_SPECS, model); }
export const PARKING = Object.freeze({ west: -51.5, east: -33.5, north: -15, south: 20, top: -.22, aisleX: -42.5, bayDepth: 5.5, bayWidth: 3.2,
  entranceZ: -28.5, entryX: -52, footwayX: -32.4 });
/** Six perimeter poles of the west lot leave the drive aisle, occupied bays, chargers and east footway clear. */
export const PARKING_LIGHTS = PARKING_LOT_LAMPS.west;
/** Every parking lamp post (west six, east five), drawn in one instanced batch with baked night pools. */
export const ALL_PARKING_LIGHTS = Object.freeze([...PARKING_LOT_LAMPS.west, ...PARKING_LOT_LAMPS.east]);
export const PARKING_LIGHT_HEIGHT = 4.5;
export interface ParkedVehicle { id: string; model: MobilityModel; x: number; y: number; z: number; yaw: number; tone: string }
export interface LotBay { id: string; lot: ParkingLotId; x: number; z: number; yaw: number; ev: boolean; occupied: boolean }
/**
 * Bays of both lots in contract order (`PARKING_LOTS`, generated from the Blender markers) with a
 * fixed occupancy pattern: west rows alternate (row index + side), east every third bay stays free.
 */
export function lotBays(lot: ParkingLot): LotBay[] {
  return lot.bays.map((bay, order) => {
    const row = Math.floor(order / 2), side = order % 2 ? 2 : 0;
    const occupied = lot.id === 'west' ? (row + side) % 3 !== 1 : order % 3 !== 1;
    return { ...bay, lot: lot.id, occupied };
  });
}
export const ALL_PARKING_BAYS: readonly LotBay[] = Object.freeze(PARKING_LOTS.flatMap(lotBays));
/** The west lot's 18 bays (positions unchanged since the shared contract). */
export const PARKING_BAYS = Object.freeze(ALL_PARKING_BAYS.filter(bay => bay.lot === 'west'));
export const EAST_PARKING_BAYS = Object.freeze(ALL_PARKING_BAYS.filter(bay => bay.lot === 'east'));
const TONES = ['#a3bec5', '#e5e1d7', '#507b88', '#9c6552', '#747a86'];
/** Catalog order by weight (common first, rare last), then style. */
const byWeight = (vehicles: readonly CatalogVehicle[]) => [...vehicles].sort((a, b) => b.weight - a.weight || a.style.localeCompare(b.style));
/**
 * Deterministic parking mix: charging bays take electric cars (most common first); the other
 * bays first show every remaining style once (the day's pickups, which replaced the single-cab
 * truck, first; rare ones last), then repeat the common ones.
 */
export function parkingAssignment(bays: readonly { ev: boolean }[], vehicles: readonly CatalogVehicle[] = VEHICLE_CATALOG): MobilityModel[] {
  const catalog = vehicles.filter(vehicle => !vehicle.trafficOnly);
  const ev = byWeight(catalog.filter(vehicle => vehicle.category === 'ev'));
  const evBays = bays.filter(bay => bay.ev).length;
  const charging = ev.slice(0, Math.max(1, Math.min(ev.length, evBays))).map(vehicle => vehicle.model);
  const common = byWeight(catalog.filter(vehicle => vehicle.weight >= 1));
  const remaining = catalog.filter(vehicle => !charging.includes(vehicle.model));
  const pickup = (vehicle: CatalogVehicle) => PICKUPS.includes(vehicle.model);
  const once = [
    ...byWeight(remaining.filter(pickup)), ...byWeight(remaining.filter(vehicle => !pickup(vehicle) && vehicle.weight >= 1)),
    ...byWeight(remaining.filter(vehicle => !pickup(vehicle) && vehicle.weight < 1)),
  ].map(vehicle => vehicle.model);
  let evIndex = 0, index = 0;
  return bays.map(bay => {
    if (bay.ev && charging.length) return charging[(evIndex++) % charging.length]!;
    const next = index < once.length ? once[index]! : common[(index - once.length) % Math.max(1, common.length)]?.model ?? once[0] ?? charging[0]!;
    index++;
    return next;
  });
}
/** Local calendar date as YYYYMMDD: the rotation changes once a day at local midnight. */
export function dailySeed(date = new Date()): number { return date.getFullYear() * 10_000 + (date.getMonth() + 1) * 100 + date.getDate(); }
/** Development only: `?carSeed=<integer>` pins the rotation for tests and screenshots. */
function seedOverride(): number | undefined {
  if (!QA_HOOKS || typeof location === 'undefined') return undefined;
  const value = new URLSearchParams(location.search).get('carSeed');
  return value && /^\d{1,9}$/.test(value) ? Number(value) : undefined;
}
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
/** Weighted sample without replacement: each car's key is u^(1/weight); the highest keys win. */
function weightedPick(pool: readonly CatalogVehicle[], count: number, next: () => number): CatalogVehicle[] {
  return pool.map(vehicle => ({ vehicle, key: Math.pow(next(), 1 / Math.max(.01, vehicle.weight)) }))
    .sort((a, b) => b.key - a.key || a.vehicle.style.localeCompare(b.vehicle.style)).slice(0, count).map(entry => entry.vehicle);
}
/** Twelve to fourteen styles a day; three electric cars cover the charging bays. */
export const DAILY_STYLE_RANGE = Object.freeze({ min: 12, max: 14, ev: 3 });
/**
 * The day's style rotation: a deterministic, weight-biased subset of the licensed catalog (rare
 * styles stay rare), with electric cars for the chargers, a common conventional car for traffic
 * and at least one derived pickup (in place of the retired single-cab truck).
 * Only the subset is parked, driven and loaded, so draw calls stay bounded by its size.
 */
export function dailyStyles(seed: number, catalog: readonly CatalogVehicle[] = licensedCatalog()): CatalogVehicle[] {
  const next = random(seed);
  const size = Math.min(catalog.length, DAILY_STYLE_RANGE.min + seed % (DAILY_STYLE_RANGE.max - DAILY_STYLE_RANGE.min + 1));
  const parkable = catalog.filter(vehicle => !vehicle.trafficOnly);
  const ev = weightedPick(parkable.filter(vehicle => vehicle.category === 'ev'), DAILY_STYLE_RANGE.ev, next);
  const commuter = weightedPick(parkable.filter(vehicle => vehicle.category === 'conventional' && vehicle.weight >= 1), 1, next);
  const chosen = [...ev, ...commuter];
  const rest = weightedPick(catalog.filter(vehicle => !chosen.includes(vehicle)), size - chosen.length, next);
  // No pickup drawn: the weakest common pick makes way for one (rare styles keep their chances).
  const pickup = (vehicle: CatalogVehicle) => PICKUPS.includes(vehicle.model);
  if (![...chosen, ...rest].some(pickup)) {
    let swap = rest.length - 1;
    while (swap >= 0 && rest[swap]!.weight < 1) swap--;
    const stand = weightedPick(parkable.filter(pickup), 1, random(seed ^ 0x5bd1e995));
    if (stand.length) rest.splice(swap < 0 ? rest.length : swap, swap < 0 ? 0 : 1, ...stand);
  }
  chosen.push(...rest);
  return catalog.filter(vehicle => chosen.includes(vehicle));
}
export const ROTATION_SEED = seedOverride() ?? dailySeed();
/** Today's catalog subset: parking, traffic and model loading all use it. */
export const DAILY_CATALOG: readonly CatalogVehicle[] = Object.freeze(dailyStyles(ROTATION_SEED));
// West bays come first, so the west lot keeps the assignment it had before the east lot existed.
const OCCUPIED_BAYS = ALL_PARKING_BAYS.filter(bay => bay.occupied);
const PARKED_MODELS = parkingAssignment(OCCUPIED_BAYS, DAILY_CATALOG);
const LOT_TOP = Object.fromEntries(PARKING_LOTS.map(lot => [lot.id, lot.top])) as Record<ParkingLotId, number>;
export const PARKED_VEHICLES: readonly ParkedVehicle[] = Object.freeze(OCCUPIED_BAYS.map((bay, index) => ({
  id: bay.id, model: PARKED_MODELS[index]!, x: bay.x, y: LOT_TOP[bay.lot] + .015, z: bay.z, yaw: bay.yaw, tone: TONES[index % TONES.length]!,
})));
/** Names used before the catalog-driven styles; kept so saved references still resolve. */
export const LEGACY_MOBILITY_MODELS: Readonly<Record<string, MobilityModel>> = Object.freeze({
  'mobility-suv': 'mobility-ev-suv', 'mobility-ev': 'mobility-ev-sedan-long', 'mobility-double-cabin': 'mobility-pickup',
  'mobility-truck': truckStandIn(DAILY_CATALOG),
});
/** One charger at the head of every EV bay in both lots (Blender layout data). */
export const EV_CHARGERS: readonly ParkedVehicle[] = Object.freeze(PARKING_LOTS.flatMap(lot => PARKING_LOT_CHARGERS[lot.id].map(charger => ({
  id: charger.id, model: 'mobility-charger' as const, x: charger.x, y: lot.top + .015, z: charger.z, yaw: charger.yaw, tone: '#ffffff',
}))));
export const CYCLE_SHELTER: ParkedVehicle = {id: 'cycle-shelter', model: 'mobility-cycle-shelter', x: 20, y: -.24, z: -25, yaw: 0, tone: '#ffffff'};

/** One straight one-way lane (left-hand traffic); `crossing` lanes stop at the arrival zebra crossing. */
export interface TrafficLane { id: string; from: readonly [number, number]; to: readonly [number, number]; top: number; speed: number; crossing: boolean }
const AVENUE = Object.freeze({ inner: 58.35, outer: 61.65, south: -47, north: 74 });
/**
 * Straight through-lanes between junctions: the front road both ways (stopping at the arrival
 * crossing) and both flanking avenues both ways (no crossing between their junctions). None turns
 * through a junction or crosses a footway; lane ends stay clear of the junction crosswalks.
 */
export const TRAFFIC_LANES: readonly TrafficLane[] = Object.freeze([
  { id: 'front-eastbound', from: [-51, FRONT_APPROACH.roadCenterZ - 1.65], to: [51, FRONT_APPROACH.roadCenterZ - 1.65], top: FRONT_APPROACH.roadTop, speed: 7.5, crossing: true },
  { id: 'front-westbound', from: [51, FRONT_APPROACH.roadCenterZ + 1.65], to: [-51, FRONT_APPROACH.roadCenterZ + 1.65], top: FRONT_APPROACH.roadTop, speed: 6.8, crossing: true },
  { id: 'west-northbound', from: [-AVENUE.inner, AVENUE.south], to: [-AVENUE.inner, AVENUE.north], top: FRONT_APPROACH.roadTop, speed: 8, crossing: false },
  { id: 'east-southbound', from: [AVENUE.inner, AVENUE.north], to: [AVENUE.inner, AVENUE.south], top: FRONT_APPROACH.roadTop, speed: 8.5, crossing: false },
  { id: 'west-southbound', from: [-AVENUE.outer, AVENUE.north], to: [-AVENUE.outer, AVENUE.south], top: FRONT_APPROACH.roadTop, speed: 7.8, crossing: false },
  { id: 'east-northbound', from: [AVENUE.outer, AVENUE.south], to: [AVENUE.outer, AVENUE.north], top: FRONT_APPROACH.roadTop, speed: 8.2, crossing: false },
]);
/** Lanes that never stop at a crossing; only they take long traffic-only vehicles. */
export const OPEN_LANES: readonly number[] = TRAFFIC_LANES.flatMap((lane, index) => lane.crossing ? [] : [index]);
export const laneLength = (lane: TrafficLane) => Math.hypot(lane.to[0] - lane.from[0], lane.to[1] - lane.from[1]);

/**
 * Traffic comes in waves: platoons of one to three cars a few seconds apart, then a quiet gap.
 * `clearance` is the bumper-to-bumper minimum, `stopLine` the distance from the crossing centre
 * to a waiting car's front bumper; each lane schedule repeats after `cycle` seconds.
 */
export const TRAFFIC_TIMING = Object.freeze({
  groupSizes: [.4, .35, .25] as readonly number[], headway: [2.2, 4] as const, gap: [10, 30] as const, cycle: [240, 330] as const,
  wait: 3.2, clearance: 1.8, stopLine: 3.4, longVehicle: .05,
});
/** Seconds a car may spend on `lane` (its own crossing stop included); queueing never extends it. */
export function laneWindow(lane: TrafficLane): number {
  return laneLength(lane) / lane.speed + (lane.crossing ? TRAFFIC_TIMING.wait : 0) + .5;
}
export interface ScheduledCar {
  /** Stable id: lane index × 1000 + position in the lane schedule. */
  id: number; model: MobilityModel; tone: string;
  /** Departure from the lane start, in seconds into the lane cycle. */
  depart: number; group: number; lead: boolean;
  /** Density thresholds: a group runs when `groupRank < density`; followers also need `rank` below theirs. */
  groupRank: number; rank: number;
  /** Half the car length (metres), for spacing and the crossing stop. */
  half: number;
}
export interface LaneSchedule { lane: TrafficLane; index: number; cycle: number; phase: number; window: number; cars: readonly ScheduledCar[] }
const TRAFFIC_TONES = ['#d8e5dd', '#748d9a', '#c6c2b6', '#527d7d', '#e5e1d7', '#9c6552', '#a3bec5', '#2f3a40', '#b8b1a3', '#7b2f2a'] as const;
function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}
/** Common styles of the day drive (weight ≥ 1); traffic-only vehicles join open lanes, rarely. */
export function trafficPool(styles: readonly CatalogVehicle[]) {
  return { cars: styles.filter(vehicle => !vehicle.trafficOnly && vehicle.weight >= 1), long: styles.filter(vehicle => vehicle.trafficOnly) };
}
function weightedChoice<T extends { weight: number }>(pool: readonly T[], u: number): T {
  const total = pool.reduce((sum, item) => sum + item.weight, 0);
  let left = u * total;
  for (const item of pool) { left -= item.weight; if (left < 0) return item; }
  return pool[pool.length - 1]!;
}
/**
 * Deterministic per-lane schedules from the day's seed and the lane id: waves of 1–3 cars with
 * 2.2–4 s headway and 10–30 s gaps; every cycle ends in a quiet tail of at least the lane window,
 * so no car of one cycle is still on the road when the next begins.
 */
export function trafficSchedule(seed: number, styles: readonly CatalogVehicle[] = DAILY_CATALOG, lanes: readonly TrafficLane[] = TRAFFIC_LANES): LaneSchedule[] {
  const { cars: pool, long } = trafficPool(styles);
  const { groupSizes, headway, gap, cycle: cycleRange, longVehicle } = TRAFFIC_TIMING;
  const between = (range: readonly [number, number], u: number) => range[0] + (range[1] - range[0]) * u;
  return lanes.map((lane, index) => {
    const next = random((seed ^ hashString(lane.id)) >>> 0);
    const window = laneWindow(lane), cycle = Math.round(between(cycleRange, next()));
    const phase = next() * cycle, cars: ScheduledCar[] = [];
    const open = !lane.crossing;
    let t = next() * 8;
    for (let group = 0; pool.length; group++) {
      let u = next(), size = 1;
      for (const share of groupSizes) { if (u < share) break; u -= share; size++; }
      size = Math.min(size, groupSizes.length);
      const departs = [t];
      while (departs.length < size) departs.push(departs[departs.length - 1]! + between(headway, next()));
      if (departs[departs.length - 1]! > cycle - window - 1) break;
      const groupRank = next();
      departs.forEach((depart, k) => {
        const vehicle = open && long.length && next() < longVehicle ? weightedChoice(long, next()) : weightedChoice(pool, next());
        cars.push({
          id: index * 1000 + cars.length, model: vehicle.model, tone: TRAFFIC_TONES[Math.floor(next() * TRAFFIC_TONES.length)]!,
          depart, group, lead: k === 0, groupRank, rank: k === 0 ? 0 : next(), half: vehicle.spec.length / 2,
        });
      });
      t = departs[departs.length - 1]! + between(gap, next());
    }
    return { lane, index, cycle, phase, window, cars };
  });
}

/** Local-time density (0–1): morning and evening rush, a calmer day and a quiet but never empty night. */
const DENSITY_PROFILE: readonly (readonly [number, number])[] = [
  [0, .3], [5, .3], [6.5, .85], [7.5, 1], [9, 1], [10, .6], [16, .6], [17, 1], [19, 1], [21, .5], [23, .3], [24, .3],
];
export function trafficDensity(minutes: number): number {
  const hour = (((minutes % 1440) + 1440) % 1440) / 60;
  for (let i = 1; i < DENSITY_PROFILE.length; i++) {
    const [h1, d1] = DENSITY_PROFILE[i]!, [h0, d0] = DENSITY_PROFILE[i - 1]!;
    if (hour <= h1) return d0 + (d1 - d0) * (hour - h0) / (h1 - h0);
  }
  return DENSITY_PROFILE[0]![1];
}
/** Forced light and dark app themes show a calm afternoon and an early evening. */
export const FORCED_THEME_DENSITY = Object.freeze({ day: trafficDensity(14 * 60), night: trafficDensity(21 * 60) });
/** Groups drop out first as density falls; at night the remaining waves are also shorter. */
export function carActive(car: Pick<ScheduledCar, 'lead' | 'groupRank' | 'rank'>, density: number): boolean {
  return car.groupRank < density && (car.lead || car.rank < .35 + .65 * density);
}
/** Spreads the moving-car cap over the lanes (front lanes first). */
export function laneCaps(total: number, lanes = TRAFFIC_LANES.length): number[] {
  return Array.from({ length: lanes }, (_, index) => Math.floor(total / lanes) + (index < total % lanes ? 1 : 0));
}
/**
 * Static admission for a car cap: a car joins only while fewer than its lane's share of admitted
 * cars departed within the lane window, so at most `total` cars are ever on the roads at once.
 */
export function admitTraffic(schedules: readonly LaneSchedule[], total: number): Uint8Array[] {
  const caps = laneCaps(total, schedules.length);
  return schedules.map(({ cars, window }, lane) => {
    const admitted = new Uint8Array(cars.length);
    cars.forEach((car, index) => {
      let onRoad = 0;
      for (let j = index - 1; j >= 0 && car.depart - cars[j]!.depart < window; j--) onRoad += admitted[j]!;
      admitted[index] = onRoad < caps[lane]! ? 1 : 0;
    });
    return admitted;
  });
}
/** Upper bound of simultaneous moving instances per model (sliding lane window, lane cap, total cap). */
export function trafficInstanceCounts(schedules: readonly LaneSchedule[], total: number): Map<MobilityModel, number> {
  const caps = laneCaps(total, schedules.length), counts = new Map<MobilityModel, number>();
  schedules.forEach(({ cars, window }, lane) => {
    const peak = new Map<MobilityModel, number>();
    cars.forEach((car, index) => {
      let same = 0;
      for (let j = index; j >= 0 && car.depart - cars[j]!.depart < window; j--) if (cars[j]!.model === car.model) same++;
      peak.set(car.model, Math.max(peak.get(car.model) ?? 0, Math.min(caps[lane]!, same)));
    });
    peak.forEach((value, model) => counts.set(model, Math.min(total, (counts.get(model) ?? 0) + value)));
  });
  return counts;
}

/** Distance along the lane `elapsed` seconds after departure, with the crossing stop (if any). */
export function freeTravel(lane: TrafficLane, half: number, elapsed: number, length = laneLength(lane), out = { position: 0, stopped: false }) {
  const stopDistance = lane.crossing ? length / 2 - TRAFFIC_TIMING.stopLine - half : Infinity;
  const stopAt = stopDistance / lane.speed;
  if (elapsed < stopAt) { out.position = elapsed * lane.speed; out.stopped = false; }
  else if (elapsed < stopAt + TRAFFIC_TIMING.wait) { out.position = stopDistance; out.stopped = true; }
  else { out.position = stopDistance + (elapsed - stopAt - TRAFFIC_TIMING.wait) * lane.speed; out.stopped = false; }
  return out;
}
export interface TrafficCarPose {
  id: number; lane: number; model: MobilityModel; tone: string;
  x: number; y: number; z: number; yaw: number;
  /** Waiting (at the crossing or queued behind a waiting car): brake lamps on. */
  stopped: boolean;
  /** Metres travelled along the lane: drives wheel spin and holds still while waiting. */
  distance: number;
  visible: boolean;
}
export const createTrafficPose = (): TrafficCarPose => ({ id: -1, lane: 0, model: 'mobility-sedan', tone: '#ffffff', x: 0, y: 0, z: 0, yaw: 0, stopped: false, distance: 0, visible: false });
const scratchTravel = { position: 0, stopped: false };
/**
 * Every moving car at `seconds`, written into `out` (no allocation); returns the count. Each car
 * drives its own free profile but never closer to the car ahead than half lengths plus clearance,
 * so a platoon queues behind a waiting car (brakes on) and creeps up to the stop line in turn.
 */
export function updateTraffic(schedules: readonly LaneSchedule[], admitted: readonly Uint8Array[], seconds: number, density: number,
  out: TrafficCarPose[], reducedMotion = false): number {
  if (reducedMotion) return 0;
  let count = 0;
  for (const { lane, index, cycle, phase, window, cars } of schedules) {
    const local = ((seconds + phase) % cycle + cycle) % cycle;
    const dx = lane.to[0] - lane.from[0], dz = lane.to[1] - lane.from[1], length = Math.hypot(dx, dz), yaw = Math.atan2(dx, dz);
    let leader = Infinity, leaderHalf = 0, leaderStopped = false;
    const allowed = admitted[index];
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i]!;
      if (car.depart > local) break;
      if (local - car.depart > window || (allowed && !allowed[i]) || !carActive(car, density)) continue;
      const free = freeTravel(lane, car.half, local - car.depart, length, scratchTravel);
      const limit = leader - leaderHalf - car.half - TRAFFIC_TIMING.clearance;
      const position: number = free.position <= limit ? free.position : limit;
      const stopped: boolean = free.position <= limit ? free.stopped : leaderStopped;
      leader = position; leaderHalf = car.half; leaderStopped = stopped;
      if (position < 0 || position > length || count >= out.length) continue;
      const pose = out[count++]!, t = position / length;
      pose.id = car.id; pose.lane = index; pose.model = car.model; pose.tone = car.tone;
      pose.x = lane.from[0] + dx * t; pose.y = lane.top + .015; pose.z = lane.from[1] + dz * t; pose.yaw = yaw;
      pose.stopped = stopped; pose.distance = position; pose.visible = true;
    }
  }
  for (let i = count; i < out.length; i++) out[i]!.visible = false;
  return count;
}

/** The day's schedule (pinned by `?carSeed=` in development) and its per-model instance bounds. */
export const TRAFFIC_SCHEDULE: readonly LaneSchedule[] = Object.freeze(trafficSchedule(ROTATION_SEED));

/** Rolling angle (radians about the axle) for a wheel of `radius` after `distance` metres. */
export function wheelSpin(distance: number, radius: number): number {
  return radius > 0 ? distance / radius : 0;
}
