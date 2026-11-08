import { open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_READ_BYTES, readTextPage } from '../src/tools/readTextPage.js';
import { isBinary, OUTPUT_LIMIT } from '../src/tools/shared.js';
import { useTempDirs } from './helpers.js';

const signal = () => new AbortController().signal;
const tempDir = useTempDirs();

class MemoryHandle {
  position = 0;
  closed = false;
  requests: number[] = [];
  reportedSize?: number;
  fileKind: 'file' | 'directory' | 'other' = 'file';
  beforeStat?: () => void | Promise<void>;
  beforeRead?: () => void | Promise<void>;
  beforeClose?: () => Promise<void>;

  constructor(public content: Buffer, private readonly chunkSize = 64 * 1024) {}

  async stat() {
    await this.beforeStat?.();
    return {
      size: this.reportedSize ?? this.content.length,
      isFile: () => this.fileKind === 'file',
      isDirectory: () => this.fileKind === 'directory',
    };
  }

  async read(buffer: Buffer, offset: number, length: number, _position: null): Promise<{ bytesRead: number }> {
    this.requests.push(length);
    await this.beforeRead?.();
    const bytesRead = Math.min(length, this.chunkSize, this.content.length - this.position);
    this.content.copy(buffer, offset, this.position, this.position + bytesRead);
    this.position += bytesRead;
    return { bytesRead };
  }

  async close(): Promise<void> {
    await this.beforeClose?.();
    this.closed = true;
  }
}

/** The previous whole-buffer implementation, kept only as a differential oracle. */
function reference(buffer: Buffer, offset: number, limit: number) {
  if (isBinary(buffer)) return { kind: 'binary', bytes: buffer.length };
  const lines = buffer.toString('utf8').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const end = Math.min(lines.length, offset - 1 + limit);
  const width = Math.max(4, String(end).length);
  const output: string[] = [];
  let size = 0;
  let shown = offset - 1;
  for (let index = offset - 1; index < end; index++) {
    let line = lines[index]!;
    if (line.length > 2000) line = `${line.slice(0, 2000)}… [line clipped, ${line.length} characters]`;
    const entry = `${String(index + 1).padStart(width)}\t${line}`;
    if (output.length && size + entry.length + 1 > OUTPUT_LIMIT) break;
    output.push(entry);
    size += entry.length + 1;
    shown = index + 1;
  }
  return { kind: 'text', totalLines: lines.length, shown, output: output.join('\n') };
}

describe('bounded text page scanning', () => {
  const fixtures = [
    { name: 'empty', content: Buffer.alloc(0), chunkSize: 1 },
    { name: 'BOM', content: Buffer.from('\ufefffirst\n\ufefflast'), chunkSize: 1 },
    { name: 'CRLF and trailing empty lines', content: Buffer.from('\r\n\nfirst\r\r\nlast\r\n\n'), chunkSize: 1 },
    { name: 'bare CR at EOF', content: Buffer.from('\r'), chunkSize: 1 },
    { name: 'split valid and malformed UTF-8', content: Buffer.from([0xf0, 0x9f, 0x98, 0x80, 10, 0xe2, 0x82, 10, 0xed, 0xa0, 0x80, 0xc0, 0xaf, 10, 0xe2, 0x82]), chunkSize: 1 },
    { name: 'surrogate clipped mid-pair', content: Buffer.from(`${'x'.repeat(1999)}😀尾\r\nend`), chunkSize: 3 },
    { name: 'huge CRLF line', content: Buffer.from(`${'界😀\r'.repeat(180_000)}\r\nshort\r\n`), chunkSize: 64 * 1024 },
    { name: 'newline dense', content: Buffer.from('\n'.repeat(110_000)), chunkSize: 64 * 1024 },
    { name: 'multilingual output limit', content: Buffer.from(Array.from({ length: 120 }, (_, index) => `${index}:${'界😀é'.repeat(420)}`).join('\n')), chunkSize: 64 * 1024 },
    { name: 'number-width boundary', content: Buffer.from(`${'\n'.repeat(9990)}${`${'語'.repeat(1800)}\n`.repeat(40)}`), chunkSize: 64 * 1024 },
  ];

  it.each(fixtures)('matches whole-buffer rendering for $name', async ({ content, chunkSize }) => {
    for (const [offset, limit] of [[1, 400], [1, 2000], [2, 1], [9995, 40], [200_000, 1]]) {
      const handle = new MemoryHandle(content, chunkSize);
      expect(await readTextPage(handle, { offset: offset!, limit: limit!, signal: signal() })).toEqual(reference(content, offset!, limit!));
      expect(handle.closed).toBe(true);
      expect(Math.max(...handle.requests)).toBeLessThanOrEqual(64 * 1024);
    }
  });

  it.each([7999, 8000])('preserves the first-8000-byte binary boundary at byte index %i', async index => {
    const content = Buffer.alloc(9000, 'x');
    content[index] = 0;
    const handle = new MemoryHandle(content, 113);
    expect(await readTextPage(handle, { offset: 1, limit: 1, signal: signal() })).toEqual(reference(content, 1, 1));
    expect(handle.closed).toBe(true);
  });

  it('reads a real opened handle and closes it before returning', async () => {
    const file = path.join(await tempDir(), 'page.txt');
    const content = Buffer.from(`${'a'.repeat(65_535)}😀\r\n\ufefftail`);
    await writeFile(file, content);
    const handle = await open(file, 'r');
    expect(await readTextPage(handle, { offset: 1, limit: 2, signal: signal() })).toEqual(reference(content, 1, 2));
    await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
  });

  it('accepts exactly 5 MiB and counts dense lines without retaining them', async () => {
    const handle = new MemoryHandle(Buffer.alloc(MAX_READ_BYTES, '\n'));
    expect(await readTextPage(handle, { offset: MAX_READ_BYTES, limit: 1, signal: signal() })).toEqual({
      kind: 'text', totalLines: MAX_READ_BYTES, shown: MAX_READ_BYTES, output: `${MAX_READ_BYTES}\t`,
    });
    expect(handle.position).toBe(MAX_READ_BYTES);
    expect(handle.requests.at(-1)).toBe(1);
    expect(handle.closed).toBe(true);
  });

  it('detects growth while reading and consumes at most one byte beyond 5 MiB', async () => {
    const handle = new MemoryHandle(Buffer.alloc(64 * 1024, 'a'));
    handle.beforeRead = () => {
      if (handle.requests.length === 2) handle.content = Buffer.alloc(MAX_READ_BYTES + 500_000, 'a');
    };
    expect(await readTextPage(handle, { offset: 1, limit: 1, signal: signal() })).toEqual({ kind: 'oversized', bytes: MAX_READ_BYTES + 1 });
    expect(handle.position).toBe(MAX_READ_BYTES + 1);
    expect(handle.requests.at(-1)).toBe(1);
    expect(handle.closed).toBe(true);
  });

  it('enforces the actual size limit for binary files too', async () => {
    const handle = new MemoryHandle(Buffer.alloc(MAX_READ_BYTES + 10));
    handle.reportedSize = 100;
    expect(await readTextPage(handle, { offset: 1, limit: 1, signal: signal() })).toEqual({ kind: 'oversized', bytes: MAX_READ_BYTES + 1 });
    expect(handle.position).toBe(MAX_READ_BYTES + 1);
    expect(handle.closed).toBe(true);
  });

  it.each(['directory', 'other'] as const)('closes an opened %s without reading it', async fileKind => {
    const handle = new MemoryHandle(Buffer.alloc(0));
    handle.fileKind = fileKind;
    expect(await readTextPage(handle, { offset: 1, limit: 1, signal: signal() })).toEqual({ kind: fileKind === 'directory' ? 'directory' : 'nonregular' });
    expect(handle.requests).toHaveLength(0);
    expect(handle.closed).toBe(true);
  });

  it('uses the opened handle size and closes an oversized file without reading', async () => {
    const handle = new MemoryHandle(Buffer.alloc(0));
    handle.reportedSize = MAX_READ_BYTES + 30;
    expect(await readTextPage(handle, { offset: 1, limit: 1, signal: signal() })).toEqual({ kind: 'oversized', bytes: MAX_READ_BYTES + 30 });
    expect(handle.requests).toHaveLength(0);
    expect(handle.closed).toBe(true);
  });

  it.each(['before first read', 'during read'])('closes on cancellation %s', async when => {
    const controller = new AbortController();
    const reason = new Error('cancelled fixture');
    const handle = new MemoryHandle(Buffer.from('first\nlast'));
    if (when === 'before first read') controller.abort(reason);
    else handle.beforeRead = () => { controller.abort(reason); };
    await expect(readTextPage(handle, { offset: 1, limit: 1, signal: controller.signal })).rejects.toBe(reason);
    expect(handle.requests).toHaveLength(when === 'before first read' ? 0 : 1);
    expect(handle.closed).toBe(true);
  });

  it.each(['stat', 'read'])('waits for close before a %s error rejects', async operation => {
    const handle = new MemoryHandle(Buffer.alloc(0));
    const error = new Error('read fixture failure');
    let releaseClose!: () => void;
    const closePending = new Promise<void>(resolve => { releaseClose = resolve; });
    if (operation === 'stat') handle.beforeStat = () => { throw error; };
    else handle.beforeRead = () => { throw error; };
    handle.beforeClose = () => closePending;
    let settled = false;
    const reading = readTextPage(handle, { offset: 1, limit: 1, signal: signal() });
    void reading.then(() => { settled = true; }, () => { settled = true; });
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(settled).toBe(false);
    expect(handle.closed).toBe(false);
    releaseClose();
    await expect(reading).rejects.toBe(error);
    expect(handle.closed).toBe(true);
  });
});
