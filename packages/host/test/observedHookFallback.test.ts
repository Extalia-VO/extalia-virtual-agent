import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type ExtaliaEvent } from '@extalia/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeCodexHook, type HookStep } from '../src/hooks/normalize.js';
import { NativeImportService } from '../src/nativeImport.js';
import { Observations } from '../src/observations.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const base = Date.parse('2026-11-01T12:00:00.000Z');
const at = (offset: number) => new Date(base + offset).toISOString();
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const prompt = (text: string, offset: number) => line({ timestamp: at(offset), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const reply = (text: string, offset: number) => line({ timestamp: at(offset), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
const call = (id: string, offset: number) => line({ timestamp: at(offset), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: id, arguments: JSON.stringify({ cmd: 'pwd' }) } });
const result = (id: string, offset: number) => line({ timestamp: at(offset), type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: 'example' } });
const realEvents = (events: readonly ExtaliaEvent[]) => events.filter(event => event.body.type !== 'session.updated');
afterEach(() => vi.useRealTimers());

async function fixture() {
  vi.useFakeTimers({ now: base, toFake: ['Date'] });
  const root = await temp(), home = path.join(root, 'home'), folder = path.join(home, '.codex', 'sessions');
  await mkdir(folder, { recursive: true });
  const files = new Map<string, string>();
  for (const native of ['native-one', 'native-two']) {
    const file = path.join(folder, `rollout-${native}.jsonl`);
    await writeFile(file, line({ type: 'session_meta', payload: { id: native, cwd: '/projects/example', timestamp: at(-60_000) } }) + prompt(`Start ${native}`, -59_000));
    files.set(native, file);
  }
  const source = await NativeImportService.create({ homeDirectory: home, env: {} });
  const updates: ExtaliaEvent[] = [];
  const observer = await Observations.create(path.join(root, 'state'), source, event => updates.push(event), 60_000);
  const scan = source.scan(['codex']);
  await observer.observe(scan.scanId, scan.sessions.map(session => session.id));
  const id = (native: string) => observer.summaries().find(session => session.observation?.nativeSessionId === native)!.id;
  const hook = (native: string, event: string, extra: Record<string, unknown> = {}) => observer.receiveHook(normalizeCodexHook({ session_id: native, transcript_path: files.get(native), hook_event_name: event, ...extra })!);
  const report = (steps: HookStep[]) => observer.receiveHook({ app: 'codex', sessionId: 'native-one', event: 'ExampleReport', starts: false, ends: false, steps });
  return { observer, source, files, updates, id, hook, report };
}

describe('transcript fallback after Codex hooks', () => {
  it('publishes fresh activity after hook silence independently for two sessions, without replay on later polls', async () => {
    const f = await fixture();
    try {
      await f.hook('native-one', 'UserPromptSubmit', { prompt: 'First request' });
      await f.hook('native-two', 'UserPromptSubmit', { prompt: 'Second request' });
      f.updates.length = 0;
      vi.setSystemTime(base + 5_000);
      await appendFile(f.files.get('native-one')!, call('missed-first', 1_000));
      await f.observer.refresh();
      expect(realEvents(f.updates).filter(event => event.body.type === 'tool.started').map(event => event.sessionId)).toEqual([f.id('native-one')]);
      expect(realEvents(f.updates).every(event => event.sessionId === f.id('native-one') && event.at === at(1_000) && event.source.channel === 'transcript')).toBe(true);
      f.updates.length = 0;
      await appendFile(f.files.get('native-two')!, call('missed-second', 2_000));
      await f.observer.refresh();
      expect(realEvents(f.updates).filter(event => event.body.type === 'tool.started').map(event => event.sessionId)).toEqual([f.id('native-two')]);
      f.updates.length = 0;
      await f.observer.refresh();
      expect(realEvents(f.updates)).toEqual([]);
      expect(f.observer.summaries()).toHaveLength(2);
      await appendFile(f.files.get('native-one')!, line({ timestamp: at(3_000), type: 'event_msg', payload: { type: 'task_complete' } }));
      await f.observer.refresh();
      expect(realEvents(f.updates).filter(event => event.sessionId === f.id('native-one')).map(event => event.body.type)).toEqual(['turn.completed', 'agent.state']);
      expect(realEvents(f.updates).at(-1)?.body).toEqual({ type: 'agent.state', state: 'idle' });
      f.updates.length = 0;
      await f.observer.refresh();
      expect(realEvents(f.updates)).toEqual([]);
    } finally { await f.observer.close(); }
  });

  it('deduplicates hook tool reports and paired state, and rejects older conflicting transcript activity', async () => {
    const f = await fixture();
    try {
      await f.hook('native-one', 'PreToolUse', { tool_name: 'exec_command', tool_input: { cmd: 'pwd' }, tool_call_id: 'same-call' });
      f.updates.length = 0;
      vi.setSystemTime(base + 5_000);
      await appendFile(f.files.get('native-one')!, call('old-call', -1_000) + call('same-call', 1_000));
      await f.observer.refresh();
      expect(realEvents(f.updates)).toEqual([]);
      await appendFile(f.files.get('native-one')!, result('same-call', 2_000));
      await f.observer.refresh();
      expect(realEvents(f.updates).map(event => event.body.type)).toEqual(['tool.completed']);
    } finally { await f.observer.close(); }
  });

  it('keeps real stop/end authoritative until a later prompt, and preserves user pauses', async () => {
    const f = await fixture();
    try {
      await f.hook('native-one', 'Stop');
      await f.hook('native-two', 'SessionEnd');
      f.updates.length = 0;
      vi.setSystemTime(base + 5_000);
      for (const native of ['native-one', 'native-two']) await appendFile(f.files.get(native)!, call(`trailing-${native}`, 1_000));
      await f.observer.refresh();
      expect(realEvents(f.updates)).toEqual([]);
      for (const native of ['native-one', 'native-two']) expect(f.observer.events(f.id(native)).some(event => event.body.type === 'tool.started' && event.body.toolCallId === `trailing-${native}`)).toBe(false);
      await appendFile(f.files.get('native-two')!, prompt('Prompt without a new session start', 2_000) + call('ended-not-resumed', 3_000));
      await f.observer.refresh();
      expect(realEvents(f.updates)).toEqual([]);
      expect(f.observer.events(f.id('native-two')).some(event => event.body.type === 'tool.started' && event.body.toolCallId === 'ended-not-resumed')).toBe(false);
      await appendFile(f.files.get('native-one')!, prompt('Resume with a new request', 2_000) + call('resumed', 3_000));
      await f.observer.refresh();
      expect(realEvents(f.updates).some(event => event.body.type === 'tool.started' && event.body.toolCallId === 'resumed')).toBe(true);
      expect(realEvents(f.updates).every(event => event.sessionId === f.id('native-one'))).toBe(true);
      vi.setSystemTime(base + 6_000);
      await f.hook('native-two', 'SessionStart');
      const liveResume = f.updates.find(event => event.sessionId === f.id('native-two') && event.body.type === 'session.started');
      const hydratedLifecycle = f.observer.events(f.id('native-two')).filter(event => event.body.type === 'session.started' || event.body.type === 'session.ended');
      expect(hydratedLifecycle.map(event => event.body.type)).toEqual(['session.started', 'session.ended', 'session.started']);
      expect(hydratedLifecycle.at(-1)?.id).toBe(liveResume?.id);
      expect(hydratedLifecycle.at(-1)?.at).toBe(at(6_000));
      expect(hydratedLifecycle.at(-1)!.at > hydratedLifecycle.at(-2)!.at).toBe(true);
      f.updates.length = 0;
      await appendFile(f.files.get('native-two')!, prompt('A real session start resumes observation', 7_000) + call('ended-resumed', 8_000));
      await f.observer.refresh();
      expect(realEvents(f.updates).some(event => event.sessionId === f.id('native-two') && event.body.type === 'tool.started' && event.body.toolCallId === 'ended-resumed')).toBe(true);
      await f.observer.setWatching(f.id('native-one'), false);
      f.updates.length = 0;
      await appendFile(f.files.get('native-one')!, call('paused', 4_000));
      await f.observer.refresh();
      expect(realEvents(f.updates)).toEqual([]);
      expect(f.observer.summaries().find(session => session.id === f.id('native-one'))?.observation?.watching).toBe(false);
    } finally { await f.observer.close(); }
  });

  it('publishes an earlier assistant reply written before hook timestamps on poll, while SessionEnd blocks trailing replies until SessionStart', async () => {
    const f = await fixture();
    try {
      await f.hook('native-one', 'UserPromptSubmit', { prompt: 'Explain the tools' });
      vi.setSystemTime(base + 5_000);
      await f.hook('native-one', 'PreToolUse', { tool_name: 'exec_command', tool_input: { cmd: 'pwd' }, tool_call_id: 'tool-before-reply' });
      await f.hook('native-one', 'Stop');
      f.updates.length = 0;

      // Transcript reply timestamp precedes hook watermarks (e.g. text emitted before/during tool calls).
      await appendFile(f.files.get('native-one')!, reply('Reply written before hooks', 1_000));
      await f.observer.refresh();
      expect(realEvents(f.updates).filter(event => event.body.type === 'model.completed')).toMatchObject([
        { sessionId: f.id('native-one'), body: { type: 'model.completed', text: 'Reply written before hooks' } },
      ]);

      // SessionEnd fences the ended session against trailing replies until a real SessionStart.
      vi.setSystemTime(base + 6_000);
      await f.hook('native-one', 'SessionEnd');
      f.updates.length = 0;
      await appendFile(f.files.get('native-one')!, reply('Trailing reply after SessionEnd', 7_000));
      await f.observer.refresh();
      expect(realEvents(f.updates).some(event => event.body.type === 'model.completed')).toBe(false);

      vi.setSystemTime(base + 8_000);
      await f.hook('native-one', 'SessionStart');
      f.updates.length = 0;
      await appendFile(f.files.get('native-one')!, reply('Reply after SessionStart', 9_000));
      await f.observer.refresh();
      expect(realEvents(f.updates).filter(event => event.body.type === 'model.completed')).toMatchObject([
        { sessionId: f.id('native-one'), body: { type: 'model.completed', text: 'Reply after SessionStart' } },
      ]);
    } finally { await f.observer.close(); }
  });

  it('scopes prompt/reply deduplication to the actor rather than another worker', async () => {
    const f = await fixture();
    try {
      await f.report([
        { agentId: 'worker-a', body: { type: 'prompt.submitted', text: 'Same prompt', via: 'native' } },
        { agentId: 'worker-a', body: { type: 'model.completed', text: 'Same reply' } },
      ]);
      f.updates.length = 0;
      vi.setSystemTime(base + 5_000);
      const reference = f.source.hookReference('codex', 'native-one', f.files.get('native-one'))!;
      const readOriginal = f.source.readObservation.bind(f.source);
      const read = readOriginal(reference);
      const readSpy = vi.spyOn(f.source, 'readObservation').mockImplementation(ref => ref.nativeSessionId !== 'native-one' ? readOriginal(ref) : { ...read, steps: [...read.steps,
        { type: 'prompt', text: 'Same prompt', at: at(1_000), pos: 'sibling-prompt', agentId: 'worker-b' },
        { type: 'reply', text: 'Same reply', at: at(2_000), pos: 'sibling-reply', agentId: 'worker-b', final: true },
      ] });
      await appendFile(f.files.get('native-one')!, prompt('Trigger a changed revision', 1_000));
      await f.observer.refresh();
      readSpy.mockRestore();
      expect(realEvents(f.updates).filter(event => event.body.type === 'model.completed').map(event => event.agentId)).toEqual(['worker-b']);
      expect(realEvents(f.updates).filter(event => event.body.type === 'prompt.submitted').map(event => event.agentId)).toEqual(['worker-b']);
      expect(f.observer.events(f.id('native-one')).filter(event => event.body.type === 'model.completed').map(event => event.agentId)).toEqual(['worker-a', 'worker-b']);
    } finally { await f.observer.close(); }
  });
});

describe('bounded hook history with busy siblings', () => {
  it('retains quiet working and stopped workers through more than 500 sibling reports', async () => {
    const f = await fixture();
    try {
      await f.report([
        { agentId: 'quiet-worker', body: { type: 'agent.state', state: 'working', activity: 'command', summary: 'Quiet command' } },
        { agentId: 'quiet-worker', body: { type: 'tool.started', tool: 'exec_command', toolCallId: 'quiet-call', kind: 'command', label: 'Quiet command' } },
        { agentId: 'stopped-worker', body: { type: 'turn.completed' } },
        { agentId: 'stopped-worker', body: { type: 'agent.state', state: 'offline' } },
      ]);
      for (let index = 1; index <= 530; index++) {
        vi.setSystemTime(base + index);
        await f.report([{ agentId: 'busy-worker', body: { type: 'agent.state', state: 'working', activity: 'read', summary: `Reading ${index}` } }]);
      }
      const events = f.observer.events(f.id('native-one')).filter(event => event.source.channel === 'hook');
      expect(events.length).toBeLessThanOrEqual(680);
      expect(events.some(event => event.agentId === 'quiet-worker' && event.body.type === 'tool.started' && event.body.toolCallId === 'quiet-call')).toBe(true);
      expect(events.some(event => event.agentId === 'quiet-worker' && event.body.type === 'agent.state' && event.body.state === 'working')).toBe(true);
      expect(events.some(event => event.agentId === 'stopped-worker' && event.body.type === 'turn.completed')).toBe(true);
      expect(events.some(event => event.agentId === 'stopped-worker' && event.body.type === 'agent.state' && event.body.state === 'offline')).toBe(true);
      expect(events.filter(event => event.body.type === 'subagent.spawned').map(event => event.body.type === 'subagent.spawned' ? event.body.subagentId : '')).toEqual(expect.arrayContaining(['quiet-worker', 'stopped-worker', 'busy-worker']));
      expect(events.every(event => event.sessionId === f.id('native-one'))).toBe(true);
      expect(f.observer.events(f.id('native-two')).some(event => event.source.channel === 'hook')).toBe(false);
    } finally { await f.observer.close(); }
  });
});
