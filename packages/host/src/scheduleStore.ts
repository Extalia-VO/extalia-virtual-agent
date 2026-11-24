/** Transactional SQLite schedule catalog and durable occurrence ledger (ADR 0097). */
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, lstatSync, openSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  GENERAL_SCHEDULE_LIMITS,
  isScheduleDeliveryState,
  isScheduleRunState,
  isScheduleVerificationState,
  normalizeSaveGeneralSchedule,
  normalizeScheduleAgentAssignment,
  normalizeScheduleReviewDecision,
  normalizeScheduleRunFilter,
  normalizeScheduleSessionTarget,
  normalizeScheduleTrigger,
  type GeneralSchedule,
  type ScheduleDeliveryState,
  type ScheduleDeliveryV1,
  type ScheduleOccurrenceKind,
  type ScheduleReviewAction,
  type ScheduleReviewDecision,
  type ScheduleRunDetail,
  type ScheduleRunFilter,
  type ScheduleRunPage,
  type ScheduleRunState,
  type ScheduleRunV1,
  type ScheduleVerificationState,
} from '@extalia/platform';
import { isNotFound } from './jsonStore.js';
import { ensurePrivateDirectory, PRIVATE_FILE_MODE } from './paths.js';

export const SCHEDULE_STORE_SCHEMA_VERSION = 1;
export const LEGACY_SCHEDULE_JSON_SCHEMA = 'extalia.schedules.v1';
export const MAX_PROMPT_CREATIONS = 1024;
export const MAX_RECOVERY_ATTEMPTS = 4;

export interface ScheduleRetryContext {
  sessionId: string;
  historySha256: string;
}

export interface PromptCreationReceipt {
  scheduleId: string;
  fingerprint: string;
  invalidated: boolean;
}

export interface RecoveryReceipt {
  scheduleId: string;
  reason: 'busy' | 'connection-unavailable';
  dueAt: string;
  retryAt: string;
  attempt: number;
  retryContext?: ScheduleRetryContext;
  runId?: string;
}

export interface LegacySchedulePayload {
  schedules: GeneralSchedule[];
  promptCreations: PromptCreationReceipt[];
  recoveries: RecoveryReceipt[];
  sha256: string;
  rawBytes: Buffer;
}

export interface LegacyMigrationResult {
  migrated: boolean;
  alreadyMigrated: boolean;
  backupPath?: string;
  hostTimeZone?: string;
  sourceSha256?: string;
  importedSchedules: number;
}

export interface StoredScheduleCatalogState {
  schedules: GeneralSchedule[];
  promptCreations: PromptCreationReceipt[];
  recoveries: RecoveryReceipt[];
  triggerGenerations: Map<string, number>;
}

export interface AdmitScheduleOccurrenceInput {
  scheduleId: string;
  scheduleRevision: number;
  occurrenceKey: string;
  occurrenceKind: ScheduleOccurrenceKind;
  scheduledFor: string;
  requestedAt?: string;
  workspaceId: string;
  runtimeId?: string;
  sessionId?: string;
  nowIso: string;
  /** Must be true to transition a `deferred` run back into `admitting`. */
  safeNoWorkProof?: boolean;
}

export type AdmitScheduleOccurrenceResult =
  | { admitted: true; run: ScheduleRunV1 }
  | { admitted: false; reason: 'already-exists' | 'missing-no-work-proof'; existingRun: ScheduleRunV1 };

export interface TurnBindingInput {
  expectedRevision?: number;
  sessionId: string;
  turnId?: string;
  correlationId?: string;
  executionGeneration?: string;
  runtimeId?: string;
  nowIso?: string;
}

export interface TurnSettlementMatch {
  runId?: string;
  sessionId: string;
  turnId?: string;
  correlationId?: string;
  executionGeneration?: string;
}

export interface TurnSettlementDetails {
  statusReason?: string;
  terminalEvidenceRef?: string;
  nowIso?: string;
}

export interface VerificationDetails {
  evidenceRef?: string;
  statusReason?: string;
  nowIso?: string;
}

export interface RecordDeliveryInput {
  id?: string;
  runId: string;
  destinationBindingId: string;
  destinationRevision: number;
  notificationKind: string;
  targetGuildId: string;
  targetChannelId: string;
  targetThreadId?: string;
  payloadDigest: string;
  state?: ScheduleDeliveryState;
  attemptCount?: number;
  discordMessageId?: string;
  lastErrorCode?: string;
  acknowledgedAt?: string;
  nowIso?: string;
}

export class ScheduleStoreDowngradeError extends Error {
  readonly code = 'SCHEDULE_STORE_DOWNGRADE_REFUSED';
  constructor(readonly foundVersion: number, readonly supportedVersion: number) {
    super(
      `Refused unsafe downgrade: schedule store schema version ${foundVersion} is newer than supported version ${supportedVersion}. `
      + 'Keep the newer database read-only or restore a compatible backup while the Host is stopped.',
    );
    this.name = 'ScheduleStoreDowngradeError';
  }
}

export class ScheduleStoreCorruptionError extends Error {
  readonly code = 'SCHEDULE_STORE_CORRUPT';
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleStoreCorruptionError';
  }
}

const SCHEMA_V1 = [
  `CREATE TABLE schedule_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE schedules (
    id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('once', 'interval', 'cron')),
    trigger_json TEXT NOT NULL,
    trigger_generation INTEGER NOT NULL DEFAULT 1 CHECK (trigger_generation >= 1),
    session_target_json TEXT NOT NULL,
    bound_session_id TEXT,
    assignment_json TEXT NOT NULL,
    missed_policy TEXT NOT NULL CHECK (missed_policy IN ('skip', 'run-once')),
    state TEXT NOT NULL CHECK (state IN ('scheduled', 'paused', 'running', 'completed', 'failed')),
    next_run_at TEXT,
    last_run_at TEXT,
    last_outcome TEXT CHECK (last_outcome IS NULL OR last_outcome IN ('succeeded', 'failed', 'skipped-busy', 'missed', 'deferred-connection')),
    last_error TEXT,
    last_session_id TEXT,
    run_count INTEGER NOT NULL DEFAULT 0 CHECK (run_count >= 0),
    legacy_dispatch_count INTEGER CHECK (legacy_dispatch_count IS NULL OR legacy_dispatch_count >= 0),
    completed_run_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_run_count >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX schedules_workspace_idx ON schedules(workspace_id, created_at, id)`,
  `CREATE TABLE schedule_runs (
    id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    schedule_id TEXT NOT NULL,
    schedule_revision INTEGER NOT NULL CHECK (schedule_revision >= 1),
    occurrence_key TEXT NOT NULL UNIQUE,
    occurrence_kind TEXT NOT NULL CHECK (occurrence_kind IN ('automatic', 'manual', 'catch-up')),
    scheduled_for TEXT NOT NULL,
    requested_at TEXT,
    workspace_id TEXT NOT NULL,
    runtime_id TEXT,
    session_id TEXT,
    turn_id TEXT,
    correlation_id TEXT,
    execution_generation TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending', 'admitting', 'deferred', 'dispatched', 'running', 'completed', 'failed', 'cancelled', 'blocked', 'unknown')),
    admitted_at TEXT,
    settled_at TEXT,
    verification TEXT NOT NULL DEFAULT 'not-checked' CHECK (verification IN ('not-checked', 'passed', 'failed')),
    verification_evidence_ref TEXT,
    terminal_evidence_ref TEXT,
    status_reason TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 0),
    review_decision TEXT CHECK (review_decision IS NULL OR review_decision IN ('acknowledge', 'mark-resolved', 'dismiss-for-new-run')),
    reviewed_at TEXT,
    review_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX schedule_runs_workspace_idx ON schedule_runs(workspace_id, created_at DESC, id DESC)`,
  `CREATE INDEX schedule_runs_schedule_idx ON schedule_runs(schedule_id, created_at DESC, id DESC)`,
  `CREATE INDEX schedule_runs_state_idx ON schedule_runs(state, updated_at)`,
  `CREATE INDEX schedule_runs_session_idx ON schedule_runs(session_id, correlation_id)`,
  `CREATE TABLE schedule_deliveries (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES schedule_runs(id),
    destination_binding_id TEXT NOT NULL,
    destination_revision INTEGER NOT NULL CHECK (destination_revision >= 1),
    notification_kind TEXT NOT NULL,
    target_guild_id TEXT NOT NULL,
    target_channel_id TEXT NOT NULL,
    target_thread_id TEXT,
    payload_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'unknown', 'cancelled')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    discord_message_id TEXT,
    last_error_code TEXT,
    acknowledged_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (run_id, destination_revision, notification_kind)
  ) STRICT`,
  `CREATE INDEX schedule_deliveries_run_idx ON schedule_deliveries(run_id, created_at)`,
  `CREATE TABLE schedule_prompt_creations (
    sort_order INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL,
    invalidated INTEGER NOT NULL CHECK (invalidated IN (0, 1))
  ) STRICT`,
  `CREATE TABLE schedule_recoveries (
    schedule_id TEXT PRIMARY KEY NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    reason TEXT NOT NULL CHECK (reason IN ('busy', 'connection-unavailable')),
    due_at TEXT NOT NULL,
    retry_at TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    retry_context_json TEXT,
    run_id TEXT
  ) STRICT`,
] as const;

const ALLOWED_RUN_TRANSITIONS: Record<ScheduleRunState, readonly ScheduleRunState[]> = {
  pending: ['admitting', 'cancelled', 'blocked'],
  admitting: ['dispatched', 'deferred', 'blocked', 'failed', 'unknown'],
  deferred: ['admitting', 'failed', 'cancelled', 'blocked'],
  dispatched: ['running', 'completed', 'failed', 'cancelled', 'unknown'],
  running: ['completed', 'failed', 'cancelled', 'unknown'],
  completed: [],
  failed: [],
  cancelled: [],
  blocked: [],
  unknown: [],
};

const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

export function buildAutomaticOccurrenceKey(scheduleId: string, occurrenceUtc: string, triggerGeneration: number): string {
  return `auto:${scheduleId}:${occurrenceUtc}:g${triggerGeneration}`;
}

export function buildManualOccurrenceKey(scheduleId: string, operatorRequestId: string): string {
  return `manual:${scheduleId}:${operatorRequestId}`;
}

export function decodeScheduleRetryContext(raw: unknown): ScheduleRetryContext {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid schedule retry context.');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== 'sessionId' && key !== 'historySha256')
    || typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 160
    || value.sessionId.trim() !== value.sessionId || /\p{Cc}/u.test(value.sessionId)
    || typeof value.historySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.historySha256)) {
    throw new Error('Invalid schedule retry context.');
  }
  return { sessionId: value.sessionId, historySha256: value.historySha256 };
}

export function decodeStoredSchedule(raw: unknown): GeneralSchedule {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid schedule entry.');
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== 'string' || !item.id || !Number.isSafeInteger(item.revision) || Number(item.revision) < 1) {
    throw new Error('Invalid schedule identity.');
  }
  const normalized = normalizeSaveGeneralSchedule({
    id: item.id,
    expectedRevision: Number(item.revision),
    workspaceId: item.workspaceId,
    name: item.name,
    prompt: item.prompt,
    enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
    trigger: normalizeScheduleTrigger(item.trigger),
    sessionTarget: normalizeScheduleSessionTarget(item.sessionTarget),
    assignment: normalizeScheduleAgentAssignment(item.assignment),
    missedPolicy: item.missedPolicy === 'run-once' ? 'run-once' : 'skip',
  });
  const state = ['scheduled', 'paused', 'running', 'completed', 'failed'].includes(String(item.state))
    ? (item.state as GeneralSchedule['state'])
    : normalized.enabled ? 'scheduled' : 'paused';
  const lastOutcome = ['succeeded', 'failed', 'skipped-busy', 'deferred-connection', 'missed'].includes(String(item.lastOutcome))
    ? (item.lastOutcome as NonNullable<GeneralSchedule['lastOutcome']>)
    : undefined;
  return {
    id: item.id,
    revision: Number(item.revision),
    workspaceId: normalized.workspaceId,
    name: normalized.name,
    prompt: normalized.prompt,
    enabled: normalized.enabled ?? true,
    trigger: normalized.trigger,
    sessionTarget: normalized.sessionTarget,
    ...(typeof item.boundSessionId === 'string' && item.boundSessionId ? { boundSessionId: item.boundSessionId } : {}),
    assignment: normalized.assignment ?? { teamMode: 'workspace' },
    missedPolicy: normalized.missedPolicy ?? 'skip',
    state,
    ...(typeof item.nextRunAt === 'string' && Number.isFinite(Date.parse(item.nextRunAt)) ? { nextRunAt: item.nextRunAt } : {}),
    ...(typeof item.lastRunAt === 'string' && Number.isFinite(Date.parse(item.lastRunAt)) ? { lastRunAt: item.lastRunAt } : {}),
    ...(lastOutcome ? { lastOutcome } : {}),
    ...(typeof item.lastError === 'string' && item.lastError ? { lastError: item.lastError.slice(0, 500) } : {}),
    ...(typeof item.lastSessionId === 'string' && item.lastSessionId ? { lastSessionId: item.lastSessionId } : {}),
    runCount: Number.isSafeInteger(item.runCount) && Number(item.runCount) >= 0 ? Number(item.runCount) : 0,
    ...(Number.isSafeInteger(item.legacyDispatchCount) && Number(item.legacyDispatchCount) >= 0 ? { legacyDispatchCount: Number(item.legacyDispatchCount) } : {}),
    ...(Number.isSafeInteger(item.completedRunCount) && Number(item.completedRunCount) >= 0 ? { completedRunCount: Number(item.completedRunCount) } : {}),
    createdAt: typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt)) ? item.createdAt : new Date(0).toISOString(),
    updatedAt: typeof item.updatedAt === 'string' && Number.isFinite(Date.parse(item.updatedAt)) ? item.updatedAt : new Date(0).toISOString(),
  };
}

/** Read and strictly validate a legacy `schedules.json` file. Returns `undefined` if not found. */
export async function readLegacyScheduleJsonFile(filePath: string): Promise<LegacySchedulePayload | undefined> {
  let handle;
  try {
    handle = await open(filePath, 'r');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  let rawBytes: Buffer;
  let raw: unknown;
  try {
    const buffer = Buffer.alloc(GENERAL_SCHEDULE_LIMITS.storeBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > GENERAL_SCHEDULE_LIMITS.storeBytes) throw new Error('Schedule store exceeds its size limit.');
    rawBytes = buffer.subarray(0, total);
    raw = JSON.parse(rawBytes.toString('utf8'));
  } finally {
    await handle.close();
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid schedule store.');
  const value = raw as Record<string, unknown>;
  if (value.schema !== LEGACY_SCHEDULE_JSON_SCHEMA || !Array.isArray(value.schedules) || value.schedules.length > GENERAL_SCHEDULE_LIMITS.schedules) {
    throw new Error('Invalid schedule store schema.');
  }
  const items = value.schedules.map(decodeStoredSchedule);
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('Duplicate schedule ids.');
  const rawReceipts = value.promptCreations ?? [];
  if (!Array.isArray(rawReceipts) || rawReceipts.length > MAX_PROMPT_CREATIONS) throw new Error('Invalid prompt schedule receipt ledger.');
  const promptCreations = rawReceipts.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid prompt schedule receipt.');
    const receipt = entry as Record<string, unknown>;
    if (typeof receipt.scheduleId !== 'string' || !/^sch_[a-f0-9]{64}$/.test(receipt.scheduleId)
      || typeof receipt.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.fingerprint)
      || typeof receipt.invalidated !== 'boolean') {
      throw new Error('Invalid prompt schedule receipt.');
    }
    if (!receipt.invalidated && !items.some(item => item.id === receipt.scheduleId)) {
      throw new Error('A prompt schedule receipt is missing its job.');
    }
    return { scheduleId: receipt.scheduleId, fingerprint: receipt.fingerprint, invalidated: receipt.invalidated };
  });
  if (new Set(promptCreations.map(receipt => receipt.scheduleId)).size !== promptCreations.length) {
    throw new Error('Duplicate prompt schedule receipts.');
  }
  const rawRecoveries = value.recoveries ?? [];
  if (!Array.isArray(rawRecoveries) || rawRecoveries.length > GENERAL_SCHEDULE_LIMITS.schedules) {
    throw new Error('Invalid schedule recovery ledger.');
  }
  const recoveries = rawRecoveries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid schedule recovery receipt.');
    const item = entry as Record<string, unknown>;
    const job = items.find(candidate => candidate.id === item.scheduleId);
    const reason = item.reason === undefined ? 'busy' : item.reason;
    if (!job || !job.enabled || (reason !== 'busy' && reason !== 'connection-unavailable') || (job.trigger.kind === 'once' && reason === 'busy') || job.missedPolicy !== 'run-once'
      || !['scheduled', 'running'].includes(job.state) || typeof item.dueAt !== 'string' || !Number.isFinite(Date.parse(item.dueAt))
      || typeof item.retryAt !== 'string' || !Number.isFinite(Date.parse(item.retryAt)) || job.nextRunAt !== item.retryAt
      || !Number.isSafeInteger(item.attempt) || Number(item.attempt) < 1 || Number(item.attempt) > MAX_RECOVERY_ATTEMPTS) {
      throw new Error('Invalid schedule recovery receipt.');
    }
    const retryContext = item.retryContext === undefined ? undefined : decodeScheduleRetryContext(item.retryContext);
    return {
      scheduleId: job.id,
      reason: reason as 'busy' | 'connection-unavailable',
      dueAt: item.dueAt,
      retryAt: item.retryAt,
      attempt: Number(item.attempt),
      ...(retryContext ? { retryContext } : {}),
    };
  });
  if (new Set(recoveries.map(item => item.scheduleId)).size !== recoveries.length) {
    throw new Error('Duplicate schedule recoveries.');
  }
  return {
    schedules: items,
    promptCreations,
    recoveries,
    sha256: sha256(rawBytes),
    rawBytes,
  };
}

function enforcePrivateFiles(file: string): void {
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      const info = lstatSync(candidate);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new ScheduleStoreCorruptionError(`Schedule store path is not a regular file: ${path.basename(candidate)}.`);
      }
      if (process.platform !== 'win32') chmodSync(candidate, PRIVATE_FILE_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

async function writeImmutableBackup(backupPath: string, bytes: Buffer): Promise<void> {
  await ensurePrivateDirectory(path.dirname(backupPath));
  try {
    const info = lstatSync(backupPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new ScheduleStoreCorruptionError('Legacy schedule backup path is not a regular file.');
    }
    if (process.platform !== 'win32') chmodSync(backupPath, PRIVATE_FILE_MODE);
    // Preserve any existing immutable backup untouched.
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(backupPath, flags, PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== 'win32') chmodSync(backupPath, PRIVATE_FILE_MODE);
}

interface ScheduleRow {
  id: string;
  revision: number;
  workspace_id: string;
  name: string;
  prompt: string;
  enabled: number;
  trigger_kind: string;
  trigger_json: string;
  trigger_generation: number;
  session_target_json: string;
  bound_session_id: string | null;
  assignment_json: string;
  missed_policy: string;
  state: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_outcome: string | null;
  last_error: string | null;
  last_session_id: string | null;
  run_count: number;
  legacy_dispatch_count: number | null;
  completed_run_count: number;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  revision: number;
  schedule_id: string;
  schedule_revision: number;
  occurrence_key: string;
  occurrence_kind: string;
  scheduled_for: string;
  requested_at: string | null;
  workspace_id: string;
  runtime_id: string | null;
  session_id: string | null;
  turn_id: string | null;
  correlation_id: string | null;
  execution_generation: string | null;
  state: string;
  admitted_at: string | null;
  settled_at: string | null;
  verification: string;
  verification_evidence_ref: string | null;
  terminal_evidence_ref: string | null;
  status_reason: string | null;
  attempt_count: number;
  review_decision: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
}

interface DeliveryRow {
  id: string;
  run_id: string;
  destination_binding_id: string;
  destination_revision: number;
  notification_kind: string;
  target_guild_id: string;
  target_channel_id: string;
  target_thread_id: string | null;
  payload_digest: string;
  state: string;
  attempt_count: number;
  discord_message_id: string | null;
  last_error_code: string | null;
  acknowledged_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRun(row: RunRow): ScheduleRunV1 {
  return {
    id: row.id,
    revision: row.revision,
    scheduleId: row.schedule_id,
    scheduleRevision: row.schedule_revision,
    occurrenceKey: row.occurrence_key,
    occurrenceKind: row.occurrence_kind as ScheduleOccurrenceKind,
    scheduledFor: row.scheduled_for,
    ...(row.requested_at !== null ? { requestedAt: row.requested_at } : {}),
    workspaceId: row.workspace_id,
    ...(row.runtime_id !== null ? { runtimeId: row.runtime_id } : {}),
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    ...(row.turn_id !== null ? { turnId: row.turn_id } : {}),
    ...(row.correlation_id !== null ? { correlationId: row.correlation_id } : {}),
    ...(row.execution_generation !== null ? { executionGeneration: row.execution_generation } : {}),
    state: row.state as ScheduleRunState,
    ...(row.admitted_at !== null ? { admittedAt: row.admitted_at } : {}),
    ...(row.settled_at !== null ? { settledAt: row.settled_at } : {}),
    verification: row.verification as ScheduleVerificationState,
    ...(row.verification_evidence_ref !== null ? { verificationEvidenceRef: row.verification_evidence_ref } : {}),
    ...(row.terminal_evidence_ref !== null ? { terminalEvidenceRef: row.terminal_evidence_ref } : {}),
    ...(row.status_reason !== null ? { statusReason: row.status_reason } : {}),
    attemptCount: row.attempt_count,
    ...(row.review_decision !== null ? { reviewDecision: row.review_decision as ScheduleReviewAction } : {}),
    ...(row.reviewed_at !== null ? { reviewedAt: row.reviewed_at } : {}),
    ...(row.review_note !== null ? { reviewNote: row.review_note } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToDelivery(row: DeliveryRow): ScheduleDeliveryV1 {
  return {
    id: row.id,
    runId: row.run_id,
    destinationBindingId: row.destination_binding_id,
    destinationRevision: row.destination_revision,
    notificationKind: row.notification_kind,
    targetGuildId: row.target_guild_id,
    targetChannelId: row.target_channel_id,
    ...(row.target_thread_id !== null ? { targetThreadId: row.target_thread_id } : {}),
    payloadDigest: row.payload_digest,
    state: row.state as ScheduleDeliveryState,
    attemptCount: row.attempt_count,
    ...(row.discord_message_id !== null ? { discordMessageId: row.discord_message_id } : {}),
    ...(row.last_error_code !== null ? { lastErrorCode: row.last_error_code } : {}),
    ...(row.acknowledged_at !== null ? { acknowledgedAt: row.acknowledged_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string' || !parsed.createdAt || !parsed.id) {
      throw new Error('Malformed cursor.');
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new Error('Invalid schedule run pagination cursor.');
  }
}

export class ScheduleStore {
  private closed = false;

  private constructor(private readonly db: DatabaseSync, readonly filePath: string) {}

  static async open(filePath: string): Promise<ScheduleStore> {
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0') || filePath === ':memory:') {
      throw new ScheduleStoreCorruptionError('Invalid schedule store path.');
    }
    const location = path.resolve(filePath);
    await ensurePrivateDirectory(path.dirname(location));
    let existed = false;
    try {
      const info = lstatSync(location);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new ScheduleStoreCorruptionError('Schedule store path is not a regular file.');
      }
      existed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    let db: DatabaseSync | undefined;
    try {
      if (!existed) {
        const descriptor = openSync(location, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), PRIVATE_FILE_MODE);
        closeSync(descriptor);
      } else {
        enforcePrivateFiles(location);
      }
      db = new DatabaseSync(location);
      const store = new ScheduleStore(db, location);
      store.initialize();
      return store;
    } catch (error) {
      try { db?.close(); } catch { /* Preserve original open error. */ }
      if (error instanceof ScheduleStoreDowngradeError || error instanceof ScheduleStoreCorruptionError) throw error;
      throw new ScheduleStoreCorruptionError(
        `Schedule SQLite store is unavailable or corrupt: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private initialize(): void {
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');

    // Read-only version check BEFORE any write or WAL switch so a newer DB is never mutated (SCH-AT-33).
    const versionRow = this.db.prepare('PRAGMA user_version').all()[0];
    const userVersion = Number(versionRow?.user_version ?? 0);
    if (!Number.isSafeInteger(userVersion) || userVersion < 0) {
      throw new ScheduleStoreCorruptionError('Invalid schedule store user_version.');
    }
    if (userVersion > SCHEDULE_STORE_SCHEMA_VERSION) {
      throw new ScheduleStoreDowngradeError(userVersion, SCHEDULE_STORE_SCHEMA_VERSION);
    }

    const objects = this.db
      .prepare("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
      .all() as Array<{ type: string; name: string }>;
    const hasMetaTable = objects.some(obj => obj.type === 'table' && obj.name === 'schedule_meta');
    if (hasMetaTable) {
      const metaVersionRow = this.db
        .prepare("SELECT value FROM schedule_meta WHERE key = 'schema_version'")
        .all()[0] as { value?: unknown } | undefined;
      if (metaVersionRow?.value !== undefined) {
        const parsedMetaVersion = Number(metaVersionRow.value);
        if (!Number.isSafeInteger(parsedMetaVersion) || parsedMetaVersion < 1) {
          throw new ScheduleStoreCorruptionError('Corrupt schema_version metadata in schedule store.');
        }
        if (parsedMetaVersion > SCHEDULE_STORE_SCHEMA_VERSION) {
          throw new ScheduleStoreDowngradeError(parsedMetaVersion, SCHEDULE_STORE_SCHEMA_VERSION);
        }
      }
    }

    if (userVersion === 0 && objects.length === 0) {
      this.transaction(() => {
        for (const sql of SCHEMA_V1) this.db.exec(sql);
        this.db.prepare("INSERT INTO schedule_meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEDULE_STORE_SCHEMA_VERSION));
        this.db.exec(`PRAGMA user_version = ${SCHEDULE_STORE_SCHEMA_VERSION}`);
      });
    } else if (userVersion !== SCHEDULE_STORE_SCHEMA_VERSION) {
      throw new ScheduleStoreCorruptionError(`Unexpected schedule store schema version ${userVersion}.`);
    } else {
      const requiredTables = new Set([
        'schedule_meta',
        'schedules',
        'schedule_runs',
        'schedule_deliveries',
        'schedule_prompt_creations',
        'schedule_recoveries',
      ]);
      const presentTables = new Set(objects.filter(obj => obj.type === 'table').map(obj => obj.name));
      for (const required of requiredTables) {
        if (!presentTables.has(required)) {
          throw new ScheduleStoreCorruptionError(`Schedule store is missing required table "${required}".`);
        }
      }
    }

    const integrity = this.db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== 'ok') {
      throw new ScheduleStoreCorruptionError('Schedule store failed SQLite integrity_check.');
    }
    const fkIssues = this.db.prepare('PRAGMA foreign_key_check').all();
    if (fkIssues.length > 0) {
      throw new ScheduleStoreCorruptionError('Schedule store failed SQLite foreign_key_check.');
    }

    const journalMode = this.db.prepare('PRAGMA journal_mode = WAL').all()[0]?.journal_mode;
    if (journalMode !== 'wal') {
      throw new ScheduleStoreCorruptionError('Schedule store could not enable WAL journal mode.');
    }
    this.db.exec('PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 1000;');
    enforcePrivateFiles(this.filePath);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Schedule store is closed.');
  }

  private transaction<T>(operation: () => T): T {
    this.assertOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      enforcePrivateFiles(this.filePath);
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve original error. */ }
      throw error;
    }
  }

  getMeta(key: string): string | undefined {
    this.assertOpen();
    const row = this.db.prepare('SELECT value FROM schedule_meta WHERE key = ?').all(key)[0] as { value?: string } | undefined;
    return typeof row?.value === 'string' ? row.value : undefined;
  }

  setMeta(key: string, value: string): void {
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO schedule_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, value);
    });
  }

  /** One-time idempotent migration from legacy `config/schedules.json` with immutable `schedules.pre-sqlite.json` backup. */
  async migrateLegacyJson(legacyJsonPath: string, nowIso = new Date().toISOString()): Promise<LegacyMigrationResult> {
    this.assertOpen();
    if (this.getMeta('legacy_migration_v1') === '1') {
      return {
        migrated: false,
        alreadyMigrated: true,
        backupPath: this.getMeta('legacy_migration_backup'),
        hostTimeZone: this.getMeta('legacy_migration_host_timezone'),
        sourceSha256: this.getMeta('legacy_migration_source_sha256'),
        importedSchedules: 0,
      };
    }

    // If this SQLite store already has native writes, it is past initial cutover and must not re-run legacy migration.
    const existingCounts = this.db
      .prepare('SELECT (SELECT COUNT(*) FROM schedules) AS s, (SELECT COUNT(*) FROM schedule_prompt_creations) AS p')
      .all()[0] as { s?: number; p?: number } | undefined;
    if ((existingCounts?.s ?? 0) > 0 || (existingCounts?.p ?? 0) > 0 || this.getMeta('last_json_mirror_sha256') !== undefined) {
      return { migrated: false, alreadyMigrated: false, importedSchedules: 0 };
    }

    const legacy = await readLegacyScheduleJsonFile(legacyJsonPath);
    if (!legacy) {
      return { migrated: false, alreadyMigrated: false, importedSchedules: 0 };
    }

    const backupPath = path.join(path.dirname(legacyJsonPath), 'schedules.pre-sqlite.json');
    await writeImmutableBackup(backupPath, legacy.rawBytes);
    const hostTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

    this.transaction(() => {
      const already = this.db.prepare("SELECT value FROM schedule_meta WHERE key = 'legacy_migration_v1'").all()[0] as { value?: string } | undefined;
      if (already?.value === '1') return;

      const insertSchedule = this.db.prepare(`
        INSERT OR IGNORE INTO schedules (
          id, revision, workspace_id, name, prompt, enabled, trigger_kind, trigger_json, trigger_generation,
          session_target_json, bound_session_id, assignment_json, missed_policy, state, next_run_at,
          last_run_at, last_outcome, last_error, last_session_id, run_count, legacy_dispatch_count,
          completed_run_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of legacy.schedules) {
        insertSchedule.run(
          item.id,
          item.revision,
          item.workspaceId,
          item.name,
          item.prompt,
          item.enabled ? 1 : 0,
          item.trigger.kind,
          JSON.stringify(item.trigger),
          1,
          JSON.stringify(item.sessionTarget),
          item.boundSessionId ?? null,
          JSON.stringify(item.assignment),
          item.missedPolicy,
          item.state,
          item.nextRunAt ?? null,
          item.lastRunAt ?? null,
          item.lastOutcome ?? null,
          item.lastError ?? null,
          item.lastSessionId ?? null,
          item.runCount,
          item.legacyDispatchCount ?? item.runCount,
          item.completedRunCount ?? 0,
          item.createdAt,
          item.updatedAt,
        );
      }

      const insertReceipt = this.db.prepare(`
        INSERT OR IGNORE INTO schedule_prompt_creations (schedule_id, fingerprint, invalidated)
        VALUES (?, ?, ?)
      `);
      for (const receipt of legacy.promptCreations) {
        insertReceipt.run(receipt.scheduleId, receipt.fingerprint, receipt.invalidated ? 1 : 0);
      }

      const insertRecovery = this.db.prepare(`
        INSERT OR REPLACE INTO schedule_recoveries (schedule_id, reason, due_at, retry_at, attempt, retry_context_json, run_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const recovery of legacy.recoveries) {
        insertRecovery.run(
          recovery.scheduleId,
          recovery.reason,
          recovery.dueAt,
          recovery.retryAt,
          recovery.attempt,
          recovery.retryContext ? JSON.stringify(recovery.retryContext) : null,
          recovery.runId ?? null,
        );
      }

      const upsertMeta = this.db.prepare(
        'INSERT INTO schedule_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      );
      upsertMeta.run('legacy_migration_v1', '1');
      upsertMeta.run('legacy_migration_at', nowIso);
      upsertMeta.run('legacy_migration_source_sha256', legacy.sha256);
      upsertMeta.run('legacy_migration_backup', backupPath);
      upsertMeta.run('legacy_migration_host_timezone', hostTimeZone);
      upsertMeta.run('last_json_mirror_sha256', legacy.sha256);
    });

    return {
      migrated: true,
      alreadyMigrated: false,
      backupPath,
      hostTimeZone,
      sourceSha256: legacy.sha256,
      importedSchedules: legacy.schedules.length,
    };
  }

  readCatalogState(): StoredScheduleCatalogState {
    this.assertOpen();
    const scheduleRows = this.db
      .prepare('SELECT * FROM schedules ORDER BY created_at, id')
      .all() as unknown as ScheduleRow[];
    const triggerGenerations = new Map<string, number>();
    const schedules = scheduleRows.map(row => {
      triggerGenerations.set(row.id, row.trigger_generation);
      const decoded = decodeStoredSchedule({
        id: row.id,
        revision: row.revision,
        workspaceId: row.workspace_id,
        name: row.name,
        prompt: row.prompt,
        enabled: row.enabled === 1,
        trigger: JSON.parse(row.trigger_json),
        sessionTarget: JSON.parse(row.session_target_json),
        ...(row.bound_session_id !== null ? { boundSessionId: row.bound_session_id } : {}),
        assignment: JSON.parse(row.assignment_json),
        missedPolicy: row.missed_policy,
        state: row.state,
        ...(row.next_run_at !== null ? { nextRunAt: row.next_run_at } : {}),
        ...(row.last_run_at !== null ? { lastRunAt: row.last_run_at } : {}),
        ...(row.last_outcome !== null ? { lastOutcome: row.last_outcome } : {}),
        ...(row.last_error !== null ? { lastError: row.last_error } : {}),
        ...(row.last_session_id !== null ? { lastSessionId: row.last_session_id } : {}),
        runCount: row.run_count,
        ...(row.legacy_dispatch_count !== null ? { legacyDispatchCount: row.legacy_dispatch_count } : {}),
        ...(row.completed_run_count > 0 ? { completedRunCount: row.completed_run_count } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
      return decoded;
    });

    const receiptRows = this.db
      .prepare('SELECT schedule_id, fingerprint, invalidated FROM schedule_prompt_creations ORDER BY sort_order ASC')
      .all() as Array<{ schedule_id: string; fingerprint: string; invalidated: number }>;
    const promptCreations: PromptCreationReceipt[] = receiptRows.map(row => ({
      scheduleId: row.schedule_id,
      fingerprint: row.fingerprint,
      invalidated: row.invalidated === 1,
    }));

    const recoveryRows = this.db
      .prepare('SELECT schedule_id, reason, due_at, retry_at, attempt, retry_context_json, run_id FROM schedule_recoveries')
      .all() as Array<{
        schedule_id: string;
        reason: 'busy' | 'connection-unavailable';
        due_at: string;
        retry_at: string;
        attempt: number;
        retry_context_json: string | null;
        run_id: string | null;
      }>;
    const recoveries: RecoveryReceipt[] = recoveryRows.map(row => ({
      scheduleId: row.schedule_id,
      reason: row.reason,
      dueAt: row.due_at,
      retryAt: row.retry_at,
      attempt: row.attempt,
      ...(row.retry_context_json !== null ? { retryContext: decodeScheduleRetryContext(JSON.parse(row.retry_context_json)) } : {}),
      ...(row.run_id !== null ? { runId: row.run_id } : {}),
    }));

    return { schedules, promptCreations, recoveries, triggerGenerations };
  }

  replaceCatalogState(state: {
    schedules: readonly GeneralSchedule[];
    promptCreations: readonly PromptCreationReceipt[];
    recoveries: readonly RecoveryReceipt[];
    triggerGenerations?: ReadonlyMap<string, number>;
    lastJsonMirrorSha256?: string;
  }): void {
    this.transaction(() => {
      const existingRows = this.db
        .prepare('SELECT id, trigger_generation, legacy_dispatch_count, completed_run_count FROM schedules')
        .all() as Array<{ id: string; trigger_generation: number; legacy_dispatch_count: number | null; completed_run_count: number }>;
      const existingById = new Map(existingRows.map(row => [row.id, row]));
      const nextIds = new Set(state.schedules.map(item => item.id));

      // Clear recoveries first so deletes do not trigger unexpected cascades before re-inserting current recoveries.
      this.db.prepare('DELETE FROM schedule_recoveries').run();
      for (const old of existingRows) {
        if (!nextIds.has(old.id)) {
          this.db.prepare('DELETE FROM schedules WHERE id = ?').run(old.id);
        }
      }

      const upsertSchedule = this.db.prepare(`
        INSERT INTO schedules (
          id, revision, workspace_id, name, prompt, enabled, trigger_kind, trigger_json, trigger_generation,
          session_target_json, bound_session_id, assignment_json, missed_policy, state, next_run_at,
          last_run_at, last_outcome, last_error, last_session_id, run_count, legacy_dispatch_count,
          completed_run_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          revision = excluded.revision,
          workspace_id = excluded.workspace_id,
          name = excluded.name,
          prompt = excluded.prompt,
          enabled = excluded.enabled,
          trigger_kind = excluded.trigger_kind,
          trigger_json = excluded.trigger_json,
          trigger_generation = excluded.trigger_generation,
          session_target_json = excluded.session_target_json,
          bound_session_id = excluded.bound_session_id,
          assignment_json = excluded.assignment_json,
          missed_policy = excluded.missed_policy,
          state = excluded.state,
          next_run_at = excluded.next_run_at,
          last_run_at = excluded.last_run_at,
          last_outcome = excluded.last_outcome,
          last_error = excluded.last_error,
          last_session_id = excluded.last_session_id,
          run_count = excluded.run_count,
          legacy_dispatch_count = COALESCE(excluded.legacy_dispatch_count, schedules.legacy_dispatch_count),
          completed_run_count = MAX(schedules.completed_run_count, excluded.completed_run_count),
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `);

      for (const item of state.schedules) {
        const prior = existingById.get(item.id);
        const generation = state.triggerGenerations?.get(item.id) ?? prior?.trigger_generation ?? 1;
        const legacyCount = item.legacyDispatchCount ?? prior?.legacy_dispatch_count ?? null;
        const completedCount = item.completedRunCount ?? prior?.completed_run_count ?? 0;
        upsertSchedule.run(
          item.id,
          item.revision,
          item.workspaceId,
          item.name,
          item.prompt,
          item.enabled ? 1 : 0,
          item.trigger.kind,
          JSON.stringify(item.trigger),
          generation,
          JSON.stringify(item.sessionTarget),
          item.boundSessionId ?? null,
          JSON.stringify(item.assignment),
          item.missedPolicy,
          item.state,
          item.nextRunAt ?? null,
          item.lastRunAt ?? null,
          item.lastOutcome ?? null,
          item.lastError ?? null,
          item.lastSessionId ?? null,
          item.runCount,
          legacyCount,
          completedCount,
          item.createdAt,
          item.updatedAt,
        );
      }

      this.db.prepare('DELETE FROM schedule_prompt_creations').run();
      const insertReceipt = this.db.prepare(
        'INSERT INTO schedule_prompt_creations (schedule_id, fingerprint, invalidated) VALUES (?, ?, ?)',
      );
      for (const receipt of state.promptCreations) {
        insertReceipt.run(receipt.scheduleId, receipt.fingerprint, receipt.invalidated ? 1 : 0);
      }

      const insertRecovery = this.db.prepare(`
        INSERT INTO schedule_recoveries (schedule_id, reason, due_at, retry_at, attempt, retry_context_json, run_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const recovery of state.recoveries) {
        insertRecovery.run(
          recovery.scheduleId,
          recovery.reason,
          recovery.dueAt,
          recovery.retryAt,
          recovery.attempt,
          recovery.retryContext ? JSON.stringify(recovery.retryContext) : null,
          recovery.runId ?? null,
        );
      }

      if (state.lastJsonMirrorSha256 !== undefined) {
        this.db
          .prepare("INSERT INTO schedule_meta(key, value) VALUES ('last_json_mirror_sha256', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(state.lastJsonMirrorSha256);
      }
    });
  }

  /** Atomically admit a new or deferred occurrence into `admitting`. Enforces `UNIQUE(occurrence_key)`. */
  admitOccurrence(input: AdmitScheduleOccurrenceInput): AdmitScheduleOccurrenceResult {
    return this.transaction(() => {
      const existing = this.db
        .prepare('SELECT * FROM schedule_runs WHERE occurrence_key = ?')
        .all(input.occurrenceKey)[0] as unknown as RunRow | undefined;

      if (!existing) {
        const id = `run_${randomUUID()}`;
        this.db.prepare(`
          INSERT INTO schedule_runs (
            id, revision, schedule_id, schedule_revision, occurrence_key, occurrence_kind,
            scheduled_for, requested_at, workspace_id, runtime_id, session_id, state,
            admitted_at, verification, attempt_count, created_at, updated_at
          ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admitting', ?, 'not-checked', 1, ?, ?)
        `).run(
          id,
          input.scheduleId,
          input.scheduleRevision,
          input.occurrenceKey,
          input.occurrenceKind,
          input.scheduledFor,
          input.requestedAt ?? null,
          input.workspaceId,
          input.runtimeId ?? null,
          input.sessionId ?? null,
          input.nowIso,
          input.nowIso,
          input.nowIso,
        );
        const inserted = this.db.prepare('SELECT * FROM schedule_runs WHERE id = ?').all(id)[0] as unknown as RunRow;
        return { admitted: true, run: rowToRun(inserted) };
      }

      if (existing.state === 'pending') {
        const result = this.db.prepare(`
          UPDATE schedule_runs
          SET state = 'admitting',
              revision = revision + 1,
              admitted_at = ?,
              updated_at = ?,
              schedule_revision = ?,
              runtime_id = COALESCE(?, runtime_id),
              session_id = COALESCE(?, session_id)
          WHERE id = ? AND revision = ? AND state = 'pending'
        `).run(
          input.nowIso,
          input.nowIso,
          input.scheduleRevision,
          input.runtimeId ?? null,
          input.sessionId ?? null,
          existing.id,
          existing.revision,
        );
        if (result.changes !== 1) throw new Error('Concurrent modification while admitting pending occurrence.');
        const updated = this.db.prepare('SELECT * FROM schedule_runs WHERE id = ?').all(existing.id)[0] as unknown as RunRow;
        return { admitted: true, run: rowToRun(updated) };
      }

      if (existing.state === 'deferred') {
        if (input.safeNoWorkProof !== true) {
          return { admitted: false, reason: 'missing-no-work-proof', existingRun: rowToRun(existing) };
        }
        const result = this.db.prepare(`
          UPDATE schedule_runs
          SET state = 'admitting',
              revision = revision + 1,
              attempt_count = attempt_count + 1,
              admitted_at = ?,
              updated_at = ?,
              schedule_revision = ?,
              status_reason = NULL,
              runtime_id = COALESCE(?, runtime_id),
              session_id = COALESCE(?, session_id)
          WHERE id = ? AND revision = ? AND state = 'deferred'
        `).run(
          input.nowIso,
          input.nowIso,
          input.scheduleRevision,
          input.runtimeId ?? null,
          input.sessionId ?? null,
          existing.id,
          existing.revision,
        );
        if (result.changes !== 1) throw new Error('Concurrent modification while re-admitting deferred occurrence.');
        const updated = this.db.prepare('SELECT * FROM schedule_runs WHERE id = ?').all(existing.id)[0] as unknown as RunRow;
        return { admitted: true, run: rowToRun(updated) };
      }

      return { admitted: false, reason: 'already-exists', existingRun: rowToRun(existing) };
    });
  }

  /** Insert a pending occurrence slot prior to admission (optional two-phase scheduling). */
  createPendingOccurrence(input: Omit<AdmitScheduleOccurrenceInput, 'safeNoWorkProof'>): ScheduleRunV1 {
    return this.transaction(() => {
      const id = `run_${randomUUID()}`;
      this.db.prepare(`
        INSERT INTO schedule_runs (
          id, revision, schedule_id, schedule_revision, occurrence_key, occurrence_kind,
          scheduled_for, requested_at, workspace_id, runtime_id, session_id, state,
          verification, attempt_count, created_at, updated_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'not-checked', 0, ?, ?)
      `).run(
        id,
        input.scheduleId,
        input.scheduleRevision,
        input.occurrenceKey,
        input.occurrenceKind,
        input.scheduledFor,
        input.requestedAt ?? null,
        input.workspaceId,
        input.runtimeId ?? null,
        input.sessionId ?? null,
        input.nowIso,
        input.nowIso,
      );
      const inserted = this.db.prepare('SELECT * FROM schedule_runs WHERE id = ?').all(id)[0] as unknown as RunRow;
      return rowToRun(inserted);
    });
  }

  /** CAS transition enforcing legal run state machine transitions. */
  transitionRunState(
    runId: string,
    expectedRevision: number,
    nextState: ScheduleRunState,
    details: {
      sessionId?: string;
      runtimeId?: string;
      turnId?: string;
      correlationId?: string;
      executionGeneration?: string;
      statusReason?: string;
      terminalEvidenceRef?: string;
      settledAt?: string;
      safeNoWorkProof?: boolean;
      nowIso?: string;
    } = {},
  ): ScheduleRunV1 {
    if (!isScheduleRunState(nextState)) throw new Error(`Invalid target schedule run state "${String(nextState)}".`);
    const nowIso = details.nowIso ?? new Date().toISOString();
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM schedule_runs WHERE id = ?').all(runId)[0] as unknown as RunRow | undefined;
      if (!existing) throw new Error('Schedule run not found.');
      if (existing.revision !== expectedRevision) {
        throw new Error('This schedule run changed. Refresh before updating.');
      }
      const currentState = existing.state as ScheduleRunState;
      const allowed = ALLOWED_RUN_TRANSITIONS[currentState];
      if (!allowed.includes(nextState)) {
        throw new Error(`Invalid schedule run state transition from "${currentState}" to "${nextState}".`);
      }
      if (currentState === 'deferred' && nextState === 'admitting' && details.safeNoWorkProof !== true) {
        throw new Error('Transition from deferred to admitting requires verified safe no-work proof.');
      }
      const isTerminal = nextState === 'completed' || nextState === 'failed' || nextState === 'cancelled' || nextState === 'blocked';
      const settledAt = details.settledAt ?? (isTerminal ? nowIso : existing.settled_at);
      const result = this.db.prepare(`
        UPDATE schedule_runs
        SET state = ?,
            revision = revision + 1,
            session_id = COALESCE(?, session_id),
            runtime_id = COALESCE(?, runtime_id),
            turn_id = COALESCE(?, turn_id),
            correlation_id = COALESCE(?, correlation_id),
            execution_generation = COALESCE(?, execution_generation),
            status_reason = COALESCE(?, status_reason),
            terminal_evidence_ref = COALESCE(?, terminal_evidence_ref),
            settled_at = ?,
            attempt_count = CASE WHEN ? = 'admitting' THEN attempt_count + 1 ELSE attempt_count END,
            updated_at = ?
        WHERE id = ? AND revision = ? AND state = ?
      `).run(
        nextState,
        details.sessionId ?? null,
        details.runtimeId ?? null,
        details.turnId ?? null,
        details.correlationId ?? null,
        details.executionGeneration ?? null,
        details.statusReason ?? null,
        details.terminalEvidenceRef ?? null,
        settledAt ?? null,
        nextState,
        nowIso,
        runId,
        expectedRevision,
        currentState,
      );
      if (result.changes !== 1) {
        throw new Error('This schedule run changed concurrently.');
      }
      if (nextState === 'completed') {
        this.db
          .prepare('UPDATE schedules SET completed_run_count = completed_run_count + 1 WHERE id = ?')
          .run(existing.schedule_id);
      }
      const updated = this.db.prepare('SELECT * FROM schedule_runs WHERE id = ?').all(runId)[0] as unknown as RunRow;
      return rowToRun(updated);
    });
  }

  markRunDispatched(
    runId: string,
    expectedRevision: number,
    details: {
      sessionId?: string;
      runtimeId?: string;
      turnId?: string;
      correlationId?: string;
      executionGeneration?: string;
      nowIso?: string;
    } = {},
  ): ScheduleRunV1 {
    return this.transitionRunState(runId, expectedRevision, 'dispatched', details);
  }

  markRunDeferred(
    runId: string,
    expectedRevision: number,
    details: { statusReason: string; sessionId?: string; nowIso?: string },
  ): ScheduleRunV1 {
    return this.transitionRunState(runId, expectedRevision, 'deferred', details);
  }

  markRunBlocked(
    runId: string,
    expectedRevision: number,
    details: { statusReason: string; sessionId?: string; nowIso?: string },
  ): ScheduleRunV1 {
    return this.transitionRunState(runId, expectedRevision, 'blocked', details);
  }

  markRunFailed(
    runId: string,
    expectedRevision: number,
    details: { statusReason: string; sessionId?: string; terminalEvidenceRef?: string; nowIso?: string },
  ): ScheduleRunV1 {
    return this.transitionRunState(runId, expectedRevision, 'failed', details);
  }

  /** Bind a managed runtime turn to a dispatched run (`dispatched -> running`). */
  recordTurnBound(runId: string, binding: TurnBindingInput): ScheduleRunV1 {
    if (!binding.sessionId || !binding.sessionId.trim()) {
      throw new Error('Binding a managed turn requires a sessionId.');
    }
    const nowIso = binding.nowIso ?? new Date().toISOString();
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM schedule_runs WHERE id = ?').all(runId)[0] as unknown as RunRow | undefined;
      if (!existing) throw new Error('Schedule run not found.');
      if (binding.expectedRevision !== undefined && existing.revision !== binding.expectedRevision) {
        throw new Error('This schedule run changed. Refresh before binding turn.');
      }
      if (existing.state !== 'dispatched' && existing.state !== 'running') {
        throw new Error(`Cannot bind a managed turn to a schedule run in state "${existing.state}".`);
      }
      if (existing.session_id !== null && existing.session_id !== binding.sessionId) {
        throw new Error('Refused turn binding: sessionId does not match the run destination session.');
      }
      if (existing.correlation_id !== null && binding.correlationId !== undefined && existing.correlation_id !== binding.correlationId) {
        throw new Error('Refused turn binding: correlationId does not match the admitted run.');
      }
      if (existing.execution_generation !== null && binding.executionGeneration !== undefined && existing.execution_generation !== binding.executionGeneration) {
        throw new Error('Refused turn binding: executionGeneration does not match the admitted run.');
      }
      const result = this.db.prepare(`
        UPDATE schedule_runs
        SET state = 'running',
            revision = revision + 1,
            session_id = ?,
            turn_id = COALESCE(?, turn_id),
            correlation_id = COALESCE(?, correlation_id),
            execution_generation = COALESCE(?, execution_generation),
            runtime_id = COALESCE(?, runtime_id),
            updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(
        binding.sessionId,
        binding.turnId ?? null,
        binding.correlationId ?? null,
        binding.executionGeneration ?? null,
        binding.runtimeId ?? null,
        nowIso,
        runId,
        existing.revision,
      );
      if (result.changes !== 1) throw new Error('Concurrent modification while binding schedule turn.');
      const updated = this.db.prepare('SELECT * FROM schedule_runs WHERE id = ?').all(runId)[0] as unknown as RunRow;
      return rowToRun(updated);
    });
  }

  /** Settle a dispatched/running occurrence only when exact session and correlation/turn/generation identity match (`SCH-AT-16`). */
  recordTurnSettled(
    match: TurnSettlementMatch,
    outcome: 'completed' | 'failed' | 'cancelled',
    details: TurnSettlementDetails = {},
  ): ScheduleRunV1 {
    if (!match.sessionId || !match.sessionId.trim()) {
      throw new Error('Refused turn settlement: sessionId is required.');
    }
    if (outcome !== 'completed' && outcome !== 'failed' && outcome !== 'cancelled') {
      throw new Error(`Invalid terminal turn outcome "${String(outcome)}".`);
    }
    const nowIso = details.nowIso ?? new Date().toISOString();
    return this.transaction(() => {
      let existing: RunRow | undefined;
      if (match.runId) {
        existing = this.db.prepare('SELECT * FROM schedule_runs WHERE id = ?').all(match.runId)[0] as unknown as RunRow | undefined;
      } else if (match.correlationId) {
        existing = this.db
          .prepare("SELECT * FROM schedule_runs WHERE session_id = ? AND correlation_id = ? AND state IN ('dispatched', 'running') ORDER BY created_at DESC LIMIT 1")
          .all(match.sessionId, match.correlationId)[0] as unknown as RunRow | undefined;
      } else if (match.turnId) {
        existing = this.db
          .prepare("SELECT * FROM schedule_runs WHERE session_id = ? AND turn_id = ? AND state IN ('dispatched', 'running') ORDER BY created_at DESC LIMIT 1")
          .all(match.sessionId, match.turnId)[0] as unknown as RunRow | undefined;
      } else {
        throw new Error('Refused turn settlement: runId, correlationId, or turnId is required to correlate a turn.');
      }

      if (!existing) {
        throw new Error('Refused turn settlement: no matching active schedule run found for this session and correlation.');
      }
      if (existing.state !== 'dispatched' && existing.state !== 'running') {
        throw new Error(`Refused turn settlement: schedule run is already in state "${existing.state}".`);
      }
      if (existing.session_id !== match.sessionId) {
        throw new Error('Refused turn settlement: unrelated sessionId does not match the run.');
      }
      if (existing.correlation_id !== null && existing.correlation_id !== match.correlationId) {
        throw new Error('Refused turn settlement: correlationId does not match the run.');
      }
      if (existing.correlation_id === null && match.correlationId !== undefined && existing.turn_id !== null && existing.turn_id !== match.turnId) {
        throw new Error('Refused turn settlement: turnId does not match the run.');
      }
      if (existing.turn_id !== null && match.turnId !== undefined && existing.turn_id !== match.turnId) {
        throw new Error('Refused turn settlement: turnId does not match the run.');
      }
      if (existing.turn_id !== null && existing.correlation_id === null && match.turnId !== existing.turn_id) {
        throw new Error('Refused turn settlement: turnId is required to match the bound turn.');
      }
      if (existing.execution_generation !== null && existing.execution_generation !== match.executionGeneration) {
        throw new Error('Refused turn settlement: executionGeneration does not match the run.');
      }

      const result = this.db.prepare(`
        UPDATE schedule_runs
        SET state = ?,
            revision = revision + 1,
            settled_at = ?,
            turn_id = COALESCE(?, turn_id),
            correlation_id = COALESCE(?, correlation_id),
            execution_generation = COALESCE(?, execution_generation),
            status_reason = COALESCE(?, status_reason),
            terminal_evidence_ref = COALESCE(?, terminal_evidence_ref),
            updated_at = ?
        WHERE id = ? AND revision = ? AND state IN ('dispatched', 'running')
      `).run(
        outcome,
        nowIso,
        match.turnId ?? null,
        match.correlationId ?? null,
        match.executionGeneration ?? null,
        details.statusReason ?? null,
        details.terminalEvidenceRef ?? null,
        nowIso,
        existing.id,
        existing.revision,
      );
      if (result.changes !== 1) throw new Error('Concurrent modification while settling schedule turn.');

      if (outcome === 'completed') {
        this.db
          .prepare('UPDATE schedules SET completed_run_count = completed_run_count + 1 WHERE id = ?')
          .run(existing.schedule_id);
      }
      const updated = this.db.prepare('SELECT * FROM schedule_runs WHERE id = ?').all(existing.id)[0] as unknown as RunRow;
      return rowToRun(updated);
    });
  }

  /** Record independent verification state (`not-checked | passed | failed`). `passed` requires explicit trusted evidence (`SCH-AT-18`). */
  recordVerification(runId: string, verification: ScheduleVerificationState, details: VerificationDetails = {}): ScheduleRunV1 {
    if (!isScheduleVerificationState(verification)) {
      throw new Error(`Invalid verification state "${String(verification)}".`);
    }
    const evidenceRef = details.evidenceRef?.trim();
    if (verification === 'passed' && !evidenceRef) {
      throw new Error('Recording passed verification requires an explicit trusted evidence reference.');
    }
    const nowIso = details.nowIso ?? new Date().toISOString();
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM schedule_runs WHERE id = ?').all(runId)[0] as unknown as RunRow | undefined;
      if (!existing) throw new Error('Schedule run not found.');
      const result = this.db.prepare(`
        UPDATE schedule_runs
        SET verification = ?,
            verification_evidence_ref = ?,
            status_reason = COALESCE(?, status_reason),
            revision = revision + 1,
            updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(
        verification,
        evidenceRef ?? null,
        details.statusReason ?? null,
        nowIso,
        runId,
        existing.revision,
      );
      if (result.changes !== 1) throw new Error('Concurrent modification while recording schedule verification.');
      const updated = this.db.prepare('SELECT * FROM schedule_runs WHERE id = ?').all(runId)[0] as unknown as RunRow;
      return rowToRun(updated);
    });
  }

  /** Quarantine all interrupted `admitting`, `dispatched`, or `running` runs as `unknown` on startup without replaying them. */
  recoverInterruptedRuns(nowIso = new Date().toISOString()): ScheduleRunV1[] {
    return this.transaction(() => {
      const interrupted = this.db
        .prepare("SELECT * FROM schedule_runs WHERE state IN ('admitting', 'dispatched', 'running') ORDER BY created_at, id")
        .all() as unknown as RunRow[];
      if (!interrupted.length) return [];
      const update = this.db.prepare(`
        UPDATE schedule_runs
        SET state = 'unknown',
            revision = revision + 1,
            status_reason = ?,
            updated_at = ?
        WHERE id = ? AND revision = ? AND state IN ('admitting', 'dispatched', 'running')
      `);
      const recovered: ScheduleRunV1[] = [];
      for (const row of interrupted) {
        const reason = row.state === 'admitting'
          ? 'Host restarted during occurrence admission; effect could not be ruled out and was not replayed.'
          : 'Host restarted while scheduled run was in progress; turn outcome is unknown and was not replayed.';
        const res = update.run(reason, nowIso, row.id, row.revision);
        if (res.changes === 1) {
          const updated = this.db.prepare('SELECT * FROM schedule_runs WHERE id = ?').all(row.id)[0] as unknown as RunRow;
          recovered.push(rowToRun(updated));
        }
      }
      return recovered;
    });
  }

  /** Record a quarantined `unknown` run when a legacy-migrated or externally interrupted schedule was left in `running`. */
  recordInterruptedLegacyRun(input: {
    scheduleId: string;
    scheduleRevision: number;
    occurrenceKey: string;
    scheduledFor: string;
    workspaceId: string;
    sessionId?: string;
    statusReason: string;
    nowIso: string;
  }): ScheduleRunV1 {
    return this.transaction(() => {
      const existing = this.db
        .prepare('SELECT * FROM schedule_runs WHERE occurrence_key = ?')
        .all(input.occurrenceKey)[0] as unknown as RunRow | undefined;
      if (existing) {
        if (existing.state === 'admitting' || existing.state === 'dispatched' || existing.state === 'running') {
          this.db.prepare(`
            UPDATE schedule_runs
            SET state = 'unknown', revision = revision + 1, status_reason = ?, updated_at = ?
            WHERE id = ? AND revision = ?
          `).run(input.statusReason, input.nowIso, existing.id, existing.revision);
          const updated = this.db.prepare('SELECT * FROM schedule_runs WHERE id = ?').all(existing.id)[0] as unknown as RunRow;
          return rowToRun(updated);
        }
        return rowToRun(existing);
      }
      const id = `run_${randomUUID()}`;
      this.db.prepare(`
        INSERT INTO schedule_runs (
          id, revision, schedule_id, schedule_revision, occurrence_key, occurrence_kind,
          scheduled_for, workspace_id, session_id, state, admitted_at, verification,
          status_reason, attempt_count, created_at, updated_at
        ) VALUES (?, 1, ?, ?, ?, 'automatic', ?, ?, ?, 'unknown', ?, 'not-checked', ?, 1, ?, ?)
      `).run(
        id,
        input.scheduleId,
        input.scheduleRevision,
        input.occurrenceKey,
        input.scheduledFor,
        input.workspaceId,
        input.sessionId ?? null,
        input.nowIso,
        input.statusReason,
        input.nowIso,
        input.nowIso,
      );
      const inserted = this.db.prepare('SELECT * FROM schedule_runs WHERE id = ?').all(id)[0] as unknown as RunRow;
      return rowToRun(inserted);
    });
  }

  /** Explicit operator reconciliation of a quarantined `unknown` run using revision CAS. Never fabricates `completed` or `passed`. */
  reviewUnknownRun(
    runId: string,
    expectedRevision: number,
    rawDecision: ScheduleReviewDecision,
    nowIso = new Date().toISOString(),
  ): ScheduleRunDetail {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error('Refresh this schedule run before reviewing.');
    }
    const decision = normalizeScheduleReviewDecision(rawDecision);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM schedule_runs WHERE id = ?').all(runId)[0] as unknown as RunRow | undefined;
      if (!existing) throw new Error('Schedule run not found.');
      if (existing.revision !== expectedRevision) {
        throw new Error('This schedule run changed. Refresh before reviewing.');
      }
      if (existing.state !== 'unknown') {
        throw new Error(`Only runs in unknown state can be reviewed (current state: "${existing.state}").`);
      }
      const result = this.db.prepare(`
        UPDATE schedule_runs
        SET review_decision = ?,
            reviewed_at = ?,
            review_note = ?,
            revision = revision + 1,
            updated_at = ?
        WHERE id = ? AND revision = ? AND state = 'unknown'
      `).run(
        decision.action,
        nowIso,
        decision.note ?? null,
        nowIso,
        runId,
        expectedRevision,
      );
      if (result.changes !== 1) throw new Error('This schedule run changed. Refresh before reviewing.');
      const detail = this.getRunDetailUnlocked(runId);
      if (!detail) throw new Error('Schedule run not found after review.');
      return detail;
    });
  }

  listRuns(rawFilter: ScheduleRunFilter): ScheduleRunPage {
    this.assertOpen();
    const filter = normalizeScheduleRunFilter(rawFilter);
    const limit = filter.limit ?? 50;
    const where: string[] = ['workspace_id = ?'];
    const baseParams: Array<string | number> = [filter.workspaceId];
    if (filter.scheduleId !== undefined) {
      where.push('schedule_id = ?');
      baseParams.push(filter.scheduleId);
    }
    if (filter.state !== undefined) {
      where.push('state = ?');
      baseParams.push(filter.state);
    }
    const baseClause = where.join(' AND ');
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS total FROM schedule_runs WHERE ${baseClause}`)
      .all(...baseParams)[0] as { total?: number } | undefined;
    const total = Number(totalRow?.total ?? 0);

    const pageWhere = [...where];
    const pageParams = [...baseParams];
    if (filter.cursor) {
      const cursor = decodeCursor(filter.cursor);
      pageWhere.push('(created_at < ? OR (created_at = ? AND id < ?))');
      pageParams.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const rows = this.db
      .prepare(`SELECT * FROM schedule_runs WHERE ${pageWhere.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...pageParams, limit + 1) as unknown as RunRow[];

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const runs = slice.map(rowToRun);
    const last = slice.at(-1);
    return {
      runs,
      total,
      ...(hasMore && last ? { nextCursor: encodeCursor(last.created_at, last.id) } : {}),
    };
  }

  private getRunDetailUnlocked(runId: string): ScheduleRunDetail | undefined {
    const row = this.db.prepare('SELECT * FROM schedule_runs WHERE id = ?').all(runId)[0] as unknown as RunRow | undefined;
    if (!row) return undefined;
    const deliveryRows = this.db
      .prepare('SELECT * FROM schedule_deliveries WHERE run_id = ? ORDER BY created_at ASC, id ASC')
      .all(runId) as unknown as DeliveryRow[];
    const scheduleRow = this.db
      .prepare('SELECT name FROM schedules WHERE id = ?')
      .all(row.schedule_id)[0] as { name?: string } | undefined;
    return {
      run: rowToRun(row),
      deliveries: deliveryRows.map(rowToDelivery),
      ...(typeof scheduleRow?.name === 'string' ? { scheduleName: scheduleRow.name } : {}),
    };
  }

  getRunDetail(runId: string): ScheduleRunDetail | undefined {
    this.assertOpen();
    if (typeof runId !== 'string' || !runId.trim()) return undefined;
    return this.getRunDetailUnlocked(runId);
  }

  recordDelivery(input: RecordDeliveryInput): ScheduleDeliveryV1 {
    const state = input.state ?? 'pending';
    if (!isScheduleDeliveryState(state)) throw new Error(`Invalid delivery state "${String(state)}".`);
    const nowIso = input.nowIso ?? new Date().toISOString();
    return this.transaction(() => {
      const id = input.id ?? `del_${randomUUID()}`;
      this.db.prepare(`
        INSERT INTO schedule_deliveries (
          id, run_id, destination_binding_id, destination_revision, notification_kind,
          target_guild_id, target_channel_id, target_thread_id, payload_digest,
          state, attempt_count, discord_message_id, last_error_code, acknowledged_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, destination_revision, notification_kind) DO UPDATE SET
          state = excluded.state,
          attempt_count = excluded.attempt_count,
          discord_message_id = COALESCE(excluded.discord_message_id, schedule_deliveries.discord_message_id),
          last_error_code = excluded.last_error_code,
          acknowledged_at = COALESCE(excluded.acknowledged_at, schedule_deliveries.acknowledged_at),
          updated_at = excluded.updated_at
      `).run(
        id,
        input.runId,
        input.destinationBindingId,
        input.destinationRevision,
        input.notificationKind,
        input.targetGuildId,
        input.targetChannelId,
        input.targetThreadId ?? null,
        input.payloadDigest,
        state,
        input.attemptCount ?? 0,
        input.discordMessageId ?? null,
        input.lastErrorCode ?? null,
        input.acknowledgedAt ?? null,
        nowIso,
        nowIso,
      );
      const row = this.db
        .prepare('SELECT * FROM schedule_deliveries WHERE run_id = ? AND destination_revision = ? AND notification_kind = ?')
        .all(input.runId, input.destinationRevision, input.notificationKind)[0] as unknown as DeliveryRow;
      return rowToDelivery(row);
    });
  }

  listDeliveries(runId: string): ScheduleDeliveryV1[] {
    this.assertOpen();
    const rows = this.db
      .prepare('SELECT * FROM schedule_deliveries WHERE run_id = ? ORDER BY created_at ASC, id ASC')
      .all(runId) as unknown as DeliveryRow[];
    return rows.map(rowToDelivery);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all();
    } catch (error) {
      const sqliteCode = (error as { errcode?: number }).errcode;
      if (sqliteCode !== 5 && sqliteCode !== 6) {
        try { this.db.close(); } catch { /* ignore */ }
        throw error;
      }
    } finally {
      try { this.db.close(); } finally {
        try { enforcePrivateFiles(this.filePath); } catch { /* ignore if file already unlinked in temp cleanup */ }
      }
    }
  }
}
