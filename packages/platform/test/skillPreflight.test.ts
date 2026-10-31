import { describe, expect, it } from 'vitest';
import { normalizeSkillPreflight, normalizeSkillPreflightReport } from '../src/skillRegistry.js';

const root = `skr_${'a'.repeat(64)}`, dependency = `skr_${'b'.repeat(64)}`;
const blocked = { rootRevisionId: root, dispatchEligible: false, status: 'blocked', issues: [{ code: 'root_unavailable', packageId: 'root' }], truncated: false };
describe('read-only skill dependency contracts', () => {
  it('copies only explicit exact pins, leaving missing ones empty', () => {
    const pins = { dependency };
    const found = normalizeSkillPreflight({ rootRevisionId: root, pins });
    expect(found).toEqual({ rootRevisionId: root, pins });
    expect(found.pins).not.toBe(pins);
    expect(normalizeSkillPreflight({ rootRevisionId: root, pins: {} }).pins).toEqual({});
  });
  it.each(['profile', 'runtimeFacts', 'permissionsCeiling', 'limits', 'scanner'])('rejects caller authority field %s', field => {
    expect(() => normalizeSkillPreflight({ rootRevisionId: root, pins: {}, [field]: {} })).toThrow();
  });
  it('refuses malformed/unbounded pins', () => {
    for (const pins of [[], null, { '../outside': dependency }, { dependency: 'latest' }, Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`dep-${i}`, dependency]))]) {
      expect(() => normalizeSkillPreflight({ rootRevisionId: root, pins })).toThrow();
    }
  });
  it('accepts only a matching-root, non-dispatchable, bounded result', () => {
    expect(normalizeSkillPreflightReport(blocked, root)).toEqual(blocked);
    for (const value of [{ ...blocked, dispatchEligible: true }, { ...blocked, rootRevisionId: dependency }, { ...blocked, plan: [] }, { ...blocked, issues: [] }, { ...blocked, issues: Array(257).fill(blocked.issues[0]) }]) {
      expect(() => normalizeSkillPreflightReport(value, root)).toThrow();
    }
  });
});
