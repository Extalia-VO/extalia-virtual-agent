import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeImportService } from '../src/nativeImport.js';
import { Observations } from '../src/observations.js';
import { newSessionId } from '../src/sessions.js';
import { normalizeCodexHook } from '../src/hooks/normalize.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const HEADER = 'This is an app-generated request for a suggested next user message. The user did not write this message.';
const REQUEST = `${HEADER}\n\nYour suggestion will appear in the user's empty message composer. Predict the next message.`;
const stamp = '2026-11-15T10:00:00.000Z';
const line = (row: unknown) => JSON.stringify(row) + '\n';
const prompt = (text: string) => line({ type: 'response_item', timestamp: stamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const transcript = (id: string, text: string) => line({ type: 'session_meta', payload: { id, cwd: '/projects/example', timestamp: stamp } }) + prompt(text);
const open: Observations[] = [];
afterEach(async () => { while (open.length) await open.pop()!.close(); });
async function fixture() {
  const root = await temp(), home = path.join(root, 'home'), directory = path.join(root, 'state');
  const folder = path.join(home, '.codex', 'sessions'); await mkdir(folder, { recursive: true });
  const file = path.join(folder, 'rollout-work.jsonl'); await writeFile(file, transcript('native-work', 'Implement the feature'));
  const source = await NativeImportService.create({ homeDirectory: home, env: {} });
  const observer = await Observations.create(directory, source, () => undefined, 60_000); open.push(observer);
  const scan = source.scan(['codex']); await observer.observe(scan.scanId, [scan.sessions[0]!.id]);
  return { root, home, directory, folder, file, source, observer, id: observer.summaries()[0]!.id };
}
async function close(observer: Observations) { open.splice(open.indexOf(observer), 1); await observer.close(); }
async function reopen(f: Awaited<ReturnType<typeof fixture>>) {
  const source = await NativeImportService.create({ homeDirectory: f.home, env: {} });
  const observer = await Observations.create(f.directory, source, () => undefined, 60_000); open.push(observer); return observer;
}

describe('internal suggestion sessions in Observe', () => {
  it('suppresses a legacy cached helper after restart without deleting its native or cached history', async () => {
    const f = await fixture();
    await writeFile(f.file, transcript('native-work', REQUEST));
    await f.observer.refresh(); expect(f.observer.summaries()).toEqual([]);
    const snapshotPath = path.join(f.directory, 'observed', `${f.id}.json`);
    const cached = await readFile(snapshotPath, 'utf8');
    await close(f.observer);
    const observer = await reopen(f);
    expect(observer.summaries()).toEqual([]);
    expect(observer.has(f.id)).toBe(true);
    expect(observer.snapshot(f.id).messages[0]!.content).toBe(REQUEST);
    expect(await readFile(snapshotPath, 'utf8')).toBe(cached);
    expect(await readFile(f.file, 'utf8')).toBe(transcript('native-work', REQUEST));
    expect(JSON.parse(await readFile(path.join(f.directory, 'observations.json'), 'utf8'))).toHaveLength(1);
  });

  it('hides an unavailable legacy helper with its full canonical source title and no snapshot', async () => {
    const f = await fixture(); await close(f.observer);
    const index = path.join(f.directory, 'observations.json'); const records = JSON.parse(await readFile(index, 'utf8'));
    records[0].title = HEADER; records[0].sourceTitle = HEADER; await writeFile(index, JSON.stringify(records));
    await rm(f.file); await rm(path.join(f.directory, 'observed', `${f.id}.json`));
    const observer = await reopen(f);
    expect(observer.has(f.id)).toBe(true); expect(observer.summaries()).toEqual([]);
  });

  it('keeps a real conversation whose title happens to quote the helper header visible', async () => {
    const f = await fixture(); await f.observer.rename(f.id, HEADER);
    expect(f.observer.summaries()).toHaveLength(1);
    expect(f.observer.summaries()[0]!.title).toBe(HEADER);
  });

  it('restores the same session when an actual user continues a helper thread', async () => {
    const f = await fixture(); await writeFile(f.file, transcript('native-work', REQUEST)); await f.observer.refresh();
    expect(f.observer.summaries()).toEqual([]);
    await appendFile(f.file, prompt('Now implement the actual change')); await f.observer.refresh();
    expect(f.observer.summaries().map(row => row.id)).toEqual([f.id]);
    expect(f.observer.snapshot(f.id).messages).toHaveLength(2);
  });

  it('keeps hook-only helper requests out of lists while allowing a later normal prompt', async () => {
    const f = await fixture();
    const hook = (text: string) => normalizeCodexHook({ session_id: 'native-hook', hook_event_name: 'UserPromptSubmit', prompt: text })!;
    await f.observer.receiveHook(hook(REQUEST));
    expect(f.observer.summaries().map(row => row.id)).toEqual([f.id]);
    await f.observer.receiveHook(hook('Review the workspace code'));
    expect(f.observer.summaries()).toHaveLength(2);
    const resumed = f.observer.summaries().find(row => row.id !== f.id)!;
    expect(resumed.observation!.nativeSessionId).toBe('native-hook');
    expect(resumed.title).toBe('Review the workspace code');
    await close(f.observer);
    expect((await reopen(f)).summaries().map(row => row.id)).toContain(resumed.id);
  });

  it('keeps hook-only helper classification across restart without retaining ephemeral hook prompts', async () => {
    const f = await fixture();
    await f.observer.receiveHook(normalizeCodexHook({ session_id: 'hook-helper', hook_event_name: 'UserPromptSubmit', prompt: REQUEST })!);
    const records = JSON.parse(await readFile(path.join(f.directory, 'observations.json'), 'utf8'));
    const helper = records.find((row: { reference: { nativeSessionId: string } }) => row.reference.nativeSessionId === 'hook-helper');
    expect(helper.suggestionOnly).toBe(true);
    await close(f.observer);
    const observer = await reopen(f);
    expect(observer.has(helper.id)).toBe(true);
    expect(observer.summaries().map(row => row.id)).toEqual([f.id]);
    await observer.receiveHook(normalizeCodexHook({ session_id: 'hook-helper', hook_event_name: 'UserPromptSubmit', prompt: 'Continue real work' })!);
    expect(observer.summaries().map(row => row.id)).toContain(helper.id);
  });

  it('does not register or count automatically discovered helper-only threads', async () => {
    const f = await fixture(); const file = path.join(f.folder, 'rollout-helper.jsonl'); await writeFile(file, transcript('native-helper', REQUEST));
    const location = f.source.locations().find(item => item.sourceId === 'codex' && !item.label.toLowerCase().includes('archived'))!;
    await f.observer.setAutoWatch(location.id, true); await f.observer.refresh();
    expect(f.observer.summaries().map(row => row.id)).toEqual([f.id]);
    expect(JSON.parse(await readFile(path.join(f.directory, 'observations.json'), 'utf8'))).toHaveLength(1);
    expect(await readFile(file, 'utf8')).toBe(transcript('native-helper', REQUEST));
  });

  it('lets real work replace legacy helper records even when helper activity timestamps are newer', async () => {
    const f = await fixture(); await close(f.observer);
    const index = path.join(f.directory, 'observations.json'); const records = JSON.parse(await readFile(index, 'utf8'));
    const helpers = Array.from({ length: 24 }, (_, n) => ({ ...records[0], id: newSessionId(), auto: true,
      title: HEADER, sourceTitle: HEADER, lastActiveAt: '2060-01-01T00:00:00.000Z',
      reference: { ...records[0].reference, nativeSessionId: `old-helper-${n}`, path: path.join(f.folder, `missing-helper-${n}.jsonl`) },
    }));
    await writeFile(index, JSON.stringify([...records, ...helpers]));
    await writeFile(path.join(f.folder, 'rollout-new-work.jsonl'), transcript('new-work', 'Continue implementing the project'));
    const observer = await reopen(f);
    const location = f.source.locations().find(item => item.sourceId === 'codex' && !item.label.toLowerCase().includes('archived'))!;
    await observer.setAutoWatch(location.id, true); await observer.refresh();
    expect(observer.summaries()).toHaveLength(2);
    expect(observer.summaries().map(row => row.observation!.nativeSessionId)).toContain('new-work');
  });

});
