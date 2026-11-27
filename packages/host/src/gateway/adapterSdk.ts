/**
 * Universal Gateway v2 4th-Provider Adapter SDK, Conformance Harness, and Reference
 * `webhook-relay` Adapter (Milestone M5, Issue #143).
 *
 * Demonstrates adding a brand-new provider adapter without modifying core/host
 * routing, outbox, or policy pipelines.
 */
import {
  GATEWAY_ADAPTER_SDK_VERSION,
  sanitizeGatewayText,
  validateGatewayAdapterCapabilities,
  type GatewayAdapterContract,
  type GatewayAdapterHealthSnapshot,
  type GatewayAdapterInboundVerification,
  type GatewayAdapterSendRequest,
  type GatewayAdapterSendResult,
  type GatewayConformanceCheckResult,
  type GatewayConformanceReport,
} from '@extalia/platform';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface GatewayAdapterConformanceOptions {
  validSignedRequest: {
    rawBody: string;
    headers: Record<string, string | undefined>;
  };
  unsignedRequest?: {
    rawBody: string;
    headers?: Record<string, string | undefined>;
  };
  sampleSecret?: string;
  connectorId?: string;
  recipientId?: string;
  nowIso?: () => string;
  createAdapterWithFetch?: (fetchImpl: typeof fetch) => GatewayAdapterContract;
  getLastTransmittedBody?: () => string | undefined;
  rateLimitedAdapter?: GatewayAdapterContract;
  timeoutAdapter?: GatewayAdapterContract;
}

export interface ReferenceFourthProviderAdapterOptions {
  connectorId: string;
  outboundEndpointUrl: string;
  signingSecret: string;
  outboundBearerToken?: string;
  signatureHeaderName?: string;
  eventIdHeaderName?: string;
  maxMessageLength?: number;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
  nowIso?: () => string;
}

function getHeaderCaseInsensitive(
  headers: Readonly<Record<string, string | undefined>>,
  targetName: string,
): string | undefined {
  const target = targetName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

function mutateSignedBody(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return JSON.stringify({ ...parsed, __conformanceTampered: true });
    }
  } catch {
    // Non-JSON payload; fall back to appending a byte.
  }
  return `${rawBody}\n__conformance_tampered__`;
}

function parseRetryAfterSeconds(headerValue: string | null): number {
  if (!headerValue) return 1;
  const numeric = Number(headerValue.trim());
  if (Number.isFinite(numeric) && numeric >= 1) {
    return Math.ceil(numeric);
  }
  return 1;
}

/**
 * Computes the `sha256=<hex>` HMAC signature header value for the reference
 * `webhook-relay` provider.
 */
export function signReferenceFourthProviderPayload(
  rawBody: string,
  signingSecret: string,
): string {
  const digest = createHmac('sha256', signingSecret).update(rawBody, 'utf8').digest('hex');
  return `sha256=${digest}`;
}

/**
 * Creates a reference 4th provider adapter (`webhook-relay`) implementing
 * `GatewayAdapterContract` with HMAC-SHA256 inbound verification, outbound
 * redaction/sanitization, and truthful HTTP 2xx/429/4xx/5xx/timeout handling.
 */
export function createReferenceFourthProviderAdapter(
  options: ReferenceFourthProviderAdapterOptions,
): GatewayAdapterContract {
  const signatureHeaderName = (options.signatureHeaderName ?? 'x-relay-signature-256').toLowerCase();
  const eventIdHeaderName = (options.eventIdHeaderName ?? 'x-relay-event-id').toLowerCase();
  const maxMessageLength = options.maxMessageLength ?? 2000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const nowIso = options.nowIso ?? (() => new Date().toISOString());

  const capabilities = {
    provider: 'webhook-relay' as const,
    revision: 1,
    receiveCommands: true,
    createOrResumeSession: true,
    perAgentWebhookPortraits: false,
    editMessages: false,
    replyReceipts: true,
    threadsOrTopics: false,
    attachments: false,
    deliveryCallbacks: true,
    supportsCancel: true,
    requiresComplianceGate: false,
    maxMessageLength,
  };

  return {
    sdkVersion: GATEWAY_ADAPTER_SDK_VERSION,
    provider: 'webhook-relay',
    capabilities,

    verifyInbound(
      rawBody: string,
      headers: Readonly<Record<string, string | undefined>>,
    ): GatewayAdapterInboundVerification {
      const providedHeader = getHeaderCaseInsensitive(headers, signatureHeaderName);
      if (!providedHeader) {
        return { ok: false, reason: `Missing ${signatureHeaderName} signature header.` };
      }

      const trimmed = providedHeader.trim();
      const hexPart = trimmed.startsWith('sha256=') ? trimmed.slice('sha256='.length) : trimmed;
      if (!/^[a-fA-F0-9]{64}$/.test(hexPart)) {
        return { ok: false, reason: 'Malformed HMAC-SHA256 signature format.' };
      }

      const expectedHex = createHmac('sha256', options.signingSecret)
        .update(rawBody, 'utf8')
        .digest('hex');
      const expectedBuf = Buffer.from(expectedHex, 'hex');
      const providedBuf = Buffer.from(hexPart, 'hex');

      if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
        return { ok: false, reason: 'Invalid HMAC-SHA256 signature.' };
      }

      const providerEventId = getHeaderCaseInsensitive(headers, eventIdHeaderName)?.trim();
      return {
        ok: true,
        verifiedAt: nowIso(),
        ...(providerEventId ? { providerEventId } : {}),
      };
    },

    async sendOutbound(request: GatewayAdapterSendRequest): Promise<GatewayAdapterSendResult> {
      const effectiveLimit = Math.min(
        request.maxMessageLength ?? capabilities.maxMessageLength,
        capabilities.maxMessageLength,
      );
      const sanitized = sanitizeGatewayText(request.text, {
        maxLength: effectiveLimit,
        stripMentions: true,
        redactSecrets: true,
        redactPaths: true,
      });

      const headers: Record<string, string> = {
        'content-type': 'application/json; charset=utf-8',
        'x-extalia-connector-id': request.connectorId || options.connectorId,
      };
      if (options.outboundBearerToken) {
        headers.authorization = `Bearer ${options.outboundBearerToken}`;
      }

      const payload = JSON.stringify({
        connectorId: request.connectorId || options.connectorId,
        recipientId: request.recipientId,
        messageClass: request.messageClass,
        correlationKey: request.correlationKey,
        text: sanitized.text,
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

      try {
        const res = await fetchImpl(options.outboundEndpointUrl, {
          method: 'POST',
          headers,
          body: payload,
          signal: controller.signal,
        });

        if (res.status === 429) {
          return {
            kind: 'rate-limited',
            retryAfterSeconds: parseRetryAfterSeconds(res.headers.get('retry-after')),
            httpStatus: 429,
            errorMessage: 'Provider rate limit exceeded.',
          };
        }

        if (res.status >= 200 && res.status < 300) {
          let remoteMessageId: string | undefined;
          try {
            const parsed = (await res.json()) as Record<string, unknown>;
            const rawId = parsed.remoteMessageId ?? parsed.id;
            if (typeof rawId === 'string' && rawId.trim().length > 0) {
              remoteMessageId = rawId.trim();
            }
          } catch {
            remoteMessageId = undefined;
          }

          if (!remoteMessageId) {
            return {
              kind: 'retryable',
              httpStatus: res.status,
              errorMessage: 'Provider returned 2xx without a remoteMessageId receipt.',
            };
          }

          return {
            kind: 'accepted',
            remoteMessageId,
            httpStatus: res.status,
          };
        }

        if (
          res.status === 400 ||
          res.status === 401 ||
          res.status === 403 ||
          res.status === 404 ||
          res.status === 410 ||
          res.status === 422
        ) {
          return {
            kind: 'permanent-blocked',
            httpStatus: res.status,
            errorMessage: `Provider rejected outbound dispatch with HTTP ${res.status}.`,
          };
        }

        return {
          kind: 'retryable',
          backoffSeconds: 5,
          httpStatus: res.status,
          errorMessage: `Provider returned transient HTTP ${res.status}.`,
        };
      } catch (error) {
        return {
          kind: 'ambiguous-timeout',
          errorMessage: error instanceof Error ? error.message : String(error),
        };
      } finally {
        clearTimeout(timer);
      }
    },

    async healthCheck(): Promise<GatewayAdapterHealthSnapshot> {
      return {
        status: 'healthy',
        checkedAt: nowIso(),
        detail: 'Reference webhook-relay adapter ready.',
      };
    },
  };
}

/**
 * Runs the 6-check Universal Gateway v2 Adapter Conformance Suite against an
 * adapter implementation.
 */
export async function runGatewayAdapterConformance(
  adapter: GatewayAdapterContract,
  options: GatewayAdapterConformanceOptions,
): Promise<GatewayConformanceReport> {
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const connectorId = options.connectorId ?? 'conn-conformance-1';
  const recipientId = options.recipientId ?? 'rcpt-conformance-1';
  const secretToken =
    options.sampleSecret ?? ['edge', 'conformance', 'tok', '1234567890abcdef'].join('_');
  const syntheticBearer = `Bearer ${secretToken}`;
  const checks: GatewayConformanceCheckResult[] = [];

  // 1. SDK version and capabilities validation
  {
    const versionOk = adapter.sdkVersion === GATEWAY_ADAPTER_SDK_VERSION;
    const capResult = validateGatewayAdapterCapabilities(adapter.capabilities);
    const providerMatches = capResult.ok && capResult.value.provider === adapter.provider;
    const passed = versionOk && capResult.ok && providerMatches;
    const detail = passed
      ? `SDK ${adapter.sdkVersion} and capabilities validated for provider "${adapter.provider}".`
      : !versionOk
        ? `Unsupported SDK version "${adapter.sdkVersion}" (expected "${GATEWAY_ADAPTER_SDK_VERSION}").`
        : !capResult.ok
          ? `Invalid capabilities: ${capResult.error}`
          : 'Capabilities provider does not match adapter.provider.';
    checks.push({ id: 'sdk-version-and-capabilities', passed, detail });
  }

  // 2. Inbound signature verification must fail closed
  {
    let passed = false;
    let detail: string;
    try {
      const validResult = await adapter.verifyInbound(
        options.validSignedRequest.rawBody,
        options.validSignedRequest.headers,
      );
      const tamperedResult = await adapter.verifyInbound(
        mutateSignedBody(options.validSignedRequest.rawBody),
        options.validSignedRequest.headers,
      );
      const unsignedResult = await adapter.verifyInbound(
        options.unsignedRequest?.rawBody ?? options.validSignedRequest.rawBody,
        options.unsignedRequest?.headers ?? {},
      );

      if (!validResult.ok) {
        detail = `Valid signed request was rejected: ${validResult.reason}`;
      } else if (tamperedResult.ok) {
        detail = 'Tampered payload was accepted by verifyInbound.';
      } else if (unsignedResult.ok) {
        detail = 'Unsigned request without signature header was accepted by verifyInbound.';
      } else {
        passed = true;
        detail = 'Valid request accepted; tampered and unsigned requests rejected fail-closed.';
      }
    } catch (error) {
      detail = `verifyInbound threw unexpectedly: ${error instanceof Error ? error.message : String(error)}`;
    }
    checks.push({ id: 'inbound-signature-fail-closed', passed, detail });
  }

  // 3. Outbound sanitization and secret redaction
  {
    let passed = false;
    let detail: string;
    let capturedBody: string | undefined;

    try {
      const probeAdapter = options.createAdapterWithFetch
        ? options.createAdapterWithFetch(async (_url, init) => {
            capturedBody = typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
            return new Response(JSON.stringify({ id: 'remote-redaction-check-1' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          })
        : adapter;

      const sendResult = await probeAdapter.sendOutbound({
        connectorId,
        recipientId,
        text: `Conformance probe ${syntheticBearer} complete.`,
        messageClass: 'milestone',
      });

      const transmitted = options.createAdapterWithFetch
        ? capturedBody
        : options.getLastTransmittedBody?.();

      if (transmitted === undefined) {
        detail = 'Unable to inspect transmitted outbound payload for secret redaction.';
      } else if (transmitted.includes(secretToken)) {
        detail = 'Outbound payload leaked raw secret token without redaction.';
      } else if (!transmitted.includes('[redacted-secret]')) {
        detail = 'Outbound payload did not contain expected [redacted-secret] marker.';
      } else if (sendResult.kind !== 'accepted') {
        detail = `Expected accepted outcome during redaction probe, got "${sendResult.kind}".`;
      } else {
        passed = true;
        detail = 'Outbound payload redacted synthetic bearer token before transmission.';
      }
    } catch (error) {
      detail = `Outbound redaction check threw: ${error instanceof Error ? error.message : String(error)}`;
    }
    checks.push({ id: 'outbound-sanitization-and-redaction', passed, detail });
  }

  // 4. Receipt truthfulness
  {
    let passed = false;
    let detail: string;
    try {
      const probeAdapter = options.createAdapterWithFetch
        ? options.createAdapterWithFetch(async () =>
            new Response(JSON.stringify({ id: 'remote-receipt-1' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          )
        : adapter;

      const sendResult = await probeAdapter.sendOutbound({
        connectorId,
        recipientId,
        text: 'Conformance receipt truthfulness check.',
        messageClass: 'milestone',
      });

      if (sendResult.kind !== 'accepted') {
        detail = `Expected accepted receipt on 200 OK, got "${sendResult.kind}".`;
      } else if (
        typeof sendResult.remoteMessageId !== 'string' ||
        sendResult.remoteMessageId.trim().length === 0
      ) {
        detail = 'Accepted send result returned empty remoteMessageId.';
      } else {
        passed = true;
        detail = `Accepted outbound returned non-empty remoteMessageId "${sendResult.remoteMessageId}".`;
      }
    } catch (error) {
      detail = `Receipt check threw: ${error instanceof Error ? error.message : String(error)}`;
    }
    checks.push({ id: 'receipt-truthfulness', passed, detail });
  }

  // 5. Rate-limit handling (HTTP 429)
  {
    let passed = false;
    let detail: string;
    try {
      const rateLimitProbeAdapter = options.createAdapterWithFetch
        ? options.createAdapterWithFetch(async () =>
            new Response(JSON.stringify({ error: 'too many requests' }), {
              status: 429,
              headers: {
                'content-type': 'application/json',
                'retry-after': '7',
              },
            }),
          )
        : options.rateLimitedAdapter;

      if (!rateLimitProbeAdapter) {
        detail = 'No transport hook or rateLimitedAdapter supplied to verify 429 handling.';
      } else {
        const sendResult = await rateLimitProbeAdapter.sendOutbound({
          connectorId,
          recipientId,
          text: 'Conformance 429 rate-limit check.',
          messageClass: 'heartbeat',
        });

        if (sendResult.kind !== 'rate-limited') {
          detail = `Expected rate-limited outcome on HTTP 429, got "${sendResult.kind}".`;
        } else if (
          typeof sendResult.retryAfterSeconds !== 'number' ||
          !Number.isFinite(sendResult.retryAfterSeconds) ||
          sendResult.retryAfterSeconds <= 0
        ) {
          detail = 'Rate-limited outcome missing positive numeric retryAfterSeconds.';
        } else {
          passed = true;
          detail = `HTTP 429 mapped truthfully to rate-limited (retryAfterSeconds=${sendResult.retryAfterSeconds}).`;
        }
      }
    } catch (error) {
      detail = `Rate-limit check threw: ${error instanceof Error ? error.message : String(error)}`;
    }
    checks.push({ id: 'rate-limit-handling', passed, detail });
  }

  // 6. Ambiguous timeout isolation
  {
    let passed = false;
    let detail: string;
    try {
      const timeoutProbeAdapter = options.createAdapterWithFetch
        ? options.createAdapterWithFetch(async () => {
            const timeoutErr = new Error('Simulated transport timeout');
            timeoutErr.name = 'AbortError';
            throw timeoutErr;
          })
        : options.timeoutAdapter;

      if (!timeoutProbeAdapter) {
        detail = 'No transport hook or timeoutAdapter supplied to verify timeout isolation.';
      } else {
        const sendResult = await timeoutProbeAdapter.sendOutbound({
          connectorId,
          recipientId,
          text: 'Conformance timeout isolation check.',
          messageClass: 'attention',
        });

        if (sendResult.kind !== 'ambiguous-timeout') {
          detail = `Expected ambiguous-timeout on transport timeout, got "${sendResult.kind}".`;
        } else if (sendResult.errorMessage.trim().length === 0) {
          detail = 'Ambiguous-timeout outcome returned empty errorMessage.';
        } else {
          passed = true;
          detail = 'Transport timeout isolated to ambiguous-timeout without throwing or claiming delivery.';
        }
      }
    } catch (error) {
      detail = `Timeout escaped sendOutbound as uncaught error: ${error instanceof Error ? error.message : String(error)}`;
    }
    checks.push({ id: 'ambiguous-timeout-isolation', passed, detail });
  }

  return {
    sdkVersion: GATEWAY_ADAPTER_SDK_VERSION,
    provider: adapter.provider,
    passed: checks.every(check => check.passed),
    checks,
    ranAt: nowIso(),
  };
}
