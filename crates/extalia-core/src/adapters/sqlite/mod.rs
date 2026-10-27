//! SQLite adapter (ADR 0019): the daemon's own file `<data>/state/core.sqlite`, with one
//! writing process. The TypeScript host's `missions.sqlite` is never opened here.
//!
//! Opening fails closed: a newer `user_version`, a schema that differs from the embedded
//! migrations, or a failed integrity check leaves the file untouched and returns an error.
//! A second opener of the same file, in this or another process, fails with
//! [`StoreError::Locked`] before the database is read (`core.sqlite.lock`).

mod lock;
mod migrate;
mod mission_snapshot;
#[cfg(test)]
mod mission_tests;
pub mod missions;
#[cfg(test)]
mod tests;

use std::ffi::OsString;
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use migrate::{MIGRATIONS, Migration};

/// File name of the core store inside the profile's `state` directory.
pub const FILE_NAME: &str = "core.sqlite";
/// Exclusive lock file next to the store (single writer, ADR 0019).
pub const LOCK_SUFFIX: &str = ".lock";
/// Bounded wait for a competing SQLite lock (ADR 0013).
const BUSY_TIMEOUT: Duration = Duration::from_millis(1_000);
const PRIVATE_FILE_MODE: u32 = 0o600;
const PRIVATE_DIRECTORY_MODE: u32 = 0o700;

/// Location of the core store for a profile data directory.
pub fn store_path(data_dir: &Path) -> PathBuf {
    data_dir.join("state").join(FILE_NAME)
}

/// Why the store could not be opened. Messages are generic: no paths or SQL.
#[derive(Debug)]
pub enum StoreError {
    /// Empty or in-memory path, or the file (or a `-wal`/`-shm`/`.lock` sibling) is not a regular file.
    InvalidPath,
    /// Another opener holds the store's lock: one writing process per file (ADR 0019).
    Locked,
    /// Written by a newer release; left untouched (no downgrade).
    NewerSchema {
        found: i64,
        supported: u32,
    },
    /// Objects differ from the expected schema of the file's version: tampered or foreign.
    SchemaMismatch,
    /// `integrity_check` or `foreign_key_check` reported a problem.
    Integrity,
    /// A required pragma did not take effect.
    Pragma(&'static str),
    /// A migration failed and was rolled back; the previous version is intact.
    Migration {
        version: u32,
        source: rusqlite::Error,
    },
    Io(io::Error),
    Sqlite(rusqlite::Error),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath => f.write_str("core store path is not a private regular file"),
            Self::Locked => f.write_str("core store is locked by another process"),
            Self::NewerSchema { found, supported } => {
                write!(
                    f,
                    "core store schema {found} is newer than supported {supported}"
                )
            }
            Self::SchemaMismatch => f.write_str("core store schema does not match its version"),
            Self::Integrity => f.write_str("core store integrity check failed"),
            Self::Pragma(name) => write!(f, "core store pragma {name} could not be applied"),
            Self::Migration { version, .. } => {
                write!(
                    f,
                    "core store migration {version} failed and was rolled back"
                )
            }
            Self::Io(_) => f.write_str("core store file access failed"),
            Self::Sqlite(_) => f.write_str("core store database operation failed"),
        }
    }
}

impl std::error::Error for StoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Migration { source, .. } | Self::Sqlite(source) => Some(source),
            Self::Io(source) => Some(source),
            _ => None,
        }
    }
}

impl From<io::Error> for StoreError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

/// The open core store. Dropping it closes the connection, then releases the lock.
#[derive(Debug)]
pub struct CoreStore {
    conn: Connection,
    _lock: lock::StoreLock,
    /// Test hook: fail every mission operation after its writes, before its commit.
    #[cfg(test)]
    fail_before_commit: std::cell::Cell<bool>,
}

impl CoreStore {
    /// Schema version this build writes.
    pub const LATEST: u32 = MIGRATIONS.len() as u32;

    /// Open or create the store at `path` and migrate it to [`LATEST`](Self::LATEST).
    /// A file at an older non-zero version is backed up next to itself before migrating.
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        Self::open_with(path, MIGRATIONS)
    }

    fn open_with(path: &Path, migrations: &[Migration]) -> Result<Self, StoreError> {
        let path = &prepare_file(path)?;
        // Take the lock before reading a byte of the database.
        let lock = lock::acquire(&sibling(path, LOCK_SUFFIX))?;
        let mut conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        conn.busy_timeout(BUSY_TIMEOUT)?;
        conn.pragma_update(None, "foreign_keys", true)?;
        if !conn.pragma_query_value(None, "foreign_keys", |row| row.get::<_, bool>(0))? {
            return Err(StoreError::Pragma("foreign_keys"));
        }
        // Verify the existing version before changing any byte of the file.
        let version = migrate::existing_version(&conn, migrations)?;
        if version > 0 {
            migrate::verify_integrity(&conn)?;
        }
        if version > 0 && (version as usize) < migrations.len() {
            migrate::backup(&conn, path, version)?;
        }
        let mode: String =
            conn.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))?;
        if !mode.eq_ignore_ascii_case("wal") {
            return Err(StoreError::Pragma("journal_mode"));
        }
        conn.pragma_update(None, "synchronous", "FULL")?;
        if conn.pragma_query_value(None, "synchronous", |row| row.get::<_, i64>(0))? != 2 {
            return Err(StoreError::Pragma("synchronous"));
        }
        migrate::apply(&mut conn, migrations, version)?;
        migrate::verify_schema(&conn, migrations)?;
        migrate::verify_integrity(&conn)?;
        private_files(path)?;
        Ok(Self {
            conn,
            _lock: lock,
            #[cfg(test)]
            fail_before_commit: std::cell::Cell::new(false),
        })
    }

    /// The file's `user_version`.
    pub fn schema_version(&self) -> Result<u32, StoreError> {
        Ok(migrate::user_version(&self.conn)?.try_into().unwrap_or(0))
    }

    /// The connection, for the skill registry (`crate::skills`), which keeps its SQL next to
    /// its domain rules. Same single-writer and transaction rules as the mission operations.
    pub(crate) fn connection(&mut self) -> &mut Connection {
        &mut self.conn
    }

    /// Close explicitly to observe a final error (for example a failed WAL checkpoint).
    /// The lock is released after the connection is closed.
    pub fn close(self) -> Result<(), StoreError> {
        let Self { conn, _lock, .. } = self;
        conn.close().map_err(|(_, error)| error.into())
    }
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = OsString::from(path.as_os_str());
    name.push(suffix);
    PathBuf::from(name)
}

/// Private parent directory; the file and its WAL siblings must be regular files (no
/// symlinks). Creates the file with a private mode so it is never readable by others.
/// Returns the path with its directory resolved: SQLite refuses symlinks in any path
/// component (`SQLITE_OPEN_NOFOLLOW`), and a data directory may sit behind one
/// (for example `/var` on macOS). The file name itself is never followed.
fn prepare_file(path: &Path) -> Result<PathBuf, StoreError> {
    let name = path.file_name().filter(|_| path != Path::new(":memory:"));
    let Some(name) = name else {
        return Err(StoreError::InvalidPath);
    };
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent)?;
    set_mode(parent, PRIVATE_DIRECTORY_MODE)?;
    #[cfg(unix)]
    let path = fs::canonicalize(parent)?.join(name);
    #[cfg(not(unix))]
    let path = parent.join(name);
    private_files(&path)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, PRIVATE_FILE_MODE);
    options.open(&path)?;
    Ok(path)
}

fn private_files(path: &Path) -> Result<(), StoreError> {
    for candidate in [
        path.to_path_buf(),
        sibling(path, "-wal"),
        sibling(path, "-shm"),
        sibling(path, LOCK_SUFFIX),
    ] {
        match fs::symlink_metadata(&candidate) {
            Ok(meta) if !meta.file_type().is_file() => return Err(StoreError::InvalidPath),
            Ok(_) => set_mode(&candidate, PRIVATE_FILE_MODE)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

/// Create a new private file; fails if it exists, so a backup never overwrites anything.
fn create_private_new(path: &Path) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, PRIVATE_FILE_MODE);
    options.open(path).map(drop)
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

/// Windows has no mode bits; the profile directory's ACL applies.
#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> io::Result<()> {
    Ok(())
}
