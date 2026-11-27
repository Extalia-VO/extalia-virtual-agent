/**
 * Durable Gateway outbox, priority queueing, per-destination rate buckets,
 * `unknown`-send quarantine, monotonic delivery reconciliation, and
 * 5-dimension connector health aggregation (PRD §12, §14, §15, §18.6, §20.1, §20.5).
 */
import {
  sanitizeGatewayText,
  validateConnectorHealth,
  validateGatewayOutboundIntent,
  type AgentPortraitIdentity,
  type ApprovedOutbound,
  type ConnectorHealth,
  type ConnectorHealthDimension,
  type DetailLevel,
  type ExecutionHealthState,
  type GatewayConnectorState,
  type GatewayOutboundIntent,
  type GatewayOutboundMessageClass,
  type GatewayOutboundPriority,
  type GatewayOutboundState,
  type GatewayProvider,
} from '@extalia/platform';
import { createHash, randomUUID } from 'node:crypto';
import { buildDeliveryKey, type GatewayStore } from './store.js';

export interface EnqueueOutboundInput {
  connectorId: string;
  targetBindingId: string;
  targetBindingRevision: number;
  reportOrSourceEventId: string;
  sourceEventId?: string;
  reportId?: string;
  reportRevision?: number;
  senderKind: 'gateway-system' | 'lead' | 'worker';
  senderPortrait?: AgentPortraitIdentity;
  format: DetailLevel;
  messageClass: GatewayOutboundMessageClass;
  priority?: GatewayOutboundPriority;
  recipientId?: string;
  rawText: string;
  maxMessageLength?: number;
  projectionVersion?: number;
  policyVersion?: number;
  audience?: string;
  actorId?: string;
  consentVerified?: boolean;
  costEstimate?: number;
  now: string;
}

export interface ClaimedOutboundIntent {
  intent: GatewayOutboundIntent;
  approved: ApprovedOutbound;
  attemptNumber: number;
}

export interface SendAttemptRecord {
  id: string;
  intentId: string;
  attemptNumber: number;
  leaseOwner: string;
  fencingToken: string;
  providerRequestKey: string;
  httpStatus?: number;
  classification: 'accepted' | 'retryable' | 'failed-retryable' | 'blocked' | 'unknown' | 'stale-authority';
  remoteMessageId?: string;
  errorMessage?: string;
  attemptedAt: string;
}

export type RecordSendResultInput =
  | {
    kind: 'accepted';
    intentId: string;
    fencingToken: string;
    leaseOwner: string;
    providerRequestKey: string;
    remoteMessageId: string;
    httpStatus?: number;
    now: string;
  }
  | {
    kind: 'rate-limited';
    intentId: string;
    fencingToken: string;
    leaseOwner: string;
    providerRequestKey: string;
    httpStatus?: number;
    retryAfterSeconds: number;
    errorMessage?: string;
    now: string;
  }
  | {
    kind: 'retryable';
    intentId: string;
    fencingToken: string;
    leaseOwner: string;
    providerRequestKey: string;
    httpStatus?: number;
    backoffSeconds?: number;
    errorMessage: string;
    now: string;
  }
  | {
    kind: 'permanent-blocked';
    intentId: string;
    fencingToken: string;
    leaseOwner: string;
    providerRequestKey: string;
    httpStatus?: number;
    errorMessage: string;
    now: string;
  }
  | {
    kind: 'ambiguous-timeout';
    intentId: string;
    fencingToken: string;
    leaseOwner: string;
    providerRequestKey: string;
    errorMessage: string;
    now: string;
  };

const PRIORITY_RANK: Readonly<Record<GatewayOutboundPriority, number>> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

const DELIVERY_RANK: Readonly<Record<'accepted' | 'delivered' | 'read', number>> = {
  accepted: 1,
  delivered: 2,
  read: 3,
};

export function defaultPriorityForMessageClass(messageClass: GatewayOutboundMessageClass): GatewayOutboundPriority {
  switch (messageClass) {
    case 'attention':
      return 'P0';
    case 'terminal':
    case 'system-report':
      return 'P1';
    case 'accepted':
    case 'milestone':
      return 'P2';
    case 'heartbeat':
      return 'P3';
  }
}

function mapOutboxRow(row: Record<string, unknown>): GatewayOutboundIntent {
  return {
    id: String(row.id),
    connectorId: String(row.connector_id),
    targetBindingId: String(row.target_binding_id),
    targetBindingRevision: Number(row.target_binding_revision),
    sourceEventId: row.source_event_id ? String(row.source_event_id) : undefined,
    reportId: row.report_id ? String(row.report_id) : undefined,
    reportRevision: row.report_revision !== null && row.report_revision !== undefined ? Number(row.report_revision) : undefined,
    senderKind: String(row.sender_kind) as GatewayOutboundIntent['senderKind'],
    senderPortrait: row.sender_portrait_json ? JSON.parse(String(row.sender_portrait_json)) as AgentPortraitIdentity : undefined,
    format: String(row.format) as DetailLevel,
    messageClass: String(row.message_class) as GatewayOutboundMessageClass,
    priority: String(row.priority) as GatewayOutboundPriority,
    recipientId: row.recipient_id ? String(row.recipient_id) : undefined,
    payloadDigest: String(row.payload_digest),
    policyEvaluationId: String(row.policy_evaluation_id),
    state: String(row.state) as GatewayOutboundState,
    remoteMessageId: row.remote_message_id ? String(row.remote_message_id) : undefined,
    lastProviderError: row.last_provider_error ? String(row.last_provider_error) : undefined,
    retryAfterAt: row.retry_after_at ? String(row.retry_after_at) : undefined,
  };
}

function mapAttemptRow(row: Record<string, unknown>): SendAttemptRecord {
  return {
    id: String(row.id),
    intentId: String(row.intent_id),
    attemptNumber: Number(row.attempt_number),
    leaseOwner: String(row.lease_owner),
    fencingToken: String(row.fencing_token),
    providerRequestKey: String(row.provider_request_key),
    httpStatus: row.http_status !== null && row.http_status !== undefined ? Number(row.http_status) : undefined,
    classification: String(row.classification) as SendAttemptRecord['classification'],
    remoteMessageId: row.remote_message_id ? String(row.remote_message_id) : undefined,
    errorMessage: row.error_message ? String(row.error_message) : undefined,
    attemptedAt: String(row.attempted_at),
  };
}

export class GatewayOutboxService {
  constructor(private readonly store: GatewayStore) {}

  configureRateBucket(input: {
    connectorId: string;
    targetBindingId: string;
    capacity: number;
    refillPerSecond: number;
    now: string;
  }): void {
    const bucketKey = `${input.connectorId}::${input.targetBindingId}`;
    this.store.database.prepare(
      `INSERT INTO gateway_rate_buckets(
        bucket_key, connector_id, target_binding_id, tokens_remaining,
        capacity, refill_per_second, blocked_until_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(bucket_key) DO UPDATE SET
        capacity = excluded.capacity,
        refill_per_second = excluded.refill_per_second,
        tokens_remaining = MIN(gateway_rate_buckets.tokens_remaining, excluded.capacity),
        updated_at = excluded.updated_at`,
    ).run(
      bucketKey,
      input.connectorId,
      input.targetBindingId,
      input.capacity,
      input.capacity,
      input.refillPerSecond,
      input.now,
    );
  }

  /** Transactionally persists a sanitized outbound intent before any network send. */
  enqueue(input: EnqueueOutboundInput): { intent: GatewayOutboundIntent; safeText: string; deduplicated: boolean } {
    const sanitized = sanitizeGatewayText(input.rawText, {
      maxLength: input.maxMessageLength ?? 4000,
      stripMentions: true,
      redactSecrets: true,
      redactPaths: true,
    });
    const priority = input.priority ?? defaultPriorityForMessageClass(input.messageClass);
    const projectionVersion = input.projectionVersion ?? 1;
    const payloadDigest = createHash('sha256').update(sanitized.text).digest('hex');
    const deliveryKey = buildDeliveryKey({
      reportOrSourceEventId: input.reportOrSourceEventId,
      bindingId: input.targetBindingId,
      bindingRevision: input.targetBindingRevision,
      messageClass: input.messageClass,
      recipientId: input.recipientId,
      projectionVersion,
    });

    return this.store.transaction(() => {
      const existing = this.store.database
        .prepare('SELECT * FROM gateway_outbox WHERE delivery_key = ?')
        .get(deliveryKey) as Record<string, unknown> | undefined;

      if (existing) {
        return {
          intent: mapOutboxRow(existing),
          safeText: String(existing.safe_text),
          deduplicated: true,
        };
      }

      const policyEvaluationId = `pol_${randomUUID()}`;
      this.store.database.prepare(
        `INSERT INTO gateway_policy_receipts(
          id, policy_version, connector_id, actor_id, audience,
          consent_verified, cost_estimate, decision, reason, evaluated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'allow', 'enqueued', ?)`,
      ).run(
        policyEvaluationId,
        input.policyVersion ?? 1,
        input.connectorId,
        input.actorId ?? null,
        input.audience ?? 'private',
        (input.consentVerified ?? true) ? 1 : 0,
        input.costEstimate ?? null,
        input.now,
      );

      const intentId = `out_${randomUUID()}`;
      const intent: GatewayOutboundIntent = {
        id: intentId,
        connectorId: input.connectorId,
        targetBindingId: input.targetBindingId,
        targetBindingRevision: input.targetBindingRevision,
        ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}),
        ...(input.reportId ? { reportId: input.reportId } : {}),
        ...(input.reportRevision !== undefined ? { reportRevision: input.reportRevision } : {}),
        senderKind: input.senderKind,
        ...(input.senderPortrait ? { senderPortrait: input.senderPortrait } : {}),
        format: input.format,
        messageClass: input.messageClass,
        priority,
        ...(input.recipientId ? { recipientId: input.recipientId } : {}),
        payloadDigest,
        policyEvaluationId,
        state: 'pending',
      };

      const validated = validateGatewayOutboundIntent(intent);
      if (!validated.ok) {
        throw new Error(`Invalid GatewayOutboundIntent: ${validated.error}`);
      }

      this.store.database.prepare(
        `INSERT INTO gateway_outbox(
          id, delivery_key, connector_id, target_binding_id, target_binding_revision,
          source_event_id, report_id, report_revision, sender_kind, sender_portrait_json,
          format, message_class, priority, priority_rank, recipient_id, payload_digest,
          safe_text, policy_evaluation_id, state, attempt_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      ).run(
        intentId,
        deliveryKey,
        input.connectorId,
        input.targetBindingId,
        input.targetBindingRevision,
        input.sourceEventId ?? null,
        input.reportId ?? null,
        input.reportRevision ?? null,
        input.senderKind,
        input.senderPortrait ? JSON.stringify(input.senderPortrait) : null,
        input.format,
        input.messageClass,
        priority,
        PRIORITY_RANK[priority],
        input.recipientId ?? null,
        payloadDigest,
        sanitized.text,
        policyEvaluationId,
        input.now,
        input.now,
      );

      return { intent, safeText: sanitized.text, deduplicated: false };
    });
  }

  /**
   * Revalidates current authorization and binding revision right before send (GW-AT-008, GW-AT-014).
   * If revoked or stale, marks the intent `blocked` with zero destination fallback.
   */
  revalidateBeforeSend(input: {
    intentId: string;
    isAuthorized: boolean;
    currentBindingRevision?: number;
    reason?: string;
    now: string;
  }): { ok: true } | { ok: false; reason: string } {
    return this.store.transaction(() => {
      const row = this.store.database
        .prepare('SELECT * FROM gateway_outbox WHERE id = ?')
        .get(input.intentId) as Record<string, unknown> | undefined;
      if (!row) return { ok: false, reason: 'Intent not found.' };
      if (String(row.state) === 'unknown') {
        return { ok: false, reason: 'Intent is quarantined in unknown state; blind resend is blocked.' };
      }

      const staleRevision =
        input.currentBindingRevision !== undefined
        && Number(row.target_binding_revision) !== input.currentBindingRevision;

      if (!input.isAuthorized || staleRevision) {
        const reason = !input.isAuthorized
          ? (input.reason ?? 'Host permission revoked before send.')
          : `Stale binding revision ${String(row.target_binding_revision)} vs current ${input.currentBindingRevision}.`;
        this.store.database.prepare(
          `UPDATE gateway_outbox
           SET state = 'blocked', last_provider_error = ?, updated_at = ?
           WHERE id = ? AND state IN ('pending', 'leased', 'sending')`,
        ).run(reason, input.now, input.intentId);
        this.store.recordAudit({
          actor: 'host:outbox',
          action: 'outbox.revalidation.blocked',
          resource: `outbox:${input.intentId}`,
          outcome: 'blocked',
          reason,
          at: input.now,
        });
        return { ok: false, reason };
      }

      return { ok: true };
    });
  }

  /**
   * Claims the highest-priority (`P0`..`P3`) ready `pending` intent whose per-destination
   * rate bucket has tokens available. Never claims `unknown` (quarantined) or `blocked` intents.
   */
  claimNextReady(input: {
    leaseOwner: string;
    connectorId?: string;
    leaseTtlSeconds?: number;
    now: string;
  }): ClaimedOutboundIntent | undefined {
    const leaseTtlSeconds = Math.max(5, Math.min(input.leaseTtlSeconds ?? 60, 300));
    const nowMs = Date.parse(input.now);

    return this.store.transaction(() => {
      const candidates = (input.connectorId
        ? this.store.database.prepare(
          `SELECT o.* FROM gateway_outbox o
           JOIN gateway_connectors c ON c.id = o.connector_id
           WHERE o.state = 'pending'
             AND o.connector_id = ?
             AND c.status NOT IN ('disabled', 'revoked', 'blocked')
             AND (o.retry_after_at IS NULL OR o.retry_after_at <= ?)
           ORDER BY o.priority_rank ASC, o.created_at ASC
           LIMIT 50`,
        ).all(input.connectorId, input.now)
        : this.store.database.prepare(
          `SELECT o.* FROM gateway_outbox o
           JOIN gateway_connectors c ON c.id = o.connector_id
           WHERE o.state = 'pending'
             AND c.status NOT IN ('disabled', 'revoked', 'blocked')
             AND (o.retry_after_at IS NULL OR o.retry_after_at <= ?)
           ORDER BY o.priority_rank ASC, o.created_at ASC
           LIMIT 50`,
        ).all(input.now)) as Array<Record<string, unknown>>;

      for (const row of candidates) {
        const connectorId = String(row.connector_id);
        const targetBindingId = String(row.target_binding_id);
        if (!this.tryConsumeRateToken(connectorId, targetBindingId, nowMs, input.now)) {
          continue;
        }

        const intentId = String(row.id);
        const attemptNumber = Number(row.attempt_count) + 1;
        const fencingToken = `fnc_${randomUUID()}`;
        const leaseExpiresAt = new Date(nowMs + leaseTtlSeconds * 1000).toISOString();
        const providerRequestKey = createHash('sha256')
          .update(`${intentId}:${attemptNumber}:${fencingToken}`)
          .digest('hex');

        this.store.database.prepare(
          `UPDATE gateway_outbox
           SET state = 'sending',
               attempt_count = ?,
               fencing_token = ?,
               lease_owner = ?,
               lease_expires_at = ?,
               updated_at = ?
           WHERE id = ?`,
        ).run(attemptNumber, fencingToken, input.leaseOwner, leaseExpiresAt, input.now, intentId);

        const updated = this.store.database
          .prepare('SELECT * FROM gateway_outbox WHERE id = ?')
          .get(intentId) as Record<string, unknown>;
        const intent = mapOutboxRow(updated);
        return {
          intent,
          approved: {
            intent,
            safeText: String(updated.safe_text),
            disableMentions: true,
            fencingToken,
            providerRequestKey,
          },
          attemptNumber,
        };
      }

      return undefined;
    });
  }

  private tryConsumeRateToken(
    connectorId: string,
    targetBindingId: string,
    nowMs: number,
    nowIso: string,
  ): boolean {
    const bucketKey = `${connectorId}::${targetBindingId}`;
    const bucket = this.store.database
      .prepare('SELECT * FROM gateway_rate_buckets WHERE bucket_key = ?')
      .get(bucketKey) as Record<string, unknown> | undefined;

    if (!bucket) {
      this.store.database.prepare(
        `INSERT INTO gateway_rate_buckets(
          bucket_key, connector_id, target_binding_id, tokens_remaining,
          capacity, refill_per_second, blocked_until_at, updated_at
        ) VALUES (?, ?, ?, 4, 5, 1, NULL, ?)`,
      ).run(bucketKey, connectorId, targetBindingId, nowIso);
      return true;
    }

    if (bucket.blocked_until_at && Date.parse(String(bucket.blocked_until_at)) > nowMs) {
      return false;
    }

    const elapsedSec = Math.max(0, (nowMs - Date.parse(String(bucket.updated_at))) / 1000);
    const capacity = Number(bucket.capacity);
    const refillPerSecond = Number(bucket.refill_per_second);
    const refilled = Math.min(capacity, Number(bucket.tokens_remaining) + elapsedSec * refillPerSecond);

    if (refilled < 1) {
      return false;
    }

    this.store.database.prepare(
      `UPDATE gateway_rate_buckets
       SET tokens_remaining = ?, blocked_until_at = NULL, updated_at = ?
       WHERE bucket_key = ?`,
    ).run(refilled - 1, nowIso, bucketKey);
    return true;
  }

  /** Records an append-only send attempt and transitions the outbox intent honestly. */
  recordSendResult(input: RecordSendResultInput): { intent: GatewayOutboundIntent; attempt: SendAttemptRecord } {
    return this.store.transaction(() => {
      const row = this.store.database
        .prepare('SELECT * FROM gateway_outbox WHERE id = ?')
        .get(input.intentId) as Record<string, unknown> | undefined;
      if (!row) throw new Error(`Outbox intent "${input.intentId}" not found.`);

      const attemptNumber = Math.max(1, Number(row.attempt_count));
      const attemptId = `att_${randomUUID()}`;

      // Fence stale lease owners.
      if (String(row.fencing_token ?? '') !== input.fencingToken) {
        this.store.database.prepare(
          `INSERT INTO gateway_send_attempts(
            id, intent_id, attempt_number, lease_owner, fencing_token,
            provider_request_key, classification, error_message, attempted_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'stale-authority', 'Fencing token mismatch.', ?)`,
        ).run(
          attemptId,
          input.intentId,
          attemptNumber + 1,
          input.leaseOwner,
          input.fencingToken,
          input.providerRequestKey,
          input.now,
        );
        const attempt = mapAttemptRow(
          this.store.database.prepare('SELECT * FROM gateway_send_attempts WHERE id = ?').get(attemptId) as Record<string, unknown>,
        );
        return { intent: mapOutboxRow(row), attempt };
      }

      if (input.kind === 'accepted') {
        this.store.database.prepare(
          `INSERT INTO gateway_send_attempts(
            id, intent_id, attempt_number, lease_owner, fencing_token,
            provider_request_key, http_status, classification, remote_message_id, attempted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?)`,
        ).run(
          attemptId,
          input.intentId,
          attemptNumber,
          input.leaseOwner,
          input.fencingToken,
          input.providerRequestKey,
          input.httpStatus ?? 200,
          input.remoteMessageId,
          input.now,
        );

        this.store.database.prepare(
          `UPDATE gateway_outbox
           SET state = 'accepted', remote_message_id = ?, last_provider_error = NULL,
               retry_after_at = NULL, updated_at = ?
           WHERE id = ?`,
        ).run(input.remoteMessageId, input.now, input.intentId);
      } else if (input.kind === 'rate-limited') {
        const retryAfterMs = Math.max(1, input.retryAfterSeconds) * 1000;
        const retryAfterAt = new Date(Date.parse(input.now) + retryAfterMs).toISOString();
        const safeErr = sanitizeGatewayText(input.errorMessage ?? `HTTP 429 retry_after=${input.retryAfterSeconds}s`, { maxLength: 500 }).text;

        this.store.database.prepare(
          `INSERT INTO gateway_send_attempts(
            id, intent_id, attempt_number, lease_owner, fencing_token,
            provider_request_key, http_status, classification, error_message, attempted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'failed-retryable', ?, ?)`,
        ).run(
          attemptId,
          input.intentId,
          attemptNumber,
          input.leaseOwner,
          input.fencingToken,
          input.providerRequestKey,
          input.httpStatus ?? 429,
          safeErr,
          input.now,
        );

        this.store.database.prepare(
          `UPDATE gateway_outbox
           SET state = 'pending', retry_after_at = ?, last_provider_error = ?, updated_at = ?
           WHERE id = ?`,
        ).run(retryAfterAt, safeErr, input.now, input.intentId);

        const bucketKey = `${String(row.connector_id)}::${String(row.target_binding_id)}`;
        this.store.database.prepare(
          `UPDATE gateway_rate_buckets
           SET tokens_remaining = 0, blocked_until_at = ?, updated_at = ?
           WHERE bucket_key = ?`,
        ).run(retryAfterAt, input.now, bucketKey);
      } else if (input.kind === 'retryable') {
        const backoffMs = Math.max(1, input.backoffSeconds ?? 5) * 1000;
        const retryAfterAt = new Date(Date.parse(input.now) + backoffMs).toISOString();
        const safeErr = sanitizeGatewayText(input.errorMessage, { maxLength: 500 }).text;

        this.store.database.prepare(
          `INSERT INTO gateway_send_attempts(
            id, intent_id, attempt_number, lease_owner, fencing_token,
            provider_request_key, http_status, classification, error_message, attempted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'retryable', ?, ?)`,
        ).run(
          attemptId,
          input.intentId,
          attemptNumber,
          input.leaseOwner,
          input.fencingToken,
          input.providerRequestKey,
          input.httpStatus ?? null,
          safeErr,
          input.now,
        );

        this.store.database.prepare(
          `UPDATE gateway_outbox
           SET state = 'pending', retry_after_at = ?, last_provider_error = ?, updated_at = ?
           WHERE id = ?`,
        ).run(retryAfterAt, safeErr, input.now, input.intentId);
      } else if (input.kind === 'permanent-blocked') {
        const safeErr = sanitizeGatewayText(input.errorMessage, { maxLength: 500 }).text;

        this.store.database.prepare(
          `INSERT INTO gateway_send_attempts(
            id, intent_id, attempt_number, lease_owner, fencing_token,
            provider_request_key, http_status, classification, error_message, attempted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'blocked', ?, ?)`,
        ).run(
          attemptId,
          input.intentId,
          attemptNumber,
          input.leaseOwner,
          input.fencingToken,
          input.providerRequestKey,
          input.httpStatus ?? 403,
          safeErr,
          input.now,
        );

        this.store.database.prepare(
          `UPDATE gateway_outbox
           SET state = 'blocked', last_provider_error = ?, retry_after_at = NULL, updated_at = ?
           WHERE id = ?`,
        ).run(safeErr, input.now, input.intentId);

        this.store.recordAudit({
          actor: input.leaseOwner,
          action: 'outbox.permanent_blocked',
          resource: `outbox:${input.intentId}`,
          outcome: 'blocked',
          reason: safeErr,
          at: input.now,
        });
      } else {
        // Ambiguous timeout after request dispatch: quarantine as `unknown` to block blind resend!
        const safeErr = sanitizeGatewayText(input.errorMessage, { maxLength: 500 }).text;

        this.store.database.prepare(
          `INSERT INTO gateway_send_attempts(
            id, intent_id, attempt_number, lease_owner, fencing_token,
            provider_request_key, classification, error_message, attempted_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'unknown', ?, ?)`,
        ).run(
          attemptId,
          input.intentId,
          attemptNumber,
          input.leaseOwner,
          input.fencingToken,
          input.providerRequestKey,
          safeErr,
          input.now,
        );

        this.store.database.prepare(
          `UPDATE gateway_outbox
           SET state = 'unknown', last_provider_error = ?, retry_after_at = NULL, updated_at = ?
           WHERE id = ?`,
        ).run(safeErr, input.now, input.intentId);

        this.store.recordAudit({
          actor: input.leaseOwner,
          action: 'outbox.quarantined_unknown',
          resource: `outbox:${input.intentId}`,
          outcome: 'unknown',
          reason: safeErr,
          at: input.now,
        });
      }

      const updatedIntent = mapOutboxRow(
        this.store.database.prepare('SELECT * FROM gateway_outbox WHERE id = ?').get(input.intentId) as Record<string, unknown>,
      );
      const attempt = mapAttemptRow(
        this.store.database.prepare('SELECT * FROM gateway_send_attempts WHERE id = ?').get(attemptId) as Record<string, unknown>,
      );
      return { intent: updatedIntent, attempt };
    });
  }

  /** Explicit reconciliation for a quarantined `unknown` send after verifying remote state. */
  reconcileUnknownIntent(input: {
    intentId: string;
    resolution: 'confirmed-accepted' | 'confirmed-not-sent' | 'abandoned-blocked';
    remoteMessageId?: string;
    reason: string;
    actor: string;
    now: string;
  }): GatewayOutboundIntent {
    return this.store.transaction(() => {
      const row = this.store.database
        .prepare('SELECT * FROM gateway_outbox WHERE id = ?')
        .get(input.intentId) as Record<string, unknown> | undefined;
      if (!row) throw new Error(`Outbox intent "${input.intentId}" not found.`);
      if (String(row.state) !== 'unknown') {
        throw new Error(`Intent "${input.intentId}" is not in unknown quarantine (state=${String(row.state)}).`);
      }

      if (input.resolution === 'confirmed-accepted') {
        if (!input.remoteMessageId) throw new Error('confirmed-accepted reconciliation requires remoteMessageId.');
        this.store.database.prepare(
          `UPDATE gateway_outbox
           SET state = 'accepted', remote_message_id = ?, last_provider_error = NULL, updated_at = ?
           WHERE id = ?`,
        ).run(input.remoteMessageId, input.now, input.intentId);
      } else if (input.resolution === 'confirmed-not-sent') {
        this.store.database.prepare(
          `UPDATE gateway_outbox
           SET state = 'pending', retry_after_at = NULL, updated_at = ?
           WHERE id = ?`,
        ).run(input.now, input.intentId);
      } else {
        this.store.database.prepare(
          `UPDATE gateway_outbox
           SET state = 'blocked', last_provider_error = ?, updated_at = ?
           WHERE id = ?`,
        ).run(input.reason, input.now, input.intentId);
      }

      this.store.recordAudit({
        actor: input.actor,
        action: 'outbox.unknown.reconciled',
        resource: `outbox:${input.intentId}`,
        outcome: input.resolution,
        reason: input.reason,
        at: input.now,
      });

      const updated = this.store.database
        .prepare('SELECT * FROM gateway_outbox WHERE id = ?')
        .get(input.intentId) as Record<string, unknown>;
      return mapOutboxRow(updated);
    });
  }

  /**
   * Cancels unsubmitted pending intents for a removed/revoked binding with zero destination fallback.
   * In-flight/unknown intents remain untouched for explicit reconciliation (PRD §6.4, GW-AT-010).
   */
  cancelPendingForBinding(input: {
    targetBindingId: string;
    reason: string;
    actor: string;
    now: string;
  }): number {
    return this.store.transaction(() => {
      const result = this.store.database.prepare(
        `UPDATE gateway_outbox
         SET state = 'blocked', last_provider_error = ?, updated_at = ?
         WHERE target_binding_id = ? AND state = 'pending'`,
      ).run(input.reason, input.now, input.targetBindingId);

      if (result.changes > 0) {
        this.store.recordAudit({
          actor: input.actor,
          action: 'outbox.binding_removed.cancelled',
          resource: `binding:${input.targetBindingId}`,
          outcome: 'blocked',
          reason: input.reason,
          metadata: { cancelledCount: Number(result.changes) },
          at: input.now,
        });
      }
      return Number(result.changes);
    });
  }

  /**
   * Monotonic delivery state reconciliation (`accepted -> delivered -> read`).
   * Out-of-order lower states are audited without regressing the higher committed state.
   */
  reconcileDeliveryState(input: {
    connectorId: string;
    remoteMessageId: string;
    nextState: 'accepted' | 'delivered' | 'read';
    at: string;
  }): { updated: boolean; currentState: GatewayOutboundState; outOfOrder: boolean } {
    return this.store.transaction(() => {
      const row = this.store.database
        .prepare('SELECT id, state FROM gateway_outbox WHERE connector_id = ? AND remote_message_id = ?')
        .get(input.connectorId, input.remoteMessageId) as { id: string; state: string } | undefined;

      if (!row) {
        return { updated: false, currentState: 'unknown', outOfOrder: false };
      }

      const currentState = row.state as GatewayOutboundState;
      const currentRank =
        currentState === 'accepted' || currentState === 'delivered' || currentState === 'read'
          ? DELIVERY_RANK[currentState]
          : 0;
      const nextRank = DELIVERY_RANK[input.nextState];

      if (nextRank <= currentRank) {
        const outOfOrder = nextRank < currentRank;
        if (outOfOrder) {
          this.store.recordAudit({
            actor: `connector:${input.connectorId}`,
            action: 'delivery.out_of_order_callback',
            resource: `outbox:${row.id}`,
            outcome: 'ignored',
            reason: `Ignored out-of-order delivery state "${input.nextState}" while already "${currentState}".`,
            at: input.at,
          });
        }
        return { updated: false, currentState, outOfOrder };
      }

      this.store.database
        .prepare('UPDATE gateway_outbox SET state = ?, updated_at = ? WHERE id = ?')
        .run(input.nextState, input.at, row.id);

      // Mirror monotonic state onto gateway_remote_receipts if present.
      if (input.nextState === 'delivered') {
        this.store.database.prepare(
          `UPDATE gateway_remote_receipts
           SET delivery_state = 'delivered', delivered_at = COALESCE(delivered_at, ?), updated_at = ?
           WHERE connector_id = ? AND remote_message_id = ?`,
        ).run(input.at, input.at, input.connectorId, input.remoteMessageId);
      } else if (input.nextState === 'read') {
        this.store.database.prepare(
          `UPDATE gateway_remote_receipts
           SET delivery_state = 'read', read_at = COALESCE(read_at, ?), updated_at = ?
           WHERE connector_id = ? AND remote_message_id = ?`,
        ).run(input.at, input.at, input.connectorId, input.remoteMessageId);
      }

      return { updated: true, currentState: input.nextState, outOfOrder: false };
    });
  }

  getIntent(intentId: string): GatewayOutboundIntent | undefined {
    const row = this.store.database
      .prepare('SELECT * FROM gateway_outbox WHERE id = ?')
      .get(intentId) as Record<string, unknown> | undefined;
    return row ? mapOutboxRow(row) : undefined;
  }

  listAttempts(intentId: string): SendAttemptRecord[] {
    const rows = this.store.database
      .prepare('SELECT * FROM gateway_send_attempts WHERE intent_id = ? ORDER BY attempt_number ASC')
      .all(intentId) as Array<Record<string, unknown>>;
    return rows.map(mapAttemptRow);
  }
}

export interface AggregateConnectorHealthInput {
  connectorId: string;
  provider: GatewayProvider;
  connectorState: GatewayConnectorState;
  transport: ConnectorHealthDimension;
  host: ConnectorHealthDimension;
  runtime: ConnectorHealthDimension;
  progress: ConnectorHealthDimension;
  notification: ConnectorHealthDimension;
  lastTransportHeartbeatAt?: string;
  lastHostHeartbeatAt?: string;
  lastRuntimeLeaseAt?: string;
  lastProgressEventAt?: string;
  lastVerifiedEffectAt?: string;
  expectedNextCheckAt?: string;
  checkedAt: string;
}

/** Builds and validates a 5-dimension ConnectorHealth snapshot (PRD §12.1). */
export function aggregateConnectorHealth(input: AggregateConnectorHealthInput): ConnectorHealth {
  const health: ConnectorHealth = {
    connectorId: input.connectorId,
    provider: input.provider,
    connectorState: input.connectorState,
    transport: input.transport,
    host: input.host,
    runtime: input.runtime,
    progress: input.progress,
    notification: input.notification,
    ...(input.lastTransportHeartbeatAt ? { lastTransportHeartbeatAt: input.lastTransportHeartbeatAt } : {}),
    ...(input.lastHostHeartbeatAt ? { lastHostHeartbeatAt: input.lastHostHeartbeatAt } : {}),
    ...(input.lastRuntimeLeaseAt ? { lastRuntimeLeaseAt: input.lastRuntimeLeaseAt } : {}),
    ...(input.lastProgressEventAt ? { lastProgressEventAt: input.lastProgressEventAt } : {}),
    ...(input.lastVerifiedEffectAt ? { lastVerifiedEffectAt: input.lastVerifiedEffectAt } : {}),
    ...(input.expectedNextCheckAt ? { expectedNextCheckAt: input.expectedNextCheckAt } : {}),
    checkedAt: input.checkedAt,
  };
  const validated = validateConnectorHealth(health);
  if (!validated.ok) {
    throw new Error(`Invalid ConnectorHealth: ${validated.error}`);
  }
  return validated.value;
}

/**
 * Classifies execution health honestly (PRD §12.2):
 * silence alone with a valid runtime lease never auto-declares failure.
 */
export function classifyExecutionHealth(input: {
  hasPendingApproval?: boolean;
  terminalState?: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  runtimeReachable: boolean;
  hasValidRuntimeLease: boolean;
  lastProgressEventAt?: string;
  stallThresholdSeconds: number;
  now: string;
}): ExecutionHealthState {
  if (input.terminalState) return input.terminalState;
  if (input.hasPendingApproval) return 'waiting_approval';
  if (!input.runtimeReachable) return 'runtime_unreachable';
  if (!input.hasValidRuntimeLease) return 'unknown';
  if (input.lastProgressEventAt) {
    const silentSec = (Date.parse(input.now) - Date.parse(input.lastProgressEventAt)) / 1000;
    if (silentSec > input.stallThresholdSeconds) {
      return 'suspected_stalled';
    }
  }
  return 'running';
}
