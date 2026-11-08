# ADR 0054: Shared Native status and guarded recovery inspection

Status: Implemented locally in v0.4.185; full verification passed in v0.4.186, 2026-11-08

## Context

Office, Chat and Missions share session events, but durable planning/preparation
blockers were internal. A stopped host could retain ownership without explaining
it in the UI. Roster/spawn events also do not establish that a worker invocation
has entered execution. The Rust backend selected for new saved missions is
separate from the TypeScript provider/tool loop and from an existing mission's
recorded backend. The shared Rust sidecar may serve Knowledge or recovery even
when new missions use TypeScript.

## Decision

Add optional `nativeStatus()` and `refreshNativeStatus()` host capabilities plus
one shared Native status drawer in the application top bar. The snapshot is
scoped to the currently locked host/profile; callers cannot request another
profile. It uses `extalia.native-status.v1`, a sampling timestamp, actual backend
selection, provider-loop implementation, sidecar state, active local operations,
worker evidence, relevant saved missions and blocker reasons.

Ordinary reads are copied local projections without provider calls or sidecar
connection/spawn. Poll only while the drawer is open, coalesce relevant Native
lifecycle events, and ignore token streaming and Knowledge-index hints. Invalid,
unsupported, unavailable or timed-out replies never imply a healthy empty state.
Host/profile replacement, closure and lifecycle invalidation discard old replies;
a timed-out transport still owns its pending slot until actual settlement.

The projection caps operations at 64, workers/task records at 128, missions at 64
and blockers at 128, with exact totals/truncation. Terminal mission history and
answer/instruction text are excluded. Saved mission/task metadata is projected
lazily before materialization, without cloning conversation/result histories.
No credentials, paths, raw provider errors, receipt digests or canonical
supervisor identifiers are included.

## Evidence and actions

Native run kind/workspace identity is captured from the actual session at its
owned entry. Delegated workers appear only through actual invocation entry/exit
observers; configured roster members and queued writers are not live workers.
Observer exceptions cannot control execution. Known team labels are captured at
entry. Persisted mission tasks are explicitly labelled recorded task state and
never count as evidence of a physical process.

Cancellation supplies the sampled Native run ID as the optional second argument
to `cancel(sessionId, expectedNativeRunId)`. The host compares the exact current
Native run synchronously before abort, approval resolution or event publication.
A stale row cannot cancel a replacement invocation in the same session. Existing
one-argument callers retain their behavior. Peers advertising status v1 must
implement this run-bound cancellation contract.

Approval links open the existing approval inbox. Recovery links select the exact
saved mission; a missing target cannot silently open a different mission. A
preallocated preparation ID alone does not create a mission-navigation target.
Mission inspection reuses `refreshNativeMissionRecovery`, including its existing
narrow settled-checkpoint repair; it cannot replay or clear uncertain execution.
Unsupported recovery remains unavailable.

## Explicit receipt recheck

`refreshNativeStatus()` is an explicit recheck, not a side-effect-free read. It
may retire an inactive host write-ahead marker only when existing daemon
inspection returns exact matching positive local-settlement evidence. It never
sends an observe operation, starts work, grants permissions, releases a worktree,
closes uncertain mission execution or replays a provider/tool call.

Concurrent refreshes coalesce. A fair rotating selection inspects at most 32
inactive planning/preparation markers per request. Active sessions are skipped.
After every await and inside the serialized removal queue, the registry checks
closure, exact original entry identity and absence of local activity. Existing
scope guards prevent a new local invocation entering the marked scope during
retirement. Missing, mismatched, stale, unsupported or unavailable evidence keeps
the guard. Results report inspected/retired/retained/skipped/remaining counts and
checked/partial/unsupported/unavailable status.

Inspection work participates in update/vault-switch busy guards. Shutdown closes
admission and drains inspection/persistence before releasing the profile lock.
Markers remain visible after the backend preference changes; new selection never
reinterprets the recorded authority of an older mission.

## UI boundaries

The drawer uses a body portal to escape glass top-bar containment, themed control
primitives, internal scrolling, focus containment/return, Escape and EN/ID copy.
Action errors are generic; detailed recovery uses existing stable reason codes.
Only current-host session/workspace targets are navigable. No replay, resume,
force-clear, fabricated CPU/RAM charts or new approval authority is exposed.
This does not complete executor membership, writer fencing or reconciliation.

## Verification

Focused tests cover real delegated lifetime versus roster/queue events, an
abort-ignoring provider, stale cancellation against a replacement run, metadata
projection bounds/privacy, retained Rust authority after backend changes, exact
receipt matching, activity/entry replacement/serialization races and shutdown
drains. UI tests cover unsupported/malformed/stale replies, timeout/owner
replacement, immediate invalidation and exact mission targeting. The PRD tracker
records final full checks and temporary-profile browser evidence.

Production-build browser checks use a temporary profile, synthetic workspaces,
a real Bridge/Rust daemon and a held local provider response. They verify actual
worker entry, cancellation remaining visible until provider settlement, removal
only after settlement, a pending approval, retained preparation ownership and an
uncertain Rust mission after switching new missions to TypeScript. Navigation
opens the exact saved mission and the existing approval inbox. Receipt inspection
retains unresolved evidence. No real profile or external provider is used.

The shared drawer is checked in English/Indonesian, at desktop and 390 px phone
widths, and across all three material templates in light/dark mode. Keyboard
containment, Escape/focus return, portal bounds and internal scrolling pass.
Closed drawers make no polling requests; unsupported peers stop automatic polls.
Delayed replies from an earlier drawer owner are ignored, and unavailable data
retains stale evidence with disabled actions and generic errors.

The v0.4.185 full-check attempt passed lint, typechecks, 5,942 TypeScript tests
(23 optional skips), Rust formatting/Clippy and 455 Rust tests before the
`worker_probe` executable stalled before its test harness. A bounded artifact
rebuild reached its 19-test listing. The full retry repeated all TypeScript
passes, then Rust compiler/Clippy processes stalled in OS directory reads during
toolchain setup. Only owned check processes were stopped. Separate production
build, version consistency, character-hair, public-safety and diff checks passed.
The complete `pnpm check` gate remains unverified; test listing is not test
execution, and these environmental interruptions are not reported as green.

Subsequent verification: the complete v0.4.186 `pnpm check` passed with 5,945
TypeScript tests (23 optional skips), all 474 Rust tests, lint, typechecks and
all builds. This closes the full-check gate for the Native status implementation;
no further Native implementation changes or toolchain/security changes were
needed to obtain the green run. Earlier interrupted attempts remain documented
above as historical evidence.
