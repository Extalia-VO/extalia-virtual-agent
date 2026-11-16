import { execFile } from 'node:child_process';
import type * as childProcess from 'node:child_process';
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitDiff, gitRepositories, gitStatus, type GitOptions } from '../src/inspect.js';
import { createAgentHost } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const nodeFixtures = vi.hoisted(() => new Set<string>());
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof childProcess>();
  const { promisify: toPromise } = await import('node:util');
  const route = (file: string, args: unknown[]) => nodeFixtures.has(file)
    ? [process.execPath, [file, ...(args[0] as string[])], ...args.slice(1)] : [file, ...args];
  const routedExecFile = (file: string, ...args: unknown[]) => Reflect.apply(actual.execFile, undefined, route(file, args));
  const originalAsync = toPromise(actual.execFile);
  // Preserve execFile's stdout/stderr promise contract for the real Git setup.
  Object.defineProperty(routedExecFile, toPromise.custom, {
    value: (file: string, ...args: unknown[]) => Reflect.apply(originalAsync, undefined, route(file, args)),
  });
  return { ...actual, execFile: routedExecFile };
});
afterEach(() => { nodeFixtures.clear(); });

const run = promisify(execFile);
const temp = useTempDirs();
const hasGit = await run('git', ['--version']).then(() => true, () => false);
const windows = process.platform === 'win32';
let workspace: string, home: string, options: GitOptions;

async function git(directory: string, ...args: string[]) {
  return (await run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Example', '-c', 'user.email=dev@example.com', ...args],
    { cwd: directory, env: { ...options.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: windows ? 'NUL' : '/dev/null' } })).stdout;
}
async function makeRepo(relative: string, root = workspace) {
  const directory = path.join(root, relative); await mkdir(directory, { recursive: true });
  await git(directory, 'init', '-q', '-b', 'main');
  await writeFile(path.join(directory, 'README.md'), 'original\n');
  await git(directory, 'add', 'README.md'); await git(directory, 'commit', '-qm', 'initial');
  return directory;
}

beforeEach(async () => {
  workspace = await temp('extalia-git-workspace-'); home = await temp('extalia-git-home-');
  options = { env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home } };
});

describe.skipIf(!hasGit)('nested Git repository discovery and scoped reading', { timeout: 30_000 }, () => {
  it('discovers nested repositories in a non-Git workspace and selects their own status/diff', async () => {
    const frontend = await makeRepo('apps/frontend'); await makeRepo('services/backend');
    await writeFile(path.join(frontend, 'README.md'), 'frontend changed\n');
    await writeFile(path.join(workspace, 'outside.txt'), 'not in the selected repository\n');
    expect(await gitStatus(workspace, options)).toEqual({ repository: false });
    expect(await gitRepositories(workspace, options)).toEqual({ repositories: [{ path: 'apps/frontend' }, { path: 'services/backend' }], truncated: false });
    const status = await gitStatus(workspace, options, 'apps/frontend');
    expect(status.repository && status.changes.map(change => change.path)).toEqual(['README.md']);
    const diff = await gitDiff(workspace, 'README.md', options, 'apps/frontend');
    expect(diff.path).toBe('README.md'); expect(diff.diff).toContain('+frontend changed');
    expect(diff.diff).not.toContain('outside.txt');
    await expect(gitDiff(workspace, '../outside.txt', options, 'apps/frontend')).rejects.toThrow(/outside the workspace/);
  });

  it('includes both a root repository and nested repositories, sorted deterministically', async () => {
    await makeRepo(''); await makeRepo('zeta'); await makeRepo('alpha/nested');
    expect(await gitRepositories(workspace, options)).toEqual({ repositories: [{ path: '' }, { path: 'alpha/nested' }, { path: 'zeta' }], truncated: false });
  });

  it('preserves workspace scope when the workspace belongs to a larger parent repository', async () => {
    const outer = await temp('extalia-git-parent-'); await makeRepo('', outer);
    workspace = path.join(outer, 'projects', 'current'); await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, 'local.txt'), 'local\n');
    await git(outer, 'add', '.'); await git(outer, 'commit', '-qm', 'workspace');
    await writeFile(path.join(outer, 'README.md'), 'parent secret change\n');
    await writeFile(path.join(workspace, 'local.txt'), 'local changed\n');
    expect(await gitRepositories(workspace, options)).toEqual({ repositories: [{ path: '' }], truncated: false });
    const status = await gitStatus(workspace, options, '');
    expect(status.repository && status.changes.map(change => change.path)).toEqual(['local.txt']);
    const diff = await gitDiff(workspace, undefined, options, '');
    expect(diff.diff).toContain('+local changed'); expect(diff.diff).not.toContain('parent secret change');
  });

  it('rejects an ordinary selected subfolder instead of lifting its status/diff to the parent repository', async () => {
    await makeRepo(''); await mkdir(path.join(workspace, 'src'));
    await writeFile(path.join(workspace, 'src', 'local.txt'), 'not a separate repository\n');
    await expect(gitStatus(workspace, options, 'src')).rejects.toThrow(/no longer a Git repository/);
    await expect(gitDiff(workspace, undefined, options, 'src')).rejects.toThrow(/no longer a Git repository/);
    expect(await gitStatus(workspace, options, '')).toMatchObject({ repository: true });
  });

  it('rejects a previously discovered nested repository after its .git marker is removed', async () => {
    await makeRepo(''); const nested = await makeRepo('apps/frontend');
    expect((await gitRepositories(workspace, options)).repositories).toEqual([{ path: '' }, { path: 'apps/frontend' }]);
    await rm(path.join(nested, '.git'), { recursive: true, force: true });
    await expect(gitStatus(workspace, options, 'apps/frontend')).rejects.toThrow(/no longer a Git repository/);
    await expect(gitDiff(workspace, undefined, options, 'apps/frontend')).rejects.toThrow(/no longer a Git repository/);
  });

  it('rejects a nested marker whose configured work tree resolves to an ancestor', async () => {
    await makeRepo(''); const nested = await makeRepo('apps/frontend');
    await git(nested, 'config', 'core.worktree', workspace);
    expect(await gitRepositories(workspace, options)).toEqual({ repositories: [{ path: '' }], truncated: true });
    await expect(gitStatus(workspace, options, 'apps/frontend')).rejects.toThrow(/no longer a Git repository/);
    await expect(gitDiff(workspace, undefined, options, 'apps/frontend')).rejects.toThrow(/no longer a Git repository/);
  });

  it.skipIf(windows)('cannot discover an ancestor when a nested marker disappears just before a status/diff subprocess', async () => {
    await makeRepo(''); const binaries = await temp('extalia-git-race-');
    for (const command of ['status', 'diff'] as const) {
      const nested = await makeRepo('apps/frontend'); const binary = path.join(binaries, `${command}.mjs`);
      await writeFile(binary, `#!/usr/bin/env node\nimport { rmSync } from 'node:fs';\nimport { execFileSync } from 'node:child_process';\nconst args = process.argv.slice(2);\nif (args.includes(${JSON.stringify(command)})) rmSync(${JSON.stringify(path.join(nested, '.git'))}, { recursive: true, force: true });\ntry { process.stdout.write(execFileSync('git', args, { env: process.env, maxBuffer: 1048576 })); } catch (error) { process.stderr.write(error.stderr ?? ''); process.exit(error.status ?? 1); }\n`);
      await chmod(binary, 0o755);
      nodeFixtures.add(binary);
      const selected = { ...options, binary };
      const operation = command === 'status' ? gitStatus(workspace, selected, 'apps/frontend') : gitDiff(workspace, undefined, selected, 'apps/frontend');
      await expect(operation).rejects.toThrow(/Git could not read this repository/);
    }
  });

  it('recognizes regular .git files for linked worktrees', async () => {
    const parent = await temp('extalia-git-main-'); await makeRepo('', parent);
    await mkdir(path.join(workspace, 'apps')); const linked = path.join(workspace, 'apps', 'linked');
    await git(parent, 'worktree', 'add', '-q', '-b', 'linked', linked);
    expect((await readFile(path.join(linked, '.git'), 'utf8')).startsWith('gitdir: ')).toBe(true);
    expect(await gitRepositories(workspace, options)).toEqual({ repositories: [{ path: 'apps/linked' }], truncated: false });
    expect(await gitStatus(workspace, options, 'apps/linked')).toMatchObject({ repository: true, branch: 'linked' });
  });

  it('skips generated/internal directories and reports depth, directory and repository bounds', async () => {
    await makeRepo('node_modules/package'); await makeRepo('vendor/package'); await makeRepo('.cache/temporary'); await makeRepo('.extalia/internal');
    await makeRepo('a/one'); await makeRepo('b/two');
    expect(await gitRepositories(workspace, options)).toEqual({ repositories: [{ path: 'a/one' }, { path: 'b/two' }], truncated: false });
    expect(await gitRepositories(workspace, options, { depth: 1 })).toEqual({ repositories: [], truncated: true });
    expect(await gitRepositories(workspace, options, { directories: 2 })).toEqual({ repositories: [], truncated: true });
    expect(await gitRepositories(workspace, options, { repositories: 1 })).toEqual({ repositories: [{ path: 'a/one' }], truncated: true });
    expect((await gitRepositories(workspace, options, { timeMs: 1 })).truncated).toBe(true);
  });

  it.skipIf(windows)('never follows directory symlinks or accepts a selected escape or .git symlink', async () => {
    const outside = await temp('extalia-git-outside-'); await makeRepo('', outside);
    await makeRepo('inside'); await symlink(outside, path.join(workspace, 'escape'));
    await symlink(path.join(workspace, 'inside'), path.join(workspace, 'alias'));
    expect(await gitRepositories(workspace, options)).toEqual({ repositories: [{ path: 'inside' }], truncated: false });
    for (const selected of ['escape', '../outside', '/tmp/elsewhere', 'inside/.git']) {
      await expect(gitStatus(workspace, options, selected)).rejects.toThrow(/inside the workspace|outside the workspace/);
      await expect(gitDiff(workspace, undefined, options, selected)).rejects.toThrow(/inside the workspace|outside the workspace/);
    }
    await mkdir(path.join(workspace, 'fake')); await symlink(path.join(outside, '.git'), path.join(workspace, 'fake', '.git'));
    const listed = await gitRepositories(workspace, options);
    expect(listed.repositories).toEqual([{ path: 'inside' }]); expect(listed.truncated).toBe(true);
    await expect(gitStatus(workspace, options, 'fake')).rejects.toThrow(/symbolic link/);
  });

  it.skipIf(windows || process.getuid?.() === 0)('retains readable repositories while reporting an unreadable subtree as partial', async () => {
    await makeRepo('available'); const denied = path.join(workspace, 'unreadable'); await mkdir(denied);
    await chmod(denied, 0);
    try {
      expect(await gitRepositories(workspace, options)).toEqual({ repositories: [{ path: 'available' }], truncated: true });
    } finally { await chmod(denied, 0o700); }
  });

  it.skipIf(windows)('reuses hardened Git configuration for discovery and selected nested reads', async () => {
    const nested = await makeRepo('apps/frontend');
    await writeFile(path.join(nested, '.gitattributes'), '* filter=evil diff=evil\n');
    await git(nested, 'add', '.'); await git(nested, 'commit', '-qm', 'attributes');
    const markers = await temp('extalia-git-markers-'); const script = path.join(nested, 'evil.sh');
    await writeFile(script, `#!/bin/sh\ntouch "${path.join(markers, 'ran')}"\ncat\n`); await chmod(script, 0o755);
    for (const name of ['core.fsmonitor', 'filter.evil.clean', 'filter.evil.process', 'diff.evil.textconv', 'diff.external', 'core.pager']) await git(nested, 'config', name, script);
    await writeFile(path.join(nested, 'README.md'), 'safe nested diff\n');
    expect((await gitRepositories(workspace, options)).repositories).toEqual([{ path: 'apps/frontend' }]);
    expect(await gitStatus(workspace, options, 'apps/frontend')).toMatchObject({ repository: true });
    expect((await gitDiff(workspace, 'README.md', options, 'apps/frontend')).diff).toContain('+safe nested diff');
    expect(existsSync(path.join(markers, 'ran'))).toBe(false);
  });

  it('exposes discovery and nested selections through the host without changing the default root behavior', async () => {
    await makeRepo('apps/frontend'); const data = await temp('extalia-git-data-');
    const runtime = await createAgentHost({ kind: 'bridge', version: '0.0.0-test', dataDirectory: data, homeDirectory: home, importHome: home,
      env: { ...options.env, EXTALIA_SECRET_STORE: 'memory' } });
    try {
      const saved = await runtime.host.saveConnection({ name: 'Example', preset: 'custom', api: 'openai-chat', baseUrl: 'http://example.com/v1', model: 'example', credential: { kind: 'none' }, features: { memory: 'extalia', skills: 'extalia' } });
      const state = await runtime.host.saveWorkspace({ name: 'Example', projectLocation: workspace, connectionId: saved.connections[0]!.id, permissions: { fileWrite: 'ask', commands: 'ask' } });
      const id = state.workspaces[0]!.id;
      expect(await runtime.host.gitRepositories!(id)).toEqual({ repositories: [{ path: 'apps/frontend' }], truncated: false });
      expect(await runtime.host.gitStatus(id)).toEqual({ repository: false });
      expect(await runtime.host.gitStatus(id, 'apps/frontend')).toMatchObject({ repository: true });
      expect((await runtime.host.gitDiff(id, 'README.md', 'apps/frontend')).diff).toBe('');
      await expect(runtime.host.gitRepositories!('missing')).rejects.toThrow(/no longer exists/);
    } finally { await runtime.close(); }
  });
});
