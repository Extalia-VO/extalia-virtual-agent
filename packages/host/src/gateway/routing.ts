/**
 * Challenge-confirmed external principal linking, deterministic route precedence,
 * reply-by-receipt resolution, and inbound admission pipeline (PRD §6, §7, §18.1, §20.1).
 */
import {
  validateGatewayInboundEvent,
  type GatewayAudience,
  type GatewayBindingState,
  type GatewayInboundActorKind,
  type GatewayInboundEvent,
  type GatewayPermissionBand,
  type GatewayRouteBinding,
  type GatewayRouteMode,
} from '@extalia/platform';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  buildInboundKey,
  buildLeadActionKey,
  normalizeThreadKey,
  type GatewayStore,
} from './store.js';

export interface LinkChallengeIssued {
  challengeId: string;
  code: string;
  connectorId: string;
  extaliaPrincipalId: string;
  expiresAt: string;
}

export interface PrincipalLinkRecord {
  id: string;
  connectorId: string;
  providerAccountId: string;
  externalActorId: string;
  extaliaPrincipalId: string;
  challengeReceipt: string;
  permissionBands: GatewayPermissionBand[];
  state: 'active' | 'expired' | 'revoked';
  expiresAt?: string;
  confirmedAt: string;
  revokedAt?: string;
  revocationReason?: string;
}

export interface GatewayRouteRecord {
  id: string;
  connectorId: string;
  providerAccountId: string;
  channelId: string;
  threadId?: string;
  workspaceId: string;
  mode: GatewayRouteMode;
  audience: GatewayAudience;
  policyRevision: number;
  inboundEnabled: boolean;
  outboundEnabled: boolean;
  isDmDefault: boolean;
  linkedPrincipalId?: string;
  state: GatewayBindingState;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteMessageReceiptRecord {
  id: string;
  provider: string;
  connectorId: string;
  remoteMessageId: string;
  providerAccountId: string;
  channelId: string;
  threadId?: string;
  workspaceId: string;
  sessionId: string;
  runId?: string;
  agentId?: string;
  taskId?: string;
  sourceEventId?: string;
  senderSnapshot: Record<string, unknown>;
  deliveryState: 'accepted' | 'delivered' | 'read' | 'failed' | 'unknown';
  acceptedAt: string;
  deliveredAt?: string;
  readAt?: string;
  updatedAt: string;
}

export type RouteResolutionResult =
  | {
    readonly ok: true;
    readonly matchedBy: 'active-binding' | 'exact-thread-route' | 'parent-channel-route' | 'dm-default';
    readonly route: GatewayRouteRecord;
    readonly binding?: GatewayRouteBinding;
  }
  | {
    readonly ok: false;
    readonly code:
      | 'NO_ROUTE'
      | 'UNREGISTERED_WORKSPACE'
      | 'STALE_ROUTE_REVISION'
      | 'INBOUND_DISABLED'
      | 'ROUTE_NOT_ACTIVE';
    readonly reason: string;
  };

export type ReplyTargetResolutionResult =
  | {
    readonly ok: true;
    readonly receipt: RemoteMessageReceiptRecord;
    readonly delegateViaLead: true;
  }
  | {
    readonly ok: false;
    readonly code: 'REPLY_RECEIPT_MISSING' | 'CROSS_WORKSPACE_REPLY_REFUSED';
    readonly reason: string;
  };

export type InboundAdmissionResult =
  | {
    readonly ok: true;
    readonly status: 'admitted' | 'duplicate' | 'ignored-echo';
    readonly inboxId?: string;
    readonly actionId?: string;
    readonly leadActionKey?: string;
    readonly route?: GatewayRouteRecord;
    readonly binding?: GatewayRouteBinding;
    readonly principal?: PrincipalLinkRecord;
    readonly replyTarget?: RemoteMessageReceiptRecord;
  }
  | {
    readonly ok: false;
    readonly code:
      | 'INVALID_ENVELOPE'
      | 'UNAUTHENTICATED_TRANSPORT'
      | 'CONNECTOR_UNAVAILABLE'
      | 'UNLINKED_PRINCIPAL'
      | 'INSUFFICIENT_PERMISSION'
      | 'ANONYMOUS_ADMIN_REFUSED'
      | 'NO_ROUTE'
      | 'UNREGISTERED_WORKSPACE'
      | 'STALE_ROUTE_REVISION'
      | 'INBOUND_DISABLED'
      | 'ROUTE_NOT_ACTIVE'
      | 'REPLY_RECEIPT_MISSING'
      | 'CROSS_WORKSPACE_REPLY_REFUSED'
      | 'SESSION_REQUIRED';
    readonly reason: string;
    readonly inboxId?: string;
  };

function hashChallenge(salt: string, code: string): string {
  return createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

function constantTimeHexEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function mapRouteRow(row: Record<string, unknown>): GatewayRouteRecord {
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
}

function mapBindingRow(row: Record<string, unknown>, mode: GatewayRouteMode): GatewayRouteBinding {
  const threadKey = String(row.thread_key);
  return {
    id: String(row.id),
    connectorId: String(row.connector_id),
    providerAccountId: String(row.provider_account_id),
    channelId: String(row.channel_id),
    threadId: threadKey.length ? threadKey : undefined,
    workspaceId: String(row.workspace_id),
    sessionId: String(row.session_id),
    mode,
    policyRevision: Number(row.policy_revision),
    audience: String(row.audience) as GatewayAudience,
    state: String(row.state) as GatewayBindingState,
  };
}

function mapLinkRow(row: Record<string, unknown>): PrincipalLinkRecord {
  return {
    id: String(row.id),
    connectorId: String(row.connector_id),
    providerAccountId: String(row.provider_account_id),
    externalActorId: String(row.external_actor_id),
    extaliaPrincipalId: String(row.extalia_principal_id),
    challengeReceipt: String(row.challenge_receipt),
    permissionBands: JSON.parse(String(row.permission_bands_json)) as GatewayPermissionBand[],
    state: String(row.state) as PrincipalLinkRecord['state'],
    expiresAt: row.expires_at ? String(row.expires_at) : undefined,
    confirmedAt: String(row.confirmed_at),
    revokedAt: row.revoked_at ? String(row.revoked_at) : undefined,
    revocationReason: row.revocation_reason ? String(row.revocation_reason) : undefined,
  };
}

function mapRemoteReceiptRow(row: Record<string, unknown>): RemoteMessageReceiptRecord {
  const threadKey = String(row.thread_key);
  return {
    id: String(row.id),
    provider: String(row.provider),
    connectorId: String(row.connector_id),
    remoteMessageId: String(row.remote_message_id),
    providerAccountId: String(row.provider_account_id),
    channelId: String(row.channel_id),
    threadId: threadKey.length ? threadKey : undefined,
    workspaceId: String(row.workspace_id),
    sessionId: String(row.session_id),
    runId: row.run_id ? String(row.run_id) : undefined,
    agentId: row.agent_id ? String(row.agent_id) : undefined,
    taskId: row.task_id ? String(row.task_id) : undefined,
    sourceEventId: row.source_event_id ? String(row.source_event_id) : undefined,
    senderSnapshot: JSON.parse(String(row.sender_snapshot_json)) as Record<string, unknown>,
    deliveryState: String(row.delivery_state) as RemoteMessageReceiptRecord['deliveryState'],
    acceptedAt: String(row.accepted_at),
    deliveredAt: row.delivered_at ? String(row.delivered_at) : undefined,
    readAt: row.read_at ? String(row.read_at) : undefined,
    updatedAt: String(row.updated_at),
  };
}

export class GatewayPrincipalLinkService {
  constructor(private readonly store: GatewayStore) {}

  /** Step 1: Authenticated Extalia UI issues a short-lived salted challenge. */
  issueChallenge(input: {
    connectorId: string;
    extaliaPrincipalId: string;
    permissionBands: readonly GatewayPermissionBand[];
    ttlSeconds?: number;
    now: string;
  }): LinkChallengeIssued {
    const ttlSeconds = Math.max(30, Math.min(input.ttlSeconds ?? 300, 900));
    const challengeId = `chl_${randomUUID()}`;
    const code = randomBytes(18).toString('base64url');
    const salt = randomBytes(16).toString('hex');
    const digest = hashChallenge(salt, code);
    const expiresAt = new Date(Date.parse(input.now) + ttlSeconds * 1000).toISOString();

    this.store.transaction(() => {
      this.store.database.prepare(
        `INSERT INTO gateway_principal_challenges(
          id, connector_id, extalia_principal_id, permission_bands_json,
          challenge_salt, challenge_hash, state, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?)`,
      ).run(
        challengeId,
        input.connectorId,
        input.extaliaPrincipalId,
        JSON.stringify([...new Set(input.permissionBands)]),
        salt,
        digest,
        expiresAt,
        input.now,
        input.now,
      );

      this.store.recordAudit({
        actor: input.extaliaPrincipalId,
        action: 'principal.challenge.issued',
        resource: `connector:${input.connectorId}`,
        outcome: 'allowed',
        metadata: { challengeId, expiresAt },
        at: input.now,
      });
    });

    return {
      challengeId,
      code,
      connectorId: input.connectorId,
      extaliaPrincipalId: input.extaliaPrincipalId,
      expiresAt,
    };
  }

  /** Step 2: External platform account submits the one-time proof code. */
  submitExternalProof(input: {
    connectorId: string;
    providerAccountId: string;
    externalActorId: string;
    actorKind: GatewayInboundActorKind;
    isAnonymousAdmin?: boolean;
    code: string;
    now: string;
  }): { ok: true; challengeId: string } | { ok: false; code: string; reason: string } {
    if (input.isAnonymousAdmin) {
      this.store.recordAudit({
        actor: `external:${input.externalActorId}`,
        action: 'principal.proof.submit',
        resource: `connector:${input.connectorId}`,
        outcome: 'denied',
        reason: 'Anonymous group administrators cannot link a personal identity.',
        at: input.now,
      });
      return { ok: false, code: 'ANONYMOUS_ADMIN_REFUSED', reason: 'Anonymous administrators cannot link identities.' };
    }
    if (input.actorKind !== 'human') {
      return { ok: false, code: 'NON_HUMAN_ACTOR_REFUSED', reason: 'Only human external accounts may link.' };
    }

    return this.store.transaction(() => {
      const candidates = this.store.database
        .prepare(
          `SELECT * FROM gateway_principal_challenges
           WHERE connector_id = ? AND state IN ('issued', 'proof-submitted', 'consumed')`,
        )
        .all(input.connectorId) as Array<Record<string, unknown>>;

      const matched = candidates.find(row =>
        constantTimeHexEqual(
          hashChallenge(String(row.challenge_salt), input.code),
          String(row.challenge_hash),
        ),
      );

      if (!matched) {
        this.store.recordAudit({
          actor: `external:${input.externalActorId}`,
          action: 'principal.proof.submit',
          resource: `connector:${input.connectorId}`,
          outcome: 'denied',
          reason: 'Invalid or unknown challenge proof.',
          at: input.now,
        });
        return { ok: false, code: 'INVALID_CHALLENGE', reason: 'Challenge proof is invalid.' };
      }

      const challengeId = String(matched.id);
      const state = String(matched.state);

      if (state === 'consumed') {
        this.store.recordAudit({
          actor: `external:${input.externalActorId}`,
          action: 'principal.proof.replay',
          resource: `challenge:${challengeId}`,
          outcome: 'denied',
          reason: 'One-time challenge was already consumed.',
          at: input.now,
        });
        return { ok: false, code: 'CHALLENGE_REPLAYED', reason: 'Challenge code was already used.' };
      }

      if (Date.parse(String(matched.expires_at)) <= Date.parse(input.now)) {
        this.store.database
          .prepare("UPDATE gateway_principal_challenges SET state = 'expired', updated_at = ? WHERE id = ?")
          .run(input.now, challengeId);
        return { ok: false, code: 'CHALLENGE_EXPIRED', reason: 'Challenge code has expired.' };
      }

      if (state === 'proof-submitted') {
        // Forwarded or replayed proof from another external actor invalidates the one-time code immediately.
        this.store.database
          .prepare("UPDATE gateway_principal_challenges SET state = 'invalidated', updated_at = ? WHERE id = ?")
          .run(input.now, challengeId);
        this.store.recordAudit({
          actor: `external:${input.externalActorId}`,
          action: 'principal.proof.forwarded',
          resource: `challenge:${challengeId}`,
          outcome: 'denied',
          reason: 'Duplicate or forwarded proof invalidated one-time challenge.',
          at: input.now,
        });
        return { ok: false, code: 'CHALLENGE_INVALIDATED', reason: 'Forwarded or duplicate proof invalidated the challenge.' };
      }

      this.store.database.prepare(
        `UPDATE gateway_principal_challenges
         SET state = 'proof-submitted',
             submitted_external_actor_id = ?,
             submitted_provider_account_id = ?,
             submitted_at = ?,
             updated_at = ?
         WHERE id = ?`,
      ).run(input.externalActorId, input.providerAccountId, input.now, input.now, challengeId);

      this.store.recordAudit({
        actor: `external:${input.externalActorId}`,
        action: 'principal.proof.submitted',
        resource: `challenge:${challengeId}`,
        outcome: 'pending-confirmation',
        at: input.now,
      });

      return { ok: true, challengeId };
    });
  }

  /** Step 3: Authenticated Extalia UI confirms the external actor proof and consumes the challenge. */
  confirmLink(input: {
    challengeId: string;
    extaliaPrincipalId: string;
    expiresAt?: string;
    now: string;
  }): { ok: true; link: PrincipalLinkRecord } | { ok: false; code: string; reason: string } {
    return this.store.transaction(() => {
      const row = this.store.database
        .prepare('SELECT * FROM gateway_principal_challenges WHERE id = ?')
        .get(input.challengeId) as Record<string, unknown> | undefined;

      if (!row) return { ok: false, code: 'NOT_FOUND', reason: 'Challenge not found.' };
      if (String(row.extalia_principal_id) !== input.extaliaPrincipalId) {
        return { ok: false, code: 'PRINCIPAL_MISMATCH', reason: 'Authenticated user does not own this challenge.' };
      }
      if (String(row.state) !== 'proof-submitted') {
        return { ok: false, code: 'INVALID_STATE', reason: `Challenge is not awaiting confirmation (state=${String(row.state)}).` };
      }
      if (Date.parse(String(row.expires_at)) <= Date.parse(input.now)) {
        this.store.database
          .prepare("UPDATE gateway_principal_challenges SET state = 'expired', updated_at = ? WHERE id = ?")
          .run(input.now, input.challengeId);
        return { ok: false, code: 'CHALLENGE_EXPIRED', reason: 'Challenge has expired.' };
      }

      const connectorId = String(row.connector_id);
      const providerAccountId = String(row.submitted_provider_account_id);
      const externalActorId = String(row.submitted_external_actor_id);
      const linkId = `lnk_${randomUUID()}`;
      const challengeReceipt = createHash('sha256')
        .update(`${input.challengeId}:${connectorId}:${providerAccountId}:${externalActorId}:${input.now}`)
        .digest('hex');

      this.store.database
        .prepare("UPDATE gateway_principal_challenges SET state = 'consumed', updated_at = ? WHERE id = ?")
        .run(input.now, input.challengeId);

      // Supersede any previous active link for this exact external actor on this connector.
      this.store.database.prepare(
        `UPDATE gateway_principal_links
         SET state = 'revoked', revoked_at = ?, revocation_reason = 'superseded-by-relink', updated_at = ?
         WHERE connector_id = ? AND provider_account_id = ? AND external_actor_id = ? AND state = 'active'`,
      ).run(input.now, input.now, connectorId, providerAccountId, externalActorId);

      this.store.database.prepare(
        `INSERT INTO gateway_principal_links(
          id, connector_id, provider_account_id, external_actor_id,
          extalia_principal_id, challenge_receipt, permission_bands_json,
          state, expires_at, confirmed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      ).run(
        linkId,
        connectorId,
        providerAccountId,
        externalActorId,
        input.extaliaPrincipalId,
        challengeReceipt,
        String(row.permission_bands_json),
        input.expiresAt ?? null,
        input.now,
        input.now,
        input.now,
      );

      this.store.recordAudit({
        actor: input.extaliaPrincipalId,
        action: 'principal.link.confirmed',
        resource: `link:${linkId}`,
        outcome: 'allowed',
        metadata: { connectorId, externalActorId },
        at: input.now,
      });

      const created = this.store.database
        .prepare('SELECT * FROM gateway_principal_links WHERE id = ?')
        .get(linkId) as Record<string, unknown>;
      return { ok: true, link: mapLinkRow(created) };
    });
  }

  revokeLink(input: {
    linkId: string;
    actor: string;
    reason: string;
    now: string;
  }): boolean {
    return this.store.transaction(() => {
      const result = this.store.database.prepare(
        `UPDATE gateway_principal_links
         SET state = 'revoked', revoked_at = ?, revocation_reason = ?, updated_at = ?
         WHERE id = ? AND state = 'active'`,
      ).run(input.now, input.reason, input.now, input.linkId);

      if (result.changes > 0) {
        this.store.recordAudit({
          actor: input.actor,
          action: 'principal.link.revoked',
          resource: `link:${input.linkId}`,
          outcome: 'revoked',
          reason: input.reason,
          at: input.now,
        });
        return true;
      }
      return false;
    });
  }

  /** Resolves strictly by (connectorId, providerAccountId, externalActorId); never by display name. */
  resolveActivePrincipal(input: {
    connectorId: string;
    providerAccountId: string;
    externalActorId: string;
    now: string;
  }): PrincipalLinkRecord | undefined {
    const row = this.store.database.prepare(
      `SELECT * FROM gateway_principal_links
       WHERE connector_id = ? AND provider_account_id = ? AND external_actor_id = ? AND state = 'active'`,
    ).get(input.connectorId, input.providerAccountId, input.externalActorId) as Record<string, unknown> | undefined;

    if (!row) return undefined;
    if (row.expires_at && Date.parse(String(row.expires_at)) <= Date.parse(input.now)) {
      this.store.database
        .prepare("UPDATE gateway_principal_links SET state = 'expired', updated_at = ? WHERE id = ?")
        .run(input.now, String(row.id));
      return undefined;
    }
    return mapLinkRow(row);
  }
}

export class GatewayRoutingService {
  private readonly links: GatewayPrincipalLinkService;

  constructor(private readonly store: GatewayStore) {
    this.links = new GatewayPrincipalLinkService(store);
  }

  get principalLinks(): GatewayPrincipalLinkService {
    return this.links;
  }

  createRoute(input: {
    id?: string;
    connectorId: string;
    providerAccountId: string;
    channelId: string;
    threadId?: string;
    workspaceId: string;
    mode: GatewayRouteMode;
    audience: GatewayAudience;
    inboundEnabled?: boolean;
    outboundEnabled?: boolean;
    isDmDefault?: boolean;
    linkedPrincipalId?: string;
    registeredWorkspaceIds: ReadonlySet<string>;
    now: string;
  }): GatewayRouteRecord {
    if (!input.registeredWorkspaceIds.has(input.workspaceId)) {
      throw new Error(`Workspace "${input.workspaceId}" is not registered.`);
    }
    const id = input.id ?? `rte_${randomUUID()}`;
    const threadKey = normalizeThreadKey(input.threadId);
    const inboundEnabled = input.inboundEnabled ?? true;
    const outboundEnabled = input.outboundEnabled ?? true;
    const isDmDefault = input.isDmDefault ?? false;

    this.store.transaction(() => {
      this.store.database.prepare(
        `INSERT INTO gateway_routes(
          id, connector_id, provider_account_id, channel_id, thread_key,
          workspace_id, mode, audience, policy_revision,
          inbound_enabled, outbound_enabled, is_dm_default, linked_principal_id,
          state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        id,
        input.connectorId,
        input.providerAccountId,
        input.channelId,
        threadKey,
        input.workspaceId,
        input.mode,
        input.audience,
        inboundEnabled ? 1 : 0,
        outboundEnabled ? 1 : 0,
        isDmDefault ? 1 : 0,
        input.linkedPrincipalId ?? null,
        input.now,
        input.now,
      );

      this.store.recordAudit({
        actor: input.linkedPrincipalId ?? 'host',
        action: 'route.created',
        resource: `route:${id}`,
        outcome: 'allowed',
        metadata: { workspaceId: input.workspaceId, audience: input.audience, policyRevision: 1 },
        at: input.now,
      });
    });

    return this.getRoute(id)!;
  }

  getRoute(routeId: string): GatewayRouteRecord | undefined {
    const row = this.store.database
      .prepare('SELECT * FROM gateway_routes WHERE id = ?')
      .get(routeId) as Record<string, unknown> | undefined;
    return row ? mapRouteRow(row) : undefined;
  }

  /** Mutates a route and increments policyRevision, fencing stale queued actions/outbox intents. */
  updateRoute(input: {
    routeId: string;
    workspaceId?: string;
    mode?: GatewayRouteMode;
    audience?: GatewayAudience;
    inboundEnabled?: boolean;
    outboundEnabled?: boolean;
    state?: GatewayBindingState;
    registeredWorkspaceIds: ReadonlySet<string>;
    actor: string;
    now: string;
  }): GatewayRouteRecord {
    return this.store.transaction(() => {
      const existing = this.getRoute(input.routeId);
      if (!existing) throw new Error(`Route "${input.routeId}" not found.`);
      const workspaceId = input.workspaceId ?? existing.workspaceId;
      if (!input.registeredWorkspaceIds.has(workspaceId)) {
        throw new Error(`Workspace "${workspaceId}" is not registered.`);
      }
      const nextRevision = existing.policyRevision + 1;
      this.store.database.prepare(
        `UPDATE gateway_routes
         SET workspace_id = ?, mode = ?, audience = ?, inbound_enabled = ?,
             outbound_enabled = ?, state = ?, policy_revision = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        workspaceId,
        input.mode ?? existing.mode,
        input.audience ?? existing.audience,
        (input.inboundEnabled ?? existing.inboundEnabled) ? 1 : 0,
        (input.outboundEnabled ?? existing.outboundEnabled) ? 1 : 0,
        input.state ?? existing.state,
        nextRevision,
        input.now,
        input.routeId,
      );

      this.store.recordAudit({
        actor: input.actor,
        action: 'route.updated',
        resource: `route:${input.routeId}`,
        outcome: 'allowed',
        metadata: { previousRevision: existing.policyRevision, policyRevision: nextRevision, workspaceId },
        at: input.now,
      });

      return this.getRoute(input.routeId)!;
    });
  }

  createBinding(input: {
    id?: string;
    routeId: string;
    routeRevision: number;
    channelId?: string;
    threadId?: string;
    sessionId: string;
    registeredWorkspaceIds: ReadonlySet<string>;
    now: string;
  }): GatewayRouteBinding {
    return this.store.transaction(() => {
      const route = this.getRoute(input.routeId);
      if (!route || route.state !== 'active') {
        throw new Error('Cannot create binding on inactive or missing route.');
      }
      if (!input.registeredWorkspaceIds.has(route.workspaceId)) {
        throw new Error(`Workspace "${route.workspaceId}" is not registered.`);
      }
      if (route.policyRevision !== input.routeRevision) {
        throw new Error(`Stale route revision: expected ${route.policyRevision}, received ${input.routeRevision}.`);
      }

      const id = input.id ?? `bnd_${randomUUID()}`;
      const channelId = input.channelId ?? route.channelId;
      const threadKey = normalizeThreadKey(input.threadId ?? route.threadId);

      this.store.database.prepare(
        `INSERT INTO gateway_bindings(
          id, route_id, connector_id, provider_account_id, channel_id, thread_key,
          workspace_id, session_id, policy_revision, audience, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        id,
        route.id,
        route.connectorId,
        route.providerAccountId,
        channelId,
        threadKey,
        route.workspaceId,
        input.sessionId,
        route.policyRevision,
        route.audience,
        input.now,
        input.now,
      );

      const created = this.store.database
        .prepare('SELECT * FROM gateway_bindings WHERE id = ?')
        .get(id) as Record<string, unknown>;
      return mapBindingRow(created, route.mode);
    });
  }

  /**
   * Deterministic route precedence (PRD §6.3):
   * 1. Existing active exact conversation binding (validated against current route revision)
   * 2. Exact active thread/topic route
   * 3. Active parent channel/group route
   * 4. Explicit configured personal-DM default for linked principal
   * 5. Fail-closed refusal; zero cross-workspace fallback.
   */
  resolveRoute(input: {
    connectorId: string;
    providerAccountId: string;
    channelId: string;
    threadId?: string;
    linkedPrincipalId?: string;
    expectedRouteRevision?: number;
    registeredWorkspaceIds: ReadonlySet<string>;
  }): RouteResolutionResult {
    const threadKey = normalizeThreadKey(input.threadId);

    // 1. Existing active exact conversation binding
    const bindingRow = this.store.database.prepare(
      `SELECT * FROM gateway_bindings
       WHERE connector_id = ? AND provider_account_id = ? AND channel_id = ? AND thread_key = ? AND state = 'active'`,
    ).get(input.connectorId, input.providerAccountId, input.channelId, threadKey) as Record<string, unknown> | undefined;

    if (bindingRow) {
      const route = this.getRoute(String(bindingRow.route_id));
      if (!route || route.state !== 'active') {
        return { ok: false, code: 'ROUTE_NOT_ACTIVE', reason: 'Underlying route for active binding is no longer active.' };
      }
      if (!input.registeredWorkspaceIds.has(route.workspaceId) || !input.registeredWorkspaceIds.has(String(bindingRow.workspace_id))) {
        return { ok: false, code: 'UNREGISTERED_WORKSPACE', reason: 'Bound workspace is not registered.' };
      }
      if (Number(bindingRow.policy_revision) !== route.policyRevision) {
        return {
          ok: false,
          code: 'STALE_ROUTE_REVISION',
          reason: `Binding revision ${String(bindingRow.policy_revision)} is stale against route revision ${route.policyRevision}.`,
        };
      }
      if (input.expectedRouteRevision !== undefined && route.policyRevision !== input.expectedRouteRevision) {
        return {
          ok: false,
          code: 'STALE_ROUTE_REVISION',
          reason: `Requested route revision ${input.expectedRouteRevision} is stale against current revision ${route.policyRevision}.`,
        };
      }
      if (!route.inboundEnabled) {
        return { ok: false, code: 'INBOUND_DISABLED', reason: 'Inbound admission is disabled on this route.' };
      }
      return {
        ok: true,
        matchedBy: 'active-binding',
        route,
        binding: mapBindingRow(bindingRow, route.mode),
      };
    }

    // 2. Exact thread/topic route
    if (threadKey.length > 0) {
      const exactThreadRow = this.store.database.prepare(
        `SELECT * FROM gateway_routes
         WHERE connector_id = ? AND provider_account_id = ? AND channel_id = ? AND thread_key = ?
           AND is_dm_default = 0 AND state = 'active'`,
      ).get(input.connectorId, input.providerAccountId, input.channelId, threadKey) as Record<string, unknown> | undefined;

      if (exactThreadRow) {
        return this.validateMatchedRoute(mapRouteRow(exactThreadRow), 'exact-thread-route', input);
      }
    }

    // 3. Parent channel/group route
    const parentRow = this.store.database.prepare(
      `SELECT * FROM gateway_routes
       WHERE connector_id = ? AND provider_account_id = ? AND channel_id = ? AND thread_key = ''
         AND is_dm_default = 0 AND state = 'active'`,
    ).get(input.connectorId, input.providerAccountId, input.channelId) as Record<string, unknown> | undefined;

    if (parentRow) {
      return this.validateMatchedRoute(mapRouteRow(parentRow), 'parent-channel-route', input);
    }

    // 4. Explicit personal-DM default for linked principal
    if (input.linkedPrincipalId) {
      const dmRow = this.store.database.prepare(
        `SELECT * FROM gateway_routes
         WHERE connector_id = ? AND provider_account_id = ? AND (channel_id = ? OR channel_id = '*')
           AND is_dm_default = 1 AND linked_principal_id = ? AND state = 'active'
         ORDER BY CASE WHEN channel_id = ? THEN 0 ELSE 1 END
         LIMIT 1`,
      ).get(
        input.connectorId,
        input.providerAccountId,
        input.channelId,
        input.linkedPrincipalId,
        input.channelId,
      ) as Record<string, unknown> | undefined;

      if (dmRow) {
        return this.validateMatchedRoute(mapRouteRow(dmRow), 'dm-default', input);
      }
    }

    // 5. Fail closed — never guess globally or fall back across workspaces.
    return {
      ok: false,
      code: 'NO_ROUTE',
      reason: 'No active route or conversation binding matches this external destination.',
    };
  }

  private validateMatchedRoute(
    route: GatewayRouteRecord,
    matchedBy: 'exact-thread-route' | 'parent-channel-route' | 'dm-default',
    input: { expectedRouteRevision?: number; registeredWorkspaceIds: ReadonlySet<string> },
  ): RouteResolutionResult {
    if (!input.registeredWorkspaceIds.has(route.workspaceId)) {
      return { ok: false, code: 'UNREGISTERED_WORKSPACE', reason: `Workspace "${route.workspaceId}" is not registered.` };
    }
    if (input.expectedRouteRevision !== undefined && route.policyRevision !== input.expectedRouteRevision) {
      return {
        ok: false,
        code: 'STALE_ROUTE_REVISION',
        reason: `Requested route revision ${input.expectedRouteRevision} is stale against current revision ${route.policyRevision}.`,
      };
    }
    if (!route.inboundEnabled) {
      return { ok: false, code: 'INBOUND_DISABLED', reason: 'Inbound admission is disabled on this route.' };
    }
    return { ok: true, matchedBy, route };
  }

  recordRemoteReceipt(input: {
    id?: string;
    provider: string;
    connectorId: string;
    remoteMessageId: string;
    providerAccountId: string;
    channelId: string;
    threadId?: string;
    workspaceId: string;
    sessionId: string;
    runId?: string;
    agentId?: string;
    taskId?: string;
    sourceEventId?: string;
    senderSnapshot: Record<string, unknown>;
    deliveryState?: 'accepted' | 'delivered' | 'read' | 'failed' | 'unknown';
    acceptedAt: string;
  }): RemoteMessageReceiptRecord {
    const id = input.id ?? `rcp_${randomUUID()}`;
    const threadKey = normalizeThreadKey(input.threadId);
    const deliveryState = input.deliveryState ?? 'accepted';

    this.store.database.prepare(
      `INSERT INTO gateway_remote_receipts(
        id, provider, connector_id, remote_message_id, provider_account_id,
        channel_id, thread_key, workspace_id, session_id, run_id, agent_id,
        task_id, source_event_id, sender_snapshot_json, delivery_state,
        accepted_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connector_id, remote_message_id) DO UPDATE SET
        updated_at = excluded.updated_at`,
    ).run(
      id,
      input.provider,
      input.connectorId,
      input.remoteMessageId,
      input.providerAccountId,
      input.channelId,
      threadKey,
      input.workspaceId,
      input.sessionId,
      input.runId ?? null,
      input.agentId ?? null,
      input.taskId ?? null,
      input.sourceEventId ?? null,
      JSON.stringify(input.senderSnapshot),
      deliveryState,
      input.acceptedAt,
      input.acceptedAt,
    );

    const row = this.store.database
      .prepare('SELECT * FROM gateway_remote_receipts WHERE connector_id = ? AND remote_message_id = ?')
      .get(input.connectorId, input.remoteMessageId) as Record<string, unknown>;
    return mapRemoteReceiptRow(row);
  }

  /** Resolves reply-to-worker strictly by stored remote message receipt ID, never by display name. */
  resolveReplyTarget(input: {
    connectorId: string;
    replyToRemoteMessageId: string;
    expectedWorkspaceId: string;
  }): ReplyTargetResolutionResult {
    const row = this.store.database
      .prepare('SELECT * FROM gateway_remote_receipts WHERE connector_id = ? AND remote_message_id = ?')
      .get(input.connectorId, input.replyToRemoteMessageId) as Record<string, unknown> | undefined;

    if (!row) {
      return {
        ok: false,
        code: 'REPLY_RECEIPT_MISSING',
        reason: 'Original remote message receipt was not found; refusing ambiguous reply target.',
      };
    }

    const receipt = mapRemoteReceiptRow(row);
    if (receipt.workspaceId !== input.expectedWorkspaceId) {
      return {
        ok: false,
        code: 'CROSS_WORKSPACE_REPLY_REFUSED',
        reason: 'Reply receipt belongs to a different workspace; refusing cross-workspace routing.',
      };
    }

    return { ok: true, receipt, delegateViaLead: true };
  }

  /**
   * Full inbound admission pipeline (PRD §7):
   * validate schema -> verify transport authenticity -> suppress self-echo ->
   * deduplicate (connectorId, providerEventId) -> resolve principal & route ->
   * verify reply receipt (if reply) -> commit single idempotent Host action.
   */
  admitInboundEvent(input: {
    rawEvent: unknown;
    verifyTransportReceipt: (event: GatewayInboundEvent) => boolean;
    registeredWorkspaceIds: ReadonlySet<string>;
    requiredPermission?: GatewayPermissionBand;
    requestedAction?: string;
    resolvedSessionId?: string;
    expectedRouteRevision?: number;
    isAnonymousAdmin?: boolean;
    now: string;
  }): InboundAdmissionResult {
    const validated = validateGatewayInboundEvent(input.rawEvent);
    if (!validated.ok) {
      this.store.recordAudit({
        actor: 'untrusted_external',
        action: 'inbound.rejected',
        resource: 'gateway:inbox',
        outcome: 'denied',
        reason: validated.error,
        at: input.now,
      });
      return { ok: false, code: 'INVALID_ENVELOPE', reason: validated.error };
    }

    const event = validated.value;
    if (!input.verifyTransportReceipt(event)) {
      this.store.recordAudit({
        actor: `external:${event.externalActorId}`,
        action: 'inbound.unauthenticated',
        resource: `connector:${event.connectorId}`,
        outcome: 'denied',
        reason: 'Transport authenticity receipt verification failed.',
        at: input.now,
      });
      return {
        ok: false,
        code: 'UNAUTHENTICATED_TRANSPORT',
        reason: 'Inbound transport receipt is unsigned or invalid.',
      };
    }

    const connector = this.store.getConnector(event.connectorId);
    if (!connector || connector.status === 'disabled' || connector.status === 'revoked' || connector.status === 'blocked') {
      return {
        ok: false,
        code: 'CONNECTOR_UNAVAILABLE',
        reason: `Connector "${event.connectorId}" is unavailable (status=${connector?.status ?? 'missing'}).`,
      };
    }

    // Suppress bot/webhook self-echo before any inbox action admission.
    if (event.actorKind === 'bot' || event.actorKind === 'webhook') {
      this.store.recordAudit({
        actor: `${event.actorKind}:${event.externalActorId}`,
        action: 'inbound.echo.suppressed',
        resource: `connector:${event.connectorId}`,
        outcome: 'ignored',
        reason: 'Bot and webhook messages cannot trigger inbound Host prompts.',
        at: input.now,
      });
      return { ok: true, status: 'ignored-echo' };
    }

    if (input.isAnonymousAdmin) {
      this.store.recordAudit({
        actor: `external:${event.externalActorId}`,
        action: 'inbound.anonymous_admin.refused',
        resource: `connector:${event.connectorId}`,
        outcome: 'denied',
        reason: 'Anonymous admin cannot execute privileged actions.',
        at: input.now,
      });
      return {
        ok: false,
        code: 'ANONYMOUS_ADMIN_REFUSED',
        reason: 'Anonymous administrators cannot inherit linked principal authority.',
      };
    }

    const inboundKey = buildInboundKey({
      connectorId: event.connectorId,
      providerAccountId: event.providerAccountId,
      providerEventId: event.providerEventId,
    });
    const fingerprint = createHash('sha256')
      .update(`${event.connectorId}:${event.providerEventId}:${event.externalActorId}:${event.kind}`)
      .digest('hex');

    return this.store.transaction(() => {
      // Check (connectorId, providerEventId) dedup first.
      const existingInbox = this.store.database
        .prepare('SELECT id, state FROM gateway_inbox WHERE connector_id = ? AND provider_event_id = ?')
        .get(event.connectorId, event.providerEventId) as { id: string; state: string } | undefined;

      if (existingInbox) {
        this.store.database
          .prepare('UPDATE gateway_inbox SET attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?')
          .run(input.now, existingInbox.id);
        const existingAction = this.store.database
          .prepare('SELECT id, lead_action_key FROM gateway_actions WHERE inbox_id = ? LIMIT 1')
          .get(existingInbox.id) as { id: string; lead_action_key: string } | undefined;
        return {
          ok: true,
          status: 'duplicate',
          inboxId: existingInbox.id,
          actionId: existingAction?.id,
          leadActionKey: existingAction?.lead_action_key,
        };
      }

      const inboxId = `inb_${randomUUID()}`;
      const threadKey = normalizeThreadKey(event.threadId);
      this.store.database.prepare(
        `INSERT INTO gateway_inbox(
          id, inbound_key, connector_id, provider, provider_account_id,
          provider_event_id, fingerprint, external_actor_id, actor_kind,
          channel_id, thread_key, remote_message_id, reply_to_remote_message_id,
          kind, auth_receipt, state, attempt_count, received_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'authenticated', 1, ?, ?)`,
      ).run(
        inboxId,
        inboundKey,
        event.connectorId,
        event.provider,
        event.providerAccountId,
        event.providerEventId,
        fingerprint,
        event.externalActorId,
        event.actorKind,
        event.channelId,
        threadKey,
        event.remoteMessageId ?? null,
        event.replyToRemoteMessageId ?? null,
        event.kind,
        event.authenticatedTransportReceipt,
        event.receivedAt,
        input.now,
      );

      const failInbox = <C extends Exclude<InboundAdmissionResult, { ok: true }>['code']>(
        code: C,
        reason: string,
      ): InboundAdmissionResult => {
        this.store.database
          .prepare("UPDATE gateway_inbox SET state = 'rejected', rejection_reason = ?, updated_at = ? WHERE id = ?")
          .run(`${code}: ${reason}`, input.now, inboxId);
        this.store.recordAudit({
          actor: `external:${event.externalActorId}`,
          action: 'inbound.rejected',
          resource: `inbox:${inboxId}`,
          outcome: 'denied',
          reason: `${code}: ${reason}`,
          at: input.now,
        });
        return { ok: false, code, reason, inboxId };
      };

      // Resolve linked principal.
      const principal = this.links.resolveActivePrincipal({
        connectorId: event.connectorId,
        providerAccountId: event.providerAccountId,
        externalActorId: event.externalActorId,
        now: input.now,
      });

      if (!principal) {
        return failInbox('UNLINKED_PRINCIPAL', 'External actor has no active confirmed Extalia principal link.');
      }

      const requiredBand = input.requiredPermission ?? 'submit_prompt';
      if (!principal.permissionBands.includes(requiredBand)) {
        return failInbox(
          'INSUFFICIENT_PERMISSION',
          `Linked principal lacks required permission band "${requiredBand}".`,
        );
      }

      // Resolve route deterministically.
      const routeRes = this.resolveRoute({
        connectorId: event.connectorId,
        providerAccountId: event.providerAccountId,
        channelId: event.channelId,
        threadId: event.threadId,
        linkedPrincipalId: principal.extaliaPrincipalId,
        expectedRouteRevision: input.expectedRouteRevision,
        registeredWorkspaceIds: input.registeredWorkspaceIds,
      });

      if (!routeRes.ok) {
        return failInbox(routeRes.code, routeRes.reason);
      }

      // If replying to an agent/webhook message, resolve strictly by stored remote receipt.
      let replyTarget: RemoteMessageReceiptRecord | undefined;
      if (event.replyToRemoteMessageId) {
        const replyRes = this.resolveReplyTarget({
          connectorId: event.connectorId,
          replyToRemoteMessageId: event.replyToRemoteMessageId,
          expectedWorkspaceId: routeRes.route.workspaceId,
        });
        if (!replyRes.ok) {
          return failInbox(replyRes.code, replyRes.reason);
        }
        replyTarget = replyRes.receipt;
      }

      const sessionId = replyTarget?.sessionId ?? routeRes.binding?.sessionId ?? input.resolvedSessionId;
      if (!sessionId) {
        return failInbox('SESSION_REQUIRED', 'No bound or explicitly selected session is available for this route.');
      }

      const requestedAction = input.requestedAction ?? (replyTarget ? 'reply-via-lead' : event.kind);
      const leadActionKey = buildLeadActionKey({
        inboundKey,
        resolvedSessionId: sessionId,
        requestedAction,
        routeRevision: routeRes.route.policyRevision,
      });
      const actionId = `act_${randomUUID()}`;

      this.store.database.prepare(
        `INSERT INTO gateway_actions(
          id, lead_action_key, inbox_id, connector_id, route_id, route_revision,
          binding_id, workspace_id, session_id, requested_action, auth_proof,
          state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admitted', ?, ?)`,
      ).run(
        actionId,
        leadActionKey,
        inboxId,
        event.connectorId,
        routeRes.route.id,
        routeRes.route.policyRevision,
        routeRes.binding?.id ?? null,
        routeRes.route.workspaceId,
        sessionId,
        requestedAction,
        principal.challengeReceipt,
        input.now,
        input.now,
      );

      this.store.database
        .prepare("UPDATE gateway_inbox SET state = 'admitted', updated_at = ? WHERE id = ?")
        .run(input.now, inboxId);

      this.store.recordAudit({
        actor: principal.extaliaPrincipalId,
        action: 'inbound.admitted',
        resource: `action:${actionId}`,
        outcome: 'admitted',
        metadata: {
          workspaceId: routeRes.route.workspaceId,
          sessionId,
          routeRevision: routeRes.route.policyRevision,
          replyTaskId: replyTarget?.taskId,
        },
        at: input.now,
      });

      return {
        ok: true,
        status: 'admitted',
        inboxId,
        actionId,
        leadActionKey,
        route: routeRes.route,
        binding: routeRes.binding,
        principal,
        replyTarget,
      };
    });
  }
}
