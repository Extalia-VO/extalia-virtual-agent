import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeImportService } from '../src/nativeImport.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const relativeRoots: string[] = [];
afterEach(async () => {
  await Promise.all(relativeRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function relativeFixtureRoot() {
  // Windows CI may put tmpdir() and cwd() on different drives, making
  // path.relative(cwd, tmpdir) absolute. Keep these invalid-root fixtures local.
  const root = await mkdtemp(path.join(process.cwd(), '.extalia-relative-import-'));
  relativeRoots.push(root);
  return root;
}
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
    const root = await relativeFixtureRoot(), home = path.join(root, 'home');
    await hermesDatabase(path.join(home, '.hermes'), 'Default history must not be substituted');
    const selected = kind === 'relative' ? path.join(root, 'relative-hermes') : path.join(root, '${UNRESOLVED_HERMES_HOME}', 'hermes');
    await hermesDatabase(selected, 'Invalid-root history must not be read');
    const codex = path.join(home, '.codex', 'sessions'); await mkdir(codex, { recursive: true });
    await writeFile(path.join(codex, 'rollout-valid.jsonl'), [
      { type: 'session_meta', payload: { id: 'valid-codex', cwd: '/projects/example', timestamp: stamp } },
      { timestamp: stamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'The unaffected Codex session' }] } },
    ].map(row => JSON.stringify(row)).join('\n'));
    const relativeHome = path.relative(process.cwd(), selected);
    expect(path.isAbsolute(relativeHome)).toBe(false);
    const source = await NativeImportService.create({ homeDirectory: home, env: { HERMES_HOME: kind === 'relative' ? relativeHome : selected } });
    const locations = source.locations().filter(item => item.sourceId === 'hermes');
    expect(locations).toHaveLength(1);
    expect(locations[0]).toMatchObject({ available: false, supported: false, note: expect.stringMatching(/absolute|unresolved/) });
    expect(source.scan().sessions).toMatchObject([{ nativeSessionId: 'valid-codex', sourceId: 'codex' }]);
  });

  it('reports bad Codex and Gemini roots separately without hiding a valid Claude transcript', async () => {
    const root = await relativeFixtureRoot(), home = path.join(root, 'home'), badCodex = path.join(root, 'relative-codex'), badGemini = path.join(root, '${UNRESOLVED_GEMINI_HOME}');
    const codex = path.join(badCodex, 'sessions'); await mkdir(codex, { recursive: true });
    await writeFile(path.join(codex, 'rollout-invalid.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'unselected-codex', timestamp: stamp } }));
    const chats = path.join(badGemini, '.gemini', 'tmp', 'project', 'chats'); await mkdir(chats, { recursive: true });
    await writeFile(path.join(chats, 'session-invalid.json'), JSON.stringify({ sessionId: 'unselected-gemini', startTime: stamp, messages: [{ type: 'user', timestamp: stamp, content: 'Do not scan this unresolved path' }] }));
    const claude = path.join(home, '.claude', 'projects', 'example'); await mkdir(claude, { recursive: true });
    await writeFile(path.join(claude, 'valid.jsonl'), JSON.stringify({ type: 'user', uuid: 'user-one', sessionId: 'valid-claude', cwd: '/projects/example', timestamp: stamp, message: { content: 'The unaffected Claude session' } }));
    const relativeCodex = path.relative(process.cwd(), badCodex);
    expect(path.isAbsolute(relativeCodex)).toBe(false);
    const source = await NativeImportService.create({ homeDirectory: home, env: { CODEX_HOME: relativeCodex, GEMINI_CLI_HOME: badGemini } });
    const locations = source.locations();
    expect(locations.filter(item => item.sourceId === 'codex').every(item => !item.available && !item.supported && /absolute/.test(item.note ?? ''))).toBe(true);
    expect(locations.find(item => item.sourceId === 'gemini-cli')).toMatchObject({ available: false, supported: false, note: expect.stringMatching(/unresolved/) });
    expect(source.scan().sessions).toMatchObject([{ nativeSessionId: 'valid-claude', sourceId: 'claude-code' }]);
  });

  it('hydrates truncated Antigravity planner responses from sibling transcript_full.jsonl without leaking thinking', async () => {
    const root = await temp(), home = path.join(root, 'home'), antigravity = path.join(root, 'antigravity');
    const logs = path.join(antigravity, 'brain', 'conv-full-1', '.system_generated', 'logs');
    await mkdir(home, { recursive: true });
    await mkdir(logs, { recursive: true });
    const fullContent = [
      '## Bagian I: Cara Hermes Agent Membangun & Mengelola Skills',
      '### 1. Struktur Paket Skill di Disk',
      '```text',
      '~/.hermes/skills/<category>/<skill-name>/',
      '├── SKILL.md',
      '├── references/',
      '└── templates/',
      '```',
      '### 2. Standar Frontmatter, Validasi Keras & Linter (skill_manager_tool.py & skill_linter.py)',
      'Detail validasi frontmatter dan linter.\n'.repeat(600),
      '## Bagian II: Cara Hermes Membangun Knowledge Base & Integrasi Obsidian',
      'Detail penuh Knowledge Base dan Obsidian.',
    ].join('\n');
    const compactContent = [
      '## Bagian I: Cara Hermes Agent Membangun & Mengelola Skills',
      '### 1. Struktur Paket Skill di Disk',
      '```text',
      '~/.hermes/skills/<category>/<skill-name>/',
      '├── SKILL.md',
      '',
      '<truncated 20525 bytes>',
      '',
      'Detail penuh Knowledge Base dan Obsidian.',
    ].join('\n');
    const userRow = { step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: stamp, content: '<USER_REQUEST>\nPelajari cara Hermes membangun skills dan knowledge/obsidian secara detail\n</USER_REQUEST>' };
    await writeFile(path.join(logs, 'transcript.jsonl'), [
      JSON.stringify(userRow),
      JSON.stringify({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: stamp, content: compactContent, thinking: 'short-thinking\n<truncated 8000 bytes>', truncated_fields: ['content', 'thinking'] }),
    ].join('\n') + '\n');
    await writeFile(path.join(logs, 'transcript_full.jsonl'), [
      JSON.stringify(userRow),
      JSON.stringify({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: stamp, content: fullContent, thinking: 'private-full-thinking-never-exposed' }),
    ].join('\n') + '\n');

    const source = await NativeImportService.create({ homeDirectory: home, env: { ANTIGRAVITY_HOME: antigravity } });
    const scan = source.scan();
    const candidate = scan.sessions.find(item => item.nativeSessionId === 'conv-full-1');
    expect(candidate).toBeDefined();
    const preview = source.preview(scan.scanId, [candidate!.id]);
    const assistantMsg = preview.sessions[0]?.session.messages.find(m => m.role === 'assistant');
    expect(assistantMsg?.content).toContain('### 2. Standar Frontmatter, Validasi Keras & Linter (skill_manager_tool.py & skill_linter.py)');
    expect(assistantMsg?.content).toContain('## Bagian II: Cara Hermes Membangun Knowledge Base & Integrasi Obsidian');
    expect(assistantMsg?.content).not.toContain('<truncated 20525 bytes>');
    expect(JSON.stringify(preview)).not.toContain('private-full-thinking-never-exposed');

    const observed = source.readObservation({
      locationId: candidate!.locationId,
      sourceId: 'antigravity',
      nativeSessionId: candidate!.nativeSessionId,
      path: path.join(logs, 'transcript.jsonl'),
    });
    const replyStep = observed.steps.find(step => step.type === 'reply');
    expect(replyStep?.type === 'reply' ? replyStep.text : '').toContain('### 2. Standar Frontmatter, Validasi Keras & Linter (skill_manager_tool.py & skill_linter.py)');
    expect(replyStep?.type === 'reply' ? replyStep.text : '').toContain('## Bagian II: Cara Hermes Membangun Knowledge Base & Integrasi Obsidian');
    expect(replyStep?.type === 'reply' ? replyStep.text : '').not.toContain('<truncated 20525 bytes>');
  });
});
