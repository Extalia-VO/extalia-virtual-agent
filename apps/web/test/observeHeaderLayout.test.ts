import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentHostApi, HostState, SessionSummary } from '@extalia/platform';
import { ObserverPage } from '../src/pages/ObserverPage';
import { ContinueInExtalia } from '../src/library/ContinueInExtalia';
import { MESSAGES } from '../src/i18n';

const observed: SessionSummary = { id: 'session-a', title: 'A long source session title that must leave its controls in a separate column', control: 'observed', workspaceId: 'workspace-a', connectionId: 'observed', running: true, createdAt: '2026-01-01T00:00:00Z', lastActiveAt: '2026-01-01T00:00:00Z', observation: { sourceId: 'codex', nativeSessionId: 'source-a', projectPath: '/projects/example', watching: true, status: 'watching' } };
const state = { workflow: 'observe', sessions: [observed], workspaces: [{ id: 'workspace-a', name: 'Example workspace', projectLocation: '/projects/example' }], connections: [] } as unknown as HostState;

it.each(['en', 'id'] as const)('keeps navigation in one page toolbar and puts source status beside the title metadata (%s)', language => {
  const html = renderToStaticMarkup(createElement(ObserverPage, { t: MESSAGES[language], language, state, agents: {} as AgentHostApi, onState: vi.fn(), onContinued: vi.fn(), onOpenSettings: vi.fn() }));
  const toolbar = html.slice(html.indexOf('<header class="observe-page-header"'), html.indexOf('</header>'));
  expect(toolbar).toContain('class="observe-page-heading"');
  expect(toolbar).toContain('class="observe-tabs"');
  expect(toolbar).toContain('class="observe-page-actions"');
  expect((html.match(/class="observe-tabs"/g) ?? []).length).toBe(1);
  const start = html.indexOf('<header class="observe-session-header"');
  const header = html.slice(start, html.indexOf('</header>', start));
  const heading = header.slice(header.indexOf('class="observe-session-heading"'), header.indexOf('class="observe-session-actions"'));
  const actions = header.slice(header.indexOf('class="observe-session-actions"'));
  expect(heading).toContain('class="observe-session-meta"');
  expect(heading).toContain('observe-session-status running');
  expect(actions).not.toContain('observe-session-status');
  expect(actions).not.toContain('observe-harness-label');
  expect(actions).toContain('aria-label="' + MESSAGES[language].characterConsole.tools + '"');
});

describe('compact observed handover action', () => {
  const agents = { sessionContinuity: vi.fn(), previewHandover: vi.fn(), applyHandover: vi.fn() } as unknown as AgentHostApi;
  const props = { t: MESSAGES.en, agents, state, source: { kind: 'observed' as const, id: observed.id }, onContinued: vi.fn(), onOpenSettings: vi.fn() };
  it('offers an accessible icon action without taking the header width of a full text button', () => {
    const html = renderToStaticMarkup(createElement(ContinueInExtalia, { ...props, compact: true }));
    expect(html).toContain('class="continue-panel compact"');
    expect(html).toContain('class="icon-button small"');
    expect(html).toContain('aria-label="' + MESSAGES.en.sessionHandover.title + '"');
    expect(html).not.toContain('</svg>' + MESSAGES.en.sessionHandover.title);
  });
  it('retains the full visible text action for existing non-compact consumers', () => {
    const html = renderToStaticMarkup(createElement(ContinueInExtalia, props));
    expect(html).toContain('</svg>' + MESSAGES.en.sessionHandover.title);
  });
});
