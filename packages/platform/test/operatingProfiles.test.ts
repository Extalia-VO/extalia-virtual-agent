import { describe, expect, it } from 'vitest';
import { AGENT_HOST_METHODS, normalizeSessionOptions } from '../src/agentHost.js';
import { normalizeOperatingProfileInput, normalizeSessionOperatingProfileInput, normalizeWorkspaceOperatingProfile } from '../src/operatingProfiles.js';
describe('operating profile client inputs', () => {
  it('exposes every optional transport method and preserves explicit persona/solo choices', () => {
    expect(AGENT_HOST_METHODS).toContain('saveOperatingProfile'); expect(AGENT_HOST_METHODS).toContain('saveSessionOperatingProfile');
    expect(normalizeOperatingProfileInput({ name: ' Example ', defaults: { team: null, lead: { soul: '' } } })).toMatchObject({ name: 'Example', defaults: { team: null, lead: { soul: '' } } });
    expect(normalizeWorkspaceOperatingProfile({ profileId: 'op_example', overrides: {} })).toEqual({ profileId: 'op_example', overrides: {} });
    expect(normalizeSessionOptions({ operatingProfile: { lead: null }, team: null })).toEqual({ operatingProfile: { lead: null }, team: null });
  });
  it('requires exact revision for edits and rejects credentials/unknown fields/oversized bytes', () => {
    expect(() => normalizeOperatingProfileInput({ id: 'op_example', name: 'Edit', defaults: {} })).toThrow(/Refresh/);
    const token = '00000000-0000-4000-8000-000000000001';
    expect(normalizeOperatingProfileInput({ createRequestId: token, name: 'New', defaults: {} }).createRequestId).toBe(token);
    expect(() => normalizeOperatingProfileInput({ createRequestId: 'invalid', name: 'New', defaults: {} })).toThrow(/creation request/);
    expect(() => normalizeOperatingProfileInput({ id: 'op_example', expectedRevision: 1, createRequestId: token, name: 'Edit', defaults: {} })).toThrow(/new profile only/);
    expect(() => normalizeSessionOperatingProfileInput({ lead: { permissions: { commands: 'allow' } } })).toThrow();
    expect(() => normalizeWorkspaceOperatingProfile({ profileId: 'op_example', overrides: { credential: 'no' } })).toThrow();
    expect(() => normalizeOperatingProfileInput({ name: 'Example', personality: '界'.repeat(30_000), defaults: {} })).toThrow(/64 KiB/);
  });
});
