import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeImportService } from '../src/nativeImport.js';
import { Observations } from '../src/observations.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const sources = ['codex', 'claude-code', 'gemini-cli', 'antigravity', 'hermes'] as const;
type Source = typeof sources[number];
const at = () => new Date().toISOString();
const line = (row: unknown) => JSON.stringify(row) + '\n';
const injected = '<environment_context>Project setup supplied by the harness.</environment_context>';
const open: Observations[] = [];
afterEach(async () => { while (open.length) await open.pop()!.close(); });

async function fixture(sourceId: Source, content: string, meta = false) {
  const root = await temp(), home = path.join(root, 'home'), state = path.join(root, 'state');
  const nativeSessionId = 'source-work';
  const files: Record<Source, string> = {
    codex: path.join(home, '.codex', 'sessions', 'rollout-work.jsonl'),
    'claude-code': path.join(home, '.claude', 'projects', 'example', 'work.jsonl'),
    'gemini-cli': path.join(home, '.gemini', 'tmp', 'example', 'chats', 'session-work.json'),
    antigravity: path.join(home, '.gemini', 'antigravity', 'brain', nativeSessionId, '.system_generated', 'logs', 'transcript.jsonl'),
    hermes: path.join(home, '.hermes', 'state.db'),
  };
  const file = files[sourceId]; await mkdir(path.dirname(file), { recursive: true });
  if (sourceId === 'hermes') {
    const db = new DatabaseSync(file);
    try {
      db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, started_at REAL); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER)');
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(nativeSessionId, 'Source work', '/projects/example', Date.now() / 1000);
      db.prepare('INSERT INTO messages VALUES (1, ?, ?, ?, ?, 1)').run(nativeSessionId, 'user', content, Date.now() / 1000);
    } finally { db.close(); }
  } else if (sourceId === 'codex') await writeFile(file,
    line({ type: 'session_meta', payload: { id: nativeSessionId, cwd: '/projects/example', timestamp: at() } })
    + line({ type: 'response_item', timestamp: at(), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: content }] } }));
  else if (sourceId === 'claude-code') await writeFile(file,
    line({ type: 'user', uuid: 'user-one', sessionId: nativeSessionId, cwd: '/projects/example', timestamp: at(), ...(meta ? { isMeta: true } : {}), message: { role: 'user', content } }));
  else if (sourceId === 'gemini-cli') await writeFile(file, JSON.stringify({ sessionId: nativeSessionId, projectHash: 'example', startTime: at(), lastUpdated: at(), messages: [{ id: 'user-one', type: 'user', timestamp: at(), content }] }));
  else await writeFile(file, line({ type: 'USER_INPUT', source: 'USER_EXPLICIT', created_at: at(), content: `<USER_REQUEST>${content}</USER_REQUEST>` }));
  async function start() {
    const source = await NativeImportService.create({ homeDirectory: home, env: {} });
    const observer = await Observations.create(state, source, () => undefined, 60_000, { homeDirectory: home });
    open.push(observer); return { source, observer };
  }
  const services = await start();
  const location = services.source.locations().find(row => row.sourceId === sourceId && row.supported)!;
  return { root, home, state, file, nativeSessionId, location, start, ...services };
}

describe('source-backed Observe admission across harnesses', () => {
  it.each(sources)('%s excludes injected-only source setup without changing the source', async sourceId => {
    const f = await fixture(sourceId, injected), before = await readFile(f.file);
    await f.observer.setAutoWatch(f.location.id, true);
    expect(f.observer.summaries()).toEqual([]);
    expect(await readFile(f.file)).toEqual(before);
  });

  it.each(sources)('%s retains genuine work even when its text mentions internal helpers', async sourceId => {
    const text = 'Review internal helpers and empty sessions in this project.';
    const f = await fixture(sourceId, text);
    await f.observer.setAutoWatch(f.location.id, true);
    const [summary] = f.observer.summaries();
    expect(summary).toBeDefined();
    expect(f.observer.snapshot(summary!.id).messages.some(message => message.content === text)).toBe(true);
    const id = summary!.id;
    await f.observer.close(); open.splice(open.indexOf(f.observer), 1);
    const { observer } = await f.start();
    expect(observer.summaries().map(row => row.id)).toEqual([id]);
    expect(observer.snapshot(id).messages.some(message => message.content === text)).toBe(true);
  });

  it('treats Claude source-marked meta input as internal while preserving explicit manual selection', async () => {
    const f = await fixture('claude-code', 'Warmup metadata', true);
    await f.observer.setAutoWatch(f.location.id, true);
    expect(f.observer.summaries()).toEqual([]);
    const scan = f.source.scan([f.location.id]);
    await f.observer.observe(scan.scanId, [scan.sessions[0]!.id]);
    const id = f.observer.summaries()[0]!.id;
    expect(f.observer.snapshot(id).messages[0]!.content).toBe('Warmup metadata');
    await f.observer.close(); open.splice(open.indexOf(f.observer), 1);
    const index = path.join(f.state, 'observations.json');
    const records = JSON.parse(await readFile(index, 'utf8'));
    records[0].auto = true; await writeFile(index, JSON.stringify(records));
    const { observer } = await f.start();
    expect(observer.has(id)).toBe(true); expect(observer.summaries()).toEqual([]);
    await appendFile(f.file, line({ type: 'user', uuid: 'user-two', parentUuid: 'user-one', sessionId: f.nativeSessionId, cwd: '/projects/example', timestamp: at(), message: { role: 'user', content: 'Implement the real project change' } }));
    await observer.refresh();
    expect(observer.summaries().map(row => row.id)).toEqual([id]);
    expect(observer.snapshot(id).messages.at(-1)!.content).toBe('Implement the real project change');
  });

  it('keeps source-classified metadata private to visibility and preserves a deliberate rename', async () => {
    const f = await fixture('claude-code', 'Warmup metadata', true);
    const scan = f.source.scan([f.location.id]); await f.observer.observe(scan.scanId, [scan.sessions[0]!.id]);
    const id = f.observer.summaries()[0]!.id;
    await f.observer.rename(id, 'Saved investigation');
    await f.observer.close(); open.splice(open.indexOf(f.observer), 1);
    const index = path.join(f.state, 'observations.json'), records = JSON.parse(await readFile(index, 'utf8'));
    records[0].auto = true; await writeFile(index, JSON.stringify(records));
    const { observer } = await f.start();
    expect(observer.summaries()).toMatchObject([{ id, title: 'Saved investigation' }]);
  });

  it.each([
    { content: [{ type: 'text', text: 'Continuing the saved work.' }] },
    { content: [{ type: 'tool_use', id: 'read-one', name: 'Read', input: { file_path: '/projects/example/README.md' } }] },
    { content: [{ type: 'thinking', thinking: 'Private reasoning is not retained.' }] },
  ])('preserves Claude work following meta input: %j', async ({ content }) => {
    const f = await fixture('claude-code', 'Warmup metadata', true);
    await appendFile(f.file, line({ type: 'assistant', uuid: 'assistant-one', parentUuid: 'user-one', sessionId: f.nativeSessionId, timestamp: at(), message: { role: 'assistant', content } }));
    const scan = f.source.scan([f.location.id]);
    const reference = f.source.observation(scan.scanId, scan.sessions[0]!.id).reference;
    expect(f.source.readObservation(reference).internalEmpty).toBe(false);
    await f.observer.setAutoWatch(f.location.id, true);
    expect(f.observer.summaries()).toHaveLength(1);
  });
});
