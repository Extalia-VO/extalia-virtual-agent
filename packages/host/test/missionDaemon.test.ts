import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEvent } from '@extalia/protocol';
import type { HostMissionRequest, HostMissionRun } from '@extalia/platform';
import type { AnyTool, ToolRunContext } from '@extalia/runtime';
import { createAgentHost, type AgentHostOptions, type AgentHostRuntime } from '../src/service.js';
import { MissionRecords } from '../src/mission.js';
import type { SessionRecord } from '../src/sessions.js';
import * as fileTools from '../src/tools/files.js';
import { DAEMON_BINARY, HAS_DAEMON, coreFile, dropCoreTrigger, failCoreEvent, queryCore } from './daemonBackend.js';

// Audit PR 8: native missions routed to the Rust core daemon (real binary). The parameterized
// host suites cover the common paths; these cases cover the daemon's own journal, its faults
// and the fail-closed behaviour when it is unavailable (ADR 0014, ADR 0020, ADR 0026).
if (!HAS_DAEMON) console.warn('missionDaemon.test.ts skipped: build the daemon with `cargo build -p extalia-daemon`.');

const roots: string[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closes.length) await closes.pop()!();
  vi.restoreAllMocks();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

type Fetch = NonNullable<AgentHostOptions['fetch']>;
const response = (text: string) => Response.json({ model: 'model-a', choices: [{ message: { content: text }, finish_reason: 'stop' }] });
const readCall = () => Response.json({ model: 'model-a', choices: [{ message: { content: '', tool_calls: [{ id: 'call-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) } }] }, finish_reason: 'tool_calls' }] });

interface Options { core?: 'rust' | 'typescript'; binary?: string; nativeCore?: AgentHostOptions['nativeCore'] }
async function fixture(fetch: Fetch, options: Options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'extalia-mission-daemon-')); roots.push(root);
  const project = path.join(root, 'project'), home = path.join(root, 'home'), data = path.join(root, 'data');
  await Promise.all([mkdir(project, { recursive: true }), mkdir(home, { recursive: true })]);
  await writeFile(path.join(project, 'README.md'), 'Project readme.\n');
  const children: ChildProcess[] = [], log: string[] = [];
  const open = async (next: Fetch = fetch, coreOverride = options.core) => {
    const runtime = await createAgentHost({
      kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home, observationIntervalMs: 60_000, fetch: next,
      env: { EXTALIA_SECRET_STORE: 'memory', HOME: home, PATH: '', ...(coreOverride ? { EXTALIA_NATIVE_CORE: coreOverride } : {}), EXTALIA_DAEMON_PATH: options.binary ?? DAEMON_BINARY },
      ...(options.nativeCore ? { nativeCore: options.nativeCore } : {}),
      daemon: {
        log: line => { log.push(line); },
        spawn: (binary, args, spawnOptions) => { const child = spawn(binary, args, { ...spawnOptions, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child); return child; },
      },
    });
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await runtime.close(); } };
    closes.push(close);
    return { runtime, host: runtime.host, close };
  };
  const first = await open();
  const connection = (await first.host.saveConnection({ name: 'Provider', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'model-a', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } })).connections[0]!;
  const workspace = (await first.host.saveWorkspace({ name: 'Project', projectLocation: project, connectionId: connection.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
  const session = await first.host.createSession(workspace.id);
  const task = (name: string) => ({ id: name, title: `Task ${name}`, instructions: `Task ${name}: inspect read-only.`, connectionId: connection.id, model: 'model-a', dependsOn: [] });
  const request: HostMissionRequest = { title: 'Read-only review', tasks: [task('inspect')] };
  return { root, data, home, project, ...first, open, children, log, workspace, session, task, request };
}
async function settled(host: AgentHostRuntime['host'], sessionId: string, missionId: string): Promise<HostMissionRun> {
  for (let attempt = 0; attempt < 600; attempt++) {
    const run = await host.nativeMissionRun(sessionId, missionId);
    if (run.state !== 'running') return run;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Mission did not settle in test fixture.');
}
async function idle(runtime: AgentHostRuntime) {
  for (let n = 0; n < 400 && runtime.isBusy(); n++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(runtime.isBusy()).toBe(false);
}
/** Run one mission so the lazily started daemon is up before a fault is injected. */
async function warm(env: Awaited<ReturnType<typeof fixture>>) {
  const run = await env.host.startNativeMission(env.session.id, env.request);
  expect((await settled(env.host, env.session.id, run.id)).state).toBe('completed');
  await idle(env.runtime);
}
const tsEvents = (data: string, missionId: string) => {
  const db = new DatabaseSync(path.join(data, 'state', 'missions.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT event_id FROM mission_events WHERE run_id = ?').all(missionId); } finally { db.close(); }
};
const countingReads = () => {
  let reads = 0;
  const create = fileTools.createFileTools;
  vi.spyOn(fileTools, 'createFileTools').mockImplementation(root => create(root).map(tool => tool.name !== 'read_file' ? tool : ({
    ...tool, run: (input: unknown, context: ToolRunContext) => { reads++; return tool.run(input, context); },
  } as AnyTool)));
  return () => reads;
};

describe.skipIf(!HAS_DAEMON)('native missions on the Rust core daemon', () => {
  it('repairs a crashed host terminal shadow from the authoritative snapshot without replay or fabricated output', async () => {
    let calls = 0;
    const env = await fixture(async () => { calls++; return response('Retained canonical answer'); }, { core: 'rust' });
    const started = await env.host.startNativeMission(env.session.id, { ...env.request, tasks: [env.task('first'), env.task('second')] });
    const final = await settled(env.host, env.session.id, started.id); await idle(env.runtime);
    expect(final.authority).toMatchObject({ backend: 'rust', profileId: 'default' });
    expect(final.state).toBe('completed');
    await env.close();
    // Reproduce the crash boundary: Rust committed terminal state, but the last host
    // checkpoint still showed one worker running and had not retained its output.
    const records = new MissionRecords(path.join(env.data, 'sessions'), path.join(env.data, 'state', 'missions.sqlite'));
    await records.initialize([{ id: env.session.id, workspaceId: env.workspace.id } as SessionRecord]);
    const second = final.tasks[1]!;
    const { answer: _answer, verification: _verification, usage: _usage, ...missing } = second;
    await records.save({ ...final, state: 'running', tasks: [final.tasks[0]!, { ...missing, state: 'running' }], usage: undefined });
    records.close();
    const next = await env.open(undefined, 'typescript');
    expect((await next.host.getState()).nativeCore).toBeUndefined();
    const recovered = await next.host.nativeMissionRun(env.session.id, final.id);
    expect(recovered).toMatchObject({ state: 'recovering', recovery: { source: 'host-restart' } });
    expect(recovered.tasks[1]!.state).toBe('unknown');
    const inspected = await next.host.refreshNativeMissionRecovery!(env.session.id, final.id);
    expect(inspected).toMatchObject({ status: 'refreshed', run: { state: 'completed' }, snapshot: { state: 'completed', leases: [] } });
    expect(inspected.run.tasks[0]!.answer).toBe('Retained canonical answer');
    expect(inspected.run.tasks[1]).not.toHaveProperty('answer');
    expect(inspected.run.tasks[1]).not.toHaveProperty('verification');
    expect(inspected.run.tasks[1]!.usage).toEqual({ unknown: true });
    expect(inspected.run).not.toHaveProperty('usage');
    expect(calls).toBe(2);
    await next.close();
    const restarted = await env.open();
    expect(await restarted.host.nativeMissionRun(env.session.id, final.id)).toEqual(inspected.run);
    expect(calls).toBe(2);
  });

  it('journals the mission in core.sqlite only, with daemon sequences, a sanitized graph and no replay after restart', async () => {
    const answer = 'UNTRUSTED_ANSWER_PAYLOAD_d41e';
    let calls = 0;
    const env = await fixture(async () => { calls++; return calls === 1 ? readCall() : response(answer); }, { core: 'rust' });
    expect((await env.host.getState()).nativeCore).toEqual({ core: 'rust', daemon: 'off' });
    const started = await env.host.startNativeMission(env.session.id, { ...env.request, tasks: [{ ...env.request.tasks[0]!, title: 'Inspect secret-ish title' }] });
    const final = await settled(env.host, env.session.id, started.id); await idle(env.runtime);
    expect(final).toMatchObject({ state: 'completed', tasks: [{ state: 'completed', answer, verification: 'unverified' }] });
    expect((await env.host.getState()).nativeCore).toEqual({ core: 'rust', daemon: 'ready' });
    expect(env.children).toHaveLength(1);
    await env.close();
    expect(env.children[0]!.exitCode).toBe(0); // stdin EOF: a clean exit, not a kill.

    const events = queryCore<{ sequence: number; event_type: string; payload: string }>(env.data, 'SELECT sequence, event_type, payload FROM events WHERE mission_id = ? ORDER BY sequence', started.id);
    expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.map(event => event.event_type)).toEqual(expect.arrayContaining(['mission.state', 'task.assigned', 'task.state', 'tool.started', 'tool.completed', 'turn.completed']));
    expect(events.filter(event => event.event_type === 'task.state').map(event => (JSON.parse(event.payload) as { to: string }).to)).toEqual(['running', 'completed']);
    expect(JSON.stringify(events)).not.toMatch(new RegExp(`${answer}|inspect read-only|README`));
    expect(queryCore(env.data, 'SELECT state FROM missions WHERE mission_id = ?', started.id)).toEqual([{ state: 'completed' }]);
    expect(queryCore(env.data, 'SELECT count(*) AS leases FROM leases')).toEqual([{ leases: 0 }]);
    expect(tsEvents(env.data, started.id)).toEqual([]); // One owning journal (ADR 0019).

    const reopened = await env.open(async () => { calls++; return response('no replay'); });
    expect(await reopened.host.nativeMissionRun(env.session.id, started.id)).toEqual(final);
    const v0 = await reopened.host.sessionEvents(env.session.id);
    expect(v0.every(event => parseEvent(event).ok)).toBe(true);
    expect(v0.some(event => event.correlationId === started.id && event.body.type === 'task.completed' && event.body.ok)).toBe(true);
    expect(calls).toBe(2);
  });

  it('blocks the provider when the daemon refuses a commit, latches recovering and does not replay after restart', async () => {
    let calls = 0;
    const env = await fixture(async () => { calls++; return response('answer'); }, { core: 'rust' });
    await warm(env);
    failCoreEvent(env.data, 'agent.state', 'fail_agent_state');
    const started = await env.host.startNativeMission(env.session.id, env.request);
    const failed = await settled(env.host, env.session.id, started.id); await idle(env.runtime);
    expect(calls).toBe(1); // Only the warm-up mission called the provider.
    expect(failed).toMatchObject({ state: 'recovering', tasks: [{ state: 'unknown', reason: 'persistence-failed' }] });
    expect(JSON.stringify(failed)).not.toContain('synthetic core failure');
    await expect(env.host.startNativeMission(env.session.id, env.request)).rejects.toThrow(/unresolved/);
    // A refused commit is not a dead daemon: the connection stays ready for other missions.
    expect((await env.host.getState()).nativeCore).toEqual({ core: 'rust', daemon: 'ready' });
    dropCoreTrigger(env.data, 'fail_agent_state');
    await env.close();

    const reopened = await env.open(async () => { calls++; return response('no replay'); });
    expect((await reopened.host.nativeMissionRun(env.session.id, started.id)).state).toBe('recovering');
    await expect(reopened.host.startNativeMission(env.session.id, env.request)).rejects.toThrow(/unresolved/);
    expect(calls).toBe(1);
  });

  it('never runs a read tool whose tool.started commit failed and latches the whole mission', async () => {
    const calls: string[] = [];
    let betaAborted = false;
    const env = await fixture(async (_url, init) => {
      const text = String(init?.body);
      const task = text.includes('Task alpha') ? 'alpha' : text.includes('Task beta') ? 'beta' : text.includes('Task gamma') ? 'gamma' : 'warm';
      calls.push(task);
      if (task === 'alpha') return readCall();
      if (task === 'beta') return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => { betaAborted = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true }));
      return response(`${task} answer`);
    }, { core: 'rust' });
    const reads = countingReads();
    await warm(env);
    failCoreEvent(env.data, 'tool.started', 'fail_tool_started');
    const started = await env.host.startNativeMission(env.session.id, { title: 'Latch review', maxConcurrency: 2, tasks: [env.task('alpha'), env.task('beta'), env.task('gamma')] });
    const failed = await settled(env.host, env.session.id, started.id); await idle(env.runtime);
    expect(failed.state).toBe('recovering');
    expect(reads()).toBe(0);
    expect(betaAborted).toBe(true);
    expect(calls.filter(task => task !== 'warm')).toEqual(expect.arrayContaining(['alpha', 'beta']));
    expect(calls).not.toContain('gamma');
    expect(failed.tasks.map(task => [task.id, task.state, task.reason])).toEqual([
      ['alpha', 'unknown', 'persistence-failed'], ['beta', 'unknown', 'persistence-failed'], ['gamma', 'blocked', 'persistence-failed'],
    ]);
    expect(queryCore(env.data, "SELECT event_id FROM events WHERE mission_id = ? AND event_type = 'tool.started'", started.id)).toEqual([]);
    dropCoreTrigger(env.data, 'fail_tool_started');
  });

  it('denies tool calls and latches recovering when the daemon crashes mid-mission; the host stays up', async () => {
    let calls = 0;
    const crash = { armed: false };
    const env = await fixture(async () => {
      calls++;
      if (calls === 1) return response('warm');
      // Between the provider reply and the tool's permission check.
      if (crash.armed) env.children[0]!.kill('SIGKILL');
      return readCall();
    }, { core: 'rust' });
    const reads = countingReads();
    await warm(env);
    crash.armed = true;
    const started = await env.host.startNativeMission(env.session.id, env.request);
    const failed = await settled(env.host, env.session.id, started.id); await idle(env.runtime);
    expect(failed).toMatchObject({ state: 'recovering', tasks: [{ state: 'unknown', reason: 'persistence-failed' }] });
    expect(reads()).toBe(0); // policy_unavailable: the read was denied, never decided locally.
    expect(calls).toBe(2);
    const state = await env.host.getState();
    expect(state.nativeCore).toMatchObject({ core: 'rust', daemon: 'unavailable' });
    expect(['crashed', 'timeout']).toContain(state.nativeCore?.lastError);
    expect(state.sessions.some(item => item.id === env.session.id)).toBe(true);
    await expect(env.host.startNativeMission(env.session.id, env.request)).rejects.toThrow(/unresolved/);
    await env.close();
    // The restarted daemon recovers its own store: in-flight work becomes unknown, never replayed.
    const reopened = await env.open(async () => { calls++; return response('no replay'); });
    const other = await reopened.host.createSession(env.workspace.id);
    await expect(reopened.host.startNativeMission(other.id, env.request)).rejects.toThrow(/unresolved/);
    expect((await reopened.host.nativeMissionRun(env.session.id, started.id)).state).toBe('recovering');
    expect(calls).toBe(2);
  });

  it('refuses to start a mission when the daemon is unavailable, without provider calls or a fallback', async () => {
    let calls = 0;
    const env = await fixture(async () => { calls++; return response('must not run'); }, { core: 'rust', binary: path.join(tmpdir(), 'missing-extalia-daemon') });
    await expect(env.host.startNativeMission(env.session.id, env.request)).rejects.toThrow(/Rust native core is not available/);
    expect(calls).toBe(0);
    expect(env.runtime.isBusy()).toBe(false);
    expect(await env.host.listNativeMissions(env.session.id)).toEqual([]);
    expect((await env.host.getState()).nativeCore).toEqual({ core: 'rust', daemon: 'unavailable', lastError: 'binary_missing' });
    expect(env.children).toHaveLength(0);
    // History-off missions never route to a store on disk, so they keep the in-memory journal.
    const noHistory = (await env.host.saveConnection({ name: 'No history', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'model-a', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off', history: false } })).connections.find(item => item.name === 'No history')!;
    const workspace = (await env.host.saveWorkspace({ name: 'Transient', projectLocation: env.project, connectionId: noHistory.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces.find(item => item.name === 'Transient')!;
    const transient = await env.host.createSession(workspace.id);
    const started = await env.host.startNativeMission(transient.id, { ...env.request, tasks: [{ ...env.request.tasks[0]!, connectionId: noHistory.id }] });
    expect((await settled(env.host, transient.id, started.id)).state).toBe('completed');
  });

  it('surfaces a clear error, without retrying, when another daemon holds the store lock (exit 4)', async () => {
    let calls = 0;
    const env = await fixture(async () => { calls++; return response('must not run'); }, { core: 'rust' });
    const holder = spawn(DAEMON_BINARY, ['--data-dir', env.data, '--profile', 'default'], { stdio: ['pipe', 'ignore', 'ignore'] });
    try {
      for (let n = 0; n < 200 && !existsSync(coreFile(env.data)); n++) await new Promise(resolve => setTimeout(resolve, 10));
      await expect(env.host.startNativeMission(env.session.id, env.request)).rejects.toThrow(/Another Extalia process/);
      await expect(env.host.startNativeMission(env.session.id, env.request)).rejects.toThrow(/Another Extalia process/);
      expect(env.children).toHaveLength(1);
      expect((await env.host.getState()).nativeCore).toEqual({ core: 'rust', daemon: 'unavailable', lastError: 'locked' });
      expect(env.log.some(line => line.includes('another process holds'))).toBe(true);
      expect(calls).toBe(0);
    } finally {
      holder.stdin.end();
      await new Promise(resolve => holder.once('close', resolve));
    }
  });

  it('keeps the flag off by default and honours the stored setting with the environment override first', async () => {
    const env = await fixture(async () => response('answer'));
    expect((await env.host.getState()).nativeCore).toBeUndefined();
    await warm(env);
    expect(env.children).toHaveLength(0);
    expect(existsSync(coreFile(env.data))).toBe(false);
    await env.close();
    const config = path.join(env.data, 'config', 'extalia.json');
    const stored = JSON.parse(await readFile(config, 'utf8')) as Record<string, unknown>;
    expect(stored.nativeCore).toBeUndefined();
    await writeFile(config, JSON.stringify({ ...stored, nativeCore: 'rust' }));
    const configured = await env.open();
    expect((await configured.host.getState()).nativeCore).toEqual({ core: 'rust', daemon: 'off' });
    await configured.close();
    const overridden = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: env.data, homeDirectory: env.home, importHome: env.home, observationIntervalMs: 60_000, env: { EXTALIA_SECRET_STORE: 'memory', HOME: env.home, PATH: '', EXTALIA_NATIVE_CORE: 'typescript' }, fetch: async () => response('answer') });
    closes.push(() => overridden.close());
    expect((await overridden.host.getState()).nativeCore).toBeUndefined();
  });
});
