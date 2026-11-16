import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PromptQueueItem } from '@extalia/platform';
import { expect, it } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { PromptDeliveryStatus } from '../src/chat/PromptDeliveryStatus';
import type { PromptQueueView } from '../src/chat/promptQueueModel';

const view = (state: PromptQueueItem['state']): PromptQueueView => ({
  phase: 'ready', busy: false, disabled: false, draft: '',
  status: { sessionId: 'session', revision: 'r1', supported: true, paused: false, maxTextLength: 16_000,
    items: [{ id: 'receipt', text: 'Example prompt', createdAt: '2030-01-01T00:00:00Z', state }] },
});

it.each(['en', 'id'] as const)('keeps pending, sending, sent and unknown evidence outside collapsed details (%s)', language => {
  const t = MESSAGES[language];
  for (const [state, expected] of [
    ['pending', t.promptDelivery.queued], ['sending', t.promptDelivery.sendingCodex],
    ['sent', t.promptDelivery.codexSubmitted], ['unknown', t.promptDelivery.unknown],
  ] as const) {
    const html = renderToStaticMarkup(createElement(PromptDeliveryStatus, { t, queueView: view(state), observed: true }));
    expect(html).toContain(expected); expect(html).toContain('role="status"');
    expect(html).not.toContain('<details'); expect(html).not.toContain('Example prompt');
    if (state === 'sending') expect(html).toContain('spin');
  }
});

it('immediately announces submission with a spinner and keeps failures distinct from earlier receipts', () => {
  const t = MESSAGES.en;
  const submitting = renderToStaticMarkup(createElement(PromptDeliveryStatus, { t, phase: 'submitting' }));
  expect(submitting).toContain(t.promptDelivery.submitting); expect(submitting).toContain('spin');
  const failed = renderToStaticMarkup(createElement(PromptDeliveryStatus, { t, phase: 'failed', queueView: view('sent') }));
  expect(failed).toContain(t.promptDelivery.failed); expect(failed).not.toContain(t.promptDelivery.accepted);
});

it('offers separate read-only recheck and explicit user inspection actions for local uncertainty', () => {
  const t = MESSAGES.en;
  const html = renderToStaticMarkup(createElement(PromptDeliveryStatus, { t, phase: 'unknown', onRecheck() {}, onRetryConfirmed() {} }));
  expect(html).toContain(t.promptDelivery.recheck); expect(html).toContain(t.promptDelivery.allowRetry);
  const blocked = renderToStaticMarkup(createElement(PromptDeliveryStatus, { t, queueView: view('unknown'), onRecheck() {}, onRetryConfirmed() {} }));
  expect(blocked).toContain(t.promptDelivery.recheck); expect(blocked).not.toContain(t.promptDelivery.allowRetry);
});

it('does not mistake local Extalia acceptance without a source receipt for Codex queue acceptance', () => {
  const t = MESSAGES.en;
  const queueView = { ...view('pending'), status: undefined, delivery: 'accepted' as const };
  const html = renderToStaticMarkup(createElement(PromptDeliveryStatus, { t, queueView, phase: 'accepted', observed: true }));
  expect(html).toContain(t.promptDelivery.queued); expect(html).not.toContain(t.promptDelivery.codexQueued);
});

it.each(['en', 'id'] as const)('names the actual observed app instead of Codex (%s)', language => {
  const t = MESSAGES[language];
  for (const label of ['Antigravity', 'Claude Code', 'Gemini CLI']) {
    const html = renderToStaticMarkup(createElement(PromptDeliveryStatus, { t, queueView: view('sent'), observed: true, sourceLabel: label }));
    expect(html).toContain(label); expect(html).not.toContain('Codex');
  }
});
