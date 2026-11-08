import { link, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from '@extalia/core';
import { describe, expect, it } from 'vitest';
import { guardMemberTools, memberEditRefusal } from '@extalia/runtime';
import { createFileTools } from '../src/tools/files.js';
import { createWorkspaceAccess } from '../src/workspaceAccess.js';
import { WorkspacePathError } from '../src/workspaceFs.js';
import { runTool, useTempDirs } from './helpers.js';

const temporary = useTempDirs();
function workspace(id: string, projectLocation: string, crossWorkspaceAccess?: Workspace['crossWorkspaceAccess']): Workspace {
  return { id, projectLocation, profileId: 'profile', name: id, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...(crossWorkspaceAccess ? { crossWorkspaceAccess } : {}) };
}
async function fixture() {
  const root = await realpath(await temporary());
  const nested = path.join(root, 'nested-private');
  const deep = path.join(root, 'src', 'deep-private');
  const foreign = await realpath(await temporary());
  await Promise.all([nested, deep].map(folder => mkdir(folder, { recursive: true })));
  await Promise.all([
    writeFile(path.join(root, 'public.txt'), 'public needle'),
    writeFile(path.join(nested, 'secret-name.txt'), 'private needle'),
    writeFile(path.join(deep, 'deep-name.txt'), 'deep needle'),
    writeFile(path.join(foreign, 'foreign.txt'), 'foreign needle'),
  ]);
  const workspaces = [workspace('own', root), workspace('private', nested, 'isolated'), workspace('deep', deep, 'isolated'), workspace('foreign', foreign)];
  return { root, nested, deep, foreign, workspaces };
}

describe('authority-backed file tools', () => {
  it('prunes isolated directories and their names from recursive lists and search', async () => {
    const { root, workspaces } = await fixture();
    const authority = await createWorkspaceAccess({ workspaceId: 'own', workspaces });
    const tools = createFileTools(root, { authority });
    const listing = await runTool(tools, 'list_files', { depth: 6 });
    expect(listing.ok).toBe(true);
    expect(listing.output).toContain('public.txt');
    expect(listing.output).not.toMatch(/nested-private|deep-private|secret-name|deep-name/);
    const search = await runTool(tools, 'search_files', { pattern: 'needle' });
    expect(search.ok).toBe(true);
    expect(search.output).toContain('public.txt:1: public needle');
    expect(search.output).not.toMatch(/nested-private|deep-private|private needle|deep needle/);
  });

  it('refuses direct access to isolated roots, including aliases and new descendants', async () => {
    const { root, nested, workspaces } = await fixture();
    await symlink(nested, path.join(root, 'alias-private'));
    const tools = createFileTools(root, { authority: await createWorkspaceAccess({ workspaceId: 'own', workspaces }) });
    for (const tool of ['list_files', 'read_file', 'search_files', 'write_file', 'edit_file']) {
      const result = await runTool(tools, tool, {
        path: tool === 'list_files' || tool === 'search_files' ? 'alias-private' : 'alias-private/secret-name.txt',
        pattern: 'needle', content: 'changed', old_text: 'private', new_text: 'changed',
      });
      expect(result).toMatchObject({ ok: false, output: expect.stringContaining('access policy') });
    }
    expect(await runTool(tools, 'write_file', { path: 'nested-private/new/created.txt', content: 'changed' })).toMatchObject({ ok: false });
    expect((await runTool(tools, 'list_files', { depth: 6 })).output).not.toContain('alias-private');
  });

  it('allows foreign reads with the default policy and refuses both write tools', async () => {
    const { root, foreign, workspaces } = await fixture();
    const tools = createFileTools(root, { authority: await createWorkspaceAccess({ workspaceId: 'own', workspaces }) });
    const file = path.join(foreign, 'foreign.txt');
    expect(await runTool(tools, 'read_file', { path: file })).toMatchObject({ ok: true, output: expect.stringContaining('foreign needle') });
    expect(await runTool(tools, 'search_files', { path: foreign, pattern: 'needle' })).toMatchObject({ ok: true, output: expect.stringContaining('foreign needle') });
    expect(await runTool(tools, 'write_file', { path: file, content: 'changed' })).toMatchObject({ ok: false, output: expect.stringContaining('access policy') });
    expect(await runTool(tools, 'edit_file', { path: file, old_text: 'foreign', new_text: 'changed' })).toMatchObject({ ok: false, output: expect.stringContaining('access policy') });
    expect(await readFile(file, 'utf8')).toBe('foreign needle');
  });

  it('permits writes only when both workspaces choose read-write', async () => {
    const { root, foreign, workspaces } = await fixture();
    workspaces[0]!.crossWorkspaceAccess = 'read-write';
    workspaces[3]!.crossWorkspaceAccess = 'read-write';
    const tools = createFileTools(root, { authority: await createWorkspaceAccess({ workspaceId: 'own', workspaces }) });
    const file = path.join(foreign, 'new/deep.txt');
    expect(await runTool(tools, 'write_file', { path: file, content: 'first' })).toMatchObject({ ok: true });
    expect(await runTool(tools, 'edit_file', { path: file, old_text: 'first', new_text: 'second' })).toMatchObject({ ok: true });
    expect(await readFile(file, 'utf8')).toBe('second');
  });

  it('refuses hard-link reads, searches and writes without modifying the linked source', async () => {
    const { root, nested, workspaces } = await fixture();
    const source = path.join(nested, 'secret-name.txt');
    await link(source, path.join(root, 'hard-alias.txt'));
    const tools = createFileTools(root, { authority: await createWorkspaceAccess({ workspaceId: 'own', workspaces }) });
    for (const tool of ['read_file', 'search_files', 'write_file', 'edit_file']) {
      expect(await runTool(tools, tool, { path: 'hard-alias.txt', pattern: 'needle', content: 'changed', old_text: 'private', new_text: 'changed' })).toMatchObject({ ok: false, output: expect.stringContaining('hard-linked') });
    }
    expect((await runTool(tools, 'list_files', { depth: 6 })).output).not.toContain('hard-alias.txt');
    expect((await runTool(tools, 'search_files', { pattern: 'needle' })).output).not.toContain('private needle');
    expect(await readFile(source, 'utf8')).toBe('private needle');
  });

  it('keeps credential and git restrictions with authority, including symlink targets', async () => {
    const { root, workspaces } = await fixture();
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, '.env'), 'credential needle');
    await symlink(path.join(root, '.env'), path.join(root, 'credential-alias'));
    const tools = createFileTools(root, { authority: await createWorkspaceAccess({ workspaceId: 'own', workspaces }) });
    expect(await runTool(tools, 'read_file', { path: 'credential-alias' })).toMatchObject({ ok: false, output: expect.stringContaining('credential') });
    expect(await runTool(tools, 'write_file', { path: '.git/config', content: '' })).toMatchObject({ ok: false, output: expect.stringContaining('inside .git') });
    expect((await runTool(tools, 'list_files', { depth: 6 })).output).not.toMatch(/\.env|credential-alias/);
    expect((await runTool(tools, 'search_files', { pattern: 'needle' })).output).not.toContain('credential needle');
  });
});

it('hides protected host data names and contents even under a selected ancestor', async () => {
  const root = await realpath(await temporary());
  const profile = path.join(root, 'app-private');
  await mkdir(profile);
  await writeFile(path.join(profile, 'record.txt'), 'private needle');
  await writeFile(path.join(root, 'public.txt'), 'public needle');
  await symlink(profile, path.join(root, 'private-alias'));
  const authority = await createWorkspaceAccess({ workspaceId: 'own', workspaces: [workspace('own', root)], protectedRoots: [profile] });
  const tools = createFileTools(root, { authority });
  expect((await runTool(tools, 'list_files', { depth: 6 })).output).not.toMatch(/app-private|private-alias|record.txt/);
  expect((await runTool(tools, 'search_files', { pattern: 'needle' })).output).not.toContain('private needle');
  expect(await runTool(tools, 'read_file', { path: 'app-private/record.txt' })).toMatchObject({ ok: false, output: expect.stringContaining('protected host data') });
});

it('enforces lexical and canonical team scopes for aliases and foreign read-write folders', async () => {
  const { root, foreign, workspaces } = await fixture();
  workspaces[0]!.crossWorkspaceAccess = 'read-write';
  workspaces[3]!.crossWorkspaceAccess = 'read-write';
  const allowed = path.join(root, 'src', 'allowed');
  const forbidden = path.join(root, 'src', 'forbidden');
  await Promise.all([mkdir(allowed), mkdir(forbidden)]);
  await Promise.all([
    writeFile(path.join(allowed, 'target.txt'), 'original'),
    writeFile(path.join(forbidden, 'target.txt'), 'original'),
  ]);
  await Promise.all([
    symlink(allowed, path.join(root, 'src', 'valid-alias')),
    symlink(forbidden, path.join(allowed, 'forbidden-alias')),
    symlink(foreign, path.join(allowed, 'foreign-alias')),
  ]);
  const member = { name: 'Writer', access: 'write' as const, scope: ['src'], forbidden: ['src/forbidden'] };
  const baseAuthority = await createWorkspaceAccess({ workspaceId: 'own', workspaces });
  // The host's per-member callback wraps canonical resolution, while runtime
  // guardMemberTools checks the original spelling before it runs the tool.
  const authority = {
    canRead: (absolute: string) => baseAuthority.canRead(absolute),
    async resolve(requested: string, purpose: 'read' | 'write') {
      const resolved = await baseAuthority.resolve(requested, purpose);
      const refusal = purpose === 'write' ? memberEditRefusal(member, resolved.relative) : undefined;
      if (refusal) throw new WorkspacePathError(refusal);
      return resolved;
    },
  };
  const tools = guardMemberTools(createFileTools(root, { authority }), member);
  expect(await runTool(tools, 'write_file', { path: 'src/allowed/forbidden-alias/target.txt', content: 'changed' })).toMatchObject({ ok: false, output: expect.stringContaining('forbidden') });
  expect(await runTool(tools, 'edit_file', { path: 'src/allowed/foreign-alias/foreign.txt', old_text: 'foreign', new_text: 'changed' })).toMatchObject({ ok: false, output: expect.stringContaining('absolute path') });
  expect(await runTool(tools, 'write_file', { path: 'src/valid-alias/target.txt', content: 'changed' })).toMatchObject({ ok: true });
  expect(await readFile(path.join(allowed, 'target.txt'), 'utf8')).toBe('changed');
  expect(await readFile(path.join(forbidden, 'target.txt'), 'utf8')).toBe('original');
  expect(await readFile(path.join(foreign, 'foreign.txt'), 'utf8')).toBe('foreign needle');
});
