import type { Usage } from '@extalia/protocol';

/** Transient, non-authoritative suggestions. Selecting one never authorizes sending it. */
export interface PromptSuggestionsStatus {
  sessionId: string;
  anchor?: string;
  state: 'pending' | 'ready' | 'unavailable' | 'unsupported' | 'private';
  prompts: string[];
  origin: 'native' | 'harness';
  canRequest: boolean;
  usage?: Usage;
}

export function normalizePromptSuggestions(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 3) throw new Error('Invalid prompt suggestions.');
  const prompts = value.map(item => {
    if (typeof item !== 'string' || !item.trim() || item.length > 240 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(item))
      throw new Error('Invalid prompt suggestions.');
    return item.trim();
  });
  if (new Set(prompts).size !== prompts.length) throw new Error('Invalid prompt suggestions.');
  return prompts;
}
