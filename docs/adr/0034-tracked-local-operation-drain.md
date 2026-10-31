# ADR 0034: Tracked local operation drain and known owned-child exit

Status: Implemented locally v0.4.121, 2026-10-29; bounded gate 3.3D2

## Context

ADR 0033's turn-promise observation is deliberately weak. An early parallel
failure can leave sibling pipelines or tools running, and search previously
resolved before awaiting worker termination. Cancellation or an empty supervisor
map cannot establish that local operations settled.

## Decision

Each native task gets a monotonically sealed tracker. Reserve before invoking
raw provider/tool implementation and before starting full tool pipelines, then
release only on actual fulfillment/rejection (including synchronous throws).
Cancellation, deadline, lost authority and actual turn settlement seal admission;
delayed preflights cannot start a new effect after sealing. Timeout/grace/finally
never erase outstanding work. A settled turn with pending tracked work retains
capacity and recovery uncertainty rather than claiming task completion.

The stronger callback requires a genuine admitted turn, actual turn settlement,
sealed admission and zero pending tracked operations/pipelines. Both provider
binding and task tools must carry trusted host-selected coverage
`extalia-native-local-v1`; custom or unknown bindings default to unsupported.
The native host selects coverage only for its built-in provider/file-tool
composition, never from model requests, tool names or access labels alone.
Commands/delegation remain unavailable in missions and cannot inherit this proof.

The search adapter selects its first outcome separately from worker shutdown.
It awaits confirmed termination/exit before settling success, failure, timeout or
abort. If termination fails without exit, its promise remains unresolved. This
retains uncertainty and prevents a false local-drain callback.

Add migration 8 and `execution.recordLocalDrain` for a separate immutable proof
bound to the existing complete admission identity/digest and prior turn
observation. Store versioned coverage and bounded actual provider/tool operation
counts, not output or a success assertion. Exact retries are idempotent; conflicts,
wrong scope and missing prior observations refuse. Reaping/restart retain the
record but never synthesize one. Recording uses the original connection and stops
after host shutdown; latched reaper/storage failure remains fail-closed.

`mission.executions` includes optional local-drain evidence. Recovery displays its
scope while preserving genuine quarantine. No task/mission transitions, tool
authority, worktree integration/release, result restoration or replay follow.
The existing separate ADR 0030 terminal display-shadow repair stays unchanged.

## Scope and remaining gates

This certifies instrumented local adapter promises and known owned-child exits
for coverage version 1. It cannot certify remote inference cancellation, custom
detached work, unknown descendants, network transport shutdown, rollback of completed writes or absence of
other processes. It is not complete physical-settlement reconciliation. Terminal
closure still needs reviewed snapshot/version/sequence/digest binding, complete
membership, applicable worktree ownership and a committed explicit decision.
Gate 3.4 action approvals and Python/scanner workers remain separate work.

Verification covers ignored abort, parallel early rejection, delayed preflight,
sealed admission, late drain, unsupported coverage, synchronous throws, search
termination/exit races, failed termination, immutable/profile-bound persistence,
duplicate/conflict/rollback, restart retention and shutdown suppression.

Verification: full `pnpm check` passes: 288 suites / 3,387 passing tests and
one skipped; 241 Rust tests (171 core, 70 daemon), strict Clippy/format, schema
parity, typechecks and Web/Desktop/CLI builds pass. Actual host acceptance covers
late fetch/body/tool drain, normal proof counts, failed evidence persistence,
restart retention, caller-supplied coverage refusal and shutdown suppression.
Search tests include delayed/failed termination and a real adversarial-regex
worker whose exit is confirmed before returning. EN/ID light/dark and 390px
recovery previews pass without horizontal overflow; preview server/browser and
source files were removed. No live-provider, cross-OS release, remote cancellation
or complete gate 3.3 acceptance is claimed.
