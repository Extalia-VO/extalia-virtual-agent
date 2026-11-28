import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ExtaliaEvent } from '@extalia/protocol';
import {
  ExactApprovalLedger,
  canonicalArgumentsJson,
  computeActionDigest,
} from '../src/approvalLedger.js';
import { createAgentHost } from '../src/service.js';
import { WORKSPACE_COMMAND_UNAVAILABLE } from '../src/tools/command.js';
import type { CommandSandboxExecutor } from '../src/tools/commandSandbox.js';
import { useTempDirs } from './helpers.js';
import { mockModelDiscovery } from './modelDiscoveryFixture.js';

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

  it('lists approvals without raw arguments, redacts target secrets, filters by session, and reflects revocation', async () => {
    const root = await tempDir('extalia-host-list-approvals-');
    const project = path.join(root, 'project');
    const data = path.join(root, 'data');
    const home = path.join(root, 'home');
    await mkdir(project);
    await mkdir(home);

    const sse = (chunks: unknown[]) =>
      new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });

    const testSecretToken = ['sk', 'test', '1234567890abcdef1234'].join('-');
    let callCounter = 0;
    const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'mock-agent' }] });
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string }> };
      const last = body.messages.at(-1);
      if (last?.role !== 'tool') {
        callCounter++;
        const filePath = callCounter === 1
          ? `notes-${testSecretToken}.txt`
          : 'second-file.txt';
        return sse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_write_${callCounter}`,
                      function: {
                        name: 'write_file',
                        arguments: JSON.stringify({
                          path: filePath,
                          content: 'SECRET_ARGUMENT_BODY_SHOULD_NOT_LEAK',
                        }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]);
      }
      return sse([{ choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] }]);
    };

    const runtime = await createAgentHost({
      kind: 'bridge',
      version: '0.0.0-test',
      dataDirectory: data,
      homeDirectory: home,
      importHome: home,
      env: { EXTALIA_SECRET_STORE: 'memory', PATH: process.env.PATH, HOME: home },
      fetch,
      modelDiscovery: mockModelDiscovery(fetch),
      knowledge: { autoSyncAfterMs: Infinity, watcher: false },
    });
    const events: ExtaliaEvent[] = [];
    runtime.host.subscribe(event => events.push(event));

    try {
      const saved = await runtime.host.saveConnection({
        name: 'Mock',
        preset: 'custom',
        api: 'openai-chat',
        baseUrl: 'http://mock.test/v1',
        model: 'mock-agent',
        credential: { kind: 'none' },
        features: { memory: 'off', skills: 'off' },
      });
      await runtime.host.saveWorkspace({
        name: 'Project',
        projectLocation: project,
        connectionId: saved.connections[0]!.id,
        permissions: { fileWrite: 'ask', commands: 'ask' },
      });
      await runtime.host.completeSetup();
      const workspaceId = (await runtime.host.getState()).workspaces[0]!.id;

      const sessionA = await runtime.host.createSession(workspaceId);
      const sessionB = await runtime.host.createSession(workspaceId);

      // Trigger first pending approval on sessionA (with credential-shaped target)
      await runtime.host.sendPrompt(sessionA.id, 'Write secret note');
      let approvalAId = '';
      await vi.waitFor(() => {
        const event = events.find(item => item.sessionId === sessionA.id && item.body.type === 'approval.requested');
        expect(event).toBeDefined();
        approvalAId = (event!.body as { approvalId: string }).approvalId;
      }, { timeout: 5_000, interval: 10 });

      const listedA = await runtime.host.listApprovals!(sessionA.id);
      expect(listedA).toHaveLength(1);
      expect(listedA[0]).toMatchObject({
        approvalId: approvalAId,
        sessionId: sessionA.id,
        workspaceId,
        toolName: 'write_file',
        access: 'write',
        target: 'notes-[redacted].txt',
        state: 'pending',
      });
      expect('argumentsJson' in listedA[0]!).toBe(false);
      expect(JSON.stringify(listedA)).not.toContain('SECRET_ARGUMENT_BODY_SHOULD_NOT_LEAK');
      expect(JSON.stringify(listedA)).not.toContain(testSecretToken);

      // Revoke immediately updates state in listApprovals
      await runtime.host.revokeApproval!(sessionA.id, approvalAId);
      await vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { timeout: 5_000, interval: 10 });

      const afterRevoke = await runtime.host.listApprovals!(sessionA.id);
      expect(afterRevoke[0]).toMatchObject({
        approvalId: approvalAId,
        state: 'revoked',
        revokeReason: 'revoked by user',
      });

      // Trigger second approval on sessionB and verify filtering + newest-first order
      await runtime.host.sendPrompt(sessionB.id, 'Write second note');
      let approvalBId = '';
      await vi.waitFor(() => {
        const event = events.find(item => item.sessionId === sessionB.id && item.body.type === 'approval.requested');
        expect(event).toBeDefined();
        approvalBId = (event!.body as { approvalId: string }).approvalId;
      }, { timeout: 5_000, interval: 10 });

      const allApprovals = await runtime.host.listApprovals!();
      expect(allApprovals).toHaveLength(2);
      expect(allApprovals[0]!.approvalId).toBe(approvalBId);
      expect(allApprovals[1]!.approvalId).toBe(approvalAId);

      const onlyB = await runtime.host.listApprovals!(sessionB.id);
      expect(onlyB.map(item => item.approvalId)).toEqual([approvalBId]);

      await expect(runtime.host.listApprovals!('   ')).rejects.toThrow(/Invalid session filter/);

      await runtime.host.resolveApproval(sessionB.id, approvalBId, 'reject');
      await vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { timeout: 5_000, interval: 10 });
    } finally {
      await runtime.close();
    }
  });
});
