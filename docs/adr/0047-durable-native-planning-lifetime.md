# ADR 0047: Durable native automatic-planning lifetime

Status: Verified locally v0.4.153, 2026-10-31; V2-03 prerequisite

## Context

Automatic mission planning precedes the accepted mission and task graph. Its
first external operation can be credential preparation or a model-catalog call,
before inference and before `mission.create`. The original-task record in
ADR 0046 cannot describe this earlier, editable proposal. In-memory reservations
survive an ignored abort within one host process, but disappear on restart.

## Decision

Saved sessions selecting the Rust Native backend admit an independent planning
invocation before credential, catalog or inference entry. Migration 12 stores
immutable admissions, resource-claim history and optional local observations in
`WITHOUT ROWID` tables. The profile and timestamps come from the daemon. An
admission binds invocation/supervisor UUIDs, actual opaque host session/workspace
IDs and sorted unique connection IDs, with a domain-separated profile-bound
digest. It contains no prompt, endpoint, credential or model output. It does not
manufacture a mission, task, canonical workspace mapping or executable grant.

The optional operations are `planning.begin`, `planning.observe` and
`planning.inspect`. Strict TS/schema/Rust rules share fixtures. The frozen v1
hello vocabulary and required-operation baseline stay unchanged. A selected
saved Rust path lacking these capabilities refuses before provider work; it
does not silently switch to unowned planning. Default TypeScript and history-off
planning retain their existing behavior and acquire no durable receipt.

One immediate transaction captures admission and all session/connection claims.
Exact retries return the same record; changed scope conflicts. Pending planning
blocks another invocation of the same session or overlapping connections within
the profile, including across workspaces. Claims remain immutable history;
only a validated local observation makes them inactive. Pending work never
expires, auto-settles or becomes replayable after restart. History is capped at
1,024 admissions per profile, with 16 connections and 32 KiB per planning value;
exhaustion refuses instead of pruning uncertain work.

## Host ordering and recovery

Before `planning.begin`, the host atomically saves a write-ahead scope marker in
its own `state/native-planning.json`. The profile lock and synced file protect the ordering; Unix also syncs the
parent directory. The bounded registry holds at most 128 pending
markers and 1 MiB. Ambiguous admission acknowledgements, mismatched replies,
connection loss and failed writes retain the blocker. Definitive pre-effect
refusals may retire their marker. No external application's configuration changes.

All known potentially contacted connections, including the lead, are reserved
before admission. The Rust planning catalog path owns its credential/catalog
promises instead of borrowing another caller's pending model-list cache. After
awaited preparation it rechecks cancellation, shutdown and the original daemon
client before the next external call. Tests, team planning, catalog lookup and
edits of saved connections respect unresolved scopes, as do mission/chat entry,
workspace policy changes and session/workspace deletion.

The original client alone can record `local-pipeline-settled`, after all entered
credential, catalog, inference and response-body promises actually fulfill or
reject and no further planning operation can start. Abort, timeout, heuristic
return and `finally` alone are insufficient. An abort-ignoring call retains its
reservation and marker until its real local completion. Shutdown suppresses new
observations; it closes the registry synchronously and drains queued marker
writes before releasing the profile lock, preventing late old-host writes.

Startup loads markers independently of the preference for new work. It may use
`planning.inspect` to retire only positively observed matching invocations.
Missing, unsupported or unavailable inspection leaves them blocked. Startup
never observes or replays an invocation. Corrupt marker metadata refuses host
startup instead of silently erasing ownership.

## Boundaries and next gate

This is a planning lifetime receipt and local promise observation, not a lease,
action approval, process-tree inventory or proof of remote physical settlement.
It cannot close a mission, clear execution quarantine, accept evidence or grant
a writer. The proposal returned by planning remains editable and is not linked
to a later mission by invented identity.

The separate `startNativeMission` preparation still requires execution-root
ownership before provider/worktree effects. Registering and sealing child
obligations, exact settlement, canonical writer/worktree fencing, explicit
transactional reconciliation and retention management remain later work.
V2-03, AR-05/06 and v0.5 acceptance remain open. Python/scanner activation and
other planning surfaces are not certified by these receipts.

## Verification

Focused checks cover 87 shared wire cases, nine core temporary-store cases, five
daemon cases including actual stdio EOF, 56 registry cases and ten real-daemon
host integration cases. They verify atomic rollback, scope/replay/conflict,
immutable bounded history, restart uncertainty, pre-effect admission ordering,
failed/missing capability, ignored abort/body lifetime, daemon loss, backend
switches, guarded provider/configuration paths and the delayed-write profile-lock
barrier. Independent review found guard and shutdown gaps; fixes were re-reviewed
without a remaining blocker. Full `pnpm check` passes: 337 TypeScript suites and
5,015 tests (one suite/five tests skipped), 448 Rust tests, strict Clippy/format,
schema/boundary/type checks, Web/Desktop/CLI builds, version consistency and hair
asset checks. Validation used Darwin ARM64 with Rust 1.99.1 and temporary profiles;
no live-provider or cross-platform release certification is claimed.
