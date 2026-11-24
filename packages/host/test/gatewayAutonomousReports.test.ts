import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AutonomousReportService,
  GatewayOutboxService,
  GatewayStore,
  selectAutonomousReportTarget,
  shouldSuppressExternalReportFanout,
  type AutonomousReportChatCandidate,
} from '../src/gateway/index.js';

const T0 = '2026-11-24T10:00:00.000Z';
const T1 = '2026-11-24T10:05:00.000Z';
const T2 = '2026-11-24T10:10:00.000Z';
const T3 = '2026-11-24T10:15:00.000Z';

const tempDirs: string[] = [];

function createTempDbPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'extalia-gw-reports-'));
  tempDirs.push(dir);
  return path.join(dir, 'state', 'gateway.sqlite');
}

function makeChat(overrides: Partial<AutonomousReportChatCandidate> = {}): AutonomousReportChatCandidate {
  return {
    chatId: 'chat-a1',
    workspaceId: 'ws-a',
    audienceScopeId: 'aud-user-1',
    historyEnabled: true,
    supportsSystemReportCards: true,
    lastForegroundActiveAt: T1,
    ...overrides,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Gateway M0 Autonomous Reports (GW-AT-078..097)', () => {
  it('GW-AT-078 & GW-AT-079: commits Knowledge saved+indexed as completed and saved+unindexed as partial with immutable revisions', async () => {
    const store = await GatewayStore.open(createTempDbPath());
    try {
      const reports = new AutonomousReportService(store);
      const candidates = [
        makeChat({ chatId: 'chat-a1', lastForegroundActiveAt: T0 }),
        makeChat({ chatId: 'chat-a2', lastForegroundActiveAt: T2 }),
      ];

      // GW-AT-078: Knowledge saved and indexed -> exactly one durable report in last eligible same-workspace Chat.
      const savedIndexed = reports.commitReport({
        source: 'knowledge-build',
        sourceJobId: 'job-kb-1',
        workspaceId: 'ws-a',
        audienceScopeId: 'aud-user-1',
        knowledge: {
          state: 'saved',
          indexed: true,
          artifactReceiptIds: ['rcpt-note-1'],
        },
        candidates,
        now: T2,
      });
      expect(savedIndexed.report.outcome).toBe('completed');
      expect(savedIndexed.report.targetChatId).toBe('chat-a2');
      expect(savedIndexed.report.targetSelection).toBe('last-eligible');
      expect(savedIndexed.projection.readOnlySystemCard).toBe(true);
      expect(savedIndexed.projection.excludeFromModelHistory).toBe(true);
      expect(savedIndexed.projection.excludeFromLearning).toBe(true);
      expect(savedIndexed.triggeredPromptSubmitted).toBe(false);
      expect(savedIndexed.triggeredLearning).toBe(false);

      // GW-AT-079: Knowledge saved but index failed -> `partial` with separate saved/indexed truth,
      // then settles to `completed` as revision 2 without losing prior receipt.
      const partial = reports.commitReport({
        source: 'learning',
        sourceJobId: 'job-lrn-2',
        workspaceId: 'ws-a',
        audienceScopeId: 'aud-user-1',
        knowledge: {
          state: 'saved',
          indexed: false,
          artifactReceiptIds: ['rcpt-note-2a'],
        },
        problems: ['index-refresh-failed'],
        candidates,
        now: T2,
      });
      expect(partial.report.outcome).toBe('partial');
      expect(partial.report.knowledge?.state).toBe('saved');
      expect(partial.report.knowledge?.indexed).toBe(false);

      const settled = reports.commitReport({
        source: 'learning',
        sourceJobId: 'job-lrn-2',
        workspaceId: 'ws-a',
        audienceScopeId: 'aud-user-1',
        knowledge: {
          state: 'saved',
          indexed: true,
          artifactReceiptIds: ['rcpt-note-2b'],
        },
        candidates,
        now: T3,
      });
      expect(settled.revised).toBe(true);
      expect(settled.report.id).toBe(partial.report.id);
      expect(settled.report.revision).toBe(2);
      expect(settled.report.outcome).toBe('completed');
      expect(settled.report.knowledge?.artifactReceiptIds).toEqual(['rcpt-note-2a', 'rcpt-note-2b']);
      expect(reports.listReportRevisions(partial.report.id)).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it('GW-AT-080, GW-AT-081 & GW-AT-082: enforces activationPerformed=false on skill candidates, honest scan failures, and no-op digest suppression', async () => {
    const store = await GatewayStore.open(createTempDbPath());
    try {
      const reports = new AutonomousReportService(store);
      const candidates = [makeChat()];

      // GW-AT-080: Skill candidate created -> activationPerformed must be false.
      const candidateRes = reports.commitReport({
        source: 'skills',
        sourceJobId: 'job-sk-1',
        workspaceId: 'ws-a',
        audienceScopeId: 'aud-user-1',
        skills: [
          {
            packageId: 'pkg-deploy-check',
            revisionId: 'rev-1',
            state: 'review-required',
            activationPerformed: false,
          },
        ],
        candidates,
        now: T1,
      });
      expect(candidateRes.report.skills?.[0]?.activationPerformed).toBe(false);
      expect(candidateRes.report.skills?.[0]?.state).toBe('review-required');

      // Attempting to claim activationPerformed=true on a candidate fails closed.
      expect(() =>
        reports.commitReport({
          source: 'skills',
          sourceJobId: 'job-sk-illegal',
          workspaceId: 'ws-a',
          audienceScopeId: 'aud-user-1',
          skills: [
            {
              packageId: 'pkg-bad',
              revisionId: 'rev-1',
              state: 'candidate-saved',
              activationPerformed: true,
            },
          ],
          candidates,
          now: T1,
        }),
      ).toThrow();

      // GW-AT-081: Skill scan failed -> never active or verified.
      const scanFailed = reports.commitReport({
        source: 'skills',
        sourceJobId: 'job-sk-fail',
        workspaceId: 'ws-a',
        audienceScopeId: 'aud-user-1',
        skills: [
          {
            packageId: 'pkg-flagged',
            revisionId: 'rev-2',
            state: 'failed',
            activationPerformed: false,
          },
        ],
        problems: ['scanner-rejected'],
        candidates,
        now: T1,
      });
      expect(scanFailed.report.outcome).toBe('failed');
      expect(scanFailed.report.skills?.[0]?.activationPerformed).toBe(false);

      // GW-AT-082: Curator no-op retained in ledger, externally suppressed under digest policy.
      const noOp = reports.commitReport({
        source: 'learning',
        sourceJobId: 'job-noop-1',
        workspaceId: 'ws-a',
        audienceScopeId: 'aud-user-1',
        knowledge: { state: 'unchanged' },
        candidates,
        now: T1,
      });
      expect(noOp.report.outcome).toBe('skipped');
      expect(reports.getReport(noOp.report.id)).toBeDefined();
      expect(shouldSuppressExternalReportFanout(noOp.report, 'digest')).toBe(true);
      expect(shouldSuppressExternalReportFanout(noOp.report, 'immediate')).toBe(false);
    } finally {
      store.close();
    }
  });

  it('GW-AT-083..086: isolates Workspace A from newer Workspace B chat, excludes private/observed/deleted/history-off chats, and falls back to Reports Inbox', () => {
    // GW-AT-083: Workspace B chat is newer than Workspace A chat, yet A report MUST stay in A.
    const wsIsolation = selectAutonomousReportTarget({
      workspaceId: 'ws-a',
      audienceScopeId: 'aud-user-1',
      candidates: [
        makeChat({ chatId: 'chat-a1', workspaceId: 'ws-a', lastForegroundActiveAt: T1 }),
        makeChat({ chatId: 'chat-b-newer', workspaceId: 'ws-b', lastForegroundActiveAt: T3 }),
      ],
    });
    expect(wsIsolation.targetChatId).toBe('chat-a1');
    expect(wsIsolation.targetSelection).toBe('last-eligible');
    expect(wsIsolation.selectionReceipt.rejected).toContainEqual({
      chatId: 'chat-b-newer',
      reason: 'wrong-workspace',
    });

    // GW-AT-084: Private chat owned by another user in shared workspace is skipped.
    const sharedWs = selectAutonomousReportTarget({
      workspaceId: 'ws-shared',
      audienceScopeId: 'aud-user-1',
      candidates: [
        makeChat({
          chatId: 'chat-private-other',
          workspaceId: 'ws-shared',
          audienceScopeId: 'aud-user-2',
          isPrivateToOtherUser: true,
          lastForegroundActiveAt: T3,
        }),
        makeChat({
          chatId: 'chat-team-ok',
          workspaceId: 'ws-shared',
          audienceScopeId: 'aud-team',
          authorizedAudienceScopeIds: ['aud-user-1', 'aud-user-2'],
          lastForegroundActiveAt: T1,
        }),
      ],
    });
    expect(sharedWs.targetChatId).toBe('chat-team-ok');

    // GW-AT-085 & GW-AT-086: Observed immutable transcript, deleted, or history-off -> Reports Inbox fallback.
    const inboxFallback = selectAutonomousReportTarget({
      workspaceId: 'ws-a',
      audienceScopeId: 'aud-user-1',
      candidates: [
        makeChat({ chatId: 'chat-obs', observedImmutableTranscript: true, lastForegroundActiveAt: T3 }),
        makeChat({ chatId: 'chat-del', deleted: true, lastForegroundActiveAt: T2 }),
        makeChat({ chatId: 'chat-nohist', historyEnabled: false, lastForegroundActiveAt: T2 }),
      ],
    });
    expect(inboxFallback.targetChatId).toBeUndefined();
    expect(inboxFallback.targetSelection).toBe('inbox');
    expect(inboxFallback.selectionReceipt.rejected.map(r => r.reason)).toEqual([
      'observed-immutable-transcript',
      'deleted',
      'history-disabled',
    ]);

    // Pinned eligible chat takes precedence over newer eligible chat; system timestamps never affect order.
    const pinnedRes = selectAutonomousReportTarget({
      workspaceId: 'ws-a',
      audienceScopeId: 'aud-user-1',
      pinnedChatId: 'chat-a-pinned',
      candidates: [
        makeChat({ chatId: 'chat-a-pinned', lastForegroundActiveAt: T0 }),
        makeChat({ chatId: 'chat-a-newer', lastForegroundActiveAt: T3, lastSystemEventAt: T3 }),
      ],
    });
    expect(pinnedRes.targetChatId).toBe('chat-a-pinned');
    expect(pinnedRes.targetSelection).toBe('pinned');
  });

  it('GW-AT-087, GW-AT-088, GW-AT-089 & GW-AT-096: pins target at commit, deduplicates maintenanceIntentKey, and ignores out-of-order lower revisions', async () => {
    const store = await GatewayStore.open(createTempDbPath());
    try {
      const reports = new AutonomousReportService(store);
      const initial = reports.commitReport({
        source: 'learning',
        sourceJobId: 'job-post-task-1',
        workspaceId: 'ws-a',
        vaultProfileRevision: 'vrev-1',
        audienceScopeId: 'aud-user-1',
        knowledge: { state: 'saved', indexed: true, artifactReceiptIds: ['rcpt-100'] },
        maintenanceSourceReceiptDigest: 'digest-same-evidence-1',
        maintenanceKind: 'knowledge-curation',
        candidates: [makeChat({ chatId: 'chat-a1', lastForegroundActiveAt: T1 })],
        now: T1,
      });
      expect(initial.report.targetChatId).toBe('chat-a1');

      // GW-AT-087 & GW-AT-089: Periodic maintenance overlaps same evidence after a newer chat-a9 is created.
      // Must deduplicate by maintenanceIntentKey AND keep original pinned chat-a1 (never migrate!).
      const overlappingMaintenance = reports.commitReport({
        source: 'scheduled-maintenance',
        sourceJobId: 'job-periodic-99',
        workspaceId: 'ws-a',
        vaultProfileRevision: 'vrev-1',
        audienceScopeId: 'aud-user-1',
        knowledge: { state: 'saved', indexed: true, artifactReceiptIds: ['rcpt-100'] },
        maintenanceSourceReceiptDigest: 'digest-same-evidence-1',
        maintenanceKind: 'knowledge-curation',
        candidates: [
          makeChat({ chatId: 'chat-a1', lastForegroundActiveAt: T1 }),
          makeChat({ chatId: 'chat-a9-newer', lastForegroundActiveAt: T3 }),
        ],
        now: T3,
      });
      expect(overlappingMaintenance.deduplicated).toBe(true);
      expect(overlappingMaintenance.report.id).toBe(initial.report.id);
      expect(overlappingMaintenance.report.targetChatId).toBe('chat-a1');

      // GW-AT-096: Out-of-order lower outcome (`partial`) arriving after `completed` does not regress outcome.
      const stalePartial = reports.commitReport({
        source: 'learning',
        sourceJobId: 'job-post-task-1',
        workspaceId: 'ws-a',
        vaultProfileRevision: 'vrev-1',
        audienceScopeId: 'aud-user-1',
        outcome: 'partial',
        knowledge: { state: 'saved', indexed: true, artifactReceiptIds: ['rcpt-100'] },
        candidates: [makeChat({ chatId: 'chat-a9-newer', lastForegroundActiveAt: T3 })],
        now: T3,
      });
      expect(stalePartial.deduplicated).toBe(true);
      expect(stalePartial.report.outcome).toBe('completed');
      expect(reports.listChatProjections({ workspaceId: 'ws-a', chatId: 'chat-a1' })).toHaveLength(1);
      expect(reports.listChatProjections({ workspaceId: 'ws-a', chatId: 'chat-a9-newer' })).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('GW-AT-093, GW-AT-094 & GW-AT-095: canonical report survives restart and external channel failures/unknown sends remain isolated', async () => {
    const dbPath = createTempDbPath();
    let reportId!: string;
    let discordIntentId!: string;
    let tgIntentId!: string;

    // Phase 1: commit canonical report + enqueue fanout to Discord and Telegram, then close (simulating crash).
    const store1 = await GatewayStore.open(dbPath);
    try {
      store1.upsertConnector({
        id: 'conn-dc',
        provider: 'discord',
        providerAccountId: 'guild-1',
        secretRef: 'keychain://extalia/gw/dc',
        status: 'connected',
        now: T1,
      });
      store1.upsertConnector({
        id: 'conn-tg',
        provider: 'telegram',
        providerAccountId: 'bot-1',
        secretRef: 'keychain://extalia/gw/tg',
        status: 'connected',
        now: T1,
      });

      const reports1 = new AutonomousReportService(store1);
      const outbox1 = new GatewayOutboxService(store1);

      const committed = reports1.commitReport({
        source: 'knowledge-build',
        sourceJobId: 'job-crash-1',
        workspaceId: 'ws-a',
        audienceScopeId: 'aud-user-1',
        knowledge: { state: 'saved', indexed: true, artifactReceiptIds: ['rcpt-survive'] },
        candidates: [makeChat({ chatId: 'chat-a1' })],
        now: T1,
      });
      reportId = committed.report.id;

      discordIntentId = outbox1.enqueue({
        connectorId: 'conn-dc',
        targetBindingId: 'bnd-dc',
        targetBindingRevision: 1,
        reportOrSourceEventId: reportId,
        reportId,
        reportRevision: 1,
        senderKind: 'gateway-system',
        format: 'detailed',
        messageClass: 'system-report',
        rawText: 'Knowledge saved and indexed.',
        now: T1,
      }).intent.id;

      tgIntentId = outbox1.enqueue({
        connectorId: 'conn-tg',
        targetBindingId: 'bnd-tg',
        targetBindingRevision: 1,
        reportOrSourceEventId: reportId,
        reportId,
        reportRevision: 1,
        senderKind: 'gateway-system',
        format: 'milestone',
        messageClass: 'system-report',
        rawText: 'Knowledge saved and indexed.',
        now: T1,
      }).intent.id;

      // Discord succeeds, Telegram gets 403 blocked.
      const dcClaim = outbox1.claimNextReady({ leaseOwner: 'host-1', connectorId: 'conn-dc', now: T1 })!;
      outbox1.recordSendResult({
        kind: 'accepted',
        intentId: dcClaim.intent.id,
        fencingToken: dcClaim.approved.fencingToken,
        leaseOwner: 'host-1',
        providerRequestKey: dcClaim.approved.providerRequestKey,
        remoteMessageId: 'dc-msg-1',
        now: T1,
      });

      const tgClaim = outbox1.claimNextReady({ leaseOwner: 'host-1', connectorId: 'conn-tg', now: T1 })!;
      outbox1.recordSendResult({
        kind: 'permanent-blocked',
        intentId: tgClaim.intent.id,
        fencingToken: tgClaim.approved.fencingToken,
        leaseOwner: 'host-1',
        providerRequestKey: tgClaim.approved.providerRequestKey,
        httpStatus: 403,
        errorMessage: 'Telegram bot blocked by user',
        now: T1,
      });
    } finally {
      store1.close();
    }

    // Phase 2: reopen after restart; verify canonical report, Chat projection, and isolated channel states survive intact.
    const store2 = await GatewayStore.open(dbPath);
    try {
      const reports2 = new AutonomousReportService(store2);
      const outbox2 = new GatewayOutboxService(store2);

      const persistedReport = reports2.getReport(reportId);
      expect(persistedReport?.outcome).toBe('completed');
      expect(persistedReport?.targetChatId).toBe('chat-a1');
      expect(reports2.listChatProjections({ workspaceId: 'ws-a', chatId: 'chat-a1' })).toHaveLength(1);

      expect(outbox2.getIntent(discordIntentId)?.state).toBe('accepted');
      expect(outbox2.getIntent(tgIntentId)?.state).toBe('blocked');
    } finally {
      store2.close();
    }
  });
});
