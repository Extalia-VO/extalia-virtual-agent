import type { EventBody } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import {
  createProvider, runTurn, type AnyTool, type FetchLike, type ModelProvider, type ModelRequest, type ModelResult,
} from '../src/index.js';

// Synthesized provider responses; no real account or endpoint is used.
function scripted(steps: ModelResult[]): ModelProvider & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    api: 'openai-chat',
    requests,
    listModels: async () => [],
    async complete(request) {
      requests.push({ ...request, messages: [...request.messages] });
      const step = steps.shift();
      if (!step) throw new Error('no more steps');
      return step;
    },
  };
}

const echoTool: AnyTool = {
  name: 'read_note', description: 'Read a note', access: 'read', kind: 'read',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  describe: input => ({ label: `Reading ${String(input.id)}` }),
  run: async () => ({ ok: true, output: 'a note '.repeat(200) }),
};

const toolStep = (promptTokens?: number): ModelResult => ({
  text: 'Reading.', toolCalls: [{ id: 'c1', name: 'read_note', input: { id: 'n1' } }], stop: 'tool_use', model: 'claude-sonnet-4-5',
  usage: { inputTokens: 100, outputTokens: 5 }, ...(promptTokens !== undefined ? { promptTokens } : {}),
});
const finalStep = (promptTokens?: number): ModelResult => ({
  text: 'Done.', toolCalls: [], stop: 'end', model: 'claude-sonnet-4-5', usage: { inputTokens: 200, outputTokens: 2 }, ...(promptTokens !== undefined ? { promptTokens } : {}),
});

function run(provider: ModelProvider, options: { system?: string; history?: Parameters<typeof runTurn>[0]['history'] } = {}) {
  const events: EventBody[] = [];
  const controller = new AbortController();
  return runTurn({
    provider, system: options.system ?? 'You are a helpful agent.', history: options.history ?? [], prompt: 'Read n1 and answer.',
    tools: [echoTool], permissions: { fileWrite: 'ask', commands: 'ask' }, sessionGrants: new Set(),
    emit: body => events.push(body), requestApproval: async () => 'once', signal: controller.signal,
  });
}

describe('turn context', () => {
  it('reports the prompt size of the last request, not the sum over the turn', async () => {
    const result = await run(scripted([toolStep(1_000), finalStep(1_500)]));
    expect(result.outcome).toBe('completed');
    expect(result.context).toEqual({ usedTokens: 1_500, estimated: false, model: 'claude-sonnet-4-5' });
    // Usage stays the sum of the turn, as before.
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 7 });
  });

  it('estimates from the text sent when the provider reports no prompt size, and marks it estimated', async () => {
    const short = await run(scripted([finalStep()]), { system: 'Short.' });
    const long = await run(scripted([finalStep()]), { system: 'Short. '.repeat(4_000) });
    expect(short.context?.estimated).toBe(true);
    expect(long.context?.estimated).toBe(true);
    expect(short.context!.usedTokens).toBeGreaterThan(0);
    expect(long.context!.usedTokens).toBeGreaterThan(short.context!.usedTokens * 10);
    expect(long.context!.usedTokens).toBeGreaterThanOrEqual(Math.floor(('Short. '.repeat(4_000)).length / 4));
  });

  it('reports no context when the turn never reached the model', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runTurn({
      provider: scripted([]), system: '', history: [], prompt: 'Hello', tools: [], permissions: { fileWrite: 'ask', commands: 'ask' },
      sessionGrants: new Set(), emit: () => undefined, requestApproval: async () => 'once', signal: controller.signal,
    });
    expect(result.outcome).toBe('cancelled');
    expect(result.context).toBeUndefined();
  });
});

describe('provider prompt sizes', () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  it('OpenAI-compatible: the prompt size is prompt_tokens, which already includes cached tokens', async () => {
    const fetch: FetchLike = async () => json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4200, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 4000 } } });
    const result = await createProvider({ preset: 'custom', api: 'openai-chat', baseUrl: 'http://127.0.0.1:9999/v1', model: 'test-model', features: { memory: 'extalia', skills: 'extalia' } }, undefined, fetch)
      .complete({ system: '', messages: [{ role: 'user', text: 'hi' }], tools: [] });
    expect(result.promptTokens).toBe(4200);
  });

  it('Anthropic: the prompt size adds cache reads and cache writes to the uncached input', async () => {
    const events = [
      { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 300, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ];
    const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
    const fetch: FetchLike = async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const result = await createProvider({ preset: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', features: { memory: 'extalia', skills: 'extalia' } }, 'test-key', fetch)
      .complete({ system: '', messages: [{ role: 'user', text: 'hi' }], tools: [] });
    expect(result.promptTokens).toBe(1320);
    expect(result.usage?.inputTokens).toBe(20);
  });
});
