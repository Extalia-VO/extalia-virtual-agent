import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AGENT_HOST_METHODS, normalizeAutomaticLearningPolicy, normalizeSaveVaultProfile, type VaultProfilesCatalog } from '@extalia/platform';
import { describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { createMockPlatform } from '../src/host/mockHost';
import { createRemoteHost } from '../src/host/remote';
import { toggleVaultWorkspace, VaultProfilesView, vaultProfileDraft } from '../src/pages/settings/VaultProfilesSection';

const catalog: VaultProfilesCatalog = { revision: 'example-revision', defaultProfileId: 'default', profiles: [
  { id: 'default', name: 'Default', kind: 'indexed', root: '/data/vaults/default', minutesEnabled: true, automaticLearning: { enabled: false, skills: false, notes: false }, workspaceIds: [] },
  { id: 'vp-example', name: 'Shared group', kind: 'managed', root: '/data/vaults/vp-example', minutesEnabled: true, automaticLearning: { enabled: false, skills: false, notes: false }, workspaceIds: ['w-one', 'w-two'] },
], workspaces: [{ id: 'w-one', name: 'Project One', profileId: 'vp-example' }, { id: 'w-two', name: 'Project Two', profileId: 'vp-example' }] };

describe('Settings: workspace vault profiles', () => {
  it('shows shared workspace bindings, vault destinations, explicit minutes permission and the indexed-vault limitation in both languages', () => {
    for (const language of ['en', 'id'] as const) {
      const t = MESSAGES[language];
      const html = renderToStaticMarkup(createElement(VaultProfilesView, { t, catalog, draft: vaultProfileDraft(catalog.profiles[1]!), busy: false,
        onDraft: vi.fn(), onSelect: vi.fn(), onNew: vi.fn(), onSave: vi.fn(), onRefresh: vi.fn() }));
      expect(html).toContain(t.vaultProfiles.title);
      expect(html).toContain(t.vaultProfiles.scope);
      expect(html).toContain(t.vaultProfiles.minutes);
      expect(html).toContain(t.vaultProfiles.learningEnabled);
      expect(html).toContain(t.vaultProfiles.learningSkills);
      expect(html).toContain(t.vaultProfiles.learningNotes);
      expect(html).toContain(t.vaultProfiles.learningHint);
      expect(html).toContain(t.vaultProfiles.learningConsent);
      expect(html).toContain(t.vaultProfiles.notesOnly);
      expect(html).toContain('/data/vaults/vp-example');
      expect(html).toContain('Project One, Project Two');
      expect(html.match(/type="checkbox" checked=""/g)).toHaveLength(3);
    }
    const original = vaultProfileDraft(catalog.profiles[1]!);
    const toggled = toggleVaultWorkspace(original, 'w-two');
    expect(toggled.workspaceIds).toEqual(['w-one']);
    expect(original.workspaceIds).toEqual(['w-one', 'w-two']);
  });

  it('the mock host groups real workspace profileIds and enforces revision and workspace validation', async () => {
    const agents = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    for (const session of (await agents.getState()).sessions) if (session.running) await agents.cancel(session.id);
    const initial = await agents.listVaultProfiles!();
    const ids = initial.workspaces.map(workspace => workspace.id);
    const saved = await agents.saveVaultProfile!({ name: 'Shared notes', vaultRoot: null, workspaceIds: ids, minutesEnabled: true, expectedRevision: initial.revision });
    const profile = saved.profiles.find(item => item.kind === 'managed')!;
    expect(profile.workspaceIds).toEqual(ids);
    expect((await agents.getState()).workspaces.every(workspace => workspace.profileId === profile.id)).toBe(true);
    await expect(agents.saveVaultProfile!({ name: 'Stale', vaultRoot: null, workspaceIds: ids, minutesEnabled: true, expectedRevision: initial.revision })).rejects.toThrow(/Refresh/);
    await expect(agents.saveVaultProfile!({ name: 'Unknown', vaultRoot: null, workspaceIds: ['unknown'], minutesEnabled: true, expectedRevision: saved.revision })).rejects.toThrow(/no longer exists/);
  });

  it('keeps mock learning off by default and preserves policy for clients that omit it', async () => {
    const agents = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    for (const session of (await agents.getState()).sessions) if (session.running) await agents.cancel(session.id);
    let catalog = await agents.listVaultProfiles!();
    expect(catalog.profiles.every(profile => !profile.automaticLearning.enabled)).toBe(true);
    const initial = { name: 'Learning group', vaultRoot: null, workspaceIds: catalog.workspaces.map(workspace => workspace.id), minutesEnabled: false };
    catalog = await agents.saveVaultProfile!({ ...initial, expectedRevision: catalog.revision,
      automaticLearning: { enabled: true, skills: true, notes: true } });
    const profile = catalog.profiles.find(item => item.name === initial.name)!;
    expect(profile.automaticLearning).toEqual({ enabled: true, skills: true, notes: true });
    expect(profile.minutesEnabled).toBe(false);
    catalog = await agents.saveVaultProfile!({ ...initial, id: profile.id, expectedRevision: catalog.revision });
    expect(catalog.profiles.find(item => item.id === profile.id)?.automaticLearning).toEqual(profile.automaticLearning);
    catalog = await agents.saveVaultProfile!({ ...initial, id: profile.id, vaultRoot: '/example/another-vault', expectedRevision: catalog.revision });
    expect(catalog.profiles.find(item => item.id === profile.id)?.automaticLearning).toEqual({ enabled: true, skills: true, notes: false });
  });

  it('forwards both methods through the shared Bridge/Desktop whitelist and validates bounded save payloads', async () => {
    expect(AGENT_HOST_METHODS).toEqual(expect.arrayContaining(['listVaultProfiles', 'saveVaultProfile']));
    const call = vi.fn(async () => catalog);
    const remote = createRemoteHost(call, () => () => undefined);
    await remote.listVaultProfiles!();
    const input = { name: 'Group', vaultRoot: null, workspaceIds: ['w-one'], minutesEnabled: true, expectedRevision: catalog.revision };
    await remote.saveVaultProfile!(input);
    expect(call.mock.calls).toEqual([['listVaultProfiles', []], ['saveVaultProfile', [input]]]);
    expect(normalizeSaveVaultProfile(input)).toEqual(input);
    expect(() => normalizeSaveVaultProfile({ ...input, workspaceIds: ['w-one', 'w-one'] })).toThrow(/once/);
    expect(() => normalizeSaveVaultProfile({ ...input, minutesEnabled: undefined })).toThrow(/meeting minutes/);
    expect(normalizeAutomaticLearningPolicy(undefined)).toEqual({ enabled: false, skills: false, notes: false });
    const automaticLearning = { enabled: true, skills: false, notes: true };
    expect(normalizeSaveVaultProfile({ ...input, automaticLearning }).automaticLearning).toEqual(automaticLearning);
    for (const invalid of [null, true, {}, { ...automaticLearning, skills: 'yes' }, { ...automaticLearning, extra: true }]) {
      expect(() => normalizeSaveVaultProfile({ ...input, automaticLearning: invalid })).toThrow(/learning policy/);
    }
  });
});
