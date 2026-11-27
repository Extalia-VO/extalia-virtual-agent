import { defaultOrchestration, type Workspace } from '@extalia/core';
import { AGENT_HOST_METHODS, type AgentHostApi, type HostState, type SessionMovePreview, type SessionSummary } from '@extalia/platform';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { navigationGroups, resolveLandingPage } from '../src/appMode';
import { ChatPage } from '../src/chat/ChatPage';
import { NativeSessionTree } from '../src/chat/NativeSessionTree';
import { ProjectProvisionDialog } from '../src/chat/ProjectProvisionDialog';
import { SessionMoveDialog } from '../src/chat/SessionMoveDialog';
import { composerDraftKey, composerDraftStore } from '../src/chat/composerDrafts';
import { nativeSessionDrop } from '../src/chat/nativeSessionTreeModel';
import { resolveChat } from '../src/chat/selection';
import { createComposerSession } from '../src/chat/sessionHandoff';
import { createMockPlatform } from '../src/host/mockHost';
import { MESSAGES } from '../src/i18n';
import { DEFAULT_PREFERENCES, decodePreferences } from '../src/preferences';
import { SettingsPage } from '../src/pages/SettingsPage';
import { SetupWizard } from '../src/setup/SetupWizard';

const stamp = '2026-11-24T00:00:00.000Z';

const sampleWorkspace = (id = 'workspace-a', name = 'Alpha'): Workspace => ({
  id,
  profileId: 'profile-default',
  name,
  projectLocation: `/projects/${id}`,
  createdAt: stamp,
  updatedAt: stamp,
});

const sampleSession = (id: string, workspaceId: string | null, lastActiveAt = stamp): SessionSummary => ({
  id,
  workspaceId,
  connectionId: 'connection-1',
  title: `Title ${id}`,
  control: 'managed',
  running: false,
  createdAt: stamp,
  lastActiveAt,
});

function sampleState(overrides: Partial<HostState> = {}): HostState {
  return {
    setupComplete: true,
    workflow: 'managed',
    profile: { id: 'profile-default', name: 'Personal' },
    connections: [{
      id: 'connection-1',
      name: 'Primary Model',
      preset: 'anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://api.example.com',
      model: 'claude-sonnet-5-5',
      credential: { kind: 'none' },
      features: { memory: 'extalia', skills: 'extalia' },
      orchestration: defaultOrchestration('anthropic'),
      createdAt: stamp,
      updatedAt: stamp,
      credentialStatus: 'not-needed',
    }],
    workspaces: [sampleWorkspace()],
    sessions: [],
    library: [],
    dataDirectory: '/Users/<name>/.extalia-vo',
    storage: { dataDirectory: '/Users/<name>/.extalia-vo', secretStore: 'memory' },
    host: { kind: 'bridge', version: 'test' },
    ...overrides,
  };
}

describe('Chat-first landing & Office lazy-loading (ADR 0096)', () => {
  it('defaults managed workflow to Chat, honours landingPage=office, and keeps Observe/static honest', () => {
    expect(DEFAULT_PREFERENCES.landingPage).toBe('chat');
    expect(decodePreferences({ landingPage: 'office' }).landingPage).toBe('office');
    expect(decodePreferences({ landingPage: 'unknown' }).landingPage).toBe('chat');

    expect(resolveLandingPage({ agents: true, workflow: 'managed' })).toBe('chat');
    expect(resolveLandingPage({ agents: true, workflow: 'managed', preference: 'chat' })).toBe('chat');
    expect(resolveLandingPage({ agents: true, workflow: 'managed', preference: 'office' })).toBe('office');
    expect(resolveLandingPage({ agents: true, workflow: 'observe', preference: 'chat' })).toBe('office');
    expect(resolveLandingPage({ agents: false, workflow: 'managed', preference: 'office' })).toBe('start');

    const nav = navigationGroups({ agents: true, workflow: 'managed', canChat: false });
    expect(nav[0]?.pages).toEqual(['chat', 'office', 'observe']);
  });

  it('imports App cleanly without eagerly evaluating OfficePage / WebGL scene modules', async () => {
    const officeModule = await import('../src/App');
    expect(typeof officeModule.App).toBe('function');
  });

  it('renders the Landing page selector in Settings (managed only) and honest SetupWizard CTA', () => {
    const platform = createMockPlatform({ seed: 'ready', host: 'bridge' });
    const agents = platform.capabilities.agents!;
    const managedState = sampleState();

    const settingsEn = renderToStaticMarkup(createElement(SettingsPage, {
      t: MESSAGES.en,
      platform,
      preferences: DEFAULT_PREFERENCES,
      onChange: vi.fn(),
      hostState: managedState,
      onHostState: vi.fn(),
      updateStatus: null,
    }));
    expect(settingsEn).toContain(MESSAGES.en.settings.landingPage);
    expect(settingsEn).toContain(MESSAGES.en.settings.landingPages.chat);
    expect(settingsEn).toContain(MESSAGES.en.settings.landingPages.office);

    const settingsObserve = renderToStaticMarkup(createElement(SettingsPage, {
      t: MESSAGES.en,
      platform,
      preferences: DEFAULT_PREFERENCES,
      onChange: vi.fn(),
      hostState: { ...managedState, workflow: 'observe' },
      onHostState: vi.fn(),
      updateStatus: null,
    }));
    expect(settingsObserve).not.toContain(MESSAGES.en.settings.landingPage);

    const setupHtml = renderToStaticMarkup(createElement(SetupWizard, {
      t: MESSAGES.id,
      platform,
      agents,
      state: managedState,
      preferences: DEFAULT_PREFERENCES,
      onPreferences: vi.fn(),
      onState: vi.fn(),
    }));
    expect(setupHtml).toContain(MESSAGES.id.setup.welcomeTitle);
  });
});

describe('Unassigned session selection, creation, and reviewed attach (ADR 0095)', () => {
  it('resolves unassigned sessions when zero workspaces exist or workspaceId is null', () => {
    const u1 = sampleSession('unassigned-1', null, '2026-11-24T01:00:00.000Z');
    const u2 = sampleSession('unassigned-2', null, '2026-11-24T02:00:00.000Z');
    const w1 = sampleSession('ws-1', 'workspace-a', '2026-11-24T03:00:00.000Z');

    const noWorkspaces = sampleState({ workspaces: [], sessions: [u1, u2] });
    const zeroResolved = resolveChat(noWorkspaces, {});
    expect(zeroResolved.workspace).toBeUndefined();
    expect(zeroResolved.unassigned).toBe(true);
    expect(zeroResolved.sessions.map(item => item.id)).toEqual(['unassigned-2', 'unassigned-1']);
    expect(zeroResolved.session?.id).toBe('unassigned-2');

    const withWorkspaces = sampleState({ sessions: [u1, u2, w1] });
    const explicitUnassigned = resolveChat(withWorkspaces, { workspaceId: null });
    expect(explicitUnassigned.workspace).toBeUndefined();
    expect(explicitUnassigned.unassigned).toBe(true);
    expect(explicitUnassigned.sessions.map(item => item.id)).toEqual(['unassigned-2', 'unassigned-1']);
    expect(explicitUnassigned.session?.id).toBe('unassigned-2');

    const newUnassigned = resolveChat(withWorkspaces, { workspaceId: null, sessionId: null });
    expect(newUnassigned.workspace).toBeUndefined();
    expect(newUnassigned.unassigned).toBe(true);
    expect(newUnassigned.session).toBeUndefined();
  });

  it('supports unassigned sessions, clientRequestId deduplication, landingPage profile, and attach in mockHost', async () => {
    const platform = createMockPlatform({ seed: 'setup', host: 'bridge' });
    const agents = platform.capabilities.agents!;
    await agents.saveConnection({
      name: 'Mock',
      preset: 'custom',
      api: 'openai-chat',
      baseUrl: 'http://mock.test/v1',
      model: 'mock-agent',
      credential: { kind: 'none' },
      features: { memory: 'off', skills: 'off' },
    });

    const savedProfile = await agents.saveProfile({ preferences: { landingPage: 'office' } });
    expect(savedProfile.preferences.landingPage).toBe('office');
    expect((await agents.getProfile()).preferences.landingPage).toBe('office');
    await expect(agents.saveProfile({ preferences: { landingPage: 'invalid' as 'chat' } })).rejects.toThrow();

    const choices = await agents.modelChoices(null);
    expect(choices.runtime).toBe('extalia-native');
    expect(choices.defaultModel).toBe('mock-agent');

    const requestId = '11111111-1111-4111-8111-111111111111';
    const created = await agents.createSession(null, { clientRequestId: requestId });
    expect(created.workspaceId).toBeNull();
    expect(created.control).toBe('managed');
    expect(created.runtime).toBeUndefined();

    const deduped = await agents.createSession(null, { clientRequestId: requestId });
    expect(deduped.id).toBe(created.id);
    await expect(agents.createSession(null, { clientRequestId: requestId, model: 'other-model' })).rejects.toThrow();

    const nextState = await agents.saveWorkspace({
      name: 'Target Project',
      projectLocation: '/Users/<name>/Projects/target',
      connectionId: (await agents.getState()).connections[0]!.id,
      permissions: { fileWrite: 'ask', commands: 'ask' },
    });
    const destination = nextState.workspaces[0]!;

    const preview = await agents.previewSessionMove!(created.id, destination.id);
    expect(preview.kind).toBe('attach');
    expect(preview.source).toBeNull();
    expect(preview.destination.id).toBe(destination.id);

    const attachedState = await agents.moveSession!(created.id, { workspaceId: destination.id, reviewId: preview.reviewId });
    expect(attachedState.sessions.find(item => item.id === created.id)?.workspaceId).toBe(destination.id);
  });

  it('creates an unassigned composer session and binds its draft without losing ownership', async () => {
    const platform = createMockPlatform({ seed: 'ready', host: 'bridge' });
    const agents = platform.capabilities.agents!;
    const ready = await agents.getState();
    const connectionId = ready.connections[0]!.id;

    const store = composerDraftStore(agents);
    const entry = store.entry(composerDraftKey(undefined, null));
    entry.setText('Hello without a workspace');
    const lease = entry.beginSend()!;
    const onState = vi.fn();
    const onSelect = vi.fn();

    const sessionId = await createComposerSession({
      agents,
      workspaceId: null,
      connectionId,
      choice: {},
      team: null,
      clientRequestId: '22222222-2222-4222-8222-222222222222',
      bindSession: id => store.bindSession(null, id),
      onState,
      onSelect,
      interrupted: 'Interrupted',
    });
    lease.finish('accepted');

    expect(onSelect).toHaveBeenCalledWith({ workspaceId: null, sessionId });
    expect(onState).toHaveBeenCalled();
    const created = (await agents.getState()).sessions.find(item => item.id === sessionId);
    expect(created?.workspaceId).toBeNull();
    expect(created?.connectionId).toBe(connectionId);
  });

  it('renders ChatPage composer with zero workspaces and Attach to workspace for unassigned sessions', () => {
    const agents = {
      sessionEvents: vi.fn(async () => []),
      modelChoices: vi.fn(async () => ({ runtime: 'extalia-native', models: ['claude-sonnet-5-5'], efforts: [], permissionModes: ['plan'] })),
      previewSessionMove: vi.fn(),
      moveSession: vi.fn(),
      getSessionTeam: vi.fn(async () => undefined),
      planTeam: vi.fn(),
      saveSessionTeam: vi.fn(),
    } as unknown as AgentHostApi;

    const zeroWorkspaceState = sampleState({ workspaces: [], sessions: [] });
    const zeroHtml = renderToStaticMarkup(createElement(ChatPage, {
      t: MESSAGES.en,
      language: 'en',
      agents,
      state: zeroWorkspaceState,
      onState: vi.fn(),
      selection: { workspaceId: null, sessionId: null },
      onSelect: vi.fn(),
      onOpenSettings: vi.fn(),
      onReviewSkills: vi.fn(),
    }));
    expect(zeroHtml).toContain('id="composer-input"');
    expect(zeroHtml).toContain(MESSAGES.en.chat.unassigned.badge);
    expect(zeroHtml).toContain(MESSAGES.en.chat.unassigned.emptyLead);
    expect(zeroHtml).not.toContain(MESSAGES.en.chat.noWorkspace);
    expect(zeroHtml).not.toContain(MESSAGES.en.memoryContext.title);

    const unassignedSession = sampleSession('unassigned-1', null);
    const activeUnassignedState = sampleState({ sessions: [unassignedSession] });
    const activeHtml = renderToStaticMarkup(createElement(ChatPage, {
      t: MESSAGES.en,
      language: 'en',
      agents,
      state: activeUnassignedState,
      onState: vi.fn(),
      selection: { workspaceId: null, sessionId: unassignedSession.id },
      onSelect: vi.fn(),
      onOpenSettings: vi.fn(),
      onReviewSkills: vi.fn(),
    }));
    expect(activeHtml).toContain(MESSAGES.en.chat.unassigned.attach);
    expect(activeHtml).toContain(MESSAGES.en.chat.unassigned.badge);
  });

  it('renders Unassigned group at the top of NativeSessionTree and prevents drag-drop onto workspaces', () => {
    const unassigned = sampleSession('unassigned-1', null);
    const assigned = sampleSession('assigned-1', 'workspace-a');
    const s = sampleState({ sessions: [assigned, unassigned] });
    const agents = { setSessionProjectRoot: vi.fn(), previewSessionMove: vi.fn(), moveSession: vi.fn() } as unknown as AgentHostApi;

    const rendered = renderToStaticMarkup(createElement(NativeSessionTree, {
      t: MESSAGES.en,
      language: 'en',
      agents,
      state: s,
      workspaceId: null,
      activeId: unassigned.id,
      onSelect: vi.fn(),
      onState: vi.fn(),
      onSettings: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(),
    }));
    const unassignedIdx = rendered.indexOf(MESSAGES.en.chat.unassigned.group);
    const workspaceIdx = rendered.indexOf('Alpha');
    expect(unassignedIdx).toBeGreaterThan(-1);
    expect(workspaceIdx).toBeGreaterThan(unassignedIdx);
    expect(rendered).toContain('Title unassigned-1');

    // Empty unassigned group is omitted cleanly.
    const withoutUnassigned = renderToStaticMarkup(createElement(NativeSessionTree, {
      t: MESSAGES.en,
      language: 'en',
      agents,
      state: sampleState({ sessions: [assigned] }),
      workspaceId: 'workspace-a',
      activeId: assigned.id,
      onSelect: vi.fn(),
      onState: vi.fn(),
      onSettings: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(),
    }));
    expect(withoutUnassigned).not.toContain('native-unassigned');

    // Drag-and-drop cannot attach an unassigned row onto a workspace folder.
    expect(nativeSessionDrop(s.sessions, s.workspaces, { sessionId: unassigned.id, workspaceId: '' }, 'workspace-a', '/projects/workspace-a')).toBeUndefined();
    expect(nativeSessionDrop(s.sessions, s.workspaces, { sessionId: unassigned.id, workspaceId: 'workspace-a' }, 'workspace-a', '/projects/workspace-a')).toBeUndefined();
  });

  it('renders SessionMoveDialog attach copy cleanly in English and Indonesian', () => {
    const unassigned = sampleSession('unassigned-1', null);
    const workspace = sampleWorkspace();
    const preview: SessionMovePreview = {
      sessionId: unassigned.id,
      reviewId: 'review-1',
      expiresAt: '2030-01-01T00:00:00.000Z',
      kind: 'attach',
      source: null,
      destination: {
        id: workspace.id,
        name: workspace.name,
        folders: [workspace.projectLocation!],
        crossWorkspaceAccess: 'read-only',
        permissions: { fileWrite: 'ask', commands: 'ask' },
      },
      accessibleFolders: [{ workspaceId: workspace.id, path: workspace.projectLocation!, access: 'read-write' }],
      transfersHistory: true,
      permissionMode: 'workspace',
    };
    const agents = {
      previewSessionMove: vi.fn(async () => preview),
      moveSession: vi.fn(),
    } as unknown as AgentHostApi;

    for (const language of ['en', 'id'] as const) {
      const html = renderToStaticMarkup(createElement(SessionMoveDialog, {
        t: MESSAGES[language],
        agents,
        session: unassigned,
        workspaces: [workspace],
        onClose: vi.fn(),
        onMoved: vi.fn(),
      }));
      expect(html).toContain(MESSAGES[language].chat.move.attachTitle);
      expect(html).toContain(MESSAGES[language].chat.move.attachDescription);
      expect(html).not.toContain('role="tablist"');
    }
  });
});

describe('Slice B project provisioning UI, mockHost, and host method registry', () => {
  it('registers previewProjectProvision and applyProjectProvision in AGENT_HOST_METHODS', () => {
    expect(AGENT_HOST_METHODS).toContain('previewProjectProvision');
    expect(AGENT_HOST_METHODS).toContain('applyProjectProvision');
  });

  it('renders ProjectProvisionDialog SSR markup for create & open modes in English and Indonesian', () => {
    const unassigned = sampleSession('unassigned-1', null);
    const state = sampleState({ workspaces: [], sessions: [unassigned] });
    const agents = {
      previewProjectProvision: vi.fn(),
      applyProjectProvision: vi.fn(),
      browseDirectories: vi.fn(),
    } as unknown as AgentHostApi;

    for (const language of ['en', 'id'] as const) {
      const msg = MESSAGES[language].chat.provision;
      const createHtml = renderToStaticMarkup(createElement(ProjectProvisionDialog, {
        t: MESSAGES[language],
        agents,
        state,
        initialMode: 'create',
        session: unassigned,
        onClose: vi.fn(),
        onProvisioned: vi.fn(),
      }));
      expect(createHtml).toContain(msg.createTab);
      expect(createHtml).toContain(msg.openTab);
      expect(createHtml).toContain(msg.parentFolder);
      expect(createHtml).toContain(msg.folderName);
      expect(createHtml).toContain(msg.templateNotice);
      expect(createHtml).toContain(msg.gitInit);
      expect(createHtml).toContain(msg.attachCurrentSession);
      expect(createHtml).toContain(msg.continueWithoutFiles);

      const openHtml = renderToStaticMarkup(createElement(ProjectProvisionDialog, {
        t: MESSAGES[language],
        agents,
        state,
        initialMode: 'open',
        session: unassigned,
        onClose: vi.fn(),
        onProvisioned: vi.fn(),
      }));
      expect(openHtml).toContain(msg.projectFolder);
      expect(openHtml).not.toContain(msg.gitInit);
      expect(openHtml).toContain(msg.attachCurrentSession);
    }
  });

  it('renders Create project and Open project buttons in unassigned ChatPage header and empty state', () => {
    const agents = {
      sessionEvents: vi.fn(async () => []),
      modelChoices: vi.fn(async () => ({ runtime: 'extalia-native', models: ['claude-sonnet-5-5'], efforts: [], permissionModes: ['plan'] })),
      previewSessionMove: vi.fn(),
      moveSession: vi.fn(),
      previewProjectProvision: vi.fn(),
      applyProjectProvision: vi.fn(),
      getSessionTeam: vi.fn(async () => undefined),
      planTeam: vi.fn(),
      saveSessionTeam: vi.fn(),
    } as unknown as AgentHostApi;

    const html = renderToStaticMarkup(createElement(ChatPage, {
      t: MESSAGES.en,
      language: 'en',
      agents,
      state: sampleState({ workspaces: [], sessions: [] }),
      onState: vi.fn(),
      selection: { workspaceId: null, sessionId: null },
      onSelect: vi.fn(),
      onOpenSettings: vi.fn(),
      onReviewSkills: vi.fn(),
    }));
    expect(html).toContain(MESSAGES.en.chat.provision.createButton);
    expect(html).toContain(MESSAGES.en.chat.provision.openButton);
    expect(html).toContain(MESSAGES.en.chat.provision.openExistingButton);
  });

  it('supports mockHost preview -> apply flow with warning gates, path validation, and atomic session attach', async () => {
    const platform = createMockPlatform({ seed: 'setup', host: 'bridge' });
    const agents = platform.capabilities.agents!;
    await agents.saveConnection({
      name: 'Mock',
      preset: 'custom',
      api: 'openai-chat',
      baseUrl: 'http://mock.test/v1',
      model: 'mock-agent',
      credential: { kind: 'none' },
      features: { memory: 'off', skills: 'off' },
    });
    const connectionId = (await agents.getState()).connections[0]!.id;

    // Rejects invalid folder names and protected system/home paths.
    await expect(agents.previewProjectProvision!({
      mode: 'create',
      parentPath: '/Users/<name>/Projects',
      folderName: '../escape',
      connectionId,
    })).rejects.toThrow();
    await expect(agents.previewProjectProvision!({
      mode: 'open',
      targetPath: '/',
      connectionId,
    })).rejects.toThrow();
    await expect(agents.previewProjectProvision!({
      mode: 'open',
      targetPath: '/Users/<name>',
      connectionId,
    })).rejects.toThrow();

    // Create an unassigned session and send a prompt so it has history events before attaching.
    const unassigned = await agents.createSession(null, { connectionId });
    await agents.sendPrompt(unassigned.id, 'Plan project structure');
    await agents.cancel(unassigned.id);
    await vi.waitFor(async () => {
      const current = (await agents.getState()).sessions.find(item => item.id === unassigned.id);
      expect(current?.running).toBe(false);
    });

    // Open a dirty + protected-branch project -> requires warning acknowledgement.
    const dirtyPreview = await agents.previewProjectProvision!({
      mode: 'open',
      targetPath: '/Users/<name>/Projects/dirty-protected-repo',
      connectionId,
      attachSessionId: unassigned.id,
    });
    expect(dirtyPreview.requiresWarningAcknowledgement).toBe(true);
    expect(dirtyPreview.warnings.map(w => w.code)).toEqual(expect.arrayContaining(['dirty-repository', 'protected-branch']));
    expect(dirtyPreview.attachSession?.sessionId).toBe(unassigned.id);

    // Fails when acknowledgeWarnings is omitted or false.
    const rejectedReceipt = await agents.applyProjectProvision!({ reviewId: dirtyPreview.reviewId });
    expect(rejectedReceipt.ok).toBe(false);
    expect(rejectedReceipt.error).toBeTruthy();

    // Succeeds with acknowledgeWarnings: true, preserving session ID & recording empty-root workspaceFileScopes cutoff.
    const appliedReceipt = await agents.applyProjectProvision!({
      reviewId: dirtyPreview.reviewId,
      acknowledgeWarnings: true,
    });
    expect(appliedReceipt.ok).toBe(true);
    expect(appliedReceipt.workspace?.projectLocation).toBe('/Users/<name>/Projects/dirty-protected-repo');
    expect(appliedReceipt.attachedSessionId).toBe(unassigned.id);
    const attached = appliedReceipt.state?.sessions.find(item => item.id === unassigned.id);
    expect(attached?.workspaceId).toBe(appliedReceipt.workspace?.id);
    expect(attached?.workspaceFileScopes?.length).toBeGreaterThan(0);
    expect(attached?.workspaceFileScopes?.[0]?.workspaceId).toBe('');
    expect(attached?.workspaceFileScopes?.[0]?.projectLocation).toBe('');

    // Create mode preview -> apply flow with scaffold template.
    const createPreview = await agents.previewProjectProvision!({
      mode: 'create',
      parentPath: '/Users/<name>/Projects',
      folderName: 'fresh-ts-app',
      templateId: 'node-ts-minimal',
      gitInit: true,
      connectionId,
    });
    expect(createPreview.requiresWarningAcknowledgement).toBe(false);
    expect(createPreview.plannedActions.map(a => a.kind)).toEqual([
      'create-folder',
      'write-file',
      'write-file',
      'write-file',
      'write-file',
      'git-init',
      'register-workspace',
    ]);
    const createReceipt = await agents.applyProjectProvision!({ reviewId: createPreview.reviewId });
    expect(createReceipt.ok).toBe(true);
    expect(createReceipt.workspace?.name).toBe('fresh-ts-app');
    expect(createReceipt.steps.every(step => step.status === 'completed')).toBe(true);
  });
});
