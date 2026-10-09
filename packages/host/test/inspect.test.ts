import { execFile } from 'node:child_process';
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { gitDiff, gitStatus, listFiles, parseGitStatus, readWorkspaceFile, READ_LIMIT } from '../src/inspect.js';
import { createAgentHost } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const run = promisify(execFile);
const tempDir = useTempDirs();
const windows = process.platform === 'win32';
const hasGit = await run('git', ['--version']).then(() => true, () => false);
const env = { PATH: process.env.PATH, HOME: process.env.HOME };
let root: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  return stdout;
}

async function repo(): Promise<string> {
  await git(root, 'init', '-q', '-b', 'main');
  await git(root, 'config', 'user.email', 'dev@example.com');
  await git(root, 'config', 'user.name', 'Dev');
  await git(root, 'config', 'commit.gpgsign', 'false');
  return root;
}

beforeEach(async () => {
  root = await tempDir('extalia-inspect-');
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'index.ts'), 'export const a = 1;\n');
  await writeFile(path.join(root, 'README.md'), '# Demo\n\nLine three');
});

describe('listFiles', () => {
  it('lists one level, folders first, with sizes and relative paths', async () => {
    await mkdir(path.join(root, 'node_modules'));
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, 'b.txt'), 'bb');
    const listing = await listFiles(root);
    expect(listing.path).toBe('.');
    expect(listing.truncated).toBe(false);
    expect(listing.entries.map(entry => entry.name)).toEqual(['node_modules', 'src', 'b.txt', 'README.md']);
    expect(listing.entries.find(entry => entry.name === 'node_modules')).toMatchObject({ kind: 'dir', generated: true });
    expect(listing.entries.find(entry => entry.name === 'b.txt')).toMatchObject({ kind: 'file', size: 2, path: 'b.txt' });
    expect((await listFiles(root, 'src')).entries).toEqual([{ name: 'index.ts', path: 'src/index.ts', kind: 'file', size: 20 }]);
  });

  it('marks credential files and hides .git', async () => {
    await writeFile(path.join(root, '.env'), 'TOKEN=x');
    await mkdir(path.join(root, '.git'));
    const listing = await listFiles(root);
    expect(listing.entries.find(entry => entry.name === '.env')).toMatchObject({ credential: true });
    expect(listing.entries.some(entry => entry.name === '.git')).toBe(false);
    await expect(listFiles(root, '.git')).rejects.toThrow(/inside \.git/);
  });

  it('caps the listing at 1000 entries', async () => {
    await mkdir(path.join(root, 'many'));
    await Promise.all(Array.from({ length: 1005 }, (_, index) => writeFile(path.join(root, 'many', `f${index}.txt`), '')));
    const listing = await listFiles(root, 'many');
    expect(listing.entries).toHaveLength(1000);
    expect(listing.truncated).toBe(true);
  });

  it('refuses paths outside the workspace', async () => {
    await expect(listFiles(root, '..')).rejects.toThrow(/outside the workspace/);
    await expect(listFiles(root, 'README.md')).rejects.toThrow(/not a folder/);
  });

  it.skipIf(windows)('does not follow symbolic links out of the workspace', async () => {
    const other = await tempDir('extalia-other-');
    await writeFile(path.join(other, 'private.txt'), 'private');
    await symlink(other, path.join(root, 'outside'));
    await symlink(path.join(root, 'src'), path.join(root, 'inside'));
    await symlink(path.join(root, '.git'), path.join(root, 'git-link'));
    const entries = (await listFiles(root)).entries;
    expect(entries.find(entry => entry.name === 'outside')).toEqual({ name: 'outside', path: 'outside', kind: 'symlink' });
    expect(entries.find(entry => entry.name === 'inside')).toMatchObject({ kind: 'symlink', target: 'dir' });
    await expect(listFiles(root, 'outside')).rejects.toThrow(/symbolic link/);
    await expect(readWorkspaceFile(root, 'outside/private.txt')).rejects.toThrow(/symbolic link/);
    expect((await listFiles(root, 'inside')).entries.map(entry => entry.path)).toEqual(['inside/index.ts']);
  });
});

describe('readWorkspaceFile', () => {
  it('reads text with size and line count', async () => {
    expect(await readWorkspaceFile(root, 'README.md')).toEqual({ path: 'README.md', size: 18, binary: false, content: '# Demo\n\nLine three', lines: 3, truncated: false });
    expect(await readWorkspaceFile(root, 'src/index.ts')).toMatchObject({ lines: 1, truncated: false });
  });

  it('detects binary files and returns no content', async () => {
    await writeFile(path.join(root, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    expect(await readWorkspaceFile(root, 'image.bin')).toEqual({ path: 'image.bin', size: 4, binary: true, lines: 0, truncated: false });
  });

  it('truncates large files at 512 KB', async () => {
    await writeFile(path.join(root, 'big.txt'), 'x'.repeat(READ_LIMIT + 10));
    const file = await readWorkspaceFile(root, 'big.txt');
    expect(file).toMatchObject({ size: READ_LIMIT + 10, truncated: true, lines: 1 });
    expect(file.content).toHaveLength(READ_LIMIT);
  });

  it('refuses credential files, .git internals, folders and missing files', async () => {
    await writeFile(path.join(root, '.env'), 'SECRET=hunter2'); // extalia-allow-secret
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, '.git', 'config'), '[core]\n');
    await expect(readWorkspaceFile(root, '.env')).rejects.toThrow(/credential/);
    await expect(readWorkspaceFile(root, '.git/config')).rejects.toThrow(/inside \.git/);
    await expect(readWorkspaceFile(root, 'src')).rejects.toThrow(/is a folder/);
    await expect(readWorkspaceFile(root, 'missing.txt')).rejects.toThrow(/does not exist/);
    await expect(readWorkspaceFile(root, '')).rejects.toThrow(/Choose a file/);
  });

  it.skipIf(windows)('refuses links to credential files and .git internals', async () => {
    await writeFile(path.join(root, '.env'), 'SECRET=hunter2'); // extalia-allow-secret
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, '.git', 'config'), '[core]\n');
    await symlink(path.join(root, '.env'), path.join(root, 'env-link'));
    await symlink(path.join(root, '.git', 'config'), path.join(root, 'config-link'));
    await expect(readWorkspaceFile(root, 'env-link')).rejects.toThrow(/credential/);
    await expect(readWorkspaceFile(root, 'config-link')).rejects.toThrow(/inside \.git/);
  });
});

describe('parseGitStatus', () => {
  it('reads branch headers and every record type', () => {
    const output = [
      '# branch.oid 0123456789abcdef0123456789abcdef01234567', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa aaa sub/app/file name.ts',
      '2 R. N... 100644 100644 100644 aaa aaa R100 sub/app/new.ts', 'sub/app/old.ts',
      'u UU N... 100644 100644 100644 100644 a b c sub/app/conflict.ts',
      '1 A. N... 000000 100644 100644 000 aaa sub/app/.env',
      '? sub/app/notes/', '? sub/other.ts', '',
    ].join('\0');
    expect(parseGitStatus(output, 'sub/app/')).toEqual({
      branch: 'main', commit: '0123456789ab', upstream: 'origin/main', ahead: 2, behind: 1,
      changes: [
        { path: 'file name.ts', index: 'unmodified', worktree: 'modified' },
        { path: 'new.ts', originalPath: 'old.ts', index: 'renamed', worktree: 'unmodified' },
        { path: 'conflict.ts', index: 'unmerged', worktree: 'unmerged', conflicted: true },
        { path: '.env', index: 'added', worktree: 'unmodified', credential: true },
        { path: 'notes/', index: 'unmodified', worktree: 'unmodified', untracked: true },
      ],
    });
  });

  it('handles detached and unborn heads and cut-off output', () => {
    expect(parseGitStatus('# branch.oid (initial)\0# branch.head main\0')).toEqual({ branch: 'main', ahead: 0, behind: 0, changes: [] });
    expect(parseGitStatus('# branch.oid abc\0# branch.head (detached)\0? a.txt\0? b.t', '', true)).toEqual({
      commit: 'abc', ahead: 0, behind: 0, changes: [{ path: 'a.txt', index: 'unmodified', worktree: 'unmodified', untracked: true }],
    });
  });
});

describe.skipIf(!hasGit)('git status and diff', () => {
  it('reports not-a-repository', async () => {
    expect(await gitStatus(root, { env })).toEqual({ repository: false });
    await expect(gitDiff(root, undefined, { env })).rejects.toThrow(/not a Git repository/);
  });

  it('reports a friendly error when git is missing', async () => {
    await expect(gitStatus(root, { env, binary: 'extalia-missing-git-binary' })).rejects.toThrow(/Git is not installed/);
  });

  it('lists changes and diffs staged, unstaged and untracked files', async () => {
    await repo();
    const lines = Array.from({ length: 8 }, (_, index) => `export const v${index} = ${index};\n`).join('');
    await writeFile(path.join(root, 'src', 'index.ts'), `export const a = 1;\n${lines}`);
    await writeFile(path.join(root, '.env'), 'SECRET=one\n'); // extalia-allow-secret
    await git(root, 'add', '.');
    await git(root, 'commit', '-qm', 'init');
    await writeFile(path.join(root, 'src', 'index.ts'), `export const a = 2;\n${lines}`);
    await writeFile(path.join(root, 'README.md'), '# Demo\n');
    await git(root, 'add', 'README.md');
    await git(root, 'mv', 'src/index.ts', 'src/main.ts');
    await writeFile(path.join(root, 'new.txt'), 'hello\nworld');
    await writeFile(path.join(root, '.env'), 'SECRET=two\n'); // extalia-allow-secret
    await mkdir(path.join(root, 'fresh'));
    await writeFile(path.join(root, 'fresh', 'a.txt'), 'a\n');

    const status = await gitStatus(root, { env });
    expect(status).toMatchObject({ repository: true, branch: 'main', ahead: 0, behind: 0, truncated: false });
    if (!status.repository) throw new Error('expected a repository');
    expect(status.commit).toMatch(/^[0-9a-f]{12}$/);
    expect(status.changes).toEqual(expect.arrayContaining([
      { path: '.env', index: 'unmodified', worktree: 'modified', credential: true },
      { path: 'README.md', index: 'modified', worktree: 'unmodified' },
      { path: 'src/main.ts', originalPath: 'src/index.ts', index: 'renamed', worktree: 'modified' },
      { path: 'new.txt', index: 'unmodified', worktree: 'unmodified', untracked: true },
      { path: 'fresh/', index: 'unmodified', worktree: 'unmodified', untracked: true },
    ]));

    const all = await gitDiff(root, undefined, { env });
    expect(all.truncated).toBe(false);
    expect(all.diff).toContain('diff --git a/README.md b/README.md');
    expect(all.diff).toContain('-Line three');
    expect(all.diff).toContain('rename from src/index.ts');
    expect(all.diff).toContain('+export const a = 2;');
    expect(all.diff).toContain('diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n\\ No newline at end of file\n');
    expect(all.diff).toContain('+++ b/fresh/a.txt');
    expect(all.diff).not.toContain('SECRET');

    const one = await gitDiff(root, 'src/main.ts', { env });
    expect(one.path).toBe('src/main.ts');
    expect(one.diff).toContain('rename from src/index.ts');
    expect(one.diff).not.toContain('README');
    expect((await gitDiff(root, 'fresh', { env })).diff).toContain('+++ b/fresh/a.txt');
    await expect(gitDiff(root, '.env', { env })).rejects.toThrow(/credential/);
  });

  it('scopes a project folder inside a larger repository', async () => {
    await repo();
    await writeFile(path.join(root, 'top.txt'), 'top\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-qm', 'init');
    await writeFile(path.join(root, 'top.txt'), 'changed\n');
    await writeFile(path.join(root, 'src', 'index.ts'), 'export const a = 3;\n');
    const project = path.join(root, 'src');
    const status = await gitStatus(project, { env });
    expect(status.repository && status.changes).toEqual([{ path: 'index.ts', index: 'unmodified', worktree: 'modified' }]);
    const diff = await gitDiff(project, undefined, { env });
    expect(diff.diff).toContain('diff --git a/index.ts b/index.ts');
    expect(diff.diff).not.toContain('top.txt');
  });

  it('diffs a repository without commits against the empty tree', async () => {
    await repo();
    await git(root, 'add', 'README.md');
    const diff = await gitDiff(root, 'README.md', { env });
    expect(diff.diff).toContain('new file mode 100644');
    expect(diff.diff).toContain('+# Demo');
    expect(await gitStatus(root, { env })).toMatchObject({ repository: true, branch: 'main' });
  });

  it.skipIf(windows)('never runs fsmonitor, filter or diff programs from the repository configuration', async () => {
    await repo();
    await writeFile(path.join(root, '.gitattributes'), '* filter=evil diff=evil\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-qm', 'init');
    const markers = await tempDir('extalia-markers-');
    const marker = (name: string) => path.join(markers, name);
    const script = async (name: string, body: string) => {
      const file = path.join(root, `${name}.sh`);
      await writeFile(file, `#!/bin/sh\ntouch "${marker(name)}"\n${body}\n`);
      await chmod(file, 0o755);
      return file;
    };
    await git(root, 'config', 'core.fsmonitor', await script('fsmonitor', 'exit 1'));
    await git(root, 'config', 'filter.evil.clean', await script('clean', 'cat'));
    await git(root, 'config', 'filter.evil.process', await script('process', 'exit 1'));
    await git(root, 'config', 'diff.evil.textconv', await script('textconv', 'cat "$1"'));
    await git(root, 'config', 'diff.evil.command', await script('command', 'exit 0'));
    await git(root, 'config', 'diff.external', await script('external', 'exit 0'));
    await git(root, 'config', 'core.pager', await script('pager', 'cat'));
    await writeFile(path.join(root, 'README.md'), '# Changed\n');

    // Control: plain git really runs the configured programs.
    await git(root, 'status', '--porcelain');
    await git(root, 'diff', 'HEAD').catch(() => '');
    expect(existsSync(marker('fsmonitor'))).toBe(true);
    expect(existsSync(marker('process'))).toBe(true);
    await rm(markers, { recursive: true });
    await mkdir(markers);

    expect(await gitStatus(root, { env })).toMatchObject({ repository: true });
    const diff = await gitDiff(root, undefined, { env });
    expect(diff.diff).toContain('+# Changed');
    await gitDiff(root, 'README.md', { env });
    for (const name of ['fsmonitor', 'clean', 'process', 'textconv', 'command', 'external', 'pager']) expect(existsSync(marker(name)), name).toBe(false);
  });
});

describe('agent host inspection methods', () => {
  it('serve the project folder of a workspace and refuse what the views may not read', async () => {
    const data = await tempDir('extalia-data-');
    const runtime = await createAgentHost({ kind: 'bridge', version: '0.0.0-test', dataDirectory: data, env: { EXTALIA_SECRET_STORE: 'memory', PATH: process.env.PATH } });
    try {
      const { host } = runtime;
      const saved = await host.saveConnection({ name: 'Mock', preset: 'custom', api: 'openai-chat', baseUrl: 'http://mock.test/v1', model: 'mock', credential: { kind: 'none' }, features: { memory: 'extalia', skills: 'extalia' } });
      const state = await host.saveWorkspace({ name: 'Project', projectLocation: root, connectionId: saved.connections[0]!.id, permissions: { fileWrite: 'ask', commands: 'ask' } });
      const id = state.workspaces[0]!.id;
      expect((await host.listFiles(id)).entries.map(entry => entry.name)).toEqual(['src', 'README.md']);
      expect(await host.readFile(id, 'src/index.ts')).toMatchObject({ content: 'export const a = 1;\n' });
      await expect(host.readFile(id, '../outside.txt')).rejects.toMatchObject({ name: 'UserError', message: expect.stringMatching(/outside the workspace/) });
      await expect(host.listFiles('missing')).rejects.toThrow(/no longer exists/);
      if (hasGit) expect(await host.gitStatus(id)).toEqual({ repository: false });
    } finally {
      await runtime.close();
    }
  });
});
