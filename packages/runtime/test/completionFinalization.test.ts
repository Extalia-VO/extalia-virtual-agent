import { expect, it, vi } from 'vitest';
import type { EventBody } from '@extalia/protocol';
import { runTurn, type ModelProvider, type TurnOptions } from '../src/index.js';

function options(patch: Partial<TurnOptions> = {}): TurnOptions {
  const provider: ModelProvider = { api: 'openai-chat', listModels: async () => [], complete: async () => ({ text: 'Task finished.', toolCalls: [], stop: 'end' }) };
  return { provider, system: 'Example', history: [], prompt: 'Do the task', tools: [], permissions: { fileWrite: 'ask', commands: 'ask' },
    sessionGrants: new Set(), emit() {}, requestApproval: async () => 'reject', signal: new AbortController().signal, ...patch };
}

it('seals steering and awaits successful-task finalization before publishing terminal events', async () => {
  const events: EventBody[] = [], order: string[] = [];
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const running = runTurn(options({ emit: event => { events.push(event); },
    takeSteering: async (_history, boundary) => { order.push(boundary); return []; },
    beforeComplete: async result => {
      order.push('finalize');
      expect(result.outcome).toBe('completed');
      expect(result.history.at(-1)).toMatchObject({ role: 'assistant', text: 'Task finished.' });
      entered(); await held;
    },
  }));
  await ready;
  expect(order.slice(-3)).toEqual(['complete', 'stop', 'finalize']);
  expect(events.some(event => event.type === 'turn.completed' || event.type === 'agent.state' && event.state === 'idle')).toBe(false);
  release(); expect((await running).outcome).toBe('completed');
  expect(events.slice(-2)).toEqual([{ type: 'turn.completed' }, { type: 'agent.state', state: 'idle' }]);
});

it.each(['failed', 'refused', 'cancelled'] as const)('does not finalize %s work', async outcome => {
  const finalize = vi.fn(), controller = new AbortController();
  if (outcome === 'cancelled') controller.abort();
  const provider: ModelProvider = { api: 'openai-chat', listModels: async () => [], complete: async () => {
    if (outcome === 'failed') throw new Error('Provider unavailable');
    return { text: 'Refused', toolCalls: [], stop: 'refusal' };
  } };
  expect((await runTurn(options({ provider, signal: controller.signal, beforeComplete: finalize }))).outcome).toBe(outcome);
  expect(finalize).not.toHaveBeenCalled();
});

it('does not publish success when the host cannot durably finalize the task', async () => {
  const events: EventBody[] = [];
  await expect(runTurn(options({ emit: event => { events.push(event); }, beforeComplete: async () => { throw new Error('Persistence failed'); } })))
    .rejects.toThrow('Persistence failed');
  expect(events.some(event => event.type === 'turn.completed')).toBe(false);
});
