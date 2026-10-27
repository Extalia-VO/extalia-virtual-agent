import { useSyncExternalStore } from 'react';
import type { Messages } from '../../../i18n';
import type { PopoverCharacter } from '../../overlay/CharacterPopover';
import { FACILITY_NPCS, type FacilityCharacterState, type FacilityNpcDefinition } from './facilityNpcs';

/** What the page may know about a facility staff member: role and duty state only, never session data. */
export interface FacilityStaffStatus {
  readonly definition: FacilityNpcDefinition;
  readonly state: FacilityCharacterState;
}

interface StatusSource {
  readonly npcs: readonly { readonly definition: FacilityNpcDefinition; readonly brain: { readonly state: FacilityCharacterState } }[];
  subscribe(listener: () => void): () => void;
  version(): number;
}

let source: StatusSource | null = null;
let detach: (() => void) | null = null;
let snapshot: readonly FacilityStaffStatus[] = FACILITY_NPCS.map(definition => ({ definition, state: 'ON_DUTY' }));
const listeners = new Set<() => void>();

function refresh() {
  const next = FACILITY_NPCS.map(definition => ({
    definition, state: source?.npcs.find(npc => npc.definition.id === definition.id)?.brain.state ?? 'ON_DUTY' as FacilityCharacterState,
  }));
  if (next.every((entry, index) => entry.state === snapshot[index]?.state)) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

/** The mounted scene's facility director reports here; the Office page reads it for the staff card. */
export function bindFacilityStatus(next: StatusSource | null): void {
  if (next === source) return;
  detach?.();
  source = next;
  detach = next ? next.subscribe(refresh) : null;
  refresh();
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const getSnapshot = () => snapshot;

export const isFacilityStaffId = (id: string | null | undefined): boolean => Boolean(id && FACILITY_NPCS.some(npc => npc.id === id));

/** Facility staff with their current duty state (on duty until a scene reports otherwise). */
export function useFacilityStaff(): readonly FacilityStaffStatus[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Character card for a staff member: role and duty only; there is no session, so no message or activity actions. */
export function facilityCard(t: Messages, status: FacilityStaffStatus): PopoverCharacter {
  const f = t.facility, role = status.definition.role, state = status.state;
  const summary = state === 'ON_DUTY' ? f.summary.duty[role] : state === 'SERVING' ? f.summary.serving[role] : f.summary[state];
  return {
    id: status.definition.id, displayName: f.roles[role], role: f.staff,
    state: state === 'BREAK' || state === 'RECREATION' ? 'break' : 'working', summary,
  };
}
