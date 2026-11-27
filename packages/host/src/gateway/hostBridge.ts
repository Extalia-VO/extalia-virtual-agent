/**
 * Host-owned Gateway bridge unifying GatewayStore, principal linking, deterministic routing,
 * autonomous report ledger, outbox health aggregation, and schedule/learning fanout
 * (Universal Gateway v2 Tahap 3, WP-SCH-09..11, GW-WP-13/17).
 */
import type {
  AutonomousReportSource,
  AutonomousReportTargetSelection,
  ChatSystemReportsView,
  ConnectorHealth,
  ConnectorHealthDimension,
  GatewayAudience,
  GatewayBindingState,
  GatewayConfirmLinkInput,
  GatewayConnectorSaveInput,
  GatewayConnectorState,
  GatewayConnectorView,
  GatewayDiagnosticsView,
  GatewayIssueChallengeInput,
  GatewayLinkChallengeView,
  GatewayOverview,
  GatewayPermissionBand,
  GatewayRouteMode,
  GatewayRouteSaveInput,
  GatewayRouteView,
  GatewayWhatsAppPosture,
  HostWatchdogStatus,
  LearningScheduleJob,
  LearningScheduleResult,
  ScheduleDeliveryState,
  ScheduleRunV1,
  WorkspaceReportProjectionSummary,
  WorkspaceReportsInboxView,
} from '@extalia/platform';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { RecordDeliveryInput } from '../scheduleStore.js';
import {
  createReferenceFourthProviderAdapter,
  runGatewayAdapterConformance,
  signReferenceFourthProviderPayload,
} from './adapterSdk.js';
import {
  AutonomousReportService,
  type AutonomousReportChatCandidate,
} from './autonomousReports.js';
import {
  GatewayFanoutService,
  type FanoutDestinationDecision,
  type FanoutDestinationTarget,
  type FanoutExecutionResult,
} from './fanout.js';
import { aggregateConnectorHealth, GatewayOutboxService } from './outbox.js';
import {
  GatewayRoutingService,
  type GatewayPrincipalLinkService,
  type GatewayRouteRecord,
} from './routing.js';
import {
  assertOpaqueSecretRef,
  GatewayStore,
  type GatewayConnectorRecord,
} from './store.js';
import { HostWatchdogMonitor, writeHostWatchdogLease } from './watchdog.js';
import {
  WHATSAPP_ALLOWED_SIGNAL_CLASSES,
  WHATSAPP_SERVICE_WINDOW_MS,
} from './whatsapp.js';

const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const CONTROL_CHAR_PATTERN = /\p{Cc}/u;

const CONNECTOR_STATES = new Set<GatewayConnectorState>([
  'disabled',
  'configuring',
  'connected',
  'degraded',
  'blocked',
  'revoked',
]);

const PERMISSION_BANDS = new Set<GatewayPermissionBand>([
  'read_status',
  'view_reports',
  'submit_prompt',
  'manage_own_session',
  'manage_schedule',
  'manage_gateway_route',
  'approve_sensitive_action',
]);

const ROUTE_MODES = new Set<GatewayRouteMode>([
  'explicit-only',
  'thread-new-session',
  'reuse-pinned',
]);

const AUDIENCES = new Set<GatewayAudience>(['private', 'team', 'public']);

const BINDING_STATES = new Set<GatewayBindingState>([
  'active',
  'paused',
  'destination-lost',
  'revoked',
]);

const MAX_PENDING_CHALLENGE_CODES = 256;

function userError(message: string): Error {
  const error = new Error(message);
  error.name = 'UserError';
  return error;
}

function requireBoundedText(value: unknown, label: string, maxLen = 200): string {
  if (typeof value !== 'string') throw userError(`${label} is required.`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen || CONTROL_CHAR_PATTERN.test(trimmed)) {
    throw userError(`Invalid ${label}.`);
  }
  return trimmed;
}

function mapRouteView(route: GatewayRouteRecord): GatewayRouteView {
  return {
    id: route.id,
    connectorId: route.connectorId,
    providerAccountId: route.providerAccountId,
    channelId: route.channelId,
    ...(route.threadId ? { threadId: route.threadId } : {}),
    workspaceId: route.workspaceId,
    mode: route.mode,
    audience: route.audience,
    policyRevision: route.policyRevision,
    inboundEnabled: route.inboundEnabled,
    outboundEnabled: route.outboundEnabled,
    isDmDefault: route.isDmDefault,
    state: route.state,
    createdAt: route.createdAt,
    updatedAt: route.updatedAt,
  };
}

function mapDecisionToDeliveryState(status: FanoutDestinationDecision['status']): ScheduleDeliveryState {
  switch (status) {
    case 'enqueued':
    case 'deduplicated':
      return 'pending';
    case 'suppressed_policy':
    case 'suppressed_quiet_hours':
    case 'suppressed_noop':
      return 'cancelled';
    case 'policy_blocked':
    case 'unauthorized':
    case 'cross_workspace_refused':
      return 'failed';
  }
}

export interface GatewaySessionCandidateInput {
  id: string;
  workspaceId: string | null;
  lastActiveAt: string;
  historyEnabled: boolean;
  isObserved?: boolean;
  isNative?: boolean;
  deleted?: boolean;
  vaultProfileId?: string;
}

export interface GatewayHostBridgeOptions {
  dbPath: string;
  validateWorkspace: (workspaceId: string) => void;
  listRegisteredWorkspaceIds: () => ReadonlySet<string>;
  defaultPrincipalId?: () => string;
  now?: () => string;
  hostId?: string;
  watchdogLeasePath?: string;
}

export interface FanoutSettledScheduleRunInput {
  run: ScheduleRunV1;
  scheduleName?: string;
  sessions: readonly GatewaySessionCandidateInput[];
  audienceScopeId: string;
  nowIso?: string;
}

export interface FanoutSettledScheduleRunResult {
  fanout: FanoutExecutionResult;
  deliveries: RecordDeliveryInput[];
}

export interface FanoutLearningOutcomeInput {
  workspaceId: string;
  sourceJobId: string;
  sourceRunId?: string;
  sourceSessionId?: string;
  source?: AutonomousReportSource;
  vaultProfileId?: string;
  vaultProfileRevision?: string;
  learningJob?: LearningScheduleJob;
  learningResult: LearningScheduleResult;
  sessions: readonly GatewaySessionCandidateInput[];
  audienceScopeId: string;
  nowIso?: string;
}

export class GatewayHostBridge {
  readonly store: GatewayStore;
  readonly routing: GatewayRoutingService;
  readonly principalLinks: GatewayPrincipalLinkService;
  readonly reports: AutonomousReportService;
  readonly outbox: GatewayOutboxService;
  readonly fanout: GatewayFanoutService;

  private readonly now: () => string;
  private readonly defaultPrincipalId: () => string;
  private readonly startedAt: string;
  private readonly hostId: string;
  private readonly watchdogLeasePath?: string;
  /** Ephemeral in-memory challenge codes (never stored in plaintext in SQLite) to support local UI confirm flow. */
  private readonly issuedChallengeCodes = new Map<string, string>();

  private constructor(
    store: GatewayStore,
    private readonly options: GatewayHostBridgeOptions,
  ) {
    this.store = store;
    this.routing = new GatewayRoutingService(store);
    this.principalLinks = this.routing.principalLinks;
    this.reports = new AutonomousReportService(store);
    this.outbox = new GatewayOutboxService(store);
    this.fanout = new GatewayFanoutService({
      store: this.store,
      reports: this.reports,
      outbox: this.outbox,
    });
    this.now = options.now ?? (() => new Date().toISOString());
    this.defaultPrincipalId = options.defaultPrincipalId ?? (() => 'profile:default');
    this.startedAt = this.now();
    this.hostId = options.hostId ?? 'extalia-host';
    this.watchdogLeasePath =
      options.watchdogLeasePath ??
      (options.dbPath !== ':memory:'
        ? path.join(path.dirname(options.dbPath), 'gateway-watchdog-lease.json')
        : undefined);
  }

  static async open(options: GatewayHostBridgeOptions): Promise<GatewayHostBridge> {
    const store = await GatewayStore.open(options.dbPath);
    return new GatewayHostBridge(store, options);
  }

  close(): void {
    this.issuedChallengeCodes.clear();
    this.store.close();
  }

  private buildConnectorHealth(connector: GatewayConnectorRecord, nowIso: string): ConnectorHealth {
    const outboxStats = this.store.database.prepare(
      `SELECT state, COUNT(*) AS count, MAX(updated_at) AS last_at
       FROM gateway_outbox
       WHERE connector_id = ?
       GROUP BY state`,
    ).all(connector.id) as Array<{ state: string; count: number; last_at: string | null }>;

    let unknownCount = 0;
    let failedCount = 0;
    let blockedCount = 0;
    let lastOutboxAt: string | undefined;
    for (const row of outboxStats) {
      const count = Number(row.count ?? 0);
      if (row.state === 'unknown') unknownCount += count;
      if (row.state === 'failed') failedCount += count;
      if (row.state === 'blocked') blockedCount += count;
      if (row.last_at && (!lastOutboxAt || row.last_at > lastOutboxAt)) {
        lastOutboxAt = row.last_at;
      }
    }

    const transport: ConnectorHealthDimension =
      connector.status === 'connected'
        ? { status: 'healthy', observedAt: connector.updatedAt, detail: 'Connector configured and active.' }
        : connector.status === 'degraded'
          ? { status: 'degraded', observedAt: connector.updatedAt, detail: 'Connector transport is degraded.' }
          : connector.status === 'blocked'
            ? { status: 'blocked', observedAt: connector.updatedAt, detail: 'Connector transport is blocked.' }
            : connector.status === 'configuring'
              ? { status: 'unknown', observedAt: connector.updatedAt, detail: 'Connector setup is in progress.' }
              : { status: 'disconnected', observedAt: connector.updatedAt, detail: `Connector is ${connector.status}.` };

    const host: ConnectorHealthDimension = {
      status: 'healthy',
      observedAt: nowIso,
      detail: 'Host Gateway bridge is online.',
    };

    const runtime: ConnectorHealthDimension =
      connector.status === 'connected' || connector.status === 'degraded'
        ? { status: 'healthy', observedAt: nowIso, detail: 'Host runtime bridge ready.' }
        : connector.status === 'blocked'
          ? { status: 'blocked', observedAt: nowIso, detail: 'Connector is blocked.' }
          : { status: 'unknown', observedAt: nowIso, detail: `Connector is ${connector.status}.` };

    const progress: ConnectorHealthDimension =
      unknownCount > 0
        ? { status: 'verification_insufficient', observedAt: lastOutboxAt ?? nowIso, detail: `${unknownCount} outbound intent(s) awaiting reconciliation.` }
        : failedCount > 0 || blockedCount > 0
          ? { status: 'degraded', observedAt: lastOutboxAt ?? nowIso, detail: `${failedCount} failed and ${blockedCount} blocked outbound intent(s).` }
          : connector.status === 'connected'
            ? { status: 'healthy', observedAt: lastOutboxAt ?? nowIso, detail: 'Delivery progress nominal.' }
            : { status: 'unknown', observedAt: nowIso, detail: `Connector is ${connector.status}.` };

    const notification: ConnectorHealthDimension =
      connector.status === 'blocked' || connector.status === 'revoked'
        ? { status: 'blocked', observedAt: nowIso, detail: `Outbound notification blocked (${connector.status}).` }
        : connector.status === 'disabled' || connector.status === 'configuring'
          ? { status: 'disconnected', observedAt: nowIso, detail: `Outbound notification inactive (${connector.status}).` }
          : failedCount > 0 || blockedCount > 0
            ? { status: 'degraded', observedAt: lastOutboxAt ?? nowIso, detail: 'One or more outbound notifications need attention.' }
            : connector.status === 'degraded'
              ? { status: 'degraded', observedAt: nowIso, detail: 'Notification channel is degraded.' }
              : { status: 'healthy', observedAt: lastOutboxAt ?? nowIso, detail: 'Notification pipeline ready.' };

    return aggregateConnectorHealth({
      connectorId: connector.id,
      provider: connector.provider,
      connectorState: connector.status,
      transport,
      host,
      runtime,
      progress,
      notification,
      ...(connector.status === 'connected' || connector.status === 'degraded'
        ? { lastTransportHeartbeatAt: connector.updatedAt }
        : {}),
      lastHostHeartbeatAt: nowIso,
      ...(lastOutboxAt ? { lastProgressEventAt: lastOutboxAt } : {}),
      checkedAt: nowIso,
    });
  }

  overview(nowIso = this.now()): GatewayOverview {
    const connectors: GatewayConnectorView[] = this.store.listConnectors().map(connector => ({
      id: connector.id,
      provider: connector.provider,
      providerAccountId: connector.providerAccountId,
      secretRef: connector.secretRef,
      status: connector.status,
      policyVersion: connector.policyVersion,
      capabilityRevision: connector.capabilityRevision,
      ...(connector.capabilities ? { capabilities: connector.capabilities } : {}),
      createdAt: connector.createdAt,
      updatedAt: connector.updatedAt,
      health: this.buildConnectorHealth(connector, nowIso),
    }));

    const routes: GatewayRouteView[] = this.store.listRoutes().map(mapRouteView);
    const links = this.store.listPrincipalLinks();
    const recentAudit = this.store.listAudit(50).map(entry => ({
      sequence: entry.sequence,
      actor: entry.actor,
      action: entry.action,
      resource: entry.resource,
      outcome: entry.outcome,
      ...(entry.reason ? { reason: entry.reason } : {}),
      at: entry.at,
    }));

    return { connectors, routes, links, recentAudit };
  }

  async diagnostics(nowIso = this.now()): Promise<GatewayDiagnosticsView> {
    const parsedNowMs = Date.parse(nowIso);
    const nowMs = Number.isFinite(parsedNowMs) ? parsedNowMs : Date.now();
    const connectors = this.store.listConnectors();
    const activeConnectors = connectors.filter(
      connector => connector.status === 'connected' || connector.status === 'degraded',
    ).length;

    let watchdog: HostWatchdogStatus;
    if (this.watchdogLeasePath) {
      await writeHostWatchdogLease(this.watchdogLeasePath, {
        schemaVersion: 1,
        ownerId: this.hostId,
        pid: process.pid,
        startedAt: this.startedAt,
        heartbeatAt: nowIso,
        fencingToken: randomUUID(),
        activeConnectors,
      });
      const monitor = new HostWatchdogMonitor({
        leaseFilePath: this.watchdogLeasePath,
        staleAfterMs: 30_000,
        downAfterMs: 90_000,
        probeHealth: async () => true,
        now: () => nowMs,
      });
      watchdog = await monitor.evaluate();
    } else {
      watchdog = {
        state: 'healthy',
        checkedAt: nowIso,
        leaseAgeMs: 0,
        heartbeatAt: nowIso,
        probeOk: true,
        reason: 'In-memory test host watchdog snapshot.',
      };
    }

    const conformanceVerifier = 'extalia-conformance-verifier';
    const rawBody = JSON.stringify({ eventId: 'evt-conformance-1', text: '/status' });
    const signature = signReferenceFourthProviderPayload(rawBody, conformanceVerifier);
    const createAdapter = (fetchImpl?: typeof fetch) =>
      createReferenceFourthProviderAdapter({
        connectorId: 'conn-conformance-1',
        outboundEndpointUrl: 'https://example.com/relay',
        signingSecret: conformanceVerifier,
        fetch: fetchImpl,
        nowIso: () => nowIso,
      });
    const defaultFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ id: 'relay-msg-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const conformance = await runGatewayAdapterConformance(createAdapter(defaultFetch), {
      validSignedRequest: {
        rawBody,
        headers: {
          'x-relay-signature-256': signature,
          'x-relay-event-id': 'evt-conformance-1',
        },
      },
      nowIso: () => nowIso,
      createAdapterWithFetch: fetchImpl => createAdapter(fetchImpl),
    });

    const whatsappConnectors = connectors.filter(connector => connector.provider === 'whatsapp');
    const whatsappPosture: GatewayWhatsAppPosture = {
      configuredConnectors: whatsappConnectors.length,
      enabledConnectors: whatsappConnectors.filter(
        connector => connector.status === 'connected' || connector.status === 'degraded',
      ).length,
      failClosed: true,
      allowedSignalCount: WHATSAPP_ALLOWED_SIGNAL_CLASSES.length,
      serviceWindowHours: Math.round(WHATSAPP_SERVICE_WINDOW_MS / 3_600_000),
    };

    return {
      observedAt: nowIso,
      watchdog,
      conformance,
      whatsappPosture,
    };
  }

  saveConnector(input: GatewayConnectorSaveInput, nowIso = this.now()): GatewayOverview {
    const provider = requireBoundedText(input?.provider, 'Gateway provider', 32).toLowerCase();
    if (!PROVIDER_PATTERN.test(provider)) {
      throw userError('Gateway provider must use lowercase letters, digits, or hyphens.');
    }
    const providerAccountId = requireBoundedText(input?.providerAccountId, 'providerAccountId');
    assertOpaqueSecretRef(input?.secretRef);

    const status: GatewayConnectorState = input.status ?? 'disabled';
    if (!CONNECTOR_STATES.has(status)) {
      throw userError(`Invalid connector status "${String(status)}".`);
    }

    const id = input.id !== undefined ? requireBoundedText(input.id, 'connector id') : `conn_${randomUUID()}`;
    const existing = this.store.getConnector(id);
    const saved = this.store.upsertConnector({
      id,
      provider,
      providerAccountId,
      secretRef: input.secretRef,
      status,
      policyVersion: existing ? existing.policyVersion + 1 : 1,
      capabilityRevision: existing?.capabilityRevision ?? 1,
      capabilities: existing?.capabilities,
      now: nowIso,
    });

    this.store.recordAudit({
      actor: this.defaultPrincipalId(),
      action: existing ? 'connector.updated' : 'connector.created',
      resource: `connector:${saved.id}`,
      outcome: 'allowed',
      metadata: { provider: saved.provider, status: saved.status, policyVersion: saved.policyVersion },
      at: nowIso,
    });

    return this.overview(nowIso);
  }

  setConnectorStatus(
    connectorId: string,
    status: GatewayConnectorState,
    nowIso = this.now(),
  ): GatewayOverview {
    const id = requireBoundedText(connectorId, 'connectorId');
    if (!CONNECTOR_STATES.has(status)) {
      throw userError(`Invalid connector status "${String(status)}".`);
    }
    const existing = this.store.getConnector(id);
    if (!existing) {
      throw userError('Gateway connector not found.');
    }
    this.store.setConnectorStatus(id, status, nowIso);
    this.store.recordAudit({
      actor: this.defaultPrincipalId(),
      action: 'connector.status.changed',
      resource: `connector:${id}`,
      outcome: status,
      metadata: { previousStatus: existing.status, status },
      at: nowIso,
    });
    return this.overview(nowIso);
  }

  issueLinkChallenge(
    input: GatewayIssueChallengeInput,
    nowIso = this.now(),
  ): GatewayLinkChallengeView {
    const connectorId = requireBoundedText(input?.connectorId, 'connectorId');
    const connector = this.store.getConnector(connectorId);
    if (!connector) {
      throw userError('Gateway connector not found.');
    }
    const extaliaPrincipalId = input.extaliaPrincipalId !== undefined
      ? requireBoundedText(input.extaliaPrincipalId, 'extaliaPrincipalId')
      : this.defaultPrincipalId();

    const issued = this.principalLinks.issueChallenge({
      connectorId,
      extaliaPrincipalId,
      permissionBands: ['read_status', 'view_reports'],
      ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
      now: nowIso,
    });

    this.issuedChallengeCodes.set(issued.challengeId, issued.code);
    if (this.issuedChallengeCodes.size > MAX_PENDING_CHALLENGE_CODES) {
      const oldest = this.issuedChallengeCodes.keys().next().value;
      if (oldest) this.issuedChallengeCodes.delete(oldest);
    }

    return {
      challengeId: issued.challengeId,
      code: issued.code,
      connectorId: issued.connectorId,
      extaliaPrincipalId: issued.extaliaPrincipalId,
      expiresAt: issued.expiresAt,
    };
  }

  confirmPrincipalLink(
    input: GatewayConfirmLinkInput,
    nowIso = this.now(),
  ): GatewayOverview {
    const challengeId = requireBoundedText(input?.challengeId, 'challengeId');
    const providerAccountId = requireBoundedText(input?.providerAccountId, 'providerAccountId');
    const externalActorId = requireBoundedText(input?.externalActorId, 'externalActorId');

    if (!Array.isArray(input?.permissionBands) || input.permissionBands.length === 0) {
      throw userError('Select at least one permission band to confirm a principal link.');
    }
    const uniqueBands: GatewayPermissionBand[] = [];
    for (const band of input.permissionBands) {
      if (typeof band !== 'string' || !PERMISSION_BANDS.has(band as GatewayPermissionBand)) {
        throw userError(`Invalid permission band "${String(band)}".`);
      }
      if (!uniqueBands.includes(band as GatewayPermissionBand)) {
        uniqueBands.push(band as GatewayPermissionBand);
      }
    }

    const challengeRow = this.store.database
      .prepare('SELECT * FROM gateway_principal_challenges WHERE id = ?')
      .get(challengeId) as Record<string, unknown> | undefined;
    if (!challengeRow) {
      throw userError('Link challenge not found.');
    }

    const connectorId = String(challengeRow.connector_id);
    const extaliaPrincipalId = String(challengeRow.extalia_principal_id);
    const currentState = String(challengeRow.state);

    if (currentState === 'issued') {
      const code = this.issuedChallengeCodes.get(challengeId);
      if (!code) {
        throw userError('External proof has not been submitted for this challenge.');
      }
      const proof = this.principalLinks.submitExternalProof({
        connectorId,
        providerAccountId,
        externalActorId,
        actorKind: 'human',
        code,
        now: nowIso,
      });
      this.issuedChallengeCodes.delete(challengeId);
      if (!proof.ok) {
        throw userError(proof.reason);
      }
    } else if (currentState === 'proof-submitted') {
      if (
        String(challengeRow.submitted_provider_account_id) !== providerAccountId
        || String(challengeRow.submitted_external_actor_id) !== externalActorId
      ) {
        throw userError('Submitted external actor does not match confirmation input.');
      }
    }

    // Apply the operator-selected permission bands to the challenge before confirming.
    this.store.database
      .prepare('UPDATE gateway_principal_challenges SET permission_bands_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(uniqueBands), nowIso, challengeId);

    const expiresAt = input.ttlSeconds !== undefined
      ? new Date(Date.parse(nowIso) + Math.max(60, input.ttlSeconds) * 1000).toISOString()
      : undefined;

    const confirmed = this.principalLinks.confirmLink({
      challengeId,
      extaliaPrincipalId,
      ...(expiresAt ? { expiresAt } : {}),
      now: nowIso,
    });
    this.issuedChallengeCodes.delete(challengeId);

    if (!confirmed.ok) {
      throw userError(confirmed.reason);
    }

    return this.overview(nowIso);
  }

  revokePrincipalLink(
    linkId: string,
    reason?: string,
    nowIso = this.now(),
  ): GatewayOverview {
    const id = requireBoundedText(linkId, 'linkId');
    const existing = this.store.database
      .prepare('SELECT id, state FROM gateway_principal_links WHERE id = ?')
      .get(id) as { id: string; state: string } | undefined;
    if (!existing) {
      throw userError('Principal link not found.');
    }
    this.principalLinks.revokeLink({
      linkId: id,
      actor: this.defaultPrincipalId(),
      reason: reason?.trim() || 'operator-revoked',
      now: nowIso,
    });
    return this.overview(nowIso);
  }

  saveRoute(input: GatewayRouteSaveInput, nowIso = this.now()): GatewayOverview {
    const connectorId = requireBoundedText(input?.connectorId, 'connectorId');
    const connector = this.store.getConnector(connectorId);
    if (!connector) {
      throw userError('Gateway connector not found.');
    }
    const providerAccountId = requireBoundedText(input?.providerAccountId, 'providerAccountId');
    const channelId = requireBoundedText(input?.channelId, 'channelId');
    const workspaceId = requireBoundedText(input?.workspaceId, 'workspaceId');
    this.options.validateWorkspace(workspaceId);

    if (input.mode !== undefined && !ROUTE_MODES.has(input.mode)) {
      throw userError(`Invalid route mode "${String(input.mode)}".`);
    }
    if (input.audience !== undefined && !AUDIENCES.has(input.audience)) {
      throw userError(`Invalid route audience "${String(input.audience)}".`);
    }
    if (input.state !== undefined && !BINDING_STATES.has(input.state)) {
      throw userError(`Invalid route state "${String(input.state)}".`);
    }

    const registeredWorkspaceIds = this.options.listRegisteredWorkspaceIds();
    const routeId = input.id !== undefined ? requireBoundedText(input.id, 'route id') : undefined;
    const existing = routeId ? this.routing.getRoute(routeId) : undefined;

    if (existing) {
      this.routing.updateRoute({
        routeId: existing.id,
        workspaceId,
        mode: input.mode,
        audience: input.audience,
        inboundEnabled: input.inboundEnabled,
        outboundEnabled: input.outboundEnabled,
        state: input.state,
        registeredWorkspaceIds,
        actor: this.defaultPrincipalId(),
        now: nowIso,
      });
    } else {
      const created = this.routing.createRoute({
        ...(routeId ? { id: routeId } : {}),
        connectorId,
        providerAccountId,
        channelId,
        ...(input.threadId?.trim() ? { threadId: input.threadId.trim() } : {}),
        workspaceId,
        mode: input.mode ?? 'explicit-only',
        audience: input.audience ?? 'private',
        inboundEnabled: input.inboundEnabled ?? true,
        outboundEnabled: input.outboundEnabled ?? true,
        isDmDefault: input.isDmDefault ?? false,
        registeredWorkspaceIds,
        now: nowIso,
      });
      if (input.state && input.state !== 'active') {
        this.routing.updateRoute({
          routeId: created.id,
          state: input.state,
          registeredWorkspaceIds,
          actor: this.defaultPrincipalId(),
          now: nowIso,
        });
      }
    }

    return this.overview(nowIso);
  }

  deleteRoute(routeId: string, nowIso = this.now()): GatewayOverview {
    const id = requireBoundedText(routeId, 'routeId');
    const existing = this.routing.getRoute(id);
    if (!existing) {
      throw userError('Gateway route not found.');
    }
    this.outbox.cancelPendingForBinding({
      targetBindingId: id,
      reason: 'route-deleted',
      actor: this.defaultPrincipalId(),
      now: nowIso,
    });
    const deleted = this.store.deleteRoute(id);
    if (!deleted) {
      throw userError('Gateway route could not be deleted.');
    }
    this.store.recordAudit({
      actor: this.defaultPrincipalId(),
      action: 'route.deleted',
      resource: `route:${id}`,
      outcome: 'deleted',
      metadata: { workspaceId: existing.workspaceId, connectorId: existing.connectorId },
      at: nowIso,
    });
    return this.overview(nowIso);
  }

  listWorkspaceReports(workspaceId: string): WorkspaceReportsInboxView {
    const id = requireBoundedText(workspaceId, 'workspaceId');
    this.options.validateWorkspace(id);
    const reports = this.reports.listWorkspaceReports(id);
    const projectionRows = this.store.database.prepare(
      `SELECT id, report_id, chat_id, target_selection, created_at
       FROM gateway_chat_projections
       WHERE workspace_id = ?
       ORDER BY created_at ASC`,
    ).all(id) as Array<Record<string, unknown>>;

    const projections: WorkspaceReportProjectionSummary[] = projectionRows.map(row => ({
      id: String(row.id),
      reportId: String(row.report_id),
      ...(row.chat_id ? { chatId: String(row.chat_id) } : {}),
      targetSelection: String(row.target_selection) as AutonomousReportTargetSelection,
      committedAt: String(row.created_at),
    }));

    return { workspaceId: id, reports, projections };
  }

  listSessionSystemReports(workspaceId: string, sessionId: string): ChatSystemReportsView {
    const wsId = requireBoundedText(workspaceId, 'workspaceId');
    const sessId = requireBoundedText(sessionId, 'sessionId');
    this.options.validateWorkspace(wsId);
    const reports = this.reports
      .listWorkspaceReports(wsId)
      .filter(report => report.workspaceId === wsId && report.targetChatId === sessId);
    return { workspaceId: wsId, sessionId: sessId, reports };
  }

  private buildChatCandidates(
    sessions: readonly GatewaySessionCandidateInput[],
    audienceScopeId: string,
  ): AutonomousReportChatCandidate[] {
    const candidates: AutonomousReportChatCandidate[] = [];
    for (const session of sessions) {
      if (!session.workspaceId) continue;
      const isObserved = Boolean(session.isObserved);
      const isNative = session.isNative !== false;
      candidates.push({
        chatId: session.id,
        workspaceId: session.workspaceId,
        audienceScopeId,
        deleted: Boolean(session.deleted),
        historyEnabled: Boolean(session.historyEnabled),
        observedImmutableTranscript: isObserved,
        supportsSystemReportCards: isNative && !isObserved,
        ...(session.vaultProfileId ? { vaultProfileId: session.vaultProfileId } : {}),
        lastForegroundActiveAt: session.lastActiveAt,
      });
    }
    return candidates;
  }

  private buildOutboundTargets(
    workspaceId: string,
    audienceScopeId: string,
  ): { targets: FanoutDestinationTarget[]; routesById: Map<string, GatewayRouteRecord> } {
    const connectorsById = new Map(this.store.listConnectors().map(c => [c.id, c]));
    const routesById = new Map<string, GatewayRouteRecord>();
    const targets: FanoutDestinationTarget[] = [];

    for (const route of this.store.listRoutes()) {
      if (route.workspaceId !== workspaceId) continue;
      if (route.state !== 'active' || !route.outboundEnabled) continue;
      const connector = connectorsById.get(route.connectorId);
      if (!connector) continue;
      if (
        connector.status === 'disabled'
        || connector.status === 'revoked'
        || connector.status === 'blocked'
      ) {
        continue;
      }
      routesById.set(route.id, route);
      targets.push({
        connectorId: connector.id,
        provider: connector.provider,
        bindingId: route.id,
        bindingRevision: route.policyRevision,
        workspaceId: route.workspaceId,
        audienceScopeId,
        authorized: true,
        subscriptionMode: 'immediate',
        ...(connector.provider === 'whatsapp'
          ? {
              whatsappCompliance: {
                waEnabled: false,
                recipientOptedIn: false,
                serviceWindowOpen: false,
              },
            }
          : {}),
      });
    }

    return { targets, routesById };
  }

  fanoutSettledScheduleRun(input: FanoutSettledScheduleRunInput): FanoutSettledScheduleRunResult {
    const nowIso = input.nowIso ?? this.now();
    const candidates = this.buildChatCandidates(input.sessions, input.audienceScopeId);
    const { targets, routesById } = this.buildOutboundTargets(input.run.workspaceId, input.audienceScopeId);

    const fanoutResult = this.fanout.fanoutScheduleRun({
      run: input.run,
      ...(input.scheduleName ? { scheduleName: input.scheduleName } : {}),
      audienceScopeId: input.audienceScopeId,
      candidates,
      targets,
      now: nowIso,
    });

    const deliveries: RecordDeliveryInput[] = fanoutResult.destinations.map(decision => {
      const route = routesById.get(decision.bindingId);
      const intent = decision.intentId ? this.outbox.getIntent(decision.intentId) : undefined;
      const payloadDigest = intent?.payloadDigest
        ?? createHash('sha256')
          .update(`${fanoutResult.report.id}:${fanoutResult.report.revision}:${decision.bindingId}:${decision.status}`)
          .digest('hex');
      const deliveryState = mapDecisionToDeliveryState(decision.status);
      return {
        runId: input.run.id,
        destinationBindingId: decision.bindingId,
        destinationRevision: route?.policyRevision ?? 1,
        notificationKind: `schedule-run:${decision.provider}:${decision.bindingId}`,
        targetGuildId: route?.providerAccountId ?? decision.connectorId,
        targetChannelId: route?.channelId ?? decision.bindingId,
        ...(route?.threadId ? { targetThreadId: route.threadId } : {}),
        payloadDigest,
        state: deliveryState,
        attemptCount: decision.intentId ? 1 : 0,
        ...(deliveryState === 'failed' || deliveryState === 'cancelled'
          ? { lastErrorCode: decision.status }
          : {}),
        nowIso,
      };
    });

    return { fanout: fanoutResult, deliveries };
  }

  fanoutLearningOutcome(input: FanoutLearningOutcomeInput): FanoutExecutionResult {
    const nowIso = input.nowIso ?? this.now();
    const candidates = this.buildChatCandidates(input.sessions, input.audienceScopeId);
    const { targets } = this.buildOutboundTargets(input.workspaceId, input.audienceScopeId);

    const source: AutonomousReportSource =
      input.source
      ?? (input.learningJob?.kind === 'knowledge-build' || input.learningResult.project
        ? 'knowledge-build'
        : input.learningJob?.kind === 'knowledge-meeting' || input.learningResult.meeting
          ? 'knowledge-meeting'
          : 'learning');

    return this.fanout.fanoutAutonomousReport({
      source,
      sourceJobId: input.sourceJobId,
      ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
      workspaceId: input.workspaceId,
      ...(input.vaultProfileId ? { vaultProfileId: input.vaultProfileId } : {}),
      ...(input.vaultProfileRevision ? { vaultProfileRevision: input.vaultProfileRevision } : {}),
      ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      audienceScopeId: input.audienceScopeId,
      ...(input.learningJob ? { learningJob: input.learningJob } : {}),
      learningResult: input.learningResult,
      candidates,
      targets,
      now: nowIso,
    });
  }
}
