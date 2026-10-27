import { describe, expect, it, vi } from 'vitest';
import { parseOrchestration, type OrchestrationPlan } from '@extalia/protocol';
import * as turnLoop from '../src/loop.js';
import { createProvider, runNativeMission, type AnyTool, type FetchLike, type NativeMissionOptions } from '../src/index.js';
import { expectAuditedTransitions } from './transitionAudit.js';

// Every emitted state change must be listed in the shared protocol transition tables.
vi.mock('../src/index.js', async importOriginal => (await import('./transitionAudit.js')).auditTransitions(await importOriginal()));
expectAuditedTransitions();

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const version = { schemaVersion: 1 as const }, at = '2026-01-01T00:00:00.000Z';
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const jsonAnswer = (model: string, text = 'Unverified response') => Response.json({ model, choices: [{ message: { content: text }, finish_reason: 'stop' }] });
const anthropicAnswer = (model: string) => new Response([
  { type: 'message_start', message: { id: 'message-1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Unverified response' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const provider = (api: 'openai-chat' | 'anthropic-messages', model: string, fetch: FetchLike) => createProvider({ preset: 'custom', api, baseUrl: 'https://example.com/v1', model, features: { memory: 'extalia', skills: 'extalia' } }, 'synthetic-key', fetch);
function fixture(count = 3, fetch: FetchLike = async (_url, init) => {
  const model = (JSON.parse(String(init?.body)) as { model: string }).model;
  return model === 'model-b' ? anthropicAnswer(model) : jsonAnswer(model);
}): NativeMissionOptions {
  const capabilities = { ...version, observe: true, readMessages: true, readTools: true, pause: false, resume: false, control: true, delegate: false };
  const plan: OrchestrationPlan = {
    ...version,
    mission: { ...version, id: id(2), workspaceId: id(1), leadAgentId: id(3), budgetId: id(4), state: 'queued', createdAt: at, updatedAt: at, version: 1 },
    budget: { ...version, id: id(4), workspaceId: id(1), maxTokens: 1000, spentTokens: 0, maxCostUsd: 1, spentCostUsd: 0, maxDurationMs: 1000, maxActiveAgents: 3, maxDelegationDepth: 1 },
    registry: { ...version, workspaceId: id(1), agents: [
      { ...version, id: id(3), origin: 'native', role: 'lead', workspaceId: id(1), engineId: 'extalia-native', capabilities: { ...capabilities, delegate: true } },
      ...Array.from({ length: count }, (_, n) => ({ ...version, id: id(30 + n), origin: 'native' as const, role: 'worker', workspaceId: id(1), supervisorId: id(3), engineId: 'extalia-native', modelProfileId: id(n === 1 ? 7 : 6), capabilities })),
    ] },
    providers: [{ ...version, id: id(8), adapterId: 'openai-chat', maxConcurrency: 2 }, { ...version, id: id(9), adapterId: 'anthropic-messages', maxConcurrency: 1 }],
    models: [
      { ...version, id: id(6), providerId: id(8), model: 'model-a', toolCalling: true, streaming: true, vision: false, contextTokens: 32000 },
      { ...version, id: id(7), providerId: id(9), model: 'model-b', toolCalling: true, streaming: true, vision: false, contextTokens: 32000 },
    ],
    graph: { ...version, missionId: id(2), tasks: Array.from({ length: count }, (_, n) => ({ ...version, id: id(20 + n), missionId: id(2), assignedAgentId: id(30 + n), state: 'queued', attempt: 0, dependsOn: [], requirements: ['Read only'], evidenceIds: [] })) },
  };
  return {
    plan, sessionId: id(5), tasks: plan.graph.tasks.map(task => ({ taskId: task.id, instructions: `Inspect ${task.id}`, timeoutMs: 1000 })),
    bindings: [{ modelProfileId: id(6), providerId: id(8), model: 'model-a', provider: provider('openai-chat', 'model-a', fetch) }, { modelProfileId: id(7), providerId: id(9), model: 'model-b', provider: provider('anthropic-messages', 'model-b', fetch) }],
  };
}

describe('bounded native mission supervisor', () => {
  it('runs three independent tasks concurrently across real OpenAI and Anthropic adapter implementations', async () => {
    const release = deferred(), admitted = deferred();
    const calls: { model: string; url: string }[] = [];
    const options = fixture(3, async (url, init) => {
      const model = (JSON.parse(String(init?.body)) as { model: string }).model;
      calls.push({ model, url });
      if (calls.length === 3) admitted.resolve();
      await release.promise;
      return model === 'model-b' ? anthropicAnswer(model) : jsonAnswer(model);
    });
    const pending = runNativeMission(options);
    await admitted.promise; // All three must enter fetch before any response is released.
    expect(calls.map(call => call.model).sort()).toEqual(['model-a', 'model-a', 'model-b']);
    expect(calls.some(call => call.url.endsWith('/messages'))).toBe(true);
    expect(calls.some(call => call.url.endsWith('/chat/completions'))).toBe(true);
    release.resolve();
    const result = await pending;
    expect(result.state).toBe('completed');
    expect(result.tasks).toHaveLength(3);
    for (const [index, task] of result.tasks.entries()) expect(task).toMatchObject({ state: 'completed', verification: 'unverified', evidenceIds: [], answer: 'Unverified response', modelProfileId: id(index === 1 ? 7 : 6), providerId: id(index === 1 ? 9 : 8) });
    expect(result.events.every(event => parseOrchestration('agentEvent', event).ok)).toBe(true);
    expect(result.events.map(event => event.sequence)).toEqual(result.events.map((_, n) => n));
    expect(result.events.every(event => event.workspaceId === id(1) && event.sessionId === id(5) && event.missionId === id(2))).toBe(true);
    expect(result.events.filter(event => event.body.type === 'task.state' && event.body.state === 'running').every(event => event.agentId === id(30 + Number(event.taskId!.slice(-2)) - 20))).toBe(true);
    expect(result.events.some(event => event.body.type === 'model.delta' || event.body.type === 'model.completed')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('synthetic-key');
  });

  it('isolates provider failure, blocks dependents and never publishes raw endpoint errors', async () => {
    const options = fixture(3, async (_url, init) => {
      const model = (JSON.parse(String(init?.body)) as { model: string }).model;
      return model === 'model-a' ? Response.json({ error: { message: 'synthetic-private-provider-secret' } }, { status: 401 }) : anthropicAnswer(model);
    });
    options.plan.graph.tasks[2]!.dependsOn = [id(20)];
    const result = await runNativeMission(options);
    expect(result.state).toBe('failed');
    expect(result.tasks.map(task => task.state)).toEqual(['failed', 'completed', 'blocked']);
    expect(result.tasks[2]?.reason).toBe('dependency-failed');
    expect(result.events.filter(event => event.taskId === id(22)).some(event => event.body.type === 'task.state' && event.body.state === 'running')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('synthetic-private-provider-secret');
  });

  it('starts a dependent only after successful completion and snapshots routing/dependencies', async () => {
    const dependencyPrompts: string[] = [];
    const options = fixture(2, async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string; messages: { role: string; content: unknown }[] };
      if (body.model === 'model-b') dependencyPrompts.push(String(body.messages[0]?.content));
      return body.model === 'model-b' ? anthropicAnswer(body.model) : jsonAnswer(body.model, `Unverified response ${'x'.repeat(5000)}`);
    });
    options.plan.graph.tasks[1]!.dependsOn = [id(20)];
    const order: string[] = [];
    options.onEvent = event => {
      if (event.body.type === 'task.state') order.push(`${event.taskId}:${event.body.state}`);
      if (event.body.type === 'mission.state' && event.body.state === 'running') {
        options.plan.graph.tasks[1]!.dependsOn = [id(99)];
        options.plan.models[0]!.model = 'mutated';
        options.tasks[0]!.instructions = 'mutated';
      }
    };
    const result = await runNativeMission(options);
    expect(result.state).toBe('completed');
    expect(order.indexOf(`${id(20)}:completed`)).toBeLessThan(order.indexOf(`${id(21)}:running`));
    expect(result.tasks.map(task => task.model)).toEqual(['model-a', 'model-b']);
    expect(dependencyPrompts[0]).toContain('UNVERIFIED');
    expect(dependencyPrompts[0]).toContain('Unverified response');
    expect(dependencyPrompts[0]).toContain(id(20));
    expect(dependencyPrompts[0]).toContain('"truncated":true');
    expect(dependencyPrompts[0]).not.toContain('x'.repeat(3000));
  });

  it.each(['global', 'provider', 'agent'] as const)('enforces %s concurrency', async limit => {
    const gate = deferred(), firstEntered = deferred();
    let active = 0, peak = 0, count = 0;
    const options = fixture(3, async (_url, init) => {
      const model = (JSON.parse(String(init?.body)) as { model: string }).model;
      active++; peak = Math.max(peak, active); count++; firstEntered.resolve();
      if (count === 1) await gate.promise;
      active--;
      return jsonAnswer(model);
    });
    for (const worker of options.plan.registry.agents.slice(1)) worker.modelProfileId = id(6);
    if (limit === 'global') options.maxConcurrency = 1;
    if (limit === 'provider') options.plan.providers[0]!.maxConcurrency = 1;
    if (limit === 'agent') for (const task of options.plan.graph.tasks) task.assignedAgentId = id(30);
    const run = runNativeMission(options);
    await firstEntered.promise;
    await Promise.resolve();
    expect(count).toBe(1);
    gate.resolve();
    const result = await run;
    expect(result.state).toBe('completed');
    expect(peak).toBe(1);
  });

  it('does not invoke providers when cancelled before scheduled task microtasks start', async () => {
    const fetch = vi.fn<FetchLike>(), controller = new AbortController();
    const options = fixture(2, fetch); options.signal = controller.signal;
    const pending = runNativeMission(options);
    controller.abort();
    const result = await pending;
    expect(result.state).toBe('cancelled');
    expect(result.tasks.every(task => task.state === 'cancelled')).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(result.events.some(event => event.body.type === 'task.state' && event.body.state === 'running')).toBe(false);
  });

  it('acknowledges cooperative cancellation without starting queued tasks', async () => {
    const entered = deferred(), controller = new AbortController();
    const fetch: FetchLike = async (_url, init) => {
      entered.resolve();
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('private abort details')), { once: true }));
    };
    const options = fixture(2, fetch);
    options.maxConcurrency = 1; options.signal = controller.signal;
    const pending = runNativeMission(options);
    await entered.promise; controller.abort();
    const result = await pending;
    expect(result.state).toBe('cancelled');
    expect(result.tasks.map(task => task.state)).toEqual(['cancelled', 'cancelled']);
    expect(result.requiresReconciliation).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private abort details');
  });

  it.each(['timeout', 'cancel'] as const)('quarantines ignored %s calls, returns unknown and drops late emissions', async cause => {
    vi.useFakeTimers();
    try {
      const gate = deferred<Response>(), entered = deferred(), providerSettled = deferred(), controller = new AbortController();
      let calls = 0;
      const options = fixture(2, async () => { calls++; entered.resolve(); return gate.promise; });
      const originalProvider = options.bindings[0]!.provider;
      options.bindings[0]!.provider = { ...originalProvider, complete: async request => {
        try { return await originalProvider.complete(request); } finally { providerSettled.resolve(); }
      } };
      for (const worker of options.plan.registry.agents.slice(1)) worker.modelProfileId = id(6);
      options.plan.providers[0]!.maxConcurrency = 1;
      options.tasks[0]!.timeoutMs = 10; options.abortGraceMs = 5; options.signal = controller.signal;
      const pending = runNativeMission(options);
      await entered.promise;
      if (cause === 'cancel') controller.abort();
      await vi.advanceTimersByTimeAsync(20);
      const result = await pending;
      expect(result.state).toBe('recovering');
      expect(result.tasks[0]).toMatchObject({ state: 'unknown', reason: 'execution-unknown' });
      expect(result.tasks[1]).toMatchObject(cause === 'cancel' ? { state: 'cancelled' } : { state: 'blocked', reason: 'capacity-unknown' });
      expect(result.requiresReconciliation).toBe(true);
      expect(calls).toBe(1);
      const snapshot = JSON.stringify(result);
      gate.resolve(jsonAnswer('model-a', 'late answer'));
      await providerSettled.promise;
      await vi.runAllTimersAsync();
      expect(JSON.stringify(result)).toBe(snapshot);
    } finally { vi.useRealTimers(); }
  });

  it('times out cooperative providers and blocks dependent work', async () => {
    const options = fixture(2, async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
    options.tasks[0]!.timeoutMs = 5;
    options.plan.graph.tasks[1]!.dependsOn = [id(20)];
    const result = await runNativeMission(options);
    expect(result.tasks.map(task => task.state)).toEqual(['failed', 'blocked']);
    expect(result.tasks[0]?.reason).toBe('timeout');
  });

  it('rejects invalid graphs, resumes, bindings, hierarchy, capabilities and unsafe tools before inference', async () => {
    const fetch = vi.fn<FetchLike>();
    const mutations: ((options: NativeMissionOptions) => void)[] = [
      options => { options.plan.graph.tasks[0]!.dependsOn = [id(99)]; },
      options => { options.plan.graph.tasks[0]!.state = 'unknown'; },
      options => { options.plan.registry.agents[1]!.capabilities.control = false; },
      options => { options.plan.registry.agents[0]!.capabilities.delegate = false; },
      options => { options.plan.registry.agents[1]!.supervisorId = undefined; },
      options => { options.plan.budget.maxDelegationDepth = 0; },
      options => { options.bindings[0]!.model = 'silent-fallback'; },
      options => { options.tasks[0]!.maxSteps = 21; },
      options => { options.tasks[0]!.instructions = 'x'.repeat(16001); },
      options => { options.sessionId = 'legacy-session-without-mapping'; },
    ];
    for (const access of ['write', 'execute', 'meta', 'memory', 'read'] as const) mutations.push(options => {
      options.tasks[0]!.tools = [{ name: 'unsafe', description: 'Unsafe', parameters: { type: 'object', properties: {} }, access, kind: access === 'read' ? 'delegate' : 'read', describe: () => ({ label: 'unsafe' }), run: async () => ({ ok: true, output: 'no' }) }];
    });
    for (const mutate of mutations) {
      const options = fixture(1, fetch); mutate(options);
      await expect(runNativeMission(options)).rejects.toThrow('Invalid native mission input');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('runs declared read tools with bounded output while keeping raw tool data out of events', async () => {
    let calls = 0;
    const run = vi.fn(async () => ({ ok: true, output: 'private-file-content'.repeat(1000) }));
    const tool: AnyTool = { name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {} }, access: 'read', kind: 'read', describe: () => ({ label: 'private description' }), run };
    const options = fixture(1, async (_url, init) => {
      calls++;
      if (calls === 1) return Response.json({ model: 'model-a', choices: [{ message: { content: '', tool_calls: [{ id: 'read1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] });
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
      expect(body.messages.find(message => message.role === 'tool')?.content.length).toBeLessThanOrEqual(4000);
      return jsonAnswer('model-a');
    });
    options.tasks[0]!.tools = [tool];
    const result = await runNativeMission(options);
    expect(result.state).toBe('completed'); expect(run).toHaveBeenCalledOnce();
    expect(result.events.filter(event => event.body.type === 'tool.started' || event.body.type === 'tool.completed')).toHaveLength(2);
    expect(JSON.stringify(result.events)).not.toContain('private-file-content');
    expect(JSON.stringify(result.events)).not.toContain('private description');
  });

  it('contains unexpected task-runner failure without losing sibling results', async () => {
    const realRun = turnLoop.runTurn;
    const spy = vi.spyOn(turnLoop, 'runTurn').mockImplementationOnce(() => { throw new Error('private runner anomaly'); }).mockImplementation(realRun);
    try {
      const result = await runNativeMission(fixture(2));
      expect(result.state).toBe('failed');
      expect(result.tasks.map(task => task.state)).toEqual(['failed', 'completed']);
      expect(result.tasks[0]?.reason).toBe('turn-incomplete');
      expect(JSON.stringify(result)).not.toContain('private runner anomaly');
    } finally { spy.mockRestore(); }
  });

  it('reports observer callback failures and never treats model text as evidence', async () => {
    const options = fixture(1);
    options.onEvent = () => { throw new Error('private sink error'); };
    const result = await runNativeMission(options);
    expect(result.eventDeliveryFailed).toBe(true);
    expect(result.tasks[0]).toMatchObject({ verification: 'unverified', evidenceIds: [] });
    expect(JSON.stringify(result)).not.toContain('private sink error');
  });
});
