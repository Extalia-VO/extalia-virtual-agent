import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, parseEvent } from '../src/index.js';

const base = { v: PROTOCOL_VERSION, id: 'evt-1', at: '2026-01-31T12:00:00.000Z', sessionId: 'session-1', source: { runtime: 'extalia-native', channel: 'stream' } };

describe('prompt.submitted attachments (v0.0.49)', () => {
  it('records the names, kinds and sizes of attached files', () => {
    const result = parseEvent({ ...base, body: { type: 'prompt.submitted', text: 'See the screenshot', via: 'extalia', attachments: [{ name: 'shot.png', kind: 'image', size: 2048 }, { name: 'notes.md', kind: 'text', size: 12 }] } });
    expect(result.ok).toBe(true);
  });

  it('refuses unknown fields, unknown kinds, too many files and content fields', () => {
    const bad = (attachments: unknown) => parseEvent({ ...base, body: { type: 'prompt.submitted', text: 'x', via: 'extalia', attachments } });
    expect(bad([{ name: 'a.png', kind: 'video', size: 1 }])).toMatchObject({ ok: false, code: 'invalid' });
    expect(bad([{ name: 'a.png', kind: 'image', size: 1, data: 'AAAA' }])).toMatchObject({ ok: false, code: 'invalid' });
    expect(bad([{ name: 'a.png', kind: 'image', size: -1 }])).toMatchObject({ ok: false, code: 'invalid' });
    expect(bad(Array.from({ length: 11 }, (_, index) => ({ name: `f${index}.txt`, kind: 'file', size: 1 })))).toMatchObject({ ok: false, code: 'invalid' });
    expect(bad('a.png')).toMatchObject({ ok: false, code: 'invalid' });
  });
});
