import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentPortraitIdentity,
  GatewayProjectEvent,
  GatewayProvider,
  LearningScheduleJob,
  ScheduleRunV1,
} from '@extalia/platform';
import {
  AutonomousReportService,
  GatewayOutboxService,
  GatewayRoutingService,
  GatewayStore,
  type AutonomousReportChatCandidate,
} from '../src/gateway/index.js';
import {
  evaluateWhatsAppCompliance,
  GatewayFanoutService,
  isWithinQuietHours,
  type FanoutDestinationTarget,
  type FanoutProviderSender,
} from '../src/gateway/fanout.js';

const T0 = '2026-11-24T10:00:00.000Z';
const T1 = '2026-11-24T10:05:00.000Z';
const T2 = '2026-11-24T10:15:00.000Z';
const T_NIGHT_NY = '2026-11-24T04:00:00.000Z'; // 23:00 America/New_York (quiet hours)

const tempDirs: string[] = [];

function createTempDbPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'extalia-gw-fanout-'));
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

function makeScheduleRun(overrides: Partial<ScheduleRunV1> = {}): ScheduleRunV1 {
  return {
    id: 'run-sch-1',
    revision: 2,
    scheduleId: 'sch-daily-check',
    scheduleRevision: 1,
    occurrenceKey: 'occ-2026-11-24-1000',
    occurrenceKind: 'automatic',
    scheduledFor: T0,
    workspaceId: 'ws-a',
    sessionId: 'chat-a1',
    state: 'completed',
    admittedAt: T0,
    settledAt: T1,
    verification: 'not-checked',
    attemptCount: 1,
    createdAt: T0,
    updatedAt: T1,
    ...overrides,
  };
}

function setupConnectors(store: GatewayStore): void {
  store.upsertConnector({
    id: 'conn-discord',
    provider: 'discord',
    providerAccountId: 'disc-bot-1',
    secretRef: 'keychain:discord-bot',
    status: 'connected',
    now: T0,
  });
  store.upsertConnector({
    id: 'conn-telegram',
    provider: 'telegram',
    providerAccountId: 'tg-bot-1',
    secretRef: 'keychain:telegram-bot',
    status: 'connected',
    now: T0,
  });
  store.upsertConnector({
    id: 'conn-whatsapp',
    provider: 'whatsapp',
    providerAccountId: 'waba-1',
    secretRef: 'keychain:whatsapp-token',
    status: 'connected',
    now: T0,
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Gateway M3 Unified Schedule & Autonomous Multi-Surface Fanout (SCH-GW-AT-01..12)', () => {
  it('SCH-GW-AT-01, SCH-GW-AT-03, SCH-GW-AT-04, SCH-GW-AT-11: scopes Chat report strictly to source workspace, never triggers feedback loops, preserves observed transcripts, and pins destination', async () => {
    const store = await GatewayStore.open(createTempDbPath());
    try {
      setupConnectors(store);
      const reports = new AutonomousReportService(store);
      const outbox = new GatewayOutboxService(store);
      const fanout = new GatewayFanoutService({ store, reports, outbox });

      const candidates: AutonomousReportChatCandidate[] = [
        // Workspace B chat is globally newer -> must NEVER receive Workspace A report (SCH-GW-AT-01).
        makeChat({ chatId: 'chat-b-newest', workspaceId: 'ws-b', lastForegroundActiveAt: T2 }),
        // Observed external transcript in Workspace A -> must remain untouched (SCH-GW-AT-04).
        makeChat({ chatId: 'chat-a-observed', workspaceId: 'ws-a', observedImmutableTranscript: true, lastForegroundActiveAt: T2 }),
        // Eligible retained chat in Workspace A.
        makeChat({ chatId: 'chat-a1', workspaceId: 'ws-a', lastForegroundActiveAt: T1 }),
      ];

      const targets: FanoutDestinationTarget[] = [
        {
          connectorId: 'conn-discord',
          provider: 'discord',
          bindingId: 'bnd-ws-b',
          bindingRevision: 1,
          workspaceId: 'ws-b', // Cross-workspace target must be refused!
          audienceScopeId: 'aud-user-1',
          authorized: true,
          subscriptionMode: 'immediate',
        },
        {
          connectorId: 'conn-discord',
          provider: 'discord',
          bindingId: 'bnd-ws-a',
          bindingRevision: 1,
          workspaceId: 'ws-a',
          audienceScopeId: 'aud-user-1',
          authorized: true,
          subscriptionMode: 'immediate',
        },
      ];

      const res = fanout.fanoutAutonomousReport({
        source: 'knowledge-build',
        sourceJobId: 'kb-ws-a-1',
        workspaceId: 'ws-a',
        audienceScopeId: 'aud-user-1',
        knowledge: { state: 'saved', indexed: true, artifactReceiptIds: ['note-a1'] },
        candidates,
        targets,
        now: T2,
      });

      // SCH-GW-AT-01 & SCH-GW-AT-04: landed in eligible Workspace A chat, never B or observed.
      expect(res.report.targetChatId).toBe('chat-a1');
      expect(res.report.targetSelection).toBe('last-eligible');
      expect(res.projection.readOnlySystemCard).toBe(true);
      expect(res.projection.excludeFromModelHistory).toBe(true);
      expect(res.projection.excludeFromLearning).toBe(true);

      // SCH-GW-AT-03: Zero feedback loops.
      expect(res.triggeredPromptSubmitted).toBe(false);
      expect(res.triggeredLearning).toBe(false);

      // Cross-workspace external binding refused; authorized same-workspace binding enqueued.
      expect(res.destinations[0]?.status).toBe('cross_workspace_refused');
      expect(res.destinations[1]?.status).toBe('enqueued');

      // SCH-GW-AT-11: New chat opened later in Workspace A does NOT retarget already-committed report.
      const revised = fanout.fanoutAutonomousReport({
        source: 'knowledge-build',
        sourceJobId: 'kb-ws-a-1',
        workspaceId: 'ws-a',
        audienceScopeId: 'aud-user-1',
        knowledge: { state: 'saved', indexed: true, artifactReceiptIds: ['note-a1', 'note-a2'] },
        candidates: [
          ...candidates,
          makeChat({ chatId: 'chat-a-newer', workspaceId: 'ws-a', lastForegroundActiveAt: '2026-11-24T11:00:00.000Z' }),
        ],
        targets: [targets[1]!],
        now: '2026-11-24T11:01:00.000Z',
      });
      expect(revised.revised).toBe(true);
      expect(revised.report.targetChatId).toBe('chat-a1');
    } finally {
      store.close();
    }
  });

  it('SCH-GW-AT-02, SCH-GW-AT-05, SCH-GW-AT-12: represents Skill candidates truthfully, deduplicates overlapping maintenance windows, and preserves partial failures', async () => {
    const store = await GatewayStore.open(createTempDbPath());
    try {
      setupConnectors(store);
      const reports = new AutonomousReportService(store);
      const outbox = new GatewayOutboxService(store);
      const fanout = new GatewayFanoutService({ store, reports, outbox });

      const learningJob: LearningScheduleJob = {
        id: 'lrn-job-42',
        workspaceId: 'ws-a',
        profileId: 'prof-1',
        profileName: 'Default Vault',
        sessionId: 'chat-a1',
        kind: 'learning',
        state: 'partial',
        dueAt: T0,
        createdAt: T0,
        result: {
          knowledge: { status: 'saved', path: 'notes/arch.md', indexed: false },
          skill: {
            id: 'sk-notice-1',
            profileId: 'prof-1',
            workspaceId: 'ws-a',
            sessionId: 'chat-a1',
            runId: 'run-42',
            createdAt: T1,
            kind: 'skill-candidate',
            packageId: 'pkg-deploy-check',
            revisionId: 'rev-3',
            state: 'review-required',
            change: 'new',
            activationPerformed: false,
            partial: true,
          },
        },
      };

      const targets: FanoutDestinationTarget[] = [
        {
          connectorId: 'conn-discord',
          provider: 'discord',
          bindingId: 'bnd-disc-1',
          bindingRevision: 1,
          workspaceId: 'ws-a',
          audienceScopeId: 'aud-user-1',
          authorized: true,
          subscriptionMode: 'immediate',
        },
        {
          connectorId: 'conn-telegram',
          provider: 'telegram',
          bindingId: 'bnd-tg-1',
          bindingRevision: 1,
          workspaceId: 'ws-a',
          audienceScopeId: 'aud-user-1',
          authorized: true,
          subscriptionMode: 'immediate',
        },
      ];

      // SCH-GW-AT-02 & SCH-GW-AT-12: Saved-but-unindexed knowledge + unactivated skill candidate -> partial.
      const first = fanout.fanoutAutonomousReport({
        source: 'learning',
        sourceJobId: learningJob.id,
        workspaceId: 'ws-a',
        vaultProfileRevision: 'vrev-1',
        audienceScopeId: 'aud-user-1',
        learningJob,
        maintenanceSourceReceiptDigest: 'digest-ev-window-99',
        maintenanceKind: 'knowledge-curation',
        candidates: [makeChat()],
        targets,
        now: T1,
      });

      expect(first.report.outcome).toBe('partial');
      expect(first.report.knowledge?.state).toBe('saved');
      expect(first.report.knowledge?.indexed).toBe(false);
      expect(first.report.skills?.[0]?.activationPerformed).toBe(false);

      const discIntent = outbox.getIntent(first.destinations[0]!.intentId!);
      const tgIntent = outbox.getIntent(first.destinations[1]!.intentId!);
      expect(discIntent?.senderKind).toBe('gateway-system');
      expect(discIntent?.format).toBe('detailed');
      expect(tgIntent?.senderKind).toBe('gateway-system');
      expect(tgIntent?.format).toBe('milestone');

      const discClaim = outbox.claimNextReady({ leaseOwner: 'host-1', connectorId: 'conn-discord', now: T1 });
      expect(discClaim?.approved.safeText).toContain('candidate only');
      expect(discClaim?.approved.safeText).toContain('NOT ACTIVE');

      // SCH-GW-AT-05 & GW-AT-089: Overlapping scheduled maintenance with same evidence digest deduplicates to one report.
      const overlapping = fanout.fanoutAutonomousReport({
        source: 'scheduled-maintenance',
        sourceJobId: 'maint-job-99',
        workspaceId: 'ws-a',
        vaultProfileRevision: 'vrev-1',
        audienceScopeId: 'aud-user-1',
        knowledge: { state: 'saved', indexed: false, artifactReceiptIds: ['note:notes/arch.md'] },
        maintenanceSourceReceiptDigest: 'digest-ev-window-99',
        maintenanceKind: 'knowledge-curation',
        candidates: [makeChat()],
        targets,
        now: T2,
      });

      expect(overlapping.report.id).toBe(first.report.id);
      expect(overlapping.deduplicated).toBe(true);
      expect(reports.listWorkspaceReports('ws-a')).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('SCH-GW-AT-06, SCH-GW-AT-07, SCH-GW-AT-10: fans out one ScheduleRun across Discord/Telegram/WhatsApp with fail-closed WA policy and isolated partial channel failures', async () => {
    const store = await GatewayStore.open(createTempDbPath());
    try {
      setupConnectors(store);
      const reports = new AutonomousReportService(store);
      const outbox = new GatewayOutboxService(store);
      const fanout = new GatewayFanoutService({ store, reports, outbox });

      const run = makeScheduleRun({ state: 'completed', verification: 'not-checked' });

      // 1. SCH-GW-AT-07: WhatsApp window closed & no approved template -> fail-closed policy_blocked.
      const targetsWindowClosed: FanoutDestinationTarget[] = [
        {
          connectorId: 'conn-discord',
          provider: 'discord',
          bindingId: 'bnd-disc-sch',
          bindingRevision: 1,
          workspaceId: 'ws-a',
          audienceScopeId: 'aud-user-1',
          authorized: true,
          subscriptionMode: 'immediate',
        },
        {
          connectorId: 'conn-telegram',
          provider: 'telegram',
          bindingId: 'bnd-tg-sch',
          bindingRevision: 1,
          workspaceId: 'ws-a',
          audienceScopeId: 'aud-user-1',
          authorized: true,
          subscriptionMode: 'immediate',
        },
        {
          connectorId: 'conn-whatsapp',
          provider: 'whatsapp',
          bindingId: 'bnd-wa-sch',
          bindingRevision: 1,
          workspaceId: 'ws-a',
          audienceScopeId: 'aud-user-1',
          authorized: true,
          subscriptionMode: 'immediate',
          recipientId: 'rcpt-wa-1',
          whatsappCompliance: {
            waEnabled: true,
            recipientOptedIn: true,
            serviceWindowOpen: false,
            approvedTemplate: undefined,
          },
        },
      ];

      const fanoutRes = fanout.fanoutScheduleRun({
        run,
        scheduleName: 'Nightly Regression Check',
        audienceScopeId: 'aud-user-1',
        candidates: [makeChat()],
        targets: targetsWindowClosed,
        now: T1,
      });

      // Canonical report committed first with exact schedule-run attribution.
      expect(fanoutRes.report.source).toBe('schedule-run');
      expect(fanoutRes.report.sourceJobId).toBe(run.scheduleId);
      expect(fanoutRes.report.sourceRunId).toBe(run.id);
      expect(fanoutRes.report.outcome).toBe('completed');

      expect(fanoutRes.destinations[0]).toMatchObject({ provider: 'discord', status: 'enqueued', format: 'detailed', senderKind: 'gateway-system' });
      expect(fanoutRes.destinations[1]).toMatchObject({ provider: 'telegram', status: 'enqueued', format: 'milestone', senderKind: 'gateway-system' });
      expect(fanoutRes.destinations[2]).toMatchObject({ provider: 'whatsapp', status: 'policy_blocked', format: 'report', senderKind: 'gateway-system' });
      expect(fanoutRes.destinations[2]?.policyReceiptId).toBeTruthy();

      // SCH-GW-AT-06 & SCH-GW-AT-12: Dispatch where Discord succeeds while Telegram returns 403 blocked.
      const senders = new Map<GatewayProvider, FanoutProviderSender>([
        ['discord', async () => ({ kind: 'accepted', remoteMessageId: 'disc-msg-99', httpStatus: 200 })],
        ['telegram', async () => ({ kind: 'permanent-blocked', httpStatus: 403, errorMessage: 'Forbidden: bot blocked' })],
      ]);

      const dispatched = await fanout.dispatchPendingForTargets({
        targets: targetsWindowClosed,
        senders,
        leaseOwner: 'host-1',
        now: T1,
      });

      expect(dispatched.find(d => d.provider === 'discord')?.outcome).toBe('accepted');
      expect(dispatched.find(d => d.provider === 'telegram')?.outcome).toBe('blocked');

      // Canonical report remains completely intact despite Telegram 403 and WhatsApp policy_blocked!
      const storedReport = reports.getReport(fanoutRes.report.id);
      expect(storedReport?.outcome).toBe('completed');

      // SCH-GW-AT-06: When WhatsApp has explicit waEnabled + opt-in + approved template + budget, all 3 enqueue independently.
      const compliantCheck = evaluateWhatsAppCompliance({
        waEnabled: true,
        recipientOptedIn: true,
        serviceWindowOpen: false,
        approvedTemplate: {
          name: 'extalia_run_report',
          language: 'en_US',
          category: 'utility',
          approved: true,
          expectedLanguage: 'en_US',
          expectedCategory: 'utility',
        },
        estimatedCost: 0.02,
        remainingBudget: 1.0,
      });
      expect(compliantCheck.allowed).toBe(true);

      // Budget exceeded -> fail-closed.
      const overBudget = evaluateWhatsAppCompliance({
        waEnabled: true,
        recipientOptedIn: true,
        serviceWindowOpen: true,
        estimatedCost: 2.5,
        remainingBudget: 1.0,
      });
      expect(overBudget.allowed).toBe(false);

      // SCH-GW-AT-10: All external providers down / zero targets -> canonical Chat report still persists cleanly.
      const offlineRun = makeScheduleRun({ id: 'run-offline-1', scheduleId: 'sch-offline', state: 'completed' });
      const offlineRes = fanout.fanoutScheduleRun({
        run: offlineRun,
        audienceScopeId: 'aud-user-1',
        candidates: [makeChat()],
        targets: [],
        now: T2,
      });
      expect(offlineRes.report.outcome).toBe('completed');
      expect(reports.getReport(offlineRes.report.id)?.targetChatId).toBe('chat-a1');
    } finally {
      store.close();
    }
  });

  it('SCH-GW-AT-08 & SCH-GW-AT-09: keeps Gateway Bot system reports strictly distinct from worker portrait snapshots and routes worker replies via Lead', async () => {
    const store = await GatewayStore.open(createTempDbPath());
    try {
      setupConnectors(store);
      const reports = new AutonomousReportService(store);
      const outbox = new GatewayOutboxService(store);
      const routing = new GatewayRoutingService(store);
      const fanout = new GatewayFanoutService({ store, reports, outbox });

      const portrait: AgentPortraitIdentity = {
        workspaceId: 'ws-a',
        sessionId: 'sess-a1',
        agentId: 'worker-qa',
        kind: 'worker',
        name: 'QA Runner',
        role: 'Verification Engineer',
        provenance: 'host-team-roster',
      };

      const workerEvent: GatewayProjectEvent = {
        sourceEventId: 'evt-worker-1',
        workspaceId: 'ws-a',
        sessionId: 'sess-a1',
        agentId: 'worker-qa',
        taskId: 'task-qa-7',
        category: 'worker-activity',
        provenance: 'host-receipt',
        verification: 'verified',
        safeText: 'Integration suite passed (14/14).',
        at: T1,
      };

      const targets: FanoutDestinationTarget[] = [
        {
          connectorId: 'conn-discord',
          provider: 'discord',
          bindingId: 'bnd-disc-worker',
          bindingRevision: 1,
          workspaceId: 'ws-a',
          audienceScopeId: 'aud-user-1',
          authorized: true,
          subscriptionMode: 'immediate',
        },
        {
          connectorId: 'conn-telegram',
          provider: 'telegram',
          bindingId: 'bnd-tg-worker',
          bindingRevision: 1,
          workspaceId: 'ws-a',
          audienceScopeId: 'aud-user-1',
          authorized: true,
          subscriptionMode: 'immediate',
        },
        {
          connectorId: 'conn-whatsapp',
          provider: 'whatsapp',
          bindingId: 'bnd-wa-worker',
          bindingRevision: 1,
          workspaceId: 'ws-a',
          audienceScopeId: 'aud-user-1',
          authorized: true,
          subscriptionMode: 'immediate',
        },
      ];

      const workerDecisions = fanout.fanoutWorkerEvent({
        event: workerEvent,
        portrait,
        audienceScopeId: 'aud-user-1',
        targets,
        now: T1,
      });

      // Discord uses worker portrait snapshot; Telegram uses single gateway-system bot; WhatsApp suppresses raw worker activity.
      expect(workerDecisions[0]).toMatchObject({ provider: 'discord', status: 'enqueued', senderKind: 'worker', format: 'detailed' });
      expect(workerDecisions[1]).toMatchObject({ provider: 'telegram', status: 'enqueued', senderKind: 'gateway-system', format: 'milestone' });
      expect(workerDecisions[2]).toMatchObject({ provider: 'whatsapp', status: 'suppressed_policy' });

      const discWorkerIntent = outbox.getIntent(workerDecisions[0]!.intentId!);
      expect(discWorkerIntent?.senderPortrait?.agentId).toBe('worker-qa');
      expect(discWorkerIntent?.senderKind).toBe('worker');

      // SCH-GW-AT-09: Discord webhook reply to worker message routes through Lead via stored receipt.
      routing.recordRemoteReceipt({
        provider: 'discord',
        connectorId: 'conn-discord',
        remoteMessageId: 'disc-wh-msg-77',
        providerAccountId: 'disc-bot-1',
        channelId: 'chan-1',
        workspaceId: 'ws-a',
        sessionId: 'sess-a1',
        agentId: 'worker-qa',
        taskId: 'task-qa-7',
        senderSnapshot: { name: 'QA Runner', role: 'Verification Engineer' },
        acceptedAt: T1,
      });

      const resolvedReply = routing.resolveReplyTarget({
        connectorId: 'conn-discord',
        replyToRemoteMessageId: 'disc-wh-msg-77',
        expectedWorkspaceId: 'ws-a',
      });
      expect(resolvedReply.ok).toBe(true);
      if (resolvedReply.ok) {
        expect(resolvedReply.delegateViaLead).toBe(true);
        expect(resolvedReply.receipt.taskId).toBe('task-qa-7');
      }
    } finally {
      store.close();
    }
  });

  it('respects quiet hours in recipient IANA timezone, subscription off, and digest no-op suppression without altering UTC ledger timestamps', async () => {
    const store = await GatewayStore.open(createTempDbPath());
    try {
      setupConnectors(store);
      const reports = new AutonomousReportService(store);
      const outbox = new GatewayOutboxService(store);
      const fanout = new GatewayFanoutService({ store, reports, outbox });

      expect(
        isWithinQuietHours(T_NIGHT_NY, {
          enabled: true,
          startHour: 22,
          endHour: 7,
          timeZone: 'America/New_York',
        }),
      ).toBe(true);
      expect(
        isWithinQuietHours('2026-11-24T15:05:00.000Z', { // 10:05 America/New_York (daytime)
          enabled: true,
          startHour: 22,
          endHour: 7,
          timeZone: 'America/New_York',
        }),
      ).toBe(false);

      const targets: FanoutDestinationTarget[] = [
        {
          connectorId: 'conn-telegram',
          provider: 'telegram',
          bindingId: 'bnd-quiet',
          bindingRevision: 1,
          workspaceId: 'ws-a',
          audienceScopeId: 'aud-user-1',
          authorized: true,
          subscriptionMode: 'immediate',
          quietHours: {
            enabled: true,
            startHour: 22,
            endHour: 7,
            timeZone: 'America/New_York',
            allowUrgentBypass: false,
          },
        },
        {
          connectorId: 'conn-discord',
          provider: 'discord',
          bindingId: 'bnd-digest',
          bindingRevision: 1,
          workspaceId: 'ws-a',
          audienceScopeId: 'aud-user-1',
          authorized: true,
          subscriptionMode: 'digest',
        },
        {
          connectorId: 'conn-discord',
          provider: 'discord',
          bindingId: 'bnd-off',
          bindingRevision: 1,
          workspaceId: 'ws-a',
          audienceScopeId: 'aud-user-1',
          authorized: true,
          subscriptionMode: 'off',
        },
      ];

      // No-op report during NY quiet hours: suppressed externally, UTC ledger still retained.
      const res = fanout.fanoutAutonomousReport({
        source: 'learning',
        sourceJobId: 'lrn-noop-1',
        workspaceId: 'ws-a',
        audienceScopeId: 'aud-user-1',
        knowledge: { state: 'unchanged' },
        candidates: [makeChat()],
        targets,
        now: T_NIGHT_NY,
      });

      expect(res.report.committedAt).toBe(T_NIGHT_NY);
      expect(res.report.outcome).toBe('skipped');
      expect(res.destinations[0]?.status).toBe('suppressed_quiet_hours');
      expect(res.destinations[1]?.status).toBe('suppressed_noop');
      expect(res.destinations[2]?.status).toBe('suppressed_policy');
    } finally {
      store.close();
    }
  });
});
