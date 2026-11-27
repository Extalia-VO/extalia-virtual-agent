/**
 * Discord Bot & Auto-Webhook Presenter Adapter for Universal Gateway v2
 * (PRD §5, §7, §8, §13, §15, §16, §18.2 GW-FR-021..044, §20.2 GW-AT-016..035).
 *
 * Transport and presenter only: never creates a second Host, never executes tools directly,
 * never activates skills, and never fabricates agent identity or utterances.
 */
import {
  sanitizeGatewayText,
  validateAgentPortraitIdentity,
  validateGatewayInboundEvent,
  validateGatewayProjectEvent,
  type AgentPortraitIdentity,
  type ApprovedOutbound,
  type ConnectorHealth,
  type ConnectorHealthDimension,
  type ExecutionHealthState,
  type GatewayAdapter,
  type GatewayAudience,
  type GatewayBindingState,
  type GatewayCapabilities,
  type GatewayConnectorState,
  type GatewayInboundEvent,
  type GatewayPermissionBand,
  type GatewayProjectEvent,
  type GatewayRouteBinding,
  type GatewayRouteMode,
  type RawVerifiedTransport,
  type RemoteSendReceipt,
  type VerifiedProviderBatch,
  type WorkspaceSystemReport,
} from '@extalia/platform';
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import type { AutonomousReportService } from './autonomousReports.js';
import {
  aggregateConnectorHealth,
  type GatewayOutboxService,
} from './outbox.js';
import {
  AVATAR_UNAVAILABLE_DIAGNOSTIC,
  AVATAR_UNAVAILABLE_INDICATOR,
  sanitizeDiscordAgentDisplayName,
  type GatewayPortraitService,
} from './portraits.js';
import {
  type GatewayRouteRecord,
  type GatewayRoutingService,
  type PrincipalLinkRecord,
  type RemoteMessageReceiptRecord,
} from './routing.js';
import {
  assertOpaqueSecretRef,
  normalizeThreadKey,
  type GatewayStore,
} from './store.js';

export const DISCORD_API_BASE_URL = 'https://discord.com/api/v10';
export const DISCORD_MAX_MESSAGE_LENGTH = 2000;
export const DISCORD_SYSTEM_BOT_NAME = 'Extalia Gateway Bot';
/** Minimal Gateway intents: GUILDS only (1 << 0). Message Content Intent (1 << 15) is NOT required (GW-AT-034). */
export const DISCORD_MINIMAL_INTENTS = 1;
export const DISCORD_MESSAGE_CONTENT_INTENT_BIT = 1 << 15;

export const DISCORD_PERMISSIONS = {
  ADMINISTRATOR: 1n << 3n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_WEBHOOKS: 1n << 29n,
  USE_APPLICATION_COMMANDS: 1n << 31n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
} as const;

export const DISCORD_SLASH_SUBCOMMANDS = [
  'help',
  'connect',
  'bind',
  'unbind',
  'new',
  'session',
  'status',
  'team',
  'tasks',
  'schedule',
  'reports',
  'pause',
  'cancel',
] as const;

export type DiscordSlashSubcommand = (typeof DISCORD_SLASH_SUBCOMMANDS)[number];

export type DiscordFetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface DiscordSecretStore {
  put(secretRef: string, secretValue: string): void | Promise<void>;
  get(secretRef: string): string | undefined | Promise<string | undefined>;
  delete?(secretRef: string): void | Promise<void>;
}

/** Simple in-memory secret store for tests or ephemeral adapters (never persisted into SQLite). */
export class InMemoryDiscordSecretStore implements DiscordSecretStore {
  private readonly secrets = new Map<string, string>();

  put(secretRef: string, secretValue: string): void {
    assertOpaqueSecretRef(secretRef);
    this.secrets.set(secretRef, secretValue);
  }

  get(secretRef: string): string | undefined {
    return this.secrets.get(secretRef);
  }

  delete(secretRef: string): void {
    this.secrets.delete(secretRef);
  }
}

export type DiscordApiErrorClassification =
  | 'rate-limited'
  | 'retryable'
  | 'permanent-blocked'
  | 'ambiguous-timeout'
  | 'archived-thread'
  | 'deleted-destination';

export class DiscordApiError extends Error {
  constructor(
    public readonly classification: DiscordApiErrorClassification,
    message: string,
    public readonly details: {
      httpStatus?: number;
      discordErrorCode?: number;
      retryAfterSeconds?: number;
    } = {},
  ) {
    super(message);
    this.name = 'DiscordApiError';
  }
}

export interface DiscordManagedWebhook {
  webhookId: string;
  guildId: string;
  channelId: string;
  /** Opaque secret reference only — never raw webhook token or URL. */
  secretRef: string;
  state: 'active' | 'disabled' | 'revoked';
  createdAt: string;
}

export interface DiscordChannelSetupResult {
  ok: boolean;
  guildId: string;
  channelId: string;
  mode: 'webhook-portraits' | 'bot-only-fallback' | 'insufficient-access';
  permissions: {
    viewChannel: boolean;
    sendMessages: boolean;
    sendMessagesInThreads: boolean;
    useApplicationCommands: boolean;
    manageWebhooks: boolean;
  };
  missingPermissions: string[];
  webhook?: DiscordManagedWebhook;
  explanation: string;
}

export interface DiscordSessionSummary {
  sessionId: string;
  workspaceId: string;
  title?: string;
  running: boolean;
}

export interface DiscordSessionStatusSnapshot {
  state: ExecutionHealthState;
  runId?: string;
  leadName?: string;
  activeWorkers: number;
  totalTasks: number;
  lastVerifiedActivityAt?: string;
  summary?: string;
}

export interface DiscordTeamMemberStatus {
  id: string;
  name: string;
  role: string;
  state: string;
  portraitReady: boolean;
  /** Never emitted to Discord even if provided by Host. */
  soul?: string;
}

export interface DiscordTaskSummary {
  id: string;
  title: string;
  status: string;
  ownerAgentId?: string;
}

export interface DiscordScheduleSummary {
  id: string;
  name: string;
  nextRunAt?: string;
  enabled: boolean;
}

/** Narrow Host boundary called by the Discord adapter; adapter holds zero direct runtime/tool authority. */
export interface DiscordHostDelegate {
  getRegisteredWorkspaceIds(): ReadonlySet<string>;
  createManagedSession?(input: {
    workspaceId: string;
    principalId: string;
    channelId: string;
    threadId?: string;
  }): Promise<{ ok: true; sessionId: string; leadName?: string } | { ok: false; reason: string }>;
  listWorkspaceSessions?(input: {
    workspaceId: string;
    principalId: string;
  }): Promise<DiscordSessionSummary[]>;
  getSessionStatus?(input: {
    workspaceId: string;
    sessionId: string;
    runId?: string;
  }): Promise<DiscordSessionStatusSnapshot>;
  getSessionTeam?(input: {
    workspaceId: string;
    sessionId: string;
  }): Promise<DiscordTeamMemberStatus[]>;
  getSessionTasks?(input: {
    workspaceId: string;
    sessionId: string;
  }): Promise<DiscordTaskSummary[]>;
  listSchedules?(input: {
    workspaceId: string;
    principalId: string;
  }): Promise<DiscordScheduleSummary[]>;
  requestCancelTurn?(input: {
    workspaceId: string;
    sessionId: string;
    principalId: string;
  }): Promise<{
    status: 'request_sent' | 'cancelled' | 'not_supported' | 'already_finished' | 'unknown';
    detail?: string;
  }>;
  submitLeadTurn?(input: {
    workspaceId: string;
    sessionId: string;
    principalId: string;
    actionId: string;
    text: string;
    replyContext?: {
      delegateViaLead: true;
      originalRemoteMessageId: string;
      targetAgentId?: string;
      targetTaskId?: string;
      sourceEventId?: string;
      workerActive: boolean;
    };
  }): Promise<{ ok: true; hostActionId: string; status: 'queued' | 'admitted' } | { ok: false; reason: string }>;
  isWorkerActiveInSession?(input: { sessionId: string; agentId: string }): boolean;
  getPinnedParentSessionId?(input: { routeId: string; workspaceId: string }): string | undefined;
  settingsUiBaseUrl?: string;
}

export interface DiscordInteractionOption {
  name: string;
  type?: number;
  value?: string | number | boolean;
  options?: DiscordInteractionOption[];
}

export interface DiscordInteractionPayload {
  id: string;
  type: number; // 1=PING, 2=APPLICATION_COMMAND, 3=MESSAGE_COMPONENT
  application_id: string;
  token: string;
  guild_id?: string;
  channel_id?: string;
  channel?: {
    id: string;
    type?: number;
    parent_id?: string | null;
    thread_metadata?: { archived?: boolean; locked?: boolean };
  };
  member?: {
    user?: { id: string; username?: string; bot?: boolean };
    permissions?: string;
  };
  user?: { id: string; username?: string; bot?: boolean };
  data?: {
    name?: string;
    custom_id?: string;
    options?: DiscordInteractionOption[];
  };
}

export interface DiscordInteractionAck {
  /** Discord Interaction Callback Type: 1=PONG, 4=CHANNEL_MESSAGE, 5=DEFERRED_CHANNEL_MESSAGE. */
  type: 1 | 4 | 5;
  data?: {
    content?: string;
    flags?: number;
    allowed_mentions?: { parse: [] };
  };
}

export interface DiscordCommandExecutionResult {
  ok: boolean;
  subcommand: DiscordSlashSubcommand | 'unknown';
  ephemeral: boolean;
  content: string;
  code?: string;
  route?: GatewayRouteRecord;
  binding?: GatewayRouteBinding;
  sessionId?: string;
}

export interface DiscordThreadEvent {
  eventId: string;
  guildId: string;
  parentChannelId: string;
  threadId: string;
  name?: string;
  archived?: boolean;
  locked?: boolean;
  ownerExternalActorId?: string;
  now: string;
}

export interface DiscordAdapterOptions {
  connectorId: string;
  applicationId: string;
  botUserId: string;
  botTokenSecretRef: string;
  /** Hex-encoded 32-byte Ed25519 Discord application public key for HTTP interaction signature checks. */
  publicKeyHex?: string;
  /** Optional verifier for Gateway WS authenticated transport receipts. */
  verifyGatewayWsReceipt?: (request: RawVerifiedTransport) => boolean;
  store: GatewayStore;
  routing: GatewayRoutingService;
  outbox: GatewayOutboxService;
  portraits: GatewayPortraitService;
  reports?: AutonomousReportService;
  secrets: DiscordSecretStore;
  host: DiscordHostDelegate;
  fetchImpl: DiscordFetchFn;
  apiBaseUrl?: string;
  /** Override clock for deterministic tests. */
  clock?: () => string;
  /** Coalescing interval bounds in milliseconds (default 3000..5000 ms). */
  coalesceMinMs?: number;
  coalesceMaxMs?: number;
}

export interface DiscordLiveRunEventInput {
  bindingId: string;
  runId: string;
  sequence: number;
  category: GatewayProjectEvent['category'];
  provenance: GatewayProjectEvent['provenance'];
  verification: GatewayProjectEvent['verification'];
  text: string;
  agentName?: string;
  agentRole?: string;
  importantTransition?: boolean;
  state?: ExecutionHealthState;
  activeWorkers?: number;
  at: string;
}

export interface DiscordCoalescedCardUpdate {
  bindingId: string;
  runId: string;
  isEdit: boolean;
  remoteMessageId?: string;
  state: ExecutionHealthState;
  text: string;
  coalescedEventCount: number;
  latestSequence: number;
  flushedAt: string;
}

const WEBHOOK_URL_PATTERN = /https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+/i;
const THINKING_BLOCK_PATTERN = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi;
const MODEL_THINKING_LINE_PATTERN = /^.*\bmodel\.thinking\b.*$/gim;
const UNSAFE_MARKDOWN_LINK_PATTERN = /\[([^\]]{1,120})\]\((?!https:\/\/)([^)]+)\)/gi;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Strips model thinking, secrets, private paths, mass mentions, and unsafe markdown links
 * before any Discord message or live card leaves the Host (GW-AT-032, GW-FR-040).
 */
export function sanitizeDiscordContent(raw: string, maxLength = DISCORD_MAX_MESSAGE_LENGTH): string {
  const withoutThinking = String(raw)
    .replace(THINKING_BLOCK_PATTERN, '[internal-reasoning-omitted]')
    .replace(MODEL_THINKING_LINE_PATTERN, '[internal-reasoning-omitted]')
    .replace(UNSAFE_MARKDOWN_LINK_PATTERN, '$1 ([link-removed])');
  return sanitizeGatewayText(withoutThinking, {
    maxLength,
    stripMentions: true,
    redactSecrets: true,
    redactPaths: true,
  }).text;
}

/** Detects raw Discord webhook URLs pasted into chat or command inputs (GW-FR-024). */
export function containsDiscordWebhookUrl(text: string | undefined): boolean {
  return typeof text === 'string' && WEBHOOK_URL_PATTERN.test(text);
}

/** Checks Discord's Ed25519 HTTP interaction signature over `timestamp + rawBody`. */
export function verifyDiscordEd25519Signature(input: {
  publicKeyHex: string;
  signatureHex: string;
  timestamp: string;
  rawBody: string;
  nowMs?: number;
  maxSkewSeconds?: number;
}): boolean {
  if (!/^[0-9a-f]{64}$/i.test(input.publicKeyHex)) return false;
  if (!/^[0-9a-f]{128}$/i.test(input.signatureHex)) return false;
  if (!/^\d{9,12}$/.test(input.timestamp)) return false;

  const maxSkew = input.maxSkewSeconds ?? 300;
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const tsSec = Number(input.timestamp);
  if (Math.abs(nowSec - tsSec) > maxSkew) return false;

  try {
    const keyDer = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(input.publicKeyHex, 'hex')]);
    const keyObject = createPublicKey({ key: keyDer, format: 'der', type: 'spki' });
    const message = Buffer.from(`${input.timestamp}${input.rawBody}`, 'utf8');
    const signature = Buffer.from(input.signatureHex, 'hex');
    return cryptoVerify(null, message, keyObject, signature);
  } catch {
    return false;
  }
}

interface LiveRunBucket {
  bindingId: string;
  runId: string;
  remoteMessageId?: string;
  lastSequence: number;
  lastFlushedAtMs: number;
  state: ExecutionHealthState;
  activeWorkers: number;
  totalObservedEvents: number;
  pendingCount: number;
  recentLines: string[];
  importantPending: boolean;
}

/**
 * Adaptive 3–5 s coalescer for Discord live run status cards and high-volume worker progress
 * (PRD §8.5, §15.3, GW-AT-029). Preserves monotonic sequencing and flushes critical transitions
 * immediately without flooding channels.
 */
export class DiscordLiveRunCoalescer {
  private readonly buckets = new Map<string, LiveRunBucket>();
  private readonly minIntervalMs: number;
  private readonly maxIntervalMs: number;

  constructor(options?: { minIntervalMs?: number; maxIntervalMs?: number }) {
    this.minIntervalMs = Math.max(500, options?.minIntervalMs ?? 3000);
    this.maxIntervalMs = Math.max(this.minIntervalMs, options?.maxIntervalMs ?? 5000);
  }

  private key(bindingId: string, runId: string): string {
    return `${bindingId}::${runId}`;
  }

  bindCardMessageId(bindingId: string, runId: string, remoteMessageId: string): void {
    const bucket = this.buckets.get(this.key(bindingId, runId));
    if (bucket) bucket.remoteMessageId = remoteMessageId;
  }

  getCardMessageId(bindingId: string, runId: string): string | undefined {
    return this.buckets.get(this.key(bindingId, runId))?.remoteMessageId;
  }

  /**
   * Ingests a run/worker event. Returns a coalesced status card update when due
   * (immediately on important transitions or once the adaptive 3–5 s window elapses),
   * or `undefined` while coalescing burst progress events.
   */
  ingest(event: DiscordLiveRunEventInput): DiscordCoalescedCardUpdate | undefined {
    const k = this.key(event.bindingId, event.runId);
    let bucket = this.buckets.get(k);
    const eventMs = Date.parse(event.at);

    if (!bucket) {
      bucket = {
        bindingId: event.bindingId,
        runId: event.runId,
        lastSequence: 0,
        lastFlushedAtMs: 0,
        state: event.state ?? 'running',
        activeWorkers: event.activeWorkers ?? 0,
        totalObservedEvents: 0,
        pendingCount: 0,
        recentLines: [],
        importantPending: false,
      };
      this.buckets.set(k, bucket);
    }

    // Enforce monotonic source event sequence: older arrivals never overwrite newer state.
    if (event.sequence <= bucket.lastSequence) {
      return undefined;
    }
    bucket.lastSequence = event.sequence;
    bucket.totalObservedEvents += 1;
    bucket.pendingCount += 1;

    if (event.state) bucket.state = event.state;
    if (event.activeWorkers !== undefined) bucket.activeWorkers = event.activeWorkers;

    const provenanceTag = event.provenance === 'host-receipt'
      ? 'host-verified'
      : event.provenance === 'runtime-observed'
        ? 'runtime-observed'
        : 'model-reported';
    const actorPrefix = event.agentName
      ? `${event.agentName}${event.agentRole ? ` (${event.agentRole})` : ''}: `
      : '';
    const safeLine = sanitizeDiscordContent(`${actorPrefix}${event.text}`, 180);
    bucket.recentLines.push(`- [${provenanceTag}] ${safeLine}`);
    if (bucket.recentLines.length > 6) {
      bucket.recentLines.splice(0, bucket.recentLines.length - 6);
    }

    const isImportant =
      Boolean(event.importantTransition)
      || event.category === 'approval'
      || event.category === 'terminal'
      || event.category === 'execution-health'
      || event.state === 'waiting_approval'
      || event.state === 'completed'
      || event.state === 'failed'
      || event.state === 'cancelled'
      || event.state === 'interrupted';

    if (isImportant) bucket.importantPending = true;

    const elapsedMs = bucket.lastFlushedAtMs === 0 ? Infinity : eventMs - bucket.lastFlushedAtMs;
    // Adaptive backoff: bursty updates widen toward maxIntervalMs (5 s), calm traffic stays at minIntervalMs (3 s).
    const adaptiveWindowMs = bucket.pendingCount >= 10 ? this.maxIntervalMs : this.minIntervalMs;

    if (!isImportant && elapsedMs < adaptiveWindowMs) {
      return undefined;
    }

    return this.buildFlush(bucket, event.at, eventMs);
  }

  /** Flushes any pending coalesced events whose adaptive interval has elapsed (or force-flushes). */
  flushDue(bindingId: string, runId: string, now: string, force = false): DiscordCoalescedCardUpdate | undefined {
    const bucket = this.buckets.get(this.key(bindingId, runId));
    if (!bucket || bucket.pendingCount === 0) return undefined;
    const nowMs = Date.parse(now);
    const adaptiveWindowMs = bucket.pendingCount >= 10 ? this.maxIntervalMs : this.minIntervalMs;
    if (!force && !bucket.importantPending && nowMs - bucket.lastFlushedAtMs < adaptiveWindowMs) {
      return undefined;
    }
    return this.buildFlush(bucket, now, nowMs);
  }

  private buildFlush(bucket: LiveRunBucket, nowIso: string, nowMs: number): DiscordCoalescedCardUpdate {
    const coalescedCount = bucket.pendingCount;
    bucket.pendingCount = 0;
    bucket.importantPending = false;
    bucket.lastFlushedAtMs = nowMs;

    const header = [
      `**[${DISCORD_SYSTEM_BOT_NAME} · Live Run Status]**`,
      `Run: \`${bucket.runId}\` | State: \`${bucket.state}\` | Active workers: ${bucket.activeWorkers}`,
      `Verified activity events: ${bucket.totalObservedEvents} (last seq #${bucket.lastSequence}, batch=${coalescedCount}) | Updated: ${nowIso}`,
    ];
    const body = bucket.recentLines.length > 0
      ? `\nRecent activity:\n${bucket.recentLines.join('\n')}`
      : '';
    const text = sanitizeDiscordContent(`${header.join('\n')}${body}`, DISCORD_MAX_MESSAGE_LENGTH);

    return {
      bindingId: bucket.bindingId,
      runId: bucket.runId,
      isEdit: Boolean(bucket.remoteMessageId),
      remoteMessageId: bucket.remoteMessageId,
      state: bucket.state,
      text,
      coalescedEventCount: coalescedCount,
      latestSequence: bucket.lastSequence,
      flushedAt: nowIso,
    };
  }
}

function hasPerm(bitfield: bigint, flag: bigint): boolean {
  if ((bitfield & DISCORD_PERMISSIONS.ADMINISTRATOR) !== 0n) return true;
  return (bitfield & flag) === flag;
}

function parseDiscordPermissionBits(raw: unknown): bigint {
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return BigInt(raw);
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return BigInt(raw.trim());
  return 0n;
}

function extractOptionString(options: readonly DiscordInteractionOption[] | undefined, name: string): string | undefined {
  const found = options?.find(o => o.name === name);
  if (!found || found.value === undefined) return undefined;
  return String(found.value).trim();
}

function extractOptionNumber(options: readonly DiscordInteractionOption[] | undefined, name: string): number | undefined {
  const found = options?.find(o => o.name === name);
  if (!found || found.value === undefined) return undefined;
  const num = Number(found.value);
  return Number.isFinite(num) ? num : undefined;
}

function resolveBindingRow(store: GatewayStore, bindingId: string): {
  id: string;
  routeId: string;
  connectorId: string;
  providerAccountId: string;
  channelId: string;
  threadId?: string;
  workspaceId: string;
  sessionId: string;
  policyRevision: number;
  audience: GatewayAudience;
  state: GatewayBindingState;
} | undefined {
  const row = store.database
    .prepare('SELECT * FROM gateway_bindings WHERE id = ?')
    .get(bindingId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const threadKey = String(row.thread_key);
  return {
    id: String(row.id),
    routeId: String(row.route_id),
    connectorId: String(row.connector_id),
    providerAccountId: String(row.provider_account_id),
    channelId: String(row.channel_id),
    threadId: threadKey.length > 0 ? threadKey : undefined,
    workspaceId: String(row.workspace_id),
    sessionId: String(row.session_id),
    policyRevision: Number(row.policy_revision),
    audience: String(row.audience) as GatewayAudience,
    state: String(row.state) as GatewayBindingState,
  };
}

export class DiscordGatewayAdapter implements GatewayAdapter {
  readonly provider = 'discord' as const;

  private readonly apiBaseUrl: string;
  private readonly clock: () => string;
  private readonly webhooksByChannel = new Map<string, DiscordManagedWebhook>();
  private readonly channelFallbackMode = new Map<string, 'webhook-portraits' | 'bot-only-fallback'>();
  private readonly coalescer: DiscordLiveRunCoalescer;
  private capabilityRevision = 1;
  private lastTransportHeartbeatAt?: string;
  private lastVerifiedEffectAt?: string;
  private lastNotificationError?: string;

  constructor(private readonly options: DiscordAdapterOptions) {
    this.apiBaseUrl = (options.apiBaseUrl ?? DISCORD_API_BASE_URL).replace(/\/+$/, '');
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.coalescer = new DiscordLiveRunCoalescer({
      minIntervalMs: options.coalesceMinMs,
      maxIntervalMs: options.coalesceMaxMs,
    });
  }

  get liveRunCoalescer(): DiscordLiveRunCoalescer {
    return this.coalescer;
  }

  getMinimalGatewayIntents(): number {
    // Explicitly omits Message Content Intent (1 << 15) (GW-AT-034).
    return DISCORD_MINIMAL_INTENTS;
  }

  getChannelWebhook(channelId: string): DiscordManagedWebhook | undefined {
    return this.webhooksByChannel.get(channelId);
  }

  /** Registers an already-provisioned webhook record using strictly an opaque secretRef. */
  registerManagedWebhook(webhook: DiscordManagedWebhook): void {
    assertOpaqueSecretRef(webhook.secretRef);
    this.webhooksByChannel.set(webhook.channelId, webhook);
    if (webhook.state === 'active') {
      this.channelFallbackMode.set(webhook.channelId, 'webhook-portraits');
    }
  }

  async capabilities(connectorId: string): Promise<Readonly<GatewayCapabilities>> {
    const connector = this.options.store.getConnector(connectorId);
    const hasActiveWebhook = [...this.webhooksByChannel.values()].some(w => w.state === 'active');
    return Object.freeze({
      provider: 'discord',
      revision: Math.max(this.capabilityRevision, connector?.capabilityRevision ?? 1),
      receiveCommands: true,
      createOrResumeSession: Boolean(this.options.host.createManagedSession),
      perAgentWebhookPortraits: hasActiveWebhook,
      editMessages: true,
      replyReceipts: true,
      threadsOrTopics: true,
      attachments: false,
      deliveryCallbacks: false,
      supportsCancel: Boolean(this.options.host.requestCancelTurn),
      requiresComplianceGate: false,
      maxMessageLength: DISCORD_MAX_MESSAGE_LENGTH,
    });
  }

  /**
   * Verifies Discord transport authenticity (Ed25519 HTTP interaction signature OR
   * verified Gateway WS receipt) before any normalization or inbox persistence (GW-AT-001).
   */
  async authenticateInbound(request: RawVerifiedTransport): Promise<VerifiedProviderBatch> {
    if (request.provider !== 'discord') {
      throw new Error(`Discord adapter refused mismatched provider "${request.provider}".`);
    }
    if (request.connectorId !== this.options.connectorId) {
      throw new Error(`Discord adapter refused mismatched connector "${request.connectorId}".`);
    }
    if (Buffer.byteLength(request.rawBody, 'utf8') > 512 * 1024) {
      throw new Error('Discord inbound payload exceeds 512 KiB safety bound.');
    }

    const headersLower: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.headers)) {
      headersLower[k.toLowerCase()] = v;
    }

    const sig = headersLower['x-signature-ed25519'];
    const ts = headersLower['x-signature-timestamp'];
    let verified = false;

    if (sig && ts && this.options.publicKeyHex) {
      verified = verifyDiscordEd25519Signature({
        publicKeyHex: this.options.publicKeyHex,
        signatureHex: sig,
        timestamp: ts,
        rawBody: request.rawBody,
        nowMs: Date.parse(request.receivedAt),
      });
    } else if (this.options.verifyGatewayWsReceipt) {
      verified = this.options.verifyGatewayWsReceipt(request);
    }

    if (!verified) {
      this.options.store.recordAudit({
        actor: 'untrusted_external',
        action: 'discord.inbound.auth_failed',
        resource: `connector:${request.connectorId}`,
        outcome: 'denied',
        reason: 'Discord transport authenticity verification failed.',
        at: request.receivedAt,
      });
      throw new Error('Unauthenticated Discord transport payload.');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(request.rawBody);
    } catch {
      throw new Error('Discord inbound payload is not valid JSON.');
    }

    const events = Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      : parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? [parsed as Record<string, unknown>]
        : [];

    if (events.length === 0) {
      throw new Error('Discord inbound batch contains no valid event objects.');
    }

    this.lastTransportHeartbeatAt = request.receivedAt;
    const receiptHash = createHash('sha256')
      .update(`${request.connectorId}:${request.authenticatedTransportReceipt}:${request.receivedAt}`)
      .digest('hex')
      .slice(0, 32);

    return {
      connectorId: request.connectorId,
      provider: 'discord',
      authenticatedTransportReceipt: `discord-verified:${receiptHash}`,
      receivedAt: request.receivedAt,
      events,
    };
  }

  /**
   * Normalizes verified Discord interactions, explicit mentions/replies, and thread/guild
   * lifecycle payloads into strict `GatewayInboundEvent[]` without requiring Message Content Intent.
   */
  normalize(batch: VerifiedProviderBatch): GatewayInboundEvent[] {
    const normalized: GatewayInboundEvent[] = [];

    for (const raw of batch.events) {
      const eventType = typeof raw.t === 'string' ? raw.t : undefined;
      const payload = (raw.d && typeof raw.d === 'object' && !Array.isArray(raw.d))
        ? raw.d as Record<string, unknown>
        : raw;

      // 1. Slash command or component interaction (works with zero Message Content Intent: GW-AT-034).
      if (typeof payload.type === 'number' && (payload.type === 2 || payload.type === 3)) {
        const interaction = payload as unknown as DiscordInteractionPayload;
        const userObj = interaction.member?.user ?? interaction.user;
        const actorId = userObj?.id;
        const guildId = interaction.guild_id ?? 'dm';
        const channel = interaction.channel;
        const isThread = Boolean(channel?.parent_id);
        const channelId = isThread ? String(channel?.parent_id) : (interaction.channel_id ?? channel?.id);
        const threadId = isThread ? (interaction.channel_id ?? channel?.id) : undefined;
        if (!actorId || !channelId || !interaction.id) continue;

        const commandName = interaction.data?.name ?? 'extalia';
        const subOption = interaction.data?.options?.[0];
        const text = interaction.type === 2
          ? `/${commandName}${subOption?.name ? ` ${subOption.name}` : ''}`
          : interaction.data?.custom_id ?? 'component-callback';

        const candidate: GatewayInboundEvent = {
          schema: 'extalia.gateway.inbound.v1',
          connectorId: batch.connectorId,
          provider: 'discord',
          providerEventId: `ix:${interaction.id}`,
          providerAccountId: guildId,
          channelId,
          ...(threadId ? { threadId } : {}),
          externalActorId: actorId,
          actorKind: userObj?.bot ? 'bot' : 'human',
          remoteMessageId: interaction.id,
          kind: interaction.type === 2 ? 'command' : 'callback',
          text,
          receivedAt: batch.receivedAt,
          authenticatedTransportReceipt: batch.authenticatedTransportReceipt,
        };
        const validated = validateGatewayInboundEvent(candidate);
        if (validated.ok) normalized.push(validated.value);
        continue;
      }

      // 2. Lifecycle events (THREAD_CREATE, THREAD_UPDATE, THREAD_DELETE, GUILD_DELETE).
      if (eventType && ['THREAD_CREATE', 'THREAD_UPDATE', 'THREAD_DELETE', 'GUILD_DELETE', 'CHANNEL_DELETE'].includes(eventType)) {
        const guildId = String(payload.guild_id ?? payload.id ?? 'unknown-guild');
        const parentId = typeof payload.parent_id === 'string' && payload.parent_id ? payload.parent_id : String(payload.id ?? guildId);
        const threadId = typeof payload.parent_id === 'string' && payload.parent_id ? String(payload.id) : undefined;
        const eventId = `life:${eventType}:${String(payload.id ?? guildId)}:${batch.receivedAt}`;

        const candidate: GatewayInboundEvent = {
          schema: 'extalia.gateway.inbound.v1',
          connectorId: batch.connectorId,
          provider: 'discord',
          providerEventId: eventId,
          providerAccountId: guildId,
          channelId: parentId,
          ...(threadId ? { threadId } : {}),
          externalActorId: typeof payload.owner_id === 'string' ? payload.owner_id : 'discord-system',
          actorKind: 'unknown',
          kind: 'lifecycle',
          text: eventType,
          receivedAt: batch.receivedAt,
          authenticatedTransportReceipt: batch.authenticatedTransportReceipt,
        };
        const validated = validateGatewayInboundEvent(candidate);
        if (validated.ok) normalized.push(validated.value);
        continue;
      }

      // 3. Explicit message / reply event (MESSAGE_CREATE).
      const msgId = typeof payload.id === 'string' ? payload.id : undefined;
      const author = (payload.author && typeof payload.author === 'object' && !Array.isArray(payload.author))
        ? payload.author as Record<string, unknown>
        : undefined;
      const authorId = typeof author?.id === 'string' ? author.id : undefined;
      if (!msgId || !authorId) continue;

      const guildId = typeof payload.guild_id === 'string' ? payload.guild_id : 'dm';
      const parentChannelId = typeof payload.parent_channel_id === 'string' && payload.parent_channel_id
        ? payload.parent_channel_id
        : String(payload.channel_id ?? '');
      const threadId = typeof payload.parent_channel_id === 'string' && payload.parent_channel_id
        ? String(payload.channel_id ?? '')
        : undefined;
      if (!parentChannelId) continue;

      const isWebhook = typeof payload.webhook_id === 'string' && payload.webhook_id.length > 0;
      const isBot = author?.bot === true || authorId === this.options.botUserId;
      const msgRef = (payload.message_reference && typeof payload.message_reference === 'object' && !Array.isArray(payload.message_reference))
        ? payload.message_reference as Record<string, unknown>
        : undefined;
      const replyToId = typeof msgRef?.message_id === 'string' ? msgRef.message_id : undefined;
      const content = typeof payload.content === 'string' ? payload.content : undefined;

      const candidate: GatewayInboundEvent = {
        schema: 'extalia.gateway.inbound.v1',
        connectorId: batch.connectorId,
        provider: 'discord',
        providerEventId: `msg:${msgId}`,
        providerAccountId: guildId,
        channelId: parentChannelId,
        ...(threadId ? { threadId } : {}),
        externalActorId: authorId,
        actorKind: isWebhook ? 'webhook' : isBot ? 'bot' : 'human',
        remoteMessageId: msgId,
        ...(replyToId ? { replyToRemoteMessageId: replyToId } : {}),
        kind: 'text',
        ...(content !== undefined ? { text: content } : {}),
        receivedAt: batch.receivedAt,
        authenticatedTransportReceipt: batch.authenticatedTransportReceipt,
      };
      const validated = validateGatewayInboundEvent(candidate);
      if (validated.ok) normalized.push(validated.value);
    }

    return normalized;
  }

  /**
   * Verifies bot guild/channel permissions and auto-creates a revocable channel webhook
   * when `Manage Webhooks` is granted; falls back honestly to labeled bot-only mode when
   * `Manage Webhooks` is missing (GW-AT-016, GW-FR-022..024).
   */
  async verifyChannelPermissionsAndSetupWebhook(input: {
    guildId: string;
    channelId: string;
    actor: string;
    now: string;
  }): Promise<DiscordChannelSetupResult> {
    const botToken = await this.requireBotToken();

    // 1. Verify bot guild membership & roles + channel overwrites via Discord REST API.
    const guildRes = await this.discordJsonRequest<{
      id: string;
      roles?: Array<{ id: string; permissions: string }>;
    }>('GET', `/guilds/${encodeURIComponent(input.guildId)}`, { botToken });

    const memberRes = await this.discordJsonRequest<{
      roles?: string[];
      permissions?: string;
    }>('GET', `/guilds/${encodeURIComponent(input.guildId)}/members/${encodeURIComponent(this.options.botUserId)}`, { botToken });

    const channelRes = await this.discordJsonRequest<{
      id: string;
      guild_id?: string;
      permission_overwrites?: Array<{ id: string; type: number; allow: string; deny: string }>;
    }>('GET', `/channels/${encodeURIComponent(input.channelId)}`, { botToken });

    // Compute effective channel permission bitmask (Discord specification).
    const roleIds = new Set<string>([input.guildId, ...(memberRes.roles ?? [])]);
    let effective = parseDiscordPermissionBits(memberRes.permissions);
    for (const role of guildRes.roles ?? []) {
      if (roleIds.has(role.id)) {
        effective |= parseDiscordPermissionBits(role.permissions);
      }
    }

    if ((effective & DISCORD_PERMISSIONS.ADMINISTRATOR) === 0n) {
      const overwrites = channelRes.permission_overwrites ?? [];
      // Apply @everyone overwrite
      const everyoneOw = overwrites.find(o => o.id === input.guildId);
      if (everyoneOw) {
        effective &= ~parseDiscordPermissionBits(everyoneOw.deny);
        effective |= parseDiscordPermissionBits(everyoneOw.allow);
      }
      // Apply role overwrites
      let roleAllow = 0n;
      let roleDeny = 0n;
      for (const ow of overwrites) {
        if (ow.id !== input.guildId && roleIds.has(ow.id)) {
          roleAllow |= parseDiscordPermissionBits(ow.allow);
          roleDeny |= parseDiscordPermissionBits(ow.deny);
        }
      }
      effective &= ~roleDeny;
      effective |= roleAllow;
      // Apply member-specific overwrite
      const memberOw = overwrites.find(o => o.id === this.options.botUserId);
      if (memberOw) {
        effective &= ~parseDiscordPermissionBits(memberOw.deny);
        effective |= parseDiscordPermissionBits(memberOw.allow);
      }
    }

    const perms = {
      viewChannel: hasPerm(effective, DISCORD_PERMISSIONS.VIEW_CHANNEL),
      sendMessages: hasPerm(effective, DISCORD_PERMISSIONS.SEND_MESSAGES),
      sendMessagesInThreads: hasPerm(effective, DISCORD_PERMISSIONS.SEND_MESSAGES_IN_THREADS),
      useApplicationCommands: hasPerm(effective, DISCORD_PERMISSIONS.USE_APPLICATION_COMMANDS),
      manageWebhooks: hasPerm(effective, DISCORD_PERMISSIONS.MANAGE_WEBHOOKS),
    };

    const missingPermissions: string[] = [];
    if (!perms.viewChannel) missingPermissions.push('VIEW_CHANNEL');
    if (!perms.sendMessages) missingPermissions.push('SEND_MESSAGES');
    if (!perms.sendMessagesInThreads) missingPermissions.push('SEND_MESSAGES_IN_THREADS');
    if (!perms.useApplicationCommands) missingPermissions.push('USE_APPLICATION_COMMANDS');
    if (!perms.manageWebhooks) missingPermissions.push('MANAGE_WEBHOOKS');

    if (!perms.viewChannel || !perms.sendMessages) {
      this.options.store.recordAudit({
        actor: input.actor,
        action: 'discord.channel.setup_denied',
        resource: `channel:${input.channelId}`,
        outcome: 'blocked',
        reason: `Missing required channel permissions: ${missingPermissions.join(', ')}`,
        at: input.now,
      });
      return {
        ok: false,
        guildId: input.guildId,
        channelId: input.channelId,
        mode: 'insufficient-access',
        permissions: perms,
        missingPermissions,
        explanation: `Bot cannot operate in channel ${input.channelId}; missing required permissions: ${missingPermissions.join(', ')}.`,
      };
    }

    // GW-AT-016: missing Manage Webhooks -> honest bot-only fallback, never pretend portraits work.
    if (!perms.manageWebhooks) {
      this.channelFallbackMode.set(input.channelId, 'bot-only-fallback');
      this.webhooksByChannel.delete(input.channelId);
      this.capabilityRevision += 1;
      await this.syncConnectorCapabilities(input.now);

      this.options.store.recordAudit({
        actor: input.actor,
        action: 'discord.webhook.fallback_bot_only',
        resource: `channel:${input.channelId}`,
        outcome: 'degraded',
        reason: 'Missing MANAGE_WEBHOOKS permission; using labeled bot-only sender fallback.',
        at: input.now,
      });

      return {
        ok: true,
        guildId: input.guildId,
        channelId: input.channelId,
        mode: 'bot-only-fallback',
        permissions: perms,
        missingPermissions,
        explanation:
          'Missing Manage Webhooks permission on this channel. Per-agent webhook portraits are unavailable; '
          + 'falling back to labeled Extalia Gateway Bot messages until Manage Webhooks is granted.',
      };
    }

    // Auto-create channel webhook and store token ONLY under an opaque secretRef (GW-FR-023..024).
    const created = await this.discordJsonRequest<{ id: string; token?: string }>(
      'POST',
      `/channels/${encodeURIComponent(input.channelId)}/webhooks`,
      {
        botToken,
        body: { name: 'Extalia Agent Presenter' },
      },
    );

    if (!created.id || !created.token) {
      throw new DiscordApiError(
        'permanent-blocked',
        'Discord created webhook response did not include an id and token.',
      );
    }

    const secretRef = `keychain://extalia/gateway/discord/webhook/${input.channelId}/${created.id}`;
    assertOpaqueSecretRef(secretRef);
    await this.options.secrets.put(secretRef, created.token);

    const record: DiscordManagedWebhook = {
      webhookId: created.id,
      guildId: input.guildId,
      channelId: input.channelId,
      secretRef,
      state: 'active',
      createdAt: input.now,
    };
    this.webhooksByChannel.set(input.channelId, record);
    this.channelFallbackMode.set(input.channelId, 'webhook-portraits');
    this.capabilityRevision += 1;
    await this.syncConnectorCapabilities(input.now);

    this.options.store.recordAudit({
      actor: input.actor,
      action: 'discord.webhook.provisioned',
      resource: `channel:${input.channelId}`,
      outcome: 'allowed',
      metadata: { webhookId: record.webhookId, secretRef: record.secretRef },
      at: input.now,
    });

    return {
      ok: true,
      guildId: input.guildId,
      channelId: input.channelId,
      mode: 'webhook-portraits',
      permissions: perms,
      missingPermissions,
      webhook: record,
      explanation: `Verified permissions and provisioned auto-managed webhook ${record.webhookId} for per-agent portraits.`,
    };
  }

  private async syncConnectorCapabilities(now: string): Promise<void> {
    const connector = this.options.store.getConnector(this.options.connectorId);
    if (!connector) return;
    const caps = await this.capabilities(this.options.connectorId);
    this.options.store.upsertConnector({
      id: connector.id,
      provider: connector.provider,
      providerAccountId: connector.providerAccountId,
      secretRef: connector.secretRef,
      status: connector.status,
      policyVersion: connector.policyVersion,
      capabilityRevision: caps.revision,
      capabilities: caps,
      now,
    });
  }

  /**
   * Sends an approved outbound intent via Discord Bot API (system notices, reports, bot-only fallback)
   * or managed channel webhook with `wait=true` (Lead/Worker outputs backed by real portraits).
   */
  async send(approved: ApprovedOutbound): Promise<RemoteSendReceipt> {
    const now = this.clock();
    const binding = resolveBindingRow(this.options.store, approved.intent.targetBindingId);
    if (!binding) {
      throw new DiscordApiError(
        'deleted-destination',
        `Target binding "${approved.intent.targetBindingId}" was not found.`,
      );
    }
    if (binding.state !== 'active') {
      throw new DiscordApiError(
        binding.state === 'paused' ? 'archived-thread' : 'deleted-destination',
        `Refusing send to non-active Discord binding "${binding.id}" (state=${binding.state}).`,
      );
    }

    const safeContent = sanitizeDiscordContent(approved.safeText, DISCORD_MAX_MESSAGE_LENGTH);
    const allowedMentions = approved.disableMentions ? { parse: [] as string[] } : undefined;
    const targetChannelOrThread = binding.threadId ?? binding.channelId;

    // Strict Bot vs Agent separation: system notices, health alerts, approvals, and autonomous
    // Knowledge/Skills reports MUST always use Extalia Gateway Bot, never webhook agent personas.
    const isSystemOutput =
      approved.intent.senderKind === 'gateway-system'
      || approved.intent.messageClass === 'system-report'
      || approved.intent.messageClass === 'attention';

    if (isSystemOutput) {
      const botToken = await this.requireBotToken();
      const response = await this.discordJsonRequest<{ id: string }>(
        'POST',
        `/channels/${encodeURIComponent(targetChannelOrThread)}/messages`,
        {
          botToken,
          body: {
            content: safeContent,
            ...(allowedMentions ? { allowed_mentions: allowedMentions } : {}),
          },
        },
      );
      this.lastVerifiedEffectAt = now;
      this.lastNotificationError = undefined;
      return {
        connectorId: approved.intent.connectorId,
        provider: 'discord',
        remoteMessageId: response.id,
        acceptedAt: now,
        state: 'accepted',
      };
    }

    // Lead / Worker outputs require a validated real AgentPortraitIdentity and sourceEventId.
    if (!approved.intent.senderPortrait || !approved.intent.sourceEventId) {
      throw new DiscordApiError(
        'permanent-blocked',
        'Lead/Worker presentation requires a verified AgentPortraitIdentity and sourceEventId.',
      );
    }
    const portraitValid = validateAgentPortraitIdentity(approved.intent.senderPortrait);
    if (!portraitValid.ok) {
      throw new DiscordApiError('permanent-blocked', `Invalid senderPortrait: ${portraitValid.error}`);
    }
    const portrait = portraitValid.value;
    if (portrait.kind !== approved.intent.senderKind) {
      throw new DiscordApiError(
        'permanent-blocked',
        `Sender kind "${approved.intent.senderKind}" does not match portrait kind "${portrait.kind}".`,
      );
    }

    const guardedName = sanitizeDiscordAgentDisplayName(portrait.name, {
      role: portrait.role,
      kind: portrait.kind,
    });
    const webhook = this.webhooksByChannel.get(binding.channelId);

    if (webhook && webhook.state === 'active') {
      const webhookToken = await this.options.secrets.get(webhook.secretRef);
      if (webhookToken) {
        const avatarRes = this.options.portraits.resolveAvatarUrlForIdentity(portrait, now);
        let content = safeContent;
        if (!avatarRes.ok) {
          this.options.store.recordAudit({
            actor: `connector:${this.options.connectorId}`,
            action: 'discord.portrait.avatar_unavailable',
            resource: `agent:${portrait.sessionId}:${portrait.agentId}`,
            outcome: AVATAR_UNAVAILABLE_DIAGNOSTIC,
            reason: avatarRes.reason,
            at: now,
          });
          // Preserve real agent name/role with explicit fallback indicator when avatar server unreachable (GW-AT-025).
          content = sanitizeDiscordContent(
            `${AVATAR_UNAVAILABLE_INDICATOR} ${safeContent}`,
            DISCORD_MAX_MESSAGE_LENGTH,
          );
        }

        const query = new URLSearchParams({ wait: 'true' });
        if (binding.threadId) query.set('thread_id', binding.threadId);

        const body: Record<string, unknown> = {
          content,
          username: guardedName.displayName,
          ...(avatarRes.ok ? { avatar_url: avatarRes.avatarUrl } : {}),
          ...(allowedMentions ? { allowed_mentions: allowedMentions } : {}),
        };

        const response = await this.discordJsonRequest<{ id: string }>(
          'POST',
          `/webhooks/${encodeURIComponent(webhook.webhookId)}/${encodeURIComponent(webhookToken)}?${query.toString()}`,
          { body },
        );

        this.lastVerifiedEffectAt = now;
        this.lastNotificationError = undefined;
        return {
          connectorId: approved.intent.connectorId,
          provider: 'discord',
          remoteMessageId: response.id,
          acceptedAt: now,
          state: 'accepted',
        };
      }
    }

    // Honest labeled bot-only fallback when Manage Webhooks is unavailable (GW-AT-016).
    const botToken = await this.requireBotToken();
    const roleLabel = portrait.kind === 'lead' ? 'Lead' : 'Worker';
    const fallbackText = sanitizeDiscordContent(
      `[${roleLabel}: ${guardedName.displayName} · ${portrait.role}] (bot-only fallback)\n${safeContent}`,
      DISCORD_MAX_MESSAGE_LENGTH,
    );
    const response = await this.discordJsonRequest<{ id: string }>(
      'POST',
      `/channels/${encodeURIComponent(targetChannelOrThread)}/messages`,
      {
        botToken,
        body: {
          content: fallbackText,
          ...(allowedMentions ? { allowed_mentions: allowedMentions } : {}),
        },
      },
    );
    this.lastVerifiedEffectAt = now;
    this.lastNotificationError = undefined;
    return {
      connectorId: approved.intent.connectorId,
      provider: 'discord',
      remoteMessageId: response.id,
      acceptedAt: now,
      state: 'accepted',
    };
  }

  /** Edits an existing bot-owned or webhook-owned Discord message (e.g., live run status card). */
  async edit(receipt: RemoteSendReceipt, approved: ApprovedOutbound): Promise<RemoteSendReceipt> {
    const now = this.clock();
    const binding = resolveBindingRow(this.options.store, approved.intent.targetBindingId);
    if (!binding || binding.state !== 'active') {
      throw new DiscordApiError(
        binding?.state === 'paused' ? 'archived-thread' : 'deleted-destination',
        `Cannot edit message on non-active binding "${approved.intent.targetBindingId}".`,
      );
    }

    const safeContent = sanitizeDiscordContent(approved.safeText, DISCORD_MAX_MESSAGE_LENGTH);
    const allowedMentions = approved.disableMentions ? { parse: [] as string[] } : undefined;
    const isSystemOutput = approved.intent.senderKind === 'gateway-system';
    const webhook = !isSystemOutput ? this.webhooksByChannel.get(binding.channelId) : undefined;

    if (webhook && webhook.state === 'active') {
      const webhookToken = await this.options.secrets.get(webhook.secretRef);
      if (webhookToken) {
        const query = binding.threadId ? `?thread_id=${encodeURIComponent(binding.threadId)}` : '';
        await this.discordJsonRequest<{ id: string }>(
          'PATCH',
          `/webhooks/${encodeURIComponent(webhook.webhookId)}/${encodeURIComponent(webhookToken)}/messages/${encodeURIComponent(receipt.remoteMessageId)}${query}`,
          {
            body: {
              content: safeContent,
              ...(allowedMentions ? { allowed_mentions: allowedMentions } : {}),
            },
          },
        );
        this.lastVerifiedEffectAt = now;
        return { ...receipt, acceptedAt: now };
      }
    }

    const botToken = await this.requireBotToken();
    const targetChannelOrThread = binding.threadId ?? binding.channelId;
    await this.discordJsonRequest<{ id: string }>(
      'PATCH',
      `/channels/${encodeURIComponent(targetChannelOrThread)}/messages/${encodeURIComponent(receipt.remoteMessageId)}`,
      {
        botToken,
        body: {
          content: safeContent,
          ...(allowedMentions ? { allowed_mentions: allowedMentions } : {}),
        },
      },
    );
    this.lastVerifiedEffectAt = now;
    return { ...receipt, acceptedAt: now };
  }

  /**
   * Projects a validated `GatewayProjectEvent` into the outbox with strict provenance separation:
   * - Lead/Worker direct utterances (`category: 'agent-message'` with `runtime-observed` or `host-receipt`
   *   provenance AND valid real `AgentPortraitIdentity`) present as Lead/Worker.
   * - Tool-only events (`worker-activity`) NEVER fabricate first-person worker quotes; they project
   *   under `Extalia Gateway Bot` explicitly labeled `[Observed activity]` / `[Host-verified activity]` (GW-AT-026).
   */
  enqueueProjectEvent(input: {
    event: GatewayProjectEvent;
    targetBindingId: string;
    targetBindingRevision: number;
    portrait?: AgentPortraitIdentity;
    now: string;
  }): { intentId: string; senderKind: 'gateway-system' | 'lead' | 'worker'; deduplicated: boolean } {
    const validated = validateGatewayProjectEvent(input.event);
    if (!validated.ok) {
      throw new Error(`Invalid GatewayProjectEvent: ${validated.error}`);
    }
    const event = validated.value;
    const cleaned = sanitizeDiscordContent(event.safeText, DISCORD_MAX_MESSAGE_LENGTH - 120);

    const canPresentAsAgent =
      event.category === 'agent-message'
      && (event.provenance === 'runtime-observed' || event.provenance === 'host-receipt')
      && input.portrait !== undefined
      && input.portrait.workspaceId === event.workspaceId
      && input.portrait.sessionId === event.sessionId
      && (event.agentId === undefined || input.portrait.agentId === event.agentId);

    let senderKind: 'gateway-system' | 'lead' | 'worker' = 'gateway-system';
    let senderPortrait: AgentPortraitIdentity | undefined;
    let rawText = cleaned;
    let messageClass: 'accepted' | 'milestone' | 'heartbeat' | 'attention' | 'terminal' | 'system-report';

    if (canPresentAsAgent && input.portrait) {
      senderKind = input.portrait.kind;
      senderPortrait = input.portrait;
      messageClass = 'milestone';
    } else if (event.category === 'worker-activity' || event.category === 'agent-message') {
      // GW-AT-026: never fabricate first-person worker speech from tool-only or unattributed events.
      const label = event.provenance === 'host-receipt'
        ? '[Host-verified activity]'
        : event.provenance === 'runtime-observed'
          ? '[Observed activity]'
          : '[System projection · model-reported]';
      const actorMeta = input.portrait
        ? `${input.portrait.name} (${input.portrait.role})`
        : event.agentId
          ? `unidentified-worker:${event.agentId}`
          : 'session';
      const taskPart = event.taskId ? ` · task=${event.taskId}` : '';
      rawText = `${label} ${actorMeta}${taskPart} · verification=${event.verification}\n${cleaned}`;
      messageClass = 'milestone';
    } else if (event.category === 'approval') {
      const uiLink = this.options.host.settingsUiBaseUrl
        ? `\nReview in Extalia: ${this.options.host.settingsUiBaseUrl}/approvals/${encodeURIComponent(event.sourceEventId)}`
        : '';
      rawText = `[Approval required] ${cleaned}${uiLink}`;
      messageClass = 'attention';
    } else if (event.category === 'execution-health') {
      rawText = `[Execution health · ${event.verification}] ${cleaned}`;
      messageClass = 'heartbeat';
    } else if (event.category === 'terminal') {
      rawText = `[Run terminal · ${event.verification}] ${cleaned}`;
      messageClass = 'terminal';
    } else {
      rawText = `[Autonomous report] ${cleaned}`;
      messageClass = 'system-report';
    }

    const enqueued = this.options.outbox.enqueue({
      connectorId: this.options.connectorId,
      targetBindingId: input.targetBindingId,
      targetBindingRevision: input.targetBindingRevision,
      reportOrSourceEventId: event.sourceEventId,
      sourceEventId: event.sourceEventId,
      senderKind,
      senderPortrait,
      format: 'detailed',
      messageClass,
      rawText,
      maxMessageLength: DISCORD_MAX_MESSAGE_LENGTH,
      now: input.now,
    });

    return {
      intentId: enqueued.intent.id,
      senderKind,
      deduplicated: enqueued.deduplicated,
    };
  }

  /**
   * Claims and dispatches the next ready outbox intent for this Discord connector,
   * recording `gateway_remote_receipts` on success (`GW-AT-030`), obeying `429 Retry-After`,
   * quarantining timeouts as `unknown` (no blind resend), and pausing/blocking archived/deleted threads.
   */
  async dispatchNextOutboxIntent(input: {
    leaseOwner: string;
    runId?: string;
    taskId?: string;
    now: string;
  }): Promise<
    | { status: 'empty' }
    | { status: 'accepted'; intentId: string; receipt: RemoteMessageReceiptRecord }
    | { status: 'blocked' | 'rate-limited' | 'retryable' | 'unknown'; intentId: string; reason: string }
  > {
    const claimed = this.options.outbox.claimNextReady({
      leaseOwner: input.leaseOwner,
      connectorId: this.options.connectorId,
      now: input.now,
    });
    if (!claimed) return { status: 'empty' };

    const binding = resolveBindingRow(this.options.store, claimed.intent.targetBindingId);
    const route = binding ? this.options.routing.getRoute(binding.routeId) : undefined;
    const isAuthorized = Boolean(
      binding
      && binding.state === 'active'
      && route
      && route.state === 'active'
      && route.outboundEnabled
      && this.options.host.getRegisteredWorkspaceIds().has(binding.workspaceId),
    );

    const reval = this.options.outbox.revalidateBeforeSend({
      intentId: claimed.intent.id,
      isAuthorized,
      currentBindingRevision: route?.policyRevision,
      reason: !binding
        ? 'Target Discord binding no longer exists.'
        : binding.state !== 'active'
          ? `Discord destination is ${binding.state}; refusing unsafe send or silent fallback.`
          : 'Route outbound permission revoked or stale.',
      now: input.now,
    });

    if (!reval.ok) {
      return { status: 'blocked', intentId: claimed.intent.id, reason: reval.reason };
    }

    try {
      const sendReceipt = await this.send(claimed.approved);
      this.options.outbox.recordSendResult({
        kind: 'accepted',
        intentId: claimed.intent.id,
        fencingToken: claimed.approved.fencingToken,
        leaseOwner: input.leaseOwner,
        providerRequestKey: claimed.approved.providerRequestKey,
        remoteMessageId: sendReceipt.remoteMessageId,
        httpStatus: 200,
        now: input.now,
      });

      // Persist immutable sender snapshot + remoteMessageId for reply-to-worker routing (GW-AT-024, GW-AT-030).
      const storedReceipt = this.options.routing.recordRemoteReceipt({
        provider: 'discord',
        connectorId: this.options.connectorId,
        remoteMessageId: sendReceipt.remoteMessageId,
        providerAccountId: binding!.providerAccountId,
        channelId: binding!.channelId,
        threadId: binding!.threadId,
        workspaceId: binding!.workspaceId,
        sessionId: binding!.sessionId,
        runId: input.runId,
        agentId: claimed.intent.senderPortrait?.agentId,
        taskId: input.taskId,
        sourceEventId: claimed.intent.sourceEventId,
        senderSnapshot: claimed.intent.senderPortrait
          ? {
            senderKind: claimed.intent.senderKind,
            ...claimed.intent.senderPortrait,
          }
          : {
            senderKind: 'gateway-system',
            name: DISCORD_SYSTEM_BOT_NAME,
          },
        deliveryState: 'accepted',
        acceptedAt: sendReceipt.acceptedAt,
      });

      return { status: 'accepted', intentId: claimed.intent.id, receipt: storedReceipt };
    } catch (error) {
      const apiErr = error instanceof DiscordApiError
        ? error
        : new DiscordApiError('ambiguous-timeout', error instanceof Error ? error.message : String(error));
      this.lastNotificationError = apiErr.message;

      if (apiErr.classification === 'rate-limited') {
        this.options.outbox.recordSendResult({
          kind: 'rate-limited',
          intentId: claimed.intent.id,
          fencingToken: claimed.approved.fencingToken,
          leaseOwner: input.leaseOwner,
          providerRequestKey: claimed.approved.providerRequestKey,
          httpStatus: apiErr.details.httpStatus ?? 429,
          retryAfterSeconds: apiErr.details.retryAfterSeconds ?? 5,
          errorMessage: apiErr.message,
          now: input.now,
        });
        return { status: 'rate-limited', intentId: claimed.intent.id, reason: apiErr.message };
      }

      if (apiErr.classification === 'ambiguous-timeout') {
        this.options.outbox.recordSendResult({
          kind: 'ambiguous-timeout',
          intentId: claimed.intent.id,
          fencingToken: claimed.approved.fencingToken,
          leaseOwner: input.leaseOwner,
          providerRequestKey: claimed.approved.providerRequestKey,
          errorMessage: apiErr.message,
          now: input.now,
        });
        return { status: 'unknown', intentId: claimed.intent.id, reason: apiErr.message };
      }

      if (apiErr.classification === 'retryable') {
        this.options.outbox.recordSendResult({
          kind: 'retryable',
          intentId: claimed.intent.id,
          fencingToken: claimed.approved.fencingToken,
          leaseOwner: input.leaseOwner,
          providerRequestKey: claimed.approved.providerRequestKey,
          httpStatus: apiErr.details.httpStatus,
          errorMessage: apiErr.message,
          now: input.now,
        });
        return { status: 'retryable', intentId: claimed.intent.id, reason: apiErr.message };
      }

      // Archived thread or deleted destination: pause/mark lost without blind unarchive or fallback (GW-AT-021, GW-AT-022).
      if (apiErr.classification === 'archived-thread' && binding) {
        this.setBindingState(binding.id, 'paused', 'Discord thread is archived/locked; paused without auto-unarchive.', input.now);
      } else if (apiErr.classification === 'deleted-destination' && binding) {
        this.setBindingState(binding.id, 'destination-lost', 'Discord channel/thread was deleted.', input.now);
      }

      this.options.outbox.recordSendResult({
        kind: 'permanent-blocked',
        intentId: claimed.intent.id,
        fencingToken: claimed.approved.fencingToken,
        leaseOwner: input.leaseOwner,
        providerRequestKey: claimed.approved.providerRequestKey,
        httpStatus: apiErr.details.httpStatus ?? 403,
        errorMessage: apiErr.message,
        now: input.now,
      });
      return { status: 'blocked', intentId: claimed.intent.id, reason: apiErr.message };
    }
  }

  /**
   * Handles a Discord HTTP interaction within platform deadline:
   * - PING (`type: 1`) -> PONG (`type: 1`)
   * - `/extalia <subcommand>` (`type: 2`) -> returns immediate deferred ACK (`type: 5`)
   *   and provides `followupPromise` which executes the command and sends an interaction
   *   follow-up WITHOUT illegal webhook `username`/`avatar_url` overrides (GW-FR-026, GW-AT-031).
   */
  handleInteraction(
    interaction: DiscordInteractionPayload,
    now: string,
  ): {
    ack: DiscordInteractionAck;
    followupPromise?: Promise<{ commandResult: DiscordCommandExecutionResult; followupMessageId?: string }>;
  } {
    if (interaction.type === 1) {
      return { ack: { type: 1 } };
    }

    const subName = interaction.data?.options?.[0]?.name ?? 'help';
    const sensitiveSubcommand = ['connect', 'bind', 'unbind', 'pause', 'cancel', 'schedule'].includes(subName);
    const ack: DiscordInteractionAck = {
      type: 5, // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE — beats 3s Discord deadline
      ...(sensitiveSubcommand ? { data: { flags: 64 } } : {}),
    };

    const followupPromise = (async () => {
      const commandResult = await this.executeSlashCommand(interaction, now);
      const sent = await this.sendInteractionFollowup({
        applicationId: interaction.application_id,
        interactionToken: interaction.token,
        content: commandResult.content,
        ephemeral: commandResult.ephemeral,
      });
      return { commandResult, followupMessageId: sent.id };
    })();

    return { ack, followupPromise };
  }

  /**
   * Sends a Discord interaction follow-up message. Explicitly forbids `username` and `avatar_url`
   * overrides because Discord interaction followups do not support agent persona impersonation (GW-AT-031).
   */
  async sendInteractionFollowup(input: {
    applicationId: string;
    interactionToken: string;
    content: string;
    ephemeral?: boolean;
  }): Promise<{ id: string }> {
    const safeContent = sanitizeDiscordContent(input.content, DISCORD_MAX_MESSAGE_LENGTH);
    const body: Record<string, unknown> = {
      content: safeContent,
      allowed_mentions: { parse: [] },
      ...(input.ephemeral ? { flags: 64 } : {}),
    };
    // Defensively guarantee username / avatar_url are never present on interaction followups.
    delete body.username;
    delete body.avatar_url;

    return this.discordJsonRequest<{ id: string }>(
      'POST',
      `/webhooks/${encodeURIComponent(input.applicationId)}/${encodeURIComponent(input.interactionToken)}`,
      { body },
    );
  }

  /**
   * Executes `/extalia <subcommand>` with strict linked-principal, permission-band,
   * registered-workspace, and route-revision checks (GW-FR-025, GW-AT-017, GW-AT-018, GW-AT-034).
   */
  async executeSlashCommand(
    interaction: DiscordInteractionPayload,
    now: string,
  ): Promise<DiscordCommandExecutionResult> {
    const guildId = interaction.guild_id ?? 'dm';
    const isThread = Boolean(interaction.channel?.parent_id);
    const channelId = isThread ? String(interaction.channel?.parent_id) : (interaction.channel_id ?? interaction.channel?.id ?? '');
    const threadId = isThread ? (interaction.channel_id ?? interaction.channel?.id) : undefined;
    const actorUser = interaction.member?.user ?? interaction.user;
    const externalActorId = actorUser?.id ?? '';

    const topOption = interaction.data?.options?.[0];
    const subName = (topOption?.name ?? 'help') as DiscordSlashSubcommand;
    const subOpts = topOption?.options ?? [];

    // Reject webhook tokens/URLs pasted into any command option (GW-FR-024).
    for (const opt of subOpts) {
      if (typeof opt.value === 'string' && containsDiscordWebhookUrl(opt.value)) {
        this.options.store.recordAudit({
          actor: `external:${externalActorId}`,
          action: 'discord.webhook_url_in_chat.refused',
          resource: `channel:${channelId}`,
          outcome: 'denied',
          reason: 'Rejected Discord webhook URL pasted into chat/command.',
          at: now,
        });
        return {
          ok: false,
          subcommand: DISCORD_SLASH_SUBCOMMANDS.includes(subName) ? subName : 'unknown',
          ephemeral: true,
          code: 'WEBHOOK_SECRET_IN_CHAT_REFUSED',
          content: 'Refused: never paste Discord webhook URLs or tokens into channel chat. Configure webhooks through protected Extalia Settings.',
        };
      }
    }

    if (actorUser?.bot) {
      return {
        ok: false,
        subcommand: DISCORD_SLASH_SUBCOMMANDS.includes(subName) ? subName : 'unknown',
        ephemeral: true,
        code: 'BOT_ACTOR_REFUSED',
        content: 'Bot accounts cannot execute Extalia commands.',
      };
    }

    // Resolve active linked Extalia principal (never by display name or guild membership alone).
    const principal = this.options.routing.principalLinks.resolveActivePrincipal({
      connectorId: this.options.connectorId,
      providerAccountId: guildId,
      externalActorId,
      now,
    });

    if (subName === 'help') {
      const caps = await this.capabilities(this.options.connectorId);
      const portraitMode = caps.perAgentWebhookPortraits ? 'per-agent webhook portraits active' : 'bot-only fallback (Manage Webhooks missing)';
      return {
        ok: true,
        subcommand: 'help',
        ephemeral: true,
        content: [
          `**${DISCORD_SYSTEM_BOT_NAME} · Commands**`,
          'Available: `/extalia help|connect|bind|unbind|new|session|status|team|tasks|schedule|reports|pause|cancel`',
          `Capabilities: ${portraitMode}; minimal intents (no Message Content Intent required).`,
          'Note: Privileged actions require a linked Extalia account and explicit workspace route.',
        ].join('\n'),
      };
    }

    if (!principal) {
      this.options.store.recordAudit({
        actor: `external:${externalActorId}`,
        action: `discord.command.${subName}`,
        resource: `channel:${channelId}`,
        outcome: 'denied',
        reason: 'External actor is not linked to an Extalia principal.',
        at: now,
      });
      return {
        ok: false,
        subcommand: DISCORD_SLASH_SUBCOMMANDS.includes(subName) ? subName : 'unknown',
        ephemeral: true,
        code: 'UNLINKED_PRINCIPAL',
        content: 'Unauthorized: link your Discord account in Extalia Settings before running commands.',
      };
    }

    const requireBand = (band: GatewayPermissionBand): DiscordCommandExecutionResult | null => {
      if (!principal.permissionBands.includes(band)) {
        this.options.store.recordAudit({
          actor: principal.extaliaPrincipalId,
          action: `discord.command.${subName}`,
          resource: `channel:${channelId}`,
          outcome: 'denied',
          reason: `Principal lacks required permission band "${band}".`,
          at: now,
        });
        return {
          ok: false,
          subcommand: subName,
          ephemeral: true,
          code: 'INSUFFICIENT_PERMISSION',
          content: `Refused: your linked Extalia principal lacks the \`${band}\` permission.`,
        };
      }
      return null;
    };

    const workspaces = this.options.host.getRegisteredWorkspaceIds();

    switch (subName) {
      case 'connect': {
        const denied = requireBand('manage_gateway_route');
        if (denied) return denied;
        const health = await this.health();
        const settingsLink = this.options.host.settingsUiBaseUrl
          ? `${this.options.host.settingsUiBaseUrl}/settings/gateways/discord`
          : 'Extalia Desktop > Settings > Gateways > Discord';
        return {
          ok: true,
          subcommand: 'connect',
          ephemeral: true,
          content: [
            `**${DISCORD_SYSTEM_BOT_NAME} · Connection**`,
            `Connector: \`${this.options.connectorId}\` (state: \`${health.connectorState}\`)`,
            `Transport: \`${health.transport.status}\` | Notification: \`${health.notification.status}\``,
            `Manage credentials securely in: ${settingsLink} (never paste tokens into Discord chat).`,
          ].join('\n'),
        };
      }

      case 'bind': {
        const denied = requireBand('manage_gateway_route');
        if (denied) return denied;
        const workspaceId = extractOptionString(subOpts, 'workspace');
        const modeRaw = extractOptionString(subOpts, 'mode') ?? 'thread-new-session';
        const audienceRaw = extractOptionString(subOpts, 'audience') ?? 'team';
        const mode: GatewayRouteMode =
          modeRaw === 'explicit-only' || modeRaw === 'thread-new-session' || modeRaw === 'reuse-pinned'
            ? modeRaw
            : 'thread-new-session';
        const audience: GatewayAudience =
          audienceRaw === 'private' || audienceRaw === 'team' || audienceRaw === 'public'
            ? audienceRaw
            : 'team';

        if (!workspaceId || !workspaces.has(workspaceId)) {
          this.options.store.recordAudit({
            actor: principal.extaliaPrincipalId,
            action: 'discord.command.bind',
            resource: `channel:${channelId}`,
            outcome: 'denied',
            reason: `Workspace "${workspaceId ?? ''}" is missing or unregistered.`,
            at: now,
          });
          return {
            ok: false,
            subcommand: 'bind',
            ephemeral: true,
            code: 'UNREGISTERED_WORKSPACE',
            content: 'Refused: specify a registered Extalia workspace ID to bind this channel.',
          };
        }

        const route = this.options.routing.createRoute({
          connectorId: this.options.connectorId,
          providerAccountId: guildId,
          channelId,
          threadId,
          workspaceId,
          mode,
          audience,
          linkedPrincipalId: principal.extaliaPrincipalId,
          registeredWorkspaceIds: workspaces,
          now,
        });

        const presentationMode = this.channelFallbackMode.get(channelId) ?? (this.webhooksByChannel.has(channelId) ? 'webhook-portraits' : 'bot-only-fallback');
        return {
          ok: true,
          subcommand: 'bind',
          ephemeral: true,
          route,
          content: [
            `Bound channel \`${channelId}\`${threadId ? ` (thread \`${threadId}\`)` : ''} to workspace \`${route.workspaceId}\`.`,
            `Route ID: \`${route.id}\` | Revision: \`${route.policyRevision}\` | Mode: \`${route.mode}\` | Audience: \`${route.audience}\``,
            `Effective permissions: inbound=${route.inboundEnabled}, outbound=${route.outboundEnabled}, presentation=${presentationMode}.`,
          ].join('\n'),
        };
      }

      case 'unbind': {
        const denied = requireBand('manage_gateway_route');
        if (denied) return denied;
        const expectedRevision = extractOptionNumber(subOpts, 'revision');
        const resolved = this.options.routing.resolveRoute({
          connectorId: this.options.connectorId,
          providerAccountId: guildId,
          channelId,
          threadId,
          linkedPrincipalId: principal.extaliaPrincipalId,
          expectedRouteRevision: expectedRevision,
          registeredWorkspaceIds: workspaces,
        });
        if (!resolved.ok) {
          return {
            ok: false,
            subcommand: 'unbind',
            ephemeral: true,
            code: resolved.code,
            content: `Refused unbind: ${resolved.reason}`,
          };
        }
        const updated = this.options.routing.updateRoute({
          routeId: resolved.route.id,
          state: 'revoked',
          inboundEnabled: false,
          outboundEnabled: false,
          registeredWorkspaceIds: workspaces,
          actor: principal.extaliaPrincipalId,
          now,
        });
        // Cancel pending outbox intents on route bindings while preserving Extalia session history.
        const bindingRows = this.options.store.database
          .prepare("SELECT id FROM gateway_bindings WHERE route_id = ? AND state != 'revoked'")
          .all(updated.id) as Array<{ id: string }>;
        for (const b of bindingRows) {
          this.setBindingState(b.id, 'revoked', 'Route unbound by route manager.', now);
          this.options.outbox.cancelPendingForBinding({
            targetBindingId: b.id,
            reason: 'Route unbound.',
            actor: principal.extaliaPrincipalId,
            now,
          });
        }
        return {
          ok: true,
          subcommand: 'unbind',
          ephemeral: true,
          route: updated,
          content: `Route \`${updated.id}\` disabled (revision \`${updated.policyRevision}\`). Existing Extalia sessions and histories remain preserved.`,
        };
      }

      case 'new': {
        const denied = requireBand('submit_prompt');
        if (denied) return denied;
        const resolved = this.options.routing.resolveRoute({
          connectorId: this.options.connectorId,
          providerAccountId: guildId,
          channelId,
          threadId,
          linkedPrincipalId: principal.extaliaPrincipalId,
          registeredWorkspaceIds: workspaces,
        });
        if (!resolved.ok) {
          return { ok: false, subcommand: 'new', ephemeral: true, code: resolved.code, content: `Refused: ${resolved.reason}` };
        }
        const requestedWs = extractOptionString(subOpts, 'workspace');
        if (requestedWs && requestedWs !== resolved.route.workspaceId) {
          return {
            ok: false,
            subcommand: 'new',
            ephemeral: true,
            code: 'CROSS_WORKSPACE_REFUSED',
            content: `Refused: channel is bound to workspace \`${resolved.route.workspaceId}\`, not \`${requestedWs}\`.`,
          };
        }
        if (!this.options.host.createManagedSession) {
          return {
            ok: false,
            subcommand: 'new',
            ephemeral: true,
            code: 'CAPABILITY_UNAVAILABLE',
            content: 'Session creation capability is unavailable on this Host.',
          };
        }
        const created = await this.options.host.createManagedSession({
          workspaceId: resolved.route.workspaceId,
          principalId: principal.extaliaPrincipalId,
          channelId,
          threadId,
        });
        if (!created.ok) {
          return { ok: false, subcommand: 'new', ephemeral: true, code: 'SESSION_CREATE_FAILED', content: `Refused: ${created.reason}` };
        }
        const binding = this.options.routing.createBinding({
          routeId: resolved.route.id,
          routeRevision: resolved.route.policyRevision,
          channelId,
          threadId,
          sessionId: created.sessionId,
          registeredWorkspaceIds: workspaces,
          now,
        });
        return {
          ok: true,
          subcommand: 'new',
          ephemeral: false,
          route: resolved.route,
          binding,
          sessionId: created.sessionId,
          content: `Created managed session \`${created.sessionId}\` in workspace \`${resolved.route.workspaceId}\` (binding \`${binding.id}\`, rev ${binding.policyRevision}).`,
        };
      }

      case 'session': {
        const denied = requireBand('manage_own_session');
        if (denied) return denied;
        const resolved = this.options.routing.resolveRoute({
          connectorId: this.options.connectorId,
          providerAccountId: guildId,
          channelId,
          threadId,
          linkedPrincipalId: principal.extaliaPrincipalId,
          registeredWorkspaceIds: workspaces,
        });
        if (!resolved.ok) {
          return { ok: false, subcommand: 'session', ephemeral: true, code: resolved.code, content: `Refused: ${resolved.reason}` };
        }
        const requestedSessionId = extractOptionString(subOpts, 'id');
        if (!requestedSessionId) {
          const current = resolved.binding?.sessionId ?? 'none';
          return {
            ok: true,
            subcommand: 'session',
            ephemeral: true,
            route: resolved.route,
            binding: resolved.binding,
            sessionId: resolved.binding?.sessionId,
            content: `Workspace \`${resolved.route.workspaceId}\` · Current bound session: \`${current}\`.`,
          };
        }
        const sessions = (await this.options.host.listWorkspaceSessions?.({
          workspaceId: resolved.route.workspaceId,
          principalId: principal.extaliaPrincipalId,
        })) ?? [];
        const target = sessions.find(s => s.sessionId === requestedSessionId && s.workspaceId === resolved.route.workspaceId);
        if (!target) {
          return {
            ok: false,
            subcommand: 'session',
            ephemeral: true,
            code: 'CROSS_WORKSPACE_OR_MISSING_SESSION',
            content: `Refused: session \`${requestedSessionId}\` was not found in bound workspace \`${resolved.route.workspaceId}\`.`,
          };
        }
        // Retire prior binding if present and bind requested session in the same workspace.
        if (resolved.binding) {
          this.setBindingState(resolved.binding.id, 'revoked', 'Switched bound session explicitly.', now);
        }
        const binding = this.options.routing.createBinding({
          routeId: resolved.route.id,
          routeRevision: resolved.route.policyRevision,
          channelId,
          threadId,
          sessionId: target.sessionId,
          registeredWorkspaceIds: workspaces,
          now,
        });
        return {
          ok: true,
          subcommand: 'session',
          ephemeral: true,
          route: resolved.route,
          binding,
          sessionId: target.sessionId,
          content: `Bound conversation to session \`${target.sessionId}\` in workspace \`${resolved.route.workspaceId}\`.`,
        };
      }

      case 'status': {
        const denied = requireBand('read_status');
        if (denied) return denied;
        const resolved = this.resolveRouteAndBindingOrFail(guildId, channelId, threadId, principal, workspaces);
        if (!resolved.ok) return { ...resolved.error, subcommand: 'status' };
        const runId = extractOptionString(subOpts, 'run');
        const status = await this.options.host.getSessionStatus?.({
          workspaceId: resolved.route.workspaceId,
          sessionId: resolved.binding.sessionId!,
          runId,
        });
        if (!status) {
          return {
            ok: true,
            subcommand: 'status',
            ephemeral: true,
            content: `Session \`${resolved.binding.sessionId}\`: state=\`unknown\` (no verified runtime status source available).`,
          };
        }
        return {
          ok: true,
          subcommand: 'status',
          ephemeral: false,
          content: sanitizeDiscordContent([
            `**[${DISCORD_SYSTEM_BOT_NAME} · Status]**`,
            `Session: \`${resolved.binding.sessionId}\` | State: \`${status.state}\` | Lead: ${status.leadName ?? 'Lead'}`,
            `Active workers: ${status.activeWorkers} | Tasks: ${status.totalTasks} | Last activity: ${status.lastVerifiedActivityAt ?? 'unknown'}`,
            ...(status.summary ? [status.summary] : []),
          ].join('\n')),
        };
      }

      case 'team': {
        const denied = requireBand('read_status');
        if (denied) return denied;
        const resolved = this.resolveRouteAndBindingOrFail(guildId, channelId, threadId, principal, workspaces);
        if (!resolved.ok) return { ...resolved.error, subcommand: 'team' };
        const members = (await this.options.host.getSessionTeam?.({
          workspaceId: resolved.route.workspaceId,
          sessionId: resolved.binding.sessionId!,
        })) ?? [];
        // Strictly omit private `soul` and credentials regardless of Host payload (GW-FR-025 / §8.2).
        const lines = members.length > 0
          ? members.map(m => `- **${sanitizeDiscordAgentDisplayName(m.name, { role: m.role, kind: 'worker' }).displayName}** (${m.role}) · state=\`${m.state}\` · portrait=${m.portraitReady ? 'ready' : AVATAR_UNAVAILABLE_DIAGNOSTIC}`)
          : ['- No active workers in this session roster.'];
        return {
          ok: true,
          subcommand: 'team',
          ephemeral: false,
          content: sanitizeDiscordContent(`**[${DISCORD_SYSTEM_BOT_NAME} · Session Team]**\n${lines.join('\n')}`),
        };
      }

      case 'tasks': {
        const denied = requireBand('read_status');
        if (denied) return denied;
        const resolved = this.resolveRouteAndBindingOrFail(guildId, channelId, threadId, principal, workspaces);
        if (!resolved.ok) return { ...resolved.error, subcommand: 'tasks' };
        const tasks = (await this.options.host.getSessionTasks?.({
          workspaceId: resolved.route.workspaceId,
          sessionId: resolved.binding.sessionId!,
        })) ?? [];
        const lines = tasks.length > 0
          ? tasks.slice(0, 20).map(t => `- \`${t.id}\` [${t.status}] ${t.title}${t.ownerAgentId ? ` (owner: ${t.ownerAgentId})` : ''}`)
          : ['- No Host-recorded tasks for this session.'];
        return {
          ok: true,
          subcommand: 'tasks',
          ephemeral: false,
          content: sanitizeDiscordContent(`**[${DISCORD_SYSTEM_BOT_NAME} · Tasks]**\n${lines.join('\n')}`),
        };
      }

      case 'schedule': {
        const denied = requireBand('manage_schedule');
        if (denied) return denied;
        const resolved = this.options.routing.resolveRoute({
          connectorId: this.options.connectorId,
          providerAccountId: guildId,
          channelId,
          threadId,
          linkedPrincipalId: principal.extaliaPrincipalId,
          registeredWorkspaceIds: workspaces,
        });
        if (!resolved.ok) {
          return { ok: false, subcommand: 'schedule', ephemeral: true, code: resolved.code, content: `Refused: ${resolved.reason}` };
        }
        const schedules = (await this.options.host.listSchedules?.({
          workspaceId: resolved.route.workspaceId,
          principalId: principal.extaliaPrincipalId,
        })) ?? [];
        const lines = schedules.length > 0
          ? schedules.slice(0, 15).map(s => `- \`${s.id}\` ${s.name} · enabled=${s.enabled} · next=${s.nextRunAt ?? 'unscheduled'}`)
          : ['- No schedules configured for this workspace.'];
        return {
          ok: true,
          subcommand: 'schedule',
          ephemeral: true,
          content: sanitizeDiscordContent(`**[${DISCORD_SYSTEM_BOT_NAME} · Schedules (preview)]**\n${lines.join('\n')}`),
        };
      }

      case 'reports': {
        const denied = requireBand('view_reports');
        if (denied) return denied;
        const resolved = this.options.routing.resolveRoute({
          connectorId: this.options.connectorId,
          providerAccountId: guildId,
          channelId,
          threadId,
          linkedPrincipalId: principal.extaliaPrincipalId,
          registeredWorkspaceIds: workspaces,
        });
        if (!resolved.ok) {
          return { ok: false, subcommand: 'reports', ephemeral: true, code: resolved.code, content: `Refused: ${resolved.reason}` };
        }
        const allReports: WorkspaceSystemReport[] = this.options.reports
          ? this.options.reports.listWorkspaceReports(resolved.route.workspaceId)
          : [];
        // Audience-scoped filter: never leak private reports to public/team channels.
        const visible = resolved.route.audience === 'public'
          ? allReports.filter(r => r.audienceScopeId === 'public')
          : allReports;
        const lines = visible.length > 0
          ? visible.slice(-5).map(r => `- \`${r.id}\` rev ${r.revision} · ${r.source} · outcome=\`${r.outcome}\` · ${r.lastUpdatedAt}`)
          : ['- No autonomous reports available for this workspace audience.'];
        return {
          ok: true,
          subcommand: 'reports',
          ephemeral: false,
          content: sanitizeDiscordContent(`**[${DISCORD_SYSTEM_BOT_NAME} · Workspace Reports]**\n${lines.join('\n')}`),
        };
      }

      case 'pause': {
        const denied = requireBand('manage_own_session');
        if (denied) return denied;
        const resolved = this.resolveRouteAndBindingOrFail(guildId, channelId, threadId, principal, workspaces);
        if (!resolved.ok) return { ...resolved.error, subcommand: 'pause' };
        this.setBindingState(resolved.binding.id, 'paused', 'Inbound submissions paused via /extalia pause.', now);
        return {
          ok: true,
          subcommand: 'pause',
          ephemeral: true,
          binding: { ...resolved.binding, state: 'paused' },
          content: `Paused new inbound submissions for binding \`${resolved.binding.id}\`. Any currently running Extalia job continues unaffected.`,
        };
      }

      case 'cancel': {
        const denied = requireBand('manage_own_session');
        if (denied) return denied;
        const resolved = this.resolveRouteAndBindingOrFail(guildId, channelId, threadId, principal, workspaces);
        if (!resolved.ok) return { ...resolved.error, subcommand: 'cancel' };
        if (!this.options.host.requestCancelTurn) {
          return {
            ok: false,
            subcommand: 'cancel',
            ephemeral: true,
            code: 'NOT_SUPPORTED',
            content: 'Cancel result: `not_supported` — this runtime does not advertise safe remote cancellation.',
          };
        }
        const res = await this.options.host.requestCancelTurn({
          workspaceId: resolved.route.workspaceId,
          sessionId: resolved.binding.sessionId!,
          principalId: principal.extaliaPrincipalId,
        });
        return {
          ok: res.status === 'request_sent' || res.status === 'cancelled',
          subcommand: 'cancel',
          ephemeral: true,
          content: sanitizeDiscordContent(
            `Cancel result for session \`${resolved.binding.sessionId}\`: \`${res.status}\`${res.detail ? ` — ${res.detail}` : ''}.`,
          ),
        };
      }

      default:
        return {
          ok: false,
          subcommand: 'unknown',
          ephemeral: true,
          code: 'UNKNOWN_SUBCOMMAND',
          content: 'Unknown `/extalia` subcommand. Run `/extalia help` for available commands.',
        };
    }
  }

  private resolveRouteAndBindingOrFail(
    guildId: string,
    channelId: string,
    threadId: string | undefined,
    principal: PrincipalLinkRecord,
    workspaces: ReadonlySet<string>,
  ):
    | { ok: true; route: GatewayRouteRecord; binding: GatewayRouteBinding }
    | { ok: false; error: Omit<DiscordCommandExecutionResult, 'subcommand'> } {
    const resolved = this.options.routing.resolveRoute({
      connectorId: this.options.connectorId,
      providerAccountId: guildId,
      channelId,
      threadId,
      linkedPrincipalId: principal.extaliaPrincipalId,
      registeredWorkspaceIds: workspaces,
    });
    if (!resolved.ok) {
      return {
        ok: false,
        error: { ok: false, ephemeral: true, code: resolved.code, content: `Refused: ${resolved.reason}` },
      };
    }
    if (!resolved.binding || !resolved.binding.sessionId) {
      return {
        ok: false,
        error: {
          ok: false,
          ephemeral: true,
          code: 'SESSION_REQUIRED',
          content: 'No bound session in this channel/thread. Run `/extalia new` or `/extalia session <id>` first.',
        },
      };
    }
    return { ok: true, route: resolved.route, binding: resolved.binding };
  }

  /**
   * Handles new Discord thread or forum post creation under a bound parent route (GW-AT-019, GW-FR-028).
   * Respects parent policy: `explicit-only`, `thread-new-session`, or `reuse-pinned`.
   */
  async handleThreadCreated(event: DiscordThreadEvent): Promise<
    | { ok: true; action: 'bound-new-session' | 'bound-pinned-session' | 'awaiting-explicit'; route: GatewayRouteRecord; binding?: GatewayRouteBinding }
    | { ok: false; code: string; reason: string }
  > {
    const workspaces = this.options.host.getRegisteredWorkspaceIds();
    const resolved = this.options.routing.resolveRoute({
      connectorId: this.options.connectorId,
      providerAccountId: event.guildId,
      channelId: event.parentChannelId,
      threadId: event.threadId,
      registeredWorkspaceIds: workspaces,
    });
    if (!resolved.ok) {
      return { ok: false, code: resolved.code, reason: resolved.reason };
    }

    if (resolved.binding) {
      return { ok: true, action: 'bound-pinned-session', route: resolved.route, binding: resolved.binding };
    }

    if (resolved.route.mode === 'explicit-only') {
      this.options.store.recordAudit({
        actor: 'discord:lifecycle',
        action: 'discord.thread.created_explicit_only',
        resource: `thread:${event.threadId}`,
        outcome: 'awaiting-explicit',
        metadata: { routeId: resolved.route.id, workspaceId: resolved.route.workspaceId },
        at: event.now,
      });
      return { ok: true, action: 'awaiting-explicit', route: resolved.route };
    }

    const ownerPrincipal = event.ownerExternalActorId
      ? this.options.routing.principalLinks.resolveActivePrincipal({
        connectorId: this.options.connectorId,
        providerAccountId: event.guildId,
        externalActorId: event.ownerExternalActorId,
        now: event.now,
      })
      : undefined;

    if (!ownerPrincipal || !ownerPrincipal.permissionBands.includes('submit_prompt')) {
      this.options.store.recordAudit({
        actor: `external:${event.ownerExternalActorId ?? 'unknown'}`,
        action: 'discord.thread.auto_bind_refused',
        resource: `thread:${event.threadId}`,
        outcome: 'denied',
        reason: 'Thread creator is not a linked principal with submit_prompt permission.',
        at: event.now,
      });
      return {
        ok: false,
        code: 'UNAUTHORIZED_THREAD_OWNER',
        reason: 'Thread creator lacks linked principal authorization to bind a session.',
      };
    }

    if (resolved.route.mode === 'reuse-pinned') {
      const pinnedSessionId = this.options.host.getPinnedParentSessionId?.({
        routeId: resolved.route.id,
        workspaceId: resolved.route.workspaceId,
      });
      if (!pinnedSessionId) {
        return { ok: true, action: 'awaiting-explicit', route: resolved.route };
      }
      const binding = this.options.routing.createBinding({
        routeId: resolved.route.id,
        routeRevision: resolved.route.policyRevision,
        channelId: event.parentChannelId,
        threadId: event.threadId,
        sessionId: pinnedSessionId,
        registeredWorkspaceIds: workspaces,
        now: event.now,
      });
      return { ok: true, action: 'bound-pinned-session', route: resolved.route, binding };
    }

    // `thread-new-session`: create a dedicated managed session strictly in the parent route's workspace.
    if (!this.options.host.createManagedSession) {
      return { ok: false, code: 'CAPABILITY_UNAVAILABLE', reason: 'Managed session creation is unavailable.' };
    }
    const created = await this.options.host.createManagedSession({
      workspaceId: resolved.route.workspaceId,
      principalId: ownerPrincipal.extaliaPrincipalId,
      channelId: event.parentChannelId,
      threadId: event.threadId,
    });
    if (!created.ok) {
      return { ok: false, code: 'SESSION_CREATE_FAILED', reason: created.reason };
    }
    const binding = this.options.routing.createBinding({
      routeId: resolved.route.id,
      routeRevision: resolved.route.policyRevision,
      channelId: event.parentChannelId,
      threadId: event.threadId,
      sessionId: created.sessionId,
      registeredWorkspaceIds: workspaces,
      now: event.now,
    });
    return { ok: true, action: 'bound-new-session', route: resolved.route, binding };
  }

  /**
   * Handles Discord `THREAD_UPDATE`:
   * - Rename (same `threadId`) preserves existing session binding untouched (GW-AT-020).
   * - Archive or lock pauses outbound/inbound without blind unarchive or fallback (GW-AT-021).
   */
  handleThreadUpdated(event: DiscordThreadEvent): {
    status: 'unchanged-rename' | 'paused-archived-or-locked' | 'no-binding';
    bindingId?: string;
    sessionId?: string;
  } {
    const row = this.options.store.database.prepare(
      `SELECT id, session_id, state FROM gateway_bindings
       WHERE connector_id = ? AND provider_account_id = ? AND channel_id = ? AND thread_key = ?
         AND state IN ('active', 'paused')`,
    ).get(
      this.options.connectorId,
      event.guildId,
      event.parentChannelId,
      normalizeThreadKey(event.threadId),
    ) as { id: string; session_id: string; state: string } | undefined;

    if (!row) return { status: 'no-binding' };

    if (event.archived || event.locked) {
      this.setBindingState(
        row.id,
        'paused',
        `Discord thread ${event.archived ? 'archived' : 'locked'}; outbound paused without auto-unarchive.`,
        event.now,
      );
      return {
        status: 'paused-archived-or-locked',
        bindingId: row.id,
        sessionId: row.session_id,
      };
    }

    // ID-stable rename resilience: remote threadId unchanged -> binding/session stays intact.
    this.options.store.recordAudit({
      actor: 'discord:lifecycle',
      action: 'discord.thread.renamed_preserved',
      resource: `binding:${row.id}`,
      outcome: 'preserved',
      metadata: { threadId: event.threadId, sessionId: row.session_id },
      at: event.now,
    });
    return {
      status: 'unchanged-rename',
      bindingId: row.id,
      sessionId: row.session_id,
    };
  }

  /**
   * Handles Discord `THREAD_DELETE`: marks binding `destination-lost`, cancels pending
   * unsubmitted outbox intents, and leaves the Extalia session intact/running (GW-AT-022).
   */
  handleThreadDeleted(event: DiscordThreadEvent): {
    status: 'destination-lost' | 'no-binding';
    bindingId?: string;
    sessionId?: string;
    cancelledOutboxCount: number;
    sessionPreserved: true;
  } {
    const row = this.options.store.database.prepare(
      `SELECT id, session_id FROM gateway_bindings
       WHERE connector_id = ? AND provider_account_id = ? AND channel_id = ? AND thread_key = ?
         AND state != 'revoked'`,
    ).get(
      this.options.connectorId,
      event.guildId,
      event.parentChannelId,
      normalizeThreadKey(event.threadId),
    ) as { id: string; session_id: string } | undefined;

    if (!row) {
      return { status: 'no-binding', cancelledOutboxCount: 0, sessionPreserved: true };
    }

    this.setBindingState(row.id, 'destination-lost', 'Discord thread deleted; Extalia session preserved.', event.now);
    const cancelled = this.options.outbox.cancelPendingForBinding({
      targetBindingId: row.id,
      reason: 'Discord thread deleted (destination-lost).',
      actor: 'discord:lifecycle',
      now: event.now,
    });

    return {
      status: 'destination-lost',
      bindingId: row.id,
      sessionId: row.session_id,
      cancelledOutboxCount: cancelled,
      sessionPreserved: true,
    };
  }

  /**
   * Handles Discord `GUILD_DELETE` (bot removed/left server): disables ALL routes, bindings,
   * and webhooks belonging to that guild with zero leak or fallback to any other guild (GW-AT-033).
   */
  handleGuildRemoved(input: { guildId: string; now: string }): {
    disabledRoutes: number;
    disabledBindings: number;
    cancelledOutboxIntents: number;
    disabledWebhooks: number;
  } {
    return this.options.store.transaction(() => {
      const routeRows = this.options.store.database.prepare(
        `SELECT id FROM gateway_routes
         WHERE connector_id = ? AND provider_account_id = ? AND state != 'revoked'`,
      ).all(this.options.connectorId, input.guildId) as Array<{ id: string }>;

      for (const r of routeRows) {
        this.options.store.database.prepare(
          `UPDATE gateway_routes
           SET state = 'revoked', inbound_enabled = 0, outbound_enabled = 0,
               policy_revision = policy_revision + 1, updated_at = ?
           WHERE id = ?`,
        ).run(input.now, r.id);
      }

      const bindingRows = this.options.store.database.prepare(
        `SELECT id FROM gateway_bindings
         WHERE connector_id = ? AND provider_account_id = ? AND state != 'revoked'`,
      ).all(this.options.connectorId, input.guildId) as Array<{ id: string }>;

      let cancelledOutbox = 0;
      for (const b of bindingRows) {
        this.options.store.database.prepare(
          `UPDATE gateway_bindings SET state = 'destination-lost', updated_at = ? WHERE id = ?`,
        ).run(input.now, b.id);
        const res = this.options.store.database.prepare(
          `UPDATE gateway_outbox
           SET state = 'blocked', last_provider_error = 'Guild removed; route disabled.', updated_at = ?
           WHERE target_binding_id = ? AND state = 'pending'`,
        ).run(input.now, b.id);
        cancelledOutbox += Number(res.changes);
      }

      let disabledWebhooks = 0;
      for (const [channelId, wh] of this.webhooksByChannel.entries()) {
        if (wh.guildId === input.guildId) {
          wh.state = 'revoked';
          this.webhooksByChannel.delete(channelId);
          disabledWebhooks += 1;
        }
      }

      this.options.store.recordAudit({
        actor: 'discord:lifecycle',
        action: 'discord.guild.removed',
        resource: `guild:${input.guildId}`,
        outcome: 'disabled',
        metadata: {
          disabledRoutes: routeRows.length,
          disabledBindings: bindingRows.length,
          cancelledOutboxIntents: cancelledOutbox,
          disabledWebhooks,
        },
        at: input.now,
      });

      return {
        disabledRoutes: routeRows.length,
        disabledBindings: bindingRows.length,
        cancelledOutboxIntents: cancelledOutbox,
        disabledWebhooks,
      };
    });
  }

  /**
   * Handles an inbound Discord reply to an agent/webhook message (GW-AT-027, GW-AT-028):
   * resolves ONLY via `GatewayRoutingService.resolveReplyTarget` (stored `gateway_remote_receipts`),
   * never by matching display name, refuses missing/lost receipts, and delegates through Lead.
   */
  async handleInboundReply(input: {
    event: GatewayInboundEvent;
    verifyTransportReceipt: (event: GatewayInboundEvent) => boolean;
    now: string;
  }): Promise<
    | {
      ok: true;
      status: 'admitted' | 'duplicate' | 'ignored-echo';
      delegateViaLead: true;
      actionId?: string;
      sessionId?: string;
      targetAgentId?: string;
      targetTaskId?: string;
      sourceEventId?: string;
      workerActive?: boolean;
      hostActionId?: string;
      notice?: string;
    }
    | { ok: false; code: string; reason: string }
  > {
    if (containsDiscordWebhookUrl(input.event.text)) {
      this.options.store.recordAudit({
        actor: `external:${input.event.externalActorId}`,
        action: 'discord.webhook_url_in_chat.refused',
        resource: `channel:${input.event.channelId}`,
        outcome: 'denied',
        reason: 'Refused message containing raw Discord webhook URL.',
        at: input.now,
      });
      return {
        ok: false,
        code: 'WEBHOOK_SECRET_IN_CHAT_REFUSED',
        reason: 'Refused: never paste Discord webhook URLs or tokens into channel chat.',
      };
    }

    const admitted = this.options.routing.admitInboundEvent({
      rawEvent: input.event,
      verifyTransportReceipt: input.verifyTransportReceipt,
      registeredWorkspaceIds: this.options.host.getRegisteredWorkspaceIds(),
      requiredPermission: 'submit_prompt',
      requestedAction: input.event.replyToRemoteMessageId ? 'reply-via-lead' : 'prompt',
      now: input.now,
    });

    if (!admitted.ok) {
      return { ok: false, code: admitted.code, reason: admitted.reason };
    }

    if (admitted.status === 'duplicate' || admitted.status === 'ignored-echo') {
      return {
        ok: true,
        status: admitted.status,
        delegateViaLead: true,
        actionId: admitted.actionId,
      };
    }

    const receipt = admitted.replyTarget;
    const sessionId = receipt?.sessionId ?? admitted.binding?.sessionId ?? '';
    const targetAgentId = receipt?.agentId;
    const workerActive = targetAgentId && this.options.host.isWorkerActiveInSession
      ? this.options.host.isWorkerActiveInSession({ sessionId, agentId: targetAgentId })
      : true;

    let hostActionId: string | undefined;
    let notice: string | undefined;

    if (targetAgentId && !workerActive) {
      notice = `Worker "${targetAgentId}" is no longer active; routed context to Lead for explicit action without silently respawning.`;
    }

    if (this.options.host.submitLeadTurn && admitted.route && admitted.principal && admitted.actionId) {
      const submitted = await this.options.host.submitLeadTurn({
        workspaceId: admitted.route.workspaceId,
        sessionId,
        principalId: admitted.principal.extaliaPrincipalId,
        actionId: admitted.actionId,
        text: sanitizeDiscordContent(input.event.text ?? '', DISCORD_MAX_MESSAGE_LENGTH),
        ...(receipt
          ? {
            replyContext: {
              delegateViaLead: true,
              originalRemoteMessageId: receipt.remoteMessageId,
              targetAgentId: receipt.agentId,
              targetTaskId: receipt.taskId,
              sourceEventId: receipt.sourceEventId,
              workerActive,
            },
          }
          : {}),
      });
      if (!submitted.ok) {
        return { ok: false, code: 'HOST_DISPATCH_REFUSED', reason: submitted.reason };
      }
      hostActionId = submitted.hostActionId;
    }

    return {
      ok: true,
      status: 'admitted',
      delegateViaLead: true,
      actionId: admitted.actionId,
      sessionId,
      targetAgentId: receipt?.agentId,
      targetTaskId: receipt?.taskId,
      sourceEventId: receipt?.sourceEventId,
      workerActive,
      hostActionId,
      ...(notice ? { notice } : {}),
    };
  }

  /** Publishes or edits a coalesced live run card via the Bot identity (never impersonating workers). */
  async publishCoalescedLiveRunCard(
    update: DiscordCoalescedCardUpdate,
    now: string,
  ): Promise<RemoteSendReceipt> {
    const binding = resolveBindingRow(this.options.store, update.bindingId);
    if (!binding || binding.state !== 'active') {
      throw new DiscordApiError(
        binding?.state === 'paused' ? 'archived-thread' : 'deleted-destination',
        `Cannot publish live run card on non-active binding "${update.bindingId}".`,
      );
    }

    const approved: ApprovedOutbound = {
      intent: {
        id: `live_${update.bindingId}_${update.runId}`,
        connectorId: this.options.connectorId,
        targetBindingId: binding.id,
        targetBindingRevision: binding.policyRevision,
        senderKind: 'gateway-system',
        format: 'detailed',
        messageClass: update.state === 'completed' || update.state === 'failed' || update.state === 'cancelled'
          ? 'terminal'
          : 'heartbeat',
        payloadDigest: createHash('sha256').update(update.text).digest('hex'),
        policyEvaluationId: `live_pol_${update.latestSequence}`,
        state: 'sending',
      },
      safeText: update.text,
      disableMentions: true,
      fencingToken: `live_fnc_${update.latestSequence}`,
      providerRequestKey: `live_req_${update.bindingId}_${update.runId}_${update.latestSequence}`,
    };

    if (update.isEdit && update.remoteMessageId) {
      return this.edit(
        {
          connectorId: this.options.connectorId,
          provider: 'discord',
          remoteMessageId: update.remoteMessageId,
          acceptedAt: now,
          state: 'accepted',
        },
        approved,
      );
    }

    const sent = await this.send(approved);
    this.coalescer.bindCardMessageId(update.bindingId, update.runId, sent.remoteMessageId);
    return sent;
  }

  async health(): Promise<ConnectorHealth> {
    const now = this.clock();
    const connector = this.options.store.getConnector(this.options.connectorId);
    const connectorState: GatewayConnectorState = connector?.status ?? 'disabled';

    const transport: ConnectorHealthDimension = connectorState === 'connected'
      ? { status: 'healthy', observedAt: this.lastTransportHeartbeatAt ?? now }
      : connectorState === 'degraded'
        ? { status: 'degraded', observedAt: this.lastTransportHeartbeatAt ?? now }
        : { status: 'disconnected', observedAt: now, detail: `Connector state is ${connectorState}.` };

    const notification: ConnectorHealthDimension = this.lastNotificationError
      ? { status: 'degraded', observedAt: now, detail: sanitizeDiscordContent(this.lastNotificationError, 240) }
      : { status: connectorState === 'connected' ? 'healthy' : 'unknown', observedAt: this.lastVerifiedEffectAt ?? now };

    return aggregateConnectorHealth({
      connectorId: this.options.connectorId,
      provider: 'discord',
      connectorState,
      transport,
      host: { status: 'healthy', observedAt: now },
      runtime: { status: 'unknown', observedAt: now, detail: 'Runtime liveness is tracked per active session.' },
      progress: { status: 'unknown', observedAt: now },
      notification,
      lastTransportHeartbeatAt: this.lastTransportHeartbeatAt,
      lastHostHeartbeatAt: now,
      lastVerifiedEffectAt: this.lastVerifiedEffectAt,
      checkedAt: now,
    });
  }

  private setBindingState(bindingId: string, state: GatewayBindingState, reason: string, now: string): void {
    this.options.store.database
      .prepare('UPDATE gateway_bindings SET state = ?, updated_at = ? WHERE id = ?')
      .run(state, now, bindingId);
    this.options.store.recordAudit({
      actor: 'discord:adapter',
      action: `discord.binding.${state}`,
      resource: `binding:${bindingId}`,
      outcome: state,
      reason,
      at: now,
    });
  }

  private async requireBotToken(): Promise<string> {
    const token = await this.options.secrets.get(this.options.botTokenSecretRef);
    if (!token) {
      throw new DiscordApiError(
        'permanent-blocked',
        'Discord bot token is unavailable in the secret store.',
      );
    }
    return token;
  }

  private async discordJsonRequest<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    endpointPath: string,
    opts: { botToken?: string; body?: Record<string, unknown> },
  ): Promise<T> {
    const url = `${this.apiBaseUrl}${endpointPath}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'ExtaliaGateway/2.0',
    };
    if (opts.botToken) {
      headers.Authorization = `Bot ${opts.botToken}`;
    }
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await this.options.fetchImpl(url, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new DiscordApiError(
        'ambiguous-timeout',
        `Discord network/timeout failure during ${method} ${endpointPath.split('?')[0]}: ${msg}`,
      );
    }

    const rawText = await response.text();
    let parsed: Record<string, unknown> | undefined;
    if (rawText) {
      try {
        parsed = JSON.parse(rawText) as Record<string, unknown>;
      } catch {
        parsed = undefined;
      }
    }

    if (response.ok) {
      return (parsed ?? {}) as T;
    }

    const discordCode = typeof parsed?.code === 'number' ? parsed.code : undefined;
    const providerMsg = typeof parsed?.message === 'string' ? parsed.message : `HTTP ${response.status}`;

    if (response.status === 429) {
      const headerRetry = Number(response.headers.get('retry-after') ?? '');
      const bodyRetry = typeof parsed?.retry_after === 'number' ? parsed.retry_after : NaN;
      const retryAfterSeconds = Number.isFinite(bodyRetry) && bodyRetry > 0
        ? Math.ceil(bodyRetry)
        : Number.isFinite(headerRetry) && headerRetry > 0
          ? Math.ceil(headerRetry)
          : 5;
      throw new DiscordApiError('rate-limited', `Discord 429 rate limited: ${providerMsg}`, {
        httpStatus: 429,
        discordErrorCode: discordCode,
        retryAfterSeconds,
      });
    }

    // Discord code 50083: Thread is archived.
    if (discordCode === 50083) {
      throw new DiscordApiError('archived-thread', `Discord thread archived: ${providerMsg}`, {
        httpStatus: response.status,
        discordErrorCode: discordCode,
      });
    }

    // Discord 404 or Unknown Channel (10003) / Unknown Webhook (10015).
    if (response.status === 404 || discordCode === 10003 || discordCode === 10015) {
      throw new DiscordApiError('deleted-destination', `Discord destination missing: ${providerMsg}`, {
        httpStatus: response.status,
        discordErrorCode: discordCode,
      });
    }

    // Permanent permission / access failures (401/403/50001/50013).
    if (response.status === 401 || response.status === 403 || discordCode === 50001 || discordCode === 50013) {
      throw new DiscordApiError('permanent-blocked', `Discord permission error: ${providerMsg}`, {
        httpStatus: response.status,
        discordErrorCode: discordCode,
      });
    }

    if (response.status >= 500) {
      throw new DiscordApiError('retryable', `Discord server error (${response.status}): ${providerMsg}`, {
        httpStatus: response.status,
        discordErrorCode: discordCode,
      });
    }

    throw new DiscordApiError('permanent-blocked', `Discord rejected request (${response.status}): ${providerMsg}`, {
      httpStatus: response.status,
      discordErrorCode: discordCode,
    });
  }
}
