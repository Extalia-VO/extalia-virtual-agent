import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEvent, type ExtaliaEvent } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import type { NormalizedHook } from '../src/hooks/normalize.js';
import { NativeImportService } from '../src/nativeImport.js';
import { Observations, normalizeIgnoreFolders } from '../src/observations.js';
import { useTempDirs } from './helpers.js';

// Synthesized Claude Code and Codex histories in temporary homes only; no real history is read.
const temp = useTempDirs();
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const stamp = (offsetMs: number) => new Date(Date.now() - 60_000 + offsetMs).toISOString();
const spawned = (events: readonly ExtaliaEvent[]) => events.filter(event => event.body.type === 'subagent.spawned');

async function homes() {
  const root = await temp(), home = path.join(root, 'home'), claude = path.join(root, 'claude-home'), codex = path.join(root, 'codex-home');
  await mkdir(home, { recursive: true });
  const source = await NativeImportService.create({ homeDirectory: home, env: { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex } });
  return { root, home, claude, codex, source, state: path.join(root, 'state') };
}

// ── Claude Code: subagent files beside the session transcript ──
const SESSION = 'claude-session-1';
const claudeRow = (type: 'user' | 'assistant', uuid: string, parentUuid: string | null, content: unknown, extra: Record<string, unknown> = {}) =>
  line({ type, sessionId: SESSION, uuid, parentUuid, timestamp: extra.timestamp ?? stamp(0), cwd: '/projects/example', message: { role: type, content, ...(extra.message as object ?? {}) }, ...extra });
const sideRow = (agentId: string, type: 'user' | 'assistant', uuid: string, parentUuid: string | null, content: unknown, at: string, model?: string) =>
  line({ type, sessionId: SESSION, isSidechain: true, agentId, uuid, parentUuid, timestamp: at, cwd: '/projects/example', message: { role: type, content, ...(model ? { model } : {}) } });

async function claudeSession(claude: string, cwd = '/projects/example') {
  const project = path.join(claude, 'projects', '-projects-example');
  const folder = path.join(project, SESSION), subagents = path.join(folder, 'subagents');
  await mkdir(subagents, { recursive: true });
  const main = path.join(project, `${SESSION}.jsonl`);
  await writeFile(main,
    line({ type: 'user', sessionId: SESSION, uuid: 'u0', parentUuid: null, timestamp: stamp(0), cwd, message: { role: 'user', content: '<command-name>/clear</command-name>' } }) +
    claudeRow('user', 'u1', 'u0', 'Build the example feature', { timestamp: stamp(1000), cwd }) +
    claudeRow('assistant', 'a1', 'u1', [{ type: 'tool_use', id: 'toolu_lead', name: 'Agent', input: { description: 'Explore the example code', subagent_type: 'general-purpose' } }],
      { timestamp: stamp(2000), cwd, message: { model: 'claude-lead-model', stop_reason: 'tool_use' } }));
  await writeFile(path.join(folder, 'custom-title.json'), JSON.stringify({ customTitle: 'Example custom title' }));
  await writeFile(path.join(subagents, 'agent-aaa111.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Explore the example code', toolUseId: 'toolu_lead', spawnDepth: 1, model: 'opus' }));
  await writeFile(path.join(subagents, 'agent-aaa111.jsonl'),
    sideRow('aaa111', 'user', 's1', null, 'Explore the example code', stamp(3000)) +
    sideRow('aaa111', 'assistant', 's2', 's1', [{ type: 'tool_use', id: 'toolu_nested', name: 'Agent', input: { description: 'Read one file' } }], stamp(4000), 'claude-sub-model'));
  // A nested sub-agent: its toolUseId belongs to the first sub-agent's tool call.
  await writeFile(path.join(subagents, 'agent-bbb222.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Read one file', toolUseId: 'toolu_nested', spawnDepth: 2 }));
  await writeFile(path.join(subagents, 'agent-bbb222.jsonl'),
    sideRow('bbb222', 'user', 'n1', null, 'Read one file', stamp(5000)) +
    sideRow('bbb222', 'assistant', 'n2', 'n1', [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/projects/example/src/a.ts' } }], stamp(6000), 'claude-nested-model'));
  return { project, folder, subagents, main };
}

// ── Codex: sub-agent threads are their own rollouts naming their parent thread ──
const pad = (value: number) => String(value).padStart(2, '0');
function rolloutName(id: string, offsetMs: number) {
  const date = new Date(Date.now() - 60_000 + offsetMs);
  return `rollout-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${id}.jsonl`;
}
const codexMeta = (id: string, offsetMs: number, spawn?: { parent: string; nickname?: string; role?: string; depth?: number }) => line({
  timestamp: stamp(offsetMs), type: 'session_meta', payload: {
    id, session_id: spawn ? 'thread-root' : id, cwd: '/projects/example', timestamp: stamp(offsetMs),
    ...(spawn ? {
      thread_source: 'subagent', parent_thread_id: spawn.parent, agent_nickname: spawn.nickname, agent_role: spawn.role,
      source: { subagent: { thread_spawn: { parent_thread_id: spawn.parent, depth: spawn.depth ?? 1, agent_path: `/root/${id}`, agent_nickname: spawn.nickname, agent_role: spawn.role } } },
    } : { source: 'vscode', thread_source: 'user' }),
  },
});
const codexTurn = (model: string, offsetMs: number) => line({ timestamp: stamp(offsetMs), type: 'turn_context', payload: { model, cwd: '/projects/example' } });
const codexPrompt = (text: string, offsetMs: number) => line({ timestamp: stamp(offsetMs), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const codexCall = (id: string, cmd: string, offsetMs: number) => line({ timestamp: stamp(offsetMs), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: id, arguments: JSON.stringify({ cmd }) } });

async function codexThreads(codex: string) {
  const folder = path.join(codex, 'sessions', ...(() => { const d = new Date(Date.now() - 60_000); return [String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())]; })());
  await mkdir(folder, { recursive: true });
  const root = path.join(folder, rolloutName('thread-root', 0));
  await writeFile(root, codexMeta('thread-root', 0) + codexTurn('gpt-lead-example', 100) +
    codexPrompt('# AGENTS.md instructions\n\n<INSTRUCTIONS>rules</INSTRUCTIONS>', 200) + codexPrompt('Coordinate the example work', 300));
  const childA = path.join(folder, rolloutName('thread-child-a', 1000));
  await writeFile(childA, codexMeta('thread-child-a', 1000, { parent: 'thread-root', nickname: 'Example the 2nd', role: 'explorer' }) +
    codexTurn('gpt-child-example', 1100) + codexPrompt('Explore the module', 1200) + codexCall('ca1', 'ls src', 1300));
  const childB = path.join(folder, rolloutName('thread-child-b', 2000));
  await writeFile(childB, codexMeta('thread-child-b', 2000, { parent: 'thread-root', role: 'worker' }) + codexTurn('gpt-child-example', 2100) + codexPrompt('Write the patch', 2200));
  const grandchild = path.join(folder, rolloutName('thread-grandchild', 3000));
  await writeFile(grandchild, codexMeta('thread-grandchild', 3000, { parent: 'thread-child-b', nickname: 'Helper', role: 'worker', depth: 2 }) + codexPrompt('Check one test', 3100));
  await writeFile(path.join(codex, 'session_index.jsonl'), line({ id: 'thread-root', thread_name: 'Old name', updated_at: stamp(0) }) + line({ id: 'thread-root', thread_name: 'Example thread name', updated_at: stamp(10) }));
  return { folder, root, childA, childB, grandchild };
}

describe('Claude Code subagents', () => {
  it('merges subagent files into the observed session with labels, roles, models, nesting and stable ids', async () => {
    const f = await homes();
    const files = await claudeSession(f.claude);
    const location = f.source.locations().find(item => item.sourceId === 'claude-code')!;
    const published: ExtaliaEvent[] = [];
    const observer = await Observations.create(f.state, f.source, event => published.push(event), 60_000, { homeDirectory: f.home });
    let reopened: Observations | undefined;
    try {
      await observer.setAutoWatch(location.id, true);
      const [summary] = observer.summaries();
      expect(summary).toMatchObject({ title: 'Example custom title', model: 'claude-lead-model', agentName: expect.any(String), agentGender: expect.stringMatching(/^(female|male)$/),
        observation: { sourceId: 'claude-code', channel: 'transcript', auto: true } });
      const id = summary!.id;
      const events = observer.events(id);
      expect(events.every(event => parseEvent(event).ok)).toBe(true);
      const announced = spawned(events);
      expect(announced.map(event => [event.agentId, event.body])).toEqual([
        ['primary', { type: 'subagent.spawned', subagentId: 'aaa111', label: 'Explore the example code', role: 'general-purpose', model: 'claude-sub-model' }],
        ['aaa111', { type: 'subagent.spawned', subagentId: 'bbb222', label: 'Read one file', role: 'Explore', model: 'claude-nested-model' }],
      ]);
      expect(events.some(event => event.agentId === 'bbb222' && event.body.type === 'tool.started' && event.body.target === 'a.ts')).toBe(true);

      // A poll reads only what changed: new subagent steps are published once, the announcement never again.
      published.length = 0;
      await observer.refresh();
      expect(published).toHaveLength(0);
      await appendFile(path.join(files.subagents, 'agent-bbb222.jsonl'),
        line({ type: 'user', sessionId: SESSION, isSidechain: true, agentId: 'bbb222', uuid: 'n3', parentUuid: 'n2', timestamp: stamp(7000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'export {}' }] } }));
      await observer.refresh();
      expect(published.map(event => event.body.type)).toEqual(['tool.completed', 'session.updated']);
      expect(published[0]!.agentId).toBe('bbb222');
      const ids = observer.events(id).map(event => event.id);
      expect(new Set(ids).size).toBe(ids.length);

      // A later custom title is followed; a rename by the user is kept.
      await writeFile(path.join(files.folder, 'custom-title.json'), JSON.stringify({ customTitle: 'Renamed in Claude Code' }));
      await observer.refresh();
      expect(observer.summaries()[0]!.title).toBe('Renamed in Claude Code');
      await observer.rename(id, 'My own name');
      await writeFile(path.join(files.folder, 'custom-title.json'), JSON.stringify({ customTitle: 'Third title' }));
      await observer.refresh();
      expect(observer.summaries()[0]!.title).toBe('My own name');

      // The generated lead name is saved with the record.
      const name = observer.summaries()[0]!.agentName;
      await observer.close();
      reopened = await Observations.create(f.state, f.source, () => undefined, 60_000, { homeDirectory: f.home });
      expect(reopened.summaries()[0]).toMatchObject({ id, agentName: name, model: 'claude-lead-model' });
      expect(reopened.events(id).map(event => event.id)).toEqual(observer.events(id).map(event => event.id));
    } finally { await observer.close(); await reopened?.close(); }
  });
});

describe('Codex sub-agent threads', () => {
  it('groups child threads under their root session, with nicknames, roles, models and nesting', async () => {
    const f = await homes();
    const files = await codexThreads(f.codex);
    const location = f.source.locations().find(item => item.sourceId === 'codex' && item.label === 'Codex')!;
    // The history list shows the root only.
    const scan = f.source.scan([location.id]);
    expect(scan.sessions.map(item => item.nativeSessionId)).toEqual(['thread-root']);

    const published: ExtaliaEvent[] = [];
    const observer = await Observations.create(f.state, f.source, event => published.push(event), 60_000, { homeDirectory: f.home });
    try {
      await observer.setAutoWatch(location.id, true);
      const summaries = observer.summaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({ title: 'Example thread name', model: 'gpt-lead-example', observation: { nativeSessionId: 'thread-root', channel: 'transcript' } });
      const id = summaries[0]!.id;
      const announced = spawned(observer.events(id));
      expect(announced.map(event => [event.agentId, event.body])).toEqual([
        ['primary', { type: 'subagent.spawned', subagentId: 'thread-child-a', label: 'Example the 2nd', role: 'explorer', model: 'gpt-child-example' }],
        ['primary', { type: 'subagent.spawned', subagentId: 'thread-child-b', role: 'worker', model: 'gpt-child-example' }],
        ['thread-child-b', { type: 'subagent.spawned', subagentId: 'thread-grandchild', label: 'Helper', role: 'worker' }],
      ]);
      expect(observer.events(id).some(event => event.agentId === 'thread-child-a' && event.body.type === 'tool.started')).toBe(true);

      // Growing a child publishes only its new steps; polling again publishes nothing.
      published.length = 0;
      await appendFile(files.childB, codexCall('cb1', 'pnpm test', 2300));
      await observer.refresh();
      expect(published.filter(event => event.body.type !== 'session.updated').map(event => [event.agentId, event.body.type])).toEqual([
        ['thread-child-b', 'agent.state'], ['thread-child-b', 'tool.started'],
      ]);
      published.length = 0;
      await observer.refresh();
      expect(published).toHaveLength(0);

      // A child thread reported by hooks goes to the root session as that sub-agent.
      const hook: NormalizedHook = {
        app: 'codex', sessionId: 'thread-child-a', event: 'PreToolUse', starts: false, ends: false, cwd: '/projects/example', transcriptPath: files.childA,
        steps: [{ agentId: 'primary', body: { type: 'tool.started', toolCallId: 'hk1', tool: 'exec_command', kind: 'command', label: 'Running ls' } }],
      };
      published.length = 0;
      await observer.receiveHook(hook);
      expect(observer.summaries()).toHaveLength(1);
      expect(observer.summaries()[0]!.observation).toMatchObject({ channel: 'hook', hook: true });
      expect(published.filter(event => event.body.type !== 'session.updated').map(event => [event.agentId, event.body.type])).toEqual([
        ['primary', 'session.started'], ['primary', 'subagent.spawned'], ['thread-child-a', 'tool.started'],
      ]);
    } finally { await observer.close(); }
  });

  it('observing a child thread from a scan observes its root, and old records of a child follow the root', async () => {
    const f = await homes();
    const files = await codexThreads(f.codex);
    const location = f.source.locations().find(item => item.sourceId === 'codex' && item.label === 'Codex')!;
    expect(f.source.rootReference({ locationId: location.id, sourceId: 'codex', nativeSessionId: 'thread-root', path: files.grandchild }))
      .toMatchObject({ nativeSessionId: 'thread-root', path: files.root, subagentId: 'thread-grandchild' });
    // A record saved by an older version that points at a child rollout.
    await mkdir(f.state, { recursive: true });
    await writeFile(path.join(f.state, 'observations.json'), JSON.stringify([{
      id: 's_legacy0001', title: '# AGENTS.md instructions', watching: true, createdAt: stamp(0), lastActiveAt: stamp(0),
      reference: { locationId: location.id, sourceId: 'codex', nativeSessionId: 'thread-root', path: files.childA },
    }]));
    const observer = await Observations.create(f.state, f.source, () => undefined, 60_000, { homeDirectory: f.home });
    try {
      const [summary] = observer.summaries();
      expect(summary).toMatchObject({ id: 's_legacy0001', title: 'Example thread name', agentName: expect.any(String), observation: { status: 'watching', nativeSessionId: 'thread-root' } });
      expect(spawned(observer.events('s_legacy0001'))).toHaveLength(3);
      const saved = JSON.parse(await readFile(path.join(f.state, 'observations.json'), 'utf8')) as { reference: { path: string }; agentName?: string }[];
      expect(saved[0]).toMatchObject({ reference: { path: files.root }, agentName: summary!.agentName });
    } finally { await observer.close(); }
  });
});

describe('ignored folders', () => {
  it('skips claude-mem helper sessions by default in auto-watch and hooks, and retires matching automatic observations', async () => {
    const f = await homes();
    const helperCwd = path.join(f.home, '.claude-mem', 'observer-sessions');
    await claudeSession(f.claude, helperCwd);
    const location = f.source.locations().find(item => item.sourceId === 'claude-code')!;
    const retired: string[] = [];
    const observer = await Observations.create(f.state, f.source, () => undefined, 60_000, { homeDirectory: f.home, retire: async session => { retired.push(session.title); } });
    try {
      expect(observer.ignoreFolders()).toEqual(['~/.claude-mem']);
      expect(observer.ignoredPath(helperCwd)).toBe(true);
      expect(observer.ignoredPath(path.join(f.home, '.claude-memory'))).toBe(false);
      await observer.setAutoWatch(location.id, true);
      expect(observer.summaries()).toHaveLength(0);
      await observer.receiveHook({ app: 'claude', sessionId: 'helper-hook', event: 'UserPromptSubmit', starts: true, ends: false, cwd: helperCwd,
        steps: [{ agentId: 'primary', body: { type: 'prompt.submitted', text: 'Condense the tool payload', via: 'native' } }] });
      expect(observer.summaries()).toHaveLength(0);

      // Removing the default lets them in; adding it back retires the automatic observation without keeping it in History.
      await observer.setPrivacy({ ignoreFolders: [] });
      await observer.refresh();
      expect(observer.summaries()).toHaveLength(1);
      await observer.setPrivacy({ ignoreFolders: ['~/.claude-mem/'] });
      expect(observer.summaries()).toHaveLength(0);
      expect(retired).toEqual([]);
      const saved = JSON.parse(await readFile(path.join(f.state, 'observer-discovery.json'), 'utf8')) as { ignoreFolders?: string[] };
      expect(saved.ignoreFolders).toEqual(['~/.claude-mem']);
      await observer.setPrivacy({ ignoreFolders: null });
      expect(observer.ignoreFolders()).toEqual(['~/.claude-mem']);
      await expect(observer.setPrivacy({ ignoreFolders: ['relative/folder'] })).rejects.toThrow('full folder path');
    } finally { await observer.close(); }
  });

  it('validates folder lists', () => {
    expect(normalizeIgnoreFolders([' /tmp/example/ ', '/tmp/example', '~', '', '~/x'])).toEqual(['/tmp/example', '~', '~/x']);
    expect(() => normalizeIgnoreFolders('~/x')).toThrow();
    expect(() => normalizeIgnoreFolders(Array.from({ length: 51 }, (_, index) => `/f${index}`))).toThrow();
    expect(() => normalizeIgnoreFolders(['/a\nb'])).toThrow();
  });
});

describe('large transcripts', () => {
  it('observes the beginning and latest activity of a transcript over the live read limit, with stable absolute positions', async () => {
    const f = await homes();
    const { folder } = await codexThreads(f.codex);
    const big = path.join(folder, rolloutName('thread-big', 5000));
    const filler = 'x'.repeat(10_000);
    let content = codexMeta('thread-big', 5000) + codexTurn('gpt-big-example', 5050) + codexPrompt('Start the big example job', 5100);
    for (let index = 0; index < 520; index++) content += codexCall(`b${index}`, 'ls', 5200) + line({ timestamp: stamp(5200), type: 'response_item', payload: { type: 'function_call_output', call_id: `b${index}`, output: filler } });
    await writeFile(big, content);
    const lines = content.split('\n').length - 1;
    const location = f.source.locations().find(item => item.sourceId === 'codex' && item.label === 'Codex')!;
    const reference = { locationId: location.id, sourceId: 'codex', nativeSessionId: 'thread-big', path: big };
    const first = f.source.readObservation(reference);
    expect(first.session.title).toBe('Start the big example job');
    expect(first.model).toBe('gpt-big-example');
    expect(first.steps.at(-1)!.pos).toBe(`L${lines - 1}`);
    expect(first.steps.some(step => step.pos === 'L2' && step.type === 'prompt')).toBe(true);
    await appendFile(big, codexCall('last', 'pnpm test', 6000));
    const second = f.source.readObservation(reference);
    expect(second.steps.at(-1)).toMatchObject({ pos: `L${lines}`, type: 'tool.call', callId: 'last' });
    const shared = first.steps.filter(step => second.steps.some(other => other.pos === step.pos));
    expect(shared.length).toBeGreaterThan(100);
    // Too large to import, but listed for observation.
    const candidate = f.source.scan([location.id]).sessions.find(item => item.nativeSessionId === 'thread-big');
    expect(candidate).toBeDefined();
  });
});
