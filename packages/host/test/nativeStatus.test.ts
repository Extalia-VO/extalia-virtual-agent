import type { HostMissionRun, NativeActiveRun } from '@extalia/platform';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeStatusSnapshot, type NativeStatusMissionMetadata } from '../src/nativeStatus.js';
import { createAgentHost, type AgentHostOptions, type AgentHostRuntime } from '../src/service.js';
import { MissionRecords } from '../src/mission.js';
import { SessionStore } from '../src/sessions.js';
import { DaemonSidecar } from '../src/daemon/sidecar.js';

const at = '2026-11-01T00:00:00.000Z';
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const mission = (n = 1): HostMissionRun => ({
  id: id(n), sessionId: `s_example${n}`, workspaceId: 'w_example', title: 'Review', state: 'recovering', createdAt: at, updatedAt: at,
  transient: false, authority: { backend: 'rust', profileId: 'default', workspaceId: id(1000), supervisorId: id(1001) }, recovery: { source: 'host-restart', at },
  tasks: [{ id: 'inspect', taskId: id(2000), agentId: id(2001), title: 'Inspect', connectionId: 'c_example', model: 'model-a', state: 'running', evidenceIds: [], answer: 'PRIVATE ANSWER' }],
});
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); vi.restoreAllMocks(); });

function response(text: string) { return Response.json({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }); }
function toolCall(name: string, args: object) { return Response.json({ choices: [{ message: { content: '', tool_calls: [{ id: 'call-example', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }); }
async function fixture(fetch: NonNullable<AgentHostOptions['fetch']> = async () => response('Done')) {
  const root = await mkdtemp(path.join(tmpdir(), 'extalia-native-status-'));
  const data = path.join(root, 'data'), home = path.join(root, 'home'), project = path.join(root, 'project');
  await Promise.all([mkdir(project), mkdir(home)]);
  const options: AgentHostOptions = { kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home,
    env: { EXTALIA_SECRET_STORE: 'memory', EXTALIA_HERMES_BIN: path.join(root, 'missing') }, observationIntervalMs: 60_000,
    knowledge: { watcher: false }, fetch };
  const runtime = await createAgentHost(options);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await runtime.close(); } };
  cleanups.push(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  const connection = (await runtime.host.saveConnection({ name: 'Provider', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'model-a', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } })).connections[0]!;
  const workspace = (await runtime.host.saveWorkspace({ name: 'Project', projectLocation: project, connectionId: connection.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
  const session = await runtime.host.createSession(workspace.id);
  return { root, data, project, options, runtime, host: runtime.host, connection, workspace, session, close };
}
async function idle(runtime: AgentHostRuntime) { await vi.waitFor(() => expect(runtime.isBusy()).toBe(false)); }

describe('native status snapshot', () => {
  it('retains recorded Rust ownership after a backend change without exposing results or canonical identities', () => {
    const run = mission();
    const status = nativeStatusSnapshot({ backend: 'typescript', daemon: { state: 'ready' }, active: [], workers: [], missions: [run], blockers: [] });
    expect(status).toMatchObject({ backend: 'typescript', providerLoop: 'typescript', daemon: { state: 'ready' },
      missions: [{ backend: 'rust', state: 'recovering' }], workers: [{ state: 'running', active: false, evidence: 'recorded-task' }], blockers: [{ kind: 'mission-recovery', reason: 'host-restart' }] });
    expect(JSON.stringify(status)).not.toMatch(/PRIVATE ANSWER|supervisorId|profileId|connectionId|model-a|evidenceIds/);
    status.missions[0]!.tasks[0]!.state = 'changed';
    expect(run.tasks[0]!.state).toBe('running');
  });

  it('caps every list while reporting actual totals and truncation', () => {
    const active: NativeActiveRun[] = Array.from({ length: 70 }, (_, index) => ({ id: `run-${index}`, sessionId: `s_example${index}`, workspaceId: 'w_example', kind: 'chat', cancellationRequested: false }));
    const status = nativeStatusSnapshot({ backend: 'rust', daemon: { state: 'off' }, active, workers: [], missions: Array.from({ length: 150 }, (_, index) => mission(index + 1)), blockers: [] });
    expect(status.totals).toEqual({ active: 70, workers: 150, missions: 150, blockers: 150 });
    expect(status.truncated).toEqual({ active: true, workers: true, missions: true, blockers: true });
    expect([status.active.length, status.workers.length, status.missions.length, status.blockers.length]).toEqual([64, 128, 64, 128]);
  });

  it('excludes terminal history and never reads retained answers or truncated task projections', () => {
    const history = (['completed', 'failed', 'cancelled'] as const).map((state, index) => ({ ...mission(index + 500), state }));
    const relevant = Array.from({ length: 150 }, (_, index) => mission(index + 1));
    for (const run of [...history, ...relevant]) Object.defineProperty(run.tasks[0]!, 'answer', { get: () => { throw new Error('Answer text must never be read'); } });
    let projectedTasks = 0;
    function* metadata(): IterableIterator<NativeStatusMissionMetadata | HostMissionRun> {
      yield* history;
      for (const run of relevant) yield {
        id: run.id, sessionId: run.sessionId, workspaceId: run.workspaceId, title: run.title, state: run.state,
        backend: 'rust', taskCount: run.tasks.length, recoveryReason: 'host-restart',
        tasks: (function* () {
          for (const task of run.tasks) {
            projectedTasks++;
            if (projectedTasks > 128) throw new Error('Truncated tasks must never be projected');
            yield { id: task.id, taskId: task.taskId, title: task.title, state: task.state };
          }
        })(),
      };
    }
    const status = nativeStatusSnapshot({ backend: 'typescript', daemon: { state: 'off' }, active: [], workers: [], missions: metadata(), blockers: [] });
    expect(status.totals).toEqual({ active: 0, workers: 150, missions: 150, blockers: 150 });
    expect(status.truncated).toEqual({ active: false, workers: true, missions: true, blockers: true });
    expect(projectedTasks).toBe(128);
    expect(status.missions.every(run => run.state === 'recovering')).toBe(true);
    expect(status.workers.every(worker => relevant.some(run => run.id === worker.missionId))).toBe(true);
    // Full-record callers also project only known task metadata, never answer properties.
    expect(nativeStatusSnapshot({ backend: 'typescript', daemon: { state: 'off' }, active: [], workers: [], missions: [relevant[0]!, ...history], blockers: [] }).totals.missions).toBe(1);
  });

  it('never starts or contacts the sidecar on reads or an empty refresh', async () => {
    const f = await fixture(), connect = vi.spyOn(DaemonSidecar.prototype, 'connect');
    for (let n = 0; n < 5; n++) expect(await f.host.nativeStatus!()).toMatchObject({ backend: 'typescript', daemon: { state: 'off' }, active: [] });
    expect(await f.host.refreshNativeStatus!()).toMatchObject({ recheck: { status: 'checked', inspected: 0, retired: 0, remaining: 0 } });
    expect(connect).not.toHaveBeenCalled();
  });

  it('shows awaiting approval and requested cancellation until the physical provider settles', async () => {
    const providerEntered = deferred<void>(), finish = deferred<Response>();
    let calls = 0;
    const f = await fixture(async () => {
      if (++calls === 1) return toolCall('write_file', { path: 'example.txt', content: 'example' });
      providerEntered.resolve(); return finish.promise;
    });
    await f.host.sendPrompt(f.session.id, 'Create example');
    await vi.waitFor(async () => expect((await f.host.nativeStatus!()).active[0]?.approvalId).toBeTypeOf('string'));
    const waiting = (await f.host.nativeStatus!()).active[0]!;
    expect(waiting).toMatchObject({ kind: 'chat', sessionId: f.session.id, workspaceId: f.workspace.id, cancellationRequested: false });
    await f.host.resolveApproval(f.session.id, waiting.approvalId!, 'once');
    await providerEntered.promise;
    await f.host.cancel(f.session.id);
    expect((await f.host.nativeStatus!()).active).toMatchObject([{ id: waiting.id, cancellationRequested: true }]);
    finish.resolve(response('Stopped')); await idle(f.runtime);
    expect((await f.host.nativeStatus!()).active).toEqual([]);
  });

  it('refuses stale cancellation of a replacement Native run in the same session', async () => {
    const entered = [deferred<void>(), deferred<void>()], release = [deferred<Response>(), deferred<Response>()];
    const signals: (AbortSignal | null | undefined)[] = [];
    let calls = 0;
    const f = await fixture(async (_url, init) => {
      const index = calls++; signals.push(init?.signal);
      entered[index]!.resolve(); return release[index]!.promise;
    });
    await f.host.sendPrompt(f.session.id, 'First'); await entered[0]!.promise;
    const oldId = (await f.host.nativeStatus!()).active[0]!.id;
    release[0]!.resolve(response('First finished')); await idle(f.runtime);
    await expect(f.host.cancel(f.session.id, oldId)).rejects.toThrow(/changed|finished/);
    await f.host.sendPrompt(f.session.id, 'Second'); await entered[1]!.promise;
    const current = (await f.host.nativeStatus!()).active[0]!;
    expect(current.id).not.toBe(oldId);
    await expect(f.host.cancel(f.session.id, oldId)).rejects.toThrow(/changed|finished/);
    expect((await f.host.nativeStatus!()).active[0]).toMatchObject({ id: current.id, cancellationRequested: false });
    expect(signals[1]?.aborted).toBe(false);
    await f.host.cancel(f.session.id, current.id);
    expect(signals[1]?.aborted).toBe(true);
    release[1]!.resolve(response('Second finished')); await idle(f.runtime);
  });

  it('counts real delegated invocations rather than configured roster members', async () => {
    const leadEntered = deferred<void>(), releaseLead = deferred<Response>(), workerEntered = deferred<void>(), releaseWorker = deferred<Response>();
    let calls = 0;
    const f = await fixture(async () => {
      calls++;
      if (calls === 1) { leadEntered.resolve(); return releaseLead.promise; }
      if (calls === 2) { workerEntered.resolve(); return releaseWorker.promise; }
      return response('Lead finished');
    });
    await f.host.saveSessionTeam(f.session.id, { enabled: true, allowedModels: ['model-a'], members: [{ id: 'member-example', name: 'Reviewer', role: 'reviewer', models: ['model-a'] }], updatedAt: at });
    await f.host.sendPrompt(f.session.id, 'Review'); await leadEntered.promise;
    expect((await f.host.nativeStatus!()).workers).toEqual([]);
    releaseLead.resolve(toolCall('delegate_task', { member: 'Reviewer', task: 'Review examples' }));
    await workerEntered.promise;
    const running = await f.host.nativeStatus!();
    expect(running.workers).toMatchObject([{ kind: 'delegated', active: true, evidence: 'local-invocation', workspaceId: f.workspace.id, label: 'Reviewer · Provider · model-a' }]);
    expect(JSON.stringify(running.workers)).not.toContain('Review examples');
    await f.host.cancel(f.session.id);
    expect((await f.host.nativeStatus!()).workers).toHaveLength(1);
    releaseWorker.resolve(response('Findings')); await idle(f.runtime);
    expect((await f.host.nativeStatus!()).workers).toEqual([]);
  });

  it('shows saved recovering Rust missions after switching the host to TypeScript without polling canonical state', async () => {
    const f = await fixture(); await f.close();
    const store = new SessionStore(path.join(f.data, 'sessions')), record = (await store.get(f.session.id))!;
    const records = new MissionRecords(path.join(f.data, 'sessions'), path.join(f.data, 'state', 'missions.sqlite'));
    await records.initialize([record]);
    await records.save({ ...mission(), sessionId: f.session.id, workspaceId: f.workspace.id });
    for (const [index, state] of (['completed', 'failed', 'cancelled'] as const).entries()) await records.save({
      ...mission(index + 500), sessionId: f.session.id, workspaceId: f.workspace.id, state,
      tasks: mission(index + 500).tasks.map(task => ({ ...task, state, answer: 'Retained historical answer '.repeat(400) })),
    });
    records.close();
    const runtime = await createAgentHost({ ...f.options, nativeCore: 'typescript' }); cleanups.push(() => runtime.close());
    const connect = vi.spyOn(DaemonSidecar.prototype, 'connect');
    const stringify = vi.spyOn(JSON, 'stringify');
    const status = await runtime.host.nativeStatus!();
    const serializedRecords = stringify.mock.calls.length; stringify.mockRestore();
    expect(serializedRecords).toBe(0);
    expect(status).toMatchObject({ backend: 'typescript', missions: [{ backend: 'rust', state: 'recovering' }], blockers: [{ reason: 'host-restart' }], totals: { missions: 1, workers: 1, blockers: 1 } });
    expect(status.missions).toHaveLength(1);
    expect(status.workers).toHaveLength(1);
    expect(connect).not.toHaveBeenCalled();
  });

  it('coalesces refreshes, fairly caps inspections and keeps read snapshots free of RPCs', async () => {
    const f = await fixture(); await f.close();
    const entries = Array.from({ length: 70 }, (_, n) => ({ invocationId: id(n + 1), supervisorId: id(1000), sessionId: `s_example${n}`, workspaceId: f.workspace.id, connectionIds: [`c_example${n}`] }));
    await writeFile(path.join(f.data, 'state', 'native-planning.json'), JSON.stringify({ schema: 'extalia.native-planning.v1', pending: entries }));
    // Startup inspection is deliberately unavailable. Reads still expose every marker.
    const connect = vi.spyOn(DaemonSidecar.prototype, 'connect').mockRejectedValue(new Error('unavailable'));
    const runtime = await createAgentHost(f.options); cleanups.push(() => runtime.close());
    const held = deferred<void>(), seen: string[] = [];
    const request = vi.fn(async (_op: string, value: { invocationId: string }) => { seen.push(value.invocationId); await held.promise; return { admission: { ...entries.find(entry => entry.invocationId === value.invocationId)!, kind: 'native-planning', admittedAt: at, admissionDigest: 'a'.repeat(64) } }; });
    connect.mockResolvedValue({ usable: true, capabilities: ['planning.inspect'], request } as never); connect.mockClear();
    const first = runtime.host.refreshNativeStatus!(), concurrent = runtime.host.refreshNativeStatus!();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(runtime.isBusy()).toBe(true);
    await runtime.host.nativeStatus!(); expect(request).toHaveBeenCalledTimes(1);
    await expect(runtime.host.setKnowledgeVaultRoot!(path.join(f.root, 'other-vault'))).rejects.toThrow(/busy|active|working|wait|running/i);
    held.resolve();
    const [a, b] = await Promise.all([first, concurrent]);
    expect(a).toEqual(b); expect(a.recheck).toMatchObject({ status: 'partial', inspected: 32, retired: 0, remaining: 70 });
    expect(connect).toHaveBeenCalledTimes(1);
    await runtime.host.refreshNativeStatus!();
    expect(new Set(seen).size).toBe(64); expect(request).toHaveBeenCalledTimes(64);
  });
});
