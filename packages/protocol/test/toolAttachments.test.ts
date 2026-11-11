import { describe, expect, it } from 'vitest';
import { createEvent, parseEvent } from '../src/index.js';

const completed = { type: 'tool.completed' as const, toolCallId: 'image-call', tool: 'view_image', kind: 'read' as const,
  label: 'Viewed an image', ok: true };
const image = { name: 'screenshot.png', kind: 'image', size: 2048, ref: 'a'.repeat(64) };
const event = createEvent({ sessionId: 'observed-session', source: { runtime: 'codex', channel: 'import' }, body: completed });

describe('tool result image metadata', () => {
  it('accepts legacy results and bounded private references without image bytes', () => {
    expect(parseEvent(event).ok).toBe(true);
    expect(parseEvent({ ...event, body: { ...completed, attachments: [image] } }).ok).toBe(true);
    expect(parseEvent({ ...event, body: { ...completed, attachments: [{ name: 'missing.png', kind: 'image', size: 0 }] } }).ok).toBe(true);
  });

  it.each([
    { ...image, data: 'AAAA' }, { ...image, url: 'https://example.com/image.png' },
    { ...image, path: '/tmp/image.png' }, { ...image, ref: 'file:///tmp/image.png' },
    { ...image, ref: `${'a'.repeat(64)}\n` }, { ...image, ref: 'A'.repeat(64) },
    { ...image, kind: 'video' }, { ...image, size: -1 },
  ])('rejects raw payloads, paths and invalid references: %j', attachment => {
    expect(parseEvent({ ...event, body: { ...completed, attachments: [attachment] } }).ok).toBe(false);
  });

  it('rejects more than ten result attachments', () => {
    expect(parseEvent({ ...event, body: { ...completed, attachments: Array.from({ length: 11 }, () => image) } }).ok).toBe(false);
  });
});
