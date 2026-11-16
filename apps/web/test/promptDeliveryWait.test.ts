import { createElement } from 'react';
import type * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';

// Exercise the mounted effect's real timer without a browser dependency.
const hooks = vi.hoisted(() => ({
  effect: undefined as (() => void | (() => void)) | undefined,
  slow: false,
  setSlow: vi.fn(),
}));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof React>(),
  useEffect: (effect: () => void | (() => void)) => { hooks.effect = effect; },
  useState: () => [hooks.slow, (next: boolean) => { hooks.slow = next; hooks.setSlow(next); }],
}));
import { PromptDeliveryStatus } from '../src/chat/PromptDeliveryStatus';

afterEach(() => { vi.useRealTimers(); hooks.slow = false; hooks.setSlow.mockClear(); });

it('changes a long submission to still-waiting feedback after eight seconds and clears its timer on unmount', async () => {
  vi.useFakeTimers();
  const render = () => renderToStaticMarkup(createElement(PromptDeliveryStatus, { t: MESSAGES.en, phase: 'submitting' }));
  expect(render()).toContain(MESSAGES.en.promptDelivery.submitting);
  const cleanup = hooks.effect!();
  await vi.advanceTimersByTimeAsync(7_999); expect(hooks.slow).toBe(false);
  await vi.advanceTimersByTimeAsync(1); expect(render()).toContain(MESSAGES.en.promptDelivery.stillWaiting);
  if (cleanup) cleanup();
  renderToStaticMarkup(createElement(PromptDeliveryStatus, { t: MESSAGES.en, phase: 'accepted' }));
  expect(hooks.slow).toBe(false); render();
  const nextCleanup = hooks.effect!();
  if (nextCleanup) nextCleanup();
  await vi.advanceTimersByTimeAsync(8_000); expect(hooks.slow).toBe(false);
});
