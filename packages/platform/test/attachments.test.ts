import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_LIMITS, MAX_ATTACHMENT_BASE64_CHARS, MAX_ATTACHMENT_REQUEST_BYTES, classifyAttachment, decodeAttachmentData, detectImageMimeType, isCredentialFileName,
  isReadableText, normalizeAttachmentUpload, normalizeMimeType, normalizePromptAttachmentIds, normalizeSessionOptions, sanitizeAttachmentName,
} from '../src/index.js';

/** Web and Node globals, typed here because this package is compiled without Node typings. */
const globals = globalThis as unknown as { btoa(value: string): string; TextEncoder: new () => { encode(value: string): Uint8Array } };
const base64 = (bytes: number[] | Uint8Array) => globals.btoa(String.fromCharCode(...bytes));
const encode = (text: string) => new globals.TextEncoder().encode(text);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe('attachment names', () => {
  it('keeps the last path segment only and strips unsafe characters', () => {
    expect(sanitizeAttachmentName('../../etc/passwd.txt')).toBe('passwd.txt');
    expect(sanitizeAttachmentName('C:\\Users\\me\\notes.md')).toBe('notes.md');
    expect(sanitizeAttachmentName('bad\u0000name\r\n<>:"|?*.txt')).toBe('badname_______.txt');
    expect(sanitizeAttachmentName('  .hidden  ')).toBe('hidden');
    expect(sanitizeAttachmentName('   ')).toBe('attachment');
    expect(sanitizeAttachmentName('a  b\t c.txt')).toBe('a b c.txt');
  });

  it('limits the length and keeps a short extension', () => {
    const name = sanitizeAttachmentName(`${'n'.repeat(300)}.pdf`);
    expect(name.length).toBe(ATTACHMENT_LIMITS.nameLength);
    expect(name.endsWith('.pdf')).toBe(true);
  });
});

describe('attachment kinds and types', () => {
  it('classifies images, text and other files by declared type and extension', () => {
    expect(classifyAttachment('shot.png', 'image/png')).toEqual({ kind: 'image', mimeType: 'image/png' });
    expect(classifyAttachment('photo.JPG', '')).toEqual({ kind: 'image', mimeType: 'image/jpeg' });
    expect(classifyAttachment('notes.md', '')).toEqual({ kind: 'text', mimeType: 'text/markdown' });
    expect(classifyAttachment('notes.md', 'text/markdown; charset=utf-8')).toEqual({ kind: 'text', mimeType: 'text/markdown' });
    expect(classifyAttachment('data.json', 'application/json')).toEqual({ kind: 'text', mimeType: 'application/json' });
    expect(classifyAttachment('app.ts', 'video/mp2t')).toEqual({ kind: 'text', mimeType: 'text/plain' });
    expect(classifyAttachment('vector.svg', 'image/svg+xml')).toEqual({ kind: 'file', mimeType: 'image/svg+xml' });
    expect(classifyAttachment('report.pdf', 'application/pdf')).toEqual({ kind: 'file', mimeType: 'application/pdf' });
    expect(classifyAttachment('mystery.bin', '')).toEqual({ kind: 'file', mimeType: 'application/octet-stream' });
  });

  it('reads the type a browser declares in a normalized form', () => {
    expect(normalizeMimeType(' Image/JPG ; x=1')).toBe('image/jpeg');
    expect(normalizeMimeType('not a type')).toBe('');
    expect(normalizeMimeType(42)).toBe('');
  });

  it('refuses credential files by name', () => {
    for (const name of ['.env', '.env.local', 'server.key', 'keys/id_ed25519', '.npmrc', 'credentials', 'x/.netrc']) expect(isCredentialFileName(name)).toBe(true);
    for (const name of ['env.md', 'keyboard.txt', 'notes.pem.md']) expect(isCredentialFileName(name)).toBe(false);
  });

  it('detects image bytes and readable text', () => {
    expect(detectImageMimeType(PNG)).toBe('image/png');
    expect(detectImageMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(detectImageMimeType(new Uint8Array([...encode('GIF89a'), 0, 0]))).toBe('image/gif');
    expect(detectImageMimeType(new Uint8Array([...encode('RIFF'), 0, 0, 0, 0, ...encode('WEBP')]))).toBe('image/webp');
    expect(detectImageMimeType(encode('hello'))).toBeUndefined();
    expect(isReadableText(encode('héllo\n'))).toBe(true);
    expect(isReadableText(new Uint8Array([0x61, 0, 0x62]))).toBe(false);
    expect(isReadableText(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe(false);
  });
});

describe('attachment payloads', () => {
  it('decodes strictly and enforces the byte limit', () => {
    expect(Array.from(decodeAttachmentData(base64([1, 2, 3])))).toEqual([1, 2, 3]);
    expect(() => decodeAttachmentData('not base64!')).toThrow(/base64|too large/);
    expect(() => decodeAttachmentData('AAA')).toThrow(/base64|too large/);
    expect(() => decodeAttachmentData(base64(new Uint8Array(11)), 10)).toThrow(/too large/);
    expect(decodeAttachmentData(base64(new Uint8Array(10)), 10).length).toBe(10);
  });

  it('bounds an upload and its request body', () => {
    expect(MAX_ATTACHMENT_BASE64_CHARS).toBe(Math.ceil((10 * 1024 * 1024) / 3) * 4);
    expect(MAX_ATTACHMENT_REQUEST_BYTES).toBeGreaterThan(MAX_ATTACHMENT_BASE64_CHARS);
    expect(normalizeAttachmentUpload({ name: 'a.txt', mimeType: 'text/plain', data: 'aGk=' })).toEqual({ name: 'a.txt', mimeType: 'text/plain', data: 'aGk=' });
    expect(() => normalizeAttachmentUpload({ name: 'a.txt', data: 'aGk=', path: '/etc/passwd' })).toThrow('Invalid file upload.');
    expect(() => normalizeAttachmentUpload({ name: 3, data: 'aGk=' })).toThrow('needs a name');
    expect(() => normalizeAttachmentUpload({ name: 'a.txt', data: 7 })).toThrow('too large');
    expect(() => normalizeAttachmentUpload({ name: 'a.txt', data: 'A'.repeat(MAX_ATTACHMENT_BASE64_CHARS + 4) })).toThrow('too large');
    expect(() => normalizeAttachmentUpload('x')).toThrow('Invalid file upload.');
  });

  it('accepts ten attachment ids per prompt, each well formed and unique', () => {
    const ids = Array.from({ length: 10 }, (_, index) => `att_${index.toString(16).padStart(24, '0')}`);
    expect(normalizePromptAttachmentIds({ attachmentIds: ids })).toEqual(ids);
    expect(normalizePromptAttachmentIds(undefined)).toEqual([]);
    expect(normalizePromptAttachmentIds({})).toEqual([]);
    expect(() => normalizePromptAttachmentIds({ attachmentIds: [...ids, `att_${'b'.repeat(24)}`] })).toThrow('up to 10');
    expect(() => normalizePromptAttachmentIds({ attachmentIds: ['../../secret'] })).toThrow('not valid');
    expect(() => normalizePromptAttachmentIds({ attachmentIds: [ids[0], ids[0]] })).toThrow('twice');
    expect(() => normalizePromptAttachmentIds({ attachmentIds: 'att' })).toThrow('must be a list');
    expect(() => normalizePromptAttachmentIds('att')).toThrow('Invalid prompt options.');
  });
});

describe('session permission mode option', () => {
  it('accepts the four modes and empty values, and refuses anything else', () => {
    for (const permissionMode of ['workspace', 'ask', 'accept-edits', 'plan']) expect(normalizeSessionOptions({ permissionMode })).toEqual({ permissionMode });
    expect(normalizeSessionOptions({ permissionMode: '' })).toEqual({});
    expect(normalizeSessionOptions({ permissionMode: null })).toEqual({});
    expect(() => normalizeSessionOptions({ permissionMode: 'yolo' })).toThrow('permission mode');
    expect(() => normalizeSessionOptions({ permissionMode: 'allow' })).toThrow('permission mode');
  });
});
