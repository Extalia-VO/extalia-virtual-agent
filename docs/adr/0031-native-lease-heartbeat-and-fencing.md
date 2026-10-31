# ADR 0031: Independent Native lease heartbeat and expiry fencing

Status: Implemented locally v0.4.118, 2026-10-29; bounded gate 3.3B

## Context

Task leases currently renew only when a state or activity event commits. A silent
provider cannot independently demonstrate that its owning executor remains alive.
Activity can also renew a lease after its expiry. Gate 3.3A intentionally only
inspects recovery; it cannot grant execution authority.

## Decision

Add profile-scoped `mission.heartbeat` to the existing daemon contract. It takes
one mission and 1–64 unique task/lease/holder claims. Each claim must match a
current in-flight task and its exact lease, assignee and mission. The acquisition
lease ID (the original running-transition event ID) is the fencing identity for
that execution attempt. Expiry at or before the daemon's current time refuses
renewal. Validate every claim before committing any renewal. Renewals never
shorten a recorded expiry and never append activity or fabricate journal events.

The host serializes renewal with that mission's event commits, tracks lease IDs
only after acknowledged running transitions, and renews independently every 30
seconds while leases exist. The current ten-minute lease lifetime remains.
The host requires the advertised capability for Rust mission admission; a daemon
without it does not silently fall back to TypeScript. Response identity and the
complete claim set are checked before accepting a renewal.

Tool permission checks run through the same serialized queue and renew exact
claims immediately before asking policy. A mission without active claims is
denied. Acknowledged expiry is checked before and after awaiting the decision:
a delayed timer or system suspension cannot make a stale `allow` usable. This
does not replace gate 3.4's action-digest-bound approval enforcement.

A failed, unavailable or mismatched heartbeat permanently revokes the host's
execution authority for this invocation. A distinct runtime authority signal
latches the existing persistence failure path: abort active calls, block queued
work and retain unknown execution as recovering. Ordinary user cancellation
keeps its existing meaning. Listeners and heartbeat timers are released when the
invocation settles. An ignored abort does not prove physical settlement.

Fresh task transitions and activity must check the current lease's validity
before renewing, releasing or acknowledging new effects; expired work cannot
become completed through a late event. Identical old event retries may return
their prior acknowledgement without granting new authority. Restart still
quarantines in-flight work and never replays it.

## Limits and verification

This is not full gate 3.3: periodic live reaping, durable intent/physical-settlement
reconciliation and Rust-owned worktree fencing remain open. An in-process
heartbeat is not an OS sandbox or proof of cancellation. Gate 3.4 execution-time
approvals remain pending. Python workers, a pinned real scanner and bundled
CPython are not delivered by this change.

Tests cover exact expiry, wrong epoch/holder/profile, transaction rollback,
unchanged journal counts, silent providers, queued siblings, late responses and
restart quarantine using temporary stores and scripted providers only.

Verification: `pnpm check` passes at v0.4.118: 286 suites, 3,261 passing tests
and one skipped; Rust workspace 219 tests, strict Clippy/format, schema parity,
workspace typechecks and Web/Desktop/CLI builds pass. These are local/scripted
proofs; live-provider and full gate 3.3 acceptance are not claimed.
