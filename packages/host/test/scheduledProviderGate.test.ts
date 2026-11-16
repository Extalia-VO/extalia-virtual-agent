import { describe, expect, it, vi } from 'vitest';
import { ProviderError, type ModelProvider, type ModelRequest, type ModelResult } from '@extalia/runtime';
import { createScheduledProviderGate } from '../src/scheduledProviderGate.js';

const request = (extra: Partial<ModelRequest> = {}): ModelRequest => ({ system: 'Fixture', messages: [{ role: 'user', text: 'Review.' }], tools: [], ...extra });
const answer: ModelResult = { text: 'Done.', toolCalls: [], stop: 'end' };
const socket = (code: string) => Object.assign(new Error('Fixture transport failure'), { code });
const provider = (complete: ModelProvider['complete']): ModelProvider => ({ api: 'openai-chat', complete, listModels: async () => ['fixture'] });

describe('first scheduled Native provider admission gate', () => {
  it.each([408, 429, 500, 502, 503, 504, undefined])('marks only a first retryable provider failure (%s) as a candidate', async status => {
    const failure = new ProviderError('Temporarily unavailable', status, true), onStarted = vi.fn();
    const gate = createScheduledProviderGate(provider(async () => { throw failure; }), { onStarted });
    await expect(gate.provider.complete(request())).rejects.toBe(failure);
    expect(gate.retryableBeforeResponse).toBe(true);
    expect(onStarted).not.toHaveBeenCalled();
    gate.settleAccepted(); await gate.started;
    expect(gate.retryableBeforeResponse).toBe(false);
    expect(onStarted).toHaveBeenCalledOnce();
  });

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'])('recognizes a trusted first socket failure %s without reading its message', async code => {
    const gate = createScheduledProviderGate(provider(async () => { throw new TypeError('fetch failed', { cause: socket(code) }); }));
    await expect(gate.provider.complete(request())).rejects.toThrow();
    expect(gate.retryableBeforeResponse).toBe(true);
  });

  it.each([
    new ProviderError('Authentication', 401, true), new ProviderError('Forbidden', 403, true),
    new ProviderError('Schema', 400, true), new ProviderError('Not retryable', 503, false),
    new Error('ECONNREFUSED'), { code: 'ENOTFOUND' }, new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }),
    new DOMException('Stopped', 'AbortError'), Object.assign(new Error('Stopped'), { name: 'APIUserAbortError', code: 'ETIMEDOUT' }),
  ])('releases unknown, auth, schema or cancellation failure without granting retry', async failure => {
    const onStarted = vi.fn(), gate = createScheduledProviderGate(provider(async () => { throw failure; }), { onStarted });
    await expect(gate.provider.complete(request())).rejects.toBe(failure);
    await gate.started;
    expect(gate.retryableBeforeResponse).toBe(false);
    expect(onStarted).toHaveBeenCalledOnce();
  });

  it('requires every aggregate failure to be trusted and rejects cyclic causes', async () => {
    for (const [failure, expected] of [
      [new AggregateError([socket('ECONNREFUSED'), socket('ENETUNREACH')]), true],
      [new AggregateError([socket('ENOTFOUND'), new Error('Unknown')]), false],
      [new AggregateError([]), false],
    ] as const) {
      const gate = createScheduledProviderGate(provider(async () => { throw failure; }));
      await expect(gate.provider.complete(request())).rejects.toBe(failure);
      expect(gate.retryableBeforeResponse).toBe(expected);
    }
    const cycle = new Error('Cycle'); cycle.cause = cycle;
    const gate = createScheduledProviderGate(provider(async () => { throw cycle; }));
    await expect(gate.provider.complete(request())).rejects.toBe(cycle);
    expect(gate.retryableBeforeResponse).toBe(false);
  });

  it('closes the window before a successful empty-text tool-call response is returned', async () => {
    const onStarted = vi.fn(), response: ModelResult = { text: '', toolCalls: [{ id: 'call-fixture', name: 'read_file', input: { path: 'README.md' } }], stop: 'tool_use' };
    const gate = createScheduledProviderGate(provider(async () => response), { onStarted });
    const result = await gate.provider.complete(request());
    expect(result).toBe(response); expect(onStarted).toHaveBeenCalledOnce();
    await gate.started; expect(gate.retryableBeforeResponse).toBe(false);
  });

  it('closes the window on partial text before a later failure and forwards the same signal', async () => {
    const controller = new AbortController(), onText = vi.fn(), onStarted = vi.fn();
    const gate = createScheduledProviderGate(provider(async input => {
      expect(input.signal).toBe(controller.signal);
      input.onText?.(' '); expect(onStarted).toHaveBeenCalledOnce();
      throw new ProviderError('Disconnected', 503, true);
    }), { onStarted });
    await expect(gate.provider.complete(request({ signal: controller.signal, onText }))).rejects.toThrow('Disconnected');
    expect(onText).toHaveBeenCalledWith(' '); expect(gate.retryableBeforeResponse).toBe(false);
  });

  it('does not treat caller callback failures as provider retry evidence', async () => {
    const failure = socket('ECONNRESET');
    const gate = createScheduledProviderGate(provider(async input => { input.onText?.(''); return answer; }));
    await expect(gate.provider.complete(request({ onText: () => { throw failure; } }))).rejects.toBe(failure);
    expect(gate.retryableBeforeResponse).toBe(false); await gate.started;
  });

  it('does not retry a later failure after any successful request', async () => {
    let calls = 0;
    const gate = createScheduledProviderGate(provider(async () => { if (calls++ === 0) return answer; throw new ProviderError('Disconnected', 503, true); }));
    await gate.provider.complete(request());
    await expect(gate.provider.complete(request())).rejects.toThrow('Disconnected');
    expect(gate.retryableBeforeResponse).toBe(false);
  });

  it('does not retain retry authority after a subsequent or concurrent request', async () => {
    let rejectFirst!: (error: Error) => void;
    const failure = new ProviderError('Disconnected', 503, true);
    let calls = 0;
    const gate = createScheduledProviderGate(provider(async () => calls++ === 0 ? new Promise<ModelResult>((_resolve, reject) => { rejectFirst = reject; }) : answer));
    const first = gate.provider.complete(request());
    await gate.provider.complete(request()); rejectFirst(failure);
    await expect(first).rejects.toBe(failure); expect(gate.retryableBeforeResponse).toBe(false);
  });

  it('does not grant retry after cancellation and ignores late callbacks from a settled adapter', async () => {
    const controller = new AbortController(), onText = vi.fn();
    const gate = createScheduledProviderGate(provider(async () => { controller.abort(); throw socket('ECONNRESET'); }));
    await expect(gate.provider.complete(request({ signal: controller.signal }))).rejects.toThrow();
    expect(gate.retryableBeforeResponse).toBe(false); await gate.started;
    let late!: (text: string) => void;
    const failed = createScheduledProviderGate(provider(async input => { late = input.onText!; throw socket('ENOTFOUND'); }));
    await expect(failed.provider.complete(request({ onText }))).rejects.toThrow();
    late('Too late'); expect(onText).not.toHaveBeenCalled(); expect(failed.retryableBeforeResponse).toBe(true);
  });

  it('preserves provider capabilities and bound methods; notifications cannot change model results', async () => {
    const original: ModelProvider = { api: 'anthropic-messages', images: false,
      complete: async function () { expect(this).toBe(original); return answer; },
      listModels: async function (signal) { expect(this).toBe(original); expect(signal).toBe(controller.signal); return ['fixture']; } };
    const controller = new AbortController();
    const onStarted = vi.fn(() => { throw new Error('Subscriber failure'); });
    const gate = createScheduledProviderGate(original, { onStarted });
    expect(gate.provider.api).toBe('anthropic-messages'); expect(gate.provider.images).toBe(false);
    expect(await gate.provider.listModels(controller.signal)).toEqual(['fixture']);
    expect(await gate.provider.complete(request())).toBe(answer); gate.settleAccepted();
    expect(onStarted).toHaveBeenCalledOnce(); await gate.started;
  });
});
