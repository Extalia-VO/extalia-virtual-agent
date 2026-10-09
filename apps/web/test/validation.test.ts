import type { ConnectionView } from '@extalia/platform';
import { describe, expect, it } from 'vitest';
import {
  checkBaseUrl, draftFromConnection, draftFromPreset, emptyWorkspaceDraft, suggestedTiers, toConnectionInput, toWorkspaceInput, validateConnection, validateWorkspace,
} from '../src/setup/validation';

describe('connection drafts', () => {
  it('starts from the preset and requires a key only where the preset needs one', () => {
    const openai = draftFromPreset('openai');
    expect(openai).toMatchObject({ name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', memory: 'extalia', orchestration: { enabled: true, maxDelegations: '3' } });
    expect(validateConnection(openai)).toEqual({ apiKey: 'apiKeyRequired', model: 'modelRequired' });
    expect(validateConnection({ ...openai, apiKey: 'test-key', model: 'gpt-x' })).toEqual({});
    const ollama = { ...draftFromPreset('ollama'), model: 'llama' };
    expect(validateConnection(ollama)).toEqual({});
    expect(toConnectionInput(ollama).input.credential).toEqual({ kind: 'none' });
  });

  it('validates endpoints like the host does', () => {
    expect(checkBaseUrl('https://api.example.com/v1')).toBeUndefined();
    expect(checkBaseUrl('ftp://example.com')).toBe('baseUrlInvalid');
    expect(checkBaseUrl('not a url')).toBe('baseUrlInvalid');
    expect(checkBaseUrl('https://user:pass@example.com')).toBe('baseUrlCredentials');
    expect(checkBaseUrl('https://example.com/v1?key=1')).toBe('baseUrlQuery');
  });

  it('sends a typed key once as the secret and keeps a stored key otherwise', () => {
    const draft = { ...draftFromPreset('anthropic'), apiKey: ' test-key ' };
    const { input, secret } = toConnectionInput(draft);
    expect(secret).toBe('test-key');
    expect(input).toMatchObject({ credential: { kind: 'stored' }, api: 'anthropic-messages', effort: 'high', baseUrl: 'https://api.anthropic.com' });
    expect(JSON.stringify(input)).not.toContain('test-key');

    const view: ConnectionView = {
      id: 'c1', name: 'Work', preset: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5',
      credential: { kind: 'stored', ref: 'ref-1' }, features: { memory: 'extalia', skills: 'off' },
      orchestration: { enabled: false, maxDelegations: 5, tiers: { quick: 'claude-haiku-4-5' } },
      createdAt: '2026-01-31T10:00:00.000Z', updatedAt: '2026-01-31T10:00:00.000Z', credentialStatus: 'ok',
    };
    const edited = draftFromConnection(view);
    expect(edited).toMatchObject({ apiKey: '', hasStoredKey: true, orchestration: { enabled: false, maxDelegations: '5', tiers: { complex: '', quick: 'claude-haiku-4-5' } } });
    expect(validateConnection(edited)).toEqual({});
    expect(toConnectionInput(edited)).toEqual({ input: expect.objectContaining({ id: 'c1', credential: { kind: 'stored' } }) });
    expect(toConnectionInput(edited).input.orchestration).toEqual({ enabled: false, maxDelegations: 5, tiers: { quick: 'claude-haiku-4-5' } });
  });

  it('checks environment variable names and the delegation limit', () => {
    const draft = { ...draftFromPreset('openrouter'), credentialMode: 'env' as const, model: 'm' };
    expect(draft.envVariable).toBe('OPENROUTER_API_KEY');
    expect(validateConnection({ ...draft, envVariable: 'bad name' })).toEqual({ envVariable: 'envInvalid' });
    expect(toConnectionInput(draft).input.credential).toEqual({ kind: 'env', variable: 'OPENROUTER_API_KEY' });
    const limit = (value: string) => validateConnection({ ...draft, orchestration: { ...draft.orchestration, maxDelegations: value } }).maxDelegations;
    expect(limit('0')).toBeUndefined();
    expect(limit('20')).toBeUndefined();
    expect(limit('21')).toBe('maxDelegationsInvalid');
    expect(limit('1.5')).toBe('maxDelegationsInvalid');
  });

  it('offers tier suggestions only for presets that have them and resets them with the preset', () => {
    expect(suggestedTiers('anthropic')).toEqual({ complex: 'claude-opus-5-5', standard: 'claude-sonnet-5-5', quick: 'claude-haiku-4-5' });
    expect(suggestedTiers('ollama')).toBeUndefined();
    const switched = draftFromPreset('ollama', { ...draftFromPreset('anthropic'), name: 'Mine', orchestration: { enabled: false, maxDelegations: '7', tiers: { complex: 'x', standard: '', quick: '' } } });
    expect(switched).toMatchObject({ name: 'Mine', orchestration: { enabled: false, maxDelegations: '7', tiers: { complex: '', standard: '', quick: '' } } });
    expect(draftFromPreset('ollama', draftFromPreset('anthropic')).name).toBe('Ollama');
  });
});

describe('workspace drafts', () => {
  it('needs a name, a checked folder and a connection', () => {
    const empty = emptyWorkspaceDraft();
    expect(validateWorkspace(empty)).toEqual({ name: 'nameRequired', folder: 'folderRequired', connection: 'connectionRequired' });
    expect(validateWorkspace({ ...empty, folderInput: '/projects/app' }).folder).toBe('folderUnchecked');
    const ready = { ...emptyWorkspaceDraft('c1'), name: ' App ', folderInput: '/projects/app/', folder: { path: '/projects/app', name: 'app' } };
    expect(validateWorkspace(ready)).toEqual({});
    expect(toWorkspaceInput(ready)).toEqual({ name: 'App', projectLocation: '/projects/app', connectionId: 'c1', permissions: { fileWrite: 'ask', commands: 'ask' } });
  });
});
