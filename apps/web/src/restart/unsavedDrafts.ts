import { useEffect, useSyncExternalStore } from 'react';

/**
 * Owners (for example the chat composer) that hold text the user has not sent or
 * saved. A restart would discard it, so the restart prompt asks first.
 */
export class DraftRegistry {
  private readonly owners = new Set<string>();
  private readonly listeners = new Set<() => void>();

  hasDrafts = (): boolean => this.owners.size > 0;

  set(owner: string, pending: boolean): void {
    const before = this.owners.size;
    if (pending) this.owners.add(owner);
    else this.owners.delete(owner);
    if (this.owners.size === before) return;
    for (const listener of [...this.listeners]) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
}

export const unsavedDrafts = new DraftRegistry();

/** Register an owner's unsaved text while `pending` is true; it is cleared when the owner unmounts. */
export function useUnsavedDraft(owner: string, pending: boolean): void {
  useEffect(() => {
    unsavedDrafts.set(owner, pending);
    return () => unsavedDrafts.set(owner, false);
  }, [owner, pending]);
}

export function useHasUnsavedDrafts(): boolean {
  return useSyncExternalStore(unsavedDrafts.subscribe, unsavedDrafts.hasDrafts, () => false);
}
