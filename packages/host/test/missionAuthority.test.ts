import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostMissionRun } from '@extalia/platform';
import { MissionRecords } from '../src/mission.js';
import { createMissionAuthorityService } from '../src/missionAuthority.js';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { SessionStore } from '../src/sessions.js';
import { mockModelDiscovery } from './modelDiscoveryFixture.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function makeTempRoot(prefix = 'extalia-mission-authority-'): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function openHost(dataDirectory: string, homeDirectory: string): Promise<AgentHostRuntime> {
  const fetchImpl: NonNullable<Parameters<typeof createAgentHost>[0]['fetch']> = async url => {
    if (String(url).endsWith('/models')) {
      return Response.json({ data: [{ id: 'mock-model' }] });
    }
    return Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  };
  return createAgentHost({
    kind: 'desktop',
    version: '0.0.0-test',
    dataDirectory,
    homeDirectory,
    importHome: homeDirectory,
    observationIntervalMs: 60_000,
    env: {
      EXTALIA_SECRET_STORE: 'memory',
      PATH: process.env.PATH ?? '',
      HOME: homeDirectory,
    },
    fetch: fetchImpl,
    modelDiscovery: mockModelDiscovery(fetchImpl),
    knowledge: { autoSyncAfterMs: Infinity, watcher: false },
  });
}

async function seedSession(dataDirectory: string, homeDirectory: string) {
  const projectDirectory = path.join(path.dirname(dataDirectory), 'project');
  await mkdir(homeDirectory, { recursive: true });
  await mkdir(projectDirectory, { recursive: true });

  const runtime = await openHost(dataDirectory, homeDirectory);
  try {
    const savedConn = await runtime.host.saveConnection({
      name: 'Mock Provider',
      preset: 'custom',
      api: 'openai-chat',
      baseUrl: 'https://api.example.com/v1',
      model: 'mock-model',
      credential: { kind: 'none' },
      features: { memory: 'off', skills: 'off', history: true },
    });
    const connection = savedConn.connections[0]!;
    const savedWs = await runtime.host.saveWorkspace({
      name: 'Mission Workspace',
      projectLocation: projectDirectory,
      connectionId: connection.id,
      permissions: { fileWrite: 'ask', commands: 'ask' },
    });
    const workspace = savedWs.workspaces[0]!;
    const session = await runtime.host.createSession(workspace.id);
    return { connection, workspace, session };
  } finally {
    await runtime.close();
  }
}

async function seedMissionRun(dataDirectory: string, sessionId: string, run: HostMissionRun): Promise<void> {
  const sessionStore = new SessionStore(path.join(dataDirectory, 'sessions'));
  const sessions = await sessionStore.list();
  const records = new MissionRecords(path.join(dataDirectory, 'sessions'), path.join(dataDirectory, 'state', 'missions.sqlite'));
  await records.initialize(sessions);
  try {
    expect(sessions.some(s => s.id === sessionId)).toBe(true);
    await records.save(run);
  } finally {
    records.close();
  }
}

describe('Host MissionAuthorityService & RPCs (V2-04 / V2-06)', () => {
  it('AR-07 & AR-08: detects stale review digests on lease/evidence changes, enforces idempotent reconciliation, rejects conflicts, and persists across restart', async () => {
    const root = await makeTempRoot();
    const data = path.join(root, 'data');
    const home = path.join(root, 'home');
    const { connection, workspace, session } = await seedSession(data, home);

    const missionId = randomUUID();
    const taskBuildId = randomUUID();
    const taskDeployId = randomUUID();
    const agentBuildId = randomUUID();
    const agentDeployId = randomUUID();
    const at = '2026-11-28T10:00:00.000Z';

    const recoveringRun: HostMissionRun = {
      id: missionId,
      sessionId: session.id,
      workspaceId: workspace.id,
      title: 'Recovered Mission',
      state: 'recovering',
      createdAt: at,
      updatedAt: at,
      transient: false,
      authority: { backend: 'typescript' },
      recovery: { source: 'host-restart', at },
      tasks: [
        {
          id: 'build',
          taskId: taskBuildId,
          agentId: agentBuildId,
          title: 'Build package',
          connectionId: connection.id,
          model: 'mock-model',
          state: 'completed',
          answer: 'Build finished earlier.',
          verification: 'unverified',
          evidenceIds: [],
        },
        {
          id: 'deploy',
          taskId: taskDeployId,
          agentId: agentDeployId,
          title: 'Verify release',
          dependsOn: ['build'],
          connectionId: connection.id,
          model: 'mock-model',
          state: 'unknown',
          reason: 'host-restarted',
          usage: { unknown: true },
          evidenceIds: [],
        },
      ],
    };
    await seedMissionRun(data, session.id, recoveringRun);

    const leaseId = 'wl-abcdef123456';
    await mkdir(path.join(data, 'state'), { recursive: true });
    await writeFile(
      path.join(data, 'state', 'worker-leases.json'),
      JSON.stringify({
        schema: 'extalia.worker-leases.v1',
        nextFencingToken: 2,
        leases: [
          {
            leaseId,
            ownerId: 'prior-dead-host',
            taskId: taskDeployId,
            sessionId: session.id,
            missionId,
            fencingToken: 1,
            status: 'active',
            acquiredAt: at,
            heartbeatAt: at,
            leaseExpiresAt: '2026-11-28T10:05:00.000Z',
          },
        ],
      }, null, 2),
      'utf8',
    );

    const runtime = await openHost(data, home);
    let committedReceiptId: string;
    try {
      const preview1 = await runtime.host.previewMissionReconciliation!(session.id, missionId);
      expect(preview1.currentState).toBe('recovering');
      expect(preview1.recoverySource).toBe('host-restart');
      expect(preview1.quarantinedLeaseIds).toEqual([leaseId]);
      expect(preview1.eligibleDecisions).toEqual(['mark-failed', 'mark-cancelled', 'retain-quarantine']);
      const digestD1 = preview1.reviewDigest;

      // Lease change (acknowledging quarantined lease) advances reviewDigest -> D2.
      await runtime.host.reconcileWorkerLease!(leaseId, 'acknowledge');
      const preview2 = await runtime.host.previewMissionReconciliation!(session.id, missionId);
      expect(preview2.quarantinedLeaseIds).toEqual([]);
      expect(preview2.reviewDigest).not.toBe(digestD1);

      // Evidence recording advances reviewDigest -> D3.
      await runtime.host.recordMissionEvidence!({
        sessionId: session.id,
        missionId,
        taskId: taskBuildId,
        sourceKind: 'test-report',
        validation: 'passed',
        contentSha256: '1'.repeat(64),
        artifactPath: 'reports/build.json',
        summary: 'Build test suite passed.',
      });
      const preview3 = await runtime.host.previewMissionReconciliation!(session.id, missionId);
      const digestD3 = preview3.reviewDigest;
      expect(digestD3).not.toBe(preview2.reviewDigest);

      // AR-07: committing with stale digest D1 fails and leaves run in recovering state.
      const staleCommit = await runtime.host.commitMissionReconciliation!({
        sessionId: session.id,
        missionId,
        expectedReviewDigest: digestD1,
        decisionKey: 'dec-1',
        decision: 'mark-failed',
        actor: 'operator',
        reason: 'Accept failure after review',
      });
      expect(staleCommit).toMatchObject({
        ok: false,
        code: 'stale-review-digest',
        currentReviewDigest: digestD3,
      });
      expect((await runtime.host.nativeMissionRun(session.id, missionId)).state).toBe('recovering');

      // AR-07: granting a waiver with stale digest D1 is also rejected.
      await expect(runtime.host.grantMissionWaiver!({
        sessionId: session.id,
        missionId,
        taskId: taskDeployId,
        expectedReviewDigest: digestD1,
        actor: 'operator',
        reason: 'Waive with stale digest',
        policyVersion: 'v1',
        scope: 'dependency-release',
      })).rejects.toThrow(/stale-review-digest/);

      // Valid commit transitions run to failed without fabricating completion or releasing worktrees.
      const commitInput = {
        sessionId: session.id,
        missionId,
        expectedReviewDigest: digestD3,
        decisionKey: 'dec-1',
        decision: 'mark-failed' as const,
        actor: 'operator',
        reason: 'Deploy remained unknown after host restart',
      };
      const committed = await runtime.host.commitMissionReconciliation!(commitInput);
      expect(committed.ok).toBe(true);
      if (!committed.ok) throw new Error('Expected reconciliation commit to succeed');
      committedReceiptId = committed.receipt.receiptId;
      expect(committed.idempotentReplay).toBe(false);
      expect(committed.receipt).toMatchObject({
        missionId,
        sessionId: session.id,
        workspaceId: workspace.id,
        reviewDigest: digestD3,
        decisionKey: 'dec-1',
        decision: 'mark-failed',
        previousState: 'recovering',
        resultingState: 'failed',
        worktreesReleased: false,
        replayedTasks: false,
      });
      expect(committed.run.state).toBe('failed');
      expect(committed.run.tasks[0]).toMatchObject({
        id: 'build',
        state: 'completed',
        answer: 'Build finished earlier.',
        verification: 'unverified',
      });
      expect(committed.run.tasks[1]).toMatchObject({
        id: 'deploy',
        state: 'failed',
        reason: 'host-restarted',
      });

      // AR-08: exact replay returns identical receipt with idempotentReplay: true.
      const replay = await runtime.host.commitMissionReconciliation!(commitInput);
      expect(replay).toMatchObject({
        ok: true,
        idempotentReplay: true,
        receipt: {
          receiptId: committedReceiptId,
          worktreesReleased: false,
          replayedTasks: false,
        },
      });

      // AR-08: conflicting decision or key returns already-reconciled.
      const conflict = await runtime.host.commitMissionReconciliation!({
        ...commitInput,
        decisionKey: 'dec-2',
        decision: 'mark-cancelled',
      });
      expect(conflict).toMatchObject({
        ok: false,
        code: 'already-reconciled',
      });

      // Missing mission returns not-found.
      const missing = await runtime.host.commitMissionReconciliation!({
        ...commitInput,
        missionId: randomUUID(),
      });
      expect(missing).toMatchObject({
        ok: false,
        code: 'not-found',
      });
    } finally {
      await runtime.close();
    }

    // Reopen host and verify durable persistence of reconciled run, receipt, and evidence.
    const reopened = await openHost(data, home);
    try {
      const persistedRun = await reopened.host.nativeMissionRun(session.id, missionId);
      expect(persistedRun.state).toBe('failed');
      const previewAfterRestart = await reopened.host.previewMissionReconciliation!(session.id, missionId);
      expect(previewAfterRestart.eligibleDecisions).toEqual([]);
      expect(previewAfterRestart.existingReceipt?.receiptId).toBe(committedReceiptId);

      const replayAfterRestart = await reopened.host.commitMissionReconciliation!({
        sessionId: session.id,
        missionId,
        expectedReviewDigest: previewAfterRestart.existingReceipt!.reviewDigest,
        decisionKey: 'dec-1',
        decision: 'mark-failed',
        actor: 'operator',
        reason: 'Deploy remained unknown after host restart',
      });
      expect(replayAfterRestart).toMatchObject({
        ok: true,
        idempotentReplay: true,
        receipt: {
          receiptId: committedReceiptId,
          worktreesReleased: false,
          replayedTasks: false,
        },
      });
    } finally {
      await reopened.close();
    }
  });

  it('AR-12 & AR-13: enforces evidence gates, keeps observed claims unverified, supports grant/revoke waivers, and rejects traversal or forged taskIds', async () => {
    const root = await makeTempRoot();
    const data = path.join(root, 'data');
    const home = path.join(root, 'home');
    const { connection, workspace, session } = await seedSession(data, home);

    const missionId = randomUUID();
    const taskBuildId = randomUUID();
    const taskDeployId = randomUUID();
    const at = '2026-11-28T11:00:00.000Z';

    const completedRun: HostMissionRun = {
      id: missionId,
      sessionId: session.id,
      workspaceId: workspace.id,
      title: 'Evidence Gate Mission',
      state: 'completed',
      createdAt: at,
      updatedAt: at,
      transient: false,
      authority: { backend: 'typescript' },
      tasks: [
        {
          id: 'build',
          taskId: taskBuildId,
          agentId: randomUUID(),
          title: 'Build',
          connectionId: connection.id,
          model: 'mock-model',
          state: 'completed',
          verification: 'unverified',
          evidenceIds: [],
        },
        {
          id: 'deploy',
          taskId: taskDeployId,
          agentId: randomUUID(),
          title: 'Deploy',
          dependsOn: ['build'],
          connectionId: connection.id,
          model: 'mock-model',
          state: 'completed',
          verification: 'unverified',
          evidenceIds: [],
        },
      ],
    };
    await seedMissionRun(data, session.id, completedRun);

    const runtime = await openHost(data, home);
    try {
      // Non-recovering mission returns not-recovering on commit.
      const nonRecoveringPreview = await runtime.host.previewMissionReconciliation!(session.id, missionId);
      expect(nonRecoveringPreview.eligibleDecisions).toEqual([]);
      const notRecoveringCommit = await runtime.host.commitMissionReconciliation!({
        sessionId: session.id,
        missionId,
        expectedReviewDigest: nonRecoveringPreview.reviewDigest,
        decisionKey: 'k-nr',
        decision: 'mark-failed',
        actor: 'operator',
        reason: 'Not recovering',
      });
      expect(notRecoveringCommit).toMatchObject({ ok: false, code: 'not-recovering' });

      // Initial state: unverified, downstream deploy blocked by build.
      const initial = await runtime.host.missionAuthorityOverview!(session.id, missionId);
      expect(initial.verifiedComplete).toBe(false);
      expect(initial.taskGates[0]).toMatchObject({ id: 'build', acceptance: 'unverified', legacyUnverified: true });
      expect(initial.taskGates[1]).toMatchObject({
        id: 'deploy',
        dependencyReleaseEligible: false,
        dependencyBlockedBy: ['build'],
      });

      // AR-13: path traversal in artifactPath and forged/cross-session taskId are rejected.
      await expect(runtime.host.recordMissionEvidence!({
        sessionId: session.id,
        missionId,
        taskId: taskBuildId,
        sourceKind: 'test-report',
        validation: 'passed',
        contentSha256: 'a'.repeat(64),
        artifactPath: '../outside/secret.txt',
        summary: 'Path traversal attempt',
      })).rejects.toThrow(/artifactPath/);

      await expect(runtime.host.recordMissionEvidence!({
        sessionId: session.id,
        missionId,
        taskId: randomUUID(),
        sourceKind: 'test-report',
        validation: 'passed',
        contentSha256: 'a'.repeat(64),
        summary: 'Forged cross-session task id',
      })).rejects.toThrow(/taskId/);

      // AR-13: observed-claim with validation='passed' remains unverified and never unlocks downstream tasks.
      const afterObserved = await runtime.host.recordMissionEvidence!({
        sessionId: session.id,
        missionId,
        taskId: taskBuildId,
        sourceKind: 'observed-claim',
        validation: 'passed',
        contentSha256: 'b'.repeat(64),
        summary: 'Model claimed build succeeded.',
      });
      expect(afterObserved.evidence[0]).toMatchObject({
        sourceKind: 'observed-claim',
        validation: 'passed',
        verifiedByHost: false,
        acceptance: 'unverified',
      });
      expect(afterObserved.verifiedComplete).toBe(false);
      expect(afterObserved.taskGates[1]).toMatchObject({
        dependencyReleaseEligible: false,
        dependencyBlockedBy: ['build'],
      });

      // AR-12: dependency-release waiver unlocks downstream deploy; revoking waiver re-blocks it.
      const afterWaiver = await runtime.host.grantMissionWaiver!({
        sessionId: session.id,
        missionId,
        taskId: taskBuildId,
        expectedReviewDigest: afterObserved.reviewDigest,
        actor: 'operator',
        reason: 'Manual verification of build artifact',
        policyVersion: 'policy-2026.1',
        scope: 'dependency-release',
        ttlMs: 120_000,
      });
      expect(afterWaiver.waivers).toHaveLength(1);
      const waiverId = afterWaiver.waivers[0]!.waiverId;
      expect(afterWaiver.taskGates[0]).toMatchObject({ acceptance: 'waived', activeWaiverId: waiverId });
      expect(afterWaiver.taskGates[1]).toMatchObject({
        dependencyReleaseEligible: true,
        dependencyBlockedBy: [],
      });
      expect(afterWaiver.verifiedComplete).toBe(false);

      const afterRevoke = await runtime.host.revokeMissionWaiver!(session.id, missionId, waiverId);
      expect(afterRevoke.waivers[0]?.revokedAt).toBeTruthy();
      expect(afterRevoke.reviewDigest).not.toBe(afterWaiver.reviewDigest);
      expect(afterRevoke.taskGates[1]).toMatchObject({
        dependencyReleaseEligible: false,
        dependencyBlockedBy: ['build'],
      });
      expect(afterRevoke.verifiedComplete).toBe(false);

      // AR-12: passing test-report evidence unlocks deploy, and passing command-gate on deploy completes verification.
      const afterBuildEvidence = await runtime.host.recordMissionEvidence!({
        sessionId: session.id,
        missionId,
        taskId: taskBuildId,
        sourceKind: 'test-report',
        validation: 'passed',
        contentSha256: 'c'.repeat(64),
        artifactPath: 'reports/build-junit.xml',
        summary: 'All build checks passed.',
      });
      expect(afterBuildEvidence.taskGates[0]).toMatchObject({ acceptance: 'accepted', legacyUnverified: false });
      expect(afterBuildEvidence.taskGates[1]).toMatchObject({
        dependencyReleaseEligible: true,
        dependencyBlockedBy: [],
      });
      expect(afterBuildEvidence.verifiedComplete).toBe(false);

      const afterDeployEvidence = await runtime.host.recordMissionEvidence!({
        sessionId: session.id,
        missionId,
        taskId: taskDeployId,
        sourceKind: 'command-gate',
        validation: 'passed',
        contentSha256: 'd'.repeat(64),
        summary: 'Release verification command exited 0.',
      });
      expect(afterDeployEvidence.verifiedComplete).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it('supports mark-cancelled, retain-quarantine, local-active blocking, and fails closed on corrupt store', async () => {
    const root = await makeTempRoot();
    const storeFile = path.join(root, 'mission-authority.json');

    // Corrupt JSON store fails closed without altering the file.
    await writeFile(storeFile, '{not-valid-json', 'utf8');
    await expect(createMissionAuthorityService({
      storeFile,
      getMission: () => undefined,
      saveMission: async () => undefined,
      listWorkerLeases: () => [],
      isSessionActive: () => false,
    })).rejects.toThrow();
    expect(await readFile(storeFile, 'utf8')).toBe('{not-valid-json');

    // Tampered observed-claim marked verifiedByHost fails closed on load.
    const tampered = {
      schema: 'extalia.mission-authority.v1',
      receipts: [],
      evidence: [
        {
          evidenceId: 'ev-1234567890ab',
          missionId: randomUUID(),
          sessionId: 's_1',
          workspaceId: randomUUID(),
          taskId: randomUUID(),
          sourceKind: 'observed-claim',
          validation: 'passed',
          acceptance: 'accepted',
          contentSha256: 'a'.repeat(64),
          summary: 'Tampered',
          recordedAt: '2026-11-28T10:00:00.000Z',
          verifiedByHost: true,
        },
      ],
      waivers: [],
    };
    const tamperedStoreFile = path.join(root, 'tampered.json');
    await writeFile(tamperedStoreFile, JSON.stringify(tampered), 'utf8');
    await expect(createMissionAuthorityService({
      storeFile: tamperedStoreFile,
      getMission: () => undefined,
      saveMission: async () => undefined,
      listWorkerLeases: () => [],
      isSessionActive: () => false,
    })).rejects.toThrow(/malformed records/);

    // Service-level unit checks for local-active, retain-quarantine, and mark-cancelled.
    const cleanStore = path.join(root, 'clean.json');
    const at = '2026-11-28T12:00:00.000Z';
    const makeRun = (state: HostMissionRun['state']): HostMissionRun => ({
      id: randomUUID(),
      sessionId: 's_local',
      workspaceId: randomUUID(),
      title: 'Unit Mission',
      state,
      createdAt: at,
      updatedAt: at,
      transient: false,
      recovery: { source: 'execution-uncertain', at },
      tasks: [
        {
          id: 'step',
          taskId: randomUUID(),
          agentId: randomUUID(),
          title: 'Step',
          connectionId: 'c1',
          model: 'm1',
          state: 'running',
          evidenceIds: [],
        },
      ],
    });
    const runQuarantine = makeRun('recovering');
    const runCancel = makeRun('recovering');
    const runs = new Map<string, HostMissionRun>([
      [runQuarantine.id, runQuarantine],
      [runCancel.id, runCancel],
    ]);
    let active = true;
    const service = await createMissionAuthorityService({
      storeFile: cleanStore,
      getMission: (s, m) => {
        const found = runs.get(m);
        return found && found.sessionId === s ? structuredClone(found) : undefined;
      },
      saveMission: async next => {
        runs.set(next.id, structuredClone(next));
      },
      listWorkerLeases: () => [],
      isSessionActive: () => active,
      now: () => '2026-11-28T12:01:00.000Z',
    });

    const previewQ = await service.previewReconciliation('s_local', runQuarantine.id);
    const activeReject = await service.commitReconciliation({
      sessionId: 's_local',
      missionId: runQuarantine.id,
      expectedReviewDigest: previewQ.reviewDigest,
      decisionKey: 'k-q',
      decision: 'retain-quarantine',
      actor: 'operator',
      reason: 'Check active block',
    });
    expect(activeReject).toMatchObject({ ok: false, code: 'local-active' });

    active = false;
    const retained = await service.commitReconciliation({
      sessionId: 's_local',
      missionId: runQuarantine.id,
      expectedReviewDigest: previewQ.reviewDigest,
      decisionKey: 'k-q',
      decision: 'retain-quarantine',
      actor: 'operator',
      reason: 'Keep quarantined for manual inspection',
    });
    expect(retained).toMatchObject({
      ok: true,
      idempotentReplay: false,
      receipt: { decision: 'retain-quarantine', previousState: 'recovering', resultingState: 'recovering' },
      run: { state: 'recovering' },
    });

    const previewC = await service.previewReconciliation('s_local', runCancel.id);
    const cancelled = await service.commitReconciliation({
      sessionId: 's_local',
      missionId: runCancel.id,
      expectedReviewDigest: previewC.reviewDigest,
      decisionKey: 'k-c',
      decision: 'mark-cancelled',
      actor: 'operator',
      reason: 'Operator cancelled recovering mission',
    });
    expect(cancelled).toMatchObject({
      ok: true,
      idempotentReplay: false,
      receipt: { decision: 'mark-cancelled', previousState: 'recovering', resultingState: 'cancelled' },
      run: { state: 'cancelled', tasks: [{ state: 'cancelled' }] },
    });
  });
});
