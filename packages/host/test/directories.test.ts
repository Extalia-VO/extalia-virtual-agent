import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { browseDirectories } from '../src/directories.js';
import { useTempDirs } from './helpers.js';

const tempDir = useTempDirs();
const listing = (requested: unknown, homeDirectory: string) => browseDirectories(requested, { homeDirectory, platform: process.platform });

describe('browseDirectories', () => {
  it('defaults to the canonical home folder and exposes its parent and filesystem roots', async () => {
    const root = await tempDir();
    const home = path.join(root, 'a home folder');
    await mkdir(home);
    const [canonicalHome, canonicalRoot] = await Promise.all([realpath(home), realpath(root)]);
    const result = await listing(undefined, home);
    expect(result).toMatchObject({ path: canonicalHome, homePath: canonicalHome, parentPath: canonicalRoot, entries: [], truncated: false });
    expect(result.roots.length).toBeGreaterThan(0);
  });

  it('accepts home and absolute paths, including names with spaces, and lists only directories', async () => {
    const root = await tempDir();
    const home = path.join(root, 'home');
    const child = path.join(home, 'Project Files');
    await mkdir(child, { recursive: true });
    await writeFile(path.join(home, 'notes.txt'), 'private file contents');

    const fromTilde = await listing('~/Project Files', home);
    expect(fromTilde.path).toBe(await realpath(child));
    expect(fromTilde.entries).toEqual([]);
    const fromAbsolute = await listing(home, home);
    expect(fromAbsolute.entries).toEqual([{ name: 'Project Files', path: await realpath(child) }]);
    expect(JSON.stringify(fromAbsolute)).not.toContain('notes.txt');
  });

  it('rejects relative, missing, non-directory and named-user paths', async () => {
    const root = await tempDir();
    const home = path.join(root, 'home');
    await mkdir(home);
    await writeFile(path.join(home, 'file.txt'), 'data');
    await expect(listing('relative/project', home)).rejects.toThrow(/absolute/);
    await expect(listing('~other/project', home)).rejects.toThrow(/current user/);
    await expect(listing(path.join(home, 'missing'), home)).rejects.toThrow(/does not exist/);
    await expect(listing(path.join(home, 'file.txt'), home)).rejects.toThrow(/not a directory/);
  });

  it('omits directory symlinks instead of following them', async () => {
    const root = await tempDir();
    const home = path.join(root, 'home');
    const outside = path.join(root, 'outside');
    await mkdir(home);
    await mkdir(outside);
    await mkdir(path.join(outside, 'secret-project'));
    try { await symlink(outside, path.join(home, 'linked-folder'), 'dir'); }
    catch { return; } // Some Windows environments do not grant symlink creation to tests.
    const result = await listing(home, home);
    expect(result.entries).toEqual([]);
  });

  it('keeps results bounded and reports when additional directories were omitted', async () => {
    const root = await tempDir();
    const home = path.join(root, 'home');
    await mkdir(home);
    await Promise.all(Array.from({ length: 205 }, (_, index) => mkdir(path.join(home, `dir-${String(index).padStart(3, '0')}`))));
    const result = await listing(home, home);
    expect(result.entries).toHaveLength(200);
    expect(result.entries[0]?.name).toBe('dir-000');
    expect(result.entries.at(-1)?.name).toBe('dir-199');
    expect(result.truncated).toBe(true);
  });

  it('does not report truncation when there are exactly 200 directories', async () => {
    const root = await tempDir();
    const home = path.join(root, 'home');
    await mkdir(home);
    await Promise.all(Array.from({ length: 200 }, (_, index) => mkdir(path.join(home, `dir-${String(index).padStart(3, '0')}`))));
    const result = await listing(home, home);
    expect(result.entries).toHaveLength(200);
    expect(result.truncated).toBe(false);
  });
});
