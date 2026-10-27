import type { AgentHostApi, FileContent, FileListing } from '@extalia/platform';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createMockPlatform } from '../src/host/mockHost';
import { MESSAGES } from '../src/i18n';
import { WorkspacesSection } from '../src/pages/settings/WorkspacesSection';
import { loadGateSuggestion, suggestGateCommand } from '../src/setup/gateSuggestion';
import { draftFromWorkspace, emptyWorkspaceDraft, toWorkspaceInput, validateWorkspace } from '../src/setup/validation';
import { WorkspaceForm } from '../src/setup/WorkspaceForm';

// ADR 0028: the workspace's integration test gate in Settings.
const t = MESSAGES.en;
const ready = { ...emptyWorkspaceDraft('c1'), name: 'App', folderInput: '/projects/app', folder: { path: '/projects/app', name: 'app' } };
const workspace = { id: 'w1', profileId: 'p', name: 'App', projectLocation: '/projects/app', providerProfileId: 'c1', createdAt: 'x', updatedAt: 'x' };

describe('workspace gate drafts', () => {
  it('leave the stored gate alone unless the form showed it; an empty command removes it', () => {
    expect('integrationGate' in toWorkspaceInput(ready)).toBe(false);
    expect(toWorkspaceInput({ ...ready, gateCommand: ' pnpm test ', gateTimeout: ' 120 ' }).integrationGate).toEqual({ command: 'pnpm test', timeoutSeconds: 120 });
    expect(toWorkspaceInput({ ...ready, gateCommand: 'cargo test', gateTimeout: '' }).integrationGate).toEqual({ command: 'cargo test' });
    expect(toWorkspaceInput({ ...ready, gateCommand: '  ', gateTimeout: '' }).integrationGate).toBeNull();
    expect(toWorkspaceInput({ ...ready, runtimeId: 'hermes', gateCommand: 'npm test' }).integrationGate).toEqual({ command: 'npm test' });
  });

  it('round-trip the stored setting and validate like the host', () => {
    expect(draftFromWorkspace(workspace)).toMatchObject({ gateCommand: '', gateTimeout: '' });
    const draft = draftFromWorkspace({ ...workspace, integrationGate: { command: 'pnpm test', timeoutSeconds: 900 } });
    expect(draft).toMatchObject({ gateCommand: 'pnpm test', gateTimeout: '900' });
    expect(toWorkspaceInput(draft).integrationGate).toEqual({ command: 'pnpm test', timeoutSeconds: 900 });
    expect(validateWorkspace(draft)).toEqual({});
    expect(validateWorkspace({ ...ready, gateCommand: 'x'.repeat(4_001) })).toEqual({ gate: 'gateInvalid' });
    expect(validateWorkspace({ ...ready, gateCommand: '', gateTimeout: '60' })).toEqual({ gate: 'gateRequired' });
    for (const timeout of ['0', '1801', '1.5', '-1', 'ten']) expect(validateWorkspace({ ...ready, gateCommand: 'ok', gateTimeout: timeout }), timeout).toEqual({ gateTimeout: 'gateTimeoutInvalid' });
    for (const timeout of ['1', '1800', ' 600 ']) expect(validateWorkspace({ ...ready, gateCommand: 'ok', gateTimeout: timeout }), timeout).toEqual({});
    for (const key of ['gateInvalid', 'gateRequired', 'gateTimeoutInvalid'] as const) expect(MESSAGES.id.workspace.errors[key]).toBeTruthy();
  });
});

describe('gate suggestions', () => {
  it('suggest a command from package.json (by lockfile) or Cargo.toml, never npm’s placeholder script', () => {
    const pkg = (test?: string) => JSON.stringify({ name: 'x', scripts: test === undefined ? {} : { test } });
    expect(suggestGateCommand(['package.json', 'pnpm-lock.yaml'], pkg('vitest run'))).toBe('pnpm test');
    expect(suggestGateCommand(['package.json', 'yarn.lock'], pkg('jest'))).toBe('yarn test');
    expect(suggestGateCommand(['package.json', 'package-lock.json'], pkg('jest'))).toBe('npm test');
    expect(suggestGateCommand(['package.json'], pkg('echo "Error: no test specified" && exit 1'))).toBeUndefined();
    expect(suggestGateCommand(['package.json'], pkg())).toBeUndefined();
    expect(suggestGateCommand(['package.json'], '{ not json')).toBeUndefined();
    expect(suggestGateCommand(['package.json', 'Cargo.toml'], pkg())).toBe('cargo test');
    expect(suggestGateCommand(['Cargo.toml', 'Cargo.lock'])).toBe('cargo test');
    expect(suggestGateCommand(['README.md'])).toBeUndefined();
  });

  it('read only the top-level listing and package.json through the host file API', async () => {
    const entry = (name: string, extra: object = {}) => ({ name, path: name, kind: 'file' as const, ...extra });
    const listing: FileListing = { path: '.', entries: [entry('package.json'), entry('pnpm-lock.yaml'), entry('.env', { credential: true })], truncated: false };
    const agents = {
      listFiles: vi.fn(async () => listing),
      readFile: vi.fn(async (): Promise<FileContent> => ({ path: 'package.json', size: 40, binary: false, content: '{"scripts":{"test":"vitest run"}}', lines: 1, truncated: false })),
    };
    expect(await loadGateSuggestion(agents, 'w1')).toBe('pnpm test');
    expect(agents.listFiles).toHaveBeenCalledWith('w1');
    expect(agents.readFile).toHaveBeenCalledWith('w1', 'package.json');
    agents.readFile.mockRejectedValueOnce(new Error('unreadable'));
    expect(await loadGateSuggestion(agents, 'w1')).toBeUndefined();
  });
});

describe('workspace form and Settings', () => {
  const agents = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
  const form = (draft: Parameters<typeof WorkspaceForm>[0]['draft'], showGate: boolean) =>
    renderToStaticMarkup(createElement(WorkspaceForm, { t, agents, draft, onChange: () => undefined, showGate }));

  it('shows the gate with its explanation in Settings only', () => {
    const html = form(draftFromWorkspace({ ...workspace, integrationGate: { command: 'pnpm test', timeoutSeconds: 120 } }), true);
    expect(html).toContain(t.workspace.gate.heading);
    expect(html).toContain('Runs in a throwaway copy before changes are merged; nothing is merged when it fails.');
    expect(html).toContain('value="pnpm test"');
    expect(html).toContain('value="120"');
    const wizard = form(ready, false);
    expect(wizard).not.toContain(t.workspace.gate.heading);
  });

  it('opens the workspace editor at the gate when asked from a Changes panel, and lists the configured gate', async () => {
    const state = await agents.getState();
    const target = state.workspaces.find(item => item.name === 'demo-app')!;
    expect(target.integrationGate).toEqual({ command: 'npm test' });
    const render = (editGateFor?: string) => renderToStaticMarkup(createElement(WorkspacesSection, { t, agents: agents as AgentHostApi, state, onState: () => undefined, ...(editGateFor ? { editGateFor } : {}) }));
    const opened = render(target.id);
    expect(opened).toContain(`aria-label="${t.settings.editing('demo-app')}"`);
    expect(opened).toContain(t.workspace.gate.lead);
    expect(opened).toContain('value="npm test"');
    const list = render();
    expect(list).not.toContain(t.workspace.gate.lead);
    expect(list).toContain(`${t.workspace.gate.heading}: <code>npm test</code>`);
  });

  it('the mock host stores, keeps and removes the gate like the real host', async () => {
    const mock = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    const docs = (await mock.getState()).workspaces.find(item => item.name === 'docs-site')!;
    expect(docs.integrationGate).toBeUndefined();
    const input = toWorkspaceInput(draftFromWorkspace(docs));
    const set = await mock.saveWorkspace({ ...input, integrationGate: { command: ' pnpm test ', timeoutSeconds: 300 } });
    expect(set.workspaces.find(item => item.id === docs.id)!.integrationGate).toEqual({ command: 'pnpm test', timeoutSeconds: 300 });
    const { integrationGate: _omitted, ...withoutGate } = input;
    expect((await mock.saveWorkspace(withoutGate)).workspaces.find(item => item.id === docs.id)!.integrationGate).toEqual({ command: 'pnpm test', timeoutSeconds: 300 });
    await expect(mock.saveWorkspace({ ...input, integrationGate: { command: 'ok', timeoutSeconds: 0 } })).rejects.toThrow(/timeout/);
    expect((await mock.saveWorkspace({ ...input, integrationGate: null })).workspaces.find(item => item.id === docs.id)!.integrationGate).toBeUndefined();
  });
});
