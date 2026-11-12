import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentHostApi, ObservedUserInputRequest, ObservedUserInputStatus, SessionSummary } from '@extalia/platform';
import { afterEach, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { ObservedInputAlert, ObservedInputCard, ObservedInputCards } from '../src/observe/ObservedInputCards';
import { ObservedInputContext } from '../src/observe/ObservedInputProvider';
import { createObservedInputControl, createObservedInputNoticeTracker, observedInputKey, observedInputAnswers, observedInputSource, validObservedInput } from '../src/observe/observedInputModel';

const session = (id = 'session', patch: Partial<SessionSummary> = {}): SessionSummary => ({ id, control: 'observed', observation: {
  sourceId: 'codex', nativeSessionId: `native-${id}`, watching: true, status: 'watching',
}, ...patch } as SessionSummary);
const request = (patch: Partial<ObservedUserInputRequest> = {}): ObservedUserInputRequest => ({ id: 'request', revision: 'revision', origin: 'codex-async',
  state: 'pending', canAnswer: true, questions: [{ id: 'question', title: 'Choose <script>bad()</script>', options: ['First', 'Second'], allowOther: true, isSecret: false }], ...patch });
const status = (patch: Partial<ObservedUserInputStatus> = {}): ObservedUserInputStatus => ({ sessionId: 'session', state: 'ready', requests: [request()], ...patch });
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const stops: Array<() => void> = [];
function setup(sessions = [session()]) {
  const api = { observedUserInputStatus: vi.fn(async (id: string) => status({ sessionId: id })),
    answerObservedUserInput: vi.fn(async (id: string) => status({ sessionId: id, requests: [request({ state: 'queued', canAnswer: false })] })) };
  const control = createObservedInputControl(api as unknown as AgentHostApi); control.setSessions(sessions); stops.push(control.start());
  const key = observedInputKey('session', observedInputSource(session()), request());
  return { api, control, key };
}
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.useRealTimers(); });

it('only polls watched observed Codex, bounded to 32 sessions and two physical reads', async () => {
  vi.useFakeTimers(); const gate = deferred<ObservedUserInputStatus>(); let current = 0, maximum = 0;
  const read = vi.fn(async (id: string) => { current++; maximum = Math.max(maximum, current); await gate.promise; current--; return status({ sessionId: id }); });
  const control = createObservedInputControl({ observedUserInputStatus: read } as unknown as AgentHostApi);
  control.setSessions([session('managed', { control: 'managed' }), session('paused', { observation: { ...session().observation!, watching: false } }),
    session('other', { observation: { ...session().observation!, sourceId: 'hermes' } }), ...Array.from({ length: 40 }, (_, i) => session(`s${i}`))]);
  stops.push(control.start()); await settle(); expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(10000); expect(read).toHaveBeenCalledTimes(2);
  gate.resolve(status()); await settle(); await settle(); await control.refresh();
  expect(maximum).toBe(2); expect(Object.keys(control.getSnapshot().entries)).toHaveLength(32);
  expect(read.mock.calls.every(([id]) => id.startsWith('s'))).toBe(true);
});

it('never auto-selects or sends and preserves the shared draft through poll updates', async () => {
  const { api, control, key } = setup(); await settle();
  expect(api.answerObservedUserInput).not.toHaveBeenCalled(); expect(control.getSnapshot().drafts).toEqual({});
  await control.answer('session', request()); expect(api.answerObservedUserInput).not.toHaveBeenCalled();
  control.setDraft(key, { choices: { question: 'other' }, texts: { question: 'Typed answer' } });
  await control.refresh(); expect(control.getSnapshot().drafts[key]?.texts.question).toBe('Typed answer');
  expect(observedInputAnswers(request(), control.getSnapshot().drafts[key])).toEqual({ question: 'Typed answer' });
});

it('dispatches once across duplicate cards, keeps queued receipts distinct and refreshes after answer', async () => {
  const { api, control, key } = setup(); await settle(); const result = deferred<ObservedUserInputStatus>();
  api.answerObservedUserInput.mockReturnValueOnce(result.promise);
  control.setDraft(key, { choices: { question: '1' }, texts: {} });
  const send = control.answer('session', request()); await control.answer('session', request());
  expect(api.answerObservedUserInput).toHaveBeenCalledExactlyOnceWith('session', { requestId: 'request', revision: 'revision', answers: { question: 'Second' } });
  expect(control.getSnapshot().busy).toBe(key);
  result.resolve(status({ requests: [request({ state: 'queued', canAnswer: false })] })); await send; await settle();
  expect(control.getSnapshot().entries.session?.requests[0]?.state).toBe('queued');
  await control.answer('session', request()); expect(api.answerObservedUserInput).toHaveBeenCalledTimes(1);
  expect(api.observedUserInputStatus.mock.calls.length).toBeGreaterThan(1);
});

it('blocks retries after ambiguous delivery even when a later read still says pending', async () => {
  const { api, control, key } = setup(); await settle(); control.setDraft(key, { choices: { question: '0' }, texts: {} });
  api.answerObservedUserInput.mockRejectedValueOnce(new Error('sensitive raw diagnostic'));
  await control.answer('session', request()); await settle();
  expect(control.getSnapshot().uncertain.has(key)).toBe(true);
  expect(JSON.stringify(control.getSnapshot())).not.toContain('sensitive');
  await control.answer('session', request()); expect(api.answerObservedUserInput).toHaveBeenCalledTimes(1);
});

it('retains unavailable requests read-only, but private responses clear questions and drafts', async () => {
  const { api, control, key } = setup(); await settle(); control.setDraft(key, { choices: {}, texts: { question: 'Secret draft' } });
  api.observedUserInputStatus.mockResolvedValueOnce(status({ state: 'unavailable', requests: [] })); await control.refresh();
  expect(control.getSnapshot().entries.session).toMatchObject({ phase: 'unavailable', requests: [{ id: 'request', canAnswer: false }] });
  expect(control.getSnapshot().drafts[key]).toBeDefined();
  api.observedUserInputStatus.mockResolvedValueOnce(status({ state: 'private' })); await control.refresh();
  expect(control.getSnapshot().entries.session).toMatchObject({ phase: 'private', requests: [] }); expect(control.getSnapshot().drafts).toEqual({});
});

it.each(['pause', 'delete', 'source', 'api', 'stop'] as const)('invalidates stale reads after %s and never enables obsolete answers', async action => {
  const { api, control } = setup(); await settle(); const late = deferred<ObservedUserInputStatus>();
  api.observedUserInputStatus.mockReturnValueOnce(late.promise); const read = control.refresh();
  if (action === 'pause') control.setSessions([session('session', { observation: { ...session().observation!, watching: false } })]);
  if (action === 'delete') control.setSessions([]);
  if (action === 'source') control.setSessions([session('session', { observation: { ...session().observation!, nativeSessionId: 'replacement' } })]);
  if (action === 'api') api.observedUserInputStatus = vi.fn(async () => status({ requests: [] }));
  if (action === 'stop') stops.pop()!();
  late.resolve(status({ requests: [request({ id: 'obsolete' })] })); await read; await settle();
  expect(control.getSnapshot().entries.session?.requests.some(item => item.id === 'obsolete' && item.canAnswer)).not.toBe(true);
  if (action === 'api') { await control.refresh(); expect(control.getSnapshot().entries.session?.requests[0]?.canAnswer).toBe(false); }
});

it('drops drafts when the stable request revision changes and rejects malformed status', async () => {
  const { api, control, key } = setup(); await settle(); control.setDraft(key, { choices: { question: '0' }, texts: {} });
  api.observedUserInputStatus.mockResolvedValueOnce(status({ requests: [request({ revision: 'new' })] })); await control.refresh();
  expect(control.getSnapshot().drafts).toEqual({});
  for (const bad of [status({ sessionId: 'foreign' }), status({ requests: [request(), request()] }), status({ requests: [request({ revision: '' })] })]) {
    expect(validObservedInput(bad, 'session')).toBe(false);
  }
});

it('baselines each startup source, notices only fresh revisions once and emits no question/answer text', async () => {
  const { control } = setup(); await settle(); const take = createObservedInputNoticeTracker();
  const entries = control.getSnapshot().entries;
  expect(take(entries)).toEqual([]); expect(take(entries)).toEqual([]);
  const fresh = { session: { ...entries.session!, requests: [request(), request({ id: 'new' })] } };
  expect(take(fresh)).toEqual([{ kind: 'observed-input', sessionId: 'session', requestId: 'new' }]); expect(take(fresh)).toEqual([]);
  expect(take({ late: { ...entries.session!, source: 'late-source' } })).toEqual([]);
  expect(take({ session: { ...fresh.session, requests: [request({ id: 'queued', state: 'queued' })] } })).toEqual([]);
});

it.each(['en', 'id'] as const)('renders explicit option/freeform/secret controls, safe question text and delivery states (%s)', language => {
  const t = MESSAGES[language]; const html = renderToStaticMarkup(createElement(ObservedInputCard, { t, request: request(), disabled: false, busy: false,
    uncertain: false, onDraft: vi.fn(), onSubmit: vi.fn() }));
  expect(html).toContain('&lt;script&gt;'); expect(html.match(/type="radio"/g)).toHaveLength(3);
  expect(html).not.toContain('checked=""'); expect(html).toContain(t.observedInput.emptyAnswer); expect(html).toContain('disabled=""');
  const secret = renderToStaticMarkup(createElement(ObservedInputCard, { t, request: request({ questions: [{ id: 'secret', title: 'Secret', options: [], allowOther: false, isSecret: true }] }),
    disabled: false, busy: false, uncertain: false, onDraft: vi.fn(), onSubmit: vi.fn() })); expect(secret).toContain('type="password"');
  for (const state of ['queued', 'submitted', 'unknown'] as const) {
    const markup = renderToStaticMarkup(createElement(ObservedInputCard, { t, request: request({ state }), disabled: false, busy: false,
      uncertain: false, onDraft: vi.fn(), onSubmit: vi.fn() })); expect(markup).toContain(t.observedInput[state]); expect(markup).not.toContain('type="submit"');
  }
});

it('gracefully omits cards/alerts outside the provider and exposes startup backlog in the global alert', async () => {
  expect(renderToStaticMarkup(createElement(ObservedInputCards, { t: MESSAGES.en, sessionId: 'session' }))).toBe('');
  expect(renderToStaticMarkup(createElement(ObservedInputAlert, { t: MESSAGES.en }))).toBe('');
  const { control } = setup(); await settle();
  const html = renderToStaticMarkup(createElement(ObservedInputContext, { value: { control, view: control.getSnapshot(), locate: vi.fn() } },
    createElement(ObservedInputAlert, { t: MESSAGES.en })));
  expect(html).toContain(MESSAGES.en.observedInput.alert(1)); expect(html).toContain(MESSAGES.en.observedInput.locate);
  expect(html).not.toContain('Choose');
});

it('an older status read cannot overwrite the answer receipt', async () => {
  const { api, control, key } = setup(); await settle(); const late = deferred<ObservedUserInputStatus>();
  api.observedUserInputStatus.mockReturnValueOnce(late.promise); const read = control.refresh();
  control.setDraft(key, { choices: { question: '0' }, texts: {} });
  await control.answer('session', request()); late.resolve(status()); await read; await settle();
  expect(control.getSnapshot().entries.session?.requests[0]?.state).toBe('queued');
});

it('a private status invalidates an in-flight answer response instead of restoring question text', async () => {
  const { api, control, key } = setup(); await settle(); const result = deferred<ObservedUserInputStatus>();
  api.answerObservedUserInput.mockReturnValueOnce(result.promise);
  control.setDraft(key, { choices: { question: '0' }, texts: {} }); const send = control.answer('session', request());
  api.observedUserInputStatus.mockResolvedValue(status({ state: 'private', requests: [] })); await control.refresh();
  result.resolve(status({ requests: [request({ state: 'queued' })] })); await send; await settle();
  expect(control.getSnapshot().entries.session).toMatchObject({ phase: 'private', requests: [] });
  expect(control.getSnapshot().drafts).toEqual({});
});

it('unrelated source changes preserve the delivery receipt of an admitted answer', async () => {
  const { api, control, key } = setup(); await settle(); const result = deferred<ObservedUserInputStatus>();
  api.answerObservedUserInput.mockReturnValueOnce(result.promise);
  control.setDraft(key, { choices: { question: '0' }, texts: {} }); const send = control.answer('session', request());
  control.setSessions([session(), session('new-session')]); await settle();
  result.resolve(status({ requests: [request({ state: 'queued' })] })); await send; await settle();
  expect(control.getSnapshot().entries.session?.requests[0]?.state).toBe('queued');
});

it('preserves native option descriptions without changing the answer labels', () => {
  const native = request({ origin: 'codex-native', questions: [{ id: 'question', title: 'Choose native behavior', options: ['First', 'Second'],
    optionDescriptions: ['Use <safe> defaults', ''], allowOther: false, isSecret: false }] });
  expect(validObservedInput(status({ requests: [native] }), 'session')).toBe(true);
  const html = renderToStaticMarkup(createElement(ObservedInputCard, { t: MESSAGES.en, request: native, disabled: false, busy: false,
    uncertain: false, onDraft: vi.fn(), onSubmit: vi.fn() }));
  expect(html).toContain('Use &lt;safe&gt; defaults'); expect(html).toContain('observed-input-option-description');
  expect(observedInputAnswers(native, { choices: { question: '0' }, texts: {} })).toEqual({ question: 'First' });
  for (const optionDescriptions of [['Only one'], ['Valid', 'x'.repeat(8193)]]) {
    expect(validObservedInput(status({ requests: [request({ questions: [{ ...native.questions[0]!, optionDescriptions }] })] }), 'session')).toBe(false);
  }
  expect(validObservedInput(status(), 'session')).toBe(true);
});

it('shows unbound history metadata read-only without asserting it needs a current answer', async () => {
  const { control } = setup(); await settle(); const view = control.getSnapshot(), entry = view.entries.session!;
  const legacy = request({ id: 'legacy', identityVerified: false, canAnswer: false });
  const entries = { session: { ...entry, requests: [legacy] } };
  const take = createObservedInputNoticeTracker(); take(view.entries); expect(take(entries)).toEqual([]);
  const context = { control, view: { ...view, entries }, locate: vi.fn() };
  const html = renderToStaticMarkup(createElement(ObservedInputContext, { value: context }, createElement(ObservedInputCards, { t: MESSAGES.en, sessionId: 'session' })));
  expect(html).toContain(MESSAGES.en.observedInput.replyUnavailable);
  expect(renderToStaticMarkup(createElement(ObservedInputContext, { value: context }, createElement(ObservedInputAlert, { t: MESSAGES.en })))).toBe('');
});
