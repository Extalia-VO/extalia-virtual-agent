# ADR 0033: Durable execution identity and turn-settlement observations

Status: Implemented locally v0.4.120, 2026-10-29; bounded gate 3.3D1

## Context

Timeout, cancellation and lease reaping correctly preserve uncertainty, but the
runtime currently retains eventual turn settlement only in a closure. Reaping
deletes live leases, so canonical recovery inspection also loses execution epoch
identity. Neither host restart nor absence of a local promise proves physical
settlement. Even `runTurn` rejection can precede another parallel tool finishing;
some tool adapters can resolve before child termination. Terminal reconciliation
must not infer stronger evidence from those signals.

## Decision

Core migration 7 adds immutable execution admissions and once-only observations.
The host creates a supervisor invocation UUID and supplies it only on a fresh
queued/assigned-to-running transition. In the same transaction as the running
lease/event, Rust records profile, workspace, mission, task, assignee, attempt,
supervisor, lease epoch, admitted mission version, task/graph digests and time.
The canonical admission digest binds that captured identity. Graph digest names
the graph at admission, not independently proven immutable original membership.
Legacy transitions without a supervisor produce no admission; migration never
backfills invented execution identity. Live lease removal does not remove it.

Add `execution.observe` and bounded `mission.executions` daemon operations.
An observation is bound to the exact admission digest and identity and says only
`turn-promise-settled`. It carries no output, success, physical-stop claim or
model-provided text. The first observation is immutable; exact retries return the
same acknowledgement, conflicting reuse is refused. Receipt and admission writes
are transactional and profile-scoped. At most 64 records belong to a current
mission; snapshots/observations survive restart and reaping.

Runtime notifies the trusted host only from actual `runTurn` fulfillment/rejection
handlers, including after the supervisory invocation returned recovering. Abort,
grace expiry, cleanup and restart never notify. The host persists the observation
using the captured admission and original daemon connection, without reconnect or
authority fallback. Invocation disposal stops heartbeat but must not manufacture
or suppress an otherwise valid late observation while the host remains open.
After host shutdown begins, late callbacks do not write. Recording failure is
reported generically and leaves existing quarantine intact.

Observation is deliberately separate from execution authority. It may be stored
after recovery or a terminal state, but never renews a lease, admits tools, changes
mission/task state, replays work or releases/integrates/deletes a worktree. A
latched store/reaper failure still refuses observation writes. Recovery exposes
records as bounded read-only evidence and explicitly states the evidence limit.

## Remaining gates and verification

This is not terminal reconciliation or proof that all local effects stopped.
Future closure must account for underlying operations and child-exit obligations,
seal admission, bind complete task/worktree identities and revalidate a reviewed
canonical version/sequence/digest inside the closing transaction. A crash without
previously committed sufficient evidence remains unresolved. Scoped execution
approvals (3.4), Python workers and scanner distribution remain separate work.

The existing ADR 0030 repair of a host-restart display shadow from an already
terminal canonical mission remains separate: it repairs a projection, excludes
genuine execution uncertainty and does not use these observations as authority.

Tests cover admission-before-effects, legacy absence, late fulfillment/rejection,
no premature observation, weaker parallel-tool semantics, exact identity/digest
refusals, duplicate/conflicting requests, write rollback, reaper/restart retention,
missing authority and shutdown. No live-provider or full gate 3.3 acceptance is
claimed by this slice.

Verification: full `pnpm check` passes: 286 suites / 3,321 passing tests and
one skipped; 237 Rust tests (167 core, 70 daemon), strict Clippy/format, schema
parity, typechecks and Web/Desktop/CLI builds pass. Real temporary-daemon host
tests cover admission failure before effects, late observation after timeout,
restart retention, failed observation persistence and shutdown suppression.
Recovery previews pass in light/dark and at 390px, including Indonesian text
without horizontal overflow. The isolated preview logged a missing favicon,
not a recovery component error. Preview files/server/browser were removed/stopped.
