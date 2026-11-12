import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createEvent, type EventBody } from '@extalia/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachmentPreviewLoader, ATTACHMENT_PREVIEW_CACHE_LIMITS, promptAttachmentMetadata } from '../src/chat/attachments';
import { projectTranscript, type ToolItem } from '../src/chat/transcript';
import { TranscriptView } from '../src/chat/TranscriptView';
import { MESSAGES } from '../src/i18n';

const REF = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const image = (ref = REF, name = 'viewed.png') => ({ name, kind: 'image' as const, size: 68, ref });
afterEach(() => vi.unstubAllGlobals());
function urls() {
  let sequence = 0;
  const created = vi.fn((_blob: Blob) => `blob:private-${++sequence}`), revoked = vi.fn();
  vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: created, revokeObjectURL: revoked }));
  return { created, revoked };
}
const event = (id: string, body: EventBody, agentId = 'primary') => createEvent({ id, sessionId: 'session', agentId, source: { runtime: 'codex', channel: 'transcript' }, body });
const completed = (id: string, ref = REF) => event(`${id}-result`, { type: 'tool.completed', toolCallId: id, tool: 'view_image', kind: 'read', label: 'Viewed an image', ok: true, attachments: [image(ref)] });
const render = (items: ReturnType<typeof projectTranscript>, language: 'en' | 'id' = 'en', preview = true) => renderToStaticMarkup(createElement(TranscriptView, {
  t: MESSAGES[language], items, language, onDecide: async () => undefined, ...(preview ? { previewAttachment: async () => undefined } : {}),
}));

describe('passive tool image projection and rendering', () => {
  it('matches images to their tool calls in source order even if results arrive out of order, without mutating input', () => {
    const input = [event('prompt', { type: 'prompt.submitted', text: 'Compare images', via: 'native' }),
      event('a', { type: 'tool.started', toolCallId: 'a', tool: 'view_image', kind: 'read', label: 'First image' }),
      event('b', { type: 'tool.started', toolCallId: 'b', tool: 'view_image', kind: 'read', label: 'Second image' }), completed('b', OTHER), completed('a')];
    const before = JSON.stringify(input), items = projectTranscript([...input, input.at(-1)!]);
    const tools = items.filter((item): item is ToolItem => item.kind === 'tool');
    expect(tools.map(tool => [tool.callId, tool.attachments?.[0]?.ref])).toEqual([['a', REF], ['b', OTHER]]);
    expect(JSON.stringify(input)).toBe(before);
  });

  for (const language of ['en', 'id'] as const) it(`shows a single result image independently of folded text in ${language}`, () => {
    const result = completed('image');
    if (result.body.type === 'tool.completed') result.body.output = 'Image result text remains folded.';
    const html = render(projectTranscript([result]), language);
    expect(html).toContain(MESSAGES[language].tool.resultAttachments);
    expect(html).toContain(MESSAGES[language].chat.openAttachment('viewed.png'));
    expect(html).toContain('bubble-thumb-button');
    expect(html).not.toContain('<pre');
    expect(html).not.toContain('Image result text remains folded.');
  });

  it('opens result images in a multi-tool run without also expanding text output', () => {
    const html = render(projectTranscript([completed('image'), event('read-result', { type: 'tool.completed', tool: 'read_file', kind: 'read', label: 'Read file', ok: true })]));
    expect(html).toContain(MESSAGES.en.tool.images(1));
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('bubble-thumb-button');
    expect(html).toContain('tool-run-list');
    expect(html).not.toContain('<pre');
    const noLoader = render(projectTranscript([completed('image'), completed('other')]), 'en', false);
    expect(noLoader).toContain(MESSAGES.en.tool.images(2));
    expect(noLoader).toContain('aria-expanded="false"');
    expect(noLoader).not.toContain('tool-run-list');
  });

  it('keeps worker images in a bounded worker card without adding duplicate primary tool rows', () => {
    const events = [event('prompt', { type: 'prompt.submitted', text: 'Inspect', via: 'native' }),
      event('spawn', { type: 'subagent.spawned', subagentId: 'worker', label: 'Inspector' }),
      event('worker-call', { type: 'tool.started', tool: 'view_image', kind: 'read', label: 'Viewed worker image' }, 'worker')];
    for (let index = 0; index < 12; index++) events.push(event(`worker-result-${index}`, {
      type: 'tool.completed', tool: 'view_image', kind: 'read', label: 'Viewed worker image', ok: true,
      attachments: [image(index.toString(16).padStart(64, '0'), `image-${index}.png`), image(index.toString(16).padStart(64, '0'), `duplicate-${index}.png`)],
    }, 'worker'));
    const items = projectTranscript(events), worker = items.find(item => item.kind === 'worker');
    expect(items.filter(item => item.kind === 'tool')).toEqual([]);
    expect(worker).toMatchObject({ toolCalls: 1, attachments: Array.from({ length: 10 }, (_, index) => image(index.toString(16).padStart(64, '0'), `image-${index}.png`)) });
    const html = render(items);
    expect(html).toContain('Inspector');
    expect(html.match(/bubble-thumb-button/g)).toHaveLength(10);
  });

  it('lists unavailable image metadata literally and never infers passive media from paths, output or URLs', () => {
    const missing = completed('missing');
    if (missing.body.type === 'tool.completed') missing.body.attachments = [{ name: '<img src=x>', kind: 'image', size: 0 }];
    const html = render(projectTranscript([missing]), 'en', false);
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).toContain(MESSAGES.en.chat.imagePreviewUnavailable);
    expect(render(projectTranscript([missing]), 'id', false)).toContain(MESSAGES.id.chat.imagePreviewUnavailable);
    expect(html).not.toContain('<img');
    const ordinary = render(projectTranscript([event('plain', { type: 'tool.completed', tool: 'view_image', kind: 'read', label: 'Viewed an image', target: '/tmp/example.png', output: '![image](https://example.com/image.png)', ok: true })]));
    expect(ordinary).not.toContain('bubble-thumb');
    expect(ordinary).not.toContain('<img');
    expect(promptAttachmentMetadata([image(), { ...image(), size: Number.NaN }, { ...image(), size: Number.POSITIVE_INFINITY }, { ...image(), size: -1 }])).toEqual([image()]);
    expect(promptAttachmentMetadata(Array.from({ length: 30 }, () => image()))).toHaveLength(10);
  });
});

describe('leased session preview memory and validation', () => {
  it('retains a small rendition and opens original bytes only on demand, releasing original URLs independently', async () => {
    const { created, revoked } = urls();
    const closed = vi.fn(), sizes: { width: number; height: number }[] = [];
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 2400, height: 1600, close: closed })));
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(public width: number, public height: number) {}
      getContext() { return { drawImage: vi.fn() }; }
      async convertToBlob() { sizes.push({ width: this.width, height: this.height }); return new Blob(['thumb'], { type: 'image/png' }); }
    });
    const host = { attachmentPreview: vi.fn(async () => ({ mimeType: 'image/png' as const, data: PNG })) };
    const load = attachmentPreviewLoader(host, 'session')!, first = load.acquire!(REF), second = load.acquire!(REF);
    expect(await first.value).toBe('blob:private-1'); expect(await second.value).toBe('blob:private-1');
    expect(sizes).toEqual([{ width: 192, height: 128 }]); expect(closed).toHaveBeenCalledOnce();
    expect(created).toHaveBeenCalledOnce(); expect(created.mock.calls[0]![0].size).toBe(5);
    expect(await first.original!()).toBe('blob:private-2'); expect(await second.original!()).toBe('blob:private-2');
    expect(created.mock.calls[1]![0].size).toBeGreaterThan(5); expect(host.attachmentPreview).toHaveBeenCalledOnce();
    first.closeOriginal!(); expect(revoked).not.toHaveBeenCalled();
    second.closeOriginal!(); expect(revoked).toHaveBeenCalledExactlyOnceWith('blob:private-2');
    expect(await first.original!()).toBe('blob:private-3'); expect(host.attachmentPreview).toHaveBeenCalledOnce();
    first.release(); expect(revoked).toHaveBeenCalledWith('blob:private-3'); expect(revoked).not.toHaveBeenCalledWith('blob:private-1');
    second.release(); expect(revoked).toHaveBeenCalledWith('blob:private-1'); expect(revoked).toHaveBeenCalledTimes(3);
  });

  it('serializes decoded frames and closes every bitmap before retaining the next rendition', async () => {
    const { created } = urls();
    let active = 0, maximum = 0;
    const closed: ReturnType<typeof vi.fn>[] = [];
    vi.stubGlobal('createImageBitmap', vi.fn(async () => {
      active++; maximum = Math.max(maximum, active);
      const close = vi.fn(() => { active--; }); closed.push(close);
      return { width: 1920, height: 1080, close };
    }));
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(public width: number, public height: number) {}
      getContext() { return { drawImage: vi.fn() }; }
      async convertToBlob() { await Promise.resolve(); return new Blob(['thumb'], { type: 'image/png' }); }
    });
    const load = attachmentPreviewLoader({ attachmentPreview: async () => ({ mimeType: 'image/png', data: PNG }) }, 'session')!;
    const leases = [load.acquire!(REF), load.acquire!(OTHER)];
    await Promise.all(leases.map(lease => lease.value));
    expect(maximum).toBe(1); expect(active).toBe(0); expect(closed.every(close => close.mock.calls.length === 1)).toBe(true);
    expect(created).toHaveBeenCalledTimes(2); for (const lease of leases) lease.release();
  });

  it('limits incapable-browser full-image fallbacks to four active previews', async () => {
    const { created, revoked } = urls();
    vi.stubGlobal('createImageBitmap', undefined);
    const load = attachmentPreviewLoader({ attachmentPreview: async () => ({ mimeType: 'image/png', data: PNG }) }, 'session')!;
    const leases = Array.from({ length: 5 }, (_, index) => load.acquire!(index.toString(16).padStart(64, '0')));
    expect((await Promise.all(leases.map(lease => lease.value))).filter(Boolean)).toHaveLength(ATTACHMENT_PREVIEW_CACHE_LIMITS.fallbackEntries);
    expect(created).toHaveBeenCalledTimes(4); for (const lease of leases) lease.release(); expect(revoked).toHaveBeenCalledTimes(4);
  });

  it('shares a URL across active consumers and never revokes it before the final release, including disposal', async () => {
    const { created, revoked } = urls();
    const host = { attachmentPreview: vi.fn(async () => ({ mimeType: 'image/png' as const, data: PNG })) };
    const load = attachmentPreviewLoader(host, 'session')!, first = load.acquire!(REF), second = load.acquire!(REF);
    expect(await first.value).toBe('blob:private-1'); expect(await second.value).toBe('blob:private-1');
    expect(host.attachmentPreview).toHaveBeenCalledOnce(); expect(created).toHaveBeenCalledOnce();
    first.release(); load.dispose!(); expect(revoked).not.toHaveBeenCalled();
    second.release(); second.release(); expect(revoked).toHaveBeenCalledExactlyOnceWith('blob:private-1');
    expect(await load(REF)).toBeUndefined();
  });

  it('drops unmounted queued work before making another host read and releases the active image', async () => {
    const { revoked } = urls();
    let resolve!: (value: { mimeType: 'image/png'; data: string }) => void;
    const host = { attachmentPreview: vi.fn(() => new Promise<{ mimeType: 'image/png'; data: string }>(done => { resolve = done; })) };
    const load = attachmentPreviewLoader(host, 'session')!, first = load.acquire!(REF), second = load.acquire!(OTHER);
    await vi.waitFor(() => expect(host.attachmentPreview).toHaveBeenCalledOnce());
    second.release(); resolve({ mimeType: 'image/png', data: PNG });
    expect(await first.value).toBe('blob:private-1'); expect(await second.value).toBeUndefined();
    expect(host.attachmentPreview).toHaveBeenCalledOnce();
    first.release(); expect(revoked).toHaveBeenCalledOnce();
  });

  it('keeps direct caches bounded, isolates loader lifetimes and retries missing images', async () => {
    const { revoked } = urls();
    const host = { attachmentPreview: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue({ mimeType: 'image/png', data: PNG }) };
    const load = attachmentPreviewLoader(host, 'session')!;
    expect(await load(REF)).toBeUndefined(); expect(await load(REF)).toBe('blob:private-1');
    for (let index = 0; index < ATTACHMENT_PREVIEW_CACHE_LIMITS.entries; index++) await load(index.toString(16).padStart(64, '0'));
    expect(revoked).toHaveBeenCalledWith('blob:private-1');
    const other = attachmentPreviewLoader(host, 'other-session')!, lease = other.acquire!(REF); await lease.value;
    expect(host.attachmentPreview).toHaveBeenLastCalledWith('other-session', REF);
    load.dispose!(); lease.release();
  });

  it('refuses new blob allocations above the byte budget while existing images stay leased', async () => {
    const { created, revoked } = urls();
    const data = btoa('\x89PNG\r\n\x1a\n' + '\0'.repeat(5 * 1024 * 1024 - 8));
    const host = { attachmentPreview: vi.fn(async () => ({ mimeType: 'image/png' as const, data })) };
    const load = attachmentPreviewLoader(host, 'session')!;
    const leases = Array.from({ length: 4 }, (_, index) => load.acquire!(index.toString(16).padStart(64, '0')));
    expect((await Promise.all(leases.map(lease => lease.value))).filter(Boolean)).toHaveLength(3);
    expect(created).toHaveBeenCalledTimes(3); expect(revoked).not.toHaveBeenCalled();
    for (const lease of leases) lease.release();
    expect(revoked).toHaveBeenCalledTimes(3);
  });

  it('rejects invalid refs, malformed data and mismatched or executable image types before creating URLs', async () => {
    const { created } = urls();
    const host = { attachmentPreview: vi.fn().mockResolvedValueOnce({ mimeType: 'image/png', data: '<svg/>' })
      .mockResolvedValueOnce({ mimeType: 'image/jpeg', data: PNG }).mockResolvedValueOnce({ mimeType: 'image/svg+xml', data: PNG }) };
    const load = attachmentPreviewLoader(host as never, 'session')!;
    expect(await load('../image.png')).toBeUndefined(); expect(host.attachmentPreview).not.toHaveBeenCalled();
    expect(await load(`${REF}\n`)).toBeUndefined(); expect(host.attachmentPreview).not.toHaveBeenCalled();
    expect(promptAttachmentMetadata([{ ...image(), ref: `${REF}\n` }])[0]?.ref).toBeUndefined();
    expect(await load(REF)).toBeUndefined(); expect(await load(REF)).toBeUndefined(); expect(await load(REF)).toBeUndefined();
    expect(created).not.toHaveBeenCalled();
  });
});
