import { describe, expect, it } from 'vitest';
import { MAX_INLINE_IMAGE_BYTES, codexEventAttachments, parseClaude, parseCodex, promptAttachments, type TranscriptStep } from '../src/index.js';

// A 1×1 transparent PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const prompts = (steps: TranscriptStep[] | undefined) => (steps ?? []).filter((step): step is Extract<TranscriptStep, { type: 'prompt' }> => step.type === 'prompt');

describe('prompt attachments in native transcripts', () => {
  it('reads every content-part shape the supported apps record', () => {
    const files = promptAttachments([
      { type: 'text', text: 'Look at this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      { type: 'input_image', image_url: `data:image/png;base64,${PNG}` },
      { type: 'image_url', image_url: { url: 'https://example.test/shot.jpg' } },
      { inlineData: { mimeType: 'image/png', data: PNG } },
      { type: 'document', title: 'spec.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' } },
    ]);
    expect(files.map(file => [file.name, file.kind, Boolean(file.data)])).toEqual([
      ['image-1.png', 'image', true], ['image-2.png', 'image', true], ['shot.jpg', 'image', false], ['image-4.png', 'image', true], ['spec.pdf', 'file', false],
    ]);
    expect(files[0]!.size).toBe(68);
    expect(files[0]!.mimeType).toBe('image/png');
  });

  it('lists oversized or unknown images by name without their bytes', () => {
    const big = 'A'.repeat(Math.ceil((MAX_INLINE_IMAGE_BYTES + 10) / 3) * 4);
    expect(promptAttachments([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } }])[0]!.data).toBeUndefined();
    expect(promptAttachments([{ type: 'image', source: { type: 'base64', media_type: 'image/tiff', data: PNG } }])[0]!.data).toBeUndefined();
    expect(codexEventAttachments({ images: [`data:image/png;base64,${PNG}`], local_images: ['/tmp/shots/screen.png'] }).map(file => file.name)).toEqual(['image-1.png', 'screen.png']);
  });

  it('attaches Claude image blocks to the prompt of the same row, also when the prompt is only an image', () => {
    const rows = [
      { type: 'user', uuid: 'u1', sessionId: 's', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: [
        { type: 'text', text: 'What is wrong here?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] } },
      { type: 'user', uuid: 'u2', parentUuid: 'u1', sessionId: 's', timestamp: '2026-01-01T00:01:00Z', message: { role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] } },
    ];
    const result = parseClaude(rows.map(row => JSON.stringify(row)).join('\n'), { sourceId: 'claude-code', nativeSessionId: 's' });
    const [first, second] = prompts(result.steps);
    expect(first).toMatchObject({ text: 'What is wrong here?', attachments: [{ kind: 'image', name: 'image-1.png' }] });
    expect(second).toMatchObject({ text: '', attachments: [{ kind: 'image' }] });
  });

  it('attaches Codex input images to the user message', () => {
    const rows = [
      { type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { id: 'c1', cwd: '/w' } },
      { type: 'response_item', timestamp: '2026-01-01T00:00:01Z', payload: { type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'Fix the layout' }, { type: 'input_image', image_url: `data:image/png;base64,${PNG}` }] } },
    ];
    const result = parseCodex(rows.map(row => JSON.stringify(row)).join('\n'), { sourceId: 'codex' });
    expect(prompts(result.steps)[0]).toMatchObject({ text: 'Fix the layout', attachments: [{ kind: 'image', data: PNG }] });
  });
});
