import { describe, expect, it } from 'vitest';
import { normalizeMemoryDelete, normalizeMemoryListOptions, normalizeMemoryReadOptions, normalizeMemoryWrite } from '../src/nativeMemory.js';

const revision = 'a'.repeat(64);
describe('Native memory user request contracts', () => {
  it('requires exact revisions for user replacements and deletes, with explicit create-only null', () => {
    expect(normalizeMemoryWrite({ name: 'workflow', content: 'Confirmed', expectedRevision: null })).toMatchObject({ expectedRevision: null });
    expect(normalizeMemoryWrite({ name: 'workflow', content: 'Confirmed', expectedRevision: revision })).toMatchObject({ expectedRevision: revision });
    for (const value of [undefined, '', 'a', false, 7, {}, []]) {
      expect(() => normalizeMemoryWrite({ name: 'workflow', content: 'Confirmed', expectedRevision: value })).toThrow();
      expect(() => normalizeMemoryDelete({ name: 'workflow', expectedRevision: value })).toThrow();
    }
  });
  it('bounds user pages and excludes filesystem names and malformed bodies', () => {
    expect(normalizeMemoryReadOptions({ offset: 4, limit: 2000, expectedRevision: revision })).toEqual({ offset: 4, limit: 2000, expectedRevision: revision });
    expect(normalizeMemoryListOptions()).toEqual({});
    expect(() => normalizeMemoryListOptions({ offset: Infinity })).toThrow();
    expect(() => normalizeMemoryReadOptions({ limit: 8001 })).toThrow();
    for (const name of ['../workflow', '/tmp/example', 'UPPER', 'a'.repeat(65)]) expect(() => normalizeMemoryWrite({ name, content: 'Confirmed', expectedRevision: null })).toThrow();
    expect(() => normalizeMemoryWrite({ name: 'valid', content: 'a'.repeat(20_001), expectedRevision: null })).toThrow();
  });
});
