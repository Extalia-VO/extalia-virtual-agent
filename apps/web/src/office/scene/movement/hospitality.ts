/** Scene-local hospitality and local console play. No protocol events or network players. */
export interface GuestService {
  readonly actorId: string;
  readonly resourceId: string;
  readonly item: 'drink' | 'food';
  status: 'waiting' | 'delivered';
  deliveredAt: number | null;
}
export const CONSOLE_SEATS = ['entertainment.console-1', 'entertainment.console-2'] as const;
export interface EntertainmentSession {
  readonly players: readonly [string, string];
  readonly reservedAt: number;
  startedAt: number | null;
  readonly arrived: Set<string>;
  readonly score: [number, number];
  /** Normalized shared court coordinates; renderers read these mutable values. */
  readonly ball: [number, number];
  readonly paddles: [number, number];
}
interface StoolState { angle: number; actorId: string | null }
export class HospitalityState {
  private readonly stools = new Map<string, StoolState>();
  private readonly services = new Map<string, GuestService>();
  private match: EntertainmentSession | null = null;
  stool(resourceId: string): StoolState {
    let state = this.stools.get(resourceId);
    if (!state) { state = { angle: 0, actorId: null }; this.stools.set(resourceId, state); }
    return state;
  }
  serviceFor(actorId: string): GuestService | undefined { return this.services.get(actorId); }
  request(actorId: string, resourceId: string): GuestService {
    const existing = this.services.get(actorId);
    if (existing?.resourceId === resourceId) return existing;
    const suffix = Number(resourceId.match(/\d+$/)?.[0] ?? 1);
    const service: GuestService = { actorId, resourceId, item: suffix % 2 === 0 ? 'food' : 'drink', status: 'waiting', deliveredAt: null };
    this.services.set(actorId, service);
    return service;
  }
  deliver(actorId: string, now: number): boolean {
    const service = this.services.get(actorId);
    if (!service || service.status === 'delivered') return false;
    service.status = 'delivered'; service.deliveredAt = now;
    return true;
  }
  releaseService(actorId: string): void { this.services.delete(actorId); }
  retainServices(present: ReadonlySet<string>): void {
    for (const id of this.services.keys()) if (!present.has(id)) this.services.delete(id);
  }
  entertainment(): EntertainmentSession | null { return this.match; }
  reserveGame(players: readonly [string, string], now: number): boolean {
    if (this.match || players[0] === players[1]) return false;
    this.match = { players, reservedAt: now, startedAt: null, arrived: new Set(), score: [0, 0], ball: [0.5, 0.5], paddles: [0.5, 0.5] };
    return true;
  }
  arriveGame(actorId: string, now: number): void {
    const match = this.match;
    if (!match?.players.includes(actorId)) return;
    match.arrived.add(actorId);
    if (match.arrived.size === 2) match.startedAt ??= now;
  }
  releaseActor(actorId: string): void {
    this.releaseService(actorId);
    if (this.match?.players.includes(actorId)) this.match = null;
    for (const stool of this.stools.values()) if (stool.actorId === actorId) stool.actorId = null;
  }
  advance(now: number, seconds: number, reducedMotion = false): void {
    for (const stool of this.stools.values()) if (!stool.actorId) stool.angle *= Math.exp(-Math.max(0, seconds) * 4);
    const match = this.match;
    if (!match || match.startedAt === null || reducedMotion) return;
    // A shared deterministic rally: both players and the television read this same match.
    const t = Math.max(0, now - match.startedAt) / 1000;
    const leg = t / 2.6, f = leg % 1;
    match.ball[0] = Math.floor(leg) % 2 ? 1 - f : f;
    match.ball[1] = 0.5 + Math.sin(t * 1.75) * 0.36;
    match.paddles[0] = 0.5 + Math.sin((t - 0.12) * 1.75) * 0.32;
    match.paddles[1] = 0.5 + Math.sin((t - 0.22) * 1.75) * 0.32;
    const points = Math.floor(t / 10.4);
    match.score[0] = Math.ceil(points / 2); match.score[1] = Math.floor(points / 2);
  }
  clear(): void { this.services.clear(); this.stools.clear(); this.match = null; }
}
export const hospitalityState = new HospitalityState();

/** Small turn about a stationary stool's shaft. The avatar and upper mesh share this exact angle. */
export function stoolTargetAngle(now: number, seed: number): number {
  return Math.sin(now / 6700 + seed) * 0.12 + Math.sin(now / 11300 + seed * 0.7) * 0.07;
}
