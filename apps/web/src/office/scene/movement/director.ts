/**
 * Keeps the walking characters in step with the real presences: a new presence
 * walks in (a lead through the building entrance, a subagent from the arrival
 * point of its desk's floor: an elevator, the stairs or the entrance), a
 * removed one stands up and walks out (a subagent to the nearest exit of its
 * floor, where it fades out), and a changed seat is walked to. Animation only
 * follows reported presence; it never invents work.
 */
import type { OfficeAgent } from '../../presence';
import type { GaitParameters } from '../avatars/gait';
import type { Point3 } from '../layout';
import type { OfficeAgentAllocation } from '../interior/seating';
import { createMover, placeSeated, remainingFloorRoute, routeFrom, sendMover, setPace, stepMover, type MovementEnv, type Mover, type MoverGoal } from './mover';
import { floorAt, planRoute, seatStageId, type OfficeFloor, type OfficeNavigation, type SeatApproach } from './navGraph';
import { tripPace, type WalkMood } from './pace';
import type { CharacterFloor, CharacterPositionSource } from './positionStore';
import type { ActivityClip } from '../avatars/activityPose';
import { deskChairMotion, isDeskChair, type DeskChairMotion } from '../interior/deskChairs';
import { CHAT_SPOT_PAIRS, chatSpotIds, LEISURE_SPOTS, type LeisureKind, type LeisureSpotDefinition } from './leisureSpots';
import { chatSpeaker, chooseLeisureKind, chooseSpot, createRoutine, lifeRandom, pickChatPartner, pickChatPlace, stepRoutine, TRAVEL_LIMIT_MS, visitMs, type Routine } from './idleRoutine';
import { deskClip, deskMode, isBusy } from './workClip';
import { CONSOLE_SEATS, hospitalityState, stoolTargetAngle, type HospitalityState } from './hospitality';
import { outdoorKioskState, type OutdoorKioskState } from './outdoorKiosk';

/** Presences present when the Office opens (or within this window) start seated: no walk-in storm on load. */
export const SETTLE_MS = 2500;
/** An Office that stayed empty this long after opening is live: its first presence walks in. */
export const EMPTY_START_MS = 5000;
/** A presence must stay gone (or stay on a new seat) this long before anyone walks; brief reloads of history do not move characters. */
export const DEPARTURE_GRACE_MS = 1500;
/** Arrivals through the same entrance or arrival point come in one after another instead of in one heap. */
export const ENTRY_SPACING_MS = 1200;
/** At most about three characters are admitted per second anywhere in the office (staggered spawn queue). */
export const ADMISSION_SPACING_MS = 340;

/** Arrival and exit points of a floor: both elevator landings and both stair heads, plus the building entrance on F1. */
export function floorPortals(navigation: Pick<OfficeNavigation, 'waypoints' | 'entryId'>, floor: OfficeFloor): string[] {
  const portals = [`f${floor}.elevator-A`, `f${floor}.elevator-B`, `f${floor}.stairs-north`, `f${floor}.stairs-south`];
  if (floor === 1) portals.unshift(navigation.entryId);
  return portals.filter(id => navigation.waypoints.has(id));
}

/**
 * The portal of `floor` with the shortest walk to (or, with `leaving`, from)
 * waypoint `node`; ties keep the portal order. Null when none connects.
 */
export function nearestPortal(navigation: OfficeNavigation, floor: OfficeFloor, node: string, leaving = false): string | null {
  let best: { id: string; cost: number } | null = null;
  for (const portal of floorPortals(navigation, floor)) {
    const route = leaving ? planRoute(node, portal, navigation) : planRoute(portal, node, navigation);
    // A portal on this floor reached through another floor is not near.
    if (!route || route.steps.some(step => step.kind === 'elevator' || (step.kind === 'walk' && step.stairs))) continue;
    if (!best || route.cost < best.cost - 1e-9) best = { id: portal, cost: route.cost };
  }
  return best?.id ?? null;
}
/** Idle routines and activity clips are re-decided a few times per second, not every frame. */
export const LIFE_DECISION_MS = 400;
/** A character that just reached a place is not pulled away to chat for this long. */
const CHAT_SETTLE_MS = 20_000;

/** One stop of an idle character's walk-about. */
export interface LeisureVisit {
  readonly spot: LeisureSpotDefinition;
  readonly startedAt: number;
  /** Seated / standing at the place since; null while walking there. */
  arrivedAt: number | null;
  readonly lengthMs: number;
  /** Chat partner and when both had arrived. */
  readonly partnerId?: string;
  chatSince?: number | null;
}

interface CharacterLife {
  readonly routine: Routine;
  visit: LeisureVisit | null;
  readonly seed: number;
  /** Status/activity key and when it last changed (commands are typed, then watched). */
  activityKey: string;
  activitySince: number;
}

const CHAT_PLACES = CHAT_SPOT_PAIRS.map(pair => ({ id: pair.id, floor: pair.floor, spots: chatSpotIds(pair) }));
const SPOT_BY_ID = new Map(LEISURE_SPOTS.map(spot => [spot.id, spot]));
const FURNITURE_SPOTS = LEISURE_SPOTS.filter(spot => spot.kind !== 'chat');

export interface DirectorInput {
  readonly allocations: readonly OfficeAgentAllocation[];
  readonly agents: readonly OfficeAgent[];
  readonly reducedMotion: boolean;
  /** Walking style per presence id. */
  readonly gaitOf: (id: string) => GaitParameters;
}

export interface RosterEntry {
  readonly mover: Mover;
  readonly agent: OfficeAgent;
}

export class MovementDirector implements CharacterPositionSource {
  private readonly movers = new Map<string, Mover>();
  /** Same movers in a flat list for allocation-free frame loops. */
  readonly list: Mover[] = [];
  private readonly agents = new Map<string, OfficeAgent>();
  private readonly seatOf = new Map<string, SeatApproach>();
  private readonly removalSince = new Map<string, number>();
  private readonly reseatSince = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly seatedFlags = new Map<string, boolean>();
  /** Arrivals waiting for their turn at their arrival point (spawn queue). */
  private readonly entering = new Map<string, { at: number; gait: GaitParameters; node: string }>();
  /** Last admission time anywhere, and per arrival point. */
  private lastAdmission = -Infinity;
  private readonly lastEntryAt = new Map<string, number>();
  /** Trips walked per character: seeds the per-trip pace variation. */
  private readonly trips = new Map<string, number>();
  /** Why each character walks its current trip. */
  private readonly moods = new Map<string, WalkMood>();
  private settleUntil: number | null = null;
  private reducedMotion = false;
  private revision = 0;
  private rosterCache: { revision: number; entries: RosterEntry[] } | null = null;

  private readonly openedAt: number;
  /** Idle life per character (routine, current leisure visit). */
  private readonly lives = new Map<string, CharacterLife>();
  /** Leisure spots taken, by spot id → character id. */
  private readonly reserved = new Map<string, string>();
  private sinceLife = Infinity;
  /** Scales every idle duration; 1 in the Office (tests and dev inspection shorten the day). */
  lifeScale = 1;
  /** Idle characters walk about; off keeps everyone at their desk. */
  wander = true;
  /** Inspection aid (dev checks, tests): the kind of place to pick whenever one is free. */
  preferKind: LeisureKind | null = null;

  constructor(private readonly env: MovementEnv, private readonly now: () => number = () => performance.now(),
    private readonly chairs: DeskChairMotion | null = deskChairMotion,
    private readonly hospitality: HospitalityState = hospitalityState,
    private readonly kiosk: OutdoorKioskState = outdoorKioskState) {
    this.openedAt = now();
  }

  // ── CharacterPositionSource ──
  position(id: string): Readonly<Point3> | undefined { return this.movers.get(id)?.position; }
  floor(id: string): CharacterFloor | undefined {
    const mover = this.movers.get(id);
    return mover ? floorAt(mover.position[1]) : undefined;
  }
  moving(id: string): boolean {
    const phase = this.movers.get(id)?.phase;
    return phase !== undefined && phase !== 'seated' && phase !== 'gone';
  }
  /** Remaining walk on the character's floor, from where it stands (see `remainingFloorRoute`); empty when not walking. */
  remainingRoute(id: string): Point3[] {
    const mover = this.movers.get(id);
    return mover ? remainingFloorRoute(mover) : [];
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  version = () => this.revision;
  private bump() { this.revision++; for (const listener of this.listeners) listener(); }

  /** Characters to render, including those still walking out. */
  roster(): readonly RosterEntry[] {
    if (this.rosterCache?.revision === this.revision) return this.rosterCache.entries;
    const entries = this.list.flatMap(mover => {
      const agent = this.agents.get(mover.id);
      return agent ? [{ mover, agent }] : [];
    });
    this.rosterCache = { revision: this.revision, entries };
    return entries;
  }

  /** Seated pose for the renderer: true once the character is mostly down on its chair. */
  static seatedPose(mover: Mover): boolean { return mover.motion.sit >= 0.5; }

  private seatFor(allocation: OfficeAgentAllocation): SeatApproach | undefined {
    return this.env.navigation.seats.get(allocation.resourceId);
  }

  private isSkillTask(agent: OfficeAgent): boolean {
    if (agent.activity === 'knowledge') return true;
    if (agent.toolName && /skill|curat/i.test(agent.toolName)) return true;
    if (agent.summary && /skill|curat/i.test(agent.summary)) return true;
    return false;
  }

  private skillStation(id: string): SeatApproach | undefined {
    const agent = this.agents.get(id);
    if (!agent || !this.isSkillTask(agent)) return undefined;
    const desk = this.seatOf.get(id);
    if (desk?.seatId === 'library.laptop') return undefined;
    const librarySeat = this.env.navigation.seats.get('library.laptop');
    if (!librarySeat) return undefined;
    for (const [otherId, otherMover] of this.movers) {
      if (otherId === id) continue;
      const otherTarget = otherMover.pending ?? otherMover.goal;
      if (otherMover.seat?.seatId === 'library.laptop' || (otherTarget?.kind === 'seat' && otherTarget.seat.seatId === 'library.laptop')) {
        return this.env.navigation.seats.get('library.sofa-1') ?? undefined;
      }
    }
    return librarySeat;
  }

  /** Where a character is headed: active skill station, a leisure place it visits, else its desk. */
  private destinationOf(id: string): SeatApproach | undefined {
    const skill = this.skillStation(id);
    if (skill) return skill;
    const visit = this.lives.get(id)?.visit;
    return (visit && this.env.navigation.seats.get(visit.spot.id)) ?? this.seatOf.get(id);
  }

  /** Pace of a new trip: the character's own pace, varied per trip, by why it walks. */
  private pace(mover: Mover, mood: WalkMood): void {
    const trip = (this.trips.get(mover.id) ?? 0) + 1;
    this.trips.set(mover.id, trip);
    this.moods.set(mover.id, mood);
    setPace(mover, tripPace(mover.id, trip, mood));
  }

  private send(mover: Mover, goal: MoverGoal, mood: WalkMood): boolean {
    const sent = sendMover(mover, goal, this.env);
    if (sent) this.pace(mover, mood);
    return sent;
  }

  /** Where a new presence comes in: a lead through the building entrance, a subagent at its desk floor's nearest arrival point. */
  private arrivalNode(agent: OfficeAgent, seat: SeatApproach): string {
    const navigation = this.env.navigation;
    if (!agent.parentId) return navigation.entryId;
    return nearestPortal(navigation, floorAt(seat.seat[1]), seatStageId(seat.seatId)) ?? navigation.entryId;
  }

  /**
   * A new presence: seated at once while settling or with reduced motion;
   * otherwise it appears at its arrival point (fading in) and walks to its seat.
   */
  private arrive(agent: OfficeAgent, gait: GaitParameters, seat: SeatApproach, node: string | null): Mover {
    const goal: MoverGoal = { kind: 'seat', seat };
    const start = node ? this.env.navigation.waypoints.get(node)?.position : undefined;
    const mover = createMover(agent.id, gait, start ? [start[0], start[1], start[2]] : seat.seat, seat.rotationY, !start);
    if (!start || !routeFrom(mover, node, goal, this.env, false)) placeSeated(mover, seat, this.env);
    else { mover.opacity = 0; this.pace(mover, 'walk'); }
    const first = mover.steps[0];
    if (first?.kind === 'walk') mover.yaw = Math.atan2(first.to[0] - mover.position[0], first.to[2] - mover.position[2]);
    return mover;
  }

  /** Where a departing character leaves: a lead through the building entrance, a subagent through its floor's nearest exit. */
  private leaveGoal(id: string): MoverGoal {
    const navigation = this.env.navigation;
    const mover = this.movers.get(id), agent = this.agents.get(id);
    if (!mover || !agent?.parentId) return { kind: 'leave', node: navigation.entryId };
    const seated = mover.phase === 'seated' || mover.phase === 'sitting' || mover.phase === 'standing' || mover.phase === 'seatwork';
    const step = mover.steps[mover.stepIndex];
    const from = seated && mover.seat ? seatStageId(mover.seat.seatId) : (step?.kind === 'walk' && !step.stairs ? step.node : null) ?? mover.lastNode;
    const exit = from && !mover.trip ? nearestPortal(navigation, floorAt(mover.position[1]), from, true) : null;
    return { kind: 'leave', node: exit ?? navigation.entryId };
  }

  private add(mover: Mover) {
    this.movers.set(mover.id, mover);
    this.list.push(mover);
  }

  private remove(id: string) {
    const mover = this.movers.get(id);
    if (!mover) return;
    if (mover.trip) this.env.elevators.release(id, mover.trip.id);
    if (mover.door) this.env.doors?.release(mover.door.id, mover.id);
    this.env.doors?.clearDuty(mover.id);
    this.env.trackWalker?.(id, null);
    this.env.trackBody?.(id, null);
    this.movers.delete(id);
    this.list.splice(this.list.indexOf(mover), 1);
    this.agents.delete(id);
    this.seatOf.delete(id);
    this.removalSince.delete(id);
    this.reseatSince.delete(id);
    this.seatedFlags.delete(id);
    this.endVisit(id);
    this.lives.delete(id);
    this.trips.delete(id);
    this.moods.delete(id);
  }

  /** Reconcile with the latest presences and seat allocation. */
  update(input: DirectorInput): void {
    const now = this.now();
    this.reducedMotion = input.reducedMotion;
    if (this.settleUntil === null && input.allocations.length) this.settleUntil = now - this.openedAt > EMPTY_START_MS ? now : now + SETTLE_MS;
    const animate = !input.reducedMotion && this.settleUntil !== null && now >= this.settleUntil;
    const byId = new Map(input.agents.map(agent => [agent.id, agent]));
    const wanted = new Set<string>();
    let changed = false;
    for (const allocation of input.allocations) {
      const seat = this.seatFor(allocation);
      const agent = byId.get(allocation.agentId);
      if (!seat || !agent) continue;
      wanted.add(agent.id);
      this.agents.set(agent.id, agent);
      this.seatOf.set(agent.id, seat);
      let mover = this.movers.get(agent.id);
      // A leisure visit keeps its place; the desk is the destination otherwise.
      const destination = (mover && this.destinationOf(agent.id)) ?? seat;
      const goal: MoverGoal = { kind: 'seat', seat: destination };
      if (!mover) {
        const queued = this.entering.get(agent.id);
        if (queued) { queued.gait = input.gaitOf(agent.id); if (input.reducedMotion) { this.spawn(agent.id, false); changed = true; } continue; }
        if (animate) {
          // Spawn queue: spaced from the previous arrival at the same point and from any admission.
          const node = this.arrivalNode(agent, seat);
          const at = Math.max(now, this.lastAdmission + ADMISSION_SPACING_MS, (this.lastEntryAt.get(node) ?? -Infinity) + ENTRY_SPACING_MS);
          this.lastAdmission = at;
          this.lastEntryAt.set(node, at);
          this.entering.set(agent.id, { at, gait: input.gaitOf(agent.id), node });
          continue;
        }
        mover = this.arrive(agent, input.gaitOf(agent.id), seat, null);
        this.add(mover);
        changed = true;
        continue;
      }
      mover.gait = input.gaitOf(agent.id);
      if (this.removalSince.delete(agent.id)) changed = true;
      if (input.reducedMotion) {
        this.endVisit(agent.id);
        if (mover.phase !== 'seated' || mover.seat?.seatId !== seat.seatId) { placeSeated(mover, seat, this.env); changed = true; }
        this.reseatSince.delete(agent.id);
        continue;
      }
      const target = mover.pending ?? mover.goal;
      if (target?.kind === 'leave') {
        // Came back while leaving: turn around.
        this.send(mover, goal, 'walk');
        changed = true;
      } else if (target?.kind === 'seat' && target.seat.seatId !== destination.seatId) {
        if (mover.phase === 'seated') { if (!this.reseatSince.has(agent.id)) this.reseatSince.set(agent.id, now); }
        else { this.send(mover, goal, isBusy(agent) ? 'hurry' : 'walk'); this.reseatSince.delete(agent.id); }
      } else this.reseatSince.delete(agent.id);
    }
    for (const id of [...this.entering.keys()]) if (!wanted.has(id)) { this.entering.delete(id); this.agents.delete(id); this.seatOf.delete(id); }
    for (const mover of [...this.list]) {
      if (wanted.has(mover.id)) continue;
      this.endVisit(mover.id);
      if (input.reducedMotion) { this.remove(mover.id); changed = true; }
      else if (!this.removalSince.has(mover.id) && mover.goal?.kind !== 'leave') this.removalSince.set(mover.id, now);
    }
    if (changed) this.bump();
  }

  /** Bring a queued arrival in (walking from its arrival point, or seated when `animate` is off). */
  private spawn(id: string, animate: boolean): boolean {
    const queued = this.entering.get(id), agent = this.agents.get(id), seat = this.seatOf.get(id);
    this.entering.delete(id);
    if (!queued || !agent || !seat) return false;
    this.add(this.arrive(agent, queued.gait, seat, animate ? queued.node : null));
    return true;
  }

  /** Advance every character; called once per rendered frame. */
  tick(seconds: number): void {
    const now = this.now();
    let changed = false;
    if (this.entering.size) {
      for (const [id, queued] of this.entering) if (now >= queued.at && this.spawn(id, !this.reducedMotion)) changed = true;
    }
    if (this.removalSince.size) {
      for (const [id, since] of this.removalSince) {
        if (now - since < DEPARTURE_GRACE_MS) continue;
        this.removalSince.delete(id);
        const mover = this.movers.get(id);
        if (!mover) continue;
        if (this.reducedMotion || !this.send(mover, this.leaveGoal(id), 'walk')) this.remove(id);
        this.seatOf.delete(id);
        changed = true;
      }
    }
    if (this.reseatSince.size) {
      for (const [id, since] of this.reseatSince) {
        if (now - since < DEPARTURE_GRACE_MS) continue;
        this.reseatSince.delete(id);
        const mover = this.movers.get(id), seat = this.destinationOf(id), agent = this.agents.get(id);
        if (mover && seat) { this.send(mover, { kind: 'seat', seat }, agent && isBusy(agent) ? 'hurry' : 'walk'); changed = true; }
      }
    }
    this.sinceLife += seconds * 1000;
    if (this.sinceLife >= LIFE_DECISION_MS) {
      this.sinceLife = 0;
      if (this.decideLife(now)) changed = true;
    }
    for (let index = this.list.length - 1; index >= 0; index--) {
      const mover = this.list[index]!;
      const low = mover.floorLow, high = mover.floorHigh;
      stepMover(mover, seconds, this.env);
      if (mover.phase === 'gone') { this.remove(mover.id); changed = true; continue; }
      const seated = MovementDirector.seatedPose(mover);
      if (this.seatedFlags.get(mover.id) !== seated) { this.seatedFlags.set(mover.id, seated); changed = true; }
      if (low !== mover.floorLow || high !== mover.floorHigh) changed = true;
      // A desk chair slides only while its person holds it (the movement's own chair beats set the pull).
      if (this.chairs && mover.seat && isDeskChair(mover.seat.seatId)) this.chairs.setTarget(mover.seat.seatId, mover.chairPull, mover.chairSide);
    }
    this.hospitality.advance(now, seconds, this.reducedMotion);
    for (const mover of this.list) {
      const seat = mover.seat;
      if (!seat?.seatId.startsWith('lounge.barstool-') || mover.phase !== 'seated') continue;
      const stool = this.hospitality.stool(seat.seatId);
      stool.actorId = mover.id;
      const target = this.reducedMotion ? 0 : stoolTargetAngle(now, this.lifeOf(mover.id).seed % 997);
      stool.angle += (target - stool.angle) * (1 - Math.exp(-Math.max(0, seconds) * 2.5));
      mover.yaw = seat.rotationY + stool.angle;
      // The resource root is 4 cm in front of the shaft. Rotate that offset too.
      const offset = 0.04;
      const cx = seat.seat[0] - Math.sin(seat.rotationY) * offset;
      const cz = seat.seat[2] - Math.cos(seat.rotationY) * offset;
      mover.position[0] = cx + Math.sin(mover.yaw) * offset;
      mover.position[2] = cz + Math.cos(mover.yaw) * offset;
    }
    this.chairs?.advance(seconds);
    if (changed) this.bump();
  }

  // ── Idle life ──

  private lifeOf(id: string): CharacterLife {
    let life = this.lives.get(id);
    if (!life) {
      life = { routine: createRoutine(id), visit: null, seed: Math.floor(lifeRandom(id, 0, 9) * 4294967296), activityKey: '', activitySince: this.now() };
      this.lives.set(id, life);
    }
    return life;
  }

  /** Start every idle routine over (after changing `lifeScale` or `wander`); characters head back to their desks. */
  resetLife(): void {
    for (const id of [...this.lives.keys()]) this.endVisit(id);
    this.lives.clear();
    this.sinceLife = Infinity;
  }

  /** Pace and mood of a character's current trip, for inspection and tests. */
  walkState(id: string): { pace: number; mood: WalkMood | undefined; trips: number } | undefined {
    const mover = this.movers.get(id);
    return mover ? { pace: mover.pace, mood: this.moods.get(id), trips: this.trips.get(id) ?? 0 } : undefined;
  }

  /** Current routine and visit of a character, for inspection and the character card. */
  lifeState(id: string): { phase: Routine['phase']; turn: number; visit: { spotId: string; kind: LeisureKind; arrived: boolean; partnerId?: string } | null } | undefined {
    const life = this.lives.get(id);
    if (!life) return undefined;
    const visit = life.visit;
    return { phase: life.routine.phase, turn: life.routine.turn,
      visit: visit ? { spotId: visit.spot.id, kind: visit.spot.kind, arrived: visit.arrivedAt !== null, ...(visit.partnerId ? { partnerId: visit.partnerId } : {}) } : null };
  }

  /** Release a character's leisure place; a chat partner's visit ends too. */
  private endVisit(id: string, ended = new Set<string>()): void {
    const life = this.lives.get(id);
    const visit = life?.visit;
    if (!life || !visit || ended.has(id)) return;
    ended.add(id);
    life.visit = null;
    this.hospitality.releaseActor(id);
    this.kiosk.release(id);
    life.routine.lastKind = visit.spot.kind;
    life.routine.visits++;
    if (this.reserved.get(visit.spot.id) === id) this.reserved.delete(visit.spot.id);
    if (visit.partnerId) this.endVisit(visit.partnerId, ended);
  }

  private beginVisit(id: string, spot: LeisureSpotDefinition, now: number, extra?: { partnerId: string; lengthMs: number }): boolean {
    const life = this.lifeOf(id), mover = this.movers.get(id), seat = this.env.navigation.seats.get(spot.id);
    if (!mover || !seat) return false;
    life.visit = { spot, startedAt: now, arrivedAt: null, lengthMs: extra?.lengthMs ?? visitMs(id, life.routine.turn, life.routine.visits, spot.kind) * this.lifeScale,
      ...(extra ? { partnerId: extra.partnerId, chatSince: null } : {}) };
    this.reserved.set(spot.id, id);
    if (spot.kind === 'pantry') this.hospitality.request(id, spot.id);
    if (spot.id === 'outdoor.cafe-counter' && !this.kiosk.request(id, now)) {
      this.endVisit(id);
      return false;
    }
    // A walk-about is a stroll.
    if (this.send(mover, { kind: 'seat', seat }, 'stroll')) return true;
    this.endVisit(id);
    return false;
  }

  /** Characters free to be asked for a chat: out on a walk-about and not chatting already. */
  private chatAvailable(id: string, now: number): boolean {
    const life = this.lives.get(id), agent = this.agents.get(id);
    if (!life || !agent || life.routine.phase !== 'outing' || isBusy(agent) || this.removalSince.has(id)) return false;
    const visit = life.visit;
    // Free, still on the way somewhere (a colleague can stop them), or settled for a while — never mid-chat.
    return !visit || (!visit.partnerId && (visit.arrivedAt === null || now - visit.arrivedAt > CHAT_SETTLE_MS * this.lifeScale));
  }

  /** Pick and start the next place of a walk-about; false when nothing fits (the character heads back). */
  private planVisit(id: string, now: number): boolean {
    const life = this.lifeOf(id), mover = this.movers.get(id);
    if (!mover) return false;
    const floor = floorAt(mover.position[1]);
    const reserved = new Set(this.reserved.keys());
    const available = new Set<LeisureKind>();
    for (const spot of FURNITURE_SPOTS) if (!reserved.has(spot.id)) available.add(spot.kind);
    const candidates = this.list.map(other => ({ id: other.id, floor: floorAt(other.position[1]), available: this.chatAvailable(other.id, now) }));
    const partner = pickChatPartner({ id, floor, turn: life.routine.turn }, candidates);
    const partnerMover = partner ? this.movers.get(partner) : undefined;
    const place = partnerMover ? pickChatPlace(CHAT_PLACES, reserved, [floor, floorAt(partnerMover.position[1])], { id, turn: life.routine.turn }) : null;
    if (place) available.add('chat');
    for (let attempt = 0; attempt < 3; attempt++) {
      const kind = this.preferKind && available.has(this.preferKind) ? this.preferKind : chooseLeisureKind(life.routine, available);
      if (!kind) return false;
      if (kind === 'chat' && partner && place) {
        const lengthMs = visitMs(id, life.routine.turn, life.routine.visits, 'chat') * this.lifeScale;
        this.endVisit(partner);
        const [a, b] = place.spots;
        if (this.beginVisit(id, SPOT_BY_ID.get(a)!, now, { partnerId: partner, lengthMs }) &&
          this.beginVisit(partner, SPOT_BY_ID.get(b)!, now, { partnerId: id, lengthMs })) return true;
        this.endVisit(id);
        available.delete('chat');
        continue;
      }
      if (kind === 'game' && partner && !this.hospitality.entertainment() && CONSOLE_SEATS.every(seat => !reserved.has(seat))) {
        const lengthMs = visitMs(id, life.routine.turn, life.routine.visits, 'game') * this.lifeScale;
        this.endVisit(partner);
        if (this.hospitality.reserveGame([id, partner], now) &&
          this.beginVisit(id, SPOT_BY_ID.get(CONSOLE_SEATS[0])!, now, { partnerId: partner, lengthMs }) &&
          this.beginVisit(partner, SPOT_BY_ID.get(CONSOLE_SEATS[1])!, now, { partnerId: id, lengthMs })) return true;
        this.endVisit(id);
        this.hospitality.releaseActor(partner);
      }
      // Café seating follows a physical pickup; a full counter sends the guest
      // to another activity rather than conjuring a drink at an empty table.
      const soloSpots = kind === 'cafe' ? FURNITURE_SPOTS.filter(spot => spot.id === 'outdoor.cafe-counter')
        : kind === 'game' ? FURNITURE_SPOTS.filter(spot => !spot.id.includes('.console-')) : FURNITURE_SPOTS;
      const spot = chooseSpot(soloSpots, kind, reserved, life.routine, floor);
      if (spot && this.beginVisit(id, spot, now)) return true;
      available.delete(kind);
      life.routine.visits++;
    }
    return false;
  }

  /** Head back to the desk (no-op when already there or on the way): hurrying when real work arrived, else strolling. */
  private toDesk(id: string, busy: boolean): boolean {
    const mover = this.movers.get(id), desk = this.seatOf.get(id);
    if (!mover || !desk || this.removalSince.has(id)) return false;
    const target = mover.pending ?? mover.goal;
    if (target?.kind === 'seat' && target.seat.seatId === desk.seatId) {
      // Already strolling back when work arrives: pick up the pace.
      if (busy && this.moods.get(id) === 'stroll' && mover.phase !== 'seated') this.pace(mover, 'hurry');
      return false;
    }
    // Only leisure trips are redirected here; desk changes and departures keep their own timing.
    if (target?.kind === 'leave' || (target?.kind === 'seat' && !SPOT_BY_ID.has(target.seat.seatId))) return false;
    return this.send(mover, { kind: 'seat', seat: desk }, busy ? 'hurry' : 'stroll');
  }

  /** The activity clip of a seated or standing character, from its real presence and place. */
  private clipOf(mover: Mover, life: CharacterLife, agent: OfficeAgent, now: number): ActivityClip {
    if (mover.phase !== 'seated') return 'none';
    const seconds = now / 1000;
    const visit = life.visit;
    if (visit && mover.seat?.seatId === visit.spot.id) {
      if (visit.spot.id === 'outdoor.cafe-counter') {
        return this.kiosk.snapshot()?.status === 'pickup' ? 'bar-serve' : 'look-around';
      }
      if (visit.spot.kind === 'pantry') {
        const service = this.hospitality.serviceFor(mover.id);
        if (service?.status !== 'delivered') return 'watch-tv';
        return service.item === 'food' ? 'eat' : 'sip';
      }
      if (visit.spot.id.includes('.console-')) return this.hospitality.entertainment()?.startedAt != null ? 'console-play' : 'watch-tv';
      if (visit.spot.kind !== 'chat') return visit.spot.clip;
      if (visit.chatSince === null || visit.chatSince === undefined) return 'look-around';
      // The first spot of a pair speaks on even turns.
      const first = visit.spot.id.endsWith('.a');
      const speaker = chatSpeaker(visit.chatSince, now, visit.spot.id.slice(0, -2));
      return (speaker === 0) === first ? 'chat-talk' : 'chat-listen';
    }
    const desk = this.seatOf.get(mover.id);
    const currentSeat = mover.seat?.seatId;
    const isAtWork = (desk && currentSeat === desk.seatId) || currentSeat === 'library.laptop' || currentSeat?.startsWith('library.');
    if (!isAtWork || (desk && desk.standing)) return 'none';
    const mode = deskMode(agent);
    return deskClip(mode, seconds, life.seed, (now - life.activitySince) / 1000);
  }

  /** Re-decide every character's routine, visit and clip; true when someone's destination changed. */
  private decideLife(now: number): boolean {
    let changed = false;
    this.kiosk.advance(now);
    const allowed = !this.reducedMotion && this.wander;
    for (const mover of this.list) {
      const id = mover.id, agent = this.agents.get(id), desk = this.seatOf.get(id);
      if (!agent || !desk) continue;
      const life = this.lifeOf(id);
      const key = `${agent.status}|${agent.activity ?? ''}|${agent.target ?? ''}`;
      if (key !== life.activityKey) { life.activityKey = key; life.activitySince = now; }
      if (this.removalSince.has(id) || mover.goal?.kind === 'leave' || mover.phase === 'gone' || mover.phase === 'vanishing') { this.endVisit(id); mover.motion.clip = 'none'; continue; }
      const destination = this.destinationOf(id) ?? desk;
      const busy = isBusy(agent);
      const atDestination = mover.phase === 'seated' && mover.seat?.seatId === destination.seatId;
      const intent = stepRoutine(life.routine, { now, busy, atDesk: atDestination, allowed, scale: this.lifeScale });
      if (intent === 'desk') {
        if (life.visit) this.endVisit(id);
        if (this.toDesk(id, busy)) changed = true;
      } else {
        const visit = life.visit;
        if (visit) {
          const arrived = mover.phase === 'seated' && mover.seat?.seatId === visit.spot.id;
          if (arrived && visit.arrivedAt === null) {
            visit.arrivedAt = now;
            if (visit.spot.id.includes('.console-')) this.hospitality.arriveGame(id, now);
            if (visit.spot.id === 'outdoor.cafe-counter') this.kiosk.arrive(id, now);
          }
          if (visit.partnerId && visit.chatSince === null && visit.arrivedAt !== null) {
            const other = this.lives.get(visit.partnerId)?.visit;
            if (other?.arrivedAt !== null && other?.arrivedAt !== undefined) { visit.chatSince = now; other.chatSince = now; }
          }
          const since = visit.spot.kind === 'pantry' ? this.hospitality.serviceFor(id)?.deliveredAt ?? null : visit.partnerId ? visit.chatSince ?? null : visit.arrivedAt;
          const atKiosk = visit.spot.id === 'outdoor.cafe-counter';
          const collected = atKiosk && this.kiosk.snapshot()?.actorId === id && this.kiosk.snapshot()?.status === 'collected';
          const done = atKiosk ? collected : since !== null && now - since >= visit.lengthMs;
          const stuck = now - visit.startedAt > TRAVEL_LIMIT_MS && (visit.arrivedAt === null || (visit.spot.kind === 'pantry' && since === null) || (visit.partnerId && visit.chatSince === null));
          if (done || stuck) {
            this.endVisit(id);
            if (collected) {
              const spot = chooseSpot(FURNITURE_SPOTS.filter(spot => spot.id !== 'outdoor.cafe-counter'), 'cafe',
                new Set(this.reserved.keys()), life.routine, 1);
              if (spot && this.beginVisit(id, spot, now)) changed = true;
            }
          }
        }
        if (!life.visit) {
          if (this.planVisit(id, now)) changed = true;
          else if (this.toDesk(id, busy)) changed = true;
        }
      }
      mover.motion.clip = this.clipOf(mover, life, agent, now);
    }
    return changed;
  }

  /** Give back elevator places and door duties when the scene unmounts. */
  dispose(): void {
    this.reserved.clear();
    this.hospitality.clear();
    this.kiosk.clear();
    for (const mover of this.list) {
      if (mover.trip) this.env.elevators.release(mover.id, mover.trip.id);
      if (mover.door) this.env.doors?.release(mover.door.id, mover.id);
      this.env.doors?.clearDuty(mover.id);
      this.env.trackWalker?.(mover.id, null);
      this.env.trackBody?.(mover.id, null);
    }
    this.listeners.clear();
  }
}

/** Whether a character is drawn in a single-floor view. */
export function visibleOnFloor(mover: Mover, floor: OfficeFloor, elevatorY?: number): boolean {
  if (mover.trip && (mover.phase === 'riding' || mover.phase === 'boarding' || mover.phase === 'alighting')) {
    return floor === mover.trip.from || floor === mover.trip.to || floorAt(elevatorY ?? mover.position[1]) === floor;
  }
  return floor >= mover.floorLow && floor <= mover.floorHigh;
}
