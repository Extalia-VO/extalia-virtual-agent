# ADR 0020: Daemon IPC transport and process model

Status: Accepted (2026-10-21; the owner accepted the recommended option).

## Context

The blueprint allows a Unix socket / named pipe or authenticated loopback for the daemon
API, and PRD §10 requires authenticated local clients, loopback-only binds, versioned
messages, cursors and backpressure. Gap-map decision 6 asks whether the daemon is a
sidecar started by Desktop and the CLI Bridge, or a separately installed long-lived service.

Repository facts ([audit](../implementation/REPO_AUDIT.md)):

- Desktop runs `@extalia/host` in the Electron main process (`apps/desktop/src/agentsIpc.ts`);
  the renderer reaches it only through one `contextBridge` API (`preload.ts`) with sender
  checks (`security.ts`).
- The Web client reaches the same `AgentHostApi` through the CLI Bridge
  (`apps/cli/src/bridge/server.ts`): HTTP + SSE on 127.0.0.1, per-launch token, Host
  allow-list, Origin check, body limits.
- One host per data directory (`packages/host/src/lock.ts`).
- The runtime's `commitEvent` acknowledgement is synchronous (ADR 0014); any process
  boundary makes it asynchronous.

## Options considered

| Option | For | Against |
| --- | --- | --- |
| **A. stdio pipes to a sidecar child** (length-prefixed or NDJSON frames) | No listening endpoint at all; only the parent can talk to it; parent death = EOF = daemon exit; identical on macOS/Windows/Linux; easy to test | Only one client (the host); a headless/service mode needs another transport later |
| B. Unix domain socket / Windows named pipe | Several local clients; OS permissions (0700 directory, pipe ACL) as first factor; peer credentials on some OSes | Two code paths per OS; stale socket files; still needs a token or peer check; more attack surface than A for slice A |
| C. Authenticated loopback HTTP (Axum) | Reuses the Bridge's proven pattern; curl-debuggable | A second loopback listener next to the Bridge and hook ingest; DNS-rebinding/Origin defences to duplicate; port allocation |
| D. gRPC | Typed streaming | New toolchain dependency; blueprint says do not lock in gRPC early. Rejected |

Process model: **sidecar** (child of the lock-holding host, lives as long as it) vs
**service** (installed, outlives the UI, several clients). A service is needed only for
headless automation (W8) and brings installers, OS service registration, upgrade while
running, and multi-client auth.

## Recommended decision

1. **Sidecar now, service deferred to W8** (answers gap-map decision 6 provisionally).
   Desktop main and the CLI Bridge each spawn the daemon only when the feature flag is on,
   after acquiring the profile lock, with a minimal allow-listed environment (no provider
   credentials). The daemon exits on stdin EOF and on a `shutdown` request; the host waits
   a bounded time, then kills it.
2. **Transport A: stdio**, with framing and messages defined in `@extalia/protocol` (daemon
   wire contract v1): startup `hello` (schema version, daemon version, capabilities), request
   id, operation, deadline, result/error code; bounded frame size; logs on stderr only, bounded.
   The message layer stays transport-agnostic so B can be added for the W8 service without
   changing messages.
3. **No new browser/renderer path.** The renderer stays behind `contextBridge`; the browser
   stays behind the Bridge; neither ever talks to the daemon. `AgentHostApi` signatures do
   not change in slice A; the host translates.
4. No HTTP listener in the daemon until a service ADR; `/v1/*` endpoints of PRD §10 stay
   illustrative and are served, if ever, by the Bridge.

## Consequences

- Asynchronous acknowledgement requires an ADR 0014 amendment and an async runtime port
  (audit PR 3) before any effect depends on the daemon.
- A daemon crash is a persistence failure for its missions (latch → `recovering`), not a
  host crash.
- Electron spawns a native child: macOS hardened runtime/notarization applies to the binary
  (ADR 0021).

## Open questions for the owner

1. Confirm sidecar now / service in W8.
2. Should the Bridge and Desktop ever run concurrently against one profile (today forbidden)?
   A "yes" forces option B or C earlier.
3. Framing: NDJSON (debuggable) or length-prefixed (binary-safe)? Proposal: length-prefixed
   JSON for the daemon, NDJSON for the Python worker (ADR 0022).

## Note (2026-10-24): knowledge requests on their own daemon thread

A vault sync can take minutes, and the host gives mission and permission requests a 5 s
deadline on the same connection (a missed deadline ends it). The daemon now runs every
`knowledge.*` request on one dedicated thread that owns the profile's knowledge index (and its
lock), strictly in arrival order; the reading thread keeps answering `hello`, `health`,
`permission.check`, the mission operations and the skill operations meanwhile
(`crates/extalia-daemon/src/session.rs`).

- **Ordering.** Answers may leave in another order than the requests arrived; each carries its
  request id and the host already correlates by id (`packages/host/src/daemon/client.ts`).
  Knowledge requests keep their relative order. No wire change and no new capability: a host
  must not assume answers in request order.
- **Framing.** One writer lock covers each whole frame (encode, write, flush), so frames from
  the two threads never interleave.
- **Deadlines.** A knowledge request whose deadline passed while it waited behind another is
  answered `deadline_exceeded` without running. A running request is not interrupted.
- **Shutdown.** On stdin EOF (or a fatal protocol error) the knowledge requests already received
  are run and answered, then the daemon exits with its usual status (0 on EOF). The host keeps
  serializing its own knowledge requests behind a sync (`packages/host/src/knowledge.ts`), since
  they still queue behind it in the daemon.
