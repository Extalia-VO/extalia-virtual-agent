import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDurableJsonWriter, writeJsonAtomic } from '../src/jsonStore.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'extalia-json-publication-')); roots.push(root);
  return root;
}

describe('JSON publication durability', () => {
  it('keeps ordinary atomic JSON writes independent of directory flushing', async () => {
    const root = await fixture(), file = join(root, 'ordinary.json');
    const handle = await open(join(root, 'probe'), 'wx');
    const prototype = Object.getPrototypeOf(handle) as { sync(): Promise<void> }, sync = prototype.sync;
    const barrier = vi.spyOn(prototype, 'sync').mockImplementation(async function (this: FileHandle) {
      if ((await this.stat()).isDirectory()) throw new Error('Unexpected directory flush');
      await sync.call(this);
    });
    try {
      await writeJsonAtomic(file, { revision: 1 });
      await writeJsonAtomic(file, { revision: 2 });
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ revision: 2 });
    } finally { barrier.mockRestore(); await handle.close(); }
  });

  it.skipIf(process.platform === 'win32')('retries every newly created directory and its existing parent after a publication failure', async () => {
    const root = await fixture(), directory = join(root, 'new-profile', 'state');
    const file = join(directory, 'continuity.json'), write = createDurableJsonWriter(file);
    const handle = await open(root, 'r'), parent = await handle.stat();
    const prototype = Object.getPrototypeOf(handle) as { sync(): Promise<void> }, sync = prototype.sync;
    const flushed: string[] = []; let failParent = true;
    const barrier = vi.spyOn(prototype, 'sync').mockImplementation(async function (this: FileHandle) {
      const info = await this.stat();
      if (info.isDirectory()) {
        flushed.push(`${info.dev}:${info.ino}`);
        if (failParent && info.dev === parent.dev && info.ino === parent.ino) throw new Error('Parent-directory durability unavailable');
      }
      await sync.call(this);
    });
    try {
      await expect(write({ revision: 1 })).rejects.toThrow('Parent-directory durability unavailable');
      const expected = await Promise.all([directory, dirname(directory), root].map(async entry => {
        const info = await lstat(entry); return `${info.dev}:${info.ino}`;
      }));
      expect(flushed).toEqual(expected);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ revision: 1 });
      failParent = false; flushed.length = 0;
      await write({ revision: 2 });
      expect(flushed).toEqual(expected);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ revision: 2 });
    } finally { barrier.mockRestore(); await handle.close(); }
  });

  it.skipIf(process.platform === 'win32')('refuses acknowledgement when the journal directory changes while its parent is flushed', async () => {
    const root = await fixture(), directory = join(root, 'state'), moved = join(root, 'moved-state');
    const file = join(directory, 'continuity.json'), write = createDurableJsonWriter(file);
    await write({ revision: 1 });
    const handle = await open(root, 'r'), parent = await handle.stat();
    const prototype = Object.getPrototypeOf(handle) as { sync(): Promise<void> }, sync = prototype.sync;
    let replaced = false;
    const barrier = vi.spyOn(prototype, 'sync').mockImplementation(async function (this: FileHandle) {
      const info = await this.stat(); await sync.call(this);
      if (!replaced && info.isDirectory() && info.dev === parent.dev && info.ino === parent.ino) {
        replaced = true; await rename(directory, moved); await mkdir(directory);
      }
    });
    try {
      await expect(write({ revision: 2 })).rejects.toThrow('Journal directory changed during publication');
      await expect(write({ revision: 3 })).rejects.toThrow('Journal directory changed during publication');
      expect(JSON.parse(await readFile(join(moved, 'continuity.json'), 'utf8'))).toEqual({ revision: 2 });
    } finally { barrier.mockRestore(); await handle.close(); }
  });
});
