//! File identity, locking and schema guards follow the existing Observe store.
use super::*;
fn private(path: &Path, mode: u32) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(storage)?;
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
    Ok(())
}
fn regular(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(info) if !info.file_type().is_file() || info.len() > STORE_BYTES => {
            Err(denied("unsafe_store"))
        }
        Ok(info) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if info.nlink() != 1 {
                    return Err(denied("unsafe_store"));
                }
            }
            #[cfg(not(unix))]
            let _ = info;
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(storage(e)),
    }
}
fn schema(conn: &Connection) -> rusqlite::Result<Vec<(String, String, String)>> {
    conn.prepare("SELECT type,name,coalesce(sql,'') FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")?
        .query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect()
}
/// Single-writer store. Opening never clears corrupt, foreign or newer data.
#[derive(Debug)]
pub struct WorkMemoryStore {
    pub(super) conn: Connection,
    pub(super) profile: ProfileId,
    _lock: File,
    directory: PathBuf,
    directory_identity: fs::Metadata,
    file: PathBuf,
    file_identity: fs::Metadata,
}
impl WorkMemoryStore {
    pub fn open(data: &Path, profile: &ProfileId) -> Result<Self> {
        if !data.is_absolute() {
            return Err(denied("invalid_root"));
        }
        let root = fs::canonicalize(data).map_err(storage)?;
        let profiles = root.join("profiles");
        for folder in [&profiles, &profiles.join(profile.as_str())] {
            match fs::symlink_metadata(folder) {
                Ok(info) if !info.file_type().is_dir() => {
                    return Err(denied("unsafe_profile_directory"));
                }
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    match fs::create_dir(folder) {
                        Ok(()) => {}
                        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                            if !fs::symlink_metadata(folder)
                                .map_err(storage)?
                                .file_type()
                                .is_dir()
                            {
                                return Err(denied("unsafe_profile_directory"));
                            }
                        }
                        Err(e) => return Err(storage(e)),
                    }
                }
                Err(e) => return Err(storage(e)),
            }
            private(folder, 0o700)?;
        }
        let file = profiles.join(profile.as_str()).join("work-memory.sqlite");
        let sibling = |suffix: &str| PathBuf::from(format!("{}{suffix}", file.to_string_lossy()));
        for p in [
            file.clone(),
            sibling("-wal"),
            sibling("-shm"),
            sibling(".lock"),
        ] {
            regular(&p)?;
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options.open(sibling(".lock")).map_err(storage)?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => return Err(denied("locked")),
            Err(TryLockError::Error(e)) => return Err(storage(e)),
        }
        regular(&file)?;
        let fresh = !file.exists();
        if fresh {
            options.open(&file).map_err(storage)?;
        }
        let mut conn = Connection::open_with_flags(
            &file,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(storage)?;
        conn.busy_timeout(Duration::from_secs(1)).map_err(storage)?;
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(storage)?;
        let app: i64 = conn
            .pragma_query_value(None, "application_id", |r| r.get(0))
            .map_err(storage)?;
        if version == 0 && app == 0 && schema(&conn).map_err(storage)?.is_empty() {
            let tx = conn.transaction().map_err(storage)?;
            tx.execute_batch(SCHEMA).map_err(storage)?;
            tx.execute(
                "INSERT INTO work_memory_state(profile_id) VALUES(?1)",
                [profile.as_str()],
            )
            .map_err(storage)?;
            tx.pragma_update(None, "application_id", APPLICATION)
                .map_err(storage)?;
            tx.pragma_update(None, "user_version", 1).map_err(storage)?;
            tx.commit().map_err(storage)?;
        } else if version != 1 || app != APPLICATION {
            return Err(denied("foreign_or_newer_schema"));
        }
        let expected = Connection::open_in_memory().map_err(storage)?;
        expected.execute_batch(SCHEMA).map_err(storage)?;
        if schema(&conn).map_err(storage)? != schema(&expected).map_err(storage)? {
            return Err(denied("schema_mismatch"));
        }
        let owners: Vec<String> = conn
            .prepare("SELECT profile_id FROM work_memory_state ORDER BY profile_id")
            .map_err(storage)?
            .query_map([], |r| r.get(0))
            .map_err(storage)?
            .collect::<std::result::Result<_, _>>()
            .map_err(storage)?;
        if owners != [profile.as_str()] {
            return Err(denied("wrong_profile"));
        }
        let check: String = conn
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .map_err(storage)?;
        if check != "ok" {
            return Err(denied("integrity"));
        }
        let mode: String = conn
            .pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get(0))
            .map_err(storage)?;
        if !mode.eq_ignore_ascii_case("wal") {
            return Err(denied("journal_mode"));
        }
        conn.pragma_update(None, "synchronous", "FULL")
            .map_err(storage)?;
        for p in [
            file.clone(),
            sibling("-wal"),
            sibling("-shm"),
            sibling(".lock"),
        ] {
            if p.exists() {
                regular(&p)?;
                private(&p, 0o600)?;
            }
        }
        let directory = file.parent().ok_or(denied("invalid_root"))?.to_path_buf();
        let directory_identity = fs::symlink_metadata(&directory).map_err(storage)?;
        let file_identity = fs::symlink_metadata(&file).map_err(storage)?;
        Ok(Self {
            conn,
            profile: profile.clone(),
            _lock: lock,
            directory,
            directory_identity,
            file,
            file_identity,
        })
    }
    pub(super) fn check_storage(&self) -> Result<()> {
        regular(&self.file)?;
        let directory = fs::symlink_metadata(&self.directory).map_err(storage)?;
        let file = fs::symlink_metadata(&self.file).map_err(storage)?;
        if !directory.file_type().is_dir()
            || !file.file_type().is_file()
            || file.len() > STORE_BYTES
            || fs::canonicalize(&self.directory).map_err(storage)? != self.directory
        {
            return Err(denied("store_changed"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if directory.dev() != self.directory_identity.dev()
                || directory.ino() != self.directory_identity.ino()
                || file.dev() != self.file_identity.dev()
                || file.ino() != self.file_identity.ino()
            {
                return Err(denied("store_changed"));
            }
        }
        #[cfg(not(unix))]
        {
            if directory.created().ok() != self.directory_identity.created().ok()
                || file.created().ok() != self.file_identity.created().ok()
            {
                return Err(denied("store_changed"));
            }
        }
        Ok(())
    }
}
