import { appendFile, mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PortableSession } from '@extalia/core';
import type { TranscriptStep } from '@extalia/importers';
import { parseEvent, type ExtaliaEvent } from '@extalia/protocol';
import { describe, expect, it, vi } from 'vitest';
import { NativeImportService } from '../src/nativeImport.js';
import { MAX_AUTO_OBSERVATIONS, Observations } from '../src/observations.js';
import { createAgentHost } from '../src/service.js';
import { transcriptEvents } from '../src/transcriptEvents.js';
import { useTempDirs } from './helpers.js';

// Synthesized Codex rollouts in temporary homes only; no real history is read.
const temp = useTempDirs();
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const stamp = (offsetMs: number) => new Date(Date.now() - 60_000 + offsetMs).toISOString();
const meta = (id: string) => line({ type: 'session_meta', payload: { id, cwd: '/projects/example', timestamp: stamp(0) } });
const prompt = (text: string, at = stamp(1000)) => line({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const call = (id: string, cmd: string, at = stamp(2000)) => line({ timestamp: at, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: id, arguments: JSON.stringify({ cmd }) } });
const output = (id: string, text: string, at = stamp(3000)) => line({ timestamp: at, type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: text } });
const final = (text: string, at = stamp(4000)) => line({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] } });

async function codexHome() {
  const root = await temp(), home = path.join(root, 'home'), codex = path.join(root, 'codex-home');
  const folder = path.join(codex, 'sessions', '2026', '10', '11');
  await mkdir(folder, { recursive: true }); await mkdir(home, { recursive: true });
  const source = await NativeImportService.create({ homeDirectory: home, env: { CODEX_HOME: codex } });
  const location = source.locations().find(item => item.sourceId === 'codex' && item.label === 'Codex')!;
  return { root, home, codex, folder, source, location, state: path.join(root, 'state') };
}

const types = (events: readonly ExtaliaEvent[]) => events.map(event => event.body.type);

describe('structured transcript events', () => {
  const steps: TranscriptStep[] = [
    { pos: 'L1', at: '2026-10-11T00:00:01.000Z', type: 'prompt', text: 'Run tests' },
    { pos: 'L2', at: '2026-10-11T00:00:02.000Z', type: 'tool.call', tool: 'exec_command', callId: 'c1', command: 'pnpm test', target: 'pnpm test' },
    { pos: 'L3', at: '2026-10-11T00:00:03.000Z', type: 'tool.result', callId: 'c1', ok: true, output: 'x'.repeat(5000) },
    { pos: 'L4', at: '2026-10-11T00:00:04.000Z', type: 'reply', text: 'Green.', final: true },
  ];
  const input = { sessionId: 'session-a', runtime: 'codex', title: 'Example', createdAt: '2026-10-11T00:00:00.000Z', steps };

  it('maps steps to protocol events with classified activity, clipped output and turn ends', () => {
    const events = transcriptEvents(input);
    expect(types(events)).toEqual(['session.started', 'prompt.submitted', 'agent.state', 'agent.state', 'tool.started', 'tool.completed', 'model.completed', 'turn.completed', 'agent.state']);
    expect(events.every(event => parseEvent(event).ok && event.source.channel === 'transcript')).toBe(true);
    expect(events.slice(1).every(event => event.agentId === 'primary')).toBe(true);
    expect(events[2]!.body).toEqual({ type: 'agent.state', state: 'thinking' });
    expect(events[3]!.body).toMatchObject({ type: 'agent.state', state: 'working', activity: 'test', target: 'pnpm test' });
    expect(events[4]!.body).toMatchObject({ type: 'tool.started', toolCallId: 'c1', kind: 'test', label: 'Running pnpm test' });
    expect(events[5]!.body).toMatchObject({ type: 'tool.completed', ok: true, kind: 'test' });
    expect((events[5]!.body as { output: string }).output).toHaveLength(4000);
    expect(events.at(-1)!.body).toEqual({ type: 'agent.state', state: 'idle' });
  });

  it('keeps event ids stable across replays and only appends as the transcript grows', () => {
    const first = transcriptEvents({ ...input, steps: steps.slice(0, 2) });
    const again = transcriptEvents({ ...input, steps: steps.slice(0, 2) });
    const grown = transcriptEvents(input);
    expect(again.map(event => event.id)).toEqual(first.map(event => event.id));
    expect(grown.slice(0, first.length).map(event => event.id)).toEqual(first.map(event => event.id));
    expect(new Set(grown.map(event => event.id)).size).toBe(grown.length);
    // A turn the source never closes ends where the next prompt starts, or after the 30s idle settle window.
    const open = transcriptEvents({ ...input, steps: [steps[0]!, { pos: 'L5', type: 'reply', text: 'Partial' }, { pos: 'L6', type: 'prompt', text: 'Next' }] });
    expect(types(open)).toEqual(['session.started', 'prompt.submitted', 'agent.state', 'model.completed', 'turn.completed', 'agent.state', 'prompt.submitted', 'agent.state']);
    const settled = transcriptEvents({
      ...input,
      steps: [steps[0]!, { pos: 'L5', at: '2026-10-11T00:00:05.000Z', type: 'reply', text: 'Finished without final marker' }],
      nowMs: Date.parse('2026-10-11T00:00:40.000Z'),
    });
    expect(types(settled)).toEqual(['session.started', 'prompt.submitted', 'agent.state', 'model.completed', 'turn.completed', 'agent.state']);
    const labelsOnlyEvents = transcriptEvents({ ...input, labelsOnly: true });
    expect(types(labelsOnlyEvents)).toEqual(['session.started', 'agent.state', 'agent.state', 'tool.started', 'tool.completed', 'turn.completed', 'agent.state']);
    expect((labelsOnlyEvents.find(e => e.body.type === 'tool.completed')?.body as { output?: string }).output).toBeUndefined();
  });
});

describe('automatic discovery and live increments', () => {
  it('observes a new rollout within one poll after opt-in, publishes only new events, and persists the opt-in', async () => {
    const f = await codexHome();
    const published: ExtaliaEvent[] = [];
    const observer = await Observations.create(f.state, f.source, event => published.push(event), 60_000);
    let reopened: Observations | undefined;
    try {
      const old = path.join(f.folder, 'rollout-old.jsonl');
      await writeFile(old, meta('native-old') + prompt('Old work'));
      const past = new Date(Date.now() - 60 * 60 * 1000);
      await utimes(old, past, past);
      await observer.setAutoWatch(f.location.id, true);
      expect(observer.summaries()).toHaveLength(0);

      const file = path.join(f.folder, 'rollout-new.jsonl');
      await writeFile(file, meta('native-new') + line({ timestamp: stamp(500), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } }) + prompt('Fix the build'));
      await observer.refresh();
      const [summary] = observer.summaries();
      expect(summary).toMatchObject({ control: 'observed', observation: { auto: true, watching: true, lastEventAt: expect.any(String) } });
      const id = summary!.id;
      expect(types(published.filter(event => event.sessionId === id))).toEqual(['session.started', 'prompt.submitted', 'agent.state', 'session.updated']);
      expect(JSON.stringify(observer.events(id))).not.toContain('environment_context');

      published.length = 0;
      await appendFile(file, call('c1', 'pnpm build'));
      await observer.refresh();
      expect(types(published)).toEqual(['agent.state', 'tool.started', 'session.updated']);
      expect(published[1]!.body).toMatchObject({ type: 'tool.started', toolCallId: 'c1', kind: 'command', target: 'pnpm build' });
      const startedId = published[1]!.id;

      published.length = 0;
      await observer.refresh();
      expect(published).toHaveLength(0);
      await appendFile(file, output('c1', 'Process exited with code 0') + final('Built.'));
      await observer.refresh();
      expect(types(published)).toEqual(['tool.completed', 'model.completed', 'turn.completed', 'agent.state', 'session.updated']);
      const replay = observer.events(id);
      expect(replay.filter(event => event.id === startedId)).toHaveLength(1);
      expect(replay.every(event => parseEvent(event).ok)).toBe(true);
      expect(await readFile(file, 'utf8')).toContain('Built.');

      // Restart: the opt-in survives and history is not replayed live.
      await observer.close();
      published.length = 0;
      reopened = await Observations.create(f.state, f.source, event => published.push(event), 60_000);
      expect(reopened.autoWatching()).toEqual([f.location.id]);
      expect(reopened.summaries()[0]).toMatchObject({ id, observation: { auto: true } });
      expect(published.filter(event => event.body.type !== 'session.updated')).toHaveLength(0);
      expect(reopened.events(id).map(event => event.id)).toEqual(replay.map(event => event.id));

      // Deleting an automatic observation keeps it away until its transcript changes again.
      await reopened.remove(id);
      await reopened.refresh();
      expect(reopened.summaries()).toHaveLength(0);
      await new Promise(resolve => setTimeout(resolve, 20));
      await appendFile(file, prompt('Another turn', new Date().toISOString()));
      await reopened.refresh();
      expect(reopened.summaries()).toHaveLength(1);

      await reopened.setAutoWatch(f.location.id, false);
      expect(reopened.autoWatching()).toEqual([]);
      await expect(reopened.setAutoWatch('loc-unknown', true)).rejects.toThrow('cannot be watched');
    } finally { await observer.close(); await reopened?.close(); }
  });

  it('keeps at most the LRU limit of automatic observations and retires the oldest to history', async () => {
    const f = await codexHome();
    const retired: PortableSession[] = [];
    const observer = await Observations.create(f.state, f.source, () => undefined, 60_000, { retire: async session => { retired.push(session); } });
    try {
      for (let index = 0; index < MAX_AUTO_OBSERVATIONS; index++) {
        const file = path.join(f.folder, `rollout-${String(index).padStart(2, '0')}.jsonl`);
        await writeFile(file, meta(`native-${index}`) + prompt(`Task ${index}`, stamp(1000 + index * 100)));
      }
      await observer.setAutoWatch(f.location.id, true);
      expect(observer.summaries()).toHaveLength(MAX_AUTO_OBSERVATIONS);
      await writeFile(path.join(f.folder, 'rollout-new.jsonl'), meta('native-new') + prompt('Newest task', stamp(50_000)));
      await observer.refresh();
      const summaries = observer.summaries();
      expect(summaries).toHaveLength(MAX_AUTO_OBSERVATIONS);
      expect(summaries.some(item => item.observation?.nativeSessionId === 'native-new')).toBe(true);
      expect(summaries.some(item => item.observation?.nativeSessionId === 'native-0')).toBe(false);
      expect(retired.map(session => session.provenance.sourceSessionId)).toEqual(['native-0']);
      await observer.refresh();
      expect(observer.summaries().some(item => item.observation?.nativeSessionId === 'native-0')).toBe(false);
    } finally { await observer.close(); }
  });

  it('works through the host API with a temporary CODEX_HOME and keeps retired sessions in History', async () => {
    const f = await codexHome();
    const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: path.join(f.root, 'host'), importHome: f.home,
      env: { EXTALIA_SECRET_STORE: 'memory', CODEX_HOME: f.codex }, observationIntervalMs: 25 });
    try {
      const { host } = runtime;
      const seen: ExtaliaEvent[] = [];
      host.subscribe(event => seen.push(event));
      const locations = await host.setAutoWatch(f.location.id, true);
      expect(locations.find(item => item.id === f.location.id)?.autoWatch).toBe(true);
      expect((await host.importLocations()).find(item => item.id === f.location.id)?.autoWatch).toBe(true);
      await expect(host.setAutoWatch('loc-antigravity-cli', true)).rejects.toThrow('cannot be watched');
      const file = path.join(f.folder, 'rollout-live.jsonl');
      await writeFile(file, meta('native-live') + prompt('Live prompt'));
      await vi.waitFor(async () => expect((await host.getState()).sessions).toHaveLength(1), { timeout: 3000, interval: 20 });
      const id = (await host.getState()).sessions[0]!.id;
      await appendFile(file, call('c9', 'git status'));
      await vi.waitFor(() => expect(seen.some(event => event.sessionId === id && event.body.type === 'tool.started')).toBe(true), { timeout: 3000, interval: 20 });
      const events = await host.sessionEvents(id);
      expect(events.filter(event => event.body.type === 'tool.started')).toHaveLength(1);
      expect(events.every(event => event.source.channel === 'transcript' && parseEvent(event).ok)).toBe(true);

      for (let index = 0; index < MAX_AUTO_OBSERVATIONS; index++) {
        await writeFile(path.join(f.folder, `rollout-more-${String(index).padStart(2, '0')}.jsonl`), meta(`native-more-${index}`) + prompt(`Task ${index}`, stamp(3000 + index * 100)));
      }
      await vi.waitFor(async () => expect((await host.getState()).library).toHaveLength(1), { timeout: 5000, interval: 25 });
      const state = await host.getState();
      expect(state.sessions).toHaveLength(MAX_AUTO_OBSERVATIONS);
      expect(state.sessions.some(item => item.id === id)).toBe(false);
      expect(state.library[0]).toMatchObject({ sourceId: 'codex', importMode: 'linked', title: 'Live prompt' });
    } finally { await runtime.close(); }
  // Three bounded observation waits can outlast Vitest's default 5-second test deadline.
  }, 15_000);

  it('discovers active Hermes sessions from new message rows and skips sessions Extalia runs itself', async () => {
    const root = await temp(), home = path.join(root, 'home'), folder = path.join(home, '.hermes');
    await mkdir(folder, { recursive: true });
    const writer = new DatabaseSync(path.join(folder, 'state.db'));
    writer.exec('PRAGMA journal_mode=WAL; CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, started_at REAL); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER)');
    const session = writer.prepare('INSERT INTO sessions VALUES (?, ?, ?)'), add = writer.prepare('INSERT INTO messages (session_id, role, content, timestamp, active) VALUES (?, ?, ?, ?, 1)');
    const now = Date.now() / 1000;
    session.run('outside', 'Outside work', now - 30); session.run('managed', 'Extalia run', now - 30); session.run('stale', 'Old', now - 7200);
    add.run('stale', 'user', 'Old prompt', now - 7200);
    add.run('managed', 'user', 'Managed prompt', now - 20);
    add.run('outside', 'user', 'Outside prompt', now - 10);
    const source = await NativeImportService.create({ homeDirectory: home, env: {} });
    const location = source.locations().find(item => item.sourceId === 'hermes')!;
    const published: ExtaliaEvent[] = [];
    const observer = await Observations.create(path.join(root, 'state'), source, event => published.push(event), 60_000, { skip: reference => reference.nativeSessionId === 'managed' });
    try {
      await observer.setAutoWatch(location.id, true);
      expect(observer.summaries().map(item => item.observation?.nativeSessionId)).toEqual(['outside']);
      const id = observer.summaries()[0]!.id;
      published.length = 0;
      add.run('outside', 'assistant', 'Done outside.', now);
      await observer.refresh();
      expect(types(published)).toEqual(['model.completed', 'turn.completed', 'agent.state', 'session.updated']);
      expect(published.every(event => event.sessionId === id)).toBe(true);
    } finally { await observer.close(); writer.close(); }
  });
});

describe('observed subagents from transcripts', () => {
  it('announces each sidechain agent once, under the primary agent, labelled by the delegation', () => {
    const steps: TranscriptStep[] = [
      { pos: 'L1', at: '2026-10-11T00:00:01.000Z', type: 'prompt', text: 'Review the change' },
      { pos: 'L2', at: '2026-10-11T00:00:02.000Z', type: 'tool.call', tool: 'Task', callId: 't1', target: 'code-reviewer' },
      { pos: 'L3', at: '2026-10-11T00:00:03.000Z', type: 'tool.call', tool: 'Read', callId: 'r1', target: 'src/a.ts', agentId: 'agent-7' },
      { pos: 'L4', at: '2026-10-11T00:00:04.000Z', type: 'tool.result', callId: 'r1', ok: true, agentId: 'agent-7' },
      { pos: 'L5', at: '2026-10-11T00:00:05.000Z', type: 'reply', text: 'Looks fine.', final: true, agentId: 'agent-7' },
    ];
    const events = transcriptEvents({ sessionId: 'session-b', runtime: 'claude-code', title: 'Review', createdAt: '2026-10-11T00:00:00.000Z', steps });
    const spawned = events.filter(event => event.body.type === 'subagent.spawned');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.agentId).toBe('primary');
    expect(spawned[0]!.body).toMatchObject({ subagentId: 'agent-7', label: 'code-reviewer' });
    expect(events.some(event => event.agentId === 'agent-7' && event.body.type === 'tool.started')).toBe(true);
    // Polling again yields the same ids, so the announcement is never repeated.
    expect(transcriptEvents({ sessionId: 'session-b', runtime: 'claude-code', title: 'Review', createdAt: '2026-10-11T00:00:00.000Z', steps }).map(event => event.id)).toEqual(events.map(event => event.id));
  });
});
