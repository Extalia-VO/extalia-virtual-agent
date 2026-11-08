import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentHostApi, HostState } from '@extalia/platform';
import { expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { ObserverPage } from '../src/pages/ObserverPage';
import { ImportPage } from '../src/library/ImportPage';
import { OBSERVE_SECTIONS, observeTabForKey } from '../src/observe/observerTabs';

it('cycles the live sessions and manual pairing tabs with roving keyboard navigation', () => {
  expect(OBSERVE_SECTIONS).toEqual(['sessions', 'pairing']);
  expect(observeTabForKey('sessions', 'ArrowLeft')).toBe('pairing');
  expect(observeTabForKey('pairing', 'ArrowRight')).toBe('sessions');
  expect(observeTabForKey('sessions', 'End')).toBe('pairing');
  expect(observeTabForKey('pairing', 'Home')).toBe('sessions');
  expect(observeTabForKey('sessions', 'Enter')).toBeUndefined();
});

it.each(['en', 'id'] as const)('keeps manual pairing mounted behind its labelled tab and configuration out of Observe in %s', language => {
  const t = MESSAGES[language];
  const createManualReply = vi.fn();
  const html = renderToStaticMarkup(createElement(ObserverPage, { t, language, agents: { createManualReply } as unknown as AgentHostApi,
    state: { sessions: [], workspaces: [] } as unknown as HostState, onState: vi.fn(), onContinued: vi.fn(), onOpenSettings: vi.fn() }));
  expect(html.match(/role="tab"/g)).toHaveLength(2);
  expect(html).toContain('aria-selected="true" tabindex="0"');
  expect(html).toContain('aria-selected="false" tabindex="-1"');
  expect(html).toMatch(/id="[^"]+-pairing-panel" aria-labelledby="[^"]+-pairing-tab" hidden=""/);
  expect(html).toContain(t.observedReply.manualTitle);
  expect(html).not.toContain(t.observer.autoTitle);
  expect(createManualReply).not.toHaveBeenCalled();
});

it.each(['en', 'id'] as const)('keeps Import focused on native history and portable JSON with no live watch action in %s', language => {
  const t = MESSAGES[language], observeImports = vi.fn(), previewImports = vi.fn(), commitImports = vi.fn();
  const html = renderToStaticMarkup(createElement(ImportPage, { t, language, agents: { observeImports, previewImports, commitImports } as unknown as AgentHostApi,
    onState: vi.fn(), onImported: vi.fn() }));
  expect(html).toContain(t.imports.locations);
  expect(html).toContain(t.imports.portableTitle);
  expect(html).not.toContain(t.observer.watch);
  expect(observeImports).not.toHaveBeenCalled();
  expect(previewImports).not.toHaveBeenCalled();
  expect(commitImports).not.toHaveBeenCalled();
});
