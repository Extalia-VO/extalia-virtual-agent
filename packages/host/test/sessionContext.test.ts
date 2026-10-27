import type { SessionContextUsage } from '@extalia/platform';
import { describe, expect, it } from 'vitest';
import { sessionContext } from '../src/sessionContext.js';

const AT = '2026-10-08T00:00:00.000Z';
const LATER = '2026-10-08T00:05:00.000Z';

describe('session context records', () => {
  it('takes the window from the source, else from the known-model table', () => {
    expect(sessionContext({ usedTokens: 124_000, model: 'claude-sonnet-4-5', compactions: 0, estimated: false, at: AT }))
      .toEqual({ usedTokens: 124_000, windowTokens: 200_000, estimated: false, compactions: 0, updatedAt: AT });
    expect(sessionContext({ usedTokens: 1_000, windowTokens: 258_400, model: 'unknown-model', compactions: 0, estimated: false, at: AT }).windowTokens).toBe(258_400);
  });

  it('omits the window for an unknown model', () => {
    const record = sessionContext({ usedTokens: 900, model: 'mistral-large', compactions: 0, estimated: true, at: AT });
    expect(record).toEqual({ usedTokens: 900, estimated: true, compactions: 0, updatedAt: AT });
    expect('windowTokens' in record).toBe(false);
  });

  it('keeps the stored record while nothing changed, so polling never rewrites it', () => {
    const previous: SessionContextUsage = { usedTokens: 124_000, windowTokens: 200_000, estimated: false, compactions: 1, updatedAt: AT };
    expect(sessionContext({ usedTokens: 124_000, model: 'claude-sonnet-4-5', compactions: 1, estimated: false, at: LATER, previous })).toBe(previous);
  });

  it('updates when the reading changes and never lowers the compaction count', () => {
    const previous: SessionContextUsage = { usedTokens: 124_000, windowTokens: 200_000, estimated: false, compactions: 2, updatedAt: AT };
    const grown = sessionContext({ usedTokens: 150_000, model: 'claude-sonnet-4-5', compactions: 1, estimated: false, at: LATER, previous });
    expect(grown).toEqual({ usedTokens: 150_000, windowTokens: 200_000, estimated: false, compactions: 2, updatedAt: LATER });
  });
});
