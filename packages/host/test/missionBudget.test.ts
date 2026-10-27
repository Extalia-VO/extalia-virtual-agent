import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostMissionRequest, HostMissionRun } from '@extalia/platform';
import { MissionRecords } from '../src/mission.js';
import type { SessionRecord } from '../src/sessions.js';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { backendEnv, backendOptions, backends, queryCore, type Backend } from './daemonBackend.js';

const roots: string[] = [];
// The host suites run once per native core backend (audit PR 8).
let backend: Backend = 'typescript';
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closes.length) await closes.pop()!();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});
type Fetch = NonNullable<Parameters<typeof createAgentHost>[0]['fetch']>;
const reply = (text: string, usage?: { prompt_tokens: number; completion_tokens: number }) =>
  Response.json({ model: 'model-a', choices: [{ message: { content: text }, finish_reason: 'stop' }], ...(usage ? { usage } : {}) });
const taskOf = (init?: RequestInit) => String(init?.body).match(/Task (\w+)/)?.[1] ?? 'unknown';

async function open(data: string, home: string, fetch: Fetch) {
  const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home, observationIntervalMs: 60_000, env: { EXTALIA_SECRET_STORE: 'memory', HOME: home, PATH: '', ...backendEnv(backend) }, fetch, ...backendOptions(backend) });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await runtime.close(); } };
  closes.push(close);
  return { runtime, close };
}
async function fixture(fetch: Fetch) {
  const root = await mkdtemp(path.join(tmpdir(), 'extalia-mission-budget-')); roots.push(root);
  const project = path.join(root, 'project'), home = path.join(root, 'home'), data = path.join(root, 'data');
  await Promise.all([mkdir(project, { recursive: true }), mkdir(home, { recursive: true })]);
  const { runtime, close } = await open(data, home, fetch);
  const connection = (await runtime.host.saveConnection({ name: 'Provider', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'model-a', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } })).connections[0]!;
  const workspace = (await runtime.host.saveWorkspace({ name: 'Project', projectLocation: project, connectionId: connection.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
  const session = await runtime.host.createSession(workspace.id);
  const task = (name: string) => ({ id: name, title: `Task ${name}`, instructions: `Task ${name}: inspect read-only.`, connectionId: connection.id, model: 'model-a', dependsOn: [] });
  return { root, data, home, runtime, close, session, task };
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

describe.each(backends())('native mission budgets and usage through the host (ADR 0015, %s core)', core => {
  beforeEach(() => { backend = core; });

  it('retains the normalized budget and honest usage, journals reported usage as metadata and survives restart', async () => {
    const env = await fixture(async (_url, init) => taskOf(init) === 'alpha' ? reply('UNTRUSTED_ALPHA_ANSWER', { prompt_tokens: 12, completion_tokens: 8 }) : reply('beta answer'));
    const request: HostMissionRequest = { title: 'Usage review', tasks: [env.task('alpha'), env.task('beta')], budget: { maxDurationMs: 60_000, maxTaskTokens: 1_000, maxConcurrency: 2 } };
    const started = await env.runtime.host.startNativeMission(env.session.id, request);
    expect(started.budget).toEqual({ maxDurationMs: 60_000, maxTaskTokens: 1_000, maxConcurrency: 2 });
    const final = await settled(env.runtime.host, env.session.id, started.id);
    expect(final.state).toBe('completed');
    expect(final.tasks[0]!.usage).toEqual({ inputTokens: 12, outputTokens: 8 });
    expect(final.tasks[1]!.usage).toEqual({ unknown: true });
    expect(final.usage).toEqual({ inputTokens: 12, outputTokens: 8, unknownTasks: 1 });
    expect(final.budgetExhausted).toBeUndefined();
    await idle(env.runtime);
    await env.close();

    // Usage is journaled as control metadata by the mission's owning store.
    let rows: { payload: string }[];
    if (core === 'rust') rows = queryCore(env.data, "SELECT payload FROM events WHERE mission_id = ? AND event_type = 'turn.completed' ORDER BY sequence", started.id);
    else {
      const db = new DatabaseSync(path.join(env.data, 'state', 'missions.sqlite'), { readOnly: true });
      try { rows = db.prepare("SELECT payload FROM mission_events WHERE run_id = ? AND event_type = 'turn.completed' ORDER BY sequence").all(started.id) as { payload: string }[]; } finally { db.close(); }
    }
    const events = rows.map(row => JSON.parse(row.payload) as { taskId: string; body: unknown });
    expect(events.find(event => event.taskId === final.tasks[0]!.taskId)!.body).toEqual({ type: 'turn.completed', usage: { inputTokens: 12, outputTokens: 8 } });
    expect(events.find(event => event.taskId === final.tasks[1]!.taskId)!.body).toEqual({ type: 'turn.completed' });
    expect(JSON.stringify(events)).not.toContain('UNTRUSTED_ALPHA_ANSWER');

    const reopened = await open(env.data, env.home, async () => { throw new Error('No replay expected.'); });
    expect(await reopened.runtime.host.nativeMissionRun(env.session.id, started.id)).toEqual(final);
  });

  it('AC-08: exhaustion blocks new scheduling, keeps finished state and persists the exhaustion reason', async () => {
    const calls: string[] = [];
    const env = await fixture(async (_url, init) => { calls.push(taskOf(init)); return reply(`answer ${taskOf(init)}`, { prompt_tokens: 40, completion_tokens: 20 }); });
    const request: HostMissionRequest = { title: 'Budget review', tasks: [env.task('alpha'), { ...env.task('beta'), dependsOn: ['alpha'] }, { ...env.task('gamma'), dependsOn: ['beta'] }], budget: { maxTokens: 100, maxConcurrency: 1 } };
    const started = await env.runtime.host.startNativeMission(env.session.id, request);
    const final = await settled(env.runtime.host, env.session.id, started.id);
    expect(calls).toEqual(['alpha', 'beta']);
    expect(final.tasks.map(task => [task.id, task.state, task.reason ?? null])).toEqual([
      ['alpha', 'completed', null], ['beta', 'completed', null], ['gamma', 'blocked', 'budget-exhausted'],
    ]);
    expect(final.tasks[1]!.answer).toBe('answer beta');
    expect(final).toMatchObject({ state: 'failed', budgetExhausted: 'tokens', usage: { inputTokens: 80, outputTokens: 40, unknownTasks: 0 } });
    await idle(env.runtime);
    // Exhaustion is a terminal budget outcome, not unresolved execution: the session is free again.
    const next = await env.runtime.host.startNativeMission(env.session.id, { title: 'Follow-up', tasks: [env.task('delta')] });
    expect((await settled(env.runtime.host, env.session.id, next.id)).state).toBe('completed');
    await idle(env.runtime);
    await env.close();
    const reopened = await open(env.data, env.home, async () => { calls.push('replay'); return reply('no'); });
    expect(await reopened.runtime.host.nativeMissionRun(env.session.id, started.id)).toEqual(final);
    expect(calls).not.toContain('replay');
  });

  it('expires the mission deadline cooperatively and records unknown usage for in-flight work', async () => {
    let aborted = false;
    const env = await fixture(async (_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true })));
    const request: HostMissionRequest = { title: 'Deadline review', tasks: [env.task('alpha'), env.task('beta')], budget: { maxDurationMs: 1_000, maxConcurrency: 1 } };
    const started = await env.runtime.host.startNativeMission(env.session.id, request);
    const final = await settled(env.runtime.host, env.session.id, started.id);
    expect(aborted).toBe(true);
    expect(final.tasks.map(task => [task.id, task.state, task.reason])).toEqual([['alpha', 'cancelled', 'mission-deadline'], ['beta', 'blocked', 'mission-deadline']]);
    expect(final.tasks[0]!.usage).toEqual({ unknown: true });
    expect(final.tasks[1]!.usage).toBeUndefined();
    expect(final).toMatchObject({ state: 'failed', budgetExhausted: 'duration', usage: { unknownTasks: 1 } });
    expect(final.usage!.inputTokens).toBeUndefined();
  });

  it('rejects contradictory or malformed budgets before reserving the session', async () => {
    const env = await fixture(async () => reply('ok', { prompt_tokens: 1, completion_tokens: 1 }));
    const base = { title: 'Budget validation', tasks: [env.task('alpha')] };
    for (const invalid of [
      { ...base, budget: { maxTokens: 100, maxTaskTokens: 200 } },
      { ...base, maxConcurrency: 2, budget: { maxConcurrency: 3 } },
      { ...base, budget: { maxCostUsd: 1 } },
      { ...base, budget: { maxDurationMs: 999 } },
      { ...base, budget: { maxTokens: -1 } },
    ]) await expect(env.runtime.host.startNativeMission(env.session.id, invalid as HostMissionRequest)).rejects.toThrow();
    expect(env.runtime.isBusy()).toBe(false);
    const ok = await env.runtime.host.startNativeMission(env.session.id, { ...base, budget: { maxTokens: 100 } });
    expect((await settled(env.runtime.host, env.session.id, ok.id)).usage).toEqual({ inputTokens: 1, outputTokens: 1, unknownTasks: 0 });
  });
});

describe('budget and usage persistence boundary', () => {
  const at = '2026-10-18T00:00:00.000Z';
  async function records() {
    const root = await mkdtemp(path.join(tmpdir(), 'extalia-budget-records-')); roots.push(root);
    const session = { id: 's_budget00001', workspaceId: 'workspace' } as SessionRecord;
    const create = async () => { const value = new MissionRecords(path.join(root, 'sessions'), path.join(root, 'state', 'missions.sqlite')); await value.initialize([session]); return value; };
    return { session, create };
  }
  const run = (sessionId: string): HostMissionRun => ({
    id: randomUUID(), sessionId, workspaceId: 'workspace', title: 'Interrupted', state: 'running', createdAt: at, updatedAt: at, transient: false,
    budget: { maxTokens: 500, maxConcurrency: 2 }, usage: { inputTokens: 6, outputTokens: 2, unknownTasks: 0 },
    tasks: [
      { id: 'inflight', taskId: randomUUID(), agentId: randomUUID(), title: 'In flight', connectionId: 'c', model: 'model-a', state: 'running', evidenceIds: [], usage: { inputTokens: 5, outputTokens: 1 } },
      { id: 'done', taskId: randomUUID(), agentId: randomUUID(), title: 'Done', connectionId: 'c', model: 'model-a', state: 'completed', answer: 'x', verification: 'unverified', evidenceIds: [], usage: { inputTokens: 1, outputTokens: 1 } },
      { id: 'waiting', taskId: randomUUID(), agentId: randomUUID(), title: 'Waiting', connectionId: 'c', model: 'model-a', state: 'queued', evidenceIds: [] },
    ],
  });

  it('marks in-flight usage unknown on restart without replay and keeps reported counts as a lower bound', async () => {
    const { session, create } = await records();
    const first = await create();
    const saved = run(session.id);
    await first.save(saved);
    first.close();
    const second = await create();
    const recovered = second.get(session.id, saved.id);
    second.close();
    expect(recovered.state).toBe('recovering');
    expect(recovered.tasks.map(task => task.usage)).toEqual([{ inputTokens: 5, outputTokens: 1, unknown: true }, { inputTokens: 1, outputTokens: 1 }, undefined]);
    expect(recovered.usage).toEqual({ inputTokens: 6, outputTokens: 2, unknownTasks: 1 });
    expect(recovered.budget).toEqual(saved.budget);
  });

  it('refuses to commit budget or usage data that the strict startup decoder would reject', async () => {
    const { session, create } = await records();
    const store = await create();
    const valid = run(session.id);
    await store.save({ ...valid, state: 'completed', tasks: valid.tasks.map(task => ({ ...task, state: 'completed' as const })) });
    const before = store.list(session.id);
    for (const invalid of [
      { ...valid, usage: { unknownTasks: -1 } },
      { ...valid, usage: { inputTokens: 1.5, unknownTasks: 0 } },
      { ...valid, usage: { unknownTasks: 0, costUsd: 3 } },
      { ...valid, budget: { maxTokens: 10, maxTaskTokens: 20, maxConcurrency: 1 } },
      { ...valid, budget: { maxTokens: 10 } },
      { ...valid, budgetExhausted: 'cost' },
      { ...valid, tasks: valid.tasks.map(task => ({ ...task, usage: { unknown: false } })) },
    ]) await expect(store.save(invalid as HostMissionRun)).rejects.toThrow();
    expect(store.list(session.id)).toEqual(before);
    store.close();
  });
});
