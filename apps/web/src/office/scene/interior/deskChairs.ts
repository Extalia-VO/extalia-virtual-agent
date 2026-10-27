/**
 * Desk chairs slide out and back only while a person holds them: the movement
 * layer (`chairChoreography`, `mover`) reports each chair's pull per frame, and
 * the chair renderer follows that scripted value. Sofas, armchairs, stools and
 * staff stations never move. Pure and allocation-free per frame.
 */
import type { Matrix4 } from 'three';
import { OFFICE_RESOURCES } from './resourceRegistry';
import { FACILITY_RESERVED_RESOURCE_IDS } from '../movement/facilityNpcs';

/** Fully pulled out: this far back from the desk and turned this much aside. */
export const CHAIR_SLIDE = 0.56;
export const CHAIR_TURN = 0.5;
/** Damping rate (1/s) when an abandoned chair returns to its tucked position. */
export const CHAIR_RATE = 16;

const DESK_CHAIRS: ReadonlySet<string> = new Set(OFFICE_RESOURCES
  .filter(resource => resource.kind === 'workstation' && resource.interaction.seatStyle === 'office' && !FACILITY_RESERVED_RESOURCE_IDS.has(resource.id))
  .map(resource => resource.id));

/** A workstation chair (never sofas, lounge chairs, stools or staff stations). */
export function isDeskChair(resourceId: string | undefined): boolean {
  return resourceId !== undefined && DESK_CHAIRS.has(resourceId);
}

/** Turn direction per chair, so neighbouring chairs don't all swing the same way. */
export function chairTurnSign(resourceId: string): 1 | -1 {
  let hash = 2166136261;
  for (let i = 0; i < resourceId.length; i++) hash = Math.imul(hash ^ resourceId.charCodeAt(i), 16777619);
  return (hash >>> 0) % 2 ? 1 : -1;
}

/** Chair-local offset for a pull amount: back along -Z (the sitter faces +Z) and a turn about Y. */
export function chairOffset(pull: number, resourceId: string, side: 1 | -1 = chairTurnSign(resourceId)): { back: number; turn: number } {
  const amount = Math.max(0, Math.min(1, pull));
  const eased = amount * amount * (3 - 2 * amount);
  return { back: CHAIR_SLIDE * eased, turn: CHAIR_TURN * eased * side };
}

/** Scripted pull per desk chair; chairs without a target this frame roll back in. */
export class DeskChairMotion {
  private readonly targets = new Map<string, number>();
  private readonly values = new Map<string, number>();
  private readonly sides = new Map<string, 1 | -1>();
  private revision = 0;

  setTarget(resourceId: string, target: number, side: 1 | -1 = chairTurnSign(resourceId)): void {
    this.targets.set(resourceId, Math.max(0, Math.min(1, target)));
    if (this.side(resourceId) !== side) this.revision++;
    this.sides.set(resourceId, side);
  }

  /** Advance every chair by `seconds`; targets are consumed (unset next frame means tucked). */
  advance(seconds: number): void {
    const k = 1 - Math.exp(-Math.max(0, seconds) * CHAIR_RATE);
    for (const id of this.targets.keys()) if (!this.values.has(id)) this.values.set(id, 0);
    for (const [id, value] of this.values) {
      const scripted = this.targets.has(id), target = this.targets.get(id) ?? 0;
      let next = scripted ? target : value + (target - value) * k;
      if (target === 0 && next < 0.002) next = 0;
      if (next !== value) this.revision++;
      if (next === 0 && !scripted) {
        this.values.delete(id);
        if (this.side(id) !== chairTurnSign(id)) this.revision++;
        this.sides.delete(id);
      } else this.values.set(id, next);
    }
    this.targets.clear();
  }

  pull(resourceId: string): number { return this.values.get(resourceId) ?? 0; }
  side(resourceId: string): 1 | -1 { return this.sides.get(resourceId) ?? chairTurnSign(resourceId); }
  /** Changes whenever any chair moved or changed turn direction. */
  version(): number { return this.revision; }
}

/** The live chairs of the mounted Office (one scene at a time). */
export const deskChairMotion = new DeskChairMotion();

// ── Rendered chairs ──

export type DeskChairVariant = 'task' | 'executive';
export interface RegisteredDeskChair {
  readonly resourceId: string;
  readonly floor: 1 | 2 | 3;
  readonly variant: DeskChairVariant;
  /** Chair transform relative to its furnished floor group. */
  readonly matrix: Matrix4;
}

const registered = new Map<string, RegisteredDeskChair>();
const listeners = new Set<() => void>();
let registryVersion = 0;
const notify = () => { registryVersion++; for (const listener of listeners) listener(); };

/** Desk chairs render as one instanced mesh per floor and variant; prefabs register their transform here. */
export const deskChairRegistry = {
  register(chair: RegisteredDeskChair): () => void {
    registered.set(chair.resourceId, chair);
    notify();
    return () => { if (registered.get(chair.resourceId) === chair) { registered.delete(chair.resourceId); notify(); } };
  },
  onFloor(floor: 1 | 2 | 3, variant: DeskChairVariant): RegisteredDeskChair[] {
    return [...registered.values()].filter(chair => chair.floor === floor && chair.variant === variant).sort((a, b) => a.resourceId.localeCompare(b.resourceId));
  },
  subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
  version: () => registryVersion,
};
