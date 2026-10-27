import type { SessionSummary } from '@extalia/platform';
import { describe, expect, it } from 'vitest';
import {
  latestWorkspaceSession, modelComboOptions, normalizeOptions, optionsChange, promptAvailability, promptTargetFor, resolveDockTarget, sessionModel, workspaceTargets,
} from '../src/office/promptTarget';

const session = (id: string, patch: Partial<SessionSummary> = {}): SessionSummary => ({
  id, workspaceId: 'w1', connectionId: 'c1', title: id, control: 'managed', createdAt: '2026-01-01T00:00:00Z', lastActiveAt: '2026-01-01T00:00:00Z', running: false, ...patch,
});
const sessions = [
  session('old', { lastActiveAt: '2026-01-01T10:00:00Z' }),
  session('new', { lastActiveAt: '2026-01-02T10:00:00Z' }),
  session('watched', { control: 'observed', lastActiveAt: '2026-01-03T10:00:00Z' }),
  session('other', { workspaceId: 'w2', lastActiveAt: '2026-01-04T10:00:00Z' }),
];
const labels = { useDefault: (model?: string) => `Default (${model ?? '-'})`, defaultBadge: 'default', otherGroup: 'Other' };

describe('prompt target resolution', () => {
  it('continues the newest managed session of the chosen workspace and never an observed one', () => {
    expect(latestWorkspaceSession(sessions, 'w1')?.id).toBe('new');
    expect(latestWorkspaceSession(sessions, 'w3')).toBeUndefined();
    expect(latestWorkspaceSession(sessions, undefined)).toBeUndefined();
    expect(workspaceTargets(sessions, 'w1').map(item => item.id)).toEqual(['new', 'old']);
  });

  it('falls back to a new session when there is nothing to continue', () => {
    expect(resolveDockTarget('continue', sessions, 'w1')).toMatchObject({ kind: 'continue', session: { id: 'new' } });
    expect(resolveDockTarget('continue', sessions, 'w3')).toEqual({ kind: 'new', workspaceId: 'w3' });
    expect(resolveDockTarget('new', sessions, 'w1')).toEqual({ kind: 'new', workspaceId: 'w1' });
  });

  it('sends a worker’s prompt to its lead session and refuses observed agents', () => {
    expect(promptTargetFor({ sessionId: 'new', control: 'managed', displayName: 'Lead' }, sessions)).toEqual({ sessionId: 'new' });
    expect(promptTargetFor({ sessionId: 'new', control: 'managed', parentId: 'new:primary', displayName: 'Tester' }, sessions)).toEqual({ sessionId: 'new', viaWorker: 'Tester' });
    expect(promptTargetFor({ sessionId: 'watched', control: 'observed', displayName: 'Codex' }, sessions)).toBeUndefined();
    expect(promptTargetFor({ sessionId: 'gone', control: 'managed', displayName: 'Gone' }, sessions)).toBeUndefined();
  });

  it('reports whether a session can take a prompt now', () => {
    expect(promptAvailability(session('a'))).toBe('ready');
    expect(promptAvailability(session('a', { running: true }))).toBe('busy');
    expect(promptAvailability(session('a', { control: 'observed' }))).toBe('read-only');
    expect(promptAvailability(undefined)).toBe('missing');
  });
});

describe('session option diffing', () => {
  it('treats empty fields as defaults', () => {
    expect(normalizeOptions({ model: '  ', effort: undefined })).toEqual({});
    expect(normalizeOptions({ model: ' gpt-x ' })).toEqual({ model: 'gpt-x' });
  });

  it('only asks the host to change options that differ', () => {
    expect(optionsChange(undefined, {})).toBeUndefined();
    expect(optionsChange({ model: 'a', effort: 'high' }, { model: 'a', effort: 'high' })).toBeUndefined();
    expect(optionsChange({ model: 'a' }, { model: 'b' })).toEqual({ model: 'b' });
    expect(optionsChange({ model: 'a', effort: 'high' }, {})).toEqual({});
    expect(optionsChange(undefined, { effort: 'low' })).toEqual({ effort: 'low' });
  });
});

describe('model options', () => {
  it('lists the default first, then models grouped by provider prefix', () => {
    const options = modelComboOptions({ runtime: 'hermes', defaultModel: 'ag/b', models: ['ag/a', 'or/x', 'local', 'ag/b', 'ag/a'], efforts: [] }, labels);
    expect(options.map(option => [option.value, option.group ?? null])).toEqual([['', null], ['ag/a', 'ag'], ['ag/b', 'ag'], ['or/x', 'or'], ['local', 'Other']]);
    expect(options[0]).toMatchObject({ label: 'Default (ag/b)', badge: 'default' });
    expect(options.find(option => option.value === 'ag/b')?.badge).toBe('default');
  });

  it('is empty without choices and offers only the default when the endpoint lists nothing', () => {
    expect(modelComboOptions(undefined, labels)).toEqual([]);
    expect(modelComboOptions({ runtime: 'extalia-native', models: [], efforts: ['low'] }, labels)).toEqual([{ value: '', label: 'Default (-)' }]);
  });

  it('names the model a session uses next', () => {
    const state = { workspaces: [{ id: 'w1', runtimeModel: 'ag/hermes-model' }], connections: [{ id: 'c1', model: 'claude-x' }] } as never;
    expect(sessionModel(state, session('a'))).toBe('claude-x');
    expect(sessionModel(state, session('a', { options: { model: 'override' } }))).toBe('override');
    expect(sessionModel(state, session('a', { runtime: { id: 'hermes', profile: 'default' } }))).toBe('ag/hermes-model');
    expect(sessionModel(state, session('a', { control: 'observed' }))).toBeUndefined();
  });
});
