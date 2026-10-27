import { describe, expect, it } from 'vitest';
import { createProvider, replayableContent, toAnthropicMessages, toChatMessages, type FetchLike, type ModelMessage } from '../src/index.js';

function sse(events: unknown[], named = false): Response {
  const body = events.map(event => {
    const data = typeof event === 'string' ? event : JSON.stringify(event);
    const type = named && typeof event === 'object' && event && 'type' in event ? `event: ${(event as { type: string }).type}\n` : '';
    return `${type}data: ${data}\n\n`;
  }).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

interface Captured { url: string; init?: RequestInit }

function fakeFetch(respond: (request: Captured) => Response): { fetch: FetchLike; requests: Captured[] } {
  const requests: Captured[] = [];
  return {
    requests,
    fetch: async (url, init) => {
      const request = { url: String(url), ...(init ? { init } : {}) };
      requests.push(request);
      return respond(request);
    },
  };
}

const connection = (overrides: Partial<Parameters<typeof createProvider>[0]> = {}): Parameters<typeof createProvider>[0] => ({
  preset: 'custom', api: 'openai-chat', baseUrl: 'http://127.0.0.1:9999/v1', model: 'test-model',
  features: { memory: 'extalia', skills: 'extalia' }, ...overrides,
});

describe('OpenAI-compatible provider', () => {
  it('streams text and assembles tool calls split across chunks', async () => {
    const { fetch, requests } = fakeFetch(() => sse([
      { model: 'test-model', choices: [{ delta: { content: 'Let me ' } }] },
      { choices: [{ delta: { content: 'check.' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } },
      '[DONE]',
    ]));
    const deltas: string[] = [];
    const result = await createProvider(connection(), 'secret-value', fetch).complete({ system: 'sys', messages: [{ role: 'user', text: 'hi' }], tools: [], onText: d => deltas.push(d) });
    expect(deltas.join('')).toBe('Let me check.');
    expect(result).toMatchObject({ text: 'Let me check.', stop: 'tool_use', model: 'test-model', usage: { inputTokens: 12, outputTokens: 5 } });
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }]);
    expect(requests[0]?.url).toBe('http://127.0.0.1:9999/v1/chat/completions');
    expect((requests[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer secret-value');
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({ model: 'test-model', stream: true, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] });
  });

  it('accepts a non-streamed JSON answer and reports invalid tool JSON', async () => {
    const { fetch } = fakeFetch(() => Response.json({ choices: [{ message: { content: 'ok', tool_calls: [{ id: 'c', function: { name: 'x', arguments: '{oops' } }] }, finish_reason: 'tool_calls' }] }));
    const result = await createProvider(connection(), undefined, fetch).complete({ system: '', messages: [], tools: [] });
    expect(result.toolCalls[0]).toMatchObject({ name: 'x', inputError: expect.stringContaining('JSON') });
  });

  it('turns HTTP errors into readable provider errors', async () => {
    const { fetch } = fakeFetch(() => Response.json({ error: { message: 'invalid api key' } }, { status: 401 }));
    await expect(createProvider(connection(), 'bad', fetch).complete({ system: '', messages: [], tools: [] })).rejects.toThrow(/rejected the credentials: invalid api key/);
  });

  it('lists models and asks OmniRoute not to add its memory when Extalia memory is used', async () => {
    const { fetch, requests } = fakeFetch(() => Response.json({ data: [{ id: 'b' }, { id: 'a' }] }));
    const provider = createProvider(connection({ preset: 'omniroute', features: { memory: 'extalia', skills: 'provider' } }), undefined, fetch);
    expect(await provider.listModels()).toEqual(['a', 'b']);
    expect((requests[0]?.init?.headers as Record<string, string>)['x-omniroute-no-memory']).toBe('true');
    const withProviderMemory = createProvider(connection({ preset: 'omniroute', features: { memory: 'provider', skills: 'provider' } }), undefined, fetch);
    await withProviderMemory.listModels();
    expect((requests[1]?.init?.headers as Record<string, string>)['x-omniroute-no-memory']).toBeUndefined();
  });

  it('maps history including tool results', () => {
    const history: ModelMessage[] = [
      { role: 'user', text: 'fix it' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'a' } }] },
      { role: 'tool', results: [{ toolCallId: 'c1', name: 'read_file', content: 'nope', isError: true }] },
    ];
    expect(toChatMessages('s', history)).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'Error: nope' },
    ]);
  });
});

const anthropicStream = (stopReason: string) => [
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 9 } },
  { type: 'message_stop' },
];

describe('Anthropic provider', () => {
  it('streams through the SDK and keeps native content for replay', async () => {
    const { fetch, requests } = fakeFetch(() => sse(anthropicStream('tool_use'), true));
    const provider = createProvider(connection({ preset: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5', effort: 'high' }), 'test-key', fetch);
    const deltas: string[] = [];
    const result = await provider.complete({ system: 'sys', messages: [{ role: 'user', text: 'hi' }], tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }], onText: d => deltas.push(d) });
    expect(deltas.join('')).toBe('Reading.');
    expect(result).toMatchObject({ text: 'Reading.', stop: 'tool_use', model: 'claude-opus-5-5', usage: { inputTokens: 20, outputTokens: 9 } });
    expect(result.toolCalls).toEqual([{ id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } }]);
    expect(result.native?.api).toBe('anthropic-messages');

    const request = requests[0]!;
    const headers = new Headers(request.init?.headers);
    const body = JSON.parse(String(request.init?.body));
    expect(request.url).toContain('https://api.anthropic.com/v1/messages');
    expect(headers.get('x-api-key')).toBe('test-key');
    expect(headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(body).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', output_config: { effort: 'high' }, stream: true });
    expect(body.tools[0]).toMatchObject({ name: 'read_file', eager_input_streaming: true });
  });

  it('sends no Authorization header to a keyless 9Router', async () => {
    const { fetch, requests } = fakeFetch(() => sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]']));
    await createProvider(connection({ preset: '9router', baseUrl: 'http://localhost:20128/v1', model: 'auto' }), undefined, fetch).complete({ system: '', messages: [{ role: 'user', text: 'hi' }], tools: [] });
    expect(new Headers(requests[0]?.init?.headers).has('authorization')).toBe(false);
  });

  it('does not send Anthropic-only options to routers', async () => {
    const { fetch, requests } = fakeFetch(() => sse(anthropicStream('end_turn'), true));
    const provider = createProvider(connection({ preset: '9router', api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:9999', model: 'any' }), undefined, fetch);
    await provider.complete({ system: '', messages: [{ role: 'user', text: 'hi' }], tools: [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }] });
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.fallbacks).toBeUndefined();
    expect(body.tools[0].eager_input_streaming).toBeUndefined();
    expect(new Headers(requests[0]?.init?.headers).get('anthropic-beta')).toBeNull();
  });

  it('replays native blocks and drops declined-attempt blocks before a fallback marker', () => {
    const content = [
      { type: 'thinking', thinking: '', signature: 'a' },
      { type: 'text', text: 'partial ' },
      { type: 'tool_use', id: 't0', name: 'x', input: {} },
      { type: 'fallback', from: { model: 'm1' }, to: { model: 'm2' } },
      { type: 'text', text: 'continued' },
      { type: 'tool_use', id: 't1', name: 'x', input: {} },
    ];
    expect(replayableContent(content as never).map(block => block.type)).toEqual(['text', 'fallback', 'text', 'tool_use']);
    const messages = toAnthropicMessages([
      { role: 'assistant', text: 'x', toolCalls: [], native: { api: 'anthropic-messages', content } },
      { role: 'tool', results: [{ toolCallId: 't1', name: 'x', content: 'ok', isError: false }] },
    ]);
    expect(messages[1]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] });
  });
});

describe('OpenAI-compatible usage (FR-04)', () => {
  const textStream = (usageChunks: unknown[]) => sse([
    { choices: [{ delta: { content: 'ok' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ...usageChunks,
    '[DONE]',
  ]);
  const run = (baseUrl: string, fetch: FetchLike, system = '') => createProvider(connection({ baseUrl }), undefined, fetch)
    .complete({ system, messages: [{ role: 'user', text: 'hi' }], tools: [] });

  it('requests include_usage and reads usage from the final chunk after null-usage chunks', async () => {
    const { fetch, requests } = fakeFetch(() => textStream([
      { choices: [], usage: null },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } } },
    ]));
    const result = await run('http://127.0.0.1:9201/v1', fetch);
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({ stream_options: { include_usage: true } });
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 5, cachedInputTokens: 4 });
    expect(requests).toHaveLength(1);
  });

  it('reads input_tokens/output_tokens and nested usage on the last delta', async () => {
    const top = await run('http://127.0.0.1:9202/v1', fakeFetch(() => textStream([{ choices: [], usage: { input_tokens: 3, output_tokens: 2 } }])).fetch);
    expect(top.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
    const nested = await run('http://127.0.0.1:9203/v1', fakeFetch(() => sse([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop', usage: { prompt_tokens: 7, completion_tokens: 1 } }] },
      '[DONE]',
    ])).fetch);
    expect(nested.usage).toEqual({ inputTokens: 7, outputTokens: 1 });
  });

  it('merges usage split across chunks and ignores malformed counts', async () => {
    const result = await run('http://127.0.0.1:9204/v1', fakeFetch(() => textStream([
      { choices: [], usage: { prompt_tokens: 9, completion_tokens: '4' } },
      { choices: [], usage: { completion_tokens: 6 } },
    ])).fetch);
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 6 });
  });

  it('keeps usage unknown, never zero, when the server reports none', async () => {
    const result = await run('http://127.0.0.1:9205/v1', fakeFetch(() => textStream([{ choices: [], usage: null }])).fetch);
    expect(result.usage).toBeUndefined();
    const empty = await run('http://127.0.0.1:9206/v1', fakeFetch(() => textStream([{ choices: [], usage: {} }])).fetch);
    expect(empty.usage).toBeUndefined();
  });

  it('retries once without stream_options after a 400 and remembers that per base URL', async () => {
    const { fetch, requests } = fakeFetch(request => JSON.parse(String(request.init?.body)).stream_options
      ? Response.json({ error: { message: 'Unrecognized request argument supplied: stream_options' } }, { status: 400 })
      : textStream([]));
    const provider = createProvider(connection({ baseUrl: 'http://127.0.0.1:9207/v1' }), undefined, fetch);
    const input = { system: '', messages: [{ role: 'user' as const, text: 'hi' }], tools: [] };

    const first = await provider.complete(input);
    expect(first.text).toBe('ok');
    expect(first.usage).toBeUndefined();
    expect(requests.map(request => 'stream_options' in JSON.parse(String(request.init?.body)))).toEqual([true, false]);

    await provider.complete(input);
    expect(requests).toHaveLength(3);
    expect('stream_options' in JSON.parse(String(requests[2]?.init?.body))).toBe(false);
  });

  it('does not retry other 400s and surfaces them', async () => {
    const { fetch, requests } = fakeFetch(() => Response.json({ error: { message: "This model's maximum context length is 8192 tokens." } }, { status: 400 }));
    await expect(run('http://127.0.0.1:9208/v1', fetch)).rejects.toThrow(/returned 400: This model's maximum context length/);
    expect(requests).toHaveLength(1);
  });

  it('does not memorize stream_options rejection when the plain retry also fails', async () => {
    const { fetch, requests } = fakeFetch(request => JSON.parse(String(request.init?.body)).stream_options
      ? Response.json({ error: { message: 'stream_options is not supported' } }, { status: 400 })
      : Response.json({ error: { message: 'upstream down' } }, { status: 500 }));
    const provider = createProvider(connection({ baseUrl: 'http://127.0.0.1:9209/v1' }), undefined, fetch);
    await expect(provider.complete({ system: '', messages: [], tools: [] })).rejects.toThrow(/returned 500: upstream down/);
    expect(requests).toHaveLength(2);
    await expect(provider.complete({ system: '', messages: [], tools: [] })).rejects.toThrow(/returned 500/);
    expect(requests).toHaveLength(4);
    expect('stream_options' in JSON.parse(String(requests[2]?.init?.body))).toBe(true);
  });

  it('reads usage from a non-streamed JSON answer', async () => {
    const { fetch } = fakeFetch(() => Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } }));
    const result = await run('http://127.0.0.1:9210/v1', fetch);
    expect(result).toMatchObject({ text: 'ok', usage: { inputTokens: 4, outputTokens: 2 } });
  });
});
