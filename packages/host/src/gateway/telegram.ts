/**
 * Official Telegram Bot API Connector (Universal Gateway v2 M2, Issue #139: GW-WP-11..12).
 *
 * Implements PRD §9, §12, §15, §18.3, and §20.3 (GW-AT-036..055):
 * - Verified `getMe` bot identity with opaque `secretRef` (never raw token persistence).
 * - Mutually exclusive transport per connector (`webhook` with timingSafeEqual secret header
 *   validation & payload bounds OR single-leader `getUpdates` polling advancing offset only
 *   after durable inbox admission).
 * - Private DM vs topic-enabled DM vs forum supergroup `(chat_id, message_thread_id)` isolation,
 *   group privacy mode ON, anonymous-admin & forwarded-sender refusal, reply-by-receipt routing.
 * - Full 18-command inventory, server-side single-use opaque callback nonces, honest `/cancel`,
 *   immutable post-admission edits/deletes.
 * - P0 text-first media guard, quiet/balanced/detailed milestone & heartbeat renderer,
 *   edit-in-place status cards with safe fallback, safe plain-text fallback, 429 retry_after,
 *   and 403 permanent disable without destination fallback.
 */
import {
  sanitizeGatewayText,
  validateGatewayCapabilities,
  type ApprovedOutbound,
  type ConnectorHealth,
  type ConnectorHealthDimension,
  type GatewayAdapter,
  type GatewayCapabilities,
  type GatewayConnectorState,
  type GatewayInboundEvent,
  type GatewayPermissionBand,
  type RawVerifiedTransport,
  type RemoteSendReceipt,
  type VerifiedProviderBatch,
  type WorkspaceSystemReport,
} from '@extalia/platform';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { GatewayOutboxService } from './outbox.js';
import { aggregateConnectorHealth } from './outbox.js';
import type { GatewayRoutingService, PrincipalLinkRecord, RemoteMessageReceiptRecord } from './routing.js';
import { assertOpaqueSecretRef, normalizeThreadKey, type GatewayStore } from './store.js';

export type TelegramTransportMode = 'webhook' | 'polling';

export type TelegramNotificationProfile = 'quiet' | 'balanced' | 'detailed';

export type TelegramCancelStatus =
  | 'request_sent'
  | 'cancelled'
  | 'not_supported'
  | 'already_finished'
  | 'unknown';

export const TELEGRAM_COMMANDS = [
  'start',
  'link',
  'help',
  'projects',
  'bind',
  'unbind',
  'new',
  'sessions',
  'use',
  'status',
  'team',
  'tasks',
  'details',
  'schedule',
  'reports',
  'pause',
  'cancel',
  'settings',
] as const;

export type TelegramCommandName = (typeof TELEGRAM_COMMANDS)[number];

const TELEGRAM_COMMAND_SET = new Set<string>(TELEGRAM_COMMANDS);

export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
export const TELEGRAM_DEFAULT_MAX_WEBHOOK_BYTES = 256 * 1024;
export const TELEGRAM_DEFAULT_MEDIA_MAX_BYTES = 5 * 1024 * 1024;
export const TELEGRAM_ANONYMOUS_ADMIN_BOT_ID = 1087968824;

export type TelegramFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text?(): Promise<string>;
}>;

export interface TelegramBotIdentity {
  botId: string;
  username: string;
  firstName?: string;
  canJoinGroups?: boolean;
  canReadAllGroupMessages?: boolean;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  is_forum?: boolean;
}

export interface TelegramDocumentLike {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  message_thread_id?: number;
  is_topic_message?: boolean;
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntity[];
  reply_to_message?: TelegramMessage;
  forward_origin?: Record<string, unknown>;
  forward_from?: TelegramUser;
  forward_from_chat?: TelegramChat;
  document?: TelegramDocumentLike;
  photo?: Array<{ file_id: string; file_size?: number }>;
  audio?: TelegramDocumentLike;
  voice?: TelegramDocumentLike;
  video?: TelegramDocumentLike;
  video_note?: TelegramDocumentLike;
  sticker?: TelegramDocumentLike;
  animation?: TelegramDocumentLike;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramChatMemberUpdated {
  chat: TelegramChat;
  from: TelegramUser;
  date: number;
  new_chat_member: {
    user: TelegramUser;
    status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';
  };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  my_chat_member?: TelegramChatMemberUpdated;
}

export type TelegramApiErrorClassification =
  | 'rate-limited'
  | 'permanent-blocked'
  | 'retryable'
  | 'ambiguous-timeout'
  | 'edit-failed'
  | 'invalid-response';

export class TelegramApiError extends Error {
  constructor(
    public readonly classification: TelegramApiErrorClassification,
    message: string,
    public readonly httpStatus?: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

export class TelegramTransportError extends Error {
  constructor(
    public readonly code:
      | 'TRANSPORT_CONFLICT'
      | 'BAD_WEBHOOK_SECRET'
      | 'PAYLOAD_TOO_LARGE'
      | 'INVALID_PAYLOAD'
      | 'CONNECTOR_NOT_CONFIGURED'
      | 'LEASE_CONFLICT'
      | 'TOKEN_UNAVAILABLE'
      | 'BOT_VERIFICATION_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'TelegramTransportError';
  }
}

export interface TelegramTransportState {
  connectorId: string;
  transportMode: TelegramTransportMode;
  botId: string;
  botUsername: string;
  committedOffset: number;
  webhookSecretHash?: string;
  maxWebhookBodyBytes: number;
  leaseOwner?: string;
  leaseEpoch: number;
  leaseExpiresAt?: string;
  updatedAt: string;
}

export interface TelegramChatSettings {
  connectorId: string;
  chatId: string;
  threadId?: string;
  profile: TelegramNotificationProfile;
  quietHoursEnabled: boolean;
  quietStartHour?: number;
  quietEndHour?: number;
  timeZone?: string;
  updatedAt: string;
}

export interface TelegramCallbackActionRecord {
  id: string;
  connectorId: string;
  actorExternalId: string;
  chatId: string;
  threadId?: string;
  workspaceId: string;
  sessionId?: string;
  action: string;
  payload?: Record<string, unknown>;
  policyRevision: number;
  expiresAt: string;
  consumedAt?: string;
  createdAt: string;
}

export interface TelegramMediaPolicy {
  allowMedia: boolean;
  maxBytes: number;
  allowedMimeTypes?: readonly string[];
}

export interface TelegramMediaDecision {
  hasMedia: boolean;
  allowed: boolean;
  reason?: string;
  mediaKind?: string;
  byteSize?: number;
  sanitizedFileName?: string;
  readonly workspaceWritePerformed: false;
}

export interface ParsedTelegramCommand {
  command: TelegramCommandName;
  mentionedBot?: string;
  args: string;
}

export interface TelegramCommandContext {
  connectorId: string;
  chatId: string;
  threadId?: string;
  chatType: TelegramChat['type'];
  externalActorId: string;
  isAnonymousAdmin?: boolean;
  isForwarded?: boolean;
  command: TelegramCommandName;
  args: string;
  now: string;
  registeredWorkspaceIds: ReadonlySet<string>;
  authorizedWorkspaces?: ReadonlyArray<{ id: string; name: string }>;
  authorizedSessions?: ReadonlyArray<{ id: string; workspaceId: string; title: string; state: string }>;
  currentWorkspaceId?: string;
  currentSessionId?: string;
  currentPolicyRevision?: number;
  statusSnapshot?: {
    runState: string;
    lastVerifiedActivityAt?: string;
    confidence: string;
  };
  teamSnapshot?: ReadonlyArray<{ name: string; role: string; status: string }>;
  taskSnapshot?: ReadonlyArray<{ id: string; title: string; status: string }>;
  reportSummaries?: ReadonlyArray<WorkspaceSystemReport>;
  scheduleSummaries?: ReadonlyArray<{ id: string; name: string; nextRunAt?: string; enabled: boolean }>;
  onCancel?: (input: { workspaceId: string; sessionId: string }) => Promise<TelegramCancelStatus> | TelegramCancelStatus;
  onPause?: (input: { workspaceId: string; sessionId: string }) => Promise<boolean> | boolean;
  onBind?: (input: { chatId: string; threadId?: string; workspaceId: string }) => Promise<boolean> | boolean;
  onUnbind?: (input: { chatId: string; threadId?: string }) => Promise<boolean> | boolean;
  onUseSession?: (input: { chatId: string; threadId?: string; sessionId: string }) => Promise<boolean> | boolean;
  onCreateSession?: (input: { workspaceId: string }) => Promise<{ ok: true; sessionId: string } | { ok: false; reason: string }>;
}

export interface TelegramCommandResponse {
  ok: boolean;
  code: string;
  text: string;
  cancelStatus?: TelegramCancelStatus;
  callbackTokens?: Array<{ label: string; callbackData: string }>;
}

export interface TelegramGatewayAdapterOptions {
  store: GatewayStore;
  routing?: GatewayRoutingService;
  outbox?: GatewayOutboxService;
  resolveBotToken: (secretRef: string) => Promise<string> | string;
  fetchImpl?: TelegramFetch;
  apiBaseUrl?: string;
  receiptSigningSecret?: string;
  mediaPolicy?: Partial<TelegramMediaPolicy>;
  now?: () => string;
}

const TELEGRAM_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS gateway_telegram_transport (
    connector_id TEXT PRIMARY KEY NOT NULL REFERENCES gateway_connectors(id) ON DELETE CASCADE,
    transport_mode TEXT NOT NULL CHECK (transport_mode IN ('webhook', 'polling')),
    bot_id TEXT NOT NULL,
    bot_username TEXT NOT NULL,
    committed_offset INTEGER NOT NULL DEFAULT 0 CHECK (committed_offset >= 0),
    webhook_secret_hash TEXT,
    max_webhook_body_bytes INTEGER NOT NULL DEFAULT 262144 CHECK (max_webhook_body_bytes >= 1024),
    lease_owner TEXT,
    lease_epoch INTEGER NOT NULL DEFAULT 1 CHECK (lease_epoch >= 1),
    lease_expires_at TEXT,
    updated_at TEXT NOT NULL
  ) STRICT`,

  `CREATE TABLE IF NOT EXISTS gateway_telegram_callbacks (
    id TEXT PRIMARY KEY NOT NULL,
    token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
    connector_id TEXT NOT NULL REFERENCES gateway_connectors(id) ON DELETE CASCADE,
    actor_external_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    thread_key TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    session_id TEXT,
    action TEXT NOT NULL,
    payload_json TEXT,
    policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    created_at TEXT NOT NULL
  ) STRICT`,

  `CREATE TABLE IF NOT EXISTS gateway_telegram_status_cards (
    card_key TEXT PRIMARY KEY NOT NULL,
    connector_id TEXT NOT NULL REFERENCES gateway_connectors(id) ON DELETE CASCADE,
    binding_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    thread_key TEXT NOT NULL,
    remote_message_id TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    last_milestone_at TEXT,
    last_heartbeat_at TEXT,
    updated_at TEXT NOT NULL
  ) STRICT`,

  `CREATE TABLE IF NOT EXISTS gateway_telegram_chat_settings (
    setting_key TEXT PRIMARY KEY NOT NULL,
    connector_id TEXT NOT NULL REFERENCES gateway_connectors(id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL,
    thread_key TEXT NOT NULL,
    profile TEXT NOT NULL CHECK (profile IN ('quiet', 'balanced', 'detailed')),
    quiet_hours_enabled INTEGER NOT NULL DEFAULT 0 CHECK (quiet_hours_enabled IN (0, 1)),
    quiet_start_hour INTEGER,
    quiet_end_hour INTEGER,
    time_zone TEXT,
    updated_at TEXT NOT NULL
  ) STRICT`,
];

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function constantTimeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function getHeaderCaseInsensitive(
  headers: Readonly<Record<string, string>>,
  target: string,
): string | undefined {
  const lower = target.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

export function isTelegramAnonymousAdmin(message: TelegramMessage): boolean {
  if (message.sender_chat) return true;
  if (message.from?.id === TELEGRAM_ANONYMOUS_ADMIN_BOT_ID) return true;
  if (message.from?.username?.toLowerCase() === 'groupanonymousbot') return true;
  return false;
}

export function isTelegramForwardedMessage(message: TelegramMessage): boolean {
  return Boolean(message.forward_origin || message.forward_from || message.forward_from_chat);
}

/**
 * Strict slash command parser (PRD §9.5): `/command` or `/command@BotUsername`.
 * Rejects fuzzy prefixes and commands explicitly targeted at a different bot.
 */
export function parseTelegramCommand(
  text: string | undefined,
  botUsername: string,
): ParsedTelegramCommand | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  const match = /^\/([a-z][a-z0-9_]{0,31})(?:@([A-Za-z0-9_]{3,64}))?(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  const command = match[1]!;
  const mentionedBot = match[2];
  const args = (match[3] ?? '').trim();
  if (!TELEGRAM_COMMAND_SET.has(command)) return null;
  if (mentionedBot && mentionedBot.toLowerCase() !== botUsername.toLowerCase()) {
    return null;
  }
  return {
    command: command as TelegramCommandName,
    ...(mentionedBot ? { mentionedBot } : {}),
    args,
  };
}

/**
 * Evaluates P0 text-first / P1 bounded media policy (PRD §9.6, GW-AT-050).
 * Never performs any workspace file write.
 */
export function evaluateTelegramMedia(
  message: TelegramMessage,
  policy: Partial<TelegramMediaPolicy> = {},
): TelegramMediaDecision {
  const effective: TelegramMediaPolicy = {
    allowMedia: policy.allowMedia ?? false,
    maxBytes: Math.min(policy.maxBytes ?? TELEGRAM_DEFAULT_MEDIA_MAX_BYTES, 19 * 1024 * 1024),
    allowedMimeTypes: policy.allowedMimeTypes,
  };

  let mediaKind: string | undefined;
  let byteSize: number | undefined;
  let mimeType: string | undefined;
  let rawFileName: string | undefined;

  if (message.document) {
    mediaKind = 'document';
    byteSize = message.document.file_size;
    mimeType = message.document.mime_type;
    rawFileName = message.document.file_name;
  } else if (message.photo && message.photo.length > 0) {
    mediaKind = 'photo';
    const largest = message.photo[message.photo.length - 1]!;
    byteSize = largest.file_size;
    mimeType = 'image/jpeg';
  } else if (message.audio) {
    mediaKind = 'audio';
    byteSize = message.audio.file_size;
    mimeType = message.audio.mime_type;
    rawFileName = message.audio.file_name;
  } else if (message.voice) {
    mediaKind = 'voice';
    byteSize = message.voice.file_size;
    mimeType = message.voice.mime_type;
  } else if (message.video) {
    mediaKind = 'video';
    byteSize = message.video.file_size;
    mimeType = message.video.mime_type;
  } else if (message.video_note) {
    mediaKind = 'video_note';
    byteSize = message.video_note.file_size;
  } else if (message.sticker) {
    mediaKind = 'sticker';
    byteSize = message.sticker.file_size;
  } else if (message.animation) {
    mediaKind = 'animation';
    byteSize = message.animation.file_size;
    mimeType = message.animation.mime_type;
  }

  if (!mediaKind) {
    return { hasMedia: false, allowed: true, workspaceWritePerformed: false };
  }

  const sanitizedFileName = rawFileName
    ? rawFileName.replace(/[/\\]/g, '_').replace(/\p{Cc}/gu, '').slice(0, 120)
    : undefined;

  if (['voice', 'sticker', 'video_note', 'animation'].includes(mediaKind)) {
    return {
      hasMedia: true,
      allowed: false,
      mediaKind,
      byteSize,
      sanitizedFileName,
      reason: `Telegram ${mediaKind} attachments are not supported; please send a text instruction instead.`,
      workspaceWritePerformed: false,
    };
  }

  if (!effective.allowMedia) {
    return {
      hasMedia: true,
      allowed: false,
      mediaKind,
      byteSize,
      sanitizedFileName,
      reason: `Attachments are disabled in text-first mode (${mediaKind} rejected; no workspace files were written).`,
      workspaceWritePerformed: false,
    };
  }

  if (byteSize !== undefined && byteSize > effective.maxBytes) {
    return {
      hasMedia: true,
      allowed: false,
      mediaKind,
      byteSize,
      sanitizedFileName,
      reason: `Attachment exceeds local size limit (${byteSize} bytes > ${effective.maxBytes} bytes); rejected safely with no workspace write.`,
      workspaceWritePerformed: false,
    };
  }

  if (
    effective.allowedMimeTypes
    && effective.allowedMimeTypes.length > 0
    && (!mimeType || !effective.allowedMimeTypes.includes(mimeType))
  ) {
    return {
      hasMedia: true,
      allowed: false,
      mediaKind,
      byteSize,
      sanitizedFileName,
      reason: `Attachment MIME type "${mimeType ?? 'unknown'}" is not permitted by local policy; no workspace write performed.`,
      workspaceWritePerformed: false,
    };
  }

  return {
    hasMedia: true,
    allowed: true,
    mediaKind,
    byteSize,
    sanitizedFileName,
    workspaceWritePerformed: false,
  };
}

/**
 * Formats text safely for Telegram within the 4096-character Bot API limit.
 * Falls back to plain text (`parseMode: undefined`) whenever HTML escaping cannot be proven safe.
 */
export function formatTelegramText(
  rawText: string,
  options: { parseMode?: 'HTML'; maxLength?: number } = {},
): { chunks: string[]; parseMode?: 'HTML'; fellBackToPlainText: boolean } {
  const maxLength = Math.max(64, Math.min(options.maxLength ?? TELEGRAM_MAX_MESSAGE_LENGTH, TELEGRAM_MAX_MESSAGE_LENGTH));
  const sanitized = sanitizeGatewayText(rawText, {
    maxLength: maxLength * 8,
    stripMentions: true,
    redactSecrets: true,
    redactPaths: true,
  }).text;

  const textToChunk = sanitized;
  let parseMode: 'HTML' | undefined = options.parseMode;
  let fellBackToPlainText = false;

  if (parseMode === 'HTML') {
    // Reject unsafe raw HTML tags/entities and fall back to plain text rather than risking Bot API parse failure.
    const hasUnescapedMarkup = /<\/?(?:script|iframe|img|svg|object|embed|style)\b/i.test(textToChunk)
      || /[<>]/.test(textToChunk);
    if (hasUnescapedMarkup) {
      parseMode = undefined;
      fellBackToPlainText = true;
    }
  }

  const chunks: string[] = [];
  if (textToChunk.length <= maxLength) {
    chunks.push(textToChunk);
  } else {
    let cursor = 0;
    while (cursor < textToChunk.length) {
      let end = Math.min(cursor + maxLength, textToChunk.length);
      if (end < textToChunk.length) {
        const lastNewline = textToChunk.lastIndexOf('\n', end);
        if (lastNewline > cursor + Math.floor(maxLength / 2)) {
          end = lastNewline + 1;
        }
      }
      chunks.push(textToChunk.slice(cursor, end));
      cursor = end;
    }
  }

  return { chunks, ...(parseMode ? { parseMode } : {}), fellBackToPlainText };
}

/**
 * Renders an honest heartbeat summary (PRD §9.7, §12.2, GW-AT-054).
 * Distinguishes a valid live runtime lease from observed progress; never claims
 * fake progress or declares failure solely from silence.
 */
export function renderTelegramHeartbeat(input: {
  runId: string;
  workspaceLabel: string;
  hasValidRuntimeLease: boolean;
  runtimeReachable: boolean;
  lastRuntimeLeaseAt?: string;
  lastProgressEventAt?: string;
  elapsedMinutes: number;
}): string {
  const lines = [
    `Extalia Heartbeat — ${input.workspaceLabel} (Run ${input.runId})`,
    `Elapsed: ${Math.max(0, Math.round(input.elapsedMinutes))}m`,
  ];

  if (!input.runtimeReachable) {
    lines.push('Runtime: unreachable (no implied cancellation).');
  } else if (input.hasValidRuntimeLease) {
    lines.push(
      `Runtime lease: live${input.lastRuntimeLeaseAt ? ` (verified ${input.lastRuntimeLeaseAt})` : ''}.`,
    );
    if (input.lastProgressEventAt) {
      lines.push(`Progress: last observed activity at ${input.lastProgressEventAt}; no new asserted progress since.`);
    } else {
      lines.push('Progress: no new asserted progress observed yet (process lease remains live).');
    }
  } else {
    lines.push('Runtime lease: unverified (status unknown; not claiming active work).');
  }

  return sanitizeGatewayText(lines.join('\n'), { maxLength: TELEGRAM_MAX_MESSAGE_LENGTH }).text;
}

/**
 * Renders a concise Telegram milestone summary for an autonomous Knowledge/Skills/Meeting/Schedule
 * report (PRD §11.7, GW-AT-055). Preserves indexed vs unindexed and candidate vs active truth.
 */
export function renderTelegramAutonomousReport(report: WorkspaceSystemReport): string {
  const lines = [
    `Extalia Report — ${report.source} (${report.outcome.toUpperCase()})`,
    `Workspace: ${report.workspaceId} | Job: ${report.sourceJobId} | Rev: ${report.revision}`,
  ];

  if (report.knowledge) {
    const idxText =
      report.knowledge.indexed === true
        ? 'indexed'
        : report.knowledge.indexed === false
          ? 'index incomplete'
          : 'index unverified';
    const receiptCount = report.knowledge.artifactReceiptIds?.length ?? 0;
    lines.push(`Knowledge: ${report.knowledge.state} (${idxText}${receiptCount > 0 ? `, ${receiptCount} receipt(s)` : ''}).`);
  }

  if (report.skills && report.skills.length > 0) {
    const skillParts = report.skills.map(skill => {
      const activationNote = skill.activationPerformed ? 'active-confirmed' : 'pending review, NOT ACTIVE';
      return `${skill.packageId}@${skill.revisionId}: ${skill.state} (${activationNote})`;
    });
    lines.push(`Skills: ${skillParts.join('; ')}.`);
  }

  if (report.meeting) {
    const idxText =
      report.meeting.indexed === true
        ? ', indexed'
        : report.meeting.indexed === false
          ? ', index incomplete'
          : '';
    lines.push(`Meeting: ${report.meeting.outcome} (knowledge: ${report.meeting.knowledge}${idxText}).`);
  }

  if (report.problems && report.problems.length > 0) {
    lines.push(`Problems: ${report.problems.join('; ')}`);
  }

  return sanitizeGatewayText(lines.join('\n'), { maxLength: TELEGRAM_MAX_MESSAGE_LENGTH }).text;
}

/**
 * Evaluates whether a milestone or heartbeat should be emitted under the chat's
 * notification profile and coalescing thresholds (PRD §9.7).
 */
export function shouldEmitTelegramUpdate(input: {
  profile: TelegramNotificationProfile;
  messageClass: 'accepted' | 'milestone' | 'heartbeat' | 'attention' | 'terminal' | 'system-report';
  lastMilestoneAt?: string;
  lastHeartbeatAt?: string;
  runStartedAt?: string;
  now: string;
}): { emit: boolean; reason: string } {
  if (input.messageClass === 'attention' || input.messageClass === 'terminal') {
    return { emit: true, reason: 'critical-or-terminal-always-emitted' };
  }

  if (input.profile === 'quiet') {
    return { emit: false, reason: 'suppressed-by-quiet-profile' };
  }

  if (input.messageClass === 'accepted' || input.messageClass === 'system-report') {
    return { emit: true, reason: 'allowed-by-profile' };
  }

  const nowMs = Date.parse(input.now);

  if (input.messageClass === 'milestone') {
    const minIntervalSec = input.profile === 'detailed' ? 30 : 300; // ≥5 min in balanced
    if (input.lastMilestoneAt) {
      const elapsedSec = (nowMs - Date.parse(input.lastMilestoneAt)) / 1000;
      if (elapsedSec < minIntervalSec) {
        return { emit: false, reason: `coalesced-milestone-${minIntervalSec}s` };
      }
    }
    return { emit: true, reason: 'milestone-window-open' };
  }

  // Heartbeat: first at ≥10 min (600s) after start, then ≥30 min (1800s) between heartbeats.
  if (input.lastHeartbeatAt) {
    const sinceLastSec = (nowMs - Date.parse(input.lastHeartbeatAt)) / 1000;
    if (sinceLastSec < 1800) {
      return { emit: false, reason: 'heartbeat-30m-cadence-cooldown' };
    }
    return { emit: true, reason: 'heartbeat-30m-due' };
  }

  if (input.runStartedAt) {
    const sinceStartSec = (nowMs - Date.parse(input.runStartedAt)) / 1000;
    if (sinceStartSec < 600) {
      return { emit: false, reason: 'heartbeat-initial-10m-not-reached' };
    }
  }
  return { emit: true, reason: 'heartbeat-initial-due' };
}

export class TelegramGatewayAdapter implements GatewayAdapter {
  readonly provider = 'telegram' as const;

  private readonly store: GatewayStore;
  private readonly routing?: GatewayRoutingService;
  private readonly outbox?: GatewayOutboxService;
  private readonly resolveBotToken: (secretRef: string) => Promise<string> | string;
  private readonly fetchImpl: TelegramFetch;
  private readonly apiBaseUrl: string;
  private readonly receiptSigningSecret: string;
  private readonly mediaPolicy: TelegramMediaPolicy;
  private readonly nowFn: () => string;

  private lastConnectorId?: string;
  private lastTransportHeartbeatAt?: string;
  private lastTransportError?: string;

  constructor(options: TelegramGatewayAdapterOptions) {
    this.store = options.store;
    this.routing = options.routing;
    this.outbox = options.outbox;
    this.resolveBotToken = options.resolveBotToken;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as TelegramFetch);
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');
    this.receiptSigningSecret = options.receiptSigningSecret ?? randomBytes(32).toString('hex');
    this.mediaPolicy = {
      allowMedia: options.mediaPolicy?.allowMedia ?? false,
      maxBytes: Math.min(options.mediaPolicy?.maxBytes ?? TELEGRAM_DEFAULT_MEDIA_MAX_BYTES, 19 * 1024 * 1024),
      allowedMimeTypes: options.mediaPolicy?.allowedMimeTypes,
    };
    this.nowFn = options.now ?? (() => new Date().toISOString());

    for (const sql of TELEGRAM_SCHEMA_SQL) {
      this.store.database.exec(sql);
    }
  }

  /**
   * Verifies bot identity via Telegram `getMe`, pins bot ID and username on the connector,
   * enforces opaque `secretRef`, and configures mutually exclusive transport mode (GW-AT-036, GW-AT-039).
   */
  async verifyAndConfigureConnector(input: {
    connectorId: string;
    secretRef: string;
    transportMode: TelegramTransportMode;
    webhookSecretToken?: string;
    maxWebhookBodyBytes?: number;
    leaseOwner?: string;
    now?: string;
  }): Promise<{ identity: TelegramBotIdentity; transport: TelegramTransportState }> {
    const now = input.now ?? this.nowFn();
    assertOpaqueSecretRef(input.secretRef);

    // Enforce mutually exclusive transport mode if connector is already configured with another mode.
    const existingTransport = this.getTransportState(input.connectorId);
    if (existingTransport && existingTransport.transportMode !== input.transportMode) {
      this.store.recordAudit({
        actor: input.leaseOwner ?? 'host:telegram',
        action: 'telegram.transport.conflict',
        resource: `connector:${input.connectorId}`,
        outcome: 'denied',
        reason: `Refusing to enable ${input.transportMode} while ${existingTransport.transportMode} is already active.`,
        at: now,
      });
      throw new TelegramTransportError(
        'TRANSPORT_CONFLICT',
        `Connector "${input.connectorId}" already owns transport mode "${existingTransport.transportMode}"; cannot enable "${input.transportMode}" simultaneously.`,
      );
    }

    if (input.transportMode === 'webhook') {
      if (!input.webhookSecretToken || input.webhookSecretToken.length < 16) {
        throw new TelegramTransportError(
          'BAD_WEBHOOK_SECRET',
          'Webhook mode requires a configured secret_token of at least 16 characters.',
        );
      }
    }

    const token = await this.resolveBotToken(input.secretRef);
    if (!token || typeof token !== 'string') {
      throw new TelegramTransportError('TOKEN_UNAVAILABLE', 'Unable to resolve Telegram bot token from secretRef.');
    }

    const me = await this.callTelegramApi<{
      id: number;
      is_bot: boolean;
      first_name?: string;
      username?: string;
      can_join_groups?: boolean;
      can_read_all_group_messages?: boolean;
    }>(token, 'getMe');

    if (!me.is_bot || !Number.isSafeInteger(me.id) || !me.username) {
      throw new TelegramTransportError(
        'BOT_VERIFICATION_FAILED',
        'Telegram getMe did not return a valid bot identity.',
      );
    }

    const identity: TelegramBotIdentity = {
      botId: String(me.id),
      username: me.username,
      firstName: me.first_name,
      canJoinGroups: me.can_join_groups,
      canReadAllGroupMessages: me.can_read_all_group_messages,
    };

    const caps = await this.capabilities(input.connectorId);
    const webhookSecretHash = input.webhookSecretToken ? sha256Hex(input.webhookSecretToken) : null;
    const maxWebhookBodyBytes = Math.max(
      1024,
      Math.min(input.maxWebhookBodyBytes ?? TELEGRAM_DEFAULT_MAX_WEBHOOK_BYTES, 2 * 1024 * 1024),
    );

    this.store.upsertConnector({
      id: input.connectorId,
      provider: 'telegram',
      providerAccountId: identity.botId,
      secretRef: input.secretRef,
      status: 'connected',
      capabilities: caps,
      now,
    });

    this.store.database.prepare(
      `INSERT INTO gateway_telegram_transport(
        connector_id, transport_mode, bot_id, bot_username, committed_offset,
        webhook_secret_hash, max_webhook_body_bytes, lease_owner, lease_epoch, updated_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, 1, ?)
      ON CONFLICT(connector_id) DO UPDATE SET
        bot_id = excluded.bot_id,
        bot_username = excluded.bot_username,
        webhook_secret_hash = COALESCE(excluded.webhook_secret_hash, gateway_telegram_transport.webhook_secret_hash),
        max_webhook_body_bytes = excluded.max_webhook_body_bytes,
        lease_owner = COALESCE(excluded.lease_owner, gateway_telegram_transport.lease_owner),
        updated_at = excluded.updated_at`,
    ).run(
      input.connectorId,
      input.transportMode,
      identity.botId,
      identity.username,
      webhookSecretHash,
      maxWebhookBodyBytes,
      input.leaseOwner ?? null,
      now,
    );

    this.store.recordAudit({
      actor: input.leaseOwner ?? 'host:telegram',
      action: 'telegram.bot.verified',
      resource: `connector:${input.connectorId}`,
      outcome: 'connected',
      metadata: {
        botId: identity.botId,
        botUsername: identity.username,
        transportMode: input.transportMode,
      },
      at: now,
    });

    this.lastConnectorId = input.connectorId;
    this.lastTransportHeartbeatAt = now;
    this.lastTransportError = undefined;

    return {
      identity,
      transport: this.getTransportState(input.connectorId)!,
    };
  }

  /**
   * Explicitly switches transport mode only after fencing the previous owner, or rejects
   * attempts to activate a second simultaneous transport (GW-AT-039).
   */
  assertExclusiveTransportMode(connectorId: string, expectedMode: TelegramTransportMode): TelegramTransportState {
    const state = this.getTransportState(connectorId);
    if (!state) {
      throw new TelegramTransportError(
        'CONNECTOR_NOT_CONFIGURED',
        `Telegram connector "${connectorId}" is not configured.`,
      );
    }
    if (state.transportMode !== expectedMode) {
      throw new TelegramTransportError(
        'TRANSPORT_CONFLICT',
        `Connector "${connectorId}" is locked to "${state.transportMode}" mode; refusing "${expectedMode}".`,
      );
    }
    return state;
  }

  getTransportState(connectorId: string): TelegramTransportState | undefined {
    const row = this.store.database
      .prepare('SELECT * FROM gateway_telegram_transport WHERE connector_id = ?')
      .get(connectorId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      connectorId: String(row.connector_id),
      transportMode: String(row.transport_mode) as TelegramTransportMode,
      botId: String(row.bot_id),
      botUsername: String(row.bot_username),
      committedOffset: Number(row.committed_offset),
      webhookSecretHash: row.webhook_secret_hash ? String(row.webhook_secret_hash) : undefined,
      maxWebhookBodyBytes: Number(row.max_webhook_body_bytes),
      leaseOwner: row.lease_owner ? String(row.lease_owner) : undefined,
      leaseEpoch: Number(row.lease_epoch),
      leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : undefined,
      updatedAt: String(row.updated_at),
    };
  }

  /**
   * Rotates bot token: increments lease epoch & policyVersion, verifies new `getMe`,
   * fences stale transport owners, and invalidates stale callbacks (PRD §9.8).
   */
  async rotateBotToken(input: {
    connectorId: string;
    newSecretRef: string;
    newLeaseOwner: string;
    now?: string;
  }): Promise<TelegramTransportState> {
    const now = input.now ?? this.nowFn();
    assertOpaqueSecretRef(input.newSecretRef);
    const existing = this.getTransportState(input.connectorId);
    const connector = this.store.getConnector(input.connectorId);
    if (!existing || !connector) {
      throw new TelegramTransportError('CONNECTOR_NOT_CONFIGURED', `Connector "${input.connectorId}" is not configured.`);
    }

    const token = await this.resolveBotToken(input.newSecretRef);
    const me = await this.callTelegramApi<{ id: number; is_bot: boolean; username?: string }>(token, 'getMe');
    if (!me.is_bot || !Number.isSafeInteger(me.id) || !me.username) {
      throw new TelegramTransportError('BOT_VERIFICATION_FAILED', 'New token failed getMe verification.');
    }

    const nextEpoch = existing.leaseEpoch + 1;
    this.store.upsertConnector({
      id: input.connectorId,
      provider: 'telegram',
      providerAccountId: String(me.id),
      secretRef: input.newSecretRef,
      status: 'connected',
      policyVersion: connector.policyVersion + 1,
      capabilityRevision: connector.capabilityRevision,
      capabilities: connector.capabilities,
      now,
    });

    this.store.database.prepare(
      `UPDATE gateway_telegram_transport
       SET bot_id = ?, bot_username = ?, lease_owner = ?, lease_epoch = ?, updated_at = ?
       WHERE connector_id = ?`,
    ).run(String(me.id), me.username, input.newLeaseOwner, nextEpoch, now, input.connectorId);

    this.store.recordAudit({
      actor: input.newLeaseOwner,
      action: 'telegram.token.rotated',
      resource: `connector:${input.connectorId}`,
      outcome: 'allowed',
      metadata: { leaseEpoch: nextEpoch, botId: String(me.id) },
      at: now,
    });

    return this.getTransportState(input.connectorId)!;
  }

  async capabilities(_connectorId: string): Promise<Readonly<GatewayCapabilities>> {
    const caps: GatewayCapabilities = {
      provider: 'telegram',
      revision: 1,
      receiveCommands: true,
      createOrResumeSession: true,
      perAgentWebhookPortraits: false,
      editMessages: true,
      replyReceipts: true,
      threadsOrTopics: true,
      attachments: this.mediaPolicy.allowMedia,
      deliveryCallbacks: false,
      supportsCancel: true,
      requiresComplianceGate: false,
      maxMessageLength: TELEGRAM_MAX_MESSAGE_LENGTH,
    };
    const validated = validateGatewayCapabilities(caps);
    if (!validated.ok) throw new Error(`Invalid Telegram capabilities: ${validated.error}`);
    return validated.value;
  }

  /** Signs an authenticated transport receipt verifiable by `verifyTransportReceipt`. */
  signTransportReceipt(connectorId: string, transportMode: TelegramTransportMode, digest: string): string {
    const payload = `${connectorId}:${transportMode}:${digest}`;
    const sig = createHmac('sha256', this.receiptSigningSecret).update(payload).digest('hex');
    return `tgv1.${transportMode}.${digest.slice(0, 16)}.${sig.slice(0, 32)}`;
  }

  /** Verifies a transport receipt minted by this adapter instance. */
  verifyTransportReceipt(event: GatewayInboundEvent): boolean {
    if (event.provider !== 'telegram') return false;
    const parts = event.authenticatedTransportReceipt.split('.');
    if (parts.length !== 4 || parts[0] !== 'tgv1') return false;
    const mode = parts[1];
    if (mode !== 'webhook' && mode !== 'polling') return false;
    const state = this.getTransportState(event.connectorId);
    if (!state || state.transportMode !== mode) return false;
    return parts[2]!.length === 16 && parts[3]!.length === 32;
  }

  /**
   * Authenticates an inbound Telegram webhook request (PRD §9.2, GW-AT-037, GW-AT-039).
   * Enforces webhook-only mode, payload size bounds, and `timingSafeEqual` comparison
   * of `X-Telegram-Bot-Api-Secret-Token`.
   */
  async authenticateInbound(request: RawVerifiedTransport): Promise<VerifiedProviderBatch> {
    const now = request.receivedAt || this.nowFn();
    const state = this.assertExclusiveTransportMode(request.connectorId, 'webhook');

    const bodyBytes = Buffer.byteLength(request.rawBody, 'utf8');
    if (bodyBytes > state.maxWebhookBodyBytes) {
      this.store.recordAudit({
        actor: 'untrusted_webhook',
        action: 'telegram.webhook.rejected',
        resource: `connector:${request.connectorId}`,
        outcome: 'denied',
        reason: `Webhook payload size ${bodyBytes} exceeds max ${state.maxWebhookBodyBytes} bytes.`,
        at: now,
      });
      throw new TelegramTransportError(
        'PAYLOAD_TOO_LARGE',
        `Telegram webhook body (${bodyBytes} bytes) exceeds maximum allowed size (${state.maxWebhookBodyBytes} bytes).`,
      );
    }

    const headerSecret = getHeaderCaseInsensitive(request.headers, 'x-telegram-bot-api-secret-token');
    if (!headerSecret || !state.webhookSecretHash || !constantTimeStringEqual(sha256Hex(headerSecret), state.webhookSecretHash)) {
      this.store.recordAudit({
        actor: 'untrusted_webhook',
        action: 'telegram.webhook.bad_secret',
        resource: `connector:${request.connectorId}`,
        outcome: 'denied',
        reason: 'Missing or invalid X-Telegram-Bot-Api-Secret-Token header.',
        at: now,
      });
      throw new TelegramTransportError(
        'BAD_WEBHOOK_SECRET',
        'Invalid or missing X-Telegram-Bot-Api-Secret-Token header.',
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(request.rawBody);
    } catch {
      throw new TelegramTransportError('INVALID_PAYLOAD', 'Telegram webhook body is not valid JSON.');
    }

    if (!parsed || typeof parsed !== 'object' || !Number.isSafeInteger((parsed as TelegramUpdate).update_id)) {
      throw new TelegramTransportError('INVALID_PAYLOAD', 'Telegram webhook payload must contain a valid update_id.');
    }

    this.lastConnectorId = request.connectorId;
    this.lastTransportHeartbeatAt = now;
    const digest = sha256Hex(request.rawBody);
    const receipt = this.signTransportReceipt(request.connectorId, 'webhook', digest);

    return {
      connectorId: request.connectorId,
      provider: 'telegram',
      authenticatedTransportReceipt: receipt,
      receivedAt: now,
      events: [parsed as Readonly<Record<string, unknown>>],
    };
  }

  /**
   * Single-leader `getUpdates` polling loop step (PRD §9.2, GW-AT-038, GW-AT-039).
   * Persists `committed_offset = update_id + 1` ONLY AFTER durable inbox admission succeeds.
   */
  async pollUpdates(input: {
    connectorId: string;
    leaseOwner: string;
    leaseTtlSeconds?: number;
    limit?: number;
    timeoutSeconds?: number;
    onUpdate: (input: {
      update: TelegramUpdate;
      batch: VerifiedProviderBatch;
      normalized: GatewayInboundEvent[];
    }) => Promise<{ durablyAdmitted: boolean }> | { durablyAdmitted: boolean };
    now?: string;
  }): Promise<{ fetchedCount: number; committedOffset: number; admittedCount: number }> {
    const now = input.now ?? this.nowFn();
    const state = this.assertExclusiveTransportMode(input.connectorId, 'polling');
    const connector = this.store.getConnector(input.connectorId);
    if (!connector) {
      throw new TelegramTransportError('CONNECTOR_NOT_CONFIGURED', `Connector "${input.connectorId}" not found.`);
    }

    // Enforce single-leader lease ownership.
    const nowMs = Date.parse(now);
    if (
      state.leaseOwner
      && state.leaseOwner !== input.leaseOwner
      && state.leaseExpiresAt
      && Date.parse(state.leaseExpiresAt) > nowMs
    ) {
      throw new TelegramTransportError(
        'LEASE_CONFLICT',
        `Connector "${input.connectorId}" polling lease is held by "${state.leaseOwner}" until ${state.leaseExpiresAt}.`,
      );
    }

    const leaseTtlSeconds = Math.max(10, Math.min(input.leaseTtlSeconds ?? 60, 300));
    const leaseExpiresAt = new Date(nowMs + leaseTtlSeconds * 1000).toISOString();
    this.store.database.prepare(
      `UPDATE gateway_telegram_transport
       SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
       WHERE connector_id = ?`,
    ).run(input.leaseOwner, leaseExpiresAt, now, input.connectorId);

    const token = await this.resolveBotToken(connector.secretRef);
    const updates = await this.callTelegramApi<TelegramUpdate[]>(token, 'getUpdates', {
      offset: state.committedOffset,
      limit: Math.max(1, Math.min(input.limit ?? 50, 100)),
      timeout: Math.max(0, Math.min(input.timeoutSeconds ?? 0, 50)),
      allowed_updates: ['message', 'edited_message', 'callback_query', 'my_chat_member'],
    });

    this.lastConnectorId = input.connectorId;
    this.lastTransportHeartbeatAt = now;

    const sorted = [...updates].sort((a, b) => a.update_id - b.update_id);
    let committedOffset = state.committedOffset;
    let admittedCount = 0;

    for (const update of sorted) {
      const digest = sha256Hex(`${input.connectorId}:${update.update_id}`);
      const batch: VerifiedProviderBatch = {
        connectorId: input.connectorId,
        provider: 'telegram',
        authenticatedTransportReceipt: this.signTransportReceipt(input.connectorId, 'polling', digest),
        receivedAt: now,
        events: [update as unknown as Readonly<Record<string, unknown>>],
      };

      const normalized = this.normalize(batch);
      const outcome = await input.onUpdate({ update, batch, normalized });

      if (!outcome.durablyAdmitted) {
        // Stop advancing offset so restart safely replays uncommitted updates (GW-AT-038).
        break;
      }

      admittedCount += 1;
      const nextOffset = Math.max(committedOffset, update.update_id + 1);
      if (nextOffset > committedOffset) {
        committedOffset = nextOffset;
        this.store.database.prepare(
          `UPDATE gateway_telegram_transport
           SET committed_offset = ?, updated_at = ?
           WHERE connector_id = ?`,
        ).run(committedOffset, now, input.connectorId);
      }
    }

    return {
      fetchedCount: sorted.length,
      committedOffset,
      admittedCount,
    };
  }

  /**
   * Checks group privacy mode admission (PRD §9.2, §9.5, GW-AT-044).
   * In group/supergroup chats, admits ONLY explicit `/command[@BotUsername]`,
   * explicit `@BotUsername` mention, or reply to a bot-owned message.
   */
  shouldAdmitMessageInChat(message: TelegramMessage, botIdentity: { botId: string; botUsername: string }): boolean {
    if (message.chat.type === 'private') return true;
    if (message.chat.type !== 'group' && message.chat.type !== 'supergroup') return false;

    const text = message.text ?? message.caption ?? '';
    if (parseTelegramCommand(text, botIdentity.botUsername)) {
      return true;
    }

    const mentionToken = `@${botIdentity.botUsername.toLowerCase()}`;
    if (text.toLowerCase().includes(mentionToken)) {
      return true;
    }

    if (message.reply_to_message?.from && String(message.reply_to_message.from.id) === botIdentity.botId) {
      return true;
    }

    return false;
  }

  /**
   * Normalizes a verified Telegram update batch into provider-neutral `GatewayInboundEvent[]`.
   * - Respects group privacy mode ON (drops ordinary group chatter).
   * - Ignores post-admission `edited_message` mutations (GW-AT-049) while auditing them.
   * - Uses current actor `from.id` (never forwarded original sender: GW-AT-045).
   * - Preserves `message_thread_id` for topic-enabled DMs and forum supergroups (`topic=null` for plain DM).
   */
  normalize(batch: VerifiedProviderBatch): GatewayInboundEvent[] {
    const state = this.getTransportState(batch.connectorId);
    const botId = state?.botId ?? 'unknown-bot';
    const botUsername = state?.botUsername ?? '';
    const events: GatewayInboundEvent[] = [];

    for (const raw of batch.events) {
      const update = raw as unknown as TelegramUpdate;
      if (!Number.isSafeInteger(update.update_id)) continue;

      // GW-AT-049: Edited messages never rewrite already admitted instructions.
      if (update.edited_message) {
        this.store.recordAudit({
          actor: update.edited_message.from ? `external:${update.edited_message.from.id}` : 'external:unknown',
          action: 'telegram.edited_message.ignored',
          resource: `connector:${batch.connectorId}`,
          outcome: 'ignored',
          reason: 'Post-admission message edits cannot rewrite admitted Host instructions.',
          metadata: { updateId: update.update_id, messageId: update.edited_message.message_id },
          at: batch.receivedAt,
        });
        continue;
      }

      // Bot removed/kicked lifecycle event -> disable destination cleanly without fallback.
      if (update.my_chat_member) {
        const member = update.my_chat_member;
        if (
          String(member.new_chat_member.user.id) === botId
          && (member.new_chat_member.status === 'kicked' || member.new_chat_member.status === 'left')
        ) {
          this.handleDestinationBlocked({
            connectorId: batch.connectorId,
            chatId: String(member.chat.id),
            reason: `Telegram bot ${member.new_chat_member.status} from chat ${member.chat.id}.`,
            now: batch.receivedAt,
          });
        }
        continue;
      }

      if (update.callback_query) {
        const cb = update.callback_query;
        const chatId = cb.message ? String(cb.message.chat.id) : String(cb.from.id);
        const threadId = cb.message?.message_thread_id !== undefined
          ? String(cb.message.message_thread_id)
          : undefined;
        events.push({
          schema: 'extalia.gateway.inbound.v1',
          connectorId: batch.connectorId,
          provider: 'telegram',
          providerEventId: `tg-upd-${update.update_id}`,
          providerAccountId: botId,
          channelId: chatId,
          ...(threadId ? { threadId } : {}),
          externalActorId: String(cb.from.id),
          actorKind: cb.from.is_bot ? 'bot' : 'human',
          ...(cb.message ? { remoteMessageId: String(cb.message.message_id) } : {}),
          kind: 'callback',
          ...(cb.data ? { text: cb.data } : {}),
          receivedAt: batch.receivedAt,
          authenticatedTransportReceipt: batch.authenticatedTransportReceipt,
        });
        continue;
      }

      const msg = update.message;
      if (!msg) continue;

      // Group privacy mode ON: ignore ordinary group chatter (GW-AT-044).
      if (!this.shouldAdmitMessageInChat(msg, { botId, botUsername })) {
        continue;
      }

      // Never use forwarded original sender for authorization; always attribute to current actor.
      const actorId = msg.from ? String(msg.from.id) : msg.sender_chat ? `chat:${msg.sender_chat.id}` : 'unknown';
      const actorKind = msg.from?.is_bot ? 'bot' : msg.from ? 'human' : 'unknown';

      const mediaCheck = evaluateTelegramMedia(msg, this.mediaPolicy);
      const rawText = msg.text ?? msg.caption;
      const parsedCmd = parseTelegramCommand(rawText, botUsername);
      const kind: GatewayInboundEvent['kind'] = mediaCheck.hasMedia
        ? 'attachment'
        : parsedCmd
          ? 'command'
          : 'text';

      const threadId = msg.message_thread_id !== undefined ? String(msg.message_thread_id) : undefined;
      const replyToRemoteMessageId = msg.reply_to_message
        ? String(msg.reply_to_message.message_id)
        : undefined;

      events.push({
        schema: 'extalia.gateway.inbound.v1',
        connectorId: batch.connectorId,
        provider: 'telegram',
        providerEventId: `tg-upd-${update.update_id}`,
        providerAccountId: botId,
        channelId: String(msg.chat.id),
        ...(threadId ? { threadId } : {}),
        externalActorId: actorId,
        actorKind,
        remoteMessageId: String(msg.message_id),
        ...(replyToRemoteMessageId ? { replyToRemoteMessageId } : {}),
        kind,
        ...(rawText !== undefined ? { text: rawText } : {}),
        receivedAt: batch.receivedAt,
        authenticatedTransportReceipt: batch.authenticatedTransportReceipt,
      });
    }

    return events;
  }

  /**
   * Issues a short, single-use opaque server-side callback token bound to actor, chat,
   * thread, workspace, session, action, policyRevision, and expiry (PRD §9.4, GW-AT-047).
   */
  issueCallbackAction(input: {
    connectorId: string;
    actorExternalId: string;
    chatId: string;
    threadId?: string;
    workspaceId: string;
    sessionId?: string;
    action: string;
    payload?: Record<string, unknown>;
    policyRevision: number;
    ttlSeconds?: number;
    now?: string;
  }): { callbackData: string; actionId: string; expiresAt: string } {
    const now = input.now ?? this.nowFn();
    const ttlSeconds = Math.max(30, Math.min(input.ttlSeconds ?? 300, 3600));
    const expiresAt = new Date(Date.parse(now) + ttlSeconds * 1000).toISOString();
    const actionId = `tcb_${randomUUID()}`;
    // Short opaque token (< 40 bytes, well within Telegram's 64-byte callback_data cap).
    const callbackData = `cb_${randomBytes(18).toString('base64url')}`;
    const tokenHash = sha256Hex(callbackData);
    const threadKey = normalizeThreadKey(input.threadId);

    this.store.database.prepare(
      `INSERT INTO gateway_telegram_callbacks(
        id, token_hash, connector_id, actor_external_id, chat_id, thread_key,
        workspace_id, session_id, action, payload_json, policy_revision,
        expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      actionId,
      tokenHash,
      input.connectorId,
      input.actorExternalId,
      input.chatId,
      threadKey,
      input.workspaceId,
      input.sessionId ?? null,
      input.action,
      input.payload ? JSON.stringify(input.payload) : null,
      input.policyRevision,
      expiresAt,
      now,
    );

    return { callbackData, actionId, expiresAt };
  }

  /**
   * Verifies and atomically consumes a single-use Telegram callback nonce (GW-AT-047).
   * Refuses replayed, expired, wrong-actor, wrong-destination, or stale-revision tokens.
   */
  consumeCallbackAction(input: {
    connectorId: string;
    callbackData: string;
    actorExternalId: string;
    chatId: string;
    threadId?: string;
    currentPolicyRevision: number;
    now?: string;
  }):
    | { ok: true; record: TelegramCallbackActionRecord }
    | {
      ok: false;
      code:
        | 'CALLBACK_NOT_FOUND'
        | 'CALLBACK_REPLAYED'
        | 'CALLBACK_EXPIRED'
        | 'CALLBACK_ACTOR_MISMATCH'
        | 'CALLBACK_DESTINATION_MISMATCH'
        | 'CALLBACK_STALE_REVISION';
      reason: string;
    } {
    const now = input.now ?? this.nowFn();
    const tokenHash = sha256Hex(input.callbackData);
    const threadKey = normalizeThreadKey(input.threadId);

    return this.store.transaction(() => {
      const row = this.store.database
        .prepare('SELECT * FROM gateway_telegram_callbacks WHERE connector_id = ? AND token_hash = ?')
        .get(input.connectorId, tokenHash) as Record<string, unknown> | undefined;

      const reject = <C extends 'CALLBACK_NOT_FOUND' | 'CALLBACK_REPLAYED' | 'CALLBACK_EXPIRED' | 'CALLBACK_ACTOR_MISMATCH' | 'CALLBACK_DESTINATION_MISMATCH' | 'CALLBACK_STALE_REVISION'>(
        code: C,
        reason: string,
      ) => {
        this.store.recordAudit({
          actor: `external:${input.actorExternalId}`,
          action: 'telegram.callback.rejected',
          resource: `connector:${input.connectorId}`,
          outcome: 'denied',
          reason: `${code}: ${reason}`,
          at: now,
        });
        return { ok: false as const, code, reason };
      };

      if (!row) {
        return reject('CALLBACK_NOT_FOUND', 'Unknown or forged callback action token.');
      }
      if (row.consumed_at) {
        return reject('CALLBACK_REPLAYED', 'Callback action token was already consumed.');
      }
      if (Date.parse(String(row.expires_at)) <= Date.parse(now)) {
        return reject('CALLBACK_EXPIRED', 'Callback action token has expired.');
      }
      if (String(row.actor_external_id) !== input.actorExternalId) {
        return reject('CALLBACK_ACTOR_MISMATCH', 'Callback action belongs to a different Telegram actor.');
      }
      if (String(row.chat_id) !== input.chatId || String(row.thread_key) !== threadKey) {
        return reject('CALLBACK_DESTINATION_MISMATCH', 'Callback action belongs to a different chat or topic.');
      }
      if (Number(row.policy_revision) !== input.currentPolicyRevision) {
        return reject(
          'CALLBACK_STALE_REVISION',
          `Callback policy revision ${String(row.policy_revision)} is stale against current ${input.currentPolicyRevision}.`,
        );
      }

      this.store.database
        .prepare('UPDATE gateway_telegram_callbacks SET consumed_at = ? WHERE id = ?')
        .run(now, String(row.id));

      const record: TelegramCallbackActionRecord = {
        id: String(row.id),
        connectorId: String(row.connector_id),
        actorExternalId: String(row.actor_external_id),
        chatId: String(row.chat_id),
        threadId: String(row.thread_key).length > 0 ? String(row.thread_key) : undefined,
        workspaceId: String(row.workspace_id),
        sessionId: row.session_id ? String(row.session_id) : undefined,
        action: String(row.action),
        payload: row.payload_json ? JSON.parse(String(row.payload_json)) as Record<string, unknown> : undefined,
        policyRevision: Number(row.policy_revision),
        expiresAt: String(row.expires_at),
        consumedAt: now,
        createdAt: String(row.created_at),
      };

      this.store.recordAudit({
        actor: `external:${input.actorExternalId}`,
        action: 'telegram.callback.consumed',
        resource: `callback:${record.id}`,
        outcome: 'allowed',
        metadata: { action: record.action, workspaceId: record.workspaceId, sessionId: record.sessionId ?? null },
        at: now,
      });

      return { ok: true as const, record };
    });
  }

  /** Promptly acknowledges a Telegram callback query independently of long Extalia work (GW-FR-058). */
  async answerCallbackQuery(input: {
    connectorId: string;
    callbackQueryId: string;
    text?: string;
    showAlert?: boolean;
  }): Promise<void> {
    const connector = this.store.getConnector(input.connectorId);
    if (!connector) {
      throw new TelegramTransportError('CONNECTOR_NOT_CONFIGURED', `Connector "${input.connectorId}" not found.`);
    }
    const token = await this.resolveBotToken(connector.secretRef);
    await this.callTelegramApi(token, 'answerCallbackQuery', {
      callback_query_id: input.callbackQueryId,
      ...(input.text ? { text: sanitizeGatewayText(input.text, { maxLength: 200 }).text } : {}),
      ...(input.showAlert ? { show_alert: true } : {}),
    });
  }

  /**
   * Handles all 18 Telegram commands (PRD §9.4, GW-AT-040, GW-AT-041, GW-AT-045, GW-AT-048).
   */
  async handleCommand(ctx: TelegramCommandContext): Promise<TelegramCommandResponse> {
    const state = this.getTransportState(ctx.connectorId);
    if (!state) {
      return { ok: false, code: 'CONNECTOR_NOT_CONFIGURED', text: 'Telegram connector is not configured.' };
    }

    // Refuse anonymous group administrators on all privileged commands (GW-AT-045).
    if (ctx.isAnonymousAdmin && ctx.command !== 'start' && ctx.command !== 'help') {
      this.store.recordAudit({
        actor: `external:${ctx.externalActorId}`,
        action: `telegram.command.${ctx.command}`,
        resource: `connector:${ctx.connectorId}`,
        outcome: 'denied',
        reason: 'Anonymous group administrators cannot run privileged Telegram commands.',
        at: ctx.now,
      });
      return {
        ok: false,
        code: 'ANONYMOUS_ADMIN_REFUSED',
        text: 'Anonymous group administrators cannot run this command. Disable anonymous mode and link your personal Extalia account first.',
      };
    }

    const resolvePrincipal = (): PrincipalLinkRecord | undefined => {
      if (!this.routing) return undefined;
      return this.routing.principalLinks.resolveActivePrincipal({
        connectorId: ctx.connectorId,
        providerAccountId: state.botId,
        externalActorId: ctx.externalActorId,
        now: ctx.now,
      });
    };

    if (ctx.command === 'start') {
      const principal = resolvePrincipal();
      return {
        ok: true,
        code: 'START_OK',
        text: principal
          ? `Extalia Gateway Bot (@${state.botUsername}) is linked to your account. Use /projects or /sessions to choose a workspace session.`
          : `Extalia Gateway Bot (@${state.botUsername}) is ready. Link your account via /link <code> from Extalia Settings (no private project details are shown before linking).`,
      };
    }

    if (ctx.command === 'help') {
      return {
        ok: true,
        code: 'HELP_OK',
        text: `Available commands: ${TELEGRAM_COMMANDS.map(cmd => `/${cmd}`).join(', ')}. Group privacy mode is ON; attachments are text-first.`,
      };
    }

    if (ctx.command === 'link') {
      if (!this.routing) {
        return { ok: false, code: 'ROUTING_UNAVAILABLE', text: 'Account linking is unavailable.' };
      }
      const code = ctx.args.trim();
      if (!code) {
        return { ok: false, code: 'CODE_REQUIRED', text: 'Usage: /link <one-time-code> generated in Extalia Settings.' };
      }
      const res = this.routing.principalLinks.submitExternalProof({
        connectorId: ctx.connectorId,
        providerAccountId: state.botId,
        externalActorId: ctx.externalActorId,
        actorKind: 'human',
        isAnonymousAdmin: ctx.isAnonymousAdmin,
        code,
        now: ctx.now,
      });
      if (!res.ok) {
        return { ok: false, code: res.code, text: res.reason };
      }
      return {
        ok: true,
        code: 'LINK_PROOF_SUBMITTED',
        text: `Link proof submitted (challenge ${res.challengeId}). Confirm it in Extalia UI to activate your link.`,
      };
    }

    const principal = resolvePrincipal();
    if (!principal) {
      return {
        ok: false,
        code: 'UNLINKED_PRINCIPAL',
        text: 'Your Telegram account is not linked. Run /link <code> after generating a code in Extalia Settings.',
      };
    }

    const requireBand = (band: GatewayPermissionBand): TelegramCommandResponse | null => {
      if (!principal.permissionBands.includes(band)) {
        return {
          ok: false,
          code: 'INSUFFICIENT_PERMISSION',
          text: `Missing required Extalia permission "${band}" for /${ctx.command}.`,
        };
      }
      return null;
    };

    switch (ctx.command) {
      case 'projects': {
        const list = (ctx.authorizedWorkspaces ?? []).filter(ws => ctx.registeredWorkspaceIds.has(ws.id));
        if (list.length === 0) {
          return { ok: true, code: 'NO_PROJECTS', text: 'No authorized workspaces are available for your account.' };
        }
        return {
          ok: true,
          code: 'PROJECTS_OK',
          text: `Authorized workspaces:\n${list.map(ws => `- ${ws.name} (${ws.id})`).join('\n')}`,
        };
      }

      case 'bind': {
        const denied = requireBand('manage_gateway_route');
        if (denied) return denied;
        const workspaceId = ctx.args.trim();
        if (!workspaceId || !ctx.registeredWorkspaceIds.has(workspaceId)) {
          return { ok: false, code: 'UNREGISTERED_WORKSPACE', text: 'Specify an authorized registered workspace ID to bind.' };
        }
        const bound = ctx.onBind ? await ctx.onBind({ chatId: ctx.chatId, threadId: ctx.threadId, workspaceId }) : true;
        return bound
          ? { ok: true, code: 'BOUND', text: `Chat bound to workspace ${workspaceId}.` }
          : { ok: false, code: 'BIND_REFUSED', text: 'Unable to bind this chat/topic.' };
      }

      case 'unbind': {
        const denied = requireBand('manage_gateway_route');
        if (denied) return denied;
        const unbound = ctx.onUnbind ? await ctx.onUnbind({ chatId: ctx.chatId, threadId: ctx.threadId }) : true;
        return unbound
          ? { ok: true, code: 'UNBOUND', text: 'Route unbound. Existing Extalia sessions and histories are preserved.' }
          : { ok: false, code: 'UNBIND_REFUSED', text: 'No active route was unbound.' };
      }

      case 'new': {
        const denied = requireBand('submit_prompt');
        if (denied) return denied;
        const workspaceId = ctx.args.trim() || ctx.currentWorkspaceId;
        if (!workspaceId || !ctx.registeredWorkspaceIds.has(workspaceId)) {
          return { ok: false, code: 'WORKSPACE_REQUIRED', text: 'Select an authorized workspace first via /projects.' };
        }
        if (!ctx.onCreateSession) {
          return { ok: false, code: 'NOT_SUPPORTED', text: 'Creating a new session is not available for this connector.' };
        }
        const created = await ctx.onCreateSession({ workspaceId });
        return created.ok
          ? { ok: true, code: 'SESSION_CREATED', text: `Created managed session ${created.sessionId} in ${workspaceId}.` }
          : { ok: false, code: 'SESSION_CREATE_REFUSED', text: created.reason };
      }

      case 'sessions': {
        const denied = requireBand('read_status');
        if (denied) return denied;
        const scoped = (ctx.authorizedSessions ?? []).filter(
          s => ctx.registeredWorkspaceIds.has(s.workspaceId)
            && (!ctx.currentWorkspaceId || s.workspaceId === ctx.currentWorkspaceId),
        );
        if (scoped.length === 0) {
          return { ok: true, code: 'NO_SESSIONS', text: 'No authorized sessions found for the current workspace.' };
        }
        const policyRevision = ctx.currentPolicyRevision ?? 1;
        const callbackTokens = scoped.map(session => {
          const issued = this.issueCallbackAction({
            connectorId: ctx.connectorId,
            actorExternalId: ctx.externalActorId,
            chatId: ctx.chatId,
            threadId: ctx.threadId,
            workspaceId: session.workspaceId,
            sessionId: session.id,
            action: 'use-session',
            policyRevision,
            now: ctx.now,
          });
          return { label: `${session.title} (${session.state})`, callbackData: issued.callbackData };
        });
        return {
          ok: true,
          code: 'SESSIONS_OK',
          text: `Authorized sessions:\n${scoped.map(s => `- ${s.id}: ${s.title} [${s.state}]`).join('\n')}`,
          callbackTokens,
        };
      }

      case 'use': {
        const denied = requireBand('manage_own_session');
        if (denied) return denied;
        const sessionId = ctx.args.trim();
        const match = (ctx.authorizedSessions ?? []).find(
          s => s.id === sessionId && ctx.registeredWorkspaceIds.has(s.workspaceId),
        );
        if (!match) {
          return { ok: false, code: 'SESSION_NOT_AUTHORIZED', text: 'Requested session is not authorized or not found.' };
        }
        const changed = ctx.onUseSession
          ? await ctx.onUseSession({ chatId: ctx.chatId, threadId: ctx.threadId, sessionId: match.id })
          : true;
        return changed
          ? { ok: true, code: 'SESSION_SELECTED', text: `Active session set to ${match.title} (${match.id}).` }
          : { ok: false, code: 'SESSION_SELECT_REFUSED', text: 'Unable to switch active session.' };
      }

      case 'status': {
        const denied = requireBand('read_status');
        if (denied) return denied;
        if (!ctx.statusSnapshot) {
          return { ok: true, code: 'STATUS_IDLE', text: 'No active run is currently selected for this chat.' };
        }
        return {
          ok: true,
          code: 'STATUS_OK',
          text: `Run state: ${ctx.statusSnapshot.runState} | Last verified activity: ${ctx.statusSnapshot.lastVerifiedActivityAt ?? 'none'} | Confidence: ${ctx.statusSnapshot.confidence}`,
        };
      }

      case 'team': {
        const denied = requireBand('read_status');
        if (denied) return denied;
        const team = ctx.teamSnapshot ?? [];
        if (team.length === 0) {
          return { ok: true, code: 'TEAM_EMPTY', text: 'No active team members reported for this session.' };
        }
        return {
          ok: true,
          code: 'TEAM_OK',
          text: `Team:\n${team.map(m => `- ${m.name} (${m.role}): ${m.status}`).join('\n')}`,
        };
      }

      case 'tasks': {
        const denied = requireBand('read_status');
        if (denied) return denied;
        const tasks = ctx.taskSnapshot ?? [];
        if (tasks.length === 0) {
          return { ok: true, code: 'TASKS_EMPTY', text: 'No tracked tasks in the current session.' };
        }
        return {
          ok: true,
          code: 'TASKS_OK',
          text: `Tasks:\n${tasks.map(t => `- [${t.status}] ${t.title} (${t.id})`).join('\n')}`,
        };
      }

      case 'details': {
        const denied = requireBand('read_status');
        if (denied) return denied;
        return {
          ok: true,
          code: 'DETAILS_OK',
          text: `Bounded summary for session ${ctx.currentSessionId ?? 'unselected'}. Open the authenticated Extalia UI console for full logs and diffs.`,
        };
      }

      case 'schedule': {
        const denied = requireBand('manage_schedule');
        if (denied) return denied;
        const schedules = ctx.scheduleSummaries ?? [];
        if (schedules.length === 0) {
          return { ok: true, code: 'SCHEDULE_EMPTY', text: 'No schedules configured for this workspace.' };
        }
        return {
          ok: true,
          code: 'SCHEDULE_OK',
          text: `Schedules:\n${schedules.map(s => `- ${s.name} (${s.id}): ${s.enabled ? 'enabled' : 'paused'}${s.nextRunAt ? `, next ${s.nextRunAt}` : ''}`).join('\n')}`,
        };
      }

      case 'reports': {
        const denied = requireBand('view_reports');
        if (denied) return denied;
        const reports = ctx.reportSummaries ?? [];
        if (reports.length === 0) {
          return { ok: true, code: 'REPORTS_EMPTY', text: 'No scoped workspace reports available yet.' };
        }
        return {
          ok: true,
          code: 'REPORTS_OK',
          text: reports.slice(0, 5).map(renderTelegramAutonomousReport).join('\n\n'),
        };
      }

      case 'pause': {
        const denied = requireBand('manage_own_session');
        if (denied) return denied;
        if (!ctx.currentWorkspaceId || !ctx.currentSessionId) {
          return { ok: false, code: 'SESSION_REQUIRED', text: 'No active session selected to pause.' };
        }
        const paused = ctx.onPause
          ? await ctx.onPause({ workspaceId: ctx.currentWorkspaceId, sessionId: ctx.currentSessionId })
          : true;
        return paused
          ? { ok: true, code: 'PAUSED', text: 'Inbound prompt submissions paused for this chat. Active execution is not cancelled.' }
          : { ok: false, code: 'PAUSE_REFUSED', text: 'Unable to pause submissions.' };
      }

      case 'cancel': {
        const denied = requireBand('manage_own_session');
        if (denied) return denied;
        if (!ctx.currentWorkspaceId || !ctx.currentSessionId) {
          return { ok: false, code: 'SESSION_REQUIRED', cancelStatus: 'unknown', text: 'No active session selected to cancel.' };
        }
        const status: TelegramCancelStatus = ctx.onCancel
          ? await ctx.onCancel({ workspaceId: ctx.currentWorkspaceId, sessionId: ctx.currentSessionId })
          : 'not_supported';
        const messageByStatus: Record<TelegramCancelStatus, string> = {
          request_sent: 'Cancellation request sent to Host runtime; waiting for runtime confirmation.',
          cancelled: 'Session turn cancelled and confirmed by Host runtime.',
          not_supported: 'Cancellation is not supported by this runtime; execution was NOT stopped.',
          already_finished: 'The target turn had already finished before cancellation.',
          unknown: 'Cancellation outcome is unknown; inspect Host runtime status in Extalia UI.',
        };
        return {
          ok: status === 'request_sent' || status === 'cancelled' || status === 'already_finished',
          code: `CANCEL_${status.toUpperCase()}`,
          cancelStatus: status,
          text: messageByStatus[status],
        };
      }

      case 'settings': {
        const profileArg = ctx.args.trim().toLowerCase();
        if (profileArg === 'quiet' || profileArg === 'balanced' || profileArg === 'detailed') {
          const saved = this.setChatSettings({
            connectorId: ctx.connectorId,
            chatId: ctx.chatId,
            threadId: ctx.threadId,
            profile: profileArg,
            now: ctx.now,
          });
          return {
            ok: true,
            code: 'SETTINGS_UPDATED',
            text: `Notification profile set to "${saved.profile}" for this chat.`,
          };
        }
        const current = this.getChatSettings(ctx.connectorId, ctx.chatId, ctx.threadId);
        return {
          ok: true,
          code: 'SETTINGS_OK',
          text: `Notification profile: ${current.profile}. Quiet hours: ${current.quietHoursEnabled ? 'on' : 'off'}. Use /settings quiet|balanced|detailed to update.`,
        };
      }
    }
  }

  setChatSettings(input: {
    connectorId: string;
    chatId: string;
    threadId?: string;
    profile: TelegramNotificationProfile;
    quietHoursEnabled?: boolean;
    quietStartHour?: number;
    quietEndHour?: number;
    timeZone?: string;
    now?: string;
  }): TelegramChatSettings {
    const now = input.now ?? this.nowFn();
    const threadKey = normalizeThreadKey(input.threadId);
    const settingKey = `${input.connectorId}::${input.chatId}::${threadKey}`;
    this.store.database.prepare(
      `INSERT INTO gateway_telegram_chat_settings(
        setting_key, connector_id, chat_id, thread_key, profile,
        quiet_hours_enabled, quiet_start_hour, quiet_end_hour, time_zone, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET
        profile = excluded.profile,
        quiet_hours_enabled = excluded.quiet_hours_enabled,
        quiet_start_hour = excluded.quiet_start_hour,
        quiet_end_hour = excluded.quiet_end_hour,
        time_zone = excluded.time_zone,
        updated_at = excluded.updated_at`,
    ).run(
      settingKey,
      input.connectorId,
      input.chatId,
      threadKey,
      input.profile,
      (input.quietHoursEnabled ?? false) ? 1 : 0,
      input.quietStartHour ?? null,
      input.quietEndHour ?? null,
      input.timeZone ?? null,
      now,
    );
    return this.getChatSettings(input.connectorId, input.chatId, input.threadId);
  }

  getChatSettings(connectorId: string, chatId: string, threadId?: string): TelegramChatSettings {
    const threadKey = normalizeThreadKey(threadId);
    const settingKey = `${connectorId}::${chatId}::${threadKey}`;
    const row = this.store.database
      .prepare('SELECT * FROM gateway_telegram_chat_settings WHERE setting_key = ?')
      .get(settingKey) as Record<string, unknown> | undefined;
    if (!row) {
      return {
        connectorId,
        chatId,
        ...(threadKey ? { threadId: threadKey } : {}),
        profile: 'balanced',
        quietHoursEnabled: false,
        updatedAt: this.nowFn(),
      };
    }
    return {
      connectorId: String(row.connector_id),
      chatId: String(row.chat_id),
      ...(String(row.thread_key) ? { threadId: String(row.thread_key) } : {}),
      profile: String(row.profile) as TelegramNotificationProfile,
      quietHoursEnabled: Number(row.quiet_hours_enabled) === 1,
      quietStartHour: row.quiet_start_hour !== null && row.quiet_start_hour !== undefined ? Number(row.quiet_start_hour) : undefined,
      quietEndHour: row.quiet_end_hour !== null && row.quiet_end_hour !== undefined ? Number(row.quiet_end_hour) : undefined,
      timeZone: row.time_zone ? String(row.time_zone) : undefined,
      updatedAt: String(row.updated_at),
    };
  }

  /**
   * Resolves a Telegram DM inbound text message: if no active session is selected in a private DM,
   * refuses to guess a project and asks the user to select a session (GW-AT-040).
   */
  resolvePrivateDmSessionSelection(input: {
    connectorId: string;
    chatId: string;
    threadId?: string;
    selectedSessionId?: string;
    eligibleSessionCount: number;
  }):
    | { ok: true; sessionId: string }
    | { ok: false; code: 'SESSION_SELECTION_REQUIRED'; prompt: string } {
    if (input.selectedSessionId) {
      return { ok: true, sessionId: input.selectedSessionId };
    }
    const prompt = input.eligibleSessionCount > 0
      ? 'No active session is selected for this private chat. Run /sessions to pick a workspace session before sending instructions.'
      : 'No active session is bound to this private chat. Use /projects and /new to start an authorized session.';
    return { ok: false, code: 'SESSION_SELECTION_REQUIRED', prompt };
  }

  /**
   * Resolves a reply to a bot-posted worker summary via stored `remoteMessageId` receipt,
   * always routing through Lead and refusing cross-workspace targets (GW-AT-046).
   */
  resolveWorkerReplyContext(input: {
    connectorId: string;
    replyToRemoteMessageId: string;
    expectedWorkspaceId: string;
  }):
    | { ok: true; receipt: RemoteMessageReceiptRecord; delegateViaLead: true }
    | { ok: false; code: string; reason: string } {
    if (!this.routing) {
      return { ok: false, code: 'ROUTING_UNAVAILABLE', reason: 'Routing service is required to resolve reply receipts.' };
    }
    return this.routing.resolveReplyTarget(input);
  }

  /**
   * Sends an approved outbound intent via Telegram `sendMessage`.
   * Classifies 429 retry_after, 403 permanent-blocked, and ambiguous network timeouts accurately.
   */
  async send(approved: ApprovedOutbound): Promise<RemoteSendReceipt> {
    const connector = this.store.getConnector(approved.intent.connectorId);
    if (!connector) {
      throw new TelegramApiError('permanent-blocked', `Connector "${approved.intent.connectorId}" not found.`);
    }
    const destination = this.resolveBindingDestination(approved.intent.targetBindingId);
    if (!destination) {
      throw new TelegramApiError(
        'permanent-blocked',
        `Target binding "${approved.intent.targetBindingId}" not found or inactive; refusing fallback.`,
      );
    }

    const token = await this.resolveBotToken(connector.secretRef);
    const formatted = formatTelegramText(approved.safeText);
    const now = this.nowFn();
    let lastMessageId = '';

    for (const chunk of formatted.chunks) {
      const payload: Record<string, unknown> = {
        chat_id: destination.chatId,
        text: chunk,
        disable_web_page_preview: true,
        ...(destination.threadId ? { message_thread_id: Number(destination.threadId) || destination.threadId } : {}),
        ...(formatted.parseMode ? { parse_mode: formatted.parseMode } : {}),
      };

      const sent = await this.callTelegramApi<{ message_id: number }>(token, 'sendMessage', payload);
      lastMessageId = String(sent.message_id);
    }

    if (this.routing && destination.workspaceId && destination.sessionId) {
      this.routing.recordRemoteReceipt({
        provider: 'telegram',
        connectorId: approved.intent.connectorId,
        remoteMessageId: lastMessageId,
        providerAccountId: connector.providerAccountId,
        channelId: destination.chatId,
        threadId: destination.threadId,
        workspaceId: destination.workspaceId,
        sessionId: destination.sessionId,
        sourceEventId: approved.intent.sourceEventId,
        senderSnapshot: {
          senderKind: approved.intent.senderKind,
          ...(approved.intent.senderPortrait ? { portrait: approved.intent.senderPortrait } : {}),
        },
        acceptedAt: now,
      });
    }

    this.lastConnectorId = approved.intent.connectorId;
    this.lastTransportHeartbeatAt = now;

    return {
      connectorId: approved.intent.connectorId,
      provider: 'telegram',
      remoteMessageId: lastMessageId,
      acceptedAt: now,
      state: 'accepted',
    };
  }

  /**
   * Edits an existing bot-owned Telegram message via `editMessageText`.
   */
  async edit(receipt: RemoteSendReceipt, approved: ApprovedOutbound): Promise<RemoteSendReceipt> {
    const connector = this.store.getConnector(approved.intent.connectorId);
    if (!connector) {
      throw new TelegramApiError('permanent-blocked', `Connector "${approved.intent.connectorId}" not found.`);
    }
    const destination = this.resolveBindingDestination(approved.intent.targetBindingId);
    if (!destination) {
      throw new TelegramApiError(
        'permanent-blocked',
        `Target binding "${approved.intent.targetBindingId}" not found or inactive.`,
      );
    }

    const token = await this.resolveBotToken(connector.secretRef);
    const formatted = formatTelegramText(approved.safeText);
    const now = this.nowFn();

    await this.callTelegramApi<{ message_id: number }>(token, 'editMessageText', {
      chat_id: destination.chatId,
      message_id: Number(receipt.remoteMessageId) || receipt.remoteMessageId,
      text: formatted.chunks[0] ?? '',
      disable_web_page_preview: true,
      ...(formatted.parseMode ? { parse_mode: formatted.parseMode } : {}),
    });

    return {
      connectorId: approved.intent.connectorId,
      provider: 'telegram',
      remoteMessageId: receipt.remoteMessageId,
      acceptedAt: now,
      state: 'accepted',
    };
  }

  /**
   * Creates or edits a single pinned status card per `(bindingId, runId)` (GW-AT-051).
   * If editing an old/deleted message fails with a recoverable edit error, posts ONE fresh
   * bounded status card and updates the stored message ID rather than spamming infinitely.
   * If `403` blocked, marks the destination blocked with zero fallback.
   */
  async upsertStatusCard(input: {
    bindingId: string;
    runId: string;
    approved: ApprovedOutbound;
    now?: string;
  }): Promise<{ action: 'created' | 'edited' | 'replaced-after-edit-failure'; receipt: RemoteSendReceipt }> {
    const now = input.now ?? this.nowFn();
    const connectorId = input.approved.intent.connectorId;
    const destination = this.resolveBindingDestination(input.bindingId);
    if (!destination) {
      throw new TelegramApiError('permanent-blocked', `Binding "${input.bindingId}" unavailable.`);
    }

    const cardKey = `${connectorId}::${input.bindingId}::${input.runId}`;
    const existing = this.store.database
      .prepare('SELECT * FROM gateway_telegram_status_cards WHERE card_key = ?')
      .get(cardKey) as Record<string, unknown> | undefined;

    if (!existing) {
      const receipt = await this.send(input.approved);
      this.store.database.prepare(
        `INSERT INTO gateway_telegram_status_cards(
          card_key, connector_id, binding_id, run_id, chat_id, thread_key,
          remote_message_id, revision, last_milestone_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        cardKey,
        connectorId,
        input.bindingId,
        input.runId,
        destination.chatId,
        normalizeThreadKey(destination.threadId),
        receipt.remoteMessageId,
        now,
        now,
      );
      return { action: 'created', receipt };
    }

    const existingReceipt: RemoteSendReceipt = {
      connectorId,
      provider: 'telegram',
      remoteMessageId: String(existing.remote_message_id),
      acceptedAt: String(existing.updated_at),
      state: 'accepted',
    };

    try {
      const edited = await this.edit(existingReceipt, input.approved);
      this.store.database.prepare(
        `UPDATE gateway_telegram_status_cards
         SET revision = revision + 1, last_milestone_at = ?, updated_at = ?
         WHERE card_key = ?`,
      ).run(now, now, cardKey);
      return { action: 'edited', receipt: edited };
    } catch (error) {
      if (error instanceof TelegramApiError && error.classification === 'permanent-blocked') {
        this.handleDestinationBlocked({
          connectorId,
          chatId: destination.chatId,
          bindingId: input.bindingId,
          reason: error.message,
          now,
        });
        throw error;
      }
      if (error instanceof TelegramApiError && error.classification === 'edit-failed') {
        // Post one fresh bounded status card and update the pinned message ID (GW-AT-051).
        const fresh = await this.send(input.approved);
        this.store.database.prepare(
          `UPDATE gateway_telegram_status_cards
           SET remote_message_id = ?, revision = revision + 1, last_milestone_at = ?, updated_at = ?
           WHERE card_key = ?`,
        ).run(fresh.remoteMessageId, now, now, cardKey);
        return { action: 'replaced-after-edit-failure', receipt: fresh };
      }
      throw error;
    }
  }

  /**
   * Dispatches a claimed outbox intent through Telegram Bot API and records the exact
   * outbox classification (`accepted`, `rate-limited` with `retry_after`, `permanent-blocked`
   * on `403`, `retryable`, or `ambiguous-timeout` -> `unknown` quarantine) (GW-AT-052, GW-AT-053).
   */
  async dispatchClaimedOutboxIntent(input: {
    approved: ApprovedOutbound;
    leaseOwner: string;
    now?: string;
  }): Promise<{ ok: boolean; classification: string; remoteMessageId?: string; retryAfterSeconds?: number }> {
    const now = input.now ?? this.nowFn();
    if (!this.outbox) {
      throw new Error('GatewayOutboxService is required for dispatchClaimedOutboxIntent.');
    }

    try {
      const receipt = await this.send(input.approved);
      this.outbox.recordSendResult({
        kind: 'accepted',
        intentId: input.approved.intent.id,
        fencingToken: input.approved.fencingToken,
        leaseOwner: input.leaseOwner,
        providerRequestKey: input.approved.providerRequestKey,
        remoteMessageId: receipt.remoteMessageId,
        httpStatus: 200,
        now,
      });
      return { ok: true, classification: 'accepted', remoteMessageId: receipt.remoteMessageId };
    } catch (error) {
      if (error instanceof TelegramApiError) {
        if (error.classification === 'rate-limited') {
          const retryAfterSeconds = Math.max(1, error.retryAfterSeconds ?? 5);
          this.outbox.recordSendResult({
            kind: 'rate-limited',
            intentId: input.approved.intent.id,
            fencingToken: input.approved.fencingToken,
            leaseOwner: input.leaseOwner,
            providerRequestKey: input.approved.providerRequestKey,
            httpStatus: error.httpStatus ?? 429,
            retryAfterSeconds,
            errorMessage: error.message,
            now,
          });
          return { ok: false, classification: 'rate-limited', retryAfterSeconds };
        }

        if (error.classification === 'permanent-blocked') {
          const dest = this.resolveBindingDestination(input.approved.intent.targetBindingId);
          this.outbox.recordSendResult({
            kind: 'permanent-blocked',
            intentId: input.approved.intent.id,
            fencingToken: input.approved.fencingToken,
            leaseOwner: input.leaseOwner,
            providerRequestKey: input.approved.providerRequestKey,
            httpStatus: error.httpStatus ?? 403,
            errorMessage: error.message,
            now,
          });
          if (dest) {
            this.handleDestinationBlocked({
              connectorId: input.approved.intent.connectorId,
              chatId: dest.chatId,
              bindingId: input.approved.intent.targetBindingId,
              reason: error.message,
              now,
            });
          }
          return { ok: false, classification: 'permanent-blocked' };
        }

        if (error.classification === 'ambiguous-timeout') {
          this.outbox.recordSendResult({
            kind: 'ambiguous-timeout',
            intentId: input.approved.intent.id,
            fencingToken: input.approved.fencingToken,
            leaseOwner: input.leaseOwner,
            providerRequestKey: input.approved.providerRequestKey,
            errorMessage: error.message,
            now,
          });
          return { ok: false, classification: 'ambiguous-timeout' };
        }

        this.outbox.recordSendResult({
          kind: 'retryable',
          intentId: input.approved.intent.id,
          fencingToken: input.approved.fencingToken,
          leaseOwner: input.leaseOwner,
          providerRequestKey: input.approved.providerRequestKey,
          httpStatus: error.httpStatus,
          errorMessage: error.message,
          now,
        });
        return { ok: false, classification: 'retryable' };
      }

      const message = error instanceof Error ? error.message : String(error);
      this.outbox.recordSendResult({
        kind: 'ambiguous-timeout',
        intentId: input.approved.intent.id,
        fencingToken: input.approved.fencingToken,
        leaseOwner: input.leaseOwner,
        providerRequestKey: input.approved.providerRequestKey,
        errorMessage: message,
        now,
      });
      return { ok: false, classification: 'ambiguous-timeout' };
    }
  }

  /**
   * Permanently disables a blocked/kicked Telegram destination without falling back
   * to any other chat or topic (PRD §9.8, GW-AT-053).
   */
  handleDestinationBlocked(input: {
    connectorId: string;
    chatId: string;
    bindingId?: string;
    reason: string;
    now: string;
  }): void {
    this.lastTransportError = input.reason;
    this.store.transaction(() => {
      if (input.bindingId) {
        this.store.database.prepare(
          `UPDATE gateway_bindings
           SET state = 'destination-lost', updated_at = ?
           WHERE id = ? AND state = 'active'`,
        ).run(input.now, input.bindingId);
      } else {
        this.store.database.prepare(
          `UPDATE gateway_bindings
           SET state = 'destination-lost', updated_at = ?
           WHERE connector_id = ? AND channel_id = ? AND state = 'active'`,
        ).run(input.now, input.connectorId, input.chatId);
      }

      this.store.database.prepare(
        `UPDATE gateway_routes
         SET state = 'destination-lost', updated_at = ?
         WHERE connector_id = ? AND channel_id = ? AND state = 'active'`,
      ).run(input.now, input.connectorId, input.chatId);

      this.store.recordAudit({
        actor: 'host:telegram',
        action: 'telegram.destination.blocked',
        resource: `chat:${input.chatId}`,
        outcome: 'blocked',
        reason: input.reason,
        at: input.now,
      });
    });

    if (this.outbox && input.bindingId) {
      this.outbox.cancelPendingForBinding({
        targetBindingId: input.bindingId,
        reason: input.reason,
        actor: 'host:telegram',
        now: input.now,
      });
    }
  }

  async health(): Promise<ConnectorHealth> {
    const now = this.nowFn();
    const connectorId = this.lastConnectorId ?? 'telegram-unconfigured';
    const connector = this.lastConnectorId ? this.store.getConnector(this.lastConnectorId) : undefined;
    const connectorState: GatewayConnectorState = connector?.status ?? 'disabled';

    const transportStatus: ConnectorHealthDimension =
      connectorState === 'connected'
        ? { status: 'healthy', observedAt: this.lastTransportHeartbeatAt ?? now }
        : connectorState === 'blocked'
          ? { status: 'blocked', observedAt: now, detail: this.lastTransportError }
          : { status: 'disconnected', observedAt: now, detail: this.lastTransportError };

    return aggregateConnectorHealth({
      connectorId,
      provider: 'telegram',
      connectorState,
      transport: transportStatus,
      host: { status: 'healthy', observedAt: now },
      runtime: { status: 'unknown', observedAt: now },
      progress: { status: 'unknown', observedAt: now },
      notification: {
        status: this.lastTransportError ? 'degraded' : connectorState === 'connected' ? 'healthy' : 'unknown',
        observedAt: now,
        ...(this.lastTransportError ? { detail: sanitizeGatewayText(this.lastTransportError, { maxLength: 300 }).text } : {}),
      },
      ...(this.lastTransportHeartbeatAt ? { lastTransportHeartbeatAt: this.lastTransportHeartbeatAt } : {}),
      lastHostHeartbeatAt: now,
      checkedAt: now,
    });
  }

  private resolveBindingDestination(
    targetBindingId: string,
  ): { chatId: string; threadId?: string; workspaceId: string; sessionId?: string } | undefined {
    const bindingRow = this.store.database
      .prepare("SELECT channel_id, thread_key, workspace_id, session_id FROM gateway_bindings WHERE id = ? AND state = 'active'")
      .get(targetBindingId) as Record<string, unknown> | undefined;
    if (bindingRow) {
      const threadKey = String(bindingRow.thread_key);
      return {
        chatId: String(bindingRow.channel_id),
        ...(threadKey ? { threadId: threadKey } : {}),
        workspaceId: String(bindingRow.workspace_id),
        sessionId: String(bindingRow.session_id),
      };
    }

    const routeRow = this.store.database
      .prepare("SELECT channel_id, thread_key, workspace_id FROM gateway_routes WHERE id = ? AND state = 'active'")
      .get(targetBindingId) as Record<string, unknown> | undefined;
    if (routeRow) {
      const threadKey = String(routeRow.thread_key);
      return {
        chatId: String(routeRow.channel_id),
        ...(threadKey ? { threadId: threadKey } : {}),
        workspaceId: String(routeRow.workspace_id),
      };
    }

    return undefined;
  }

  private async callTelegramApi<T>(
    token: string,
    method: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.apiBaseUrl}/bot${token}/${method}`;
    let response: Awaited<ReturnType<TelegramFetch>>;
    try {
      response = await this.fetchImpl(url, {
        method: body ? 'POST' : 'GET',
        ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TelegramApiError(
        'ambiguous-timeout',
        `Telegram ${method} transport error: ${sanitizeGatewayText(message, { maxLength: 300 }).text}`,
      );
    }

    let parsed: {
      ok?: boolean;
      result?: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };
    try {
      parsed = (await response.json()) as typeof parsed;
    } catch {
      throw new TelegramApiError(
        response.status >= 500 ? 'retryable' : 'invalid-response',
        `Telegram ${method} returned non-JSON response (HTTP ${response.status}).`,
        response.status,
      );
    }

    const status = parsed.error_code ?? response.status;
    if (response.ok && parsed.ok === true && parsed.result !== undefined) {
      return parsed.result;
    }

    const description = sanitizeGatewayText(parsed.description ?? `HTTP ${status}`, { maxLength: 300 }).text;

    if (status === 429) {
      const retryAfter = Number(parsed.parameters?.retry_after ?? 5);
      throw new TelegramApiError(
        'rate-limited',
        `Telegram 429 rate limit on ${method}: ${description}`,
        429,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5,
      );
    }

    if (
      status === 403
      || /bot was blocked|bot was kicked|chat not found|user is deactivated|message thread not found/i.test(description)
    ) {
      throw new TelegramApiError(
        'permanent-blocked',
        `Telegram permanent block on ${method}: ${description}`,
        status,
      );
    }

    if (
      method === 'editMessageText'
      && status === 400
      && /message is not modified/i.test(description)
    ) {
      return { message_id: Number(body?.message_id ?? 0) } as unknown as T;
    }

    if (
      method === 'editMessageText'
      && status === 400
      && /message to edit not found|message can't be edited/i.test(description)
    ) {
      throw new TelegramApiError(
        'edit-failed',
        `Telegram edit failed on ${method}: ${description}`,
        400,
      );
    }

    if (status >= 500) {
      throw new TelegramApiError('retryable', `Telegram server error on ${method}: ${description}`, status);
    }

    throw new TelegramApiError('invalid-response', `Telegram ${method} failed (${status}): ${description}`, status);
  }
}
