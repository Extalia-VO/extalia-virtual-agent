import { createEvent } from '@extalia/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TranscriptView } from '../src/chat/TranscriptView';
import { MESSAGES } from '../src/i18n';
import { describe, expect, it, vi } from 'vitest';
import { attachmentPreviewLoader, promptAttachmentMetadata } from '../src/chat/attachments';
import { projectTranscript } from '../src/chat/transcript';

const REF = 'c'.repeat(64);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('attachments shown in message details', () => {
  it('keeps the image reference of observed prompts and drops malformed ones', () => {
    expect(promptAttachmentMetadata([
      { name: 'shot.png', kind: 'image', size: 68, ref: REF },
      { name: 'notes.md', kind: 'text', size: 10, ref: '../etc' },
    ])).toEqual([{ name: 'shot.png', kind: 'image', size: 68, ref: REF }, { name: 'notes.md', kind: 'text', size: 10 }]);
    const items = projectTranscript([createEvent({ id: 'p', sessionId: 's', source: { runtime: 'codex', channel: 'transcript' },
      body: { type: 'prompt.submitted', text: 'Look', via: 'native', attachments: [{ name: 'shot.png', kind: 'image', size: 68, ref: REF }] } })]);
    expect(items[0]).toMatchObject({ kind: 'user', attachments: [{ ref: REF }] });
  });

  it('loads each image once per session and retries one the host did not have yet', async () => {
    const created: Blob[] = [];
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: (blob: Blob) => { created.push(blob); return `blob:${created.length}`; } }));
    const attachmentPreview = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue({ mimeType: 'image/png', data: PNG });
    const load = attachmentPreviewLoader({ attachmentPreview }, 'session-x')!;
    expect(await load(REF)).toBeUndefined();
    expect(await load(REF)).toBe('blob:1');
    expect(await load(REF)).toBe('blob:1');
    expect(attachmentPreview).toHaveBeenCalledTimes(2);
    expect(created[0]!.type).toBe('image/png');
    expect(attachmentPreviewLoader({}, 'session-x')).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('shows a thumbnail button for a kept image and a plain row for other files', () => {
    const items = projectTranscript([createEvent({ id: 'p', sessionId: 's', source: { runtime: 'codex', channel: 'transcript' },
      body: { type: 'prompt.submitted', text: 'Look', via: 'native', attachments: [{ name: 'shot.png', kind: 'image', size: 68, ref: REF }, { name: 'notes.md', kind: 'text', size: 2048 }] } })]);
    const html = renderToStaticMarkup(createElement(TranscriptView, { t: MESSAGES.en, items, language: 'en', onDecide: async () => undefined, previewAttachment: async () => undefined }));
    expect(html).toContain('bubble-thumb-button');
    expect(html).toContain('aria-label="Open shot.png"');
    expect(html).toContain('notes.md');
    // Without a loader every file is listed by name.
    const plain = renderToStaticMarkup(createElement(TranscriptView, { t: MESSAGES.en, items, language: 'en', onDecide: async () => undefined }));
    expect(plain).not.toContain('bubble-thumb');
  });
});

describe('tool calls in message details', () => {
  const tool = (id: string, activity: 'command' | 'read' | 'edit', status: 'ok' | 'failed' | 'running' = 'ok') =>
    ({ kind: 'tool' as const, id, tool: 'x', activity, label: `Step ${id}`, status, files: [] });

  it('groups consecutive calls into one run and keeps everything else in place', async () => {
    const { groupToolRuns } = await import('../src/chat/TranscriptView');
    const items = [tool('a', 'command'), tool('b', 'read'), { kind: 'assistant' as const, id: 'r', text: 'Done', streaming: false }, tool('c', 'edit')];
    expect(groupToolRuns(items).map(entry => Array.isArray(entry) ? entry.map(item => item.id) : entry.kind)).toEqual([['a', 'b'], 'assistant', ['c']]);
    // A run grows with every new call until the agent writes again; workers form their own run.
    const worker = (id: string) => ({ kind: 'worker' as const, id, subagentId: id, state: 'idle' as const, status: 'ok' as const, toolCalls: 0 });
    const grown = [...items, tool('d', 'command'), worker('w1'), worker('w2')];
    expect(groupToolRuns(grown).map(entry => Array.isArray(entry) ? entry.map(item => item.id) : entry.kind)).toEqual([['a', 'b'], 'assistant', ['c', 'd'], ['w1', 'w2']]);
  });

  it('summarises a run by what it did, in both languages', async () => {
    const { toolRunSummary } = await import('../src/chat/TranscriptView');
    const run = [tool('1', 'command'), tool('2', 'command'), tool('3', 'command'), tool('4', 'read'), tool('5', 'read'), tool('6', 'edit')];
    expect(toolRunSummary(MESSAGES.en, run)).toBe('Ran 3 commands, read 2 files and edited a file');
    expect(toolRunSummary(MESSAGES.id, run.slice(0, 3))).toBe('Menjalankan 3 perintah');
  });

  it('renders a finished run folded under its summary and a running run open', async () => {
    const { TranscriptView } = await import('../src/chat/TranscriptView');
    const render = (items: unknown[]) => renderToStaticMarkup(createElement(TranscriptView, { t: MESSAGES.en, items: items as never, language: 'en', onDecide: async () => undefined }));
    const done = render([tool('a', 'command'), tool('b', 'command', 'failed')]);
    expect(done).toContain('Ran 2 commands');
    expect(done).toContain('1 failed');
    expect(done).not.toContain('tool-run-list');
    const running = render([tool('a', 'command'), tool('b', 'command', 'running')]);
    expect(running).toContain('tool-run-list');
    expect((running.match(/class="tool-row /g) ?? []).length).toBe(2);
    // A single call shows as its row, without a summary line.
    const single = render([tool('a', 'read')]);
    expect(single).not.toContain('tool-run-head');
    expect(single).toContain('Step a');
  });
});
