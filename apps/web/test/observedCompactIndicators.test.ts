import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@extalia/platform';
import { SessionList } from '../src/chat/SessionList';
import { SessionBrowserIndicators } from '../src/sessions/SessionBrowser';
import { MESSAGES } from '../src/i18n';

const row: SessionSummary = { id: 'session-a', title: 'Example conversation', control: 'observed', workspaceId: '', connectionId: 'observed', running: true, createdAt: '2026-01-01T00:00:00Z', lastActiveAt: '2026-01-01T00:00:00Z', observation: { sourceId: 'codex', nativeSessionId: 'source-a', watching: true, status: 'watching', unreadOutput: true, outputRevision: 'output-1' } };
const props = { t: MESSAGES.en, language: 'en', sessions: [row], activeId: row.id, onSelect: vi.fn(), onRename: vi.fn(), onDelete: vi.fn() };

describe('minimal observed tree indicators', () => {
  it('shows one spinner and one real unread dot without running text, numeric work badges or repeated harness text', () => {
    const html = renderToStaticMarkup(createElement(SessionList, { ...props, compactIndicators: true, showSource: true }));
    expect(html).toContain('compact-indicators');
    expect((html.match(/session-browser-spinner spin/g) ?? []).length).toBe(1);
    expect((html.match(/class="session-browser-unread"/g) ?? []).length).toBe(1);
    expect(html).not.toContain('badge running');
    expect(html).not.toContain('session-source');
    expect(html).toContain('<time');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('aria-label="' + MESSAGES.en.sessionBrowser.unread + '"');
  });
  it('keeps normal Native lists unchanged unless compact indicators were requested', () => {
    const html = renderToStaticMarkup(createElement(SessionList, props));
    expect(html).toContain('badge running');
    expect(html).not.toContain('session-browser-spinner');
    expect(html).not.toContain('session-browser-unread');
  });
  it.each(['en', 'id'] as const)('keeps aggregate indicators small and accessible with no visible status text (%s)', language => {
    const html = renderToStaticMarkup(createElement(SessionBrowserIndicators, { t: MESSAGES[language], running: true, unread: true }));
    expect(html).toContain('aria-label="' + MESSAGES[language].chat.running + '"');
    expect(html).toContain('aria-label="' + MESSAGES[language].sessionBrowser.unread + '"');
    expect(html.replace(/<[^>]*>/g, '')).toBe('');
    expect(html).not.toContain('session-browser-running');
  });
  it('shows no unread dot for ordinary working sessions without new assistant output', () => {
    const html = renderToStaticMarkup(createElement(SessionList, { ...props, compactIndicators: true, sessions: [{ ...row, observation: { ...row.observation!, unreadOutput: false } }] }));
    expect(html).toContain('session-browser-spinner');
    expect(html).not.toContain('class="session-browser-unread"');
  });
});
