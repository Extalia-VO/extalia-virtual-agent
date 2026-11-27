# ADR 0101: WhatsApp Cloud API / BSP conditional monitoring adapter (`GW-WP-14`)

- Status: Accepted (M4 Conditional Monitoring Adapter, Issue #141, Refs #145)
- Date: 2026-11-26
- References: [Universal Gateway v2 PRD](../product/prd-universal-gateway-v2.md), [ADR 0098](0098-universal-gateway-and-autonomous-reports.md), [Architecture Overview](../architecture/overview.md)

## Context

Extalia's Universal Gateway v2 (`M0`–`M3`) provides a provider-neutral Host storage, identity, routing, durable outbox, and canonical autonomous workspace reporting core, with interactive adapters for Discord (`M1`) and Telegram (`M2`) plus scheduled/autonomous fanout (`M3`).

WhatsApp (`M4`, `GW-WP-14`..`GW-WP-16`) is fundamentally different from Discord and Telegram:

1. **Platform & Legal Eligibility Restrictions:** Meta's WhatsApp Business Platform Terms restrict general-purpose AI assistant chatbots as a primary service and enforce strict business use-case, target-country, template-category, and consent requirements. Technically being able to call the Cloud API does not certify product or legal eligibility.
2. **Unofficial Automation Prohibition:** Unofficial WhatsApp Web reverse-engineered clients or browser automation violate platform terms and lack authentic delivery/identity receipts.
3. **24-Hour Customer-Service Window & Template Enforcement:** Outbound free-form text is only lawful inside an active 24-hour customer-service window opened by a verified inbound customer message—never by an outbound business message. Outside that window, only currently approved templates of an eligible category (`utility`) may be sent.
4. **October 1, 2026 Pricing & Hard Budget Risk:** Effective October 1, 2026, WhatsApp Business Platform pricing rules changed across service and utility messages in many markets, meaning neither service-window nor template messages can be assumed free. Unbounded heartbeats or retries can generate unexpected billing.
5. **Bounded Reporting Scope & Honest Delivery Semantics:** WhatsApp is unsuitable for raw step-by-step tool feeds, source paths, diffs, or general coding chat. Furthermore, Cloud API `POST /messages` returning a `wamid` proves API acceptance only—never handset delivery or read state—and async status webhooks (`sent`, `delivered`, `read`, `failed`) can arrive delayed, duplicated, or out of order.

## Decision

### 1. Conditional, fail-closed enablement (`wa.enabled = false` default)

The WhatsApp adapter (`packages/host/src/gateway/whatsapp.ts`) is **disabled and fail-closed by default**:

- `waEnabled` must be explicitly `true`, **and** a non-empty `complianceSignOffId` (recording written Meta Business Platform AI use-case, WABA account, and target-country eligibility sign-off) must be present at send time.
- If either gate is absent, `evaluateWhatsAppSendPolicy(...)` and `sendWhatsAppCloudMessage(...)` refuse outbound delivery with zero network calls (`permanent-blocked`), while canonical workspace reports remain preserved inside Extalia Chat and Workspace Reports Inbox.

### 2. Official Meta Cloud API / approved BSP transport only

Only the official Meta WhatsApp Business Platform Cloud API (pinned to `WHATSAPP_PINNED_GRAPH_VERSION = 'v21.0'` unless explicitly certified otherwise) or an authorized Business Solution Provider (BSP) exposing authentic Meta `wamid`, sending phone number ID, template category, and cost basis is permitted. Unofficial WhatsApp Web automation is strictly prohibited.

- Webhook registration (`GET`) validates `hub.mode === 'subscribe'`, checks `hub.verify_token` via constant-time `timingSafeEqual`, and requires a non-empty `hub.challenge`.
- Webhook ingestion (`POST`) validates `X-Hub-Signature-256` (`sha256=<hex>`) using HMAC-SHA256 over raw request bytes with `timingSafeEqual`, failing closed on missing, malformed, or mismatched signatures.

### 3. Explicit revocable opt-in consent

Outbound notifications require explicit `optInStatus === 'opted_in'` revalidated at send time immediately before dispatch.

- Opt-out commands (`STOP`, `UNSUBSCRIBE`, `BERHENTI`, `OPT OUT`, `OPTOUT`, case-insensitive) recognized by `isWhatsAppOptOutText(...)` revoke consent immediately and block subsequent queued or scheduled sends without fallback to alternative recipients.
- Recipient phone reassignment requires fresh identity/opt-in reverification before resuming sends.

### 4. Restricted four-signal monitoring scope and redaction

WhatsApp declares capability bounds (`WHATSAPP_CAPABILITIES`) with `requiresComplianceGate: true`, `receiveCommands: false`, `createOrResumeSession: false`, `perAgentWebhookPortraits: false`, `editMessages: false`, `attachments: false`, `supportsCancel: false`, `deliveryCallbacks: true`, and `maxMessageLength: 1024`.

- Outbound policy permits **only** the four bounded monitoring signal classes: `accepted`, `heartbeat`, `attention`, and `terminal`.
- `milestone`, `system-report`, step-by-step worker/tool feeds, and general-purpose coding chat are rejected by policy.
- `sanitizeWhatsAppSignalText(...)` strips control characters, mass mentions, credentials, Unix/Windows filesystem paths (e.g. `/Users/<name>/...`, `C:\Users\<name>\...`, `/etc/...`), stack traces, and raw tool-output lines, enforcing `<= 1024` characters before transport.

### 5. 24-hour customer-service window and approved utility template registry

- `isWhatsAppServiceWindowOpen(lastInboundAtIso, nowIso)` enforces a strict 24-hour window (`0 <= deltaMs <= 86_400_000`), failing closed on missing, invalid, future, or expired timestamps.
- Outside an open 24-hour window, free-form text is blocked; only an exact match in the local template registry (`approved === true`, exact `name`, `language`, and `category: 'utility'`) via `validateWhatsAppTemplateForSend(...)` is permitted.
- `marketing` and `authentication` templates are rejected for monitoring signals so no category-substitution bypass is possible. Approval state is rechecked at send time.

### 6. October 1, 2026 pricing awareness and hard dual budgets

- Every policy evaluation requires explicit finite non-negative `estimatedCost`, `monthlySpent`, `monthlyBudgetLimit`, `workspaceSpent`, and `workspaceBudgetLimit`.
- Neither service-window messages nor utility templates are assumed free; missing/non-finite cost inputs fail closed.
- Sends exceeding either `monthlyBudgetLimit` or `workspaceBudgetLimit` are blocked before any network call.

### 7. Honest `wamid` acceptance, `unknown` timeout quarantine, and monotonic webhooks

- `sendWhatsAppCloudMessage(...)` separates HTTP transport outcomes cleanly:
  - `2xx` with `messages[0].id` -> `accepted` (with `wamid`; never claims `delivered`).
  - `429` -> `rate-limited` (respecting `Retry-After`).
  - `5xx` -> `retryable`.
  - Other `4xx` / malformed success response -> `permanent-blocked`.
  - Transport error / `AbortError` timeout -> `ambiguous-timeout` (maps to `unknown` quarantine, never blindly retried).
- `parseWhatsAppStatusWebhooks(...)` and `reconcileWhatsAppStatusWebhook(...)` enforce monotonic delivery state progression (`pending < accepted < sent < delivered < read`), treating duplicate callbacks as idempotent no-ops and out-of-order stale callbacks (e.g. `sent` arriving after `delivered` or `read`) as audited anomalies without state regression. `failed` records terminal provider failure only from non-delivered/non-read states (`pending`, `accepted`, `sent`, `unknown`).

### 8. Synthetic unit verification vs. live WABA certification

Unit and integration tests in `packages/host/test/gatewayWhatsapp.test.ts` verify policy gates, HMAC signatures, 24h window boundaries, template registry validation, sanitization, budget caps, mocked Cloud API error mapping, and monotonic webhook reconciliation (`GW-AT-057`..`GW-AT-076`). These synthetic tests **do not** constitute live production certification (`GW-AT-077`), which remains gated on a real eligible WABA, written legal/policy sign-off, live approved utility templates, real account rate-card verification, and end-to-end delivery/billing receipts.

## Consequences

- `packages/host/src/gateway/whatsapp.ts` provides a pure, fail-closed policy and Cloud API transport boundary with zero unauthenticated network side effects and zero Host/workspace execution authority.
- Existing `waEnabled: false` defaults in Host Gateway fanout remain intact, ensuring accidental enablement cannot occur without explicit operator configuration, compliance sign-off, opt-in consent, and budget bounds.
- Production activation (`GW-AT-077`) remains an explicit release gate requiring live WABA and legal/operations verification.
