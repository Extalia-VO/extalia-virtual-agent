# ADR 0052: Durable mission-start preparation lifetime

Status: Verified locally v0.4.183, 2026-11-08; V2-03 prerequisite

## Context

`startNativeMission` prepares credentials and isolated worktrees before canonical
mission creation. Its in-memory reservation could disappear on restart before
the mission existed. Parallel credential preparation also used an early-rejecting
aggregate, allowing a failed caller to release its reservation while another
entered credential operation still ran. ADR 0047 covers automatic planning,
which is a distinct lifetime and cannot stand in for mission execution.

## Decision

Saved Rust missions record a preparation admission before credential or worktree
entry. The host allocates mission and canonical workspace IDs first; a separately
allocated supervisor ID is reused by the actual daemon mission adapter. The
receipt binds these identities to the host session/workspace and sorted selected
connections. It contains no prompt, instructions, credentials, endpoints or output.

Migration 13 adds immutable `STRICT, WITHOUT ROWID` admissions, claims and local
observations. Profile-bound digests, daemon timestamps, exact replay, bounded
payloads and a 1,024-admission profile history follow the planning model. One
immediate transaction admits all session/connection claims. Bidirectional SQL
and application checks prevent overlap with pending planning claims. Pending
preparation neither expires nor becomes replayable on restart.

The additive optional operations are `preparation.begin`, `preparation.observe`
and `preparation.inspect`. The frozen v1 hello fields and required-operation
baseline remain unchanged. Saved Rust missions refuse missing capabilities;
TypeScript and history-off missions retain their existing persistence behavior.

## Host lifetime and handoff

Before admission, a synced write-ahead marker in `state/native-preparation.json`
installs the session/connection blocker. The registry caps pending markers at
128 and encoded storage at 1 MiB. Ambiguous acknowledgements, invalid replies,
failed persistence and lost original daemon connections retain the blocker.
Startup reloads markers independently of the backend selected for new work;
only exact matching positive inspection evidence can retire them. Missing or
unavailable evidence leaves the scope blocked. Corrupt metadata refuses startup.

Credential preparation drains every entered promise, including after an earlier
failure. Cancellation, closing and original-client checks run between effects,
including after awaiting the worktree store. Fresh worktree handles are tracked
before another check can throw. A creation with an unknown outcome retains its
blocker; preparation does not certify canonical writer ownership.

Successful handoff requires acknowledged canonical mission creation, saved host
metadata and persisted startup events before local preparation observation.
Existing mission guards then cover execution. Canonical cancellation validates
its acknowledgement. Failure cleanup precedes terminal host metadata; uncertain
cancellation or worktree removal keeps a recovering checkpoint. If an observation
commits but marker removal fails, the checkpoint still preserves unresolved
cleanup even when startup later retires the observed marker.

Shutdown closes marker admission immediately and drains queued marker writes.
Entered worktree creation/removal promises are separately drained before profile
lock release, beyond the bounded general-run wait. Closing callbacks cannot admit
new cleanup or checkpoint writes. A local failure observation is permitted only
after all entered preparation and successful cleanup complete, before canonical
creation was attempted. Ambiguous creation retains the preparation blocker.

## Boundaries

A `local-preparation-settled` observation reports local preparation completion.
It does not prove remote process settlement, child membership, successful task
execution, accepted evidence or worktree fencing. It grants no approval and
cannot close a recovering mission or automatically replay work. Complete executor
membership, physical-settlement reconciliation, effect-time scoped approvals and
Rust-owned writer fencing remain open. No production Python/scanner worker or
external managed-worker capability is enabled.

## Verification

Local temporary-profile tests cover strict shared TS/schema/Rust wire fixtures,
immutable migration/storage, cross-kind contention, restart and original-client
checks, pre-effect admission failures, delayed sibling drain and handoff identity.
Eleven real-daemon host scenarios include actual Git worktree registry writes
held across the shutdown deadline, committed observations with failed marker
retirement/cancellation, restart under a different backend, and completed mission
handoff with matching actual execution supervisor. Fourteen host registry tests,
121 shared wire cases, fifteen core preparation tests and six daemon preparation
tests passed. Independent review found two lifecycle gaps; fixes and regression
tests were re-reviewed. Full `pnpm check` passed with 5,860 TypeScript tests
(23 optional tests skipped), 474 Rust tests and all builds. The first full run
exposed an outdated schema-10 fixture; its exact schema audit and downgrade check
were preserved while removing later migration objects, then the entire gate
passed. No live provider or cross-platform packaged release certification is implied.
