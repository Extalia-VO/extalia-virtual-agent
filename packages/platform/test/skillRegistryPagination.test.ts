import { describe, expect, it } from 'vitest';
import { AGENT_HOST_METHODS, isAgentHostMethod, normalizeSkillRegistryPageInput } from '../src/index.js';

const cursor = `example-skill/skr_${'a'.repeat(64)}`;

describe('skill registry metadata page input', () => {
  it('exposes an optional read-only transport method and preserves a valid cursor', () => {
    expect(AGENT_HOST_METHODS).toContain('skillRegistryPage');
    expect(isAgentHostMethod('skillRegistryPage')).toBe(true);
    expect(normalizeSkillRegistryPageInput({ cursor })).toEqual({ cursor });
  });

  it('rejects missing, oversized, malformed or authority-bearing inputs', () => {
    for (const input of [undefined, null, [], cursor, {}, { cursor: '' }, { cursor: `${cursor}\n` }, { cursor: cursor.toUpperCase() },
      { cursor: 'x'.repeat(10000) }, { cursor: '../example/skr_' + 'a'.repeat(64) }, { cursor, profile: 'other' }, { cursor, limit: 1000 }, { cursor, packageId: 'example' }]) {
      expect(() => normalizeSkillRegistryPageInput(input)).toThrow('Invalid skill catalog cursor.');
    }
  });
});
