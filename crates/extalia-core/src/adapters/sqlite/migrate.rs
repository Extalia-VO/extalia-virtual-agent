//! Ordered, embedded migrations advancing `PRAGMA user_version`, one transaction each,
//! and the exact-schema check: the objects of a file at version N must equal those
//! produced by replaying migrations 1..=N on an empty in-memory database.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, MAIN_DB, TransactionBehavior};

use super::{StoreError, create_private_new, set_mode};

#[derive(Debug, Clone, Copy)]
pub(super) struct Migration {
    /// The `user_version` after this migration; migration `i` (0-based) has version `i + 1`.
    pub version: u32,
    pub sql: &'static str,
}

pub(super) const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        sql: include_str!("../../../migrations/0001_core.sql"),
    },
    // Secure skill registry, W3 slice 1 (ADR 0025).
    Migration {
        version: 2,
        sql: include_str!("../../../migrations/0002_skills.sql"),
    },
    // Running per-mission journal totals, backfilled (commit cost independent of depth).
    Migration {
        version: 3,
        sql: include_str!("../../../migrations/0003_mission_totals.sql"),
    },
    // Skill reviews, W0 consent review inputs, built-in registrations, W3 slice 2 (ADR 0025).
    Migration {
        version: 4,
        sql: include_str!("../../../migrations/0004_skill_reviews.sql"),
    },
    // Skill tables accept host workspace ids (`w_…`): approvals and review inputs rebuilt.
    Migration {
        version: 5,
        sql: include_str!("../../../migrations/0005_workspace_ids.sql"),
    },
    // Learning loop, W6 slice 1: experiences, evidence, candidates and decisions (ADR 0029).
    Migration {
        version: 6,
        sql: include_str!("../../../migrations/0006_learning.sql"),
    },
];

pub(super) fn user_version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
}

/// Version of an existing file, after checking it is not newer and its schema is exact.
pub(super) fn existing_version(
    conn: &Connection,
    migrations: &[Migration],
) -> Result<u32, StoreError> {
    let found = user_version(conn)?;
    let supported = migrations.len() as u32;
    let version = u32::try_from(found).map_err(|_| StoreError::SchemaMismatch)?;
    if version > supported {
        return Err(StoreError::NewerSchema { found, supported });
    }
    verify_schema(conn, &migrations[..version as usize])?;
    Ok(version)
}

/// Apply every migration after `from`, each in its own immediate transaction together
/// with its `user_version`. A failure rolls that migration back and stops.
pub(super) fn apply(
    conn: &mut Connection,
    migrations: &[Migration],
    from: u32,
) -> Result<(), StoreError> {
    for (index, migration) in migrations.iter().enumerate().skip(from as usize) {
        debug_assert_eq!(migration.version as usize, index + 1);
        let failed = |source| StoreError::Migration {
            version: migration.version,
            source,
        };
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(failed)?;
        tx.execute_batch(migration.sql).map_err(failed)?;
        tx.pragma_update(None, "user_version", migration.version)
            .map_err(failed)?;
        if has_rows(&tx, "PRAGMA foreign_key_check").map_err(failed)? {
            return Err(StoreError::Integrity);
        }
        tx.commit().map_err(failed)?;
    }
    Ok(())
}

/// One schema object, SQL with whitespace collapsed. Internal `sqlite_*` objects are
/// excluded, as in the host's checkpoint store.
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct SchemaObject {
    kind: String,
    name: String,
    table: String,
    sql: Option<String>,
}

fn schema_objects(conn: &Connection) -> rusqlite::Result<Vec<SchemaObject>> {
    let mut statement = conn.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema \
         WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name",
    )?;
    let rows = statement.query_map([], |row| {
        let sql: Option<String> = row.get(3)?;
        Ok(SchemaObject {
            kind: row.get(0)?,
            name: row.get(1)?,
            table: row.get(2)?,
            sql: sql.map(|text| text.split_whitespace().collect::<Vec<_>>().join(" ")),
        })
    })?;
    rows.collect()
}

/// Fail closed unless the objects equal those of `migrations` replayed in memory.
pub(super) fn verify_schema(conn: &Connection, migrations: &[Migration]) -> Result<(), StoreError> {
    let expected = Connection::open_in_memory()?;
    for migration in migrations {
        expected.execute_batch(migration.sql)?;
    }
    if schema_objects(conn)? == schema_objects(&expected)? {
        Ok(())
    } else {
        Err(StoreError::SchemaMismatch)
    }
}

pub(super) fn verify_integrity(conn: &Connection) -> Result<(), StoreError> {
    let mut statement = conn.prepare("PRAGMA integrity_check")?;
    let report = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if report != ["ok"] || has_rows(conn, "PRAGMA foreign_key_check")? {
        return Err(StoreError::Integrity);
    }
    Ok(())
}

fn has_rows(conn: &Connection, sql: &str) -> rusqlite::Result<bool> {
    conn.prepare(sql)?
        .query([])?
        .next()
        .map(|row| row.is_some())
}

/// Online backup next to the store before migrating a non-empty file:
/// `core.sqlite.bak-<version>-<unix-ms>`. Never overwrites and is never deleted here.
pub(super) fn backup(conn: &Connection, path: &Path, version: u32) -> Result<PathBuf, StoreError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis());
    let mut base = path.as_os_str().to_owned();
    base.push(format!(".bak-{version}-{millis}"));
    for attempt in 0..100u32 {
        let mut candidate = base.clone();
        if attempt > 0 {
            candidate.push(format!("-{attempt}"));
        }
        let candidate = PathBuf::from(candidate);
        match create_private_new(&candidate) {
            Ok(()) => {
                conn.backup(MAIN_DB, &candidate, None)?;
                set_mode(&candidate, super::PRIVATE_FILE_MODE)?;
                return Ok(candidate);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err(StoreError::InvalidPath)
}
