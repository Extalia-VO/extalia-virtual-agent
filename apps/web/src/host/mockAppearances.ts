import {
  characterSessionId, decodeCharacterAppearance, isCharacterId, MAX_CHARACTER_APPEARANCES, type CharacterAppearances,
} from '@extalia/core';
import type { AgentHostApi } from '@extalia/platform';

type AppearanceMethods = Pick<AgentHostApi, 'characterAppearances' | 'saveCharacterAppearance'>;

/** In-memory character looks for the development mock host, validated like the real host. */
export function createMockAppearances(liveSessionIds: () => ReadonlySet<string>, latency: () => Promise<void> = async () => undefined): AppearanceMethods {
  let characters: CharacterAppearances = {};
  const live = (): CharacterAppearances => {
    const sessions = liveSessionIds();
    characters = Object.fromEntries(Object.entries(characters).filter(([id]) => sessions.has(characterSessionId(id))));
    return structuredClone(characters);
  };
  return {
    async characterAppearances() { await latency(); return live(); },
    async saveCharacterAppearance(characterId, appearance) {
      await latency();
      if (!isCharacterId(characterId)) throw new Error('Choose a character in the Office.');
      if (!liveSessionIds().has(characterSessionId(characterId))) throw new Error('That character’s session no longer exists.');
      const next = { ...characters };
      if (appearance === null) delete next[characterId];
      else {
        const decoded = decodeCharacterAppearance(appearance);
        if (!decoded.ok) throw new Error(`This appearance cannot be saved: ${decoded.errors.join(' ')}`);
        if (!Object.hasOwn(next, characterId) && Object.keys(next).length >= MAX_CHARACTER_APPEARANCES) throw new Error('Too many saved appearances.');
        next[characterId] = decoded.value;
      }
      characters = next;
      return live();
    },
  };
}
