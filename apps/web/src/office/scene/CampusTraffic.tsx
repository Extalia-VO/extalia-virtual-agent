/* eslint-disable react-hooks/immutability -- Instanced Three.js matrices and materials are renderer-owned mutable resources. */
import { QA_HOOKS } from './qaHooks';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  AdditiveBlending, CanvasTexture, Color, DynamicDrawUsage, Float32BufferAttribute, InstancedBufferAttribute, Matrix4, MeshBasicMaterial, MeshStandardMaterial, Object3D, PlaneGeometry,
  ShaderMaterial, SpotLight, SRGBColorSpace, Vector3, type BufferGeometry, type Group, type InstancedMesh,
} from 'three';
import { sceneLocalMinutes, useSolarEnvironment, type LightOverride, type SceneSky } from './Environment';
import { getRenderBudget, getRenderBudgetLevel, RENDER_BUDGET_LEVELS } from './environment/renderBudget';
import { createMobilityFallbackModels, disposeMobilityLibrary, USED_MOBILITY_MODELS, useCampusMobilityModels, type MobilityGeometry, type MobilityWheels } from './CampusMobilityModels';
import {
  CYCLE_SHELTER, DAILY_CATALOG, EV_CHARGERS, FORCED_THEME_DENSITY, MOBILITY_MODELS, PARKED_VEHICLES, ROTATION_SEED, TRAFFIC_LANES, VEHICLE_SPECS,
  isMobilityVehicle, trafficDensity, wheelSpin,
  type MobilityModel, type ParkedVehicle, type TrafficCarPose, type TrafficLane,
} from './campusMobilityLayout';
import { ROAD_NETWORK, ROAD_TOP } from './campusRoadNetwork';
import {
  TRAFFIC_STEP, TRAFFIC_WARMUP, adoptCar, advanceTrafficNetwork, canAdoptCar, createTrafficNetwork, dispatchCar, hideTrafficNetwork, networkDebug,
  stepTrafficNetwork, trafficModelSlots, type TrafficNetwork, type TrafficStepInput,
} from './trafficNetwork';
import {
  MANEUVER_LOTS, MAX_LOT_MANEUVERS, adoptArrival, createParkingSim, lotManeuverCap, lotModelCapacity, parkedAt, parkingDebug, settleParking, stepParking, triggerManeuver,
  unmanagedParked, type ManeuverKind, type ManeuverPose, type ParkingSim, type ParkingStepOptions, type TrafficContext,
} from './parkingManeuvers';
import {
  BEAM_LENGTH, BEAM_TUCK, BEAM_WIDTH, DECAL_LIFT, HEAD_GLARE_SIZE, HEADLIGHT_SPOT, REAR_POOL_LENGTH, REAR_POOL_TUCK, REAR_POOL_WIDTH,
  carPoint, headlightPoolLevels, headlightSpotAim, lampGlareLevels, vehicleLampAnchors, type VehicleLampAnchors,
} from './campusVehicleLamps';

/**
 * Lamp power. Site fixtures (charger, shelter) and moving cars follow the light control:
 * `auto` uses the exterior photocell (dusk, blue hour and night), `on`/`off` force it.
 * Parked cars never light up.
 */
export function mobilityLampPower(model: MobilityModel, night: number, override: LightOverride, moving = false): number {
  const exterior = Math.max(0, Math.min(1, night));
  if (isMobilityVehicle(model) && !moving) return 0;
  return override === 'off' ? 0 : override === 'on' ? 1 : exterior;
}

/** Batch-owned attributes must never mutate the shared loaded or fallback geometry. */
export function createMobilityLampGeometry(source: BufferGeometry, model: MobilityModel, parked: number, moving: number): BufferGeometry {
  const geometry = source.clone();
  const emission = new Float32Array(parked + moving);
  for (let i = 0; i < emission.length; i++) emission[i] = !isMobilityVehicle(model) || i >= parked ? 1 : 0;
  // Lot cars switch between parked (dark) and manoeuvring (lit) in place, so emission is per frame too.
  geometry.setAttribute('mobilityEmission', new InstancedBufferAttribute(emission, 1).setUsage(DynamicDrawUsage));
  const brake = new InstancedBufferAttribute(new Float32Array(parked + moving), 1);
  brake.setUsage(DynamicDrawUsage);
  geometry.setAttribute('mobilityBrake', brake);
  geometry.setAttribute('mobilityReverse', new InstancedBufferAttribute(new Float32Array(parked + moving), 1).setUsage(DynamicDrawUsage));
  if (!geometry.getAttribute('mobilityTail')) geometry.setAttribute('mobilityTail', new Float32BufferAttribute(new Float32Array(geometry.getAttribute('position').count), 1));
  return geometry;
}

/** Headlamp lenses run hotter than the base lamp level; brake lamps glow brighter than running tail lamps. */
export const HEAD_GAIN = 1.8, TAIL_RUNNING = .65, TAIL_BRAKE = 2.4;
/** Reversing: the tail lenses turn mostly white (a cheap reverse lamp) and brighter. */
export const REVERSE_WHITE = .75, REVERSE_GAIN = 1.6;
export function lampEmissionScale(tail: boolean, braking: boolean): number { return tail ? (braking ? TAIL_BRAKE : TAIL_RUNNING) : HEAD_GAIN; }

const scratchHub = new Matrix4(), scratchTurn = new Matrix4(), scratchSpin = new Matrix4();
/**
 * World matrix of one wheel: car pose, hub offset, a half-turn for the right-hand side so
 * the rim faces outwards, then the rolling angle about the axle (negated on the mirrored side).
 */
export function wheelMatrix(car: Matrix4, hub: MobilityWheels['hubs'][number], angle: number, target = new Matrix4()): Matrix4 {
  scratchHub.makeTranslation(hub.x, hub.y, hub.z);
  scratchTurn.makeRotationY(hub.side < 0 ? Math.PI : 0);
  scratchSpin.makeRotationX(hub.side < 0 ? -angle : angle);
  return target.multiplyMatrices(car, scratchHub).multiply(scratchTurn).multiply(scratchSpin);
}

/** Pooled headlight spot for one car: lamp-pair centre to 12 m ahead on its centreline, on the road. */
export function trafficHeadlightBeam(lane: Pick<TrafficLane, 'top'>, pose: Pick<TrafficCarPose, 'x' | 'y' | 'z' | 'yaw' | 'visible'>, lamps: VehicleLampAnchors, power: number, hidden = false) {
  const { position, aim } = headlightSpotAim(pose, lamps, lane.top);
  return { position, aim, intensity: !hidden && pose.visible ? HEADLIGHT_SPOT.intensity * Math.max(0, Math.min(1, power)) : 0 };
}

/** Real spot lights for moving cars: at most two, only while the render budget keeps live beams. */
export const HEADLIGHT_SPOT_BUDGET = 2;
export function headlightSpotCount(liveBeams: number, lampPower: number): number {
  return liveBeams > 0 && lampPower > .02 ? HEADLIGHT_SPOT_BUDGET : 0;
}
/** The visible moving cars nearest the camera receive the pooled spot lights. */
export function allocateHeadlightSpots(cars: readonly { id: string; x: number; z: number; visible: boolean }[], camera: { x: number; z: number }, count: number): string[] {
  return cars.filter(car => car.visible)
    .map(car => ({ id: car.id, distance: Math.hypot(car.x - camera.x, car.z - camera.z) }))
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, Math.min(HEADLIGHT_SPOT_BUDGET, count))).map(car => car.id);
}

/**
 * The nearest `limit` visible cars to `focus`, written into `out` as car ids (no allocation;
 * ties keep the lower id). Returns how many were found.
 */
export function nearestTrafficCars(poses: readonly Pick<TrafficCarPose, 'id' | 'x' | 'z' | 'visible'>[], count: number, focus: { x: number; z: number }, limit: number, out: number[]): number {
  const wanted = Math.max(0, Math.min(HEADLIGHT_SPOT_BUDGET, limit, out.length));
  let found = 0, d0 = Infinity, d1 = Infinity;
  for (let i = 0; i < count && wanted; i++) {
    const pose = poses[i]!;
    if (!pose.visible) continue;
    const d = Math.hypot(pose.x - focus.x, pose.z - focus.z);
    if (d < d0 || (d === d0 && pose.id < out[0]!)) { out[1] = out[0]!; d1 = d0; out[0] = pose.id; d0 = d; }
    else if (wanted > 1 && (d < d1 || (d === d1 && pose.id < out[1]!))) { out[1] = pose.id; d1 = d; }
    found = Math.min(wanted, found + 1);
  }
  for (let i = found; i < out.length; i++) out[i] = -1;
  return found;
}

/** Most moving cars the top render tier allows; instance buffers are sized for it once. */
export const MAX_TRAFFIC_CARS = Math.max(...RENDER_BUDGET_LEVELS.map(level => level.trafficCars));
export function trafficCarCap(level: number): number {
  return RENDER_BUDGET_LEVELS[Math.max(0, Math.min(RENDER_BUDGET_LEVELS.length - 1, Math.round(level)))]!.trafficCars;
}
/** Lot cars that can manoeuvre at once (every lot at its top-tier cap): sized once for the road-light batches. */
export const MAX_LOT_CARS = MANEUVER_LOTS.length * MAX_LOT_MANEUVERS;
/** Cars leaving or heading for a lot may drive on the network above the tier cap, up to the lots' own manoeuvre budget. */
export function trafficHeadroom(level: number): number { return MANEUVER_LOTS.length * lotManeuverCap(trafficCarCap(level)); }
/** Network car pool: the top-tier cap plus the lot headroom. */
export const TRAFFIC_POOL = MAX_TRAFFIC_CARS + MAX_LOT_CARS;
/** Moving instances per model: its spawn cap on the network, plus the lot headroom for parkable styles. */
export const TRAFFIC_INSTANCES: ReadonlyMap<MobilityModel, number> = trafficModelSlots(DAILY_CATALOG, MAX_TRAFFIC_CARS, MAX_LOT_CARS).slots;
/** Density for the scene's sky: real local time when following the sun, a fixed level for forced themes. */
export function trafficDensityFor(sky: SceneSky, minutes: number): number {
  return sky === 'day' ? FORCED_THEME_DENSITY.day : sky === 'night' ? FORCED_THEME_DENSITY.night : trafficDensity(minutes);
}
/** Local time for the lots' arrival/departure mix: the forced themes show a calm afternoon and an early evening. */
export function lotMinutesFor(sky: SceneSky, minutes: number): number {
  return sky === 'day' ? 14 * 60 : sky === 'night' ? 21 * 60 : minutes;
}
/** Simulated seconds run before the first frame (the roads start busy, not empty). */
const WARMUP = Math.min(TRAFFIC_WARMUP, 90);

/**
 * One traffic clock, network and pose pool, advanced once per rendered frame however many consumers
 * read it, in fixed-size substeps (at most `TRAFFIC_STEP`). The render tier sets the car cap; density
 * follows local time (refreshed every 2 s). The parking lots advance on the same substeps right after
 * the network (pinning the clock freezes both) and hand cars to and from it.
 */
interface TrafficSim {
  seconds: number; stamp: number; pinned?: boolean;
  sky: SceneSky; density: number; densityOverride?: number; nextDensity: number; minutes: number;
  level: number; net: TrafficNetwork; input: TrafficStepInput & { obstacles: ManeuverPose[] };
  parking: ParkingSim; parkingOptions: ParkingStepOptions & { traffic: TrafficContext };
  /** Every moving car that may carry lamps this frame: traffic poses, then the lit manoeuvring lot cars. */
  lights: TrafficCarPose[]; lightCount: number;
}
/** A fresh network warmed up for `seconds`, its lot hand-offs wired to `sim`. */
function buildNetwork(sim: Pick<TrafficSim, 'parking' | 'input'>, seconds: number): TrafficNetwork {
  const net = createTrafficNetwork(ROTATION_SEED, DAILY_CATALOG, TRAFFIC_POOL, { total: MAX_TRAFFIC_CARS, headroom: MAX_LOT_CARS });
  net.arrive = car => adoptArrival(sim.parking, car.lot, { model: car.model, tone: car.tone, bay: car.bay, s: car.s, v: car.v, distance: car.odometer });
  advanceTrafficNetwork(net, seconds, sim.input);
  return net;
}
function createTrafficSim(): TrafficSim {
  const parking = createParkingSim(ROTATION_SEED), level = getRenderBudgetLevel();
  const input = { density: FORCED_THEME_DENSITY.day, cap: trafficCarCap(level), headroom: trafficHeadroom(level),
    obstacles: parking.lots.flatMap(lot => lot.maneuvers.map(maneuver => maneuver.pose)) };
  const sim = { parking, input } as TrafficSim;
  const net = buildNetwork(sim, WARMUP);
  const traffic: TrafficContext = {
    poses: net.poses, count: net.count, seconds: 0, density: input.density,
    canAdopt: model => canAdoptCar(sim.net, model),
    adopt: (lane, along, speed, car) => adoptCar(sim.net, lane, along, speed, car),
    dispatch: (lot, lane, model, tone, bay, u) => dispatchCar(sim.net, lot, lane, model, tone, bay, u),
  };
  return Object.assign(sim, {
    seconds: 0, stamp: -1, sky: 'day' as SceneSky, density: input.density, nextDensity: 0, minutes: 14 * 60, level, net,
    parkingOptions: { minutes: 14 * 60, density: input.density, cap: 0, reducedMotion: false, traffic },
    lights: Array.from({ length: TRAFFIC_POOL + MAX_LOT_CARS }, () => net.poses[0]!), lightCount: 0,
  });
}
/** Development: rebuild the network at `seconds` (warm-up included); cars bound for a lot release their reservations. */
function resetNetwork(sim: TrafficSim, seconds: number) {
  for (const car of sim.net.cars) if (car.active && car.lot >= 0) adoptArrival(sim.parking, car.lot, { model: car.model, tone: car.tone, bay: -1, s: Infinity, v: 0, distance: 0 });
  for (const job of sim.net.dispatches) if (job.active) adoptArrival(sim.parking, job.lot, { model: job.model, tone: job.tone, bay: -1, s: Infinity, v: 0, distance: 0 });
  sim.net = buildNetwork(sim, WARMUP + seconds);
  sim.parkingOptions.traffic.poses = sim.net.poses;
}
const isLotPose = (pose: TrafficCarPose): pose is ManeuverPose => 'phase' in pose;
function collectLights(sim: TrafficSim) {
  let count = 0;
  for (let i = 0; i < sim.net.count; i++) sim.lights[count++] = sim.net.poses[i]!;
  for (const lot of sim.parking.lots) for (const maneuver of lot.maneuvers) {
    if (maneuver.pose.visible && maneuver.pose.lit > 0 && count < sim.lights.length) sim.lights[count++] = maneuver.pose;
  }
  sim.lightCount = count;
}
function syncParkingOptions(sim: TrafficSim, reducedMotion: boolean) {
  const options = sim.parkingOptions, traffic = options.traffic;
  options.minutes = sim.minutes; options.density = sim.density; options.reducedMotion = reducedMotion;
  options.cap = lotManeuverCap(trafficCarCap(sim.level));
  traffic.count = sim.net.count; traffic.seconds = sim.seconds; traffic.density = sim.density;
  return options;
}
function stepTraffic(sim: TrafficSim, stamp: number, delta: number, hidden: boolean, reducedMotion: boolean) {
  if (sim.stamp === stamp) return;
  sim.stamp = stamp;
  // Hidden (tab or view): the clock and every car stand still and nothing is recomputed.
  if (hidden) return;
  if (stamp >= sim.nextDensity) {
    sim.nextDensity = stamp + 2;
    const minutes = sceneLocalMinutes();
    sim.density = sim.densityOverride ?? trafficDensityFor(sim.sky, minutes);
    sim.minutes = lotMinutesFor(sim.sky, minutes);
  }
  const level = getRenderBudgetLevel();
  if (level !== sim.level) sim.level = level;
  const input = sim.input;
  input.density = sim.density; input.cap = trafficCarCap(level); input.headroom = trafficHeadroom(level);
  if (reducedMotion) {
    // Reduced motion: empty roads (the network holds still) and settled lots.
    hideTrafficNetwork(sim.net);
    stepParking(sim.parking, 0, syncParkingOptions(sim, true));
  } else {
    const dt = sim.pinned ? 0 : Math.min(.1, Math.max(0, delta)), steps = Math.ceil(dt / TRAFFIC_STEP - 1e-9);
    // Network first, then the lots (they see this substep's traffic and may hand cars over).
    for (let i = 0; i < steps; i++) {
      sim.seconds += dt / steps;
      stepTrafficNetwork(sim.net, dt / steps, input);
      stepParking(sim.parking, dt / steps, syncParkingOptions(sim, false));
    }
    if (!steps) stepParking(sim.parking, 0, syncParkingOptions(sim, false));
  }
  collectLights(sim);
}

/**
 * Per-model instance layout: site fixtures (and any parked car outside a managed lot), then the
 * lot cars (parked, then manoeuvring: a car switches from parked to moving within this range
 * without a new draw), then traffic.
 */
interface MobilityInstances { fixed: readonly ParkedVehicle[]; lot: number; moving: number }
const LOT_CAPACITY = lotModelCapacity();
const STATIC_VEHICLES = unmanagedParked();
const instances = new Map<MobilityModel, MobilityInstances>(MOBILITY_MODELS.map(model => [model, {
  fixed: [...STATIC_VEHICLES, ...EV_CHARGERS, CYCLE_SHELTER].filter(vehicle => vehicle.model === model),
  lot: isMobilityVehicle(model) ? LOT_CAPACITY.get(model) ?? 0 : 0,
  moving: TRAFFIC_INSTANCES.get(model) ?? 0,
}]));
const tones = new Map<string, Color>();
const toneColour = (tone: string) => { let colour = tones.get(tone); if (!colour) tones.set(tone, colour = new Color(tone)); return colour; };

function visibleInHierarchy(object: Object3D | null): boolean {
  for (let node = object; node; node = node.parent) if (!node.visible) return false;
  return object !== null;
}

function MobilityBatch({ model, geometry, sim }: { model: MobilityModel; geometry: MobilityGeometry; sim: TrafficSim }) {
  const { state, lightOverride, reducedMotion } = useSolarEnvironment();
  const body = useRef<InstancedMesh>(null), lamp = useRef<InstancedMesh>(null), wheel = useRef<InstancedMesh>(null);
  const group = useRef<Group>(null);
  const config = instances.get(model)!;
  const fixed = config.fixed.length, parked = fixed + config.lot, count = parked + config.moving;
  const hubs = geometry.wheels?.hubs ?? [];
  const scratch = useMemo(() => new Object3D(), []);
  const wheelScratch = useMemo(() => new Matrix4(), []);
  // Car key drawn in each dynamic slot (its tone is re-applied only when that changes), the lot
  // layout version last packed, how many parked lot cars precede the moving ones, and the dynamic count.
  const slots = useMemo(() => ({ ids: new Int32Array(count).fill(-1), version: -1, statics: 0, used: -1 }), [count]);
  const lampGeometry = useMemo(() => createMobilityLampGeometry(geometry.lamp, model, parked, config.moving), [geometry.lamp, model, parked, config]);
  useEffect(() => () => lampGeometry.dispose(), [lampGeometry]);
  const materials = useMemo(() => {
    const body = new MeshStandardMaterial({ name: `campus-${model}-body`, color: '#ffffff', vertexColors: true, metalness: .25, roughness: .42 });
    const wheel = new MeshStandardMaterial({ name: `campus-${model}-wheels`, color: '#ffffff', vertexColors: true, metalness: .3, roughness: .6 });
    const lamp = new MeshStandardMaterial({ name: `campus-${model}-lamp`, color: '#ffffff', vertexColors: true, emissive: '#ffffff', emissiveIntensity: 0, roughness: .3, toneMapped: false });
    // Standard emissive radiance otherwise ignores vertex colours, turning red tail lamps and
    // green charging indicators white when their power rises. Tail lamps run dimmer and brake brighter;
    // a reversing car's tail lenses turn mostly white (reverse lamp).
    lamp.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute float mobilityEmission;\nattribute float mobilityBrake;\nattribute float mobilityTail;\nattribute float mobilityReverse;\nvarying float vMobilityEmission;\nvarying float vMobilityReverse;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>\nvMobilityReverse = mobilityReverse * mobilityTail;\nvMobilityEmission = mobilityEmission * mix(${HEAD_GAIN.toFixed(2)}, mix(${TAIL_RUNNING.toFixed(2)}, ${TAIL_BRAKE.toFixed(2)}, mobilityBrake), mobilityTail) * (1.0 + ${(REVERSE_GAIN - 1).toFixed(2)} * vMobilityReverse);`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vMobilityEmission;\nvarying float vMobilityReverse;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vMobilityEmission;\n#ifdef USE_COLOR\n totalEmissiveRadiance *= mix(vColor.rgb, vec3(1.0), ${REVERSE_WHITE.toFixed(2)} * vMobilityReverse);\n#endif`);
    };
    lamp.customProgramCacheKey = () => 'campus-mobility-coloured-lamps-v5';
    return { body, lamp, wheel };
  }, [model]);
  useEffect(() => () => { materials.body.dispose(); materials.lamp.dispose(); materials.wheel.dispose(); }, [materials]);
  useEffect(() => {
    materials.lamp.emissiveIntensity = mobilityLampPower(model, state.factors.exteriorLightFactor, lightOverride, true) * 1.25;
  }, [materials, model, state.factors.exteriorLightFactor, lightOverride]);

  const setWheels = (index: number, car: Matrix4, angle: number) => {
    const radius = geometry.wheels?.radius ?? 0;
    hubs.forEach((hub, h) => wheel.current?.setMatrixAt(index * hubs.length + h, wheelMatrix(car, hub, radius ? angle : 0, wheelScratch)));
  };
  const place = (slot: number, x: number, y: number, z: number, yaw: number) => {
    scratch.position.set(x, y, z);
    scratch.rotation.set(0, yaw, 0);
    scratch.scale.setScalar(1);
    scratch.updateMatrix();
    body.current!.setMatrixAt(slot, scratch.matrix);
    lamp.current!.setMatrixAt(slot, scratch.matrix);
  };

  /**
   * Pack this model's cars after the fixed slots: parked lot cars (re-packed only when the lots'
   * layout changes), then manoeuvring lot cars, then traffic; draw only the used slots.
   */
  const update = () => {
    const bodies = body.current, lamps = lamp.current;
    if (!bodies || !lamps) return;
    const brake = lampGeometry.getAttribute('mobilityBrake') as InstancedBufferAttribute;
    const emission = lampGeometry.getAttribute('mobilityEmission') as InstancedBufferAttribute;
    const reverse = lampGeometry.getAttribute('mobilityReverse') as InstancedBufferAttribute;
    const parking = sim.parking, radius = geometry.wheels?.radius ?? 0;
    let slot = fixed, recoloured = false;
    const repack = slots.version !== parking.version;
    if (repack) {
      slots.version = parking.version;
      for (const lot of parking.lots) for (let b = 0; b < lot.lot.bays.length && slot < parked; b++) {
        if (parkedAt(lot, b) !== model) continue;
        const bay = lot.lot.bays[b]!;
        place(slot, bay.x, lot.lot.top + .015, bay.z, bay.yaw);
        setWheels(slot, scratch.matrix, 0);
        emission.setX(slot, 0); brake.setX(slot, 0); reverse.setX(slot, 0);
        bodies.setColorAt(slot, toneColour(lot.tones[b]!)); slots.ids[slot] = -1; recoloured = true;
        slot++;
      }
      slots.statics = slot - fixed;
    } else slot += slots.statics;
    const dynamicStart = slot;
    for (const lot of parking.lots) for (const maneuver of lot.maneuvers) {
      const pose = maneuver.pose;
      if (!pose.visible || pose.model !== model || slot >= parked) continue;
      place(slot, pose.x, pose.y, pose.z, pose.yaw);
      setWheels(slot, scratch.matrix, wheelSpin(pose.distance, radius));
      emission.setX(slot, pose.lit); brake.setX(slot, pose.stopped ? 1 : 0); reverse.setX(slot, pose.reverse ? 1 : 0);
      if (slots.ids[slot] !== pose.id) { slots.ids[slot] = pose.id; bodies.setColorAt(slot, toneColour(pose.tone)); recoloured = true; }
      slot++;
    }
    // Traffic may also use lot slots left free (a departed lot car drives on as traffic).
    for (let i = 0; i < sim.net.count && slot < count; i++) {
      const pose = sim.net.poses[i]!;
      if (pose.model !== model) continue;
      place(slot, pose.x, pose.y, pose.z, pose.yaw);
      setWheels(slot, scratch.matrix, wheelSpin(pose.distance, radius));
      emission.setX(slot, 1); brake.setX(slot, pose.stopped ? 1 : 0); reverse.setX(slot, 0);
      if (slots.ids[slot] !== pose.id) { slots.ids[slot] = pose.id; bodies.setColorAt(slot, toneColour(pose.tone)); recoloured = true; }
      slot++;
    }
    const used = slot - dynamicStart;
    if (!repack && !used && !slots.used) return;
    slots.used = used;
    bodies.count = lamps.count = slot;
    bodies.visible = lamps.visible = slot > 0;
    if (wheel.current) { wheel.current.count = slot * hubs.length; wheel.current.visible = bodies.visible; wheel.current.instanceMatrix.needsUpdate = true; }
    bodies.instanceMatrix.needsUpdate = true; lamps.instanceMatrix.needsUpdate = true;
    brake.needsUpdate = true; emission.needsUpdate = true; reverse.needsUpdate = true;
    if (recoloured && bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
  };

  useLayoutEffect(() => {
    if (!body.current || !lamp.current) return;
    for (const mesh of [body.current, lamp.current, wheel.current]) mesh?.instanceMatrix.setUsage(DynamicDrawUsage);
    config.fixed.forEach((vehicle, index) => {
      place(index, vehicle.x, vehicle.y, vehicle.z, vehicle.yaw);
      body.current!.setColorAt(index, toneColour(vehicle.tone));
      setWheels(index, scratch.matrix, 0);
    });
    // Allocate the lot and moving slots' colours before the first draw; a rebuilt mesh re-tones and re-packs every slot.
    for (let index = fixed; index < count; index++) body.current.setColorAt(index, toneColour('#ffffff'));
    slots.ids.fill(-1); slots.version = -1; slots.statics = 0; slots.used = -1;
    body.current.instanceColor?.setUsage(DynamicDrawUsage);
    if (body.current.instanceColor) body.current.instanceColor.needsUpdate = true;
    update();
    for (const mesh of [body.current, lamp.current, wheel.current]) if (mesh) mesh.instanceMatrix.needsUpdate = true;
    // Geometry replacement after async load retains the same active traffic clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, config, scratch, slots, reducedMotion]);

  useFrame((frame, delta) => {
    if (!config.moving && !config.lot) return;
    const hidden = document.hidden || !visibleInHierarchy(group.current);
    stepTraffic(sim, frame.clock.elapsedTime, delta, hidden, reducedMotion);
    if (!hidden) update();
  });
  if (!count) return null;
  return <group ref={group} name={`campus-mobility-${model}`}>
    <instancedMesh ref={body} name={`${model}-bodies`} args={[geometry.body, materials.body, count]} frustumCulled={false} />
    <instancedMesh ref={lamp} name={`${model}-lamps`} args={[lampGeometry, materials.lamp, count]} frustumCulled={false} />
    {geometry.wheels && <instancedMesh ref={wheel} name={`${model}-wheels`} args={[geometry.wheels.geometry, materials.wheel, count * hubs.length]} frustumCulled={false} />}
  </group>;
}

/**
 * Road-light masks drawn once into a small canvas (no binary asset). `beam`: v=0 at the lamp,
 * a narrow bright throw widening into a soft trapezoid that fades out by the far end. `rear`:
 * a low elliptical glow just behind the tail lamp.
 */
export function roadLightMask(kind: 'beam' | 'rear', u: number, v: number): number {
  if (kind === 'beam') {
    const half = .14 + .86 * Math.pow(v, .7), across = Math.abs(u) / half;
    const lateral = Math.pow(Math.max(0, 1 - across * across), 1.5);
    const along = Math.min(1, v / .03) * Math.pow(1 - v, 1.7) * (.55 + .45 * Math.exp(-v * 5));
    return lateral * along;
  }
  const r = Math.hypot(u, (v - .3) / .7);
  return Math.max(0, 1 - r) ** 2 * Math.min(1, v / .08);
}
function maskTexture(kind: 'beam' | 'rear'): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = kind === 'beam' ? 256 : 64;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    const value = roadLightMask(kind, (x + .5) / canvas.width * 2 - 1, (y + .5) / canvas.height);
    const i = (y * canvas.width + x) * 4;
    image.data[i] = image.data[i + 1] = image.data[i + 2] = Math.round(255 * value);
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** Flat road decal: additive, unlit, no depth writes, pulled towards the camera against z-fighting. */
const roadDecal = (map: CanvasTexture) => new MeshBasicMaterial({ map, color: '#ffffff', transparent: true, blending: AdditiveBlending, depthWrite: false,
  toneMapped: false, fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });

/**
 * Lamp glare: a camera-facing soft halo per lamp (instance +Z is the lamp's facing). It fades
 * when the lamp faces away, is pulled slightly towards the viewer so its own lens panel does
 * not swallow it, and keeps a small minimum on-screen size when zoomed out.
 */
function glareMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    name: 'campus-traffic-lamp-glare', transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false,
    uniforms: { minimumSize: { value: .022 } },
    vertexShader: `
uniform float minimumSize;
varying vec2 vGlareUv;
varying vec3 vGlareColour;
void main() {
  mat4 world = modelMatrix * instanceMatrix;
  vec4 centre = viewMatrix * world * vec4(0.0, 0.0, 0.0, 1.0);
  vec3 facing = normalize((viewMatrix * world * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
  vec3 toViewer = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(-centre.xyz);
  float fade = smoothstep(0.08, 0.6, dot(facing, toViewer));
  float size = length(world[0].xyz) * mix(0.55, 1.0, fade);
  centre.xyz += toViewer * 0.25;
  vec4 clip = projectionMatrix * centre;
  size = max(size, minimumSize * clip.w / projectionMatrix[1][1]) * step(1e-4, length(world[0].xyz));
  centre.xy += position.xy * size;
  gl_Position = projectionMatrix * centre;
  vGlareUv = position.xy * 2.0;
  #ifdef USE_INSTANCING_COLOR
  vGlareColour = instanceColor * fade;
  #else
  vGlareColour = vec3(fade);
  #endif
}`,
    fragmentShader: `
varying vec2 vGlareUv;
varying vec3 vGlareColour;
void main() {
  float d2 = dot(vGlareUv, vGlareUv);
  float glow = (exp(-d2 * 26.0) + 0.5 * exp(-d2 * 5.0)) * (1.0 - smoothstep(0.7, 1.0, d2));
  gl_FragColor = vec4(vGlareColour * glow, 1.0);
  #include <colorspace_fragment>
}`,
  });
}

type TrafficQaWindow = Window & {
  __EXTALIA_TRAFFIC__?: () => unknown; __EXTALIA_TRAFFIC_PIN__?: (seconds?: number, density?: number) => void;
  __EXTALIA_PARKING_PIN__?: (kind?: ManeuverKind | 'none', options?: { lot?: string; bay?: string; advance?: number; settle?: boolean }) => unknown;
};

/** Where the view centre meets the road: "nearest to the camera" for the orthographic office view. */
export function viewFocus(camera: { x: number; y: number; z: number }, direction: { x: number; y: number; z: number }, groundY: number) {
  if (direction.y > -1e-3) return { x: camera.x, z: camera.z };
  const t = (groundY - camera.y) / direction.y;
  return { x: camera.x + direction.x * t, z: camera.z + direction.z * t };
}

/**
 * Road light for every moving car: two headlight beams and two rear pools per car (one
 * instanced decal batch each), four lamp glares per car (one batch), plus a two-light
 * budgeted spot pool on the cars nearest the view centre. Only the active cars' instances draw.
 */
function TrafficHeadlights({ sim, lamps }: { sim: TrafficSim; lamps: ReadonlyMap<MobilityModel, VehicleLampAnchors> }) {
  const { state, lightOverride, reducedMotion } = useSolarEnvironment();
  const group = useRef<Group>(null), beams = useRef<InstancedMesh>(null), pools = useRef<InstancedMesh>(null), glares = useRef<InstancedMesh>(null);
  useEffect(() => { sim.sky = state.sky; sim.nextDensity = 0; }, [sim, state.sky]);
  const resources = useMemo(() => {
    const beam = roadDecal(maskTexture('beam')), rear = roadDecal(maskTexture('rear'));
    // Local frames: beams run along +Z from just under the bumper; rear pools along -Z.
    const beamPlane = new PlaneGeometry(BEAM_WIDTH, BEAM_LENGTH).rotateX(-Math.PI / 2).translate(0, 0, BEAM_LENGTH / 2);
    const rearPlane = new PlaneGeometry(REAR_POOL_WIDTH, REAR_POOL_LENGTH).rotateX(-Math.PI / 2).rotateY(Math.PI).translate(0, 0, -REAR_POOL_LENGTH / 2);
    const glarePlane = new PlaneGeometry(1, 1);
    const glare = glareMaterial();
    const spots = Array.from({ length: HEADLIGHT_SPOT_BUDGET }, (_, index) => {
      const light = new SpotLight(HEADLIGHT_SPOT.color, 0, HEADLIGHT_SPOT.distance, HEADLIGHT_SPOT.angle, HEADLIGHT_SPOT.penumbra, HEADLIGHT_SPOT.decay);
      light.name = `traffic-headlight-spot-${index}`;
      light.castShadow = false;
      return light;
    });
    const scratch = new Object3D(), colour = new Color(), point = { x: 0, y: 0, z: 0 };
    /** Pose one decal or glare instance at `point`, facing `yaw`; scale 0 hides it. */
    const place = (mesh: InstancedMesh, slot: number, yaw: number, scale: number, r: number, g: number, b: number) => {
      scratch.position.set(point.x, point.y, point.z);
      scratch.rotation.set(0, yaw, 0);
      scratch.scale.setScalar(scale);
      scratch.updateMatrix();
      mesh.setMatrixAt(slot, scratch.matrix);
      mesh.setColorAt(slot, colour.setRGB(r, g, b));
    };
    return { beam, rear, glare, beamPlane, rearPlane, glarePlane, spots, assigned: Array.from({ length: HEADLIGHT_SPOT_BUDGET }, () => -1), nextAllocation: 0,
      colour, point, place, direction: new Vector3(), road: { top: 0 },
      poolLevels: headlightPoolLevels(0, false, false), glareLevels: lampGlareLevels(0, false, false) };
  }, []);
  useEffect(() => {
    if (!QA_HOOKS) return;
    // Development audit: schedule, density, cap, live cars, wheel distances and the headlight spot allocation.
    (window as TrafficQaWindow).__EXTALIA_TRAFFIC__ = () => {
      const round = (value: number) => Math.round(value * 100) / 100;
      return {
        seconds: sim.seconds, density: round(sim.density), tier: sim.level, cap: trafficCarCap(sim.level), headroom: trafficHeadroom(sim.level),
        maxCars: MAX_TRAFFIC_CARS, pool: TRAFFIC_POOL, active: sim.net.count, instances: Object.fromEntries(TRAFFIC_INSTANCES),
        rotation: { seed: ROTATION_SEED, styles: DAILY_CATALOG.map(vehicle => vehicle.style), parked: PARKED_VEHICLES.map(vehicle => vehicle.model) },
        network: { lanes: TRAFFIC_LANES.length, junctions: ROAD_NETWORK.nodes.filter(node => !node.boundary).length, turns: ROAD_NETWORK.turns.length,
          entries: ROAD_NETWORK.entries.map(lane => TRAFFIC_LANES[lane]!.id), held: sim.net.cars.filter(car => car.active && car.holds >= 0).map(car => ({ id: car.id, node: car.holds })) },
        cars: sim.net.poses.slice(0, sim.net.count).map(pose => ({ id: pose.id, lane: TRAFFIC_LANES[pose.lane]!.id, along: round(pose.along), model: pose.model, x: round(pose.x), z: round(pose.z), yaw: round(pose.yaw), stopped: pose.stopped, distance: round(pose.distance) })),
        routes: networkDebug(sim.net),
        spots: resources.spots.map((light, index) => ({ car: resources.assigned[index] ?? -1, intensity: round(light.intensity),
          position: light.position.toArray().map(round), aim: light.target.position.toArray().map(round) })),
        lamps: Object.fromEntries([...lamps].map(([model, anchors]) => [model, anchors])),
        // Lot manoeuvres: occupancy, next decision, each bay's car and state (parked/starting/reversing/driving/merging/arriving/parking).
        lots: parkingDebug(sim.parking), lotCap: lotManeuverCap(trafficCarCap(sim.level)), lotLog: sim.parking.log.slice(-12),
      };
    };
    // Development audit: start a departure or an arrival now (optionally from/into `bay`) and advance the lots by
    // `advance` seconds without new scheduled manoeuvres (`settle` first completes the running ones); pin the
    // traffic clock first to hold the frame still.
    (window as TrafficQaWindow).__EXTALIA_PARKING_PIN__ = (kind, options = {}) => {
      if (options.settle) settleParking(sim.parking);
      const started = kind === 'depart' || kind === 'arrive'
        ? triggerManeuver(sim.parking, options.lot ?? MANEUVER_LOTS[0]!.id, kind, options.bay, syncParkingOptions(sim, false).traffic) : false;
      const step = syncParkingOptions(sim, false), cap = step.cap;
      step.cap = 0;
      for (let i = Math.round(Math.max(0, options.advance ?? 0) * 30); i > 0; i--) stepParking(sim.parking, 1 / 30, step);
      step.cap = cap;
      if (!options.advance) stepParking(sim.parking, 0, step);
      collectLights(sim);
      return { started, lots: parkingDebug(sim.parking) };
    };
    // Development audit: pin the traffic clock (and optionally the density) for repeatable captures; no argument resumes it.
    // The network is a simulation: pinning rebuilds it and runs it (warm-up included) to `seconds` at the fixed step.
    (window as TrafficQaWindow).__EXTALIA_TRAFFIC_PIN__ = (seconds, density) => {
      sim.pinned = seconds !== undefined;
      sim.densityOverride = density; sim.nextDensity = 0;
      if (seconds !== undefined) {
        sim.seconds = seconds;
        if (density !== undefined) sim.density = sim.input.density = density;
        resetNetwork(sim, Math.max(0, seconds));
        syncParkingOptions(sim, false);
        collectLights(sim);
      }
    };
    return () => {
      delete (window as TrafficQaWindow).__EXTALIA_TRAFFIC__; delete (window as TrafficQaWindow).__EXTALIA_TRAFFIC_PIN__; delete (window as TrafficQaWindow).__EXTALIA_PARKING_PIN__;
    };
  }, [sim, resources, lamps]);
  useEffect(() => () => {
    resources.beam.map?.dispose(); resources.rear.map?.dispose(); resources.beam.dispose(); resources.rear.dispose(); resources.glare.dispose();
    resources.beamPlane.dispose(); resources.rearPlane.dispose(); resources.glarePlane.dispose(); resources.spots.forEach(light => light.dispose());
  }, [resources]);
  useLayoutEffect(() => {
    // Allocate instance colours before the first draw so every program compiles with them.
    for (const mesh of [beams.current, pools.current, glares.current]) if (mesh) {
      for (let i = 0; i < mesh.count; i++) mesh.setColorAt(i, resources.colour.setRGB(0, 0, 0));
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.instanceColor?.setUsage(DynamicDrawUsage);
      mesh.count = 0;
      mesh.visible = false;
    }
  }, [resources]);

  useFrame((frame, delta) => {
    const hidden = document.hidden || !visibleInHierarchy(group.current);
    stepTraffic(sim, frame.clock.elapsedTime, delta, hidden, reducedMotion);
    const beamMesh = beams.current, poolMesh = pools.current, glareMesh = glares.current;
    if (!beamMesh || !poolMesh || !glareMesh || hidden) return;
    const { point, spots, place, assigned } = resources;
    const power = mobilityLampPower('mobility-sedan', state.factors.exteriorLightFactor, lightOverride, true);
    // Traffic and the lit manoeuvring lot cars (lamps on from engine start until a second after parking).
    const cars = power > 0 ? sim.lightCount : 0;
    for (let index = 0; index < cars; index++) {
      const pose = sim.lights[index]!;
      const lot = isLotPose(pose), reversing = lot && pose.reverse;
      const anchors = lamps.get(pose.model), level = anchors ? power * (lot ? pose.lit : 1) : 0;
      const pool = headlightPoolLevels(level, pose.visible, pose.stopped || reversing, resources.poolLevels);
      const glare = lampGlareLevels(level, pose.visible, pose.stopped || reversing, resources.glareLevels);
      const top = pose.top;
      // Reverse lamp: the rear pool and tail glare turn white.
      const rearG = reversing ? .9 : .06, rearB = reversing ? .82 : .04, glareG = reversing ? .92 : .1, glareB = reversing ? .85 : .06;
      for (let side = 0; side < 2; side++) {
        const head = anchors?.head[side], tail = anchors?.tail[side];
        const slot = index * 2 + side;
        if (!head || !tail) { point.x = point.y = point.z = 0; place(beamMesh, slot, 0, 0, 0, 0, 0); place(poolMesh, slot, 0, 0, 0, 0, 0); place(glareMesh, slot * 2, 0, 0, 0, 0, 0); place(glareMesh, slot * 2 + 1, 0, 0, 0, 0, 0); continue; }
        carPoint(pose, head, -BEAM_TUCK, point); point.y = top + DECAL_LIFT;
        place(beamMesh, slot, pose.yaw, pool.head > 0 ? 1 : 0, pool.head, pool.head * .93, pool.head * .8);
        carPoint(pose, tail, REAR_POOL_TUCK, point); point.y = top + DECAL_LIFT;
        place(poolMesh, slot, pose.yaw, pool.tail > 0 ? 1 : 0, pool.tail, pool.tail * rearG, pool.tail * rearB);
        carPoint(pose, head, .03, point);
        place(glareMesh, slot * 2, pose.yaw, glare.head > 0 ? HEAD_GLARE_SIZE : 0, glare.head, glare.head * .94, glare.head * .82);
        carPoint(pose, tail, -.03, point);
        place(glareMesh, slot * 2 + 1, pose.yaw + Math.PI, glare.tail > 0 ? glare.tailSize : 0, glare.tail, glare.tail * glareG, glare.tail * glareB);
      }
    }
    // Daytime (or lights off, or an empty road): skip the three road-light draws entirely; otherwise draw only the active cars.
    const shown = cars > 0;
    if (shown || beamMesh.visible) for (const [mesh, perCar] of [[beamMesh, 2], [poolMesh, 2], [glareMesh, 4]] as const) {
      mesh.visible = shown; mesh.count = cars * perCar;
      if (shown) { mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; }
    }
    if (frame.clock.elapsedTime >= resources.nextAllocation) {
      resources.nextAllocation = frame.clock.elapsedTime + .2;
      const focus = viewFocus(frame.camera.position, frame.camera.getWorldDirection(resources.direction), ROAD_TOP);
      nearestTrafficCars(sim.lights, sim.lightCount, focus, headlightSpotCount(getRenderBudget().liveBeams, power), assigned);
    }
    spots.forEach((light, index) => {
      let pose: TrafficCarPose | undefined;
      for (let i = 0; i < sim.lightCount && assigned[index]! >= 0; i++) if (sim.lights[i]!.id === assigned[index]) { pose = sim.lights[i]; break; }
      const anchors = pose && lamps.get(pose.model);
      if (!pose || !anchors) { light.intensity = 0; return; }
      const car = pose;
      resources.road.top = car.top;
      const beam = trafficHeadlightBeam(resources.road, car, anchors, power * (isLotPose(car) ? car.lit : 1));
      light.position.set(beam.position.x, beam.position.y, beam.position.z);
      light.target.position.set(beam.aim.x, beam.aim.y, beam.aim.z);
      light.intensity = beam.intensity;
    });
  });
  return <group ref={group} name="campus-traffic-headlights" userData={{ officeDynamic: true }}>
    <instancedMesh ref={beams} name="traffic-headlight-beams" args={[resources.beamPlane, resources.beam, (TRAFFIC_POOL + MAX_LOT_CARS) * 2]} frustumCulled={false} renderOrder={2} />
    <instancedMesh ref={pools} name="traffic-tail-pools" args={[resources.rearPlane, resources.rear, (TRAFFIC_POOL + MAX_LOT_CARS) * 2]} frustumCulled={false} renderOrder={2} />
    <instancedMesh ref={glares} name="traffic-lamp-glares" args={[resources.glarePlane, resources.glare, (TRAFFIC_POOL + MAX_LOT_CARS) * 4]} frustumCulled={false} renderOrder={3} />
    {resources.spots.map(light => <group key={light.name}><primitive object={light} /><primitive object={light.target} /></group>)}
  </group>;
}

/**
 * Three geometry batches per vehicle model (body, lamps, instanced wheels; only parked, manoeuvring
 * and active moving instances draw), two per site fixture, two additive road-light batches, one
 * lamp-glare batch and a fixed two-spot headlight pool.
 */
export function CampusTraffic() {
  const loaded = useCampusMobilityModels();
  // Only today's rotation is built, batched and drawn: three batches per used model.
  const fallback = useMemo(() => createMobilityFallbackModels(USED_MOBILITY_MODELS), []);
  useEffect(() => () => disposeMobilityLibrary(fallback), [fallback]);
  // Lamp anchors for every car that can move: traffic styles and every style a lot car can take.
  const lamps = useMemo(() => new Map([...new Set([...TRAFFIC_INSTANCES.keys(), ...LOT_CAPACITY.keys()])].filter(model => USED_MOBILITY_MODELS.includes(model)).map(model => {
    if (!isMobilityVehicle(model)) throw new Error('Traffic requires a vehicle');
    const geometry = loaded?.get(model) ?? fallback.get(model)!;
    return [model, vehicleLampAnchors(geometry.lamp, VEHICLE_SPECS[model]!)];
  })), [loaded, fallback]);
  const sim = useMemo(() => createTrafficSim(), []);
  return <group name="campus-mobility" userData={{ officeCollision: false }}>
    {USED_MOBILITY_MODELS.map(model => <MobilityBatch key={model} model={model} geometry={loaded?.get(model) ?? fallback.get(model)!} sim={sim} />)}
    <TrafficHeadlights sim={sim} lamps={lamps} />
  </group>;
}
