import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentHostApi, ObservedCodexQueueStatus, SessionSummary } from '@extalia/platform';
import { afterEach, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { codexPromptEnterSends, ObservedCodexPromptComposer, ObservedCodexPromptContent, ObservedQueuedPromptFeedback } from '../src/observe/ObservedCodexPromptComposer';
import { CODEX_PROMPT_LIMIT, createObservedCodexPromptControl } from '../src/observe/observedCodexPromptModel';

const id = 'observed', threadId = '11111111-1111-4111-8111-111111111111';
const status = (enabled = false, patch: Partial<ObservedCodexQueueStatus> = {}): ObservedCodexQueueStatus => ({ sessionId: id, threadId, enabled, canQueue: enabled, ...patch });
const stops: Array<() => void> = [];
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function setup(initial = status()) {
  const api = {
    observedCodexQueueStatus: vi.fn(async () => initial),
    setObservedCodexQueue: vi.fn(async () => status(true)),
    queueObservedCodexMessage: vi.fn(async () => status(true, { delivery: 'queued', messageId: 'receipt' })),
    createSession: vi.fn(), sendPrompt: vi.fn(), uploadAttachment: vi.fn(), modelChoices: vi.fn(),
  };
  const model = createObservedCodexPromptControl(api as unknown as AgentHostApi, id, threadId);
  stops.push(model.start()); return { api, model };
}
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.useRealTimers(); });

it.each(['en', 'id'] as const)('renders one observed input through the host outbox without creating a session (%s)', language => {
  const api = { promptQueueStatus: vi.fn(), changePromptQueue: vi.fn(), createSession: vi.fn(), queueObservedCodexMessage: vi.fn() };
  const session = { id, control: 'observed', running: true,
    observation: { sourceId: 'codex', nativeSessionId: threadId, watching: true, status: 'watching' } } as SessionSummary;
  const html = renderToStaticMarkup(createElement(ObservedCodexPromptComposer, { t: MESSAGES[language], agents: api as unknown as AgentHostApi, session }));
  expect(html.match(/<textarea/g)).toHaveLength(1);
  expect(html).toContain(MESSAGES[language].promptQueue.queueLabel);
  expect(html).not.toContain(MESSAGES[language].promptQueue.addPlaceholder);
  expect(api.createSession).not.toHaveBeenCalled(); expect(api.queueObservedCodexMessage).not.toHaveBeenCalled();
});

it('only reads on mount; first Send checks the source, opts in and queues text to the same observed ID', async () => {
  vi.useFakeTimers(); const { api, model } = setup(); await settle(); await vi.advanceTimersByTimeAsync(4000);
  expect(api.setObservedCodexQueue).not.toHaveBeenCalled(); expect(api.queueObservedCodexMessage).not.toHaveBeenCalled();
  model.setDraft('Original conversation\nKeep this exact text'); await model.send();
  expect(api.setObservedCodexQueue).toHaveBeenCalledExactlyOnceWith(id, true);
  expect(api.queueObservedCodexMessage).toHaveBeenCalledExactlyOnceWith(id, { text: 'Original conversation\nKeep this exact text' });
  expect(api.observedCodexQueueStatus.mock.invocationCallOrder.at(-1)).toBeLessThan(api.setObservedCodexQueue.mock.invocationCallOrder[0]!);
  expect(api.setObservedCodexQueue.mock.invocationCallOrder[0]).toBeLessThan(api.queueObservedCodexMessage.mock.invocationCallOrder[0]!);
  expect(model.getSnapshot()).toMatchObject({ draft: '', notice: 'queued', busy: false });
  expect(api.createSession).not.toHaveBeenCalled(); expect(api.sendPrompt).not.toHaveBeenCalled();
  expect(api.uploadAttachment).not.toHaveBeenCalled(); expect(api.modelChoices).not.toHaveBeenCalled();
});

it('reuses enabled setup and clears only the draft that was actually queued', async () => {
  const { api, model } = setup(status(true)); await settle(); model.setDraft('first draft');
  const pending = deferred<ObservedCodexQueueStatus>(); api.queueObservedCodexMessage.mockReturnValueOnce(pending.promise);
  const send = model.send(); await settle(); model.setDraft('new draft');
  pending.resolve(status(true, { delivery: 'queued' })); await send;
  expect(api.setObservedCodexQueue).not.toHaveBeenCalled(); expect(model.getSnapshot().draft).toBe('new draft');
  expect(model.getSnapshot().notice).toBe('queued');
});

it('keeps the draft after setup failure and exposes no internal error details', async () => {
  const { api, model } = setup(); await settle(); model.setDraft('keep this');
  api.setObservedCodexQueue.mockRejectedValueOnce(new Error('internal endpoint and profile details'));
  await model.send(); expect(api.queueObservedCodexMessage).not.toHaveBeenCalled();
  expect(model.getSnapshot()).toMatchObject({ draft: 'keep this', notice: 'failed', phase: 'error' });
  expect(JSON.stringify(model.getSnapshot())).not.toContain('internal endpoint');
});

it.each(['returned', 'thrown'] as const)('preserves and locks an uncertain draft when delivery is %s', async mode => {
  vi.useFakeTimers(); const { api, model } = setup(status(true)); await settle(); model.setDraft('possibly submitted');
  if (mode === 'returned') api.queueObservedCodexMessage.mockResolvedValueOnce(status(true, { delivery: 'unknown', canQueue: false }));
  else api.queueObservedCodexMessage.mockRejectedValueOnce(new Error('transport lost after request'));
  await model.send(); await vi.advanceTimersByTimeAsync(6000); await model.send();
  expect(api.queueObservedCodexMessage).toHaveBeenCalledTimes(1); expect(api.setObservedCodexQueue).not.toHaveBeenCalled();
  expect(model.getSnapshot()).toMatchObject({ draft: 'possibly submitted', notice: 'unknown' });
  expect(model.canSend()).toBe(false);
});

it('does not reset an existing unknown receipt to enable another send', async () => {
  const { api, model } = setup(status(true, { delivery: 'unknown', canQueue: false })); await settle();
  model.setDraft('retain'); await model.send();
  expect(api.setObservedCodexQueue).not.toHaveBeenCalled(); expect(api.queueObservedCodexMessage).not.toHaveBeenCalled();
});

it('fresh status blocks changed source, host busy and unavailable submission', async () => {
  const { api, model } = setup(status(true)); await settle(); model.setDraft('only this source');
  api.observedCodexQueueStatus.mockResolvedValueOnce(status(true, { threadId: '22222222-2222-4222-8222-222222222222' }));
  await model.send(); expect(api.queueObservedCodexMessage).not.toHaveBeenCalled();
  await model.refresh(); api.observedCodexQueueStatus.mockResolvedValueOnce(status(true, { busy: true, canQueue: false }));
  await model.send(); expect(api.queueObservedCodexMessage).not.toHaveBeenCalled();
  expect(model.getSnapshot().notice).toBe('unavailable');
});

it('navigation during the fresh check or setup prevents a later send', async () => {
  const first = setup(); await settle(); first.model.setDraft('old host');
  const pendingRead = deferred<ObservedCodexQueueStatus>(); first.api.observedCodexQueueStatus.mockReturnValueOnce(pendingRead.promise);
  const firstSend = first.model.send(); await settle(); stops.pop()!(); pendingRead.resolve(status()); await firstSend;
  expect(first.api.setObservedCodexQueue).not.toHaveBeenCalled(); expect(first.api.queueObservedCodexMessage).not.toHaveBeenCalled();
  const next = setup(); await settle(); next.model.setDraft('old session');
  const pendingSetup = deferred<ObservedCodexQueueStatus>(); next.api.setObservedCodexQueue.mockReturnValueOnce(pendingSetup.promise);
  const nextSend = next.model.send(); await settle(); stops.pop()!(); pendingSetup.resolve(status(true)); await nextSend;
  expect(next.api.queueObservedCodexMessage).not.toHaveBeenCalled();
});

it('pause during setup blocks submission; pause after dispatch preserves uncertainty', async () => {
  const { api, model } = setup(); await settle(); model.setDraft('stay here');
  const enabling = deferred<ObservedCodexQueueStatus>(); api.setObservedCodexQueue.mockReturnValueOnce(enabling.promise);
  const first = model.send(); await settle(); model.setDisabled(true); enabling.resolve(status(true)); await first;
  expect(api.queueObservedCodexMessage).not.toHaveBeenCalled();
  model.setDisabled(false); api.observedCodexQueueStatus.mockResolvedValue(status(true)); await model.refresh();
  const pending = deferred<ObservedCodexQueueStatus>(); api.queueObservedCodexMessage.mockReturnValueOnce(pending.promise);
  const second = model.send(); await settle(); model.setDisabled(true); model.setDisabled(false);
  pending.resolve(status(true, { delivery: 'queued' })); await second;
  expect(model.getSnapshot()).toMatchObject({ draft: 'stay here', notice: 'unknown' }); expect(model.canSend()).toBe(false);
});

it('waits for an in-flight poll, then fresh-checks once and suppresses concurrent Send clicks', async () => {
  const { api, model } = setup(status(true)); await settle(); model.setDraft('one message');
  const pending = deferred<ObservedCodexQueueStatus>(); api.observedCodexQueueStatus.mockReturnValueOnce(pending.promise);
  const read = model.refresh(); const send = model.send(); await model.send();
  expect(api.observedCodexQueueStatus).toHaveBeenCalledTimes(2); expect(api.queueObservedCodexMessage).not.toHaveBeenCalled();
  pending.resolve(status(true)); await read; await send;
  expect(api.observedCodexQueueStatus).toHaveBeenCalledTimes(3); expect(api.queueObservedCodexMessage).toHaveBeenCalledTimes(1);
});

it('returns a validated source queue acceptance after unmount to settle the original draft', async () => {
  const { api, model } = setup(status(true)); await settle();
  const pending = deferred<ObservedCodexQueueStatus>(); api.queueObservedCodexMessage.mockReturnValueOnce(pending.promise);
  const send = model.send('shared original draft'); await settle(); stops.pop()!();
  pending.resolve(status(true, { delivery: 'queued' }));
  expect(await send).toBe('accepted');
  expect(api.queueObservedCodexMessage).toHaveBeenCalledExactlyOnceWith(id, { text: 'shared original draft' });
});

it('requires a fresh safe source read and explicit inspection to clear local uncertainty', async () => {
  const { api, model } = setup(status(true)); await settle();
  api.queueObservedCodexMessage.mockRejectedValueOnce(new Error('response lost'));
  expect(await model.send('uncertain draft')).toBe('unknown');
  expect(model.allowRetry()).toBe(false);
  api.observedCodexQueueStatus.mockResolvedValue(status(true, { delivery: 'unknown', canQueue: false }));
  await model.refresh(); expect(model.allowRetry()).toBe(false);
  api.observedCodexQueueStatus.mockResolvedValue(status(true, { delivery: 'queued' }));
  await model.refresh();
  expect(model.canSend('uncertain draft')).toBe(false);
  expect(model.canRetry()).toBe(true); expect(model.allowRetry()).toBe(true);
  expect(model.canSend('uncertain draft')).toBe(true);
  expect(api.queueObservedCodexMessage).toHaveBeenCalledTimes(1);
});

it('reconstructs positive queue feedback from a persisted receipt on mount', async () => {
  const { model } = setup(status(true, { delivery: 'queued' })); await settle();
  expect(model.getSnapshot().notice).toBe('queued');
  // A remounted composer can retain local uncertainty in its shared draft;
  // only user inspection, after this fresh safe read, may unlock that draft.
  expect(model.canRetry()).toBe(true);
  expect(model.allowRetry()).toBe(true);
});

it('does not latch an in-flight write-ahead marker as a settled unknown after remount', async () => {
  const { api, model } = setup(status(true, { delivery: 'unknown', busy: true, canQueue: false })); await settle();
  expect(model.getSnapshot().notice).not.toBe('unknown'); expect(model.canSend('next draft')).toBe(false);
  api.observedCodexQueueStatus.mockResolvedValue(status(true, { delivery: 'queued' })); await model.refresh();
  expect(model.getSnapshot().notice).toBe('queued'); expect(model.canSend('next draft')).toBe(true);
});

it('rejects oversized, blank and null-containing text without trimming or uploading attachments', async () => {
  const { api, model } = setup(); await settle();
  for (const draft of ['  \n', 'x'.repeat(CODEX_PROMPT_LIMIT + 1), 'null\0byte']) { model.setDraft(draft); await model.send(); }
  expect(api.setObservedCodexQueue).not.toHaveBeenCalled(); expect(api.queueObservedCodexMessage).not.toHaveBeenCalled();
});

it('Enter sends while Shift+Enter and IME composition preserve input', () => {
  expect(codexPromptEnterSends({ key: 'Enter', shiftKey: false })).toBe(true);
  expect(codexPromptEnterSends({ key: 'Enter', shiftKey: true })).toBe(false);
  expect(codexPromptEnterSends({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
  expect(codexPromptEnterSends({ key: 'Enter', shiftKey: false, keyCode: 229 })).toBe(false);
});

it('renders a normal labeled text composer with localized queue wording and no attachments or pickers', async () => {
  const { model } = setup(); await settle(); model.setDraft('hello');
  for (const language of ['en', 'id'] as const) {
    const t = MESSAGES[language];
    const html = renderToStaticMarkup(createElement(ObservedCodexPromptContent, { t, control: model, view: model.getSnapshot() }));
    expect(html).toContain('composer observed-codex-prompt'); expect(html).toContain(t.observedCodexPrompt.send);
    expect(html).not.toMatch(/id="[^"]+-hint"/); expect(html).not.toContain('maxLength=');
    expect(html).not.toContain('composer-toolbar');
    expect(html).not.toContain('type="file"'); expect(html).not.toContain('combobox'); expect(html).not.toContain('details');
  }
});


it.each(['en', 'id'] as const)('renders one actionable queue failure with one retry in %s', language => {
  const t = MESSAGES[language], html = renderToStaticMarkup(createElement(ObservedQueuedPromptFeedback, { t, view: { phase: 'error', notice: 'failed', busy: false }, locked: false, draftLength: 10, onRefresh: vi.fn() }));
  expect(html.split(t.promptQueue.failed)).toHaveLength(2); expect(html.split(t.promptQueue.refresh)).toHaveLength(2);
  expect(html.match(/role="status"/g)).toHaveLength(1);
});

it('retains independent paused, length, loading and unsupported hints', () => {
  const t = MESSAGES.en, render = (phase: 'loading' | 'error' | 'unsupported', locked = false, draftLength = 0) => renderToStaticMarkup(createElement(ObservedQueuedPromptFeedback, { t, view: { phase, busy: false }, locked, draftLength, onRefresh: vi.fn() }));
  expect(render('error', true)).toContain(t.observedCodexPrompt.paused);
  expect(render('error', false, CODEX_PROMPT_LIMIT + 1)).toContain(t.observedCodexPrompt.tooLong);
  expect(render('loading')).toContain(t.promptQueue.loading); expect(render('unsupported')).toContain(t.promptQueue.unsupported);
});

it('shows a stale queue notice once and keeps refresh disabled while busy', () => {
  const t = MESSAGES.en, html = renderToStaticMarkup(createElement(ObservedQueuedPromptFeedback, { t, view: { phase: 'error', notice: 'stale', busy: true }, locked: false, draftLength: 0, onRefresh: vi.fn() }));
  expect(html).toContain(t.promptQueue.stale); expect(html).not.toContain(t.promptQueue.failed); expect(html).toContain('disabled=""');
});

it('does not offer queue retry when delivery is uncertain', () => {
  const t = MESSAGES.en, html = renderToStaticMarkup(createElement(ObservedQueuedPromptFeedback, { t, view: { phase: 'error', notice: 'failed', delivery: 'unknown', busy: false }, locked: false, draftLength: 0, onRefresh: vi.fn() }));
  expect(html.split(t.promptQueue.failed)).toHaveLength(2); expect(html).not.toContain(t.promptQueue.refresh);
});
