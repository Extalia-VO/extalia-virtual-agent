import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeImportService } from '../src/nativeImport.js';
import { Observations, OBSERVED_ACTIVITY_LIVE_MS } from '../src/observations.js';
import { normalizeCodexHook } from '../src/hooks/normalize.js';
import { createAgentHost } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const base = Date.UTC(2026, 10, 12, 1);
const stamp = (offset = 0) => new Date(base + offset).toISOString();
const line = (row: unknown) => `${JSON.stringify(row)}\n`;
afterEach(() => vi.useRealTimers());
async function fixture() {
  const root = await temp(); const home = path.join(root, 'home'); const directory = path.join(root, 'state');
  const source = await NativeImportService.create({ homeDirectory: home, env: {} });
  const observer = await Observations.create(directory, source, () => undefined, 60_000);
  return { root, home, directory, source, observer };
}
function hook(event: string, extra: Record<string, unknown> = {}) {
  return normalizeCodexHook({ session_id: 'activity-fixture', hook_event_name: event, ...extra })!;
}

describe('source-reported Observe activity metadata', () => {
  it('tracks work, questions, terminal fences, paused state and expiry without granting approval authority', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(base);
    const f = await fixture(); const running = () => f.observer.summaries()[0]?.running;
    try {
      await f.observer.receiveHook(hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'pwd' } }));
      expect(running()).toBe(true);
      const id = f.observer.summaries()[0]!.id;
      await f.observer.receiveHook(hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: {} }));
      expect(running()).toBe(false); expect(f.observer.summaries()[0]?.pendingApprovalId).toBeUndefined();
      await f.observer.receiveHook(hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'pwd' } }));
      expect(running()).toBe(true);
      await f.observer.receiveHook(hook('PermissionRequest', { tool_name: 'Bash' }));
      expect(running()).toBe(false); expect(f.observer.summaries()[0]?.pendingApprovalId).toBeUndefined();
      await f.observer.receiveHook(hook('UserPromptSubmit', { prompt: 'Continue the task' }));
      expect(running()).toBe(true);
      await f.observer.receiveHook(hook('Stop'));
      expect(running()).toBe(false);
      await f.observer.receiveHook(hook('PostToolUse', { tool_name: 'Bash', tool_response: 'Late result' }));
      await f.observer.receiveHook(hook('SubagentStart', { agent_id: 'late-worker' }));
      expect(running()).toBe(false);
      await f.observer.receiveHook(hook('UserPromptSubmit', { prompt: 'A new turn' }));
      expect(running()).toBe(true);
      await f.observer.setWatching(id, false); expect(running()).toBe(false);
      await f.observer.receiveHook(hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'pwd' } }));
      await f.observer.setWatching(id, true); expect(running()).toBe(false);
      await f.observer.receiveHook(hook('UserPromptSubmit', { prompt: 'A watched turn' }));
      expect(running()).toBe(true);
      vi.setSystemTime(base + OBSERVED_ACTIVITY_LIVE_MS + 1); expect(running()).toBe(false);
    } finally { await f.observer.close(); }
  });

  it.each(['turn.completed', 'agent.stopped'] as const)('retains two known workers after lead %s while rejecting unknown orphans and late lead results', async terminalType => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(base);
    const f = await fixture(); const running = () => f.observer.summaries()[0]?.running;
    try {
      await f.observer.receiveHook(hook('UserPromptSubmit', { prompt: 'Delegate the task' }));
      await f.observer.receiveHook(hook('SubagentStart', { agent_id: 'worker-one' }));
      await f.observer.receiveHook(hook('SubagentStart', { agent_id: 'worker-two' }));
      await f.observer.receiveHook({ ...hook('Stop'), steps: [{ agentId: 'primary', body: { type: terminalType } }] });
      expect(running()).toBe(true);
      await f.observer.receiveHook(hook('SubagentStop', { agent_id: 'worker-one' })); expect(running()).toBe(true);
      vi.setSystemTime(Date.now() + OBSERVED_ACTIVITY_LIVE_MS + 1); expect(running()).toBe(false);
      await f.observer.receiveHook(hook('PostToolUse', { agent_id: 'worker-two', tool_name: 'Bash', tool_response: 'Worker result' })); expect(running()).toBe(true);
      await f.observer.receiveHook(hook('SubagentStop', { agent_id: 'worker-two' })); expect(running()).toBe(false);
      vi.setSystemTime(Date.now() + OBSERVED_ACTIVITY_LIVE_MS + 1);
      await f.observer.receiveHook(hook('SubagentStart', { agent_id: 'unknown-worker' })); expect(running()).toBe(false);
      await f.observer.receiveHook(hook('PostToolUse', { tool_name: 'Bash', tool_response: 'Late lead result' })); expect(running()).toBe(false);
    } finally { await f.observer.close(); }
  });

  it('clears all known workers on an explicit session end and fences late child reports', async () => {
    const f = await fixture();
    try {
      await f.observer.receiveHook(hook('UserPromptSubmit', { prompt: 'Delegate the task' }));
      await f.observer.receiveHook(hook('SubagentStart', { agent_id: 'worker-one' }));
      await f.observer.receiveHook(hook('SubagentStart', { agent_id: 'worker-two' }));
      expect(f.observer.summaries()[0]?.running).toBe(true);
      await f.observer.receiveHook(hook('SessionEnd')); expect(f.observer.summaries()[0]?.running).toBe(false);
      await f.observer.receiveHook(hook('PreToolUse', { agent_id: 'worker-two', tool_name: 'Bash', tool_input: { command: 'pwd' } }));
      expect(f.observer.summaries()[0]?.running).toBe(false);
    } finally { await f.observer.close(); }
  });

  it('uses new transcript deltas while ignoring initial/restarted history and stale or excessive future timestamps', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(base);
    const f = await fixture(); const folder = path.join(f.home, '.codex', 'sessions'); await mkdir(folder, { recursive: true });
    const file = path.join(folder, 'rollout-activity.jsonl');
    await writeFile(file, line({ type: 'session_meta', payload: { id: 'activity-fixture', cwd: '/projects/example', timestamp: stamp() } })
      + line({ type: 'response_item', timestamp: stamp(), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Original task' }] } }));
    const scan = f.source.scan(['codex']); await f.observer.observe(scan.scanId, [scan.sessions[0]!.id]);
    let observer = f.observer; const running = () => observer.summaries()[0]?.running;
    const call = (id: string, offset: number, tool = 'exec_command') => line({ timestamp: stamp(offset), type: 'response_item', payload: { type: 'function_call', name: tool, call_id: id, arguments: JSON.stringify({ cmd: 'pwd' }) } });
    try {
      expect(running()).toBe(false);
      vi.setSystemTime(base + 1000); await appendFile(file, call('fresh', 1000)); await observer.refresh(); expect(running()).toBe(true);
      await observer.close(); observer = await Observations.create(f.directory, f.source, () => undefined, 60_000);
      expect(running()).toBe(false);
      vi.setSystemTime(base + 2000); await appendFile(file, call('resumed', 2000)); await observer.refresh(); expect(running()).toBe(true);
      vi.setSystemTime(base + 3000); await appendFile(file, line({ timestamp: stamp(3000), type: 'event_msg', payload: { type: 'task_complete' } })); await observer.refresh(); expect(running()).toBe(false);
      vi.setSystemTime(base + 4000); await appendFile(file, call('question', 4000, 'request_user_input_async')); await observer.refresh(); expect(running()).toBe(false);
      await appendFile(file, line({ timestamp: stamp(4000), type: 'response_item', payload: { type: 'function_call_output', call_id: 'question', output: '{"accepted":true}' } })); await observer.refresh(); expect(running()).toBe(false);
      vi.setSystemTime(base + 5000); await appendFile(file, call('after-answer', 5000)); await observer.refresh(); expect(running()).toBe(true);
      vi.setSystemTime(base + OBSERVED_ACTIVITY_LIVE_MS + 6001); expect(running()).toBe(false);
      await appendFile(file, call('stale', 6000)); await observer.refresh(); expect(running()).toBe(false);
      await appendFile(file, call('future', OBSERVED_ACTIVITY_LIVE_MS * 10)); await observer.refresh(); expect(running()).toBe(false);
    } finally { await observer.close(); }
  });

  it('clamps tolerated source clock skew to receipt time so activity cannot outlive the local freshness window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(base);
    const f = await fixture(); const folder = path.join(f.home, '.codex', 'sessions'); await mkdir(folder, { recursive: true });
    const file = path.join(folder, 'rollout-skew.jsonl');
    await writeFile(file, line({ type: 'session_meta', payload: { id: 'skew-fixture', cwd: '/projects/example', timestamp: stamp() } })
      + line({ type: 'response_item', timestamp: stamp(), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Clock skew fixture' }] } }));
    const scan = f.source.scan(['codex']); await f.observer.observe(scan.scanId, [scan.sessions[0]!.id]);
    try {
      vi.setSystemTime(base + 1000);
      await appendFile(file, line({ timestamp: stamp(20_000), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'skew-call', arguments: '{"cmd":"pwd"}' } }));
      await f.observer.refresh(); expect(f.observer.summaries()[0]?.running).toBe(true);
      vi.setSystemTime(base + 1000 + OBSERVED_ACTIVITY_LIVE_MS + 1);
      expect(f.observer.summaries()[0]?.running).toBe(false);
    } finally { await f.observer.close(); }
  });

  it('exposes real authenticated hook work and harness counts through the host, then clears activity on restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(base);
    const root = await temp(); const dataDirectory = path.join(root, 'data'); const home = path.join(root, 'home'); await mkdir(home);
    const options = { kind: 'bridge' as const, version: 'test', dataDirectory, importHome: home, env: { EXTALIA_SECRET_STORE: 'memory' }, observationIntervalMs: 60_000 };
    let runtime = await createAgentHost(options);
    const server = http.createServer((request, response) => { void runtime.hooks!.handle(request, response, 'codex'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test hook listener.');
    const token = (await readFile((await runtime.host.hookIngest()).tokenPath, 'utf8')).trim();
    const send = async (event: string) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/hooks/codex`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ session_id: 'activity-http', hook_event_name: event, tool_name: 'Bash', tool_input: { command: 'pwd' }, cwd: '/projects/example' }) });
      expect(response.status).toBe(204);
    };
    const running = async () => (await runtime.host.getStateSummary!()).sessions.find(row => row.observation?.nativeSessionId === 'activity-http')?.running;
    try {
      await send('PreToolUse'); await vi.waitFor(async () => expect(await running()).toBe(true));
      const groups = await runtime.host.sessionBrowserGroups!({ collection: 'observed', section: 'harnesses' });
      expect(groups.groups[0]).toMatchObject({ sourceId: 'codex', runningCount: 1 });
      await send('Stop'); await vi.waitFor(async () => expect(await running()).toBe(false));
      await send('PreToolUse'); await vi.waitFor(async () => expect(await running()).toBe(true));
      vi.setSystemTime(Date.now() + OBSERVED_ACTIVITY_LIVE_MS + 1); expect(await running()).toBe(false);
      await send('PreToolUse'); await vi.waitFor(async () => expect(await running()).toBe(true));
      await runtime.close(); runtime = await createAgentHost(options); expect(await running()).toBe(false);
      expect((await runtime.host.getStateSummary!()).sessions.some(row => row.observation?.nativeSessionId === 'activity-http')).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await runtime.close();
    }
  });
});
