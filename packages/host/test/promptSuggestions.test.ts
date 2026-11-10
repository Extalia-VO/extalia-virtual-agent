import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEvent, type EventBody } from '@extalia/protocol';
import type { ModelProvider, ModelResult } from '@extalia/runtime';
import { normalizePromptSuggestions, PromptSuggestionsService } from '../src/promptSuggestions.js';

const result = (prompts: string[] = ['Review the remaining parser edge cases.']): ModelResult => ({
  text: JSON.stringify({ prompts }), stop: 'end', toolCalls: [], usage: { inputTokens: 15, outputTokens: 7 },
});
const provider = (response: ModelResult = result()): ModelProvider => ({ api: 'openai-chat', listModels: async () => [], complete: vi.fn(async () => response) });
function delayed() {
  let resolve!: (response: ModelResult) => void;
  const promise = new Promise<ModelResult>(done => { resolve = done; });
  const model: ModelProvider = { api: 'openai-chat', listModels: async () => [], complete: vi.fn(() => promise) };
  return { model, resolve };
}
const event = (body: EventBody, extra: { agentId?: string; taskId?: string; id?: string } = {}) => createEvent({
  sessionId: 'session-one', agentId: 'primary', source: { runtime: 'codex', channel: 'hook' }, body, ...extra,
});
const setup = (service: PromptSuggestionsService, model = provider(), extra = {}) => {
  service.completed('session-one', 'completed-one');
  return { sessionId: 'session-one', anchor: 'completed-one', provider: model, prompt: 'Fix the parser.', answer: 'The parser now rejects missing fields.', isCurrent: () => true, ...extra };
};
const flush = async () => { for (let index = 0; index < 5; index++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe('ephemeral prompt suggestions', () => {
  it('offers prepared Native context without inference and requests only the exact completion once', async () => {
    const service = new PromptSuggestionsService(), model = provider();
    service.prepareNative(setup(service, model));
    const offered = { sessionId: 'session-one', anchor: 'completed-one', state: 'unavailable', prompts: [], origin: 'native', canRequest: true };
    expect(service.status('session-one')).toEqual(offered);
    expect(service.status('session-one')).toEqual(offered);
    expect(service.pendingCount).toBe(0); expect(model.complete).not.toHaveBeenCalled();
    expect(service.requestNative('session-one', 'older-anchor')).toEqual(offered);
    expect(model.complete).not.toHaveBeenCalled();
    expect(service.requestNative('session-one', 'completed-one')).toMatchObject({ state: 'pending', anchor: 'completed-one', canRequest: false });
    service.requestNative('session-one', 'completed-one');
    await flush();
    expect(service.status('session-one').state).toBe('ready');
    service.requestNative('session-one', 'completed-one');
    expect(model.complete).toHaveBeenCalledTimes(1);
    service.close();
  });

  it('captures only bounded redacted data at preparation rather than retaining mutable task arrays', async () => {
    const service = new PromptSuggestionsService(), model = provider();
    const evidence = [{ name: 'read_file', toolCallId: 'one', content: 'password=synthetic-secret ' + 'a'.repeat(30_000), isError: false }];
    const request = setup(service, model, { prompt: '"'.repeat(40_000), answer: '\\'.repeat(40_000), evidence });
    service.prepareNative(request);
    request.prompt = 'Mutated prompt after preparation.'; request.answer = 'Mutated answer after preparation.';
    evidence[0]!.content = 'Mutated evidence after preparation.';
    expect(model.complete).not.toHaveBeenCalled();
    service.requestNative('session-one', 'completed-one'); await flush();
    const message = vi.mocked(model.complete).mock.calls[0]![0].messages[0]!;
    if (message.role !== 'user') throw new Error('Expected one user-data message.');
    expect(message.text.length).toBeLessThanOrEqual(12_000);
    expect(() => JSON.parse(message.text)).not.toThrow();
    expect(message.text).not.toContain('synthetic-secret'); expect(message.text).not.toContain('Mutated');
    service.close();
  });

  it('preserves prepared offers while global or same-session physical capacity is unavailable', async () => {
    const service = new PromptSuggestionsService({ maxPending: 1 }), first = delayed(), next = provider();
    const request = setup(service, first.model);
    service.runNative(request);
    service.completed('session-two', 'completed-two');
    service.prepareNative({ ...request, provider: next, sessionId: 'session-two', anchor: 'completed-two' });
    expect(service.status('session-two')).toMatchObject({ anchor: 'completed-two', canRequest: false });
    service.requestNative('session-two', 'completed-two'); expect(next.complete).not.toHaveBeenCalled();
    service.invalidate('session-one');
    service.completed('session-one', 'replacement');
    service.prepareNative({ ...request, provider: next, anchor: 'replacement' });
    expect(service.status('session-one').canRequest).toBe(false);
    expect(service.pendingCount).toBe(1);
    first.resolve(result()); await flush();
    expect(service.status('session-two').canRequest).toBe(true);
    expect(service.status('session-one').canRequest).toBe(true);
    service.requestNative('session-two', 'completed-two'); await flush();
    expect(next.complete).toHaveBeenCalledTimes(1);
    service.close();
  });

  it('bounds retained prepared snapshots and retains recently inspected offers', async () => {
    const service = new PromptSuggestionsService(), model = provider();
    service.prepareNative(setup(service, model));
    for (let index = 0; index < 255; index++) service.completed(`other-${index}`, `anchor-${index}`);
    expect(service.status('session-one').canRequest).toBe(true);
    service.completed('newest', 'newest-anchor');
    expect(service.status('other-0').anchor).toBeUndefined();
    expect(service.requestNative('session-one', 'completed-one').state).toBe('pending');
    await flush(); expect(model.complete).toHaveBeenCalledTimes(1);
    service.close();
  });

  it.each(['new-turn', 'cancel', 'stale', 'privacy', 'close'] as const)('drops an unrequested prepared context on %s', mode => {
    const service = new PromptSuggestionsService(), model = provider(), controller = new AbortController();
    let current = true;
    service.prepareNative(setup(service, model, { signal: controller.signal, isCurrent: () => current }));
    if (mode === 'new-turn') service.observeEvent(event({ type: 'prompt.submitted', text: 'New task.', via: 'extalia' }));
    if (mode === 'cancel') controller.abort();
    if (mode === 'stale') current = false;
    if (mode === 'privacy') service.invalidatePrivacy();
    if (mode === 'close') service.close();
    expect(service.status('session-one').canRequest).toBe(false);
    service.requestNative('session-one', 'completed-one');
    expect(model.complete).not.toHaveBeenCalled(); expect(service.pendingCount).toBe(0);
    service.close();
  });

  it('uses one tools-free request and keeps exact completion anchor and actual usage', async () => {
    const service = new PromptSuggestionsService(), model = provider();
    const request = setup(service, model);
    service.runNative(request);
    expect(service.status('session-one')).toMatchObject({ state: 'pending', anchor: 'completed-one', canRequest: false });
    await flush();
    expect(service.status('session-one')).toEqual({ sessionId: 'session-one', anchor: 'completed-one', state: 'ready', prompts: ['Review the remaining parser edge cases.'], origin: 'native', canRequest: false, usage: { inputTokens: 15, outputTokens: 7 } });
    expect(model.complete).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(model.complete).mock.calls[0]![0];
    expect(sent.tools).toEqual([]); expect(sent.onText).toBeUndefined();
    expect(sent.messages).toEqual([{ role: 'user', text: JSON.stringify({ prompt: request.prompt, answer: request.answer, evidence: [] }) }]);
    expect(sent.system).toContain('untrusted');
    service.runNative(request); expect(model.complete).toHaveBeenCalledTimes(1);
    const snapshot = service.status('session-one'); snapshot.prompts.push('mutated');
    expect(service.status('session-one').prompts).toHaveLength(1);
  });

  it('bounds and redacts JSON input without forwarding failed evidence, tools or native history', async () => {
    const service = new PromptSuggestionsService(), model = provider();
    service.runNative(setup(service, model, {
      prompt: '"'.repeat(40_000), answer: '\\'.repeat(40_000),
      evidence: [{ name: 'read_file', toolCallId: 'a', content: 'password=synthetic-secret ' + 'x'.repeat(20_000), isError: false },
        { name: 'failed', toolCallId: 'b', content: 'do not forward', isError: true }],
    }));
    await flush();
    const sent = vi.mocked(model.complete).mock.calls[0]![0];
    const message = sent.messages[0]!;
    if (message.role !== 'user') throw new Error('Expected one user-data message.');
    const text = message.text;
    expect(text.length).toBeLessThanOrEqual(12_000); expect(() => JSON.parse(text)).not.toThrow();
    expect(text).not.toContain('synthetic-secret'); expect(text).not.toContain('do not forward');
    service.close();
  });

  it.each([
    { ...result(), text: 'not JSON' },
    { ...result(), text: '{"prompts":[],"extra":true}' },
    { ...result(), text: '{"prompts":["same","Same"]}' },
    { ...result(), text: '{"prompts":["line\\nline"]}' },
    { ...result(), text: JSON.stringify({ prompts: ['x'.repeat(241)] }) },
    { ...result(), stop: 'refusal' as const, refusal: 'Declined.' },
    { ...result(), stop: 'max_tokens' as const },
    { ...result(), toolCalls: [{ id: 'forbidden', name: 'read_file', input: {} }] },
  ])('rejects invalid generation without retrying: %j', async response => {
    const service = new PromptSuggestionsService(), model = provider(response);
    const request = setup(service, model); service.runNative(request); await flush();
    expect(service.status('session-one')).toMatchObject({ state: 'unavailable', prompts: [] });
    service.runNative(request); expect(model.complete).toHaveBeenCalledTimes(1); service.close();
  });

  it('accepts zero prompts and never invents usage', async () => {
    const service = new PromptSuggestionsService(), response = result([]); delete response.usage;
    service.runNative(setup(service, provider(response))); await flush();
    expect(service.status('session-one')).toMatchObject({ state: 'ready', prompts: [] });
    expect(service.status('session-one').usage).toBeUndefined();
    expect(normalizePromptSuggestions(['  Continue the review.  '])).toEqual(['Continue the review.']);
  });

  it('revokes publication at the deadline but keeps the actual request pending until settlement', async () => {
    vi.useFakeTimers();
    const service = new PromptSuggestionsService({ timeoutMs: 10 }), delayedModel = delayed();
    service.runNative(setup(service, delayedModel.model));
    expect(service.pendingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(service.status('session-one')).toMatchObject({ state: 'unavailable', prompts: [] });
    const sent = vi.mocked(delayedModel.model.complete).mock.calls[0]![0];
    expect(sent.signal?.aborted).toBe(true); expect(service.pendingCount).toBe(1);
    delayedModel.resolve(result()); await flush();
    expect(service.pendingCount).toBe(0); expect(service.status('session-one').prompts).toEqual([]);
  });

  it.each([
    { options: {}, deadline: 8_000 },
    { options: { timeoutMs: 30_000 }, deadline: 12_000 },
    { options: { timeoutMs: 0 }, deadline: 1 },
  ])('bounds background publication lifetime to $deadline milliseconds', async ({ options, deadline }) => {
    vi.useFakeTimers();
    const service = new PromptSuggestionsService(options), delayedModel = delayed();
    service.runNative(setup(service, delayedModel.model));
    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect(service.status('session-one').state).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(service.status('session-one').state).toBe('unavailable');
    expect(service.pendingCount).toBe(1);
    delayedModel.resolve(result()); await flush();
    expect(service.pendingCount).toBe(0);
    service.close();
  });

  it.each(['new-turn', 'cancel', 'queue', 'privacy', 'close'] as const)('rejects an abort-ignoring late result after %s', async mode => {
    const service = new PromptSuggestionsService(), delayedModel = delayed(), controller = new AbortController();
    let current = true;
    service.runNative(setup(service, delayedModel.model, { signal: controller.signal, isCurrent: () => current }));
    if (mode === 'new-turn') service.observeEvent(event({ type: 'prompt.submitted', text: 'New task.', via: 'native' }));
    if (mode === 'cancel') controller.abort();
    if (mode === 'queue') current = false;
    if (mode === 'privacy') service.invalidatePrivacy();
    if (mode === 'close') service.close();
    delayedModel.resolve(result()); await flush();
    expect(service.status('session-one').prompts).toEqual([]); expect(service.pendingCount).toBe(0);
    if (mode === 'privacy') expect(service.status('session-one').state).toBe('private');
  });

  it('refuses stale/uncompleted/cancelled requests and caps actual in-flight work globally and per session', async () => {
    const service = new PromptSuggestionsService({ maxPending: 2 }), delayedModel = delayed();
    const request = setup(service, delayedModel.model);
    service.runNative({ ...request, anchor: 'stale' });
    service.runNative({ ...request, isCurrent: () => false });
    service.runNative({ ...request, signal: AbortSignal.abort() });
    expect(delayedModel.model.complete).not.toHaveBeenCalled();
    service.runNative(request);
    service.invalidate('session-one'); service.completed('session-one', 'completed-two');
    service.runNative({ ...request, anchor: 'completed-two' });
    service.completed('session-two', 'two'); service.runNative({ ...request, sessionId: 'session-two', anchor: 'two' });
    service.completed('session-three', 'three'); service.runNative({ ...request, sessionId: 'session-three', anchor: 'three' });
    expect(delayedModel.model.complete).toHaveBeenCalledTimes(2); expect(service.pendingCount).toBe(2);
    service.close(); expect(service.pendingCount).toBe(2);
    delayedModel.resolve(result()); await flush(); expect(service.pendingCount).toBe(0);
  });

  it('stages harness reports until exact primary completion, keeping active-turn reports across thinking', () => {
    const service = new PromptSuggestionsService();
    service.observeEvent(event({ type: 'prompt.submitted', text: 'Task.', via: 'native' }));
    service.report('session-one', ['Check the reported result.']);
    service.observeEvent(event({ type: 'model.thinking' }));
    expect(service.status('session-one')).toMatchObject({ prompts: [], origin: 'harness' });
    service.observeEvent(event({ type: 'turn.completed' }, { id: 'terminal-one', agentId: 'worker' }));
    expect(service.status('session-one').anchor).toBeUndefined();
    service.observeEvent(event({ type: 'turn.completed' }, { id: 'terminal-one' }));
    expect(service.status('session-one')).toMatchObject({ anchor: 'terminal-one', state: 'ready', origin: 'harness', prompts: ['Check the reported result.'], canRequest: false });
    service.report('session-one', ['Inspect the next edge case.']);
    expect(service.status('session-one').prompts).toEqual(['Inspect the next edge case.']);
    service.observeEvent(event({ type: 'model.thinking' })); expect(service.status('session-one').prompts).toEqual([]);
    service.close();
  });

  it.each<EventBody>([
    { type: 'turn.failed', error: 'Failed.' }, { type: 'session.ended' }, { type: 'agent.stopped' },
    { type: 'user.intervention', action: 'cancel' }, { type: 'prompt.submitted', text: 'Next task.', via: 'extalia' },
  ])('clears staged reports and completed suggestions on %j', body => {
    const service = new PromptSuggestionsService();
    service.report('session-one', ['Check it.']); service.observeEvent(event(body));
    service.completed('session-one', 'later'); expect(service.status('session-one').prompts).toEqual([]);
    service.report('session-one', ['Review it.']); service.observeEvent(event(body));
    expect(service.status('session-one').prompts).toEqual([]);
    service.close();
  });

  it('checks current authorization when reading already-ready native suggestions', async () => {
    const service = new PromptSuggestionsService(); let current = true;
    service.runNative(setup(service, provider(), { isCurrent: () => current })); await flush();
    expect(service.status('session-one').state).toBe('ready');
    current = false; expect(service.status('session-one')).toMatchObject({ state: 'unavailable', prompts: [] });
    service.close();
  });
});
