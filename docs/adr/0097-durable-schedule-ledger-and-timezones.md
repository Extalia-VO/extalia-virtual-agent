# ADR 0097: Durable schedule ledger, atomic occurrence admission, and per-job IANA timezones

- Status: Accepted (Core SQLite ledger, IANA timezone engine, and Host manager integration; OS service supervision and Gateway delivery adapters remain separate slices)
- Date: 2026-11-24
- References: [Schedule & Automation vNext PRD](../product/prd-schedule-automation-vnext.md), [ADR 0013](0013-transactional-mission-checkpoints.md), [ADR 0019](0019-sqlite-driver-and-database-ownership.md), [ADR 0071](0071-rust-openai-completion-and-resource-evidence.md)

## Context

In baseline v0.4.353, general schedules are stored in a flat JSON catalog (`config/schedules.json`). That baseline has four structural limits:

1. **No transactional occurrence ledger:** schedule definitions, retries, and run state live in one rewritten JSON file without per-occurrence identity or durable execution history.
2. **Conflated status truth:** `lastOutcome: 'succeeded'` and `runCount` record prompt dispatch admission rather than managed turn completion or independent verification.
3. **Host-local cron only:** cron triggers store only a 5-field expression and evaluate in the executing host's local timezone rather than an explicit per-job IANA timezone.
4. **Crash ambiguity without quarantine ledger:** interrupted runs can only mark the schedule catalog row; there is no durable `unknown` run record for explicit operator review.

## Decision

### 1. Canonical Host-owned SQLite store

Schedule definitions, occurrence runs, delivery receipts, prompt-creation receipts, recovery receipts, and store metadata are owned by the single Host process in `<state>/schedules.sqlite` using Node's built-in `node:sqlite` (`DatabaseSync`), matching ADR 0013 and ADR 0019:

- SQLite runs in `WAL` journal mode with `PRAGMA foreign_keys = ON`, `PRAGMA synchronous = FULL`, and `PRAGMA busy_timeout = 5000`.
- The database file and its `-wal`/`-shm` sidecars are created as regular non-symlink files with mode `0o600` (POSIX) inside a `0o700` directory.
- There is one authoritative scheduler writer per `EXTALIA_HOME`. During transitional rollout, callers that omit an explicit `stateDirectory` retain a read/write compatibility projection at `schedules.json` tracked by content digest; callers supplying `stateDirectory` operate in pure SQLite single-writer mode without mutating `config/schedules.json` after migration.
- Storage corruption or write failure latches `storage-unavailable`, cancels scheduling timers, and refuses new automatic or manual admission (fail closed).

### 2. Schema versioning and downgrade refusal

- The current schema version (`1`) is recorded in both `PRAGMA user_version` and `schedule_meta(key = 'schema_version')`.
- Opening a database whose `user_version` or `schema_version` exceeds the binary's supported version fails closed immediately before modifying journal mode, schema, or rows (`SCH-AT-33`).
- `PRAGMA integrity_check` and `PRAGMA foreign_key_check` run on open; any corruption refuses admission with actionable diagnostics (`SCH-AT-19`).

### 3. Immutable backup and one-time idempotent migration

When a fresh SQLite store opens alongside a legacy `config/schedules.json`:

1. Read and strictly validate the legacy file (size limit, schedule schemas, prompt-creation receipts, recovery receipts, and typed `retryContext` proofs).
2. Write an immutable byte-for-byte backup `schedules.pre-sqlite.json` with mode `0o600` using exclusive creation (`O_CREAT | O_EXCL`) so an existing backup is never overwritten.
3. Inside one `BEGIN IMMEDIATE ... COMMIT` transaction, import all schedules (preserving `sch_*` IDs, revisions, session targets, bound sessions, assignments, missed policies, and `runCount` as `legacy_dispatch_count`), `schedule_prompt_creations`, and `schedule_recoveries`, and record `legacy_migration_v1`, source SHA-256, backup path, timestamp, and captured host timezone in `schedule_meta`.
4. Migration performs zero dispatches (`SCH-AT-01`). Subsequent restarts observe `legacy_migration_v1` and skip re-import idempotently (`SCH-AT-02`).

### 4. Tables and atomic CAS occurrence admission

The store defines six strict tables:

- `schedule_meta`: schema version, migration receipts, and diagnostics metadata.
- `schedules`: schedule definitions, `trigger_generation`, `legacy_dispatch_count`, and `completed_run_count`.
- `schedule_runs`: per-occurrence durable ledger (`ScheduleRunV1`) with `UNIQUE(occurrence_key)`.
  - Automatic and catch-up slots use `auto:<schedule_id>:<occurrence_utc>:g<trigger_generation>`.
  - Manual Run now uses `manual:<schedule_id>:<operator_request_id>`.
- `schedule_deliveries`: delivery outbox receipts (`ScheduleDeliveryV1`) with `UNIQUE(run_id, destination_revision, notification_kind)`.
- `schedule_prompt_creations`: private idempotency receipts for prompt-created schedules.
- `schedule_recoveries`: bounded pre-admission busy/connection retry receipts linked to the deferred `run_id`.

Occurrence transitions use compare-and-swap (`WHERE id = ? AND revision = ? AND state = ?`):

```text
pending -> admitting -> dispatched -> running -> completed | failed | cancelled | unknown
             |                |-> unknown
             |-> deferred -> admitting (only with verified pre-admission no-work proof)
             `-> blocked | failed
```

- Deleting or editing a schedule definition affects future slots only; previously recorded `schedule_runs` remain retained for audit.
- On Host startup, any run left in `admitting`, `dispatched`, or `running` transitions atomically to `unknown` with a restart diagnostic and is **never automatically replayed** (`SCH-AT-09`, `SCH-AT-10`).
- Operators reconcile quarantined runs through `reviewUnknownRun(runId, expectedRevision, decision)` (`acknowledge`, `mark-resolved`, or `dismiss-for-new-run`), which records audited review metadata via CAS without fabricating `completed` or `verification = 'passed'`.

### 5. Split dispatch, managed turn settlement, and independent verification

- Prompt acceptance transitions a run to `dispatched` only; it never marks a turn `completed`.
- Managed turn start binds exact `sessionId` plus `correlationId`, `turnId`, and/or `executionGeneration` (`dispatched -> running`).
- Turn settlement (`running | dispatched -> completed | failed | cancelled`) validates exact `sessionId` and correlation/turn/generation identity and refuses settlement from unrelated sessions or mismatched correlations (`SCH-AT-16`).
- `verification` (`not-checked | passed | failed`) is persisted independently of turn state. `turn.completed` leaves `verification` as `not-checked` (`SCH-AT-17`). Recording `passed` requires an explicit non-empty trusted evidence reference (`SCH-AT-18`).
- Historical `runCount` is preserved as `legacyDispatchCount`; `completedRunCount` increments only from observed `completed` turn settlements.

### 6. Per-job IANA timezones and DST policy

- Cron triggers add optional `timeZone?: string` (validated through `Intl.DateTimeFormat`, rejecting invalid zones) and `dstPolicy?: 'each-valid-instant'`.
- Legacy cron jobs that omit `timeZone` preserve host-local compatibility without silently shifting planned occurrences; migration captures the host timezone so timezone drift can be surfaced for user review (`SCH-AT-03`).
- Next-run calculations and multi-run previews (`previewScheduleNextRuns`) execute authoritatively in `@extalia/platform` / Host using `Intl.DateTimeFormat` wall-clock field search rather than browser-local assumptions:
  - **Fall-back repeated local times:** `each-valid-instant` yields both distinct UTC occurrences with distinct occurrence keys and explicit preview ambiguity notes (`repeated-first`, `repeated-second`).
  - **Spring-forward skipped local times:** nonexistent local times are skipped cleanly to the next valid matching local occurrence with an `after-skipped-gap` preview note.

## Meaning and limits

- Local occurrence keys and transactional admission prevent duplicate automatic admission within one Host data root; they do not establish global exactly-once semantics for third-party model providers or external messaging APIs.
- Observed third-party agent sessions and blocked Native command executors retain their existing capability gates; verification evidence cannot bypass runtime or approval boundaries.
- Headless OS service supervision (`launchd`, `systemd`, Windows) and external Gateway delivery adapters are delivered in separate work packages.

## Verification

Unit and integration tests in `packages/host/test/scheduleLedger.test.ts` and `packages/host/test/scheduleTimezone.test.ts` (plus all existing `packages/platform/test/schedules.test.ts` and `packages/host/test/schedule*.test.ts` suites) exercise temporary directories only and cover `SCH-AT-01` through `SCH-AT-19` and `SCH-AT-33`: legacy migration and backup immutability, idempotent restart, host timezone drift detection, multi-zone IANA previews, DST spring-forward gaps and fall-back folds, interval anchoring, concurrent timer + manual run uniqueness, pre/post-dispatch crash quarantine, 40-slot missed catch-up coalescing, busy/connection deferral with safe no-work proof, deleted target refusal, mismatched session/correlation settlement refusal, split turn completion vs `not-checked`/`passed` verification, storage corruption fail-closed handling, and schema downgrade refusal.
