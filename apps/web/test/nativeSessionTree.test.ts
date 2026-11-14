import type { Workspace } from '@extalia/core';
import type { AgentHostApi, HostState, SessionSummary } from '@extalia/platform';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NativeSessionTree } from '../src/chat/NativeSessionTree';
import { nativeSessionDrop, parseNativeSessionDrag, registeredSessionFolders } from '../src/chat/nativeSessionTreeModel';
import { MESSAGES } from '../src/i18n';

const at = '2026-11-13T00:00:00Z';
const workspace = (id = 'workspace-a'): Workspace => ({ id, profileId: 'profile', name: id, projectLocation: `/projects/${id}`, additionalProjectLocations: [`/projects/${id}/extra`], createdAt: at, updatedAt: at });
const session = (id = 'native'): SessionSummary => ({ id, workspaceId: 'workspace-a', connectionId: 'connection', title: `Title ${id}`, control: 'managed', running: false, createdAt: at, lastActiveAt: at });
const state = (): HostState => ({ profile: { id: 'profile', name: 'Example' }, workspaces: [workspace(), workspace('workspace-b')], sessions: [session()], connections: [], library: [], setupComplete: true, dataDirectory: '/example/extalia', storage: { dataDirectory: '/example/extalia', secretStore: 'memory' }, host: { kind: 'bridge', version: 'test' } });

describe('Native same-workspace drag decisions', () => {
  const extra = '/projects/workspace-a/extra';
  const drag = { sessionId: 'native', workspaceId: 'workspace-a' };
  it('resolves the existing Native session from current state and exact registered folders', () => {
    const s = state();
    expect(nativeSessionDrop(s.sessions, s.workspaces, drag, 'workspace-a', extra)).toBe(s.sessions[0]);
    expect(nativeSessionDrop(s.sessions, s.workspaces, drag, 'workspace-a', '/unregistered')).toBeUndefined();
    expect(nativeSessionDrop(s.sessions, s.workspaces, drag, 'workspace-a', '/projects/workspace-a')).toBeUndefined();
    expect(nativeSessionDrop(s.sessions, s.workspaces, undefined, 'workspace-a', extra)).toBeUndefined();
    expect(nativeSessionDrop([], s.workspaces, drag, 'workspace-a', extra)).toBeUndefined();
  });
  it('rejects another workspace even when access is read-write and the source payload claims otherwise', () => {
    const s = state(); s.workspaces.forEach(workspace => { workspace.crossWorkspaceAccess = 'read-write'; });
    expect(nativeSessionDrop(s.sessions, s.workspaces, drag, 'workspace-b', '/projects/workspace-b')).toBeUndefined();
    expect(nativeSessionDrop(s.sessions, s.workspaces, { ...drag, workspaceId: 'workspace-b' }, 'workspace-b', '/projects/workspace-b')).toBeUndefined();
  });
  it.each([
    { running: true }, { transient: true }, { pendingApprovalId: 'approval' },
    { control: 'observed' as const }, { runtime: { id: 'hermes' as const, profile: 'default' } },
  ])('rejects a currently ineligible session %j', patch => {
    const s = state(); s.sessions[0] = { ...session(), ...patch };
    expect(nativeSessionDrop(s.sessions, s.workspaces, drag, 'workspace-a', extra)).toBeUndefined();
  });
  it('uses session runtime ownership when a workspace default changes to Hermes', () => {
    const s = state(); s.workspaces[0]!.runtimeId = 'hermes';
    expect(nativeSessionDrop(s.sessions, s.workspaces, drag, 'workspace-a', extra)).toBe(s.sessions[0]);
    s.workspaces[0]!.mode = 'observe';
    expect(nativeSessionDrop(s.sessions, s.workspaces, drag, 'workspace-a', extra)).toBeUndefined();
  });
  it('parses only session identity and deduplicates registered root choices', () => {
    expect(parseNativeSessionDrag('{"sessionId":"native","workspaceId":"workspace-a","projectLocation":"/foreign"}')).toEqual(drag);
    for (const value of ['text', 'null', '{}', '{"sessionId":1,"workspaceId":"workspace-a"}']) expect(parseNativeSessionDrag(value)).toBeUndefined();
    expect(registeredSessionFolders({ ...workspace(), additionalProjectLocations: ['/projects/workspace-a', '/projects/workspace-a/extra', '/projects/workspace-a/extra'] })).toEqual(['/projects/workspace-a', '/projects/workspace-a/extra']);
  });
});

describe('Native workspace folder navigation presentation', () => {
  const html = (s: HostState, language: 'en' | 'id' = 'en') => renderToStaticMarkup(createElement(NativeSessionTree, {
    t: MESSAGES[language], language, agents: { setSessionProjectRoot: vi.fn() } as unknown as AgentHostApi, state: s, workspaceId: 'workspace-a', activeId: 'native',
    onSelect: vi.fn(), onState: vi.fn(), onSettings: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(),
  }));
  it.each(['en', 'id'] as const)('shows registered folders, compact actual-work spinners and Native settings (%s)', language => {
    const s = state(); s.sessions[0]!.running = true;
    const rendered = html(s, language);
    expect(rendered).toContain('workspace-a'); expect(rendered).toContain('workspace-b');
    expect(rendered).toContain('title="/projects/workspace-a/extra"');
    expect(rendered).toContain(MESSAGES[language].chat.sessionSettings.title);
    expect(rendered).toContain('session-browser-spinner spin');
    expect(rendered).toContain('draggable="false"');
    expect(rendered).toContain(MESSAGES[language].chat.rename);
    expect(rendered).toContain(MESSAGES[language].common.delete);
  });
  it('opens the selected additional folder and leaves the old folder mounted as an empty target', () => {
    const s = state(); s.sessions[0]!.projectLocation = '/projects/workspace-a/extra';
    const rendered = html(s);
    expect(rendered).toContain('Title native');
    expect(rendered).toContain('aria-expanded="false" title="/projects/workspace-a"');
    expect(rendered).toContain('title="/projects/workspace-a/extra"');
    expect(rendered).toContain('draggable="true"');
  });
  it('keeps non-Native rows accessible without exposing Native folder actions or observed-only workspaces', () => {
    const s = state(); s.workspaces.push({ ...workspace('observe'), mode: 'observe' });
    s.sessions = [{ ...session('hermes'), runtime: { id: 'hermes', profile: 'default' } }, { ...session('observed'), control: 'observed' }];
    const rendered = html(s);
    expect(rendered).toContain('Title hermes'); expect(rendered).toContain('Title observed');
    expect(rendered).toContain(MESSAGES.en.chat.sessionSettings.other);
    expect(rendered).not.toContain('draggable=');
    expect(rendered).not.toContain('aria-label="Session settings:');
    expect(rendered).not.toContain('title="/projects/observe"');
  });
});
