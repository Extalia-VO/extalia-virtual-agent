import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentHostApi, ObservedCodexQueueStatus } from '@extalia/platform';
import { afterEach, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { codexPromptEnterSends, ObservedCodexPromptContent } from '../src/observe/ObservedCodexPromptComposer';
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
