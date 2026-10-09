import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { IGNORED_DIRECTORIES, isCredentialPath, resolveInside, WorkspacePathError } from '../src/workspaceFs.js';
import { useTempDirs } from './helpers.js';

const tempDir = useTempDirs();
const windows = process.platform === 'win32';
let root: string;

beforeEach(async () => {
  root = await tempDir('extalia-ws-');
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'index.ts'), 'export {};\n');
});

describe('resolveInside', () => {
  it('resolves relative paths inside the workspace', async () => {
    expect(await resolveInside(root, 'src/index.ts', 'read')).toEqual({ absolute: path.join(root, 'src', 'index.ts'), relative: 'src/index.ts' });
    expect(await resolveInside(root, '.', 'read')).toEqual({ absolute: path.resolve(root), relative: '.' });
    expect(await resolveInside(root, '', 'read')).toMatchObject({ relative: '.' });
    expect(await resolveInside(root, 'src/../README.md', 'write')).toMatchObject({ relative: 'README.md' });
    expect(await resolveInside(root, 'new/dir/file.txt', 'write')).toMatchObject({ relative: 'new/dir/file.txt' });
  });

  it('accepts absolute paths inside the workspace, also through its real location', async () => {
    expect(await resolveInside(root, path.join(root, 'src', 'index.ts'), 'read')).toMatchObject({ relative: 'src/index.ts' });
    const real = await realpath(root);
    expect(await resolveInside(root, path.join(real, 'src', 'index.ts'), 'read')).toMatchObject({ relative: 'src/index.ts' });
  });

  it('refuses paths that escape with ..', async () => {
    await expect(resolveInside(root, '../outside.txt', 'read')).rejects.toThrow(/outside the workspace/);
    await expect(resolveInside(root, 'src/../../outside.txt', 'write')).rejects.toThrow(/outside the workspace/);
    await expect(resolveInside(root, '..', 'read')).rejects.toBeInstanceOf(WorkspacePathError);
  });

  it('allows names that merely start with two dots', async () => {
    expect(await resolveInside(root, '..notes', 'write')).toMatchObject({ relative: '..notes' });
  });

  it('refuses absolute paths outside the workspace', async () => {
    const other = await tempDir('extalia-other-');
    await expect(resolveInside(root, path.join(other, 'file.txt'), 'read')).rejects.toThrow(/outside the workspace/);
    await expect(resolveInside(path.join(root, 'src'), path.join(root, 'secret.txt'), 'read')).rejects.toThrow(/outside the workspace/);
  });

  it.skipIf(windows)('refuses symbolic links that lead outside the workspace', async () => {
    const other = await tempDir('extalia-other-');
    await writeFile(path.join(other, 'private.txt'), 'private');
    await symlink(other, path.join(root, 'linked'));
    await symlink(path.join(other, 'private.txt'), path.join(root, 'file-link.txt'));
    await expect(resolveInside(root, 'linked/private.txt', 'read')).rejects.toThrow(/symbolic link/);
    await expect(resolveInside(root, 'linked', 'read')).rejects.toThrow(/symbolic link/);
    await expect(resolveInside(root, 'linked/new-file.txt', 'write')).rejects.toThrow(/symbolic link/);
    await expect(resolveInside(root, 'file-link.txt', 'write')).rejects.toThrow(/symbolic link/);
  });

  it.skipIf(windows)('refuses broken symbolic links, which could create files anywhere', async () => {
    const other = await tempDir('extalia-other-');
    await symlink(path.join(other, 'not-there.txt'), path.join(root, 'dangling.txt'));
    await expect(resolveInside(root, 'dangling.txt', 'write')).rejects.toThrow(/broken symbolic link/);
  });

  it.skipIf(windows)('allows symbolic links that stay inside, but not to credential files', async () => {
    await symlink(path.join(root, 'src'), path.join(root, 'source'));
    expect(await resolveInside(root, 'source/index.ts', 'read')).toMatchObject({ relative: 'source/index.ts' });
    await writeFile(path.join(root, '.env'), 'TOKEN=value\n');
    await symlink(path.join(root, '.env'), path.join(root, 'notes.txt'));
    await expect(resolveInside(root, 'notes.txt', 'read')).rejects.toThrow(/credential file/);
  });

  it('refuses credential files for reading and writing', async () => {
    const refused = [
      '.env', '.env.local', 'config/.env.production', '.ENV', 'certs/server.pem', 'tls/server.key', 'store.p12', 'cert.pfx',
      'id_rsa', 'keys/id_ed25519.pub', 'id_ecdsa', '.npmrc', '.netrc', '.pypirc', '.ssh/config', 'home/.ssh/known_hosts',
      '.aws/credentials', '.git-credentials',
    ];
    for (const requested of refused) {
      await expect(resolveInside(root, requested, 'read'), requested).rejects.toThrow(/credential file/);
      await expect(resolveInside(root, requested, 'write'), requested).rejects.toThrow(/credential file/);
    }
  });

  it('allows environment templates and ordinary files with similar names', async () => {
    for (const allowed of ['.env.example', '.env.sample', 'src/env.ts', 'keys.ts', 'credentials.md', 'aws/credentials', 'docs/ssh.md']) {
      await expect(resolveInside(root, allowed, 'write'), allowed).resolves.toMatchObject({ relative: allowed });
    }
  });

  it('allows reading inside .git but refuses writes there', async () => {
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, '.git', 'config'), '[core]\n');
    expect(await resolveInside(root, '.git/config', 'read')).toMatchObject({ relative: '.git/config' });
    await expect(resolveInside(root, '.git/config', 'write')).rejects.toThrow(/inside \.git/);
    await expect(resolveInside(root, '.git/hooks/pre-commit', 'write')).rejects.toThrow(/inside \.git/);
  });

  it('refuses paths with NUL bytes and missing workspaces', async () => {
    await expect(resolveInside(root, 'a\0b', 'read')).rejects.toThrow(/plain text/);
    await expect(resolveInside(path.join(root, 'missing'), 'a.txt', 'read')).rejects.toThrow(/not available/);
  });
});

describe('credential paths and ignored directories', () => {
  it('detects credential files by name and location', () => {
    expect(isCredentialPath('a/b/.env.development')).toBe(true);
    expect(isCredentialPath('a\\b\\.npmrc')).toBe(true);
    expect(isCredentialPath('.aws/config')).toBe(false);
    expect(isCredentialPath('src/main.ts')).toBe(false);
  });

  it('lists the generated and vendored directories', () => {
    for (const name of ['.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', '.venv', 'venv', '__pycache__', 'coverage', 'target', '.turbo', '.cache']) {
      expect(IGNORED_DIRECTORIES.has(name)).toBe(true);
    }
    expect(IGNORED_DIRECTORIES.has('src')).toBe(false);
  });
});
