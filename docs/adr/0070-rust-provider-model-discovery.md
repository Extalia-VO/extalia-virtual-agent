# ADR 0070: Rust-owned OpenAI-compatible model discovery

Status: Implemented and verified locally in v0.4.242 (2026-11-09).

Completion candidates are subsequently compared in
[ADR 0071](0071-rust-openai-completion-and-resource-evidence.md), which retains
TypeScript completion after measurement. The ownership
and validation descriptions below remain the v0.4.242 discovery-only snapshot.

## Context

ADR 0069 requires real provider processing to move out of TypeScript. The first
provider increment must remain smaller than the full streaming tool loop, whose
large inputs, backpressure, budgets and execution lifetimes need separate work.
Model discovery is a bounded, read-only GET used by setup, model selectors and
mission planning. It must retain the existing connection and planning admission
checks before credentials or network access.

## Decision

The shipped `extalia-daemon` executable gains an exclusive `--provider-models`
mode. It runs before profile initialization and rejects combinations with store,
profile or vault arguments. It does not open SQLite or read a credential store.
The ordinary profile daemon and its protocol remain separate.

The dedicated `extalia.provider-models.v1` contract carries one request over
stdin, requires EOF, and returns one JSON response before process exit. A UUID
binds the reply. The input cap is 16 KiB; the output cap is 128 KiB. Credentials
travel only in this private request, never command arguments, environment,
persisted receipts or diagnostic text. Child stderr is drained without retaining
its contents, with a 4 KiB limit.

Rust owns endpoint construction, bearer authentication, the preset memory
opt-out header, HTTP transport, response parsing and catalog normalization.
`reqwest = 0.13.5` is pinned with default features disabled and only `blocking`
and `rustls` enabled. The endpoint may use HTTP for configured local routers or
HTTPS with certificate verification. No provider key or production endpoint is
needed for tests.

Limits are enforced while reading: a 2 MiB response body cap, 10,000 catalog rows,
strict ASCII model identifiers of at most 200 characters, sorted unique results
and at most 500 returned models. A truncation flag records the last cap. Invalid
response shapes do not attest a working connection. HTTP failures expose only
their status, never a provider's potentially sensitive error body.

The host's existing OpenAI-compatible provider forwards discovery to this native
port; its JavaScript `/models` request and JSON parser are removed. Setup tests,
model selectors and planning use the same port. Custom `fetch` injection does
not select an alternate JavaScript discovery path. Tests that need fixtures use
an explicit discovery port, while integration tests exercise the default Rust
path against actual local HTTP servers.

## Lifetime and permissions

The existing user-selected connection, secret acquisition, resource exclusions
and durable planning admissions remain authoritative. Catalog contents do not
grant a model, connection, task, file or tool permission.

The narrow Node client retains at most four admitted child handles, with no
waiting queue or automatic replay. Rust owns one HTTP operation per child.
Result delivery, cancellation and timeout do not release the handle: the client
waits for positively observed child close. A failed spawn with no process is a
separate settled failure. Unconfirmed termination remains pending; there is no
timer that invents settlement. Host shutdown aborts and drains these handles
before releasing the profile lock. A kill watchdog is not a promise that the OS
will reap an uninterruptible process by an absolute deadline.

The HTTP operation has a maximum 15-second total connect/body timeout. The client
also has a 16-second kill watchdog for startup and protocol failures; caller
cancellation can initiate termination sooner. A response alone never establishes
local settlement. This does not prove that a remote server stopped processing.

## Deliberate compatibility boundaries

- Redirects and retries are disabled. A redirect cannot forward credentials or
  silently change the selected endpoint; configure its final URL instead.
- Environment proxies are disabled and the minimal child environment excludes
  provider credentials and Node-specific network settings. Proxy and custom-CA
  parity are not claimed. Reqwest's platform certificate verification can differ
  from the former Node trust configuration; TLS validation is never disabled.
- Connection tests now receive filtered, unique, bounded models rather than an
  unfiltered provider response. Missing `data`, invalid JSON, excessive response
  size and failed native transport are errors.
- Only explicit HTTP 404, 405 and 501 preserve the existing one-word inference
  fallback. Cancellation, missing binaries, malformed replies, redirects and
  authentication failures cannot trigger that fallback. Shutdown checks run
  before fallback inference.
- Older binaries without this mode report discovery unavailable. The normal
  applications ship matched daemon binaries; no JavaScript discovery fallback
  is silently enabled. This change does not alter external observed harnesses.

## Ownership accounting and remaining work

The Node child transport is transitional privileged code and remains in the
backend inventory. The new shared envelope validator is also conservatively
recorded as shared review code. The reviewed baseline grows from 224 to 226
outstanding files; that count is not a measure of migrated computation. HTTP,
raw-body parsing and catalog normalization for this path genuinely execute in
Rust, while the remaining debt stays visible.

The baseline review covers `packages/host/src/daemon/modelDiscovery.ts`, the
targeted composition changes in `service.ts`, the protocol export/validator and
the two runtime provider files. It does not exempt these paths from strict
ownership or refresh unrelated source changes. No zero-backend-JavaScript claim
is made.

Anthropic discovery/pagination, completion HTTP/stream parsing, request assembly,
fallback, budgets, host catalog caching, turn/history state, tools and remaining
stores still need migration. Full executor membership, writer fencing, physical
reconciliation, exact action approvals and evidence acceptance remain separate
open PRD gates. This increment closes none of those broader gates.

## Validation

Real executable tests use synthetic local HTTP servers and temporary directories.
They cover authentication/header parity, no profile initialization, strict input
and EOF, invalid identifiers, malformed/oversized catalogs, redirect refusal and
total deadlines including trickled bodies. Host tests cover the default Rust
route, model selectors/cache, narrow inference fallback and real delayed-catalog
planning cancellation. Controlled child tests verify that replies, cancellation,
output overflow and failed exits cannot free capacity before close.

The full `pnpm check` passed: 7,798 TypeScript tests (26 optional skips),
517 Rust tests, lint/boundaries/public-safety/schema and ownership-baseline checks,
typechecks, formatting, Clippy with warnings denied, all builds and version/asset
checks. Strict backend ownership still fails as expected: 226 outstanding files
remain explicitly tracked, not exempted.

A signed release daemon also performed actual catalog HTTP against a synthetic
loopback server with an empty child environment and a temporary working directory.
It returned a valid versioned reply, closed normally and created no profile or
database. This verifies the macOS ARM64 executable, not a complete installer or
other packaged targets. Detailed sanitized results are in
[the evidence record](../architecture/native-provider-models-evidence.json).

The current local evidence is macOS ARM64. Portable source and CI tests do not
establish packaged TLS/proxy behavior or certification on other targets. No real
profile, external application configuration, paid provider or publication is used.

Sources: [OpenAI model listing](https://developers.openai.com/api/reference/resources/models/methods/list),
[reqwest blocking client](https://docs.rs/reqwest/0.13.5/reqwest/blocking/struct.ClientBuilder.html).
