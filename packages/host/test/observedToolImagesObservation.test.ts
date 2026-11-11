import { appendFile, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NativeImportService } from '../src/nativeImport.js';
import { Observations } from '../src/observations.js';
import type { ObservedImageStore } from '../src/observedToolImages.js';
import { normalizeCodexHook } from '../src/hooks/normalize.js';
import { useTempDirs } from './helpers.js';

const temporary = useTempDirs();
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const at = '2026-11-01T00:00:00.000Z';
const line = (value: unknown) => JSON.stringify(value) + '\n';
async function fixture(inline = false, labelsOnly = false) {
  const root = await temporary('extalia-observed-tool-preview-'), home = path.join(root, 'home'), directory = path.join(root, 'data'), project = path.join(root, 'project'), scratch = path.join(root, 'temporary');
  const sourceFolder = path.join(home, '.codex', 'sessions');
  await Promise.all([sourceFolder, project, scratch].map(folder => mkdir(folder, { recursive: true })));
  const image = path.join(scratch, 'shot.png'); await writeFile(image, Buffer.from(PNG, 'base64')); await utimes(image, new Date(at), new Date(at));
  const file = path.join(sourceFolder, 'rollout.jsonl');
  await writeFile(file, line({ type: 'session_meta', payload: { id: 'native-image', cwd: project, timestamp: at } })
    + line({ type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect the screenshot.' }] } })
    + line({ type: 'response_item', timestamp: at, payload: { type: 'function_call', call_id: 'image-call', name: 'view_image', arguments: JSON.stringify({ path: image }) } })
    + line({ type: 'response_item', timestamp: at, payload: { type: 'function_call_output', call_id: 'image-call', output: inline ? [{ type: 'image', data: PNG, mimeType: 'image/png' }] : 'Viewed image.' } }));
  const source = await NativeImportService.create({ homeDirectory: home, env: {} });
  const observer = await Observations.create(directory, source, () => undefined, 60_000, { homeDirectory: home, temporaryImageRoot: scratch });
  if (labelsOnly) await observer.setPrivacy({ labelsOnly: true });
  const scan = source.scan(['codex']); await observer.observe(scan.scanId, [scan.sessions[0]!.id]);
  return { root, home, directory, project, scratch, source, observer, image, file, id: observer.summaries()[0]!.id };
}
const images = (observer: Observations, id: string) => observer.events(id).flatMap(event => event.body.type === 'tool.completed' ? event.body.attachments ?? [] : []);

describe('Observe image tool path through imported source and private host storage', () => {
  it.each([false, true])('hydrates image metadata without embedding bytes in events/snapshots (inline=%s)', async inline => {
    const f = await fixture(inline);
    try {
      const files = images(f.observer, f.id); expect(files).toHaveLength(1);
      expect(files[0]!.ref).toMatch(/^[0-9a-f]{64}$/);
      expect(await f.observer.attachment(f.id, files[0]!.ref!)).toEqual({ mimeType: 'image/png', data: PNG });
      expect(JSON.stringify(f.observer.events(f.id))).not.toContain(PNG);
      expect(JSON.stringify(f.observer.snapshot(f.id))).not.toContain(PNG);
      const before = f.observer.events(f.id).map(event => event.id);
      await f.observer.refresh(); expect(f.observer.events(f.id).map(event => event.id)).toEqual(before);
      expect((await readdir(path.join(f.directory, 'observed-files', f.id))).filter(name => /^[0-9a-f]{64}$/.test(name))).toHaveLength(1);
    } finally { await f.observer.close(); }
  });

  it('preserves an observed call copy after source-file deletion and a host restart', async () => {
    const f = await fixture(), ref = images(f.observer, f.id)[0]!.ref!;
    await f.observer.close(); await rm(f.image);
    const reopened = await Observations.create(f.directory, f.source, () => undefined, 60_000, { temporaryImageRoot: f.scratch, homeDirectory: f.home });
    try { expect(images(reopened, f.id)[0]!.ref).toBe(ref); expect(await reopened.attachment(f.id, ref)).toBeDefined(); }
    finally { await reopened.close(); }
  });

  it('does not copy images or publish metadata in labels-only mode and blocks old refs after privacy changes', async () => {
    const f = await fixture(false, true);
    try {
      expect(images(f.observer, f.id)).toEqual([]);
      expect(await readdir(path.join(f.directory, 'observed-files')).catch(() => [])).toEqual([]);
      await f.observer.setPrivacy({ labelsOnly: false });
      await appendFile(f.file, line({ type: 'event_msg', timestamp: at, payload: { type: 'task_complete' } }));
      await f.observer.refresh();
      const ref = images(f.observer, f.id)[0]!.ref!; expect(await f.observer.attachment(f.id, ref)).toBeDefined();
      await f.observer.setPrivacy({ labelsOnly: true });
      expect(images(f.observer, f.id)).toEqual([]); expect(await f.observer.attachment(f.id, ref)).toBeUndefined();
    } finally { await f.observer.close(); }
  });

  it.each(['privacy', 'remove'] as const)('rechecks %s after an entered preview request settles', async change => {
    const f = await fixture(), ref = images(f.observer, f.id)[0]!.ref!;
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    const store = (f.observer as unknown as { imageStore(id: string): ObservedImageStore }).imageStore(f.id);
    const spy = vi.spyOn(store, 'preview').mockImplementation(async () => { await hold; return { mimeType: 'image/png', data: PNG }; });
    try {
      const loading = f.observer.attachment(f.id, ref);
      if (change === 'privacy') await f.observer.setPrivacy({ labelsOnly: true }); else await f.observer.remove(f.id);
      release(); expect(await loading).toBeUndefined();
    } finally { release(); spy.mockRestore(); await f.observer.close(); }
  });

  it('fills a matching successful live hook row without duplicating the tool completion', async () => {
    const f = await fixture();
    try {
      const hook = normalizeCodexHook({ session_id: 'native-image', hook_event_name: 'PostToolUse', tool_name: 'view_image', tool_use_id: 'image-call', tool_response: 'Viewed image.', cwd: f.project, timestamp: at });
      expect(hook).toBeDefined(); await f.observer.receiveHook(hook!);
      const completed = f.observer.events(f.id).filter(event => event.body.type === 'tool.completed' && event.body.toolCallId === 'image-call');
      expect(completed).toHaveLength(1);
      expect(completed[0]!.body.type === 'tool.completed' && completed[0]!.body.attachments?.[0]?.ref).toMatch(/^[0-9a-f]{64}$/);
    } finally { await f.observer.close(); }
  });

  it('continues a bounded image batch on the next poll even after the transcript has stopped changing', async () => {
    const f = await fixture();
    try {
      let rows = '';
      for (let index = 1; index < 20; index++) rows += line({ type: 'response_item', timestamp: at, payload: {
        type: 'function_call', call_id: `image-${index}`, name: 'view_image', arguments: JSON.stringify({ path: f.image }),
      } }) + line({ type: 'response_item', timestamp: at, payload: { type: 'function_call_output', call_id: `image-${index}`, output: 'Viewed image.' } });
      await appendFile(f.file, rows);
      await f.observer.refresh();
      expect(images(f.observer, f.id).filter(file => file.ref)).toHaveLength(17);
      await f.observer.refresh();
      expect(images(f.observer, f.id).filter(file => file.ref)).toHaveLength(20);
      const stable = f.observer.events(f.id).map(event => event.id);
      await f.observer.refresh(); expect(f.observer.events(f.id).map(event => event.id)).toEqual(stable);
    } finally { await f.observer.close(); }
  });

  it('keeps source conversation and image metadata readable when a private image index is corrupt', async () => {
    const f = await fixture();
    await f.observer.close();
    await writeFile(path.join(f.directory, 'observed-files', f.id, 'index.json'), '{invalid');
    const reopened = await Observations.create(f.directory, f.source, () => undefined, 60_000, { homeDirectory: f.home, temporaryImageRoot: f.scratch });
    try {
      expect(reopened.summaries()[0]?.observation?.status).toBe('watching');
      expect(reopened.events(f.id).some(event => event.body.type === 'prompt.submitted' && event.body.text === 'Inspect the screenshot.')).toBe(true);
      expect(images(reopened, f.id)).toEqual([{ name: 'shot.png', kind: 'image', size: 0 }]);
    } finally { await reopened.close(); }
  });
});
