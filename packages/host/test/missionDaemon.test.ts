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
import { MISSION_HEARTBEAT_MS } from '../src/daemon/mission.js';
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
const localDrains = (data: string, missionId: string) => queryCore(data,
  'SELECT proof_id AS proofId, kind, coverage, provider_operations AS providerOperations, tool_operations AS toolOperations, recorded_at AS recordedAt FROM execution_local_drains WHERE mission_id = ?', missionId);
const countingReads = () => {
  let reads = 0;
  const create = fileTools.createFileTools;
  vi.spyOn(fileTools, 'createFileTools').mockImplementation(root => create(root).map(tool => tool.name !== 'read_file' ? tool : ({
    ...tool, run: (input: unknown, context: ToolRunContext) => { reads++; return tool.run(input, context); },
  } as AnyTool)));
  return () => reads;
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** Only speed up host lease renewal; subprocess IO and every other timeout remain real. */
function fastHeartbeat() {
  const set = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) =>
    set(callback, delay === MISSION_HEARTBEAT_MS ? 20 : delay, ...args));
}

describe.skipIf(!HAS_DAEMON)('native missions on the Rust core daemon', () => {
  it('refuses caller-supplied adapter coverage before execution or daemon admission', async () => {
    let calls = 0;
    const env = await fixture(async () => { calls++; return response('must not run'); }, { core: 'rust' });
    for (const request of [
      { ...env.request, localSettlementCoverage: 'extalia-native-local-v1' },
      { ...env.request, tasks: env.request.tasks.map(task => ({ ...task, localSettlementCoverage: 'extalia-native-local-v1' })) },
    ]) await expect(env.host.startNativeMission(env.session.id, request as HostMissionRequest)).rejects.toThrow(/Invalid native mission request/);
    expect(calls).toBe(0); expect(env.children).toHaveLength(0);
  });

  it('records local drain only after the late provider and response body settle, retaining quarantine and evidence across restart', async () => {
    const entered = deferred(), late = deferred<Response>(), bodyEntered = deferred(), body = deferred<unknown>();
    let calls = 0;
    const env = await fixture(async () => { calls++; entered.resolve(); return late.promise; }, { core: 'rust' });
    const reads = countingReads();
    const started = await env.host.startNativeMission(env.session.id, { ...env.request, tasks: [{ ...env.task('late'), timeoutMs: 100 }] });
    await entered.promise;
    expect(queryCore(env.data, 'SELECT count(*) AS count FROM execution_admissions WHERE mission_id = ?', started.id)).toEqual([{ count: 1 }]);
    const uncertain = await settled(env.host, env.session.id, started.id); await idle(env.runtime);
    expect(uncertain.state).toBe('recovering');
    expect(queryCore(env.data, 'SELECT count(*) AS count FROM execution_observations WHERE mission_id = ?', started.id)).toEqual([{ count: 0 }]);
    expect(localDrains(env.data, started.id)).toEqual([]);
    const before = queryCore(env.data, 'SELECT event_id FROM events WHERE mission_id = ? ORDER BY sequence', started.id);
    const canonical = queryCore(env.data, 'SELECT state, version FROM missions WHERE mission_id = ?', started.id);
    const beforeReview = await env.host.refreshNativeMissionRecovery!(env.session.id, started.id);
    expect(beforeReview.reviewInspection?.status).toBe('available');
    const priorDigest = beforeReview.reviewInspection?.status === 'available' ? beforeReview.reviewInspection.review.reviewDigest : undefined;
    const lateResponse = readCall();
    vi.spyOn(lateResponse, 'json').mockImplementation(async () => { bodyEntered.resolve(); return body.promise; });
    late.resolve(lateResponse);
    await bodyEntered.promise;
    // Returning from fetch is insufficient: the raw provider still owns response processing.
    expect(queryCore(env.data, 'SELECT observation_id FROM execution_observations WHERE mission_id = ?', started.id)).toEqual([]);
    expect(localDrains(env.data, started.id)).toEqual([]);
    expect(reads()).toBe(0);
    body.resolve(await readCall().json());
    await vi.waitFor(() => expect(localDrains(env.data, started.id)).toHaveLength(1), { interval: 5, timeout: 3000 });
    const proof = { proofId: expect.any(String), kind: 'local-operations-drained', coverage: 'extalia-native-local-v1', providerOperations: 1, toolOperations: 0, recordedAt: expect.any(String) };
    expect(localDrains(env.data, started.id)).toEqual([proof]);
    expect(queryCore(env.data, 'SELECT kind FROM execution_observations WHERE mission_id = ?', started.id)).toEqual([{ kind: 'turn-promise-settled' }]);
    expect(queryCore(env.data, 'SELECT event_id FROM events WHERE mission_id = ? ORDER BY sequence', started.id)).toEqual(before);
    expect(queryCore(env.data, 'SELECT state, version FROM missions WHERE mission_id = ?', started.id)).toEqual(canonical);
    expect(await env.host.nativeMissionRun(env.session.id, started.id)).toEqual(uncertain);
    expect(reads()).toBe(0); expect(calls).toBe(1);
    const inspection = await env.host.refreshNativeMissionRecovery!(env.session.id, started.id);
    expect(inspection).toMatchObject({ status: 'quarantined', reason: 'execution-uncertain', run: { state: 'recovering' }, executionInspection: { status: 'available', executions: [{ observation: { kind: 'turn-promise-settled' }, localDrain: proof }] } });
    expect(inspection.reviewInspection).toMatchObject({ status: 'available', review: { missingAdmissionTaskIds: [], worktreeOwnership: 'unverified' } });
    if (inspection.reviewInspection?.status !== 'available') throw new Error('Missing recovery review');
    expect(inspection.reviewInspection.review.snapshot).toEqual(beforeReview.snapshot);
    expect(inspection.reviewInspection.review.reviewDigest).not.toBe(priorDigest);
    await expect(env.host.startNativeMission(env.session.id, env.request)).rejects.toThrow(/unresolved/);
    await env.close();
    const next = await env.open(async () => { calls++; return response('must not replay'); });
    const retained = await next.host.refreshNativeMissionRecovery!(env.session.id, started.id);
    expect(retained).toMatchObject({ run: { state: 'recovering' }, executionInspection: inspection.executionInspection });
    expect(localDrains(env.data, started.id)).toHaveLength(1);
    expect(queryCore(env.data, 'SELECT event_id FROM events WHERE mission_id = ? ORDER BY sequence', started.id)).toEqual(before);
    expect(calls).toBe(1);
  });

  it('withholds local drain while a raw read tool ignores abort, then records it once without changing quarantined results', async () => {
    const toolEntered = deferred(), rawTool = deferred<{ ok: boolean; output: string }>();
    let calls = 0, reads = 0;
    let toolSignal: AbortSignal | undefined;
    const create = fileTools.createFileTools;
    vi.spyOn(fileTools, 'createFileTools').mockImplementation(root => create(root).map(tool => tool.name !== 'read_file' ? tool : ({
      ...tool,
      run: (_input: unknown, context: ToolRunContext) => {
        reads++; toolSignal = context.signal; toolEntered.resolve();
        return rawTool.promise;
      },
    } as AnyTool)));
    const env = await fixture(async () => { calls++; return readCall(); }, { core: 'rust' });
    const started = await env.host.startNativeMission(env.session.id, { ...env.request, tasks: [{ ...env.task('late-tool'), timeoutMs: 100 }] });
    await toolEntered.promise;
    const uncertain = await settled(env.host, env.session.id, started.id); await idle(env.runtime);
    expect(uncertain).toMatchObject({ state: 'recovering', tasks: [{ state: 'unknown', reason: 'execution-unknown' }] });
    expect(toolSignal?.aborted).toBe(true);
    expect(queryCore(env.data, 'SELECT observation_id FROM execution_observations WHERE mission_id = ?', started.id)).toEqual([]);
    expect(localDrains(env.data, started.id)).toEqual([]);
    const before = queryCore(env.data, 'SELECT event_id FROM events WHERE mission_id = ? ORDER BY sequence', started.id);
    const canonical = queryCore(env.data, 'SELECT state, version FROM missions WHERE mission_id = ?', started.id);
    rawTool.resolve({ ok: true, output: 'Late raw tool output must stay discarded.' });
    await vi.waitFor(() => expect(localDrains(env.data, started.id)).toHaveLength(1), { interval: 5, timeout: 3000 });
    expect(localDrains(env.data, started.id)).toEqual([{ proofId: expect.any(String), kind: 'local-operations-drained', coverage: 'extalia-native-local-v1', providerOperations: 1, toolOperations: 1, recordedAt: expect.any(String) }]);
    expect(queryCore(env.data, 'SELECT kind FROM execution_observations WHERE mission_id = ?', started.id)).toEqual([{ kind: 'turn-promise-settled' }]);
    expect(queryCore(env.data, 'SELECT event_id FROM events WHERE mission_id = ? ORDER BY sequence', started.id)).toEqual(before);
    expect(queryCore(env.data, 'SELECT state, version FROM missions WHERE mission_id = ?', started.id)).toEqual(canonical);
    expect(await env.host.nativeMissionRun(env.session.id, started.id)).toEqual(uncertain);
    await expect(env.host.startNativeMission(env.session.id, env.request)).rejects.toThrow(/unresolved/);
    expect(reads).toBe(1); expect(calls).toBe(1);
  }, 60_000);

  it('does not call a provider when durable admission fails, and does not invent an observation', async () => {
    let calls = 0;
    const env = await fixture(async () => { calls++; return response('warm'); }, { core: 'rust' });
    await warm(env);
    const db = new DatabaseSync(coreFile(env.data));
    try { db.exec("CREATE TRIGGER fail_execution_admission BEFORE INSERT ON execution_admissions BEGIN SELECT RAISE(ABORT, 'synthetic admission failure'); END;"); } finally { db.close(); }
    const started = await env.host.startNativeMission(env.session.id, env.request);
    expect((await settled(env.host, env.session.id, started.id)).state).toBe('recovering'); await idle(env.runtime);
    expect(calls).toBe(1);
    expect(queryCore(env.data, 'SELECT state FROM tasks WHERE mission_id = ?', started.id)).toEqual([{ state: 'queued' }]);
    expect(queryCore(env.data, 'SELECT lease_id FROM execution_admissions WHERE mission_id = ?', started.id)).toEqual([]);
    expect(queryCore(env.data, 'SELECT observation_id FROM execution_observations WHERE mission_id = ?', started.id)).toEqual([]);
    expect(localDrains(env.data, started.id)).toEqual([]);
  });

  it('reports a failed late observation without clearing quarantine, retrying or reconnecting', async () => {
    const entered = deferred(), late = deferred<Response>();
    const env = await fixture(async () => { entered.resolve(); return late.promise; }, { core: 'rust' });
    const started = await env.host.startNativeMission(env.session.id, { ...env.request, tasks: [{ ...env.task('late'), timeoutMs: 100 }] });
    await entered.promise; await settled(env.host, env.session.id, started.id); await idle(env.runtime);
    const db = new DatabaseSync(coreFile(env.data));
    try { db.exec("CREATE TRIGGER fail_execution_observation BEFORE INSERT ON execution_observations BEGIN SELECT RAISE(ABORT, 'synthetic observation failure'); END;"); } finally { db.close(); }
    late.resolve(response('discarded'));
    for (let n = 0; n < 400 && !env.log.some(line => line.includes('observation could not be recorded')); n++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(env.log.some(line => line.includes('observation could not be recorded'))).toBe(true);
    await vi.waitFor(() => expect(env.log.some(line => line.includes('local drain could not be recorded'))).toBe(true), { interval: 5, timeout: 3000 });
    expect(queryCore(env.data, 'SELECT observation_id FROM execution_observations WHERE mission_id = ?', started.id)).toEqual([]);
    expect(localDrains(env.data, started.id)).toEqual([]);
    expect((await env.host.nativeMissionRun(env.session.id, started.id)).state).toBe('recovering');
    const inspected = await env.host.refreshNativeMissionRecovery!(env.session.id, started.id);
    expect(inspected).toMatchObject({ status: 'quarantined', executionInspection: { status: 'available', executions: [{}] } });
    expect(JSON.stringify(inspected.executionInspection)).not.toMatch(/observation|localDrain/);
    expect(env.children).toHaveLength(1);
  });

  it('logs a local-drain write failure without losing the weak observation, clearing quarantine or reconnecting', async () => {
    const entered = deferred(), late = deferred<Response>();
    let calls = 0;
    const env = await fixture(async () => { calls++; entered.resolve(); return late.promise; }, { core: 'rust' });
    const reads = countingReads();
    const started = await env.host.startNativeMission(env.session.id, { ...env.request, tasks: [{ ...env.task('late'), timeoutMs: 100 }] });
    await entered.promise;
    const uncertain = await settled(env.host, env.session.id, started.id); await idle(env.runtime);
    const before = queryCore(env.data, 'SELECT event_id FROM events WHERE mission_id = ? ORDER BY sequence', started.id);
    const db = new DatabaseSync(coreFile(env.data));
    try { db.exec("CREATE TRIGGER fail_execution_local_drain BEFORE INSERT ON execution_local_drains BEGIN SELECT RAISE(ABORT, 'synthetic local drain failure'); END;"); } finally { db.close(); }
    late.resolve(readCall());
    await vi.waitFor(() => expect(env.log.some(line => line.includes('local drain could not be recorded'))).toBe(true), { interval: 5, timeout: 3000 });
    expect(queryCore(env.data, 'SELECT kind FROM execution_observations WHERE mission_id = ?', started.id)).toEqual([{ kind: 'turn-promise-settled' }]);
    expect(localDrains(env.data, started.id)).toEqual([]);
    expect(await env.host.nativeMissionRun(env.session.id, started.id)).toEqual(uncertain);
    expect(queryCore(env.data, 'SELECT event_id FROM events WHERE mission_id = ? ORDER BY sequence', started.id)).toEqual(before);
    const inspected = await env.host.refreshNativeMissionRecovery!(env.session.id, started.id);
    expect(inspected).toMatchObject({ status: 'quarantined', executionInspection: { status: 'available', executions: [{ observation: { kind: 'turn-promise-settled' } }] } });
    expect(JSON.stringify(inspected.executionInspection)).not.toContain('localDrain');
    await expect(env.host.startNativeMission(env.session.id, env.request)).rejects.toThrow(/unresolved/);
    expect((await env.host.getState()).nativeCore).toEqual({ core: 'rust', daemon: 'ready' });
    expect(env.children).toHaveLength(1);
    expect(reads()).toBe(0); expect(calls).toBe(1);
  });

  it('suppresses late observation and local-drain writes after host shutdown without starting another daemon', async () => {
    const entered = deferred(), late = deferred<Response>(), bodyRead = deferred();
    const env = await fixture(async () => { entered.resolve(); return late.promise; }, { core: 'rust' });
    const reads = countingReads();
    const started = await env.host.startNativeMission(env.session.id, { ...env.request, tasks: [{ ...env.task('late'), timeoutMs: 100 }] });
    await entered.promise; await settled(env.host, env.session.id, started.id); await idle(env.runtime);
    await env.close();
    const lateResponse = readCall(), readBody = lateResponse.json.bind(lateResponse);
    vi.spyOn(lateResponse, 'json').mockImplementation(async () => { const body = await readBody(); bodyRead.resolve(); return body; });
    late.resolve(lateResponse);
    await bodyRead.promise;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(queryCore(env.data, 'SELECT observation_id FROM execution_observations WHERE mission_id = ?', started.id)).toEqual([]);
    expect(localDrains(env.data, started.id)).toEqual([]);
    expect(reads()).toBe(0);
    expect(env.log.some(line => line.includes('local drain could not be recorded'))).toBe(false);
    expect(env.children).toHaveLength(1);
  });

  it('observes daemon-side reaping before any host heartbeat or new provider event, without admitting late work', async () => {
    const entered = deferred(), reply = deferred<Response>();
    let calls = 0;
    const env = await fixture(async () => { calls++; entered.resolve(); return reply.promise; }, { core: 'rust' });
    const reads = countingReads();
    const started = await env.host.startNativeMission(env.session.id, { ...env.request, maxConcurrency: 1, tasks: [env.task('silent'), env.task('queued')] });
    await entered.promise;
    const lease = queryCore<{ lease_id: string; acquired_at: string }>(env.data,
      'SELECT l.lease_id, l.acquired_at FROM leases l JOIN tasks t ON t.task_id = l.task_id WHERE t.mission_id = ?', started.id)[0]!;
    const events = queryCore(env.data, 'SELECT event_id FROM events WHERE mission_id = ? ORDER BY sequence', started.id);
    await new Promise(resolve => setTimeout(resolve, 10));
    const db = new DatabaseSync(coreFile(env.data));
    try { db.prepare('UPDATE leases SET expires_at = ? WHERE lease_id = ?').run(new Date(Date.parse(lease.acquired_at) + 1).toISOString(), lease.lease_id); }
    finally { db.close(); }
    let canonical = 'running';
    for (let attempt = 0; attempt < 500 && canonical !== 'recovering'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      canonical = queryCore<{ state: string }>(env.data, 'SELECT state FROM missions WHERE mission_id = ?', started.id)[0]!.state;
    }
    expect(canonical).toBe('recovering');
    expect(calls).toBe(1);
    expect(queryCore(env.data, 'SELECT state FROM tasks WHERE task_id = ?', started.tasks[0]!.taskId)).toEqual([{ state: 'unknown' }]);
    expect(queryCore(env.data, 'SELECT state FROM tasks WHERE task_id = ?', started.tasks[1]!.taskId)).toEqual([{ state: 'queued' }]);
    expect(queryCore(env.data, 'SELECT event_id FROM events WHERE mission_id = ? ORDER BY sequence', started.id)).toEqual(events);
    // A model response arriving after logical fencing cannot reach a tool or the next task.
    reply.resolve(readCall());
    expect((await settled(env.host, env.session.id, started.id)).state).toBe('recovering');
    await idle(env.runtime);
    expect(reads()).toBe(0); expect(calls).toBe(1);
    const inspected = await env.host.refreshNativeMissionRecovery!(env.session.id, started.id);
    expect(inspected).toMatchObject({ snapshot: { state: 'recovering', leases: [] }, run: { state: 'recovering' } });
    await expect(env.host.startNativeMission(env.session.id, env.request)).rejects.toThrow(/unresolved/);
  });

  it('renews an event-silent provider independently, then fails closed on expired authority without late reads or restart replay', async () => {
    const entered = deferred();
    const lateReply = deferred<Response>();
    const providerReturned = deferred();
    let calls = 0;
    let providerSignal: AbortSignal | null | undefined;
    const env = await fixture(async (_url, init) => {
      calls++;
      providerSignal = init?.signal;
      entered.resolve();
      const reply = await lateReply.promise; // Deliberately ignores cancellation.
      providerReturned.resolve();
      return reply;
    }, { core: 'rust' });
    const reads = countingReads();
    fastHeartbeat();
    const started = await env.host.startNativeMission(env.session.id, { ...env.request, maxConcurrency: 1, tasks: [env.task('silent'), env.task('queued')] });
    await entered.promise;
    const leases = () => queryCore<{ lease_id: string; acquired_at: string; expires_at: string }>(env.data,
      'SELECT l.lease_id, l.acquired_at, l.expires_at FROM leases l JOIN tasks t ON t.profile_id = l.profile_id AND t.task_id = l.task_id WHERE t.mission_id = ?', started.id);
    const before = leases()[0]!;
    expect(before).toBeDefined();
    const journalLength = queryCore<{ count: number }>(env.data, 'SELECT count(*) AS count FROM events WHERE mission_id = ?', started.id)[0]!.count;
    let renewed = before;
    for (let attempt = 0; attempt < 200 && renewed.expires_at === before.expires_at; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      renewed = leases()[0]!;
    }
    expect(Date.parse(renewed.expires_at)).toBeGreaterThan(Date.parse(before.expires_at));
    expect(renewed.lease_id).toBe(before.lease_id);
    expect(renewed.acquired_at).toBe(before.acquired_at);
    expect(queryCore(env.data, 'SELECT count(*) AS count FROM events WHERE mission_id = ?', started.id)).toEqual([{ count: journalLength }]);
    expect(providerSignal?.aborted).toBe(false);
    expect(calls).toBe(1);
    // Fault injection in this fixture's temporary database: no clock changes or user data.
    const db = new DatabaseSync(coreFile(env.data));
    try { db.prepare('UPDATE leases SET expires_at = ? WHERE lease_id = ?').run('2000-01-01T00:00:00.000Z', before.lease_id); }
    finally { db.close(); }
    const failed = await settled(env.host, env.session.id, started.id); await idle(env.runtime);
    expect(failed).toMatchObject({ state: 'recovering', recovery: { source: 'execution-uncertain' } });
    expect(failed.tasks.map(task => [task.id, task.state, task.reason])).toEqual([
      ['silent', 'unknown', 'persistence-failed'], ['queued', 'blocked', 'persistence-failed'],
    ]);
    expect(providerSignal?.aborted).toBe(true);
    expect(reads()).toBe(0);
    expect(calls).toBe(1);
    expect((await env.host.getState()).nativeCore).toEqual({ core: 'rust', daemon: 'ready' });
    const durableEvents = queryCore(env.data, 'SELECT sequence, event_id, event_type FROM events WHERE mission_id = ? ORDER BY sequence', started.id);
    lateReply.resolve(readCall());
    await providerReturned.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(reads()).toBe(0);
    expect(calls).toBe(1);
    expect(queryCore(env.data, 'SELECT sequence, event_id, event_type FROM events WHERE mission_id = ? ORDER BY sequence', started.id)).toEqual(durableEvents);
    await expect(env.host.startNativeMission(env.session.id, env.request)).rejects.toThrow(/unresolved/);
    await env.close();
    const reopened = await env.open(async () => { calls++; return response('must not replay'); });
    expect((await reopened.host.nativeMissionRun(env.session.id, started.id)).state).toBe('recovering');
    await expect(reopened.host.startNativeMission(env.session.id, env.request)).rejects.toThrow(/unresolved/);
    expect(reads()).toBe(0);
    expect(calls).toBe(1);
  });

  it('interrupts a silent cooperative provider when independent heartbeat discovers a crashed daemon', async () => {
    const entered = deferred();
    let calls = 0, aborted = false;
    const env = await fixture(async (_url, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
        entered.resolve();
      });
    }, { core: 'rust' });
    fastHeartbeat();
    const started = await env.host.startNativeMission(env.session.id, env.request);
    await entered.promise;
    env.children[0]!.kill('SIGKILL');
    const failed = await settled(env.host, env.session.id, started.id); await idle(env.runtime);
    expect(aborted).toBe(true);
    expect(failed).toMatchObject({ state: 'recovering', tasks: [{ state: 'unknown', reason: 'persistence-failed' }] });
    expect((await env.host.getState()).nativeCore).toMatchObject({ core: 'rust', daemon: 'unavailable' });
    expect(calls).toBe(1);
    await env.close();
    const reopened = await env.open(async () => { calls++; return response('must not replay'); });
    expect((await reopened.host.nativeMissionRun(env.session.id, started.id)).state).toBe('recovering');
    await expect(reopened.host.startNativeMission(env.session.id, env.request)).rejects.toThrow(/unresolved/);
    expect(calls).toBe(1);
  });

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
    expect(inspected).toMatchObject({ status: 'refreshed', run: { state: 'completed' }, snapshot: { state: 'completed', leases: [] }, reviewInspection: { status: 'available', review: { kind: 'extalia-recovery-review-v1', missingAdmissionTaskIds: [], worktreeOwnership: 'unverified' } } });
    if (inspected.reviewInspection?.status !== 'available') throw new Error('Missing atomic review');
    expect(inspected.reviewInspection.review.snapshot).toEqual(inspected.snapshot);
    expect(inspected.reviewInspection.review.executions).toEqual(inspected.executionInspection?.status === 'available' ? inspected.executionInspection.executions : []);
    expect(inspected.reviewInspection.review.reviewDigest).toMatch(/^[a-f0-9]{64}$/);
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
    await vi.waitFor(() => expect(localDrains(env.data, started.id)).toHaveLength(1), { interval: 5, timeout: 3000 });
    const proof = localDrains(env.data, started.id)[0]!;
    expect(proof).toEqual({ proofId: expect.any(String), kind: 'local-operations-drained', coverage: 'extalia-native-local-v1', providerOperations: 2, toolOperations: 1, recordedAt: expect.any(String) });
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
    const inspected = await reopened.host.refreshNativeMissionRecovery!(env.session.id, started.id);
    expect(inspected).toMatchObject({ status: 'refreshed', run: { state: 'completed' }, executionInspection: { status: 'available', executions: [{ localDrain: proof }] } });
    expect(localDrains(env.data, started.id)).toEqual([proof]);
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
