import type { Point3 } from '../layout';

export type CharacterFloor = 1 | 2 | 3;

/** Read side of the live character positions, shared by the scene and its host page. */
export interface CharacterPositionSource {
  /** Current feet position. The tuple is live and updated in place: read it, never keep or mutate it. */
  position(id: string): Readonly<Point3> | undefined;
  /** Nearest floor of the character right now (it may be on the stairs or in an elevator). */
  floor(id: string): CharacterFloor | undefined;
  /** True while the character walks, rides or sits down / stands up. */
  moving(id: string): boolean;
  /** Notified on arrivals, departures, floor changes and sit/stand; not on every frame. */
  subscribe(listener: () => void): () => void;
  version(): number;
}

export interface CharacterPositionStore extends CharacterPositionSource {
  /** Connect the scene's movement layer; `null` disconnects it. */
  bind(source: CharacterPositionSource | null): void;
}

/**
 * A stable handle the page can create before the (lazy) Office canvas mounts.
 * Without a bound scene every query is empty.
 */
export function createCharacterPositionStore(): CharacterPositionStore {
  let source: CharacterPositionSource | null = null;
  let detach: (() => void) | null = null;
  let localVersion = 0;
  const listeners = new Set<() => void>();
  const notify = () => { localVersion++; for (const listener of listeners) listener(); };
  return {
    position: id => source?.position(id),
    floor: id => source?.floor(id),
    moving: id => source?.moving(id) ?? false,
    version: () => localVersion,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    bind(next) {
      if (next === source) return;
      detach?.();
      source = next;
      detach = next ? next.subscribe(notify) : null;
      notify();
    },
  };
}

/** Several position sources read as one (agents and facility staff); ids never overlap. */
export function combinePositionSources(...sources: readonly CharacterPositionSource[]): CharacterPositionSource {
  const pick = (id: string) => sources.find(source => source.position(id));
  return {
    position: id => pick(id)?.position(id),
    floor: id => pick(id)?.floor(id),
    moving: id => pick(id)?.moving(id) ?? false,
    subscribe(listener) {
      const detach = sources.map(source => source.subscribe(listener));
      return () => { for (const off of detach) off(); };
    },
    version: () => sources.reduce((total, source) => total + source.version(), 0),
  };
}
