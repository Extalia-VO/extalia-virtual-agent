import { appendFile, mkdir, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeImportService } from '../src/nativeImport.js';
import { useTempDirs } from './helpers.js';

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof filesystem>() }));
afterEach(() => vi.restoreAllMocks());

const temp = useTempDirs(), id = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
async function fixture() {
  // Resolve Windows short temporary paths before registering the profile.
  const home = await realpath(await temp('extalia-codex-binding-')), codexHome = path.join(home, '.codex'), sessions = path.join(codexHome, 'sessions');
  await mkdir(sessions, { recursive: true });
  const file = path.join(sessions, `rollout-${id}.jsonl`);
  const header = `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/projects/example' } })}\n`;
  await writeFile(file, header);
  const source = await NativeImportService.create({ homeDirectory: home, env: {} });
  const location = source.locations().find(item => item.sourceId === 'codex' && item.path === sessions)!;
  return { home, codexHome, sessions, file, header, source, ref: { locationId: location.id, sourceId: 'codex', nativeSessionId: id, path: file } };
}

/** Preserve real file operations while exposing file IDs that a Number cannot distinguish. */
async function exactIdentity(file: string) {
  const actual = await vi.importActual<typeof filesystem>('node:fs');
  let current = { dev: 1n, ino: 9_007_199_254_740_992n };
  const remap = (info: filesystem.Stats | filesystem.BigIntStats | undefined) => info && Object.assign(info, {
    dev: typeof info.dev === 'bigint' ? current.dev : Number(current.dev),
    ino: typeof info.ino === 'bigint' ? current.ino : Number(current.ino),
  });
  vi.spyOn(filesystem, 'statSync').mockImplementation((target, options) => {
    const info = actual.statSync(target, options);
    return target === file ? remap(info) : info;
  });
  vi.spyOn(filesystem, 'fstatSync').mockImplementation((fd, options) => {
    const info = actual.fstatSync(fd, options), opened = actual.fstatSync(fd, { bigint: true }), named = actual.statSync(file, { bigint: true });
    return opened.dev === named.dev && opened.ino === named.ino ? remap(info)! : info;
  });
  return (next: Partial<typeof current>) => { current = { ...current, ...next }; };
}

async function replaceFile(f: Awaited<ReturnType<typeof fixture>>, header = f.header) {
  const replacement = path.join(f.sessions, 'replacement.jsonl');
  await writeFile(replacement, header);
  await rename(replacement, f.file);
}

it('binds the exact registered UUID/profile and remains stable for append-only native activity', async () => {
  const f = await fixture(), first = f.source.codexQueueSource(f.ref);
  expect(first?.codexHome).toBe(await realpath(f.codexHome));
  await appendFile(f.file, `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`);
  expect(f.source.codexQueueSource(f.ref)).toEqual(first);
  expect(f.source.codexQueueSource({ ...f.ref, nativeSessionId: '22222222-2222-4222-8222-222222222222' })).toBeUndefined();
  expect(f.source.codexQueueSource({ ...f.ref, locationId: 'unregistered' })).toBeUndefined();
});
it('changes the binding when the source file is replaced and refuses a symlink escape', async () => {
  const f = await fixture(), first = f.source.codexQueueSource(f.ref);
  const replacement = path.join(f.sessions, 'replacement.jsonl'); await writeFile(replacement, f.header); await rename(replacement, f.file);
  const replaced = f.source.codexQueueSource(f.ref);
  expect(first).toBeDefined();
  expect(replaced).toBeDefined();
  expect(replaced?.sourceFingerprint).not.toBe(first?.sourceFingerprint);
  if (process.platform !== 'win32') {
    const outside = path.join(f.home, 'outside.jsonl'), link = path.join(f.sessions, 'escape.jsonl');
    await writeFile(outside, f.header); await symlink(outside, link);
    expect(f.source.codexQueueSource({ ...f.ref, path: link })).toBeUndefined();
  }
});

it('distinguishes exact 64-bit file IDs while retaining append-only bindings', async () => {
  const f = await fixture(), changeIdentity = await exactIdentity(f.file);
  const first = f.source.codexQueueSource(f.ref);
  expect(first).toBeDefined();
  await appendFile(f.file, `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`);
  expect(f.source.codexQueueSource(f.ref)).toEqual(first);
  expect(Number(9_007_199_254_740_992n)).toBe(Number(9_007_199_254_740_993n));
  await replaceFile(f);
  changeIdentity({ ino: 9_007_199_254_740_993n });
  const replaced = f.source.codexQueueSource(f.ref);
  expect(replaced).toBeDefined();
  expect(replaced?.sourceFingerprint).not.toBe(first?.sourceFingerprint);
});

it.each(['inode', 'device'] as const)('invalidates cached UUID metadata when the exact %s changes', async field => {
  const f = await fixture(), changeIdentity = await exactIdentity(f.file);
  expect(f.source.codexQueueSource(f.ref)).toBeDefined();
  await replaceFile(f, f.header.replace(id, otherId));
  changeIdentity(field === 'inode' ? { ino: 9_007_199_254_740_993n } : { dev: 2n });
  expect(f.source.codexQueueSource(f.ref)).toBeUndefined();
  expect(f.source.codexQueueSource({ ...f.ref, nativeSessionId: otherId })).toBeDefined();
});

it.each([1, 2])('refuses replacement during source inspection %i, including a cached header', async replaceAt => {
  const f = await fixture(), actual = await vi.importActual<typeof filesystem>('node:fs');
  expect(f.source.codexQueueSource(f.ref)).toBeDefined();
  const replacement = path.join(f.sessions, 'replacement.jsonl');
  await writeFile(replacement, f.header);
  let inspected = 0;
  vi.spyOn(filesystem, 'statSync').mockImplementation((target, options) => {
    const info = actual.statSync(target, options);
    if (target === f.file && ++inspected === replaceAt) actual.renameSync(replacement, f.file);
    return info;
  });
  expect(f.source.codexQueueSource(f.ref)).toBeUndefined();
  expect(f.source.codexQueueSource(f.ref)).toBeDefined();
});

it('refuses a different file opened after header inspection', async () => {
  const f = await fixture(), actual = await vi.importActual<typeof filesystem>('node:fs');
  const replacement = path.join(f.sessions, 'replacement.jsonl');
  await writeFile(replacement, f.header);
  let replaced = false;
  vi.spyOn(filesystem, 'openSync').mockImplementation((target, flags, mode) => {
    if (target === f.file && !replaced) { replaced = true; actual.renameSync(replacement, f.file); }
    return actual.openSync(target, flags, mode);
  });
  expect(f.source.codexQueueSource(f.ref)).toBeUndefined();
  expect(f.source.codexQueueSource(f.ref)).toBeDefined();
});

it('refuses a header when the named file changes during its read', async () => {
  const f = await fixture(), actual = await vi.importActual<typeof filesystem>('node:fs');
  const replacement = path.join(f.sessions, 'replacement.jsonl');
  await writeFile(replacement, f.header);
  let sourceFd: number | undefined, replaced = false;
  vi.spyOn(filesystem, 'openSync').mockImplementation((target, flags, mode) => {
    const fd = actual.openSync(target, flags, mode);
    if (target === f.file) sourceFd = fd;
    return fd;
  });
  // Model the named replacement without requiring Windows to replace an open target.
  const named = vi.spyOn(filesystem, 'statSync').mockImplementation((target, options) =>
    actual.statSync(target === f.file && replaced ? replacement : target, options));
  vi.spyOn(filesystem, 'readSync').mockImplementation((...args: Parameters<typeof filesystem.readSync>) => {
    const bytes = actual.readSync(...args);
    if (args[0] === sourceFd) replaced = true;
    return bytes;
  });
  expect(f.source.codexQueueSource(f.ref)).toBeUndefined();
  named.mockRestore();
  actual.renameSync(replacement, f.file); // The rejected read has closed its descriptor.
  expect(f.source.codexQueueSource(f.ref)).toBeDefined();
});
