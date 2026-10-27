//! Quarantine staging and the canonical tree hash (ADR 0025 §2 and its 2026-10-22
//! amendment).
//!
//! # Object store
//!
//! `<data>/profiles/<profile-id>/skills/objects/<tree-sha256>/` holds one immutable copy of
//! each revision's package, per profile (no cross-profile reuse, ADR 0025 question 4).
//! Packages are copied (never linked) into `skills/staging/<unique>/`, hashed there, then
//! renamed into `objects/`. Stored files are read-only (`0400`, or `0500` when executable)
//! and directories `0500`; the store directories are private (`0700`). On Windows only
//! the read-only attribute is set and the executable bit is always clear.
//!
//! # Accepted packages
//!
//! - The source is a real directory (not a symbolic link) outside the skill store.
//! - Every entry is a regular file with exactly one link or a directory. Symbolic links,
//!   hard-linked files, FIFOs, sockets and devices are refused, never followed or copied.
//! - Every path segment matches `[A-Za-z0-9_][A-Za-z0-9._-]{0,127}`, does not end with `.`
//!   and is not a Windows device name (`con`, `nul`, `com1`, ...). Names starting with `.`
//!   (hidden entries, `.` and `..`) are refused. Paths are at most 512 bytes. Because names
//!   are ASCII, NFC normalization (ADR 0025 §2) is the identity.
//! - No two paths differ only by ASCII case.
//! - Caps ([`StagingLimits`]): bytes per file, total bytes, entries (files and directories)
//!   and depth. A package must contain `SKILL.md` at its root.
//!
//! # Canonical tree hash `extalia.skill-tree.v1`
//!
//! `tree_sha256` is the lowercase hex SHA-256 of the bytes
//!
//! ```text
//! "extalia.skill-tree.v1\n"
//! for each regular file, sorted by the bytes of its path:
//!     <path> 0x00 <mode> 0x00 <size> 0x00 <sha256> "\n"
//! ```
//!
//! where `<path>` is the package-relative path with `/` separators, `<mode>` is `100755`
//! if any executable bit is set on the file and `100644` otherwise, `<size>` is the byte
//! length in ASCII decimal without leading zeros, and `<sha256>` is the lowercase hex
//! SHA-256 of the file's bytes. Directories are not listed (an empty directory does not
//! change the hash) and timestamps, owners and other mode bits are ignored. The hash is
//! always computed from the staged copy, never from the source (hash point a).

use std::collections::BTreeSet;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use super::manifest::SKILL_FILE;
use super::{ProfileId, Refusal, SkillError, refused};
use crate::sha256;

/// Domain separator and version of the canonical tree text.
pub const TREE_SCHEMA: &str = "extalia.skill-tree.v1";
const MODE_REGULAR: &str = "100644";
const MODE_EXECUTABLE: &str = "100755";
const MAX_SEGMENT_BYTES: usize = 128;
const MAX_PATH_BYTES: usize = 512;
const PRIVATE_DIRECTORY_MODE: u32 = 0o700;
const SEALED_DIRECTORY_MODE: u32 = 0o500;
const WINDOWS_DEVICE_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Package caps (ADR 0025 question 3; the owner may change the defaults).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StagingLimits {
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
    /// Files and directories together.
    pub max_entries: usize,
    /// Segments of the longest path (`SKILL.md` has depth 1).
    pub max_depth: usize,
}

impl Default for StagingLimits {
    fn default() -> Self {
        Self {
            max_file_bytes: 1024 * 1024,
            max_total_bytes: 8 * 1024 * 1024,
            max_entries: 256,
            max_depth: 8,
        }
    }
}

/// One regular file of a package tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    pub executable: bool,
}

/// A package tree: its files sorted by path and the canonical hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tree {
    pub sha256: String,
    pub files: Vec<TreeFile>,
}

impl Tree {
    /// Sort `files` by path and compute the canonical hash.
    pub fn from_files(mut files: Vec<TreeFile>) -> Self {
        files.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
        Self {
            sha256: sha256::hex_digest(&canonical_text(&files)),
            files,
        }
    }

    pub fn file(&self, path: &str) -> Option<&TreeFile> {
        self.files.iter().find(|file| file.path == path)
    }
}

/// The canonical text hashed into `tree_sha256`; `files` must be sorted by path.
pub fn canonical_text(files: &[TreeFile]) -> Vec<u8> {
    let mut out = format!("{TREE_SCHEMA}\n").into_bytes();
    for file in files {
        let mode = if file.executable {
            MODE_EXECUTABLE
        } else {
            MODE_REGULAR
        };
        out.extend_from_slice(file.path.as_bytes());
        out.push(0);
        out.extend_from_slice(mode.as_bytes());
        out.push(0);
        out.extend_from_slice(file.size.to_string().as_bytes());
        out.push(0);
        out.extend_from_slice(file.sha256.as_bytes());
        out.push(b'\n');
    }
    out
}

/// Check one path segment against the portable name rules.
pub fn check_segment(name: &str) -> Result<(), Refusal> {
    if name == "." || name == ".." || name.is_empty() {
        return Err(Refusal::InvalidName);
    }
    if name.starts_with('.') {
        return Err(Refusal::HiddenEntry);
    }
    let bytes = name.as_bytes();
    let portable = |byte: &u8| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-');
    if bytes.len() > MAX_SEGMENT_BYTES
        || !(bytes[0].is_ascii_alphanumeric() || bytes[0] == b'_')
        || !bytes.iter().all(portable)
        || name.ends_with('.')
    {
        return Err(Refusal::InvalidName);
    }
    let stem = name.split('.').next().unwrap_or(name).to_ascii_lowercase();
    if WINDOWS_DEVICE_NAMES.contains(&stem.as_str()) {
        return Err(Refusal::InvalidName);
    }
    Ok(())
}

/// Check a package-relative path: `/`-separated valid segments, no `.`/`..`, no leading or
/// trailing separator, at most 512 bytes.
pub fn check_relative_path(path: &str) -> Result<(), Refusal> {
    if path.is_empty() || path.len() > MAX_PATH_BYTES {
        return Err(Refusal::InvalidName);
    }
    path.split('/').try_for_each(check_segment)
}

/// The first path (lowercased) that collides with another one by ASCII case.
pub fn find_case_collision<'a>(paths: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let mut seen = BTreeSet::new();
    paths
        .into_iter()
        .map(str::to_ascii_lowercase)
        .find(|lower| !seen.insert(lower.clone()))
}

/// The per-profile skill object store.
#[derive(Debug, Clone)]
pub struct ObjectStore {
    root: PathBuf,
}

impl ObjectStore {
    pub fn new(data_dir: &Path, profile: &ProfileId) -> Self {
        Self {
            root: data_dir
                .join("profiles")
                .join(profile.as_str())
                .join("skills"),
        }
    }

    /// The immutable copy of a revision.
    pub fn object_dir(&self, tree_sha256: &str) -> PathBuf {
        self.root.join("objects").join(tree_sha256)
    }

    /// Copy `source` into quarantine and return the staged tree (hash point a). The same
    /// bytes staged twice address the same object; an existing object is re-verified and
    /// never overwritten.
    pub fn stage(&self, source: &Path, limits: &StagingLimits) -> Result<Tree, SkillError> {
        match fs::symlink_metadata(source) {
            Ok(meta) if meta.file_type().is_dir() => {}
            Ok(_) => return Err(refused(Refusal::NotADirectory, None)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(refused(Refusal::NotADirectory, None));
            }
            Err(error) => return Err(error.into()),
        }
        let staging = self.root.join("staging");
        let objects = self.root.join("objects");
        for dir in [&self.root, &staging, &objects] {
            fs::create_dir_all(dir)?;
            set_mode(dir, PRIVATE_DIRECTORY_MODE)?;
        }
        let source = fs::canonicalize(source)?;
        let store_root = fs::canonicalize(&self.root)?;
        if source.starts_with(&store_root) || store_root.starts_with(&source) {
            return Err(refused(Refusal::InsideStore, None));
        }
        let entries = collect(&source, limits)?;
        if !entries.iter().any(|entry| !entry.dir) {
            return Err(refused(Refusal::Empty, None));
        }
        if !entries
            .iter()
            .any(|entry| !entry.dir && entry.rel == SKILL_FILE)
        {
            return Err(refused(Refusal::MissingSkillMd, None));
        }

        let temp = new_staging_dir(&staging)?;
        let mut cleanup = Cleanup(Some(temp.clone()));
        let mut total = 0u64;
        for entry in &entries {
            let dest = native_path(&temp, &entry.rel);
            if entry.dir {
                fs::create_dir(&dest)?;
                set_mode(&dest, PRIVATE_DIRECTORY_MODE)?;
            } else {
                copy_file(entry, &dest, limits, &mut total)?;
            }
        }
        // Hash point (a): the staged copy, never the source.
        let tree = scan(&temp, limits)?;
        let object = self.object_dir(&tree.sha256);
        match fs::symlink_metadata(&object) {
            Ok(_) => {
                drop(cleanup);
                self.verify(&tree.sha256, limits)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::rename(&temp, &object)?;
                cleanup.0 = None;
                seal_directories(&object)?;
                Ok(tree)
            }
            Err(error) => Err(error.into()),
        }
    }

    /// Re-hash a stored object. A missing, altered or no longer acceptable object is
    /// [`SkillError::Integrity`]; other IO failures are returned as they are.
    pub fn verify(&self, tree_sha256: &str, limits: &StagingLimits) -> Result<Tree, SkillError> {
        match scan(&self.object_dir(tree_sha256), limits) {
            Ok(tree) if tree.sha256 == tree_sha256 => Ok(tree),
            Ok(_) | Err(SkillError::Refused { .. }) => Err(SkillError::Integrity),
            Err(SkillError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
                Err(SkillError::Integrity)
            }
            Err(error) => Err(error),
        }
    }

    /// Read one stored file and check it against its recorded size and SHA-256 (hash
    /// point g). No path component may be a symbolic link.
    pub fn read_file(
        &self,
        tree_sha256: &str,
        path: &str,
        expected: &TreeFile,
    ) -> Result<Vec<u8>, SkillError> {
        if check_relative_path(path).is_err() || expected.path != path {
            return Err(SkillError::Denied("invalid_path"));
        }
        let mut current = self.object_dir(tree_sha256);
        let integrity = |error: io::Error| match error.kind() {
            io::ErrorKind::NotFound => SkillError::Integrity,
            _ => SkillError::Io(error),
        };
        let root = fs::symlink_metadata(&current).map_err(integrity)?;
        if !root.file_type().is_dir() {
            return Err(SkillError::Integrity);
        }
        let segments: Vec<&str> = path.split('/').collect();
        for (index, segment) in segments.iter().enumerate() {
            current.push(segment);
            let meta = fs::symlink_metadata(&current).map_err(integrity)?;
            let last = index + 1 == segments.len();
            let kind_ok = if last {
                meta.file_type().is_file()
            } else {
                meta.file_type().is_dir()
            };
            if !kind_ok {
                return Err(SkillError::Integrity);
            }
        }
        let bytes = match read_regular(&current, expected.size, None) {
            Ok((bytes, _)) => bytes,
            Err(SkillError::Refused { .. }) => return Err(SkillError::Integrity),
            Err(error) => return Err(error),
        };
        if bytes.len() as u64 != expected.size || sha256::hex_digest(&bytes) != expected.sha256 {
            return Err(SkillError::Integrity);
        }
        Ok(bytes)
    }
}

/// Hash a directory tree with the staging rules (used for the staged copy and for every
/// later re-verification of the object).
pub fn scan(root: &Path, limits: &StagingLimits) -> Result<Tree, SkillError> {
    let meta = fs::symlink_metadata(root)?;
    if !meta.file_type().is_dir() {
        return Err(refused(Refusal::NotADirectory, None));
    }
    let mut files = Vec::new();
    let mut total = 0u64;
    for entry in collect(root, limits)? {
        if entry.dir {
            continue;
        }
        let (bytes, executable) = read_entry(&entry, limits)?;
        total += bytes.len() as u64;
        if total > limits.max_total_bytes {
            return Err(refused(Refusal::PackageTooLarge, None));
        }
        files.push(TreeFile {
            path: entry.rel,
            size: bytes.len() as u64,
            sha256: sha256::hex_digest(&bytes),
            executable,
        });
    }
    Ok(Tree::from_files(files))
}

struct Entry {
    rel: String,
    abs: PathBuf,
    dir: bool,
    /// `lstat` at walk time; a file is read only if the opened inode is this one, so a
    /// file or parent directory swapped for a link after the walk is refused (`changed`).
    meta: Metadata,
}

fn collect(root: &Path, limits: &StagingLimits) -> Result<Vec<Entry>, SkillError> {
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    walk(root, "", 1, limits, &mut out, &mut seen)?;
    Ok(out)
}

fn walk(
    dir: &Path,
    prefix: &str,
    depth: usize,
    limits: &StagingLimits,
    out: &mut Vec<Entry>,
    seen: &mut BTreeSet<String>,
) -> Result<(), SkillError> {
    let mut names = Vec::new();
    for entry in fs::read_dir(dir)? {
        names.push(entry?.file_name());
        if out.len() + names.len() > limits.max_entries {
            return Err(refused(Refusal::TooManyEntries, None));
        }
    }
    names.sort();
    for name in names {
        let name = name
            .into_string()
            .map_err(|_| refused(Refusal::InvalidName, None))?;
        check_segment(&name).map_err(|refusal| refused(refusal, None))?;
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if rel.len() > MAX_PATH_BYTES {
            return Err(refused(Refusal::InvalidName, None));
        }
        if !seen.insert(rel.to_ascii_lowercase()) {
            return Err(refused(Refusal::PathCollision, Some(&rel)));
        }
        let abs = dir.join(&name);
        let meta = fs::symlink_metadata(&abs)?;
        let kind = meta.file_type();
        if kind.is_symlink() {
            return Err(refused(Refusal::Symlink, Some(&rel)));
        } else if kind.is_dir() {
            if depth + 1 > limits.max_depth {
                return Err(refused(Refusal::TooDeep, Some(&rel)));
            }
            out.push(Entry {
                rel: rel.clone(),
                abs: abs.clone(),
                dir: true,
                meta,
            });
            walk(&abs, &rel, depth + 1, limits, out, seen)?;
        } else if kind.is_file() {
            if link_count(&meta) > 1 {
                return Err(refused(Refusal::HardLink, Some(&rel)));
            }
            out.push(Entry {
                rel,
                abs,
                dir: false,
                meta,
            });
        } else {
            return Err(refused(Refusal::SpecialFile, Some(&rel)));
        }
        if out.len() > limits.max_entries {
            return Err(refused(Refusal::TooManyEntries, None));
        }
    }
    Ok(())
}

/// Open a regular file without following a swapped-in link and read at most `cap` + 1
/// bytes. The opened file must be the inode that `lstat` saw, and the inode the walk saw
/// bytes when `expected` (the walk-time `lstat`) is given. Returns the bytes and the
/// opened file's metadata.
fn read_regular(
    path: &Path,
    cap: u64,
    expected: Option<&Metadata>,
) -> Result<(Vec<u8>, Metadata), SkillError> {
    let before = fs::symlink_metadata(path)?;
    if !before.file_type().is_file() {
        return Err(refused(Refusal::Changed, None));
    }
    let mut file = File::open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file()
        || !same_file(&before, &meta)
        || expected.is_some_and(|expected| !same_file(expected, &meta))
    {
        return Err(refused(Refusal::Changed, None));
    }
    if link_count(&meta) > 1 {
        return Err(refused(Refusal::HardLink, None));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(cap.saturating_add(1))
        .read_to_end(&mut bytes)?;
    Ok((bytes, meta))
}

fn read_entry(entry: &Entry, limits: &StagingLimits) -> Result<(Vec<u8>, bool), SkillError> {
    let rel = entry.rel.as_str();
    if entry.meta.len() > limits.max_file_bytes {
        return Err(refused(Refusal::FileTooLarge, Some(rel)));
    }
    let (bytes, meta) = read_regular(&entry.abs, limits.max_file_bytes, Some(&entry.meta))
        .map_err(|error| match error {
            SkillError::Refused { refusal, .. } => refused(refusal, Some(rel)),
            other => other,
        })?;
    if bytes.len() as u64 > limits.max_file_bytes {
        return Err(refused(Refusal::FileTooLarge, Some(rel)));
    }
    Ok((bytes, is_executable(&meta)))
}

fn copy_file(
    entry: &Entry,
    dest: &Path,
    limits: &StagingLimits,
    total: &mut u64,
) -> Result<(), SkillError> {
    let (bytes, executable) = read_entry(entry, limits)?;
    *total += bytes.len() as u64;
    if *total > limits.max_total_bytes {
        return Err(refused(Refusal::PackageTooLarge, None));
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(dest)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    seal_file(dest, executable)
}

fn new_staging_dir(staging: &Path) -> io::Result<PathBuf> {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    for _ in 0..100 {
        let candidate = staging.join(format!(
            "{}-{nanos}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        match fs::create_dir(&candidate) {
            Ok(()) => {
                set_mode(&candidate, PRIVATE_DIRECTORY_MODE)?;
                return Ok(candidate);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::from(io::ErrorKind::AlreadyExists))
}

/// Removes an unfinished staging directory (best effort).
struct Cleanup(Option<PathBuf>);

impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_dir_all(path);
        }
    }
}

fn native_path(root: &Path, rel: &str) -> PathBuf {
    rel.split('/')
        .fold(root.to_path_buf(), |path, segment| path.join(segment))
}

/// Make every directory of a stored object read-only, children first.
fn seal_directories(dir: &Path) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            seal_directories(&entry.path())?;
        }
    }
    set_mode(dir, SEALED_DIRECTORY_MODE)
}

#[cfg(unix)]
fn seal_file(path: &Path, executable: bool) -> Result<(), SkillError> {
    Ok(set_mode(path, if executable { 0o500 } else { 0o400 })?)
}

#[cfg(not(unix))]
fn seal_file(path: &Path, _executable: bool) -> Result<(), SkillError> {
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_readonly(true);
    Ok(fs::set_permissions(path, permissions)?)
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

/// Windows has no mode bits; the data directory's ACL applies.
#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn is_executable(meta: &Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_meta: &Metadata) -> bool {
    false
}

#[cfg(unix)]
fn link_count(meta: &Metadata) -> u64 {
    std::os::unix::fs::MetadataExt::nlink(meta)
}

#[cfg(not(unix))]
fn link_count(_meta: &Metadata) -> u64 {
    1
}

#[cfg(unix)]
fn same_file(a: &Metadata, b: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev() && a.ino() == b.ino()
}

#[cfg(not(unix))]
fn same_file(a: &Metadata, b: &Metadata) -> bool {
    a.len() == b.len()
}
