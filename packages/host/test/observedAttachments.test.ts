import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NativeImportService } from '../src/nativeImport.js';
import { Observations } from '../src/observations.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const at = '2026-10-09T00:00:00.000Z';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

async function observe(content: unknown[]) {
  const root = await temp();
  const home = path.join(root, 'home'), directory = path.join(root, 'state');
  const folder = path.join(home, '.codex', 'sessions');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'rollout.jsonl'), line({ type: 'session_meta', payload: { id: 'native-one', cwd: '/projects/example', timestamp: at } })
    + line({ type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content } }));
  const source = await NativeImportService.create({ homeDirectory: home, env: {} });
  const observer = await Observations.create(directory, source, () => undefined, 60_000);
  const scan = source.scan(['codex']);
  await observer.observe(scan.scanId, [scan.sessions[0]!.id]);
  return { directory, observer, id: observer.summaries()[0]!.id };
}

describe('attachments of observed prompts', () => {
  it('keeps a private copy of embedded images and lists them on the prompt event by reference', async () => {
    const { directory, observer, id } = await observe([{ type: 'input_text', text: 'Fix this layout' }, { type: 'input_image', image_url: `data:image/png;base64,${PNG}` }]);
    try {
      const prompt = observer.events(id).find(event => event.body.type === 'prompt.submitted');
      const files = prompt?.body.type === 'prompt.submitted' ? prompt.body.attachments : undefined;
      expect(files).toEqual([{ name: 'image-1.png', kind: 'image', size: 68, ref: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
      const ref = files![0]!.ref!;
      expect(await observer.attachment(id, ref)).toEqual({ mimeType: 'image/png', data: PNG });
      const copy = path.join(directory, 'observed-files', id, ref);
      if (process.platform !== 'win32') expect((await stat(copy)).mode & 0o777).toBe(0o600);
      // Only this session's own references resolve.
      expect(await observer.attachment(id, 'f'.repeat(64))).toBeUndefined();
      expect(await observer.attachment(id, '../observations.json')).toBeUndefined();
      await observer.remove(id);
      expect(await readdir(path.join(directory, 'observed-files'))).toEqual([]);
    } finally { void observer; }
  });

  it('lists a file it cannot show (not an image the host recognises) by name only', async () => {
    const { observer, id } = await observe([{ type: 'input_text', text: 'See attached' }, { type: 'input_image', image_url: 'data:image/png;base64,bm90IGFuIGltYWdl' }]);
    try {
      const prompt = observer.events(id).find(event => event.body.type === 'prompt.submitted');
      expect(prompt?.body.type === 'prompt.submitted' && prompt.body.attachments).toEqual([{ name: 'image-1.png', kind: 'image', size: 12 }]);
    } finally { void observer; }
  });
});
