import { link, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from '@extalia/core';
import { describe, expect, it } from 'vitest';
import { createWorkspaceAccess } from '../src/workspaceAccess.js';
import { useTempDirs } from './helpers.js';

const temporary = useTempDirs();
function workspace(id: string, projectLocation: string, crossWorkspaceAccess?: Workspace['crossWorkspaceAccess']): Workspace {
  return { id, projectLocation, profileId: 'profile', name: id, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...(crossWorkspaceAccess ? { crossWorkspaceAccess } : {}) };
}
async function fixture() {
  const base = await realpath(await temporary());
  const own = path.join(base, 'own');
  const foreign = path.join(base, 'foreign');
  const additional = path.join(base, 'additional');
  await Promise.all([own, foreign, additional].map(folder => mkdir(folder)));
  await writeFile(path.join(foreign, 'source.txt'), 'foreign content');
  return { base, own, foreign, additional };
}

describe('workspace file authority', () => {
  it('permits own primary/additional folders and defaults foreign folders to read-only', async () => {
    const { base, own, foreign, additional } = await fixture();
    const authority = await createWorkspaceAccess({ workspaceId: 'own', workspaces: [{ ...workspace('own', own), additionalProjectLocations: [additional] }, workspace('foreign', foreign)] });
    expect((await authority.resolve('new/deep.txt', 'write')).absolute).toBe(path.join(own, 'new/deep.txt'));
    expect((await authority.resolve(path.join(additional, 'new.txt'), 'write')).absolute).toBe(path.join(additional, 'new.txt'));
    expect((await authority.resolve('../foreign/source.txt', 'read')).absolute).toBe(path.join(foreign, 'source.txt'));
    await expect(authority.resolve('../foreign/new.txt', 'write')).rejects.toThrow('access policy');
    await expect(authority.resolve(path.join(base, 'unregistered'), 'read')).rejects.toThrow('outside the registered');
    expect(authority.folders()).toEqual([
      { workspaceId: 'own', path: own, primary: true, access: 'read-write' },
      { workspaceId: 'own', path: additional, primary: false, access: 'read-write' },
      { workspaceId: 'foreign', path: foreign, primary: true, access: 'read-only' },
    ]);
  });

  it.each(['isolated', 'read-only', 'read-write', undefined] as const)('combines both sides of the %s source policy', async source => {
    const { own, foreign } = await fixture();
    for (const destination of ['isolated', 'read-only', 'read-write', undefined] as const) {
      const authority = await createWorkspaceAccess({ workspaceId: 'own', workspaces: [workspace('own', own, source), workspace('foreign', foreign, destination)] });
      const requested = path.join(foreign, 'source.txt');
      expect(await authority.canRead(requested)).toBe(source !== 'isolated' && destination !== 'isolated');
      if (source === 'read-write' && destination === 'read-write') await expect(authority.resolve(requested, 'write')).resolves.toHaveProperty('absolute', requested);
      else await expect(authority.resolve(requested, 'write')).rejects.toThrow('access policy');
      // The other direction applies the same inbound restriction.
      const reverse = await createWorkspaceAccess({ workspaceId: 'foreign', workspaces: [workspace('own', own, source), workspace('foreign', foreign, destination)] });
      expect(await reverse.canRead(own)).toBe(source !== 'isolated' && destination !== 'isolated');
    }
  });

  it('enforces every nested workspace boundary and fails closed for shared isolated roots', async () => {
    const { own } = await fixture();
    const nested = path.join(own, 'private');
    await mkdir(nested);
    const authority = await createWorkspaceAccess({ workspaceId: 'own', workspaces: [workspace('own', own, 'read-write'), workspace('nested', nested, 'isolated')] });
    expect(await authority.canRead(own)).toBe(true);
    expect(await authority.canRead(nested)).toBe(false);
    expect(authority.folders()).not.toContainEqual(expect.objectContaining({ workspaceId: 'nested' }));
    const readonly = await createWorkspaceAccess({ workspaceId: 'own', workspaces: [workspace('own', own, 'read-write'), workspace('nested', nested, 'read-only')] });
    expect(await readonly.canRead(nested)).toBe(true);
    await expect(readonly.resolve(path.join(nested, 'new/file.txt'), 'write')).rejects.toThrow('access policy');
    const shared = await createWorkspaceAccess({ workspaceId: 'own', workspaces: [workspace('own', own), workspace('nested', own, 'isolated')] });
    expect(await shared.canRead(own)).toBe(false);
    expect(shared.folders()).toEqual([]);
  });

  it('checks lexical and canonical membership, including credential aliases and broken links', async () => {
    const { base, own, foreign } = await fixture();
    const outside = path.join(base, 'outside');
    await mkdir(outside);
    await writeFile(path.join(own, '.env'), 'credential');
    await symlink(outside, path.join(own, 'escape'));
    await symlink(own, path.join(outside, 'unregistered-alias'));
    await symlink(path.join(own, '.env'), path.join(own, 'credential-alias'));
    await symlink(path.join(base, 'absent'), path.join(own, 'broken'));
    await symlink(foreign, path.join(own, 'foreign-alias'));
    const authority = await createWorkspaceAccess({ workspaceId: 'own', workspaces: [workspace('own', own), workspace('foreign', foreign)] });
    await expect(authority.resolve('escape/new.txt', 'write')).rejects.toThrow('outside the registered');
    await expect(authority.resolve(path.join(outside, 'unregistered-alias/new.txt'), 'read')).rejects.toThrow('outside the registered');
    await expect(authority.resolve('credential-alias', 'read')).rejects.toThrow('credential file');
    await expect(authority.resolve('broken/child', 'write')).rejects.toThrow('broken symbolic link');
    expect((await authority.resolve('foreign-alias/source.txt', 'read')).absolute).toBe(path.join(foreign, 'source.txt'));
    await expect(authority.resolve('foreign-alias/new.txt', 'write')).rejects.toThrow('access policy');
    await expect(authority.resolve('.git/config', 'write')).rejects.toThrow('inside .git');
  });

  it('preserves lexical nested isolation even when a registered root is a symlink', async () => {
    const { own, foreign } = await fixture();
    const alias = path.join(own, 'nested-alias');
    await symlink(foreign, alias);
    const authority = await createWorkspaceAccess({ workspaceId: 'own', workspaces: [workspace('own', own, 'read-write'), workspace('private', alias, 'isolated')] });
    await expect(authority.resolve('nested-alias/source.txt', 'read')).rejects.toThrow('access policy');
    await expect(authority.resolve(path.join(foreign, 'source.txt'), 'read')).rejects.toThrow('access policy');
  });

  it('rejects hard links even when the alias is inside an owned folder', async () => {
    const { own, foreign } = await fixture();
    await link(path.join(foreign, 'source.txt'), path.join(own, 'alias.txt'));
    const authority = await createWorkspaceAccess({ workspaceId: 'own', workspaces: [workspace('own', own), workspace('foreign', foreign, 'isolated')] });
    await expect(authority.resolve('alias.txt', 'read')).rejects.toThrow('hard-linked');
    await expect(authority.resolve('alias.txt', 'write')).rejects.toThrow('hard-linked');
    expect(await readFile(path.join(foreign, 'source.txt'), 'utf8')).toBe('foreign content');
  });

  it('replaces owned folders for scoped worktrees while retaining foreign nested restrictions', async () => {
    const { own, foreign, additional } = await fixture();
    const nested = path.join(additional, 'private');
    await mkdir(nested);
    const authority = await createWorkspaceAccess({ workspaceId: 'own', workspaces: [workspace('own', own), workspace('foreign', foreign), workspace('nested', nested, 'isolated')], ownedRoots: [additional] });
    expect((await authority.resolve('new.txt', 'write')).absolute).toBe(path.join(additional, 'new.txt'));
    expect(await authority.canRead(own)).toBe(false);
    expect(await authority.canRead(nested)).toBe(false);
    expect(authority.folders()).toContainEqual({ workspaceId: 'own', path: additional, primary: true, access: 'read-write' });
  });

  it('captures policy immutably and rejects unavailable or excessive registered roots', async () => {
    const { own, foreign, base } = await fixture();
    const workspaces = [workspace('own', own), workspace('foreign', foreign, 'isolated')];
    const authority = await createWorkspaceAccess({ workspaceId: 'own', workspaces });
    workspaces[1]!.crossWorkspaceAccess = 'read-write';
    expect(await authority.canRead(foreign)).toBe(false);
    await expect(createWorkspaceAccess({ workspaceId: 'own', workspaces: [workspace('own', own), workspace('foreign', path.join(base, 'missing'))] })).rejects.toThrow('not available');
    await expect(createWorkspaceAccess({ workspaceId: 'own', workspaces: [{ ...workspace('own', own), additionalProjectLocations: Array.from({ length: 16 }, () => foreign) }] })).rejects.toThrow('at most 16');
  });
});

describe('protected host data', () => {
  it('denies host data under a selected ancestor and hides a directly selected protected folder', async () => {
    const { own } = await fixture();
    const profile = path.join(own, 'app-data');
    const library = path.join(profile, 'library');
    await mkdir(library, { recursive: true });
    await writeFile(path.join(library, 'record.txt'), 'private record');
    await symlink(profile, path.join(own, 'data-alias'));
    const authority = await createWorkspaceAccess({ workspaceId: 'own', workspaces: [workspace('own', own)], protectedRoots: [profile] });
    expect(await authority.canRead(own)).toBe(true);
    expect(await authority.canRead(library)).toBe(false);
    await expect(authority.resolve('data-alias/library/record.txt', 'read')).rejects.toThrow('protected host data');
    await expect(authority.resolve('app-data/new.txt', 'write')).rejects.toThrow('protected host data');
    const selected = await createWorkspaceAccess({ workspaceId: 'own', workspaces: [workspace('own', profile)], protectedRoots: [profile] });
    expect(selected.folders()).toEqual([]);
    expect(await selected.canRead(profile)).toBe(false);
    const selectedChild = await createWorkspaceAccess({ workspaceId: 'own', workspaces: [workspace('own', library)], protectedRoots: [profile] });
    expect(selectedChild.folders()).toEqual([]);
    expect(await selectedChild.canRead(library)).toBe(false);
  });

  it('permits only an explicit run-owned worktree subtree inside protected data', async () => {
    const { own } = await fixture();
    const profile = path.join(own, 'app-data');
    const worktree = path.join(profile, 'worktrees', 'run-owned');
    const other = path.join(profile, 'other');
    await Promise.all([mkdir(worktree, { recursive: true }), mkdir(other, { recursive: true })]);
    await writeFile(path.join(other, 'record.txt'), 'private record');
    await symlink(other, path.join(worktree, 'escape'));
    const workspaces = [workspace('own', own)];
    const authority = await createWorkspaceAccess({ workspaceId: 'own', workspaces, ownedRoots: [worktree], protectedRoots: [profile] });
    expect((await authority.resolve('new.txt', 'write')).absolute).toBe(path.join(worktree, 'new.txt'));
    expect(await authority.canRead(worktree)).toBe(true);
    await expect(authority.resolve('escape/record.txt', 'read')).rejects.toThrow();
    expect(await authority.canRead(profile)).toBe(false);
    expect(await authority.canRead(other)).toBe(false);
    expect(authority.folders()).toEqual([{ workspaceId: 'own', path: worktree, primary: true, access: 'read-write' }]);
    const broad = await createWorkspaceAccess({ workspaceId: 'own', workspaces, ownedRoots: [profile], protectedRoots: [profile] });
    expect(await broad.canRead(profile)).toBe(false);
    expect(broad.folders()).toEqual([]);
  });
});

it('pins every worktree write to owned roots even when both workspaces permit cross-writes', async () => {
  const { own, foreign, additional } = await fixture();
  await symlink(foreign, path.join(additional, 'foreign-alias'));
  const authority = await createWorkspaceAccess({
    workspaceId: 'own', ownedRoots: [additional],
    workspaces: [workspace('own', own, 'read-write'), workspace('foreign', foreign, 'read-write')],
  });
  expect((await authority.resolve('new.txt', 'write')).absolute).toBe(path.join(additional, 'new.txt'));
  expect((await authority.resolve(path.join(foreign, 'source.txt'), 'read')).absolute).toBe(path.join(foreign, 'source.txt'));
  await expect(authority.resolve(path.join(foreign, 'source.txt'), 'write')).rejects.toThrow('run-owned');
  await expect(authority.resolve('foreign-alias/source.txt', 'write')).rejects.toThrow('run-owned');
});
