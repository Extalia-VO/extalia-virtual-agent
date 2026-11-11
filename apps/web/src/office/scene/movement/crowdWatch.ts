import type { Point3 } from '../layout';

/** The caller owns phase safety: hands on doors/chairs, stairs and lifts are ineligible. */
export interface CrowdWatchActor {
  readonly id: string;
  readonly floor: number;
  readonly position: Readonly<Point3>;
  readonly target?: Readonly<Point3> | null;
  readonly movementIntent: boolean;
  readonly eligible: boolean;
  /** Waiting is valid, but an eligible waiter can still repair a physical overlap. */
  readonly intentionalWait: boolean;
}

export interface CrowdWatchGroup {
  readonly id: string;
  readonly members: readonly string[];
  readonly overlapping: boolean;
  readonly seconds: number;
}

export interface CrowdWatchInitiative {
  readonly actorId: string;
  readonly groupId: string;
  readonly members: readonly string[];
  readonly reason: 'overlap' | 'blocked';
  readonly remainingSeconds: number;
}

export interface CrowdWatchDecision {
  readonly groups: readonly CrowdWatchGroup[];
  readonly initiative: CrowdWatchInitiative | null;
}

interface TrackedActor {
  anchor: Point3;
  floor: number;
  stationary: number;
}

const STALL_SECONDS = 3;
const SETTLE_SECONDS = 1;
const PROGRESS_METRES = .08;
const LEASE_SECONDS = 4;
const COOLDOWN_SECONDS = 1;
const RETRY_SECONDS = 8;
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const distance = (a: Readonly<Point3>, b: Readonly<Point3>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function facing(a: CrowdWatchActor, b: CrowdWatchActor): boolean {
  if (!a.target) return false;
  const tx = a.target[0] - a.position[0], tz = a.target[2] - a.position[2];
  const dx = b.position[0] - a.position[0], dz = b.position[2] - a.position[2];
  const lengths = Math.hypot(tx, tz) * Math.hypot(dx, dz);
  return lengths > 1e-6 && (tx * dx + tz * dz) / lengths > .5;
}

/**
 * Pure scene decisions from physical positions. One shared instance arbitrates
 * all characters; the caller must still find a collision-free escape and keep
 * the original destination. This class never moves actors or changes routes.
 */
export class CrowdWatch {
  private readonly tracked = new Map<string, TrackedActor>();
  private readonly retryAfter = new Map<string, number>();
  private readonly lastNominationAt = new Map<string, number>();
  private groups = new Map<string, CrowdWatchGroup>();
  private active: CrowdWatchInitiative | null = null;
  private now = 0;
  private nextInitiative = 0;

  /** A safe physical escape was unavailable; let another peer try after cooldown. */
  failed(actorId: string): void {
    if (this.active?.actorId !== actorId) return;
    this.retryAfter.set(actorId, this.now + RETRY_SECONDS);
    this.release();
  }

  /** The caller completed its escape, without replacing the actor's real goal. */
  resolved(actorId: string): void {
    if (this.active?.actorId === actorId) this.release();
  }

  private release(): void {
    this.active = null;
    this.nextInitiative = this.now + COOLDOWN_SECONDS;
  }

  update(input: readonly CrowdWatchActor[], seconds: number): CrowdWatchDecision {
    // The mover uses the same frame cap; tab suspension cannot age a crowd instantly.
    const dt = Number.isFinite(seconds) ? Math.min(.1, Math.max(0, seconds)) : 0;
    this.now += dt;
    const actors = [...new Map(input.filter(actor => actor.position.every(Number.isFinite)).map(actor => [actor.id, actor])).values()]
      .sort((a, b) => order(a.id, b.id));
    const byId = new Map(actors.map(actor => [actor.id, actor]));
    for (const id of this.tracked.keys()) if (!byId.has(id)) { this.tracked.delete(id); this.retryAfter.delete(id); this.lastNominationAt.delete(id); }
    for (const actor of actors) {
      const previous = this.tracked.get(actor.id);
      if (!previous || previous.floor !== actor.floor || distance(previous.anchor, actor.position) >= PROGRESS_METRES) {
        this.tracked.set(actor.id, { anchor: [...actor.position], floor: actor.floor, stationary: 0 });
      } else previous.stationary += dt;
    }

    const links = actors.map(() => [] as number[]);
    const overlaps = new Set<number>();
    for (let a = 0; a < actors.length; a++) {
      for (let b = a + 1; b < actors.length; b++) {
        const first = actors[a]!, second = actors[b]!;
        if (first.floor !== second.floor) continue;
        const separation = distance(first.position, second.position);
        const overlap = separation < .56;
        const blocked = separation < 1.4 && first.movementIntent && second.movementIntent
          && !first.intentionalWait && !second.intentionalWait
          && this.tracked.get(first.id)!.stationary >= STALL_SECONDS - 1e-9
          && this.tracked.get(second.id)!.stationary >= STALL_SECONDS - 1e-9
          && (facing(first, second) || facing(second, first)
            || separation < .85 && (!first.eligible || !second.eligible));
        if (!overlap && !blocked) continue;
        links[a]!.push(b); links[b]!.push(a);
        if (overlap) { overlaps.add(a); overlaps.add(b); }
      }
    }

    const groups = new Map<string, CrowdWatchGroup>();
    const visited = new Set<number>();
    for (let index = 0; index < actors.length; index++) {
      if (visited.has(index) || !links[index]!.length) continue;
      const pending = [index], members: string[] = [];
      let overlapping = false;
      visited.add(index);
      while (pending.length) {
        const current = pending.pop()!;
        members.push(actors[current]!.id);
        overlapping ||= overlaps.has(current);
        for (const neighbor of links[current]!) if (!visited.has(neighbor)) { visited.add(neighbor); pending.push(neighbor); }
      }
      members.sort(order);
      const id = JSON.stringify(members);
      groups.set(id, { id, members, overlapping, seconds: (this.groups.get(id)?.seconds ?? -dt) + dt });
    }
    this.groups = groups;

    if (this.active) {
      const actor = byId.get(this.active.actorId);
      const group = groups.get(this.active.groupId);
      if (!actor || !group || !actor.eligible || (actor.intentionalWait && !group.overlapping) || this.tracked.get(actor.id)!.stationary < STALL_SECONDS - 1e-9) this.release();
      else if (this.active.remainingSeconds <= dt + 1e-9) this.failed(actor.id);
      else this.active = { ...this.active, remainingSeconds: this.active.remainingSeconds - dt };
    }
    if (!this.active && this.now >= this.nextInitiative - 1e-9) {
      // Give every eligible actor a turn before retrying earlier nominees,
      // including actors in other clusters. IDs only break equal-age ties.
      const candidates = [...groups.values()].filter(group => group.seconds >= SETTLE_SECONDS - 1e-9)
        .flatMap(group => group.members.map(id => ({ actor: byId.get(id)!, group })))
        .filter(({ actor, group }) => actor.eligible && (!actor.intentionalWait || group.overlapping)
          && this.tracked.get(actor.id)!.stationary >= STALL_SECONDS - 1e-9
          && this.now >= (this.retryAfter.get(actor.id) ?? 0) - 1e-9)
        .sort((a, b) => (this.lastNominationAt.get(a.actor.id) ?? -1) - (this.lastNominationAt.get(b.actor.id) ?? -1)
          || order(a.actor.id, b.actor.id));
      const candidate = candidates[0];
      if (candidate) {
        this.lastNominationAt.set(candidate.actor.id, this.now);
        this.active = { actorId: candidate.actor.id, groupId: candidate.group.id, members: [...candidate.group.members],
          reason: candidate.group.overlapping ? 'overlap' : 'blocked', remainingSeconds: LEASE_SECONDS };
      }
    }
    return { groups: [...groups.values()], initiative: this.active ? { ...this.active, members: [...this.active.members] } : null };
  }
}
