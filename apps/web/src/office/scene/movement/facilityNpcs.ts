/**
 * Facility staff: the receptionist and the bartender. They are building
 * characters owned by the 3D simulation, never agent sessions: they create no
 * protocol events, never count as agents, and never take a workstation that
 * agents use. Pure definitions and a deterministic duty state machine, so the
 * per-frame cost is a few comparisons and everything here is unit-tested.
 */
import type { CharacterAppearance } from '@extalia/core';
import { BARTENDER_BAR_BLUEPRINT } from '../interior/spatialBlueprints';
import { resourceById, type SpatialResource } from '../interior/resourceRegistry';

export type FacilityRole = 'receptionist' | 'bartender';
export type FacilityCharacterState = 'ON_DUTY' | 'BREAK' | 'RECREATION' | 'RETURNING' | 'SERVING';

export interface FacilityTiming {
  /** Time on duty before a break is considered. */
  readonly dutyMs: number;
  /** Required quiet time (no demand) before leaving the station. */
  readonly quietMs: number;
  /** Stay at an F1 break spot. */
  readonly breakMs: number;
  /** Stay at the F3 terrace or fitness spot. */
  readonly recreationMs: number;
  /** One guest served (greeting, or one drink). */
  readonly serviceMs: number;
  /** A queued guest who left the service area is dropped after this. */
  readonly queueGraceMs: number;
  /** Walking pace while hurrying back to a waiting guest (1 = relaxed pace). */
  readonly urgency: number;
}

export interface FacilityNpcDefinition {
  readonly id: string;
  readonly role: FacilityRole;
  /** Explicit metadata, never inferred from a name. The rig and clothing are a visual definition only. */
  readonly presentation: 'female' | 'male';
  readonly homeResourceId: string;
  readonly homeFloor: 1;
  /** Home first, then the F1 break spot, then the F3 recreation spot. */
  readonly allowedDestinations: readonly string[];
  readonly breakResourceId: string;
  readonly recreationResourceId: string;
  readonly appearance: CharacterAppearance;
  readonly timing: FacilityTiming;
}

/** F3 rooms facility staff may visit; every other F3 room and all of F2 are offices. */
export const FACILITY_F3_ROOMS: ReadonlySet<string> = new Set(['rooftop-terrace', 'fitness']);

const RECEPTIONIST_LOOK: CharacterAppearance = {
  presentation: 'feminine', hairStyle: 'bob', hairColor: '#292426', skinTone: '#c79a82',
  outfit: 'business-casual', top: 'blouse', bottom: 'skirt', topColor: '#f3efe6', bottomColor: '#2f3a4f',
  stature: 'default', gait: 'feminine',
  accessories: { glasses: 'none', watch: 'classic', earrings: 'studs', bag: 'none', tie: false, badge: true, headphones: false },
};
const BARTENDER_LOOK: CharacterAppearance = {
  presentation: 'masculine', hairStyle: 'short-fade', hairColor: '#16110f', skinTone: '#a9765e',
  outfit: 'service', top: 'shirt', bottom: 'trousers', topColor: '#f5f3ee', bottomColor: '#23262b',
  stature: 'default', gait: 'masculine',
  accessories: { glasses: 'none', watch: 'none', earrings: 'none', bag: 'none', tie: true, badge: true, headphones: false },
};

export const FACILITY_NPCS: readonly FacilityNpcDefinition[] = Object.freeze([
  {
    id: 'facility:receptionist', role: 'receptionist', presentation: 'female',
    homeResourceId: 'lobby.receptionist', homeFloor: 1,
    allowedDestinations: ['lobby.receptionist', 'lounge.dining-2', 'rooftop-terrace.armchair-3'],
    breakResourceId: 'lounge.dining-2', recreationResourceId: 'rooftop-terrace.armchair-3',
    appearance: RECEPTIONIST_LOOK,
    timing: { dutyMs: 150_000, quietMs: 20_000, breakMs: 40_000, recreationMs: 60_000, serviceMs: 5_000, queueGraceMs: 8_000, urgency: 1.3 },
  },
  {
    id: 'facility:bartender', role: 'bartender', presentation: 'male',
    homeResourceId: 'lounge.bartender', homeFloor: 1,
    allowedDestinations: ['lounge.bartender', 'lounge.bar-prep', 'lounge.bar-serve', ...BARTENDER_BAR_BLUEPRINT.stools.map(stool => stool.resourceId.replace('.barstool-', '.bar-serve-')), 'lounge.dining-1', 'fitness.yoga-mat-1'],
    breakResourceId: 'lounge.dining-1', recreationResourceId: 'fitness.yoga-mat-1',
    appearance: BARTENDER_LOOK,
    timing: { dutyMs: 210_000, quietMs: 30_000, breakMs: 45_000, recreationMs: 70_000, serviceMs: 19_000, queueGraceMs: 30_000, urgency: 1.15 },
  },
]);

/** Stations owned by facility staff: generic agent seating never reserves them. */
export const FACILITY_RESERVED_RESOURCE_IDS: ReadonlySet<string> = new Set(FACILITY_NPCS.map(npc => npc.homeResourceId));
/** Every resource the walking graph must reach for facility staff. */
export const FACILITY_NAV_RESOURCE_IDS: ReadonlySet<string> = new Set(FACILITY_NPCS.flatMap(npc => npc.allowedDestinations));

/**
 * Where facility staff may go: their own station, or a non-workstation spot on
 * F1 or in the F3 terrace / fitness rooms. Never F2, never an F3 office, never
 * an ordinary workstation.
 */
export function isPermittedFacilityDestination(resource: Pick<SpatialResource, 'id' | 'floor' | 'roomId' | 'kind'> | undefined, homeResourceId: string): boolean {
  if (!resource) return false;
  if (resource.id === homeResourceId) return true;
  if (resource.kind === 'workstation') return false;
  if (resource.floor === 1) return true;
  return resource.floor === 3 && FACILITY_F3_ROOMS.has(resource.roomId);
}

export function facilityDefinitionsValid(definitions: readonly FacilityNpcDefinition[] = FACILITY_NPCS): boolean {
  return definitions.every(npc => npc.allowedDestinations[0] === npc.homeResourceId
    && npc.allowedDestinations.includes(npc.breakResourceId) && npc.allowedDestinations.includes(npc.recreationResourceId)
    && npc.allowedDestinations.every(id => isPermittedFacilityDestination(resourceById(id), npc.homeResourceId)));
}

// ── Demand ──

/** What the facility director knows about a real character (an agent avatar) this instant. */
export interface CharacterSample {
  readonly id: string;
  readonly floor: 1 | 2 | 3;
  readonly x: number;
  readonly z: number;
  /** Walking, riding or sitting down / standing up. */
  readonly moving: boolean;
  /** Heading to (or sitting at) a seat, rather than leaving. */
  readonly headingToSeat: boolean;
  /** Room of the seat it is heading to or sitting at. */
  readonly seatRoomId: string | null;
  /** First seen at the campus entrance, outside the lobby door: an arrival, not someone passing through. */
  readonly enteredFromEntrance: boolean;
}

/** Lobby arrival zone: the entrance approach and the reception hall on F1. */
export const LOBBY_ARRIVAL_ZONE = Object.freeze({ west: -8, east: 11, north: -24, south: -11 });

/** Receptionist demand: a real character who came in through the entrance and is walking through the lobby. */
export function isReceptionDemand(sample: CharacterSample): boolean {
  const zone = LOBBY_ARRIVAL_ZONE;
  return sample.floor === 1 && sample.enteredFromEntrance && sample.moving && sample.headingToSeat
    && sample.x >= zone.west && sample.x <= zone.east && sample.z >= zone.north && sample.z <= zone.south;
}

/** Bartender demand: a real character using a lounge seat (bar stool, lounge or dining seat). Lobby arrivals never count (R7). */
export function isBarDemand(sample: CharacterSample): boolean {
  return sample.floor === 1 && sample.headingToSeat && sample.seatRoomId === 'lounge';
}

export function isDemandFor(role: FacilityRole, sample: CharacterSample): boolean {
  return role === 'receptionist' ? isReceptionDemand(sample) : isBarDemand(sample);
}

// ── Duty state machine ──

export interface FacilityBrain {
  readonly definition: FacilityNpcDefinition;
  state: FacilityCharacterState;
  /** Resource the character is at or walking to. */
  destination: string;
  stateSince: number;
  dutySince: number;
  /** Arrived at the break / recreation spot at this time; null while walking there. */
  dwellSince: number | null;
  lastDemandAt: number;
  breaks: number;
  /** Guests waiting, in arrival order, with the last time each still showed demand. */
  readonly queue: { id: string; lastSeen: number }[];
  /** Guest being served now. */
  serving: { id: string; since: number } | null;
  /** Guests already served while they stay in the service area. */
  readonly served: Set<string>;
  /** Hurrying back to a waiting guest. */
  urgent: boolean;
  lastStepAt: number;
}

export function createFacilityBrain(definition: FacilityNpcDefinition, now: number): FacilityBrain {
  return {
    definition, lastStepAt: now, state: 'ON_DUTY', destination: definition.homeResourceId, stateSince: now, dutySince: now, dwellSince: null,
    lastDemandAt: -Infinity, breaks: 0, queue: [], serving: null, served: new Set(), urgent: false,
  };
}

export interface FacilityStepInput {
  readonly now: number;
  /** Ids of real characters showing demand for this role right now. */
  readonly demand: readonly string[];
  /** The character has settled at `brain.destination`. */
  readonly arrived: boolean;
  /** Breaks are allowed (off with reduced motion, so staff stay put). */
  readonly allowBreaks: boolean;
  /** Pause the bar preparation clock while the bartender walks between contacts. */
  readonly serviceReady?: boolean;
}

function enter(brain: FacilityBrain, state: FacilityCharacterState, now: number) {
  brain.state = state;
  brain.stateSince = now;
}

/** Track guests: queue new ones in arrival order, forget those who left long enough ago. */
function updateQueue(brain: FacilityBrain, now: number, demand: readonly string[]) {
  const present = new Set(demand);
  for (const id of demand) {
    const queued = brain.queue.find(entry => entry.id === id);
    if (queued) queued.lastSeen = now;
    else if (!brain.served.has(id) && brain.serving?.id !== id) brain.queue.push({ id, lastSeen: now });
  }
  for (let index = brain.queue.length - 1; index >= 0; index--) {
    if (now - brain.queue[index]!.lastSeen > brain.definition.timing.queueGraceMs) brain.queue.splice(index, 1);
  }
  // Leaving the service area ends "served", so a later visit is welcomed again.
  for (const id of brain.served) if (!present.has(id)) brain.served.delete(id);
  if (demand.length) brain.lastDemandAt = now;
}

const pending = (brain: FacilityBrain) => brain.queue.length > 0 || brain.serving !== null;

function startDuty(brain: FacilityBrain, now: number) {
  enter(brain, 'ON_DUTY', now);
  brain.dutySince = now;
  brain.urgent = false;
}

function returnHome(brain: FacilityBrain, now: number, urgent: boolean) {
  enter(brain, 'RETURNING', now);
  brain.destination = brain.definition.homeResourceId;
  brain.dwellSince = null;
  brain.urgent = urgent;
}

/** Serve the next guest, or go back on duty when nobody waits. */
function serveNext(brain: FacilityBrain, now: number) {
  const next = brain.queue.shift();
  if (!next) { startDuty(brain, now); return; }
  brain.serving = { id: next.id, since: now };
  brain.served.add(next.id);
  enter(brain, 'SERVING', now);
  brain.urgent = false;
}

/**
 * Advance one character's duty. Deterministic: the same inputs always give the
 * same state. Returns true when the state, destination, guest or urgency changed.
 */
export function stepFacilityBrain(brain: FacilityBrain, input: FacilityStepInput): boolean {
  const { now, arrived, allowBreaks } = input;
  const signature = () => `${brain.state}|${brain.destination}|${brain.serving?.id ?? ''}|${brain.urgent}`;
  const before = signature();
  const timing = brain.definition.timing;
  updateQueue(brain, now, input.demand);
  if (brain.serving && input.serviceReady === false) brain.serving.since += Math.max(0, now - brain.lastStepAt);
  brain.lastStepAt = now;
  if (brain.definition.role === 'bartender' && brain.serving && !input.demand.includes(brain.serving.id)) brain.serving = null;
  switch (brain.state) {
    case 'ON_DUTY':
      if (pending(brain) && arrived) serveNext(brain, now);
      else if (allowBreaks && now - brain.dutySince >= timing.dutyMs && now - brain.lastDemandAt >= timing.quietMs) {
        // Alternate a short F1 break with F3 recreation.
        const recreation = brain.breaks % 2 === 1;
        brain.breaks++;
        enter(brain, recreation ? 'RECREATION' : 'BREAK', now);
        brain.destination = recreation ? brain.definition.recreationResourceId : brain.definition.breakResourceId;
        brain.dwellSince = null;
      }
      break;
    case 'BREAK':
    case 'RECREATION': {
      if (pending(brain) || !allowBreaks) { returnHome(brain, now, pending(brain)); break; }
      if (!arrived) break;
      brain.dwellSince ??= now;
      if (now - brain.dwellSince >= (brain.state === 'BREAK' ? timing.breakMs : timing.recreationMs)) returnHome(brain, now, false);
      break;
    }
    case 'RETURNING':
      if (pending(brain)) brain.urgent = true;
      if (arrived) { if (pending(brain)) serveNext(brain, now); else startDuty(brain, now); }
      break;
    case 'SERVING':
      if (brain.serving && input.serviceReady !== false && now - brain.serving.since >= timing.serviceMs) brain.serving = null;
      if (!brain.serving) serveNext(brain, now);
      break;
  }
  return before !== signature();
}

/** Bar service phases over one serving, ported from the hospitality cycle: notice, brew, shake, serve, return. */
export type BarServicePhase = 'notice' | 'brew' | 'shake' | 'serve' | 'return';
const BAR_TIMELINE: readonly { phase: BarServicePhase; until: number }[] = [
  { phase: 'notice', until: 2_000 }, { phase: 'brew', until: 8_000 }, { phase: 'shake', until: 12_000 },
  { phase: 'serve', until: 16_000 }, { phase: 'return', until: 19_000 },
];
export function barServicePhase(elapsedMs: number): BarServicePhase {
  for (const step of BAR_TIMELINE) if (elapsedMs < step.until) return step.phase;
  return 'return';
}
