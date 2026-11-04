import { useSyncExternalStore } from 'react';
import { lookVersion, subscribeLooks } from './lookAllocation';

/** Re-renders when the allocation of generated looks changes (a character joined or left the Office). */
export function useLookVersion(): number {
  return useSyncExternalStore(subscribeLooks, lookVersion, lookVersion);
}
