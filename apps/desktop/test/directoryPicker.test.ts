import type { BrowserWindow, Dialog } from 'electron';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectNativeDirectory } from '../src/directoryPicker';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'extalia-directory-picker-')); roots.push(root);
  const home = path.join(root, 'home'), project = path.join(root, 'project'), file = path.join(root, 'plain.txt');
  await mkdir(home); await mkdir(project); await writeFile(file, 'Keep existing user data.');
  const isDestroyed = vi.fn(() => false), owner = { isDestroyed } as unknown as BrowserWindow;
  const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: [project] }));
  const options = { homeDirectory: home, dialog: { showOpenDialog } as unknown as Pick<Dialog, 'showOpenDialog'> };
  return { root, home, project, file, owner, options, isDestroyed, showOpenDialog };
}

describe('native desktop directory picker', () => {
  it('parents the native folder dialog, starts at an existing directory, and returns only the selected folder', async () => {
    const f = await fixture();
    expect(await selectNativeDirectory(f.owner, { title: 'Pilih folder proyek', initialPath: f.project, purpose: 'project' }, f.options))
      .toEqual({ name: 'project', path: f.project });
    expect(f.showOpenDialog).toHaveBeenCalledExactlyOnceWith(f.owner, { title: 'Pilih folder proyek', defaultPath: f.project,
      properties: ['openDirectory', 'createDirectory'] });
  });

  it.each(['absent', 'relative', 'missing', 'file'] as const)('falls back to the OS home for an %s starting folder', async kind => {
    const f = await fixture();
    const initialPath = kind === 'absent' ? undefined : kind === 'relative' ? 'relative/project' : kind === 'missing' ? path.join(f.root, 'missing') : f.file;
    await selectNativeDirectory(f.owner, initialPath === undefined ? undefined : { initialPath }, f.options);
    expect(f.showOpenDialog).toHaveBeenCalledExactlyOnceWith(f.owner, { defaultPath: f.home, properties: ['openDirectory', 'createDirectory'] });
  });

  it('selects an existing skill package without offering native creation and leaves cancellation untouched', async () => {
    const f = await fixture(), before = await readdir(f.root);
    f.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [f.project] });
    expect(await selectNativeDirectory(f.owner, { purpose: 'skill', title: 'Choose a skill folder' }, f.options)).toBeNull();
    expect(f.showOpenDialog).toHaveBeenCalledExactlyOnceWith(f.owner, { title: 'Choose a skill folder', defaultPath: f.home, properties: ['openDirectory'] });
    expect(await readdir(f.root)).toEqual(before);
    expect(await readFile(f.file, 'utf8')).toBe('Keep existing user data.');
  });

  it.each([null, 'destroyed'] as const)('does not open an unparented dialog for parent %s', async kind => {
    const f = await fixture();
    f.isDestroyed.mockReturnValue(true);
    expect(await selectNativeDirectory(kind === null ? null : f.owner, undefined, f.options)).toBeNull();
    expect(f.showOpenDialog).not.toHaveBeenCalled();
  });

  it('ignores a native selection returned after its parent closed', async () => {
    const f = await fixture();
    f.showOpenDialog.mockImplementation(async () => { f.isDestroyed.mockReturnValue(true); return { canceled: false, filePaths: [f.project] }; });
    expect(await selectNativeDirectory(f.owner, undefined, f.options)).toBeNull();
  });

  it.each(['relative', 'missing', 'file', 'multiple', 'empty'] as const)('refuses an invalid native %s selection', async kind => {
    const f = await fixture();
    const filePaths = kind === 'relative' ? ['relative/project'] : kind === 'missing' ? [path.join(f.root, 'missing')]
      : kind === 'file' ? [f.file] : kind === 'multiple' ? [f.home, f.project] : [];
    f.showOpenDialog.mockResolvedValue({ canceled: false, filePaths });
    expect(await selectNativeDirectory(f.owner, undefined, f.options)).toBeNull();
  });

  it.each([null, [], 'project', { unexpected: true }, { title: '' }, { title: 'a'.repeat(161) }, { title: 'line\nbreak' },
    { initialPath: 1 }, { initialPath: 'a'.repeat(4097) }, { initialPath: '\0' }, { purpose: 'unknown' }, { purpose: { toString: (): string => 'project' } }])(
    'rejects malformed renderer hints before opening a dialog (%j)', async raw => {
      const f = await fixture();
      await expect(selectNativeDirectory(f.owner, raw, f.options)).rejects.toThrow(/Invalid folder picker/);
      expect(f.showOpenDialog).not.toHaveBeenCalled();
    },
  );

  it('rejects inherited payloads but accepts a closed null-prototype options object', async () => {
    const f = await fixture();
    await expect(selectNativeDirectory(f.owner, Object.create({ title: 'Inherited' }), f.options)).rejects.toThrow(/Invalid folder picker/);
    expect(f.showOpenDialog).not.toHaveBeenCalled();
    expect(await selectNativeDirectory(f.owner, Object.assign(Object.create(null), { initialPath: f.project }), f.options)).toEqual({ name: 'project', path: f.project });
  });
});
