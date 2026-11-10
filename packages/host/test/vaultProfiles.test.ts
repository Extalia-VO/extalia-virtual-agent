import { lstat, mkdir, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from '@extalia/core';
import { describe, expect, it } from 'vitest';
import { VaultProfiles, type StoredVaultProfiles } from '../src/vaultProfiles.js';
import { writeJsonAtomic } from '../src/jsonStore.js';
import { useTempDirs } from './helpers.js';
import { createAgentHost } from '../src/service.js';
import { useRustLearningBackend } from './rustLearningFixture.js';

const temp = useTempDirs();
const rustBackend = useRustLearningBackend();
const workspace = (id: string): Workspace => ({ id, name: id, profileId: 'default', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
async function setup() {
  const root = await realpath(await temp());
  const data = path.join(root, 'data'), home = path.join(root, 'home');
  await mkdir(path.join(data, 'config'), { recursive: true }); await mkdir(home);
  let saved: StoredVaultProfiles | undefined;
  let workspaces = [workspace('w-one'), workspace('w-two')];
  let defaultRoot = path.join(data, 'vaults', 'default');
  let busy = false;
  const read = () => ({ profiles: saved, workspaces, defaultProfile: { id: 'default', name: 'Default' }, defaultRoot });
  const backend = await rustBackend(data);
  const options = { dataDirectory: data, homeDirectory: home, read, busy: () => busy,
    ensureManagedRoot: async (profileId: string) => (await backend.process('vault.ensure', { profileId })).root,
    commit: async (profiles: StoredVaultProfiles, next: Workspace[]) => {
      await writeJsonAtomic(path.join(data, 'config', 'extalia.json'), { vaultProfiles: profiles, workspaces: next }); saved = profiles; workspaces = next;
    } };
  const profiles = new VaultProfiles(options);
  const save = async (patch: Partial<Parameters<VaultProfiles['save']>[0]> = {}) => profiles.save({ name: 'Group', vaultRoot: null, workspaceIds: ['w-one', 'w-two'],
    expectedRevision: (await profiles.list()).revision, minutesEnabled: true, ...patch });
  return { root, data, home, options, profiles, save, read, setBusy: (value: boolean) => { busy = value; }, setDefault: (value: string) => { defaultRoot = value; } };
}

describe.skipIf(process.platform === 'win32')('workspace vault profiles', () => {
  it('keeps existing default notes, groups workspaces in an isolated managed vault and atomically persists actual profileIds', async () => {
    const h = await setup();
    const initial = await h.profiles.resolve('w-one', { ensure: true });
    await writeFile(path.join(initial.root, 'Keep.md'), '# Existing');
    const catalog = await h.save();
    const grouped = catalog.profiles.find(profile => profile.kind === 'managed')!;
    expect(grouped.id).toMatch(/^vp-/);
    expect(grouped.workspaceIds).toEqual(['w-one', 'w-two']);
    const one = await h.profiles.resolve('w-one', { ensure: true });
    const two = await h.profiles.resolve('w-two', { ensure: true });
    expect(one).toEqual(two);
    expect(one.root).toBe(path.join(h.data, 'vaults', grouped.id));
    expect(await readFile(path.join(initial.root, 'Keep.md'), 'utf8')).toBe('# Existing');
    const disk = JSON.parse(await readFile(path.join(h.data, 'config', 'extalia.json'), 'utf8'));
    expect(disk.workspaces.every((item: Workspace) => item.profileId === grouped.id)).toBe(true);
    const restarted = new VaultProfiles(h.options);
    expect(await restarted.resolve('w-two')).toEqual(two);
    await h.save({ id: grouped.id, workspaceIds: ['w-one'] });
    expect((await h.profiles.resolve('w-two')).profileId).toBe('default');
    expect(await readFile(path.join(initial.root, 'Keep.md'), 'utf8')).toBe('# Existing');
  });

  it('rejects overlapping custom vaults, stale revisions, duplicate or unknown workspaces, and busy changes', async () => {
    const h = await setup();
    const old = await h.profiles.list();
    const notes = path.join(h.root, 'notes'); await mkdir(path.join(notes, 'nested'), { recursive: true });
    await h.save({ name: 'First', vaultRoot: notes });
    await expect(h.save({ name: 'Second', vaultRoot: path.join(notes, 'nested') })).rejects.toThrow(/overlap/);
    await expect(h.profiles.assertDefaultRoot(notes)).rejects.toThrow(/overlap/);
    await expect(h.save({ name: 'Stale', expectedRevision: old.revision })).rejects.toThrow(/Refresh/);
    await expect(h.save({ workspaceIds: ['w-one', 'w-one'] })).rejects.toThrow(/once/);
    await expect(h.save({ workspaceIds: ['missing-workspace'] })).rejects.toThrow(/no longer exists/);
    await expect(h.profiles.resolve('missing-workspace', { ensure: true })).rejects.toThrow(/no longer exists/);
    h.setBusy(true);
    await expect(h.save()).rejects.toThrow(/active/);
    expect((await h.profiles.list()).profiles).toHaveLength(2);
  });

  it('preserves a legacy custom indexed vault and requires root-bound minutes opt-in', async () => {
    const h = await setup();
    const first = path.join(h.root, 'existing'), second = path.join(h.root, 'other');
    await mkdir(first); await mkdir(second); await writeFile(path.join(first, 'Keep.md'), '# Keep');
    h.setDefault(first);
    expect((await h.profiles.list()).profiles[0]).toMatchObject({ root: first, kind: 'indexed', minutesEnabled: false });
    await expect(h.profiles.resolve('w-one')).rejects.toThrow(/not enabled/);
    await h.save({ id: 'default', name: 'Default', minutesEnabled: true });
    expect((await h.profiles.resolve('w-one')).root).toBe(first);
    h.setDefault(second);
    await expect(h.profiles.resolve('w-one')).rejects.toThrow(/not enabled/);
    expect(await readFile(path.join(first, 'Keep.md'), 'utf8')).toBe('# Keep');
    await expect(h.save({ name: 'Duplicate', vaultRoot: second })).rejects.toThrow(/overlap/);
  });

  it('refuses managed vault symlink parents and revalidates custom folder identity at resolution', async () => {
    const h = await setup();
    const outside = path.join(h.root, 'outside'); await mkdir(outside);
    await symlink(outside, path.join(h.data, 'vaults'));
    await expect(h.profiles.resolve('w-one', { ensure: true })).rejects.toThrow(/identity|not enabled/);
    await expect(readFile(path.join(outside, 'default', 'missing.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    const other = await setup();
    const actual = path.join(other.root, 'custom'); await mkdir(actual);
    const catalog = await other.save({ vaultRoot: actual });
    expect(catalog.profiles.find(profile => profile.kind === 'custom')?.root).toBe(actual);
    const alternate = path.join(other.root, 'alias'); await symlink(actual, alternate);
    await expect(other.save({ name: 'Alias', vaultRoot: alternate })).rejects.toThrow(/symbolic link/);
  });

  it('never treats another internal vault or its descendants as the indexed owned default, even after minutes opt-in', async () => {
    const h = await setup();
    const invalid = path.join(h.data, 'vaults', 'other-profile');
    await mkdir(path.join(invalid, 'nested'), { recursive: true });
    await writeFile(path.join(invalid, 'Keep.md'), '# Keep');
    for (const selected of [invalid, path.join(invalid, 'nested')]) {
      h.setDefault(selected);
      expect((await h.profiles.list()).profiles[0]?.minutesEnabled).toBe(false);
      await expect(h.profiles.resolve('w-one', { ensure: true })).rejects.toThrow(/not enabled/);
      await h.save({ id: 'default', name: 'Default', minutesEnabled: true });
      await expect(h.profiles.resolve('w-one', { ensure: true })).rejects.toThrow(/outside the Extalia data folder/);
    }
    await expect(lstat(path.join(h.data, 'vaults', 'nested'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(invalid, 'Keep.md'), 'utf8')).toBe('# Keep');
  });

  it('recognizes only vaults/default through the host data-directory alias without migrating profile identities', async () => {
    const h = await setup();
    const alias = path.join(h.root, 'data-alias'); await symlink(h.data, alias);
    const profiles = new VaultProfiles({ ...h.options, dataDirectory: alias,
      read: () => ({ ...h.read(), defaultProfile: { id: 'profile-main', name: 'Default' },
        workspaces: h.read().workspaces.map(item => ({ ...item, profileId: 'profile-main' })) }),
    });
    const expected = path.join(h.data, 'vaults', 'default');
    expect(await profiles.resolve('w-one', { ensure: true })).toMatchObject({ root: expected, profileId: 'profile-main' });
    h.setDefault(path.join(alias, 'vaults', 'default'));
    expect(await profiles.resolve('w-one', { ensure: true })).toMatchObject({ root: expected, profileId: 'profile-main' });
    h.setDefault(path.join(h.data, 'vaults', 'profile-main'));
    await mkdir(path.join(h.data, 'vaults', 'profile-main'));
    await profiles.save({ id: 'profile-main', name: 'Default', vaultRoot: null, minutesEnabled: true, workspaceIds: ['w-one', 'w-two'], expectedRevision: (await profiles.list()).revision });
    await expect(profiles.resolve('w-one', { ensure: true })).rejects.toThrow(/outside the Extalia data folder/);
  });

  it('defaults learning off independently of minutes and persists explicit per-profile learning policy atomically', async () => {
    const h = await setup();
    expect((await h.profiles.policyFor('w-one')).policy).toEqual({ enabled: false, skills: false, notes: false });
    await expect(h.profiles.resolve('w-one', { purpose: 'learning', ensure: true })).rejects.toThrow(/not enabled/);
    const catalog = await h.save({ minutesEnabled: false, automaticLearning: { enabled: true, skills: true, notes: true } });
    const profile = catalog.profiles.find(item => item.kind === 'managed')!;
    const learning = await h.profiles.resolve('w-one', { purpose: 'learning', ensure: true });
    expect(learning).toEqual({ root: profile.root, profileId: profile.id, revision: catalog.revision });
    await expect(h.profiles.resolve('w-one')).rejects.toThrow(/Meeting minutes are not enabled/);
    const disk = JSON.parse(await readFile(path.join(h.data, 'config', 'extalia.json'), 'utf8'));
    expect(disk.vaultProfiles.profiles[0]).toMatchObject({ automaticLearning: { enabled: true, skills: true, notes: true }, learningRoot: profile.root });
    const restarted = new VaultProfiles(h.options);
    expect(await restarted.policyFor('w-two')).toEqual({ profileId: profile.id, revision: catalog.revision, policy: profile.automaticLearning });
    expect(await restarted.resolve('w-two', { purpose: 'learning' })).toEqual(learning);
    const renamed = await h.save({ id: profile.id, name: 'Renamed', minutesEnabled: false });
    expect(renamed.profiles.find(item => item.id === profile.id)?.automaticLearning).toEqual(profile.automaticLearning);
    await h.save({ id: profile.id, automaticLearning: { enabled: false, skills: true, notes: true } });
    expect((await restarted.policyFor('w-one')).policy).toEqual({ enabled: false, skills: false, notes: false });
    await expect(restarted.resolve('w-one', { purpose: 'learning' })).rejects.toThrow(/not enabled/);
  });

  it('reads skills-only policy without creating or accessing a notes vault', async () => {
    const h = await setup();
    const catalog = await h.save({ minutesEnabled: false, automaticLearning: { enabled: true, skills: true, notes: false } });
    const profile = catalog.profiles.find(item => item.kind === 'managed')!;
    const restarted = new VaultProfiles(h.options);
    expect((await restarted.policyFor('w-one')).policy).toEqual({ enabled: true, skills: true, notes: false });
    await expect(lstat(profile.root)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(restarted.resolve('w-one', { purpose: 'learning', ensure: true })).rejects.toThrow(/not enabled/);
    await expect(lstat(profile.root)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(restarted.policyFor('missing-workspace')).rejects.toThrow(/no longer exists/);
    await expect(restarted.resolve('w-one', { purpose: 'unknown' as 'learning' })).rejects.toThrow(/supported vault purpose/);
  });

  it('requires separate exact-root learning consent when the indexed vault changes, including old-client saves', async () => {
    const h = await setup();
    const first = path.join(h.root, 'first-vault'), second = path.join(h.root, 'second-vault');
    await mkdir(first); await mkdir(second);
    h.setDefault(first);
    await h.save({ id: 'default', name: 'Default', minutesEnabled: true });
    expect((await h.profiles.policyFor('w-one')).policy.notes).toBe(false);
    await expect(h.profiles.resolve('w-one', { purpose: 'learning' })).rejects.toThrow(/not enabled/);
    const automaticLearning = { enabled: true, skills: true, notes: true };
    await h.save({ id: 'default', name: 'Default', automaticLearning });
    expect((await h.profiles.resolve('w-one', { purpose: 'learning' })).root).toBe(first);
    h.setDefault(second);
    expect((await h.profiles.policyFor('w-one')).policy).toEqual({ ...automaticLearning, notes: false });
    await h.save({ id: 'default', name: 'Default', minutesEnabled: true });
    await expect(h.profiles.resolve('w-one', { purpose: 'learning' })).rejects.toThrow(/not enabled/);
    expect((await h.profiles.resolve('w-one')).root).toBe(second);
    await h.save({ id: 'default', name: 'Default', automaticLearning });
    expect((await h.profiles.resolve('w-one', { purpose: 'learning' })).root).toBe(second);
  });

  it('does not carry learning consent to a replacement custom root or a retargeted symbolic link', async () => {
    const h = await setup();
    const first = path.join(h.root, 'first-vault'), second = path.join(h.root, 'second-vault');
    await mkdir(first); await mkdir(second);
    const automaticLearning = { enabled: true, skills: true, notes: true };
    const catalog = await h.save({ vaultRoot: first, automaticLearning });
    const profile = catalog.profiles.find(item => item.kind === 'custom')!;
    await h.save({ id: profile.id, vaultRoot: second });
    expect((await h.profiles.policyFor('w-one')).policy.notes).toBe(false);
    await expect(h.profiles.resolve('w-one', { purpose: 'learning' })).rejects.toThrow(/not enabled/);
    await h.save({ id: profile.id, vaultRoot: second, automaticLearning });
    await rename(second, path.join(h.root, 'old-second-vault'));
    await symlink(first, second);
    expect((await h.profiles.policyFor('w-one')).policy.notes).toBe(false);
    await expect(h.profiles.resolve('w-one', { purpose: 'learning', ensure: true })).rejects.toThrow(/not enabled/);
  });

  it('rejects malformed stored learning policy and detects policy changes during resolution', async () => {
    const h = await setup();
    const catalog = await h.save({ automaticLearning: { enabled: true, skills: true, notes: true } });
    const invalid = new VaultProfiles({ ...h.options, read: () => ({ ...h.read(), profiles: { profiles: h.read().profiles!.profiles.map(item => ({ ...item,
      automaticLearning: { enabled: true, skills: 'yes', notes: true } as unknown as NonNullable<typeof item.automaticLearning> })) } }) });
    await expect(invalid.list()).rejects.toThrow(/learning policy is invalid/);
    const invalidId = new VaultProfiles({ ...h.options, read: () => ({ ...h.read(),
      profiles: { profiles: h.read().profiles!.profiles.map(item => ({ ...item, id: 'invalid-profile' })) },
      workspaces: h.read().workspaces.map(item => ({ ...item, profileId: 'invalid-profile' })) }) });
    await expect(invalidId.policyFor('w-one')).rejects.toThrow(/invalid id/);
    let reads = 0;
    const changed = new VaultProfiles({ ...h.options, read: () => {
      const snapshot = structuredClone(h.read());
      if (++reads > 1) snapshot.profiles!.profiles[0]!.automaticLearning = { enabled: false, skills: false, notes: false };
      return snapshot;
    } });
    await expect(changed.policyFor('w-one')).rejects.toThrow(/changed/);
    reads = 0;
    await expect(changed.resolve('w-one', { purpose: 'learning' })).rejects.toThrow(/changed/);
    expect((await h.profiles.list()).revision).toBe(catalog.revision);
  });

  it('exposes grouping on the host without switching Knowledge and preserves profile binding during workspace edits', async () => {
    const h = await setup();
    const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: h.data, homeDirectory: h.home, importHome: h.home,
      env: { EXTALIA_SECRET_STORE: 'memory', PATH: '', EXTALIA_NATIVE_CORE: 'typescript' }, observationIntervalMs: 60_000 });
    try {
      const host = runtime.host;
      const connected = await host.saveConnection({ name: 'Mock', preset: 'custom', api: 'openai-chat', baseUrl: 'http://mock.test/v1', model: 'mock-model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } });
      const connectionId = connected.connections[0]!.id;
      const created = await host.saveWorkspace({ name: 'Project', projectLocation: h.root, connectionId, permissions: { fileWrite: 'ask', commands: 'ask' } });
      const project = created.workspaces[0]!;
      const before = await host.knowledgeSettings!();
      const catalog = await host.listVaultProfiles!();
      const saved = await host.saveVaultProfile!({ name: 'Shared', vaultRoot: null, workspaceIds: [project.id], expectedRevision: catalog.revision, minutesEnabled: true });
      const id = saved.profiles.find(profile => profile.kind === 'managed')!.id;
      expect((await host.getState()).workspaces[0]?.profileId).toBe(id);
      await host.saveWorkspace({ id: project.id, name: 'Renamed', projectLocation: h.root, connectionId, permissions: { fileWrite: 'ask', commands: 'ask' } });
      expect((await host.getState()).workspaces[0]?.profileId).toBe(id);
      expect(await host.knowledgeSettings!()).toEqual(before);
    } finally { await runtime.close(); }
  });
});
