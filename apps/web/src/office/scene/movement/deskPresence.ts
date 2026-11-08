import { useSyncExternalStore } from 'react';

/**
 * Where each character actually sits right now (seat id), as the movement layer sees it, or null while it
 * walks. A desk computer shows its owner's work only while the owner sits at it: a character on its way
 * (carrying its tablet) leaves a locked screen behind. Characters the movement layer does not track have no
 * entry, and screens then keep following the seat allocation alone.
 */
const seats = new Map<string, string | null>();
const listeners = new Set<() => void>();
let version = 0;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function setSeatedAt(agentId: string, seatId: string | null): void {
  if (seats.get(agentId) === seatId && seats.has(agentId)) return;
  seats.set(agentId, seatId);
  version++;
  listeners.forEach(listener => listener());
}
export function forgetSeated(agentId: string): void {
  if (!seats.delete(agentId)) return;
  version++;
  listeners.forEach(listener => listener());
}

/** Seat id the agent sits at, null while it moves, undefined when the movement layer does not track it. */
export function seatedAt(agentId: string): string | null | undefined {
  return seats.get(agentId);
}

/** Whether `agentId` is at `seatId`, re-rendering when that changes; untracked agents count as present. */
export function useSeatedAt(agentId: string | undefined, seatId: string | undefined): boolean {
  useSyncExternalStore(subscribe, () => version, () => version);
  if (!agentId || !seatId) return true;
  const at = seats.get(agentId);
  return at === undefined || at === seatId;
}
