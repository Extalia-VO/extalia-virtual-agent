/**
 * Isolated Loopback Webhook Edge for Universal Gateway v2 (Milestone M5, Issue #143).
 *
 * Accepts untrusted external webhook POSTs, enforces body-size caps and per-connector
 * rate limits, verifies provider signatures BEFORE forwarding, and relays ONLY verified
 * payloads over loopback to the Extalia Host using a scoped bearer token.
 */
import {
  isLoopbackHttpUrl,
  sanitizeGatewayText,
  type GatewayAdapterInboundVerification,
  type GatewayWebhookEdgeAuditDecision,
  type GatewayWebhookEdgeAuditEntry,
  type GatewayWebhookEdgeRoutePolicy,
} from '@extalia/platform';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const DEFAULT_MAX_BODY_BYTES = 65_536;
const DEFAULT_RATE_LIMIT_MAX = 60;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_AUDIT_ENTRIES = 1_000;
const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export type GatewayWebhookEdgeVerifier = (
  rawBody: Buffer,
  headers: Readonly<Record<string, string | undefined>>,
) => Promise<GatewayAdapterInboundVerification> | GatewayAdapterInboundVerification;

export interface GatewayWebhookEdgeRoute extends GatewayWebhookEdgeRoutePolicy {
  verify: GatewayWebhookEdgeVerifier;
}

export interface StartGatewayWebhookEdgeOptions {
  host?: string;
  port?: number;
  hostTargetUrl: string;
  scopedForwardToken: string;
  routes: readonly GatewayWebhookEdgeRoute[];
  defaultMaxBodyBytes?: number;
  defaultRateLimitMax?: number;
  defaultRateLimitWindowMs?: number;
  upstreamTimeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface GatewayWebhookEdgeServer {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
  getAuditLog(): GatewayWebhookEdgeAuditEntry[];
}

interface NormalizedRoute {
  connectorId: string;
  path: string;
  maxBodyBytes: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  verify: GatewayWebhookEdgeVerifier;
}

interface RateLimitBucket {
  windowStartMs: number;
  count: number;
}

class PayloadTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(`Request body exceeded ${limitBytes} bytes.`);
    this.name = 'PayloadTooLargeError';
  }
}

function normalizeRoutePath(connectorId: string, customPath?: string): string {
  const raw = customPath ?? `/hooks/${connectorId}`;
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`Invalid webhook edge path for connector "${connectorId}".`);
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizeHeaders(
  headers: IncomingMessage['headers'],
): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (Array.isArray(value)) {
      normalized[lowerKey] = value.join(', ');
    } else {
      normalized[lowerKey] = value;
    }
  }
  return normalized;
}

async function readBoundedBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const contentLengthHeader = req.headers['content-length'];
  if (typeof contentLengthHeader === 'string') {
    const declaredLength = Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      req.resume();
      throw new PayloadTooLargeError(maxBytes);
    }
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  return await new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        req.pause();
        fail(new PayloadTooLargeError(maxBytes));
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, totalBytes));
    });

    req.on('error', err => {
      fail(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): void {
  if (res.writableEnded) return;
  const serialized = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(serialized),
    ...extraHeaders,
  });
  res.end(serialized);
}

/**
 * Starts an isolated loopback HTTP webhook edge server.
 */
export async function startGatewayWebhookEdge(
  options: StartGatewayWebhookEdgeOptions,
): Promise<GatewayWebhookEdgeServer> {
  const bindHost = (options.host ?? '127.0.0.1').trim();
  if (!LOOPBACK_BIND_HOSTS.has(bindHost.toLowerCase())) {
    throw new Error(
      `Webhook edge must bind strictly to loopback (received "${bindHost}").`,
    );
  }
  if (!isLoopbackHttpUrl(options.hostTargetUrl)) {
    throw new Error(
      `Webhook edge hostTargetUrl must be a loopback HTTP(S) URL (received "${options.hostTargetUrl}").`,
    );
  }
  if (typeof options.scopedForwardToken !== 'string' || options.scopedForwardToken.trim().length === 0) {
    throw new Error('Webhook edge requires a non-empty scopedForwardToken.');
  }

  const defaultMaxBodyBytes = options.defaultMaxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const defaultRateLimitMax = options.defaultRateLimitMax ?? DEFAULT_RATE_LIMIT_MAX;
  const defaultRateLimitWindowMs =
    options.defaultRateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());

  const routesByPath = new Map<string, NormalizedRoute>();
  for (const route of options.routes) {
    if (!route.connectorId || route.connectorId.trim().length === 0) {
      throw new Error('Webhook edge route requires a non-empty connectorId.');
    }
    const routePath = normalizeRoutePath(route.connectorId, route.path);
    if (routesByPath.has(routePath)) {
      throw new Error(`Duplicate webhook edge route path "${routePath}".`);
    }
    const maxBodyBytes = route.maxBodyBytes ?? defaultMaxBodyBytes;
    const rateLimitMax = route.rateLimitMax ?? defaultRateLimitMax;
    const rateLimitWindowMs = route.rateLimitWindowMs ?? defaultRateLimitWindowMs;
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
      throw new Error(`Invalid maxBodyBytes for connector "${route.connectorId}".`);
    }
    if (!Number.isSafeInteger(rateLimitMax) || rateLimitMax < 1) {
      throw new Error(`Invalid rateLimitMax for connector "${route.connectorId}".`);
    }
    if (!Number.isSafeInteger(rateLimitWindowMs) || rateLimitWindowMs < 1) {
      throw new Error(`Invalid rateLimitWindowMs for connector "${route.connectorId}".`);
    }
    routesByPath.set(routePath, {
      connectorId: route.connectorId,
      path: routePath,
      maxBodyBytes,
      rateLimitMax,
      rateLimitWindowMs,
      verify: route.verify,
    });
  }

  const rateBuckets = new Map<string, RateLimitBucket>();
  const auditLog: GatewayWebhookEdgeAuditEntry[] = [];

  const recordAudit = (
    connectorId: string,
    routePath: string,
    method: string,
    statusCode: number,
    decision: GatewayWebhookEdgeAuditDecision,
    bodyBytes: number,
    extra: { upstreamStatus?: number; reason?: string } = {},
  ): void => {
    const sanitizedReason = extra.reason
      ? sanitizeGatewayText(extra.reason, { maxLength: 300 }).text
      : undefined;
    auditLog.push({
      id: randomUUID(),
      connectorId,
      path: routePath,
      method,
      statusCode,
      decision,
      at: new Date(now()).toISOString(),
      bodyBytes,
      ...(extra.upstreamStatus !== undefined ? { upstreamStatus: extra.upstreamStatus } : {}),
      ...(sanitizedReason ? { reason: sanitizedReason } : {}),
    });
    if (auditLog.length > MAX_AUDIT_ENTRIES) {
      auditLog.splice(0, auditLog.length - MAX_AUDIT_ENTRIES);
    }
  };

  const checkRateLimit = (route: NormalizedRoute): { allowed: true } | { allowed: false; retryAfterSeconds: number } => {
    const currentMs = now();
    const existing = rateBuckets.get(route.connectorId);
    if (!existing || currentMs - existing.windowStartMs >= route.rateLimitWindowMs) {
      rateBuckets.set(route.connectorId, { windowStartMs: currentMs, count: 1 });
      return { allowed: true };
    }
    if (existing.count >= route.rateLimitMax) {
      const remainingMs = Math.max(1, route.rateLimitWindowMs - (currentMs - existing.windowStartMs));
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
      };
    }
    existing.count += 1;
    return { allowed: true };
  };

  const server = createServer(async (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase();
    let requestPath: string;
    try {
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
      requestPath = parsed.pathname;
    } catch {
      requestPath = req.url ?? '/';
    }

    const route = routesByPath.get(requestPath);
    if (!route) {
      recordAudit('unknown', requestPath, method, 404, 'rejected_not_found', 0, {
        reason: 'Unknown webhook route.',
      });
      sendJson(res, 404, { error: 'Webhook route not found.' });
      return;
    }

    if (method !== 'POST') {
      recordAudit(route.connectorId, route.path, method, 405, 'rejected_method', 0, {
        reason: 'Only POST requests are accepted.',
      });
      sendJson(res, 405, { error: 'Method not allowed.' }, { allow: 'POST' });
      return;
    }

    const rateDecision = checkRateLimit(route);
    if (!rateDecision.allowed) {
      recordAudit(route.connectorId, route.path, method, 429, 'rejected_rate_limited', 0, {
        reason: `Rate limit exceeded; retry after ${rateDecision.retryAfterSeconds}s.`,
      });
      sendJson(
        res,
        429,
        { error: 'Rate limit exceeded.', retryAfterSeconds: rateDecision.retryAfterSeconds },
        { 'retry-after': String(rateDecision.retryAfterSeconds) },
      );
      return;
    }

    let rawBody: Buffer;
    try {
      rawBody = await readBoundedBody(req, route.maxBodyBytes);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        recordAudit(route.connectorId, route.path, method, 413, 'rejected_body_too_large', 0, {
          reason: error.message,
        });
        sendJson(res, 413, { error: 'Payload too large.' });
        return;
      }
      recordAudit(route.connectorId, route.path, method, 400, 'rejected_signature', 0, {
        reason: 'Failed to read inbound body.',
      });
      sendJson(res, 400, { error: 'Unable to read request body.' });
      return;
    }

    const normalizedHeaders = normalizeHeaders(req.headers);
    let verification: GatewayAdapterInboundVerification;
    try {
      verification = await route.verify(rawBody, normalizedHeaders);
    } catch (error) {
      verification = {
        ok: false,
        reason: error instanceof Error ? error.message : 'Inbound verification failed.',
      };
    }

    if (!verification.ok) {
      recordAudit(
        route.connectorId,
        route.path,
        method,
        401,
        'rejected_signature',
        rawBody.length,
        { reason: verification.reason },
      );
      sendJson(res, 401, { error: 'Inbound signature verification failed.' });
      return;
    }

    const forwardHeaders: Record<string, string> = {
      authorization: `Bearer ${options.scopedForwardToken}`,
      'content-type': normalizedHeaders['content-type'] ?? 'application/json',
      'x-extalia-edge-verified': '1',
      'x-extalia-connector-id': route.connectorId,
      'x-extalia-verified-at': verification.verifiedAt,
    };
    if (verification.providerEventId) {
      forwardHeaders['x-extalia-provider-event-id'] = verification.providerEventId;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs);

    try {
      const upstreamRes = await fetchImpl(options.hostTargetUrl, {
        method: 'POST',
        headers: forwardHeaders,
        body: new Uint8Array(rawBody),
        signal: controller.signal,
      });

      const responseBytes = Buffer.from(await upstreamRes.arrayBuffer());
      const upstreamContentType =
        upstreamRes.headers.get('content-type') ?? 'application/json; charset=utf-8';

      recordAudit(
        route.connectorId,
        route.path,
        method,
        upstreamRes.status,
        'forwarded',
        rawBody.length,
        { upstreamStatus: upstreamRes.status },
      );

      res.writeHead(upstreamRes.status, {
        'content-type': upstreamContentType,
        'content-length': responseBytes.length,
      });
      res.end(responseBytes);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Upstream host unreachable.';
      recordAudit(route.connectorId, route.path, method, 502, 'upstream_error', rawBody.length, {
        reason,
      });
      sendJson(res, 502, { error: 'Host upstream unreachable.' });
    } finally {
      clearTimeout(timer);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port ?? 0, bindHost);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to bind webhook edge TCP address.');
  }

  const formattedHost = bindHost === '::1' ? '[::1]' : bindHost;
  const url = `http://${formattedHost}:${address.port}`;

  return {
    url,
    host: bindHost,
    port: address.port,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
        server.closeAllConnections?.();
      });
    },
    getAuditLog: () => auditLog.map(entry => ({ ...entry })),
  };
}
