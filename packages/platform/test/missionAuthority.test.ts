import { describe, expect, it } from 'vitest';
import {
  AGENT_HOST_METHODS,
  MISSION_AUTHORITY_HOST_METHODS,
  computeMissionReviewDigest,
  deriveEvidenceAcceptance,
  evaluateMissionTaskGates,
  normalizeGrantMissionWaiverInput,
  normalizeMissionReconciliationCommitInput,
  normalizeRecordMissionEvidenceInput,
  requiredBridgeScopeForMethod,
  type HostMissionRun,
  type MissionEvidenceRecord,
  type MissionWaiverRecord,
} from '../src/index.js';

function makeRun(): HostMissionRun {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    sessionId: 's_test',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    title: 'Verification Gate Mission',
    state: 'completed',
    createdAt: '2026-11-28T10:00:00.000Z',
    updatedAt: '2026-11-28T10:05:00.000Z',
    transient: false,
    tasks: [
      {
        id: 'build',
        taskId: '33333333-3333-4333-8333-333333333333',
        agentId: '44444444-4444-4444-8444-444444444444',
        title: 'Build artifacts',
        connectionId: 'conn-1',
        model: 'mock-model',
        state: 'completed',
        verification: 'unverified',
        evidenceIds: [],
      },
      {
        id: 'deploy',
        taskId: '55555555-5555-4555-8555-555555555555',
        agentId: '66666666-6666-4666-8666-666666666666',
        title: 'Prepare release',
        dependsOn: ['build'],
        connectionId: 'conn-1',
        model: 'mock-model',
        state: 'completed',
        verification: 'unverified',
        evidenceIds: [],
      },
    ],
  };
}

describe('Mission authority platform contracts and gates (V2-04 / V2-06)', () => {
  it('registers mission authority RPC methods and enforces fail-closed Bridge scopes', () => {
    for (const method of MISSION_AUTHORITY_HOST_METHODS) {
      expect(AGENT_HOST_METHODS).toContain(method);
    }
    expect(requiredBridgeScopeForMethod('previewMissionReconciliation')).toBe('read');
    expect(requiredBridgeScopeForMethod('missionAuthorityOverview')).toBe('read');
    expect(requiredBridgeScopeForMethod('commitMissionReconciliation')).toBe('approvals');
    expect(requiredBridgeScopeForMethod('grantMissionWaiver')).toBe('approvals');
    expect(requiredBridgeScopeForMethod('revokeMissionWaiver')).toBe('approvals');
    expect(requiredBridgeScopeForMethod('recordMissionEvidence')).toBe('admin');
  });

  it('computes deterministic order-independent review digests (AR-07)', () => {
    const a = computeMissionReviewDigest({
      missionId: 'm1',
      sessionId: 's1',
      workspaceId: 'w1',
      state: 'recovering',
      updatedAt: '2026-11-28T10:00:00.000Z',
      recoverySource: 'host-restart',
      tasks: [
        { taskId: 't2', state: 'unknown' },
        { taskId: 't1', state: 'completed', verification: 'unverified' },
      ],
      activeLeaseIds: ['wl-b', 'wl-a'],
      quarantinedLeaseIds: ['wl-q'],
      evidenceDigests: ['ev-2', 'ev-1'],
      waiverIds: ['wv-2', 'wv-1'],
    });
    const b = computeMissionReviewDigest({
      missionId: 'm1',
      sessionId: 's1',
      workspaceId: 'w1',
      state: 'recovering',
      updatedAt: '2026-11-28T10:00:00.000Z',
      recoverySource: 'host-restart',
      tasks: [
        { taskId: 't1', state: 'completed', verification: 'unverified' },
        { taskId: 't2', state: 'unknown' },
      ],
      activeLeaseIds: ['wl-a', 'wl-b'],
      quarantinedLeaseIds: ['wl-q'],
      evidenceDigests: ['ev-1', 'ev-2'],
      waiverIds: ['wv-1', 'wv-2'],
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps observed claims unverified and blocks downstream dependency release until verified or waived (AR-12, AR-13)', () => {
    expect(deriveEvidenceAcceptance('observed-claim', 'passed')).toEqual({
      verifiedByHost: false,
      acceptance: 'unverified',
    });
    expect(deriveEvidenceAcceptance('test-report', 'passed')).toEqual({
      verifiedByHost: true,
      acceptance: 'accepted',
    });
    expect(deriveEvidenceAcceptance('command-gate', 'failed')).toEqual({
      verifiedByHost: true,
      acceptance: 'rejected',
    });

    const run = makeRun();
    const observedOnly: MissionEvidenceRecord[] = [
      {
        evidenceId: 'ev-obs',
        missionId: run.id,
        sessionId: run.sessionId,
        workspaceId: run.workspaceId,
        taskId: run.tasks[0]!.taskId,
        sourceKind: 'observed-claim',
        validation: 'passed',
        acceptance: 'unverified',
        contentSha256: 'a'.repeat(64),
        summary: 'Model claimed build passed.',
        recordedAt: '2026-11-28T10:02:00.000Z',
        verifiedByHost: false,
      },
    ];

    const blocked = evaluateMissionTaskGates(run, observedOnly, [], Date.parse('2026-11-28T10:10:00.000Z'));
    expect(blocked.verifiedComplete).toBe(false);
    expect(blocked.taskGates[0]?.acceptance).toBe('unverified');
    expect(blocked.taskGates[0]?.legacyUnverified).toBe(true);
    expect(blocked.taskGates[1]?.dependencyReleaseEligible).toBe(false);
    expect(blocked.taskGates[1]?.dependencyBlockedBy).toEqual(['build']);

    // Dependency-release waiver unlocks downstream deploy, without certifying full mission-acceptance.
    const depWaiver: MissionWaiverRecord = {
      waiverId: 'wv-1234567890ab',
      missionId: run.id,
      sessionId: run.sessionId,
      workspaceId: run.workspaceId,
      taskId: run.tasks[0]!.taskId,
      actor: 'operator',
      reason: 'Reviewed manual build output',
      policyVersion: 'v1',
      scope: 'dependency-release',
      reviewDigest: 'b'.repeat(64),
      grantedAt: '2026-11-28T10:06:00.000Z',
      expiresAt: '2026-11-28T11:06:00.000Z',
    };
    const unlockedByWaiver = evaluateMissionTaskGates(run, observedOnly, [depWaiver], Date.parse('2026-11-28T10:10:00.000Z'));
    expect(unlockedByWaiver.taskGates[0]?.acceptance).toBe('waived');
    expect(unlockedByWaiver.taskGates[1]?.dependencyReleaseEligible).toBe(true);
    expect(unlockedByWaiver.verifiedComplete).toBe(false);

    // Verified passing evidence for both tasks establishes verifiedComplete.
    const verifiedEvidence: MissionEvidenceRecord[] = [
      {
        evidenceId: 'ev-1',
        missionId: run.id,
        sessionId: run.sessionId,
        workspaceId: run.workspaceId,
        taskId: run.tasks[0]!.taskId,
        sourceKind: 'test-report',
        validation: 'passed',
        acceptance: 'accepted',
        contentSha256: 'c'.repeat(64),
        artifactPath: 'reports/build.json',
        summary: 'Unit suite passed.',
        recordedAt: '2026-11-28T10:07:00.000Z',
        verifiedByHost: true,
      },
      {
        evidenceId: 'ev-2',
        missionId: run.id,
        sessionId: run.sessionId,
        workspaceId: run.workspaceId,
        taskId: run.tasks[1]!.taskId,
        sourceKind: 'command-gate',
        validation: 'passed',
        acceptance: 'accepted',
        contentSha256: 'd'.repeat(64),
        summary: 'Package verification passed.',
        recordedAt: '2026-11-28T10:08:00.000Z',
        verifiedByHost: true,
      },
    ];
    const verified = evaluateMissionTaskGates(run, verifiedEvidence, [], Date.parse('2026-11-28T10:10:00.000Z'));
    expect(verified.verifiedComplete).toBe(true);
    expect(verified.taskGates.every(g => g.acceptance === 'accepted' && !g.legacyUnverified)).toBe(true);
  });

  it('rejects malformed digests, traversal artifact paths, and invalid waiver TTLs', () => {
    expect(() => normalizeMissionReconciliationCommitInput({
      sessionId: 's',
      missionId: 'm',
      expectedReviewDigest: 'bad-digest',
      decisionKey: 'k1',
      decision: 'mark-failed',
      actor: 'op',
      reason: 'Timed out',
    })).toThrow();

    expect(() => normalizeRecordMissionEvidenceInput({
      sessionId: 's',
      missionId: 'm',
      taskId: 't',
      sourceKind: 'test-report',
      validation: 'passed',
      contentSha256: 'a'.repeat(64),
      artifactPath: '../secret.txt',
      summary: 'bad path',
    })).toThrow();

    expect(() => normalizeGrantMissionWaiverInput({
      sessionId: 's',
      missionId: 'm',
      taskId: 't',
      expectedReviewDigest: 'a'.repeat(64),
      actor: 'op',
      reason: 'waive',
      policyVersion: 'v1',
      scope: 'dependency-release',
      ttlMs: 1000,
    })).toThrow();
  });
});
