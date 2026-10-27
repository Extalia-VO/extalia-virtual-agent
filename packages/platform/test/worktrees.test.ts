import { describe, expect, it } from 'vitest';
import {
  AGENT_HOST_METHODS, INTEGRATION_GATE_LIMITS, isIntegrationBranch, normalizeDiscardConfirmation, normalizeIntegrationApproval, normalizeIntegrationGate, normalizeIntegrationRequest, normalizeProposalId, normalizeWorktreeId,
  WORKTREE_HOST_METHODS,
} from '../src/index.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('worktree host methods (ADR 0028)', () => {
  it('are forwarded by the transports', () => {
    for (const method of WORKTREE_HOST_METHODS) expect(AGENT_HOST_METHODS as readonly string[]).toContain(method);
  });

  it('accept only worktree and proposal ids of their own kind', () => {
    expect(normalizeWorktreeId('w-0123456789ab')).toBe('w-0123456789ab');
    expect(normalizeProposalId('i-0123456789ab')).toBe('i-0123456789ab');
    for (const raw of ['i-0123456789ab', 'w-0123456789AB', 'w-0123', '../w-0123456789ab', 7, undefined, { id: 'w-0123456789ab' }]) expect(() => normalizeWorktreeId(raw)).toThrow('Invalid worktree id.');
    for (const raw of ['w-0123456789ab', 'i-xyz', null]) expect(() => normalizeProposalId(raw)).toThrow('Invalid integration proposal id.');
  });

  it('require the exact diff digest to apply and an exact fingerprint to discard', () => {
    expect(normalizeIntegrationApproval({ diffDigest: DIGEST })).toEqual({ diffDigest: DIGEST });
    for (const raw of [undefined, {}, { diffDigest: 'a'.repeat(64) }, { diffDigest: `sha256:${'A'.repeat(64)}` }, { diffDigest: DIGEST, force: true }, [DIGEST], Object.create({ diffDigest: DIGEST })]) {
      expect(() => normalizeIntegrationApproval(raw)).toThrow(/diff digest/);
    }
    expect(normalizeDiscardConfirmation(undefined)).toBeUndefined();
    expect(normalizeDiscardConfirmation({ fingerprint: DIGEST })).toEqual({ fingerprint: DIGEST });
    for (const raw of [{}, { fingerprint: 'yes' }, { fingerprint: DIGEST, extra: 1 }, 'discard']) expect(() => normalizeDiscardConfirmation(raw)).toThrow('Invalid discard confirmation.');
  });

  it('validate the integration target and the user-chosen test gate', () => {
    expect(normalizeIntegrationRequest(undefined)).toEqual({});
    expect(normalizeIntegrationRequest({ targetBranch: 'feature/login', gate: { command: '  pnpm test  ', timeoutSeconds: 120 } })).toEqual({ targetBranch: 'feature/login', gate: { command: 'pnpm test', timeoutSeconds: 120 } });
    for (const branch of ['main', 'release/1.2', 'user_x-y']) expect(isIntegrationBranch(branch), branch).toBe(true);
    for (const branch of ['', '-x', 'a..b', 'a b', 'a~1', 'a^', 'a:b', 'x.lock', 'a/.hidden', 'a//b', '/a', 'a/', 'a.', '@', 'a@{1}', 'a\\b', 'x'.repeat(201)]) {
      expect(isIntegrationBranch(branch), branch).toBe(false);
      expect(() => normalizeIntegrationRequest({ targetBranch: branch })).toThrow(/branch/);
    }
    for (const gate of [{ command: '' }, { command: '   ' }, { command: 'x'.repeat(4_001) }, { command: 'a\0b' }, { command: 'ok', timeoutSeconds: 0 }, { command: 'ok', timeoutSeconds: 1_801 }, { command: 'ok', timeoutSeconds: 1.5 }, { command: 'ok', shell: true }, 'pnpm test']) {
      expect(() => normalizeIntegrationRequest({ gate })).toThrow();
    }
    expect(() => normalizeIntegrationRequest({ targetBranch: 'main', force: true })).toThrow('Invalid integration request.');
  });

  it('validate the workspace gate setting with the same rules as the proposal gate', () => {
    expect(INTEGRATION_GATE_LIMITS).toEqual({ maxCommand: 4_000, minTimeoutSeconds: 1, maxTimeoutSeconds: 1_800, defaultTimeoutSeconds: 600 });
    expect(normalizeIntegrationGate({ command: ' cargo test ' })).toEqual({ command: 'cargo test' });
    expect(normalizeIntegrationGate({ command: 'x'.repeat(4_000), timeoutSeconds: 1 })).toEqual({ command: 'x'.repeat(4_000), timeoutSeconds: 1 });
    expect(normalizeIntegrationGate({ command: 'pnpm test', timeoutSeconds: 1_800 })).toEqual({ command: 'pnpm test', timeoutSeconds: 1_800 });
    for (const gate of [undefined, null, 'pnpm test', ['pnpm test'], {}, { command: '' }, { command: ' ' }, { command: 7 }, { command: 'x'.repeat(4_001) }, { command: 'a\0b' },
      { command: 'ok', timeoutSeconds: 0 }, { command: 'ok', timeoutSeconds: 1_801 }, { command: 'ok', timeoutSeconds: 1.5 }, { command: 'ok', timeoutSeconds: '60' }, { command: 'ok', cwd: '/' },
      Object.create({ command: 'ok' })]) {
      expect(() => normalizeIntegrationGate(gate), JSON.stringify(gate)?.slice(0, 40)).toThrow(/test gate/i);
    }
  });
});
