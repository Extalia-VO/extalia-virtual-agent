import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  MISSION_EVIDENCE_SOURCE_KINDS,
  MISSION_RECONCILIATION_DECISIONS,
  MISSION_VALIDATION_OUTCOMES,
  MissionAuthorityInputError,
  computeMissionReviewDigest,
  deriveEvidenceAcceptance,
  evaluateMissionTaskGates,
  normalizeGrantMissionWaiverInput,
  normalizeMissionReconciliationCommitInput,
  normalizeRecordMissionEvidenceInput,
  normalizeWaiverId,
  type GrantMissionWaiverInput,
  type HostMissionRun,
  type MissionAcceptanceState,
  type MissionAuthorityOverview,
  type MissionEvidenceRecord,
  type MissionEvidenceSourceKind,
  type MissionReconciliationCommitInput,
  type MissionReconciliationCommitResult,
  type MissionReconciliationDecision,
  type MissionReconciliationPreview,
  type MissionReconciliationReceipt,
  type MissionValidationOutcome,
  type MissionWaiverRecord,
  type MissionWaiverScope,
  type RecordMissionEvidenceInput,
  type WorkerLeaseView,
} from '@extalia/platform';
import type { TaskState } from '@extalia/protocol';
import { readJson, writeJsonAtomic } from './jsonStore.js';
import { ensurePrivateDirectory } from './paths.js';

const STORE_SCHEMA = 'extalia.mission-authority.v1';
const RECEIPT_ID_PATTERN = /^rc-[0-9a-f]{12}$/;
const EVIDENCE_ID_PATTERN = /^ev-[0-9a-f]{12}$/;
const WAIVER_ID_PATTERN = /^wv-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const VALID_RUN_STATES = new Set<HostMissionRun['state']>(['running', 'completed', 'failed', 'cancelled', 'recovering']);
const TERMINAL_TASK_STATES = new Set<TaskState>(['completed', 'failed', 'cancelled']);
const VALID_DECISIONS = new Set<MissionReconciliationDecision>(MISSION_RECONCILIATION_DECISIONS);
const VALID_SOURCE_KINDS = new Set<MissionEvidenceSourceKind>(MISSION_EVIDENCE_SOURCE_KINDS);
const VALID_VALIDATIONS = new Set<MissionValidationOutcome>(MISSION_VALIDATION_OUTCOMES);
const VALID_ACCEPTANCES = new Set<MissionAcceptanceState>(['unverified', 'accepted', 'waived', 'rejected']);
const VALID_WAIVER_SCOPES = new Set<MissionWaiverScope>(['dependency-release', 'mission-acceptance']);

interface StoredMissionAuthorityState {
  schema: typeof STORE_SCHEMA;
  receipts: MissionReconciliationReceipt[];
  evidence: MissionEvidenceRecord[];
  waivers: MissionWaiverRecord[];
}

export class MissionAuthorityStoreError extends Error {
  override name = 'MissionAuthorityStoreError';
}

export interface MissionAuthorityDeps {
  storeFile: string;
  getMission(sessionId: string, missionId: string): HostMissionRun | undefined;
  saveMission(run: HostMissionRun): Promise<void>;
  listWorkerLeases(missionId: string): readonly WorkerLeaseView[];
  isSessionActive(sessionId: string): boolean;
  now?: () => string;
  nowMs?: () => number;
}

export interface MissionAuthorityService {
  previewReconciliation(sessionId: string, missionId: string): Promise<MissionReconciliationPreview>;
  commitReconciliation(input: MissionReconciliationCommitInput): Promise<MissionReconciliationCommitResult>;
  overview(sessionId: string, missionId: string): Promise<MissionAuthorityOverview>;
  recordEvidence(input: RecordMissionEvidenceInput): Promise<MissionAuthorityOverview>;
  grantWaiver(input: GrantMissionWaiverInput): Promise<MissionAuthorityOverview>;
  revokeWaiver(sessionId: string, missionId: string, waiverId: string): Promise<MissionAuthorityOverview>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isSafeRelativePath(value: unknown): value is string {
  if (!isNonEmptyString(value) || value.length > 512) return false;
  if (
    value.startsWith('/')
    || value.startsWith('\\')
    || value.includes('\\')
    || /^[A-Za-z]:/.test(value)
    || value.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    return false;
  }
  return true;
}

function isValidReceipt(raw: unknown): raw is MissionReconciliationReceipt {
  if (!isPlainObject(raw)) return false;
  return isNonEmptyString(raw.receiptId)
    && RECEIPT_ID_PATTERN.test(raw.receiptId)
    && isNonEmptyString(raw.missionId)
    && isNonEmptyString(raw.sessionId)
    && isNonEmptyString(raw.workspaceId)
    && typeof raw.reviewDigest === 'string'
    && SHA256_PATTERN.test(raw.reviewDigest)
    && isNonEmptyString(raw.decisionKey)
    && typeof raw.decision === 'string'
    && VALID_DECISIONS.has(raw.decision as MissionReconciliationDecision)
    && typeof raw.previousState === 'string'
    && VALID_RUN_STATES.has(raw.previousState as HostMissionRun['state'])
    && typeof raw.resultingState === 'string'
    && VALID_RUN_STATES.has(raw.resultingState as HostMissionRun['state'])
    && isNonEmptyString(raw.actor)
    && isNonEmptyString(raw.reason)
    && isIsoTimestamp(raw.committedAt)
    && raw.worktreesReleased === false
    && raw.replayedTasks === false;
}

function isValidEvidence(raw: unknown): raw is MissionEvidenceRecord {
  if (!isPlainObject(raw)) return false;
  if (
    !isNonEmptyString(raw.evidenceId)
    || !EVIDENCE_ID_PATTERN.test(raw.evidenceId)
    || !isNonEmptyString(raw.missionId)
    || !isNonEmptyString(raw.sessionId)
    || !isNonEmptyString(raw.workspaceId)
    || !isNonEmptyString(raw.taskId)
    || typeof raw.sourceKind !== 'string'
    || !VALID_SOURCE_KINDS.has(raw.sourceKind as MissionEvidenceSourceKind)
    || typeof raw.validation !== 'string'
    || !VALID_VALIDATIONS.has(raw.validation as MissionValidationOutcome)
    || typeof raw.acceptance !== 'string'
    || !VALID_ACCEPTANCES.has(raw.acceptance as MissionAcceptanceState)
    || typeof raw.contentSha256 !== 'string'
    || !SHA256_PATTERN.test(raw.contentSha256)
    || (raw.artifactPath !== undefined && !isSafeRelativePath(raw.artifactPath))
    || !isNonEmptyString(raw.summary)
    || !isIsoTimestamp(raw.recordedAt)
    || typeof raw.verifiedByHost !== 'boolean'
  ) {
    return false;
  }
  // Enforce AR-13 invariant on load so tampered observed claims cannot become verified.
  if (raw.sourceKind === 'observed-claim' && (raw.verifiedByHost || raw.acceptance !== 'unverified')) {
    return false;
  }
  return true;
}

function isValidWaiver(raw: unknown): raw is MissionWaiverRecord {
  if (!isPlainObject(raw)) return false;
  return isNonEmptyString(raw.waiverId)
    && WAIVER_ID_PATTERN.test(raw.waiverId)
    && isNonEmptyString(raw.missionId)
    && isNonEmptyString(raw.sessionId)
    && isNonEmptyString(raw.workspaceId)
    && isNonEmptyString(raw.taskId)
    && isNonEmptyString(raw.actor)
    && isNonEmptyString(raw.reason)
    && isNonEmptyString(raw.policyVersion)
    && typeof raw.scope === 'string'
    && VALID_WAIVER_SCOPES.has(raw.scope as MissionWaiverScope)
    && typeof raw.reviewDigest === 'string'
    && SHA256_PATTERN.test(raw.reviewDigest)
    && isIsoTimestamp(raw.grantedAt)
    && isIsoTimestamp(raw.expiresAt)
    && (raw.revokedAt === undefined || isIsoTimestamp(raw.revokedAt));
}

function decodeStore(raw: unknown): StoredMissionAuthorityState {
  if (!isPlainObject(raw)) {
    throw new MissionAuthorityStoreError('Mission authority store has an invalid root value. It was left unchanged.');
  }
  if (Object.keys(raw).some(key => !['schema', 'receipts', 'evidence', 'waivers'].includes(key))) {
    throw new MissionAuthorityStoreError('Mission authority store contains unexpected fields. It was left unchanged.');
  }
  if (raw.schema !== STORE_SCHEMA || !Array.isArray(raw.receipts) || !Array.isArray(raw.evidence) || !Array.isArray(raw.waivers)) {
    throw new MissionAuthorityStoreError('Mission authority store has an invalid schema. It was left unchanged.');
  }
  if (!raw.receipts.every(isValidReceipt) || !raw.evidence.every(isValidEvidence) || !raw.waivers.every(isValidWaiver)) {
    throw new MissionAuthorityStoreError('Mission authority store contains malformed records. It was left unchanged.');
  }
  const receiptIds = new Set<string>();
  const reconciledMissions = new Set<string>();
  for (const receipt of raw.receipts) {
    if (receiptIds.has(receipt.receiptId) || reconciledMissions.has(receipt.missionId)) {
      throw new MissionAuthorityStoreError('Mission authority store contains duplicate reconciliation receipts.');
    }
    receiptIds.add(receipt.receiptId);
    reconciledMissions.add(receipt.missionId);
  }
  if (new Set(raw.evidence.map(item => item.evidenceId)).size !== raw.evidence.length) {
    throw new MissionAuthorityStoreError('Mission authority store contains duplicate evidence identifiers.');
  }
  if (new Set(raw.waivers.map(item => item.waiverId)).size !== raw.waivers.length) {
    throw new MissionAuthorityStoreError('Mission authority store contains duplicate waiver identifiers.');
  }
  return {
    schema: STORE_SCHEMA,
    receipts: structuredClone(raw.receipts),
    evidence: structuredClone(raw.evidence),
    waivers: structuredClone(raw.waivers),
  };
}

function requireIdentifier(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 200) {
    throw new MissionAuthorityInputError(`${field}: expected a non-empty string.`);
  }
  return raw.trim();
}

function evidenceDigestToken(record: MissionEvidenceRecord): string {
  return `${record.evidenceId}:${record.taskId}:${record.sourceKind}:${record.validation}:${record.acceptance}:${record.contentSha256}`;
}

function waiverDigestToken(record: MissionWaiverRecord): string {
  return record.revokedAt ? `${record.waiverId}:revoked` : record.waiverId;
}

class HostMissionAuthorityService implements MissionAuthorityService {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: MissionAuthorityDeps,
    private readonly state: StoredMissionAuthorityState,
  ) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private nowMs(): number {
    if (this.deps.nowMs) return this.deps.nowMs();
    if (this.deps.now) {
      const parsed = Date.parse(this.deps.now());
      if (Number.isFinite(parsed)) return parsed;
    }
    return Date.now();
  }

  private nowIso(): string {
    return this.deps.now ? this.deps.now() : new Date(this.nowMs()).toISOString();
  }

  private async persist(): Promise<void> {
    await ensurePrivateDirectory(path.dirname(this.deps.storeFile));
    await writeJsonAtomic(this.deps.storeFile, this.state, { mode: 0o600 });
  }

  private missionRecords(run: HostMissionRun): {
    receipt?: MissionReconciliationReceipt;
    evidence: MissionEvidenceRecord[];
    waivers: MissionWaiverRecord[];
    leases: readonly WorkerLeaseView[];
    activeLeaseIds: string[];
    quarantinedLeaseIds: string[];
    reviewDigest: string;
  } {
    const receipt = this.state.receipts.find(item => item.missionId === run.id && item.sessionId === run.sessionId);
    const evidence = this.state.evidence.filter(item => item.missionId === run.id && item.sessionId === run.sessionId);
    const waivers = this.state.waivers.filter(item => item.missionId === run.id && item.sessionId === run.sessionId);
    const leases = this.deps.listWorkerLeases(run.id);
    const activeLeaseIds = leases.filter(lease => lease.status === 'active').map(lease => lease.leaseId).sort();
    const quarantinedLeaseIds = leases.filter(lease => lease.status === 'quarantined').map(lease => lease.leaseId).sort();
    const reviewDigest = computeMissionReviewDigest({
      missionId: run.id,
      sessionId: run.sessionId,
      workspaceId: run.workspaceId,
      state: run.state,
      updatedAt: run.updatedAt,
      ...(run.recovery?.source !== undefined ? { recoverySource: run.recovery.source } : {}),
      tasks: run.tasks.map(task => ({
        taskId: task.taskId,
        state: task.state,
        ...(task.verification !== undefined ? { verification: task.verification } : {}),
      })),
      activeLeaseIds,
      quarantinedLeaseIds,
      evidenceDigests: evidence.map(evidenceDigestToken),
      waiverIds: waivers.map(waiverDigestToken),
    });
    return {
      ...(receipt ? { receipt } : {}),
      evidence,
      waivers,
      leases,
      activeLeaseIds,
      quarantinedLeaseIds,
      reviewDigest,
    };
  }

  private buildOverviewLocked(run: HostMissionRun): MissionAuthorityOverview {
    const { receipt, evidence, waivers, reviewDigest } = this.missionRecords(run);
    const { taskGates, verifiedComplete } = evaluateMissionTaskGates(run, evidence, waivers, this.nowMs());
    return {
      missionId: run.id,
      sessionId: run.sessionId,
      workspaceId: run.workspaceId,
      reviewDigest,
      verifiedComplete,
      ...(receipt ? { reconciliationReceipt: structuredClone(receipt) } : {}),
      evidence: structuredClone(evidence),
      waivers: structuredClone(waivers),
      taskGates,
    };
  }

  previewReconciliation(rawSessionId: string, rawMissionId: string): Promise<MissionReconciliationPreview> {
    const sessionId = requireIdentifier(rawSessionId, 'sessionId');
    const missionId = requireIdentifier(rawMissionId, 'missionId');
    return this.serial(async () => {
      const run = this.deps.getMission(sessionId, missionId);
      if (!run) {
        throw new Error('That native mission no longer exists.');
      }
      const { receipt, evidence, waivers, activeLeaseIds, quarantinedLeaseIds, reviewDigest } = this.missionRecords(run);
      const { taskGates } = evaluateMissionTaskGates(run, evidence, waivers, this.nowMs());
      const eligibleDecisions: MissionReconciliationDecision[] = run.state === 'recovering' && !receipt
        ? [...MISSION_RECONCILIATION_DECISIONS]
        : [];
      const warnings: string[] = [
        'Terminal reconciliation never replays interrupted tasks and never releases or discards worker worktrees.',
      ];
      if (activeLeaseIds.length > 0 || quarantinedLeaseIds.length > 0) {
        warnings.push('Active or quarantined worker leases remain attached to this mission and require separate inspection or acknowledgement.');
      }
      if (run.state !== 'recovering') {
        warnings.push(`Mission state is '${run.state}'; terminal reconciliation is only available while recovering.`);
      }
      if (receipt) {
        warnings.push(`A terminal reconciliation receipt (${receipt.decision}) has already been committed.`);
      }
      if (this.deps.isSessionActive(sessionId)) {
        warnings.push('This session currently has active local execution; reconciliation commits are blocked.');
      }
      return {
        missionId: run.id,
        sessionId: run.sessionId,
        workspaceId: run.workspaceId,
        currentState: run.state,
        ...(run.recovery?.source ? { recoverySource: run.recovery.source } : {}),
        reviewDigest,
        taskSummaries: taskGates.map(gate => ({
          id: gate.id,
          taskId: gate.taskId,
          title: gate.title,
          state: gate.state,
          acceptance: gate.acceptance,
          evidenceCount: gate.evidenceCount,
        })),
        activeLeaseIds,
        quarantinedLeaseIds,
        eligibleDecisions,
        ...(receipt ? { existingReceipt: structuredClone(receipt) } : {}),
        warnings,
      };
    });
  }

  commitReconciliation(rawInput: MissionReconciliationCommitInput): Promise<MissionReconciliationCommitResult> {
    const input = normalizeMissionReconciliationCommitInput(rawInput);
    return this.serial(async () => {
      if (this.deps.isSessionActive(input.sessionId)) {
        return {
          ok: false,
          code: 'local-active',
          detail: 'Cannot reconcile a mission while the session has active local execution.',
        };
      }
      const run = this.deps.getMission(input.sessionId, input.missionId);
      if (!run) {
        return {
          ok: false,
          code: 'not-found',
          detail: 'That native mission no longer exists.',
        };
      }

      const { receipt: existingReceipt, reviewDigest: currentReviewDigest } = this.missionRecords(run);
      if (existingReceipt) {
        if (
          existingReceipt.decisionKey === input.decisionKey
          && existingReceipt.reviewDigest === input.expectedReviewDigest
          && existingReceipt.decision === input.decision
        ) {
          return {
            ok: true,
            idempotentReplay: true,
            receipt: structuredClone(existingReceipt),
            run: structuredClone(run),
          };
        }
        return {
          ok: false,
          code: 'already-reconciled',
          currentReviewDigest,
          detail: `Mission ${run.id} was already reconciled with decision '${existingReceipt.decision}'.`,
        };
      }

      if (run.state !== 'recovering') {
        return {
          ok: false,
          code: 'not-recovering',
          currentReviewDigest,
          detail: `Mission ${run.id} is in state '${run.state}', not 'recovering'.`,
        };
      }

      if (currentReviewDigest !== input.expectedReviewDigest) {
        return {
          ok: false,
          code: 'stale-review-digest',
          currentReviewDigest,
          detail: 'Mission state, leases, evidence, or waivers changed since the review digest was computed.',
        };
      }

      const committedAt = this.nowIso();
      let nextRun: HostMissionRun;
      if (input.decision === 'retain-quarantine') {
        nextRun = structuredClone(run);
      } else {
        const targetState = input.decision === 'mark-failed' ? 'failed' : 'cancelled';
        nextRun = {
          ...structuredClone(run),
          state: targetState,
          updatedAt: committedAt,
          tasks: run.tasks.map(task => {
            if (TERMINAL_TASK_STATES.has(task.state)) {
              return structuredClone(task);
            }
            return {
              ...structuredClone(task),
              state: targetState,
            };
          }),
        };
        await this.deps.saveMission(nextRun);
      }

      const receipt: MissionReconciliationReceipt = {
        receiptId: `rc-${randomBytes(6).toString('hex')}`,
        missionId: run.id,
        sessionId: run.sessionId,
        workspaceId: run.workspaceId,
        reviewDigest: currentReviewDigest,
        decisionKey: input.decisionKey,
        decision: input.decision,
        previousState: run.state,
        resultingState: nextRun.state,
        actor: input.actor,
        reason: input.reason,
        committedAt,
        worktreesReleased: false,
        replayedTasks: false,
      };
      this.state.receipts.push(receipt);
      try {
        await this.persist();
      } catch (error) {
        this.state.receipts.pop();
        throw error;
      }
      return {
        ok: true,
        idempotentReplay: false,
        receipt: structuredClone(receipt),
        run: structuredClone(nextRun),
      };
    });
  }

  overview(rawSessionId: string, rawMissionId: string): Promise<MissionAuthorityOverview> {
    const sessionId = requireIdentifier(rawSessionId, 'sessionId');
    const missionId = requireIdentifier(rawMissionId, 'missionId');
    return this.serial(async () => {
      const run = this.deps.getMission(sessionId, missionId);
      if (!run) {
        throw new Error('That native mission no longer exists.');
      }
      return this.buildOverviewLocked(run);
    });
  }

  recordEvidence(rawInput: RecordMissionEvidenceInput): Promise<MissionAuthorityOverview> {
    const input = normalizeRecordMissionEvidenceInput(rawInput);
    return this.serial(async () => {
      const run = this.deps.getMission(input.sessionId, input.missionId);
      if (!run) {
        throw new Error('That native mission no longer exists.');
      }
      const task = run.tasks.find(item => item.taskId === input.taskId);
      if (!task) {
        throw new MissionAuthorityInputError('taskId: does not belong to the specified mission.');
      }
      const { verifiedByHost, acceptance } = deriveEvidenceAcceptance(input.sourceKind, input.validation);
      const record: MissionEvidenceRecord = {
        evidenceId: `ev-${randomBytes(6).toString('hex')}`,
        missionId: run.id,
        sessionId: run.sessionId,
        workspaceId: run.workspaceId,
        taskId: task.taskId,
        sourceKind: input.sourceKind,
        validation: input.validation,
        acceptance,
        contentSha256: input.contentSha256,
        ...(input.artifactPath !== undefined ? { artifactPath: input.artifactPath } : {}),
        summary: input.summary,
        recordedAt: this.nowIso(),
        verifiedByHost,
      };
      this.state.evidence.push(record);
      try {
        await this.persist();
      } catch (error) {
        this.state.evidence.pop();
        throw error;
      }
      return this.buildOverviewLocked(run);
    });
  }

  grantWaiver(rawInput: GrantMissionWaiverInput): Promise<MissionAuthorityOverview> {
    const input = normalizeGrantMissionWaiverInput(rawInput);
    return this.serial(async () => {
      const run = this.deps.getMission(input.sessionId, input.missionId);
      if (!run) {
        throw new Error('That native mission no longer exists.');
      }
      const task = run.tasks.find(item => item.taskId === input.taskId);
      if (!task) {
        throw new MissionAuthorityInputError('taskId: does not belong to the specified mission.');
      }
      const { reviewDigest: currentReviewDigest } = this.missionRecords(run);
      if (currentReviewDigest !== input.expectedReviewDigest) {
        throw new MissionAuthorityInputError(
          `stale-review-digest: expected ${input.expectedReviewDigest}, current ${currentReviewDigest}.`,
        );
      }
      const nowMs = this.nowMs();
      const waiver: MissionWaiverRecord = {
        waiverId: `wv-${randomBytes(6).toString('hex')}`,
        missionId: run.id,
        sessionId: run.sessionId,
        workspaceId: run.workspaceId,
        taskId: task.taskId,
        actor: input.actor,
        reason: input.reason,
        policyVersion: input.policyVersion,
        scope: input.scope,
        reviewDigest: currentReviewDigest,
        grantedAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + input.ttlMs).toISOString(),
      };
      this.state.waivers.push(waiver);
      try {
        await this.persist();
      } catch (error) {
        this.state.waivers.pop();
        throw error;
      }
      return this.buildOverviewLocked(run);
    });
  }

  revokeWaiver(rawSessionId: string, rawMissionId: string, rawWaiverId: string): Promise<MissionAuthorityOverview> {
    const sessionId = requireIdentifier(rawSessionId, 'sessionId');
    const missionId = requireIdentifier(rawMissionId, 'missionId');
    const waiverId = normalizeWaiverId(rawWaiverId);
    return this.serial(async () => {
      const run = this.deps.getMission(sessionId, missionId);
      if (!run) {
        throw new Error('That native mission no longer exists.');
      }
      const waiver = this.state.waivers.find(
        item => item.waiverId === waiverId && item.missionId === run.id && item.sessionId === run.sessionId,
      );
      if (!waiver) {
        throw new MissionAuthorityInputError('waiverId: waiver was not found for this mission.');
      }
      if (waiver.revokedAt === undefined) {
        waiver.revokedAt = this.nowIso();
        try {
          await this.persist();
        } catch (error) {
          delete waiver.revokedAt;
          throw error;
        }
      }
      return this.buildOverviewLocked(run);
    });
  }
}

/**
 * Open the durable host mission authority store (`state/mission-authority.json`).
 * Fails closed on unreadable or malformed JSON without modifying the existing file.
 */
export async function createMissionAuthorityService(deps: MissionAuthorityDeps): Promise<MissionAuthorityService> {
  const stored = await readJson<unknown>(deps.storeFile, undefined);
  const state: StoredMissionAuthorityState = stored === undefined
    ? { schema: STORE_SCHEMA, receipts: [], evidence: [], waivers: [] }
    : decodeStore(stored);
  return new HostMissionAuthorityService(deps, state);
}
