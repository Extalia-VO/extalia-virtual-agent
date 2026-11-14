import { describe, expect, it } from 'vitest';
import { decodeOperatingProfile, decodeSessionOperatingProfile, readOperatingProfileDefaults, resolveOperatingProfile } from '../src/operatingProfiles.js';
import { decodeWorkspace } from '../src/models.js';
const stamp = '2026-01-01T00:00:00Z';
const profile = { id: 'op_example', name: 'Example', revision: 1, createdAt: stamp, updatedAt: stamp, purpose: 'Project purpose', personality: 'Shared style', defaults: { connectionId: 'saved', model: 'example-model', lead: { role: 'Lead', soul: 'Individual style' }, team: null } };
describe('operating profile contracts', () => {
  it('resolves explicit overrides, solo and empty own persona without changing the source', () => {
    const decoded = decodeOperatingProfile(profile); expect(decoded.ok).toBe(true); if (!decoded.ok) return;
    const resolved = resolveOperatingProfile(decoded.value, { model: 'another-model', personality: '', lead: { soul: '' }, team: null });
    expect(resolved.defaults.model).toBe('another-model'); expect(resolved.defaults.team).toBeNull();
    expect(resolved.snapshot).toMatchObject({ id: profile.id, revision: 1, personality: '', lead: { role: 'Lead', soul: '' } });
    expect(profile.defaults.lead.soul).toBe('Individual style');
  });
  it('returns independent nested team and lead data for source, overrides and session snapshot', () => {
    const decoded = decodeOperatingProfile({ ...profile, defaults: { ...profile.defaults, team: { enabled: true, allowedModels: ['example-model'],
      members: [{ id: 'member-one', name: 'Example Worker', role: 'Reviewer', models: ['example-model'], scope: ['src/**'], forbidden: ['private/**'] }],
      connections: [{ connectionId: 'another', allowedModels: ['worker-model'] }], rules: ['Review evidence'], goalDocument: { name: 'Goal', text: 'Original goal' } } } });
    expect(decoded.ok).toBe(true); if (!decoded.ok) return;
    const overrides = { team: decoded.value.defaults.team };
    const resolved = resolveOperatingProfile(decoded.value, overrides), team = resolved.defaults.team!;
    team.allowedModels.push('changed'); team.members[0]!.models.push('changed'); team.members[0]!.scope!.push('changed'); team.members[0]!.forbidden!.push('changed');
    team.connections![0]!.allowedModels.push('changed'); team.rules!.push('changed'); team.goalDocument!.text = 'Changed goal';
    resolved.defaults.lead!.soul = 'Changed lead';
    expect(decoded.value.defaults.team).toEqual(overrides.team);
    expect(decoded.value.defaults.team?.allowedModels).toEqual(['example-model']);
    expect(decoded.value.defaults.team?.members[0]).toMatchObject({ models: ['example-model'], scope: ['src/**'], forbidden: ['private/**'] });
    expect(decoded.value.defaults.team?.connections?.[0]?.allowedModels).toEqual(['worker-model']);
    expect(decoded.value.defaults.team?.rules).toEqual(['Review evidence']); expect(decoded.value.defaults.team?.goalDocument?.text).toBe('Original goal');
    expect(decoded.value.defaults.lead?.soul).toBe('Individual style'); expect(resolved.snapshot.lead?.soul).toBe('Individual style');
  });
  it('rejects unknown fields, authority fields, invalid models and incomplete snapshot source metadata', () => {
    for (const raw of [{ ...profile, permissions: { commands: 'allow' } }, { ...profile, defaults: { apiKey: 'secret' } }, { ...profile, defaults: { model: '--flag' } }, { ...profile, revision: 0 }]) expect(decodeOperatingProfile(raw).ok).toBe(false);
    expect(() => readOperatingProfileDefaults({ connectionId: 'saved', permissions: {} }, true)).toThrow();
    expect(decodeSessionOperatingProfile({ id: 'op_example', personality: 'style' }).ok).toBe(false);
    expect(decodeSessionOperatingProfile({ lead: { soul: '' } }).ok).toBe(true);
  });
  it('keeps operating selection distinct from the vault profile and file boundaries', () => {
    const decoded = decodeWorkspace({ id: 'w_example', profileId: 'vault-one', name: 'Example', createdAt: stamp, updatedAt: stamp, operatingProfileId: profile.id, operatingProfileOverrides: { team: null }, crossWorkspaceAccess: 'isolated' });
    expect(decoded.ok).toBe(true); if (decoded.ok) expect(decoded.value).toMatchObject({ profileId: 'vault-one', operatingProfileId: profile.id, crossWorkspaceAccess: 'isolated', operatingProfileOverrides: { team: null } });
  });
});
