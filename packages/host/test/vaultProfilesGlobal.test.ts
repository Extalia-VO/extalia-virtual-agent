import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from '@extalia/core';
import { GLOBAL_OBSERVE_WORKSPACE_ID } from '@extalia/platform';
import { describe, expect, it, vi } from 'vitest';
import { VaultProfiles, type StoredVaultProfiles } from '../src/vaultProfiles.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
async function fixture() {
  const root = await realpath(await temp('extalia-global-vault-')), data = path.join(root, 'data'), home = path.join(root, 'home');
  await mkdir(data); await mkdir(home);
  const snapshot: { profiles?: StoredVaultProfiles; workspaces: Workspace[]; defaultProfile: { id: string; name: string }; defaultRoot: string } = {
    workspaces: [], defaultProfile: { id: 'default', name: 'Default' }, defaultRoot: path.join(data, 'vaults', 'default'),
  };
  const ensure = vi.fn(async () => { throw new Error('This fixture does not create managed vaults.'); });
  const profiles = new VaultProfiles({ dataDirectory: data, homeDirectory: home, read: () => snapshot, busy: () => false,
    ensureManagedRoot: ensure,
    commit: async (stored, workspaces) => { snapshot.profiles = stored; snapshot.workspaces = workspaces; },
  });
  const save = async (policy: { enabled: boolean; skills: boolean; notes: boolean; observed?: boolean }) => profiles.save({
    id: 'default', name: 'Default', vaultRoot: null, workspaceIds: [], minutesEnabled: false,
    automaticLearning: policy, expectedRevision: (await profiles.list()).revision,
  });
  return { root, data, home, snapshot, profiles, ensure, save };
}

describe.skipIf(process.platform === 'win32')('default vault APIs for unbound Observe', () => {
  it('resolves default policy and note root without requiring or creating a workspace', async () => {
    const f = await fixture();
    expect((await f.profiles.policyFor()).policy.observed).toBeUndefined();
    await f.save({ enabled: true, skills: true, notes: true, observed: true });
    const policy = await f.profiles.policyFor(undefined);
    expect(policy).toMatchObject({ profileId: 'default', policy: { enabled: true, skills: true, notes: true, observed: true } });
    expect(await f.profiles.resolve(undefined, { purpose: 'learning' })).toEqual({ root: f.snapshot.defaultRoot, profileId: 'default', revision: policy.revision });
    expect(await f.profiles.knowledgeTarget(undefined)).toMatchObject({ root: f.snapshot.defaultRoot, profileId: 'default', custom: false });
    expect(f.ensure).not.toHaveBeenCalled();
    expect(f.snapshot.workspaces).toEqual([]);
  });

  it('preserves explicit global opt-out and refuses note writes while leaving read-only target resolution available', async () => {
    const f = await fixture();
    await f.save({ enabled: false, skills: true, notes: true, observed: true });
    expect((await f.profiles.policyFor()).policy).toEqual({ enabled: false, skills: false, notes: false, observed: false });
    await expect(f.profiles.resolve(undefined, { purpose: 'learning', ensure: true })).rejects.toThrow(/not enabled/);
    expect(await f.profiles.knowledgeTarget()).toMatchObject({ profileId: 'default' });
    expect(f.ensure).not.toHaveBeenCalled();
  });

  it.each(['missing-workspace', '', GLOBAL_OBSERVE_WORKSPACE_ID])('refuses unknown workspace %j rather than treating it as default', async workspaceId => {
    const f = await fixture();
    await expect(f.profiles.policyFor(workspaceId)).rejects.toThrow(/no longer exists/);
    await expect(f.profiles.resolve(workspaceId, { purpose: 'learning', ensure: true })).rejects.toThrow(/no longer exists/);
    await expect(f.profiles.knowledgeTarget(workspaceId)).rejects.toThrow(/no longer exists/);
    expect(f.ensure).not.toHaveBeenCalled();
  });

  it('keeps global external-vault consent bound to the exact root', async () => {
    const f = await fixture(), first = path.join(f.root, 'first-vault'), second = path.join(f.root, 'second-vault');
    await mkdir(first); await mkdir(second); await writeFile(path.join(first, 'Keep.md'), '# Existing knowledge');
    f.snapshot.defaultRoot = first;
    expect((await f.profiles.policyFor()).policy).toEqual({ enabled: false, skills: false, notes: false });
    await expect(f.profiles.resolve(undefined, { purpose: 'learning' })).rejects.toThrow(/not enabled/);
    await f.save({ enabled: true, skills: false, notes: true, observed: true });
    expect(await f.profiles.resolve(undefined, { purpose: 'learning' })).toMatchObject({ root: first, profileId: 'default' });
    f.snapshot.defaultRoot = second;
    expect((await f.profiles.policyFor()).policy.notes).toBe(false);
    await expect(f.profiles.resolve(undefined, { purpose: 'learning' })).rejects.toThrow(/not enabled/);
    expect(await readFile(path.join(first, 'Keep.md'), 'utf8')).toBe('# Existing knowledge');
    expect(f.ensure).not.toHaveBeenCalled();
  });
});
