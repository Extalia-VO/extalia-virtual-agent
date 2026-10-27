import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseEvent, type ExtaliaEvent } from '@extalia/protocol';
import type { HostMissionRequest, HostMissionRun } from '@extalia/platform';
import { MissionCheckpointStore } from '../src/missionCheckpoints.js';
import { MissionRecords } from '../src/mission.js';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { backendEnv, backendOptions, backends, coreFile, queryCore, type Backend } from './daemonBackend.js';

const cleanups: (() => Promise<void>)[] = [];
// Each suite below runs once per native core backend (audit PR 8).
let backend: Backend = 'typescript';
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const answer = (model: string, text = 'Unverified answer') => Response.json({ model, choices: [{ message: { content: text }, finish_reason: 'stop' }] });
const anthropic = (model: string, text = 'Unverified answer') => new Response([
  { type: 'message_start', message: { id: 'message-1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
type Fetch = NonNullable<Parameters<typeof createAgentHost>[0]['fetch']>;
async function setup(fetch: Fetch = async (_url, init) => {
  const model = (JSON.parse(String(init?.body)) as { model: string }).model;
  return model === 'model-b' ? anthropic(model) : answer(model);
}, existingRoot?: string) {
  const root = existingRoot ?? await mkdtemp(path.join(tmpdir(), 'extalia-missions-'));
  const project = path.join(root, 'project'), home = path.join(root, 'home'), data = path.join(root, 'data');
  await mkdir(project, { recursive: true }); await mkdir(home, { recursive: true });
  const runtime = await createAgentHost({ kind: 'bridge', version: '0.0.0-test', dataDirectory: data, homeDirectory: home, importHome: home, observationIntervalMs: 60_000, env: { EXTALIA_SECRET_STORE: 'memory', HOME: home, PATH: '', MISSION_KEY_A: 'opaque-secret-a-value', MISSION_KEY_B: 'opaque-secret-b-value', ...backendEnv(backend) }, fetch, ...backendOptions(backend) });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await runtime.close(); } };
  cleanups.push(async () => { await close(); if (!existingRoot) await rm(root, { recursive: true, force: true }); });
  const events: ExtaliaEvent[] = []; runtime.host.subscribe(event => events.push(event));
  return { root, project, data, runtime, host: runtime.host, events, close };
}
async function configure(host: AgentHostRuntime['host'], project: string, history = true) {
  const first = await host.saveConnection({ name: 'Provider A', preset: 'custom', api: 'openai-chat', baseUrl: 'https://a.example.com/v1', model: 'model-a', credential: { kind: 'env', variable: 'MISSION_KEY_A' }, features: { memory: 'off', skills: 'off', history } });
  const a = first.connections.find(item => item.name === 'Provider A')!;
  const second = await host.saveConnection({ name: 'Provider B', preset: 'custom', api: 'anthropic-messages', baseUrl: 'https://b.example.com', model: 'model-b', credential: { kind: 'env', variable: 'MISSION_KEY_B' }, features: { memory: 'off', skills: 'off' } });
  const b = second.connections.find(item => item.name === 'Provider B')!;
  const state = await host.saveWorkspace({ name: 'Project', projectLocation: project, connectionId: a.id, permissions: { fileWrite: 'ask', commands: 'ask' } });
  const workspace = state.workspaces[0]!;
  const session = await host.createSession(workspace.id);
  const request: HostMissionRequest = { title: 'Read-only review', maxConcurrency: 3, tasks: [
    { id: 'backend', title: 'Backend', instructions: 'Inspect backend only.', connectionId: a.id, model: 'model-a', dependsOn: [] },
    { id: 'frontend', title: 'Frontend', instructions: 'Inspect frontend only.', connectionId: b.id, model: 'model-b', dependsOn: [] },
    { id: 'qa', title: 'QA', instructions: 'Inspect QA only.', connectionId: a.id, model: 'model-a', dependsOn: [] },
  ] };
  return { a, b, workspace, session, request };
}
async function completed(host: AgentHostRuntime['host'], sessionId: string, missionId: string): Promise<HostMissionRun> {
  for (let n = 0; n < 300; n++) {
    const run = await host.nativeMissionRun(sessionId, missionId);
    if (run.state !== 'running') return run;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Mission did not settle.');
}
async function idle(runtime: AgentHostRuntime) {
  for (let n = 0; n < 300 && runtime.isBusy(); n++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(runtime.isBusy()).toBe(false);
}
function checkpointRuns(data: string, sessionId: string): HostMissionRun[] {
  const db = new DatabaseSync(path.join(data, 'state', 'missions.sqlite'), { readOnly: true });
  try {
    const rows = db.prepare('SELECT checkpoint.payload FROM mission_checkpoints checkpoint JOIN (SELECT run_id, MAX(revision) AS revision FROM mission_checkpoints WHERE session_id = ? GROUP BY run_id) latest ON latest.run_id = checkpoint.run_id AND latest.revision = checkpoint.revision ORDER BY checkpoint.updated_at DESC').all(sessionId) as { payload: string }[];
    return rows.map(row => JSON.parse(row.payload) as HostMissionRun);
  } finally { db.close(); }
}

describe.each(backends())('native missions through the managed host (%s core)', core => {
  beforeEach(() => { backend = core; });

  it('runs three tasks across two separately credentialed adapters and retains results with canonical v0 events after restart', async () => {
    const release = deferred(), entered = deferred();
    const calls: { url: string; headers: Headers; body: { model: string; tools?: { function?: { name: string }; name?: string }[] } }[] = [];
    const env = await setup(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as typeof calls[number]['body'];
      calls.push({ url, headers: new Headers(init?.headers), body });
      if (calls.length === 3) entered.resolve();
      await release.promise;
      return body.model === 'model-b' ? anthropic(body.model) : answer(body.model);
    });
    const { a, b, workspace, session, request } = await configure(env.host, env.project);
    await env.host.setWorkspaceMissionConnections(workspace.id, [b.id]);
    const started = await env.host.startNativeMission(session.id, request);
    await entered.promise;
    expect(env.runtime.isBusy()).toBe(true);
    await expect(env.host.setWorkspaceMissionConnections(workspace.id, [])).rejects.toThrow(/Stop or reconcile/);
    await expect(env.host.saveWorkspace({ id: workspace.id, name: 'Project', projectLocation: env.project, connectionId: a.id, missionConnectionIds: [], permissions: { fileWrite: 'ask', commands: 'ask' } })).rejects.toThrow(/Stop or reconcile/);
    await expect(env.host.saveWorkspace({ id: workspace.id, name: 'Project', projectLocation: env.project, connectionId: b.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).rejects.toThrow(/Stop or reconcile/);
    await expect(env.host.saveWorkspace({ id: workspace.id, name: 'Project', projectLocation: env.project, runtimeId: 'hermes', permissions: { fileWrite: 'ask', commands: 'ask' } })).rejects.toThrow(/Stop or reconcile/);
    const renamed = await env.host.saveWorkspace({ id: workspace.id, name: 'Renamed during mission', projectLocation: env.project, connectionId: a.id, permissions: { fileWrite: 'ask', commands: 'ask' } });
    expect(renamed.workspaces[0]?.name).toBe('Renamed during mission');
    expect(calls.map(call => call.body.model).sort()).toEqual(['model-a', 'model-a', 'model-b']);
    for (const call of calls) {
      expect(call.body.tools?.map(tool => tool.function?.name ?? tool.name).sort()).toEqual(['list_files', 'read_file', 'search_files']);
      if (call.body.model === 'model-a') { expect(call.headers.get('authorization')).toBe('Bearer opaque-secret-a-value'); expect(call.headers.has('x-api-key')).toBe(false); }
      else { expect(call.headers.get('x-api-key')).toBe('opaque-secret-b-value'); expect(call.headers.has('authorization')).toBe(false); }
    }
    await expect(env.host.startNativeMission(session.id, request)).rejects.toThrow(/still working/);
    await expect(env.host.sendPrompt(session.id, 'overlap')).rejects.toThrow(/active|working/);
    release.resolve();
    const final = await completed(env.host, session.id, started.id); await idle(env.runtime);
    expect(final.state).toBe('completed');
    expect(final.tasks.map(task => task.connectionId)).toEqual([a.id, b.id, a.id]);
    expect(final.tasks.every(task => task.state === 'completed' && task.verification === 'unverified' && !task.evidenceIds.length)).toBe(true);
    const events = await env.host.sessionEvents(session.id);
    expect(events.every(event => parseEvent(event).ok && event.v === 'extalia.v0')).toBe(true);
    const missionEvents = events.filter(event => event.correlationId === started.id);
    expect(missionEvents.filter(event => event.body.type === 'task.completed')).toHaveLength(3);
    expect(missionEvents.flatMap(event => event.body.type === 'subagent.spawned' ? [event.body.model] : []).sort()).toEqual(['model-a', 'model-a', 'model-b']);
    expect(missionEvents.filter(event => event.body.type === 'task.completed').map(event => event.taskId)).toEqual(expect.arrayContaining(final.tasks.map(task => task.taskId)));
    expect(events.every((event, index) => event.seq === index)).toBe(true);
    const stored = JSON.stringify(checkpointRuns(env.data, session.id));
    expect(stored).not.toMatch(/opaque-secret|Inspect backend|baseUrl|credential|schemaVersion/);
    await expect(readFile(path.join(env.data, 'sessions', `${session.id}.missions.json`))).rejects.toMatchObject({ code: 'ENOENT' });
    await env.close();
    // One owning store per mission: the daemon's core.sqlite only when the Rust core is selected.
    if (core === 'rust') {
      expect(queryCore(env.data, 'SELECT state FROM missions WHERE mission_id = ?', started.id)).toEqual([{ state: 'completed' }]);
      expect(queryCore(env.data, 'SELECT state FROM tasks WHERE mission_id = ?', started.id)).toEqual([{ state: 'completed' }, { state: 'completed' }, { state: 'completed' }]);
      expect(JSON.stringify(queryCore(env.data, 'SELECT payload FROM events'))).not.toMatch(/opaque-secret|Inspect backend|Unverified answer/);
    } else expect(existsSync(coreFile(env.data))).toBe(false);
    const reopened = await setup(undefined, env.root);
    expect(await reopened.host.nativeMissionRun(session.id, started.id)).toEqual(final);
    expect(await reopened.host.listNativeMissions(session.id)).toEqual([final]);
  });

  it('enforces opt-in connection allowlists, preserves them on workspace edits and validates deletion dependencies', async () => {
    let calls = 0;
    const env = await setup(async (_url, init) => { calls++; return answer((JSON.parse(String(init?.body)) as { model: string }).model); });
    const { b, workspace, session, request } = await configure(env.host, env.project);
    await expect(env.host.startNativeMission(session.id, request)).rejects.toThrow(/not authorized/);
    expect(calls).toBe(0); expect(env.runtime.isBusy()).toBe(false);
    await env.host.setWorkspaceMissionConnections(workspace.id, [b.id]);
    await expect(env.host.setWorkspaceMissionConnections(workspace.id, [b.id, b.id])).rejects.toThrow(/distinct/);
    const saved = await env.host.saveWorkspace({ id: workspace.id, name: 'Renamed', projectLocation: env.project, connectionId: workspace.providerProfileId, permissions: { fileWrite: 'ask', commands: 'ask' } });
    expect(saved.workspaces[0]?.missionConnectionIds).toEqual([b.id]);
    await expect(env.host.deleteConnection(b.id)).rejects.toThrow(/uses this connection/);
  });

  it('keeps history-off missions entirely in memory and rejects their workers from saved sessions', async () => {
    const env = await setup();
    const { a, b, workspace, session, request } = await configure(env.host, env.project, false);
    await env.host.setWorkspaceMissionConnections(workspace.id, [b.id]);
    expect(session.transient).toBe(true);
    const started = await env.host.startNativeMission(session.id, request);
    expect((await completed(env.host, session.id, started.id)).transient).toBe(true); await idle(env.runtime);
    expect((await readdir(path.join(env.data, 'sessions'))).some(name => name.startsWith(session.id))).toBe(false);
    const savedWorkspace = (await env.host.saveWorkspace({ name: 'Saved', projectLocation: env.project, connectionId: b.id, missionConnectionIds: [a.id], permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces.find(item => item.name === 'Saved')!;
    const saved = await env.host.createSession(savedWorkspace.id);
    await expect(env.host.startNativeMission(saved.id, { ...request, tasks: [request.tasks[0]!] })).rejects.toThrow(/History-off/);
    await env.close();
    const checkpoints = new DatabaseSync(path.join(env.data, 'state', 'missions.sqlite'), { readOnly: true });
    try { expect(checkpoints.prepare('SELECT session_id FROM checkpoint_sessions WHERE session_id = ?').get(session.id)).toBeUndefined(); }
    finally { checkpoints.close(); }
    const reopened = await setup(undefined, env.root);
    expect((await reopened.host.getState()).sessions.some(item => item.id === session.id)).toBe(false);
  });

  it('redacts exact known credentials in malicious model answers and mission labels', async () => {
    const env = await setup(async (_url, init) => answer((JSON.parse(String(init?.body)) as { model: string }).model, 'Echo opaque-secret-a-value and sk-example1234567890abcdef')); // extalia-allow-secret: synthetic redaction fixture.
    const { session, request } = await configure(env.host, env.project);
    request.tasks = [request.tasks[0]!]; request.title = 'Review opaque-secret-a-value'; request.tasks[0]!.title = 'Inspect opaque-secret-a-value';
    const started = await env.host.startNativeMission(session.id, request);
    const final = await completed(env.host, session.id, started.id); await idle(env.runtime);
    expect(final.tasks[0]?.answer).toContain('[redacted]');
    const persisted = JSON.stringify(checkpointRuns(env.data, session.id));
    const events = JSON.stringify(await env.host.sessionEvents(session.id));
    expect(JSON.stringify(started) + JSON.stringify(final) + persisted + events).not.toMatch(/opaque-secret-a-value|sk-example1234567890abcdef/); // extalia-allow-secret: assert the synthetic fixture is absent.
  });

  it('uses existing cancellation and holds session busy until mission persistence finishes', async () => {
    const entered = deferred();
    const env = await setup(async (_url, init) => {
      entered.resolve();
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('private cancellation detail')), { once: true }));
    });
    const { session, request } = await configure(env.host, env.project);
    request.tasks = [request.tasks[0]!];
    const started = await env.host.startNativeMission(session.id, request);
    await entered.promise; await env.host.cancel(session.id);
    const final = await completed(env.host, session.id, started.id); await idle(env.runtime);
    expect(final.state).toBe('cancelled');
    expect(final.tasks[0]?.state).toBe('cancelled');
    expect(JSON.stringify(final)).not.toContain('private cancellation detail');
    await env.host.deleteSession(session.id);
    expect(checkpointRuns(env.data, session.id)).toEqual([]);
    await expect(readFile(path.join(env.data, 'sessions', `${session.id}.missions.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('quarantines ignored aborts across sessions and restart without replay or unsafe deletion', async () => {
    const entered = deferred(), release = deferred<Response>();
    let calls = 0;
    const env = await setup(async () => { calls++; entered.resolve(); return release.promise; });
    const { workspace, session, request } = await configure(env.host, env.project);
    request.tasks = [{ ...request.tasks[0]!, timeoutMs: 50 }];
    const started = await env.host.startNativeMission(session.id, request);
    await entered.promise;
    const final = await completed(env.host, session.id, started.id); await idle(env.runtime);
    expect(final.state).toBe('recovering'); expect(final.tasks[0]?.state).toBe('unknown');
    const workerStates = (await env.host.sessionEvents(session.id)).filter(event => event.agentId === final.tasks[0]!.agentId && event.body.type === 'agent.state');
    expect(workerStates.at(-1)?.body).toMatchObject({ type: 'agent.state', state: 'blocked', summary: expect.stringContaining('unknown') });
    const other = await env.host.createSession(workspace.id);
    await expect(env.host.startNativeMission(other.id, request)).rejects.toThrow(/unresolved/);
    await expect(env.host.sendPrompt(other.id, 'unsafe overlap')).rejects.toThrow(/unresolved/);
    await expect(env.host.deleteSession(session.id)).rejects.toThrow(/unresolved/);
    await expect(env.host.deleteWorkspace(workspace.id)).rejects.toThrow(/unresolved/);
    const frozen = JSON.stringify(final);
    release.resolve(answer('model-a', 'late answer'));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(JSON.stringify(await env.host.nativeMissionRun(session.id, started.id))).toBe(frozen);
    await env.close();
    const reopened = await setup(async () => { throw new Error('Must not replay'); }, env.root);
    await expect(reopened.host.startNativeMission(other.id, request)).rejects.toThrow(/unresolved/);
    expect((await reopened.host.nativeMissionRun(session.id, started.id)).state).toBe('recovering');
    expect(calls).toBe(1);
  });

  // TypeScript journal fault injection; the Rust core's equivalent is in missionDaemon.test.ts.
  it.skipIf(core === 'rust')('surfaces failed terminal state commits as unknown execution instead of completion', async () => {
    const release = deferred<Response>(), entered = deferred();
    const env = await setup(async () => { entered.resolve(); return release.promise; });
    const { session, request } = await configure(env.host, env.project);
    request.tasks = [request.tasks[0]!];
    const started = await env.host.startNativeMission(session.id, request);
    await entered.promise;
    // Temporary checkpoint fault after admission: force the transactional journal append to abort.
    const checkpointDb = new DatabaseSync(path.join(env.data, 'state', 'missions.sqlite'));
    checkpointDb.exec("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON mission_changes BEGIN SELECT RAISE(ABORT, 'synthetic checkpoint failure'); END;");
    checkpointDb.close();
    release.resolve(answer('model-a'));
    const final = await completed(env.host, session.id, started.id); await idle(env.runtime);
    expect(final.state).toBe('recovering');
    expect(final.tasks[0]).toMatchObject({ state: 'unknown', reason: 'persistence-failed' });
    expect(final.tasks[0]?.answer).toBeUndefined(); // No uncommitted result is presented as completed.
    await expect(env.host.sendPrompt(session.id, 'unsafe retry')).rejects.toThrow(/unresolved/);
    // The checkpoint correctly remains at its last committed (running) revision;
    // the live host reports recovering, and restart will conservatively mark it unknown.
    expect(checkpointRuns(env.data, session.id)[0]).toMatchObject({ state: 'running' });
  });

  it('retains the current running record when bounded history timestamps tie', async () => {
    const env = await setup();
    const records = new MissionRecords(path.join(env.data, 'sessions'));
    const stamp = '2026-01-01T00:00:00.000Z';
    const base: HostMissionRun = { id: randomUUID(), sessionId: 's_example123', workspaceId: 'workspace', title: 'History', state: 'completed', createdAt: stamp, updatedAt: stamp, transient: true, tasks: [
      { id: 'read', taskId: randomUUID(), agentId: randomUUID(), title: 'Read', connectionId: 'connection', model: 'model', state: 'completed', verification: 'unverified', evidenceIds: [] },
    ] };
    for (let n = 0; n < 16; n++) records.updateMemory({ ...base, id: randomUUID() });
    const running = { ...base, id: randomUUID(), state: 'running' as const };
    records.updateMemory(running);
    expect(records.list(base.sessionId)).toHaveLength(16);
    expect(records.get(base.sessionId, running.id).state).toBe('running');
    expect(() => records.assertConnectionsClear(['connection'])).toThrow(/active|unresolved/);
  });

  it('rejects unknown metadata fields on restart rather than exposing injected credentials', async () => {
    const env = await setup();
    const { session, request } = await configure(env.host, env.project);
    request.tasks = [request.tasks[0]!];
    const started = await env.host.startNativeMission(session.id, request);
    const final = await completed(env.host, session.id, started.id); await idle(env.runtime); await env.close();
    const file = path.join(env.data, 'sessions', `${session.id}.missions.json`);
    await rm(path.join(env.data, 'state', 'missions.sqlite'));
    await writeFile(file, JSON.stringify({ schema: 'extalia.native-missions.v1', runs: [{ ...final, apiKey: 'synthetic-private-value' }] }));
    await expect(setup(undefined, env.root)).rejects.toThrow(/metadata is unavailable/);
    await writeFile(file, JSON.stringify({ schema: 'extalia.native-missions.v1', runs: [{ ...final, tasks: final.tasks.map(task => ({ ...task, endpoint: 'https://example.com' })) }] }));
    await expect(setup(undefined, env.root)).rejects.toThrow(/metadata is unavailable/);
    await writeFile(file, JSON.stringify({ schema: 'extalia.native-missions.v99', runs: [final] }));
    await expect(setup(undefined, env.root)).rejects.toThrow(/metadata is unavailable/);
  });

  it('marks interrupted saved metadata recovering on restart, never replays it', async () => {
    const env = await setup();
    const { session, request } = await configure(env.host, env.project);
    request.tasks = [request.tasks[0]!];
    const started = await env.host.startNativeMission(session.id, request);
    const final = await completed(env.host, session.id, started.id); await idle(env.runtime); await env.close();
    const checkpoint = await MissionCheckpointStore.open(path.join(env.data, 'state', 'missions.sqlite'));
    checkpoint.writeSession(session.id, [{ ...final, state: 'running', tasks: final.tasks.map(task => ({ ...task, state: 'running' })) }]);
    checkpoint.close();
    const reopened = await setup(async () => { throw new Error('Must not replay'); }, env.root);
    const recovered = await reopened.host.nativeMissionRun(session.id, started.id);
    expect(recovered.state).toBe('recovering');
    expect(recovered.tasks[0]).toMatchObject({ state: 'unknown', reason: 'host-restarted' });
    expect(recovered.tasks[0]?.answer).toBeUndefined();
    await expect(reopened.host.sendPrompt(session.id, 'unsafe retry')).rejects.toThrow(/unresolved/);
  });

  it('retains task dependency aliases for a mission launched in this window and after restart', async () => {
    const env = await setup();
    const { session, request } = await configure(env.host, env.project);
    request.tasks = [
      { ...request.tasks[0]!, id: 'survey', title: 'Survey', dependsOn: [] },
      { ...request.tasks[0]!, id: 'review', title: 'Review', dependsOn: ['survey'] },
    ];
    const started = await env.host.startNativeMission(session.id, request);
    const final = await completed(env.host, session.id, started.id); await idle(env.runtime);
    expect(final.tasks.map(task => [task.id, task.dependsOn])).toEqual([['survey', []], ['review', ['survey']]]);
    const persisted = checkpointRuns(env.data, session.id);
    expect(persisted[0]?.tasks.map(task => [task.id, task.dependsOn])).toEqual([['survey', []], ['review', ['survey']]]);
    await env.close();
    const reopened = await setup(undefined, env.root);
    expect((await reopened.host.nativeMissionRun(session.id, started.id)).tasks.map(task => task.dependsOn)).toEqual([[], ['survey']]);
  });
});
