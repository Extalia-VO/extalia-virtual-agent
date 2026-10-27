//! The per-profile index file `<data>/profiles/<profile-id>/knowledge.sqlite` and its own
//! small migrator, following the core store's rules (ADR 0019): an exclusive sibling lock
//! (`knowledge.sqlite.lock`) taken before the file is read, WAL, `synchronous=FULL`,
//! foreign keys on, embedded schema versions advancing `user_version` in one transaction
//! each, an exact-schema and integrity check on open, private (`0600`) files in a private
//! directory, fail closed on a newer or foreign schema.
//!
//! Unlike `core.sqlite` the file is derived data: no backup is taken before a migration,
//! and [`KnowledgeStore::recreate`] discards it (with its WAL) so the caller can rebuild
//! from the vault. A future schema change may simply recreate and rebuild.

use std::ffi::OsString;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, TransactionBehavior};

use super::KnowledgeError;
use super::vault::set_mode;
use crate::skills::ProfileId;

pub const FILE_NAME: &str = "knowledge.sqlite";
const LOCK_SUFFIX: &str = ".lock";
const BUSY_TIMEOUT: Duration = Duration::from_millis(1_000);
const PRIVATE_FILE_MODE: u32 = 0o600;
const PRIVATE_DIRECTORY_MODE: u32 = 0o700;

/// Embedded schema versions; entry `i` produces `user_version` `i + 1`.
const SCHEMA: &[&str] = &[include_str!("schema/0001_index.sql")];

/// Location of a profile's index.
pub fn index_path(data_dir: &Path, profile: &ProfileId) -> PathBuf {
    data_dir
        .join("profiles")
        .join(profile.as_str())
        .join(FILE_NAME)
}

/// The open index of one profile. Dropping it closes the connection, then the lock.
#[derive(Debug)]
pub struct KnowledgeStore {
    pub(super) conn: Connection,
    pub(super) profile: ProfileId,
    _lock: File,
}

impl KnowledgeStore {
    /// Schema version this build writes.
    pub const LATEST: u32 = SCHEMA.len() as u32;

    /// Open or create the profile's index and migrate it to [`LATEST`](Self::LATEST).
    pub fn open(data_dir: &Path, profile: &ProfileId) -> Result<Self, KnowledgeError> {
        Self::open_path(&index_path(data_dir, profile), profile, false)
    }

    /// Discard the profile's index (it is derived data) and open an empty one. Used when
    /// [`open`](Self::open) fails with a schema, integrity or profile error, or on request.
    /// The caller then runs a full rebuild.
    pub fn recreate(data_dir: &Path, profile: &ProfileId) -> Result<Self, KnowledgeError> {
        Self::open_path(&index_path(data_dir, profile), profile, true)
    }

    pub(super) fn open_path(
        path: &Path,
        profile: &ProfileId,
        discard: bool,
    ) -> Result<Self, KnowledgeError> {
        let path = &prepare_parent(path)?;
        let lock = acquire_lock(&sibling(path, LOCK_SUFFIX))?;
        if discard {
            for candidate in [path.clone(), sibling(path, "-wal"), sibling(path, "-shm")] {
                match fs::symlink_metadata(&candidate) {
                    Ok(meta) if !meta.file_type().is_file() => {
                        return Err(KnowledgeError::InvalidPath);
                    }
                    Ok(_) => fs::remove_file(&candidate)?,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }
        private_files(path)?;
        create_private(path)?;
        let mut conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        conn.busy_timeout(BUSY_TIMEOUT)?;
        conn.pragma_update(None, "foreign_keys", true)?;
        if !conn.pragma_query_value(None, "foreign_keys", |row| row.get::<_, bool>(0))? {
            return Err(KnowledgeError::Pragma("foreign_keys"));
        }
        let found: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        let version = u32::try_from(found).map_err(|_| KnowledgeError::SchemaMismatch)?;
        if version > Self::LATEST {
            return Err(KnowledgeError::NewerSchema {
                found,
                supported: Self::LATEST,
            });
        }
        verify_schema(&conn, &SCHEMA[..version as usize])?;
        if version > 0 {
            verify_integrity(&conn)?;
        }
        let mode: String =
            conn.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))?;
        if !mode.eq_ignore_ascii_case("wal") {
            return Err(KnowledgeError::Pragma("journal_mode"));
        }
        conn.pragma_update(None, "synchronous", "FULL")?;
        if conn.pragma_query_value(None, "synchronous", |row| row.get::<_, i64>(0))? != 2 {
            return Err(KnowledgeError::Pragma("synchronous"));
        }
        for (index, sql) in SCHEMA.iter().enumerate().skip(version as usize) {
            let next = index as u32 + 1;
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(sql)
                .map_err(|source| KnowledgeError::Migration {
                    version: next,
                    source,
                })?;
            tx.pragma_update(None, "user_version", next)?;
            tx.commit()?;
        }
        verify_schema(&conn, SCHEMA)?;
        verify_integrity(&conn)?;
        // The file belongs to exactly one profile.
        conn.execute(
            "INSERT INTO knowledge_index_state (profile_id, generation) \
             SELECT ?1, 0 WHERE NOT EXISTS (SELECT 1 FROM knowledge_index_state)",
            [profile.as_str()],
        )?;
        let owners: Vec<String> = conn
            .prepare("SELECT profile_id FROM knowledge_index_state")?
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        if owners != [profile.as_str()] {
            return Err(KnowledgeError::WrongProfile);
        }
        private_files(path)?;
        Ok(Self {
            conn,
            profile: profile.clone(),
            _lock: lock,
        })
    }

    pub fn profile(&self) -> &ProfileId {
        &self.profile
    }

    /// The file's `user_version`.
    pub fn schema_version(&self) -> Result<u32, KnowledgeError> {
        let version: i64 = self
            .conn
            .pragma_query_value(None, "user_version", |row| row.get(0))?;
        Ok(u32::try_from(version).unwrap_or(0))
    }

    /// Graph generation: increases whenever a sync changes nodes or edges (cache key,
    /// ADR 0024 §3).
    pub fn generation(&self) -> Result<u64, KnowledgeError> {
        let generation: i64 = self.conn.query_row(
            "SELECT generation FROM knowledge_index_state WHERE profile_id = ?1",
            [self.profile.as_str()],
            |row| row.get(0),
        )?;
        Ok(u64::try_from(generation).unwrap_or(0))
    }

    /// Row counts of this profile's index (status display; daemon `knowledge.status`).
    pub fn stats(&self) -> Result<IndexStats, KnowledgeError> {
        let count = |sql: &str| -> Result<u64, KnowledgeError> {
            let value: i64 = self
                .conn
                .query_row(sql, [self.profile.as_str()], |row| row.get(0))?;
            Ok(u64::try_from(value).unwrap_or(0))
        };
        Ok(IndexStats {
            notes: count(
                "SELECT count(*) FROM knowledge_nodes WHERE profile_id = ?1 \
                 AND visibility = 'profile'",
            )?,
            edges: count(
                "SELECT count(*) FROM knowledge_edges WHERE profile_id = ?1 \
                 AND visibility = 'profile'",
            )?,
            unresolved_links: count(
                "SELECT count(*) FROM knowledge_edges WHERE profile_id = ?1 \
                 AND visibility = 'profile' AND target_node_id IS NULL",
            )?,
            skipped_documents: count(
                "SELECT count(*) FROM knowledge_documents WHERE profile_id = ?1 \
                 AND status = 'skipped'",
            )?,
        })
    }

    /// Close explicitly to observe a final error. The lock is released afterwards.
    pub fn close(self) -> Result<(), KnowledgeError> {
        let Self { conn, _lock, .. } = self;
        conn.close().map_err(|(_, error)| error.into())
    }
}

/// Row counts of one profile's index ([`KnowledgeStore::stats`]). `skipped_documents`
/// counts only files the index remembers (read and refused); walk-time refusals such as
/// symbolic links are reported by a sync, not stored.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IndexStats {
    pub notes: u64,
    pub edges: u64,
    pub unresolved_links: u64,
    pub skipped_documents: u64,
}

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

/// Fail closed unless the objects equal those of `schema` replayed in memory.
fn verify_schema(conn: &Connection, schema: &[&str]) -> Result<(), KnowledgeError> {
    let expected = Connection::open_in_memory()?;
    for sql in schema {
        expected.execute_batch(sql)?;
    }
    if schema_objects(conn)? == schema_objects(&expected)? {
        Ok(())
    } else {
        Err(KnowledgeError::SchemaMismatch)
    }
}

fn verify_integrity(conn: &Connection) -> Result<(), KnowledgeError> {
    let report = conn
        .prepare("PRAGMA integrity_check")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let foreign_key_problem = conn
        .prepare("PRAGMA foreign_key_check")?
        .query([])?
        .next()?
        .is_some();
    if report != ["ok"] || foreign_key_problem {
        return Err(KnowledgeError::Integrity);
    }
    Ok(())
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = OsString::from(path.as_os_str());
    name.push(suffix);
    PathBuf::from(name)
}

/// Create the private parent directories; return the path with its directory resolved
/// (SQLite refuses symlinks in any component, and a data directory may sit behind one).
fn prepare_parent(path: &Path) -> Result<PathBuf, KnowledgeError> {
    let (Some(name), Some(parent)) = (path.file_name(), path.parent()) else {
        return Err(KnowledgeError::InvalidPath);
    };
    if parent.as_os_str().is_empty() {
        return Err(KnowledgeError::InvalidPath);
    }
    if !parent.exists() {
        fs::create_dir_all(parent)?;
        if let Some(profiles) = parent.parent() {
            set_mode(profiles, PRIVATE_DIRECTORY_MODE)?;
        }
    }
    let meta = fs::symlink_metadata(parent)?;
    if !meta.file_type().is_dir() {
        return Err(KnowledgeError::InvalidPath);
    }
    set_mode(parent, PRIVATE_DIRECTORY_MODE)?;
    Ok(fs::canonicalize(parent)?.join(name))
}

fn private_files(path: &Path) -> Result<(), KnowledgeError> {
    for candidate in [
        path.to_path_buf(),
        sibling(path, "-wal"),
        sibling(path, "-shm"),
        sibling(path, LOCK_SUFFIX),
    ] {
        match fs::symlink_metadata(&candidate) {
            Ok(meta) if !meta.file_type().is_file() => return Err(KnowledgeError::InvalidPath),
            Ok(_) => set_mode(&candidate, PRIVATE_FILE_MODE)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn create_private(path: &Path) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, PRIVATE_FILE_MODE);
    options.open(path).map(drop)
}

/// Exclusive advisory lock on a sibling file, held for the store's lifetime (single
/// writer, ADR 0019). The lock file is never deleted.
fn acquire_lock(path: &Path) -> Result<File, KnowledgeError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if !meta.file_type().is_file() => return Err(KnowledgeError::InvalidPath),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, PRIVATE_FILE_MODE);
    let file = options.open(path)?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => Err(KnowledgeError::Locked),
        Err(TryLockError::Error(error)) => Err(error.into()),
    }
}
