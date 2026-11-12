//! Private files, anchored directory descriptors on Unix; no links followed for package I/O.
use super::{Result, check_segment, fail, io_error};
#[cfg(unix)]
use rustix::fs::{AtFlags, Dir, Mode, OFlags, mkdirat, open, openat, renameat, unlinkat};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub(super) struct Directory {
    path: PathBuf,
    #[cfg(unix)]
    file: File,
}
impl Directory {
    /// The configured data root is trusted; internal profile components are opened separately.
    pub fn trusted_root(path: &Path) -> Result<Self> {
        let path = fs::canonicalize(path).map_err(io_error)?;
        if !fs::symlink_metadata(&path).map_err(io_error)?.is_dir() {
            return Err(fail("storage"));
        }
        #[cfg(unix)]
        let file =
            File::from(open(&path, flags() | OFlags::DIRECTORY, Mode::empty()).map_err(io_error)?);
        Ok(Self {
            path,
            #[cfg(unix)]
            file,
        })
    }
    pub fn lock(&self) -> Result<File> {
        #[cfg(unix)]
        let file = File::from(
            openat(
                &self.file,
                "operation.lock",
                OFlags::RDWR
                    | OFlags::CREATE
                    | OFlags::NOFOLLOW
                    | OFlags::CLOEXEC
                    | OFlags::NONBLOCK,
                Mode::from_raw_mode(0o600),
            )
            .map_err(io_error)?,
        );
        #[cfg(not(unix))]
        let file = {
            let path = self.path.join("operation.lock");
            if let Ok(metadata) = fs::symlink_metadata(&path) {
                if !metadata.is_file() || linked(&metadata) {
                    return Err(fail("storage"));
                }
            }
            let mut options = fs::OpenOptions::new();
            options.read(true).write(true).create(true).truncate(false);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.custom_flags(0x0020_0000);
            }
            options.open(path).map_err(io_error)?
        };
        let metadata = file.metadata().map_err(io_error)?;
        if !metadata.is_file() || linked(&metadata) || metadata.len() != 0 {
            return Err(fail("storage"));
        }
        file.try_lock().map_err(|_| fail("review_conflict"))?;
        Ok(file)
    }
    pub fn modified_millis(&self) -> Result<i64> {
        #[cfg(unix)]
        let metadata = self.file.metadata().map_err(io_error)?;
        #[cfg(not(unix))]
        let metadata = fs::symlink_metadata(&self.path).map_err(io_error)?;
        let millis = metadata
            .modified()
            .map_err(io_error)?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(io_error)?
            .as_millis();
        i64::try_from(millis).map_err(io_error)
    }
    pub fn child(&self, name: &str, create: bool) -> Result<Self> {
        check_segment(name).map_err(|_| fail("storage"))?;
        #[cfg(unix)]
        {
            if create {
                match mkdirat(&self.file, name, Mode::from_raw_mode(0o700)) {
                    Ok(()) => self.file.sync_all().map_err(io_error)?,
                    Err(e) if e == rustix::io::Errno::EXIST => {}
                    Err(e) => return Err(io_error(e)),
                }
            }
            let file = File::from(
                openat(&self.file, name, flags() | OFlags::DIRECTORY, Mode::empty())
                    .map_err(io_error)?,
            );
            Ok(Self {
                path: self.path.join(name),
                file,
            })
        }
        #[cfg(not(unix))]
        {
            let path = self.path.join(name);
            if create {
                match fs::create_dir(&path) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(e) => return Err(io_error(e)),
                }
            }
            let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
            if !metadata.is_dir() || linked(&metadata) {
                return Err(fail("storage"));
            }
            Ok(Self { path })
        }
    }
    pub fn exclusive_child(&self, name: &str) -> Result<Self> {
        check_segment(name).map_err(|_| fail("storage"))?;
        #[cfg(unix)]
        mkdirat(&self.file, name, Mode::from_raw_mode(0o700)).map_err(|e| {
            if e == rustix::io::Errno::EXIST {
                fail("review_conflict")
            } else {
                io_error(e)
            }
        })?;
        #[cfg(not(unix))]
        fs::create_dir(self.path.join(name)).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                fail("review_conflict")
            } else {
                io_error(e)
            }
        })?;
        self.child(name, false)
    }
    pub fn read_optional(&self, name: &str, max: usize) -> Result<Option<Vec<u8>>> {
        check_segment(name).map_err(|_| fail("storage"))?;
        #[cfg(unix)]
        let mut file = match openat(&self.file, name, flags(), Mode::empty()) {
            Ok(file) => File::from(file),
            Err(e) if e == rustix::io::Errno::NOENT => return Ok(None),
            Err(e) => return Err(io_error(e)),
        };
        #[cfg(not(unix))]
        let mut file = {
            let path = self.path.join(name);
            match fs::symlink_metadata(&path) {
                Ok(m) if m.is_file() && !linked(&m) => {}
                Ok(_) => return Err(fail("storage")),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(e) => return Err(io_error(e)),
            }
            let mut options = fs::OpenOptions::new();
            options.read(true);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.custom_flags(0x0020_0000);
            }
            options.open(path).map_err(io_error)?
        };
        let metadata = file.metadata().map_err(io_error)?;
        if !metadata.is_file() || linked(&metadata) || metadata.len() > max as u64 {
            return Err(fail("integrity"));
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(max as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(io_error)?;
        if bytes.len() > max || bytes.len() as u64 != metadata.len() {
            return Err(fail("integrity"));
        }
        Ok(Some(bytes))
    }
    pub fn read(&self, name: &str, max: usize) -> Result<Vec<u8>> {
        self.read_optional(name, max)?
            .ok_or_else(|| fail("not_found"))
    }
    pub fn create(&self, name: &str, bytes: &[u8]) -> Result<()> {
        check_segment(name).map_err(|_| fail("storage"))?;
        #[cfg(unix)]
        let mut file = File::from(
            openat(
                &self.file,
                name,
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::from_raw_mode(0o600),
            )
            .map_err(io_error)?,
        );
        #[cfg(not(unix))]
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.path.join(name))
            .map_err(io_error)?;
        file.write_all(bytes).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        #[cfg(unix)]
        self.file.sync_all().map_err(io_error)?;
        Ok(())
    }
    pub fn replace(&self, name: &str, bytes: &[u8], request_id: &str) -> Result<()> {
        let temporary = format!("temp-{request_id}.json");
        self.create(&temporary, bytes)?;
        #[cfg(unix)]
        renameat(&self.file, temporary.as_str(), &self.file, name).map_err(io_error)?;
        #[cfg(not(unix))]
        {
            // Never follow a destination reparse point, even when replacing a cache entry.
            if self.read_optional(name, 256 * 1024)?.is_some() {
                fs::remove_file(self.path.join(name)).map_err(io_error)?;
            }
            fs::rename(self.path.join(&temporary), self.path.join(name)).map_err(io_error)?;
        }
        #[cfg(unix)]
        self.file.sync_all().map_err(io_error)?;
        Ok(())
    }
    pub fn names(&self) -> Result<Vec<String>> {
        let mut names = Vec::new();
        #[cfg(unix)]
        {
            for entry in Dir::read_from(&self.file).map_err(io_error)? {
                let entry = entry.map_err(io_error)?;
                let name = entry.file_name().to_str().map_err(io_error)?;
                if name == "." || name == ".." {
                    continue;
                }
                if names.len() >= 1024 {
                    return Err(fail("too_large"));
                }
                names.push(name.to_owned());
            }
        }
        #[cfg(not(unix))]
        {
            for entry in fs::read_dir(&self.path).map_err(io_error)? {
                let name = entry
                    .map_err(io_error)?
                    .file_name()
                    .into_string()
                    .map_err(io_error)?;
                if names.len() >= 1024 {
                    return Err(fail("too_large"));
                }
                names.push(name);
            }
        }
        Ok(names)
    }
    pub fn remove_file(&self, name: &str) -> Result<()> {
        check_segment(name).map_err(|_| fail("storage"))?;
        #[cfg(unix)]
        match unlinkat(&self.file, name, AtFlags::empty()) {
            Ok(()) => {}
            Err(e) if e == rustix::io::Errno::NOENT => {}
            Err(e) => return Err(io_error(e)),
        }
        #[cfg(not(unix))]
        match fs::remove_file(self.path.join(name)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_error(e)),
        }
        Ok(())
    }
    pub fn remove_tree(&self, name: &str, depth: usize, budget: &mut usize) -> Result<()> {
        if depth > 8 {
            return Err(fail("too_large"));
        }
        let dir = self.child(name, false)?;
        for entry in dir.names()? {
            *budget = budget.checked_sub(1).ok_or_else(|| fail("too_large"))?;
            if dir.child(&entry, false).is_ok() {
                dir.remove_tree(&entry, depth + 1, budget)?;
            } else {
                dir.remove_file(&entry)?;
            }
        }
        #[cfg(unix)]
        unlinkat(&self.file, name, AtFlags::REMOVEDIR).map_err(io_error)?;
        #[cfg(not(unix))]
        fs::remove_dir(self.path.join(name)).map_err(io_error)?;
        Ok(())
    }
    pub fn write_path(&self, path: &str, bytes: &[u8]) -> Result<()> {
        let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
        if parent.is_empty() {
            return self.create(name, bytes);
        }
        let mut current = self.child(
            parent.split('/').next().ok_or_else(|| fail("storage"))?,
            true,
        )?;
        for part in parent.split('/').skip(1) {
            current = current.child(part, true)?;
        }
        current.create(name, bytes)
    }
    pub fn read_path(&self, path: &str, max: usize) -> Result<Vec<u8>> {
        let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
        if parent.is_empty() {
            return self.read(name, max);
        }
        let mut current = self.child(
            parent.split('/').next().ok_or_else(|| fail("storage"))?,
            false,
        )?;
        for part in parent.split('/').skip(1) {
            current = current.child(part, false)?;
        }
        current.read(name, max)
    }
}
#[cfg(unix)]
fn flags() -> OFlags {
    OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK | OFlags::NOCTTY
}
#[cfg(unix)]
fn linked(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    metadata.nlink() != 1
}
#[cfg(windows)]
fn linked(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
}
#[cfg(not(any(unix, windows)))]
fn linked(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}
