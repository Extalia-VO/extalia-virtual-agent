//! Physical skill layout. The app's default library is global; explicit nondefault
//! CLI namespaces retain their existing paths and consent namespace.
//!
//! Relocation copies immutable objects, never database rows or transient import jobs.
//! The legacy copy is retained. Publication and the completion marker are durable,
//! descriptor-relative operations under one persistent cooperative writer lock.

use std::fs::File;
use std::path::{Path, PathBuf};

use super::{ProfileId, SkillError};

pub const LAYOUT_MARKER: &str = "layout-v1";
#[cfg(unix)]
const MARKER_BYTES: &[u8] = b"extalia.skills-layout.v1\n";

/// Non-Unix keeps its authoritative legacy layout until handle-safe relocation is supported.
pub fn is_global(profile: &ProfileId) -> bool {
    cfg!(unix) && profile.as_str() == "default"
}

pub fn root(data: &Path, profile: &ProfileId) -> PathBuf {
    if is_global(profile) {
        data.join("skills")
    } else {
        data.join("profiles").join(profile.as_str()).join("skills")
    }
}

pub fn inbox(data: &Path, profile: &ProfileId) -> PathBuf {
    if is_global(profile) {
        root(data, profile).join("imports")
    } else {
        data.join("profiles")
            .join(profile.as_str())
            .join("skill-imports")
    }
}

pub fn market(data: &Path, profile: &ProfileId) -> PathBuf {
    if is_global(profile) {
        root(data, profile).join("market")
    } else {
        data.join("profiles")
            .join(profile.as_str())
            .join("skill-market")
    }
}

/// Shared admission after commit; initialization takes the exclusive lock.
/// Keep alive through the producer's publication. Never remove the lock file: another
/// process may already have its inode open. Contention is a retryable refusal.
pub struct LayoutGuard {
    _lock: Option<File>,
}

/// Initialize only while holding the core store's exclusive owner lock. Standalone
/// callers must provide the same single-owner guarantee before using ObjectStore.
pub fn initialize(data: &Path, profile: &ProfileId) -> Result<LayoutGuard, SkillError> {
    guard(data, profile, true)
}

/// Writer admission for independent producers: never migrates or commits a layout.
pub fn prepare(data: &Path, profile: &ProfileId) -> Result<LayoutGuard, SkillError> {
    guard(data, profile, false)
}

fn guard(data: &Path, profile: &ProfileId, initialize: bool) -> Result<LayoutGuard, SkillError> {
    if !is_global(profile) {
        return Ok(LayoutGuard { _lock: None });
    }
    platform::prepare(data, initialize)
}

#[cfg(unix)]
mod platform {
    use super::*;
    use crate::sha256;
    use crate::skills::tree::{StagingLimits, Tree, TreeFile, check_relative_path};
    use rustix::fs::{
        AtFlags, Dir, FileType, Mode, OFlags, RenameFlags, mkdirat, open, openat, renameat_with,
        statat,
    };
    use std::collections::BTreeSet;
    use std::io::{Read, Write};
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::sync::atomic::{AtomicU64, Ordering};

    fn denied() -> SkillError {
        SkillError::Denied("skill_layout_conflict")
    }
    fn flags() -> OFlags {
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK
    }
    fn child(parent: &File, name: &str, create: bool) -> Result<File, SkillError> {
        if create {
            match mkdirat(parent, name, Mode::from_raw_mode(0o700)) {
                Ok(()) => parent.sync_all()?,
                Err(e) if e == rustix::io::Errno::EXIST => {}
                Err(e) => return Err(std::io::Error::from(e).into()),
            }
        }
        openat(parent, name, flags() | OFlags::DIRECTORY, Mode::empty())
            .map(File::from)
            .map_err(|_| denied())
    }
    fn optional_child(parent: &File, name: &str) -> Result<Option<File>, SkillError> {
        match statat(parent, name, AtFlags::SYMLINK_NOFOLLOW) {
            Err(e) if e == rustix::io::Errno::NOENT => Ok(None),
            Err(e) => Err(std::io::Error::from(e).into()),
            Ok(_) => child(parent, name, false).map(Some),
        }
    }
    fn names(dir: &File, cap: usize) -> Result<Vec<String>, SkillError> {
        let mut entries = Dir::read_from(dir).map_err(std::io::Error::from)?;
        let mut names = Vec::new();
        while let Some(entry) = entries.read() {
            let entry = entry.map_err(std::io::Error::from)?;
            let name = entry.file_name().to_str().map_err(|_| denied())?;
            if name == "." || name == ".." {
                continue;
            }
            if names.len() >= cap {
                return Err(SkillError::Denied("skill_layout_capacity"));
            }
            names.push(name.to_owned());
        }
        names.sort();
        Ok(names)
    }
    fn regular(parent: &File, name: &str) -> Result<File, SkillError> {
        let file = File::from(openat(parent, name, flags(), Mode::empty()).map_err(|_| denied())?);
        let meta = file.metadata()?;
        if !meta.is_file() || meta.nlink() != 1 {
            return Err(denied());
        }
        Ok(file)
    }
    fn create(parent: &File, name: &str, bytes: &[u8], mode: u32) -> Result<(), SkillError> {
        let mut file = File::from(
            openat(
                parent,
                name,
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::from_raw_mode(0o600),
            )
            .map_err(std::io::Error::from)?,
        );
        file.write_all(bytes)?;
        file.set_permissions(std::fs::Permissions::from_mode(mode))?;
        file.sync_all()?;
        parent.sync_all()?;
        Ok(())
    }
    fn reserved(root: &File, name: &str, create: bool) -> Result<File, SkillError> {
        let dir = child(root, name, create)?;
        // A W0 skill may be named objects/staging/imports/market. Never repurpose it.
        match statat(&dir, "SKILL.md", AtFlags::SYMLINK_NOFOLLOW) {
            Err(e) if e == rustix::io::Errno::NOENT => Ok(dir),
            _ => Err(denied()),
        }
    }
    struct Walk {
        files: Vec<TreeFile>,
        seen: BTreeSet<String>,
        count: usize,
        bytes: u64,
    }
    fn walk(
        source: &File,
        dest: Option<&File>,
        prefix: &str,
        state: &mut Walk,
    ) -> Result<(), SkillError> {
        let limits = StagingLimits::default();
        for name in names(source, limits.max_entries)? {
            let rel = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            check_relative_path(&rel).map_err(|_| denied())?;
            state.count += 1;
            if state.count > limits.max_entries
                || rel.split('/').count() > limits.max_depth
                || !state.seen.insert(rel.to_ascii_lowercase())
            {
                return Err(denied());
            }
            let stat = statat(source, name.as_str(), AtFlags::SYMLINK_NOFOLLOW)
                .map_err(std::io::Error::from)?;
            match FileType::from_raw_mode(stat.st_mode) {
                FileType::Directory => {
                    let src = child(source, &name, false)?;
                    let mode = src.metadata()?.mode() & 0o777;
                    if mode != 0o500 {
                        return Err(denied());
                    }
                    let dst = dest.map(|d| child(d, &name, true)).transpose()?;
                    walk(&src, dst.as_ref(), &rel, state)?;
                    if let Some(dst) = dst {
                        dst.set_permissions(std::fs::Permissions::from_mode(mode))?;
                        dst.sync_all()?;
                    }
                }
                FileType::RegularFile => {
                    let mut file = regular(source, &name)?;
                    let before = file.metadata()?;
                    let mode = before.mode() & 0o777;
                    if !matches!(mode, 0o400 | 0o500) || before.len() > limits.max_file_bytes {
                        return Err(denied());
                    }
                    let mut bytes = Vec::new();
                    (&mut file)
                        .take(limits.max_file_bytes + 1)
                        .read_to_end(&mut bytes)?;
                    let after = file.metadata()?;
                    if before.len() != bytes.len() as u64
                        || before.len() != after.len()
                        || before.mtime() != after.mtime()
                        || before.mtime_nsec() != after.mtime_nsec()
                        || before.ctime() != after.ctime()
                        || before.ctime_nsec() != after.ctime_nsec()
                        || before.mode() != after.mode()
                    {
                        return Err(denied());
                    }
                    state.bytes += bytes.len() as u64;
                    if state.bytes > limits.max_total_bytes {
                        return Err(denied());
                    }
                    if let Some(dest) = dest {
                        create(dest, &name, &bytes, mode)?;
                    }
                    state.files.push(TreeFile {
                        path: rel,
                        size: bytes.len() as u64,
                        sha256: sha256::hex_digest(&bytes),
                        executable: mode & 0o111 != 0,
                    });
                }
                _ => return Err(denied()),
            }
        }
        Ok(())
    }
    fn tree(source: &File, dest: Option<&File>) -> Result<Tree, SkillError> {
        if !matches!(source.metadata()?.mode() & 0o777, 0o500 | 0o700) {
            return Err(denied());
        }
        let mut state = Walk {
            files: Vec::new(),
            seen: BTreeSet::new(),
            count: 0,
            bytes: 0,
        };
        walk(source, dest, "", &mut state)?;
        Ok(Tree::from_files(state.files))
    }
    fn legacy(data: &File) -> Result<Option<File>, SkillError> {
        let mut current = data.try_clone()?;
        for name in ["profiles", "default", "skills", "objects"] {
            let Some(next) = optional_child(&current, name)? else {
                return Ok(None);
            };
            current = next;
        }
        Ok(Some(current))
    }
    fn same(a: &File, b: &File) -> Result<bool, SkillError> {
        let a = a.metadata()?;
        let b = b.metadata()?;
        Ok(a.dev() == b.dev() && a.ino() == b.ino())
    }
    fn staging_dir(staging: &File) -> Result<(String, File), SkillError> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        for _ in 0..1024 {
            let temp = format!(
                "relocate-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            );
            match mkdirat(staging, temp.as_str(), Mode::from_raw_mode(0o700)) {
                Ok(()) => return Ok((temp.clone(), child(staging, &temp, false)?)),
                Err(e) if e == rustix::io::Errno::EXIST => continue,
                Err(e) => return Err(std::io::Error::from(e).into()),
            }
        }
        Err(SkillError::Denied("skill_layout_capacity"))
    }
    fn marker_temp(root: &File) -> Result<String, SkillError> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        for _ in 0..1024 {
            let temp = format!(
                "layout-pending-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            );
            match create(root, &temp, MARKER_BYTES, 0o400) {
                Ok(()) => return Ok(temp),
                Err(SkillError::Io(e)) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        Err(SkillError::Denied("skill_layout_capacity"))
    }
    fn publish(
        staging: &File,
        temp: &str,
        objects: &File,
        hash: &str,
        target: &File,
        expected: &Tree,
    ) -> Result<(), SkillError> {
        renameat_with(staging, temp, objects, hash, RenameFlags::NOREPLACE)
            .map_err(std::io::Error::from)?;
        let published = child(objects, hash, false)?;
        if !same(&published, target)? || tree(&published, None)? != *expected {
            return Err(SkillError::Integrity);
        }
        published.set_permissions(std::fs::Permissions::from_mode(0o500))?;
        published.sync_all()?;
        objects.sync_all()?;
        staging.sync_all()?;
        Ok(())
    }
    fn migrate(data: &File, root: &File, objects: &File, staging: &File) -> Result<(), SkillError> {
        if let Some(old) = legacy(data)? {
            for hash in names(&old, 4096)? {
                if hash.len() != 64
                    || !hash
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                {
                    return Err(denied());
                }
                let source = child(&old, &hash, false)?;
                if source.metadata()?.mode() & 0o777 != 0o500 {
                    return Err(denied());
                }
                let expected = tree(&source, None)?;
                if expected.sha256 != hash || expected.file("SKILL.md").is_none() {
                    return Err(SkillError::Integrity);
                }
                if let Some(existing) = optional_child(objects, &hash)? {
                    if tree(&existing, None)? != expected {
                        return Err(SkillError::Integrity);
                    }
                    existing.set_permissions(std::fs::Permissions::from_mode(0o500))?;
                    existing.sync_all()?;
                    continue;
                }
                // Crash leftovers are inert; bounded allocation skips names from an old PID.
                let (temp, target) = staging_dir(staging)?;
                let copied = tree(&source, Some(&target))?;
                target.sync_all()?;
                if copied != expected || tree(&target, None)? != expected {
                    return Err(SkillError::Integrity);
                }
                publish(staging, &temp, objects, &hash, &target, &expected)?;
            }
        }
        // Exclusive final publication: a partial write is a conflict, never success.
        // Publish through a fresh temp name so interrupted writes cannot look complete.
        if !same(&child(data, "skills", false)?, root)?
            || !same(&child(root, "objects", false)?, objects)?
            || !same(&child(root, "staging", false)?, staging)?
        {
            return Err(denied());
        }
        let temp = marker_temp(root)?;
        renameat_with(
            root,
            temp.as_str(),
            root,
            LAYOUT_MARKER,
            RenameFlags::NOREPLACE,
        )
        .map_err(std::io::Error::from)?;
        root.sync_all()?;
        let mut committed = regular(root, LAYOUT_MARKER)?;
        let mut bytes = Vec::new();
        (&mut committed)
            .take(MARKER_BYTES.len() as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes != MARKER_BYTES {
            return Err(denied());
        }
        Ok(())
    }
    pub(super) fn prepare(data: &Path, initialize: bool) -> Result<LayoutGuard, SkillError> {
        // The configured data root may be an intentional alias; its descendants may not.
        if initialize {
            std::fs::create_dir_all(data)?;
        }
        let canonical = std::fs::canonicalize(data)?;
        let data = File::from(
            open(&canonical, flags() | OFlags::DIRECTORY, Mode::empty())
                .map_err(std::io::Error::from)?,
        );
        let root = child(&data, "skills", initialize)?;
        let lock = File::from(
            openat(
                &root,
                "layout.lock",
                OFlags::RDWR
                    | OFlags::CREATE
                    | OFlags::NOFOLLOW
                    | OFlags::CLOEXEC
                    | OFlags::NONBLOCK,
                Mode::from_raw_mode(0o600),
            )
            .map_err(std::io::Error::from)?,
        );
        let meta = lock.metadata()?;
        if !meta.is_file() || meta.nlink() != 1 || meta.len() != 0 {
            return Err(denied());
        }
        if initialize {
            lock.try_lock()
                .map_err(|_| SkillError::Denied("skill_layout_busy"))?;
        } else {
            lock.try_lock_shared()
                .map_err(|_| SkillError::Denied("skill_layout_busy"))?;
        }
        let committed = match statat(&root, LAYOUT_MARKER, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(_) => true,
            Err(e) if e == rustix::io::Errno::NOENT => false,
            Err(e) => return Err(std::io::Error::from(e).into()),
        };
        let create_layout = initialize && !committed;
        let objects = reserved(&root, "objects", create_layout)?;
        let staging = reserved(&root, "staging", create_layout)?;
        // Import/cache directories stay lazy; pre-existing W0 names must still fail closed.
        for name in ["imports", "market"] {
            match statat(&root, name, AtFlags::SYMLINK_NOFOLLOW) {
                Err(e) if e == rustix::io::Errno::NOENT => {}
                Err(e) => return Err(std::io::Error::from(e).into()),
                Ok(_) => {
                    reserved(&root, name, false)?;
                }
            }
        }
        match statat(&root, LAYOUT_MARKER, AtFlags::SYMLINK_NOFOLLOW) {
            Err(e) if e == rustix::io::Errno::NOENT => {
                if !initialize {
                    return Err(SkillError::Denied("skill_layout_uninitialized"));
                }
                migrate(&data, &root, &objects, &staging)?;
            }
            Err(e) => return Err(std::io::Error::from(e).into()),
            Ok(_) => {
                let mut marker = regular(&root, LAYOUT_MARKER)?;
                let mut bytes = Vec::new();
                (&mut marker)
                    .take(MARKER_BYTES.len() as u64 + 1)
                    .read_to_end(&mut bytes)?;
                if bytes != MARKER_BYTES {
                    return Err(denied());
                }
            }
        }
        Ok(LayoutGuard { _lock: Some(lock) })
    }
    #[cfg(test)]
    mod publication_tests {
        use super::*;
        #[test]
        fn source_name_replacement_never_commits_verified_object() {
            let temp = crate::skills::storage::tests::TempDir::new();
            let path = temp.data();
            std::fs::create_dir_all(&path).unwrap();
            let root = File::from(open(&path, flags() | OFlags::DIRECTORY, Mode::empty()).unwrap());
            let staging = child(&root, "staging", true).unwrap();
            let objects = child(&root, "objects", true).unwrap();
            let target = child(&staging, "temp", true).unwrap();
            create(&target, "SKILL.md", b"verified", 0o400).unwrap();
            let expected = tree(&target, None).unwrap();
            renameat_with(
                &staging,
                "temp",
                &staging,
                "retained",
                RenameFlags::NOREPLACE,
            )
            .unwrap();
            let replacement = child(&staging, "temp", true).unwrap();
            create(&replacement, "SKILL.md", b"replacement", 0o400).unwrap();
            assert!(
                publish(
                    &staging,
                    "temp",
                    &objects,
                    &expected.sha256,
                    &target,
                    &expected
                )
                .is_err()
            );
            assert!(!path.join(LAYOUT_MARKER).exists());
        }
    }
}

#[cfg(not(unix))]
mod platform {
    use super::*;
    pub(super) fn prepare(_: &Path, _: bool) -> Result<LayoutGuard, SkillError> {
        // Keep the existing authoritative layout until handle-safe relocation is available.
        Ok(LayoutGuard { _lock: None })
    }
}

#[cfg(test)]
mod tests;
