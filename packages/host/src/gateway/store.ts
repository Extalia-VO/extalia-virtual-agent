/**
 * Host-owned transactional SQLite store for Universal Gateway v2 (`<state>/gateway.sqlite`).
 * Separate from Rust mission/Knowledge stores and Schedule store (PRD §14, ADR 0098).
 */
import {
  sanitizeGatewayText,
  type GatewayAudience,
  type GatewayBindingState,
  type GatewayCapabilities,
  type GatewayConnectorState,
  type GatewayPermissionBand,
  type GatewayPrincipalLinkView,
  type GatewayProvider,
  type GatewayRouteMode,
} from '@extalia/platform';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, lstatSync, openSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensurePrivateDirectory, PRIVATE_FILE_MODE } from '../paths.js';
import type { GatewayRouteRecord } from './routing.js';

export const GATEWAY_SCHEMA_VERSION = 1;

export type GatewayStoreErrorCode =
  | 'INVALID_PATH'
  | 'STORAGE_UNAVAILABLE'
  | 'SCHEMA_DOWNGRADE_REFUSED'
  | 'CORRUPT_DATABASE'
  | 'SECRET_REF_INVALID'
  | 'CLOSED';

export class GatewayStoreError extends Error {
  constructor(
    public readonly code: GatewayStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayStoreError';
  }
}

export interface GatewayConnectorRecord {
  id: string;
  provider: GatewayProvider;
  providerAccountId: string;
  secretRef: string;
  status: GatewayConnectorState;
  policyVersion: number;
  capabilityRevision: number;
  capabilities?: GatewayCapabilities;
  leaseOwner?: string;
  leaseEpoch: number;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GatewayAuditEntry {
  sequence: number;
  actor: string;
  action: string;
  resource: string;
  outcome: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  at: string;
}

export interface GatewayWatchdogLeaseRecord {
  hostId: string;
  ownerEpoch: number;
  heartbeatAt: string;
  lastSignal: string;
  updatedAt: string;
}

const RAW_SECRET_IN_REF_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|rk)-(?:proj-|live-|ant-)?[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\//i,
  /^\d{8,12}:[A-Za-z0-9_-]{30,}$/,
];

/** Ensures connector secret references are opaque pointers, never raw credentials. */
export function assertOpaqueSecretRef(secretRef: string): void {
  if (
    typeof secretRef !== 'string'
    || secretRef.length < 3
    || secretRef.length > 256
    || /[\s]|\p{Cc}/u.test(secretRef)
    || RAW_SECRET_IN_REF_PATTERNS.some(pattern => pattern.test(secretRef))
  ) {
    throw new GatewayStoreError(
      'SECRET_REF_INVALID',
      'Connector secretRef must be an opaque secret store reference, never a raw token or webhook URL.',
    );
  }
}

export function normalizeThreadKey(threadId?: string | null): string {
  if (typeof threadId !== 'string') return '';
  return threadId.trim();
}

function sha256Hex(parts: readonly (string | number)[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    const str = String(part);
    hash.update(String(Buffer.byteLength(str)));
    hash.update(':');
    hash.update(str);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function buildInboundKey(input: {
  connectorId: string;
  providerAccountId: string;
  providerEventId: string;
}): string {
  return sha256Hex(['inbound.v1', input.connectorId, input.providerAccountId, input.providerEventId]);
}

export function buildLeadActionKey(input: {
  inboundKey: string;
  resolvedSessionId: string;
  requestedAction: string;
  routeRevision: number;
}): string {
  return sha256Hex([
    'leadAction.v1',
    input.inboundKey,
    input.resolvedSessionId,
    input.requestedAction,
    input.routeRevision,
  ]);
}

export function buildAutonomousKey(input: {
  sourceJobId: string;
  workspaceId: string;
  vaultProfileRevision?: string;
  reportKind: string;
}): string {
  return sha256Hex([
    'autonomous.v1',
    input.sourceJobId,
    input.workspaceId,
    input.vaultProfileRevision ?? '',
    input.reportKind,
  ]);
}

export function buildMaintenanceIntentKey(input: {
  workspaceId: string;
  vaultProfileRevision?: string;
  maintenanceKind: string;
  sourceReceiptDigest: string;
}): string {
  return sha256Hex([
    'maintenanceIntent.v1',
    input.workspaceId,
    input.vaultProfileRevision ?? '',
    input.maintenanceKind,
    input.sourceReceiptDigest,
  ]);
}

export function buildReportRevisionId(input: {
  reportId: string;
  artifactReceiptIds: readonly string[];
  actualOutcome: string;
}): string {
  const sortedReceipts = [...new Set(input.artifactReceiptIds)].sort();
  return sha256Hex(['reportRevision.v1', input.reportId, sortedReceipts.join(','), input.actualOutcome]);
}

export function buildDeliveryKey(input: {
  reportOrSourceEventId: string;
  bindingId: string;
  bindingRevision: number;
  messageClass: string;
  recipientId?: string;
  projectionVersion: number;
}): string {
  return sha256Hex([
    'delivery.v1',
    input.reportOrSourceEventId,
    input.bindingId,
    input.bindingRevision,
    input.messageClass,
    input.recipientId ?? '',
    input.projectionVersion,
  ]);
}

const SCHEMA_V1: readonly string[] = [
  `CREATE TABLE gateway_connectors (
    id TEXT PRIMARY KEY NOT NULL,
    provider TEXT NOT NULL,
    provider_account_id TEXT NOT NULL,
    secret_ref TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('disabled', 'configuring', 'connected', 'degraded', 'blocked', 'revoked')),
    policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
    capability_revision INTEGER NOT NULL CHECK (capability_revision >= 1),
    capabilities_json TEXT,
    lease_owner TEXT,
    lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
    lease_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE UNIQUE INDEX gateway_connectors_active_account
    ON gateway_connectors(provider, provider_account_id)
    WHERE status != 'revoked'`,

  `CREATE TABLE gateway_principal_challenges (
    id TEXT PRIMARY KEY NOT NULL,
    connector_id TEXT NOT NULL REFERENCES gateway_connectors(id),
    extalia_principal_id TEXT NOT NULL,
    permission_bands_json TEXT NOT NULL,
    challenge_salt TEXT NOT NULL,
    challenge_hash TEXT NOT NULL CHECK (length(challenge_hash) = 64),
    submitted_external_actor_id TEXT,
    submitted_provider_account_id TEXT,
    submitted_at TEXT,
    state TEXT NOT NULL CHECK (state IN ('issued', 'proof-submitted', 'consumed', 'expired', 'invalidated')),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,

  `CREATE TABLE gateway_principal_links (
    id TEXT PRIMARY KEY NOT NULL,
    connector_id TEXT NOT NULL REFERENCES gateway_connectors(id),
    provider_account_id TEXT NOT NULL,
    external_actor_id TEXT NOT NULL,
    extalia_principal_id TEXT NOT NULL,
    challenge_receipt TEXT NOT NULL,
    permission_bands_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'expired', 'revoked')),
    expires_at TEXT,
    confirmed_at TEXT NOT NULL,
    revoked_at TEXT,
    revocation_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE UNIQUE INDEX gateway_principal_links_active_actor
    ON gateway_principal_links(connector_id, provider_account_id, external_actor_id)
    WHERE state = 'active'`,

  `CREATE TABLE gateway_routes (
    id TEXT PRIMARY KEY NOT NULL,
    connector_id TEXT NOT NULL REFERENCES gateway_connectors(id),
    provider_account_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_key TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('explicit-only', 'thread-new-session', 'reuse-pinned')),
    audience TEXT NOT NULL CHECK (audience IN ('private', 'team', 'public')),
    policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
    inbound_enabled INTEGER NOT NULL CHECK (inbound_enabled IN (0, 1)),
    outbound_enabled INTEGER NOT NULL CHECK (outbound_enabled IN (0, 1)),
    is_dm_default INTEGER NOT NULL DEFAULT 0 CHECK (is_dm_default IN (0, 1)),
    linked_principal_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'destination-lost', 'revoked')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE UNIQUE INDEX gateway_routes_effective_key
    ON gateway_routes(connector_id, provider_account_id, channel_id, thread_key, is_dm_default, COALESCE(linked_principal_id, ''))
    WHERE state = 'active'`,

  `CREATE TABLE gateway_bindings (
    id TEXT PRIMARY KEY NOT NULL,
    route_id TEXT NOT NULL REFERENCES gateway_routes(id),
    connector_id TEXT NOT NULL REFERENCES gateway_connectors(id),
    provider_account_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_key TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
    audience TEXT NOT NULL CHECK (audience IN ('private', 'team', 'public')),
    state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'destination-lost', 'revoked')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE UNIQUE INDEX gateway_bindings_active_conversation
    ON gateway_bindings(connector_id, provider_account_id, channel_id, thread_key)
    WHERE state = 'active'`,

  `CREATE TABLE gateway_inbox (
    id TEXT PRIMARY KEY NOT NULL,
    inbound_key TEXT NOT NULL UNIQUE CHECK (length(inbound_key) = 64),
    connector_id TEXT NOT NULL REFERENCES gateway_connectors(id),
    provider TEXT NOT NULL,
    provider_account_id TEXT NOT NULL,
    provider_event_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
    external_actor_id TEXT NOT NULL,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'bot', 'webhook', 'unknown')),
    channel_id TEXT NOT NULL,
    thread_key TEXT NOT NULL,
    remote_message_id TEXT,
    reply_to_remote_message_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('command', 'text', 'callback', 'attachment', 'lifecycle')),
    auth_receipt TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('received', 'authenticated', 'deduplicated', 'route-resolved', 'authorized', 'admitted', 'queued', 'rejected', 'unknown')),
    attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
    rejection_reason TEXT,
    received_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (connector_id, provider_event_id)
  ) STRICT`,

  `CREATE TABLE gateway_actions (
    id TEXT PRIMARY KEY NOT NULL,
    lead_action_key TEXT NOT NULL UNIQUE CHECK (length(lead_action_key) = 64),
    inbox_id TEXT NOT NULL REFERENCES gateway_inbox(id),
    connector_id TEXT NOT NULL REFERENCES gateway_connectors(id),
    route_id TEXT NOT NULL REFERENCES gateway_routes(id),
    route_revision INTEGER NOT NULL CHECK (route_revision >= 1),
    binding_id TEXT REFERENCES gateway_bindings(id),
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    requested_action TEXT NOT NULL,
    host_action_id TEXT,
    auth_proof TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('accepted', 'admitted', 'running', 'completed', 'failed', 'cancelled', 'unknown')),
    receipt_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,

  `CREATE TABLE gateway_event_projection (
    id TEXT PRIMARY KEY NOT NULL,
    source_event_id TEXT NOT NULL,
    projection_version INTEGER NOT NULL CHECK (projection_version >= 1),
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    run_id TEXT,
    agent_id TEXT,
    task_id TEXT,
    category TEXT NOT NULL CHECK (category IN ('agent-message', 'worker-activity', 'execution-health', 'approval', 'terminal', 'autonomous-report')),
    provenance TEXT NOT NULL CHECK (provenance IN ('host-receipt', 'runtime-observed', 'model-reported')),
    verification TEXT NOT NULL CHECK (verification IN ('verified', 'unverified', 'unknown', 'not-applicable')),
    safe_text TEXT NOT NULL,
    event_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (source_event_id, projection_version)
  ) STRICT`,

  `CREATE TABLE gateway_outbox (
    id TEXT PRIMARY KEY NOT NULL,
    delivery_key TEXT NOT NULL UNIQUE CHECK (length(delivery_key) = 64),
    connector_id TEXT NOT NULL REFERENCES gateway_connectors(id),
    target_binding_id TEXT NOT NULL,
    target_binding_revision INTEGER NOT NULL CHECK (target_binding_revision >= 1),
    source_event_id TEXT,
    report_id TEXT,
    report_revision INTEGER,
    sender_kind TEXT NOT NULL CHECK (sender_kind IN ('gateway-system', 'lead', 'worker')),
    sender_portrait_json TEXT,
    format TEXT NOT NULL CHECK (format IN ('detailed', 'milestone', 'report')),
    message_class TEXT NOT NULL CHECK (message_class IN ('accepted', 'milestone', 'heartbeat', 'attention', 'terminal', 'system-report')),
    priority TEXT NOT NULL CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
    priority_rank INTEGER NOT NULL CHECK (priority_rank >= 0 AND priority_rank <= 3),
    recipient_id TEXT,
    payload_digest TEXT NOT NULL,
    safe_text TEXT NOT NULL,
    policy_evaluation_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'sending', 'accepted', 'delivered', 'read', 'blocked', 'failed', 'unknown')),
    remote_message_id TEXT,
    last_provider_error TEXT,
    retry_after_at TEXT,
    fencing_token TEXT,
    lease_owner TEXT,
    lease_expires_at TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX gateway_outbox_dispatch_order
    ON gateway_outbox(state, priority_rank, created_at)`,

  `CREATE TABLE gateway_send_attempts (
    id TEXT PRIMARY KEY NOT NULL,
    intent_id TEXT NOT NULL REFERENCES gateway_outbox(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
    lease_owner TEXT NOT NULL,
    fencing_token TEXT NOT NULL,
    provider_request_key TEXT NOT NULL,
    http_status INTEGER,
    classification TEXT NOT NULL CHECK (classification IN ('accepted', 'retryable', 'failed-retryable', 'blocked', 'unknown', 'stale-authority')),
    remote_message_id TEXT,
    error_message TEXT,
    attempted_at TEXT NOT NULL,
    UNIQUE (intent_id, attempt_number)
  ) STRICT`,

  `CREATE TABLE gateway_remote_receipts (
    id TEXT PRIMARY KEY NOT NULL,
    provider TEXT NOT NULL,
    connector_id TEXT NOT NULL REFERENCES gateway_connectors(id),
    remote_message_id TEXT NOT NULL,
    provider_account_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_key TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    run_id TEXT,
    agent_id TEXT,
    task_id TEXT,
    source_event_id TEXT,
    sender_snapshot_json TEXT NOT NULL,
    delivery_state TEXT NOT NULL CHECK (delivery_state IN ('accepted', 'delivered', 'read', 'failed', 'unknown')),
    accepted_at TEXT NOT NULL,
    delivered_at TEXT,
    read_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (connector_id, remote_message_id)
  ) STRICT`,

  `CREATE TABLE gateway_avatar_assets (
    id TEXT PRIMARY KEY NOT NULL,
    character_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    appearance_hash TEXT NOT NULL,
    revision TEXT NOT NULL,
    asset_ref TEXT NOT NULL,
    expires_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (character_id, appearance_hash, revision)
  ) STRICT`,

  `CREATE TABLE gateway_report_ledger (
    id TEXT PRIMARY KEY NOT NULL,
    autonomous_key TEXT NOT NULL UNIQUE CHECK (length(autonomous_key) = 64),
    maintenance_intent_key TEXT UNIQUE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    report_revision_id TEXT NOT NULL CHECK (length(report_revision_id) = 64),
    source TEXT NOT NULL CHECK (source IN ('learning', 'knowledge-build', 'knowledge-meeting', 'skills', 'scheduled-maintenance', 'schedule-run')),
    source_job_id TEXT NOT NULL,
    source_run_id TEXT,
    workspace_id TEXT NOT NULL,
    vault_profile_id TEXT,
    vault_profile_revision TEXT,
    source_session_id TEXT,
    target_chat_id TEXT,
    target_selection TEXT NOT NULL CHECK (target_selection IN ('pinned', 'last-eligible', 'source-only', 'inbox')),
    outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'partial', 'failed', 'cancelled', 'skipped', 'unknown')),
    outcome_rank INTEGER NOT NULL CHECK (outcome_rank >= 0),
    audience_scope_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    last_updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX gateway_report_ledger_workspace ON gateway_report_ledger(workspace_id, committed_at)`,

  `CREATE TABLE gateway_report_revisions (
    id TEXT PRIMARY KEY NOT NULL,
    report_id TEXT NOT NULL REFERENCES gateway_report_ledger(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    report_revision_id TEXT NOT NULL UNIQUE CHECK (length(report_revision_id) = 64),
    outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'partial', 'failed', 'cancelled', 'skipped', 'unknown')),
    payload_json TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    UNIQUE (report_id, revision)
  ) STRICT`,

  `CREATE TABLE gateway_chat_projections (
    id TEXT PRIMARY KEY NOT NULL,
    report_id TEXT NOT NULL UNIQUE REFERENCES gateway_report_ledger(id) ON DELETE CASCADE,
    chat_id TEXT,
    workspace_id TEXT NOT NULL,
    audience_scope_id TEXT NOT NULL,
    target_selection TEXT NOT NULL CHECK (target_selection IN ('pinned', 'last-eligible', 'source-only', 'inbox')),
    selection_receipt_json TEXT NOT NULL,
    read_only_system_card INTEGER NOT NULL DEFAULT 1 CHECK (read_only_system_card = 1),
    exclude_from_model_history INTEGER NOT NULL DEFAULT 1 CHECK (exclude_from_model_history = 1),
    exclude_from_learning INTEGER NOT NULL DEFAULT 1 CHECK (exclude_from_learning = 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX gateway_chat_projections_chat ON gateway_chat_projections(workspace_id, chat_id, created_at)`,

  `CREATE TABLE gateway_policy_receipts (
    id TEXT PRIMARY KEY NOT NULL,
    policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
    connector_id TEXT NOT NULL,
    actor_id TEXT,
    audience TEXT NOT NULL,
    template_ref TEXT,
    consent_verified INTEGER NOT NULL CHECK (consent_verified IN (0, 1)),
    cost_estimate REAL,
    decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny', 'blocked')),
    reason TEXT,
    evaluated_at TEXT NOT NULL
  ) STRICT`,

  `CREATE TABLE gateway_audit (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    resource TEXT NOT NULL,
    outcome TEXT NOT NULL,
    reason TEXT,
    metadata_json TEXT,
    at TEXT NOT NULL
  ) STRICT`,

  `CREATE TABLE gateway_watchdog_leases (
    host_id TEXT PRIMARY KEY NOT NULL,
    owner_epoch INTEGER NOT NULL CHECK (owner_epoch >= 1),
    heartbeat_at TEXT NOT NULL,
    last_signal TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,

  `CREATE TABLE gateway_rate_buckets (
    bucket_key TEXT PRIMARY KEY NOT NULL,
    connector_id TEXT NOT NULL REFERENCES gateway_connectors(id),
    target_binding_id TEXT NOT NULL,
    tokens_remaining REAL NOT NULL,
    capacity REAL NOT NULL CHECK (capacity > 0),
    refill_per_second REAL NOT NULL CHECK (refill_per_second > 0),
    blocked_until_at TEXT,
    updated_at TEXT NOT NULL
  ) STRICT`,
];

function tightenPrivateFiles(file: string): void {
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      const info = lstatSync(candidate);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new GatewayStoreError('INVALID_PATH', 'Gateway database path must be a regular non-symlink file.');
      }
      if (process.platform !== 'win32') chmodSync(candidate, PRIVATE_FILE_MODE);
    } catch (error) {
      if (error instanceof GatewayStoreError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new GatewayStoreError('STORAGE_UNAVAILABLE', 'Unable to verify Gateway database file permissions.');
      }
    }
  }
}

export class GatewayStore {
  private closed = false;

  private constructor(
    private readonly db: DatabaseSync,
    public readonly file: string,
  ) {}

  static async open(file: string): Promise<GatewayStore> {
    if (typeof file !== 'string' || !file.trim() || file.includes('\0') || file === ':memory:') {
      throw new GatewayStoreError('INVALID_PATH', 'Gateway database requires an explicit private file path.');
    }
    const location = path.resolve(file);
    await ensurePrivateDirectory(path.dirname(location));
    let db: DatabaseSync | undefined;
    try {
      tightenPrivateFiles(location);
      const descriptor = openSync(
        location,
        constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
        PRIVATE_FILE_MODE,
      );
      closeSync(descriptor);
      db = new DatabaseSync(location);
      const store = new GatewayStore(db, location);
      store.initialize();
      tightenPrivateFiles(location);
      return store;
    } catch (error) {
      try { db?.close(); } catch { /* preserve original error */ }
      if (error instanceof GatewayStoreError) throw error;
      throw new GatewayStoreError(
        'STORAGE_UNAVAILABLE',
        `Gateway storage failed to open: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new GatewayStoreError('CLOSED', 'GatewayStore is closed.');
    }
  }

  /** Exposed for sibling Gateway Host modules (routing, autonomousReports, outbox). */
  get database(): DatabaseSync {
    this.ensureOpen();
    return this.db;
  }

  private initialize(): void {
    this.db.exec('PRAGMA busy_timeout = 1000; PRAGMA foreign_keys = ON;');
    const versionRow = this.db.prepare('PRAGMA user_version').all()[0] as { user_version?: number } | undefined;
    const version = Number(versionRow?.user_version ?? 0);
    const existingObjects = this.db
      .prepare("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
      .all();

    if (version > GATEWAY_SCHEMA_VERSION) {
      throw new GatewayStoreError(
        'SCHEMA_DOWNGRADE_REFUSED',
        `Gateway database schema version ${version} is newer than supported version ${GATEWAY_SCHEMA_VERSION}. Refusing unsafe downgrade.`,
      );
    }

    if (version === 0 && existingObjects.length === 0) {
      this.transaction(() => {
        for (const sql of SCHEMA_V1) this.db.exec(sql);
        this.db.exec(`PRAGMA user_version = ${GATEWAY_SCHEMA_VERSION}`);
      });
    } else if (version !== GATEWAY_SCHEMA_VERSION) {
      throw new GatewayStoreError(
        'CORRUPT_DATABASE',
        `Unexpected Gateway database schema version ${version}.`,
      );
    }

    const integrityRow = this.db.prepare('PRAGMA integrity_check').all()[0] as Record<string, unknown> | undefined;
    if (integrityRow?.integrity_check !== 'ok') {
      throw new GatewayStoreError('CORRUPT_DATABASE', 'Gateway database integrity_check failed.');
    }

    const journalRow = this.db.prepare('PRAGMA journal_mode = WAL').all()[0] as { journal_mode?: string } | undefined;
    if (journalRow?.journal_mode !== 'wal') {
      throw new GatewayStoreError('STORAGE_UNAVAILABLE', 'Gateway database failed to enable WAL mode.');
    }
    this.db.exec('PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 1000;');
  }

  transaction<T>(fn: () => T): T {
    this.ensureOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore rollback error */ }
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  getSchemaVersion(): number {
    this.ensureOpen();
    const row = this.db.prepare('PRAGMA user_version').all()[0] as { user_version?: number } | undefined;
    return Number(row?.user_version ?? 0);
  }

  upsertConnector(input: {
    id: string;
    provider: GatewayProvider;
    providerAccountId: string;
    secretRef: string;
    status?: GatewayConnectorState;
    policyVersion?: number;
    capabilityRevision?: number;
    capabilities?: GatewayCapabilities;
    now: string;
  }): GatewayConnectorRecord {
    this.ensureOpen();
    assertOpaqueSecretRef(input.secretRef);
    const status: GatewayConnectorState = input.status ?? 'disabled';
    const policyVersion = input.policyVersion ?? 1;
    const capabilityRevision = input.capabilityRevision ?? 1;
    const capabilitiesJson = input.capabilities ? JSON.stringify(input.capabilities) : null;

    return this.transaction(() => {
      const existing = this.db
        .prepare('SELECT created_at, lease_owner, lease_epoch, lease_expires_at FROM gateway_connectors WHERE id = ?')
        .get(input.id) as { created_at: string; lease_owner: string | null; lease_epoch: number; lease_expires_at: string | null } | undefined;

      if (!existing) {
        this.db.prepare(
          `INSERT INTO gateway_connectors(
            id, provider, provider_account_id, secret_ref, status,
            policy_version, capability_revision, capabilities_json,
            lease_owner, lease_epoch, lease_expires_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?)`,
        ).run(
          input.id,
          input.provider,
          input.providerAccountId,
          input.secretRef,
          status,
          policyVersion,
          capabilityRevision,
          capabilitiesJson,
          input.now,
          input.now,
        );
      } else {
        this.db.prepare(
          `UPDATE gateway_connectors
           SET provider = ?, provider_account_id = ?, secret_ref = ?, status = ?,
               policy_version = ?, capability_revision = ?, capabilities_json = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
          input.provider,
          input.providerAccountId,
          input.secretRef,
          status,
          policyVersion,
          capabilityRevision,
          capabilitiesJson,
          input.now,
          input.id,
        );
      }

      return this.getConnector(input.id)!;
    });
  }

  private mapConnectorRow(row: Record<string, unknown>): GatewayConnectorRecord {
    return {
      id: String(row.id),
      provider: String(row.provider),
      providerAccountId: String(row.provider_account_id),
      secretRef: String(row.secret_ref),
      status: String(row.status) as GatewayConnectorState,
      policyVersion: Number(row.policy_version),
      capabilityRevision: Number(row.capability_revision),
      capabilities: row.capabilities_json ? JSON.parse(String(row.capabilities_json)) as GatewayCapabilities : undefined,
      leaseOwner: row.lease_owner ? String(row.lease_owner) : undefined,
      leaseEpoch: Number(row.lease_epoch),
      leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  getConnector(connectorId: string): GatewayConnectorRecord | undefined {
    this.ensureOpen();
    const row = this.db
      .prepare('SELECT * FROM gateway_connectors WHERE id = ?')
      .get(connectorId) as Record<string, unknown> | undefined;
    return row ? this.mapConnectorRow(row) : undefined;
  }

  listConnectors(): GatewayConnectorRecord[] {
    this.ensureOpen();
    const rows = this.db
      .prepare('SELECT * FROM gateway_connectors ORDER BY created_at ASC, id ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(row => this.mapConnectorRow(row));
  }

  listPrincipalLinks(): GatewayPrincipalLinkView[] {
    this.ensureOpen();
    const rows = this.db
      .prepare('SELECT * FROM gateway_principal_links ORDER BY confirmed_at DESC, id ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(row => ({
      id: String(row.id),
      connectorId: String(row.connector_id),
      providerAccountId: String(row.provider_account_id),
      externalActorId: String(row.external_actor_id),
      extaliaPrincipalId: String(row.extalia_principal_id),
      permissionBands: JSON.parse(String(row.permission_bands_json)) as GatewayPermissionBand[],
      state: String(row.state) as GatewayPrincipalLinkView['state'],
      ...(row.expires_at ? { expiresAt: String(row.expires_at) } : {}),
      confirmedAt: String(row.confirmed_at),
      ...(row.revoked_at ? { revokedAt: String(row.revoked_at) } : {}),
      ...(row.revocation_reason ? { revocationReason: String(row.revocation_reason) } : {}),
    }));
  }

  listRoutes(): GatewayRouteRecord[] {
    this.ensureOpen();
    const rows = this.db
      .prepare('SELECT * FROM gateway_routes ORDER BY created_at ASC, id ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(row => {
      const threadKey = String(row.thread_key);
      return {
        id: String(row.id),
        connectorId: String(row.connector_id),
        providerAccountId: String(row.provider_account_id),
        channelId: String(row.channel_id),
        threadId: threadKey.length ? threadKey : undefined,
        workspaceId: String(row.workspace_id),
        mode: String(row.mode) as GatewayRouteMode,
        audience: String(row.audience) as GatewayAudience,
        policyRevision: Number(row.policy_revision),
        inboundEnabled: Number(row.inbound_enabled) === 1,
        outboundEnabled: Number(row.outbound_enabled) === 1,
        isDmDefault: Number(row.is_dm_default) === 1,
        linkedPrincipalId: row.linked_principal_id ? String(row.linked_principal_id) : undefined,
        state: String(row.state) as GatewayBindingState,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      };
    });
  }

  deleteRoute(routeId: string): boolean {
    this.ensureOpen();
    return this.transaction(() => {
      const result = this.db
        .prepare('DELETE FROM gateway_routes WHERE id = ?')
        .run(routeId);
      return Number(result.changes) > 0;
    });
  }

  setConnectorStatus(connectorId: string, status: GatewayConnectorState, now: string): GatewayConnectorRecord | undefined {
    this.ensureOpen();
    this.db
      .prepare('UPDATE gateway_connectors SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now, connectorId);
    return this.getConnector(connectorId);
  }

  recordAudit(entry: {
    actor: string;
    action: string;
    resource: string;
    outcome: string;
    reason?: string;
    metadata?: Record<string, unknown>;
    at: string;
  }): number {
    this.ensureOpen();
    const safeReason = entry.reason ? sanitizeGatewayText(entry.reason, { maxLength: 500 }).text : null;
    const safeMeta = entry.metadata
      ? sanitizeGatewayText(JSON.stringify(entry.metadata), { maxLength: 2000 }).text
      : null;
    const result = this.db.prepare(
      `INSERT INTO gateway_audit(actor, action, resource, outcome, reason, metadata_json, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(entry.actor, entry.action, entry.resource, entry.outcome, safeReason, safeMeta, entry.at);
    return Number(result.lastInsertRowid);
  }

  listAudit(limit = 100): GatewayAuditEntry[] {
    this.ensureOpen();
    const rows = this.db
      .prepare('SELECT * FROM gateway_audit ORDER BY sequence DESC LIMIT ?')
      .all(Math.max(1, Math.min(limit, 1000))) as Array<Record<string, unknown>>;
    return rows.map(row => ({
      sequence: Number(row.sequence),
      actor: String(row.actor),
      action: String(row.action),
      resource: String(row.resource),
      outcome: String(row.outcome),
      reason: row.reason ? String(row.reason) : undefined,
      metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) as Record<string, unknown> : undefined,
      at: String(row.at),
    }));
  }

  recordWatchdogLease(input: {
    hostId: string;
    ownerEpoch: number;
    heartbeatAt: string;
    lastSignal: string;
    now: string;
  }): GatewayWatchdogLeaseRecord {
    this.ensureOpen();
    this.db.prepare(
      `INSERT INTO gateway_watchdog_leases(host_id, owner_epoch, heartbeat_at, last_signal, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(host_id) DO UPDATE SET
         owner_epoch = excluded.owner_epoch,
         heartbeat_at = excluded.heartbeat_at,
         last_signal = excluded.last_signal,
         updated_at = excluded.updated_at
       WHERE excluded.owner_epoch >= gateway_watchdog_leases.owner_epoch`,
    ).run(input.hostId, input.ownerEpoch, input.heartbeatAt, input.lastSignal, input.now);
    const row = this.db
      .prepare('SELECT * FROM gateway_watchdog_leases WHERE host_id = ?')
      .get(input.hostId) as Record<string, unknown>;
    return {
      hostId: String(row.host_id),
      ownerEpoch: Number(row.owner_epoch),
      heartbeatAt: String(row.heartbeat_at),
      lastSignal: String(row.last_signal),
      updatedAt: String(row.updated_at),
    };
  }
}
