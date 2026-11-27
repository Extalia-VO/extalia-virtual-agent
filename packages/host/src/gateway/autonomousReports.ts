/**
 * Canonical WorkspaceSystemReport ledger, immutable revisions, deduplication,
 * and `latest-eligible-in-source-workspace` Chat target selection (PRD §11, §18.5, §20.5).
 */
import {
  validateWorkspaceSystemReport,
  type AutonomousReportOutcome,
  type AutonomousReportSource,
  type AutonomousReportTargetPolicy,
  type AutonomousReportTargetSelection,
  type LearningScheduleResult,
  type WorkspaceSystemReport,
  type WorkspaceSystemReportKnowledge,
  type WorkspaceSystemReportMeeting,
  type WorkspaceSystemReportSkill,
} from '@extalia/platform';
import { randomUUID } from 'node:crypto';
import {
  buildAutonomousKey,
  buildMaintenanceIntentKey,
  buildReportRevisionId,
  type GatewayStore,
} from './store.js';

export interface AutonomousReportChatCandidate {
  chatId: string;
  workspaceId: string;
  audienceScopeId: string;
  authorizedAudienceScopeIds?: readonly string[];
  deleted?: boolean;
  historyEnabled: boolean;
  isPrivateToOtherUser?: boolean;
  observedImmutableTranscript?: boolean;
  supportsSystemReportCards: boolean;
  vaultProfileId?: string;
  /** Last genuine human or agent foreground activity time (excludes system reports/notifications). */
  lastForegroundActiveAt: string;
  /** Ignored for ordering; retained only to verify system cards do not perturb foreground recency. */
  lastSystemEventAt?: string;
}

export interface TargetSelectionRejection {
  chatId: string;
  reason:
    | 'wrong-workspace'
    | 'deleted'
    | 'history-disabled'
    | 'private-to-other-user'
    | 'observed-immutable-transcript'
    | 'unsupported-system-cards'
    | 'unauthorized-audience'
    | 'vault-profile-mismatch';
}

export interface TargetSelectionReceipt {
  decisionId: string;
  policy: AutonomousReportTargetPolicy;
  workspaceId: string;
  audienceScopeId: string;
  selectedChatId?: string;
  targetSelection: AutonomousReportTargetSelection;
  evaluatedCount: number;
  eligibleCount: number;
  rejected: TargetSelectionRejection[];
}

export interface AutonomousReportTargetResult {
  targetChatId?: string;
  targetSelection: AutonomousReportTargetSelection;
  selectionReceipt: TargetSelectionReceipt;
}

export interface ChatReportProjectionRecord {
  id: string;
  reportId: string;
  chatId?: string;
  workspaceId: string;
  audienceScopeId: string;
  targetSelection: AutonomousReportTargetSelection;
  selectionReceipt: TargetSelectionReceipt;
  readonly readOnlySystemCard: true;
  readonly excludeFromModelHistory: true;
  readonly excludeFromLearning: true;
  createdAt: string;
  updatedAt: string;
}

export interface CommitAutonomousReportInput {
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
  learningResult?: LearningScheduleResult;
  problems?: string[];
  /** Optional evidence digest used to deduplicate overlapping periodic maintenance & post-task curator runs. */
  maintenanceSourceReceiptDigest?: string;
  maintenanceKind?: string;
  targetPolicy?: AutonomousReportTargetPolicy;
  pinnedChatId?: string;
  candidates: readonly AutonomousReportChatCandidate[];
  now: string;
}

export interface CommitAutonomousReportResult {
  report: WorkspaceSystemReport;
  projection: ChatReportProjectionRecord;
  deduplicated: boolean;
  revised: boolean;
  /** Guaranteed invariants: committing a report never submits a prompt or triggers learning. */
  readonly triggeredPromptSubmitted: false;
  readonly triggeredLearning: false;
}

const OUTCOME_RANK: Readonly<Record<AutonomousReportOutcome, number>> = {
  unknown: 0,
  skipped: 1,
  partial: 2,
  failed: 3,
  cancelled: 3,
  completed: 4,
};

function checkCandidateEligibility(
  candidate: AutonomousReportChatCandidate,
  input: { workspaceId: string; audienceScopeId: string; vaultProfileId?: string },
): TargetSelectionRejection['reason'] | null {
  if (candidate.workspaceId !== input.workspaceId) return 'wrong-workspace';
  if (candidate.deleted) return 'deleted';
  if (!candidate.historyEnabled) return 'history-disabled';
  if (candidate.isPrivateToOtherUser) return 'private-to-other-user';
  if (candidate.observedImmutableTranscript) return 'observed-immutable-transcript';
  if (!candidate.supportsSystemReportCards) return 'unsupported-system-cards';
  const audienceAllowed =
    candidate.audienceScopeId === input.audienceScopeId
    || (candidate.authorizedAudienceScopeIds?.includes(input.audienceScopeId) ?? false);
  if (!audienceAllowed) return 'unauthorized-audience';
  if (input.vaultProfileId && candidate.vaultProfileId && candidate.vaultProfileId !== input.vaultProfileId) {
    return 'vault-profile-mismatch';
  }
  return null;
}

/**
 * Selects the report destination strictly within the source workspace and authorized audience
 * (PRD §11.3, GW-AT-078..087). Never falls back to a newer Chat in another workspace.
 */
export function selectAutonomousReportTarget(input: {
  workspaceId: string;
  audienceScopeId: string;
  vaultProfileId?: string;
  sourceSessionId?: string;
  policy?: AutonomousReportTargetPolicy;
  pinnedChatId?: string;
  candidates: readonly AutonomousReportChatCandidate[];
}): AutonomousReportTargetResult {
  const policy: AutonomousReportTargetPolicy = input.policy ?? 'latest-eligible-in-source-workspace';
  const decisionId = `sel_${randomUUID()}`;
  const rejected: TargetSelectionRejection[] = [];
  const eligible: AutonomousReportChatCandidate[] = [];

  for (const candidate of input.candidates) {
    const reason = checkCandidateEligibility(candidate, input);
    if (reason) {
      rejected.push({ chatId: candidate.chatId, reason });
    } else {
      eligible.push(candidate);
    }
  }

  const finish = (
    targetChatId: string | undefined,
    targetSelection: AutonomousReportTargetSelection,
  ): AutonomousReportTargetResult => ({
    targetChatId,
    targetSelection,
    selectionReceipt: {
      decisionId,
      policy,
      workspaceId: input.workspaceId,
      audienceScopeId: input.audienceScopeId,
      selectedChatId: targetChatId,
      targetSelection,
      evaluatedCount: input.candidates.length,
      eligibleCount: eligible.length,
      rejected,
    },
  });

  if (policy === 'inbox-only') {
    return finish(undefined, 'inbox');
  }

  if (policy === 'source-session-only') {
    if (input.sourceSessionId && eligible.some(c => c.chatId === input.sourceSessionId)) {
      return finish(input.sourceSessionId, 'source-only');
    }
    return finish(undefined, 'inbox');
  }

  // 1. Pinned eligible Chat in the source workspace takes precedence.
  if (input.pinnedChatId && eligible.some(c => c.chatId === input.pinnedChatId)) {
    return finish(input.pinnedChatId, 'pinned');
  }

  // 2. Latest eligible retained foreground Chat in the source workspace,
  // ordered strictly by genuine foreground activity time with deterministic chatId tie-break.
  if (eligible.length > 0) {
    const sorted = [...eligible].sort((a, b) => {
      const diff = Date.parse(b.lastForegroundActiveAt) - Date.parse(a.lastForegroundActiveAt);
      if (diff !== 0) return diff;
      return a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0;
    });
    return finish(sorted[0]!.chatId, 'last-eligible');
  }

  // 3. Safe fallback to workspace Reports Inbox.
  return finish(undefined, 'inbox');
}

function deriveFromLearningResult(
  result: LearningScheduleResult,
): {
  knowledge?: WorkspaceSystemReportKnowledge;
  skills?: WorkspaceSystemReportSkill[];
  meeting?: WorkspaceSystemReportMeeting;
  problems: string[];
} {
  const problems: string[] = [];
  if (result.problem) problems.push(`learning-problem:${result.problem}`);

  let knowledge: WorkspaceSystemReportKnowledge | undefined;
  if (result.project) {
    knowledge = {
      state: result.project.status,
      indexed: result.project.indexed,
      artifactReceiptIds: result.project.overviewPath ? [`overview:${result.project.overviewPath}`] : undefined,
    };
  } else if (result.knowledge) {
    knowledge = {
      state: result.knowledge.status,
      indexed: result.knowledge.indexed,
      artifactReceiptIds: result.knowledge.path ? [`note:${result.knowledge.path}`] : undefined,
    };
  }

  let skills: WorkspaceSystemReportSkill[] | undefined;
  if (result.skill) {
    skills = [
      {
        packageId: result.skill.packageId,
        revisionId: result.skill.revisionId,
        state: 'review-required',
        activationPerformed: false,
      },
    ];
  }

  let meeting: WorkspaceSystemReportMeeting | undefined;
  if (result.meeting) {
    meeting = {
      outcome: result.meeting.outcome,
      meetingId: result.meeting.meetingId,
      knowledge: result.meeting.knowledge,
      indexed: result.meeting.indexed,
      artifactReceiptId: result.meeting.notePath ? `meeting:${result.meeting.notePath}` : undefined,
    };
    if (result.meeting.problem) problems.push(result.meeting.problem);
  }

  return { knowledge, skills, meeting, problems };
}

function normalizeOutcome(input: {
  explicit?: AutonomousReportOutcome;
  knowledge?: WorkspaceSystemReportKnowledge;
  skills?: readonly WorkspaceSystemReportSkill[];
  meeting?: WorkspaceSystemReportMeeting;
  problems: readonly string[];
}): AutonomousReportOutcome {
  // Saved knowledge whose index refresh failed must be represented as `partial`, never `completed`.
  if (input.knowledge?.state === 'saved' && input.knowledge.indexed === false) {
    return 'partial';
  }
  if (input.knowledge?.state === 'partial') {
    return 'partial';
  }
  if (input.explicit) return input.explicit;

  const hasSkillFailure = input.skills?.some(s => s.state === 'failed') ?? false;
  const hasSkillSaved = input.skills?.some(
    s => s.state === 'candidate-saved' || s.state === 'inspection-pending' || s.state === 'review-required',
  ) ?? false;

  if (input.knowledge?.state === 'failed' || input.meeting?.outcome === 'failed') {
    return hasSkillSaved ? 'partial' : 'failed';
  }
  if (hasSkillFailure) {
    return input.knowledge?.state === 'saved' ? 'partial' : 'failed';
  }
  if (input.meeting?.outcome === 'cancelled') return 'cancelled';
  if (input.knowledge?.state === 'unchanged' && !hasSkillSaved && input.problems.length === 0) {
    return 'skipped';
  }
  if (input.knowledge?.state === 'skipped' && !hasSkillSaved && input.problems.length === 0) {
    return 'skipped';
  }
  if (input.problems.length > 0 && (input.knowledge?.state === 'saved' || hasSkillSaved)) {
    return 'partial';
  }
  return 'completed';
}

function collectArtifactReceiptIds(report: {
  knowledge?: WorkspaceSystemReportKnowledge;
  skills?: readonly WorkspaceSystemReportSkill[];
  meeting?: WorkspaceSystemReportMeeting;
}): string[] {
  const ids: string[] = [];
  if (report.knowledge?.artifactReceiptIds) {
    ids.push(...report.knowledge.artifactReceiptIds);
  }
  if (report.knowledge) {
    ids.push(`knowledge:${report.knowledge.state}:indexed=${String(report.knowledge.indexed ?? 'unset')}`);
  }
  if (report.skills) {
    for (const skill of report.skills) {
      ids.push(`skill:${skill.packageId}@${skill.revisionId}:${skill.state}:active=${String(skill.activationPerformed)}`);
    }
  }
  if (report.meeting) {
    ids.push(`meeting:${report.meeting.meetingId ?? 'none'}:${report.meeting.outcome}:${report.meeting.knowledge}`);
    if (report.meeting.artifactReceiptId) ids.push(report.meeting.artifactReceiptId);
  }
  return [...new Set(ids)].sort();
}

function mergeKnowledgeReceipts(
  prev?: WorkspaceSystemReportKnowledge,
  next?: WorkspaceSystemReportKnowledge,
): WorkspaceSystemReportKnowledge | undefined {
  if (!prev) return next;
  if (!next) return prev;
  const mergedIds = [...new Set([...(prev.artifactReceiptIds ?? []), ...(next.artifactReceiptIds ?? [])])].sort();
  return {
    state: next.state,
    indexed: next.indexed ?? prev.indexed,
    artifactReceiptIds: mergedIds.length > 0 ? mergedIds : undefined,
  };
}

function mergeSkills(
  prev?: readonly WorkspaceSystemReportSkill[],
  next?: readonly WorkspaceSystemReportSkill[],
): WorkspaceSystemReportSkill[] | undefined {
  if (!prev?.length) return next ? [...next] : undefined;
  if (!next?.length) return [...prev];
  const byKey = new Map<string, WorkspaceSystemReportSkill>();
  for (const item of prev) byKey.set(`${item.packageId}@${item.revisionId}`, item);
  for (const item of next) byKey.set(`${item.packageId}@${item.revisionId}`, item);
  return [...byKey.values()];
}

function mapProjectionRow(row: Record<string, unknown>): ChatReportProjectionRecord {
  return {
    id: String(row.id),
    reportId: String(row.report_id),
    chatId: row.chat_id ? String(row.chat_id) : undefined,
    workspaceId: String(row.workspace_id),
    audienceScopeId: String(row.audience_scope_id),
    targetSelection: String(row.target_selection) as AutonomousReportTargetSelection,
    selectionReceipt: JSON.parse(String(row.selection_receipt_json)) as TargetSelectionReceipt,
    readOnlySystemCard: true,
    excludeFromModelHistory: true,
    excludeFromLearning: true,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class AutonomousReportService {
  constructor(private readonly store: GatewayStore) {}

  /**
   * Commits a canonical WorkspaceSystemReport from verified receipts, independent of external
   * network availability. Enforces dedup, immutable revisions, post-commit pinning,
   * activationPerformed=false for candidates, and zero prompt/learning feedback loops.
   */
  commitReport(input: CommitAutonomousReportInput): CommitAutonomousReportResult {
    const derived = input.learningResult ? deriveFromLearningResult(input.learningResult) : undefined;
    const knowledge = input.knowledge ?? derived?.knowledge;
    const skills = input.skills ?? derived?.skills;
    const meeting = input.meeting ?? derived?.meeting;
    const problems = [...new Set([...(input.problems ?? []), ...(derived?.problems ?? [])])];

    // Enforce invariant: skill candidates cannot claim activationPerformed.
    if (skills) {
      for (const skill of skills) {
        if (skill.state !== 'active-confirmed' && skill.activationPerformed) {
          throw new Error(
            `Skill candidate "${skill.packageId}@${skill.revisionId}" cannot set activationPerformed=true.`,
          );
        }
      }
    }

    const outcome = normalizeOutcome({
      explicit: input.outcome,
      knowledge,
      skills,
      meeting,
      problems,
    });

    const autonomousKey = buildAutonomousKey({
      sourceJobId: input.sourceJobId,
      workspaceId: input.workspaceId,
      vaultProfileRevision: input.vaultProfileRevision,
      reportKind: input.source,
    });

    const maintenanceIntentKey = input.maintenanceSourceReceiptDigest
      ? buildMaintenanceIntentKey({
        workspaceId: input.workspaceId,
        vaultProfileRevision: input.vaultProfileRevision,
        maintenanceKind: input.maintenanceKind ?? input.source,
        sourceReceiptDigest: input.maintenanceSourceReceiptDigest,
      })
      : undefined;

    return this.store.transaction(() => {
      const existingRow = (this.store.database
        .prepare('SELECT * FROM gateway_report_ledger WHERE autonomous_key = ?')
        .get(autonomousKey)
        ?? (maintenanceIntentKey
          ? this.store.database
            .prepare('SELECT * FROM gateway_report_ledger WHERE maintenance_intent_key = ?')
            .get(maintenanceIntentKey)
          : undefined)) as Record<string, unknown> | undefined;

      if (!existingRow) {
        const reportId = `rpt_${randomUUID()}`;
        const target = selectAutonomousReportTarget({
          workspaceId: input.workspaceId,
          audienceScopeId: input.audienceScopeId,
          vaultProfileId: input.vaultProfileId,
          sourceSessionId: input.sourceSessionId,
          policy: input.targetPolicy,
          pinnedChatId: input.pinnedChatId,
          candidates: input.candidates,
        });

        const report: WorkspaceSystemReport = {
          id: reportId,
          revision: 1,
          source: input.source,
          sourceJobId: input.sourceJobId,
          ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
          workspaceId: input.workspaceId,
          ...(input.vaultProfileId ? { vaultProfileId: input.vaultProfileId } : {}),
          ...(input.vaultProfileRevision ? { vaultProfileRevision: input.vaultProfileRevision } : {}),
          ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
          ...(target.targetChatId ? { targetChatId: target.targetChatId } : {}),
          targetSelection: target.targetSelection,
          outcome,
          ...(knowledge ? { knowledge } : {}),
          ...(skills?.length ? { skills } : {}),
          ...(meeting ? { meeting } : {}),
          ...(problems.length ? { problems } : {}),
          ...(maintenanceIntentKey ? { maintenanceIntentKey } : {}),
          committedAt: input.now,
          lastUpdatedAt: input.now,
          audienceScopeId: input.audienceScopeId,
        };

        const validated = validateWorkspaceSystemReport(report);
        if (!validated.ok) {
          throw new Error(`Invalid WorkspaceSystemReport: ${validated.error}`);
        }

        const reportRevisionId = buildReportRevisionId({
          reportId,
          artifactReceiptIds: collectArtifactReceiptIds(report),
          actualOutcome: outcome,
        });
        const payloadJson = JSON.stringify(report);
        const projectionId = `prj_${randomUUID()}`;

        this.store.database.prepare(
          `INSERT INTO gateway_report_ledger(
            id, autonomous_key, maintenance_intent_key, revision, report_revision_id,
            source, source_job_id, source_run_id, workspace_id, vault_profile_id,
            vault_profile_revision, source_session_id, target_chat_id, target_selection,
            outcome, outcome_rank, audience_scope_id, payload_json, committed_at, last_updated_at
          ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          reportId,
          autonomousKey,
          maintenanceIntentKey ?? null,
          reportRevisionId,
          report.source,
          report.sourceJobId,
          report.sourceRunId ?? null,
          report.workspaceId,
          report.vaultProfileId ?? null,
          report.vaultProfileRevision ?? null,
          report.sourceSessionId ?? null,
          report.targetChatId ?? null,
          report.targetSelection,
          report.outcome,
          OUTCOME_RANK[report.outcome],
          report.audienceScopeId,
          payloadJson,
          report.committedAt,
          report.lastUpdatedAt,
        );

        this.store.database.prepare(
          `INSERT INTO gateway_report_revisions(
            id, report_id, revision, report_revision_id, outcome, payload_json, committed_at
          ) VALUES (?, ?, 1, ?, ?, ?, ?)`,
        ).run(`rev_${randomUUID()}`, reportId, reportRevisionId, report.outcome, payloadJson, input.now);

        this.store.database.prepare(
          `INSERT INTO gateway_chat_projections(
            id, report_id, chat_id, workspace_id, audience_scope_id, target_selection,
            selection_receipt_json, read_only_system_card, exclude_from_model_history,
            exclude_from_learning, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?)`,
        ).run(
          projectionId,
          reportId,
          target.targetChatId ?? null,
          report.workspaceId,
          report.audienceScopeId,
          target.targetSelection,
          JSON.stringify(target.selectionReceipt),
          input.now,
          input.now,
        );

        this.store.recordAudit({
          actor: 'host:autonomous-reports',
          action: 'report.committed',
          resource: `report:${reportId}`,
          outcome: report.outcome,
          metadata: {
            workspaceId: report.workspaceId,
            targetSelection: report.targetSelection,
            targetChatId: report.targetChatId ?? null,
            revision: 1,
          },
          at: input.now,
        });

        const projectionRow = this.store.database
          .prepare('SELECT * FROM gateway_chat_projections WHERE id = ?')
          .get(projectionId) as Record<string, unknown>;

        return {
          report,
          projection: mapProjectionRow(projectionRow),
          deduplicated: false,
          revised: false,
          triggeredPromptSubmitted: false,
          triggeredLearning: false,
        };
      }

      // Existing report: preserve pinned destination, protect against out-of-order outcome regression,
      // and append an immutable revision only when new confirmed receipts or higher outcome settle.
      const existingReport = JSON.parse(String(existingRow.payload_json)) as WorkspaceSystemReport;
      const existingProjectionRow = this.store.database
        .prepare('SELECT * FROM gateway_chat_projections WHERE report_id = ?')
        .get(existingReport.id) as Record<string, unknown>;
      const existingProjection = mapProjectionRow(existingProjectionRow);

      const mergedKnowledge = mergeKnowledgeReceipts(existingReport.knowledge, knowledge);
      const mergedSkills = mergeSkills(existingReport.skills, skills);
      const mergedMeeting = meeting ?? existingReport.meeting;
      const mergedProblems = [...new Set([...(existingReport.problems ?? []), ...problems])];

      const existingRank = OUTCOME_RANK[existingReport.outcome];
      const incomingRank = OUTCOME_RANK[outcome];

      const existingReceipts = new Set(collectArtifactReceiptIds(existingReport));
      const candidateReceipts = collectArtifactReceiptIds({
        knowledge: mergedKnowledge,
        skills: mergedSkills,
        meeting: mergedMeeting,
      });
      const hasNewReceipts = candidateReceipts.some(id => !existingReceipts.has(id));

      // Out-of-order lower outcome without new receipts is deduplicated without regressing state.
      if (incomingRank < existingRank && !hasNewReceipts) {
        return {
          report: existingReport,
          projection: existingProjection,
          deduplicated: true,
          revised: false,
          triggeredPromptSubmitted: false,
          triggeredLearning: false,
        };
      }

      const effectiveOutcome: AutonomousReportOutcome =
        incomingRank >= existingRank ? outcome : existingReport.outcome;

      const nextRevisionId = buildReportRevisionId({
        reportId: existingReport.id,
        artifactReceiptIds: candidateReceipts,
        actualOutcome: effectiveOutcome,
      });

      if (nextRevisionId === String(existingRow.report_revision_id)) {
        return {
          report: existingReport,
          projection: existingProjection,
          deduplicated: true,
          revised: false,
          triggeredPromptSubmitted: false,
          triggeredLearning: false,
        };
      }

      const nextRevision = existingReport.revision + 1;
      const updatedReport: WorkspaceSystemReport = {
        ...existingReport,
        revision: nextRevision,
        outcome: effectiveOutcome,
        ...(mergedKnowledge ? { knowledge: mergedKnowledge } : {}),
        ...(mergedSkills?.length ? { skills: mergedSkills } : {}),
        ...(mergedMeeting ? { meeting: mergedMeeting } : {}),
        ...(mergedProblems.length ? { problems: mergedProblems } : {}),
        lastUpdatedAt: input.now,
      };

      const validated = validateWorkspaceSystemReport(updatedReport);
      if (!validated.ok) {
        throw new Error(`Invalid revised WorkspaceSystemReport: ${validated.error}`);
      }

      const payloadJson = JSON.stringify(updatedReport);
      this.store.database.prepare(
        `INSERT INTO gateway_report_revisions(
          id, report_id, revision, report_revision_id, outcome, payload_json, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(`rev_${randomUUID()}`, updatedReport.id, nextRevision, nextRevisionId, effectiveOutcome, payloadJson, input.now);

      this.store.database.prepare(
        `UPDATE gateway_report_ledger
         SET revision = ?, report_revision_id = ?, outcome = ?, outcome_rank = ?,
             payload_json = ?, last_updated_at = ?
         WHERE id = ?`,
      ).run(
        nextRevision,
        nextRevisionId,
        effectiveOutcome,
        OUTCOME_RANK[effectiveOutcome],
        payloadJson,
        input.now,
        updatedReport.id,
      );

      this.store.database
        .prepare('UPDATE gateway_chat_projections SET updated_at = ? WHERE report_id = ?')
        .run(input.now, updatedReport.id);

      this.store.recordAudit({
        actor: 'host:autonomous-reports',
        action: 'report.revised',
        resource: `report:${updatedReport.id}`,
        outcome: effectiveOutcome,
        metadata: { revision: nextRevision, pinnedChatId: updatedReport.targetChatId ?? null },
        at: input.now,
      });

      const refreshedProjection = this.store.database
        .prepare('SELECT * FROM gateway_chat_projections WHERE report_id = ?')
        .get(updatedReport.id) as Record<string, unknown>;

      return {
        report: updatedReport,
        projection: mapProjectionRow(refreshedProjection),
        deduplicated: false,
        revised: true,
        triggeredPromptSubmitted: false,
        triggeredLearning: false,
      };
    });
  }

  getReport(reportId: string): WorkspaceSystemReport | undefined {
    const row = this.store.database
      .prepare('SELECT payload_json FROM gateway_report_ledger WHERE id = ?')
      .get(reportId) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as WorkspaceSystemReport : undefined;
  }

  listReportRevisions(reportId: string): WorkspaceSystemReport[] {
    const rows = this.store.database
      .prepare('SELECT payload_json FROM gateway_report_revisions WHERE report_id = ? ORDER BY revision ASC')
      .all(reportId) as Array<{ payload_json: string }>;
    return rows.map(r => JSON.parse(r.payload_json) as WorkspaceSystemReport);
  }

  listChatProjections(input: { workspaceId: string; chatId: string | null }): ChatReportProjectionRecord[] {
    const rows = input.chatId === null
      ? this.store.database
        .prepare(
          `SELECT * FROM gateway_chat_projections
           WHERE workspace_id = ? AND chat_id IS NULL
           ORDER BY created_at ASC`,
        )
        .all(input.workspaceId) as Array<Record<string, unknown>>
      : this.store.database
        .prepare(
          `SELECT * FROM gateway_chat_projections
           WHERE workspace_id = ? AND chat_id = ?
           ORDER BY created_at ASC`,
        )
        .all(input.workspaceId, input.chatId) as Array<Record<string, unknown>>;
    return rows.map(mapProjectionRow);
  }

  listWorkspaceReports(workspaceId: string): WorkspaceSystemReport[] {
    const rows = this.store.database
      .prepare('SELECT payload_json FROM gateway_report_ledger WHERE workspace_id = ? ORDER BY committed_at ASC')
      .all(workspaceId) as Array<{ payload_json: string }>;
    return rows.map(r => JSON.parse(r.payload_json) as WorkspaceSystemReport);
  }
}

/**
 * Determines whether a committed report should be suppressed from immediate external push
 * under a route's digest/no-op policy (PRD §11.5, GW-AT-082). Local ledger is always retained.
 */
export function shouldSuppressExternalReportFanout(
  report: WorkspaceSystemReport,
  mode: 'immediate' | 'digest' | 'off',
): boolean {
  if (mode === 'off') return true;
  if (mode === 'immediate') return false;
  // In 'digest' mode, suppress no-op/unchanged reports that have no skill candidates or problems.
  const isNoOp =
    report.outcome === 'skipped'
    || (report.knowledge?.state === 'unchanged'
      && (!report.skills || report.skills.length === 0)
      && (!report.problems || report.problems.length === 0));
  return isNoOp;
}
