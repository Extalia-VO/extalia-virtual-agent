import type { Workspace } from '@extalia/core';
import { GLOBAL_OBSERVE_WORKSPACE_ID, type SessionSummary } from '@extalia/platform';
import { describe, expect, it } from 'vitest';
import { globalObservedConnection, observedLearningWorkspace } from '../src/observedLearningScope.js';

const workspace = (id: string, profileId = 'default', connectionId?: string): Workspace => ({
  id, name: id, profileId, ...(connectionId ? { providerProfileId: connectionId } : {}),
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});
const source = (mode?: NonNullable<SessionSummary['observation']>['workspaceLinkState'], workspaceId = ''): SessionSummary => ({
  id: 'observed-one', workspaceId, connectionId: '', title: 'Observed work', control: 'observed', running: false,
  createdAt: '2026-01-01T00:00:00.000Z', lastActiveAt: '2026-01-01T00:00:01.000Z',
  observation: { sourceId: 'codex', nativeSessionId: 'native-one', watching: true, status: 'watching',
    ...(mode ? { workspaceLinkState: mode } : {}) },
});

describe('observed learning scope resolution', () => {
  it('routes only an explicitly unbound source to default without fabricating a project', () => {
    expect(observedLearningWorkspace(source('unbound'), [], 'profile-default')).toEqual({
      workspaceId: GLOBAL_OBSERVE_WORKSPACE_ID, profileId: 'profile-default', workspace: undefined,
    });
    expect(observedLearningWorkspace(source(), [], 'default')).toBeUndefined();
    expect(observedLearningWorkspace({ ...source(), observation: undefined }, [], 'default')).toBeUndefined();
    expect(observedLearningWorkspace(source('unbound', GLOBAL_OBSERVE_WORKSPACE_ID), [], 'default')).toBeUndefined();
  });

  it.each(['automatic', 'explicit'] as const)('retains the exact registered isolated profile for %s mapping', mode => {
    const selected = { ...workspace('isolated-work', 'isolated-profile', 'private-connection'), crossWorkspaceAccess: 'isolated' as const };
    const unrelated = workspace('shared-work', 'default', 'global-connection');
    const resolved = observedLearningWorkspace(source(mode, selected.id), [unrelated, selected], 'default');
    expect(resolved).toEqual({ workspaceId: selected.id, profileId: selected.profileId, workspace: selected });
    expect(observedLearningWorkspace(source(mode, selected.id), [unrelated], 'default')).toBeUndefined();
  });

  it.each(['invalid', 'ambiguous'] as const)('never falls back to global after a %s physical link', mode => {
    const registered = workspace('known-work');
    expect(observedLearningWorkspace(source(mode), [registered], 'default')).toBeUndefined();
    expect(observedLearningWorkspace(source(mode, registered.id), [registered], 'default')).toBeUndefined();
  });
});

describe('global Observe model route', () => {
  it('prefers the sole eligible default-profile route over other saved connections', () => {
    const workspaces = [workspace('one', 'default', 'shared'), workspace('two', 'default', 'shared'), workspace('private', 'isolated', 'private')];
    expect(globalObservedConnection(workspaces, 'default', ['shared', 'private', 'other'])).toBe('shared');
  });

  it('uses a sole eligible saved connection when no default workspace owns a route', () => {
    expect(globalObservedConnection([], 'default', ['one'])).toBe('one');
    expect(globalObservedConnection([], 'default', ['one', 'one'])).toBe('one');
    expect(globalObservedConnection([workspace('private', 'isolated', 'one')], 'default', ['one'])).toBe('one');
  });

  it('refuses absent or ambiguous choices rather than selecting the first', () => {
    expect(globalObservedConnection([], 'default', [])).toBeUndefined();
    expect(globalObservedConnection([], 'default', ['one', 'two'])).toBeUndefined();
    expect(globalObservedConnection([workspace('one', 'default', 'one'), workspace('two', 'default', 'two')], 'default', ['one', 'two'])).toBeUndefined();
  });

  it('never uses a default route that is outside the current eligible set', () => {
    const workspaces = [workspace('one', 'default', 'history-off')];
    expect(globalObservedConnection(workspaces, 'default', [])).toBeUndefined();
    expect(globalObservedConnection(workspaces, 'default', ['eligible'])).toBe('eligible');
    expect(globalObservedConnection(workspaces, 'default', ['first', 'second'])).toBeUndefined();
  });
});
