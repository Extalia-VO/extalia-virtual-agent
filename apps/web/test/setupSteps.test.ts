import type { Workspace } from '@extalia/core';
import type { ConnectionView, HostState } from '@extalia/platform';
import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../src/i18n';
import {
  SETUP_STEPS, canAdvance, canFinish, dataDirectoryOf, detectExistingSetup, nextStep, previousStep, stepIndex, validateDisplayName, type AdvanceContext,
} from '../src/setup/steps';

const connection = (id: string) => ({ id, name: `Conn ${id}`, model: 'm' }) as unknown as ConnectionView;
const workspace = (id: string, extra: Partial<Workspace> = {}) => ({ id, name: `Ws ${id}`, profileId: 'p', createdAt: '', updatedAt: '', ...extra }) as Workspace;
const ok: AdvanceContext = { busy: false, displayNameValid: true, hermes: false, hermesBlocked: false, connectionValid: true, workspaceValid: true };

describe('setup step list', () => {
  it('runs welcome → profile → connection → workspace → agent apps → done, with a label per step', () => {
    expect(SETUP_STEPS).toEqual(['welcome', 'profile', 'connection', 'workspace', 'agentApps', 'done']);
    for (const messages of Object.values(MESSAGES)) expect(messages.setup.steps).toHaveLength(SETUP_STEPS.length);
    expect(nextStep('welcome')).toBe('profile');
    expect(nextStep('workspace')).toBe('agentApps');
    expect(nextStep('done')).toBe('done');
    expect(previousStep('welcome')).toBe('welcome');
    expect(previousStep('connection')).toBe('profile');
    expect(stepIndex('done')).toBe(5);
  });
});

describe('prefill from an existing (older or migrated) setup', () => {
  it('finds nothing on a clean first run', () => {
    expect(detectExistingSetup({ connections: [], workspaces: [] })).toEqual({ found: false });
  });
  it('preselects the first workspace with the connection it uses', () => {
    const found = detectExistingSetup({ connections: [connection('a'), connection('b')], workspaces: [workspace('w', { providerProfileId: 'b' })] });
    expect(found.found).toBe(true);
    expect(found.workspace?.id).toBe('w');
    expect(found.connection?.id).toBe('b');
  });
  it('falls back to the first connection when there is no workspace or the link is stale', () => {
    expect(detectExistingSetup({ connections: [connection('a')], workspaces: [] }).connection?.id).toBe('a');
    expect(detectExistingSetup({ connections: [connection('a')], workspaces: [workspace('w', { providerProfileId: 'gone' })] }).connection?.id).toBe('a');
    expect(detectExistingSetup({ connections: [], workspaces: [workspace('h', { runtimeId: 'hermes' })] })).toMatchObject({ found: true, workspace: { id: 'h' } });
  });
});

describe('can-advance rules', () => {
  it('lets the welcome and agent-app steps through, but never while busy', () => {
    expect(canAdvance('welcome', ok)).toBe(true);
    expect(canAdvance('agentApps', ok)).toBe(true);
    expect(canAdvance('welcome', { ...ok, busy: true })).toBe(false);
  });
  it('needs a valid display name on the profile step (empty is fine)', () => {
    expect(validateDisplayName('')).toBeUndefined();
    expect(validateDisplayName('  Alex  ')).toBeUndefined();
    expect(validateDisplayName('x'.repeat(65))).toBe('tooLong');
    expect(validateDisplayName('a\nb')).toBe('invalid');
    expect(canAdvance('profile', { ...ok, displayNameValid: false })).toBe(false);
  });
  it('needs a valid connection for Extalia Native, an installed Hermes for Hermes', () => {
    expect(canAdvance('connection', { ...ok, connectionValid: false })).toBe(false);
    expect(canAdvance('connection', { ...ok, connectionValid: false, hermes: true })).toBe(true);
    expect(canAdvance('connection', { ...ok, hermes: true, hermesBlocked: true })).toBe(false);
    expect(canAdvance('workspace', { ...ok, workspaceValid: false })).toBe(false);
  });
  it('never completes from the done step’s advance rule; finishing needs the saved workspace and its connection', () => {
    expect(canAdvance('done', ok)).toBe(false);
    const state = { connections: [connection('a')], workspaces: [workspace('w', { providerProfileId: 'a' }), workspace('h', { runtimeId: 'hermes' }), workspace('x', { providerProfileId: 'gone' })] };
    expect(canFinish(state, undefined)).toBe(false);
    expect(canFinish(state, 'missing')).toBe(false);
    expect(canFinish(state, 'w')).toBe(true);
    expect(canFinish(state, 'h')).toBe(true);
    expect(canFinish(state, 'x')).toBe(false);
  });
  it('allows explicit workspace deferral only with the selected saved connection or available Hermes', () => {
    const empty = { connections: [], workspaces: [] };
    expect(canFinish(empty, undefined)).toBe(false);
    expect(canFinish(empty, undefined, { runtimeId: 'extalia-native', connectionId: 'draft', hermesAvailable: true })).toBe(false);
    expect(canFinish({ connections: [connection('saved')], workspaces: [] }, undefined, { runtimeId: 'extalia-native', connectionId: 'saved', hermesAvailable: false })).toBe(true);
    expect(canFinish(empty, undefined, { runtimeId: 'hermes', hermesAvailable: false })).toBe(false);
    expect(canFinish(empty, undefined, { runtimeId: 'hermes', hermesAvailable: true })).toBe(true);
    // Deferral preserves old workspaces without accepting an unsaved or unrelated Native connection.
    const migrated = { connections: [connection('saved')], workspaces: [workspace('old', { providerProfileId: 'saved' })] };
    expect(canFinish(migrated, 'old', { runtimeId: 'extalia-native', connectionId: 'draft', hermesAvailable: false })).toBe(false);
    expect(canFinish(migrated, 'old')).toBe(true);
  });
});

describe('data folder', () => {
  it('prefers the host data directory and falls back to storage', () => {
    const storage = { dataDirectory: '/Users/you/.extalia', secretStore: 'memory' } as HostState['storage'];
    expect(dataDirectoryOf({ storage, dataDirectory: '/Users/you/.extalia-vo' })).toBe('/Users/you/.extalia-vo');
    expect(dataDirectoryOf({ storage })).toBe('/Users/you/.extalia');
  });
});
