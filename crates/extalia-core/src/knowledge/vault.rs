//! A profile's vault root and the safe walker (ADR 0024 §5).
//!
//! - The default root is `<data>/vaults/<profile-id>/`, created private (`0700`). It must
//!   be a real directory (not a symbolic link) whose canonical path lies inside the
//!   canonical data directory; it is re-validated before every walk.
//! - A user-chosen root ([`Vault::open_custom`], ADR 0024 V3) is never created. It must be an
//!   existing real directory (the root itself not a symbolic link), not the file system root,
//!   not the data directory or one of its ancestors, and not inside the data directory except
//!   below the profile's own default root. Its canonical path is pinned when opened: a root
//!   that disappears, is replaced by a link or resolves elsewhere later is unavailable, and
//!   nothing falls back to another path. Callers add their own policy (for example refusing
//!   the home directory).
//! - The walker never follows symbolic links (files or directories), so nothing outside
//!   the root is read. Names starting with `.` are ignored (`.obsidian/`, `.trash/`,
//!   `.git/`, hidden files). Only regular files named `*.md` (any case) are notes; other
//!   files are attachments and ignored. Symbolic links, special files, hard-linked files,
//!   non-UTF-8 names and directories deeper than the cap are reported as skipped.
//! - A note is read through the inode the walk saw (a file or parent swapped after the
//!   walk is refused), at most `max_file_bytes` + 1 bytes; larger files are skipped
//!   unread. Content must be UTF-8 (a leading byte order mark is removed).
//! - Too many entries or notes fail the whole walk: the index is never replaced by a
//!   partial view of a vault.

use std::collections::BTreeMap;
use std::fs::{self, File, Metadata};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use super::KnowledgeError;
use crate::skills::ProfileId;

const PRIVATE_DIRECTORY_MODE: u32 = 0o700;

/// Walk and read caps. The defaults may change with owner input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VaultLimits {
    pub max_file_bytes: u64,
    /// Sum of the sizes of readable notes (bounds memory during a rebuild).
    pub max_total_bytes: u64,
    /// Notes (`*.md` files) per vault.
    pub max_notes: usize,
    /// Directory entries visited per walk (files, directories and ignored names).
    pub max_entries: usize,
    /// Directory nesting below the root.
    pub max_depth: usize,
    /// Vault-relative path bytes.
    pub max_path_bytes: usize,
    /// Links kept per note; later ones are ignored.
    pub max_links_per_note: usize,
}

impl Default for VaultLimits {
    fn default() -> Self {
        Self {
            max_file_bytes: 1024 * 1024,
            max_total_bytes: 256 * 1024 * 1024,
            max_notes: 20_000,
            max_entries: 200_000,
            max_depth: 32,
            max_path_bytes: 1024,
            max_links_per_note: 2_000,
        }
    }
}

/// Why a file was not indexed. Reported to the vault's owner; never visible to another
/// profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SkipReason {
    Symlink,
    SpecialFile,
    HardLink,
    InvalidName,
    TooDeep,
    TooLarge,
    NotUtf8,
    InvalidFrontMatter,
    ProfileMismatch,
    DuplicateId,
}

impl SkipReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Symlink => "symlink",
            Self::SpecialFile => "special_file",
            Self::HardLink => "hard_link",
            Self::InvalidName => "invalid_name",
            Self::TooDeep => "too_deep",
            Self::TooLarge => "too_large",
            Self::NotUtf8 => "not_utf8",
            Self::InvalidFrontMatter => "invalid_front_matter",
            Self::ProfileMismatch => "profile_mismatch",
            Self::DuplicateId => "duplicate_id",
        }
    }

    pub(crate) fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "too_large" => Self::TooLarge,
            "not_utf8" => Self::NotUtf8,
            "invalid_front_matter" => Self::InvalidFrontMatter,
            "profile_mismatch" => Self::ProfileMismatch,
            "duplicate_id" => Self::DuplicateId,
            _ => return None,
        })
    }
}

/// A validated vault root of one profile.
#[derive(Debug, Clone)]
pub struct Vault {
    root: PathBuf,
    data_dir: PathBuf,
    profile: ProfileId,
    limits: VaultLimits,
    /// Canonical path of a user-chosen root, pinned when opened.
    pinned: Option<PathBuf>,
}

impl Vault {
    /// `<data>/vaults/<profile-id>/`, created private when missing.
    pub fn open_default(
        data_dir: &Path,
        profile: &ProfileId,
        limits: VaultLimits,
    ) -> Result<Self, KnowledgeError> {
        let vaults = data_dir.join("vaults");
        let root = vaults.join(profile.as_str());
        for dir in [&vaults, &root] {
            match fs::create_dir(dir) {
                Ok(()) => set_mode(dir, PRIVATE_DIRECTORY_MODE)?,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    return Err(KnowledgeError::VaultUnavailable);
                }
                Err(error) => return Err(error.into()),
            }
        }
        let vault = Self {
            root,
            data_dir: data_dir.to_path_buf(),
            profile: profile.clone(),
            limits,
            pinned: None,
        };
        vault.validate()?;
        Ok(vault)
    }

    /// A user-chosen root (module documentation); never created. `root` must be absolute.
    pub fn open_custom(
        root: &Path,
        data_dir: &Path,
        profile: &ProfileId,
        limits: VaultLimits,
    ) -> Result<Self, KnowledgeError> {
        let unavailable = |_| KnowledgeError::VaultUnavailable;
        if !root.is_absolute() {
            return Err(KnowledgeError::VaultUnavailable);
        }
        let meta = fs::symlink_metadata(root).map_err(unavailable)?;
        if !meta.file_type().is_dir() {
            return Err(KnowledgeError::VaultUnavailable);
        }
        let canonical = fs::canonicalize(root).map_err(unavailable)?;
        let data = fs::canonicalize(data_dir).map_err(unavailable)?;
        let own_default = data.join("vaults").join(profile.as_str());
        if canonical.parent().is_none()
            || data.starts_with(&canonical)
            || (canonical.starts_with(&data) && !canonical.starts_with(&own_default))
        {
            return Err(KnowledgeError::VaultUnavailable);
        }
        Ok(Self {
            root: root.to_path_buf(),
            data_dir: data_dir.to_path_buf(),
            profile: profile.clone(),
            limits,
            pinned: Some(canonical),
        })
    }

    /// Whether this is a user-chosen root.
    pub fn is_custom(&self) -> bool {
        self.pinned.is_some()
    }

    /// Re-validate the root now (the same check every walk, read and write runs).
    pub fn check(&self) -> Result<(), KnowledgeError> {
        self.validate().map(drop)
    }

    pub fn profile(&self) -> &ProfileId {
        &self.profile
    }

    pub fn limits(&self) -> &VaultLimits {
        &self.limits
    }

    /// The root as configured (not canonicalized).
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Canonical root, after checking it is still a real directory inside the data
    /// directory. A missing, replaced or moved root disables the vault; nothing falls
    /// back to another path.
    pub(crate) fn validate(&self) -> Result<PathBuf, KnowledgeError> {
        let unavailable = |_| KnowledgeError::VaultUnavailable;
        let meta = fs::symlink_metadata(&self.root).map_err(unavailable)?;
        if !meta.file_type().is_dir() {
            return Err(KnowledgeError::VaultUnavailable);
        }
        let root = fs::canonicalize(&self.root).map_err(unavailable)?;
        if let Some(pinned) = &self.pinned {
            return if &root == pinned {
                Ok(root)
            } else {
                Err(KnowledgeError::VaultUnavailable)
            };
        }
        let data = fs::canonicalize(&self.data_dir).map_err(unavailable)?;
        if root == data || !root.starts_with(&data) {
            return Err(KnowledgeError::VaultUnavailable);
        }
        Ok(root)
    }

    /// Walk the vault: every note candidate with its walk-time metadata, and the entries
    /// refused by the walk.
    pub(crate) fn walk(&self) -> Result<Walk, KnowledgeError> {
        let root = self.validate()?;
        let mut walk = Walk::default();
        let mut entries = 0usize;
        self.walk_dir(&root, "", 0, &mut walk, &mut entries)?;
        Ok(walk)
    }

    fn walk_dir(
        &self,
        dir: &Path,
        prefix: &str,
        depth: usize,
        walk: &mut Walk,
        entries: &mut usize,
    ) -> Result<(), KnowledgeError> {
        let mut names = Vec::new();
        for entry in fs::read_dir(dir)? {
            names.push(entry?.file_name());
            *entries += 1;
            if *entries > self.limits.max_entries {
                return Err(KnowledgeError::VaultTooLarge);
            }
        }
        names.sort();
        for name in names {
            let lossy = name.to_string_lossy().into_owned();
            if lossy.starts_with('.') {
                continue;
            }
            let rel_of = |name: &str| {
                if prefix.is_empty() {
                    name.to_owned()
                } else {
                    format!("{prefix}/{name}")
                }
            };
            let abs = dir.join(&name);
            let Some(name) = name.to_str() else {
                walk.skipped.insert(rel_of(&lossy), SkipReason::InvalidName);
                continue;
            };
            let rel = rel_of(name);
            if rel.len() > self.limits.max_path_bytes || name.contains(['\\', '\u{0}']) {
                walk.skipped.insert(rel, SkipReason::InvalidName);
                continue;
            }
            let meta = fs::symlink_metadata(&abs)?;
            let kind = meta.file_type();
            let is_note = is_note_name(name);
            if kind.is_symlink() {
                walk.skipped.insert(rel, SkipReason::Symlink);
            } else if kind.is_dir() {
                if depth + 1 > self.limits.max_depth {
                    walk.skipped.insert(rel, SkipReason::TooDeep);
                } else {
                    self.walk_dir(&abs, &rel, depth + 1, walk, entries)?;
                }
            } else if !is_note {
                // Attachments and other files are not notes.
            } else if !kind.is_file() {
                walk.skipped.insert(rel, SkipReason::SpecialFile);
            } else if link_count(&meta) > 1 {
                walk.skipped.insert(rel, SkipReason::HardLink);
            } else {
                walk.notes.insert(
                    rel,
                    NoteFile {
                        abs,
                        size: meta.len(),
                        mtime_ns: mtime_ns(&meta),
                        meta,
                    },
                );
                if walk.notes.len() > self.limits.max_notes {
                    return Err(KnowledgeError::VaultTooLarge);
                }
            }
        }
        Ok(())
    }
}

/// `*.md`, any case, with a non-empty stem.
pub(crate) fn is_note_name(name: &str) -> bool {
    name.len() > 3 && name.is_char_boundary(name.len() - 3) && {
        let (stem, ext) = name.split_at(name.len() - 3);
        ext.eq_ignore_ascii_case(".md") && !stem.is_empty()
    }
}

/// Result of a walk, keyed by vault-relative path (`/` separators).
#[derive(Debug, Default)]
pub(crate) struct Walk {
    pub notes: BTreeMap<String, NoteFile>,
    pub skipped: BTreeMap<String, SkipReason>,
}

#[derive(Debug)]
pub(crate) struct NoteFile {
    pub abs: PathBuf,
    pub size: u64,
    pub mtime_ns: i64,
    meta: Metadata,
}

/// What reading a note produced.
#[derive(Debug)]
pub(crate) enum Content {
    Text {
        text: String,
        sha256: String,
    },
    /// Not UTF-8; the digest is kept so an unchanged file is not read again.
    NotUtf8 {
        sha256: String,
    },
    TooLarge,
}

impl NoteFile {
    /// Read through the inode the walk saw, without following a swapped-in link.
    pub(crate) fn read(&self, cap: u64) -> Result<Content, KnowledgeError> {
        if self.size > cap {
            return Ok(Content::TooLarge);
        }
        let before = fs::symlink_metadata(&self.abs)?;
        if !before.file_type().is_file() {
            return Err(KnowledgeError::Changed);
        }
        let mut file = File::open(&self.abs)?;
        let opened = file.metadata()?;
        if !opened.is_file()
            || !same_file(&before, &opened)
            || !same_file(&self.meta, &opened)
            || link_count(&opened) > 1
        {
            return Err(KnowledgeError::Changed);
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(cap.saturating_add(1))
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > cap {
            return Ok(Content::TooLarge);
        }
        let sha256 = crate::sha256::hex_digest(&bytes);
        match String::from_utf8(bytes) {
            Ok(mut text) => {
                if text.starts_with('\u{feff}') {
                    text.drain(..'\u{feff}'.len_utf8());
                }
                Ok(Content::Text { text, sha256 })
            }
            Err(_) => Ok(Content::NotUtf8 { sha256 }),
        }
    }
}

fn mtime_ns(meta: &Metadata) -> i64 {
    match meta.modified() {
        Ok(time) => match time.duration_since(UNIX_EPOCH) {
            Ok(after) => i64::try_from(after.as_nanos()).unwrap_or(i64::MAX),
            Err(before) => i64::try_from(before.duration().as_nanos())
                .map(|nanos| -nanos)
                .unwrap_or(i64::MIN),
        },
        Err(_) => 0,
    }
}

#[cfg(unix)]
pub(crate) fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

/// Windows has no mode bits; the data directory's ACL applies.
#[cfg(not(unix))]
pub(crate) fn set_mode(_path: &Path, _mode: u32) -> io::Result<()> {
    Ok(())
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
