# ADR 0098: Universal Gateway foundation and autonomous workspace reports

- Status: Accepted (M0 Foundation)
- Date: 2026-11-24
- References: [Universal Gateway v2 PRD](../product/prd-universal-gateway-v2.md), [Architecture Overview](../architecture/overview.md), [ADR 0074](0074-deferred-learning-and-workspace-knowledge.md), [ADR 0086](0086-native-user-skill-learning-sources.md), [ADR 0093](0093-source-grounded-project-knowledge.md)

## Context

Extalia integrates external messaging surfaces (Discord, Telegram, conditional WhatsApp, and future capability-constrained providers) and produces autonomous background outcomes from post-task learning, source-grounded project Knowledge builds, team Knowledge meetings, learned skill candidate curation, and recurring maintenance schedules.

Without a single provider-neutral Host foundation:

1. External transports risk becoming duplicate state owners, bypassing workspace boundaries, or turning the loopback Bridge into a public attack surface.
2. External identities, routes, and reply targets can drift or be spoofed via mutable display names or stale route revisions.
3. Autonomous Knowledge and Skill results can vanish into transient UI notices, leak across workspaces or private sessions, mutate immutable observed transcripts, or trigger recursive prompt/learning loops.
4. Network timeouts during remote sends can cause blind retries and duplicate external side effects, or falsely conflate remote delivery with Host execution/artifact success.

## Decision

### 1. Host-owned transactional `state/gateway.sqlite` lane

Gateway state lives in `<EXTALIA_HOME>/state/gateway.sqlite`, owned exclusively by the single authoritative Extalia Host for that profile root (`0o700` directory, `0o600` database and WAL/SHM sidecars, `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`, `PRAGMA synchronous = FULL`).

- It is a **separate SQLite lane** from the Rust Knowledge/mission stores (`core.sqlite`) and the Schedule store. Gateway code never inserts rows into Rust Knowledge or mission tables and never duplicates artifact lifecycle authority; it consumes verified Host/Rust receipts.
- Schema version is enforced via `PRAGMA user_version`. Opening a database created by a newer schema version fails closed (downgrade refusal) rather than mutating or silently recreating state.
- Connector credentials are persisted strictly as opaque `secretRef` pointers; raw tokens and webhook URLs are never stored in Gateway tables, configuration JSON, or audit payloads.
- All critical uniqueness and idempotency invariants (`inboundKey`, `leadActionKey`, `autonomousKey`, `reportRevisionId`, `deliveryKey`) use deterministic SHA-256 digests over stable IDs and revisions—never mutable display names, message bodies, or timestamps alone.

### 2. Private Host Gateway API boundary (loopback Bridge untouched)

Provider adapters are transport and presentation boundaries only (`GatewayAdapter`), implementing capability discovery, origin-authenticated inbound normalization, and bounded outbound send/edit.

- Adapters never instantiate a second Host, read workspaces directly, execute tools, or activate skills.
- Any future public webhook edge runs as an isolated receiver that verifies provider-specific authenticity (signatures/secrets) and forwards to a private authenticated Host Gateway API. The local loopback Bridge (`apps/cli/src/bridge/server.ts`) remains strictly private and loopback-only.

### 3. Challenge-confirmed external principal linking

External platform accounts are untrusted by default (`untrusted_external`). Privileged inbound actions require a linked Extalia principal stored in `gateway_principal_links`:

- Linking uses a Host-issued, short-lived, salted SHA-256 challenge digest bound to `(connectorId, extaliaPrincipalId, expiry)`.
- External proof submission binds the exact platform actor ID and tenant/account namespace, and requires explicit confirmation by an authenticated Extalia session.
- Challenges are strictly one-time: replay, forwarded codes, expired challenges, display-name matching, and anonymous group admins are rejected and audited.
- Revocation immediately invalidates subsequent inbound actions and callbacks for that principal link.

### 4. Deterministic route precedence with zero cross-workspace fallback

Inbound conversation resolution follows a strict deterministic precedence order against active, registered workspaces only:

1. Existing active exact external conversation binding (`connectorId + providerAccountId + channelId + normalizedThreadId`) and its pinned session, revalidated against current ACL.
2. Explicit active route for that exact thread/topic.
3. Explicit active parent channel/group route (according to its session mode).
4. Explicit configured personal-DM default for a linked principal (when enabled).
5. Fail closed with a safe refusal; never fall back to a globally latest session, workspace name match, or unregistered filesystem path.

Route edits increment `policyRevision` and fence pending actions/outbox intents; stale revisions are refused rather than silently redirected. Reply-to-worker routing resolves strictly via stored `(connectorId, remoteMessageId)` receipts in `gateway_remote_receipts`—never by parsing visible usernames or avatars—and refuses missing receipts.

### 5. Canonical `WorkspaceSystemReport` ledger and Chat projection

Every eligible autonomous terminal outcome (learning, project Knowledge build, Knowledge meeting, skill candidate, or scheduled maintenance) is committed first to `gateway_report_ledger` from verified Host/Rust receipts, independent of external network availability.

- **Deduplication and immutable revisions:** Reports deduplicate by `autonomousKey` (and optional `maintenanceIntentKey` for overlapping periodic maintenance and post-task curator evidence). Partial-to-terminal settlement appends immutable revisions under the same `reportId` without erasing earlier confirmed artifact receipts, and out-of-order lower revisions cannot overwrite higher committed outcomes.
- **Target selection (`latest-eligible-in-source-workspace`):** Computed at commit time within the exact source `workspaceId` and `audienceScopeId`:
  1. Configured pinned report Chat for that workspace, if still eligible and authorized.
  2. Latest eligible retained foreground Chat in the same workspace, ordered by genuine human/agent foreground `lastActiveAt` (excluding system reports, bot notifications, and maintenance updates) with deterministic `chatId` tie-break.
  3. Configured `source-session-only` target when eligible.
  4. Fallback to the workspace `Reports Inbox` (`targetChatId = null`, `targetSelection = 'inbox'`).
- **Isolation and no-loop guarantees:** A newer Chat in another workspace is never selected. Deleted, history-off, private-to-another-user, profile-mismatched, or observed immutable source transcripts are excluded. Once committed, a report's target is pinned and never migrated when newer chats are created. Skill candidate reports always preserve `activationPerformed: false` until separate explicit user approval and activation.
- **Read-only system cards:** Projected Chat entries (`gateway_chat_projections`) are marked read-only system cards excluded from Native model history, prompt submission, and automatic learning triggers so reporting cannot create feedback loops.

### 6. Durable outbox, rate isolation, and `unknown`-send quarantine

External fanout is strictly downstream of canonical report commitment and subject to fresh policy/ACL revalidation at dispatch time.

- Outbound intents (`gateway_outbox`) are enqueued transactionally before any network call, ordered by priority (`P0` critical health/approval > `P1` terminal/partial > `P2` accepted/milestone > `P3` heartbeat/digest) with per-`(connectorId, targetBindingId)` rate buckets so noisy destinations cannot starve critical alerts.
- Explicit `429 retry_after` responses schedule bounded backoff without duplicating the intent.
- Permanent `403`/blocked/revoked failures transition the intent to `blocked` and halt delivery without falling back to an unapproved destination.
- Ambiguous network timeouts after send dispatch transition the intent to `unknown` (quarantined) and record an append-only attempt row in `gateway_send_attempts`. Quarantined `unknown` intents block blind resend until explicit remote receipt reconciliation proves non-delivery or confirms acceptance.
- Delivery receipts reconcile monotonically (`accepted -> delivered -> read`), and delivery failures never mutate Host execution or Knowledge/Skill artifact status.
- Health reporting preserves five distinct dimensions (`transport`, `host`, `runtime`, `progress`, `notification`) rather than collapsing liveness into a single boolean.

## Consequences

- M0 establishes a complete, provider-neutral Host storage, trust, routing, autonomous reporting, and durable outbox core with zero external network dependencies.
- Later milestones (M1 Discord, M2 Telegram, M3 Automation fanout, M4 conditional WhatsApp, M5 Headless/Watchdog) build strictly on these contracts and tables without modifying Host execution authority or core runtime isolation.
- Tests exercise all storage, routing, isolation, report projection, and outbox invariants against temporary profile directories with deterministic clocks and synthetic receipts; live provider acceptance remains a separate gate per milestone.
