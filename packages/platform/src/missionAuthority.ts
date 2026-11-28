import { canonicalSnapshotJson, sha256Utf8Hex } from '@extalia/core';
import type { TaskState } from '@extalia/protocol';
import type { HostMissionRun } from './missions.js';

/**
 * Browser-safe contracts, pure digest computation, and evidence/waiver gate evaluation for
 * Reviewed Terminal Reconciliation & Accepted Evidence / Waiver Gate (V2-04 / #42, V2-06 / #44).
 *
 * Zero Node built-ins. Enforces AR-07, AR-08, AR-12, and AR-13 cleanly on client and server.
 */

export const MISSION_RECONCILIATION_DECISIONS = [
  'mark-failed',
  'mark-cancelled',
  'retain-quarantine',
] as const;
export type MissionReconciliationDecision = (typeof MISSION_RECONCILIATION_DECISIONS)[number];

export const MISSION_EVIDENCE_SOURCE_KINDS = [
  'command-gate',
  'worktree-diff',
  'test-report',
  'observed-claim',
] as const;
export type MissionEvidenceSourceKind = (typeof MISSION_EVIDENCE_SOURCE_KINDS)[number];

export const MISSION_VALIDATION_OUTCOMES = [
  'not_run',
  'passed',
  'failed',
  'timed_out',
  'cancelled',
  'unknown',
] as const;
export type MissionValidationOutcome = (typeof MISSION_VALIDATION_OUTCOMES)[number];

export type MissionAcceptanceState = 'unverified' | 'accepted' | 'waived' | 'rejected';
export type MissionWaiverScope = 'dependency-release' | 'mission-acceptance';

export interface MissionReconciliationReceipt {
  receiptId: string;
  missionId: string;
  sessionId: string;
  workspaceId: string;
  reviewDigest: string;
  decisionKey: string;
  decision: MissionReconciliationDecision;
  previousState: HostMissionRun['state'];
  resultingState: HostMissionRun['state'];
  actor: string;
  reason: string;
  committedAt: string;
  worktreesReleased: false;
  replayedTasks: false;
}

export interface MissionReconciliationPreview {
  missionId: string;
  sessionId: string;
  workspaceId: string;
  currentState: HostMissionRun['state'];
  recoverySource?: 'host-restart' | 'execution-uncertain';
  reviewDigest: string;
  taskSummaries: Array<{
    id: string;
    taskId: string;
    title: string;
    state: TaskState;
    acceptance: MissionAcceptanceState;
    evidenceCount: number;
  }>;
  activeLeaseIds: string[];
  quarantinedLeaseIds: string[];
  eligibleDecisions: MissionReconciliationDecision[];
  existingReceipt?: MissionReconciliationReceipt;
  warnings: string[];
}

export interface MissionReconciliationCommitInput {
  sessionId: string;
  missionId: string;
  expectedReviewDigest: string;
  decisionKey: string;
  decision: MissionReconciliationDecision;
  actor: string;
  reason: string;
}

export type MissionReconciliationCommitErrorCode =
  | 'stale-review-digest'
  | 'already-reconciled'
  | 'local-active'
  | 'not-recovering'
  | 'invalid-decision'
  | 'not-found';

export type MissionReconciliationCommitResult =
  | {
      ok: true;
      idempotentReplay: boolean;
      receipt: MissionReconciliationReceipt;
      run: HostMissionRun;
    }
  | {
      ok: false;
      code: MissionReconciliationCommitErrorCode;
      currentReviewDigest?: string;
      detail: string;
    };

export interface MissionEvidenceRecord {
  evidenceId: string;
  missionId: string;
  sessionId: string;
  workspaceId: string;
  taskId: string;
  sourceKind: MissionEvidenceSourceKind;
  validation: MissionValidationOutcome;
  acceptance: MissionAcceptanceState;
  contentSha256: string;
  artifactPath?: string;
  summary: string;
  recordedAt: string;
  verifiedByHost: boolean;
}

export interface RecordMissionEvidenceInput {
  sessionId: string;
  missionId: string;
  taskId: string;
  sourceKind: MissionEvidenceSourceKind;
  validation: MissionValidationOutcome;
  contentSha256: string;
  artifactPath?: string;
  summary: string;
}

export interface MissionWaiverRecord {
  waiverId: string;
  missionId: string;
  sessionId: string;
  workspaceId: string;
  taskId: string;
  actor: string;
  reason: string;
  policyVersion: string;
  scope: MissionWaiverScope;
  reviewDigest: string;
  grantedAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface GrantMissionWaiverInput {
  sessionId: string;
  missionId: string;
  taskId: string;
  expectedReviewDigest: string;
  actor: string;
  reason: string;
  policyVersion: string;
  scope: MissionWaiverScope;
  ttlMs?: number;
}

export interface MissionTaskGateEvaluation {
  id: string;
  taskId: string;
  title: string;
  state: TaskState;
  executionOutcome: 'succeeded' | 'failed' | 'cancelled' | 'running' | 'unknown';
  validation: MissionValidationOutcome;
  acceptance: MissionAcceptanceState;
  legacyUnverified: boolean;
  evidenceCount: number;
  activeWaiverId?: string;
  dependencyBlockedBy: string[];
  dependencyReleaseEligible: boolean;
}

export interface MissionAuthorityOverview {
  missionId: string;
  sessionId: string;
  workspaceId: string;
  reviewDigest: string;
  verifiedComplete: boolean;
  reconciliationReceipt?: MissionReconciliationReceipt;
  evidence: MissionEvidenceRecord[];
  waivers: MissionWaiverRecord[];
  taskGates: MissionTaskGateEvaluation[];
}

export const MISSION_AUTHORITY_HOST_METHODS = [
  'previewMissionReconciliation',
  'commitMissionReconciliation',
  'missionAuthorityOverview',
  'recordMissionEvidence',
  'grantMissionWaiver',
  'revokeMissionWaiver',
] as const;

export type MissionAuthorityHostMethod = (typeof MISSION_AUTHORITY_HOST_METHODS)[number];

export const MISSION_WAIVER_MIN_TTL_MS = 60_000;
export const MISSION_WAIVER_MAX_TTL_MS = 7 * 86_400_000;
export const MISSION_WAIVER_DEFAULT_TTL_MS = 3_600_000;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const WAIVER_ID_PATTERN = /^wv-[0-9a-f]{12}$/;
const CONTROL_CHAR_PATTERN = /\p{Cc}/u;
const VALID_DECISIONS = new Set<string>(MISSION_RECONCILIATION_DECISIONS);
const VALID_SOURCE_KINDS = new Set<string>(MISSION_EVIDENCE_SOURCE_KINDS);
const VALID_VALIDATIONS = new Set<string>(MISSION_VALIDATION_OUTCOMES);
const VALID_WAIVER_SCOPES = new Set<string>(['dependency-release', 'mission-acceptance']);

export class MissionAuthorityInputError extends Error {
  override name = 'MissionAuthorityInputError';
}

function invalid(message: string): never {
  throw new MissionAuthorityInputError(message);
}

function cleanText(raw: unknown, field: string, max: number, allowNewlines = false): string {
  if (typeof raw !== 'string') invalid(`${field}: expected a string.`);
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > max) {
    invalid(`${field}: must be 1–${max} characters.`);
  }
  const hasBadChars = allowNewlines
    ? [...trimmed].some(char => {
        const code = char.charCodeAt(0);
        return (code < 32 && code !== 10 && code !== 13) || code === 127;
      })
    : CONTROL_CHAR_PATTERN.test(trimmed);
  if (hasBadChars) {
    invalid(`${field}: contains disallowed control characters.`);
  }
  return trimmed;
}

function normalizeSha256(raw: unknown, field: string): string {
  const value = cleanText(raw, field, 64).toLowerCase();
  if (!SHA256_PATTERN.test(value)) {
    invalid(`${field}: expected lowercase 64-character SHA-256 hex digest.`);
  }
  return value;
}

function normalizeRelativeArtifactPath(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  const value = cleanText(raw, 'artifactPath', 512);
  if (
    value.startsWith('/')
    || value.startsWith('\\')
    || value.includes('\\')
    || /^[A-Za-z]:/.test(value)
    || value.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    invalid('artifactPath: must be a normalized relative path without traversal segments.');
  }
  return value;
}

/** Validate and normalize a reviewed terminal reconciliation commit input. */
export function normalizeMissionReconciliationCommitInput(raw: unknown): MissionReconciliationCommitInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('Commit input must be an object.');
  const input = raw as Record<string, unknown>;
  const decision = typeof input.decision === 'string' && VALID_DECISIONS.has(input.decision)
    ? (input.decision as MissionReconciliationDecision)
    : invalid(`decision: expected one of ${MISSION_RECONCILIATION_DECISIONS.join(', ')}.`);
  return {
    sessionId: cleanText(input.sessionId, 'sessionId', 200),
    missionId: cleanText(input.missionId, 'missionId', 200),
    expectedReviewDigest: normalizeSha256(input.expectedReviewDigest, 'expectedReviewDigest'),
    decisionKey: cleanText(input.decisionKey, 'decisionKey', 160),
    decision,
    actor: cleanText(input.actor, 'actor', 120),
    reason: cleanText(input.reason, 'reason', 1000, true),
  };
}

/** Validate and normalize a mission evidence recording input. */
export function normalizeRecordMissionEvidenceInput(raw: unknown): RecordMissionEvidenceInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('Evidence input must be an object.');
  const input = raw as Record<string, unknown>;
  const sourceKind = typeof input.sourceKind === 'string' && VALID_SOURCE_KINDS.has(input.sourceKind)
    ? (input.sourceKind as MissionEvidenceSourceKind)
    : invalid(`sourceKind: expected one of ${MISSION_EVIDENCE_SOURCE_KINDS.join(', ')}.`);
  const validation = typeof input.validation === 'string' && VALID_VALIDATIONS.has(input.validation)
    ? (input.validation as MissionValidationOutcome)
    : invalid(`validation: expected one of ${MISSION_VALIDATION_OUTCOMES.join(', ')}.`);
  const artifactPath = normalizeRelativeArtifactPath(input.artifactPath);
  return {
    sessionId: cleanText(input.sessionId, 'sessionId', 200),
    missionId: cleanText(input.missionId, 'missionId', 200),
    taskId: cleanText(input.taskId, 'taskId', 200),
    sourceKind,
    validation,
    contentSha256: normalizeSha256(input.contentSha256, 'contentSha256'),
    ...(artifactPath !== undefined ? { artifactPath } : {}),
    summary: cleanText(input.summary, 'summary', 1000, true),
  };
}

/** Validate and normalize an explicit task waiver grant input. */
export function normalizeGrantMissionWaiverInput(raw: unknown): GrantMissionWaiverInput & { ttlMs: number } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('Waiver input must be an object.');
  const input = raw as Record<string, unknown>;
  const scope = typeof input.scope === 'string' && VALID_WAIVER_SCOPES.has(input.scope)
    ? (input.scope as MissionWaiverScope)
    : invalid('scope: expected dependency-release or mission-acceptance.');
  let ttlMs = MISSION_WAIVER_DEFAULT_TTL_MS;
  if (input.ttlMs !== undefined) {
    if (
      typeof input.ttlMs !== 'number'
      || !Number.isInteger(input.ttlMs)
      || input.ttlMs < MISSION_WAIVER_MIN_TTL_MS
      || input.ttlMs > MISSION_WAIVER_MAX_TTL_MS
    ) {
      invalid(`ttlMs: expected integer milliseconds between ${MISSION_WAIVER_MIN_TTL_MS} and ${MISSION_WAIVER_MAX_TTL_MS}.`);
    }
    ttlMs = input.ttlMs;
  }
  return {
    sessionId: cleanText(input.sessionId, 'sessionId', 200),
    missionId: cleanText(input.missionId, 'missionId', 200),
    taskId: cleanText(input.taskId, 'taskId', 200),
    expectedReviewDigest: normalizeSha256(input.expectedReviewDigest, 'expectedReviewDigest'),
    actor: cleanText(input.actor, 'actor', 120),
    reason: cleanText(input.reason, 'reason', 1000, true),
    policyVersion: cleanText(input.policyVersion, 'policyVersion', 64),
    scope,
    ttlMs,
  };
}

export function normalizeWaiverId(raw: unknown): string {
  const value = cleanText(raw, 'waiverId', 64);
  if (!WAIVER_ID_PATTERN.test(value)) {
    invalid('waiverId: expected format wv-<12 lowercase hex chars>.');
  }
  return value;
}

/**
 * Derive host-authoritative acceptance state from evidence source & validation outcome (AR-13).
 * Observed claims can never certify completion or become host-verified evidence.
 */
export function deriveEvidenceAcceptance(
  sourceKind: MissionEvidenceSourceKind,
  validation: MissionValidationOutcome,
): { verifiedByHost: boolean; acceptance: MissionAcceptanceState } {
  if (sourceKind === 'observed-claim') {
    return { verifiedByHost: false, acceptance: 'unverified' };
  }
  if (validation === 'passed') {
    return { verifiedByHost: true, acceptance: 'accepted' };
  }
  if (validation === 'failed' || validation === 'timed_out') {
    return { verifiedByHost: true, acceptance: 'rejected' };
  }
  return { verifiedByHost: true, acceptance: 'unverified' };
}

/** Compute deterministic SHA-256 digest representing exact reviewed mission/lease/evidence/waiver state (AR-07). */
export function computeMissionReviewDigest(input: {
  missionId: string;
  sessionId: string;
  workspaceId: string;
  state: HostMissionRun['state'];
  updatedAt: string;
  recoverySource?: string;
  tasks: ReadonlyArray<{ taskId: string; state: TaskState; verification?: string }>;
  activeLeaseIds: readonly string[];
  quarantinedLeaseIds: readonly string[];
  evidenceDigests: readonly string[];
  waiverIds: readonly string[];
}): string {
  const sortedTasks = [...input.tasks]
    .sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0))
    .map(task => ({
      taskId: task.taskId,
      state: task.state,
      ...(task.verification !== undefined ? { verification: task.verification } : {}),
    }));
  const sortedActive = [...input.activeLeaseIds].sort();
  const sortedQuarantined = [...input.quarantinedLeaseIds].sort();
  const sortedEvidence = [...input.evidenceDigests].sort();
  const sortedWaivers = [...input.waiverIds].sort();
  return sha256Utf8Hex(
    canonicalSnapshotJson({
      missionId: input.missionId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      state: input.state,
      updatedAt: input.updatedAt,
      ...(input.recoverySource !== undefined ? { recoverySource: input.recoverySource } : {}),
      tasks: sortedTasks,
      activeLeaseIds: sortedActive,
      quarantinedLeaseIds: sortedQuarantined,
      evidenceDigests: sortedEvidence,
      waiverIds: sortedWaivers,
    }),
  );
}

function executionOutcomeForTaskState(state: TaskState): MissionTaskGateEvaluation['executionOutcome'] {
  if (state === 'completed') return 'succeeded';
  if (state === 'failed') return 'failed';
  if (state === 'cancelled') return 'cancelled';
  if (state === 'running' || state === 'assigned' || state === 'verifying') return 'running';
  return 'unknown';
}

function isWaiverActive(waiver: MissionWaiverRecord, nowMs: number): boolean {
  if (waiver.revokedAt !== undefined) return false;
  const expiresMs = Date.parse(waiver.expiresAt);
  return Number.isFinite(expiresMs) && expiresMs > nowMs;
}

/**
 * Evaluate per-task acceptance, legacy unverified markers, downstream dependency eligibility,
 * and whole-mission verified completion from explicit evidence & active waivers (AR-12, AR-13).
 */
export function evaluateMissionTaskGates(
  run: HostMissionRun,
  evidence: readonly MissionEvidenceRecord[],
  waivers: readonly MissionWaiverRecord[],
  nowMs: number = Date.now(),
): { taskGates: MissionTaskGateEvaluation[]; verifiedComplete: boolean } {
  const activeWaiversByTask = new Map<string, MissionWaiverRecord[]>();
  for (const waiver of waivers) {
    if (waiver.missionId !== run.id || !isWaiverActive(waiver, nowMs)) continue;
    const list = activeWaiversByTask.get(waiver.taskId) ?? [];
    list.push(waiver);
    activeWaiversByTask.set(waiver.taskId, list);
  }

  const evidenceByTask = new Map<string, MissionEvidenceRecord[]>();
  for (const item of evidence) {
    if (item.missionId !== run.id) continue;
    const list = evidenceByTask.get(item.taskId) ?? [];
    list.push(item);
    evidenceByTask.set(item.taskId, list);
  }

  // First pass computes individual validation/acceptance + active waiver scopes.
  const baseEvalByAlias = new Map<string, {
    evaluation: Omit<MissionTaskGateEvaluation, 'dependencyBlockedBy' | 'dependencyReleaseEligible'>;
    activeWaiverScopes: Set<MissionWaiverScope>;
  }>();

  for (const task of run.tasks) {
    const taskEvidence = evidenceByTask.get(task.taskId) ?? [];
    const hostEvidence = taskEvidence.filter(item => item.verifiedByHost && item.sourceKind !== 'observed-claim');
    const latestHostEvidence = hostEvidence.at(-1);
    const activeWaivers = activeWaiversByTask.get(task.taskId) ?? [];
    const activeWaiver = activeWaivers.at(-1);
    const activeWaiverScopes = new Set<MissionWaiverScope>(activeWaivers.map(w => w.scope));

    const legacyUnverified = hostEvidence.length === 0 && !activeWaiver;
    let validation: MissionValidationOutcome = latestHostEvidence ? latestHostEvidence.validation : 'not_run';
    let acceptance: MissionAcceptanceState = latestHostEvidence ? latestHostEvidence.acceptance : 'unverified';

    if (hostEvidence.some(item => item.acceptance === 'rejected')) {
      const latestFailure = [...hostEvidence].reverse().find(item => item.acceptance === 'rejected')!;
      validation = latestFailure.validation;
      acceptance = 'rejected';
    }

    if (activeWaiver) {
      acceptance = 'waived';
    }

    baseEvalByAlias.set(task.id, {
      evaluation: {
        id: task.id,
        taskId: task.taskId,
        title: task.title,
        state: task.state,
        executionOutcome: executionOutcomeForTaskState(task.state),
        validation,
        acceptance,
        legacyUnverified,
        evidenceCount: taskEvidence.length,
        ...(activeWaiver ? { activeWaiverId: activeWaiver.waiverId } : {}),
      },
      activeWaiverScopes,
    });
  }

  const taskGates: MissionTaskGateEvaluation[] = run.tasks.map(task => {
    const own = baseEvalByAlias.get(task.id)!;
    const dependencyBlockedBy: string[] = [];
    for (const depAlias of task.dependsOn ?? []) {
      const upstream = baseEvalByAlias.get(depAlias);
      if (!upstream) {
        dependencyBlockedBy.push(depAlias);
        continue;
      }
      const upstreamAccepted = upstream.evaluation.state === 'completed'
        && (
          upstream.evaluation.acceptance === 'accepted'
          || (upstream.evaluation.acceptance === 'waived'
            && (upstream.activeWaiverScopes.has('dependency-release') || upstream.activeWaiverScopes.has('mission-acceptance')))
        );
      if (!upstreamAccepted) {
        dependencyBlockedBy.push(depAlias);
      }
    }

    return {
      ...own.evaluation,
      dependencyBlockedBy,
      dependencyReleaseEligible: dependencyBlockedBy.length === 0,
    };
  });

  const verifiedComplete = run.state === 'completed'
    && taskGates.length > 0
    && taskGates.every(gate => {
      if (gate.state !== 'completed') return false;
      if (gate.acceptance === 'accepted') return true;
      const meta = baseEvalByAlias.get(gate.id);
      return gate.acceptance === 'waived' && Boolean(meta?.activeWaiverScopes.has('mission-acceptance'));
    });

  return { taskGates, verifiedComplete };
}
