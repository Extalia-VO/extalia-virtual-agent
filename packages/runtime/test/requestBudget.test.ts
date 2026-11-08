import { describe, expect, it, vi } from 'vitest';
import {
  REQUEST_CHARACTER_LIMIT, RequestBudgetError, checkRequestBudget, createDelegationTool, createFallbackProvider, createProvider, guardProviderRequests, isFallbackError, modelChain, runTurn,
  type AnyTool, type ModelMessage, type ModelProvider, type ModelRequest, type ModelResult, type TurnOptions,
} from '../src/index.js';

const done: ModelResult = { text: 'Done.', toolCalls: [], stop: 'end' };
const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({ system: 'sys', messages: [{ role: 'user', text: 'hi' }], tools: [], ...overrides });
const readTool = (output = 'ok'): AnyTool => ({
  name: 'read_file', description: 'Read a file', access: 'read', kind: 'read',
  parameters: { type: 'object', properties: {} }, describe: () => ({ label: 'Read' }),
  run: vi.fn(async () => ({ ok: true, output })),
});

function harness(steps: ModelResult[] = [done]) {
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    api: 'openai-chat', listModels: async () => [],
    complete: vi.fn(async input => {
      requests.push({ ...input, messages: [...input.messages] });
      const result = steps.shift();
      if (!result) throw new Error('Unexpected provider call.');
      return result;
    }),
  };
  const run = (overrides: Partial<TurnOptions> = {}) => runTurn({
    provider, system: 'sys', history: [], prompt: 'hi', tools: [],
    permissions: { fileWrite: 'ask', commands: 'ask' }, sessionGrants: new Set(),
    signal: new AbortController().signal, emit: () => undefined, requestApproval: async () => 'once', ...overrides,
  });
  return { provider, requests, run };
}

describe('request pressure measurement', () => {
  it('counts the full system, all history, tool descriptions/schemas and native replay', () => {
    const basic = checkRequestBudget(request()).pressure!;
    const histories: ModelMessage[][] = [
      [{ role: 'user', text: 'old'.repeat(2_000) }],
      [{ role: 'assistant', text: '', toolCalls: [{ id: 't', name: 'read_file', input: { data: 'input'.repeat(2_000) } }] }],
      [{ role: 'tool', results: [{ toolCallId: 't', name: 'read_file', content: 'result'.repeat(2_000), isError: false }] }],
      [{ role: 'assistant', text: '', toolCalls: [], native: { api: 'anthropic-messages', content: [{ type: 'thinking', thinking: 'reason'.repeat(2_000), signature: 'signature' }] } }],
    ];
    for (const history of histories) expect(checkRequestBudget(request({ messages: [...history, ...request().messages] })).pressure!.characters).toBeGreaterThan(basic.characters + 5_000);
    expect(checkRequestBudget(request({ system: 's'.repeat(6_000) })).pressure!.characters).toBeGreaterThan(basic.characters + 5_000);
    const { name, description, parameters } = readTool();
    const tool = { name, description, parameters };
    expect(checkRequestBudget(request({ tools: [{ ...tool, description: 'd'.repeat(6_000) }] })).pressure!.characters).toBeGreaterThan(basic.characters + 5_000);
    expect(checkRequestBudget(request({ tools: [{ ...tool, parameters: { type: 'object', properties: { data: { type: 'string', description: 'schema'.repeat(2_000) } } } }] })).pressure!.characters).toBeGreaterThan(basic.characters + 5_000);
  });

  it('counts UTF-16 Unicode text without mutating or normalizing it', () => {
    const text = '日本語 🧑🏽‍💻 e\u0301\n\u0000';
    const messages: ModelMessage[] = [{ role: 'user', text }];
    const full = checkRequestBudget(request({ messages })).pressure!;
    const empty = checkRequestBudget(request({ messages: [{ role: 'user', text: '' }] })).pressure!;
    expect(full.characters - empty.characters).toBe(text.length);
    expect(messages).toEqual([{ role: 'user', text }]);
  });

  it('excludes only typed user image data, with a fixed image token estimate', () => {
    const withImage = (data: string) => request({ messages: [{ role: 'user', text: 'see', images: [{ mimeType: 'image/png', data }] }] });
    const small = checkRequestBudget(withImage('x')).pressure!;
    const larger = checkRequestBudget(withImage('x'.repeat(10_000))).pressure!;
    expect(larger).toEqual(small);
    expect(small.estimatedTokens).toBe(Math.ceil(small.characters / 4) + 1_500);
    expect(checkRequestBudget(withImage('x'), 1_500).reason).toBe('token-limit');
    const native = (data: string) => request({ messages: [{ role: 'assistant', text: '', toolCalls: [], native: { api: 'anthropic-messages', content: [{ type: 'image', source: { type: 'base64', data } }] } }] });
    expect(checkRequestBudget(native('x'.repeat(10_000))).pressure!.characters - checkRequestBudget(native('x')).pressure!.characters).toBe(9_999);
    const invalid = withImage('x'.repeat(10_000));
    (invalid.messages[0] as { images: { mimeType: string }[] }).images[0]!.mimeType = 'application/json';
    expect(checkRequestBudget(invalid).pressure!.characters).toBeGreaterThan(10_000);
  });

  it('counts shared schema aliases each time, omits undefined optional fields and refuses unsafe structures', () => {
    const shared = { type: 'string', description: 'x'.repeat(200) };
    const schema = { type: 'object', properties: { one: shared, two: shared } };
    const tools = [{ name: 'tool', description: 'd', parameters: schema }] as ModelRequest['tools'];
    const measured = checkRequestBudget(request({ tools }));
    expect(measured.reason).toBeUndefined();
    expect(measured.pressure!.characters).toBeGreaterThan(400);
    const optional = request({ tools: [{ ...tools[0]!, parameters: { ...tools[0]!.parameters, required: undefined } }] });
    expect(checkRequestBudget(optional)).toEqual(measured);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 100; index++) { const next = {}; cursor.next = next; cursor = next; }
    const getter = vi.fn(() => 'not read');
    for (const content of [cyclic, deep, Object.defineProperty({}, 'secret', { enumerable: true, get: getter }), new Date(), { invalid: 1n }]) {
      expect(checkRequestBudget(request({ messages: [{ role: 'assistant', text: '', toolCalls: [], native: { api: 'anthropic-messages', content } }] }))).toEqual({ reason: 'unsupported-request' });
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it('bounds the number of traversed values, including omitted undefined properties', () => {
    const content = Object.fromEntries(Array.from({ length: 100_001 }, (_, index) => [`p${index}`, undefined]));
    expect(checkRequestBudget(request({ messages: [{ role: 'assistant', text: '', toolCalls: [], native: { api: 'anthropic-messages', content } }] })).reason).toBe('unsupported-request');
  });

  it('accepts an exact estimated ceiling and refuses only requests beyond it', () => {
    const size = checkRequestBudget(request()).pressure!.estimatedTokens;
    expect(checkRequestBudget(request(), size).reason).toBeUndefined();
    expect(checkRequestBudget(request(), size - 1).reason).toBe('token-limit');
    expect(checkRequestBudget(request(), Number.MAX_SAFE_INTEGER).reason).toBeUndefined();
  });
});

describe('turn request budget guard', () => {
  it.each(['system', 'history', 'prompt', 'native', 'schema'] as const)('blocks initial oversized %s before entering the provider', async source => {
    const h = harness();
    const large = 'x'.repeat(5_000);
    const tool = readTool();
    const override: Partial<TurnOptions> = source === 'system' ? { system: large }
      : source === 'prompt' ? { prompt: large }
      : source === 'history' ? { history: [{ role: 'user', text: large }] }
      : source === 'native' ? { history: [{ role: 'assistant', text: '', toolCalls: [], native: { api: 'anthropic-messages', content: [{ type: 'thinking', thinking: large, signature: 's' }] } }] }
      : { tools: [{ ...tool, parameters: { type: 'object', properties: { item: { type: 'string', description: large } } } }] };
    const result = await h.run({ ...override, maxInputTokens: 1_000 });
    expect(result).toMatchObject({ outcome: 'failed', reason: 'context', error: 'native_context_limit', usage: {}, requestPressure: { limitTokens: 1_000, characterLimit: REQUEST_CHARACTER_LIMIT } });
    expect(result.context).toBeUndefined();
    expect(h.provider.complete).not.toHaveBeenCalled();
  });

  it('applies the independent default character ceiling without inferring a model window', async () => {
    const h = harness([{ ...done, model: 'unknown-future-model' }]);
    const prompt = 'x'.repeat(REQUEST_CHARACTER_LIMIT + 1);
    const rejected = await h.run({ prompt });
    expect(rejected).toMatchObject({ outcome: 'failed', reason: 'context', error: 'native_context_limit' });
    expect(rejected.history[0]).toEqual({ role: 'user', text: prompt });
    expect(rejected.requestPressure).not.toHaveProperty('limitTokens');
    expect(h.provider.complete).not.toHaveBeenCalled();
    const accepted = await h.run({ prompt: 'x'.repeat(100_000) });
    expect(accepted.outcome).toBe('completed');
    expect(accepted.context?.model).toBe('unknown-future-model');
    expect(accepted.requestPressure).not.toHaveProperty('limitTokens');
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('refuses invalid explicit input ceilings (%s) before provider entry', async maxInputTokens => {
    const h = harness();
    expect(await h.run({ maxInputTokens })).toMatchObject({ outcome: 'failed', reason: 'context', error: 'native_context_limit', usage: {} });
    expect(h.provider.complete).not.toHaveBeenCalled();
  });

  it('stops after tool-result growth, preserves pairs and reports only earlier actual usage/context', async () => {
    const calls = [{ id: 't1', name: 'read_file', input: {} }, { id: 't2', name: 'read_file', input: {} }];
    const h = harness([{ text: 'Reading.', toolCalls: calls, stop: 'tool_use', model: 'unknown-model', promptTokens: 123, usage: { inputTokens: 123, outputTokens: 7, cachedInputTokens: 20 } }]);
    const tool = readTool('x'.repeat(5_000));
    const history: ModelMessage[] = [{ role: 'user', text: ' Earlier text\n' }, { role: 'assistant', text: 'Earlier answer.', toolCalls: [] }];
    const before = structuredClone(history);
    const result = await h.run({ tools: [tool], history, prompt: ' Exact user text\n', maxInputTokens: 1_000 });
    expect(result).toMatchObject({ outcome: 'failed', reason: 'context', error: 'native_context_limit', context: { usedTokens: 123, estimated: false, model: 'unknown-model' }, usage: { inputTokens: 123, outputTokens: 7, cachedInputTokens: 20 } });
    expect(h.requests).toHaveLength(1);
    expect(tool.run).toHaveBeenCalledTimes(2);
    expect(result.history).toEqual([...history, { role: 'user', text: ' Exact user text\n' }, { role: 'assistant', text: 'Reading.', toolCalls: calls }, { role: 'tool', results: calls.map(call => ({ toolCallId: call.id, name: call.name, content: 'x'.repeat(5_000), isError: false })) }]);
    expect(history).toEqual(before);
    expect(result.requestPressure!.estimatedTokens).toBeGreaterThan(1_000);
  });

  it('retains the prior sent-request estimate when a later request is blocked', async () => {
    const h = harness([{ text: '', toolCalls: [{ id: 't', name: 'read_file', input: {} }], stop: 'tool_use', usage: { outputTokens: 5 } }]);
    const result = await h.run({ tools: [readTool('x'.repeat(5_000))], maxInputTokens: 1_000 });
    expect(result.context).toEqual({ usedTokens: checkRequestBudget(h.requests[0]!).pressure!.estimatedTokens, estimated: true });
    expect(result.context!.usedTokens).toBeLessThan(result.requestPressure!.estimatedTokens);
    expect(result.usage).toEqual({ outputTokens: 5 });
  });

  it('gives cancellation precedence over an invalid limit and oversized request', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const result = await h.run({ signal: controller.signal, prompt: 'x'.repeat(5_000), maxInputTokens: -1 });
    expect(result.outcome).toBe('cancelled');
    expect(result.reason).toBeUndefined();
    expect(result.context).toBeUndefined();
    expect(h.provider.complete).not.toHaveBeenCalled();
  });

  it('rechecks cancellation immediately before provider entry', async () => {
    const h = harness();
    const controller = new AbortController();
    const result = await h.run({ signal: controller.signal, emit: event => { if (event.type === 'agent.state' && event.state === 'thinking') controller.abort(); } });
    expect(result.outcome).toBe('cancelled');
    expect(h.provider.complete).not.toHaveBeenCalled();
  });

  it('keeps image data out of request pressure while retaining actual provider image input', async () => {
    const h = harness();
    const result = await h.run({ attachments: [{ kind: 'image', name: 'sample.png', mimeType: 'image/png', size: 100, data: 'base64' }], maxInputTokens: 2_000 });
    expect(result.outcome).toBe('completed');
    expect(h.requests[0]!.messages[0]).toMatchObject({ role: 'user', images: [{ mimeType: 'image/png', data: 'base64' }] });
    expect(result.requestPressure!.estimatedTokens).toBeGreaterThan(1_500);
    expect(result.context?.usedTokens).toBe(result.requestPressure!.estimatedTokens);
    expect(result.history[0]).not.toHaveProperty('images'); // Existing persisted-image policy is unchanged.
  });
});

describe('factory provider request guards', () => {
  const connection = (api: 'openai-chat' | 'anthropic-messages', inputTokenLimit?: number) => ({
    preset: 'custom' as const, api, baseUrl: 'https://api.example.com/v1', model: 'unknown-model',
    features: { memory: 'extalia' as const, skills: 'extalia' as const }, ...(inputTokenLimit === undefined ? {} : { inputTokenLimit }),
  });

  it.each(['openai-chat', 'anthropic-messages'] as const)('guards direct planner-style %s calls before any fetch', async api => {
    const fetch = vi.fn(async () => Response.json({}));
    const provider = createProvider(connection(api, 1_024), undefined, fetch);
    const input = request({ system: 'p'.repeat(5_000), messages: [{ role: 'user', text: 'Exact planner instructions\n' }] });
    const original = structuredClone(input);
    await expect(provider.complete(input)).rejects.toMatchObject({ name: 'RequestBudgetError', code: 'native_context_limit', status: 400, retryable: false, pressure: { limitTokens: 1_024 } });
    expect(fetch).not.toHaveBeenCalled();
    expect(input).toEqual(original);
  });

  it.each(['openai-chat', 'anthropic-messages'] as const)('applies the independent character safety guard without an explicit limit (%s)', async api => {
    const fetch = vi.fn(async () => Response.json({}));
    const provider = createProvider(connection(api), undefined, fetch);
    await expect(provider.complete(request({ system: 'p'.repeat(REQUEST_CHARACTER_LIMIT + 1) }))).rejects.toMatchObject({ code: 'native_context_limit', reason: 'character-limit' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not fall back from a guarded refusal to a model with a looser or absent ceiling', async () => {
    const fetch = vi.fn(async () => Response.json({}));
    const factory = vi.fn((model: string) => createProvider({ ...connection('openai-chat', model === 'first' ? 1_024 : undefined), model }, undefined, fetch));
    const switched = vi.fn();
    const provider = createFallbackProvider(modelChain(['first', 'second'], factory), { onSwitch: switched });
    const input = request({ messages: [{ role: 'user', text: 'Exact text\n'.repeat(1_000) }] });
    const error = await provider.complete(input).catch(value => value);
    expect(error).toBeInstanceOf(RequestBudgetError);
    expect(isFallbackError(error)).toBe(false);
    expect(provider.current).toBe('first');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(switched).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps a tighter factory ceiling to a context failure without replacing earlier actual context', async () => {
    const h = harness([{ text: '', toolCalls: [{ id: 't', name: 'read_file', input: {} }], stop: 'tool_use', promptTokens: 321, usage: { inputTokens: 321, outputTokens: 4 } }]);
    const result = await h.run({ provider: guardProviderRequests(h.provider, 1_024), tools: [readTool('x'.repeat(5_000))] });
    expect(result).toMatchObject({ outcome: 'failed', error: 'native_context_limit', reason: 'context', usage: { inputTokens: 321, outputTokens: 4 }, context: { usedTokens: 321, estimated: false }, requestPressure: { limitTokens: 1_024 } });
    expect(h.requests).toHaveLength(1);
    expect(result.history.map(message => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(result.history.at(-1)).toMatchObject({ role: 'tool', results: [{ toolCallId: 't', content: 'x'.repeat(5_000) }] });
  });

  it('retains possible prior provider entry when a later fallback is locally refused', async () => {
    const fetch = vi.fn(async () => Response.json({ error: { message: 'Rate limit reached.' } }, { status: 429 }));
    const factory = vi.fn((model: string) => createProvider({ ...connection('openai-chat', model === 'first' ? undefined : 1_024), model }, undefined, fetch));
    const provider = createFallbackProvider(modelChain(['first', 'second', 'third'], factory));
    const input = request({ system: 'x'.repeat(5_000) });
    await expect(provider.complete(input)).rejects.toMatchObject({ code: 'native_context_limit', priorRequestMayHaveRun: true, retryable: false, pressure: { limitTokens: 1_024 } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(provider.current).toBe('second');
  });

  it('protects delegated workers that have no loop-level limit configured', async () => {
    const fetch = vi.fn(async () => Response.json({}));
    const provider = createProvider(connection('openai-chat', 1_024), undefined, fetch);
    const tool = createDelegationTool({ providerFor: () => provider, workerTools: [], maxDelegations: 1, workspace: { name: 'App', root: '/projects/app' }, emit: () => undefined });
    const result = await tool.run({ task: 'Read context', context: 'x'.repeat(5_000) }, { signal: new AbortController().signal, toolCallId: 'delegate-1', emit: () => undefined });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('native_context_limit');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([1_023, 2_000_001, -1, NaN, Infinity])('rejects invalid factory connection ceilings (%s) before fetch', async inputTokenLimit => {
    const fetch = vi.fn(async () => Response.json({}));
    const provider = createProvider(connection('openai-chat', inputTokenLimit), undefined, fetch);
    await expect(provider.complete(request())).rejects.toMatchObject({ code: 'native_context_limit', reason: 'invalid-limit', retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves model listing, image capability, successful request text and local-only limits', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => init?.body
      ? Response.json({ model: 'unknown-model', choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })
      : Response.json({ data: [{ id: 'unknown-model' }] }));
    const provider = createProvider(connection('openai-chat', 1_024), undefined, fetch);
    expect(provider.api).toBe('openai-chat');
    expect(provider.images).toBe(true);
    expect(await provider.listModels()).toEqual(['unknown-model']);
    const input = request({ messages: [{ role: 'user', text: ' Exact request\n' }] });
    expect((await provider.complete(input)).text).toBe('OK');
    const body = JSON.parse(String(fetch.mock.calls[1]![1]?.body));
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: ' Exact request\n' });
    expect(body).not.toHaveProperty('inputTokenLimit');
  });

  it('prioritizes cancellation over a factory refusal', async () => {
    const fetch = vi.fn(async () => Response.json({}));
    const provider = createProvider(connection('openai-chat', -1), undefined, fetch);
    const controller = new AbortController();
    controller.abort();
    await expect(provider.complete({ ...request(), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
