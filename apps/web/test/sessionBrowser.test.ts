import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentHostApi, HostState } from '@extalia/platform';
import { LocalProjectTree } from '../src/sessions/LocalProjectTree';
import { SessionBrowser } from '../src/sessions/SessionBrowser';
import { MESSAGES } from '../src/i18n';
import { missingSessionBrowserCapability } from '../src/sessions/sessionBrowserCompatibility';

const row = (id: number, projectPath?: string, sourceId = 'codex') => ({ sourceId, id: String(id), title: `Session ${id}`, projectPath, updatedAt: new Date(Date.UTC(2026, 0, 1, 0, id)).toISOString() });
type Row = ReturnType<typeof row>;
const path = (item: Row) => item.projectPath;
const updatedAt = (item: Row) => item.updatedAt;
const renderRow = (item: Row) => createElement('li', { key: item.id, 'data-session': item.id }, item.title);
const tree = (rows: Row[], language: 'en' | 'id' = 'en') => renderToStaticMarkup(createElement(LocalProjectTree<Row>, { t: MESSAGES[language], rows, path, updatedAt, source: (item: Row) => item.sourceId, renderRow }));

describe('compact source project navigation', () => {
  it('renders a bounded first page of newest session titles, preserving the source folder name', () => {
    const html = tree(Array.from({ length: 1000 }, (_, index) => row(index, '/projects/example')));
    expect((html.match(/data-session=/g) ?? []).length).toBe(12);
    expect(html).toContain('Session 999');
    expect(html).not.toContain('Session 987');
    expect(html).toContain(MESSAGES.en.sessionBrowser.older);
    expect(html).toContain('<span>example</span>');
    expect(html).not.toContain('project/project');
  });

  it('keeps source paths distinct even when names match, and does not render collapsed folder rows', () => {
    const html = tree([row(1, '/projects/first/example'), row(2, '/projects/second/example')]);
    expect(html).toContain('/projects/first/example');
    expect(html).toContain('/projects/second/example');
    expect(html).toContain('Session 2');
    expect(html).not.toContain('Session 1');
    expect((html.match(/class="session-browser-folder"/g) ?? []).length).toBe(2);
  });

  it.each(['en', 'id'] as const)('separates the project and no-project expand regions (%s)', language => {
    const html = tree([row(1, '/projects/example'), row(2)], language);
    expect(html).toContain(MESSAGES[language].sessionBrowser.projects);
    expect(html).toContain(MESSAGES[language].sessionBrowser.unassigned);
    expect((html.match(/class="session-browser-section-toggle"/g) ?? []).length).toBe(2);
    expect(html).toContain('Session 1');
    expect(html).toContain('Session 2');
  });

  it('renders only the first project page while retaining a load-more affordance', () => {
    const html = tree(Array.from({ length: 100 }, (_, index) => row(index, `/projects/folder-${index}`)));
    expect((html.match(/class="session-browser-folder"/g) ?? []).length).toBe(12);
    expect(html).toContain(MESSAGES.en.sessionBrowser.showMore);
    expect(html).toContain('folder-99');
    expect(html).not.toContain('folder-87');
  });

  it('keeps harnesses above projects, newest first, without mounting collapsed agent sessions', () => {
    const html = tree([row(1, '/projects/example', 'codex'), row(2, '/projects/example', 'claude-code'), row(3, undefined, 'antigravity')]);
    expect(html.indexOf('Antigravity')).toBeLessThan(html.indexOf('Claude Code'));
    expect(html.indexOf('Claude Code')).toBeLessThan(html.indexOf('Codex'));
    expect((html.match(/class="session-browser-harness-toggle"/g) ?? []).length).toBe(3);
    expect(html).toContain('Session 3');
    expect(html).not.toContain('Session 2');
    expect(html).not.toContain('Session 1');
    expect(html).toContain('session-browser-harness-children');
  });

  it('does not invoke remote lists or transcript loaders during render', () => {
    const agents = { sessionBrowserGroups: vi.fn(), sessionBrowserSessions: vi.fn(), observationSession: vi.fn(), librarySession: vi.fn() } as unknown as AgentHostApi;
    const html = renderToStaticMarkup(createElement(SessionBrowser, { t: MESSAGES.en, agents, state: { sessions: [], workspaces: [], library: [] } as unknown as HostState, collection: 'library', emptyLabel: 'Empty', renderRows: () => null }));
    expect(html).not.toContain(MESSAGES.en.sessionBrowser.unavailable);
    for (const method of Object.values(agents)) expect(method).not.toHaveBeenCalled();
  });
});

 it('downgrades only explicit missing old-host methods, preserving auth and network errors', () => {
   expect(missingSessionBrowserCapability(new Error('Unknown method.'))).toBe(true);
   expect(missingSessionBrowserCapability(new Error("Error invoking remote method 'agent:sessionBrowserGroups': Error: No handler registered for 'agent:sessionBrowserGroups'"))).toBe(true);
   expect(missingSessionBrowserCapability(new Error('This host does not support this action.'))).toBe(true);
   for (const message of ['Unauthorized.', 'Network request failed.', 'Unknown session.', 'Server unavailable.']) expect(missingSessionBrowserCapability(new Error(message))).toBe(false);
 });
