/**
 * Provider-neutral Universal Gateway v2 contracts, runtime validators, and
 * redaction helpers (PRD §12, §13, §15, §16; ADR 0098).
 *
 * Browser-safe: zero Node built-ins or runtime/provider imports.
 */

export type GatewayProvider = 'discord' | 'telegram' | 'whatsapp' | (string & {});

export type DetailLevel = 'detailed' | 'milestone' | 'report';

export type GatewayPermissionBand =
  | 'read_status'
  | 'view_reports'
  | 'submit_prompt'
  | 'manage_own_session'
  | 'manage_schedule'
  | 'manage_gateway_route'
  | 'approve_sensitive_action';

export type GatewayConnectorState =
  | 'disabled'
  | 'configuring'
  | 'connected'
  | 'degraded'
  | 'blocked'
  | 'revoked';

export type GatewayAudience = 'private' | 'team' | 'public';

export type GatewayRouteMode = 'explicit-only' | 'thread-new-session' | 'reuse-pinned';

export type GatewayBindingState = 'active' | 'paused' | 'destination-lost' | 'revoked';

export type GatewayInboundActorKind = 'human' | 'bot' | 'webhook' | 'unknown';

export type GatewayInboundKind = 'command' | 'text' | 'callback' | 'attachment' | 'lifecycle';

export interface GatewayInboundEvent {
  schema: 'extalia.gateway.inbound.v1';
  connectorId: string;
  provider: GatewayProvider;
  providerEventId: string;
  providerAccountId: string;
  channelId: string;
  threadId?: string;
  externalActorId: string;
  actorKind: GatewayInboundActorKind;
  remoteMessageId?: string;
  replyToRemoteMessageId?: string;
  kind: GatewayInboundKind;
  text?: string;
  receivedAt: string;
  authenticatedTransportReceipt: string;
}

export interface GatewayRouteBinding {
  id: string;
  connectorId: string;
  providerAccountId: string;
  channelId: string;
  threadId?: string;
  workspaceId: string;
  sessionId?: string;
  mode: GatewayRouteMode;
  policyRevision: number;
  audience: GatewayAudience;
  state: GatewayBindingState;
}

export interface AgentPortraitIdentity {
  workspaceId: string;
  sessionId: string;
  agentId: string;
  kind: 'lead' | 'worker';
  name: string;
  role: string;
  teamMemberId?: string;
  appearanceHash?: string;
  portraitAssetId?: string;
  portraitRevision?: string;
  profileRevision?: number;
  provenance: 'host-team-roster' | 'verified-runtime-identity';
}

export type GatewayProjectEventCategory =
  | 'agent-message'
  | 'worker-activity'
  | 'execution-health'
  | 'approval'
  | 'terminal'
  | 'autonomous-report';

export type GatewayEvidenceProvenance =
  | 'host-receipt'
  | 'runtime-observed'
  | 'model-reported';

export type GatewayVerificationState =
  | 'verified'
  | 'unverified'
  | 'unknown'
  | 'not-applicable';

export interface GatewayProjectEvent {
  sourceEventId: string;
  workspaceId: string;
  sessionId: string;
  runId?: string;
  agentId?: string;
  taskId?: string;
  category: GatewayProjectEventCategory;
  provenance: GatewayEvidenceProvenance;
  verification: GatewayVerificationState;
  safeText: string;
  at: string;
}

export type AutonomousReportSource =
  | 'learning'
  | 'knowledge-build'
  | 'knowledge-meeting'
  | 'skills'
  | 'scheduled-maintenance'
  | 'schedule-run';

export type AutonomousReportTargetPolicy =
  | 'latest-eligible-in-source-workspace'
  | 'pinned-then-latest-eligible'
  | 'source-session-only'
  | 'inbox-only';

export type AutonomousReportTargetSelection =
  | 'pinned'
  | 'last-eligible'
  | 'source-only'
  | 'inbox';

export type AutonomousReportOutcome =
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'unknown';

export interface WorkspaceSystemReportKnowledge {
  state: 'saved' | 'unchanged' | 'partial' | 'failed' | 'skipped';
  indexed?: boolean;
  artifactReceiptIds?: string[];
}

export interface WorkspaceSystemReportSkill {
  packageId: string;
  revisionId: string;
  state:
    | 'candidate-saved'
    | 'inspection-pending'
    | 'review-required'
    | 'active-confirmed'
    | 'failed'
    | 'unknown';
  activationPerformed: boolean;
}

export interface WorkspaceSystemReportMeeting {
  outcome: 'completed' | 'cancelled' | 'failed' | 'unknown';
  meetingId?: string;
  knowledge: 'saved' | 'unavailable' | 'failed';
  indexed?: boolean;
  artifactReceiptId?: string;
}

export interface WorkspaceSystemReport {
  id: string;
  revision: number;
  source: AutonomousReportSource;
  sourceJobId: string;
  sourceRunId?: string;
  workspaceId: string;
  vaultProfileId?: string;
  vaultProfileRevision?: string;
  sourceSessionId?: string;
  targetChatId?: string;
  targetSelection: AutonomousReportTargetSelection;
  outcome: AutonomousReportOutcome;
  knowledge?: WorkspaceSystemReportKnowledge;
  skills?: WorkspaceSystemReportSkill[];
  meeting?: WorkspaceSystemReportMeeting;
  problems?: string[];
  maintenanceIntentKey?: string;
  committedAt: string;
  lastUpdatedAt: string;
  audienceScopeId: string;
}

export type GatewayOutboundPriority = 'P0' | 'P1' | 'P2' | 'P3';

export type GatewayOutboundMessageClass =
  | 'accepted'
  | 'milestone'
  | 'heartbeat'
  | 'attention'
  | 'terminal'
  | 'system-report';

export type GatewayOutboundState =
  | 'pending'
  | 'leased'
  | 'sending'
  | 'accepted'
  | 'delivered'
  | 'read'
  | 'blocked'
  | 'failed'
  | 'unknown';

export interface GatewayOutboundIntent {
  id: string;
  connectorId: string;
  targetBindingId: string;
  targetBindingRevision: number;
  sourceEventId?: string;
  reportId?: string;
  reportRevision?: number;
  senderKind: 'gateway-system' | 'lead' | 'worker';
  senderPortrait?: AgentPortraitIdentity;
  format: DetailLevel;
  messageClass: GatewayOutboundMessageClass;
  priority?: GatewayOutboundPriority;
  recipientId?: string;
  payloadDigest: string;
  policyEvaluationId: string;
  state: GatewayOutboundState;
  remoteMessageId?: string;
  lastProviderError?: string;
  retryAfterAt?: string;
}

export interface GatewayCapabilities {
  provider: GatewayProvider;
  revision: number;
  receiveCommands: boolean;
  createOrResumeSession: boolean;
  perAgentWebhookPortraits: boolean;
  editMessages: boolean;
  replyReceipts: boolean;
  threadsOrTopics: boolean;
  attachments: boolean;
  deliveryCallbacks: boolean;
  supportsCancel: boolean;
  requiresComplianceGate: boolean;
  maxMessageLength: number;
}

export type ExecutionHealthState =
  | 'queued'
  | 'admitted'
  | 'running'
  | 'waiting_approval'
  | 'suspected_stalled'
  | 'runtime_unreachable'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export type HealthDimensionStatus =
  | 'healthy'
  | 'degraded'
  | 'blocked'
  | 'disconnected'
  | 'unknown'
  | 'verification_insufficient';

export interface ConnectorHealthDimension {
  status: HealthDimensionStatus;
  observedAt?: string;
  detail?: string;
}

/** Five separate health dimensions (PRD §12.1); never collapsed into one boolean. */
export interface ConnectorHealth {
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

export interface RawVerifiedTransport {
  connectorId: string;
  provider: GatewayProvider;
  receivedAt: string;
  authenticatedTransportReceipt: string;
  headers: Readonly<Record<string, string>>;
  rawBody: string;
}

export interface VerifiedProviderBatch {
  connectorId: string;
  provider: GatewayProvider;
  authenticatedTransportReceipt: string;
  receivedAt: string;
  events: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

export interface ApprovedOutbound {
  intent: Readonly<GatewayOutboundIntent>;
  safeText: string;
  disableMentions: boolean;
  fencingToken: string;
  providerRequestKey: string;
}

export interface RemoteSendReceipt {
  connectorId: string;
  provider: GatewayProvider;
  remoteMessageId: string;
  acceptedAt: string;
  state: 'accepted' | 'delivered' | 'read';
}

/** Provider-neutral adapter boundary (PRD §13). No workspace, tool, skill, or Host creation authority. */
export interface GatewayAdapter {
  readonly provider: GatewayProvider;
  capabilities(connectorId: string): Promise<Readonly<GatewayCapabilities>>;
  authenticateInbound(request: RawVerifiedTransport): Promise<VerifiedProviderBatch>;
  normalize(batch: VerifiedProviderBatch): GatewayInboundEvent[];
  send(intent: ApprovedOutbound): Promise<RemoteSendReceipt>;
  edit?(receipt: RemoteSendReceipt, intent: ApprovedOutbound): Promise<RemoteSendReceipt>;
  health(): Promise<ConnectorHealth>;
}

export type GatewayValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CONTROL_CHAR_PATTERN = /(?!\t|\n|\r)\p{Cc}/u;

const DETAIL_LEVELS = new Set<string>(['detailed', 'milestone', 'report']);
const ACTOR_KINDS = new Set<string>(['human', 'bot', 'webhook', 'unknown']);
const INBOUND_KINDS = new Set<string>(['command', 'text', 'callback', 'attachment', 'lifecycle']);
const ROUTE_MODES = new Set<string>(['explicit-only', 'thread-new-session', 'reuse-pinned']);
const AUDIENCES = new Set<string>(['private', 'team', 'public']);
const BINDING_STATES = new Set<string>(['active', 'paused', 'destination-lost', 'revoked']);
const CONNECTOR_STATES = new Set<string>(['disabled', 'configuring', 'connected', 'degraded', 'blocked', 'revoked']);
const PORTRAIT_KINDS = new Set<string>(['lead', 'worker']);
const PORTRAIT_PROVENANCES = new Set<string>(['host-team-roster', 'verified-runtime-identity']);
const PROJECT_CATEGORIES = new Set<string>(['agent-message', 'worker-activity', 'execution-health', 'approval', 'terminal', 'autonomous-report']);
const EVIDENCE_PROVENANCES = new Set<string>(['host-receipt', 'runtime-observed', 'model-reported']);
const VERIFICATION_STATES = new Set<string>(['verified', 'unverified', 'unknown', 'not-applicable']);
const REPORT_SOURCES = new Set<string>(['learning', 'knowledge-build', 'knowledge-meeting', 'skills', 'scheduled-maintenance', 'schedule-run']);
const REPORT_TARGET_SELECTIONS = new Set<string>(['pinned', 'last-eligible', 'source-only', 'inbox']);
const REPORT_OUTCOMES = new Set<string>(['completed', 'partial', 'failed', 'cancelled', 'skipped', 'unknown']);
const KNOWLEDGE_STATES = new Set<string>(['saved', 'unchanged', 'partial', 'failed', 'skipped']);
const SKILL_STATES = new Set<string>(['candidate-saved', 'inspection-pending', 'review-required', 'active-confirmed', 'failed', 'unknown']);
const MEETING_OUTCOMES = new Set<string>(['completed', 'cancelled', 'failed', 'unknown']);
const MEETING_KNOWLEDGE_STATES = new Set<string>(['saved', 'unavailable', 'failed']);
const SENDER_KINDS = new Set<string>(['gateway-system', 'lead', 'worker']);
const MESSAGE_CLASSES = new Set<string>(['accepted', 'milestone', 'heartbeat', 'attention', 'terminal', 'system-report']);
const OUTBOUND_PRIORITIES = new Set<string>(['P0', 'P1', 'P2', 'P3']);
const OUTBOUND_STATES = new Set<string>(['pending', 'leased', 'sending', 'accepted', 'delivered', 'read', 'blocked', 'failed', 'unknown']);
const HEALTH_DIMENSION_STATUSES = new Set<string>(['healthy', 'degraded', 'blocked', 'disconnected', 'unknown', 'verification_insufficient']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOnlyKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>): string | null {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return `Unexpected field "${key}".`;
  }
  return null;
}

function isBoundedId(value: unknown, maxLen = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen && !CONTROL_CHAR_PATTERN.test(value);
}

function isOptionalBoundedId(value: unknown, maxLen = 200): value is string | undefined {
  return value === undefined || isBoundedId(value, maxLen);
}

function isBoundedText(value: unknown, maxLen = 16_000): value is string {
  return typeof value === 'string' && value.length <= maxLen && !value.includes('\0');
}

function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_UTC_PATTERN.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function isProviderName(value: unknown): value is GatewayProvider {
  return typeof value === 'string' && PROVIDER_PATTERN.test(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

const INBOUND_KEYS = new Set([
  'schema', 'connectorId', 'provider', 'providerEventId', 'providerAccountId',
  'channelId', 'threadId', 'externalActorId', 'actorKind', 'remoteMessageId',
  'replyToRemoteMessageId', 'kind', 'text', 'receivedAt', 'authenticatedTransportReceipt',
]);

export function validateGatewayInboundEvent(value: unknown): GatewayValidationResult<GatewayInboundEvent> {
  if (!isPlainObject(value)) return { ok: false, error: 'Inbound event must be a plain object.' };
  const extra = hasOnlyKeys(value, INBOUND_KEYS);
  if (extra) return { ok: false, error: extra };
  if (value.schema !== 'extalia.gateway.inbound.v1') return { ok: false, error: 'Unsupported inbound event schema.' };
  if (!isBoundedId(value.connectorId)) return { ok: false, error: 'Invalid connectorId.' };
  if (!isProviderName(value.provider)) return { ok: false, error: 'Invalid provider identifier.' };
  if (!isBoundedId(value.providerEventId)) return { ok: false, error: 'Invalid providerEventId.' };
  if (!isBoundedId(value.providerAccountId)) return { ok: false, error: 'Invalid providerAccountId.' };
  if (!isBoundedId(value.channelId)) return { ok: false, error: 'Invalid channelId.' };
  if (!isOptionalBoundedId(value.threadId)) return { ok: false, error: 'Invalid threadId.' };
  if (!isBoundedId(value.externalActorId)) return { ok: false, error: 'Invalid externalActorId.' };
  if (typeof value.actorKind !== 'string' || !ACTOR_KINDS.has(value.actorKind)) return { ok: false, error: 'Invalid actorKind.' };
  if (!isOptionalBoundedId(value.remoteMessageId)) return { ok: false, error: 'Invalid remoteMessageId.' };
  if (!isOptionalBoundedId(value.replyToRemoteMessageId)) return { ok: false, error: 'Invalid replyToRemoteMessageId.' };
  if (typeof value.kind !== 'string' || !INBOUND_KINDS.has(value.kind)) return { ok: false, error: 'Invalid inbound kind.' };
  if (value.text !== undefined && !isBoundedText(value.text, 16_000)) return { ok: false, error: 'Invalid or oversized inbound text.' };
  if (!isUtcTimestamp(value.receivedAt)) return { ok: false, error: 'Invalid UTC receivedAt timestamp.' };
  if (!isBoundedId(value.authenticatedTransportReceipt, 512)) return { ok: false, error: 'Missing authenticatedTransportReceipt.' };
  return { ok: true, value: value as unknown as GatewayInboundEvent };
}

const ROUTE_BINDING_KEYS = new Set([
  'id', 'connectorId', 'providerAccountId', 'channelId', 'threadId',
  'workspaceId', 'sessionId', 'mode', 'policyRevision', 'audience', 'state',
]);

export function validateGatewayRouteBinding(value: unknown): GatewayValidationResult<GatewayRouteBinding> {
  if (!isPlainObject(value)) return { ok: false, error: 'Route binding must be a plain object.' };
  const extra = hasOnlyKeys(value, ROUTE_BINDING_KEYS);
  if (extra) return { ok: false, error: extra };
  if (!isBoundedId(value.id)) return { ok: false, error: 'Invalid route binding id.' };
  if (!isBoundedId(value.connectorId)) return { ok: false, error: 'Invalid connectorId.' };
  if (!isBoundedId(value.providerAccountId)) return { ok: false, error: 'Invalid providerAccountId.' };
  if (!isBoundedId(value.channelId)) return { ok: false, error: 'Invalid channelId.' };
  if (!isOptionalBoundedId(value.threadId)) return { ok: false, error: 'Invalid threadId.' };
  if (!isBoundedId(value.workspaceId)) return { ok: false, error: 'Invalid workspaceId.' };
  if (!isOptionalBoundedId(value.sessionId)) return { ok: false, error: 'Invalid sessionId.' };
  if (typeof value.mode !== 'string' || !ROUTE_MODES.has(value.mode)) return { ok: false, error: 'Invalid route mode.' };
  if (!isPositiveInt(value.policyRevision)) return { ok: false, error: 'Invalid policyRevision.' };
  if (typeof value.audience !== 'string' || !AUDIENCES.has(value.audience)) return { ok: false, error: 'Invalid audience.' };
  if (typeof value.state !== 'string' || !BINDING_STATES.has(value.state)) return { ok: false, error: 'Invalid binding state.' };
  return { ok: true, value: value as unknown as GatewayRouteBinding };
}

const PORTRAIT_KEYS = new Set([
  'workspaceId', 'sessionId', 'agentId', 'kind', 'name', 'role',
  'teamMemberId', 'appearanceHash', 'portraitAssetId', 'portraitRevision',
  'profileRevision', 'provenance',
]);

export function validateAgentPortraitIdentity(value: unknown): GatewayValidationResult<AgentPortraitIdentity> {
  if (!isPlainObject(value)) return { ok: false, error: 'Agent portrait identity must be a plain object.' };
  const extra = hasOnlyKeys(value, PORTRAIT_KEYS);
  if (extra) return { ok: false, error: extra };
  if (!isBoundedId(value.workspaceId)) return { ok: false, error: 'Invalid workspaceId.' };
  if (!isBoundedId(value.sessionId)) return { ok: false, error: 'Invalid sessionId.' };
  if (!isBoundedId(value.agentId)) return { ok: false, error: 'Invalid agentId.' };
  if (typeof value.kind !== 'string' || !PORTRAIT_KINDS.has(value.kind)) return { ok: false, error: 'Invalid portrait kind.' };
  if (!isBoundedId(value.name, 120)) return { ok: false, error: 'Invalid portrait name.' };
  if (!isBoundedId(value.role, 120)) return { ok: false, error: 'Invalid portrait role.' };
  if (!isOptionalBoundedId(value.teamMemberId)) return { ok: false, error: 'Invalid teamMemberId.' };
  if (!isOptionalBoundedId(value.appearanceHash, 128)) return { ok: false, error: 'Invalid appearanceHash.' };
  if (!isOptionalBoundedId(value.portraitAssetId)) return { ok: false, error: 'Invalid portraitAssetId.' };
  if (!isOptionalBoundedId(value.portraitRevision, 128)) return { ok: false, error: 'Invalid portraitRevision.' };
  if (value.profileRevision !== undefined && !isPositiveInt(value.profileRevision)) return { ok: false, error: 'Invalid profileRevision.' };
  if (typeof value.provenance !== 'string' || !PORTRAIT_PROVENANCES.has(value.provenance)) return { ok: false, error: 'Invalid portrait provenance.' };
  return { ok: true, value: value as unknown as AgentPortraitIdentity };
}

const PROJECT_EVENT_KEYS = new Set([
  'sourceEventId', 'workspaceId', 'sessionId', 'runId', 'agentId', 'taskId',
  'category', 'provenance', 'verification', 'safeText', 'at',
]);

export function validateGatewayProjectEvent(value: unknown): GatewayValidationResult<GatewayProjectEvent> {
  if (!isPlainObject(value)) return { ok: false, error: 'Project event must be a plain object.' };
  const extra = hasOnlyKeys(value, PROJECT_EVENT_KEYS);
  if (extra) return { ok: false, error: extra };
  if (!isBoundedId(value.sourceEventId)) return { ok: false, error: 'Invalid sourceEventId.' };
  if (!isBoundedId(value.workspaceId)) return { ok: false, error: 'Invalid workspaceId.' };
  if (!isBoundedId(value.sessionId)) return { ok: false, error: 'Invalid sessionId.' };
  if (!isOptionalBoundedId(value.runId)) return { ok: false, error: 'Invalid runId.' };
  if (!isOptionalBoundedId(value.agentId)) return { ok: false, error: 'Invalid agentId.' };
  if (!isOptionalBoundedId(value.taskId)) return { ok: false, error: 'Invalid taskId.' };
  if (typeof value.category !== 'string' || !PROJECT_CATEGORIES.has(value.category)) return { ok: false, error: 'Invalid category.' };
  if (typeof value.provenance !== 'string' || !EVIDENCE_PROVENANCES.has(value.provenance)) return { ok: false, error: 'Invalid provenance.' };
  if (typeof value.verification !== 'string' || !VERIFICATION_STATES.has(value.verification)) return { ok: false, error: 'Invalid verification state.' };
  if (!isBoundedText(value.safeText, 8_000)) return { ok: false, error: 'Invalid safeText.' };
  if (!isUtcTimestamp(value.at)) return { ok: false, error: 'Invalid UTC at timestamp.' };
  return { ok: true, value: value as unknown as GatewayProjectEvent };
}

const REPORT_KEYS = new Set([
  'id', 'revision', 'source', 'sourceJobId', 'sourceRunId', 'workspaceId',
  'vaultProfileId', 'vaultProfileRevision', 'sourceSessionId', 'targetChatId',
  'targetSelection', 'outcome', 'knowledge', 'skills', 'meeting', 'problems',
  'maintenanceIntentKey', 'committedAt', 'lastUpdatedAt', 'audienceScopeId',
]);
const KNOWLEDGE_KEYS = new Set(['state', 'indexed', 'artifactReceiptIds']);
const SKILL_KEYS = new Set(['packageId', 'revisionId', 'state', 'activationPerformed']);
const MEETING_KEYS = new Set(['outcome', 'meetingId', 'knowledge', 'indexed', 'artifactReceiptId']);

export function validateWorkspaceSystemReport(value: unknown): GatewayValidationResult<WorkspaceSystemReport> {
  if (!isPlainObject(value)) return { ok: false, error: 'Workspace system report must be a plain object.' };
  const extra = hasOnlyKeys(value, REPORT_KEYS);
  if (extra) return { ok: false, error: extra };
  if (!isBoundedId(value.id)) return { ok: false, error: 'Invalid report id.' };
  if (!isPositiveInt(value.revision)) return { ok: false, error: 'Invalid report revision.' };
  if (typeof value.source !== 'string' || !REPORT_SOURCES.has(value.source)) return { ok: false, error: 'Invalid report source.' };
  if (!isBoundedId(value.sourceJobId)) return { ok: false, error: 'Invalid sourceJobId.' };
  if (!isOptionalBoundedId(value.sourceRunId)) return { ok: false, error: 'Invalid sourceRunId.' };
  if (!isBoundedId(value.workspaceId)) return { ok: false, error: 'Invalid workspaceId.' };
  if (!isOptionalBoundedId(value.vaultProfileId)) return { ok: false, error: 'Invalid vaultProfileId.' };
  if (!isOptionalBoundedId(value.vaultProfileRevision)) return { ok: false, error: 'Invalid vaultProfileRevision.' };
  if (!isOptionalBoundedId(value.sourceSessionId)) return { ok: false, error: 'Invalid sourceSessionId.' };
  if (!isOptionalBoundedId(value.targetChatId)) return { ok: false, error: 'Invalid targetChatId.' };
  if (typeof value.targetSelection !== 'string' || !REPORT_TARGET_SELECTIONS.has(value.targetSelection)) return { ok: false, error: 'Invalid targetSelection.' };
  if (value.targetSelection === 'inbox' && value.targetChatId !== undefined) return { ok: false, error: 'Inbox report must not set targetChatId.' };
  if (value.targetSelection !== 'inbox' && value.targetChatId === undefined) return { ok: false, error: 'Chat-projected report requires targetChatId.' };
  if (typeof value.outcome !== 'string' || !REPORT_OUTCOMES.has(value.outcome)) return { ok: false, error: 'Invalid outcome.' };
  if (value.knowledge !== undefined) {
    if (!isPlainObject(value.knowledge)) return { ok: false, error: 'Invalid knowledge section.' };
    const kExtra = hasOnlyKeys(value.knowledge, KNOWLEDGE_KEYS);
    if (kExtra) return { ok: false, error: kExtra };
    if (typeof value.knowledge.state !== 'string' || !KNOWLEDGE_STATES.has(value.knowledge.state)) return { ok: false, error: 'Invalid knowledge state.' };
    if (value.knowledge.indexed !== undefined && typeof value.knowledge.indexed !== 'boolean') return { ok: false, error: 'Invalid knowledge indexed flag.' };
    if (value.knowledge.artifactReceiptIds !== undefined) {
      if (!Array.isArray(value.knowledge.artifactReceiptIds) || value.knowledge.artifactReceiptIds.length > 100
        || !value.knowledge.artifactReceiptIds.every(item => isBoundedId(item))) return { ok: false, error: 'Invalid knowledge artifactReceiptIds.' };
    }
  }
  if (value.skills !== undefined) {
    if (!Array.isArray(value.skills) || value.skills.length > 50) return { ok: false, error: 'Invalid skills section.' };
    for (const skill of value.skills) {
      if (!isPlainObject(skill)) return { ok: false, error: 'Invalid skill entry.' };
      const sExtra = hasOnlyKeys(skill, SKILL_KEYS);
      if (sExtra) return { ok: false, error: sExtra };
      if (!isBoundedId(skill.packageId)) return { ok: false, error: 'Invalid skill packageId.' };
      if (!isBoundedId(skill.revisionId)) return { ok: false, error: 'Invalid skill revisionId.' };
      if (typeof skill.state !== 'string' || !SKILL_STATES.has(skill.state)) return { ok: false, error: 'Invalid skill state.' };
      if (typeof skill.activationPerformed !== 'boolean') return { ok: false, error: 'Invalid skill activationPerformed flag.' };
      if (skill.state !== 'active-confirmed' && skill.activationPerformed) {
        return { ok: false, error: 'Candidate skill cannot claim activationPerformed.' };
      }
    }
  }
  if (value.meeting !== undefined) {
    if (!isPlainObject(value.meeting)) return { ok: false, error: 'Invalid meeting section.' };
    const mExtra = hasOnlyKeys(value.meeting, MEETING_KEYS);
    if (mExtra) return { ok: false, error: mExtra };
    if (typeof value.meeting.outcome !== 'string' || !MEETING_OUTCOMES.has(value.meeting.outcome)) return { ok: false, error: 'Invalid meeting outcome.' };
    if (!isOptionalBoundedId(value.meeting.meetingId)) return { ok: false, error: 'Invalid meetingId.' };
    if (typeof value.meeting.knowledge !== 'string' || !MEETING_KNOWLEDGE_STATES.has(value.meeting.knowledge)) return { ok: false, error: 'Invalid meeting knowledge state.' };
    if (value.meeting.indexed !== undefined && typeof value.meeting.indexed !== 'boolean') return { ok: false, error: 'Invalid meeting indexed flag.' };
    if (!isOptionalBoundedId(value.meeting.artifactReceiptId)) return { ok: false, error: 'Invalid meeting artifactReceiptId.' };
  }
  if (value.problems !== undefined) {
    if (!Array.isArray(value.problems) || value.problems.length > 32
      || !value.problems.every(item => typeof item === 'string' && item.length > 0 && item.length <= 500 && !CONTROL_CHAR_PATTERN.test(item))) {
      return { ok: false, error: 'Invalid problems list.' };
    }
  }
  if (!isOptionalBoundedId(value.maintenanceIntentKey, 128)) return { ok: false, error: 'Invalid maintenanceIntentKey.' };
  if (!isUtcTimestamp(value.committedAt)) return { ok: false, error: 'Invalid committedAt timestamp.' };
  if (!isUtcTimestamp(value.lastUpdatedAt)) return { ok: false, error: 'Invalid lastUpdatedAt timestamp.' };
  if (!isBoundedId(value.audienceScopeId)) return { ok: false, error: 'Invalid audienceScopeId.' };
  return { ok: true, value: value as unknown as WorkspaceSystemReport };
}

const OUTBOUND_KEYS = new Set([
  'id', 'connectorId', 'targetBindingId', 'targetBindingRevision',
  'sourceEventId', 'reportId', 'reportRevision', 'senderKind', 'senderPortrait',
  'format', 'messageClass', 'priority', 'recipientId', 'payloadDigest',
  'policyEvaluationId', 'state', 'remoteMessageId', 'lastProviderError', 'retryAfterAt',
]);

export function validateGatewayOutboundIntent(value: unknown): GatewayValidationResult<GatewayOutboundIntent> {
  if (!isPlainObject(value)) return { ok: false, error: 'Outbound intent must be a plain object.' };
  const extra = hasOnlyKeys(value, OUTBOUND_KEYS);
  if (extra) return { ok: false, error: extra };
  if (!isBoundedId(value.id)) return { ok: false, error: 'Invalid outbound intent id.' };
  if (!isBoundedId(value.connectorId)) return { ok: false, error: 'Invalid connectorId.' };
  if (!isBoundedId(value.targetBindingId)) return { ok: false, error: 'Invalid targetBindingId.' };
  if (!isPositiveInt(value.targetBindingRevision)) return { ok: false, error: 'Invalid targetBindingRevision.' };
  if (!isOptionalBoundedId(value.sourceEventId)) return { ok: false, error: 'Invalid sourceEventId.' };
  if (!isOptionalBoundedId(value.reportId)) return { ok: false, error: 'Invalid reportId.' };
  if (value.reportRevision !== undefined && !isPositiveInt(value.reportRevision)) return { ok: false, error: 'Invalid reportRevision.' };
  if (typeof value.senderKind !== 'string' || !SENDER_KINDS.has(value.senderKind)) return { ok: false, error: 'Invalid senderKind.' };
  if (value.senderPortrait !== undefined) {
    const portrait = validateAgentPortraitIdentity(value.senderPortrait);
    if (!portrait.ok) return { ok: false, error: `Invalid senderPortrait: ${portrait.error}` };
  }
  if (typeof value.format !== 'string' || !DETAIL_LEVELS.has(value.format)) return { ok: false, error: 'Invalid format.' };
  if (typeof value.messageClass !== 'string' || !MESSAGE_CLASSES.has(value.messageClass)) return { ok: false, error: 'Invalid messageClass.' };
  if (value.priority !== undefined && (typeof value.priority !== 'string' || !OUTBOUND_PRIORITIES.has(value.priority))) {
    return { ok: false, error: 'Invalid priority.' };
  }
  if (!isOptionalBoundedId(value.recipientId)) return { ok: false, error: 'Invalid recipientId.' };
  if (!isBoundedId(value.payloadDigest, 128)) return { ok: false, error: 'Invalid payloadDigest.' };
  if (!isBoundedId(value.policyEvaluationId)) return { ok: false, error: 'Invalid policyEvaluationId.' };
  if (typeof value.state !== 'string' || !OUTBOUND_STATES.has(value.state)) return { ok: false, error: 'Invalid outbound state.' };
  if (!isOptionalBoundedId(value.remoteMessageId)) return { ok: false, error: 'Invalid remoteMessageId.' };
  if (value.lastProviderError !== undefined && !isBoundedText(value.lastProviderError, 1000)) return { ok: false, error: 'Invalid lastProviderError.' };
  if (value.retryAfterAt !== undefined && !isUtcTimestamp(value.retryAfterAt)) return { ok: false, error: 'Invalid retryAfterAt timestamp.' };
  return { ok: true, value: value as unknown as GatewayOutboundIntent };
}

const CAPABILITY_KEYS = new Set([
  'provider', 'revision', 'receiveCommands', 'createOrResumeSession',
  'perAgentWebhookPortraits', 'editMessages', 'replyReceipts', 'threadsOrTopics',
  'attachments', 'deliveryCallbacks', 'supportsCancel', 'requiresComplianceGate',
  'maxMessageLength',
]);

export function validateGatewayCapabilities(value: unknown): GatewayValidationResult<GatewayCapabilities> {
  if (!isPlainObject(value)) return { ok: false, error: 'Capabilities must be a plain object.' };
  const extra = hasOnlyKeys(value, CAPABILITY_KEYS);
  if (extra) return { ok: false, error: extra };
  if (!isProviderName(value.provider)) return { ok: false, error: 'Invalid provider.' };
  if (!isPositiveInt(value.revision)) return { ok: false, error: 'Invalid capability revision.' };
  const boolFields = [
    'receiveCommands', 'createOrResumeSession', 'perAgentWebhookPortraits',
    'editMessages', 'replyReceipts', 'threadsOrTopics', 'attachments',
    'deliveryCallbacks', 'supportsCancel', 'requiresComplianceGate',
  ] as const;
  for (const field of boolFields) {
    if (typeof value[field] !== 'boolean') return { ok: false, error: `Invalid boolean capability "${field}".` };
  }
  if (typeof value.maxMessageLength !== 'number' || !Number.isSafeInteger(value.maxMessageLength) || value.maxMessageLength < 64 || value.maxMessageLength > 65_536) {
    return { ok: false, error: 'Invalid maxMessageLength.' };
  }
  return { ok: true, value: value as unknown as GatewayCapabilities };
}

const HEALTH_DIMENSION_KEYS = new Set(['status', 'observedAt', 'detail']);
const HEALTH_KEYS = new Set([
  'connectorId', 'provider', 'connectorState', 'transport', 'host', 'runtime',
  'progress', 'notification', 'lastTransportHeartbeatAt', 'lastHostHeartbeatAt',
  'lastRuntimeLeaseAt', 'lastProgressEventAt', 'lastVerifiedEffectAt',
  'expectedNextCheckAt', 'checkedAt',
]);

function validateHealthDimension(value: unknown, label: string): string | null {
  if (!isPlainObject(value)) return `Invalid ${label} health dimension.`;
  const extra = hasOnlyKeys(value, HEALTH_DIMENSION_KEYS);
  if (extra) return `${label}: ${extra}`;
  if (typeof value.status !== 'string' || !HEALTH_DIMENSION_STATUSES.has(value.status)) return `Invalid ${label} health status.`;
  if (value.observedAt !== undefined && !isUtcTimestamp(value.observedAt)) return `Invalid ${label} observedAt.`;
  if (value.detail !== undefined && !isBoundedText(value.detail, 500)) return `Invalid ${label} detail.`;
  return null;
}

export function validateConnectorHealth(value: unknown): GatewayValidationResult<ConnectorHealth> {
  if (!isPlainObject(value)) return { ok: false, error: 'ConnectorHealth must be a plain object.' };
  const extra = hasOnlyKeys(value, HEALTH_KEYS);
  if (extra) return { ok: false, error: extra };
  if (!isBoundedId(value.connectorId)) return { ok: false, error: 'Invalid connectorId.' };
  if (!isProviderName(value.provider)) return { ok: false, error: 'Invalid provider.' };
  if (typeof value.connectorState !== 'string' || !CONNECTOR_STATES.has(value.connectorState)) return { ok: false, error: 'Invalid connectorState.' };
  for (const dim of ['transport', 'host', 'runtime', 'progress', 'notification'] as const) {
    const err = validateHealthDimension(value[dim], dim);
    if (err) return { ok: false, error: err };
  }
  for (const tsField of [
    'lastTransportHeartbeatAt', 'lastHostHeartbeatAt', 'lastRuntimeLeaseAt',
    'lastProgressEventAt', 'lastVerifiedEffectAt', 'expectedNextCheckAt',
  ] as const) {
    if (value[tsField] !== undefined && !isUtcTimestamp(value[tsField])) return { ok: false, error: `Invalid ${tsField}.` };
  }
  if (!isUtcTimestamp(value.checkedAt)) return { ok: false, error: 'Invalid checkedAt.' };
  return { ok: true, value: value as unknown as ConnectorHealth };
}

export interface SanitizeGatewayTextOptions {
  maxLength?: number;
  stripMentions?: boolean;
  redactSecrets?: boolean;
  redactPaths?: boolean;
}

export interface SanitizedGatewayText {
  text: string;
  redactedCount: number;
  mentionsStripped: number;
  truncated: boolean;
}

const MASS_MENTION_PATTERNS: readonly RegExp[] = [
  /@(?:everyone|here)\b/gi,
  /<@&\d+>/g,
];

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|rk)-(?:proj-|live-|ant-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g,
  /https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+/gi,
  /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\b(?:api[_-]?key|access[_-]?token|bot[_-]?token|webhook[_-]?secret|password|secret)\s*[:=]\s*['"]?[A-Za-z0-9._~+/-]{8,}['"]?/gi,
];

const PRIVATE_PATH_PATTERNS: readonly RegExp[] = [
  /\/Users\/[A-Za-z0-9._-]+(?:\/[^\s"'`<>|)\]}]+)*/g,
  /\/home\/[A-Za-z0-9._-]+(?:\/[^\s"'`<>|)\]}]+)*/g,
  /[A-Za-z]:(?:\\|\/)Users(?:\\|\/)[A-Za-z0-9._-]+(?:(?:\\|\/)[^\s"'`<>|)\]}]+)*/g,
  /~\/\.extalia-vo(?:\/[^\s"'`<>|)\]}]+)*/g,
];

/**
 * Redacts credentials, private filesystem paths, and mass mentions from text
 * before external gateway presentation or audit logging (PRD §16.2, GW-AT-015).
 */
export function sanitizeGatewayText(
  input: string,
  options: SanitizeGatewayTextOptions = {},
): SanitizedGatewayText {
  const maxLength = options.maxLength ?? 4000;
  const stripMentions = options.stripMentions ?? true;
  const redactSecrets = options.redactSecrets ?? true;
  const redactPaths = options.redactPaths ?? true;

  let text = String(input).replace(/(?!\t|\n|\r)\p{Cc}/gu, '');
  let redactedCount = 0;
  let mentionsStripped = 0;

  if (redactSecrets) {
    for (const pattern of SECRET_PATTERNS) {
      text = text.replace(pattern, () => {
        redactedCount += 1;
        return '[redacted-secret]';
      });
    }
  }

  if (redactPaths) {
    for (const pattern of PRIVATE_PATH_PATTERNS) {
      text = text.replace(pattern, () => {
        redactedCount += 1;
        return '[redacted-path]';
      });
    }
  }

  if (stripMentions) {
    for (const pattern of MASS_MENTION_PATTERNS) {
      text = text.replace(pattern, () => {
        mentionsStripped += 1;
        return '[mention-redacted]';
      });
    }
  }

  let truncated = false;
  if (text.length > maxLength) {
    truncated = true;
    const suffix = '…';
    text = text.slice(0, Math.max(0, maxLength - suffix.length)) + suffix;
  }

  return { text, redactedCount, mentionsStripped, truncated };
}

export interface GatewayConnectorView {
  id: string;
  provider: GatewayProvider;
  providerAccountId: string;
  /** Opaque secret-store reference only; raw credentials are never serialized to clients. */
  secretRef: string;
  status: GatewayConnectorState;
  policyVersion: number;
  capabilityRevision: number;
  capabilities?: GatewayCapabilities;
  createdAt: string;
  updatedAt: string;
  health?: ConnectorHealth;
}

export interface GatewayConnectorSaveInput {
  id?: string;
  provider: GatewayProvider;
  providerAccountId: string;
  secretRef: string;
  status?: GatewayConnectorState;
}

export interface GatewayLinkChallengeView {
  challengeId: string;
  code: string;
  connectorId: string;
  extaliaPrincipalId: string;
  expiresAt: string;
}

export interface GatewayIssueChallengeInput {
  connectorId: string;
  extaliaPrincipalId?: string;
  ttlSeconds?: number;
}

export interface GatewayConfirmLinkInput {
  challengeId: string;
  providerAccountId: string;
  externalActorId: string;
  permissionBands: GatewayPermissionBand[];
  ttlSeconds?: number;
}

export interface GatewayPrincipalLinkView {
  id: string;
  connectorId: string;
  providerAccountId: string;
  externalActorId: string;
  extaliaPrincipalId: string;
  permissionBands: GatewayPermissionBand[];
  state: 'active' | 'expired' | 'revoked';
  expiresAt?: string;
  confirmedAt: string;
  revokedAt?: string;
  revocationReason?: string;
}

export interface GatewayRouteView {
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
  state: GatewayBindingState;
  createdAt: string;
  updatedAt: string;
}

export interface GatewayRouteSaveInput {
  id?: string;
  connectorId: string;
  providerAccountId: string;
  channelId: string;
  threadId?: string;
  workspaceId: string;
  mode?: GatewayRouteMode;
  audience?: GatewayAudience;
  inboundEnabled?: boolean;
  outboundEnabled?: boolean;
  isDmDefault?: boolean;
  state?: GatewayBindingState;
}

export interface GatewayAuditEntryView {
  sequence: number;
  actor: string;
  action: string;
  resource: string;
  outcome: string;
  reason?: string;
  at: string;
}

export interface GatewayOverview {
  connectors: GatewayConnectorView[];
  routes: GatewayRouteView[];
  links: GatewayPrincipalLinkView[];
  recentAudit: GatewayAuditEntryView[];
}

export interface WorkspaceReportProjectionSummary {
  id: string;
  reportId: string;
  chatId?: string;
  targetSelection: AutonomousReportTargetSelection;
  committedAt: string;
}

export interface WorkspaceReportsInboxView {
  workspaceId: string;
  reports: WorkspaceSystemReport[];
  projections: WorkspaceReportProjectionSummary[];
}

export interface ChatSystemReportsView {
  workspaceId: string;
  sessionId: string;
  reports: WorkspaceSystemReport[];
}

export const GATEWAY_HOST_METHODS = [
  'gatewayOverview',
  'saveGatewayConnector',
  'setGatewayConnectorStatus',
  'issueGatewayLinkChallenge',
  'confirmGatewayPrincipalLink',
  'revokeGatewayPrincipalLink',
  'saveGatewayRoute',
  'deleteGatewayRoute',
  'listWorkspaceReports',
  'listSessionSystemReports',
] as const;
