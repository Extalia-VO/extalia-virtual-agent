import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { connectionFailure, friendlyConnectionError } from '../src/setup/connectionErrors';
import { bypassesHermesApprovals, hermesPermissions, permissionsLabel } from '../src/setup/permissions';
import { TEST_MODEL_PLACEHOLDER, draftFromPreset, toConnectionTestInput, validateConnection } from '../src/setup/validation';
import { createMockPlatform } from '../src/host/mockHost';

const { en, id } = MESSAGES;

describe('testing a connection', () => {
  it('does not require a model: the test lists models and the user picks one afterwards', () => {
    const custom = { ...draftFromPreset('custom'), baseUrl: 'http://127.0.0.1:4392/v1', model: '' };
    expect(validateConnection(custom).model).toBe('modelRequired');
    expect(toConnectionTestInput(custom).input.model).toBe(TEST_MODEL_PLACEHOLDER);
    expect(toConnectionTestInput({ ...custom, model: ' mock-agent ' }).input.model).toBe('mock-agent');
  });

  it('turns raw host and provider errors into plain wording in both languages', () => {
    expect(connectionFailure('model: expected a string with content')).toBe('invalid');
    expect(connectionFailure('The endpoint rejected the credentials: bad key')).toBe('credentials');
    expect(connectionFailure('The endpoint returned 404: no such model')).toBe('notFound');
    expect(connectionFailure('The endpoint returned 429.')).toBe('rateLimited');
    expect(connectionFailure('The endpoint returned 503.')).toBe('serverError');
    expect(connectionFailure('The operation was aborted due to timeout')).toBe('timeout');
    expect(connectionFailure('fetch failed')).toBe('unreachable');
    expect(connectionFailure('something unexpected')).toBe('generic');
    for (const messages of [en, id]) {
      const text = friendlyConnectionError(messages, 'model: expected a string with content');
      expect(text).not.toContain('expected a string');
      for (const key of Object.keys(en.connection.failures)) expect(messages.connection.failures[key as keyof typeof en.connection.failures]).toBeTruthy();
    }
  });
});

describe('Hermes permissions', () => {
  it('are managed by Hermes unless everything is explicitly allowed', () => {
    expect(bypassesHermesApprovals(hermesPermissions(false))).toBe(false);
    expect(bypassesHermesApprovals(hermesPermissions(true))).toBe(true);
    expect(bypassesHermesApprovals({ fileWrite: 'allow', commands: 'ask' })).toBe(false);
    expect(permissionsLabel(en, 'hermes', { fileWrite: 'ask', commands: 'ask' })).toBe('Managed by Hermes');
    expect(permissionsLabel(en, 'hermes', { fileWrite: 'allow', commands: 'allow' })).toBe(en.workspace.hermesPermissions.bypassSummary);
    expect(permissionsLabel(en, 'extalia-native', { fileWrite: 'ask', commands: 'allow' })).toBe('File edits: Ask · Commands: Allow');
    expect(permissionsLabel(id, 'hermes', undefined)).toBe(id.workspace.hermesPermissions.managed);
  });
});

describe('setup wording', () => {
  it('names every step in both languages and ends in the 3D Office', () => {
    expect(en.setup.steps).toEqual(['Welcome', 'Profile', 'Connection', 'Workspace', 'Agent apps', 'Done']);
    expect(id.setup.steps[2]).toBe('Koneksi');
    expect(id.setup.steps).toHaveLength(en.setup.steps.length);
    expect(en.setup.finish).toBe('Enter the 3D Office');
    expect(id.setup.finish).toContain('Kantor 3D');
    expect(en.setup.welcomePoints).toHaveLength(id.setup.welcomePoints.length);
  });
});

describe('deferred workspace setup in the mock host', () => {
  it('keeps managed setup honest with a saved connection or available Hermes', async () => {
    const native = createMockPlatform({ seed: 'setup', host: 'bridge' }).capabilities.agents!;
    await expect(native.completeSetup()).rejects.toThrow(/connection/);
    await native.saveConnection({ name: 'Mock', preset: 'custom', api: 'openai-chat', baseUrl: 'http://mock.test/v1', model: 'mock-agent', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } });
    expect(await native.completeSetup()).toMatchObject({ setupComplete: true, workflow: 'managed', workspaces: [] });
    const hermes = createMockPlatform({ seed: 'setup', host: 'bridge', hermes: true }).capabilities.agents!;
    expect(await hermes.completeSetup()).toMatchObject({ setupComplete: true, workflow: 'managed', connections: [], workspaces: [] });
  });
});
