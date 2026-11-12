import { appendFile, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseEvent, type ExtaliaEvent } from '@extalia/protocol';
import { describe, expect, it, vi } from 'vitest';
import { NativeImportService } from '../src/nativeImport.js';
import { Observations } from '../src/observations.js';
import { createAgentHost } from '../src/service.js';
import { normalizeCodexHook, normalizeHook, type HookApp } from '../src/hooks/normalize.js';
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

describe('explicit observed meetings', () => {
  const report = (input: Record<string, unknown>, sessionId = 'native-one', app: HookApp = 'codex') => normalizeHook(app, { session_id: sessionId, hook_event_name: 'report_meeting', tool_input: input })!;
  const start = { phase: 'start', meeting_id: 'meeting-1', participants: ['primary', 'worker-1'], room_id: 'meeting-a', topic: 'Review the plan' };
  const contribution = { phase: 'contribution', meeting_id: 'meeting-1', agent_id: 'worker-1', round: 1, text: 'Use the smaller change.' };
  const complete = { phase: 'complete', meeting_id: 'meeting-1', outcome: 'completed', note_path: '/projects/example/notes/meeting.md' };
  const meetings = (f: Awaited<ReturnType<typeof fixture>>) => f.observer.events(f.id).filter(event => event.body.type.startsWith('meeting.'));
  const announce = async (f: Awaited<ReturnType<typeof fixture>>) => f.observer.receiveHook(normalizeCodexHook({ session_id: 'native-one', hook_event_name: 'SubagentStart', agent_id: 'worker-1', agent_type: 'Reviewer' })!);

  it('requires independent participant evidence and admits each explicit lifecycle report once', async () => {
    const f = await fixture();
    try {
      await f.observer.receiveHook(report(start));
      expect(meetings(f)).toEqual([]);
      expect(f.observer.events(f.id).some(event => event.body.type === 'subagent.spawned')).toBe(false);
      await announce(f);
      await f.observer.receiveHook(report(start));
      await f.observer.receiveHook(report(start));
      await f.observer.receiveHook(report({ ...start, meeting_id: 'other-active' }));
      await f.observer.receiveHook(report(contribution));
      await f.observer.receiveHook(report(contribution));
      await f.observer.receiveHook(report({ ...contribution, agent_id: 'invented-agent', round: 2 }));
      await f.observer.receiveHook(report({ ...contribution, agent_id: 'primary', meeting_id: 'foreign-meeting' }));
      await f.observer.receiveHook(report({ ...complete, meeting_id: 'foreign-meeting' }));
      await f.observer.receiveHook(report({ ...complete, agent_id: 'worker-1' }));
      await f.observer.receiveHook(report({ ...contribution, round: 2 }));
      await f.observer.receiveHook(report(complete));
      await f.observer.receiveHook(report(complete));
      await f.observer.receiveHook(report(start));
      await f.observer.receiveHook(report(contribution));
      expect(meetings(f).map(event => event.body.type)).toEqual(['meeting.started', 'meeting.contribution', 'meeting.contribution', 'meeting.completed']);
      expect(meetings(f).at(-1)?.body).toMatchObject({ outcome: 'completed', notePath: '/projects/example/notes/meeting.md' });
      expect(meetings(f).every(event => parseEvent(event).ok && event.sessionId === f.id && event.source.runtime === 'codex')).toBe(true);
      expect(f.observer.events(f.id).some(event => event.body.type === 'subagent.spawned' && event.body.subagentId === 'invented-agent')).toBe(false);
    } finally { await f.observer.close(); }
  });

  it('does not borrow participant identity or meeting state from another source or session', async () => {
    const f = await fixture();
    try {
      for (const [app, sessionId] of [['claude', 'native-one'], ['codex', 'native-two']] as const) {
        await f.observer.receiveHook(normalizeHook(app, { session_id: sessionId, hook_event_name: 'SubagentStart', agent_id: 'worker-1' })!);
      }
      await f.observer.receiveHook(report(start));
      expect(meetings(f)).toEqual([]);
      await announce(f);
      await f.observer.receiveHook(report(start));
      await f.observer.receiveHook(report(contribution, 'native-two'));
      await f.observer.receiveHook(report(complete, 'native-one', 'claude'));
      expect(meetings(f).map(event => event.body.type)).toEqual(['meeting.started']);
      await f.observer.receiveHook(report(complete));
      expect(meetings(f).map(event => event.body.type)).toEqual(['meeting.started', 'meeting.completed']);
    } finally { await f.observer.close(); }
  });

  it('never creates a new observation or participant solely from a meeting report', async () => {
    const f = await fixture();
    try {
      await f.observer.receiveHook(report({ ...start, participants: ['primary'] }, 'unknown-session'));
      expect(f.observer.summaries()).toHaveLength(1);
      await f.observer.receiveHook(report({ ...start, agent_id: 'unknown-reporter', participants: ['primary'] }));
      expect(meetings(f)).toEqual([]);
      expect(f.observer.events(f.id).some(event => event.body.type === 'subagent.spawned')).toBe(false);
    } finally { await f.observer.close(); }
  });

  it.each(['SessionEnd', 'StopFailure'])('closes the active meeting on %s and rejects stale reports', async event => {
    const f = await fixture();
    try {
      await announce(f);
      await f.observer.receiveHook(report(start));
      await f.observer.receiveHook(normalizeCodexHook({ session_id: 'native-one', hook_event_name: event, error: 'rate_limit', error_message: 'Rate limit' })!);
      await f.observer.receiveHook(report(contribution));
      await f.observer.receiveHook(report(complete));
      expect(meetings(f).map(event => event.body.type)).toEqual(['meeting.started', 'meeting.completed']);
      expect(meetings(f).at(-1)?.body).toEqual({ type: 'meeting.completed', meetingId: 'meeting-1', outcome: event === 'SessionEnd' ? 'cancelled' : 'failed' });
    } finally { await f.observer.close(); }
  });

  it('closes a child-reported meeting when that known child stops', async () => {
    const f = await fixture();
    try {
      await announce(f);
      await f.observer.receiveHook(report({ ...start, agent_id: 'worker-1' }));
      await f.observer.receiveHook(normalizeCodexHook({ session_id: 'native-one', hook_event_name: 'SubagentStop', agent_id: 'worker-1' })!);
      await f.observer.receiveHook(report({ ...complete, agent_id: 'worker-1' }));
      expect(meetings(f).map(event => event.body.type)).toEqual(['meeting.started', 'meeting.completed']);
      expect(meetings(f).at(-1)?.body).toEqual({ type: 'meeting.completed', meetingId: 'meeting-1', outcome: 'cancelled' });
    } finally { await f.observer.close(); }
  });

  it('drops meeting content at ingestion and removes retained content when labels-only is enabled', async () => {
    const f = await fixture();
    try {
      await announce(f);
      await f.observer.receiveHook(report(start));
      await f.observer.receiveHook(report(contribution));
      await f.observer.setPrivacy({ labelsOnly: true });
      // Exercise the observer's own privacy boundary with already-normalized input,
      // including legacy completion fields that the new MCP tool does not accept.
      const hook = report(complete);
      hook.steps[0]!.body = { type: 'meeting.completed', meetingId: 'meeting-1', outcome: 'completed', notePath: '/projects/example/private.md', decisions: ['Private decision'], actionItems: ['Private action'] };
      await f.observer.receiveHook(hook);
      await f.observer.receiveHook(report({ ...start, meeting_id: 'meeting-2' }));
      await f.observer.receiveHook(report({ ...contribution, meeting_id: 'meeting-2' }));
      await f.observer.receiveHook(report({ ...complete, meeting_id: 'meeting-2' }));
      expect(meetings(f).map(event => event.body.type)).toEqual(['meeting.started', 'meeting.completed', 'meeting.started', 'meeting.completed']);
      const serialized = JSON.stringify(meetings(f));
      for (const content of ['Review the plan', 'Use the smaller change', 'Private decision', 'Private action', '/projects/example']) expect(serialized).not.toContain(content);
      expect(meetings(f)[0]?.body).toEqual({ type: 'meeting.started', meetingId: 'meeting-1', participants: ['primary', 'worker-1'], roomId: 'meeting-a' });
      await f.observer.setPrivacy({ labelsOnly: false });
      expect(JSON.stringify(meetings(f))).not.toContain('Use the smaller change');
    } finally { await f.observer.close(); }
  });
});

describe('live transcript observation', () => {
  it('recovers a missing transcript status when a real hook reports activity without fabricating transcript history', async () => {
    const f = await fixture();
    try {
      await rm(f.file);
      await f.observer.refresh();
      expect(f.observer.summaries()[0]?.observation).toMatchObject({ status: 'unavailable' });
      const probe = normalizeCodexHook({ session_id: 'native-one', hook_event_name: 'ExtaliaConnectTest' })!;
      await f.observer.receiveHook(probe);
      expect(f.observer.summaries()[0]?.observation?.status).toBe('unavailable');
      const unknown = normalizeCodexHook({ session_id: 'native-one', hook_event_name: 'UnknownExampleEvent' })!;
      await f.observer.receiveHook(unknown);
      expect(f.observer.summaries()[0]?.observation?.status).toBe('unavailable');
      expect(f.observer.summaries()[0]?.observation?.hook).toBeUndefined();
      const activity = normalizeCodexHook({ session_id: 'native-one', hook_event_name: 'PreToolUse', tool_name: 'read_file', tool_input: {}, cwd: '/projects/example' })!;
      await f.observer.receiveHook(activity);
      expect(f.observer.summaries()[0]?.observation).toMatchObject({ status: 'watching', channel: 'hook', hook: true });
      expect(f.observer.summaries()[0]?.observation?.error).toBeUndefined();
      await f.observer.refresh();
      expect(f.observer.summaries()[0]?.observation?.status).toBe('watching');
      expect(f.observer.snapshot(f.id).messages.map(message => message.content)).toEqual(['Plan']);
      expect(f.observer.events(f.id).some(event => event.body.type === 'agent.state' && event.body.state === 'working')).toBe(true);
      await expect(readFile(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await f.observer.close(); }
  });

  it('does not undo a user pause when hooks arrive while transcript history is unavailable', async () => {
    const f = await fixture();
    try {
      await rm(f.file); await f.observer.refresh(); await f.observer.setWatching(f.id, false);
      const hook = normalizeCodexHook({ session_id: 'native-one', hook_event_name: 'UserPromptSubmit', prompt: 'Example request' })!;
      await f.observer.receiveHook(hook);
      expect(f.observer.summaries()[0]?.observation).toMatchObject({ status: 'paused', watching: false });
    } finally { await f.observer.close(); }
  });
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
      expect(f.observer.events(f.id).map(event => event.body.type)).toEqual(['session.started', 'prompt.submitted', 'agent.state']);
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
      expect(await host.setWorkflow('managed')).toMatchObject({ setupComplete: true, workflow: 'managed', connections: [], workspaces: [] });
    } finally { await runtime.close(); }
  });
});


describe('observed source model and effort', () => {
  const contextLine = (timestamp: string, model: string, effort?: unknown) => line({ type: 'turn_context', timestamp, payload: { model, ...(effort !== undefined ? { effort } : {}) } });

  it('updates from context before a reply, ignores stale settings and clears effort on a model switch', async () => {
    const f = await fixture();
    let reopened: Observations | undefined;
    try {
      await appendFile(f.file, contextLine(later, 'gpt-first', 'high'));
      await f.observer.refresh();
      expect(f.observer.summaries()[0]).toMatchObject({ model: 'gpt-first', modelAt: later, effort: 'high', effortAt: later });
      expect(f.observer.snapshot(f.id).messages).toHaveLength(1);
      const next = '2026-10-09T00:00:02.000Z';
      await appendFile(f.file, contextLine(next, 'gpt-next') + contextLine(at, 'stale-model', 'low'));
      await f.observer.refresh();
      expect(f.observer.summaries()[0]).toMatchObject({ model: 'gpt-next', modelAt: next, effortAt: next });
      expect(f.observer.summaries()[0]?.effort).toBeUndefined();
      await f.observer.setWatching(f.id, false);
      await f.observer.close();
      reopened = await Observations.create(f.directory, f.source, () => undefined, 60_000);
      expect(reopened.summaries()[0]).toMatchObject({ model: 'gpt-next', effortAt: next });
      expect(reopened.summaries()[0]?.effort).toBeUndefined();
    } finally { await f.observer.close(); await reopened?.close(); }
  });

  it('keeps lead hook settings separate from children and stale transcript replies', async () => {
    const f = await fixture();
    try {
      await f.observer.receiveHook(normalizeCodexHook({ session_id: 'native-one', hook_event_name: 'UserPromptSubmit', model: 'gpt-lead', effort: 'high' })!);
      const reported = f.observer.summaries()[0]!;
      expect(reported).toMatchObject({ model: 'gpt-lead', effort: 'high' });
      await f.observer.receiveHook(normalizeCodexHook({ session_id: 'native-one', hook_event_name: 'SubagentStart', agent_id: 'worker-1', model: 'gpt-child', effort: 'max' })!);
      await f.observer.receiveHook(normalizeCodexHook({ session_id: 'native-one', hook_event_name: 'Stop', agent_id: 'worker-1', model: 'gpt-child', reasoning_effort: 'low' })!);
      await f.observer.receiveHook(normalizeCodexHook({ session_id: 'native-one', hook_event_name: 'SubagentStart', subagent_id: 'worker-2', model: 'gpt-child', effort: 'max' })!);
      expect(f.observer.summaries()[0]).toMatchObject({ model: 'gpt-lead', modelAt: reported.modelAt, effort: 'high', effortAt: reported.effortAt });
      // A late reply must not lend its timestamp to the older model context.
      const replyAt = '2099-01-01T00:00:00.000Z';
      await appendFile(f.file, contextLine(later, 'stale-model', 'low') + message('assistant', 'Late reply', replyAt));
      await f.observer.refresh();
      expect(f.observer.summaries()[0]).toMatchObject({ model: 'gpt-lead', effort: 'high' });
      await f.observer.receiveHook(normalizeCodexHook({ session_id: 'native-one', hook_event_name: 'UserPromptSubmit', model: 'gpt-new' })!);
      expect(f.observer.summaries()[0]?.model).toBe('gpt-new');
      expect(f.observer.summaries()[0]?.effort).toBeUndefined();
    } finally { await f.observer.close(); }
  });

  it('persists valid effort for the same model and clears a later unknown context', async () => {
    const f = await fixture();
    let reopened: Observations | undefined;
    try {
      await appendFile(f.file, contextLine(later, 'gpt-lead', 'high'));
      await f.observer.refresh();
      await f.observer.setWatching(f.id, false);
      await f.observer.close();
      reopened = await Observations.create(f.directory, f.source, () => undefined, 60_000);
      expect(reopened.summaries()[0]).toMatchObject({ model: 'gpt-lead', effort: 'high', effortAt: later });
      const next = '2026-10-09T00:00:02.000Z';
      await appendFile(f.file, contextLine(next, 'gpt-lead'));
      await reopened.setWatching(f.id, true);
      expect(reopened.summaries()[0]).toMatchObject({ model: 'gpt-lead', effortAt: next });
      expect(reopened.summaries()[0]?.effort).toBeUndefined();
    } finally { await f.observer.close(); await reopened?.close(); }
  });

  it('clears invalid explicit effort and validates saved effort on restart', async () => {
    const f = await fixture();
    let reopened: Observations | undefined;
    try {
      const hook = (effort: unknown) => normalizeCodexHook({ session_id: 'native-one', hook_event_name: 'UserPromptSubmit', model: 'gpt-lead', effort })!;
      await f.observer.receiveHook(hook('high'));
      expect(f.observer.summaries()[0]?.effort).toBe('high');
      await f.observer.receiveHook(hook('ultra'));
      expect(f.observer.summaries()[0]?.effort).toBeUndefined();
      await f.observer.setWatching(f.id, false);
      await f.observer.close();
      const index = path.join(f.directory, 'observations.json');
      const saved = JSON.parse(await readFile(index, 'utf8'));
      saved[0].effort = 'ultra';
      await writeFile(index, JSON.stringify(saved));
      reopened = await Observations.create(f.directory, f.source, () => undefined, 60_000);
      expect(reopened.summaries()[0]?.effort).toBeUndefined();
    } finally { await f.observer.close(); await reopened?.close(); }
  });
});
