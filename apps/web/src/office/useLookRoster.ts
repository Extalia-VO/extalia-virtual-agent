import type { CharacterAppearance, CharacterAppearances } from '@extalia/core';
import { useEffect, useMemo } from 'react';
import type { OfficeAgent } from './presence';
import { lookSeed, presentationOf } from './scene/avatars/appearance';
import { lookVersion, notifyLookChange, setLookRoster, type LookRosterEntry } from './scene/avatars/lookAllocation';
import { FACILITY_NPCS, facilityAppearance } from './scene/movement/facilityNpcs';

/**
 * Publish the characters visible in the Office (agents and facility staff) so the scene, portraits
 * and the appearance editor resolve the same generated looks. Saved looks stay as they are and
 * only hold their casual items. The allocation is set while rendering, so the first frame already
 * wears the right outfits; listeners are notified once the commit is done.
 */
export function useLookRoster(agents: readonly OfficeAgent[], saved: CharacterAppearances): void {
  const entries = useMemo<LookRosterEntry[]>(() => [
    ...agents.map((agent): LookRosterEntry => {
      const seed = lookSeed(agent.id, agent.look);
      const look: CharacterAppearance | undefined = saved[agent.id];
      return { id: agent.id, seed, presentation: presentationOf(seed, agent.look?.presentation), saved: look };
    }),
    ...FACILITY_NPCS.map((npc): LookRosterEntry => {
      const look = facilityAppearance(npc, saved[npc.id]);
      return { id: npc.id, seed: npc.id, presentation: look.presentation, saved: look };
    }),
  ], [agents, saved]);
  setLookRoster(entries);
  const version = lookVersion();
  useEffect(() => { notifyLookChange(); }, [version]);
}
