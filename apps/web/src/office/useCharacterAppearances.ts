import type { CharacterAppearance, CharacterAppearances } from '@extalia/core';
import type { AgentHostApi } from '@extalia/platform';
import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Saved character looks from the agent host (shared by Web and Desktop), plus
 * one unsaved preview that the appearance editor shows on its character.
 */
export function useCharacterAppearances(agents: AgentHostApi | undefined) {
  const [saved, setSaved] = useState<CharacterAppearances>({});
  const [draft, setDraft] = useState<{ id: string; appearance: CharacterAppearance } | null>(null);
  useEffect(() => {
    if (!agents) return;
    let active = true;
    // A host without saved looks (or an older one) keeps every generated default.
    agents.characterAppearances().then(next => { if (active) setSaved(next); }, () => undefined);
    return () => { active = false; };
  }, [agents]);
  const appearances = useMemo<CharacterAppearances>(() => draft ? { ...saved, [draft.id]: draft.appearance } : saved, [saved, draft]);
  const preview = useCallback((id: string, appearance: CharacterAppearance | null) => {
    setDraft(current => appearance ? { id, appearance } : current?.id === id ? null : current);
  }, []);
  const save = useCallback(async (id: string, appearance: CharacterAppearance | null) => {
    if (!agents) throw new Error('Connect a host to save appearances.');
    setSaved(await agents.saveCharacterAppearance(id, appearance));
  }, [agents]);
  return { saved, appearances, preview, save };
}
