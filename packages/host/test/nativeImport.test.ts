import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createAgentHost } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const T = '2026-10-08T00:00:00.000Z';
const T1 = '2026-10-08T00:00:01.000Z';
const jsonl = (...values: unknown[]) => values.map(value => JSON.stringify(value)).join('\n');

/** Synthesized native histories in a temporary home; nothing real is read. */
async function fakeHome(root: string) {
  const home = path.join(root, 'home');
  const codex = path.join(home, '.codex', 'sessions', '2026', '10', '08');
  await mkdir(codex, { recursive: true });
  await writeFile(path.join(codex, 'rollout-a.jsonl'), jsonl(
    { type: 'session_meta', payload: { id: 'codex-1', cwd: '/projects/site', timestamp: T } },
    { timestamp: T, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add a footer' }] } },
    { timestamp: T1, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Footer added.' }] } },
  ));
  // A link that points outside the history folder must be ignored.
  await writeFile(path.join(root, 'outside.jsonl'), jsonl({ type: 'session_meta', payload: { id: 'escaped', timestamp: T } }));
  await symlink(path.join(root, 'outside.jsonl'), path.join(codex, 'rollout-link.jsonl'));

  const claude = path.join(home, '.claude', 'projects', '-projects-site');
  await mkdir(claude, { recursive: true });
  await writeFile(path.join(claude, 'c1.jsonl'), jsonl(
    { type: 'user', uuid: 'u', sessionId: 'claude-1', cwd: '/projects/site', timestamp: T, message: { content: 'Explain the router' } },
    { type: 'assistant', uuid: 'a', parentUuid: 'u', sessionId: 'claude-1', timestamp: T1, message: { content: [{ type: 'text', text: 'It maps paths to views.' }] } },
  ));
  await writeFile(path.join(claude, 'agent-sub.jsonl'), jsonl({ type: 'user', uuid: 'x', sessionId: 'sub', timestamp: T, message: { content: 'subagent' } }));

  const hermes = path.join(home, '.hermes');
  await mkdir(path.join(hermes, 'profiles', 'team'), { recursive: true });
  for (const [file, id] of [[path.join(hermes, 'state.db'), 'hermes-1'], [path.join(hermes, 'profiles', 'team', 'state.db'), 'hermes-1']] as const) {
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, started_at REAL); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER)');
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(id, 'Deploy notes', '/projects/api', Date.parse(T) / 1000);
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp, active) VALUES (?, ?, ?, ?, 1)').run(id, 'user', 'How do we deploy?', Date.parse(T) / 1000);
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp, active) VALUES (?, ?, ?, ?, 1)').run(id, 'assistant', 'Run the release script.', Date.parse(T1) / 1000);
    db.close();
  }

  const gemini = path.join(home, '.gemini', 'tmp', 'abc123', 'chats');
  await mkdir(gemini, { recursive: true });
  await writeFile(path.join(gemini, 'session-1.json'), JSON.stringify({ sessionId: 'gemini-1', projectHash: 'abc123', startTime: T, messages: [
    { id: 'u', type: 'user', timestamp: T, content: 'Summarize the README' },
    { id: 'a', type: 'gemini', timestamp: T1, content: 'It describes the setup.' },
  ] }));
  const antigravity = path.join(home, '.gemini', 'antigravity', 'conversations');
  await mkdir(antigravity, { recursive: true });
  await writeFile(path.join(antigravity, 'x.pb'), Buffer.from([1, 2, 3]));
  return home;
}

describe('native history import through the host', () => {
  it('discovers, previews and imports histories without duplicates, keeping organization', async () => {
    const root = await temp();
    const home = await fakeHome(root);
    const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: path.join(root, 'data'), importHome: home, env: { EXTALIA_SECRET_STORE: 'memory' } });
    try {
      const { host } = runtime;
      const locations = await host.importLocations();
      const available = Object.fromEntries(locations.map(location => [`${location.label}${location.profile && location.profile !== 'default' ? `/${location.profile}` : ''}`, location.available]));
      expect(available).toMatchObject({ Codex: true, 'Claude Code': true, 'Hermes Agent': true, 'Hermes Agent/team': true, 'Gemini CLI': true, 'Antigravity IDE': true });
      expect(locations.find(location => location.sourceId === 'antigravity-ide')?.supported).toBe(false);

      const scan = await host.scanImports();
      const ids = scan.sessions.map(session => session.nativeSessionId).sort();
      expect(ids).toEqual(['claude-1', 'codex-1', 'gemini-1', 'hermes-1', 'hermes-1', 'x']);
      expect(ids).not.toContain('escaped');
      expect(ids).not.toContain('sub');
      const supported = scan.sessions.filter(session => session.supported).map(session => session.id);

      const preview = await host.previewImports(scan.scanId, supported);
      expect(preview.plan).toMatchObject({ addCount: 5, updateCount: 0 });
      expect(preview.sessions.map(entry => entry.session.provenance.sourceSessionId).sort()).toEqual(['claude-1', 'codex-1', 'gemini-1', 'hermes-1', 'profile:team:hermes-1']);
      expect((await host.getState()).library).toHaveLength(0);

      let state = await host.commitImports(scan.scanId, supported);
      expect(state.library).toHaveLength(5);
      const codex = state.library.find(item => item.sourceId === 'codex')!;
      expect(codex).toMatchObject({ title: 'Add a footer', workspaceName: 'site', messageCount: 2 });
      expect((await host.librarySession(codex.id)).messages.map(message => message.content)).toEqual(['Add a footer', 'Footer added.']);

      state = await host.organizeLibrarySession(codex.id, 'rename', 'Footer work');
      state = await host.organizeLibrarySession(codex.id, 'archive');
      const again = await host.scanImports(['codex']);
      state = await host.commitImports(again.scanId, again.sessions.map(session => session.id));
      expect(state.library).toHaveLength(5);
      expect(state.library.find(item => item.id === codex.id)).toMatchObject({ title: 'Footer work', state: 'archived' });

      expect((await host.importPortable('{not json')).plan.rejectionReason).toBeTruthy();
      await expect(host.previewImports('expired', supported)).rejects.toThrow(/expired/);
    } finally {
      await runtime.close();
    }
  });

  it('keeps library state across restarts', async () => {
    const root = await temp();
    const home = await fakeHome(root);
    const options = { kind: 'bridge' as const, version: 'test', dataDirectory: path.join(root, 'data'), importHome: home, env: { EXTALIA_SECRET_STORE: 'memory' } };
    const first = await createAgentHost(options);
    const scan = await first.host.scanImports(['claude-code']);
    await first.host.commitImports(scan.scanId, scan.sessions.map(session => session.id));
    await first.close();
    const second = await createAgentHost(options);
    expect((await second.host.getState()).library.map(item => item.title)).toEqual(['Explain the router']);
    await second.close();
  });
});
