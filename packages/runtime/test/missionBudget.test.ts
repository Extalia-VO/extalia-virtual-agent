import { createProvider } from '../src/index.js';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, OrchestrationPlan } from '@extalia/protocol';
import { ProviderError, createFallbackProvider, guardProviderRequests, runNativeMission, type AnyTool, type NativeMissionAccounting, type NativeMissionOptions } from '../src/index.js';
import type { ModelProvider, ModelRequest, ModelResult } from '../src/model.js';

import { expectAuditedTransitions } from './transitionAudit.js';

// Every emitted state change must be listed in the shared protocol transition tables.
vi.mock('../src/index.js', async importOriginal => (await import('./transitionAudit.js')).auditTransitions(await importOriginal()));
expectAuditedTransitions();

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const version = { schemaVersion: 1 as const };
const at = '2026-10-18T00:00:00.000Z';

/** One provider; the task index comes from its instruction text. */
function fixture(count: number, reply: (request: ModelRequest, taskIndex: number) => Promise<ModelResult>): NativeMissionOptions {
  const capability = { ...version, observe: true, readMessages: true, readTools: true, pause: false, resume: false, control: true, delegate: false };
  const plan: OrchestrationPlan = {
    ...version,
    mission: { ...version, id: id(2), workspaceId: id(1), leadAgentId: id(3), budgetId: id(4), state: 'queued', createdAt: at, updatedAt: at, version: 1 },
    budget: { ...version, id: id(4), workspaceId: id(1), maxTokens: 0, spentTokens: 0, maxCostUsd: 0, spentCostUsd: 0, maxDurationMs: 0, maxActiveAgents: count, maxDelegationDepth: 1 },
    registry: { ...version, workspaceId: id(1), agents: [
      { ...version, id: id(3), origin: 'native', workspaceId: id(1), role: 'lead', engineId: 'extalia-native', capabilities: { ...capability, delegate: true } },
      ...Array.from({ length: count }, (_, index) => ({ ...version, id: id(10 + index), origin: 'native' as const, workspaceId: id(1), supervisorId: id(3), role: 'worker', engineId: 'extalia-native', modelProfileId: id(5), capabilities: capability })),
    ] },
    providers: [{ ...version, id: id(6), adapterId: 'openai-chat', maxConcurrency: count }],
    models: [{ ...version, id: id(5), providerId: id(6), model: 'model', toolCalling: true, streaming: true, vision: false }],
    graph: { ...version, missionId: id(2), tasks: Array.from({ length: count }, (_, index) => ({ ...version, id: id(20 + index), missionId: id(2), assignedAgentId: id(10 + index), state: 'queued' as const, attempt: 0, dependsOn: [], requirements: ['Read only'], evidenceIds: [] })) },
  };
  const provider: ModelProvider = {
    api: 'openai-chat', listModels: async () => ['model'],
    complete: async request => {
      const first = request.messages[0];
      const index = Number(String(first && 'text' in first ? first.text : '').match(/Inspect task-(\d+)/)?.[1] ?? 0);
      return reply(request, index);
    },
  };
  return { plan, sessionId: id(7), tasks: plan.graph.tasks.map((task, index) => ({ taskId: task.id, instructions: `Inspect task-${index}`, timeoutMs: 5_000 })), bindings: [{ modelProfileId: id(5), providerId: id(6), model: 'model', provider }] };
}
const answer = (text: string, usage?: ModelResult['usage']): ModelResult => ({ text, toolCalls: [], stop: 'end', model: 'model', ...(usage ? { usage } : {}) });
const toolReply = (usage?: ModelResult['usage']): ModelResult => ({ text: '', toolCalls: [{ id: 'call-1', name: 'read_only', input: {} }], stop: 'tool_use', model: 'model', ...(usage ? { usage } : {}) });
const readTool: AnyTool = { name: 'read_only', description: 'Read fixture', parameters: { type: 'object', properties: {} }, access: 'read', kind: 'read', describe: () => ({ label: 'read' }), run: async () => ({ ok: true, output: 'data' }) };
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function journal(options: NativeMissionOptions) {
  const committed: { event: AgentEvent; accounting?: NativeMissionAccounting }[] = [];
  let sequence = 0;
  options.commitEvent = (event, _result, accounting) => { committed.push({ event, ...(accounting ? { accounting } : {}) }); return ++sequence; };
  return committed;
}

describe('native mission budgets and usage ownership (ADR 0015)', () => {
  it.each(['prompt_tokens', 'completion_tokens'] as const)('blocks queued work when an unsafe final %s invalidates a provisional stream counter', async field => {
    let calls = 0;
    const provider = createProvider({ preset: 'custom', api: 'openai-chat', baseUrl: 'https://api.example.com/v1', model: 'model', features: { memory: 'off', skills: 'off' } }, undefined, async () => {
      calls++;
      return new Response([
        { choices: [], usage: { prompt_tokens: 1, completion_tokens: 0 } },
        { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }], usage: { [field]: Number.MAX_SAFE_INTEGER + 1 } },
      ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    });
    const options = fixture(2, request => provider.complete(request));
    options.maxConcurrency = 1;
    options.budget = { maxTokens: 100 };
    const result = await runNativeMission(options);
    expect(calls).toBe(1);
    expect(result.tasks[0]!.usage).toEqual({ ...(field === 'prompt_tokens' ? { outputTokens: 0 } : { inputTokens: 1 }), unknown: true });
    expect(result.tasks[1]).toMatchObject({ state: 'blocked', reason: 'usage-unknown' });
    expect(result.budgetExhausted).toBe('usage-unknown');
  });

  it('omits unsafe task totals permanently while retaining partial usage and unknown attribution', async () => {
    let calls = 0;
    const options = fixture(1, async () => ++calls < 3 ? toolReply({ inputTokens: calls === 1 ? Number.MAX_SAFE_INTEGER : 2, outputTokens: 0 }) : answer('done', { inputTokens: 1, outputTokens: 2 }));
    options.tasks[0]!.tools = [readTool];
    const result = await runNativeMission(options);
    expect(result.tasks[0]!.usage).toEqual({ outputTokens: 2, unknown: true });
    expect(result.usage).toEqual({ outputTokens: 2, unknownTasks: 1 });
  });

  it('keeps aggregate totals safe when independent known task counts cannot be represented together', async () => {
    const options = fixture(2, async () => answer('done', { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 }));
    const result = await runNativeMission(options);
    expect(result.usage.inputTokens).toBeUndefined();
    expect(result.usage.outputTokens).toBe(0);
    expect(result.tasks.every(task => Number.isSafeInteger(task.usage?.inputTokens))).toBe(true);
  });

  it('fails budget eligibility closed when the sum of individually safe input and output overflows', async () => {
    const options = fixture(1, async () => toolReply({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: Number.MAX_SAFE_INTEGER }));
    options.tasks[0]!.tools = [readTool];
    options.budget = { maxTaskTokens: 100 };
    const result = await runNativeMission(options);
    expect(result.tasks[0]).toMatchObject({ state: 'cancelled', reason: 'usage-unknown', usage: { unknown: true } });
  });

  it('does not invent unknown usage when a connection input ceiling prevents provider entry', async () => {
    const fetch = vi.fn(async () => Response.json({}));
    const options = fixture(1, async () => { throw new Error('Unused fixture provider.'); });
    options.tasks[0]!.instructions = 'Inspect task-0\n' + 'x'.repeat(10_000);
    options.budget = { maxTokens: 1_000_000 };
    options.bindings[0]!.provider = createProvider({
      preset: 'custom', api: 'openai-chat', baseUrl: 'https://api.example.com/v1', model: 'model',
      features: { memory: 'extalia', skills: 'extalia' }, inputTokenLimit: 1_024,
    }, undefined, fetch);
    const result = await runNativeMission(options);
    expect(result.state).toBe('failed');
    expect(result.tasks[0]).toMatchObject({ state: 'failed', reason: 'provider-failed' });
    expect(result.tasks[0]).not.toHaveProperty('usage');
    expect(result.usage).toEqual({ unknownTasks: 0 });
    expect(result.budgetExhausted).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retains known earlier usage when tool growth triggers a later local preflight refusal', async () => {
    const entered = vi.fn(async () => toolReply({ inputTokens: 123, outputTokens: 4 }));
    const options = fixture(1, entered);
    options.budget = { maxTokens: 1_000_000 };
    options.tasks[0]!.tools = [{ ...readTool, run: async () => ({ ok: true, output: 'x'.repeat(20_000) }) }];
    options.bindings[0]!.provider = guardProviderRequests(options.bindings[0]!.provider, 1_024);
    const result = await runNativeMission(options);
    expect(entered).toHaveBeenCalledTimes(1);
    expect(result.tasks[0]).toMatchObject({ state: 'failed', usage: { inputTokens: 123, outputTokens: 4 } });
    expect(result.usage).toEqual({ inputTokens: 123, outputTokens: 4, unknownTasks: 0 });
    expect(result.budgetExhausted).toBeUndefined();
  });

  it('keeps failed calls that actually entered a provider unknown', async () => {
    const entered = vi.fn(async () => { throw new Error('Provider connection failed.'); });
    const options = fixture(1, entered);
    options.budget = { maxTokens: 1_000_000 };
    const result = await runNativeMission(options);
    expect(entered).toHaveBeenCalledTimes(1);
    expect(result.tasks[0]).toMatchObject({ state: 'failed', usage: { unknown: true } });
    expect(result.usage).toEqual({ unknownTasks: 1 });
    expect(result.budgetExhausted).toBe('usage-unknown');
  });

  it('keeps usage unknown after a real failed attempt followed by a locally refused fallback', async () => {
    const entered = vi.fn(async () => { throw new ProviderError('Rate limit reached.', 429, true); });
    const fetch = vi.fn(async () => Response.json({}));
    const options = fixture(1, entered);
    options.tasks[0]!.instructions = 'Inspect task-0\n' + 'x'.repeat(10_000);
    options.budget = { maxTokens: 1_000_000 };
    const first = options.bindings[0]!.provider;
    const fallback = createProvider({
      preset: 'custom', api: 'openai-chat', baseUrl: 'https://api.example.com/v1', model: 'model',
      features: { memory: 'extalia', skills: 'extalia' }, inputTokenLimit: 1_024,
    }, undefined, fetch);
    options.bindings[0]!.provider = createFallbackProvider([{ model: 'first', provider: () => first }, { model: 'second', provider: () => fallback }]);
    const result = await runNativeMission(options);
    expect(entered).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(result.tasks[0]).toMatchObject({ state: 'failed', usage: { unknown: true } });
    expect(result.usage).toEqual({ unknownTasks: 1 });
    expect(result.budgetExhausted).toBe('usage-unknown');
  });

  it('sums only provider-reported usage per task and mission, commits it with events and keeps unreported usage unknown', async () => {
    const options = fixture(2, async (_request, index) => index === 0 ? answer('a', { inputTokens: 10, outputTokens: 5 }) : answer('b'));
    const committed = journal(options);
    const result = await runNativeMission(options);
    expect(result.state).toBe('completed');
    expect(result.tasks[0]!.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(result.tasks[1]!.usage).toEqual({ unknown: true });
    // Unreported usage is never folded in as zero.
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, unknownTasks: 1 });
    expect(result.budgetExhausted).toBeUndefined();
    const completedTurn = committed.find(item => item.event.taskId === id(20) && item.event.body.type === 'turn.completed')!;
    expect(completedTurn.event.body).toEqual({ type: 'turn.completed', usage: { inputTokens: 10, outputTokens: 5 } });
    expect(committed.find(item => item.event.taskId === id(21) && item.event.body.type === 'turn.completed')!.event.body).toEqual({ type: 'turn.completed' });
    expect(committed.every(item => item.accounting)).toBe(true);
    expect(committed.at(-1)!.accounting!.usage).toEqual(result.usage);
  });

  it('AC-08: token exhaustion blocks new admission while running work finishes with its state intact', async () => {
    const releaseRunning = deferred<ModelResult>();
    let calls: number[] = [];
    const options = fixture(3, async (_request, index) => {
      calls.push(index);
      if (index === 0) return answer('first', { inputTokens: 100, outputTokens: 50 });
      if (index === 1) return releaseRunning.promise;
      return answer('must not run');
    });
    options.maxConcurrency = 2;
    options.budget = { maxTokens: 100 };
    const committed = journal(options);
    const pending = runNativeMission(options);
    await new Promise(resolve => setTimeout(resolve, 10));
    // Task 0 exhausted the budget; task 1 is still in flight and must not be corrupted.
    expect(calls).toEqual([0, 1]);
    releaseRunning.resolve(answer('second', { inputTokens: 5, outputTokens: 5 }));
    const result = await pending;
    expect(calls).toEqual([0, 1]);
    expect(result.tasks[0]).toMatchObject({ state: 'completed', answer: 'first' });
    expect(result.tasks[1]).toMatchObject({ state: 'completed', answer: 'second', usage: { inputTokens: 5, outputTokens: 5 } });
    expect(result.tasks[2]).toMatchObject({ state: 'blocked', reason: 'budget-exhausted' });
    expect(result.tasks[2]!.usage).toBeUndefined();
    expect(result).toMatchObject({ state: 'failed', budgetExhausted: 'tokens', persistenceFailed: false, requiresReconciliation: false, usage: { inputTokens: 105, outputTokens: 55, unknownTasks: 0 } });
    expect(result.events.map(event => event.sequence)).toEqual(result.events.map((_, index) => index + 1));
    expect(committed.some(item => item.event.taskId === id(22) && item.event.body.type === 'task.assigned')).toBe(false);
    expect(committed.find(item => item.event.taskId === id(22))!.accounting!.exhausted).toBe('tokens');
    calls = [];
  });

  it('refuses the next provider call of running work after mission exhaustion, never aborting the in-flight call', async () => {
    const releaseFirst = deferred<ModelResult>();
    let task1Calls = 0, aborted = false;
    const options = fixture(2, async (request, index) => {
      if (index === 0) return answer('spender', { inputTokens: 90, outputTokens: 20 });
      task1Calls++;
      request.signal?.addEventListener('abort', () => { aborted = true; });
      return releaseFirst.promise;
    });
    options.tasks[1]!.tools = [readTool];
    options.budget = { maxTokens: 100 };
    const pending = runNativeMission(options);
    await new Promise(resolve => setTimeout(resolve, 10));
    releaseFirst.resolve(toolReply({ inputTokens: 1, outputTokens: 1 }));
    const result = await pending;
    expect(task1Calls).toBe(1);
    expect(aborted).toBe(false);
    expect(result.tasks[1]).toMatchObject({ state: 'cancelled', reason: 'budget-exhausted', usage: { inputTokens: 1, outputTokens: 1 } });
    expect(result.budgetExhausted).toBe('tokens');
  });

  it('enforces a per-task token limit without exhausting the mission', async () => {
    let task0Calls = 0;
    const options = fixture(2, async (_request, index) => {
      if (index === 0) { task0Calls++; return toolReply({ inputTokens: 40, outputTokens: 20 }); }
      return answer('sibling', { inputTokens: 1, outputTokens: 1 });
    });
    options.tasks[0]!.tools = [readTool];
    options.budget = { maxTaskTokens: 50 };
    const result = await runNativeMission(options);
    expect(task0Calls).toBe(1);
    expect(result.tasks[0]).toMatchObject({ state: 'cancelled', reason: 'budget-exhausted', usage: { inputTokens: 40, outputTokens: 20 } });
    expect(result.tasks[1]).toMatchObject({ state: 'completed', answer: 'sibling' });
    expect(result.budgetExhausted).toBeUndefined();
    expect(result.state).toBe('failed');
  });

  it('fails closed when a token budget cannot be proven because usage was not reported', async () => {
    const calls: number[] = [];
    const options = fixture(2, async (_request, index) => { calls.push(index); return answer(`answer ${index}`); });
    options.maxConcurrency = 1;
    options.budget = { maxTokens: 1_000_000 };
    const result = await runNativeMission(options);
    expect(calls).toEqual([0]);
    expect(result.tasks[0]).toMatchObject({ state: 'completed', usage: { unknown: true } });
    expect(result.tasks[1]).toMatchObject({ state: 'blocked', reason: 'usage-unknown' });
    expect(result).toMatchObject({ budgetExhausted: 'usage-unknown', usage: { unknownTasks: 1 } });
    expect(result.usage.inputTokens).toBeUndefined();
  });

  it('cancels cooperatively at the mission deadline, blocks queued work and records in-flight usage unknown', async () => {
    const calls: number[] = [];
    const options = fixture(2, async (request, index) => {
      calls.push(index);
      return new Promise<ModelResult>((_resolve, reject) => request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    });
    options.maxConcurrency = 1;
    options.abortGraceMs = 50;
    options.budget = { maxDurationMs: 30 };
    const committed = journal(options);
    const result = await runNativeMission(options);
    expect(calls).toEqual([0]);
    expect(result.tasks[0]).toMatchObject({ state: 'cancelled', reason: 'mission-deadline', usage: { unknown: true } });
    expect(result.tasks[1]).toMatchObject({ state: 'blocked', reason: 'mission-deadline' });
    expect(result).toMatchObject({ state: 'failed', budgetExhausted: 'duration', requiresReconciliation: false, usage: { unknownTasks: 1 } });
    expect(committed.at(-1)!.event.body).toEqual({ type: 'mission.state', state: 'failed' });
    expect(committed.at(-1)!.accounting!.exhausted).toBe('duration');
  });

  it('keeps abort-ignoring work unknown at the deadline and suppresses its late usage', async () => {
    const late = deferred<ModelResult>();
    const options = fixture(1, async () => late.promise);
    options.abortGraceMs = 5;
    options.budget = { maxDurationMs: 20 };
    const result = await runNativeMission(options);
    expect(result.tasks[0]).toMatchObject({ state: 'unknown', reason: 'execution-unknown', usage: { unknown: true } });
    expect(result).toMatchObject({ state: 'recovering', requiresReconciliation: true, budgetExhausted: 'duration' });
    const snapshot = JSON.stringify(result);
    late.resolve(answer('late', { inputTokens: 9, outputTokens: 9 }));
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(JSON.stringify(result)).toBe(snapshot);
  });

  it('rejects invalid budgets before any provider call', async () => {
    for (const budget of [{ maxTokens: 0 }, { maxTaskTokens: 1.5 }, { maxDurationMs: 86_400_001 }, { maxTokens: Number.NaN }]) {
      let calls = 0;
      const options = fixture(1, async () => { calls++; return answer('no'); });
      options.budget = budget;
      await expect(runNativeMission(options)).rejects.toThrow(/Invalid native mission input/);
      expect(calls).toBe(0);
    }
  });

  it('gets real numbers through the OpenAI-compatible adapter (FR-04), and stays unknown when the server reports none', async () => {
    const stream = (usage: unknown) => new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const adapter = (baseUrl: string, usage: unknown) => createProvider(
      { preset: 'custom', api: 'openai-chat', baseUrl, model: 'model', features: { memory: 'extalia', skills: 'extalia' } },
      undefined,
      async () => stream(usage),
    );

    const reporting = adapter('http://127.0.0.1:9301/v1', { prompt_tokens: 30, completion_tokens: 10 });
    const options = fixture(2, request => reporting.complete(request));
    options.maxConcurrency = 1;
    options.budget = { maxTokens: 1000 };
    const result = await runNativeMission(options);
    expect(result.state).toBe('completed');
    expect(result.tasks[0]!.usage).toEqual({ inputTokens: 30, outputTokens: 10 });
    expect(result.usage).toEqual({ inputTokens: 60, outputTokens: 20, unknownTasks: 0 });
    expect(result.budgetExhausted).toBeUndefined();

    const silent = adapter('http://127.0.0.1:9302/v1', null);
    const unreported = fixture(1, request => silent.complete(request));
    unreported.budget = { maxTokens: 1000 };
    const unknown = await runNativeMission(unreported);
    expect(unknown.tasks[0]!.usage).toEqual({ unknown: true });
    expect(unknown).toMatchObject({ budgetExhausted: 'usage-unknown', usage: { unknownTasks: 1 } });
    expect(unknown.usage.inputTokens).toBeUndefined();
  });

  it.each([
    { name: 'cache reads', raw: { input_tokens: 2, cache_read_input_tokens: 100, output_tokens: 5 }, inputTokens: 102, outputTokens: 5, exhausted: 'tokens' },
    { name: 'cache creation', raw: { input_tokens: 2, cache_creation_input_tokens: 100, output_tokens: 5 }, inputTokens: 102, outputTokens: 5, exhausted: 'tokens' },
    { name: 'mixed cache reads and creation', raw: { input_tokens: 2, cache_read_input_tokens: 60, cache_creation_input_tokens: 40, output_tokens: 5 }, inputTokens: 102, outputTokens: 5, exhausted: 'tokens' },
    { name: 'missing optional cache metrics', raw: { input_tokens: 2, output_tokens: 5 }, inputTokens: 2, outputTokens: 5 },
    { name: 'explicit zero metrics', raw: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }, inputTokens: 0, outputTokens: 0 },
    { name: 'missing uncached input', raw: { cache_read_input_tokens: 100, output_tokens: 5 }, outputTokens: 5, exhausted: 'usage-unknown' },
  ])('accounts for Anthropic $name before admitting queued work', async ({ raw, inputTokens, outputTokens, exhausted }) => {
    let calls = 0;
    const provider = createProvider(
      { preset: 'custom', api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:9303', model: 'model', features: { memory: 'extalia', skills: 'extalia' } },
      undefined,
      async () => {
        calls++;
        const events = [
          { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'model', content: [], stop_reason: null, stop_sequence: null, usage: raw } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'done' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens } },
          { type: 'message_stop' },
        ];
        return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
      },
    );
    const options = fixture(2, request => provider.complete(request));
    options.maxConcurrency = 1;
    options.budget = { maxTokens: 100 };
    const committed = journal(options);
    const result = await runNativeMission(options);
    const reported = { ...(inputTokens !== undefined ? { inputTokens } : {}), outputTokens };
    expect(result.tasks[0]).toMatchObject({ state: 'completed', answer: 'done' });
    expect(result.tasks[0]!.usage).toEqual({ ...reported, ...(inputTokens === undefined ? { unknown: true } : {}) });
    // Mission summaries spend the normalized total once; cache reads are a subset of it.
    expect(committed.find(item => item.event.taskId === id(20) && item.event.body.type === 'turn.completed')!.event.body).toEqual({
      type: 'turn.completed', usage: reported,
    });
    expect(result.budgetExhausted).toBe(exhausted);
    expect(calls).toBe(exhausted ? 1 : 2);
    if (exhausted) {
      expect(result.tasks[1]).toMatchObject({ state: 'blocked', reason: exhausted === 'tokens' ? 'budget-exhausted' : 'usage-unknown' });
      expect(result.usage).toEqual({ ...reported, unknownTasks: inputTokens === undefined ? 1 : 0 });
      expect(committed.some(item => item.event.taskId === id(21) && item.event.body.type === 'task.assigned')).toBe(false);
    } else {
      expect(result.state).toBe('completed');
      expect(result.usage).toEqual({ inputTokens: inputTokens! * 2, outputTokens: outputTokens * 2, unknownTasks: 0 });
    }
  });
});
