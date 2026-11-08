import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentHostApi, ObservedCodexInputRequest, ObservedCodexStatus, SessionSummary } from '@extalia/platform';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { CodexQuestionCard, ObservedCodexControls, ObservedCodexControlsContent } from '../src/observe/ObservedCodexControls';
import { createObservedCodexControl } from '../src/observe/observedCodexModel';

const request = (): ObservedCodexInputRequest => ({ id: 'request', turnId: 'turn', itemId: 'item', state: 'pending', questions: [
  { id: 'choice', header: 'Original header', question: 'Original question?', isOther: true, isSecret: false, options: [{ label: 'Option A', description: 'User content' }] },
  { id: 'secret', header: 'Secret header', question: 'Secret question?', isOther: false, isSecret: true, options: [] },
] });
const connected = (patch: Partial<ObservedCodexStatus> = {}): ObservedCodexStatus => ({ sessionId: 'session', state: 'connected', connectionId: 'connection', threadId: 'original-thread', canSend: true, canAnswer: true, requests: [], ...patch });
const disconnected = (): ObservedCodexStatus => ({ sessionId: 'session', state: 'disconnected', canSend: false, canAnswer: false, requests: [] });
const host = () => ({
  observedCodexStatus: vi.fn(async () => disconnected()), connectObservedCodex: vi.fn(async () => connected()),
  disconnectObservedCodex: vi.fn(async () => disconnected()), sendObservedCodexMessage: vi.fn(async () => connected({ delivery: 'submitted' })),
  answerObservedCodexInput: vi.fn(async () => connected({ delivery: 'submitted' })),
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
const controls: (() => void)[] = [];
function setup(api = host()) {
  const model = createObservedCodexControl(api as unknown as AgentHostApi, 'session');
  controls.push(model.start());
  return { api, model };
}
afterEach(() => { controls.splice(0).forEach(stop => stop()); vi.useRealTimers(); });

describe('observed Codex explicit control', () => {
  it('only reads status on mount and never auto-connects, spawns, sends or answers', async () => {
    vi.useFakeTimers();
    const { api, model } = setup(); await settle();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(api.observedCodexStatus).toHaveBeenCalledTimes(1);
    expect(api.connectObservedCodex).not.toHaveBeenCalled();
    expect(api.sendObservedCodexMessage).not.toHaveBeenCalled();
    expect(api.answerObservedCodexInput).not.toHaveBeenCalled();
    expect(model.getSnapshot().status?.state).toBe('disconnected');
  });
  it('polls only connected sessions; poll failure removes capabilities and pending questions without retry', async () => {
    vi.useFakeTimers();
    const api = host(); api.observedCodexStatus.mockResolvedValueOnce(connected({ requests: [request()] }));
    const { model } = setup(api); await settle();
    api.observedCodexStatus.mockRejectedValueOnce(new Error('offline'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(model.getSnapshot()).toMatchObject({ phase: 'error', status: undefined });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.observedCodexStatus).toHaveBeenCalledTimes(2);
    await model.answer(request(), { choice: 'Option A', secret: 'answer' });
    expect(api.answerObservedCodexInput).not.toHaveBeenCalled();
  });
  it('rejects late old reads after an explicit disconnect and after session disposal', async () => {
    const api = host(); api.observedCodexStatus.mockResolvedValueOnce(connected());
    const { model } = setup(api); await settle();
    const read = deferred<ObservedCodexStatus>(); api.observedCodexStatus.mockReturnValueOnce(read.promise);
    const pending = model.refresh(); await model.disconnect();
    read.resolve(connected()); await pending;
    expect(model.getSnapshot().status?.state).toBe('disconnected');
    const late = deferred<ObservedCodexStatus>(); api.observedCodexStatus.mockReturnValueOnce(late.promise);
    const last = model.refresh(); controls.pop()!(); late.resolve(connected()); await last;
    expect(model.getSnapshot().status?.state).toBe('disconnected');
  });
  it('keeps failed drafts, prevents duplicate sends and clears only the submitted draft generation', async () => {
    const { api, model } = setup(); await settle(); await model.connect('/tmp/codex.sock');
    model.setDraft('first draft');
    const send = deferred<ObservedCodexStatus>(); api.sendObservedCodexMessage.mockReturnValueOnce(send.promise);
    const first = model.send(); await model.send();
    expect(api.sendObservedCodexMessage).toHaveBeenCalledTimes(1);
    model.setDraft('new draft'); send.resolve(connected()); await first;
    expect(model.getSnapshot().draft).toBe('new draft');
    api.sendObservedCodexMessage.mockRejectedValueOnce(new Error('send failed')); await model.send();
    expect(model.getSnapshot().draft).toBe('new draft');
    expect(model.getSnapshot().status).toBeUndefined();
    await model.connect('/tmp/codex.sock'); await model.send();
    expect(model.getSnapshot().draft).toBe('');
  });
  it('retains drafts when a resolved host call reports unavailable or uncertain delivery', async () => {
    const { api, model } = setup(); await settle(); await model.connect('/tmp/codex.sock');
    model.setDraft('keep until confirmed');
    api.sendObservedCodexMessage.mockResolvedValueOnce({ ...disconnected(), state: 'unavailable' }); await model.send();
    expect(model.getSnapshot().draft).toBe('keep until confirmed');
    await model.connect('/tmp/codex.sock');
    api.sendObservedCodexMessage.mockResolvedValueOnce(connected({ delivery: 'unknown' })); await model.send();
    expect(model.getSnapshot().draft).toBe('keep until confirmed');
  });
  it('steers the exact active turn while idle sends omit the turn identifier', async () => {
    const { api, model } = setup(); await settle();
    api.connectObservedCodex.mockResolvedValueOnce(connected({ activeTurnId: 'current-turn' }));
    await model.connect('/tmp/codex.sock'); model.setDraft('steer'); await model.send();
    expect(api.sendObservedCodexMessage.mock.calls[0]).toEqual(['session', { connectionId: 'connection', text: 'steer', activeTurnId: 'current-turn' }]);
    model.setDraft('idle'); await model.send();
    expect(api.sendObservedCodexMessage.mock.calls[1]).toEqual(['session', { connectionId: 'connection', text: 'idle' }]);
  });
  it('rejects expired or changed questions, incomplete answers, and duplicate submission', async () => {
    const api = host(); api.observedCodexStatus.mockResolvedValueOnce(connected({ requests: [request()] }));
    const { model } = setup(api); await settle();
    await model.answer(request(), { choice: 'Option A' });
    expect(api.answerObservedCodexInput).not.toHaveBeenCalled();
    const changed = request(); changed.questions[0]!.question = 'Changed question?';
    await model.answer(changed, { choice: 'Option A', secret: 'secret' });
    expect(api.answerObservedCodexInput).not.toHaveBeenCalled();
    api.answerObservedCodexInput.mockResolvedValueOnce(connected({ requests: [request()] }));
    await model.answer(request(), { choice: 'Option A', secret: 'secret' });
    expect(model.getSnapshot().status?.requests[0]?.state).toBe('submitted');
    await model.answer(request(), { choice: 'Option A', secret: 'secret' });
    expect(api.answerObservedCodexInput).toHaveBeenCalledTimes(1);
    api.observedCodexStatus.mockResolvedValueOnce(connected({ requests: [] })); await model.refresh();
    await model.answer(request(), { choice: 'Option A', secret: 'secret' });
    expect(api.answerObservedCodexInput).toHaveBeenCalledTimes(1);
  });
  it('fails closed on malformed question data rather than rendering actionable partial controls', async () => {
    const api = host(); api.observedCodexStatus.mockResolvedValueOnce(connected({ requests: [{ ...request(), questions: [null] } as unknown as ObservedCodexInputRequest] }));
    const { model } = setup(api); await settle();
    expect(model.getSnapshot()).toMatchObject({ phase: 'error', status: undefined });
  });
  it('fails closed on foreign-session responses and gracefully handles older hosts', async () => {
    const api = host(); api.observedCodexStatus.mockResolvedValueOnce(connected({ sessionId: 'another-session' }));
    const { model } = setup(api); await settle();
    expect(model.getSnapshot()).toMatchObject({ phase: 'error', status: undefined });
    const unsupported = createObservedCodexControl({} as AgentHostApi, 'session');
    const stop = unsupported.start(); await unsupported.connect('/tmp/codex.sock');
    expect(unsupported.getSnapshot().phase).toBe('unsupported'); stop();
  });
});

describe('observed Codex presentation', () => {
  it('renders only observed Codex source and makes no network call during rendering', () => {
    const api = host();
    for (const source of ['claude', 'hermes', 'gemini']) {
      const session = { id: 'session', control: 'observed', observation: { sourceId: source } } as SessionSummary;
      expect(renderToStaticMarkup(createElement(ObservedCodexControls, { t: MESSAGES.en, agents: api as unknown as AgentHostApi, session }))).toBe('');
    }
    const session = { id: 'session', control: 'observed', observation: { sourceId: 'codex' } } as SessionSummary;
    const html = renderToStaticMarkup(createElement(ObservedCodexControls, { t: MESSAGES.en, agents: api as unknown as AgentHostApi, session }));
    expect(html).toContain('Connect existing Codex server');
    expect(html).toContain('may not expose a supported public endpoint');
    expect(api.observedCodexStatus).not.toHaveBeenCalled();
    expect(api.connectObservedCodex).not.toHaveBeenCalled();
  });
  it('preserves original questions with no preselected answer and password freeform fields in both languages', () => {
    for (const language of ['en', 'id'] as const) {
      const html = renderToStaticMarkup(createElement(CodexQuestionCard, { t: MESSAGES[language], request: request(), disabled: false, onAnswer: vi.fn() }));
      expect(html).toContain('Original header'); expect(html).toContain('Original question?'); expect(html).toContain('User content');
      expect(html).toContain('type="password"'); expect(html).not.toContain('checked=""');
      expect(html).toContain(MESSAGES[language].observedCodex.answer);
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>/);
    }
  });
  it('shows original thread metadata and neutral submitted/resolved evidence', () => {
    const model = createObservedCodexControl(host() as unknown as AgentHostApi, 'session');
    for (const delivery of ['submitted', 'resolved'] as const) {
      const html = renderToStaticMarkup(createElement(ObservedCodexControlsContent, { t: MESSAGES.en, control: model,
        view: { phase: 'ready', draft: '', status: connected({ delivery, requests: [{ ...request(), state: 'submitted' }] }) } }));
      expect(html).toContain('original-thread'); expect(html).toContain('Connected to the original conversation');
      expect(html).not.toContain('accepted'); expect(html).not.toContain('Submit answer');
      expect(html).toContain(MESSAGES.en.observedCodex[delivery]);
    }
  });
});
