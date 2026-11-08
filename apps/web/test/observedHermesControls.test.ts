import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentHostApi, HermesObservedStatus } from '@extalia/platform';
import { afterEach, expect, it, vi } from 'vitest';
import { createObservedHermesControl } from '../src/observe/observedHermesModel';
import { HermesQuestion } from '../src/observe/ObservedHermesControls';
import { MESSAGES } from '../src/i18n';

const state = (connected = false): HermesObservedStatus => ({ sessionId: 'session', nativeSessionId: 'original', state: connected ? 'connected' : 'disconnected', running: connected, canSend: connected, canAnswer: connected, requests: [], ...(connected ? { connectionId: 'connection', executionGeneration: 3 } : {}) });
const host = () => ({ observedHermesStatus: vi.fn(async () => state()), connectObservedHermes: vi.fn(async () => state(true)), disconnectObservedHermes: vi.fn(async () => state()), sendObservedHermesMessage: vi.fn(async () => ({ ...state(true), delivery: 'submitted' as const })), answerObservedHermesInput: vi.fn(async () => state(true)) });
const stops: (() => void)[] = [];
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
const setup = () => { const api = host(); const model = createObservedHermesControl(api as unknown as AgentHostApi, 'session'); stops.push(model.start()); return { api, model }; };
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.useRealTimers(); });
it('does not attach automatically and preserves the exact execution generation when sending', async () => {
  const { api, model } = setup(); await settle(); expect(api.connectObservedHermes).not.toHaveBeenCalled();
  await model.connect('example'); model.setDraft('Continue'); await model.send();
  expect(api.sendObservedHermesMessage).toHaveBeenCalledExactlyOnceWith('session', { connectionId: 'connection', text: 'Continue', executionGeneration: 3 });
  expect(model.getSnapshot().draft).toBe('');
});
it('rejects absent or stale questions instead of replying to a different generation', async () => {
  const { api, model } = setup(); await settle(); await model.connect('');
  api.observedHermesStatus.mockResolvedValue({ ...state(true), requests: [{ id: 'question', kind: 'clarify', executionGeneration: 4, question: 'Original?', choices: [] }] });
  await model.refresh(); await model.answer({ requestId: 'question', executionGeneration: 3, answer: 'stale' });
  expect(api.answerObservedHermesInput).not.toHaveBeenCalled();
  await model.answer({ requestId: 'question', executionGeneration: 4, answer: 'current' });
  expect(api.answerObservedHermesInput).toHaveBeenCalledWith('session', { connectionId: 'connection', requestId: 'question', executionGeneration: 4, answer: 'current' });
});
it('also includes the native execution generation for an idle-session message', async () => {
  const { api, model } = setup(); await settle();
  api.connectObservedHermes.mockResolvedValue({ ...state(true), running: false });
  await model.connect(''); model.setDraft('Next message'); await model.send();
  expect(api.sendObservedHermesMessage).toHaveBeenCalledWith('session', { connectionId: 'connection', text: 'Next message', executionGeneration: 3 });
});
it('invalidates native controls on malformed status or polling failure and retains drafts', async () => {
  vi.useFakeTimers(); const { api, model } = setup(); await settle(); await model.connect(''); model.setDraft('keep');
  api.observedHermesStatus.mockResolvedValue({ ...state(true), sessionId: 'other' });
  await vi.advanceTimersByTimeAsync(2000); await model.send();
  expect(model.getSnapshot()).toMatchObject({ phase: 'error', status: undefined, draft: 'keep' });
  expect(api.sendObservedHermesMessage).not.toHaveBeenCalled();
});
it.each(['en', 'id'] as const)('renders native request details without a default approval in %s', language => {
  const model = createObservedHermesControl({} as AgentHostApi, 'session');
  const html = renderToStaticMarkup(createElement(HermesQuestion, { t: MESSAGES[language], control: model, disabled: false,
    question: { id: 'question', kind: 'approval', executionGeneration: 3, question: 'Original permission?', command: 'original command', description: 'original description', choices: ['once', 'deny'] } }));
  expect(html).toContain('Original permission?'); expect(html).toContain('original command'); expect(html).toContain('original description');
  expect(html).not.toContain('checked=""'); expect(html).toContain('disabled=""');
});
