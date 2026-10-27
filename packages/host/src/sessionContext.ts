import { contextWindowOf } from '@extalia/core';
import type { SessionContextUsage } from '@extalia/platform';

/**
 * The context record of a session (v0.0.48). The window comes from the source when it states one
 * (Codex `model_context_window`), otherwise from the known-model table. An unchanged reading returns
 * the stored record, so polling an unchanged transcript never rewrites it.
 */
export function sessionContext(input: {
  usedTokens: number;
  estimated: boolean;
  model?: string;
  windowTokens?: number;
  compactions: number;
  at: string;
  previous?: SessionContextUsage;
}): SessionContextUsage {
  const windowTokens = input.windowTokens ?? contextWindowOf(input.model, input.usedTokens);
  const previous = input.previous;
  // Compactions only grow: a window read that misses a compaction in the middle never lowers the count.
  const compactions = Math.max(input.compactions, previous?.compactions ?? 0);
  if (previous && previous.usedTokens === input.usedTokens && previous.windowTokens === windowTokens
    && previous.estimated === input.estimated && previous.compactions === compactions) return previous;
  return {
    usedTokens: input.usedTokens,
    ...(windowTokens ? { windowTokens } : {}),
    estimated: input.estimated,
    compactions,
    updatedAt: input.at,
  };
}
