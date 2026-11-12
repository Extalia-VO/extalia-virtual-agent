import { describe, expect, it } from 'vitest';
import { MAX_INLINE_IMAGE_BYTES, parseCodex, toolImageOutputText, toolResultAttachments, type TranscriptStep } from '../src/index.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const resultOf = (steps: TranscriptStep[] | undefined) => steps?.filter((step): step is Extract<TranscriptStep, { type: 'tool.result' }> => step.type === 'tool.result');
const parse = (output: unknown, options: { tool?: string; callId?: string; resultId?: string; path?: string; status?: string; name?: string } = {}) => parseCodex([
  { type: 'session_meta', payload: { id: 'fixture', cwd: '/projects/example' } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect the screenshot.' }] } },
  { type: 'response_item', payload: { type: 'function_call', call_id: options.callId ?? 'call-image', name: options.tool ?? 'view_image', arguments: JSON.stringify({ path: options.path ?? '/projects/example/shot.png' }) } },
  { type: 'response_item', payload: { type: 'function_call_output', call_id: options.resultId ?? options.callId ?? 'call-image', output, ...(options.status ? { status: options.status } : {}), ...(options.name ? { name: options.name } : {}) } },
].map(value => JSON.stringify(value)).join('\n'), { sourceId: 'codex', nativeSessionId: 'fixture' });

describe('structured tool images in Codex observation steps', () => {
  it.each([
    { type: 'input_image', image_url: `data:image/png;base64,${PNG}` },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
    { type: 'image', data: PNG, mimeType: 'image/png' },
    { type: 'image', source: { type: 'base64', data: PNG, media_type: 'image/png' } },
  ])('keeps an explicit image block without image bytes in portable text: $type', image => {
    const result = parse([{ type: 'text', text: 'Screenshot inspected.' }, image]);
    expect(resultOf(result.steps)?.[0]).toMatchObject({ ok: true, attachments: [{ kind: 'image', size: 68, mimeType: 'image/png', data: PNG }], output: 'Screenshot inspected.' });
    expect(JSON.stringify(result.session)).not.toContain(PNG);
    expect(JSON.stringify(result.session)).not.toContain('data:image');
  });

  it('uses a private path candidate only for an exact successful matched view_image call', () => {
    expect(resultOf(parse('Viewed image.').steps)?.[0]).toMatchObject({ imagePath: '/projects/example/shot.png', attachments: [{ name: 'shot.png', size: 0 }] });
    expect(resultOf(parse('Viewed image.', { tool: 'functions.view_image' }).steps)?.[0]?.imagePath).toBe('/projects/example/shot.png');
    for (const options of [{ tool: 'read_file' }, { resultId: 'other-call' }, { name: 'read_file' }, { status: 'cancelled' }])
      expect(resultOf(parse('Viewed image.', options).steps)?.[0]?.imagePath).toBeUndefined();
    for (const output of [{ is_error: true }, { success: false }, 'Tool execution was aborted by the user.', 'Cancelled by user.', [{ type: 'text', text: 'Error: permission denied' }]])
      expect(resultOf(parse(output).steps)?.[0]).toMatchObject({ ok: false });
  });

  it('does not read image-looking strings, Markdown, remote URLs or oversized bytes', () => {
    expect(toolResultAttachments(`![image](https://example.com/shot.png)`)).toEqual([]);
    expect(toolResultAttachments('Viewed an image: /projects/example/shot.png')).toEqual([]);
    const remote = toolResultAttachments([{ type: 'input_image', image_url: 'https://example.com/shot.png' }]);
    expect(remote).toEqual([{ name: 'shot.png', kind: 'image', size: 0 }]);
    expect(toolImageOutputText([{ type: 'text', text: 'Image preview' }, { type: 'input_image', image_url: 'https://example.com/shot.png' }])).toBe('Image preview');
    const big = 'A'.repeat(Math.ceil((MAX_INLINE_IMAGE_BYTES + 10) / 3) * 4);
    expect(toolResultAttachments([{ type: 'image', data: big, mimeType: 'image/png' }])[0]?.data).toBeUndefined();
  });
});
