import { describe, expect, it } from 'vitest';
import { PROVIDER_PRESETS, checkEndpoint, decodeConnection, defaultOrchestration, keepsHistory, presetById, providerHeaders, resolveFeatures, tierModel } from '../src/index.js';

const T0 = '2026-01-31T10:00:00.000Z';
const base = {
  id: 'c1', name: 'Router', preset: '9router', api: 'openai-chat', baseUrl: 'http://localhost:20128/v1/', model: 'auto',
  credential: { kind: 'stored', ref: 'connection-c1' }, features: { memory: 'extalia', skills: 'extalia' }, createdAt: T0, updatedAt: T0,
};

describe('connections', () => {
  it('decodes a connection and normalizes the endpoint', () => {
    const result = decodeConnection(base);
    expect(result).toMatchObject({ ok: true, value: { baseUrl: 'http://localhost:20128/v1', credential: { kind: 'stored', ref: 'connection-c1' } } });
  });

  it('never accepts a secret inside the connection', () => {
    expect(decodeConnection({ ...base, apiKey: 'abc' }).ok).toBe(false);
    expect(decodeConnection({ ...base, baseUrl: 'https://user:pass@example.com/v1' }).ok).toBe(false);
    expect(decodeConnection({ ...base, credential: { kind: 'env', variable: 'not valid' } }).ok).toBe(false);
  });

  it('allows provider-managed memory and skills only for presets that have them', () => {
    expect(decodeConnection({ ...base, features: { memory: 'provider', skills: 'extalia' } }).ok).toBe(false);
    expect(decodeConnection({ ...base, preset: 'omniroute', features: { memory: 'provider', skills: 'provider' } }).ok).toBe(true);
  });

  it('saves history unless the connection turns it off', () => {
    const saved = decodeConnection(base), unsaved = decodeConnection({ ...base, features: { ...base.features, history: false } });
    expect(saved.ok && keepsHistory(saved.value)).toBe(true);
    expect(unsaved.ok && unsaved.value.features).toEqual({ memory: 'extalia', skills: 'extalia', history: false });
    expect(unsaved.ok && keepsHistory(unsaved.value)).toBe(false);
    const explicit = decodeConnection({ ...base, features: { ...base.features, history: true } });
    expect(explicit.ok && explicit.value.features).toEqual({ memory: 'extalia', skills: 'extalia' });
    expect(decodeConnection({ ...base, features: { ...base.features, history: 'no' } }).ok).toBe(false);
  });

  it('resolves who provides memory and skills', () => {
    expect(resolveFeatures({ preset: '9router', features: { memory: 'extalia', skills: 'off' } })).toEqual({ extaliaMemory: true, extaliaSkills: false, suppressProviderMemory: false });
    expect(resolveFeatures({ preset: 'omniroute', features: { memory: 'extalia', skills: 'provider' } })).toEqual({ extaliaMemory: true, extaliaSkills: false, suppressProviderMemory: true });
    expect(providerHeaders({ preset: 'omniroute', features: { memory: 'extalia', skills: 'provider' } })).toEqual({ 'x-omniroute-no-memory': 'true' });
    expect(providerHeaders({ preset: 'omniroute', features: { memory: 'provider', skills: 'provider' } })).toEqual({});
  });

  it('ships presets with valid defaults', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.baseUrl) expect(() => checkEndpoint(preset.baseUrl)).not.toThrow();
      if (preset.defaults.memory === 'provider') expect(preset.nativeMemory).toBe(true);
      if (preset.defaults.skills === 'provider') expect(preset.nativeSkills).toBe(true);
    }
    expect(presetById('omniroute').defaults).toMatchObject({ memory: 'provider', skills: 'provider' });
  });

  it('makes the 9Router key optional and keeps its local default endpoint', () => {
    expect(presetById('9router')).toMatchObject({ apiKey: 'optional', baseUrl: 'http://localhost:20128/v1', local: true });
    const keyless = decodeConnection({ ...base, credential: { kind: 'none' } });
    expect(keyless.ok && keyless.value.credential).toEqual({ kind: 'none' });
  });

  it('turns orchestration on by default and resolves tier models', () => {
    const legacy = decodeConnection(base);
    expect(legacy.ok && legacy.value.orchestration).toEqual({ enabled: true, maxDelegations: 3, tiers: {} });
    expect(defaultOrchestration('anthropic').tiers).toEqual({ complex: 'claude-opus-5-5', standard: 'claude-sonnet-5-5', quick: 'claude-haiku-4-5' });
    const connection = { model: 'main-model', orchestration: { enabled: true, maxDelegations: 3, tiers: { quick: 'small-model' } } };
    expect(tierModel(connection, 'quick')).toBe('small-model');
    expect(tierModel(connection, 'complex')).toBe('main-model');
    expect(decodeConnection({ ...base, orchestration: { enabled: true, maxDelegations: 99, tiers: {} } }).ok).toBe(false);
  });
});
