import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentHostApi, ImportCandidate } from '@extalia/platform';
import { expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { NativeSessionPicker } from '../src/library/NativeSessionPicker';
import { createOperationScope, LIVE_SELECTION_LIMIT, nativeSelectableIds, type NativeDiscovery } from '../src/library/nativeDiscovery';

const candidate = (id: string, patch: Partial<ImportCandidate> = {}): ImportCandidate => ({
  id, sourceId: 'codex', locationId: 'location', sourceName: 'Codex', nativeSessionId: id, title: `Conversation ${id}`,
  updatedAt: '2026-01-31T10:00:00.000Z', format: 'JSONL', supported: true, ...patch,
});

it('excludes unsupported and ignored candidates from watching, while history import can include ignored folders', () => {
  const sessions = [candidate('normal'), candidate('ignored', { ignored: true }), candidate('unsupported', { supported: false })];
  expect(nativeSelectableIds(sessions, 'observe')).toEqual(['normal']);
  expect(nativeSelectableIds(sessions, 'import')).toEqual(['normal', 'ignored']);
  expect(LIVE_SELECTION_LIMIT).toBe(10);
});

it('holds an action lock synchronously and invalidates all delayed results on disposal', async () => {
  const scope = createOperationScope();
  const action = vi.fn();
  const lease = scope.acquire()!;
  expect(scope.acquire()).toBeUndefined();
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; }).then(() => { if (lease.isCurrent()) action(); lease.release(); });
  scope.dispose();
  scope.activate();
  const next = scope.acquire()!;
  finish(); await pending;
  expect(action).not.toHaveBeenCalled();
  expect(lease.isCurrent()).toBe(false);
  expect(scope.acquire()).toBeUndefined(); // Old completion cannot release the new host's lock.
  next.release();
  expect(scope.acquire()).toBeDefined();
});

it.each(['en', 'id'] as const)('shows source metadata and explicit unchecked consent without transcript actions in %s', language => {
  const t = MESSAGES[language];
  const discovery: NativeDiscovery = {
    locations: [], locationsChosen: new Set(), scan: { scanId: 'scan', sessions: [candidate('normal'), candidate('ignored', { ignored: true })], diagnostics: [], truncated: false },
    selected: new Set(), query: '', consent: false, scanning: false, error: null,
    scope: { ...createOperationScope(), owner: {} as AgentHostApi }, update: vi.fn(), choose: vi.fn(), startScan: vi.fn(),
  };
  const html = renderToStaticMarkup(createElement(NativeSessionPicker, { t, language, discovery, purpose: 'observe' }));
  expect(html).toContain(t.observer.sourceConsent);
  expect(html).toContain(t.observedOrigin.ignoredBadge);
  expect(html).toContain('Conversation normal');
  expect(html).not.toContain('checked=""');
  expect(html).not.toContain(t.imports.showMessages(0));
  expect(discovery.choose).not.toHaveBeenCalled();
  expect(discovery.startScan).not.toHaveBeenCalled();
});
