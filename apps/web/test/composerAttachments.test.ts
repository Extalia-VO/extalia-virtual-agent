import { describe, expect, it, vi } from 'vitest';
import {
  ATTACHMENT_LIMITS, AttachmentUploadError, MAX_ATTACHMENTS, attachmentKind, attachmentRejection, fileToBase64, formatBytes, planAttachments,
  promptAttachmentMetadata, sendPromptWithAttachments, uploadAttachments, type AttachmentHostApi, type PendingAttachment,
} from '../src/chat/attachments';

const MB = 1024 * 1024;

function chip(name: string, overrides: Partial<PendingAttachment> = {}): PendingAttachment {
  const file = new File(['hello'], name, { type: overrides.mimeType ?? 'text/plain' });
  return { key: name, file, name, mimeType: file.type, size: file.size, kind: 'text', status: 'ready', ...overrides };
}

describe('attachment kinds', () => {
  it('classifies by MIME type, then by extension when the browser reports none', () => {
    expect(attachmentKind('photo.png', 'image/png')).toBe('image');
    expect(attachmentKind('photo.JPG', '')).toBe('image');
    expect(attachmentKind('notes.md', '')).toBe('text');
    expect(attachmentKind('data.json', 'application/json')).toBe('text');
    expect(attachmentKind('readme.txt', 'text/plain; charset=utf-8')).toBe('text');
    expect(attachmentKind('report.pdf', 'application/pdf')).toBe('file');
    expect(attachmentKind('logo.svg', 'image/svg+xml')).toBe('file');
    expect(attachmentKind('archive.zip', 'application/octet-stream')).toBe('file');
  });
});

describe('attachment limits', () => {
  it('uses 5 MB for images, 1 MB for text-like files and 10 MB for other files', () => {
    expect(ATTACHMENT_LIMITS).toEqual({ image: 5 * MB, text: MB, file: 10 * MB });
    expect(attachmentRejection({ name: 'a.png', type: 'image/png', size: 5 * MB }, 0)).toBeUndefined();
    expect(attachmentRejection({ name: 'a.png', type: 'image/png', size: 5 * MB + 1 }, 0)).toEqual({ reason: 'size', limit: 5 * MB });
    expect(attachmentRejection({ name: 'a.md', type: '', size: MB + 1 }, 0)).toEqual({ reason: 'size', limit: MB });
    expect(attachmentRejection({ name: 'a.pdf', type: 'application/pdf', size: 9 * MB }, 0)).toBeUndefined();
    expect(attachmentRejection({ name: 'a.pdf', type: 'application/pdf', size: 11 * MB }, 0)).toEqual({ reason: 'size', limit: 10 * MB });
  });

  it('allows up to 10 files per message', () => {
    expect(MAX_ATTACHMENTS).toBe(10);
    expect(attachmentRejection({ name: 'a.txt', type: 'text/plain', size: 1 }, 9)).toBeUndefined();
    expect(attachmentRejection({ name: 'a.txt', type: 'text/plain', size: 1 }, 10)).toEqual({ reason: 'count' });
  });

  it('plans a batch in order: accepts what fits and says why the rest was refused', () => {
    const files = [
      { name: 'one.txt', type: 'text/plain', size: 10 },
      { name: 'big.md', type: 'text/markdown', size: 2 * MB },
      { name: 'two.png', type: 'image/png', size: 10 },
      { name: 'three.pdf', type: 'application/pdf', size: 10 },
    ];
    const plan = planAttachments(0, files);
    expect(plan.accepted.map(file => file.name)).toEqual(['one.txt', 'two.png', 'three.pdf']);
    expect(plan.rejected.map(item => [item.name, item.rejection.reason])).toEqual([['big.md', 'size']]);

    const crowded = planAttachments(8, [{ name: 'a.txt', type: '', size: 1 }, { name: 'b.txt', type: '', size: 1 }, { name: 'c.txt', type: '', size: 1 }]);
    expect(crowded.accepted).toHaveLength(2);
    expect(crowded.rejected).toEqual([{ file: expect.anything(), name: 'c.txt', rejection: { reason: 'count' } }]);
  });

  it('formats sizes briefly', () => {
    expect(formatBytes(812)).toBe('812 B');
    expect(formatBytes(14 * 1024)).toBe('14 KB');
    expect(formatBytes(2.4 * MB)).toBe('2.4 MB');
    expect(formatBytes(12 * MB)).toBe('12 MB');
    expect(formatBytes(-1)).toBe('0 B');
  });
});

describe('uploading attachments', () => {
  it('uploads each pending file once, in order, and reuses the ids of files already uploaded', async () => {
    const uploadAttachment = vi.fn(async (_session: string, input: { name: string }) => ({ id: `id-${input.name}`, name: input.name, mimeType: 'text/plain', size: 5, kind: 'text' as const }));
    const host: AttachmentHostApi = { sendPrompt: vi.fn(async () => undefined), uploadAttachment };
    const patches: [string, Partial<PendingAttachment>][] = [];
    const chips = [chip('a.txt', { status: 'uploaded', attachmentId: 'kept' }), chip('b.txt'), chip('c.txt')];
    const ids = await uploadAttachments(host, 'session-1', chips, (key, change) => patches.push([key, change]));
    expect(ids).toEqual(['kept', 'id-b.txt', 'id-c.txt']);
    expect(uploadAttachment).toHaveBeenCalledTimes(2);
    expect(uploadAttachment.mock.calls[0]![1]).toMatchObject({ name: 'b.txt', mimeType: 'text/plain', data: btoa('hello') });
    expect(patches).toEqual([
      ['b.txt', { status: 'uploading', error: undefined }],
      ['b.txt', { status: 'uploaded', attachmentId: 'id-b.txt' }],
      ['c.txt', { status: 'uploading', error: undefined }],
      ['c.txt', { status: 'uploaded', attachmentId: 'id-c.txt' }],
    ]);
  });

  it('stops at the first failure, marks that chip failed and keeps the uploaded ones', async () => {
    const uploadAttachment = vi.fn(async (_session: string, input: { name: string }) => {
      if (input.name === 'bad.txt') throw new Error('The file is too large.');
      return { id: `id-${input.name}`, name: input.name, mimeType: 'text/plain', size: 5, kind: 'text' as const };
    });
    const host: AttachmentHostApi = { sendPrompt: vi.fn(async () => undefined), uploadAttachment };
    const patches: [string, Partial<PendingAttachment>][] = [];
    const chips = [chip('ok.txt'), chip('bad.txt'), chip('later.txt')];
    await expect(uploadAttachments(host, 's', chips, (key, change) => patches.push([key, change]))).rejects.toBeInstanceOf(AttachmentUploadError);
    expect(uploadAttachment).toHaveBeenCalledTimes(2);
    expect(patches.at(-1)).toEqual(['bad.txt', { status: 'failed', error: 'The file is too large.' }]);
  });

  it('refuses to upload where the host has no attachment support', async () => {
    const host: AttachmentHostApi = { sendPrompt: vi.fn(async () => undefined) };
    await expect(uploadAttachments(host, 's', [chip('a.txt')], () => undefined)).rejects.toThrow('not available');
  });

  it('encodes bytes as base64', async () => {
    expect(await fileToBase64(new Blob([new Uint8Array([0, 255, 16])]))).toBe(btoa(String.fromCharCode(0, 255, 16)));
  });

  it('sends the prompt with its attachment ids only when there are some', async () => {
    const sendPrompt = vi.fn(async () => undefined);
    const host: AttachmentHostApi = { sendPrompt };
    await sendPromptWithAttachments(host, 's', 'hi', []);
    expect(sendPrompt).toHaveBeenLastCalledWith('s', 'hi');
    await sendPromptWithAttachments(host, 's', 'hi', ['a', 'b']);
    expect(sendPrompt).toHaveBeenLastCalledWith('s', 'hi', { attachmentIds: ['a', 'b'] });
  });
});

describe('prompt attachment metadata', () => {
  it('keeps well-formed names, kinds and sizes and drops anything else', () => {
    expect(promptAttachmentMetadata([
      { name: 'a.png', kind: 'image', size: 120 },
      { name: 'b.md', kind: 'text', size: 3 },
      { name: 'c.pdf', kind: 'pdf', size: 3 },
      { name: 4, kind: 'file', size: 3 },
      null,
      { name: 'd.bin', kind: 'file', size: -5 },
    ])).toEqual([
      { name: 'a.png', kind: 'image', size: 120 },
      { name: 'b.md', kind: 'text', size: 3 },
      { name: 'd.bin', kind: 'file', size: 0 },
    ]);
    expect(promptAttachmentMetadata(undefined)).toEqual([]);
    expect(promptAttachmentMetadata('a.png')).toEqual([]);
  });
});
