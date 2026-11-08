import { QA_HOOKS } from './qaHooks';
import { ROAD_NETWORK, type TrafficLane } from './campusRoadNetwork';
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

/** Directed lanes of the district road network (left-hand traffic), shared with the parking lots. */
export type { TrafficLane } from './campusRoadNetwork';
export const TRAFFIC_LANES: readonly TrafficLane[] = ROAD_NETWORK.lanes;
export const laneLength = (lane: Pick<TrafficLane, 'from' | 'to'>) => Math.hypot(lane.to[0] - lane.from[0], lane.to[1] - lane.from[1]);

/**
 * Traffic comes in waves: platoons of one to three cars a few seconds apart, then a quiet gap, from
 * every network entry. `clearance` is the bumper-to-bumper minimum, `stopLine` the distance from the
 * crossing centre to a waiting car's front bumper, `wait` the stop there while pedestrians cross.
 * `accel`/`decel` (m/s²) shape speed changes; `request` is how far ahead of a junction a car asks
 * for it; `patience` how long a departure may wait at a full network entry before it is dropped.
 */
export const TRAFFIC_TIMING = Object.freeze({
  groupSizes: [.4, .35, .25] as readonly number[], headway: [2.2, 4] as const, gap: [16, 46] as const,
  wait: 3.2, clearance: 1.8, stopLine: 3.4, longVehicle: .05,
  accel: 2.2, decel: 3.2, request: 14, patience: 8, follow: .6,
});
/** Seeded generator shared by the traffic and parking schedules. */
export const seededRandom = random;
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}
export const TRAFFIC_TONES = ['#d8e5dd', '#748d9a', '#c6c2b6', '#527d7d', '#e5e1d7', '#9c6552', '#a3bec5', '#2f3a40', '#b8b1a3', '#7b2f2a'] as const;
/** Common styles of the day drive (weight ≥ 1); traffic-only vehicles join straight routes, rarely. */
export function trafficPool(styles: readonly CatalogVehicle[]) {
  return { cars: styles.filter(vehicle => !vehicle.trafficOnly && vehicle.weight >= 1), long: styles.filter(vehicle => vehicle.trafficOnly) };
}
export function weightedChoice<T extends { weight: number }>(pool: readonly T[], u: number): T {
  const total = pool.reduce((sum, item) => sum + item.weight, 0);
  let left = u * total;
  for (const item of pool) { left -= item.weight; if (left < 0) return item; }
  return pool[pool.length - 1]!;
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
export function carActive(car: { lead: boolean; groupRank: number; rank: number }, density: number): boolean {
  return car.groupRank < density && (car.lead || car.rank < .35 + .65 * density);
}

export interface TrafficCarPose {
  id: number;
  /** The lane the car is on, or (inside a junction) the lane it is turning into. */
  lane: number;
  model: MobilityModel; tone: string;
  x: number; y: number; z: number; yaw: number;
  /** Braking or standing (at a junction, the crossing or in a queue): brake lamps on. */
  stopped: boolean;
  /** Odometer (metres): drives wheel spin and holds still while waiting. */
  distance: number;
  /** Centre position along `lane` (negative while still turning into it). */
  along: number;
  /** The next lane on the car's route and its distance to that lane's start (negative), else -1 / 0. */
  feed: number; feedAt: number;
  /** Road surface height under the car (lamp decals). */
  top: number;
  /** Turn signal: 1 left (the car's +X side), -1 right, 0 off. */
  signal: number;
  visible: boolean;
}
export const createTrafficPose = (): TrafficCarPose => ({
  id: -1, lane: 0, model: 'mobility-sedan', tone: '#ffffff', x: 0, y: 0, z: 0, yaw: 0, stopped: false, distance: 0, along: 0, feed: -1, feedAt: 0, top: 0, signal: 0, visible: false,
});

/** Rolling angle (radians about the axle) for a wheel of `radius` after `distance` metres. */
export function wheelSpin(distance: number, radius: number): number {
  return radius > 0 ? distance / radius : 0;
}
