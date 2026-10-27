/**
 * Pure per-character movement state machine: stand up, walk a planned route
 * (stairs included), ride an elevator through its controller, sit down or
 * leave. Positions are mutated in place; free-space trajectories are planned per trip.
 */
import { advanceNaturalWalk, createNaturalWalkState, naturalRoute, protectedHeadway, reconnectNaturalRoute, walkingSeed, type NaturalWalkState, type WalkableSegment, type WalkingNeighbor } from './naturalWalking';
import type { GaitParameters } from '../avatars/gait';
import type { Point3 } from '../layout';
import type { ElevatorId } from '../prefabs/architecture/elevatorController';
import { floorAt, floorY, planRoute, seatStageId, STAIR_SPEED_FACTOR, withElevator, type OfficeFloor, type OfficeNavigation, type RouteStep, type SeatApproach } from './navGraph';
import { advanceWalkDistance, advanceWalkPhase, angleDelta, createCharacterMotion, headingOf, smoothstep, turnToward, walkingSpeed, type CharacterMotion } from './walkCycle';
import { doorInteractionTempo, strideAndCadence } from './pace';
import { isDeskChair } from '../interior/deskChairs';
import { doorAxes, doorHandle, doorLeafDistance, doorHandedness, doorPoint as doorWorldPoint, DOOR_SWING_RATE, type DoorHit, type DoorInfo, type DoorTraffic } from '../interior/doorTraffic';
import { DOOR_BODY_CLEARANCE, doorClosePosition, doorEntryCloseHandWeight, doorOpenPosition, doorOpenHandWeight, doorSwingSide, doorWalkPath } from './doorChoreography';
import { ARMREST, BEAT_S, CHAIR_FRONT_APPROACH, chairManeuverSide, chairWalkPath, chairWorld, chairContactWorld, chairYaw, GRIP_BACK_Z, GRIP_HAND_X, GRIP_HEIGHT, GRIP_STAND, scootPull, SEAT_EDGE, sittingCentre, smooth01, standPull, toCharacterFrame, yawToward, type ChairSide } from './chairChoreography';
import { isStaticSeat, STATIC_BODY_RADIUS, staticSeatContact, staticSeatNeighborsClear, staticSeatRoute, type StaticSeatRoute } from './staticSeating';

/** `vanishing`: reached the waypoint where it leaves and fades out there; `gone` once invisible. */
export type MoverPhase = 'seated' | 'standing' | 'walking' | 'waiting' | 'boarding' | 'riding' | 'alighting' | 'sitting' | 'vanishing' | 'gone' | 'chairing' | 'doorwork' | 'seatwork';
/** Where a character is heading: its seat, or a waypoint where it leaves the scene. */
export type MoverGoal = { readonly kind: 'seat'; readonly seat: SeatApproach } | { readonly kind: 'leave'; readonly node: string };

/** The subset of the elevator controller a rider uses; injected for tests. */
export interface ElevatorAccess {
  request(riderId: string, from: OfficeFloor, to: OfficeFloor, elevatorId: ElevatorId): void;
  waitingSlot(riderId: string, elevatorId: ElevatorId): number | null;
  canBoard(riderId: string, elevatorId: ElevatorId): boolean;
  /** Reserved standing place in the cab, at the cab's current height. */
  standingPosition(riderId: string, elevatorId: ElevatorId): Point3 | null;
  confirmBoarded(riderId: string, elevatorId: ElevatorId): boolean;
  canExit(riderId: string, elevatorId: ElevatorId): boolean;
  confirmExited(riderId: string, elevatorId: ElevatorId): boolean;
  release(riderId: string, elevatorId: ElevatorId): void;
  /** Landing door threshold X and shaft centre Z. */
  door(elevatorId: ElevatorId): { readonly x: number; readonly z: number };
}

export interface MovementEnv {
  readonly navigation: OfficeNavigation;
  readonly elevators: ElevatorAccess;
  /** Lets automatic doors see a walker heading through them; `null` when it stops. */
  readonly trackWalker?: (id: string, position: Readonly<Point3> | null, target?: Readonly<Point3>) => void;
  /** Stationary bodies remain collision obstacles without requesting automatic doors. */
  readonly trackBody?: (id: string, position: Readonly<Point3> | null) => void;
  /** Doors on the way: hinged leaves are swung by hand, the last one through closes them. */
  readonly doors?: DoorTraffic;
  /** Static rendered floor/furniture clearance; absent keeps legacy exact paths. */
  readonly walkable?: WalkableSegment;
  /** Front contact may overlap its own cushion bounds, while other furniture still blocks it. */
  readonly seatContactClear?: (seat: SeatApproach, from: Readonly<Point3>, to: Readonly<Point3>, radius?: number) => boolean;
  readonly nearbyWalkers?: (id: string, position: Readonly<Point3>) => readonly WalkingNeighbor[];
}

/** A chair beat in progress: sitting down (grip, pull, let go, walk round, lower, scoot in) or standing up (walk out, grip, push in, let go). */
export interface ChairAct {
  readonly kind: 'sit' | 'stand';
  readonly seat: SeatApproach;
  readonly side: ChairSide;
  beat: number;
  timer: number;
  begun: boolean;
  /** Walk points still to reach in a walking beat. */
  path: Point3[];
}

export interface StaticSeatAct {
  kind: 'sit' | 'stand';
  readonly seat: SeatApproach;
  beat: 'approach' | 'contact' | 'align' | 'lower' | 'rise' | 'exit-contact' | 'exit';
  timer: number;
  retry: number;
  route: StaticSeatRoute | null;
  path: Point3[] | null;
  /** Reversible exterior corridor, also used when an approaching sitter is recalled. */
  trail: Point3[];
}

/** A hinged door in progress: stop and open it, wait for a free passage, or close it behind. */
export interface DoorAct {
  kind: 'open' | 'wait' | 'close' | 'pass';
  readonly id: string;
  readonly door: Readonly<DoorInfo>;
  timer: number;
  beat: 'reserve' | 'approach' | 'grip' | 'swing' | 'passage' | 'handoff' | 'release';
  side: 1 | -1;
  entrySide: 1 | -1;
  hand: 0 | 1;
  /** Fixed when the opening grip finishes; late arrivals cannot extend a released tug. */
  openAmount?: number;
  /** Entry-side closing tug, followed by a clear arc inside the moving free tip. */
  entryCloseStart?: number;
  path: Point3[] | null;
}

interface ElevatorTrip {
  readonly id: ElevatorId;
  readonly from: OfficeFloor;
  readonly to: OfficeFloor;
  readonly exit: Point3;
  /** Landing waypoint where the rider called the cab. */
  readonly landing: Point3;
  stage: 'approach' | 'door' | 'slot';
  requested: boolean;
  exited: boolean;
}

export interface Mover {
  readonly id: string;
  /** Feet position in world space (mutated in place). */
  readonly position: Point3;
  yaw: number;
  readonly motion: CharacterMotion;
  phase: MoverPhase;
  gait: GaitParameters;
  goal: MoverGoal | null;
  /** Seat currently sat on or walked to. */
  seat: SeatApproach | null;
  steps: RouteStep[];
  stepIndex: number;
  /** Waypoint where the current walk step started. */
  lastNode: string | null;
  /** The current step backs away from a chair without turning. */
  backing: boolean;
  timer: number;
  /** Start pose of a timed transition. */
  readonly from: Point3;
  fromYaw: number;
  fromSit: number;
  trip: ElevatorTrip | null;
  /** A new goal that waits until the cab ride or stand-up finishes. */
  pending: MoverGoal | null;
  /** Point walked toward during the last step, if any. */
  target: Readonly<Point3> | null;
  /** Lowest and highest floor this character is visible on right now. */
  floorLow: OfficeFloor;
  floorHigh: OfficeFloor;
  /** Walking pace over the gait's relaxed pace for the current trip (see `pace.ts` and `setPace`). */
  pace: number;
  /** Cadence share of `pace`; the stride share is `motion.stride`. */
  cadenceScale: number;
  /** 0 invisible … 1 fully drawn: arrivals fade in where they appear, departures fade out where they leave. */
  opacity: number;
  /** Chair in progress (phase `chairing`) and how far the chair is pulled out (0 tucked … 1 out), which only a held chair moves. */
  chair: ChairAct | null;
  chairPull: number;
  chairSide: ChairSide;
  chairSequence: number;
  staticSeat: StaticSeatAct | null;
  /** Door in progress (phase `doorwork`) and the door this walker has already been let through. */
  door: DoorAct | null;
  cleared: string | null;
  /** Position at the start of this frame (for door crossings). */
  readonly prev: Point3;
  /** Stable per-trip lane and progress along the sampled free-space trajectory. */
  routeSequence: number;
  readonly natural: NaturalWalkState;
}

/** Turning speed in rad/s: a person turns a right-angle corner in about a quarter of a second. */
export const TURN_RATE = 6.2;
/** No pace ever walks faster than this (m/s): a hurried walk, never a run. */
export const MAX_WALK_SPEED = 2.2;
/** Corners slow a walker to no less than this share of its pace, so it never slides sideways. */
export const CORNER_MIN_SCALE = 0.4;
/** Within this distance of a corner the walker already turns toward the next leg. */
export const CORNER_LOOKAHEAD = 0.7;
/** Seconds to fade in at an arrival point and out at an exit. */
export const FADE_IN_S = 0.6;
export const FADE_OUT_S = 0.7;
const BACKING_SPEED = 0.5;
const BACKING_DISTANCE = 0.6;
const ARRIVE = 1e-3;

export function createMover(id: string, gait: GaitParameters, position: Point3, yaw: number, seated: boolean): Mover {
  const floor = floorAt(position[1]);
  return {
    id, position: [position[0], position[1], position[2]], yaw, motion: createCharacterMotion(seated), phase: seated ? 'seated' : 'walking', gait,
    goal: null, seat: null, steps: [], stepIndex: 0, lastNode: null, backing: false, timer: 0, from: [0, 0, 0], fromYaw: 0, fromSit: 0,
    trip: null, pending: null, target: null, floorLow: floor, floorHigh: floor, pace: 1, cadenceScale: 1, opacity: 1,
    routeSequence: 0, natural: createNaturalWalkState(), chair: null, chairPull: 0, chairSide: 1, chairSequence: 0, staticSeat: null, door: null, cleared: null, prev: [position[0], position[1], position[2]],
  };
}

/** Set the walking pace of the next trip; stride and cadence share it so the feet stay planted. */
export function setPace(mover: Mover, pace: number): void {
  const capped = Math.min(pace, MAX_WALK_SPEED / Math.max(1e-6, walkingSpeed(mover.gait)));
  const split = strideAndCadence(capped);
  mover.pace = capped;
  mover.cadenceScale = split.cadence;
  mover.motion.stride = split.stride;
}

/** Travel speed in m/s at the current pace (before corner slow-downs). */
export function walkSpeed(mover: Pick<Mover, 'gait' | 'pace'>): number {
  return Math.min(MAX_WALK_SPEED, walkingSpeed(mover.gait) * mover.pace);
}

/** Put a character on its seat at once (initial load, reduced motion). */
export function placeSeated(mover: Mover, seat: SeatApproach, env?: MovementEnv): void {
  releaseTrip(mover, env);
  if (mover.door && env?.doors) env.doors.release(mover.door.id, mover.id);
  env?.doors?.clearDuty(mover.id);
  mover.door = null;
  mover.chair = null;
  mover.staticSeat = null;
  mover.chairPull = 0;
  mover.motion.reach[0].weight = 0;
  mover.motion.reach[1].weight = 0;
  mover.position[0] = seat.seat[0]; mover.position[1] = seat.seat[1]; mover.position[2] = seat.seat[2];
  mover.yaw = seat.rotationY;
  mover.seat = seat; mover.goal = { kind: 'seat', seat }; mover.pending = null;
  mover.phase = 'seated'; mover.steps = []; mover.stepIndex = 0; mover.backing = false;
  mover.motion.sit = seat.standing ? 0 : 1; mover.motion.walk = 0;
  env?.trackWalker?.(mover.id, null);
  env?.trackBody?.(mover.id, mover.position);
  updateFloors(mover);
}

function releaseTrip(mover: Mover, env?: MovementEnv) {
  if (mover.trip && env) env.elevators.release(mover.id, mover.trip.id);
  mover.trip = null;
}

/** Riders are spread over both cabs by a stable hash of their id. */
export function preferredElevator(id: string): ElevatorId {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return (hash >>> 0) % 2 ? 'B' : 'A';
}

const copy = (target: Point3, source: Readonly<Point3>) => { target[0] = source[0]; target[1] = source[1]; target[2] = source[2]; };
const goalNode = (goal: MoverGoal) => goal.kind === 'seat' ? seatStageId(goal.seat.seatId) : goal.node;

/**
 * Head for `goal` from wherever the character is: a seated character stands
 * first, a walking one re-plans from its current corridor, and a rider
 * finishes the cab ride before continuing.
 */
export function sendMover(mover: Mover, goal: MoverGoal, env: MovementEnv): boolean {
  if (mover.phase === 'gone') return false;
  if (mover.phase === 'seatwork' && mover.staticSeat) {
    const act = mover.staticSeat;
    if (act.kind === 'sit' && goal.kind === 'seat' && goal.seat.seatId === act.seat.seatId) { mover.goal = goal; mover.pending = null; return true; }
    if (act.kind === 'sit' && (act.beat === 'approach' || act.beat === 'contact' || act.beat === 'align')) {
      // A blocked, still-standing visitor can be recalled without waiting for
      // its seat to become free. Retrace only the corridor already traversed.
      mover.goal = goal; mover.pending = null;
      act.kind = 'stand'; act.path = [...act.trail].reverse();
      act.beat = act.beat === 'approach' ? 'exit' : 'exit-contact';
      act.timer = 0;
    } else mover.pending = goal;
    return true;
  }
  // Called back while fading out at an exit: walk in again from there.
  if (mover.phase === 'vanishing') mover.phase = 'walking';
  if (mover.phase === 'riding' || mover.phase === 'boarding' || mover.phase === 'alighting' || mover.phase === 'standing' || mover.phase === 'chairing' || mover.phase === 'doorwork') {
    mover.pending = goal;
    return true;
  }
  mover.pending = null;
  if (mover.phase === 'seated' || mover.phase === 'sitting') {
    // Already there (or sitting down there).
    if (goal.kind === 'seat' && mover.seat?.seatId === goal.seat.seatId) { mover.goal = goal; return true; }
    mover.goal = goal;
    if (mover.seat && isStaticSeat(mover.seat)) { startStaticSeat(mover, 'stand', mover.seat); return true; }
    if (mover.seat && isDeskChairSeat(mover.seat)) mover.chairSide = chairManeuverSide(mover.id, mover.chairSequence++);
    mover.phase = 'standing'; mover.timer = 0; mover.fromSit = mover.motion.sit;
    return true;
  }
  if (mover.phase === 'waiting' && mover.trip) {
    // Not boarded yet: give the place back and re-plan from the landing.
    const landing = mover.steps[mover.stepIndex - 1]?.node ?? mover.lastNode;
    releaseTrip(mover, env);
    return routeFrom(mover, landing, goal, env, true);
  }
  // Walking: continue from whichever end of the current corridor is cheaper.
  const step = mover.steps[mover.stepIndex];
  const ahead = step?.kind === 'walk' ? step.node : mover.steps[mover.stepIndex - 1]?.node ?? null, behind = mover.lastNode;
  const options = [ahead, behind].filter((node): node is string => Boolean(node));
  const freeSpaceReplan = Boolean(env.walkable && step?.kind === 'walk' && !step.stairs && !mover.backing);
  // A curved trip or local detour can be away from either graph endpoint.
  // Rejoin only a real, visible waypoint instead of walking through furniture.
  if (freeSpaceReplan) {
    const nearby = [...env.navigation.waypoints.values()]
      .filter(node => Math.abs(node.position[1] - mover.position[1]) < 0.05 && node.kind !== 'connector')
      .sort((a, b) => Math.hypot(a.position[0] - mover.position[0], a.position[2] - mover.position[2]) - Math.hypot(b.position[0] - mover.position[0], b.position[2] - mover.position[2]))
      .slice(0, 24);
    for (const node of nearby) if (!options.includes(node.id)) options.push(node.id);
  }
  let best: { node: string; cost: number } | null = null;
  for (const node of options) {
    const route = planRoute(node, goalNode(goal), env.navigation);
    const point = env.navigation.waypoints.get(node)?.position;
    if (!route || !point || (freeSpaceReplan && !env.walkable?.(mover.position, point, 0.29))) continue;
    const cost = route.cost + Math.hypot(point[0] - mover.position[0], point[1] - mover.position[1], point[2] - mover.position[2]);
    if (!best || cost < best.cost) best = { node, cost };
  }
  if (!best) {
    if (freeSpaceReplan) { mover.pending = goal; return true; }
    return false;
  }
  return routeFrom(mover, best.node, goal, env, true);
}

/** Plan from waypoint `start`; with `walkToStart`, first walk to that waypoint from the current spot. */
export function routeFrom(mover: Mover, start: string | null, goal: MoverGoal, env: MovementEnv, walkToStart: boolean): boolean {
  if (!start) return false;
  const route = planRoute(start, goalNode(goal), env.navigation);
  const point = env.navigation.waypoints.get(start)?.position;
  if (!route || !point) return false;
  mover.goal = goal;
  const steps = withElevator(route.steps, preferredElevator(mover.id), env.navigation);
  const routeSteps: RouteStep[] = walkToStart ? [{ kind: 'walk', node: start, to: [point[0], point[1], point[2]], stairs: Math.abs(point[1] - mover.position[1]) > 0.05 }, ...steps] : steps;
  mover.steps = naturalRoute(mover.position, routeSteps, env.navigation, walkingSeed(mover.id, mover.routeSequence++), env.walkable);
  mover.natural.index = -1; mover.natural.progress = 0; mover.natural.offset = 0; mover.natural.speed = 1; mover.natural.blockedTime = 0; mover.natural.lateralSpeed = 0;
  mover.stepIndex = 0;
  mover.lastNode = walkToStart ? null : start;
  mover.backing = false;
  mover.phase = 'walking';
  mover.staticSeat = null;
  env.trackBody?.(mover.id, null);
  if (goal.kind === 'seat') mover.seat = goal.seat;
  return true;
}

/** A waypoint this close to a floor's height is on that floor. */
const LEVEL_EPSILON = 0.05;

/**
 * Where a walking character is now, then the waypoints still ahead on its
 * current floor. Stairs and the cab end the list, so nothing is drawn across
 * floors. Empty unless the character is walking on a level.
 */
export function remainingFloorRoute(mover: Readonly<Mover>): Point3[] {
  if (mover.phase !== 'walking') return [];
  const level = floorY(floorAt(mover.position[1]));
  const onLevel = (y: number) => Math.abs(y - level) < LEVEL_EPSILON;
  if (!onLevel(mover.position[1])) return [];
  const points: Point3[] = [[mover.position[0], mover.position[1], mover.position[2]]];
  for (let index = mover.stepIndex; index < mover.steps.length; index++) {
    const step = mover.steps[index]!;
    if (step.kind !== 'walk' || step.stairs || !onLevel(step.to[1])) break;
    points.push([step.to[0], step.to[1], step.to[2]]);
  }
  return points;
}

/** Start walking from a seat's standing point: back out of the chair first. */
function leaveSeat(mover: Mover, env: MovementEnv) {
  const seat = mover.seat;
  const goal = mover.pending ?? mover.goal;
  mover.pending = null;
  if (!seat || !goal) { mover.phase = 'gone'; return; }
  if (goal.kind === 'seat' && goal.seat.seatId === seat.seatId) { mover.phase = 'sitting'; beginSitting(mover); mover.timer = 0; return; }
  if (isDeskChairSeat(seat)) { mover.goal = goal; startChair(mover, 'stand', seat); return; }
  if (!routeFrom(mover, seatStageId(seat.seatId), goal, env, false)) { mover.phase = 'gone'; return; }
  // Push back from the desk a short step without turning, then walk to the standing point.
  const node = seatStageId(seat.seatId);
  const dx = seat.staging[0] - mover.position[0], dz = seat.staging[2] - mover.position[2], distance = Math.hypot(dx, dz);
  const back = Math.min(1, BACKING_DISTANCE / Math.max(distance, 1e-6));
  mover.steps.unshift(
    { kind: 'walk', node, to: [mover.position[0] + dx * back, seat.staging[1], mover.position[2] + dz * back], stairs: false },
    { kind: 'walk', node, to: [...seat.staging], stairs: false },
  );
  mover.lastNode = null;
  mover.backing = true;
}

function beginSitting(mover: Mover) {
  copy(mover.from, mover.position);
  mover.fromYaw = mover.yaw;
  mover.fromSit = mover.motion.sit;
  mover.timer = 0;
}

function updateFloors(mover: Mover) {
  const trip = mover.trip;
  if (trip && (mover.phase === 'riding' || mover.phase === 'boarding' || mover.phase === 'alighting')) {
    mover.floorLow = Math.min(trip.from, trip.to) as OfficeFloor;
    mover.floorHigh = Math.max(trip.from, trip.to) as OfficeFloor;
    return;
  }
  const level = mover.position[1] / floorY(2);
  const low = Math.floor(level + 1e-3), high = Math.ceil(level - 1e-3);
  mover.floorLow = Math.max(1, Math.min(3, low + 1)) as OfficeFloor;
  mover.floorHigh = Math.max(1, Math.min(3, high + 1)) as OfficeFloor;
}

/**
 * Walk toward `target`; returns the distance left after this frame (0 when arrived).
 * With `next` (the following waypoint on the same level), the walker starts
 * turning into the next leg shortly before the corner, as people do, so the
 * corner costs less speed.
 */
function walkToward(mover: Mover, target: Readonly<Point3>, seconds: number, speedScale: number, keepFacing: boolean, next: Readonly<Point3> | null = null, turnScale = 1): number {
  const dx = target[0] - mover.position[0], dy = target[1] - mover.position[1], dz = target[2] - mover.position[2];
  const length = Math.hypot(dx, dy, dz);
  mover.target = target;
  if (length < ARRIVE) { copy(mover.position, target); return 0; }
  let scale = speedScale;
  const flat = Math.hypot(dx, dz);
  if (!keepFacing && flat > 1e-4) {
    const heading = headingOf(dx, dz);
    let aim = heading;
    if (next && flat < CORNER_LOOKAHEAD) {
      const nx = next[0] - target[0], nz = next[2] - target[2];
      // Face halfway into the next leg by the time the corner is reached.
      if (Math.hypot(nx, nz) > 1e-3) aim = heading + angleDelta(heading, headingOf(nx, nz)) * 0.5 * (1 - flat / CORNER_LOOKAHEAD);
    }
    mover.yaw = turnToward(mover.yaw, aim, TURN_RATE * turnScale, seconds);
    // Slow down while still turning toward where it wants to face instead of sliding sideways.
    scale *= Math.max(CORNER_MIN_SCALE, 1 - Math.abs(angleDelta(mover.yaw, aim)) / 1.8);
  }
  const travel = walkSpeed(mover) * scale * seconds;
  // Cadence follows the actual speed; the stride share of the pace is `motion.stride`.
  const cadence = mover.cadenceScale * (walkSpeed(mover) / Math.max(1e-6, walkingSpeed(mover.gait) * mover.pace));
  mover.motion.phase = advanceWalkPhase(mover.motion.phase, mover.gait, seconds, (keepFacing ? -scale : scale) * cadence);
  if (travel >= length) { copy(mover.position, target); return 0; }
  const k = travel / length;
  mover.position[0] += dx * k; mover.position[1] += dy * k; mover.position[2] += dz * k;
  return length - travel;
}

function easeWalk(mover: Mover, target: number, seconds: number) {
  const rate = seconds / 0.28;
  mover.motion.walk += Math.max(-rate, Math.min(rate, target - mover.motion.walk));
}

/** Advance one character by `seconds`, sharing one movement and turning budget. */
export function stepMover(mover: Mover, seconds: number, env: MovementEnv): void {
  const dt = Math.min(Math.max(seconds, 0), 0.1);
  mover.target = null;
  const yawBefore = mover.yaw;
  const walkingBefore = mover.phase === 'walking';
  copy(mover.prev, mover.position);
  // Arms reach only while a chair or door beat drives them (or a standing beat rests the hands on the armrests).
  if (mover.phase !== 'standing' && mover.phase !== 'chairing' && mover.phase !== 'doorwork') { mover.motion.reach[0].weight = 0; mover.motion.reach[1].weight = 0; }
  if (mover.opacity < 1 && mover.phase !== 'vanishing' && mover.phase !== 'gone') mover.opacity = Math.min(1, mover.opacity + dt / FADE_IN_S);
  switch (mover.phase) {
    case 'seated':
    case 'gone':
      easeWalk(mover, 0, dt);
      break;
    case 'vanishing':
      // Stops at the exit and fades out there.
      easeWalk(mover, 0, dt);
      mover.opacity = Math.max(0, mover.opacity - dt / FADE_OUT_S);
      if (mover.opacity <= 0) mover.phase = 'gone';
      break;
    case 'standing': {
      const seat = mover.seat;
      const duration = seat && isDeskChairSeat(seat) ? Math.max(BEAT_S.stand, seat.standMs / 1000) : (seat?.standMs ?? 760) / 1000;
      mover.timer += dt;
      mover.motion.sit = mover.fromSit * (1 - smoothstep(mover.timer / duration));
      if (seat && isDeskChairSeat(seat)) standingAtChair(mover, seat, Math.min(1, mover.timer / duration), dt);
      if (mover.timer >= duration) { mover.motion.sit = 0; leaveSeat(mover, env); }
      break;
    }
    case 'chairing':
      stepChair(mover, dt, env);
      break;
    case 'seatwork':
      stepStaticSeat(mover, dt, env);
      break;
    case 'doorwork':
      stepDoorWork(mover, dt, env);
      break;
    case 'sitting': {
      const seat = mover.seat!;
      if (mover.timer < 0) {
        // Step from the standing point to the chair, then lower onto it.
        easeWalk(mover, 1, dt);
        if (walkToward(mover, seat.seat, dt, 0.7, false) > 0) break;
        beginSitting(mover);
      }
      const duration = seat.sitMs / 1000;
      mover.timer += dt;
      const t = mover.timer / duration;
      mover.yaw = mover.fromYaw + angleDelta(mover.fromYaw, seat.rotationY) * smoothstep(t / 0.45);
      // A standing station (a bar service point) only turns to face its work.
      mover.motion.sit = seat.standing ? 0 : mover.fromSit + (1 - mover.fromSit) * smoothstep((t - 0.2) / 0.8);
      easeWalk(mover, 0, dt);
      if (t >= 1) placeSeated(mover, seat, env);
      break;
    }
    case 'walking':
      stepWalking(mover, dt, env);
      break;
    case 'waiting':
    case 'boarding':
    case 'riding':
    case 'alighting':
      stepElevator(mover, dt, env);
      break;
  }
  // Several short curve samples may be consumed in one frame; share one turn budget.
  if (walkingBefore) mover.yaw = turnToward(yawBefore, mover.yaw, TURN_RATE, dt);
  updateFloors(mover);
  if (walkingBefore && env.doors) env.doors.moved(mover.id, mover.prev, mover.position);
  const routeStep = mover.steps[mover.stepIndex];
  const trackedTarget = mover.phase === 'doorwork' && routeStep?.kind === 'walk' ? routeStep.to : mover.target;
  // A yielding walker still occupies physical space after its walk blend fades.
  env.trackWalker?.(mover.id, mover.phase === 'doorwork' || (trackedTarget && (mover.phase === 'walking' || mover.motion.walk > 0.05)) ? mover.position : null, trackedTarget ?? undefined);
  env.trackBody?.(mover.id, mover.phase === 'seated' || mover.phase === 'standing' || mover.phase === 'sitting' || mover.phase === 'seatwork' || mover.phase === 'chairing' ? mover.position : null);
}

function finishRoute(mover: Mover, env: MovementEnv) {
  if (mover.pending && mover.lastNode) {
    const pending = mover.pending;
    if (routeFrom(mover, mover.lastNode, pending, env, false)) { mover.pending = null; return; }
  }
  mover.steps = []; mover.stepIndex = 0; mover.backing = false;
  // The last one through a door closes it, even when the walk ends right beside it.
  const hit = env.doors?.duty(mover.id);
  if (hit && env.doors && beginClosing(mover, env.doors, hit, 0)) return;
  const goal = mover.goal;
  if (goal?.kind === 'seat') {
    mover.seat = goal.seat;
    if (isDeskChairSeat(goal.seat)) { releaseTrip(mover, env); startChair(mover, 'sit', goal.seat); return; }
    if (isStaticSeat(goal.seat)) { releaseTrip(mover, env); startStaticSeat(mover, 'sit', goal.seat); return; }
    mover.phase = 'sitting'; mover.timer = -1;
  }
  else mover.phase = 'vanishing';
  releaseTrip(mover, env);
}

/** The next waypoint when the walker turns a corner on the same level (no stairs, cab or chair ahead). */
function cornerAhead(mover: Mover, step: Extract<RouteStep, { kind: 'walk' }>): Readonly<Point3> | null {
  if (mover.backing || step.stairs) return null;
  const next = mover.steps[mover.stepIndex + 1];
  if (!next || next.kind !== 'walk' || next.stairs || Math.abs(next.to[1] - step.to[1]) > 0.05) return null;
  // The last leg ends at a seat's standing point, where the walker turns to sit anyway.
  return next.to;
}

function stepWalking(mover: Mover, dt: number, env: MovementEnv) {
  let budget = dt;
  const hit = env.doors?.duty(mover.id);
  if (hit && env.doors && beginClosing(mover, env.doors, hit, DOOR_CLOSE_MIN_M)) return;
  // Carry the frame across short curve samples without stopping at each marker.
  for (let guard = 0; guard < 16 && budget > 0; guard++) {
    const step = mover.steps[mover.stepIndex];
    if (!step) { finishRoute(mover, env); return; }
    if (step.kind === 'walk' && env.doors && !step.stairs && !mover.backing) {
      const door = env.doors.doorAhead(mover.position, step.to);
      if (door && mover.cleared !== door.id) {
        const verdict = env.doors.request(door.id, door.door, mover.id);
        if (verdict === 'pass' && door.door.sliding) mover.cleared = door.id;
        else { startDoorAct(mover, verdict, door); return; }
      } else if (!door) mover.cleared = null;
    }
    if (step.kind === 'elevator') {
      mover.trip = { id: step.elevatorId, from: step.from, to: step.to, exit: step.exit, landing: [mover.position[0], mover.position[1], mover.position[2]], stage: 'approach', requested: false, exited: false };
      mover.phase = 'waiting';
      return;
    }
    let scale = mover.backing ? BACKING_SPEED : step.stairs ? STAIR_SPEED_FACTOR : 1;
    const before = step.natural ? Math.max(0, Math.hypot(step.to[0] - step.natural.from[0], step.to[2] - step.natural.from[2]) - (mover.natural.index === mover.stepIndex ? mover.natural.progress : 0)) : Math.hypot(step.to[0] - mover.position[0], step.to[1] - mover.position[1], step.to[2] - mover.position[2]);
    let left: number;
    let naturalSeconds = budget;
    if (step.natural && env.walkable && !mover.backing) {
      const state = mover.natural;
      if (state.index !== mover.stepIndex) {
        state.index = mover.stepIndex; state.progress = 0;
      }
      const targetHeading = headingOf(step.to[0] - step.natural.from[0], step.to[2] - step.natural.from[2]);
      scale *= Math.max(CORNER_MIN_SCALE, 1 - Math.abs(angleDelta(mover.yaw, targetHeading)) / 1.8);
      const neighbors = env.nearbyWalkers?.(mover.id, mover.position) ?? [];
      const advanced = advanceNaturalWalk(mover.id, mover.position, step.to, step.natural, state, walkSpeed(mover) * scale, budget, neighbors, env.walkable);
      naturalSeconds = advanced.secondsUsed;
      const dx = advanced.position[0] - mover.position[0], dz = advanced.position[2] - mover.position[2];
      const travelled = Math.hypot(dx, dz);
      if (travelled > 1e-5) mover.yaw = turnToward(mover.yaw, headingOf(dx, dz), TURN_RATE, budget);
      mover.motion.phase = advanceWalkDistance(mover.motion.phase, mover.gait, travelled, mover.motion.stride);
      mover.target = step.to;
      copy(mover.position, advanced.position);
      state.progress = advanced.progress; state.offset = advanced.offset; state.speed = advanced.speed; state.lateralSpeed = advanced.lateralSpeed;
      state.blockedTime = travelled < 1e-4 ? state.blockedTime + budget : 0;
      if (state.blockedTime > 1.5) {
        state.blockedTime = 0;
        const reconnect = reconnectNaturalRoute(mover.position, mover.steps, mover.stepIndex, env.navigation, walkingSeed(mover.id, mover.routeSequence), env.walkable, neighbors);
        if (reconnect) {
          mover.steps.splice(mover.stepIndex, reconnect.count, ...reconnect.steps);
          state.index = -1; state.progress = 0; state.offset = 0; state.speed = 0; state.lateralSpeed = 0;
          easeWalk(mover, 0, budget);
          return;
        }
      }
      left = advanced.arrived ? 0 : 1;
    } else {
      if (env.walkable && env.nearbyWalkers && !step.stairs && !mover.backing) {
        scale *= protectedHeadway(mover.id, mover.position, step.to, walkSpeed(mover) * scale, budget, env.nearbyWalkers(mover.id, mover.position));
      }
      left = walkToward(mover, step.to, budget, scale, mover.backing, cornerAhead(mover, step));
    }
    easeWalk(mover, Math.hypot(mover.position[0] - mover.prev[0], mover.position[2] - mover.prev[2]) > 1e-5 ? 1 : 0, budget);
    if (left > 0) return;
    // Carry the unused part of the frame into the next leg.
    const speed = walkSpeed(mover) * scale * (step.natural ? mover.natural.speed : 1);
    budget = step.natural ? Math.max(0, budget - naturalSeconds) : speed > 0 ? Math.max(0, budget - before / speed) : 0;
    if (!step.natural?.transit) mover.lastNode = step.node;
    mover.backing = false;
    mover.stepIndex++;
    if (mover.pending) {
      const pending = mover.pending;
      mover.pending = null;
      sendMover(mover, pending, env);
      return;
    }
  }
}

const doorPoint = (env: MovementEnv, trip: ElevatorTrip, floor: OfficeFloor, out: Point3) => {
  const door = env.elevators.door(trip.id);
  out[0] = door.x; out[1] = floorY(floor); out[2] = door.z;
  return out;
};
const scratch: Point3 = [0, 0, 0];

function stepElevator(mover: Mover, dt: number, env: MovementEnv) {
  const trip = mover.trip;
  if (!trip) { mover.phase = 'walking'; return; }
  const lifts = env.elevators;
  if (mover.phase === 'waiting') {
    if (!trip.requested) { lifts.request(mover.id, trip.from, trip.to, trip.id); trip.requested = true; }
    // Queue beside the landing door, one body apart per reserved waiting place.
    const slot = lifts.waitingSlot(mover.id, trip.id) ?? 0;
    const door = lifts.door(trip.id);
    const approach = trip.landing;
    scratch[0] = approach[0] - 0.75 * (slot % 3); scratch[1] = floorY(trip.from); scratch[2] = approach[2] + (slot >= 3 ? (door.z < 0 ? -0.75 : 0.75) : 0);
    if (walkToward(mover, scratch, dt, 0.8, false) > 0) { easeWalk(mover, 1, dt); return; }
    easeWalk(mover, 0, dt);
    mover.yaw = turnToward(mover.yaw, headingOf(1, 0), TURN_RATE, dt);
    if (lifts.canBoard(mover.id, trip.id)) { mover.phase = 'boarding'; trip.stage = 'door'; }
    return;
  }
  if (mover.phase === 'boarding') {
    easeWalk(mover, 1, dt);
    if (trip.stage === 'door') {
      if (walkToward(mover, doorPoint(env, trip, trip.from, scratch), dt, 0.8, false) > 0) return;
      trip.stage = 'slot';
    }
    const slot = lifts.standingPosition(mover.id, trip.id);
    if (!slot) return;
    if (walkToward(mover, slot, dt, 0.7, false) > 0) return;
    if (lifts.confirmBoarded(mover.id, trip.id)) mover.phase = 'riding';
    return;
  }
  if (mover.phase === 'riding') {
    easeWalk(mover, 0, dt);
    const slot = lifts.standingPosition(mover.id, trip.id);
    if (slot) copy(mover.position, slot);
    // Face the doors while the cab travels.
    mover.yaw = turnToward(mover.yaw, headingOf(-1, 0), TURN_RATE, dt);
    if (lifts.canExit(mover.id, trip.id)) { mover.phase = 'alighting'; trip.stage = 'door'; }
    return;
  }
  // Alighting: clear the doorway (then free it for the next rider), then the landing.
  easeWalk(mover, 1, dt);
  if (trip.stage === 'door') {
    if (walkToward(mover, doorPoint(env, trip, trip.to, scratch), dt, 0.8, false) > 0) return;
    if (!trip.exited) trip.exited = lifts.confirmExited(mover.id, trip.id);
    trip.stage = 'approach';
  }
  if (walkToward(mover, trip.exit, dt, 0.9, false) > 0) return;
  mover.trip = null;
  mover.lastNode = mover.steps[mover.stepIndex]?.node ?? null;
  mover.stepIndex++;
  mover.phase = 'walking';
  if (mover.pending) { const pending = mover.pending; mover.pending = null; sendMover(mover, pending, env); }
}

// ── Fixed seating ──

function startStaticSeat(mover: Mover, kind: 'sit' | 'stand', seat: SeatApproach): void {
  mover.staticSeat = { kind, seat, beat: kind === 'sit' ? 'approach' : 'rise', timer: 0, retry: 0, route: null, path: null, trail: [[...mover.position] as Point3] };
  mover.phase = 'seatwork'; mover.backing = false;
  mover.fromSit = mover.motion.sit;
}

/** Turn first, then walk a front/exterior leg; never sidestep through an armrest. */
function staticSeatWalk(mover: Mover, target: Point3, dt: number, env: MovementEnv, contact: boolean): boolean {
  const length = Math.hypot(target[0] - mover.position[0], target[2] - mover.position[2]);
  if (length <= ARRIVE) return true;
  const yaw = headingOf(target[0] - mover.position[0], target[2] - mover.position[2]);
  if (Math.abs(angleDelta(mover.yaw, yaw)) > 0.12) {
    mover.yaw = turnToward(mover.yaw, yaw, TURN_RATE, dt);
    easeWalk(mover, 0, dt);
    return false;
  }
  const amount = Math.min(1, walkSpeed(mover) * 0.6 * dt / length);
  const next: Point3 = [mover.position[0] + (target[0] - mover.position[0]) * amount, mover.position[1], mover.position[2] + (target[2] - mover.position[2]) * amount];
  const neighbors = env.nearbyWalkers?.(mover.id, mover.position) ?? [];
  const clear = contact ? !env.seatContactClear || env.seatContactClear(mover.staticSeat!.seat, mover.position, next, STATIC_BODY_RADIUS)
    : !env.walkable || env.walkable(mover.position, next, STATIC_BODY_RADIUS);
  if (!clear || !staticSeatNeighborsClear(mover.id, mover.position, next, neighbors, dt)) {
    easeWalk(mover, 0, dt); return false;
  }
  easeWalk(mover, 0.8, dt);
  return walkToward(mover, target, dt, 0.6, false) <= ARRIVE;
}

function finishStaticExit(mover: Mover, seat: SeatApproach, env: MovementEnv): void {
  const goal = mover.pending ?? mover.goal;
  mover.pending = null; mover.staticSeat = null;
  if (!goal || !routeFrom(mover, seatStageId(seat.seatId), goal, env, false)) {
    // A missing graph route leaves a visible standing body at the safe stage.
    mover.phase = 'seated'; mover.motion.sit = 0;
  }
}

function stepStaticSeat(mover: Mover, dt: number, env: MovementEnv): void {
  const act = mover.staticSeat;
  if (!act) { mover.phase = 'walking'; return; }
  const seat = act.seat;
  const neighbors = env.nearbyWalkers?.(mover.id, mover.position) ?? [];
  if (!act.route && act.path === null) {
    easeWalk(mover, 0, dt);
    act.retry -= dt;
    if (act.retry > 0) return;
    act.retry = 0.4;
    const contactClear: WalkableSegment | undefined = env.seatContactClear ? (from, to, radius) => env.seatContactClear!(seat, from, to, radius) : undefined;
    const route = staticSeatRoute(mover.id, seat, act.kind === 'sit' ? mover.position : seat.staging, env.navigation, env.walkable, neighbors, contactClear);
    if (!route || (act.kind === 'stand' && !staticSeatNeighborsClear(mover.id, mover.position, route.contact, neighbors))) return;
    act.route = route;
    act.path = act.kind === 'sit' ? [...route.path] : [...route.path.slice(0, -1).reverse(), [...seat.staging] as Point3];
  }
  if (act.beat === 'approach' || act.beat === 'exit') {
    const target = act.path?.[0];
    if (target) {
      if (!staticSeatWalk(mover, target, dt, env, false)) return;
      act.path!.shift();
      if (act.beat === 'approach') act.trail.push([...target] as Point3);
      return;
    }
    if (act.beat === 'exit') { finishStaticExit(mover, seat, env); return; }
    act.beat = 'contact';
  }
  if (act.beat === 'contact') {
    if (!staticSeatWalk(mover, act.route!.contact, dt, env, true)) return;
    act.beat = 'align'; act.timer = 0;
  }
  if (act.beat === 'align') {
    easeWalk(mover, 0, dt);
    mover.yaw = turnToward(mover.yaw, seat.rotationY, TURN_RATE, dt);
    act.timer += dt;
    if (act.timer >= 0.25 && Math.abs(angleDelta(mover.yaw, seat.rotationY)) < 1e-4 && mover.motion.walk <= 1e-4 && staticSeatNeighborsClear(mover.id, mover.position, seat.seat, neighbors)) {
      mover.yaw = seat.rotationY; mover.motion.walk = 0;
      act.beat = 'lower'; act.timer = 0;
    }
    return;
  }
  if (act.beat === 'lower' || act.beat === 'rise') {
    easeWalk(mover, 0, dt);
    const rising = act.beat === 'rise';
    const duration = (rising ? seat.standMs : seat.sitMs) / 1000;
    const timer = act.timer + dt, t = smoothstep(timer / Math.max(0.001, duration));
    const contact = act.route?.contact ?? staticSeatContact(seat);
    const from = rising ? seat.seat : contact, to = rising ? contact : seat.seat;
    const next: Point3 = [from[0] + (to[0] - from[0]) * t, seat.seat[1], from[2] + (to[2] - from[2]) * t];
    if ((env.seatContactClear && !env.seatContactClear(seat, mover.position, next, STATIC_BODY_RADIUS)) || !staticSeatNeighborsClear(mover.id, mover.position, next, neighbors, dt)) return;
    act.timer = timer;
    copy(mover.position, next);
    mover.yaw = seat.rotationY;
    mover.motion.walk = 0;
    mover.motion.sit = rising ? mover.fromSit * (1 - t) : t;
    if (timer < duration) return;
    if (rising) { act.beat = 'exit-contact'; mover.motion.sit = 0; return; }
    const pending = mover.pending;
    placeSeated(mover, seat, env);
    if (pending) sendMover(mover, pending, env);
    return;
  }
  if (act.beat === 'exit-contact') {
    if (!act.route || !staticSeatWalk(mover, act.route.apron, dt, env, true)) return;
    // A recall during contact/align still has the apron in its breadcrumb path.
    act.beat = 'exit';
  }
}

// ── Chair choreography ──

/** Walking beats and timed beats of a desk chair, in order. */
const SIT_BEATS = ['grip-walk', 'grip', 'pull', 'let-go', 'walk-sit', 'align', 'lower', 'scoot'] as const;
const STAND_BEATS = ['walk-out', 'grip', 'push', 'let-go'] as const;

/** Desk chairs only: the stand-up and sit-down beats apply to workstation chairs, never sofas, stools or staff stations. */
const isDeskChairSeat = (seat: SeatApproach) => !seat.standing && isDeskChair(seat.seatId);
const RIGHT = 1;
const LEFT = 0;
const handPoint: Point3 = [0, 0, 0];
const RAMP_S = BEAT_S.armrestRamp;

/** Move a weight toward `target` over about `seconds`. */
function rampWeight(current: number, target: number, dt: number, seconds: number): number {
  const step = dt / seconds;
  return current + Math.max(-step, Math.min(step, target - current));
}

/** Set one hand's reach: a blend weight and, when given, the world point it reaches (stored in the character's own frame). */
function aimHand(mover: Mover, hand: 0 | 1, weight: number, point: Readonly<Point3> | null): void {
  const reach = mover.motion.reach[hand];
  reach.weight = Math.max(0, Math.min(1, weight));
  if (point) toCharacterFrame(mover.position, mover.yaw, point, reach.target);
}

function startChair(mover: Mover, kind: 'sit' | 'stand', seat: SeatApproach): void {
  if (kind === 'sit') mover.chairSide = chairManeuverSide(mover.id, mover.chairSequence++);
  mover.chair = { kind, seat, side: mover.chairSide, beat: 0, timer: 0, begun: false, path: [] };
  mover.phase = 'chairing';
}

/** Standing up from a desk chair: the hands press on the armrests and the chair rolls back as the body rises. */
function standingAtChair(mover: Mover, seat: SeatApproach, fraction: number, dt: number): void {
  const pull = standPull(fraction), side = mover.chairSide;
  mover.chairPull = pull;
  const front = CHAIR_FRONT_APPROACH * smooth01((fraction - 0.6) / 0.4);
  chairWorld(seat, pull, 0, 0, front, mover.position, side);
  mover.yaw = chairYaw(seat, pull, side);
  const release = 1 - smooth01((fraction - 0.6) / 0.2);
  aimHand(mover, LEFT, Math.min(release, rampWeight(mover.motion.reach[LEFT].weight, 1, dt, RAMP_S)), chairContactWorld(seat, pull, -ARMREST.x, ARMREST.y, ARMREST.z, handPoint, side));
  aimHand(mover, RIGHT, Math.min(release, rampWeight(mover.motion.reach[RIGHT].weight, 1, dt, RAMP_S)), chairContactWorld(seat, pull, ARMREST.x, ARMREST.y, ARMREST.z, handPoint, side));
}

function nextBeat(act: ChairAct): void { act.beat++; act.timer = 0; act.begun = false; }

function stepChair(mover: Mover, dt: number, env: MovementEnv): void {
  const act = mover.chair;
  if (!act) { mover.phase = 'walking'; return; }
  const beats: readonly string[] = act.kind === 'sit' ? SIT_BEATS : STAND_BEATS;
  const beat = beats[act.beat];
  if (beat === undefined) { finishChair(mover, env); return; }
  const seat = act.seat;
  if (!act.begun) { act.begun = true; act.timer = 0; act.path = chairWalkPath(seat, beat, act.side); }
  act.timer += dt;
  const t = act.timer;
  const hand = mover.motion.reach;
  const gripHand = act.side === 1 ? RIGHT : LEFT;
  const freeHand = gripHand === RIGHT ? LEFT : RIGHT;
  const contact = (x: number, y: number, z: number) => chairContactWorld(seat, mover.chairPull, x, y, z, handPoint, act.side);
  if (beat === 'grip-walk' || beat === 'walk-out' || beat === 'walk-sit') {
    easeWalk(mover, 1, dt);
    mover.chairPull = beat === 'grip-walk' ? 0 : 1;
    aimHand(mover, LEFT, rampWeight(hand[LEFT].weight, 0, dt, RAMP_S), null);
    aimHand(mover, RIGHT, rampWeight(hand[RIGHT].weight, 0, dt, RAMP_S), null);
    const target = act.path[0];
    if (!target) { nextBeat(act); return; }
    if (walkToward(mover, target, dt, 0.7, false, act.path[1] ?? null) > 0) return;
    act.path.shift();
    if (act.path.length === 0) nextBeat(act);
    return;
  }
  if (beat !== 'pull' && beat !== 'push') easeWalk(mover, 0, dt);
  if (beat === 'grip') {
    // Turn to face the chair from behind and take hold of its back.
    mover.yaw = turnToward(mover.yaw, chairYaw(seat, act.kind === 'sit' ? 0 : 1, act.side), TURN_RATE, dt);
    mover.chairPull = act.kind === 'sit' ? 0 : 1;
    aimHand(mover, gripHand, rampWeight(hand[gripHand].weight, 1, dt, 0.3), contact(act.side * GRIP_HAND_X, GRIP_HEIGHT, GRIP_BACK_Z));
    aimHand(mover, freeHand, rampWeight(hand[freeHand].weight, 0, dt, RAMP_S), null);
    if (t >= BEAT_S.grip) nextBeat(act);
    return;
  }
  if (beat === 'pull' || beat === 'push') {
    // The chair moves only while the hand holds it: its pull follows the hand's progress.
    const along = smooth01(t / BEAT_S.pull);
    mover.chairPull = beat === 'pull' ? along : 1 - along;
    chairWorld(seat, mover.chairPull, GRIP_STAND[0], 0, GRIP_STAND[1], scratch, act.side);
    const dx = scratch[0] - mover.position[0], dz = scratch[2] - mover.position[2];
    const distance = Math.hypot(dx, dz);
    copy(mover.position, scratch);
    mover.yaw = chairYaw(seat, mover.chairPull, act.side);
    const direction = dx * Math.sin(mover.yaw) + dz * Math.cos(mover.yaw) < 0 ? -1 : 1;
    easeWalk(mover, distance > 1e-5 ? 0.55 : 0, dt);
    // The chair's eased slide/swivel changes speed; keep short forward/backward
    // steps tied to that travel instead of advancing a constant-rate cycle.
    mover.motion.phase = advanceWalkDistance(mover.motion.phase, mover.gait, direction * distance, mover.motion.stride, .55);
    aimHand(mover, gripHand, 1, contact(act.side * GRIP_HAND_X, GRIP_HEIGHT, GRIP_BACK_Z));
    aimHand(mover, freeHand, rampWeight(hand[freeHand].weight, 0, dt, RAMP_S), null);
    if (t >= BEAT_S.pull) nextBeat(act);
    return;
  }
  if (beat === 'let-go') {
    // The chair stays where it is while the hand comes off it.
    aimHand(mover, gripHand, Math.max(0, 1 - t / BEAT_S.letGo), contact(act.side * GRIP_HAND_X, GRIP_HEIGHT, GRIP_BACK_Z));
    if (t >= BEAT_S.letGo) nextBeat(act);
    return;
  }
  if (beat === 'align') {
    mover.yaw = turnToward(mover.yaw, chairYaw(seat, 1, act.side), TURN_RATE, dt);
    if (t >= BEAT_S.align && Math.abs(angleDelta(mover.yaw, chairYaw(seat, 1, act.side))) < 0.05) nextBeat(act);
    return;
  }
  if (beat === 'lower') {
    mover.chairPull = 1;
    mover.yaw = chairYaw(seat, 1, act.side);
    mover.motion.sit = smooth01(t / BEAT_S.lower);
    chairWorld(seat, 1, 0, 0, CHAIR_FRONT_APPROACH * (1 - mover.motion.sit), mover.position, act.side);
    aimHand(mover, LEFT, rampWeight(hand[LEFT].weight, 0, dt, RAMP_S), null);
    aimHand(mover, RIGHT, rampWeight(hand[RIGHT].weight, 0, dt, RAMP_S), null);
    if (t >= BEAT_S.lower) nextBeat(act);
    return;
  }
  if (beat === 'scoot') {
    // Hands on the seat edge: the chair and the sitter slide in together.
    const pull = scootPull(t);
    mover.chairPull = pull;
    sittingCentre(seat, pull, mover.position, act.side);
    mover.yaw = chairYaw(seat, pull, act.side);
    mover.motion.sit = 1;
    aimHand(mover, LEFT, rampWeight(hand[LEFT].weight, 1, dt, RAMP_S), chairContactWorld(seat, pull, -SEAT_EDGE.x, SEAT_EDGE.y, SEAT_EDGE.z, handPoint, act.side));
    aimHand(mover, RIGHT, rampWeight(hand[RIGHT].weight, 1, dt, RAMP_S), chairContactWorld(seat, pull, SEAT_EDGE.x, SEAT_EDGE.y, SEAT_EDGE.z, handPoint, act.side));
    if (t >= BEAT_S.scoot) nextBeat(act);
    return;
  }
  // Remaining beat: the stand-up's `push` is handled above; anything else ends the chair beats.
  nextBeat(act);
}

/** The chair beats are done: a sitter sits in place, a standing person leaves on its route. */
function finishChair(mover: Mover, env: MovementEnv): void {
  const act = mover.chair;
  mover.chair = null;
  mover.chairPull = 0;
  aimHand(mover, LEFT, 0, null);
  aimHand(mover, RIGHT, 0, null);
  if (!act) { mover.phase = 'walking'; return; }
  if (act.kind === 'sit') {
    const pending = mover.pending;
    placeSeated(mover, act.seat, env);
    if (pending) sendMover(mover, pending, env);
    return;
  }
  const goal = mover.pending ?? mover.goal;
  mover.pending = null;
  if (!goal || !routeFrom(mover, seatStageId(act.seat.seatId), goal, env, true)) mover.phase = 'gone';
}

// ── Door choreography ──

const DOOR_STOP_S = 0.35;
/** Close hand contact uses shorter, careful steps than clear-apron walking. */
const DOOR_MANEUVER_SCALE = 0.75;
/** Keep the old crossing-duty hook for routes that were already in the portal. */
const DOOR_CLOSE_MIN_M = 0.45;
const DOOR_CLOSE_MAX_M = 2.5;

/** Side to retreat to when an old actor is exactly on a threshold marker. */
function doorEntryFromRoute(mover: Mover, door: Readonly<DoorInfo>): 1 | -1 | null {
  for (let index = mover.stepIndex; index < mover.steps.length; index++) {
    const step = mover.steps[index]!;
    if (step.kind !== 'walk' || step.stairs) return null;
    const through = doorAxes(door, step.to).through;
    if (Math.abs(through) > 1e-6) return through > 0 ? -1 : 1;
  }
  return null;
}

function startDoorAct(mover: Mover, kind: DoorAct['kind'], hit: DoorHit): void {
  const at = doorAxes(hit.door, mover.position);
  // A walker already on the plane retreats to the side opposite its next goal.
  const side = Math.abs(at.through) <= 1e-6
    ? doorEntryFromRoute(mover, hit.door) ?? doorSide(hit.door, mover.position) : doorSide(hit.door, mover.position);
  mover.door = { kind, id: hit.id, door: hit.door, timer: 0, beat: 'reserve', side, entrySide: side, hand: RIGHT, path: null };
  mover.phase = 'doorwork';
}

/** Which side of the frame the walker approached from (fixed throughout an act). */
const doorSide = (door: Readonly<DoorInfo>, position: Readonly<Point3>): 1 | -1 => doorAxes(door, position).through >= 0 ? 1 : -1;

function beginClosing(mover: Mover, doors: DoorTraffic, hit: DoorHit, minMeters: number): boolean {
  const distance = Math.abs(doorAxes(hit.door, mover.position).through);
  if (distance > DOOR_CLOSE_MAX_M) { doors.clearDuty(mover.id); return false; }
  if (distance < minMeters) return false;
  doors.clearDuty(mover.id);
  startDoorAct(mover, 'close', hit);
  return true;
}

function endDoorAct(mover: Mover, env: MovementEnv, cleared: string | null): void {
  if (mover.door) {
    // Door choreography moves the feet independently of the sampled route.
    // Join it from the actual release point before using curve progress again.
    if (env.doors && !mover.pending && !mover.door.door.sliding && !resumeDoorRoute(mover, mover.door, env.doors.amount(mover.door.id), env.walkable)) return;
    env.doors?.release(mover.door.id, mover.id);
  }
  Object.assign(mover.natural, createNaturalWalkState());
  mover.door = null;
  mover.phase = 'walking';
  mover.cleared = cleared;
  aimHand(mover, LEFT, 0, null);
  aimHand(mover, RIGHT, 0, null);
  if (mover.pending) { const pending = mover.pending; mover.pending = null; sendMover(mover, pending, env); }
}

function doorBeat(act: DoorAct, beat: DoorAct['beat']): void {
  act.beat = beat; act.timer = 0; act.path = null;
}

/** Consume only threshold waypoints already crossed; retain destination-side waypoints. */
function crossedDoorSteps(mover: Mover, act: DoorAct): void {
  for (let guard = 0; guard < mover.steps.length; guard++) {
    const step = mover.steps[mover.stepIndex];
    if (!step || step.kind !== 'walk' || step.stairs) break;
    const a = doorAxes(act.door, step.to);
    if (Math.abs(step.to[1] - act.door.center[1]) > 0.1 || (!step.natural && Math.abs(a.across) > act.door.clearWidth / 2 + 0.25) || Math.abs(a.through) > act.door.clearWidth + 0.65 || a.through * act.entrySide < -0.05) break;
    mover.lastNode = step.node;
    mover.stepIndex++;
  }
}

function doorWalk(mover: Mover, act: DoorAct, amount: number, target: Readonly<Point3>, dt: number): boolean {
  const tempo = doorInteractionTempo(walkSpeed(mover));
  const walk = (point: Readonly<Point3>, scale: number, next: Readonly<Point3> | null): number => {
    const x = mover.position[0], z = mover.position[2], phase = mover.motion.phase;
    const left = walkToward(mover, point, dt, scale, false, next, tempo);
    // A short tip-path segment can end before the frame's travel budget does.
    mover.motion.phase = advanceWalkDistance(phase, mover.gait, Math.hypot(mover.position[0] - x, mover.position[2] - z), mover.motion.stride);
    return left;
  };
  // Recover old live actors parked inside a shut leaf's capsule. Walk straight
  // away on the same face before planning; never teleport or cross the panel.
  if (amount <= 1e-6 && doorLeafDistance(act.door, amount, mover.position) < DOOR_BODY_CLEARANCE) {
    const at = doorAxes(act.door, mover.position);
    const side = Math.abs(at.through) > 1e-6 ? (at.through > 0 ? 1 : -1)
      : doorEntryFromRoute(mover, act.door) ?? act.side;
    act.side = side;
    if (act.kind !== 'close') act.entrySide = side;
    act.path = null;
    const retreat = doorWorldPoint(act.door, at.across, side * (DOOR_BODY_CLEARANCE + 0.04), scratch);
    easeWalk(mover, 1, dt);
    walk(retreat, 0.8, null);
    return false;
  }
  if (!act.path) act.path = doorWalkPath(act.door, amount, mover.position, target);
  if (!act.path) { easeWalk(mover, 0, dt); return false; }
  const next = act.path[0];
  if (!next) { easeWalk(mover, 0, dt); return true; }
  easeWalk(mover, 1, dt);
  if (walk(next, 1, act.path[1] ?? null) <= ARRIVE) act.path.shift();
  return act.path.length === 0;
}

/** Reconnect moved feet to their route without reusing an obsolete curve leg. */
function resumeDoorRoute(mover: Mover, act: DoorAct, amount: number, walkable?: WalkableSegment): boolean {
  let index = mover.stepIndex;
  for (; index < mover.steps.length; index++) {
    const step = mover.steps[index];
    if (!step || step.kind !== 'walk' || step.stairs) return index === mover.stepIndex;
    const path = doorWalkPath(act.door, amount, mover.position, step.to);
    let from: Readonly<Point3> = mover.position;
    if (path && path.every(point => { const clear = !walkable || walkable(from, point, 0.29); from = point; return clear; })) {
      // Include the joining point as an exact leg. Its old natural.from and
      // progress describe the pre-interaction body, even when no detour is needed.
      mover.steps.splice(mover.stepIndex, index - mover.stepIndex + 1,
        ...path.map(to => ({ kind: 'walk' as const, node: step.node, to, stairs: false })));
      Object.assign(mover.natural, createNaturalWalkState());
      return true;
    }
    // An inside marker can lie inside a partially open leaf's capsule. Keep
    // exact contacts blocked by static geometry; only a leaf-covered interior
    // marker may be bypassed, and never the final goal.
    const at = doorAxes(act.door, step.to);
    if (index === mover.steps.length - 1 || (!step.natural && (path !== null || doorLeafDistance(act.door, amount, step.to) >= DOOR_BODY_CLEARANCE || Math.abs(at.across) > act.door.clearWidth / 2)) || Math.abs(at.through) > act.door.clearWidth + DOOR_BODY_CLEARANCE || Math.abs(step.to[1] - act.door.center[1]) > 0.1) return false;
  }
  return true;
}

/** Select an entry-side tug only when the walker is inside and still on the accessible leaf face. */
function entryClosing(act: DoorAct, amount: number): void {
  if (act.entrySide === doorSwingSide(act.door)) return;
  act.entryCloseStart = amount;
  act.side = act.entrySide;
}

function doorHandWeight(act: DoorAct, amount: number): number {
  return act.kind === 'open' ? doorOpenHandWeight(act.door, amount, act.side)
    : act.entryCloseStart === undefined ? 1 : doorEntryCloseHandWeight(act.door, amount, act.entryCloseStart);
}

/**
 * A single reservation covers opening and passage. Push entries follow the
 * leaf; pull entries tug and move to the latch side, then regrip for closing.
 * A free-tip path handles full openings shared with other walkers.
 */
function stepDoorWork(mover: Mover, dt: number, env: MovementEnv): void {
  const act = mover.door, doors = env.doors;
  if (!act || !doors) { endDoorAct(mover, env, null); return; }
  const { id, door } = act;
  const amount = doors.amount(id);
  const tempo = doorInteractionTempo(walkSpeed(mover));
  const contactDt = dt * tempo;
  act.timer += contactDt;
  aimHand(mover, LEFT, rampWeight(mover.motion.reach[LEFT].weight, 0, contactDt, RAMP_S), null);
  aimHand(mover, RIGHT, rampWeight(mover.motion.reach[RIGHT].weight, 0, contactDt, RAMP_S), null);
  if (door.sliding) {
    easeWalk(mover, 0, dt);
    if (doors.request(id, door, mover.id) === 'pass') endDoorAct(mover, env, id);
    return;
  }
  if (act.beat === 'reserve') {
    if (!doors.claim(id, mover.id)) {
      act.kind = 'wait';
      // Stay beyond the sweep radius, rather than waiting in the other
      // operator's opening arc. No timeout grants passage through a shut leaf.
      const safe = doorWorldPoint(door, 0, act.side * (door.clearWidth + 0.65), handPoint);
      doorWalk(mover, act, amount, safe, dt);
      return;
    }
    if (act.kind !== 'close') act.kind = amount >= 0.99 ? 'pass' : 'open';
    if (act.kind === 'close' && amount >= .8) {
      // Close duties also cover free walkers crossing an already-open door.
      // Infer the reachable leaf face from their body, not the frame normal.
      const at = doorAxes(door, mover.position), theta = amount * door.openAngle;
      const arrival = doorSwingSide(door);
      const face = (at.across + doorHandedness(door) * door.clearWidth / 2) * Math.sin(theta) + at.through * Math.cos(theta);
      if (at.through * arrival > .05 && face * arrival < 0) {
        act.entrySide = -arrival as 1 | -1;
        entryClosing(act, amount);
      }
    }
    doorBeat(act, act.kind === 'pass' ? 'passage' : 'approach');
  }
  if (act.beat === 'approach') {
    const target = act.kind === 'close' ? doorClosePosition(door, amount, act.side, handPoint, act.entryCloseStart) : doorOpenPosition(door, amount, act.side, handPoint);
    if (doorWalk(mover, act, amount, target, dt)) doorBeat(act, 'grip');
    return;
  }
  if (act.beat === 'grip' || act.beat === 'swing') {
    const contact = doorHandle;
    const handle = contact(door, amount, act.side, handPoint);
    const yaw = yawToward(mover.position, handle);
    mover.yaw = turnToward(mover.yaw, yaw, TURN_RATE * tempo, dt);
    if (act.beat === 'grip') {
      // Handedness stays stable while the body turns and the leaf rotates.
      act.hand = doorHandedness(door) * act.side > 0 ? LEFT : RIGHT;
      easeWalk(mover, 0, dt);
      aimHand(mover, act.hand, Math.min(1, act.timer / DOOR_STOP_S), handle);
      if (act.timer >= DOOR_STOP_S && Math.abs(angleDelta(mover.yaw, yaw)) < 0.15) {
        if (act.kind === 'open' && act.openAmount === undefined) {
          const pulling = act.entrySide === doorSwingSide(door);
          const shared = doors.approachers(door, mover.id).length > 0 || doors.occupied(door, mover.id);
          const passAngle = Math.max(Math.PI / 4, Math.asin(Math.min(0.98, (2 * DOOR_BODY_CLEARANCE + 0.22) / door.clearWidth)));
          act.openAmount = pulling && !shared ? Math.max(amount, Math.min(1, passAngle / Math.abs(door.openAngle))) : 1;
        }
        doorBeat(act, 'swing');
      }
      return;
    }
    const target = act.kind === 'close' ? 0 : act.openAmount ?? 1;
    const direction = act.kind === 'close' ? 0 : 1;
    const nextAmount = direction ? Math.min(target, amount + DOOR_SWING_RATE * contactDt) : Math.max(0, amount - DOOR_SWING_RATE * contactDt);
    if (!doors.clearForSwing(door, mover.id, amount, nextAmount)) {
      easeWalk(mover, 0, dt); aimHand(mover, act.hand, doorHandWeight(act, amount), handle); return;
    }
    const bodyPosition: typeof doorOpenPosition = act.kind === 'close'
      ? (d, a, side, out) => doorClosePosition(d, a, side, out, act.entryCloseStart) : doorOpenPosition;
    bodyPosition(door, amount, act.side, scratch);
    const anchorDistance = Math.hypot(scratch[0] - mover.position[0], scratch[2] - mover.position[2]);
    if (anchorDistance > 1e-5) {
      const travel = Math.min(anchorDistance, walkSpeed(mover) * DOOR_MANEUVER_SCALE * dt);
      const k = travel / anchorDistance;
      const backwards = (scratch[0] - mover.position[0]) * Math.sin(mover.yaw) + (scratch[2] - mover.position[2]) * Math.cos(mover.yaw) < 0;
      mover.position[0] += (scratch[0] - mover.position[0]) * k;
      mover.position[2] += (scratch[2] - mover.position[2]) * k;
      mover.target = scratch;
      easeWalk(mover, DOOR_MANEUVER_SCALE, dt);
      mover.motion.phase = advanceWalkDistance(mover.motion.phase, mover.gait, (backwards ? -1 : 1) * travel, mover.motion.stride, DOOR_MANEUVER_SCALE);
      aimHand(mover, act.hand, doorHandWeight(act, amount), handle);
      return;
    }
    const next = bodyPosition(door, nextAmount, act.side, scratch);
    const distance = Math.hypot(next[0] - mover.position[0], next[2] - mover.position[2]);
    // Bound the feet through the piecewise sidestep, including its final corner.
    const budget = walkSpeed(mover) * DOOR_MANEUVER_SCALE * dt;
    let safeAmount = nextAmount;
    if (distance > budget) {
      let low = 0, high = 1;
      for (let sample = 0; sample < 16; sample++) {
        const t = (low + high) / 2;
        bodyPosition(door, amount + (nextAmount - amount) * t, act.side, scratch);
        if (Math.hypot(scratch[0] - mover.position[0], scratch[2] - mover.position[2]) <= budget) low = t;
        else high = t;
      }
      safeAmount = amount + (nextAmount - amount) * low;
    }
    const moved = doors.hold(id, mover.id, direction, Math.abs(safeAmount - amount) / DOOR_SWING_RATE);
    bodyPosition(door, moved, act.side, scratch);
    const dx = scratch[0] - mover.position[0], dz = scratch[2] - mover.position[2];
    const travelled = Math.hypot(dx, dz);
    easeWalk(mover, travelled > 1e-5 ? DOOR_MANEUVER_SCALE : 0, dt);
    const facing = yawToward(mover.position, contact(door, moved, act.side, handPoint));
    mover.yaw = turnToward(mover.yaw, facing, TURN_RATE * tempo, dt);
    const backwards = dx * Math.sin(mover.yaw) + dz * Math.cos(mover.yaw) < 0;
    mover.motion.phase = advanceWalkDistance(mover.motion.phase, mover.gait, (backwards ? -1 : 1) * travelled, mover.motion.stride, DOOR_MANEUVER_SCALE);
    copy(mover.position, scratch);
    mover.target = scratch;
    aimHand(mover, act.hand, doorHandWeight(act, moved), handPoint);
    if (Math.abs(moved - target) < 1e-6) doorBeat(act, direction === 1 ? 'passage' : 'release');
    return;
  }
  if (act.beat === 'passage') {
    // Switch leaf faces directly beside its free edge. A lone closer turns
    // here; walking out to the far waiting apron and back serves no purpose.
    const exitSide = -act.entrySide as 1 | -1;
    if (amount >= 0.99 && (doors.approachers(door, mover.id).length > 0 || doors.occupied(door, mover.id))) { doorBeat(act, 'handoff'); return; }
    entryClosing(act, amount);
    const destination = doorClosePosition(door, amount, act.entryCloseStart === undefined ? exitSide : act.side, handPoint, act.entryCloseStart);
    if (!doorWalk(mover, act, amount, destination, dt)) return;
    act.kind = 'close'; if (act.entryCloseStart === undefined) act.side = exitSide;
    doors.clearDuty(mover.id);
    doorBeat(act, 'grip');
    return;
  }
  if (act.beat === 'handoff') {
    const exitSide = -act.entrySide as 1 | -1;
    const distance = exitSide === doorSwingSide(door) ? door.clearWidth + 0.65 : 0.7;
    const destination = doorWorldPoint(door, 0, exitSide * distance, handPoint);
    if (!doorWalk(mover, act, amount, destination, dt)) return;
    crossedDoorSteps(mover, act);
    doors.clearDuty(mover.id);
    // Hand the open door to the next person; only the final passer closes it.
    if ((doors.approachers(door, mover.id).length > 0 || doors.occupied(door, mover.id)) && resumeDoorRoute(mover, act, amount, env.walkable)) { endDoorAct(mover, env, id); return; }
    act.kind = 'close'; act.side = -act.entrySide as 1 | -1;
    entryClosing(act, amount);
    doorBeat(act, 'approach');
    return;
  }
  easeWalk(mover, 0, dt);
  if (act.timer >= 0.25) {
    if (act.side !== act.entrySide || act.entryCloseStart !== undefined) crossedDoorSteps(mover, act);
    endDoorAct(mover, env, null);
  }
}
