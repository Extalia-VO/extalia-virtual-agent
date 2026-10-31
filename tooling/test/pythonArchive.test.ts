import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdtemp, writeFile, readFile, lstat, rm, chmod } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectPythonArchive, materializePythonArchive } from '../python-bundle/archive.mjs';

type Entry = { path: string; data?: string | Buffer; type?: string; link?: string; size?: number; mode?: number };
const roots: string[] = [];
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');

function tar(entries: Entry[]) {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '');
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, 'ascii');
    header.write((entry.mode ?? 0o644).toString(8).padStart(7, '0'), 100, 7, 'ascii');
    header.write((entry.size ?? data.length).toString(8).padStart(11, '0'), 124, 11, 'ascii');
    header.fill(32, 148, 156);
    header.write(entry.type ?? '0', 156, 1, 'ascii');
    header.write(entry.link ?? '', 157, 100, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((total, byte) => total + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

async function fixture(raw: Buffer, compressed = false) {
  const root = await mkdtemp(join(tmpdir(), 'extalia-archive-test-'));
  roots.push(root);
  const path = join(root, 'archive.tar.gz');
  const data = compressed ? raw : gzipSync(raw);
  await writeFile(path, data);
  return { path, destination: join(root, 'payload'), pin: { bytes: data.length, sha256: hash(data) } };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    // Successful payload directories deliberately have no write permission.
    await chmod(join(root, 'payload/python/lib'), 0o700).catch(() => {});
    await chmod(join(root, 'payload/python'), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

describe('pinned streaming Python archive staging', () => {
  it('preflights files and materializes internal file links without filesystem links', async () => {
    const source = await fixture(tar([
      { path: 'python/', type: '5' },
      { path: 'python/lib/tool', data: 'binary\0bytes', mode: 0o4755 },
      { path: 'python/alias', type: '2', link: 'lib/tool' },
      { path: 'python/lib/up', type: '2', link: '../alias' },
      { path: 'python/hard', type: '1', link: 'python/lib/tool' },
    ]));
    const index = await inspectPythonArchive(source.path, source.pin);
    expect(index.materialized).toHaveLength(4);
    const inventory = await materializePythonArchive(source.path, source.pin, source.destination);
    expect(inventory.materialized.every((file) => file.executable)).toBe(true);
    for (const file of inventory.materialized) {
      const path = join(source.destination, file.path);
      expect((await lstat(path)).isFile()).toBe(true);
      if (process.platform !== 'win32') expect((await lstat(path)).mode & 0o7777).toBe(0o555);
      expect((await readFile(path)).toString()).toBe('binary\0bytes');
    }
    expect((await lstat(source.destination)).mode & 0o777).toBe(0o700);
  });

  it.each([
    ['traversal', [{ path: 'python/../escape', data: 'bad' }]],
    ['absolute', [{ path: '/python/escape', data: 'bad' }]],
    ['wrong root', [{ path: 'other/file', data: 'bad' }]],
    ['backslash', [{ path: 'python/a\\b', data: 'bad' }]],
    ['colon', [{ path: 'python/a:b', data: 'bad' }]],
    ['dot suffix', [{ path: 'python/name.', data: 'bad' }]],
    ['device', [{ path: 'python/COM0.txt', data: 'bad' }]],
    ['duplicate file', [{ path: 'python/a' }, { path: 'python/a' }]],
    ['duplicate directory', [{ path: 'python/a/', type: '5' }, { path: 'python/a', type: '5' }]],
    ['case fold', [{ path: 'python/A' }, { path: 'python/a' }]],
    ['ancestor spelling', [{ path: 'python/Lib/a' }, { path: 'python/lib/b' }]],
    ['file prefix', [{ path: 'python/a' }, { path: 'python/a/b' }]],
    ['late file prefix', [{ path: 'python/a/b' }, { path: 'python/a' }]],
    ['PAX', [{ path: 'python/a', type: 'x' }]],
    ['GNU long name', [{ path: 'python/a', type: 'L' }]],
    ['special device', [{ path: 'python/a', type: '3' }]],
    ['FIFO', [{ path: 'python/a', type: '6' }]],
    ['sparse', [{ path: 'python/a', type: 'S' }]],
    ['symlink escape', [{ path: 'python/a', type: '2', link: '../outside' }]],
    ['hardlink escape', [{ path: 'python/a', type: '1', link: '../outside' }]],
    ['missing link', [{ path: 'python/a', type: '2', link: 'missing' }]],
    ['link cycle', [{ path: 'python/a', type: '2', link: 'b' }, { path: 'python/b', type: '2', link: 'a' }]],
    ['directory link', [{ path: 'python/a', type: '5' }, { path: 'python/b', type: '2', link: 'a' }]],
    ['link ancestor', [{ path: 'python/a', type: '2', link: 'b' }, { path: 'python/a/c' }, { path: 'python/b' }]],
    ['file size limit', [{ path: 'python/a', size: 128 * 1024 * 1024 + 1 }]],
    ['component bound', [{ path: `python/${'a'.repeat(65)}` }]],
    ['depth bound', [{ path: `python/${Array.from({ length: 16 }, () => 'a').join('/')}` }]],
  ] satisfies [string, Entry[]][])('rejects %s before creating a destination', async (_name, entries) => {
    const source = await fixture(tar(entries));
    await expect(materializePythonArchive(source.path, source.pin, source.destination)).rejects.toThrow();
    await expect(lstat(source.destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['checksum', 'padding', 'end blocks', 'truncation', 'trailing data', 'octal'])(
    'rejects malformed %s', async (kind) => {
      let raw = tar([{ path: 'python/file', data: 'a' }]);
      if (kind === 'checksum') raw[0] ^= 1;
      if (kind === 'padding') raw[513] = 1;
      if (kind === 'end blocks') raw[1536] = 1;
      if (kind === 'truncation') raw = raw.subarray(0, raw.length - 513);
      if (kind === 'trailing data') raw = Buffer.concat([raw, Buffer.from('bad')]);
      if (kind === 'octal') raw[124] = 0x80;
      const source = await fixture(raw);
      await expect(inspectPythonArchive(source.path, source.pin)).rejects.toThrow();
    },
  );

  it('checks exact size and sha before attempting to decompress', async () => {
    const source = await fixture(Buffer.from('not tar'));
    await expect(inspectPythonArchive(source.path, { ...source.pin, bytes: source.pin.bytes + 1 })).rejects.toThrow('byte size');
    await expect(inspectPythonArchive(source.path, { ...source.pin, sha256: '0'.repeat(64) })).rejects.toThrow('sha256');
    await expect(inspectPythonArchive(source.path, { ...source.pin, bytes: 64 * 1024 * 1024 + 1 })).rejects.toThrow('pin');
  });

  it('refuses an existing destination and preserves its contents', async () => {
    const source = await fixture(tar([{ path: 'python/file', data: 'ok' }]));
    await writeFile(source.destination, 'existing');
    await expect(materializePythonArchive(source.path, source.pin, source.destination)).rejects.toThrow();
    expect(await readFile(source.destination, 'utf8')).toBe('existing');
  });

  it('validates empty directory entries without creating unlisted output directories', async () => {
    const source = await fixture(tar([
      { path: 'python/unused/deep/', type: '5' },
      { path: 'python/lib/tool', data: 'keep' },
    ]));
    const index = await inspectPythonArchive(source.path, source.pin);
    expect(index.entries).toHaveLength(2);
    expect(index.directories).toEqual(['python', 'python/lib']);
    await materializePythonArchive(source.path, source.pin, source.destination);
    expect(await readFile(join(source.destination, 'python/lib/tool'), 'utf8')).toBe('keep');
    await expect(lstat(join(source.destination, 'python/unused'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(platform() === 'win32')('refuses a FIFO archive without blocking on its open', async () => {
    const source = await fixture(tar([{ path: 'python/file', data: 'ok' }]));
    const fifo = join(source.destination, '..', 'archive.fifo');
    execFileSync('mkfifo', [fifo]);
    await expect(inspectPythonArchive(fifo, source.pin)).rejects.toThrow('archive byte size');
  });

  it('bounds final file counts including aliases and link chain depth', async () => {
    const many = await fixture(tar(Array.from({ length: 4097 }, (_, index) => ({ path: `python/f${index}` }))));
    await expect(inspectPythonArchive(many.path, many.pin)).rejects.toThrow('materialized file limit');
    const links: Entry[] = [{ path: 'python/f0', data: 'ok' }];
    for (let index = 1; index <= 17; index++) links.push({ path: `python/f${index}`, type: '2', link: `f${index - 1}` });
    const chain = await fixture(tar(links));
    await expect(inspectPythonArchive(chain.path, chain.pin)).rejects.toThrow('chain limit');
  });

  it('bounds source entry counts and implicit directories', async () => {
    const entries = await fixture(tar(Array.from({ length: 8193 }, (_, index) => ({ path: `python/d${index}`, type: '5' }))));
    await expect(inspectPythonArchive(entries.path, entries.pin)).rejects.toThrow('source entry limit');
    const directories = await fixture(tar(Array.from({ length: 4096 }, (_, index) => ({ path: `python/d${index}/f` }))));
    await expect(inspectPythonArchive(directories.path, directories.pin)).rejects.toThrow('derived directory limit');
  });

  it('accepts USTAR NUL-terminated names with unused bytes after the terminator', async () => {
    const raw = tar([{ path: 'python/file', data: 'ok' }]);
    raw.write('stale', 13, 'ascii');
    raw.fill(32, 148, 156);
    const checksum = raw.subarray(0, 512).reduce((total, byte) => total + byte, 0);
    raw.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    const source = await fixture(raw);
    expect((await inspectPythonArchive(source.path, source.pin)).materialized[0].path).toBe('python/file');
  });

  it('counts all decompressed bytes including ignored trailing zeros', async () => {
    const zeroMember = gzipSync(Buffer.alloc(1024 * 1024));
    const source = await fixture(Buffer.concat([
      gzipSync(Buffer.alloc(1024)), ...Array.from({ length: 512 }, () => zeroMember),
    ]), true);
    await expect(inspectPythonArchive(source.path, source.pin)).rejects.toThrow('decompressed byte limit');
  });

  it('counts link alias expansion toward the total payload byte limit', async () => {
    const zeroMember = gzipSync(Buffer.alloc(1024 * 1024));
    const header = tar([{ path: 'python/file', size: 128 * 1024 * 1024 }]).subarray(0, 512);
    const aliases = tar(Array.from({ length: 4 }, (_, index) => ({ path: `python/alias${index}`, type: '2', link: 'file' })));
    const source = await fixture(Buffer.concat([
      gzipSync(header), ...Array.from({ length: 128 }, () => zeroMember), gzipSync(aliases),
    ]), true);
    await expect(materializePythonArchive(source.path, source.pin, source.destination)).rejects.toThrow('materialized file limit');
    await expect(lstat(source.destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
