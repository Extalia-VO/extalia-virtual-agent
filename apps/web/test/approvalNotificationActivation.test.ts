import { createElement } from 'react';
import type * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NotificationCapability } from '@extalia/platform';
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalProvider } from '../src/approvals/ApprovalProvider';
import { MESSAGES } from '../src/i18n';

const hooks = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)>, setters: [] as ReturnType<typeof vi.fn>[] }));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return { ...actual,
    useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
    useState: (initial: unknown) => { const setter = vi.fn(); hooks.setters.push(setter); return [initial, setter]; },
  };
});
afterEach(() => { hooks.effects.length = 0; hooks.setters.length = 0; vi.unstubAllGlobals(); });

it('opens the approval inbox for legacy and approval targets and ignores observed questions', () => {
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  let activate: Parameters<NotificationCapability['onActivate']>[0] | undefined;
  const notifier: NotificationCapability = { notify: vi.fn(), onActivate: listener => { activate = listener; return () => undefined; } };
  renderToStaticMarkup(createElement(ApprovalProvider, { t: MESSAGES.en, hostKind: 'web', agents: undefined, state: null, notifier, children: null }));
  const cleanup = hooks.effects.map(effect => effect());
  expect(activate).toBeDefined();
  activate!({ kind: 'observed-input', sessionId: 'session', requestId: 'question' });
  expect(hooks.setters.every(setter => setter.mock.calls.length === 0)).toBe(true);
  activate!(); activate!({ kind: 'approval-inbox' });
  expect(hooks.setters.flatMap(setter => setter.mock.calls)).toEqual([[true], [true]]);
  cleanup.forEach(stop => stop?.());
});
