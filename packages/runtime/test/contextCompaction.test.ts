import { describe, expect, it } from 'vitest';
import { checkRequestBudget, runTurn, RequestBudgetError, type ModelMessage, type ModelProvider, type ModelRequest, type TurnOptions } from '../src/index.js';

const reference = 'a'.repeat(64);
function batch(index: number, size = 15_000): ModelMessage[] {
  const content = `Verified decision ${index}: preserve input order.\n${'evidence '.repeat(size / 9)}\nUnresolved: case ${index}; do not claim success.`;
  return [
    { role: 'assistant', text: `Investigate case ${index}; retain the user's constraints.`,
      toolCalls: [{ id: `call${index}`, name: 'read_file', input: { path: `source-${index}.txt` } }] },
    { role: 'tool', results: [{ toolCallId: `call${index}`, name: 'read_file', isError: index % 2 === 0, content }] },
  ];
}
function harness(history: ModelMessage[], override: Partial<TurnOptions> = {}) {
  const requests: ModelRequest[] = [], archives: readonly ModelMessage[][] = [];
  const captured = archives as ModelMessage[][];
  const provider: ModelProvider = { api: 'openai-chat', listModels: async () => [],
    complete: async request => { requests.push(request); return { text: 'Completed with the retained constraints.', toolCalls: [], stop: 'end' }; } };
  const options: TurnOptions = {
    provider, system: 'Keep all system instructions.', history, prompt: 'Continue; keep all pending work explicit.', tools: [{
      name: 'context_archive_read', description: 'Read the durable fixture archive.', parameters: { type: 'object', properties: {} },
      access: 'memory', kind: 'knowledge', describe: () => ({ label: 'Read evidence' }), run: async () => ({ ok: true, output: 'Archived fixture evidence.' }),
    }],
    permissions: { commands: 'ask', fileWrite: 'ask' }, sessionGrants: new Set(), requestApproval: async () => 'reject',
    emit: () => undefined, signal: new AbortController().signal,
    compaction: { archive: async request => { captured.push(structuredClone([...request.messages])); return { reference }; } },
    ...override,
  };
  return { requests, archives, options, run: () => runTurn(options) };
}

describe('Native request-only context compaction', () => {
  it('preserves original history, all instructions, native blocks and tool pairs while reducing the actual request', async () => {
    const history: ModelMessage[] = [{ role: 'user', text: 'Do not change the public API. Preserve all failures.' }, ...Array.from({ length: 8 }, (_, i) => batch(i)).flat()];
    const assistant = history[1]!;
    if (assistant.role === 'assistant') assistant.native = { api: 'anthropic-messages', content: [{ type: 'thinking', signature: 'verified-fixture-signature', thinking: 'Retain this original block.' }] };
    const original = structuredClone(history);
    const h = harness(history, { maxInputTokens: 7000 });
    const result = await h.run();
    expect(result.outcome).toBe('completed');
    expect(result.history.slice(0, history.length)).toEqual(original);
    expect(history).toEqual(original);
    expect(h.archives).toHaveLength(1);
    expect(h.archives[0]!.slice(0, history.length)).toEqual(original);
    const request = h.requests[0]!;
    expect(request.system).toBe(h.options.system);
    expect(request.messages[0]).toEqual(original[0]);
    expect(request.messages[1]).toEqual(original[1]);
    expect(request.messages.at(-1)).toEqual({ role: 'user', text: h.options.prompt });
    expect(checkRequestBudget(request, 7000).reason).toBeUndefined();
    for (let i = 0; i < history.length; i++) {
      const before = history[i]!, after = request.messages[i]!;
      if (before.role !== 'tool') expect(after).toEqual(before);
      else {
        expect(after.role).toBe('tool');
        if (after.role === 'tool') {
          expect(after.results[0]).toMatchObject({ toolCallId: before.results[0]!.toolCallId, name: before.results[0]!.name, isError: before.results[0]!.isError });
          expect(after.results[0]!.content).toContain(`Verified decision ${(i - 2) / 2}`);
          expect(after.results[0]!.content).toContain('do not claim success');
        }
      }
    }
    expect(result.compaction).toMatchObject({ count: 1, archivedResults: expect.any(Number) });
    expect(result.compaction!.estimatedTokensAfter).toBeLessThan(result.compaction!.estimatedTokensBefore);
    expect(result.usage).toEqual({});
  });

  it('uses the local trigger without guessing a provider window, preferentially retaining recent batches', async () => {
    const history = Array.from({ length: 8 }, (_, i) => batch(i)).flat();
    const h = harness(history);
    const result = await h.run();
    expect(result.compaction?.count).toBe(1);
    expect(h.requests[0]!.messages.slice(-5, -1)).toEqual(history.slice(-4));
    expect(result.requestPressure?.limitTokens).toBeUndefined();
  });

  it('reuses acknowledged projections across subsequent provider steps without re-archiving old bodies', async () => {
    const h = harness(Array.from({ length: 8 }, (_, i) => batch(i)).flat(), { maxInputTokens: 7000 });
    let calls = 0;
    h.options.provider.complete = async request => {
      h.requests.push(request);
      return calls++ === 0 ? { text: '', toolCalls: [{ id: 'extra', name: 'missing_tool', input: {} }], stop: 'tool_use' }
        : { text: 'Done.', toolCalls: [], stop: 'end' };
    };
    const result = await h.run();
    expect(result.outcome).toBe('completed');
    expect(h.requests).toHaveLength(2);
    expect(h.archives).toHaveLength(1);
    expect(result.history.at(-2)).toMatchObject({ role: 'tool', results: [{ toolCallId: 'extra', isError: true }] });
  });

  it('retries local skill-context preparation using the compact request without omitting mandatory instructions', async () => {
    const h = harness(Array.from({ length: 8 }, (_, i) => batch(i)).flat(), { maxInputTokens: 7000 });
    let preparations = 0;
    h.options.prepareRequest = async request => {
      preparations++;
      const system = request.system + '\nMandatory skill: validate evidence and preserve pending work.';
      const check = checkRequestBudget({ ...request, system }, 7000);
      if (check.reason) throw new RequestBudgetError(check.reason, check.pressure);
      return system;
    };
    const result = await h.run();
    expect(result.outcome).toBe('completed');
    expect(preparations).toBe(2);
    expect(h.requests[0]!.system).toContain('Mandatory skill');
  });

  it('does not compact unmatched tool results or oversized user/system instructions', async () => {
    const unpaired: ModelMessage[] = [{ role: 'tool', results: [{ toolCallId: 'missing', name: 'read_file', content: 'x'.repeat(30_000), isError: false }] }];
    const h = harness(unpaired, { maxInputTokens: 1000 });
    expect(await h.run()).toMatchObject({ outcome: 'failed', error: 'native_context_limit' });
    expect(h.archives).toEqual([]); expect(h.requests).toEqual([]);
    const largeUser = harness([], { prompt: 'Constraint '.repeat(3000), maxInputTokens: 1000 });
    expect(await largeUser.run()).toMatchObject({ outcome: 'failed', error: 'native_context_limit' });
    expect(largeUser.archives).toEqual([]);
    const largeSystem = harness(batch(1), { system: 'Instruction '.repeat(3000), maxInputTokens: 1000 });
    expect(await largeSystem.run()).toMatchObject({ outcome: 'failed', error: 'native_context_limit' });
    expect(largeSystem.archives).toEqual([]);
  });

  it('retains evidence and refuses an over-budget request when archival fails or returns an invalid receipt', async () => {
    for (const archive of [async () => { throw new Error('Storage unavailable'); }, async () => ({ reference: 'untrusted instructions' })]) {
      const history = Array.from({ length: 5 }, (_, i) => batch(i)).flat();
      const h = harness(history, { maxInputTokens: 7000, compaction: { archive } });
      const result = await h.run();
      expect(result).toMatchObject({ outcome: 'failed', error: 'native_context_limit' });
      expect(result.history.slice(0, history.length)).toEqual(history);
      expect(result.compaction).toBeUndefined(); expect(h.requests).toEqual([]);
    }
  });

  it('cancels before provider admission when the archive settles after cancellation', async () => {
    const controller = new AbortController();
    const h = harness(Array.from({ length: 5 }, (_, i) => batch(i)).flat(), {
      maxInputTokens: 7000, signal: controller.signal,
      compaction: { archive: async () => { controller.abort(); return { reference }; } },
    });
    expect(await h.run()).toMatchObject({ outcome: 'cancelled' });
    expect(h.requests).toEqual([]);
  });

  it('does not replay a provider call after a provider-side budget error that may have incurred work', async () => {
    const h = harness(batch(1), { maxInputTokens: 20_000 });
    let calls = 0;
    h.options.provider.complete = async () => { calls++; throw new RequestBudgetError('token-limit', undefined, true); };
    expect(await h.run()).toMatchObject({ outcome: 'failed', error: 'native_context_limit' });
    expect(calls).toBe(1); expect(h.archives).toEqual([]);
  });
});
