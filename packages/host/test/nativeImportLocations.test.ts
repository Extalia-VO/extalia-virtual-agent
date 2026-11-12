import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { NativeImportService } from '../src/nativeImport.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const stamp = '2026-11-12T00:00:00.000Z';
async function hermesDatabase(home: string, message: string) {
  await mkdir(home, { recursive: true });
  const file = path.join(home, 'state.db'), db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, started_at REAL); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER)');
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('shared-native-id', message, '/projects/example', 1_770_000_000);
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)').run(1, 'shared-native-id', 'user', message, 1_770_000_000, 1);
  } finally { db.close(); }
  return file;
}

describe('connected-agent history roots in temporary homes', () => {
  it('uses only the official Windows Hermes installation when legacy history also exists', async () => {
    const root = await temp(), home = path.join(root, 'home'), local = path.join(home, 'AppData', 'Local');
    const official = await hermesDatabase(path.join(local, 'hermes'), 'Official installation history');
    const legacy = await hermesDatabase(path.join(home, '.hermes'), 'Unselected legacy history');
    const before = await readFile(official), legacyBefore = await readFile(legacy);
    const source = await NativeImportService.create({ homeDirectory: home, platform: 'win32', env: { LOCALAPPDATA: local } });
    const scan = source.scan();
    expect(scan.sessions.filter(item => item.sourceId === 'hermes')).toMatchObject([{ title: 'Official installation history', profile: 'default' }]);
    expect(scan.sessions).toHaveLength(1);
    expect(await readFile(official)).toEqual(before); expect(await readFile(legacy)).toEqual(legacyBefore);
  });

  it('keeps an existing legacy Windows installation discoverable when no official root exists', async () => {
    const root = await temp(), home = path.join(root, 'home');
    await hermesDatabase(path.join(home, '.hermes'), 'Legacy installation history');
    const source = await NativeImportService.create({ homeDirectory: home, platform: 'win32', env: {} });
    expect(source.scan().sessions).toMatchObject([{ title: 'Legacy installation history', profile: 'default' }]);
  });

  it('binds an explicitly selected named Hermes home to its actual profile without enrolling siblings', async () => {
    const root = await temp(), home = path.join(root, 'home'), hermes = path.join(root, 'custom-hermes');
    await mkdir(home); await hermesDatabase(hermes, 'Default profile history');
    await hermesDatabase(path.join(hermes, 'profiles', 'team'), 'Selected team history');
    await hermesDatabase(path.join(hermes, 'profiles', 'other'), 'Unselected sibling history');
    const source = await NativeImportService.create({ homeDirectory: home, env: { HERMES_HOME: path.join(hermes, 'profiles', 'team') } });
    const scan = source.scan();
    expect(scan.sessions).toMatchObject([{ title: 'Selected team history', nativeSessionId: 'shared-native-id', profile: 'team' }]);
    expect(scan.sessions).toHaveLength(1);
    expect(source.preview(scan.scanId, [scan.sessions[0]!.id]).sessions[0]!.session.provenance.sourceSessionId).toBe('profile:team:shared-native-id');
    expect(source.locations().filter(item => item.sourceId === 'hermes').map(item => item.profile)).toEqual(['team']);
  });

  it('keeps a missing explicit Hermes override from falling back to another installed profile', async () => {
    const root = await temp(), home = path.join(root, 'home');
    await hermesDatabase(path.join(home, '.hermes'), 'Existing but unselected history');
    const source = await NativeImportService.create({ homeDirectory: home, env: { HERMES_HOME: path.join(root, 'missing') } });
    expect(source.scan().sessions).toEqual([]);
  });

  it('uses explicit Codex, Claude, Gemini base-home and Antigravity roots from the shared resolver', async () => {
    const root = await temp(), home = path.join(root, 'home'); await mkdir(home);
    const codex = path.join(root, 'codex'), claude = path.join(root, 'claude'), base = path.join(root, 'gemini-base'), antigravity = path.join(root, 'antigravity');
    await mkdir(path.join(codex, 'sessions'), { recursive: true }); await mkdir(path.join(claude, 'projects'), { recursive: true });
    const chats = path.join(base, '.gemini', 'tmp', 'project-one', 'chats'); await mkdir(chats, { recursive: true });
    await writeFile(path.join(base, '.gemini', 'projects.json'), JSON.stringify({ projects: { '/projects/selected-gemini': 'project-one' } }));
    await writeFile(path.join(chats, 'session-selected.json'), JSON.stringify({ sessionId: 'selected-gemini', startTime: stamp, messages: [{ type: 'user', timestamp: stamp, content: 'Selected custom-home session' }] }));
    await mkdir(path.join(base, '.cache', '.gemini', 'tmp'), { recursive: true });
    await mkdir(path.join(antigravity, 'brain'), { recursive: true });
    const source = await NativeImportService.create({ homeDirectory: home, env: { CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude, GEMINI_CLI_HOME: base, ANTIGRAVITY_HOME: antigravity } });
    const locations = source.locations();
    expect(locations.find(item => item.sourceId === 'codex' && item.available)?.path).toBe(path.join(codex, 'sessions'));
    expect(locations.find(item => item.sourceId === 'claude-code')?.path).toBe(path.join(claude, 'projects'));
    expect(locations.find(item => item.label === 'Gemini CLI')?.path).toBe(path.join(base, '.gemini', 'tmp'));
    expect(locations.find(item => item.label === 'Gemini CLI (sandbox)')?.path).toBe(path.join(base, '.cache', '.gemini', 'tmp'));
    expect(locations.find(item => item.sourceId === 'antigravity')?.path).toBe(path.join(antigravity, 'brain'));
    expect(source.scan().sessions).toMatchObject([{ nativeSessionId: 'selected-gemini', projectPath: '/projects/selected-gemini' }]);
  });

  it.each(['relative', 'unresolved'] as const)('marks a %s Hermes home unavailable without scanning it or falling back, while Codex still works', async kind => {
    const root = await temp(), home = path.join(root, 'home');
    await hermesDatabase(path.join(home, '.hermes'), 'Default history must not be substituted');
    const selected = kind === 'relative' ? path.join(root, 'relative-hermes') : path.join(root, '${UNRESOLVED_HERMES_HOME}', 'hermes');
    await hermesDatabase(selected, 'Invalid-root history must not be read');
    const codex = path.join(home, '.codex', 'sessions'); await mkdir(codex, { recursive: true });
    await writeFile(path.join(codex, 'rollout-valid.jsonl'), [
      { type: 'session_meta', payload: { id: 'valid-codex', cwd: '/projects/example', timestamp: stamp } },
      { timestamp: stamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'The unaffected Codex session' }] } },
    ].map(row => JSON.stringify(row)).join('\n'));
    const source = await NativeImportService.create({ homeDirectory: home, env: { HERMES_HOME: kind === 'relative' ? path.relative(process.cwd(), selected) : selected } });
    const locations = source.locations().filter(item => item.sourceId === 'hermes');
    expect(locations).toHaveLength(1);
    expect(locations[0]).toMatchObject({ available: false, supported: false, note: expect.stringMatching(/absolute|unresolved/) });
    expect(source.scan().sessions).toMatchObject([{ nativeSessionId: 'valid-codex', sourceId: 'codex' }]);
  });

  it('reports bad Codex and Gemini roots separately without hiding a valid Claude transcript', async () => {
    const root = await temp(), home = path.join(root, 'home'), badCodex = path.join(root, 'relative-codex'), badGemini = path.join(root, '${UNRESOLVED_GEMINI_HOME}');
    const codex = path.join(badCodex, 'sessions'); await mkdir(codex, { recursive: true });
    await writeFile(path.join(codex, 'rollout-invalid.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'unselected-codex', timestamp: stamp } }));
    const chats = path.join(badGemini, '.gemini', 'tmp', 'project', 'chats'); await mkdir(chats, { recursive: true });
    await writeFile(path.join(chats, 'session-invalid.json'), JSON.stringify({ sessionId: 'unselected-gemini', startTime: stamp, messages: [{ type: 'user', timestamp: stamp, content: 'Do not scan this unresolved path' }] }));
    const claude = path.join(home, '.claude', 'projects', 'example'); await mkdir(claude, { recursive: true });
    await writeFile(path.join(claude, 'valid.jsonl'), JSON.stringify({ type: 'user', uuid: 'user-one', sessionId: 'valid-claude', cwd: '/projects/example', timestamp: stamp, message: { content: 'The unaffected Claude session' } }));
    const source = await NativeImportService.create({ homeDirectory: home, env: { CODEX_HOME: path.relative(process.cwd(), badCodex), GEMINI_CLI_HOME: badGemini } });
    const locations = source.locations();
    expect(locations.filter(item => item.sourceId === 'codex').every(item => !item.available && !item.supported && /absolute/.test(item.note ?? ''))).toBe(true);
    expect(locations.find(item => item.sourceId === 'gemini-cli')).toMatchObject({ available: false, supported: false, note: expect.stringMatching(/unresolved/) });
    expect(source.scan().sessions).toMatchObject([{ nativeSessionId: 'valid-claude', sourceId: 'claude-code' }]);
  });
});
