/**
 * Idle life of an agent character, decided only from its real presence: while
 * it works it stays at its own desk; once it is idle (or its task is done) it
 * stays seated for 1–5 minutes, then spends 6–15 minutes visiting the office's
 * real places (chatting with another idle character, fitness, TV and games,
 * the terrace, lounges, the pantry, the forecourt garden), then sits down at its
 * desk again. Real activity always wins: a busy character heads back at once.
 *
 * Pure and deterministic: durations and choices come from a hash of the
 * character id and its idle turn, so the same history gives the same day.
 */
import type { LeisureKind } from './leisureSpots';

export const LINGER_MIN_MS = 60_000;
export const LINGER_MAX_MS = 300_000;
export const OUTING_MIN_MS = 360_000;
export const OUTING_MAX_MS = 900_000;
export const VISIT_MIN_MS = 70_000;
export const VISIT_MAX_MS = 200_000;
export const CHAT_MIN_MS = 40_000;
export const CHAT_MAX_MS = 100_000;
/** A walk to a place that takes longer than this is given up (blocked lift, far floor). */
export const TRAVEL_LIMIT_MS = 150_000;

/** FNV-1a of `id`, mixed with a turn and a salt: a stable value in [0, 1). */
export function lifeRandom(id: string, turn: number, salt: number): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  let x = (hash ^ Math.imul(turn + 1, 0x9e3779b1) ^ Math.imul(salt + 7, 0x85ebca6b)) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

const between = (min: number, max: number, r: number) => Math.round(min + (max - min) * r);
/** Seated time at the desk after work ends, for this idle turn. */
export const lingerMs = (id: string, turn: number) => between(LINGER_MIN_MS, LINGER_MAX_MS, lifeRandom(id, turn, 1));
/** Length of the walk-about that follows, for this idle turn. */
export const outingMs = (id: string, turn: number) => between(OUTING_MIN_MS, OUTING_MAX_MS, lifeRandom(id, turn, 2));
/** Time spent at one place once there. */
export function visitMs(id: string, turn: number, visit: number, kind: LeisureKind): number {
  const r = lifeRandom(id, turn, 40 + visit);
  return kind === 'chat' ? between(CHAT_MIN_MS, CHAT_MAX_MS, r) : between(VISIT_MIN_MS, VISIT_MAX_MS, r);
}

export type RoutinePhase = 'busy' | 'linger' | 'outing';

export interface Routine {
  readonly id: string;
  phase: RoutinePhase;
  /** Idle turn: one linger plus the outing after it. */
  turn: number;
  /** End of the seated linger; null until the character is seated at its desk. */
  lingerUntil: number | null;
  outingUntil: number;
  /** Places visited in this outing. */
  visits: number;
  lastKind: LeisureKind | null;
}

/** A character starts idle at its desk (an Office that opens shows nobody wandering yet). */
export function createRoutine(id: string): Routine {
  return { id, phase: 'linger', turn: 0, lingerUntil: null, outingUntil: 0, visits: 0, lastKind: null };
}

export interface RoutineInput {
  readonly now: number;
  /** Real work in progress (`isBusy`). */
  readonly busy: boolean;
  /** Seated at its own desk right now. */
  readonly atDesk: boolean;
  /** Wandering is allowed (off with reduced motion). */
  readonly allowed: boolean;
  /** Scales every idle duration (1 in the Office; tests and inspection use less). */
  readonly scale?: number;
}

/** Where the character should be: at its desk, or out among the office's places. */
export type RoutineIntent = 'desk' | 'out';

function startLinger(routine: Routine) {
  routine.phase = 'linger';
  routine.turn++;
  routine.lingerUntil = null;
}

export function stepRoutine(routine: Routine, input: RoutineInput): RoutineIntent {
  const scale = input.scale ?? 1;
  if (input.busy) { routine.phase = 'busy'; return 'desk'; }
  if (routine.phase === 'busy') startLinger(routine);
  if (!input.allowed) {
    // Stay put; the linger starts over once wandering is allowed again.
    if (routine.phase === 'outing') startLinger(routine);
    routine.lingerUntil = null;
    return 'desk';
  }
  if (routine.phase === 'linger') {
    if (routine.lingerUntil === null) {
      if (input.atDesk) routine.lingerUntil = input.now + lingerMs(routine.id, routine.turn) * scale;
      return 'desk';
    }
    if (input.now < routine.lingerUntil) return 'desk';
    routine.phase = 'outing';
    routine.outingUntil = input.now + outingMs(routine.id, routine.turn) * scale;
    routine.visits = 0;
    routine.lastKind = null;
    return 'out';
  }
  if (input.now >= routine.outingUntil) { startLinger(routine); return 'desk'; }
  return 'out';
}

/** How often each kind is picked when it is available. */
export const LEISURE_WEIGHTS: Readonly<Record<LeisureKind, number>> = {
  chat: 3, fitness: 2, tv: 2, game: 1.5, terrace: 2, lounge: 1.5, pantry: 2, garden: 1.5, cafe: 1.5,
};

/**
 * The next kind of place, weighted, among the kinds with a free place (and a
 * partner, for chat); never the same kind twice in a row when another fits.
 */
export function chooseLeisureKind(routine: Pick<Routine, 'id' | 'turn' | 'visits' | 'lastKind'>, available: ReadonlySet<LeisureKind>): LeisureKind | null {
  let kinds = [...available].sort();
  if (kinds.length > 1 && routine.lastKind) kinds = kinds.filter(kind => kind !== routine.lastKind);
  if (!kinds.length) return null;
  const total = kinds.reduce((sum, kind) => sum + LEISURE_WEIGHTS[kind], 0);
  let pick = lifeRandom(routine.id, routine.turn, 100 + routine.visits) * total;
  for (const kind of kinds) {
    pick -= LEISURE_WEIGHTS[kind];
    if (pick < 0) return kind;
  }
  return kinds[kinds.length - 1]!;
}

export interface SpotCandidate {
  readonly id: string;
  readonly kind: LeisureKind;
  readonly floor: 1 | 2 | 3;
}

/**
 * A free place of `kind` (never one in `reserved`), preferring the character's
 * own floor most of the time so walks stay short; stable for the same inputs.
 */
export function chooseSpot<T extends SpotCandidate>(spots: readonly T[], kind: LeisureKind, reserved: ReadonlySet<string>,
  routine: Pick<Routine, 'id' | 'turn' | 'visits'>, floor: 1 | 2 | 3): T | null {
  const free = spots.filter(spot => spot.kind === kind && !reserved.has(spot.id));
  if (!free.length) return null;
  const near = free.filter(spot => spot.floor === floor);
  const pool = near.length && lifeRandom(routine.id, routine.turn, 200 + routine.visits) < 0.6 ? near : free;
  return pool[Math.floor(lifeRandom(routine.id, routine.turn, 300 + routine.visits) * pool.length)]!;
}

// ── Chat pairing ──

export interface ChatCandidate {
  readonly id: string;
  readonly floor: 1 | 2 | 3;
  /** Idle, out on a walk-about, and not chatting or just arrived somewhere. */
  readonly available: boolean;
}

/** Another available idle character to chat with: the same floor first, then anyone; stable order. */
export function pickChatPartner(self: { id: string; floor: 1 | 2 | 3; turn: number }, candidates: readonly ChatCandidate[]): string | null {
  const others = candidates.filter(candidate => candidate.available && candidate.id !== self.id);
  if (!others.length) return null;
  const rank = (candidate: ChatCandidate) => lifeRandom(`${self.id}|${candidate.id}`, self.turn, 500);
  others.sort((a, b) => Number(a.floor !== self.floor) - Number(b.floor !== self.floor) || rank(a) - rank(b) || a.id.localeCompare(b.id));
  return others[0]!.id;
}

export interface ChatPairCandidate {
  readonly id: string;
  readonly floor: 1 | 2 | 3;
  /** Spot ids: the first character stands at `a`, its partner at `b`, facing each other. */
  readonly spots: readonly [string, string];
}

/** A chat place with both spots free, on either partner's floor when possible. */
export function pickChatPlace<T extends ChatPairCandidate>(places: readonly T[], reserved: ReadonlySet<string>, floors: readonly (1 | 2 | 3)[], seed: { id: string; turn: number }): T | null {
  const free = places.filter(place => !reserved.has(place.spots[0]) && !reserved.has(place.spots[1]));
  if (!free.length) return null;
  const near = free.filter(place => floors.includes(place.floor));
  const pool = near.length ? near : free;
  return pool[Math.floor(lifeRandom(seed.id, seed.turn, 600) * pool.length)]!;
}

/** Who talks while the other listens: turns of a few seconds, alternating. */
export function chatSpeaker(startedAt: number, now: number, seed: string): 0 | 1 {
  const turnMs = 5_000 + lifeRandom(seed, 0, 700) * 4_000;
  return (Math.floor(Math.max(0, now - startedAt) / turnMs) % 2) as 0 | 1;
}
