import { appendFile, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseEvent, type ExtaliaEvent } from '@extalia/protocol';
import { describe, expect, it, vi } from 'vitest';
import { NativeImportService } from '../src/nativeImport.js';
import { Observations } from '../src/observations.js';
import { createAgentHost } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const at = '2026-10-09T00:00:00.000Z';
const later = '2026-10-09T00:00:01.000Z';
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const message = (role: string, text: string, stamp = at) => line({ type: 'response_item', timestamp: stamp, payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });

async function fixture() {
  const root = await temp();
  const home = path.join(root, 'home'), directory = path.join(root, 'state');
  const folder = path.join(home, '.codex', 'sessions');
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, 'rollout.jsonl');
  const initial = line({ type: 'session_meta', payload: { id: 'native-one', cwd: '/projects/example', timestamp: at } }) + message('user', 'Plan');
  await writeFile(file, initial);
  const source = await NativeImportService.create({ homeDirectory: home, env: {} });
  const updates: ExtaliaEvent[] = [];
  const observer = await Observations.create(directory, source, event => updates.push(event), 60_000);
  const scan = source.scan(['codex']);
  await observer.observe(scan.scanId, [scan.sessions[0]!.id]);
  return { root, home, directory, file, initial, source, observer, updates, id: observer.summaries()[0]!.id };
}

describe('live transcript observation', () => {
  it('preserves a damaged observer registry and releases the host lock when startup fails', async () => {
    const root = await temp(), dataDirectory = path.join(root, 'data'), file = path.join(dataDirectory, 'state', 'observations.json');
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, '{}');
    const options = { kind: 'bridge' as const, version: 'test', dataDirectory, importHome: path.join(root, 'home'), env: { EXTALIA_SECRET_STORE: 'memory' } };
    await expect(createAgentHost(options)).rejects.toThrow('observer registry');
    expect(await readFile(file, 'utf8')).toBe('{}');
    await writeFile(file, '[]');
    const runtime = await createAgentHost(options);
    await runtime.close();
  });
  it('skips unchanged transcript parsing and disk writes; coalesces pending polls', async () => {
    const f = await fixture();
    try {
      const read = vi.spyOn(f.source, 'readObservation');
      await f.observer.refresh();
      const saved = path.join(f.directory, 'observed', `${f.id}.json`);
      const info = await stat(saved), notifications = f.updates.length;
      const poll = f.observer.refresh();
      expect(f.observer.refresh()).toBe(poll);
      await poll;
      await f.observer.refresh();
      expect(read).toHaveBeenCalledTimes(1);
      expect((await stat(saved)).mtimeMs).toBe(info.mtimeMs);
      expect(f.updates).toHaveLength(notifications);
      expect(await readFile(f.file, 'utf8')).toBe(f.initial);

      await appendFile(f.file, message('assistant', 'Done.', later));
      await f.observer.refresh();
      expect(read).toHaveBeenCalledTimes(2);
      expect(f.observer.snapshot(f.id).messages.at(-1)?.content).toBe('Done.');
      expect(f.updates.at(-1)?.body).toMatchObject({ type: 'session.updated', messageCount: 2 });
      expect(f.observer.events(f.id).every(event => parseEvent(event).ok)).toBe(true);
    } finally { await f.observer.close(); }
  });

  it('detects equal-size rewrites even with restored mtime, handles rewinds and redacts source content', async () => {
    const f = await fixture();
    try {
      await f.observer.refresh();
      const before = await stat(f.file);
      await writeFile(f.file, f.initial.replace('Plan', 'Test'));
      await utimes(f.file, before.atime, before.mtime);
      await f.observer.refresh();
      expect(f.observer.snapshot(f.id).messages[0]?.content).toBe('Test');
      await appendFile(f.file, message('assistant', 'api_key=synthetic-credential-value', later));
      await f.observer.refresh();
      expect(JSON.stringify(f.observer.snapshot(f.id))).not.toContain('synthetic-credential-value');
      await writeFile(f.file, f.initial);
      await f.observer.refresh();
      expect(f.observer.snapshot(f.id).messages).toHaveLength(1);
      expect(f.observer.events(f.id)).toHaveLength(2);
    } finally { await f.observer.close(); }
  });

  it('revalidates source boundaries before a cached read and recovers without losing the saved snapshot', async () => {
    const f = await fixture();
    try {
      await f.observer.refresh();
      const outside = path.join(f.root, 'outside.jsonl');
      await writeFile(outside, f.initial + message('assistant', 'Outside data', later));
      await rm(f.file); await symlink(outside, f.file);
      await f.observer.refresh();
      expect(f.observer.summaries()[0]?.observation?.status).toBe('unavailable');
      expect(JSON.stringify(f.observer.snapshot(f.id))).not.toContain('Outside data');
      await rm(f.file); await writeFile(f.file, f.initial + message('assistant', 'Safe data', later));
      await f.observer.refresh();
      expect(f.observer.summaries()[0]?.observation?.status).toBe('watching');
      expect(f.observer.snapshot(f.id).messages.at(-1)?.content).toBe('Safe data');
    } finally { await f.observer.close(); }
  });

  it('keeps pause and local title across restart, resumes updates and deletes only the Extalia copy', async () => {
    const f = await fixture();
    let reopened: Observations | undefined;
    try {
      await f.observer.rename(f.id, 'Kept title');
      await expect(f.observer.rename(f.id, '   ')).rejects.toThrow('Enter a title');
      expect(f.observer.summaries()[0]?.title).toBe('Kept title');
      await f.observer.setWatching(f.id, false);
      await appendFile(f.file, message('assistant', 'New native turn', later));
      await f.observer.refresh();
      expect(f.observer.snapshot(f.id).messages).toHaveLength(1);
      await f.observer.close();
      reopened = await Observations.create(f.directory, f.source, () => undefined, 60_000);
      expect(reopened.summaries()[0]).toMatchObject({ title: 'Kept title', observation: { status: 'paused', watching: false } });
      await reopened.setWatching(f.id, true);
      expect(reopened.snapshot(f.id).messages).toHaveLength(2);
      await reopened.remove(f.id);
      expect(reopened.summaries()).toHaveLength(0);
      expect(await readFile(f.file, 'utf8')).toContain('New native turn');
    } finally { await f.observer.close(); await reopened?.close(); }
  });

  it('sees Hermes WAL appends without a session metadata update and skips idle database parsing', async () => {
    const root = await temp(), home = path.join(root, 'home'), directory = path.join(root, 'state');
    const folder = path.join(home, '.hermes'); await mkdir(folder, { recursive: true });
    const writer = new DatabaseSync(path.join(folder, 'state.db'));
    writer.exec('PRAGMA journal_mode=WAL; CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, started_at REAL); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER)');
    writer.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('native-one', 'Hermes notes', Date.parse(at) / 1000);
    const add = writer.prepare('INSERT INTO messages (session_id, role, content, timestamp, active) VALUES (?, ?, ?, ?, 1)');
    add.run('native-one', 'user', 'First turn', Date.parse(at) / 1000);
    const source = await NativeImportService.create({ homeDirectory: home, env: {} });
    const observer = await Observations.create(directory, source, () => undefined, 60_000);
    try {
      const scan = source.scan(['hermes']); await observer.observe(scan.scanId, [scan.sessions[0]!.id]);
      const id = observer.summaries()[0]!.id, read = vi.spyOn(source, 'readObservation');
      await observer.refresh(); await observer.refresh();
      expect(read).toHaveBeenCalledTimes(1);
      add.run('native-one', 'assistant', 'WAL-only turn', Date.parse(later) / 1000);
      await observer.refresh();
      expect(read).toHaveBeenCalledTimes(2);
      expect(observer.snapshot(id).messages.at(-1)?.content).toBe('WAL-only turn');
      await observer.refresh(); expect(read).toHaveBeenCalledTimes(2);
      expect(writer.prepare('SELECT count(*) AS n FROM messages').get()).toMatchObject({ n: 2 });
    } finally { await observer.close(); writer.close(); }
  });

  it('supports observer-only onboarding and rejects managed actions on observed sessions', async () => {
    const f = await fixture(); await f.observer.close();
    const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: path.join(f.root, 'host'), importHome: f.home, env: { EXTALIA_SECRET_STORE: 'memory' }, observationIntervalMs: 60_000 });
    try {
      const { host } = runtime;
      expect(await host.completeSetup('observe')).toMatchObject({ setupComplete: true, workflow: 'observe', connections: [], workspaces: [] });
      const scan = await host.scanImports(['codex']);
      const state = await host.observeImports(scan.scanId, [scan.sessions[0]!.id]);
      const id = state.sessions[0]!.id;
      expect(state.sessions[0]).toMatchObject({ control: 'observed', running: false, observation: { watching: true } });
      await expect(host.sendPrompt(id, 'Edit something')).rejects.toThrow('read-only');
      await expect(host.cancel(id)).rejects.toThrow('cannot cancel');
      await expect(host.resolveApproval(id, 'native', 'once')).rejects.toThrow('cannot approve');
      expect((await host.sessionEvents(id)).every(event => event.source.channel === 'transcript' && parseEvent(event).ok)).toBe(true);
      await host.deleteSession(id);
      expect((await host.getState()).sessions).toHaveLength(0);
      expect(await readFile(f.file, 'utf8')).toBe(f.initial);
      expect(await host.setWorkflow('managed')).toMatchObject({ setupComplete: false, workflow: 'managed' });
    } finally { await runtime.close(); }
  });
});
