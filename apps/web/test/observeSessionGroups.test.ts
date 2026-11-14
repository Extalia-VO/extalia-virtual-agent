import type { Workspace } from '@extalia/core';
import type { AgentHostApi, HostState, SessionSummary } from '@extalia/platform';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { groupObserveSessions, observeProject } from '../src/observe/observeSessionGroups';
import { ObserverPage } from '../src/pages/ObserverPage';
import { MESSAGES } from '../src/i18n';

const workspaces = [{ id: 'workspace-one', name: 'Example workspace', projectLocation: '/projects/example' }] as Workspace[];
function session(id: string, sourceId = 'codex', change: Partial<SessionSummary> = {}): SessionSummary {
  return { id, title: `Session ${id}`, workspaceId: 'workspace-one', connectionId: 'observed', control: 'observed', running: false,
    createdAt: '2026-01-01T00:00:00Z', lastActiveAt: '2026-01-01T00:00:00Z',
    observation: { sourceId, nativeSessionId: '11111111-1111-4111-8111-111111111111', projectPath: '/projects/example', watching: true, status: 'watching' }, ...change };
}

describe('Observe session navigation', () => {
  it('groups by exact harness then host workspace and reported folder without mixing projects', () => {
    const a = session('one'), b = session('two', 'antigravity'), c = session('three', 'codex', { workspaceId: '' });
    const d = session('four', 'codex', { observation: { ...a.observation!, projectPath: '/projects/example/nested' } });
    const groups = groupObserveSessions([a, b, c, d], workspaces);
    expect(groups.map(group => [group.id, group.count])).toEqual([['codex', 3], ['antigravity', 1]]);
    expect(groups[0]!.projects.map(group => [group.workspaceId, group.projectPath])).toEqual([
      ['workspace-one', '/projects/example/nested'], ['workspace-one', '/projects/example'], [undefined, '/projects/example'],
    ]);
    expect(observeProject(c, workspaces)).toMatchObject({ projectPath: '/projects/example', folderName: 'example' });
    expect(observeProject(c, workspaces).workspaceId).toBeUndefined();
    expect(c.workspaceId).toBe('');
  });

  it('searches literal title, model, harness, workspace and folder, and excludes managed sessions', () => {
    const rows = [session('one', 'codex', { model: 'example-model' }), session('two', 'antigravity'), session('managed', 'codex', { control: 'managed' })];
    for (const query of ['EXAMPLE WORKSPACE', '/projects/example']) expect(groupObserveSessions(rows, workspaces, query).map(group => group.count)).toEqual([1, 1]);
    expect(groupObserveSessions(rows, workspaces, 'example-model').flatMap(group => group.projects.flatMap(project => project.sessions.map(row => row.id)))).toEqual(['one']);
    expect(groupObserveSessions(rows, workspaces, 'antigravity').map(group => group.id)).toEqual(['antigravity']);
    expect(groupObserveSessions(rows, workspaces, 'missing')).toEqual([]);
  });

  it('filters work, approval/question attention, and paused observation from reported state only', () => {
    const running = session('working', 'codex', { running: true }), approval = session('approval', 'codex', { pendingApprovalId: 'approval' });
    const question = session('question'), paused = session('paused', 'codex', { observation: { ...question.observation!, watching: false, status: 'paused' } });
    const rows = [running, approval, question, paused], ids = (filter: 'running' | 'attention' | 'paused') => groupObserveSessions(rows, workspaces, '', filter, new Set(['question'])).flatMap(group => group.projects.flatMap(project => project.sessions.map(row => row.id)));
    expect(ids('running')).toEqual(['working']);
    expect(ids('attention')).toEqual(['approval', 'question']);
    expect(ids('paused')).toEqual(['paused']);
  });

  it('sorts newest activity first without changing the host session list and handles unknown folders', () => {
    const old = session('old'), recent = session('recent', 'gemini-cli', { lastActiveAt: '2026-01-02T00:00:00Z' });
    const rows = [old, recent];
    expect(groupObserveSessions(rows, workspaces).map(group => group.id)).toEqual(['gemini-cli', 'codex']);
    expect(rows).toEqual([old, recent]);
    expect(observeProject(session('unknown', 'codex', { workspaceId: '', observation: undefined }), workspaces)).toEqual({ id: '["",""]' });
  });
});

it.each(['en', 'id'] as const)('places transcript before the composer and keeps technical controls outside the conversation (%s)', language => {
  const t = MESSAGES[language];
  const state = { sessions: [session('selected')], workspaces, connections: [] } as unknown as HostState;
  const html = renderToStaticMarkup(createElement(ObserverPage, { t, language, state, agents: {} as AgentHostApi,
    onState: vi.fn(), onContinued: vi.fn(), onOpenSettings: vi.fn() }));
  expect(html).toContain(t.observer.searchSessions);
  expect(html).toContain('Example workspace');
  expect(html.indexOf('observe-transcript-region')).toBeLessThan(html.indexOf('observe-composer-region'));
  const conversation = html.slice(html.indexOf('<section class="observe-conversation"'), html.indexOf('<aside class="observe-tools-panel"'));
  expect(conversation).not.toContain(t.observedCodexPrompt.settings);
  expect(html).toMatch(/class="observe-tools-panel"[^>]+hidden=""/);
  expect(html).toContain(t.observer.folder);
});
