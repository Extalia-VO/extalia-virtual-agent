import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { gitEnvironment } from '../src/inspect.js';
import { GitRunner, WorktreeManager } from '../src/worktrees/index.js';
import { useTempDirs } from './helpers.js';

const tempDir = useTempDirs();
const hasGit = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();
const owner = { missionId: '00000000-0000-4000-8000-000000000001', taskId: '00000000-0000-4000-8000-000000000002' };

async function fixture() {
  const root = await tempDir('extalia-git-safety-');
  const home = path.join(root, 'home'), project = path.join(root, 'project'), data = path.join(root, 'data');
  await mkdir(home); await mkdir(project);
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: project, env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  await writeFile(path.join(project, 'file.txt'), 'base content\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const manager = await WorktreeManager.open({ directory: path.join(data, 'worktrees'), registryFile: path.join(data, 'worktrees.json'), git: { env } });
  return { root, home, project, data, env, git, manager };
}

describe.skipIf(!hasGit)('write-capable Git preflight', { timeout: 60_000 }, () => {
  it.each(['extensions.partialClone', 'remote.origin.promisor', 'remote.origin.partialCloneFilter'])('refuses %s before object resolution or checkout', async key => {
    const f = await fixture();
    f.git('config', key, key.endsWith('promisor') ? 'true' : key.endsWith('Filter') ? 'blob:none' : 'origin');
    const run = vi.spyOn(f.manager.git, 'run');
    await expect(f.manager.create({ workspaceRoot: f.project, owner })).rejects.toMatchObject({ code: 'unsupported', message: expect.stringContaining('partial-clone or promisor') });
    expect(run).not.toHaveBeenCalled();
    expect(f.manager.list()).toEqual([]);
    expect(f.git('branch', '--list', 'extalia/worker/*')).toBe('');
  });

  it('checks included configuration rather than relying only on the main local config', async () => {
    const f = await fixture();
    const included = path.join(f.root, 'included.gitconfig');
    await writeFile(included, '[remote "origin"]\n\tpromisor = true\n');
    f.git('config', 'include.path', included);
    await expect(f.manager.create({ workspaceRoot: f.project, owner })).rejects.toMatchObject({ code: 'unsupported' });
  });

  it.skipIf(process.platform === 'win32')('never launches a local remote helper for a missing promised object', async () => {
    const f = await fixture();
    const blob = f.git('rev-parse', 'HEAD:file.txt');
    const bin = path.join(f.root, 'bin'), marker = path.join(f.root, 'helper-started');
    await mkdir(bin);
    const helper = path.join(bin, 'git-remote-sentinel');
    const quotedMarker = `'${marker.replace(/'/g, "'\\''")}'`;
    await writeFile(helper, `#!/bin/sh\n: > ${quotedMarker}\nexit 1\n`);
    await chmod(helper, 0o700);
    f.git('config', 'remote.origin.url', 'sentinel::local-fixture');
    f.git('config', 'remote.origin.promisor', 'true');
    f.git('config', 'remote.origin.partialclonefilter', 'blob:none');
    await rm(path.join(f.project, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    const env = { ...f.env, PATH: `${bin}${path.delimiter}${f.env.PATH ?? ''}`, GIT_NO_LAZY_FETCH: '0' };
    const runner = new GitRunner({ env });
    await expect(runner.text(f.project, ['cat-file', '-p', blob])).rejects.toMatchObject({ code: 'unsupported' });
    const manager = await WorktreeManager.open({ directory: path.join(f.data, 'guarded-worktrees'), registryFile: path.join(f.data, 'guarded.json'), git: { env } });
    await expect(manager.create({ workspaceRoot: f.project, owner })).rejects.toMatchObject({ code: 'unsupported' });
    expect(existsSync(marker)).toBe(false);
    expect(manager.list()).toEqual([]);
  });

  it('rechecks configuration after creation before subsequent object operations', async () => {
    const f = await fixture();
    const worker = await f.manager.create({ workspaceRoot: f.project, owner });
    f.git('config', 'remote.origin.promisor', 'true');
    await expect(f.manager.status(worker.id)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('overrides signature verification and fixes lazy-fetch environment regardless of inherited overrides', async () => {
    const f = await fixture();
    f.git('config', 'merge.verifySignatures', 'true');
    f.git('config', 'gpg.program', 'unavailable-fixture-verifier');
    const runner = new GitRunner({ env: f.env });
    expect((await runner.text(f.project, ['config', '--get', 'merge.verifySignatures'])).trim()).toBe('false');
    expect(gitEnvironment({ ...f.env, GIT_NO_LAZY_FETCH: '0', GIT_CONFIG_COUNT: '99' })).toMatchObject({ GIT_NO_LAZY_FETCH: '1', GIT_CONFIG_NOSYSTEM: '1' });
    expect(gitEnvironment({ ...f.env, GIT_CONFIG_COUNT: '99' }).GIT_CONFIG_COUNT).toBeUndefined();
  });

  it('rejects core.worktree redirection before object reads or copying a foreign checkout', async () => {
    const f = await fixture(), other = await fixture();
    // A repository nested inside another checkout can redirect Git's reported root to its ancestor.
    const selected = path.join(other.project, 'selected');
    await rename(f.project, selected);
    execFileSync('git', ['-C', selected, 'config', 'core.worktree', other.project], { env: f.env });
    const before = await readFile(path.join(other.project, 'file.txt'), 'utf8');
    const foreignHead = other.git('rev-parse', 'HEAD');
    const foreignStatus = other.git('status', '--porcelain');
    const run = vi.spyOn(f.manager.git, 'run');
    await expect(f.manager.create({ workspaceRoot: selected, owner, requireExactRoot: true })).rejects.toMatchObject({ code: 'location' });
    expect(run.mock.calls.map(([, args]) => args[0])).toEqual(['rev-parse']);
    expect(f.manager.list()).toEqual([]);
    expect(await readdir(f.manager.directory)).toEqual([]);
    expect(await readFile(path.join(other.project, 'file.txt'), 'utf8')).toBe(before);
    expect(other.git('rev-parse', 'HEAD')).toBe(foreignHead);
    expect(other.git('status', '--porcelain')).toBe(foreignStatus);
  });

  it('rejects a foreign common directory before resolving a base object', async () => {
    const f = await fixture(), other = await fixture();
    await writeFile(path.join(f.project, '.git', 'commondir'), `${path.join(other.project, '.git')}\n`);
    const run = vi.spyOn(f.manager.git, 'run');
    await expect(f.manager.create({ workspaceRoot: f.project, owner, requireExactRoot: true })).rejects.toMatchObject({ code: 'location' });
    expect(run.mock.calls.map(([, args]) => args[0])).toEqual(['rev-parse']);
    expect(await readdir(f.manager.directory)).toEqual([]);
    expect(other.git('status', '--porcelain')).toBe('');
  });

  it('refuses alternate object stores when the exact-root boundary is required', async () => {
    const f = await fixture(), other = await fixture();
    await writeFile(path.join(f.project, '.git', 'objects', 'info', 'alternates'), `${path.join(other.project, '.git', 'objects')}\n`);
    const run = vi.spyOn(f.manager.git, 'run');
    await expect(f.manager.create({ workspaceRoot: f.project, owner, requireExactRoot: true })).rejects.toMatchObject({ code: 'unsupported' });
    expect(run.mock.calls.map(([, args]) => args[0])).toEqual(['rev-parse']);
    expect(await readdir(f.manager.directory)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('refuses a symlinked object directory under the exact-root boundary', async () => {
    const f = await fixture(), other = await fixture();
    await rm(path.join(f.project, '.git', 'objects'), { recursive: true });
    await symlink(path.join(other.project, '.git', 'objects'), path.join(f.project, '.git', 'objects'));
    await expect(f.manager.create({ workspaceRoot: f.project, owner, requireExactRoot: true })).rejects.toMatchObject({ code: 'unsupported' });
    expect(await readdir(f.manager.directory)).toEqual([]);
  });

  it('accepts an ordinary exact repository and keeps nested workspace support when the flag is omitted', async () => {
    const f = await fixture();
    await mkdir(path.join(f.project, 'nested'));
    await writeFile(path.join(f.project, 'nested', 'file.txt'), 'nested\n');
    f.git('add', '-A'); f.git('commit', '-q', '-m', 'nested folder');
    const exact = await f.manager.create({ workspaceRoot: f.project, owner, requireExactRoot: true });
    expect(exact.prefix).toBe('');
    await expect(f.manager.create({ workspaceRoot: path.join(f.project, 'nested'), owner, requireExactRoot: true })).rejects.toMatchObject({ code: 'location' });
    const legacy = await f.manager.create({ workspaceRoot: path.join(f.project, 'nested'), owner });
    expect(legacy.prefix).toBe('nested');
  });
});
