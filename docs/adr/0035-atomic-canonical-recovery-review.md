# ADR 0035: Atomic canonical recovery review

Status: Implemented locally v0.4.122, 2026-10-29; gate 3.3D3 prerequisite

## Context

Recovery previously read `mission.snapshot` and `mission.executions` separately.
Lease reaping, a state commit or late settlement evidence could occur between
those reads. The resulting display was useful information, but could not serve
as a coherent basis for a future explicit reconciliation decision. Mission
version and journal sequence alone do not change when late evidence arrives.

## Decision

Add the read-only, profile-scoped `mission.recoveryReview` operation. One deferred
SQLite transaction pins the complete validated canonical mission/task graph,
projected snapshot, recorded leases and all bounded execution admissions with
weak observations and scoped local-drain proofs. Existing execution readers
share the same transaction helper rather than opening a nested transaction.
No migration or stored review receipt is needed for this read-only increment.

Return complete mission and graph hashes plus a domain-separated, profile-bound
`reviewDigest` over the review body, including version, sequence, current leases,
admission identities, evidence and explicit missing membership. The full graph
hash covers task content omitted from the projected snapshot. A late observation,
local-drain proof, heartbeat, journal append, reaping or graph change invalidates
the old digest. Exact unchanged reads have the same digest; the wire treats
hashes as opaque identifiers, not independently verified authorizations.

`missingAdmissionTaskIds` is exactly every current graph task without a captured
admission. This includes never-started tasks: absence never implies settlement.
Portable TypeScript and Rust parsers validate cross-record mission, workspace,
task, assignee, attempt, version, current lease and missing-membership identity.
Unknown fields, false ownership certification and oversize arrays are refused.
The response stays bounded well below the daemon's 1 MiB frame maximum.

The host prefers this operation when advertised. A failed supported review never
falls back to mixed separate reads. Older daemons keep informational inspection,
explicitly labelled as lacking a coherent review. After every await the host
rechecks local guards and saved ownership; populated evidence must match the
persisted supervisor. Empty legacy evidence can be displayed without inventing
one. The panel shows the review scope, missing task admissions and an expandable
fingerprint in English and Indonesian. Refresh clears the prior displayed review.

## Boundaries and next gate

This operation neither persists a user decision nor closes, retries or resumes a
mission. It does not change leases, journal rows, task states, retained results,
capacity guards, integration or worktrees. Existing ADR 0030 repair of an already
terminal canonical mission's host-restart projection remains separate.

Worktree ownership is always `unverified`: its mutable host-side registry is not
part of this SQLite view. The graph also does not certify planner activity,
unknown descendants, custom detached work, remote inference cancellation, network
shutdown or rollback. Even zero missing task admissions and complete local-drain
records cannot establish complete physical settlement.

Before any terminal reconciliation, capture immutable applicable execution and
worktree ownership, fence writers, bind an explicit decision to this review's
version/sequence/digest and recompute it within the committing write transaction.
A changed review must refuse the decision. Durable idempotent closure, execution-
time approvals (3.4), Python/scanner workers and v0.5 acceptance remain open.

## Verification

Focused tests cover stable read-only/profile-bound digests, missing legacy and
never-started admissions, late evidence without version/sequence changes,
heartbeat/journal invalidation, restart, corruption refusal and a concurrent
canonical writer proving that the review uses one pinned SQLite read view.
Wire fixtures cover grammar and named semantic schema gaps in both parsers.
Host tests cover capability fallback, supported-operation failure, ownership
changes/reservations during await, actual daemon late evidence and terminal
projection repair with the coherent review. UI tests cover both languages and
all availability/missing-membership states without a new closure action.

Full `pnpm check` passes at v0.4.122: 288 suites, 3,437 passing tests and
one skipped; 249 Rust tests (178 core, 71 daemon), strict Clippy/format,
schema parity, typechecks and Web/Desktop/CLI production builds pass.
Light/dark and 390px EN/ID previews pass without horizontal overflow; the
preview browser/server and temporary source files were removed. No live-provider,
cross-OS release or complete physical-settlement/reconciliation claim.
