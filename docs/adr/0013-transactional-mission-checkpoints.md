# ADR 0013: Transactional mission checkpoints

Status: Accepted (2026-10-18)

## Context

Stage 2 retains mission results in per-session JSON sidecars and recovers an
interrupted run conservatively. These files provide no transactional revision
history. The next Stage 3 increment needs one host-owned persistence boundary
without changing runtime authority or suggesting that interrupted tools are safe
to retry. The existing profile lock already excludes concurrent Bridge/Desktop
writers for the same data directory.

## Decision

The host stores saved mission checkpoints in `state/missions.sqlite`, under its
existing profile lock. `MissionCheckpointStore` owns the connection and first
schema migration. SQLite uses WAL, FULL synchronous commits, foreign keys and a
bounded busy timeout. Files and their directory retain private permissions.

Each changed checkpoint and its change row commit together in one transaction.
The change row contains a store-assigned monotonic cursor, mission identity,
revision, state, timestamp and snapshot digest. An identical checkpoint is an
idempotent no-op. Change reads are paginated and bounded. Current result retention
still limits each session to 16 records and 8 MiB of encoded metadata; pruning
removes terminal records and their change rows, never unresolved execution.
A maximum of 8,192 retained changes per session fails closed on exhaustion; it
does not silently trim revisions of a retained mission.
Deletion keeps a session tombstone to prevent stale legacy data from reappearing.

`MissionRecords` remains the validation/privacy/retention boundary. It loads the
checkpoint store first, and only if no session marker exists reads the old
`sessions/<session-id>.missions.json`. Strict, bounded validation precedes import.
Import and its source digest/marker commit atomically per session. Original
sidecars are preserved and never used as a fallback after import. An interrupted
multi-session import resumes from committed markers. Corrupt data, unsupported
schema versions and failed writes fail closed instead of rebuilding an empty DB.

Before exposing startup state, saved `running` runs become `recovering` and their
tasks become `unknown`; that checkpoint and its change commit together. If a
saved session record is missing while its checkpoint is unresolved, startup
fails rather than hiding its connection quarantine. Providers
and tools are never replayed. Existing connection/session quarantine remains.
Transient/history-off missions stay in RAM and do not create checkpoint rows.
The store is closed before releasing the host lock, including startup failures
that occur after it is opened.

Use the built-in `node:sqlite` `DatabaseSync` API and SQL pragmas supported by
Node 22.13. Raise the published Node floor from 22.12 to 22.13, when the module
became available without an experimental flag (the Node 23 line requires 23.4+,
so engines/doctor exclude 23.0–23.3) ([Node documentation](https://nodejs.org/download/release/v22.13.0/docs/api/sqlite.html)).
The installed Electron runtime was feature-probed independently; this avoids a
native npm addon/rebuild dependency. Synchronous transactions are bounded, but
latency and a worker-thread boundary still need measurement ([API behavior](https://nodejs.org/api/sqlite.html)).

Amendment (2026-10-22): the recovery rewrite applies only to work that may have
started. Tasks in `assigned`, `running`, `waiting`, `awaiting_approval` or
`verifying` become `unknown` (reason `host-restarted`, usage marked unknown,
unconfirmed answer dropped); `completed`, `failed` and `cancelled` tasks keep
their state and retained results; `queued` and `blocked` tasks stay as they
were, since they never ran and a `recovering` run admits nothing new. The run
itself still becomes `recovering` and no event is synthesized. This matches the
Rust store's recovery (`TaskState::in_flight`) and ADR 0014. The original rule
above rewrote every task of a running run, including finished and never-started
ones; checkpoints already recovered that way are not rewritten again.

## Scope and limits

This is a checkpoint change journal, not the PRD's canonical task/tool event
journal. Existing v0 JSONL session events remain separate and are not atomic with
SQLite commits. The runtime's intermediate task states are still in memory;
checkpoint durability alone does not gate every provider/tool effect. The
store's change cursor is not a v1 `AgentEvent.sequence` or a replay cursor for
session logs. No leases, reaper, tool-call intents, automatic retry,
reconciliation API, budget enforcement or scoped approvals are supplied here.

Results remain bounded, sanitized model output with no verified evidence.
Migration does not invent missing legacy dependencies or execution history.
SQLite/WAL and preserved sidecars are sensitive profile data; this increment
makes no immediate physical-erasure or performance guarantee.

## Validation and rollback

Tests use temporary profiles/databases, exercise transaction rollback, idempotent
imports, tombstones, invalid/newer schemas, restart quarantine, retention and
history-off isolation. Build and Desktop smoke checks verify runtime loading.

Keep the database authoritative when reverting UI changes. Older binaries only
read stale sidecars and cannot safely continue these missions. No automatic
SQLite-to-sidecar downgrade exists; do not delete the database, edit its version,
or erase unresolved records to bypass quarantine. A future migration/export must
preserve current state and unresolved execution before supporting downgrade.
