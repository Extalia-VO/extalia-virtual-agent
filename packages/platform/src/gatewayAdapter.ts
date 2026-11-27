/**
 * Provider-neutral Universal Gateway v2 Adapter SDK, Webhook Edge, and Host
 * Watchdog contracts & pure runtime validators (Milestone M5, Issue #143).
 *
 * Browser-safe: zero Node built-ins or runtime/provider imports.
 */
import {
  validateGatewayCapabilities,
  type GatewayCapabilities,
  type GatewayOutboundMessageClass,
  type GatewayProvider,
  type GatewayValidationResult,
} from './gateway.js';

export const GATEWAY_ADAPTER_SDK_VERSION = '1.0.0' as const;

export type GatewayAdapterInboundVerification =
  | {
      readonly ok: true;
      readonly verifiedAt: string;
      readonly providerEventId?: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export interface GatewayAdapterSendRequest {
  connectorId: string;
  recipientId?: string;
  text: string;
  messageClass: GatewayOutboundMessageClass;
  maxMessageLength?: number;
  correlationKey?: string;
}

export type GatewayAdapterSendResult =
  | {
      readonly kind: 'accepted';
      readonly remoteMessageId: string;
      readonly httpStatus?: number;
    }
  | {
      readonly kind: 'rate-limited';
      readonly retryAfterSeconds: number;
      readonly httpStatus?: number;
      readonly errorMessage?: string;
    }
  | {
      readonly kind: 'retryable';
      readonly backoffSeconds?: number;
      readonly httpStatus?: number;
      readonly errorMessage: string;
    }
  | {
      readonly kind: 'permanent-blocked';
      readonly httpStatus?: number;
      readonly errorMessage: string;
    }
  | {
      readonly kind: 'ambiguous-timeout';
      readonly errorMessage: string;
    };

export interface GatewayAdapterHealthSnapshot {
  status: 'healthy' | 'degraded' | 'unavailable';
  checkedAt: string;
  detail?: string;
}

export interface GatewayAdapterContract {
  readonly sdkVersion: string;
  readonly provider: GatewayProvider;
  readonly capabilities: GatewayCapabilities;
  verifyInbound(
    rawBody: string,
    headers: Readonly<Record<string, string | undefined>>,
  ): Promise<GatewayAdapterInboundVerification> | GatewayAdapterInboundVerification;
  sendOutbound(request: GatewayAdapterSendRequest): Promise<GatewayAdapterSendResult>;
  healthCheck?(): Promise<GatewayAdapterHealthSnapshot>;
}

export interface GatewayWebhookEdgeRoutePolicy {
  connectorId: string;
  path?: string;
  maxBodyBytes?: number;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
}

export type GatewayWebhookEdgeAuditDecision =
  | 'forwarded'
  | 'rejected_signature'
  | 'rejected_body_too_large'
  | 'rejected_rate_limited'
  | 'rejected_method'
  | 'rejected_not_found'
  | 'upstream_error';

export interface GatewayWebhookEdgeAuditEntry {
  id: string;
  connectorId: string;
  path: string;
  method: string;
  statusCode: number;
  decision: GatewayWebhookEdgeAuditDecision;
  at: string;
  bodyBytes: number;
  upstreamStatus?: number;
  reason?: string;
}

export type HostWatchdogHealthState =
  | 'healthy'
  | 'degraded'
  | 'suspected_stalled'
  | 'host_down'
  | 'unknown';

export interface HostWatchdogLeaseSnapshot {
  schemaVersion: 1;
  ownerId: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  fencingToken: string;
  activeConnectors?: number;
}

export interface HostWatchdogStatus {
  state: HostWatchdogHealthState;
  checkedAt: string;
  leaseAgeMs?: number;
  heartbeatAt?: string;
  probeOk?: boolean;
  reason: string;
}

export interface HostWatchdogAlertEvent {
  id: string;
  kind: 'host_down' | 'recovered';
  state: HostWatchdogHealthState;
  at: string;
  reason: string;
}

export interface GatewayConformanceCheckResult {
  id: string;
  passed: boolean;
  detail: string;
}

export interface GatewayConformanceReport {
  sdkVersion: string;
  provider: GatewayProvider;
  passed: boolean;
  checks: GatewayConformanceCheckResult[];
  ranAt: string;
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CONTROL_CHAR_PATTERN = /(?!\t|\n|\r)\p{Cc}/u;

const LEASE_KEYS = new Set([
  'schemaVersion',
  'ownerId',
  'pid',
  'startedAt',
  'heartbeatAt',
  'fencingToken',
  'activeConnectors',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !CONTROL_CHAR_PATTERN.test(value)
  );
}

function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_UTC_PATTERN.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

/**
 * Validates that a URL uses HTTP(S) and resolves strictly to a loopback host
 * (`127.0.0.1`, `localhost`, `::1`, or `[::1]`). Rejects wildcard bind hosts,
 * LAN IPs, external domains, non-HTTP schemes, and malformed URLs.
 */
export function isLoopbackHttpUrl(url: string): boolean {
  if (
    typeof url !== 'string' ||
    url.length === 0 ||
    url.trim() !== url ||
    CONTROL_CHAR_PATTERN.test(url) ||
    /\s/.test(url)
  ) {
    return false;
  }

  const schemeMatch = /^https?:\/\/(.+)$/i.exec(url);
  if (!schemeMatch) {
    return false;
  }

  const rest = schemeMatch[1] ?? '';
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  if (authority.length === 0 || authority.includes('@')) {
    return false;
  }

  let hostname: string;
  let portText: string | undefined;

  if (authority.startsWith('[')) {
    const bracketMatch = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(authority);
    if (!bracketMatch) {
      return false;
    }
    hostname = `[${(bracketMatch[1] ?? '').toLowerCase()}]`;
    portText = bracketMatch[2];
  } else {
    const hostPortMatch = /^([^:[\]]+)(?::(\d{1,5}))?$/.exec(authority);
    if (!hostPortMatch) {
      return false;
    }
    hostname = (hostPortMatch[1] ?? '').toLowerCase();
    portText = hostPortMatch[2];
  }

  if (portText !== undefined) {
    const port = Number(portText);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      return false;
    }
  }

  return LOOPBACK_HOSTNAMES.has(hostname);
}

/**
 * Validates adapter-declared gateway capabilities against the platform contract.
 */
export function validateGatewayAdapterCapabilities(
  value: unknown,
): GatewayValidationResult<GatewayCapabilities> {
  return validateGatewayCapabilities(value);
}

/**
 * Validates a Host Watchdog lease snapshot read from disk or IPC.
 */
export function validateHostWatchdogLeaseSnapshot(
  value: unknown,
): GatewayValidationResult<HostWatchdogLeaseSnapshot> {
  if (!isPlainObject(value)) {
    return { ok: false, error: 'Host watchdog lease snapshot must be a plain object.' };
  }
  for (const key of Object.keys(value)) {
    if (!LEASE_KEYS.has(key)) {
      return { ok: false, error: `Unexpected field "${key}".` };
    }
  }
  if (value.schemaVersion !== 1) {
    return { ok: false, error: 'Unsupported watchdog lease schemaVersion.' };
  }
  if (!isBoundedString(value.ownerId, 200)) {
    return { ok: false, error: 'Invalid watchdog lease ownerId.' };
  }
  if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid < 1) {
    return { ok: false, error: 'Invalid watchdog lease pid.' };
  }
  if (!isUtcTimestamp(value.startedAt)) {
    return { ok: false, error: 'Invalid watchdog lease startedAt timestamp.' };
  }
  if (!isUtcTimestamp(value.heartbeatAt)) {
    return { ok: false, error: 'Invalid watchdog lease heartbeatAt timestamp.' };
  }
  if (!isBoundedString(value.fencingToken, 256)) {
    return { ok: false, error: 'Invalid watchdog lease fencingToken.' };
  }
  if (
    value.activeConnectors !== undefined &&
    (typeof value.activeConnectors !== 'number' ||
      !Number.isSafeInteger(value.activeConnectors) ||
      value.activeConnectors < 0)
  ) {
    return { ok: false, error: 'Invalid watchdog lease activeConnectors.' };
  }
  return { ok: true, value: value as unknown as HostWatchdogLeaseSnapshot };
}
