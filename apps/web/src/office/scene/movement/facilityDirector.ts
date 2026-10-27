/**
 * Moves the facility staff (see `facilityNpcs.ts`) over the same walking graph,
 * stairs and elevators as everyone else. Staff start at their stations, so a
 * remount or hot reload never shows a walk-in or a second copy; they only walk
 * for a break or to hurry back to a real arrival. Demand is read from the
 * agents' movers; nothing here feeds back into agent sessions.
 */
import { gaitParameters, type GaitParameters } from '../avatars/gait';
import { createMover, placeSeated, sendMover, setPace, stepMover, type MovementEnv, type Mover } from './mover';
import { tripPace } from './pace';
import { floorAt, planRoute, seatStageId } from './navGraph';
import type { CharacterFloor, CharacterPositionSource } from './positionStore';
import { hospitalityState, type HospitalityState } from './hospitality';
import { barServicePhase, FACILITY_NPCS, createFacilityBrain, isDemandFor, stepFacilityBrain, type CharacterSample, type FacilityBrain, type FacilityNpcDefinition } from './facilityNpcs';

/** Demand and duty are re-evaluated a few times per second, not every frame. */
export const FACILITY_DECISION_MS = 250;
/** First sighting this far north of the lobby door (outside it) marks an arrival from the entrance. */
const ENTRANCE_Z = -19;

export interface FacilityNpc {
  readonly definition: FacilityNpcDefinition;
  readonly mover: Mover;
  readonly brain: FacilityBrain;
}

export class FacilityNpcDirector implements CharacterPositionSource {
  readonly npcs: FacilityNpc[];
  private readonly listeners = new Set<() => void>();
  private readonly seatedFlags = new Map<string, boolean>();
  /** Real characters seen so far and whether they came in from the entrance. */
  private readonly entrants = new Map<string, boolean>();
  private readonly baseGait = new Map<string, GaitParameters>();
  private revision = 0;
  private sinceDecision = Infinity;
  private reducedMotion = false;

  constructor(
    private readonly env: MovementEnv,
    /** The real characters' movers (the agent movement director's list). */
    private readonly characters: () => readonly Mover[],
    private readonly now: () => number = () => performance.now(),
    definitions: readonly FacilityNpcDefinition[] = FACILITY_NPCS,
    private readonly hospitality: HospitalityState = hospitalityState,
  ) {
    const start = now();
    this.npcs = definitions.flatMap(definition => {
      const home = env.navigation.seats.get(definition.homeResourceId);
      if (!home) return [];
      const gait = gaitParameters({ gait: definition.appearance.gait });
      const mover = createMover(definition.id, gait, [...home.seat], home.rotationY, true);
      placeSeated(mover, home, env);
      // Staff walk at the office pace too, each at their own personal pace.
      setPace(mover, tripPace(definition.id, 0));
      this.baseGait.set(definition.id, gait);
      return [{ definition, mover, brain: createFacilityBrain(definition, start) }];
    });
  }

  // ── CharacterPositionSource (camera locate/follow and the character card) ──
  private npc(id: string): FacilityNpc | undefined { return this.npcs.find(entry => entry.definition.id === id); }
  position(id: string) { return this.npc(id)?.mover.position; }
  floor(id: string): CharacterFloor | undefined { const npc = this.npc(id); return npc ? floorAt(npc.mover.position[1]) : undefined; }
  moving(id: string): boolean { const phase = this.npc(id)?.mover.phase; return phase !== undefined && phase !== 'seated' && phase !== 'gone'; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  version = () => this.revision;
  private bump() { this.revision++; for (const listener of this.listeners) listener(); }

  /** Reduced motion keeps staff at their stations: no breaks, and anyone away is placed back at once. */
  setReducedMotion(reduced: boolean): void {
    if (this.reducedMotion === reduced) return;
    this.reducedMotion = reduced;
    this.sinceDecision = Infinity;
  }

  private arrived(npc: FacilityNpc): boolean {
    return npc.mover.phase === 'seated' && npc.mover.seat?.seatId === npc.brain.destination;
  }

  private sample(mover: Mover): CharacterSample {
    const p = mover.position;
    const floor = floorAt(p[1]);
    let entered = this.entrants.get(mover.id);
    if (entered === undefined) { entered = floor === 1 && p[2] < ENTRANCE_Z; this.entrants.set(mover.id, entered); }
    const goal = mover.pending ?? mover.goal;
    const seat = goal?.kind === 'seat' ? goal.seat : null;
    return {
      id: mover.id, floor, x: p[0], z: p[2], moving: mover.phase !== 'seated' && mover.phase !== 'gone',
      headingToSeat: Boolean(seat), seatRoomId: seat?.roomId ?? null, enteredFromEntrance: entered,
    };
  }

  /** Re-evaluate demand and duty; returns true when anyone's state changed. */
  private decide(): boolean {
    const now = this.now();
    const characters = this.characters();
    const samples = characters.map(mover => this.sample(mover));
    if (this.entrants.size > samples.length) {
      const present = new Set(samples.map(sample => sample.id));
      for (const id of this.entrants.keys()) if (!present.has(id)) this.entrants.delete(id);
    }
    let changed = false;
    const barGuests = samples.filter(sample => isDemandFor('bartender', sample));
    this.hospitality.retainServices(new Set(barGuests.map(sample => sample.id)));
    for (const guest of barGuests) {
      const mover = characters.find(character => character.id === guest.id)!;
      const goal = mover.pending ?? mover.goal;
      if (goal?.kind === 'seat') this.hospitality.request(guest.id, goal.seat.seatId);
    }
    for (const npc of this.npcs) {
      const demand = samples.filter(sample => isDemandFor(npc.definition.role, sample)).map(sample => sample.id);
      const before = npc.brain.destination;
      const arrived = this.arrived(npc);
      const serving = npc.brain.serving;
      const waitingForGuest = serving && barServicePhase(now - serving.since) === 'serve' && characters.find(character => character.id === serving.id)?.phase !== 'seated';
      if (stepFacilityBrain(npc.brain, { now, demand, arrived, allowBreaks: !this.reducedMotion,
        serviceReady: npc.definition.role !== 'bartender' || this.reducedMotion || (arrived && !waitingForGuest) })) changed = true;
      if (npc.definition.role === 'bartender') {
        const serving = npc.brain.serving;
        if (serving) {
          const phase = barServicePhase(now - serving.since);
          const resourceId = this.hospitality.serviceFor(serving.id)?.resourceId;
          const handoff = resourceId?.startsWith('lounge.barstool-') ? resourceId.replace('.barstool-', '.bar-serve-') : 'lounge.bar-serve';
          const contact = this.reducedMotion ? npc.definition.homeResourceId : phase === 'brew' || phase === 'shake' ? 'lounge.bar-prep' : phase === 'serve' ? handoff : npc.definition.homeResourceId;
          if (npc.brain.destination !== contact) { npc.brain.destination = contact; changed = true; }
          const settled = npc.mover.phase === 'seated' && npc.mover.seat?.seatId === contact;
          if (phase === 'serve' && settled) {
            const guest = characters.find(character => character.id === serving.id);
            if (guest?.phase === 'seated' && this.hospitality.deliver(serving.id, now)) changed = true;
          }
          npc.mover.motion.clip = settled ? phase === 'brew' ? 'bar-prep' : phase === 'shake' ? 'bar-shake' : phase === 'serve' ? 'bar-serve' : 'look-around' : 'none';
        } else {
          npc.mover.motion.clip = 'none';
          if (npc.brain.state === 'ON_DUTY' && npc.brain.destination !== npc.definition.homeResourceId) { npc.brain.destination = npc.definition.homeResourceId; changed = true; }
        }
      }
      const base = this.baseGait.get(npc.definition.id)!;
      npc.mover.gait = npc.brain.urgent ? { ...base, cadence: base.cadence * npc.definition.timing.urgency } : base;
      if (npc.brain.destination === before && !this.reducedMotion && npc.mover.goal?.kind === 'seat' && npc.mover.goal.seat.seatId === before) continue;
      const seat = this.env.navigation.seats.get(npc.brain.destination);
      if (!seat) continue;
      if (this.reducedMotion) placeSeated(npc.mover, seat, this.env);
      else {
        // A bad/missing connection must leave staff waiting, never trigger the mover's exit recovery.
        const current = npc.mover.seat;
        if (current && (npc.mover.phase === 'seated' || npc.mover.phase === 'sitting') &&
          !planRoute(seatStageId(current.seatId), seatStageId(seat.seatId), this.env.navigation)) continue;
        sendMover(npc.mover, { kind: 'seat', seat }, this.env);
      }
    }
    return changed;
  }

  /** Advance staff; called once per rendered frame. */
  tick(seconds: number): void {
    let changed = false;
    this.sinceDecision += seconds * 1000;
    if (this.sinceDecision >= FACILITY_DECISION_MS) {
      this.sinceDecision = 0;
      if (this.decide()) changed = true;
    }
    for (const npc of this.npcs) {
      const mover = npc.mover;
      const low = mover.floorLow, high = mover.floorHigh;
      stepMover(mover, seconds, this.env);
      // Staff never leave the building: an unexpected route end puts them back at their station.
      if (mover.phase === 'gone') {
        const home = this.env.navigation.seats.get(npc.definition.homeResourceId);
        if (home) placeSeated(mover, home, this.env);
      }
      const seated = mover.motion.sit >= 0.5;
      if (this.seatedFlags.get(mover.id) !== seated) { this.seatedFlags.set(mover.id, seated); changed = true; }
      if (low !== mover.floorLow || high !== mover.floorHigh) changed = true;
    }
    if (changed) this.bump();
  }

  /** Give back elevator places and door duties when the scene unmounts. */
  dispose(): void {
    for (const { mover } of this.npcs) {
      if (mover.trip) this.env.elevators.release(mover.id, mover.trip.id);
      if (mover.door) this.env.doors?.release(mover.door.id, mover.id);
      this.env.doors?.clearDuty(mover.id);
      this.env.trackWalker?.(mover.id, null);
      this.env.trackBody?.(mover.id, null);
    }
    this.hospitality.retainServices(new Set());
    this.listeners.clear();
  }
}
