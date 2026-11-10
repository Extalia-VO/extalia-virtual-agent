import { describe, expect, it, vi } from 'vitest';
import type { EventBody } from '@extalia/protocol';
import { createProvider, ProviderError, runTurn, type AnyTool } from '../src/index.js';

const connection = { preset: 'custom' as const, api: 'openai-chat' as const, baseUrl: 'https://example.com/v1', model: 'fixture', features: { memory: 'off' as const, skills: 'off' as const } };
const toolCall = { id: 'write-1', type: 'function', function: { name: 'write_file', arguments: '{"path":"fixture.txt"}' } };

describe('Production OpenAI completion selection and tool safety', () => {
  it.each(['content_filter', 'length'] as const)('never executes valid tool JSON when the provider finishes with %s', async finish => {
    const fetch = vi.fn(async () => new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, ...toolCall }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''), { headers: { 'content-type': 'text/event-stream' } }));
    const provider = createProvider(connection, undefined, fetch);
    const result = await provider.complete({ system: 'sys', messages: [], tools: [] });
    expect(result.stop).toBe(finish === 'content_filter' ? 'refusal' : 'max_tokens');
    if (finish === 'content_filter') expect(result.toolCalls).toEqual([]);
    else expect(result.toolCalls).toEqual([{ id: 'write-1', name: 'write_file', input: {}, inputError: 'Tool arguments were truncated by the provider.' }]);
    const execute = vi.fn(async () => ({ ok: true, output: 'Unexpected execution' }));
    const tool: AnyTool = { name: 'write_file', description: 'Synthetic write', access: 'write', kind: 'edit',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      describe: () => ({ label: 'Synthetic write' }), run: execute };
    const events: EventBody[] = [];
    const turn = await runTurn({ provider, system: 'sys', history: [], prompt: 'Write the fixture.', tools: [tool],
      permissions: { fileWrite: 'ask', commands: 'ask' }, sessionGrants: new Set(), requestApproval: async () => 'once',
      signal: new AbortController().signal, emit: event => events.push(event) });
    expect(turn.outcome).toBe(finish === 'content_filter' ? 'refused' : 'failed');
    expect(execute).not.toHaveBeenCalled(); expect(events.some(event => event.type === 'tool.started')).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not fall back to JavaScript HTTP when an explicit native operation is uncertain', async () => {
    const fetch = vi.fn(async () => Response.json({ choices: [] }));
    const failure = new ProviderError('Native operation is uncertain.', undefined, false);
    const complete = vi.fn(async () => { throw failure; });
    const provider = createProvider(connection, undefined, fetch, undefined, complete);
    await expect(provider.complete({ system: '', messages: [], tools: [] })).rejects.toBe(failure);
    expect(complete).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  });
});
