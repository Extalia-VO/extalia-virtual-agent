//! Single writer per store file (ADR 0019, audit risk 4): an exclusive OS advisory lock on
//! `core.sqlite.lock` next to the store, held for the store's lifetime. A sibling file is
//! locked rather than `core.sqlite` itself because Windows file locks are mandatory and
//! would block SQLite's own I/O on the database. The lock file is never deleted, so two
//! processes cannot each lock a different inode of it.

use std::fs::{self, File, OpenOptions, TryLockError};
use std::io;
use std::path::Path;

#[cfg(unix)]
use super::PRIVATE_FILE_MODE;
use super::StoreError;

/// Held exclusive lock; released when dropped (or when the process exits, however it ends).
#[derive(Debug)]
pub(super) struct StoreLock {
    _file: File,
}

pub(super) fn acquire(path: &Path) -> Result<StoreLock, StoreError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if !meta.file_type().is_file() => return Err(StoreError::InvalidPath),
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
        Ok(()) => Ok(StoreLock { _file: file }),
        Err(TryLockError::WouldBlock) => Err(StoreError::Locked),
        Err(TryLockError::Error(error)) => Err(error.into()),
    }
}
