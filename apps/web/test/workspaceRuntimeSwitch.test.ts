import type { Workspace } from '@extalia/core';
import type { ConnectionView, SessionSummary } from '@extalia/platform';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { modelChoicesKey, sessionRuntime, workspaceTargetChanged } from '../src/chat/sessionRuntime';
import { WorkspaceRuntimeNotice } from '../src/chat/WorkspaceRuntimeNotice';
import { MESSAGES } from '../src/i18n';
import { createMockPlatform } from '../src/host/mockHost';

const at = '2026-11-08T00:00:00.000Z';
const workspace: Workspace = { id: 'workspace-a', profileId: 'default', name: 'Example', providerProfileId: 'connection-a', createdAt: at, updatedAt: at };
const native: SessionSummary = { id: 'session-a', workspaceId: workspace.id, connectionId: 'connection-a', title: 'Example task', control: 'managed', running: false, createdAt: at, lastActiveAt: at };
const hermes: SessionSummary = { ...native, id: 'session-b', connectionId: '', runtime: { id: 'hermes', profile: 'example-profile' } };
const hermesWorkspace: Workspace = { ...workspace, providerProfileId: undefined, runtimeId: 'hermes', runtimeProfileId: 'example-profile' };
const connection: ConnectionView = { id: 'connection-a', name: 'Example provider', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'example-model', credential: { kind: 'none' }, credentialStatus: 'not-needed', features: { memory: 'off', skills: 'off' }, orchestration: { enabled: false, maxDelegations: 0, tiers: {} }, createdAt: at, updatedAt: at };
const state = { profile: { id: 'default', name: 'Example' }, connections: [connection] };

describe('workspace defaults and saved session targets', () => {
  it('keeps saved runtime in both switch directions while new conversations use workspace defaults', () => {
    expect(sessionRuntime(workspace, hermes)).toBe('hermes');
    expect(sessionRuntime(workspace)).toBe('extalia-native');
    expect(sessionRuntime(hermesWorkspace, native)).toBe('extalia-native');
    expect(sessionRuntime(hermesWorkspace)).toBe('hermes');
    expect(workspaceTargetChanged(workspace, hermes)).toBe(true);
    expect(workspaceTargetChanged(hermesWorkspace, native)).toBe(true);
    expect(workspaceTargetChanged(workspace, native)).toBe(false);
    expect(workspaceTargetChanged(hermesWorkspace, hermes)).toBe(false);
    expect(workspaceTargetChanged(workspace, { ...native, control: 'observed' })).toBe(false);
    expect(workspaceTargetChanged(workspace, { ...native, workspaceId: 'foreign' })).toBe(false);
    expect(workspaceTargetChanged({ ...workspace, providerProfileId: 'connection-b' }, native)).toBe(true);
    expect(workspaceTargetChanged({ ...hermesWorkspace, runtimeProfileId: 'another-profile' }, hermes)).toBe(true);
  });

  it('invalidates same-ID default catalogs and saved connection edits without adopting another workspace runtime', () => {
    const original = modelChoicesKey(state, workspace);
    expect(modelChoicesKey(state, hermesWorkspace)).not.toBe(original);
    expect(modelChoicesKey(state, { ...workspace, providerProfileId: 'connection-b' })).not.toBe(original);
    expect(modelChoicesKey(state, { ...workspace, updatedAt: '2026-11-08T01:00:00.000Z' })).toBe(original);
    expect(modelChoicesKey(state, hermesWorkspace, native)).toBe(modelChoicesKey(state, workspace, native));
    expect(modelChoicesKey({ ...state, connections: [{ ...connection, model: 'changed-model' }] }, workspace, native)).not.toBe(modelChoicesKey(state, workspace, native));
    expect(modelChoicesKey(state, workspace, native)).not.toBe(modelChoicesKey(state, workspace, hermes));
  });

  it.each(['en', 'id'] as const)('explains the preserved session and offers a fresh-default action in %s', language => {
    const html = renderToStaticMarkup(createElement(WorkspaceRuntimeNotice, { t: MESSAGES[language], state, workspace, session: hermes, onNewSession() {} }));
    expect(html).toContain('Hermes Agent');
    expect(html).toContain('Extalia Native');
    expect(html).toContain('Example provider');
    expect(html).toContain(MESSAGES[language].chat.startWithWorkspaceDefault);
    expect(renderToStaticMarkup(createElement(WorkspaceRuntimeNotice, { t: MESSAGES[language], state, workspace, session: native }))).toBe('');
  });

  it('keeps mock and real model-target semantics aligned after editing the same workspace', async () => {
    const api = createMockPlatform({ seed: 'setup', host: 'bridge', hermes: true }).capabilities.agents!;
    const connected = await api.saveConnection({ name: 'Example', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'example-model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } });
    const created = await api.saveWorkspace({ name: 'Example', projectLocation: '/projects/example', runtimeId: 'hermes', runtimeProfileId: 'example-profile', runtimeModel: 'example-model', permissions: { fileWrite: 'ask', commands: 'ask' } });
    const id = created.workspaces[0]!.id;
    const old = await api.createSession(id);
    expect(old.options?.model).toBe('example-model');
    await api.saveWorkspace({ id, name: 'Example', projectLocation: '/projects/example', connectionId: connected.connections[0]!.id, permissions: { fileWrite: 'ask', commands: 'ask' } });
    expect((await api.modelChoices(id)).runtime).toBe('extalia-native');
    expect((await api.modelChoices(id, old.id)).runtime).toBe('hermes');
    const fresh = await api.createSession(id);
    expect(fresh.runtime).toBeUndefined();
    await api.saveWorkspace({ id, name: 'Example', projectLocation: '/projects/example', runtimeId: 'hermes', permissions: { fileWrite: 'ask', commands: 'ask' } });
    expect((await api.modelChoices(id, fresh.id)).runtime).toBe('extalia-native');
    await expect(api.modelChoices('missing', old.id)).rejects.toThrow();
  });
});
