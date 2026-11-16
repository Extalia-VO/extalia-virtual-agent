import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EventBody } from '@extalia/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOOK_APPS, HOOK_APP_LABELS, HOOK_SOURCE_IDS, normalizeHook, type HookApp } from '../src/hooks/normalize.js';
import { NativeImportService } from '../src/nativeImport.js';
import { Observations, type ObservationHooks } from '../src/observations.js';
import { newSessionId } from '../src/sessions.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const stamp = '2026-11-15T10:00:00.000Z';
const line = (row: unknown) => `${JSON.stringify(row)}\n`;
const open: Observations[] = [];
afterEach(async () => { while (open.length) await open.pop()!.close(); });

function placeholder(app: HookApp, nativeSessionId = 'native-empty-placeholder-with-long-id') {
  return { id: newSessionId(), title: `${HOOK_APP_LABELS[app]} · ${nativeSessionId.slice(0, 24)}`, auto: true, watching: true,
    createdAt: stamp, lastActiveAt: stamp, hook: { app },
    reference: { sourceId: HOOK_SOURCE_IDS[app], locationId: `hook-${app}`, nativeSessionId, path: '' } };
}
async function close(observer: Observations) { open.splice(open.indexOf(observer), 1); await observer.close(); }
function report(observer: Observations, app: HookApp, sessionId: string, body: EventBody, agentId = 'primary') {
  return observer.receiveHook({ app, sessionId, event: 'ActivityReport', starts: false, ends: false, steps: [{ agentId, body }] });
}
async function fixture(app: HookApp, records: unknown[] = [], hooks: ObservationHooks = {}) {
  const root = await temp(), home = path.join(root, 'home'), directory = path.join(root, 'state');
  const folders: Record<HookApp, string> = {
    codex: path.join(home, '.codex', 'sessions'), claude: path.join(home, '.claude', 'projects', 'example'),
    gemini: path.join(home, '.gemini', 'tmp', 'example', 'chats'),
    antigravity: path.join(home, '.gemini', 'antigravity', 'brain'), hermes: path.join(home, '.hermes'),
  };
  await mkdir(folders[app], { recursive: true }); await mkdir(directory, { recursive: true });
  const index = path.join(directory, 'observations.json'); await writeFile(index, JSON.stringify(records));
  const database = path.join(folders.hermes, 'state.db');
  if (app === 'hermes') {
    const writer = new DatabaseSync(database);
    try { writer.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, started_at REAL); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER)'); }
    finally { writer.close(); }
  }
  async function seed(id: string, text: string) {
    let file: string;
    switch (app) {
      case 'codex':
        file = path.join(folders.codex, `rollout-${id}.jsonl`);
        await writeFile(file, line({ type: 'session_meta', payload: { id, cwd: '/projects/example', timestamp: stamp } })
          + line({ type: 'response_item', timestamp: stamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }));
        break;
      case 'claude':
        file = path.join(folders.claude, `${id}.jsonl`);
        await writeFile(file, line({ type: 'user', uuid: `prompt-${id}`, sessionId: id, cwd: '/projects/example', timestamp: stamp, message: { content: text } }));
        break;
      case 'gemini':
        file = path.join(folders.gemini, `session-${id}.json`);
        await writeFile(file, JSON.stringify({ sessionId: id, projectHash: 'example', startTime: stamp, messages: [{ id: 'prompt-one', type: 'user', timestamp: stamp, content: text }] }));
        break;
      case 'antigravity': {
        const logs = path.join(folders.antigravity, id, '.system_generated', 'logs');
        await mkdir(logs, { recursive: true }); file = path.join(logs, 'transcript.jsonl');
        await writeFile(file, line({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: stamp, content: text }));
        break;
      }
      case 'hermes': {
        file = database; const writer = new DatabaseSync(file);
        try {
          const now = Date.now() / 1000;
          writer.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(id, text, now);
          writer.prepare('INSERT INTO messages (session_id, role, content, timestamp, active) VALUES (?, ?, ?, ?, 1)').run(id, 'user', text, now);
        } finally { writer.close(); }
        break;
      }
    }
    return file;
  }
  async function start() {
    const source = await NativeImportService.create({ homeDirectory: home, env: {} });
    const observer = await Observations.create(directory, source, () => undefined, 60_000, { ...hooks, homeDirectory: home });
    open.push(observer); return { source, observer };
  }
  return { directory, index, seed, start, ...await start() };
}

describe.each(HOOK_APPS)('%s automatic Observe visibility', app => {
  it('hides lifecycle-only placeholders while retaining their identity across restart', async () => {
    const record = placeholder(app); const f = await fixture(app, [record]);
    const lifecycle = app === 'hermes' ? ['on_session_start', 'on_session_end', 'on_session_finalize'] : ['SessionStart', 'Stop', 'SessionEnd'];
    for (const hook_event_name of lifecycle) {
      await f.observer.receiveHook(normalizeHook(app, { session_id: record.reference.nativeSessionId, hook_event_name })!);
      expect(f.observer.summaries()).toEqual([]); expect(f.observer.has(record.id)).toBe(true);
    }
    await close(f.observer);
    const { observer } = await f.start();
    expect(observer.summaries()).toEqual([]); expect(observer.has(record.id)).toBe(true);
    expect(JSON.parse(await readFile(f.index, 'utf8'))).toMatchObject([{ id: record.id,
      reference: { sourceId: record.reference.sourceId, nativeSessionId: record.reference.nativeSessionId } }]);
  });

  it('keeps a new lifecycle registration hidden when it reports only model configuration', async () => {
    const f = await fixture(app);
    const hook_event_name = app === 'hermes' ? 'on_session_start' : 'SessionStart';
    await f.observer.receiveHook(normalizeHook(app, { session_id: 'lifecycle-model', hook_event_name,
      model: 'example-model', extra: { model: 'example-model' } })!);
    expect(f.observer.summaries()).toEqual([]);
    await close(f.observer);
    const [saved] = JSON.parse(await readFile(f.index, 'utf8'));
    expect(saved).toMatchObject({ lifecycleOnly: true, model: 'example-model' });
    const { observer } = await f.start();
    expect(observer.summaries()).toEqual([]); expect(observer.has(saved.id)).toBe(true);
    await report(observer, app, 'lifecycle-model', { type: 'tool.started', tool: 'exec_command', kind: 'command', label: 'Run tests' });
    expect(observer.summaries().map(row => row.id)).toEqual([saved.id]);
    await close(observer);
    expect(JSON.parse(await readFile(f.index, 'utf8'))[0].lifecycleOnly).toBeUndefined();
    expect((await f.start()).observer.summaries().map(row => row.id)).toEqual([saved.id]);
  });

  it.each([
    { type: 'prompt.submitted', text: 'Review this change', via: 'native' },
    { type: 'prompt.submitted', text: '', via: 'native', attachments: [{ name: 'diagram.png', kind: 'image', size: 100 }] },
    { type: 'tool.started', tool: 'exec_command', kind: 'command', label: 'Run tests' },
    { type: 'approval.requested', approvalId: 'approval-one', action: 'Run tests' },
    { type: 'model.completed', text: 'The change is ready.' },
    { type: 'subagent.spawned', subagentId: 'review-worker' },
    { type: 'turn.failed', error: 'The tool process failed' },
    { type: 'agent.error', message: 'The tool process failed' },
    { type: 'agent.state', state: 'idle', phase: 'error', summary: 'The tool process failed' },
  ] satisfies EventBody[])('reveals the same ID for $type evidence', async body => {
    const record = placeholder(app); const f = await fixture(app, [record]);
    await report(f.observer, app, record.reference.nativeSessionId, body);
    expect(f.observer.summaries().map(row => row.id)).toEqual([record.id]);
  });

  it('keeps primary and child tool work visible without interpreting generic helper words', async () => {
    const record = placeholder(app); const f = await fixture(app, [record]);
    await report(f.observer, app, record.reference.nativeSessionId,
      { type: 'tool.started', tool: 'exec_command', kind: 'command', label: 'Generate suggestions for a background helper' }, 'review-worker');
    expect(f.observer.summaries().map(row => row.id)).toEqual([record.id]);
    expect(f.observer.events(record.id).some(event => event.agentId === 'review-worker' && event.body.type === 'tool.started')).toBe(true);
  });

  it('applies the canonical suggested-prompt exception only to Codex', async () => {
    const record = placeholder(app); const f = await fixture(app, [record]);
    await report(f.observer, app, record.reference.nativeSessionId, { type: 'prompt.submitted', via: 'native',
      text: 'This is an app-generated request for a suggested next user message. The user did not write this message.' });
    expect(f.observer.summaries().map(row => row.id)).toEqual(app === 'codex' ? [] : [record.id]);
    await close(f.observer);
    expect((await f.start()).observer.summaries().map(row => row.id)).toEqual(app === 'codex' ? [] : [record.id]);
  });

  it('persists genuine primary prompts and attachment-only prompts, but not child or injected input', async () => {
    const f = await fixture(app);
    await report(f.observer, app, 'real-primary', { type: 'prompt.submitted', text: 'Review the background helper and suggestions', via: 'native' });
    await report(f.observer, app, 'attachment-only', { type: 'prompt.submitted', text: '', via: 'native', attachments: [{ name: 'diagram.png', kind: 'image', size: 100 }] });
    await report(f.observer, app, 'child-prompt', { type: 'prompt.submitted', text: 'Review one module', via: 'native' }, 'review-worker');
    await report(f.observer, app, 'injected-prompt', { type: 'prompt.submitted', text: '<environment_context>\nGenerated environment\n</environment_context>', via: 'native' });
    await report(f.observer, app, 'injected-prompt', { type: 'agent.state', state: 'idle' });
    await report(f.observer, app, 'blank-prompt', { type: 'prompt.submitted', text: '   ', via: 'native' });
    await close(f.observer);
    const saved = JSON.parse(await readFile(f.index, 'utf8')) as { userConversation?: boolean; reference: { nativeSessionId: string } }[];
    expect(saved.filter(row => row.userConversation).map(row => row.reference.nativeSessionId)).toEqual(['real-primary', 'attachment-only']);
    expect((await f.start()).observer.summaries().map(row => row.observation!.nativeSessionId)).toEqual(['real-primary', 'attachment-only']);
  });

  it('does not persist an injected-context title or classify that hook as genuine user input', async () => {
    const record = placeholder(app); const f = await fixture(app, [record]);
    await f.observer.receiveHook({ app, sessionId: record.reference.nativeSessionId, event: 'UserPromptSubmit', starts: false, ends: false,
      titleHint: '<environment_context>', steps: [
        { agentId: 'primary', body: { type: 'prompt.submitted', text: '<environment_context>\nGenerated environment\n</environment_context>', via: 'native' } },
        { agentId: 'primary', body: { type: 'agent.state', state: 'thinking' } },
      ] });
    await report(f.observer, app, record.reference.nativeSessionId, { type: 'agent.state', state: 'idle' });
    expect(f.observer.summaries()).toEqual([]);
    await close(f.observer);
    expect(JSON.parse(await readFile(f.index, 'utf8'))).toMatchObject([{ title: record.title }]);
    expect(await readFile(f.index, 'utf8')).not.toContain('userConversation');
  });

  it.each(['UserPromptSubmit', 'BeforeAgent'])('keeps labels-only %s visible while current without saving content', async event => {
    const record = placeholder(app); const f = await fixture(app, [record]);
    await f.observer.setPrivacy({ labelsOnly: true });
    await f.observer.receiveHook({ app, sessionId: record.reference.nativeSessionId, event, starts: false, ends: false,
      titleHint: 'Private prompt body', steps: [{ agentId: 'primary', body: { type: 'agent.state', state: 'thinking' } }] });
    await report(f.observer, app, record.reference.nativeSessionId, { type: 'agent.state', state: 'idle' });
    expect(f.observer.summaries().map(row => row.id)).toEqual([record.id]);
    expect(JSON.stringify(f.observer.events(record.id))).not.toContain('Private prompt body');
    await close(f.observer);
    expect(await readFile(f.index, 'utf8')).not.toContain('Private prompt body');
    expect((await f.start()).observer.summaries()).toEqual([]);
  });

  it('preserves manual, descriptive, renamed, unavailable and durable evidence records', async () => {
    const manual = { ...placeholder(app, 'manual'), auto: false };
    const descriptive = { ...placeholder(app, 'descriptive'), title: 'Review suggestions and background helpers' };
    const renamed = placeholder(app, 'renamed');
    const unavailable = { ...placeholder(app, 'unavailable'), title: 'Known conversation', reference: { ...placeholder(app).reference, nativeSessionId: 'unavailable', path: '/unavailable/conversation.jsonl' } };
    const model = { ...placeholder(app, 'model-evidence'), model: 'example-model', modelAt: stamp };
    const context = { ...placeholder(app, 'context-evidence'), context: { usedTokens: 100, estimated: false, compactions: 0, updatedAt: stamp } };
    const output = { ...placeholder(app, 'output-evidence'), output: { revision: '1'.repeat(64), readRevision: '0'.repeat(64), hasOutput: true } };
    const kept = [manual, descriptive, renamed, unavailable, model, context, output];
    const f = await fixture(app, [placeholder(app), ...kept]);
    await f.observer.rename(renamed.id, `${HOOK_APP_LABELS[app]} · My saved project`);
    await f.observer.receiveHook({ app, sessionId: renamed.reference.nativeSessionId, event: 'UserPromptSubmit', starts: false, ends: false,
      titleHint: 'A new source title', steps: [{ agentId: 'primary', body: { type: 'prompt.submitted', text: 'A new source title', via: 'native' } }] });
    await f.observer.refresh();
    expect(f.observer.summaries().map(row => row.id)).toEqual(kept.map(row => row.id));
    expect(f.observer.summaries().find(row => row.id === renamed.id)?.title).toBe(`${HOOK_APP_LABELS[app]} · My saved project`);
    await close(f.observer);
    expect((await f.start()).observer.summaries().map(row => row.id)).toEqual(kept.map(row => row.id));
  });

  it('recovers the same ID through opted-in discovery, preserves pause and cached history after source removal', async () => {
    const record = placeholder(app, 'discovered-later'); const f = await fixture(app, [record]);
    const file = await f.seed(record.reference.nativeSessionId, 'Resume discovered work');
    const location = f.source.locations().find(item => item.sourceId === HOOK_SOURCE_IDS[app] && item.available && item.supported)!;
    expect(location).toBeDefined();
    await f.observer.setWatching(record.id, false);
    await f.observer.setAutoWatch(location.id, true);
    expect(f.observer.summaries()).toEqual([]);
    expect(() => f.observer.snapshot(record.id)).toThrow('not available yet');
    await f.observer.setWatching(record.id, true);
    expect(f.observer.summaries()).toMatchObject([{ id: record.id, title: 'Resume discovered work' }]);
    expect(f.observer.snapshot(record.id).messages[0]!.content).toBe('Resume discovered work');
    await close(f.observer); await rm(file);
    const { observer } = await f.start(); await observer.refresh();
    expect(observer.summaries()).toMatchObject([{ id: record.id, observation: { status: 'unavailable' } }]);
    expect(observer.snapshot(record.id).messages[0]!.content).toBe('Resume discovered work');
    expect(JSON.parse(await readFile(f.index, 'utf8'))).toHaveLength(1);
  });

  it('rolls back failed discovery hydration and retries the same pathless identity', async () => {
    const projectContext = vi.fn().mockRejectedValueOnce(new Error('Project evidence temporarily unavailable')).mockResolvedValue(undefined);
    const record = placeholder(app, 'discovery-retry'); const f = await fixture(app, [record], { projectContext });
    const file = await f.seed(record.reference.nativeSessionId, 'Recover the original session');
    const location = f.source.locations().find(item => item.sourceId === HOOK_SOURCE_IDS[app] && item.available && item.supported)!;
    await f.observer.setAutoWatch(location.id, true);
    expect(projectContext).toHaveBeenCalledTimes(1);
    expect(f.observer.summaries()).toEqual([]); expect(f.observer.has(record.id)).toBe(true);
    await f.observer.rename(record.id, record.title);
    expect(JSON.parse(await readFile(f.index, 'utf8'))).toMatchObject([{ id: record.id, reference: record.reference }]);
    await f.observer.refresh();
    expect(projectContext).toHaveBeenCalledTimes(2);
    expect(f.observer.summaries()).toMatchObject([{ id: record.id, title: 'Recover the original session' }]);
    expect(JSON.parse(await readFile(f.index, 'utf8'))).toMatchObject([{ id: record.id, reference: { path: file } }]);
  });

  it('preserves a user rename made before the first metadata-only transcript hydration', async () => {
    const record = placeholder(app, 'renamed-before-source'); const f = await fixture(app, [record]);
    const title = `${HOOK_APP_LABELS[app]} · My saved project`;
    await f.observer.rename(record.id, title);
    const file = await f.seed(record.reference.nativeSessionId, 'A source prompt');
    const readObservation = f.source.readObservation.bind(f.source);
    vi.spyOn(f.source, 'readObservation').mockImplementation(reference => {
      const read = readObservation(reference);
      return { ...read, internalEmpty: true, steps: [], session: { ...read.session, title: 'Warmup',
        messages: read.session.messages.map(message => ({ ...message, role: 'user', content: 'Internal warmup' })) } };
    });
    await f.observer.receiveHook({ app, sessionId: record.reference.nativeSessionId, transcriptPath: file,
      event: 'SessionStart', starts: true, ends: false, steps: [{ agentId: 'primary', body: { type: 'session.started', control: 'observed' } }] });
    await f.observer.refresh();
    expect(f.observer.summaries()).toMatchObject([{ id: record.id, title }]);
    await close(f.observer);
    expect(JSON.parse(await readFile(f.index, 'utf8'))).toMatchObject([{ id: record.id, title, titleRenamed: true, internalEmpty: true }]);
    expect((await f.start()).observer.summaries()).toMatchObject([{ id: record.id, title }]);
  });

  it('does not attach discovery to manual records or mismatched hook source markers', async () => {
    const manual = { ...placeholder(app, 'manual-source'), auto: false };
    const mismatch = { ...placeholder(app, 'mismatched-source'), hook: { app: app === 'codex' ? 'claude' : 'codex' } };
    const unmarked = { ...placeholder(app, 'unmarked-source'), hook: undefined };
    const records = [manual, mismatch, unmarked]; const f = await fixture(app, records);
    for (const record of records) await f.seed(record.reference.nativeSessionId, 'Discovery must respect ownership');
    const location = f.source.locations().find(item => item.sourceId === HOOK_SOURCE_IDS[app] && item.available && item.supported)!;
    await f.observer.setAutoWatch(location.id, true);
    for (const record of records) expect(() => f.observer.snapshot(record.id)).toThrow('not available yet');
    expect(JSON.parse(await readFile(f.index, 'utf8'))).toMatchObject(records.map(record => ({ id: record.id, reference: record.reference })));
  });

  it('does not treat model configuration as work after positive source metadata classification', async () => {
    const record = { ...placeholder(app), title: 'Warmup', sourceTitle: 'Warmup', internalEmpty: true, model: 'example-model', modelAt: stamp };
    const f = await fixture(app, [record]);
    expect(f.observer.summaries()).toEqual([]);
    await report(f.observer, app, record.reference.nativeSessionId, { type: 'agent.state', state: 'waiting', phase: 'input', summary: 'Choose an option' });
    expect(f.observer.summaries().map(row => row.id)).toEqual([record.id]);
    await report(f.observer, app, record.reference.nativeSessionId, { type: 'agent.state', state: 'idle' });
    expect(f.observer.summaries()).toEqual([]);
    await report(f.observer, app, record.reference.nativeSessionId, { type: 'prompt.submitted', text: 'A genuine continuation', via: 'native' });
    await close(f.observer);
    expect((await f.start()).observer.summaries().map(row => row.id)).toEqual([record.id]);
  });
});
