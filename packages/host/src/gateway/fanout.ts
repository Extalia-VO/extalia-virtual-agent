/**
 * Unified Schedule & Autonomous Knowledge/Skills Multi-Surface Fanout
 * (Universal Gateway v2 M3, Issue #140: GW-WP-13; Schedule vNext PRD Appendix A: SCH-GW-01..10).
 *
 * Bridges `ScheduleRunV1` receipts and `LearningSchedule` / Knowledge / Meeting / Skill
 * candidate receipts into canonical `WorkspaceSystemReport` + Chat projection FIRST,
 * then fans out one single execution into zero or more authorized external bindings
 * across Discord (detailed), Telegram (milestone/digest), and WhatsApp (fail-closed
 * policy-gated compact report) with strict partial-failure isolation and zero feedback loops.
 */
import {
  isValidIanaTimeZone,
  sanitizeGatewayText,
  type AgentPortraitIdentity,
  type ApprovedOutbound,
  type AutonomousReportOutcome,
  type AutonomousReportSource,
  type AutonomousReportTargetPolicy,
  type DetailLevel,
  type GatewayOutboundIntent,
  type GatewayOutboundMessageClass,
  type GatewayProjectEvent,
  type GatewayProvider,
  type LearningScheduleJob,
  type LearningScheduleResult,
  type ScheduleRunV1,
  type WorkspaceSystemReport,
  type WorkspaceSystemReportKnowledge,
  type WorkspaceSystemReportMeeting,
  type WorkspaceSystemReportSkill,
} from '@extalia/platform';
import { randomUUID } from 'node:crypto';
import {
  shouldSuppressExternalReportFanout,
  type AutonomousReportChatCandidate,
  type AutonomousReportService,
  type ChatReportProjectionRecord,
} from './autonomousReports.js';
import type { GatewayOutboxService, RecordSendResultInput } from './outbox.js';
import type { GatewayStore } from './store.js';
import { renderTelegramAutonomousReport } from './telegram.js';

export type FanoutSubscriptionMode = 'immediate' | 'digest' | 'off';

export interface FanoutQuietHours {
  enabled: boolean;
  /** Local start hour in 0..23 (inclusive). */
  startHour: number;
  /** Local end hour in 0..23 (exclusive). Supports overnight ranges like 22..7. */
  endHour: number;
  /** Recipient IANA timezone (e.g. 'UTC', 'America/New_York', 'Asia/Jakarta'). */
  timeZone: string;
  /** Only urgent failures/attention may bypass quiet hours when explicitly opted in. */
  allowUrgentBypass?: boolean;
}

export interface WhatsAppTemplateApproval {
  name: string;
  language: string;
  category: 'utility' | 'authentication' | 'marketing';
  approved: boolean;
  expectedLanguage?: string;
  expectedCategory?: 'utility' | 'authentication' | 'marketing';
}

export interface WhatsAppComplianceContext {
  /** Explicit feature/policy flag; defaults false (fail-closed). */
  waEnabled: boolean;
  recipientOptedIn: boolean;
  serviceWindowOpen: boolean;
  approvedTemplate?: WhatsAppTemplateApproval;
  estimatedCost?: number;
  remainingBudget?: number;
}

export interface FanoutDestinationTarget {
  connectorId: string;
  provider: GatewayProvider;
  bindingId: string;
  bindingRevision: number;
  workspaceId: string;
  audienceScopeId: string;
  authorized: boolean;
  subscriptionMode: FanoutSubscriptionMode;
  quietHours?: FanoutQuietHours;
  recipientId?: string;
  whatsappCompliance?: WhatsAppComplianceContext;
  maxMessageLength?: number;
}

export type FanoutDestinationStatus =
  | 'enqueued'
  | 'deduplicated'
  | 'suppressed_policy'
  | 'suppressed_quiet_hours'
  | 'suppressed_noop'
  | 'policy_blocked'
  | 'unauthorized'
  | 'cross_workspace_refused';

export interface FanoutDestinationDecision {
  connectorId: string;
  provider: GatewayProvider;
  bindingId: string;
  status: FanoutDestinationStatus;
  format: DetailLevel;
  senderKind: 'gateway-system' | 'lead' | 'worker';
  intentId?: string;
  policyReceiptId?: string;
  reason?: string;
}

export interface FanoutExecutionResult {
  report: WorkspaceSystemReport;
  projection: ChatReportProjectionRecord;
  deduplicated: boolean;
  revised: boolean;
  destinations: FanoutDestinationDecision[];
  /** Guaranteed invariants (SCH-GW-AT-03): fanout never triggers new prompts or learning loops. */
  readonly triggeredPromptSubmitted: false;
  readonly triggeredLearning: false;
}

export interface FanoutScheduleRunInput {
  run: ScheduleRunV1;
  scheduleName?: string;
  audienceScopeId: string;
  targetPolicy?: AutonomousReportTargetPolicy;
  pinnedChatId?: string;
  candidates: readonly AutonomousReportChatCandidate[];
  targets: readonly FanoutDestinationTarget[];
  now: string;
}

export interface FanoutAutonomousReportInput {
  source: AutonomousReportSource;
  sourceJobId: string;
  sourceRunId?: string;
  workspaceId: string;
  vaultProfileId?: string;
  vaultProfileRevision?: string;
  sourceSessionId?: string;
  audienceScopeId: string;
  outcome?: AutonomousReportOutcome;
  knowledge?: WorkspaceSystemReportKnowledge;
  skills?: WorkspaceSystemReportSkill[];
  meeting?: WorkspaceSystemReportMeeting;
  learningJob?: LearningScheduleJob;
  learningResult?: LearningScheduleResult;
  problems?: string[];
  maintenanceSourceReceiptDigest?: string;
  maintenanceKind?: string;
  targetPolicy?: AutonomousReportTargetPolicy;
  pinnedChatId?: string;
  candidates: readonly AutonomousReportChatCandidate[];
  targets: readonly FanoutDestinationTarget[];
  now: string;
}

export interface FanoutWorkerEventInput {
  event: GatewayProjectEvent;
  portrait: AgentPortraitIdentity;
  audienceScopeId: string;
  targets: readonly FanoutDestinationTarget[];
  now: string;
}

export type FanoutProviderDispatchOutcome =
  | { kind: 'accepted'; remoteMessageId: string; httpStatus?: number }
  | { kind: 'rate-limited'; retryAfterSeconds: number; httpStatus?: number; errorMessage?: string }
  | { kind: 'retryable'; backoffSeconds?: number; httpStatus?: number; errorMessage: string }
  | { kind: 'permanent-blocked'; httpStatus?: number; errorMessage: string }
  | { kind: 'ambiguous-timeout'; errorMessage: string };

export type FanoutProviderSender = (
  approved: ApprovedOutbound,
) => Promise<FanoutProviderDispatchOutcome>;

export interface FanoutDispatchSummary {
  intentId: string;
  connectorId: string;
  bindingId: string;
  provider: GatewayProvider;
  outcome: GatewayOutboundIntent['state'];
  remoteMessageId?: string;
  error?: string;
}

/**
 * Evaluates whether `nowIso` falls inside `quietHours` in the recipient's IANA timezone.
 * Never mutates UTC report timestamps (GW-FR-112).
 */
export function isWithinQuietHours(nowIso: string, quietHours?: FanoutQuietHours): boolean {
  if (!quietHours || !quietHours.enabled) return false;
  if (!isValidIanaTimeZone(quietHours.timeZone)) return false;

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: quietHours.timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
  });
  const parts = formatter.formatToParts(new Date(Date.parse(nowIso)));
  const hourPart = parts.find(p => p.type === 'hour')?.value;
  let localHour = Number(hourPart ?? 0);
  if (localHour === 24) localHour = 0;

  const start = ((quietHours.startHour % 24) + 24) % 24;
  const end = ((quietHours.endHour % 24) + 24) % 24;
  if (start === end) return false;
  if (start < end) {
    return localHour >= start && localHour < end;
  }
  // Overnight quiet window (e.g. 22:00 .. 07:00)
  return localHour >= start || localHour < end;
}

/**
 * Fail-closed WhatsApp compliance gate (PRD §10, §16.2, SCH-GW-AT-06, SCH-GW-AT-07).
 * Blocks unless explicit policy flag + recipient consent + (service window OR approved template)
 * + budget check all pass.
 */
export function evaluateWhatsAppCompliance(
  compliance?: WhatsAppComplianceContext,
): { allowed: true; templateRef?: string } | { allowed: false; reason: string } {
  if (!compliance || !compliance.waEnabled) {
    return {
      allowed: false,
      reason: 'WhatsApp connector policy flag waEnabled is not explicitly enabled (fail-closed).',
    };
  }
  if (!compliance.recipientOptedIn) {
    return {
      allowed: false,
      reason: 'WhatsApp recipient has not opted in or consent was revoked.',
    };
  }
  if (!compliance.serviceWindowOpen) {
    const tpl = compliance.approvedTemplate;
    if (!tpl || !tpl.approved) {
      return {
        allowed: false,
        reason: 'WhatsApp 24h customer-service window is closed and no approved template is available.',
      };
    }
    if (tpl.expectedLanguage && tpl.language !== tpl.expectedLanguage) {
      return {
        allowed: false,
        reason: `Approved template language "${tpl.language}" does not match expected "${tpl.expectedLanguage}".`,
      };
    }
    if (tpl.expectedCategory && tpl.category !== tpl.expectedCategory) {
      return {
        allowed: false,
        reason: `Approved template category "${tpl.category}" does not match expected "${tpl.expectedCategory}".`,
      };
    }
  }
  if (
    compliance.estimatedCost !== undefined
    && compliance.remainingBudget !== undefined
    && compliance.estimatedCost > compliance.remainingBudget
  ) {
    return {
      allowed: false,
      reason: `WhatsApp estimated send cost (${compliance.estimatedCost}) exceeds remaining budget (${compliance.remainingBudget}).`,
    };
  }
  return {
    allowed: true,
    ...(compliance.approvedTemplate?.approved ? { templateRef: `${compliance.approvedTemplate.name}:${compliance.approvedTemplate.language}` } : {}),
  };
}

function defaultDetailLevelForProvider(provider: GatewayProvider): DetailLevel {
  if (provider === 'discord') return 'detailed';
  if (provider === 'telegram') return 'milestone';
  if (provider === 'whatsapp') return 'report';
  return 'milestone';
}

function mapScheduleRunOutcome(state: ScheduleRunV1['state']): AutonomousReportOutcome {
  switch (state) {
    case 'completed':
      return 'completed';
    case 'failed':
    case 'blocked':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'deferred':
      return 'skipped';
    case 'pending':
    case 'admitting':
    case 'dispatched':
    case 'running':
    case 'unknown':
      return 'unknown';
  }
}

function renderDiscordSystemReport(
  report: WorkspaceSystemReport,
  extra?: { scheduleName?: string; run?: ScheduleRunV1 },
): string {
  const lines = [
    `Extalia System Report — ${report.source === 'schedule-run' ? 'Scheduled Run' : `Autonomous (${report.source})`}`,
    `Workspace: ${report.workspaceId} | Job: ${report.sourceJobId}${report.sourceRunId ? ` | Run: ${report.sourceRunId}` : ''} | Rev: ${report.revision}`,
  ];

  if (extra?.scheduleName) {
    lines.push(`Schedule: ${extra.scheduleName}`);
  }

  if (extra?.run) {
    lines.push(`Run state: ${extra.run.state} | Verification: ${extra.run.verification}`);
    if (extra.run.statusReason) {
      lines.push(`Detail: ${extra.run.statusReason}`);
    }
  } else {
    lines.push(`Outcome: ${report.outcome.toUpperCase()}`);
  }

  if (report.knowledge) {
    const idx =
      report.knowledge.indexed === true
        ? 'indexed'
        : report.knowledge.indexed === false
          ? 'index incomplete'
          : 'index unverified';
    const receipts = report.knowledge.artifactReceiptIds?.join(', ') ?? 'none';
    lines.push(`Knowledge: ${report.knowledge.state} (${idx}; receipts: ${receipts}).`);
  }

  if (report.skills && report.skills.length > 0) {
    for (const skill of report.skills) {
      const statusNote = skill.activationPerformed
        ? 'active-confirmed'
        : 'candidate only — review/approval required, NOT ACTIVE';
      lines.push(`Skill: ${skill.packageId}@${skill.revisionId} [${skill.state}] (${statusNote}).`);
    }
  }

  if (report.meeting) {
    lines.push(
      `Meeting ${report.meeting.meetingId ?? 'unknown'}: ${report.meeting.outcome} (knowledge: ${report.meeting.knowledge}).`,
    );
  }

  if (report.problems && report.problems.length > 0) {
    lines.push(`Problems: ${report.problems.join('; ')}`);
  }

  return sanitizeGatewayText(lines.join('\n'), { maxLength: 1900 }).text;
}

function renderWhatsAppCompactReport(
  report: WorkspaceSystemReport,
  extra?: { scheduleName?: string; run?: ScheduleRunV1 },
): string {
  // WhatsApp omits raw worker/tool/file details and Skill internals (PRD §11.7, GW-FR-082).
  if (extra?.run) {
    const label = extra.scheduleName ?? extra.run.scheduleId;
    const stateLabel =
      extra.run.state === 'dispatched' || extra.run.state === 'running'
        ? `admitted/${extra.run.state}`
        : extra.run.state;
    const verificationNote =
      extra.run.state === 'completed'
        ? ` (verification: ${extra.run.verification})`
        : '';
    return sanitizeGatewayText(
      `Extalia Monitor: Schedule "${label}" in ${report.workspaceId} is ${stateLabel}${verificationNote}.`,
      { maxLength: 500 },
    ).text;
  }

  return sanitizeGatewayText(
    `Extalia Monitor: Autonomous ${report.source} report for ${report.workspaceId} finished with outcome ${report.outcome.toUpperCase()} (Rev ${report.revision}). Open Extalia UI for details.`,
    { maxLength: 500 },
  ).text;
}

export class GatewayFanoutService {
  constructor(
    private readonly deps: {
      store: GatewayStore;
      reports: AutonomousReportService;
      outbox: GatewayOutboxService;
    },
  ) {}

  /**
   * Commits a canonical WorkspaceSystemReport for a `ScheduleRunV1` first, then fans out
   * that single execution into zero or more authorized bindings across providers
   * (SCH-GW-01..10, SCH-GW-AT-06, SCH-GW-AT-07, SCH-GW-AT-10).
   */
  fanoutScheduleRun(input: FanoutScheduleRunInput): FanoutExecutionResult {
    const problems: string[] = [];
    if (input.run.state === 'failed' || input.run.state === 'blocked') {
      problems.push(input.run.statusReason ?? `schedule-run-${input.run.state}`);
    } else if (input.run.verification === 'failed') {
      problems.push('schedule-verification-failed');
    }

    const committed = this.deps.reports.commitReport({
      source: 'schedule-run',
      sourceJobId: input.run.scheduleId,
      sourceRunId: input.run.id,
      workspaceId: input.run.workspaceId,
      sourceSessionId: input.run.sessionId,
      audienceScopeId: input.audienceScopeId,
      outcome: mapScheduleRunOutcome(input.run.state),
      problems: problems.length > 0 ? problems : undefined,
      targetPolicy: input.targetPolicy,
      pinnedChatId: input.pinnedChatId,
      candidates: input.candidates,
      now: input.now,
    });

    const isNonTerminal =
      input.run.state === 'pending'
      || input.run.state === 'admitting'
      || input.run.state === 'dispatched'
      || input.run.state === 'running';
    const messageClass: GatewayOutboundMessageClass =
      input.run.state === 'failed' || input.run.state === 'blocked'
        ? 'attention'
        : isNonTerminal
          ? 'accepted'
          : 'system-report';

    const destinations = this.enqueueTargetsForReport({
      report: committed.report,
      targets: input.targets,
      messageClass,
      isUrgent: input.run.state === 'failed' || input.run.state === 'blocked',
      scheduleName: input.scheduleName,
      run: input.run,
      now: input.now,
    });

    return {
      report: committed.report,
      projection: committed.projection,
      deduplicated: committed.deduplicated,
      revised: committed.revised,
      destinations,
      triggeredPromptSubmitted: false,
      triggeredLearning: false,
    };
  }

  /**
   * Commits a canonical WorkspaceSystemReport for autonomous Learning / Knowledge / Meeting /
   * Skill candidate / scheduled maintenance receipts FIRST, then fans out to authorized targets
   * (SCH-GW-AT-01..05, SCH-GW-AT-06, SCH-GW-AT-07, SCH-GW-AT-10..12).
   */
  fanoutAutonomousReport(input: FanoutAutonomousReportInput): FanoutExecutionResult {
    const learningResult = input.learningResult ?? input.learningJob?.result;
    const sourceSessionId = input.sourceSessionId ?? input.learningJob?.sessionId;
    const vaultProfileId = input.vaultProfileId ?? input.learningJob?.profileId;

    const committed = this.deps.reports.commitReport({
      source: input.source,
      sourceJobId: input.sourceJobId,
      sourceRunId: input.sourceRunId,
      workspaceId: input.workspaceId,
      vaultProfileId,
      vaultProfileRevision: input.vaultProfileRevision,
      sourceSessionId,
      audienceScopeId: input.audienceScopeId,
      outcome: input.outcome,
      knowledge: input.knowledge,
      skills: input.skills,
      meeting: input.meeting,
      learningResult,
      problems: input.problems,
      maintenanceSourceReceiptDigest: input.maintenanceSourceReceiptDigest,
      maintenanceKind: input.maintenanceKind,
      targetPolicy: input.targetPolicy,
      pinnedChatId: input.pinnedChatId,
      candidates: input.candidates,
      now: input.now,
    });

    const isUrgent = committed.report.outcome === 'failed' || committed.report.outcome === 'partial';
    const messageClass: GatewayOutboundMessageClass =
      committed.report.outcome === 'failed' ? 'attention' : 'system-report';

    const destinations = this.enqueueTargetsForReport({
      report: committed.report,
      targets: input.targets,
      messageClass,
      isUrgent,
      now: input.now,
    });

    return {
      report: committed.report,
      projection: committed.projection,
      deduplicated: committed.deduplicated,
      revised: committed.revised,
      destinations,
      triggeredPromptSubmitted: false,
      triggeredLearning: false,
    };
  }

  /**
   * Fans out a real worker event (SCH-GW-AT-08):
   * - Discord receives `format: 'detailed'` with `senderKind: 'worker'` and verified `senderPortrait`.
   * - Telegram receives `format: 'milestone'` with `senderKind: 'gateway-system'` (single bot).
   * - WhatsApp suppresses raw worker/tool activity (`suppressed_policy`).
   */
  fanoutWorkerEvent(input: FanoutWorkerEventInput): FanoutDestinationDecision[] {
    const decisions: FanoutDestinationDecision[] = [];

    for (const target of input.targets) {
      const format = defaultDetailLevelForProvider(target.provider);
      const senderKind: 'gateway-system' | 'worker' =
        target.provider === 'discord' ? 'worker' : 'gateway-system';

      if (target.workspaceId !== input.event.workspaceId) {
        decisions.push({
          connectorId: target.connectorId,
          provider: target.provider,
          bindingId: target.bindingId,
          status: 'cross_workspace_refused',
          format,
          senderKind,
          reason: 'Target binding belongs to a different workspace.',
        });
        continue;
      }

      if (!target.authorized || target.audienceScopeId !== input.audienceScopeId) {
        decisions.push({
          connectorId: target.connectorId,
          provider: target.provider,
          bindingId: target.bindingId,
          status: 'unauthorized',
          format,
          senderKind,
          reason: 'Target binding is not authorized for this event audience.',
        });
        continue;
      }

      if (target.subscriptionMode === 'off') {
        decisions.push({
          connectorId: target.connectorId,
          provider: target.provider,
          bindingId: target.bindingId,
          status: 'suppressed_policy',
          format,
          senderKind,
          reason: 'Target subscription mode is off.',
        });
        continue;
      }

      // WhatsApp omits raw worker/tool activity (GW-FR-082).
      if (target.provider === 'whatsapp') {
        decisions.push({
          connectorId: target.connectorId,
          provider: target.provider,
          bindingId: target.bindingId,
          status: 'suppressed_policy',
          format,
          senderKind: 'gateway-system',
          reason: 'WhatsApp omits raw worker and tool activity by policy.',
        });
        continue;
      }

      const text = target.provider === 'discord'
        ? input.event.safeText
        : `[${input.portrait.name} (${input.portrait.role})] ${input.event.safeText}`;

      const enqueued = this.deps.outbox.enqueue({
        connectorId: target.connectorId,
        targetBindingId: target.bindingId,
        targetBindingRevision: target.bindingRevision,
        reportOrSourceEventId: input.event.sourceEventId,
        sourceEventId: input.event.sourceEventId,
        senderKind,
        ...(senderKind === 'worker' ? { senderPortrait: input.portrait } : {}),
        format,
        messageClass: 'milestone',
        recipientId: target.recipientId,
        rawText: text,
        maxMessageLength: target.maxMessageLength,
        now: input.now,
      });

      decisions.push({
        connectorId: target.connectorId,
        provider: target.provider,
        bindingId: target.bindingId,
        status: enqueued.deduplicated ? 'deduplicated' : 'enqueued',
        format,
        senderKind,
        intentId: enqueued.intent.id,
      });
    }

    return decisions;
  }

  /**
   * Dispatches pending outbox intents across providers with strict per-channel failure isolation
   * (SCH-GW-AT-06, SCH-GW-AT-12, GW-AT-094). A failure on one provider (e.g. Telegram 403)
   * never reverts or alters the canonical report or other providers' receipts.
   */
  async dispatchPendingForTargets(input: {
    targets: readonly FanoutDestinationTarget[];
    senders: ReadonlyMap<GatewayProvider, FanoutProviderSender>;
    leaseOwner: string;
    now: string;
  }): Promise<FanoutDispatchSummary[]> {
    const providerByConnector = new Map<string, GatewayProvider>();
    for (const t of input.targets) {
      providerByConnector.set(t.connectorId, t.provider);
    }

    const summaries: FanoutDispatchSummary[] = [];
    const seenConnectors = new Set<string>(providerByConnector.keys());

    for (const connectorId of seenConnectors) {
      const provider = providerByConnector.get(connectorId)!;
      const sender = input.senders.get(provider);
      if (!sender) continue;

      for (;;) {
        const claimed = this.deps.outbox.claimNextReady({
          leaseOwner: input.leaseOwner,
          connectorId,
          now: input.now,
        });
        if (!claimed) break;

        let dispatchResult: FanoutProviderDispatchOutcome;
        try {
          dispatchResult = await sender(claimed.approved);
        } catch (error) {
          dispatchResult = {
            kind: 'ambiguous-timeout',
            errorMessage: error instanceof Error ? error.message : String(error),
          };
        }

        const recordInput: RecordSendResultInput =
          dispatchResult.kind === 'accepted'
            ? {
              kind: 'accepted',
              intentId: claimed.intent.id,
              fencingToken: claimed.approved.fencingToken,
              leaseOwner: input.leaseOwner,
              providerRequestKey: claimed.approved.providerRequestKey,
              remoteMessageId: dispatchResult.remoteMessageId,
              httpStatus: dispatchResult.httpStatus,
              now: input.now,
            }
            : dispatchResult.kind === 'rate-limited'
              ? {
                kind: 'rate-limited',
                intentId: claimed.intent.id,
                fencingToken: claimed.approved.fencingToken,
                leaseOwner: input.leaseOwner,
                providerRequestKey: claimed.approved.providerRequestKey,
                httpStatus: dispatchResult.httpStatus,
                retryAfterSeconds: dispatchResult.retryAfterSeconds,
                errorMessage: dispatchResult.errorMessage,
                now: input.now,
              }
              : dispatchResult.kind === 'retryable'
                ? {
                  kind: 'retryable',
                  intentId: claimed.intent.id,
                  fencingToken: claimed.approved.fencingToken,
                  leaseOwner: input.leaseOwner,
                  providerRequestKey: claimed.approved.providerRequestKey,
                  httpStatus: dispatchResult.httpStatus,
                  backoffSeconds: dispatchResult.backoffSeconds,
                  errorMessage: dispatchResult.errorMessage,
                  now: input.now,
                }
                : dispatchResult.kind === 'permanent-blocked'
                  ? {
                    kind: 'permanent-blocked',
                    intentId: claimed.intent.id,
                    fencingToken: claimed.approved.fencingToken,
                    leaseOwner: input.leaseOwner,
                    providerRequestKey: claimed.approved.providerRequestKey,
                    httpStatus: dispatchResult.httpStatus,
                    errorMessage: dispatchResult.errorMessage,
                    now: input.now,
                  }
                  : {
                    kind: 'ambiguous-timeout',
                    intentId: claimed.intent.id,
                    fencingToken: claimed.approved.fencingToken,
                    leaseOwner: input.leaseOwner,
                    providerRequestKey: claimed.approved.providerRequestKey,
                    errorMessage: dispatchResult.errorMessage,
                    now: input.now,
                  };

        const recorded = this.deps.outbox.recordSendResult(recordInput);
        summaries.push({
          intentId: recorded.intent.id,
          connectorId,
          bindingId: recorded.intent.targetBindingId,
          provider,
          outcome: recorded.intent.state,
          remoteMessageId: recorded.intent.remoteMessageId,
          error: recorded.intent.lastProviderError,
        });
      }
    }

    return summaries;
  }

  private enqueueTargetsForReport(input: {
    report: WorkspaceSystemReport;
    targets: readonly FanoutDestinationTarget[];
    messageClass: GatewayOutboundMessageClass;
    isUrgent: boolean;
    scheduleName?: string;
    run?: ScheduleRunV1;
    now: string;
  }): FanoutDestinationDecision[] {
    const decisions: FanoutDestinationDecision[] = [];

    for (const target of input.targets) {
      const format = defaultDetailLevelForProvider(target.provider);
      // System reports ALWAYS use `gateway-system` identity, never a worker persona (SCH-GW-AT-08).
      const senderKind = 'gateway-system' as const;

      if (target.workspaceId !== input.report.workspaceId) {
        decisions.push({
          connectorId: target.connectorId,
          provider: target.provider,
          bindingId: target.bindingId,
          status: 'cross_workspace_refused',
          format,
          senderKind,
          reason: `Refused cross-workspace fanout from ${input.report.workspaceId} to ${target.workspaceId}.`,
        });
        continue;
      }

      if (!target.authorized || target.audienceScopeId !== input.report.audienceScopeId) {
        decisions.push({
          connectorId: target.connectorId,
          provider: target.provider,
          bindingId: target.bindingId,
          status: 'unauthorized',
          format,
          senderKind,
          reason: 'Binding is not authorized for this report audience.',
        });
        continue;
      }

      if (target.subscriptionMode === 'off') {
        decisions.push({
          connectorId: target.connectorId,
          provider: target.provider,
          bindingId: target.bindingId,
          status: 'suppressed_policy',
          format,
          senderKind,
          reason: 'Destination subscription mode is off.',
        });
        continue;
      }

      if (shouldSuppressExternalReportFanout(input.report, target.subscriptionMode)) {
        decisions.push({
          connectorId: target.connectorId,
          provider: target.provider,
          bindingId: target.bindingId,
          status: 'suppressed_noop',
          format,
          senderKind,
          reason: 'No-op report suppressed under digest subscription policy.',
        });
        continue;
      }

      if (isWithinQuietHours(input.now, target.quietHours)) {
        const urgentBypass = input.isUrgent && Boolean(target.quietHours?.allowUrgentBypass);
        if (!urgentBypass) {
          decisions.push({
            connectorId: target.connectorId,
            provider: target.provider,
            bindingId: target.bindingId,
            status: 'suppressed_quiet_hours',
            format,
            senderKind,
            reason: `Suppressed during recipient quiet hours (${target.quietHours?.timeZone}).`,
          });
          continue;
        }
      }

      // WhatsApp fail-closed compliance gate (SCH-GW-AT-06, SCH-GW-AT-07).
      if (target.provider === 'whatsapp') {
        const complianceCheck = evaluateWhatsAppCompliance(target.whatsappCompliance);
        if (!complianceCheck.allowed) {
          const policyReceiptId = this.recordBlockedPolicyReceipt({
            connectorId: target.connectorId,
            recipientId: target.recipientId,
            reason: complianceCheck.reason,
            costEstimate: target.whatsappCompliance?.estimatedCost,
            now: input.now,
          });
          decisions.push({
            connectorId: target.connectorId,
            provider: target.provider,
            bindingId: target.bindingId,
            status: 'policy_blocked',
            format,
            senderKind,
            policyReceiptId,
            reason: complianceCheck.reason,
          });
          continue;
        }
      }

      const rawText = this.renderForProvider(target.provider, input.report, {
        scheduleName: input.scheduleName,
        run: input.run,
      });

      const enqueued = this.deps.outbox.enqueue({
        connectorId: target.connectorId,
        targetBindingId: target.bindingId,
        targetBindingRevision: target.bindingRevision,
        reportOrSourceEventId: `${input.report.id}:rev${input.report.revision}`,
        reportId: input.report.id,
        reportRevision: input.report.revision,
        senderKind,
        format,
        messageClass: input.messageClass,
        recipientId: target.recipientId,
        rawText,
        maxMessageLength: target.maxMessageLength,
        projectionVersion: input.report.revision,
        consentVerified: target.provider === 'whatsapp' ? Boolean(target.whatsappCompliance?.recipientOptedIn) : true,
        costEstimate: target.whatsappCompliance?.estimatedCost,
        now: input.now,
      });

      decisions.push({
        connectorId: target.connectorId,
        provider: target.provider,
        bindingId: target.bindingId,
        status: enqueued.deduplicated ? 'deduplicated' : 'enqueued',
        format,
        senderKind,
        intentId: enqueued.intent.id,
      });
    }

    return decisions;
  }

  private renderForProvider(
    provider: GatewayProvider,
    report: WorkspaceSystemReport,
    extra?: { scheduleName?: string; run?: ScheduleRunV1 },
  ): string {
    if (provider === 'discord') {
      return renderDiscordSystemReport(report, extra);
    }
    if (provider === 'whatsapp') {
      return renderWhatsAppCompactReport(report, extra);
    }
    if (extra?.run) {
      const label = extra.scheduleName ?? extra.run.scheduleId;
      const stateLabel =
        extra.run.state === 'dispatched' || extra.run.state === 'running'
          ? `admitted/${extra.run.state}`
          : extra.run.state;
      return sanitizeGatewayText(
        `Extalia Schedule — ${label} (${stateLabel})\nWorkspace: ${report.workspaceId} | Run: ${extra.run.id} | Verification: ${extra.run.verification}`,
        { maxLength: 4000 },
      ).text;
    }
    return renderTelegramAutonomousReport(report);
  }

  private recordBlockedPolicyReceipt(input: {
    connectorId: string;
    recipientId?: string;
    reason: string;
    costEstimate?: number;
    now: string;
  }): string {
    const id = `pol_${randomUUID()}`;
    this.deps.store.database.prepare(
      `INSERT INTO gateway_policy_receipts(
        id, policy_version, connector_id, actor_id, audience,
        consent_verified, cost_estimate, decision, reason, evaluated_at
      ) VALUES (?, 1, ?, ?, 'private', 0, ?, 'blocked', ?, ?)`,
    ).run(
      id,
      input.connectorId,
      input.recipientId ?? null,
      input.costEstimate ?? null,
      sanitizeGatewayText(input.reason, { maxLength: 500 }).text,
      input.now,
    );
    this.deps.store.recordAudit({
      actor: 'host:fanout',
      action: 'fanout.policy_blocked',
      resource: `connector:${input.connectorId}`,
      outcome: 'blocked',
      reason: input.reason,
      at: input.now,
    });
    return id;
  }
}
