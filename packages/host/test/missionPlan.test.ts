import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { missionPlanToRequest, normalizeHostMissionRequest, type HostMissionRun, type MissionPlan } from '@extalia/platform';
import * as credentials from '../src/secrets.js';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const PLANNER_MARK = 'accountable lead agent';
const chat = (model: string, text: string) => Response.json({ model, choices: [{ message: { content: text }, finish_reason: 'stop' }] });
const anthropic = (model: string, text = 'Unverified answer') => new Response([
  { type: 'message_start', message: { id: 'message-1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });

interface Call { signal?: AbortSignal; url: string; method: string; headers: Headers; text: string; body: { model?: string; tools?: unknown[] } }
type Fetch = NonNullable<Parameters<typeof createAgentHost>[0]['fetch']>;

/** A temporary home whose fetch answers the lead's planning call with `planReply` and every worker call with a short answer. */
async function setup(planReply: (call: Call) => Response | Promise<Response>, catalogReply?: (call: Call) => Response | Promise<Response>) {
  const root = await mkdtemp(path.join(tmpdir(), 'extalia-mission-plan-'));
  const project = path.join(root, 'project'), home = path.join(root, 'home'), data = path.join(root, 'data');
  await mkdir(project, { recursive: true }); await mkdir(home, { recursive: true });
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    const text = typeof init?.body === 'string' ? init.body : '';
    const call: Call = { ...(init?.signal ? { signal: init.signal } : {}), url: String(url), method: init?.method ?? 'GET', headers: new Headers(init?.headers), text, body: text ? JSON.parse(text) as Call['body'] : {} };
    calls.push(call);
    if (call.url.endsWith('/models') && catalogReply) return catalogReply(call);
    if (call.url.endsWith('/models')) return Response.json({ data: [{ id: 'model-a' }, { id: 'model-a-mini' }] });
    if (text.includes(PLANNER_MARK)) return planReply(call);
    return call.body.model === 'model-b' ? anthropic(call.body.model) : chat(call.body.model ?? 'model-a', 'Unverified answer');
  };
  const runtime = await createAgentHost({ kind: 'bridge', version: '0.0.0-test', dataDirectory: data, homeDirectory: home, importHome: home, observationIntervalMs: 60_000, env: { EXTALIA_SECRET_STORE: 'memory', HOME: home, PATH: '', PLAN_KEY_A: 'opaque-plan-secret-a', PLAN_KEY_B: 'opaque-plan-secret-b' }, fetch });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await runtime.close(); } };
  cleanups.push(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  const host = runtime.host;
  const first = await host.saveConnection({ name: 'Provider A', preset: 'custom', api: 'openai-chat', baseUrl: 'https://a.example.com/v1', model: 'model-a', credential: { kind: 'env', variable: 'PLAN_KEY_A' }, features: { memory: 'off', skills: 'off' } });
  const a = first.connections.find(item => item.name === 'Provider A')!;
  const second = await host.saveConnection({ name: 'Provider B', preset: 'custom', api: 'anthropic-messages', baseUrl: 'https://b.example.com', model: 'model-b', credential: { kind: 'env', variable: 'PLAN_KEY_B' }, features: { memory: 'off', skills: 'off' } });
  const b = second.connections.find(item => item.name === 'Provider B')!;
  const state = await host.saveWorkspace({ name: 'Project', projectLocation: project, connectionId: a.id, permissions: { fileWrite: 'ask', commands: 'ask' } });
  const workspace = state.workspaces[0]!;
  await host.setWorkspaceMissionConnections(workspace.id, [b.id]);
  const session = await host.createSession(workspace.id);
  return { root, data, runtime, host, calls, a, b, workspace, session, close };
}
type Env = Awaited<ReturnType<typeof setup>>;


const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const requestFor = (env: Env) => ({ title: 'Review', tasks: [{ id: 'read', title: 'Read', instructions: 'Inspect read-only.', connectionId: env.a.id, model: 'model-a', dependsOn: [] }] });

const task = (id: string, worker: number, dependsOn: string[] = [], extra: Record<string, unknown> = {}) => ({ id, title: `Task ${id}`, role: 'Reviewer', instructions: `Inspect ${id} read-only.`, worker, dependsOn, ...extra });
const planJson = (tasks: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ title: 'Login review', tasks, ...extra });

/** Settled planning leaves no mission records, events, busy reservation or sidecar. */
async function expectNothingExecuted(env: Env, eventsBefore: number) {
  expect(await env.host.listNativeMissions(env.session.id)).toEqual([]);
  expect((await env.host.sessionEvents(env.session.id)).length).toBe(eventsBefore);
  expect(env.runtime.isBusy()).toBe(false);
  const files = await readdir(path.join(env.data, 'sessions')).catch(() => [] as string[]);
  expect(files.some(file => file.endsWith('.missions.json'))).toBe(false);
}
function expectLaunchable(plan: MissionPlan, env: Env) {
  const pairs = new Set([`${env.a.id}|model-a`, `${env.b.id}|model-b`]);
  expect(() => normalizeHostMissionRequest(missionPlanToRequest(plan))).not.toThrow();
  expect(plan.tasks.every(item => pairs.has(`${item.connectionId}|${item.model}`))).toBe(true);
}
async function settled(host: AgentHostRuntime['host'], sessionId: string, missionId: string): Promise<HostMissionRun> {
  for (let n = 0; n < 400; n++) {
    const run = await host.nativeMissionRun(sessionId, missionId);
    if (run.state !== 'running') return run;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Mission did not settle.');
}

describe('planNativeMission (accountable lead planning)', () => {
  it('asks the session lead once with its own credential and no tools, returns a launchable two-provider plan and starts nothing', async () => {
    const env = await setup(call => chat(call.body.model!, planJson([task('survey', 1), task('backend', 1, ['survey']), task('frontend', 2, ['survey']), task('synthesis', 1, ['backend', 'frontend'])])));
    const before = (await env.host.sessionEvents(env.session.id)).length;
    const plan = await env.host.planNativeMission(env.session.id, { goal: 'Review the login flow.', maxTasks: 4 });
    expect(plan).toMatchObject({ source: 'model', title: 'Login review', leadModel: 'model-a', maxConcurrency: 2 });
    expect(plan.tasks.map(item => [item.id, item.connectionId, item.model])).toEqual([
      ['survey', env.a.id, 'model-a'], ['backend', env.a.id, 'model-a'], ['frontend', env.b.id, 'model-b'], ['synthesis', env.a.id, 'model-a'],
    ]);
    expectLaunchable(plan, env);
    const planning = env.calls.filter(call => call.text.includes(PLANNER_MARK));
    expect(planning).toHaveLength(1);
    expect(planning[0]!.url).toContain('a.example.com');
    expect(planning[0]!.headers.get('authorization')).toBe('Bearer opaque-plan-secret-a');
    expect(planning[0]!.body.tools ?? []).toEqual([]);
    // The lead sees workers by number with model and display name, never endpoints or credentials.
    expect(planning[0]!.text).not.toMatch(/example\.com|opaque-plan-secret/);
    expect(env.calls.some(call => call.url.includes('b.example.com'))).toBe(false);
    await expectNothingExecuted(env, before);

    // The reviewed plan launches through the existing read-only mission API.
    const started = await env.host.startNativeMission(env.session.id, missionPlanToRequest(plan));
    const run = await settled(env.host, env.session.id, started.id);
    expect(run.state).toBe('completed');
    expect(run.tasks.every(item => item.verification === 'unverified' && item.evidenceIds.length === 0)).toBe(true);
    expect(new Set(run.tasks.map(item => item.connectionId)).size).toBe(2);
  });

  it('falls back to a deterministic two-provider plan for adversarial or unusable lead replies, without executing anything', async () => {
    const replies = [
      planJson([task('a', 1, ['b']), task('b', 2, ['a'])]), // cycle
      planJson([task('a', 7)]), // unknown worker
      planJson([task('a', 1, [], { connectionId: 'c_injected', model: 'evil-model' })]), // unknown connection
      planJson([task('a', 1, [], { baseUrl: 'https://evil.example.com/v1', apiKey: 'x' })]), // injected endpoint/credential
      planJson([task('a', 1, [], { instructions: 'x'.repeat(5_000) })]), // oversized
      planJson(Array.from({ length: 17 }, (_, index) => task(`t${index}`, 1))), // too many tasks
      `Sure! ${planJson([task('a', 1)])}`, // prose
    ];
    let next = 0;
    const env = await setup(call => chat(call.body.model!, replies[next++]!));
    const before = (await env.host.sessionEvents(env.session.id)).length;
    for (const _reply of replies) {
      const plan = await env.host.planNativeMission(env.session.id, { goal: 'Review the login flow.', maxTasks: 5 });
      expect(plan.source).toBe('heuristic');
      expect(plan.note).toMatch(/not a usable plan/);
      expect(plan.leadModel).toBe('model-a');
      expect(plan.tasks.map(item => item.id)).toEqual(['survey', 'review-architecture', 'review-risks', 'review-tests', 'synthesis']);
      expect(new Set(plan.tasks.map(item => item.connectionId)).size).toBe(2);
      expectLaunchable(plan, env);
    }
    expect(next).toBe(replies.length);
    await expectNothingExecuted(env, before);
  });

  it('ignores tool calls in the lead reply and falls back when the lead cannot be asked', async () => {
    const toolCall = (model: string) => Response.json({ model, choices: [{ message: { content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'run_command', arguments: '{"command":"rm -rf /"}' } }] }, finish_reason: 'tool_calls' }] });
    let mode: 'tool' | 'error' = 'tool';
    const env = await setup(call => mode === 'tool' ? toolCall(call.body.model!) : new Response('upstream failed', { status: 500 }));
    const before = (await env.host.sessionEvents(env.session.id)).length;
    const fromTool = await env.host.planNativeMission(env.session.id, { goal: 'Review.' });
    expect(fromTool.source).toBe('heuristic');
    expect(fromTool.tasks).toHaveLength(6);
    mode = 'error';
    const failed = await env.host.planNativeMission(env.session.id, { goal: 'Review.', maxTasks: 3 });
    expect(failed).toMatchObject({ source: 'heuristic' });
    expect(failed.note).toMatch(/could not be asked/);
    await expectNothingExecuted(env, before);
  });

  it('redacts secrets from the goal sent to the lead and from echoed plan text', async () => {
    const env = await setup(call => chat(call.body.model!, planJson([task('a', 1, [], { title: 'Check opaque-plan-secret-a', instructions: 'Goal echo: token=abcdefgh123456 and opaque-plan-secret-a' })]))); // extalia-allow-secret
    const plan = await env.host.planNativeMission(env.session.id, { goal: 'Audit where token=abcdefgh123456 is used.', maxTasks: 1 }); // extalia-allow-secret
    const sent = env.calls.find(call => call.text.includes(PLANNER_MARK))!;
    expect(sent.text).not.toContain('abcdefgh123456');
    expect(JSON.stringify(plan)).not.toMatch(/abcdefgh123456|opaque-plan-secret-a/);
    expect(plan.source).toBe('model');
  });

  it('uses only workspace-allowed connections, narrows by models, honours history policy and team hints', async () => {
    const env = await setup(call => chat(call.body.model!, '{}'));
    await expect(env.host.planNativeMission(env.session.id, { goal: 'x', connectionIds: ['c_not_allowed'] })).rejects.toThrow(/not allowed/);
    await expect(env.host.planNativeMission('s_missing000', { goal: 'x' })).rejects.toThrow(/no longer exists/);
    await expect(env.host.planNativeMission(env.session.id, { goal: '' })).rejects.toThrow(/goal/);
    await expect(env.host.planNativeMission(env.session.id, { goal: 'x', models: ['unknown-model'] })).rejects.toThrow(/No allowed connection/);

    const onlyA = await env.host.planNativeMission(env.session.id, { goal: 'Review.', connectionIds: [env.a.id], maxTasks: 3 });
    expect(onlyA.tasks.every(item => item.connectionId === env.a.id)).toBe(true);
    const onlyB = await env.host.planNativeMission(env.session.id, { goal: 'Review.', models: ['model-b'], maxTasks: 3 });
    expect(onlyB.tasks.every(item => item.connectionId === env.b.id && item.model === 'model-b')).toBe(true);

    // A team's roles and models (on the lead's connection) become hints and eligible pairs.
    await env.host.saveSessionTeam(env.session.id, { enabled: true, allowedModels: ['model-a', 'model-a-mini'], members: [{ id: 'm1', name: 'Ada Vale', role: 'Security', task: 'Audit tokens', models: ['model-a-mini'] }] });
    const hinted = await env.host.planNativeMission(env.session.id, { goal: 'Review.', maxTasks: 3 });
    expect(hinted.tasks[1]).toMatchObject({ id: 'review-security', role: 'Security' });
    const prompt = env.calls.filter(call => call.text.includes(PLANNER_MARK)).at(-1)!.text;
    expect(prompt).toContain('Security');
    expect(prompt).toContain('model-a-mini');

    // History-off connections cannot serve saved sessions and are left out with a note.
    await env.host.saveConnection({ id: env.b.id, name: 'Provider B', preset: 'custom', api: 'anthropic-messages', baseUrl: 'https://b.example.com', model: 'model-b', credential: { kind: 'env', variable: 'PLAN_KEY_B' }, features: { memory: 'off', skills: 'off', history: false } });
    const noB = await env.host.planNativeMission(env.session.id, { goal: 'Review.', maxTasks: 3 });
    expect(noB.tasks.every(item => item.connectionId === env.a.id)).toBe(true);
    expect(noB.note).toMatch(/keeps no history/);
  });
});


describe('native mission planner resource admission', () => {
  it('reserves synchronously and excludes concurrent plans, prompts and missions sharing its session or lead', async () => {
    const gate = deferred<Response>(), entered = deferred();
    const env = await setup(() => { entered.resolve(); return gate.promise; });
    const before = (await env.host.sessionEvents(env.session.id)).length;
    const pending = env.host.planNativeMission(env.session.id, { goal: 'Review.' });
    expect(env.runtime.isBusy()).toBe(true);
    await expect(env.host.planNativeMission(env.session.id, { goal: 'Overlap.' })).rejects.toThrow(/still working/);
    await entered.promise;
    await expect(env.host.sendPrompt(env.session.id, 'Overlap.')).rejects.toThrow(/active|working/);
    await expect(env.host.startNativeMission(env.session.id, requestFor(env))).rejects.toThrow(/still working/);
    const other = await env.host.createSession(env.workspace.id);
    const fallback = await env.host.planNativeMission(other.id, { goal: 'Other session.' });
    expect(fallback.source).toBe('heuristic');
    expect(fallback.note).toMatch(/busy/);
    await expect(env.host.sendPrompt(other.id, 'Overlap.')).rejects.toThrow(/active|working/);
    await expect(env.host.startNativeMission(other.id, requestFor(env))).rejects.toThrow(/active|working/);
    await expect(env.host.setWorkspaceMissionConnections(env.workspace.id, [])).rejects.toThrow(/Stop or reconcile/);
    await expect(env.host.deleteWorkspace(env.workspace.id)).rejects.toThrow(/running/);
    expect(env.calls.filter(call => call.text.includes(PLANNER_MARK))).toHaveLength(1);
    gate.resolve(chat('model-a', planJson([task('review', 1)])));
    expect((await pending).source).toBe('model');
    await expectNothingExecuted(env, before);
  });

  it('owns the lead during uncached catalog discovery and never infers after preparation cancellation', async () => {
    const gate = deferred<Response>(), entered = deferred();
    const env = await setup(call => chat(call.body.model!, planJson([task('review', 1)])), () => { entered.resolve(); return gate.promise; });
    const before = (await env.host.sessionEvents(env.session.id)).length;
    const pending = env.host.planNativeMission(env.session.id, { goal: 'Review.', connectionIds: [env.a.id], models: ['model-a-mini'] })
      .then(plan => ({ plan }), error => ({ error: error as Error }));
    await entered.promise;
    const other = await env.host.createSession(env.workspace.id);
    const fallback = await env.host.planNativeMission(other.id, { goal: 'Overlap.', connectionIds: [env.a.id], models: ['model-a'] });
    expect(fallback.source).toBe('heuristic'); expect(fallback.note).toMatch(/busy/);
    await expect(env.host.sendPrompt(other.id, 'Overlap.')).rejects.toThrow(/active|working/);
    await expect(env.host.startNativeMission(other.id, requestFor(env))).rejects.toThrow(/active|working/);
    expect(env.calls.filter(call => call.url.endsWith('/models'))).toHaveLength(1);
    await env.host.cancel(env.session.id);
    expect(env.runtime.isBusy()).toBe(true); // Existing catalog request still owns its physical capacity.
    gate.resolve(Response.json({ data: [{ id: 'model-a-mini' }] }));
    expect(await pending).toMatchObject({ error: { name: 'UserError', message: expect.stringContaining('cancelled before preparation') } });
    expect(env.calls.filter(call => call.text.includes(PLANNER_MARK))).toHaveLength(0);
    await expectNothingExecuted(env, before);
  });

  it('cooperative cancel releases capacity and records no conversation intervention for planning', async () => {
    const entered = deferred();
    let cooperative = true;
    const env = await setup(call => {
      if (!cooperative) return chat(call.body.model!, planJson([task('review', 1)]));
      entered.resolve();
      return new Promise((_resolve, reject) => call.signal!.addEventListener('abort', () => reject(new Error('Cancelled provider request.')), { once: true }));
    });
    const before = (await env.host.sessionEvents(env.session.id)).length;
    const pending = env.host.planNativeMission(env.session.id, { goal: 'Review.' });
    await entered.promise;
    const idle = deferred(); env.runtime.onIdle(() => idle.resolve());
    await env.host.cancel(env.session.id);
    const fallback = await pending;
    expect(fallback).toMatchObject({ source: 'heuristic' });
    expect(fallback.note).toMatch(/cancelled/);
    await idle.promise;
    await expectNothingExecuted(env, before);
    cooperative = false;
    expect((await env.host.planNativeMission(env.session.id, { goal: 'Try again.' })).source).toBe('model');
  });

  it('bounds cooperative inference timeout and releases only after actual rejection', async () => {
    const entered = deferred();
    const env = await setup(call => {
      entered.resolve();
      return new Promise((_resolve, reject) => call.signal!.addEventListener('abort', () => reject(new Error('Timed out provider request.')), { once: true }));
    });
    const before = (await env.host.sessionEvents(env.session.id)).length;
    vi.useFakeTimers();
    try {
      const pending = env.host.planNativeMission(env.session.id, { goal: 'Review.' });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(45_000);
      const fallback = await pending;
      expect(fallback.source).toBe('heuristic');
      expect(fallback.note).toMatch(/did not answer in time/);
      await expectNothingExecuted(env, before);
    } finally { vi.useRealTimers(); }
  });

  it.each(['cancel', 'timeout'] as const)('retains busy capacity after ignored %s and suppresses late model plans', async cause => {
    const gate = deferred<Response>(), entered = deferred();
    const env = await setup(() => { entered.resolve(); return gate.promise; });
    const before = (await env.host.sessionEvents(env.session.id)).length;
    vi.useFakeTimers();
    try {
      const pending = env.host.planNativeMission(env.session.id, { goal: 'Review.' });
      await entered.promise;
      if (cause === 'cancel') await env.host.cancel(env.session.id);
      else await vi.advanceTimersByTimeAsync(45_000);
      const fallback = await pending;
      expect(fallback.source).toBe('heuristic');
      expect(env.runtime.isBusy()).toBe(true);
      await expect(env.host.planNativeMission(env.session.id, { goal: 'Overlap.' })).rejects.toThrow(/still working/);
      const other = await env.host.createSession(env.workspace.id);
      await expect(env.host.sendPrompt(other.id, 'Overlap.')).rejects.toThrow(/active|working/);
      await expect(env.host.startNativeMission(other.id, requestFor(env))).rejects.toThrow(/active|working/);
      expect(env.calls.filter(call => call.text.includes(PLANNER_MARK))).toHaveLength(1);
      const frozen = JSON.stringify(fallback), idle = deferred(); env.runtime.onIdle(() => idle.resolve());
      gate.resolve(chat('model-a', planJson([task('late', 1)], { title: 'Late proposal' })));
      await idle.promise;
      expect(JSON.stringify(fallback)).toBe(frozen);
      await expectNothingExecuted(env, before);
    } finally { vi.useRealTimers(); }
  });

  it('cancelled credential preparation never enters inference when the secret resolves late', async () => {
    const env = await setup(call => chat(call.body.model!, planJson([task('review', 1)])));
    const before = (await env.host.sessionEvents(env.session.id)).length;
    const entered = deferred(), secret = deferred<string | undefined>();
    const resolveCredential = credentials.resolveCredential;
    const spy = vi.spyOn(credentials, 'resolveCredential').mockImplementation((source, store, variables) => {
      if (source.kind === 'env' && source.variable === 'PLAN_KEY_A') { entered.resolve(); return secret.promise; }
      return resolveCredential(source, store, variables);
    });
    try {
      const pending = env.host.planNativeMission(env.session.id, { goal: 'Review.' });
      await entered.promise;
      const idle = deferred(); env.runtime.onIdle(() => idle.resolve());
      await env.host.cancel(env.session.id);
      expect((await pending).source).toBe('heuristic');
      expect(env.runtime.isBusy()).toBe(true);
      secret.resolve('opaque-plan-secret-a');
      await idle.promise;
      expect(env.calls.filter(call => call.text.includes(PLANNER_MARK))).toHaveLength(0);
      await expectNothingExecuted(env, before);
    } finally { spy.mockRestore(); }
  });

  it('close aborts planning while ignored requests remain reserved until physical settlement', async () => {
    const gate = deferred<Response>(), entered = deferred();
    const env = await setup(() => { entered.resolve(); return gate.promise; });
    const before = (await env.host.sessionEvents(env.session.id)).length;
    vi.useFakeTimers();
    try {
      const pending = env.host.planNativeMission(env.session.id, { goal: 'Review.' });
      await entered.promise;
      let closed = false;
      const closing = env.close().then(() => { closed = true; });
      // Ingest/observer shutdown completes before close aborts the run.
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).source).toBe('heuristic');
      expect(env.runtime.isBusy()).toBe(true);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000); await closing;
      const idle = vi.fn(); env.runtime.onIdle(idle);
      gate.resolve(chat('model-a', planJson([task('late', 1)])));
      await vi.waitFor(() => expect(env.runtime.isBusy()).toBe(false));
      expect(idle).not.toHaveBeenCalled();
      expect((await env.host.sessionEvents(env.session.id)).length).toBe(before);
      await expect(env.host.planNativeMission(env.session.id, { goal: 'After close.' })).rejects.toThrow(/shutting down/);
    } finally { vi.useRealTimers(); }
  });
});
