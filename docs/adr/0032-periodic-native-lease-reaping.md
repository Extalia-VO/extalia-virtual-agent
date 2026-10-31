# ADR 0032: Periodic Native lease reaping

Status: Implemented locally v0.4.119, 2026-10-29; bounded gate 3.3C

## Context

Gate 3.3B prevents an expired holder from committing new activity or obtaining tool
permission, but only subsequent requests expose that failure. A silent host can
leave canonical task states running indefinitely while the daemon remains alive.
Reaping must run independently of stdin activity and preserve uncertainty.

## Decision

The Rust store exposes a profile-scoped bounded sweep, serialized with heartbeat
renewals and mission mutations. Each transaction handles at most 16 missions
selected through expired task leases. It validates exact stored task/lease/holder
relationships and timestamp expiry before changing state. An invalid row or
storage failure rolls the complete batch back. If renewal wins the serialization
race first, an unexpired lease is not reaped; if reaping wins, renewal is refused.

One expired lease quarantines the affected mission: every in-flight task becomes
unknown, its lease is removed and the mission becomes recovering. Queued and
already-terminal tasks retain their state. This is logical fencing, not evidence
that a provider or tool stopped. The reaper never retries tasks, integrates or
deletes worktrees, restores results, or declares work completed.

As with startup recovery, quarantine changes canonical recovery state without
inventing agent events. Mission version/update time changes reflect recovery;
the activity journal retains only events actually committed. This is not complete
mission event replay or durable intent/settlement recording.

The stdio daemon runs a scoped periodic sweep thread while serving requests,
sharing the single owned core store under a mutex. Knowledge indexing keeps its
separate worker. A stop channel interrupts the sweep wait on EOF/fatal input or
serve failure; the worker joins before store shutdown. No additional store
connection or lock bypass is introduced. Sweep failure permanently latches
mission mutation/heartbeat refusal for that daemon instance rather than silently
continuing after failed fencing. Snapshot inspection stays read-only.

## Limits and verification

This closes periodic logical quarantine, not full gate 3.3. Physical-settlement
reconciliation and Rust-owned worktree fencing remain; exact action approvals
are gate 3.4. Python worker supervision/distribution stays pending. A mutex is
serialization, not an OS sandbox or hard real-time scheduling guarantee.

Tests use temporary stores and subprocesses: exact expiry, renewal/reaper order,
bounded batch progress, sibling quarantine, queued/terminal preservation,
transaction rollback, wrong profiles, silent stdin, restart without replay,
failure latching and prompt shutdown. Performance acceptance remains unmeasured.

Verification: full `pnpm check` passes at v0.4.119: 286 suites / 3,262
passing tests and one skipped; 232 Rust tests (163 core, 69 daemon), strict
Clippy/format, schema drift checks, typechecks and Web/Desktop/CLI builds pass.
The actual host observes canonical quarantine before its heartbeat or the next
provider response and refuses late tool execution. Shutdown and knowledge-output
failure regression tests pass. No live-provider, Windows/macOS/Linux release
certification, performance or full gate 3.3 acceptance is claimed.
