# ADR 0019: SQLite driver and database ownership for the Rust core

Status: Accepted (2026-10-21; the owner accepted the recommended option).

## Context

Patch v1.1.1 makes a Rust daemon the authority for task state, events, permissions
and approvals ([blueprint §1, §6](../product/master-prd-v1.1/technical-blueprint-v1.1.1.md)),
and asks to choose SQLx or rusqlite after the audit. Today `@extalia/host` is the only
SQLite writer: `MissionCheckpointStore` (`packages/host/src/missionCheckpoints.ts`) opens
`<data>/state/missions.sqlite` with `node:sqlite` `DatabaseSync`, WAL, `synchronous=FULL`,
foreign keys and `user_version` 2 (3 since 2026-10-22: running totals), under the per-profile host lock (`lock.ts`). On open it
requires the **exact** schema (object count and SQL text) and fails closed otherwise
(ADRs 0013–0015). The workload is small, synchronous, bounded transactions (one event +
one checkpoint per commit). See the [repository audit](../implementation/REPO_AUDIT.md).

## Options considered

| Option | For | Against |
| --- | --- | --- |
| **rusqlite** (`bundled` feature) | Synchronous API matches the existing `DatabaseSync` semantics and short transactions; bundled SQLite gives one pinned engine on every OS; online backup API; small dependency tree; no build-time database | Blocking calls must stay off async executor threads (dedicated thread or `spawn_blocking`); no compile-time query checking |
| **SQLx** (sqlite) | Async API, compile-time checked queries, built-in migrator | SQLite access still runs on a worker thread internally; compile-time checks need a database or committed offline query data in every build (adds CI/contributor friction); larger dependency tree; migrator conventions differ from the existing `user_version` pattern |
| Keep `node:sqlite` in TS as the only writer, Rust calls TS | No migration | Contradicts "Rust is the authority" (blueprint hard constraint) |
| Shared file, two writers (TS and Rust) | No data move | Breaks ADR 0013 exact-schema check; two migrators on one `user_version`; lock semantics undefined. Rejected |

Migration files: `migrations/` at the root vs `crates/extalia-core/migrations/`. Crate-local
keeps SQL next to the code that embeds it (`include_str!`) and versioned with it.

## Recommended decision

1. **rusqlite with the bundled SQLite**, behind the `event_store` port in `extalia-core`, on a
   dedicated database thread owned by the daemon. Revisit SQLx only if a measured async
   contention problem appears.
2. **Single-writer rule:** each SQLite file has exactly one writing process. The daemon owns a
   **new file** `<data>/state/core.sqlite`; `missions.sqlite` stays TS-owned and unchanged.
   During transition every mission has one owning store (new missions route to the daemon
   only when the flag is on). The daemon holds its own lock file and runs only as a child of
   the host that holds the profile lock (ADR 0020).
3. Same pragmas and guarantees as ADR 0013: WAL, `synchronous=FULL`, `foreign_keys=ON`,
   bounded busy timeout, `STRICT` tables, `integrity_check` + exact-schema verification on
   open, private file modes, fail closed on unknown/newer `user_version`.
4. **Migrations** in `crates/extalia-core/migrations/NNNN_name.sql`, ordered, embedded at
   build, applied in one transaction each, advancing `user_version`. Before any migration of
   a non-empty database: online backup to `core.sqlite.bak-<version>`. Destructive steps need
   their own ADR. No automatic downgrade; a down script is provided only where it cannot lose
   data. Upgrade fixtures (previous schema + data) are tests.
5. **Cutover** (separate later PR, after the benchmark gate): one-time import of
   `missions.sqlite` into `core.sqlite` with per-session markers and source digest, the TS
   file preserved read-only, never used as a fallback (ADR 0013 import pattern). TS keeps
   `node:sqlite` read-only for that import and for Hermes history (`nativeImport.ts`).

## Consequences

- No change to `missions.sqlite` or its tests; the TS host keeps failing closed on foreign
  tables, which now protects the rule instead of blocking it.
- Two SQLite engines may exist (Node's and the bundled one); only read-only TS access to
  daemon files is allowed, and only after cutover.
- Users downgrading after daemon missions exist will not see them (consistent with
  ADRs 0013–0015, which already forbid downgrade).

## Open questions for the owner

1. Accept the separate `core.sqlite` file and "new missions only" routing?
2. Retention of `.bak-<version>` backups (count/size) and whether they count as sensitive
   profile data in the erase flow.
3. Should knowledge/skill tables (W3, W5) share `core.sqlite` or get their own files
   (rebuildable indexes vs authoritative state)?
