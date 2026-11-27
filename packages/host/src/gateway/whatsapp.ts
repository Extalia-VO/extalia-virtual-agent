/**
 * Official WhatsApp Business Platform Cloud API / BSP Conditional Monitoring Adapter
 * (Universal Gateway v2 M4, Issue #141, Refs #145: GW-WP-14..16, GW-AT-057..077).
 *
 * Implements PRD §10, §18.4, and §20.4:
 * - Fail-closed by default (`waEnabled === true` + explicit `complianceSignOffId` required).
 * - Official Meta Cloud API only (pinned Graph API version; zero unofficial Web automation).
 * - Webhook `GET` challenge verification and `POST` raw-body `X-Hub-Signature-256` HMAC-SHA256
 *   validation using `timingSafeEqual`.
 * - Strict 24-hour customer-service window (`0 <= deltaMs <= 86_400_000`) and approved
 *   `utility` template registry validation (`name`, `language`, `category`, `approved`).
 * - Explicit revocable opt-in consent (`STOP`, `UNSUBSCRIBE`, `BERHENTI`, `OPT OUT`, `OPTOUT`).
 * - Bounded 4-signal reporting (`accepted`, `heartbeat`, `attention`, `terminal`) with strict
 *   redaction of secrets, filesystem paths, stack traces, and tool feeds (`<= 1024` chars).
 * - Hard monthly and per-workspace budget enforcement (October 1, 2026 pricing-aware).
 * - Truthful `wamid` acceptance separated from async `sent`/`delivered`/`read`/`failed`
 *   webhook status reconciliation with monotonic state ordering.
 */
import {
  sanitizeGatewayText,
  type GatewayCapabilities,
} from '@extalia/platform';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const WHATSAPP_PINNED_GRAPH_VERSION = 'v21.0';
export const WHATSAPP_SERVICE_WINDOW_MS = 86_400_000;
export const WHATSAPP_MAX_MESSAGE_LENGTH = 1024;

export const WHATSAPP_CAPABILITIES: GatewayCapabilities = {
  provider: 'whatsapp',
  revision: 1,
  requiresComplianceGate: true,
  receiveCommands: false,
  createOrResumeSession: false,
  perAgentWebhookPortraits: false,
  editMessages: false,
  replyReceipts: true,
  threadsOrTopics: false,
  attachments: false,
  deliveryCallbacks: true,
  supportsCancel: false,
  maxMessageLength: WHATSAPP_MAX_MESSAGE_LENGTH,
};

export const WHATSAPP_ALLOWED_SIGNAL_CLASSES = [
  'accepted',
  'heartbeat',
  'attention',
  'terminal',
] as const;

export type WhatsAppAllowedSignalClass = (typeof WHATSAPP_ALLOWED_SIGNAL_CLASSES)[number];

const ALLOWED_SIGNAL_CLASS_SET = new Set<string>(WHATSAPP_ALLOWED_SIGNAL_CLASSES);

export type WhatsAppTemplateCategory = 'utility' | 'authentication' | 'marketing';

export type WhatsAppOptInStatus = 'opted_in' | 'opted_out' | 'pending' | 'unknown';

export interface WhatsAppRegisteredTemplate {
  name: string;
  language: string;
  category: WhatsAppTemplateCategory;
  approved: boolean;
  version?: string;
  allowedSignalClasses?: readonly WhatsAppAllowedSignalClass[];
}

export interface WhatsAppTemplateSelection {
  name: string;
  language: string;
  category: WhatsAppTemplateCategory;
  parameters?: readonly string[];
}

export type WhatsAppPolicyDenialCode =
  | 'adapter_disabled'
  | 'missing_compliance_signoff'
  | 'recipient_not_opted_in'
  | 'signal_class_not_allowed'
  | 'window_closed_no_template'
  | 'template_invalid'
  | 'template_not_utility'
  | 'template_signal_mismatch'
  | 'invalid_cost_budget'
  | 'monthly_budget_exceeded'
  | 'workspace_budget_exceeded';

export interface WhatsAppSendPolicyInput {
  waEnabled: boolean;
  complianceSignOffId?: string;
  optInStatus: WhatsAppOptInStatus;
  signalClass: string;
  lastInboundAtIso?: string;
  nowIso: string;
  template?: {
    name: string;
    language: string;
    category: WhatsAppTemplateCategory;
  };
  templateRegistry?: readonly WhatsAppRegisteredTemplate[];
  estimatedCost: number;
  monthlySpent: number;
  monthlyBudgetLimit: number;
  workspaceSpent: number;
  workspaceBudgetLimit: number;
}

export type WhatsAppSendPolicyResult =
  | {
    allowed: true;
    mode: 'session-text' | 'utility-template';
    reason: string;
  }
  | {
    allowed: false;
    code: WhatsAppPolicyDenialCode;
    reason: string;
  };

export type WhatsAppFetch = (
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
  headers?: { get?(name: string): string | null };
  json(): Promise<unknown>;
  text?(): Promise<string>;
}>;

export interface SendWhatsAppCloudMessageInput {
  policy: WhatsAppSendPolicyInput;
  phoneNumberId: string;
  accessToken: string;
  recipientPhone: string;
  messageText: string;
  template?: WhatsAppTemplateSelection;
  graphVersion?: string;
  fetchImpl?: WhatsAppFetch;
  signal?: AbortSignal;
}

export type SendWhatsAppCloudMessageResult =
  | {
    kind: 'accepted';
    wamid: string;
    remoteMessageId: string;
    httpStatus: number;
    mode: 'session-text' | 'utility-template';
  }
  | {
    kind: 'rate-limited';
    retryAfterSeconds: number;
    httpStatus: number;
    errorMessage: string;
  }
  | {
    kind: 'retryable';
    httpStatus: number;
    errorMessage: string;
  }
  | {
    kind: 'permanent-blocked';
    reason?: string;
    errorCode?: WhatsAppPolicyDenialCode | string;
    httpStatus?: number;
    errorMessage?: string;
  }
  | {
    kind: 'ambiguous-timeout';
    state: 'unknown';
    errorMessage: string;
  };

export type WhatsAppWebhookStatus = 'sent' | 'delivered' | 'read' | 'failed';
export type WhatsAppDeliveryState = 'pending' | 'accepted' | 'sent' | 'delivered' | 'read' | 'failed' | 'unknown';

export interface WhatsAppWebhookError {
  code?: number;
  title?: string;
  message?: string;
}

export interface WhatsAppWebhookStatusEvent {
  wamid: string;
  status: WhatsAppWebhookStatus;
  recipientId: string;
  timestamp: string;
  timestampIso?: string;
  phoneNumberId?: string;
  errors?: WhatsAppWebhookError[];
}

export interface WhatsAppStatusReconciliationResult {
  updated: boolean;
  wamid: string;
  previousState: WhatsAppDeliveryState;
  state: WhatsAppDeliveryState;
  outOfOrder: boolean;
  duplicate: boolean;
  errors?: WhatsAppWebhookError[];
  reason: string;
}

const SIGNATURE_HEX_PATTERN = /^sha256=([0-9a-f]{64})$/i;
const OPT_OUT_PATTERN = /^(?:stop|unsubscribe|berhenti|opt\s*out)(?:$|[\s!.,;?])/i;

const META_TOKEN_PATTERN = /\bEAA[A-Za-z0-9]{16,}\b/g;
const STACK_LINE_PATTERN = /^\s*at\s+(?:async\s+)?(?:[\w$.<>]+\s+\([^)]+\)|[^\s()]+:\d+:\d+)\s*$/gm;
const TOOL_FEED_LINE_PATTERN = /^\s*(?:\[?(?:tool|exec|shell|bash|cmd|stderr|stdout)(?::[^\]]*)?\]?\s*[:>|]|Tool\s+(?:call|output|result)\s*:).*$/gim;
const UNIX_ABSOLUTE_PATH_PATTERN = /(?<![:/\w])\/[A-Za-z0-9._-]+(?:\/[^\s"'`<>|)\]}]+)+/g;
const WINDOWS_BACKSLASH_PATH_PATTERN = /\b[A-Za-z]:\\(?:[^\s"'`<>|)\]}]+\\)*[^\s"'`<>|)\]}]+/g;
const WINDOWS_SLASH_PATH_PATTERN = /\b[A-Za-z]:\/(?:Users|Windows|Program Files|Projects|work|src|tmp|home|var|opt)(?:\/[^\s"'`<>|)\]}]+)*/gi;

const MONOTONIC_PROGRESS_RANK: Readonly<Record<'pending' | 'accepted' | 'sent' | 'delivered' | 'read', number>> = {
  pending: 1,
  accepted: 2,
  sent: 3,
  delivered: 4,
  read: 5,
};

const BUDGET_TOLERANCE = 1e-9;

function isValidFiniteNonNegative(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function sha256Buffer(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Verifies Meta Cloud API `X-Hub-Signature-256` against raw request bytes using
 * HMAC-SHA256 and `timingSafeEqual`. Fails closed on any missing, empty, or malformed input.
 */
export function verifyWhatsAppWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (typeof appSecret !== 'string' || appSecret.length === 0) {
    return false;
  }
  if (typeof signatureHeader !== 'string') {
    return false;
  }
  const match = SIGNATURE_HEX_PATTERN.exec(signatureHeader.trim());
  const rawHex = match?.[1];
  if (!rawHex) {
    return false;
  }

  const receivedHex = rawHex.toLowerCase();
  const expectedHex = createHmac('sha256', appSecret).update(rawBody).digest('hex');

  const receivedBuf = Buffer.from(receivedHex, 'hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (receivedBuf.length !== expectedBuf.length || receivedBuf.length === 0) {
    return false;
  }
  return timingSafeEqual(receivedBuf, expectedBuf);
}

/**
 * Verifies Meta Cloud API `GET` webhook setup challenge using constant-time token
 * comparison (`timingSafeEqual`) and requiring `hub.mode === 'subscribe'`.
 */
export function verifyWhatsAppWebhookChallenge(
  query: Record<string, string | undefined>,
  expectedVerifyToken: string,
): { ok: true; challenge: string } | { ok: false; status: 403; reason: string } {
  if (typeof expectedVerifyToken !== 'string' || expectedVerifyToken.length === 0) {
    return { ok: false, status: 403, reason: 'Webhook verify token is not configured.' };
  }

  const mode = query['hub.mode'];
  const verifyToken = query['hub.verify_token'];
  const challenge = query['hub.challenge'];

  if (mode !== 'subscribe') {
    return { ok: false, status: 403, reason: 'Invalid hub.mode; expected subscribe.' };
  }

  if (typeof verifyToken !== 'string' || verifyToken.length === 0) {
    return { ok: false, status: 403, reason: 'Missing hub.verify_token.' };
  }

  const expectedDigest = sha256Buffer(expectedVerifyToken);
  const actualDigest = sha256Buffer(verifyToken);
  if (!timingSafeEqual(expectedDigest, actualDigest)) {
    return { ok: false, status: 403, reason: 'Webhook verify token mismatch.' };
  }

  if (typeof challenge !== 'string' || challenge.length === 0) {
    return { ok: false, status: 403, reason: 'Missing hub.challenge.' };
  }

  return { ok: true, challenge };
}

/**
 * Checks whether the recipient's 24-hour WhatsApp customer-service window is currently open.
 * Strictly requires `0 <= deltaMs <= 86_400_000`; fails closed on missing, invalid,
 * future, or expired timestamps.
 */
export function isWhatsAppServiceWindowOpen(
  lastInboundAtIso: string | undefined,
  nowIso: string,
): boolean {
  if (typeof lastInboundAtIso !== 'string' || lastInboundAtIso.trim().length === 0) {
    return false;
  }
  if (typeof nowIso !== 'string' || nowIso.trim().length === 0) {
    return false;
  }

  const lastInboundMs = Date.parse(lastInboundAtIso);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(lastInboundMs) || !Number.isFinite(nowMs)) {
    return false;
  }

  const deltaMs = nowMs - lastInboundMs;
  return deltaMs >= 0 && deltaMs <= WHATSAPP_SERVICE_WINDOW_MS;
}

/**
 * Validates an outbound template request against the local approved template registry.
 * Requires `approved === true` and exact match on `name`, `language`, and `category`.
 */
export function validateWhatsAppTemplateForSend(
  template: { name: string; language: string; category: WhatsAppTemplateCategory },
  registry: readonly WhatsAppRegisteredTemplate[],
): { ok: true; template: WhatsAppRegisteredTemplate } | { ok: false; reason: string } {
  const byName = registry.filter(entry => entry.name === template.name);
  if (byName.length === 0) {
    return { ok: false, reason: `Template "${template.name}" is not registered.` };
  }

  const byLanguage = byName.filter(entry => entry.language === template.language);
  if (byLanguage.length === 0) {
    return {
      ok: false,
      reason: `Template "${template.name}" has no entry for language "${template.language}".`,
    };
  }

  const byCategory = byLanguage.filter(entry => entry.category === template.category);
  if (byCategory.length === 0) {
    return {
      ok: false,
      reason: `Template "${template.name}" (${template.language}) category "${template.category}" does not match registry.`,
    };
  }

  const approvedMatch = byCategory.find(entry => entry.approved === true);
  if (!approvedMatch) {
    return {
      ok: false,
      reason: `Template "${template.name}" (${template.language}, ${template.category}) is not currently approved.`,
    };
  }

  return { ok: true, template: approvedMatch };
}

/**
 * Recognizes explicit recipient opt-out keywords (`STOP`, `UNSUBSCRIBE`, `BERHENTI`,
 * `OPT OUT`, `OPTOUT`) case-insensitively at the start of an inbound message.
 */
export function isWhatsAppOptOutText(text: string): boolean {
  if (typeof text !== 'string') {
    return false;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return OPT_OUT_PATTERN.test(trimmed);
}

/**
 * Sanitizes outbound WhatsApp monitoring text (PRD §10.3, GW-AT-015):
 * strips control characters, mass mentions, credentials, Unix/Windows filesystem paths,
 * stack traces, and raw tool-feed lines, enforcing `<= maxLength` characters cleanly.
 */
export function sanitizeWhatsAppSignalText(
  text: string,
  maxLength = WHATSAPP_MAX_MESSAGE_LENGTH,
): string {
  const boundedMax = Number.isSafeInteger(maxLength) && maxLength > 0
    ? Math.min(maxLength, WHATSAPP_MAX_MESSAGE_LENGTH)
    : WHATSAPP_MAX_MESSAGE_LENGTH;

  const initial = sanitizeGatewayText(text, {
    maxLength: Math.max(boundedMax * 4, 4096),
    stripMentions: true,
    redactSecrets: true,
    redactPaths: true,
  }).text;

  const redacted = initial
    .replace(META_TOKEN_PATTERN, '[redacted-secret]')
    .replace(STACK_LINE_PATTERN, '[redacted-stack]')
    .replace(TOOL_FEED_LINE_PATTERN, '[redacted-tool-output]')
    .replace(WINDOWS_BACKSLASH_PATH_PATTERN, '[redacted-path]')
    .replace(WINDOWS_SLASH_PATH_PATTERN, '[redacted-path]')
    .replace(UNIX_ABSOLUTE_PATH_PATTERN, '[redacted-path]');

  return sanitizeGatewayText(redacted, {
    maxLength: boundedMax,
    stripMentions: true,
    redactSecrets: true,
    redactPaths: true,
  }).text;
}

/**
 * Evaluates all WhatsApp outbound policy, compliance, consent, 4-signal scope,
 * 24h window / approved utility template, and hard monthly/workspace budget gates
 * in strict fail-closed order.
 */
export function evaluateWhatsAppSendPolicy(
  input: WhatsAppSendPolicyInput,
): WhatsAppSendPolicyResult {
  if (input.waEnabled !== true) {
    return {
      allowed: false,
      code: 'adapter_disabled',
      reason: 'WhatsApp conditional monitoring adapter is disabled (wa.enabled=false).',
    };
  }

  if (typeof input.complianceSignOffId !== 'string' || input.complianceSignOffId.trim().length === 0) {
    return {
      allowed: false,
      code: 'missing_compliance_signoff',
      reason: 'Explicit Meta Business Platform AI and country eligibility complianceSignOffId is required.',
    };
  }

  if (input.optInStatus !== 'opted_in') {
    return {
      allowed: false,
      code: 'recipient_not_opted_in',
      reason: `Recipient opt-in status "${input.optInStatus}" does not permit outbound WhatsApp notifications.`,
    };
  }

  if (!ALLOWED_SIGNAL_CLASS_SET.has(input.signalClass)) {
    return {
      allowed: false,
      code: 'signal_class_not_allowed',
      reason: `Signal class "${input.signalClass}" is not permitted on WhatsApp; only accepted, heartbeat, attention, and terminal are allowed.`,
    };
  }

  const signalClass = input.signalClass as WhatsAppAllowedSignalClass;
  const windowOpen = isWhatsAppServiceWindowOpen(input.lastInboundAtIso, input.nowIso);

  let mode: 'session-text' | 'utility-template';
  if (input.template) {
    if (input.template.category !== 'utility') {
      return {
        allowed: false,
        code: 'template_not_utility',
        reason: `Only approved utility templates are permitted for WhatsApp monitoring signals (got "${input.template.category}").`,
      };
    }

    const templateValidation = validateWhatsAppTemplateForSend(
      input.template,
      input.templateRegistry ?? [],
    );
    if (!templateValidation.ok) {
      return {
        allowed: false,
        code: 'template_invalid',
        reason: templateValidation.reason,
      };
    }

    const allowedClasses = templateValidation.template.allowedSignalClasses;
    if (allowedClasses && allowedClasses.length > 0 && !allowedClasses.includes(signalClass)) {
      return {
        allowed: false,
        code: 'template_signal_mismatch',
        reason: `Template "${input.template.name}" is not mapped to signal class "${signalClass}".`,
      };
    }

    mode = 'utility-template';
  } else if (windowOpen) {
    mode = 'session-text';
  } else {
    return {
      allowed: false,
      code: 'window_closed_no_template',
      reason: '24-hour WhatsApp customer-service window is closed and no approved utility template was provided.',
    };
  }

  if (
    !isValidFiniteNonNegative(input.estimatedCost)
    || !isValidFiniteNonNegative(input.monthlySpent)
    || !isValidFiniteNonNegative(input.monthlyBudgetLimit)
    || !isValidFiniteNonNegative(input.workspaceSpent)
    || !isValidFiniteNonNegative(input.workspaceBudgetLimit)
  ) {
    return {
      allowed: false,
      code: 'invalid_cost_budget',
      reason: 'WhatsApp cost and monthly/workspace budget limits must be finite non-negative numbers.',
    };
  }

  if (input.monthlySpent + input.estimatedCost - input.monthlyBudgetLimit > BUDGET_TOLERANCE) {
    return {
      allowed: false,
      code: 'monthly_budget_exceeded',
      reason: `Estimated charge (${input.estimatedCost}) exceeds remaining monthly WhatsApp budget.`,
    };
  }

  if (input.workspaceSpent + input.estimatedCost - input.workspaceBudgetLimit > BUDGET_TOLERANCE) {
    return {
      allowed: false,
      code: 'workspace_budget_exceeded',
      reason: `Estimated charge (${input.estimatedCost}) exceeds remaining workspace WhatsApp budget.`,
    };
  }

  return {
    allowed: true,
    mode,
    reason: `WhatsApp send permitted via ${mode} for signal "${signalClass}".`,
  };
}

function parseRetryAfterSeconds(
  headers: { get?(name: string): string | null } | undefined,
): number {
  const rawHeader = headers?.get?.('retry-after');
  if (rawHeader) {
    const parsed = Number(rawHeader);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.ceil(parsed);
    }
  }
  return 5;
}

function extractMetaErrorMessage(parsed: unknown, fallbackStatus: number): { message: string; code?: string } {
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    const err = record.error;
    if (err && typeof err === 'object') {
      const errObj = err as Record<string, unknown>;
      const rawMessage = typeof errObj.message === 'string'
        ? errObj.message
        : typeof errObj.error_user_msg === 'string'
          ? errObj.error_user_msg
          : `Meta Cloud API HTTP ${fallbackStatus}`;
      const code = errObj.code !== undefined ? String(errObj.code) : undefined;
      return { message: sanitizeWhatsAppSignalText(rawMessage, 300), code };
    }
  }
  return { message: `Meta Cloud API HTTP ${fallbackStatus}` };
}

/**
 * Dispatches an outbound WhatsApp Cloud API monitoring message after running
 * `evaluateWhatsAppSendPolicy` and strict text/parameter sanitization.
 *
 * Never executes a network request when policy denies, and never conflates
 * `wamid` API acceptance with handset delivery.
 */
export async function sendWhatsAppCloudMessage(
  input: SendWhatsAppCloudMessageInput,
): Promise<SendWhatsAppCloudMessageResult> {
  const policyResult = evaluateWhatsAppSendPolicy(input.policy);
  if (!policyResult.allowed) {
    return {
      kind: 'permanent-blocked',
      reason: policyResult.reason,
      errorMessage: policyResult.reason,
      errorCode: policyResult.code,
    };
  }

  if (
    typeof input.phoneNumberId !== 'string'
    || input.phoneNumberId.trim().length === 0
    || typeof input.accessToken !== 'string'
    || input.accessToken.trim().length === 0
    || typeof input.recipientPhone !== 'string'
    || input.recipientPhone.trim().length === 0
  ) {
    const reason = 'WhatsApp phoneNumberId, accessToken, and recipientPhone are required.';
    return {
      kind: 'permanent-blocked',
      reason,
      errorMessage: reason,
      errorCode: 'invalid_transport_config',
    };
  }

  const version = (input.graphVersion ?? WHATSAPP_PINNED_GRAPH_VERSION).trim() || WHATSAPP_PINNED_GRAPH_VERSION;
  const url = `https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(input.phoneNumberId)}/messages`;

  let bodyPayload: Record<string, unknown>;
  if (policyResult.mode === 'utility-template' && input.template) {
    const sanitizedParams = (input.template.parameters ?? [])
      .map(param => sanitizeWhatsAppSignalText(param, WHATSAPP_MAX_MESSAGE_LENGTH));
    bodyPayload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: input.recipientPhone,
      type: 'template',
      template: {
        name: input.template.name,
        language: { code: input.template.language },
        ...(sanitizedParams.length > 0
          ? {
              components: [
                {
                  type: 'body',
                  parameters: sanitizedParams.map(text => ({ type: 'text', text })),
                },
              ],
            }
          : {}),
      },
    };
  } else {
    const sanitizedBody = sanitizeWhatsAppSignalText(input.messageText, WHATSAPP_MAX_MESSAGE_LENGTH);
    bodyPayload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: input.recipientPhone,
      type: 'text',
      text: {
        preview_url: false,
        body: sanitizedBody,
      },
    };
  }

  const fetchImpl = input.fetchImpl ?? (globalThis.fetch as unknown as WhatsAppFetch);
  let response: Awaited<ReturnType<WhatsAppFetch>>;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.accessToken}`,
      },
      body: JSON.stringify(bodyPayload),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: 'ambiguous-timeout',
      state: 'unknown',
      errorMessage: sanitizeWhatsAppSignalText(`WhatsApp Cloud API transport error: ${message}`, 300),
    };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    if (response.status === 429) {
      return {
        kind: 'rate-limited',
        retryAfterSeconds: parseRetryAfterSeconds(response.headers),
        httpStatus: 429,
        errorMessage: 'Meta Cloud API HTTP 429 (non-JSON body).',
      };
    }
    if (response.status >= 500) {
      return {
        kind: 'retryable',
        httpStatus: response.status,
        errorMessage: `Meta Cloud API HTTP ${response.status} (non-JSON body).`,
      };
    }
    return {
      kind: 'permanent-blocked',
      httpStatus: response.status,
      errorMessage: `Meta Cloud API HTTP ${response.status} returned non-JSON body.`,
    };
  }

  if (response.status === 429) {
    const errInfo = extractMetaErrorMessage(parsed, 429);
    return {
      kind: 'rate-limited',
      retryAfterSeconds: parseRetryAfterSeconds(response.headers),
      httpStatus: 429,
      errorMessage: errInfo.message,
    };
  }

  if (response.status >= 500) {
    const errInfo = extractMetaErrorMessage(parsed, response.status);
    return {
      kind: 'retryable',
      httpStatus: response.status,
      errorMessage: errInfo.message,
    };
  }

  if (!response.ok) {
    const errInfo = extractMetaErrorMessage(parsed, response.status);
    return {
      kind: 'permanent-blocked',
      httpStatus: response.status,
      errorMessage: errInfo.message,
      ...(errInfo.code ? { errorCode: errInfo.code } : {}),
    };
  }

  const messages = parsed && typeof parsed === 'object'
    ? (parsed as Record<string, unknown>).messages
    : undefined;
  const firstMessage = Array.isArray(messages) && messages.length > 0
    ? messages[0] as Record<string, unknown>
    : undefined;
  const wamid = firstMessage && typeof firstMessage.id === 'string' && firstMessage.id.trim().length > 0
    ? firstMessage.id
    : undefined;

  if (!wamid) {
    return {
      kind: 'permanent-blocked',
      httpStatus: response.status,
      errorMessage: 'Meta Cloud API response did not include messages[0].id (wamid).',
    };
  }

  return {
    kind: 'accepted',
    wamid,
    remoteMessageId: wamid,
    httpStatus: response.status,
    mode: policyResult.mode,
  };
}

const VALID_WEBHOOK_STATUSES = new Set<string>(['sent', 'delivered', 'read', 'failed']);

/**
 * Parses Meta Cloud API webhook `entry[].changes[].value.statuses[]` payloads into
 * structured status events with sanitized error details.
 */
export function parseWhatsAppStatusWebhooks(payload: unknown): WhatsAppWebhookStatusEvent[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const entries = (payload as Record<string, unknown>).entry;
  if (!Array.isArray(entries)) {
    return [];
  }

  const events: WhatsAppWebhookStatusEvent[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const changes = (entry as Record<string, unknown>).changes;
    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      if (!change || typeof change !== 'object') continue;
      const value = (change as Record<string, unknown>).value;
      if (!value || typeof value !== 'object') continue;

      const valueObj = value as Record<string, unknown>;
      const metadata = valueObj.metadata && typeof valueObj.metadata === 'object'
        ? (valueObj.metadata as Record<string, unknown>)
        : undefined;
      const phoneNumberId = metadata && typeof metadata.phone_number_id === 'string'
        ? metadata.phone_number_id
        : undefined;

      const statuses = valueObj.statuses;
      if (!Array.isArray(statuses)) continue;

      for (const item of statuses) {
        if (!item || typeof item !== 'object') continue;
        const statusObj = item as Record<string, unknown>;
        const wamid = typeof statusObj.id === 'string' ? statusObj.id.trim() : '';
        const status = typeof statusObj.status === 'string' ? statusObj.status : '';
        if (!wamid || !VALID_WEBHOOK_STATUSES.has(status)) {
          continue;
        }

        const recipientId = typeof statusObj.recipient_id === 'string' ? statusObj.recipient_id : '';
        const timestamp = statusObj.timestamp !== undefined ? String(statusObj.timestamp) : '';
        let timestampIso: string | undefined;
        if (/^\d+$/.test(timestamp)) {
          const epochMs = Number(timestamp) * 1000;
          if (Number.isFinite(epochMs)) {
            timestampIso = new Date(epochMs).toISOString();
          }
        }

        let errors: WhatsAppWebhookError[] | undefined;
        if (Array.isArray(statusObj.errors) && statusObj.errors.length > 0) {
          errors = statusObj.errors
            .filter((err): err is Record<string, unknown> => Boolean(err && typeof err === 'object'))
            .map(err => ({
              ...(typeof err.code === 'number' ? { code: err.code } : {}),
              ...(typeof err.title === 'string' ? { title: sanitizeWhatsAppSignalText(err.title, 200) } : {}),
              ...(typeof err.message === 'string' ? { message: sanitizeWhatsAppSignalText(err.message, 300) } : {}),
            }));
          if (errors.length === 0) {
            errors = undefined;
          }
        }

        events.push({
          wamid,
          status: status as WhatsAppWebhookStatus,
          recipientId,
          timestamp,
          ...(timestampIso ? { timestampIso } : {}),
          ...(phoneNumberId ? { phoneNumberId } : {}),
          ...(errors ? { errors } : {}),
        });
      }
    }
  }

  return events;
}

/**
 * Reconciles a WhatsApp Cloud API delivery webhook against the current delivery state
 * using strict monotonic progression (`pending < accepted < sent < delivered < read`).
 *
 * Out-of-order lower callbacks never downgrade higher committed states, duplicate callbacks
 * are idempotent no-ops, and `failed` transitions only from non-delivered/non-read states.
 */
export function reconcileWhatsAppStatusWebhook(
  currentState: WhatsAppDeliveryState,
  statusEvent: Pick<WhatsAppWebhookStatusEvent, 'wamid' | 'status' | 'errors'>,
): WhatsAppStatusReconciliationResult {
  if (statusEvent.status === 'failed') {
    if (currentState === 'failed') {
      return {
        updated: false,
        wamid: statusEvent.wamid,
        previousState: currentState,
        state: 'failed',
        outOfOrder: false,
        duplicate: true,
        ...(statusEvent.errors ? { errors: statusEvent.errors } : {}),
        reason: 'Duplicate failed status webhook ignored.',
      };
    }

    if (currentState === 'delivered' || currentState === 'read') {
      return {
        updated: false,
        wamid: statusEvent.wamid,
        previousState: currentState,
        state: currentState,
        outOfOrder: true,
        duplicate: false,
        ...(statusEvent.errors ? { errors: statusEvent.errors } : {}),
        reason: `Ignored out-of-order "failed" webhook while already "${currentState}".`,
      };
    }

    return {
      updated: true,
      wamid: statusEvent.wamid,
      previousState: currentState,
      state: 'failed',
      outOfOrder: false,
      duplicate: false,
      ...(statusEvent.errors ? { errors: statusEvent.errors } : {}),
      reason: `Transitioned from "${currentState}" to "failed".`,
    };
  }

  if (currentState === 'failed') {
    return {
      updated: false,
      wamid: statusEvent.wamid,
      previousState: currentState,
      state: 'failed',
      outOfOrder: true,
      duplicate: false,
      reason: `Ignored out-of-order "${statusEvent.status}" webhook while already "failed".`,
    };
  }

  const nextRank = MONOTONIC_PROGRESS_RANK[statusEvent.status];
  const currentRank = currentState === 'unknown' ? 0 : MONOTONIC_PROGRESS_RANK[currentState];

  if (nextRank === currentRank) {
    return {
      updated: false,
      wamid: statusEvent.wamid,
      previousState: currentState,
      state: currentState,
      outOfOrder: false,
      duplicate: true,
      reason: `Duplicate "${statusEvent.status}" webhook ignored.`,
    };
  }

  if (nextRank < currentRank) {
    return {
      updated: false,
      wamid: statusEvent.wamid,
      previousState: currentState,
      state: currentState,
      outOfOrder: true,
      duplicate: false,
      reason: `Ignored out-of-order "${statusEvent.status}" webhook while already "${currentState}".`,
    };
  }

  return {
    updated: true,
    wamid: statusEvent.wamid,
    previousState: currentState,
    state: statusEvent.status,
    outOfOrder: false,
    duplicate: false,
    reason: `Monotonically advanced from "${currentState}" to "${statusEvent.status}".`,
  };
}
