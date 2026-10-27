import { describe, expect, it } from 'vitest';
import { assertNoCredentialFields, countSecrets, decodeIntegrationGate, decodeProfile, decodeWorkspace, redact, safeLabel, workspaceRuntime } from '../src/index.js';

const T0 = '2026-01-31T10:00:00.000Z';

describe('profiles and workspaces', () => {
  it('accepts user-defined names without special cases', () => {
    const profile = decodeProfile({ id: 'p1', name: 'Personal', defaults: { runtimeId: 'hermes' }, createdAt: T0, updatedAt: T0 });
    const workspace = decodeWorkspace({ id: 'w1', profileId: 'p1', name: 'Website', projectLocation: '/projects/website', createdAt: T0, updatedAt: T0 });
    expect(profile).toMatchObject({ ok: true, value: { name: 'Personal', defaults: { runtimeId: 'hermes' } } });
    expect(workspace).toMatchObject({ ok: true, value: { projectLocation: '/projects/website' } });
  });

  it('rejects credentials, inverted timestamps and multi-line names', () => {
    expect(decodeProfile({ id: 'p1', name: 'P', token: 'x', createdAt: T0, updatedAt: T0 }).ok).toBe(false);
    expect(decodeWorkspace({ id: 'w', profileId: 'p', name: 'W', createdAt: '2026-02-01T00:00:00.000Z', updatedAt: T0 }).ok).toBe(false);
    expect(decodeWorkspace({ id: 'w', profileId: 'p', name: 'two\nlines', createdAt: T0, updatedAt: T0 }).ok).toBe(false);
  });

  it('keeps a bounded explicit native mission connection allowlist', () => {
    const base = { id: 'w1', profileId: 'p1', name: 'Workspace', createdAt: T0, updatedAt: T0 };
    const ids = ['c-primary', 'c-secondary'];
    const parsed = decodeWorkspace({ ...base, missionConnectionIds: ids });
    expect(parsed).toMatchObject({ ok: true, value: { missionConnectionIds: ids } });
    ids.push('later');
    expect(parsed.ok && parsed.value.missionConnectionIds).toEqual(['c-primary', 'c-secondary']);
    for (const invalid of [null, 'c1', ['c1', 'c1'], [' c1'], ['c1\nc2'], Array.from({ length: 9 }, (_, n) => `c${n}`)]) {
      expect(decodeWorkspace({ ...base, missionConnectionIds: invalid }).ok).toBe(false);
    }
    expect(decodeWorkspace(base)).toMatchObject({ ok: true, value: base });
  });

  it('keeps a valid integration test gate and drops a damaged one without losing the workspace (ADR 0028)', () => {
    const base = { id: 'w1', profileId: 'p1', name: 'Workspace', createdAt: T0, updatedAt: T0 };
    expect(decodeWorkspace({ ...base, integrationGate: { command: ' pnpm test ', timeoutSeconds: 900 } })).toMatchObject({ ok: true, value: { integrationGate: { command: 'pnpm test', timeoutSeconds: 900 } } });
    expect(decodeWorkspace({ ...base, integrationGate: { command: 'cargo test' } })).toEqual({ ok: true, value: { ...base, integrationGate: { command: 'cargo test' } } });
    for (const damaged of [{ command: '' }, { command: 'x'.repeat(4_001) }, { command: 'ok', timeoutSeconds: 0 }, { command: 'ok', timeoutSeconds: 1_801 }, 'npm test', null]) {
      const decoded = decodeWorkspace({ ...base, integrationGate: damaged });
      expect(decoded.ok && 'integrationGate' in decoded.value, JSON.stringify(damaged)?.slice(0, 30)).toBe(false);
      expect(decoded.ok).toBe(true);
    }
    expect(() => decodeIntegrationGate({ command: 'ok', timeoutSeconds: 1.5 })).toThrow(/timeoutSeconds/);
    expect(() => decodeIntegrationGate({ command: 'a\0b' })).toThrow(/command/);
  });

  it('keeps Extalia Native as the default runtime and validates Hermes settings', () => {
    const base = { id: 'w', profileId: 'p', name: 'W', createdAt: T0, updatedAt: T0 };
    const native = decodeWorkspace({ ...base, providerProfileId: 'c1' });
    expect(native.ok && native.value.runtimeId).toBeUndefined();
    expect(native.ok && workspaceRuntime(native.value)).toBe('extalia-native');
    const explicit = decodeWorkspace({ ...base, runtimeId: 'extalia-native', providerProfileId: 'c1' });
    expect(explicit.ok && explicit.value.runtimeId).toBeUndefined();
    expect(decodeWorkspace({ ...base, runtimeId: 'hermes' })).toMatchObject({ ok: true, value: { runtimeId: 'hermes', runtimeProfileId: 'default' } });
    expect(decodeWorkspace({ ...base, runtimeId: 'hermes', runtimeProfileId: 'work_2', runtimeModel: 'example/model-1' }))
      .toMatchObject({ ok: true, value: { runtimeProfileId: 'work_2', runtimeModel: 'example/model-1' } });
    expect(decodeWorkspace({ ...base, runtimeId: 'codex' }).ok).toBe(false);
    expect(decodeWorkspace({ ...base, runtimeId: 'hermes', runtimeProfileId: 'Work Bot' }).ok).toBe(false);
    expect(decodeWorkspace({ ...base, runtimeId: 'hermes', runtimeModel: '--yolo' }).ok).toBe(false);
    expect(decodeWorkspace({ ...base, runtimeId: 'hermes', runtimeModel: 'two words' }).ok).toBe(false);
  });
});

describe('privacy', () => {
  it('redacts common credential formats and keeps assignment keys readable', () => {
    const input = 'token=abcdef123456 https://user:pass@example.com ghp_abcdefghijklmnopqrstuvwxyz0123'; // extalia-allow-secret
    const output = redact(input);
    expect(output).toContain('token=[redacted]');
    expect(output).toContain('https://[redacted]@example.com');
    expect(output).not.toContain('ghp_');
    expect(countSecrets(input)).toBe(3);
  });

  it('produces bounded single-line labels', () => {
    expect(safeLabel('line one\nline two', 12)).toBe('line one li…');
  });

  it('finds credential fields at any depth', () => {
    expect(() => assertNoCredentialFields({ a: [{ b: { client_secret: 'x' } }] })).toThrow();
    expect(() => assertNoCredentialFields({ tokens: 3, messages: ['token=1'] })).not.toThrow();
  });
});
