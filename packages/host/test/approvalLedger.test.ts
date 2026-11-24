import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ExactApprovalLedger,
  canonicalArgumentsJson,
  computeActionDigest,
} from '../src/approvalLedger.js';
import { createAgentHost } from '../src/service.js';
import { WORKSPACE_COMMAND_UNAVAILABLE } from '../src/tools/command.js';
import type { CommandSandboxExecutor } from '../src/tools/commandSandbox.js';
import { useTempDirs } from './helpers.js';

const tempDir = useTempDirs();

describe('computeActionDigest and canonicalArgumentsJson', () => {
  it('produces stable sha256 digests independent of object key order and sensitive to any field change', () => {
    const argsA = canonicalArgumentsJson({ b: 2, a: 1, nested: { y: true, x: false } });
    const argsB = canonicalArgumentsJson({ nested: { x: false, y: true }, a: 1, b: 2 });
    expect(argsA).toBe(argsB);

    const base = {
      sessionId: 'ses_1',
      workspaceId: 'ws_1',
      toolName: 'write_file',
      access: 'write' as const,
      target: 'src/app.ts',
      argumentsJson: argsA,
      generation: 3,
    };
    const digest = computeActionDigest(base);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeActionDigest({ ...base, argumentsJson: argsB })).toBe(digest);

    expect(computeActionDigest({ ...base, sessionId: 'ses_2' })).not.toBe(digest);
    expect(computeActionDigest({ ...base, workspaceId: 'ws_2' })).not.toBe(digest);
    expect(computeActionDigest({ ...base, toolName: 'edit_file' })).not.toBe(digest);
    expect(computeActionDigest({ ...base, access: 'execute' })).not.toBe(digest);
    expect(computeActionDigest({ ...base, target: 'src/other.ts' })).not.toBe(digest);
    expect(computeActionDigest({ ...base, argumentsJson: canonicalArgumentsJson({ a: 2 }) })).not.toBe(digest);
    expect(computeActionDigest({ ...base, generation: 4 })).not.toBe(digest);
  });
});

describe('ExactApprovalLedger', () => {
  it('issues, resolves once, verifies exact digest, and consumes single-use grants', () => {
    let clock = 1_000;
    const ledger = new ExactApprovalLedger({ ttlMs: 60_000, now: () => clock });
    const argumentsJson = canonicalArgumentsJson({ path: 'README.md' });
    const issued = ledger.issue({
      approvalId: 'apr_1',
      sessionId: 'ses_1',
      workspaceId: 'ws_1',
      toolName: 'write_file',
      access: 'write',
      target: 'README.md',
      argumentsJson,
      generation: 1,
    });
    expect(issued.state).toBe('pending');

    const resolved = ledger.resolve('apr_1', 'once');
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.record.state).toBe('granted');

    // Second resolve is refused
    const duplicate = ledger.resolve('apr_1', 'once');
    expect(duplicate).toMatchObject({ ok: false, code: 'already_settled' });

    // Effect-time verify succeeds once and consumes
    const firstVerify = ledger.verifyForEffect('apr_1', {
      sessionId: 'ses_1',
      workspaceId: 'ws_1',
      actionDigest: issued.actionDigest,
      generation: 1,
    });
    expect(firstVerify.ok).toBe(true);
    expect(ledger.get('apr_1')?.state).toBe('consumed');

    // Replay is refused
    const replay = ledger.verifyForEffect('apr_1', {
      sessionId: 'ses_1',
      workspaceId: 'ws_1',
      actionDigest: issued.actionDigest,
      generation: 1,
    });
    expect(replay).toMatchObject({ ok: false, code: 'consumed' });

    clock += 100;
    expect(ledger.list('ses_1')).toHaveLength(1);
  });

  it('allows repeated verification for session grants until revoked or expired', () => {
    let clock = 10_000;
    const ledger = new ExactApprovalLedger({ ttlMs: 5_000, now: () => clock });
    const issued = ledger.issue({
      approvalId: 'apr_session',
      sessionId: 'ses_1',
      workspaceId: 'ws_1',
      toolName: 'run_command',
      access: 'execute',
      argumentsJson: canonicalArgumentsJson({ command: 'pnpm test' }),
      generation: 2,
    });
    expect(ledger.resolve('apr_session', 'session').ok).toBe(true);

    const check1 = ledger.verifyForEffect('apr_session', {
      sessionId: 'ses_1',
      workspaceId: 'ws_1',
      actionDigest: issued.actionDigest,
      generation: 2,
    });
    const check2 = ledger.verifyForEffect('apr_session', {
      sessionId: 'ses_1',
      workspaceId: 'ws_1',
      actionDigest: issued.actionDigest,
      generation: 2,
    });
    expect(check1.ok).toBe(true);
    expect(check2.ok).toBe(true);

    // Expiry blocks verification
    clock += 6_000;
    const expired = ledger.verifyForEffect('apr_session', {
      sessionId: 'ses_1',
      workspaceId: 'ws_1',
      actionDigest: issued.actionDigest,
      generation: 2,
    });
    expect(expired).toMatchObject({ ok: false, code: 'expired' });
  });

  it('refuses mismatched digest/generation/session/workspace and revokes cleanly', () => {
    const ledger = new ExactApprovalLedger();
    const issued = ledger.issue({
      approvalId: 'apr_2',
      sessionId: 'ses_1',
      workspaceId: 'ws_1',
      toolName: 'write_file',
      access: 'write',
      argumentsJson: canonicalArgumentsJson({ path: 'a.txt' }),
      generation: 1,
    });
    ledger.resolve('apr_2', 'once');

    expect(ledger.verifyForEffect('apr_2', {
      sessionId: 'ses_1',
      workspaceId: 'ws_1',
      actionDigest: issued.actionDigest,
      generation: 2,
    })).toMatchObject({ ok: false, code: 'mismatch' });

    expect(ledger.verifyForEffect('apr_2', {
      sessionId: 'ses_other',
      workspaceId: 'ws_1',
      actionDigest: issued.actionDigest,
      generation: 1,
    })).toMatchObject({ ok: false, code: 'mismatch' });

    ledger.revoke('apr_2', 'workspace changed');
    expect(ledger.verifyForEffect('apr_2', {
      sessionId: 'ses_1',
      workspaceId: 'ws_1',
      actionDigest: issued.actionDigest,
      generation: 1,
    })).toMatchObject({ ok: false, code: 'revoked' });
  });

  it('revokes all pending/granted entries for one session without affecting others', () => {
    const ledger = new ExactApprovalLedger();
    ledger.issue({
      approvalId: 'apr_s1_a',
      sessionId: 'ses_1',
      workspaceId: 'ws_1',
      toolName: 'write_file',
      access: 'write',
      argumentsJson: '{}',
      generation: 0,
    });
    ledger.issue({
      approvalId: 'apr_s1_b',
      sessionId: 'ses_1',
      workspaceId: 'ws_1',
      toolName: 'write_file',
      access: 'write',
      argumentsJson: '{}',
      generation: 0,
    });
    ledger.resolve('apr_s1_b', 'once');
    ledger.issue({
      approvalId: 'apr_s2',
      sessionId: 'ses_2',
      workspaceId: 'ws_1',
      toolName: 'write_file',
      access: 'write',
      argumentsJson: '{}',
      generation: 0,
    });

    expect(ledger.revokeSession('ses_1', 'cancelled')).toBe(2);
    expect(ledger.get('apr_s1_a')?.state).toBe('revoked');
    expect(ledger.get('apr_s1_b')?.state).toBe('revoked');
    expect(ledger.get('apr_s2')?.state).toBe('pending');
    expect(ledger.resolve('apr_s1_a', 'once')).toMatchObject({ ok: false, code: 'revoked' });
  });

  it('caps stored entries at 512 and evicts oldest settled entries first', () => {
    const ledger = new ExactApprovalLedger();
    for (let i = 0; i < 520; i++) {
      const id = `apr_${i}`;
      ledger.issue({
        approvalId: id,
        sessionId: 'ses_cap',
        workspaceId: 'ws_1',
        toolName: 'write_file',
        access: 'write',
        argumentsJson: `{"i":${i}}`,
        generation: 0,
      });
      if (i < 500) {
        ledger.resolve(id, 'reject');
      }
    }
    expect(ledger.list()).toHaveLength(512);
    // Settled oldest entries were evicted, while pending entries (500..519) remain
    expect(ledger.get('apr_0')).toBeUndefined();
    expect(ledger.get('apr_500')?.state).toBe('pending');
    expect(ledger.get('apr_519')?.state).toBe('pending');
  });
});

describe('AgentHost Slice C sandbox status and approval revocation APIs', () => {
  it('returns fail-closed commandSandboxStatus by default and reflects an injected verified sandbox', async () => {
    const root = await tempDir('extalia-host-sandbox-status-');
    const dataA = path.join(root, 'data-a');
    const dataB = path.join(root, 'data-b');
    const home = path.join(root, 'home');
    await mkdir(home);

    const defaultRuntime = await createAgentHost({
      kind: 'desktop',
      version: '0.0.0-test',
      dataDirectory: dataA,
      homeDirectory: home,
      env: { PATH: process.env.PATH, HOME: home },
      knowledge: { autoSyncAfterMs: Infinity, watcher: false },
    });
    try {
      const status = await defaultRuntime.host.commandSandboxStatus!();
      expect(status).toEqual({
        supported: false,
        kind: 'none',
        platform: process.platform,
        networkAccess: 'denied',
        reason: WORKSPACE_COMMAND_UNAVAILABLE,
      });
    } finally {
      await defaultRuntime.close();
    }

    const verifiedSandbox: CommandSandboxExecutor = {
      status: {
        supported: true,
        kind: 'macos-seatbelt',
        platform: 'darwin',
        networkAccess: 'denied',
        verifiedAt: '2026-11-24T00:00:00.000Z',
      },
      async spawn() {
        throw new Error('unused in status test');
      },
    };
    const verifiedRuntime = await createAgentHost({
      kind: 'desktop',
      version: '0.0.0-test',
      dataDirectory: dataB,
      homeDirectory: home,
      env: { PATH: process.env.PATH, HOME: home },
      commandSandbox: verifiedSandbox,
      knowledge: { autoSyncAfterMs: Infinity, watcher: false },
    });
    try {
      const status = await verifiedRuntime.host.commandSandboxStatus!();
      expect(status).toEqual(verifiedSandbox.status);
    } finally {
      await verifiedRuntime.close();
    }
  });
});
