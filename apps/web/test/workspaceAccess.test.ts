import { MAX_WORKSPACE_FOLDERS, WORKSPACE_CROSS_ACCESS, type Workspace } from '@extalia/core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createMockPlatform } from '../src/host/mockHost';
import { MESSAGES } from '../src/i18n';
import { WorkspacesSection } from '../src/pages/settings/WorkspacesSection';
import { draftFromWorkspace, emptyWorkspaceDraft, toWorkspaceInput, validateWorkspace, validWorkspaceFolders } from '../src/setup/validation';
import { WorkspaceForm } from '../src/setup/WorkspaceForm';

const at = '2026-11-08T00:00:00.000Z';
const workspace: Workspace = { id: 'w1', profileId: 'default', name: 'Example', projectLocation: '/projects/example', providerProfileId: 'c1', createdAt: at, updatedAt: at };
const ready = { ...emptyWorkspaceDraft('c1'), name: workspace.name, folderInput: workspace.projectLocation!, folder: { path: workspace.projectLocation!, name: 'example' } };

describe('workspace Native access drafts', () => {
  it('uses read-only by default and round-trips every policy when editing or switching runtimes', () => {
    expect(ready.crossWorkspaceAccess).toBe('read-only');
    expect(toWorkspaceInput(ready)).toMatchObject({ crossWorkspaceAccess: 'read-only', additionalProjectLocations: [] });
    expect(draftFromWorkspace(workspace).crossWorkspaceAccess).toBe('read-only');
    for (const crossWorkspaceAccess of WORKSPACE_CROSS_ACCESS) {
      const draft = draftFromWorkspace({ ...workspace, crossWorkspaceAccess, additionalProjectLocations: ['/projects/shared'] });
      expect(validateWorkspace(draft)).toEqual({});
      expect(toWorkspaceInput(draft)).toMatchObject({ id: workspace.id, projectLocation: workspace.projectLocation, crossWorkspaceAccess, additionalProjectLocations: ['/projects/shared'] });
      const hermes = { ...draft, runtimeId: 'hermes' as const };
      expect(toWorkspaceInput(hermes)).toMatchObject({ runtimeId: 'hermes', crossWorkspaceAccess, additionalProjectLocations: ['/projects/shared'] });
      expect(toWorkspaceInput({ ...hermes, runtimeId: 'extalia-native' })).toMatchObject({ crossWorkspaceAccess, additionalProjectLocations: ['/projects/shared'] });
    }
  });

  it('copies folder lists and rejects blank, duplicate, malformed and excessive paths', () => {
    const source = { ...workspace, additionalProjectLocations: ['/projects/shared'] };
    const draft = draftFromWorkspace(source);
    draft.additionalProjectLocations.push('/projects/extra');
    expect(source.additionalProjectLocations).toEqual(['/projects/shared']);
    const input = toWorkspaceInput(draft);
    draft.additionalProjectLocations.pop();
    expect(input.additionalProjectLocations).toEqual(['/projects/shared', '/projects/extra']);
    expect(validWorkspaceFolders('/projects/main', Array.from({ length: MAX_WORKSPACE_FOLDERS - 1 }, (_, n) => `/projects/extra-${n}`))).toBe(true);
    for (const paths of [[''], ['  '], ['/projects/example/'], ['/projects/extra', '/projects/extra/'], ['/projects/a\nb'], ['/projects/a\0b'], Array.from({ length: MAX_WORKSPACE_FOLDERS }, (_, n) => `/projects/extra-${n}`)]) {
      expect(validateWorkspace({ ...ready, additionalProjectLocations: paths })).toEqual({ additionalFolders: 'additionalFoldersInvalid' });
    }
  });
});

describe('Native workspace access controls', () => {
  const agents = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;

  it.each(['en', 'id'] as const)('shows Native policy and folder controls with clear descriptions in %s', language => {
    const t = MESSAGES[language];
    for (const crossWorkspaceAccess of WORKSPACE_CROSS_ACCESS) {
      const draft = { ...ready, crossWorkspaceAccess, additionalProjectLocations: ['/projects/shared'] };
      const html = renderToStaticMarkup(createElement(WorkspaceForm, { t, agents, draft, onChange() {} }));
      expect(html).toContain(t.workspace.crossAccess.heading);
      expect(html).toContain(t.workspace.crossAccess.modes[crossWorkspaceAccess]);
      expect(html).toContain(t.workspace.crossAccess.descriptions[crossWorkspaceAccess]);
      expect(html).toContain(t.workspace.crossAccess.lead);
      expect(html).toContain(t.workspace.crossAccess.detail);
      expect(html).toContain(t.workspace.additionalFolders.heading);
      expect(html).toContain(t.workspace.additionalFolders.lead);
      expect(html).toContain('/projects/shared');
      expect(html).not.toContain('folder-manual');
      expect(html).not.toContain('-folder-input');
      expect(html).not.toContain('-additional-path');
      expect(html.match(/class="copy-button /g)).toHaveLength(2);
      const hermes = renderToStaticMarkup(createElement(WorkspaceForm, { t, agents, draft: { ...draft, runtimeId: 'hermes' }, onChange() {} }));
      expect(hermes).not.toContain(t.workspace.crossAccess.heading);
      expect(hermes).not.toContain(t.workspace.additionalFolders.heading);
    }
  });

  it('lists the effective Native policy and extra folders without applying Native settings to Hermes', async () => {
    const state = await agents.getState();
    const render = (runtimeId?: 'hermes') => renderToStaticMarkup(createElement(WorkspacesSection, {
      t: MESSAGES.en, agents, state: { ...state, workspaces: [{ ...workspace, runtimeId, additionalProjectLocations: ['/projects/shared'] }] }, onState() {},
    }));
    expect(render()).toContain(MESSAGES.en.workspace.crossAccess.modes['read-only']);
    expect(render()).toContain('/projects/shared');
    expect(render('hermes')).not.toContain(MESSAGES.en.workspace.crossAccess.heading);
    expect(render('hermes')).not.toContain('/projects/shared');
  });

  it('creates, edits and reloads the Native policy and own folders through the host input', async () => {
    const api = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    const initial = await api.getState();
    const created = await api.saveWorkspace(toWorkspaceInput({ ...ready, connectionId: initial.connections[0]!.id, crossWorkspaceAccess: 'isolated', additionalProjectLocations: ['/projects/shared'] }));
    const saved = created.workspaces.find(item => item.name === workspace.name)!;
    expect(saved).toMatchObject({ crossWorkspaceAccess: 'isolated', additionalProjectLocations: ['/projects/shared'] });
    const edited = draftFromWorkspace(saved);
    edited.crossWorkspaceAccess = 'read-write';
    edited.additionalProjectLocations = ['/projects/other', '/projects/extra'];
    await api.saveWorkspace(toWorkspaceInput(edited));
    expect((await api.getState()).workspaces.find(item => item.id === saved.id)).toMatchObject({ projectLocation: workspace.projectLocation, crossWorkspaceAccess: 'read-write', additionalProjectLocations: edited.additionalProjectLocations });
    await api.saveWorkspace(toWorkspaceInput({ ...edited, additionalProjectLocations: [] }));
    expect((await api.getState()).workspaces.find(item => item.id === saved.id)!.additionalProjectLocations ?? []).toEqual([]);
  });
});
