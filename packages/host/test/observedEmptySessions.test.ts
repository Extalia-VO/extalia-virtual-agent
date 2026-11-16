import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EventBody } from '@extalia/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeCodexHook } from '../src/hooks/normalize.js';
import { NativeImportService } from '../src/nativeImport.js';
import { MAX_AUTO_OBSERVATIONS, Observations, type ObservationHooks } from '../src/observations.js';
import { newSessionId } from '../src/sessions.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const stamp = '2026-11-15T10:00:00.000Z';
const line = (row: unknown) => `${JSON.stringify(row)}\n`;
const meta = (id: string) => line({ type: 'session_meta', payload: { id, cwd: '/projects/example', timestamp: stamp } });
const prompt = (text: string) => line({ type: 'response_item', timestamp: stamp,
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const open: Observations[] = [];
afterEach(async () => { while (open.length) await open.pop()!.close(); });

function placeholder(nativeSessionId = 'native-empty-placeholder-with-long-id') {
  return { id: newSessionId(), title: `Codex · ${nativeSessionId.slice(0, 24)}`, auto: true, watching: true,
    createdAt: stamp, lastActiveAt: stamp, hook: { app: 'codex' },
    reference: { sourceId: 'codex', locationId: 'hook-codex', nativeSessionId, path: '' },
    output: { revision: '0'.repeat(64), readRevision: '0'.repeat(64), hasOutput: false } };
}
async function fixture(records: unknown[] = [], hooks: ObservationHooks = {}) {
  const root = await temp(), home = path.join(root, 'home'), directory = path.join(root, 'state');
  const folder = path.join(home, '.codex', 'sessions');
  await mkdir(folder, { recursive: true }); await mkdir(directory, { recursive: true });
  const index = path.join(directory, 'observations.json'); await writeFile(index, JSON.stringify(records));
  async function start() {
    const source = await NativeImportService.create({ homeDirectory: home, env: {} });
    const observer = await Observations.create(directory, source, () => undefined, 60_000, { ...hooks, homeDirectory: home });
    open.push(observer); return { source, observer };
  }
  return { root, home, directory, folder, index, start, ...await start() };
}
async function close(observer: Observations) { open.splice(open.indexOf(observer), 1); await observer.close(); }
function report(observer: Observations, sessionId: string, body: EventBody) {
  return observer.receiveHook({ app: 'codex', sessionId, event: 'ActivityReport', starts: false, ends: false,
    steps: [{ agentId: 'primary', body }] });
}

describe('empty automatic Codex observation visibility', () => {
  it('hides a persisted pathless placeholder after restart while retaining its identity and registry', async () => {
    const record = placeholder(); const f = await fixture([record]);
    expect(f.observer.summaries()).toEqual([]); expect(f.observer.has(record.id)).toBe(true);
    expect(() => f.observer.snapshot(record.id)).toThrow('not available yet');
    expect(f.observer.events(record.id)).toBeInstanceOf(Array);
    expect(JSON.parse(await readFile(f.index, 'utf8'))).toMatchObject([{ id: record.id, reference: { path: '' } }]);
    await close(f.observer); const { observer } = await f.start();
    expect(observer.summaries()).toEqual([]); expect(observer.has(record.id)).toBe(true);
  });

  it('keeps new session lifecycle and idle-only hook reports hidden', async () => {
    const f = await fixture();
    for (const event of ['SessionStart', 'Stop', 'SessionEnd']) {
      await f.observer.receiveHook(normalizeCodexHook({ session_id: 'native-lifecycle', hook_event_name: event })!);
      expect(f.observer.summaries()).toEqual([]);
    }
    await close(f.observer);
    const records = JSON.parse(await readFile(f.index, 'utf8'));
    expect(records).toHaveLength(1);
    const { observer } = await f.start();
    expect(observer.has(records[0].id)).toBe(true); expect(observer.summaries()).toEqual([]);
  });

  it('clears bare thinking activity on Stop instead of keeping a lifecycle placeholder visible', async () => {
    const record = placeholder(); const f = await fixture([record]);
    await f.observer.receiveHook(normalizeCodexHook({ session_id: record.reference.nativeSessionId, hook_event_name: 'SessionStart' })!);
    expect(f.observer.summaries()).toEqual([]);
    await report(f.observer, record.reference.nativeSessionId, { type: 'agent.state', state: 'thinking' });
    expect(f.observer.summaries().map(row => row.id)).toEqual([record.id]);
    await f.observer.receiveHook(normalizeCodexHook({ session_id: record.reference.nativeSessionId, hook_event_name: 'Stop' })!);
    expect(f.observer.summaries()).toEqual([]); expect(f.observer.has(record.id)).toBe(true);
    await report(f.observer, record.reference.nativeSessionId, { type: 'agent.state', state: 'waiting', phase: 'input' });
    expect(f.observer.summaries().map(row => row.id)).toEqual([record.id]);
    await report(f.observer, record.reference.nativeSessionId, { type: 'agent.state', state: 'idle' });
    expect(f.observer.summaries()).toEqual([]);
  });

  it.each([
    { type: 'prompt.submitted', text: 'Review the code', via: 'native' },
    { type: 'tool.started', tool: 'exec_command', kind: 'command', label: 'Run tests' },
    { type: 'command.started', command: 'pnpm test' },
    { type: 'model.completed', text: 'The work is complete.' },
    { type: 'approval.requested', approvalId: 'approval-one', action: 'Run command' },
    { type: 'agent.state', state: 'waiting', phase: 'input', summary: 'Choose an option' },
    { type: 'subagent.spawned', subagentId: 'worker-one' },
  ] satisfies EventBody[])('reveals the same retained ID for substantive $type hooks without a transcript', async body => {
    const record = placeholder(); const f = await fixture([record]);
    await report(f.observer, record.reference.nativeSessionId, body);
    expect(f.observer.summaries().map(row => row.id)).toEqual([record.id]);
    expect(() => f.observer.snapshot(record.id)).toThrow('not available yet');
  });

  it('keeps durable user, model, context and output evidence visible across restart', async () => {
    const records = [
      { ...placeholder('native-user'), userConversation: true },
      { ...placeholder('native-model'), model: 'example-model', modelAt: stamp },
      { ...placeholder('native-context'), context: { usedTokens: 100, estimated: false, compactions: 0, updatedAt: stamp } },
      { ...placeholder('native-output'), output: { revision: '1'.repeat(64), readRevision: '0'.repeat(64), hasOutput: true } },
    ];
    const f = await fixture([placeholder(), ...records]);
    expect(f.observer.summaries().map(row => row.id)).toEqual(records.map(row => row.id));
    await close(f.observer);
    expect((await f.start()).observer.summaries().map(row => row.id)).toEqual(records.map(row => row.id));
  });

  it('retains real hook prompt and model evidence, while transient tool-only metadata resets on restart', async () => {
    const f = await fixture();
    await report(f.observer, 'native-user', { type: 'prompt.submitted', text: 'Review the code', via: 'native' });
    await report(f.observer, 'native-model', { type: 'model.completed', text: 'The work is complete.' });
    await report(f.observer, 'native-tool', { type: 'tool.started', tool: 'exec_command', kind: 'command', label: 'Run tests' });
    expect(f.observer.summaries()).toHaveLength(3);
    const ids = f.observer.summaries().filter(row => row.observation!.nativeSessionId !== 'native-tool').map(row => row.id);
    await close(f.observer);
    expect((await f.start()).observer.summaries().map(row => row.id)).toEqual(ids);
  });

  it('reveals a later readable source on the same ID, retaining the cached conversation if that source disappears', async () => {
    const record = placeholder(); const f = await fixture([record]);
    const file = path.join(f.folder, 'rollout-recovered.jsonl');
    await writeFile(file, meta(record.reference.nativeSessionId) + prompt('Continue this project'));
    await f.observer.receiveHook(normalizeCodexHook({ session_id: record.reference.nativeSessionId,
      transcript_path: file, hook_event_name: 'SessionStart' })!);
    await f.observer.refresh();
    expect(f.observer.summaries().map(row => row.id)).toEqual([record.id]);
    expect(f.observer.snapshot(record.id).messages[0]!.content).toBe('Continue this project');
    const cached = await readFile(path.join(f.directory, 'observed', `${record.id}.json`), 'utf8');
    await f.observer.rename(record.id, record.title);
    await close(f.observer); await rm(file);
    const { observer } = await f.start();
    expect(observer.summaries().map(row => row.id)).toEqual([record.id]);
    expect(observer.snapshot(record.id).messages[0]!.content).toBe('Continue this project');
    expect(await readFile(path.join(f.directory, 'observed', `${record.id}.json`), 'utf8')).toBe(cached);
  });

  it('recovers a lifecycle placeholder through opted-in source discovery, respecting a user pause', async () => {
    const f = await fixture();
    await f.observer.receiveHook(normalizeCodexHook({ session_id: 'discovered-later', hook_event_name: 'SessionStart' })!);
    expect(f.observer.summaries()).toEqual([]);
    await close(f.observer);
    const [record] = JSON.parse(await readFile(f.index, 'utf8'));
    await writeFile(path.join(f.folder, 'rollout-later.jsonl'), meta('discovered-later') + prompt('Resume discovered work'));
    const { source, observer } = await f.start();
    expect(observer.summaries()).toEqual([]);
    expect(() => observer.snapshot(record.id)).toThrow('not available yet');
    await observer.setWatching(record.id, false);
    const location = source.locations().find(item => item.sourceId === 'codex' && item.label === 'Codex')!;
    await observer.setAutoWatch(location.id, true);
    expect(observer.summaries()).toEqual([]);
    expect(() => observer.snapshot(record.id)).toThrow('not available yet');
    await observer.setWatching(record.id, true);
    expect(observer.summaries()).toMatchObject([{ id: record.id, title: 'Resume discovered work' }]);
    expect(observer.snapshot(record.id).messages[0]!.content).toBe('Resume discovered work');
    expect(JSON.parse(await readFile(f.index, 'utf8'))).toMatchObject([{ id: record.id, reference: { nativeSessionId: 'discovered-later' } }]);
  });

  it('retains the pathless reference after failed hydration and retries the same ID on a later poll', async () => {
    let attempts = 0;
    const projectContext = vi.fn(async () => {
      if (++attempts === 1) throw new Error('Project evidence temporarily unavailable');
      return undefined;
    });
    const record = placeholder('discovery-retry'); const f = await fixture([record], { projectContext });
    const file = path.join(f.folder, 'rollout-retry.jsonl');
    await writeFile(file, meta('discovery-retry') + prompt('Recover after project evidence is ready'));
    const location = f.source.locations().find(item => item.sourceId === 'codex' && item.label === 'Codex')!;
    await f.observer.setAutoWatch(location.id, true);
    expect(projectContext).toHaveBeenCalledTimes(1);
    expect(f.observer.summaries()).toEqual([]); expect(f.observer.has(record.id)).toBe(true);
    expect(() => f.observer.snapshot(record.id)).toThrow('not available yet');
    // Persist through a separate public operation to verify the in-memory reference was restored too.
    await f.observer.rename(record.id, record.title);
    expect(JSON.parse(await readFile(f.index, 'utf8'))).toMatchObject([{ id: record.id, title: record.title, reference: record.reference }]);
    await f.observer.refresh();
    expect(projectContext).toHaveBeenCalledTimes(2);
    expect(f.observer.summaries()).toMatchObject([{ id: record.id, title: 'Recover after project evidence is ready' }]);
    expect(f.observer.snapshot(record.id).messages[0]!.content).toBe('Recover after project evidence is ready');
    expect(JSON.parse(await readFile(f.index, 'utf8'))).toMatchObject([{ id: record.id, reference: { path: file } }]);
  });

  it('keeps a descriptive Codex-prefixed rename when approved discovery hydrates its placeholder', async () => {
    const record = placeholder('renamed-before-discovery'); const f = await fixture([record]);
    expect(f.observer.summaries()).toEqual([]);
    const title = 'Codex · My saved project';
    await f.observer.rename(record.id, title);
    const file = path.join(f.folder, 'rollout-renamed.jsonl');
    await writeFile(file, meta(record.reference.nativeSessionId) + prompt('A source-provided conversation title'));
    const location = f.source.locations().find(item => item.sourceId === 'codex' && item.label === 'Codex')!;
    await f.observer.setAutoWatch(location.id, true);
    expect(f.observer.summaries()).toMatchObject([{ id: record.id, title }]);
    expect(f.observer.snapshot(record.id).messages[0]!.content).toBe('A source-provided conversation title');
    expect(JSON.parse(await readFile(f.index, 'utf8'))).toMatchObject([{ id: record.id, title, reference: { path: file } }]);
  });

  it('preserves manual, renamed and descriptive observations and unrelated source titles', async () => {
    const manual = { ...placeholder('native-manual'), auto: false };
    const descriptive = { ...placeholder('native-descriptive'), title: 'Project review' };
    const other = { ...placeholder('native-other'), reference: { ...placeholder().reference, sourceId: 'claude-code', nativeSessionId: 'native-other' } };
    const renamed = placeholder('native-renamed'); const f = await fixture([manual, descriptive, other, renamed]);
    await f.observer.rename(renamed.id, 'Codex · My saved project');
    expect(f.observer.summaries().map(row => row.id)).toEqual([manual.id, descriptive.id, other.id, renamed.id]);
    await f.observer.setWatching(renamed.id, false);
    await report(f.observer, renamed.reference.nativeSessionId, { type: 'tool.started', tool: 'exec_command', kind: 'command', label: 'Run tests' });
    expect(f.observer.summaries().find(row => row.id === renamed.id)?.observation).toMatchObject({ watching: false, status: 'paused' });
  });

  it('keeps labels-only real activity and pending approvals visible, while lifecycle-only privacy rows stay hidden', async () => {
    const records = [placeholder('private-lifecycle'), placeholder('private-prompt'), placeholder('private-output'), placeholder('private-approval')];
    const f = await fixture(records); await f.observer.setPrivacy({ labelsOnly: true });
    await f.observer.receiveHook(normalizeCodexHook({ session_id: 'private-lifecycle', hook_event_name: 'SessionStart' }, { labelsOnly: true })!);
    await f.observer.receiveHook(normalizeCodexHook({ session_id: 'private-prompt', hook_event_name: 'UserPromptSubmit', prompt: 'Private request' }, { labelsOnly: true })!);
    await report(f.observer, 'private-output', { type: 'model.completed', text: 'Private output' });
    await report(f.observer, 'private-approval', { type: 'approval.requested', approvalId: 'private-one', action: 'Run command' });
    expect(f.observer.summaries().map(row => row.id)).toEqual(records.slice(1).map(row => row.id));
    expect(f.observer.events(records[2]!.id).some(event => event.body.type === 'model.completed')).toBe(false);
    await f.observer.receiveHook(normalizeCodexHook({ session_id: 'private-prompt', hook_event_name: 'Stop' }, { labelsOnly: true })!);
    expect(f.observer.summaries().map(row => row.id)).toContain(records[1]!.id);
  });

  it('lets internal helper classification win over hook activity and model metadata', async () => {
    const record = { ...placeholder(), suggestionOnly: true, model: 'example-model' };
    const f = await fixture([record]);
    await report(f.observer, record.reference.nativeSessionId, { type: 'tool.started', tool: 'exec_command', kind: 'command', label: 'Run tests' });
    expect(f.observer.summaries()).toEqual([]); expect(f.observer.has(record.id)).toBe(true);
  });

  it('prioritizes real work over newer empty placeholders at the existing automatic capacity limit', async () => {
    const records = Array.from({ length: MAX_AUTO_OBSERVATIONS }, (_, index) => ({ ...placeholder(`empty-${index}`), lastActiveAt: '2060-01-01T00:00:00.000Z' }));
    const f = await fixture(records);
    await report(f.observer, 'real-work', { type: 'prompt.submitted', text: 'Implement the feature', via: 'native' });
    expect(f.observer.summaries().map(row => row.observation!.nativeSessionId)).toEqual(['real-work']);
    await close(f.observer);
    const saved = JSON.parse(await readFile(f.index, 'utf8'));
    expect(saved).toHaveLength(MAX_AUTO_OBSERVATIONS);
    expect(saved.some((row: { reference: { nativeSessionId: string } }) => row.reference.nativeSessionId === 'real-work')).toBe(true);
  });
});
