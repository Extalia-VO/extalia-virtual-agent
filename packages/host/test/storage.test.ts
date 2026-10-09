import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendLine, CorruptFileError, readJson, writeJsonAtomic } from '../src/jsonStore.js';
import { dataLayout, ensureLayout } from '../src/paths.js';
import { useTempDirs } from './helpers.js';

const tempDir = useTempDirs();
const windows = process.platform === 'win32';

describe('data layout', () => {
  it('places every directory below the absolute data directory', () => {
    const layout = dataLayout('relative/data');
    expect(path.isAbsolute(layout.root)).toBe(true);
    for (const key of ['config', 'state', 'sessions', 'workspaces', 'skills', 'cache'] as const) {
      expect(layout[key]).toBe(path.join(layout.root, key));
    }
  });

  it('creates the directories', async () => {
    const layout = dataLayout(path.join(await tempDir(), 'Extalia'));
    await ensureLayout(layout);
    for (const directory of Object.values(layout)) expect((await stat(directory)).isDirectory()).toBe(true);
  });

  it.skipIf(windows)('makes the directories private on POSIX', async () => {
    const layout = dataLayout(path.join(await tempDir(), 'Extalia'));
    await ensureLayout(layout);
    for (const directory of Object.values(layout)) expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });
});

describe('JSON store', () => {
  it('returns the fallback for a missing file', async () => {
    expect(await readJson(path.join(await tempDir(), 'missing.json'), { empty: true })).toEqual({ empty: true });
  });

  it('refuses corrupt JSON and leaves the file unchanged', async () => {
    const file = path.join(await tempDir(), 'config.json');
    await writeFile(file, '{ "broken": ');
    await expect(readJson(file, {})).rejects.toBeInstanceOf(CorruptFileError);
    await expect(readJson(file, {})).rejects.toThrow(/not valid JSON/);
    expect(await readFile(file, 'utf8')).toBe('{ "broken": ');
  });

  it('writes atomically, creating parent directories and leaving no temporary files', async () => {
    const directory = await tempDir();
    const file = path.join(directory, 'nested', 'deeper', 'value.json');
    await writeJsonAtomic(file, { a: 1 });
    await writeJsonAtomic(file, { a: 2 });
    expect(await readJson(file, {})).toEqual({ a: 2 });
    expect(await readdir(path.dirname(file))).toEqual(['value.json']);
  });

  it.skipIf(windows)('writes private files by default', async () => {
    const file = path.join(await tempDir(), 'private.json');
    await writeJsonAtomic(file, {});
    await writeJsonAtomic(file, { again: true });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('appends single lines and refuses embedded line breaks', async () => {
    const file = path.join(await tempDir(), 'log', 'events.jsonl');
    await appendLine(file, '{"n":1}');
    await appendLine(file, '{"n":2}');
    expect(await readFile(file, 'utf8')).toBe('{"n":1}\n{"n":2}\n');
    await expect(appendLine(file, 'a\nb')).rejects.toThrow(/line breaks/);
  });
});
