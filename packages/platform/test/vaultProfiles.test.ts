import { describe, expect, it } from 'vitest';
import { normalizeAutomaticLearningPolicy, normalizeSaveVaultProfile } from '../src/vaultProfiles.js';

const legacy = { enabled: true, skills: true, notes: false };
const save = { name: 'Example profile', vaultRoot: null, workspaceIds: ['workspace-example'], expectedRevision: 'reviewed-revision', minutesEnabled: false };
describe('observed automatic learning consent', () => {
  it('keeps legacy policy shape and missing observed consent off', () => {
    expect(normalizeAutomaticLearningPolicy(undefined)).toEqual({ enabled: false, skills: false, notes: false });
    expect(normalizeAutomaticLearningPolicy(legacy)).toEqual(legacy); expect(normalizeAutomaticLearningPolicy(legacy).observed === true).toBe(false);
  });
  it('preserves explicit boolean consent through the policy and profile-save contracts', () => {
    for (const observed of [false, true]) {
      const policy = { ...legacy, observed };
      expect(normalizeAutomaticLearningPolicy(policy)).toEqual(policy); expect(normalizeSaveVaultProfile({ ...save, automaticLearning: policy }).automaticLearning).toEqual(policy);
    }
  });
  it('rejects non-boolean observed consent instead of coercing truthiness', () => {
    for (const observed of [undefined, null, 'true', 'false', 0, 1, {}, []]) expect(() => normalizeAutomaticLearningPolicy({ ...legacy, observed })).toThrow('Invalid automatic learning policy');
  });
  it('keeps all three original boolean fields mandatory and rejects unrelated additions', () => {
    for (const key of ['enabled', 'skills', 'notes']) {
      const policy: Record<string, unknown> = { ...legacy, observed: true }; delete policy[key];
      expect(() => normalizeAutomaticLearningPolicy(policy)).toThrow('Invalid automatic learning policy');
    }
    expect(() => normalizeAutomaticLearningPolicy({ ...legacy, observed: true, activateSkills: true })).toThrow('Invalid automatic learning policy');
    expect(() => normalizeSaveVaultProfile({ ...save, expectedRevision: '', automaticLearning: { ...legacy, observed: true } })).toThrow('Refresh');
  });
});
