import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { createAgentHost } from '@extalia/host';
import type {
  GrantMissionWaiverInput,
  MissionAuthorityOverview,
  MissionReconciliationCommitInput,
  MissionReconciliationCommitResult,
  MissionReconciliationPreview,
} from '@extalia/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, type CliHost } from '../src/cli';
import { parseLoopbackMissionBridgeUrl, runMissionAuthority } from '../src/missionAuthority';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function buildPreview(): MissionReconciliationPreview {
  return {
    missionId: 'mission-1',
    sessionId: 'session-1',
    workspaceId: 'ws-alpha',
    currentState: 'recovering',
    recoverySource: 'host-restart',
    reviewDigest: DIGEST_A,
    taskSummaries: [
      {
        id: 't1',
        taskId: 'task-1',
        title: 'Run test suite',
        state: 'running',
        acceptance: 'unverified',
        evidenceCount: 0,
      },
    ],
    activeLeaseIds: ['lease-1'],
    quarantinedLeaseIds: ['lease-2'],
    eligibleDecisions: ['mark-failed', 'mark-cancelled', 'retain-quarantine'],
    warnings: ['Active worker lease must be reconciled before release.'],
  };
}

function buildOverview(overrides: Partial<MissionAuthorityOverview> = {}): MissionAuthorityOverview {
  return {
    missionId: 'mission-1',
    sessionId: 'session-1',
    workspaceId: 'ws-alpha',
    reviewDigest: DIGEST_A,
    verifiedComplete: false,
    evidence: [],
    waivers: [],
    taskGates: [
      {
        id: 't1',
        taskId: 'task-1',
        title: 'Build feature',
        state: 'completed',
        executionOutcome: 'succeeded',
        validation: 'passed',
        acceptance: 'accepted',
        legacyUnverified: false,
        evidenceCount: 1,
        dependencyBlockedBy: [],
        dependencyReleaseEligible: true,
      },
      {
        id: 't2',
        taskId: 'task-2',
        title: 'Verify integration',
        state: 'blocked',
        executionOutcome: 'unknown',
        validation: 'not_run',
        acceptance: 'unverified',
        legacyUnverified: true,
        evidenceCount: 0,
        dependencyBlockedBy: ['t1'],
        dependencyReleaseEligible: false,
      },
    ],
    ...overrides,
  };
}

describe('extalia mission CLI', () => {
  let root: string;
  let homeDirectory: string;
  let dataDirectory: string;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'extalia-mission-cli-'));
    homeDirectory = path.join(root, 'home');
    dataDirectory = path.join(root, 'extalia-data');
    await mkdir(homeDirectory, { recursive: true });
    await mkdir(dataDirectory, { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  });

  function makeHost(
    overrides: Partial<CliHost> & {
      fetch?: typeof fetch;
      dataDirectory?: string;
      createAgentHost?: typeof createAgentHost;
    } = {},
  ) {
    const out: string[] = [];
    const err: string[] = [];
    const value: CliHost & {
      fetch?: typeof fetch;
      dataDirectory?: string;
      createAgentHost?: typeof createAgentHost;
    } = {
      version: '0.0.0-test',
      out: line => out.push(line),
      err: line => err.push(line),
      readFile: file => readFile(file, 'utf8'),
      exists: async file => {
        try {
          await stat(file);
          return true;
        } catch {
          return false;
        }
      },
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      env: { EXTALIA_HOME: dataDirectory, EXTALIA_SECRET_STORE: 'memory' },
      homeDirectory,
      dataDirectory,
      start: async () => 0,
      update: async () => 0,
      ...overrides,
    };
    return { value, out, err };
  }

  it('includes mission in extalia help and handles mission help and invalid usage', async () => {
    const helpIo = makeHost();
    expect(await run(['help'], helpIo.value)).toBe(0);
    expect(helpIo.out.join('\n')).toContain('mission <action>');

    for (const args of [
      ['help'],
      ['--help'],
      ['-h'],
      ['reconcile-preview', '--help'],
      ['reconcile-commit', '-h'],
      ['evidence', '--help'],
      ['waive', '-h'],
      ['revoke-waiver', '--help'],
    ]) {
      const io = makeHost();
      expect(await runMissionAuthority(args, io.value)).toBe(0);
      expect(io.out.join('\n')).toContain('Usage: extalia mission');
    }

    const routedHelpIo = makeHost();
    expect(await run(['mission', '--help'], routedHelpIo.value)).toBe(0);
    expect(routedHelpIo.out.join('\n')).toContain('Usage: extalia mission');

    for (const args of [
      [],
      ['bogus'],
      ['reconcile-preview', '--session', 'session-1'],
      ['reconcile-commit', '--session', 'session-1', '--mission', 'mission-1'],
      ['evidence', '--mission', 'mission-1'],
      ['waive', '--session', 'session-1', '--mission', 'mission-1', '--task', 'task-1'],
      ['revoke-waiver', '--session', 'session-1', '--mission', 'mission-1', '--waiver', 'invalid-waiver'],
      ['evidence', '--session', 'session-1', '--mission', 'mission-1', '--url', 'http://127.0.0.1:4310'],
    ]) {
      const io = makeHost();
      expect(await runMissionAuthority(args, io.value)).toBe(1);
      expect(io.err.length).toBeGreaterThan(0);
    }
  });

  it('refuses non-loopback Bridge URLs fail-closed without calling fetch', async () => {
    expect(parseLoopbackMissionBridgeUrl('http://127.0.0.1:4310')?.origin).toBe('http://127.0.0.1:4310');
    expect(parseLoopbackMissionBridgeUrl('http://localhost:4310/')?.origin).toBe('http://localhost:4310');
    expect(parseLoopbackMissionBridgeUrl('http://[::1]:4310')?.origin).toBe('http://[::1]:4310');
    expect(parseLoopbackMissionBridgeUrl('https://evil.example.com')).toBeUndefined();
    expect(parseLoopbackMissionBridgeUrl('http://evil.example.com:4310')).toBeUndefined();
    expect(parseLoopbackMissionBridgeUrl('https://127.0.0.1:4310')).toBeUndefined();
    expect(parseLoopbackMissionBridgeUrl('http://user:pass@127.0.0.1:4310')).toBeUndefined();
    expect(parseLoopbackMissionBridgeUrl('http://127.0.0.1:4310/api/call')).toBeUndefined();
    expect(parseLoopbackMissionBridgeUrl('http://127.0.0.1:4310/?a=1')).toBeUndefined();

    const fetchSpy = vi.fn();
    const badArgIo = makeHost({ fetch: fetchSpy as unknown as typeof fetch });
    expect(
      await run(
        [
          'mission',
          'evidence',
          '--session', 'session-1',
          '--mission', 'mission-1',
          '--url', 'https://evil.example.com',
          '--token', 'bridge-secret',
        ],
        badArgIo.value,
      ),
    ).toBe(1);
    expect(badArgIo.err.join('\n')).toContain('loopback');
    expect(fetchSpy).not.toHaveBeenCalled();

    const badEnvIo = makeHost({
      fetch: fetchSpy as unknown as typeof fetch,
      env: {
        EXTALIA_HOME: dataDirectory,
        EXTALIA_BRIDGE_URL: 'https://evil.example.com',
        EXTALIA_BRIDGE_TOKEN: 'bridge-secret',
      },
    });
    expect(
      await runMissionAuthority(['reconcile-preview', '--session', 'session-1', '--mission', 'mission-1'], badEnvIo.value),
    ).toBe(1);
    expect(badEnvIo.err.join('\n')).toContain('loopback');
    expect(fetchSpy).not.toHaveBeenCalled();

    const missingTokenEnvIo = makeHost({
      fetch: fetchSpy as unknown as typeof fetch,
      env: {
        EXTALIA_HOME: dataDirectory,
        EXTALIA_BRIDGE_URL: 'http://127.0.0.1:4310',
      },
    });
    expect(
      await runMissionAuthority(['evidence', '--session', 'session-1', '--mission', 'mission-1'], missingTokenEnvIo.value),
    ).toBe(1);
    expect(missingTokenEnvIo.err.join('\n')).toContain('--token');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('runs reconcile-preview via mocked Bridge RPC in human-readable and --json modes', async () => {
    const preview = buildPreview();
    const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:4310/api/call');
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer tok-1');
      const body = JSON.parse(String(init?.body)) as { method: string; args: unknown[] };
      expect(body).toEqual({ method: 'previewMissionReconciliation', args: ['session-1', 'mission-1'] });
      return new Response(JSON.stringify({ result: preview }), { status: 200 });
    });

    const textIo = makeHost({ fetch: fetchSpy as unknown as typeof fetch });
    expect(
      await run(
        ['mission', 'reconcile-preview', '--session', 'session-1', '--mission', 'mission-1', '--url', 'http://127.0.0.1:4310', '--token', 'tok-1'],
        textIo.value,
      ),
    ).toBe(0);
    expect(textIo.out.join('\n')).toContain('Mission mission-1');
    expect(textIo.out.join('\n')).toContain(DIGEST_A);
    expect(textIo.out.join('\n')).toContain('mark-failed, mark-cancelled, retain-quarantine');

    const jsonIo = makeHost({ fetch: fetchSpy as unknown as typeof fetch });
    expect(
      await runMissionAuthority(
        ['reconcile-preview', '--session', 'session-1', '--mission', 'mission-1', '--url', 'http://127.0.0.1:4310', '--token', 'tok-1', '--json'],
        jsonIo.value,
      ),
    ).toBe(0);
    expect(JSON.parse(jsonIo.out.join('\n'))).toEqual(preview);
  });

  it('runs reconcile-commit for success, idempotentReplay, and stale-review-digest exit 1', async () => {
    const baseRun = {
      id: 'mission-1',
      sessionId: 'session-1',
      workspaceId: 'ws-alpha',
      title: 'Test mission',
      goal: 'Ship feature',
      state: 'failed' as const,
      transient: false,
      createdAt: '2026-11-28T10:00:00.000Z',
      updatedAt: '2026-11-28T10:05:00.000Z',
      tasks: [],
    };
    const commitSuccess: Extract<MissionReconciliationCommitResult, { ok: true }> = {
      ok: true,
      idempotentReplay: false,
      receipt: {
        receiptId: 'rcpt-1',
        missionId: 'mission-1',
        sessionId: 'session-1',
        workspaceId: 'ws-alpha',
        reviewDigest: DIGEST_A,
        decisionKey: 'key-1',
        decision: 'mark-failed',
        previousState: 'recovering',
        resultingState: 'failed',
        actor: 'operator',
        reason: 'Confirmed failed during review',
        committedAt: '2026-11-28T10:05:00.000Z',
        worktreesReleased: false,
        replayedTasks: false,
      },
      run: baseRun,
    };
    const commitReplay: MissionReconciliationCommitResult = {
      ...commitSuccess,
      idempotentReplay: true,
    };
    const commitStale: MissionReconciliationCommitResult = {
      ok: false,
      code: 'stale-review-digest',
      currentReviewDigest: DIGEST_B,
      detail: 'Mission state changed since review digest was captured.',
    };

    const recordedInputs: MissionReconciliationCommitInput[] = [];
    const fetchSpy = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; args: [MissionReconciliationCommitInput] };
      expect(body.method).toBe('commitMissionReconciliation');
      recordedInputs.push(body.args[0]);
      const idx = recordedInputs.length;
      const result = idx === 1 ? commitSuccess : idx === 2 ? commitReplay : commitStale;
      return new Response(JSON.stringify({ result }), { status: 200 });
    });

    // 1) Success with omitted --key (auto-generated cli-<uuid>)
    const okIo = makeHost({ fetch: fetchSpy as unknown as typeof fetch });
    expect(
      await runMissionAuthority(
        [
          'reconcile-commit',
          '--session', 'session-1',
          '--mission', 'mission-1',
          '--digest', DIGEST_A,
          '--decision', 'mark-failed',
          '--actor', 'operator',
          '--reason', 'Confirmed failed during review',
          '--url', 'http://localhost:4310',
          '--token', 'tok-1',
        ],
        okIo.value,
      ),
    ).toBe(0);
    expect(recordedInputs[0]?.decisionKey).toMatch(/^cli-[0-9a-f-]{36}$/i);
    expect(okIo.out.join('\n')).toContain('rcpt-1');
    expect(okIo.out.join('\n')).toContain('idempotentReplay=false');

    // 2) Idempotent replay with explicit --key and --json
    const replayIo = makeHost({ fetch: fetchSpy as unknown as typeof fetch });
    expect(
      await runMissionAuthority(
        [
          'reconcile-commit',
          '--session', 'session-1',
          '--mission', 'mission-1',
          '--digest', DIGEST_A,
          '--decision', 'mark-failed',
          '--actor', 'operator',
          '--reason', 'Confirmed failed during review',
          '--key', 'key-1',
          '--url', 'http://localhost:4310',
          '--token', 'tok-1',
          '--json',
        ],
        replayIo.value,
      ),
    ).toBe(0);
    expect(recordedInputs[1]?.decisionKey).toBe('key-1');
    expect(JSON.parse(replayIo.out.join('\n'))).toMatchObject({ ok: true, idempotentReplay: true });

    // 3) Stale review digest exits 1 and prints error code & currentReviewDigest (human-readable)
    const staleIo = makeHost({ fetch: fetchSpy as unknown as typeof fetch });
    expect(
      await runMissionAuthority(
        [
          'reconcile-commit',
          '--session', 'session-1',
          '--mission', 'mission-1',
          '--digest', DIGEST_A,
          '--decision', 'mark-failed',
          '--actor', 'operator',
          '--reason', 'Retry with stale digest',
          '--url', 'http://localhost:4310',
          '--token', 'tok-1',
        ],
        staleIo.value,
      ),
    ).toBe(1);
    expect(staleIo.err.join('\n')).toContain('stale-review-digest');
    expect(staleIo.err.join('\n')).toContain(DIGEST_B);

    // 4) Stale review digest with --json exits 1 and emits JSON payload
    const staleJsonIo = makeHost({ fetch: fetchSpy as unknown as typeof fetch });
    expect(
      await runMissionAuthority(
        [
          'reconcile-commit',
          '--session', 'session-1',
          '--mission', 'mission-1',
          '--digest', DIGEST_A,
          '--decision', 'mark-failed',
          '--actor', 'operator',
          '--reason', 'Retry with stale digest',
          '--url', 'http://localhost:4310',
          '--token', 'tok-1',
          '--json',
        ],
        staleJsonIo.value,
      ),
    ).toBe(1);
    expect(JSON.parse(staleJsonIo.out.join('\n'))).toMatchObject({
      ok: false,
      code: 'stale-review-digest',
      currentReviewDigest: DIGEST_B,
    });
  });

  it('runs evidence, waive, and revoke-waiver via mocked Bridge RPC in human-readable and --json modes', async () => {
    const baseOverview = buildOverview();
    const waivedOverview = buildOverview({
      reviewDigest: DIGEST_B,
      verifiedComplete: true,
      waivers: [
        {
          waiverId: 'wv-0123456789ab',
          missionId: 'mission-1',
          sessionId: 'session-1',
          workspaceId: 'ws-alpha',
          taskId: 'task-2',
          actor: 'reviewer',
          reason: 'Manual verification passed',
          policyVersion: 'v1',
          scope: 'dependency-release',
          reviewDigest: DIGEST_A,
          grantedAt: '2026-11-28T11:00:00.000Z',
          expiresAt: '2026-11-28T12:00:00.000Z',
        },
      ],
    });
    const revokedOverview = buildOverview({
      reviewDigest: DIGEST_B,
      verifiedComplete: false,
      waivers: [
        {
          waiverId: 'wv-0123456789ab',
          missionId: 'mission-1',
          sessionId: 'session-1',
          workspaceId: 'ws-alpha',
          taskId: 'task-2',
          actor: 'reviewer',
          reason: 'Manual verification passed',
          policyVersion: 'v1',
          scope: 'dependency-release',
          reviewDigest: DIGEST_A,
          grantedAt: '2026-11-28T11:00:00.000Z',
          expiresAt: '2026-11-28T12:00:00.000Z',
          revokedAt: '2026-11-28T11:05:00.000Z',
        },
      ],
    });

    const rpcCalls: Array<{ method: string; args: unknown[] }> = [];
    const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('http://[::1]:4310/api/call');
      const body = JSON.parse(String(init?.body)) as { method: string; args: unknown[] };
      rpcCalls.push(body);
      if (body.method === 'missionAuthorityOverview') {
        return new Response(JSON.stringify({ result: baseOverview }), { status: 200 });
      }
      if (body.method === 'grantMissionWaiver') {
        return new Response(JSON.stringify({ result: waivedOverview }), { status: 200 });
      }
      if (body.method === 'revokeMissionWaiver') {
        return new Response(JSON.stringify({ result: revokedOverview }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected method' }), { status: 500 });
    });

    // evidence (human-readable + --json)
    const evidenceTextIo = makeHost({ fetch: fetchSpy as unknown as typeof fetch });
    expect(
      await runMissionAuthority(
        ['evidence', '--session', 'session-1', '--mission', 'mission-1', '--url', 'http://[::1]:4310', '--token', 'tok-1'],
        evidenceTextIo.value,
      ),
    ).toBe(0);
    const evidenceOutput = evidenceTextIo.out.join('\n');
    expect(evidenceOutput).toContain('id');
    expect(evidenceOutput).toContain('state');
    expect(evidenceOutput).toContain('validation');
    expect(evidenceOutput).toContain('acceptance');
    expect(evidenceOutput).toContain('dependencyBlockedBy');
    expect(evidenceOutput).toContain('verifiedComplete');
    expect(evidenceOutput).toContain('t1');
    expect(evidenceOutput).toContain('t2');

    const evidenceJsonIo = makeHost({ fetch: fetchSpy as unknown as typeof fetch });
    expect(
      await runMissionAuthority(
        ['evidence', '--session', 'session-1', '--mission', 'mission-1', '--url', 'http://[::1]:4310', '--token', 'tok-1', '--json'],
        evidenceJsonIo.value,
      ),
    ).toBe(0);
    expect(JSON.parse(evidenceJsonIo.out.join('\n'))).toEqual(baseOverview);

    // waive (default scope + --ttl-ms, human-readable + --json)
    const waiveTextIo = makeHost({ fetch: fetchSpy as unknown as typeof fetch });
    expect(
      await runMissionAuthority(
        [
          'waive',
          '--session', 'session-1',
          '--mission', 'mission-1',
          '--task', 'task-2',
          '--digest', DIGEST_A,
          '--actor', 'reviewer',
          '--reason', 'Manual verification passed',
          '--policy-version', 'v1',
          '--ttl-ms', '120000',
          '--url', 'http://[::1]:4310',
          '--token', 'tok-1',
        ],
        waiveTextIo.value,
      ),
    ).toBe(0);
    expect(waiveTextIo.out.join('\n')).toContain('wv-0123456789ab');
    expect(waiveTextIo.out.join('\n')).toContain('verifiedComplete: true');
    const waiveCall = rpcCalls.find(call => call.method === 'grantMissionWaiver');
    expect(waiveCall?.args[0]).toEqual<GrantMissionWaiverInput & { ttlMs: number }>({
      sessionId: 'session-1',
      missionId: 'mission-1',
      taskId: 'task-2',
      expectedReviewDigest: DIGEST_A,
      actor: 'reviewer',
      reason: 'Manual verification passed',
      policyVersion: 'v1',
      scope: 'dependency-release',
      ttlMs: 120_000,
    });

    const waiveJsonIo = makeHost({ fetch: fetchSpy as unknown as typeof fetch });
    expect(
      await runMissionAuthority(
        [
          'waive',
          '--session', 'session-1',
          '--mission', 'mission-1',
          '--task', 'task-2',
          '--digest', DIGEST_A,
          '--actor', 'reviewer',
          '--reason', 'Override mission acceptance',
          '--policy-version', 'v2',
          '--scope', 'mission-acceptance',
          '--url', 'http://[::1]:4310',
          '--token', 'tok-1',
          '--json',
        ],
        waiveJsonIo.value,
      ),
    ).toBe(0);
    expect(JSON.parse(waiveJsonIo.out.join('\n'))).toEqual(waivedOverview);

    // revoke-waiver (human-readable + --json)
    const revokeTextIo = makeHost({ fetch: fetchSpy as unknown as typeof fetch });
    expect(
      await runMissionAuthority(
        [
          'revoke-waiver',
          '--session', 'session-1',
          '--mission', 'mission-1',
          '--waiver', 'wv-0123456789ab',
          '--url', 'http://[::1]:4310',
          '--token', 'tok-1',
        ],
        revokeTextIo.value,
      ),
    ).toBe(0);
    expect(revokeTextIo.out.join('\n')).toContain('Waiver revoked: wv-0123456789ab');
    expect(revokeTextIo.out.join('\n')).toContain('Revoked at:');

    const revokeJsonIo = makeHost({ fetch: fetchSpy as unknown as typeof fetch });
    expect(
      await runMissionAuthority(
        [
          'revoke-waiver',
          '--session', 'session-1',
          '--mission', 'mission-1',
          '--waiver', 'wv-0123456789ab',
          '--url', 'http://[::1]:4310',
          '--token', 'tok-1',
          '--json',
        ],
        revokeJsonIo.value,
      ),
    ).toBe(0);
    expect(JSON.parse(revokeJsonIo.out.join('\n'))).toEqual(revokedOverview);
    expect(rpcCalls.filter(call => call.method === 'revokeMissionWaiver').at(-1)?.args).toEqual([
      'session-1',
      'mission-1',
      'wv-0123456789ab',
    ]);
  });
});
