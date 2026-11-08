import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentHostApi, ObservedReplyStatus } from '@extalia/platform';
import { afterEach, expect, it, vi } from 'vitest';
import { createObservedReplyControl, validReplyStatus } from '../src/observe/observedReplyModel';
import { ManualReplyControls, ObservedReplyContent } from '../src/observe/ObservedReplyControls';
import { MESSAGES } from '../src/i18n';

const id = 'session', channelId = '11111111-1111-4111-8111-111111111111';
const status = (state: ObservedReplyStatus['state']): ObservedReplyStatus => ({ sessionId: id, state,
  ...(state === 'waitingForAgent' || state === 'waitingForReply' ? { channelId } : {}),
  ...(state === 'waitingForAgent' ? { url: `http://127.0.0.1:12345/reply/${channelId}`, token: 'a'.repeat(64) } : {}),
});
const host = () => ({
  observedReplyStatus: vi.fn(async () => status('disconnected')),
  createObservedReply: vi.fn(async () => status('waitingForAgent')),
  closeObservedReply: vi.fn(async () => status('disconnected')),
  answerObservedReply: vi.fn(async () => status('answered')),
});
const stops: (() => void)[] = [];
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
const setup = () => { const api = host(); const model = createObservedReplyControl(api as unknown as AgentHostApi, id); stops.push(model.start()); return { api, model }; };
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.useRealTimers(); });

it('never creates or sends on mount; only polls a live one-use channel', async () => {
  vi.useFakeTimers(); const { api, model } = setup(); await settle();
  await vi.advanceTimersByTimeAsync(5000); expect(api.observedReplyStatus).toHaveBeenCalledTimes(1);
  expect(api.createObservedReply).not.toHaveBeenCalled(); expect(api.answerObservedReply).not.toHaveBeenCalled();
  await model.create(); api.observedReplyStatus.mockResolvedValue(status('waitingForReply'));
  await vi.advanceTimersByTimeAsync(1000); model.setDraft('reply'); await model.answer(); await model.answer();
  expect(api.answerObservedReply).toHaveBeenCalledExactlyOnceWith(id, { channelId, text: 'reply' });
  expect(model.getSnapshot().draft).toBe('');
});
it('fails closed on polling failure, retains failed draft and never auto resends', async () => {
  vi.useFakeTimers(); const { api, model } = setup(); await settle(); await model.create();
  model.setDraft('keep'); api.observedReplyStatus.mockRejectedValue(new Error('offline'));
  await vi.advanceTimersByTimeAsync(1000); await model.answer();
  expect(model.getSnapshot()).toMatchObject({ phase: 'error', draft: 'keep', status: undefined });
  expect(api.answerObservedReply).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5000); expect(api.observedReplyStatus).toHaveBeenCalledTimes(2);
});
it('ignores a late status after disposal and a read superseded by close', async () => {
  const { api, model } = setup(); await settle(); await model.create();
  let resolve!: (value: ObservedReplyStatus) => void;
  api.observedReplyStatus.mockReturnValue(new Promise(done => { resolve = done; }));
  const read = model.refresh(); await model.close(); resolve(status('waitingForReply')); await read;
  expect(model.getSnapshot().status?.state).toBe('disconnected');
  const late = model.refresh(); stops.pop()!(); resolve(status('waitingForReply')); await late;
  expect(model.getSnapshot().status?.state).toBe('disconnected');
});
it('rejects foreign sessions and unsafe returned command targets', () => {
  expect(validReplyStatus({ ...status('waitingForAgent'), sessionId: 'other' }, id)).toBe(false);
  for (const url of ['http://localhost:12345/reply/x', 'https://example.com', 'http://127.0.0.1:12345/reply/x', `http://127.0.0.1:12345/reply/${channelId}?a=b`]) {
    expect(validReplyStatus({ ...status('waitingForAgent'), url }, id)).toBe(false);
  }
  expect(validReplyStatus(status('waitingForAgent'), id)).toBe(true);
});
it.each(['en', 'id'] as const)('renders explicit source pairing and untranslated question in %s', language => {
  const model = createObservedReplyControl({} as AgentHostApi, id);
  const html = renderToStaticMarkup(createElement(ObservedReplyContent, { t: MESSAGES[language], control: model,
    view: { phase: 'ready', busy: false, draft: '', status: { ...status('waitingForReply'), question: 'Original source question?' } } }));
  expect(html).toContain('Original source question?'); expect(html).toContain(MESSAGES[language].observedReply.helper);
  expect(html).toContain('disabled=""'); expect(html).not.toContain('checked=""');
});
it('renders a separate manual pairing entry without creating a source session on mount', () => {
  const createManualReply = vi.fn();
  const html = renderToStaticMarkup(createElement(ManualReplyControls, { t: MESSAGES.en, agents: { createManualReply } as unknown as AgentHostApi }));
  expect(html).toContain(MESSAGES.en.observedReply.manualTitle);
  expect(html).toContain(MESSAGES.en.observedReply.manualHint);
  expect(createManualReply).not.toHaveBeenCalled();
});
