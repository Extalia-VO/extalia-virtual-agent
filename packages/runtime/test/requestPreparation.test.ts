import { describe, expect, it } from 'vitest';
import type { EventBody } from '@extalia/protocol';
import { RequestBudgetError, runTurn, type AnyTool, type ModelMessage, type ModelProvider, type ModelRequest, type TurnOptions } from '../src/index.js';

const done = { text: 'Done.', toolCalls: [], stop: 'end' as const };
const read: AnyTool = { name: 'read', description: 'Read', parameters: { type: 'object', properties: {} }, access: 'meta', kind: 'read',
  describe: () => ({ label: 'Read' }), run: async () => ({ ok: true, output: 'data' }) };

function fixture() {
  const requests: ModelRequest[] = [], events: EventBody[] = [];
  const provider: ModelProvider = { api: 'openai-chat', listModels: async () => [], complete: async request => { requests.push(request); return done; } };
  const options: TurnOptions = { provider, system: 'base', history: [], prompt: 'First task', tools: [read],
    permissions: { fileWrite: 'ask', commands: 'ask' }, sessionGrants: new Set(), signal: new AbortController().signal,
    emit: event => { events.push(event); }, requestApproval: async () => 'reject' };
  return { requests, events, options };
}

describe('host request preparation', () => {
  it('refreshes after steering and every tool boundary without accumulating prior context or changing saved history', async () => {
    const f = fixture();
    let step = 0;
    f.options.provider.complete = async request => {
      f.requests.push(request);
      return step++ === 0 ? { text: '', toolCalls: [{ id: 'c1', name: 'read', input: {} }], stop: 'tool_use' } : done;
    };
    let boundaries = 0;
    f.options.takeSteering = async (_, boundary) => boundary === 'step' && boundaries++ === 1 ? ['New task'] : [];
    const seen: string[] = [];
    f.options.prepareRequest = async request => {
      expect(request.system).toBe('base');
      const latest = request.messages.filter((item): item is Extract<ModelMessage, { role: 'user' }> => item.role === 'user').at(-1)!.text;
      seen.push(latest);
      return `${request.system}\nprepared:${latest}`;
    };
    const result = await runTurn(f.options);
    expect(result.outcome).toBe('completed');
    expect(seen).toEqual(['First task', 'New task']);
    expect(f.requests.map(request => request.system)).toEqual(['base\nprepared:First task', 'base\nprepared:New task']);
    expect(JSON.stringify(result.history)).not.toContain('prepared:');
  });

  it('budgets the prepared context before entering a provider', async () => {
    const f = fixture();
    f.options.maxInputTokens = 100;
    f.options.prepareRequest = async () => 'x'.repeat(2000);
    const result = await runTurn(f.options);
    expect(result).toMatchObject({ outcome: 'failed', reason: 'context', error: 'native_context_limit' });
    expect(f.requests).toEqual([]);
  });

  it('retains explicit preparation budget refusals and sanitizes other failures', async () => {
    for (const error of [new RequestBudgetError('token-limit'), new Error('private source body')]) {
      const f = fixture(); f.options.prepareRequest = async () => { throw error; };
      const result = await runTurn(f.options);
      expect(result.outcome).toBe('failed');
      expect(f.requests).toEqual([]);
      expect(JSON.stringify(f.events)).not.toContain('private source body');
      if (error instanceof RequestBudgetError) expect(result.reason).toBe('context');
    }
  });

  it('waits for preparation to settle after cancellation and never enters inference', async () => {
    const f = fixture(), controller = new AbortController(); f.options.signal = controller.signal;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { f.options.prepareRequest = async () => { resolve(); await new Promise<void>(done => { release = done; }); return 'late'; }; });
    const pending = runTurn(f.options); await entered; controller.abort();
    let settled = false; void pending.then(() => { settled = true; }); await Promise.resolve();
    expect(settled).toBe(false); release();
    expect((await pending).outcome).toBe('cancelled'); expect(f.requests).toEqual([]);
  });
});
