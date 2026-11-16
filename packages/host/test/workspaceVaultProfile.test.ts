import type { Workspace } from '@extalia/core';
import { describe, expect, it } from 'vitest';
import { assignWorkspaceVaultProfile } from '../src/workspaceVaultProfile.js';

const workspace = (id: string, profileId = 'default', crossWorkspaceAccess: Workspace['crossWorkspaceAccess'] = 'read-only'): Workspace => ({
  id, name: id, profileId, crossWorkspaceAccess, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});
const id = 'vp-00000000-0000-4000-8000-000000000001';

describe('workspace vault profile assignment', () => {
  it('creates a dedicated managed profile only for the isolated target and leaves other bindings intact', () => {
    const result = assignWorkspaceVaultProfile({ workspaces: [workspace('isolated', 'default', 'isolated'), workspace('shared')],
      defaultProfile: { id: 'default', name: 'Default' } }, 'isolated', () => id);
    expect(result).toMatchObject({ profileId: id, created: true });
    expect(result.workspaces.map(item => [item.id, item.profileId])).toEqual([['isolated', id], ['shared', 'default']]);
    expect(result.profiles.profiles[0]).toMatchObject({ id, name: 'isolated vault', vaultRoot: null,
      automaticLearning: { enabled: true, skills: true, notes: true } });
  });

  it('retains an existing sole-member dedicated profile and does not alter shared workspaces', () => {
    const profile = { id, name: 'Existing', vaultRoot: null, minutesEnabled: true };
    const result = assignWorkspaceVaultProfile({ profiles: { profiles: [profile] },
      workspaces: [workspace('isolated', id, 'isolated'), workspace('shared')], defaultProfile: { id: 'default', name: 'Default' } },
    'isolated', () => { throw new Error('must not generate'); });
    expect(result.created).toBe(false);
    expect(result.profileId).toBe(id);
    expect(result.profiles.profiles).toEqual([profile]);
  });

  it('creates a new profile when the current non-default profile is shared', () => {
    const sharedId = 'vp-00000000-0000-4000-8000-000000000002';
    const result = assignWorkspaceVaultProfile({ profiles: { profiles: [{ id: sharedId, name: 'Shared', vaultRoot: null }] },
      workspaces: [workspace('isolated', sharedId, 'isolated'), workspace('other', sharedId)], defaultProfile: { id: 'default', name: 'Default' } },
    'isolated', () => id);
    expect(result.profileId).toBe(id);
    expect(result.workspaces.find(item => item.id === 'other')?.profileId).toBe(sharedId);
  });

  it('does not mutate input and rejects unknown workspaces or invalid generated ids', () => {
    const state = { workspaces: [workspace('isolated', 'default', 'isolated')], defaultProfile: { id: 'default', name: 'Default' } };
    expect(() => assignWorkspaceVaultProfile(state, 'missing')).toThrow(/no longer exists/);
    expect(() => assignWorkspaceVaultProfile(state, 'isolated', () => 'bad')).toThrow(/unique/);
    expect(state.workspaces[0]?.profileId).toBe('default');
  });

  it('keeps generated profile names within the registry bound for long workspace names', () => {
    const target = { ...workspace('long', 'default', 'isolated'), name: 'A'.repeat(120) };
    const result = assignWorkspaceVaultProfile({ workspaces: [target], defaultProfile: { id: 'default', name: 'Default' } }, target.id, () => id);
    expect(result.profiles.profiles[0]!.name.length).toBeLessThanOrEqual(120);
    expect(result.profiles.profiles[0]!.name).toContain('vault');
  });
});
