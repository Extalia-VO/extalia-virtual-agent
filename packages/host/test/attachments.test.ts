import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AttachmentStore } from '../src/attachments.js';
import { useTempDirs } from './helpers.js';

const tempDir = useTempDirs();
const b64 = (bytes: Uint8Array | number[] | string) => Buffer.from(typeof bytes === 'string' ? bytes : Uint8Array.from(bytes)).toString('base64');
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const pngOf = (size: number) => { const bytes = new Uint8Array(size); bytes.set(PNG_HEAD); return bytes; };
const SESSION = 's_abc123def456';
const OTHER = 's_zzz999yyy888';

function store(root: string, persisted = true) {
  return new AttachmentStore(root, () => persisted);
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { return error instanceof Error ? error.message : String(error); }
  throw new Error('Expected a refusal.');
}

describe('AttachmentStore', () => {
  it('stores an image privately for a session that keeps history, and removes it once sent', async () => {
    const root = path.join(await tempDir(), 'attachments');
    const attachments = store(root);
    const meta = await attachments.upload(SESSION, { name: 'shot.png', mimeType: 'image/png', data: b64(pngOf(64)) });
    expect(meta).toMatchObject({ name: 'shot.png', mimeType: 'image/png', size: 64, kind: 'image' });
    expect(meta.id).toMatch(/^att_[0-9a-f]{24}$/);
    const file = path.join(root, SESSION, `${meta.id}.bin`);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    const [taken] = await attachments.take(SESSION, [meta.id]);
    expect(taken!.bytes.length).toBe(64);
    await attachments.consume(SESSION, [meta.id]);
    expect(existsSync(file)).toBe(false);
    expect(await refusal(attachments.take(SESSION, [meta.id]))).toMatch(/no longer available/);
  });

  it('enforces the limits per kind: images 5 MB, text 1 MB, other files 10 MB', async () => {
    const attachments = store(path.join(await tempDir(), 'a'));
    const MB = 1024 * 1024;
    expect(await refusal(attachments.upload(SESSION, { name: 'big.png', mimeType: 'image/png', data: b64(pngOf(5 * MB + 1)) }))).toMatch(/Images can be up to 5 MB/);
    await attachments.upload(SESSION, { name: 'ok.png', mimeType: 'image/png', data: b64(pngOf(5 * MB)) });
    expect(await refusal(attachments.upload(SESSION, { name: 'big.md', mimeType: 'text/markdown', data: b64('a'.repeat(MB + 1)) }))).toMatch(/Text files can be up to 1 MB/);
    await attachments.upload(SESSION, { name: 'ok.md', mimeType: 'text/markdown', data: b64('a'.repeat(MB)) });
    await attachments.upload(SESSION, { name: 'ok.pdf', mimeType: 'application/pdf', data: b64(new Uint8Array(10 * MB)) });
    expect(await refusal(attachments.upload(SESSION, { name: 'huge.pdf', mimeType: 'application/pdf', data: b64(new Uint8Array(10 * MB + 1)) }))).toMatch(/Other files can be up to 10 MB/);
  });

  it('checks the bytes: images must be images, text must be readable text', async () => {
    const attachments = store(path.join(await tempDir(), 'a'));
    expect(await refusal(attachments.upload(SESSION, { name: 'fake.png', mimeType: 'image/png', data: b64('not really a png') }))).toMatch(/not a PNG, JPEG, WebP or GIF/);
    expect(await refusal(attachments.upload(SESSION, { name: 'binary.txt', mimeType: 'text/plain', data: b64(Uint8Array.from([0x61, 0, 0x62])) }))).toMatch(/not readable text/);
    // A declared type that is wrong for the bytes is corrected from the bytes.
    const meta = await attachments.upload(SESSION, { name: 'shot.jpg', mimeType: 'image/jpeg', data: b64(Uint8Array.from([...PNG_HEAD, 0, 0])) });
    expect(meta.mimeType).toBe('image/png');
  });

  it('sanitizes names so nothing is written outside the session folder', async () => {
    const root = path.join(await tempDir(), 'attachments');
    const attachments = store(root);
    const meta = await attachments.upload(SESSION, { name: '../../../etc/passwd.txt', mimeType: 'text/plain', data: b64('hello') });
    expect(meta.name).toBe('passwd.txt');
    expect((await readdir(path.join(root, SESSION))).sort()).toEqual([`${meta.id}.bin`, `${meta.id}.json`].sort());
    expect(existsSync(path.join(root, '..', 'etc'))).toBe(false);
  });

  it('refuses credential files and malformed payloads', async () => {
    const attachments = store(path.join(await tempDir(), 'a'));
    expect(await refusal(attachments.upload(SESSION, { name: '.env', mimeType: 'text/plain', data: b64('KEY=1') }))).toMatch(/Credential files cannot be attached/);
    expect(await refusal(attachments.upload(SESSION, { name: 'x.txt', mimeType: 'text/plain', data: 'not base64!' }))).toMatch(/could not be read as a file/);
  });

  it('keeps files of sessions with history off in memory only', async () => {
    const root = path.join(await tempDir(), 'attachments');
    const attachments = store(root, false);
    const meta = await attachments.upload(SESSION, { name: 'shot.png', mimeType: 'image/png', data: b64(pngOf(32)) });
    expect(existsSync(root)).toBe(false);
    expect((await attachments.take(SESSION, [meta.id]))[0]!.bytes.length).toBe(32);
    await attachments.consume(SESSION, [meta.id]);
    expect(attachments.pending(SESSION)).toBe(0);
    expect(existsSync(root)).toBe(false);
  });

  it('finds an id only in the session that owns it', async () => {
    const root = path.join(await tempDir(), 'attachments');
    const attachments = store(root);
    const mine = await attachments.upload(SESSION, { name: 'mine.txt', mimeType: 'text/plain', data: b64('mine') });
    expect(await refusal(attachments.take(OTHER, [mine.id]))).toMatch(/no longer available/);
    await attachments.remove(OTHER, mine.id);
    expect(attachments.pending(SESSION)).toBe(1);
    await attachments.take(SESSION, [mine.id]);
    expect(await refusal(attachments.take(SESSION, ['att_../../x']))).toMatch(/no longer available/);
  });

  it('caps the files waiting in one session and drops them with the session', async () => {
    const root = path.join(await tempDir(), 'attachments');
    const attachments = store(root);
    const ids: string[] = [];
    for (let index = 0; index < 40; index++) ids.push((await attachments.upload(SESSION, { name: `f${index}.txt`, mimeType: 'text/plain', data: b64('x') })).id);
    expect(await refusal(attachments.upload(SESSION, { name: 'one-more.txt', mimeType: 'text/plain', data: b64('x') }))).toMatch(/already has 40 files waiting/);
    await attachments.drop(SESSION);
    expect(existsSync(path.join(root, SESSION))).toBe(false);
    expect(attachments.pending(SESSION)).toBe(0);
  });
});

