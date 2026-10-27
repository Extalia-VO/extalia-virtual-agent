//! Safe note writes, W5 slice 2b (PRD v1.1 sync contract; ADR 0024 amendment
//! 2026-10-23 and its slice 2b note; ADR 0027).
//!
//! The vault's Markdown is the authored truth and may be edited at any time by the user or
//! an external editor, so every write is a compare-and-swap that never silently replaces
//! somebody else's text:
//!
//! - **Path rules** are the walker's ([`super::vault`]): a vault-relative path with `/`
//!   separators, no empty, `.` or `..` segment, no segment starting with `.` (hidden names
//!   are ignored by the walker), no `\`, NUL or control characters, a `*.md` file name, at
//!   most `max_depth` folders and `max_path_bytes` bytes. Content is UTF-8 (`&str`) of at
//!   most `max_file_bytes` bytes.
//! - **No links.** Every folder on the way must be a real directory (missing ones are
//!   created `0700`), and the target must be absent or a regular file with a single link.
//!   A symbolic link, special file or hard-linked file anywhere on the path refuses the
//!   write ([`WriteError::Unsafe`]). The current note is read through the inode it was
//!   checked with.
//! - **Atomic replace.** The new text goes to a hidden temporary file in the target's
//!   folder (ignored by the walker), is flushed with `fsync`, then renamed over the target
//!   (or hard-linked into place when the note must still be absent, so a file created
//!   meanwhile is never replaced); the folder is flushed afterwards. An existing note keeps
//!   its permission bits; a new note is `0600`.
//! - **Compare-and-swap.** The caller states what it believes is on disk
//!   ([`Expected::Absent`] or the SHA-256 of a read). The current file is hashed before the
//!   temporary file is written and **hashed again right before the rename**. On any
//!   mismatch nothing is replaced: the proposed text is written as a *conflict copy*
//!   `Name (conflict <yyyymmddThhmmssZ> <first 8 hex of the proposal>).md` next to the note
//!   and [`WriteOutcome::Conflict`] is returned. The conflict copy is a separate note: its
//!   front matter gains `conflict_of` (the original path) and `conflict_base_sha256`, and
//!   its `id`, `aliases` and `managed_by` keys are renamed `conflict_id`, `conflict_aliases`
//!   and `conflict_managed_by`, so it never takes the original's identity (duplicate ids
//!   resolve to the smallest path) nor becomes auto-updatable. The journal entry of the
//!   conflict is the review record. A change that lands between the second hash and the
//!   rename (a window of one system call) cannot be detected without platform-specific
//!   exchange renames; that residual race is documented, not hidden.
//! - **History.** Before a note is replaced, its previous bytes and the new bytes are
//!   stored content-addressed in `<data>/profiles/<profile>/knowledge-history/objects/`
//!   and every create, update, rollback and conflict is appended to
//!   `knowledge-history/journal.jsonl` (private `0600` files in `0700` folders). Any
//!   overwrite is recoverable with [`rollback`], which restores a version from the note's
//!   own history through the same compare-and-swap path.
//! - **No deletes.** Nothing here removes or moves a note; only Extalia's own temporary
//!   files are removed. Retiring a note (for example moving it to `_archive/`) is out of
//!   scope: it changes paths and links and needs an explicit user action, not automation.
//! - **Ownership.** A note is *Extalia-managed* when its front matter says
//!   `managed_by: extalia`. A per-note marker is used instead of an `Extalia/` folder
//!   because ADR 0024 §7 places imported memory under `Projects/<workspace>/Memory/` and the
//!   PRD taxonomy (`Knowledge/`, `Experiences/`, …) holds Extalia-merged notes beside user
//!   notes; the marker also survives a rename, and the user takes a note over by deleting
//!   the line. [`Author::Extalia`] may only create notes whose content is managed and only
//!   replace notes that are currently managed; an Extalia update of a user note becomes a
//!   conflict copy (a proposal), never an overwrite. [`Author::User`] (a person who reviewed
//!   the note) may write any note, still only with the hash of their read. The marker grants
//!   no trust (ADR 0027): it only allows recoverable, journaled proposals to apply.

use std::cell::Cell;
use std::fmt;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::KnowledgeError;
use super::frontmatter;
use super::vault::{SkipReason, Vault, VaultLimits, is_note_name, set_mode};
use crate::sha256::hex_digest;
use crate::skills::ProfileId;

/// Folder of the revision journal below `<data>/profiles/<profile-id>/`.
pub const HISTORY_DIR: &str = "knowledge-history";
const OBJECTS_DIR: &str = "objects";
const JOURNAL_FILE: &str = "journal.jsonl";
/// Front matter key and value that mark an Extalia-managed note.
pub const MANAGED_KEY: &str = "managed_by";
pub const MANAGED_VALUE: &str = "extalia";
const PRIVATE_FILE_MODE: u32 = 0o600;
const PRIVATE_DIRECTORY_MODE: u32 = 0o700;
const MAX_CONFLICT_NAMES: u32 = 100;
const READ_ATTEMPTS: usize = 3;
/// Keys renamed in a conflict copy so it never takes the original's identity.
const CONFLICT_RENAMED_KEYS: [&str; 3] = ["id", "aliases", MANAGED_KEY];

/// What the caller believes is on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expected {
    /// The note must not exist yet.
    Absent,
    /// The lowercase hex SHA-256 of the note's bytes, from a read.
    Sha256(String),
}

/// Who asks for a write; decides the ownership rule (module documentation).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Author {
    /// A person who reviewed the current note; the expected hash comes from their read.
    User,
    /// An Extalia component (for example `memory-import`); may only touch managed notes.
    Extalia { component: &'static str },
}

impl Author {
    pub fn label(&self) -> String {
        match self {
            Self::User => "user".to_owned(),
            Self::Extalia { component } => format!("extalia:{component}"),
        }
    }
}

/// Why a write produced a conflict copy instead of replacing the note.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictReason {
    /// The note on disk differs from [`Expected`].
    HashMismatch,
    /// The note changed while the new version was being written.
    ChangedDuringWrite,
    /// An Extalia update of a note that is not (or no longer) Extalia-managed.
    NotManaged,
}

impl ConflictReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::HashMismatch => "hash_mismatch",
            Self::ChangedDuringWrite => "changed_during_write",
            Self::NotManaged => "not_managed",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "hash_mismatch" => Self::HashMismatch,
            "changed_during_write" => Self::ChangedDuringWrite,
            "not_managed" => Self::NotManaged,
            _ => return None,
        })
    }
}

/// Result of a write. Paths are vault-relative.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteOutcome {
    Written {
        path: String,
        previous_sha256: Option<String>,
        sha256: String,
    },
    /// The note already has exactly this content; nothing was written.
    Unchanged { path: String, sha256: String },
    /// Nothing was replaced; the proposal is in `conflict_path`.
    Conflict {
        /// What is on disk now (`None`: the note is absent).
        current_sha256: Option<String>,
        conflict_path: String,
        reason: ConflictReason,
    },
}

/// Why a write was refused. Messages are generic: no paths or note text.
#[derive(Debug)]
pub enum WriteError {
    /// The vault-relative path breaks the walker's rules.
    InvalidPath,
    /// The expected hash is not a lowercase hex SHA-256.
    InvalidExpected,
    /// The content, or the note it would replace, exceeds `max_file_bytes`.
    TooLarge,
    /// Extalia content without valid front matter for this profile, or a version that is
    /// not UTF-8.
    InvalidContent,
    /// Extalia content without `managed_by: extalia`.
    NotManagedContent,
    /// A symbolic link, special file or hard link on the note's path.
    Unsafe(SkipReason),
    /// The version is not in the note's history, or its stored copy is damaged.
    UnknownVersion,
    /// The history folder, journal or a stored version is not a private regular file.
    History,
    Knowledge(KnowledgeError),
    Io(io::Error),
}

impl fmt::Display for WriteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath => f.write_str("note path is not a valid vault note path"),
            Self::InvalidExpected => f.write_str("expected note hash is not a SHA-256"),
            Self::TooLarge => f.write_str("note exceeds the size limit"),
            Self::InvalidContent => f.write_str("note content is not valid for this write"),
            Self::NotManagedContent => f.write_str("Extalia notes must be marked managed"),
            Self::Unsafe(reason) => write!(f, "note path is unsafe ({})", reason.as_str()),
            Self::UnknownVersion => f.write_str("note version is not in its history"),
            Self::History => f.write_str("knowledge history is not a private folder"),
            Self::Knowledge(error) => error.fmt(f),
            Self::Io(_) => f.write_str("note file access failed"),
        }
    }
}

impl std::error::Error for WriteError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Knowledge(source) => Some(source),
            Self::Io(source) => Some(source),
            _ => None,
        }
    }
}

impl From<io::Error> for WriteError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<KnowledgeError> for WriteError {
    fn from(error: KnowledgeError) -> Self {
        Self::Knowledge(error)
    }
}

/// Journal operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryOp {
    Create,
    Update,
    Rollback,
    Conflict,
}

impl HistoryOp {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Update => "update",
            Self::Rollback => "rollback",
            Self::Conflict => "conflict",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "create" => Self::Create,
            "update" => Self::Update,
            "rollback" => Self::Rollback,
            "conflict" => Self::Conflict,
            _ => return None,
        })
    }
}

/// One journal line. For a conflict, `path` is the original note, `previous_sha256` what
/// was on disk, `sha256` the conflict copy's content and `conflict_path` its path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryEntry {
    pub at: String,
    pub op: HistoryOp,
    pub path: String,
    pub previous_sha256: Option<String>,
    pub sha256: String,
    pub author: String,
    pub conflict_path: Option<String>,
    pub reason: Option<ConflictReason>,
}

impl HistoryEntry {
    fn to_json(&self) -> String {
        serde_json::json!({
            "at": self.at,
            "op": self.op.as_str(),
            "path": self.path,
            "previous_sha256": self.previous_sha256,
            "sha256": self.sha256,
            "author": self.author,
            "conflict_path": self.conflict_path,
            "reason": self.reason.map(ConflictReason::as_str),
        })
        .to_string()
    }

    fn from_json(line: &str) -> Option<Self> {
        let value: serde_json::Value = serde_json::from_str(line).ok()?;
        let text = |key: &str| value.get(key).and_then(|v| v.as_str()).map(str::to_owned);
        let entry = Self {
            at: text("at")?,
            op: HistoryOp::parse(&text("op")?)?,
            path: text("path")?,
            previous_sha256: text("previous_sha256"),
            sha256: text("sha256")?,
            author: text("author")?,
            conflict_path: text("conflict_path"),
            reason: text("reason").and_then(|reason| ConflictReason::parse(&reason)),
        };
        Some(entry)
    }
}

/// The append-only revision journal of one profile:
/// `<data>/profiles/<profile-id>/knowledge-history/{journal.jsonl,objects/<sha256>}`.
#[derive(Debug, Clone)]
pub struct History {
    dir: PathBuf,
    profile: ProfileId,
}

impl History {
    /// Open (creating private folders) the profile's history. The data directory must exist.
    pub fn open(data_dir: &Path, profile: &ProfileId) -> Result<Self, WriteError> {
        if !fs::symlink_metadata(data_dir)?.file_type().is_dir() {
            return Err(WriteError::History);
        }
        let profiles = data_dir.join("profiles");
        let own = profiles.join(profile.as_str());
        let dir = own.join(HISTORY_DIR);
        for folder in [&profiles, &own, &dir, &dir.join(OBJECTS_DIR)] {
            private_dir(folder)?;
        }
        Ok(Self {
            dir,
            profile: profile.clone(),
        })
    }

    pub fn profile(&self) -> &ProfileId {
        &self.profile
    }

    /// The history folder (Extalia's own files live here, for example the import marker).
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Journal entries that concern `path` (as the note or as a conflict copy), oldest
    /// first. A torn or unreadable line is ignored.
    pub fn entries(&self, path: &str) -> Result<Vec<HistoryEntry>, WriteError> {
        let journal = self.dir.join(JOURNAL_FILE);
        let text = match fs::symlink_metadata(&journal) {
            Ok(meta) if meta.file_type().is_file() => fs::read_to_string(&journal)?,
            Ok(_) => return Err(WriteError::History),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        Ok(text
            .lines()
            .filter_map(HistoryEntry::from_json)
            .filter(|entry| entry.path == path || entry.conflict_path.as_deref() == Some(path))
            .collect())
    }

    /// A stored version by its SHA-256, verified against its name.
    pub fn version(&self, sha256: &str) -> Result<Option<Vec<u8>>, WriteError> {
        if !is_sha256(sha256) {
            return Err(WriteError::InvalidExpected);
        }
        let path = self.dir.join(OBJECTS_DIR).join(sha256);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_file() => {}
            Ok(_) => return Err(WriteError::History),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        }
        let bytes = fs::read(&path)?;
        Ok((hex_digest(&bytes) == sha256).then_some(bytes))
    }

    fn store(&self, bytes: &[u8], sha256: &str) -> Result<(), WriteError> {
        let objects = self.dir.join(OBJECTS_DIR);
        let path = objects.join(sha256);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_file() && meta.len() == bytes.len() as u64 => {
                return Ok(());
            }
            Ok(meta) if !meta.file_type().is_file() => return Err(WriteError::History),
            // A damaged copy is replaced by a verified one below.
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let temp = TempFile::create(&objects, bytes, PRIVATE_FILE_MODE)?;
        fs::rename(&temp.path, &path)?;
        temp.disarm();
        sync_dir(&objects)?;
        Ok(())
    }

    fn append(&self, entry: &HistoryEntry) -> Result<(), WriteError> {
        let journal = self.dir.join(JOURNAL_FILE);
        match fs::symlink_metadata(&journal) {
            Ok(meta) if !meta.file_type().is_file() || link_count(&meta) > 1 => {
                return Err(WriteError::History);
            }
            _ => {}
        }
        let mut options = OpenOptions::new();
        options.append(true).create(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, PRIVATE_FILE_MODE);
        let mut file = options.open(&journal)?;
        let mut line = entry.to_json();
        line.push('\n');
        file.write_all(line.as_bytes())?;
        file.sync_data()?;
        Ok(())
    }
}

/// A note read for review; `sha256` is what a later [`write_note`] passes as expected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteRead {
    pub text: String,
    pub sha256: String,
    /// `managed_by: extalia` in valid front matter.
    pub managed: bool,
}

/// Read a note with the write path's rules (no links, size cap, UTF-8 only).
pub fn read_note(vault: &Vault, rel_path: &str) -> Result<Option<NoteRead>, WriteError> {
    let segments = validate_note_path(rel_path, vault.limits())?;
    let root = vault.validate()?;
    let mut abs = root.clone();
    for segment in &segments[..segments.len() - 1] {
        abs.push(segment);
        match fs::symlink_metadata(&abs) {
            Ok(meta) => check_dir(&meta)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        }
    }
    abs.push(segments[segments.len() - 1]);
    let Some(current) = read_current(&abs, vault.limits().max_file_bytes)? else {
        return Ok(None);
    };
    let text = String::from_utf8(current.bytes).map_err(|_| WriteError::InvalidContent)?;
    let managed = is_managed(&text);
    Ok(Some(NoteRead {
        text,
        sha256: current.sha256,
        managed,
    }))
}

/// Write `content` to the note at `rel_path` if, and only if, the note on disk is what
/// `expected` says (module documentation).
pub fn write_note(
    vault: &Vault,
    history: &History,
    rel_path: &str,
    content: &str,
    expected: &Expected,
    author: Author,
) -> Result<WriteOutcome, WriteError> {
    commit(vault, history, rel_path, content, expected, author, false)
}

/// Restore the version `to_sha256` from the note's own history, through the same
/// compare-and-swap path (`expected` is the current note's hash from a read).
pub fn rollback(
    vault: &Vault,
    history: &History,
    rel_path: &str,
    to_sha256: &str,
    expected: &Expected,
    author: Author,
) -> Result<WriteOutcome, WriteError> {
    validate_note_path(rel_path, vault.limits())?;
    if !is_sha256(to_sha256) {
        return Err(WriteError::InvalidExpected);
    }
    let known = history.entries(rel_path)?.iter().any(|entry| {
        entry.path == rel_path
            && (entry.previous_sha256.as_deref() == Some(to_sha256)
                || (entry.op != HistoryOp::Conflict && entry.sha256 == to_sha256))
    });
    if !known {
        return Err(WriteError::UnknownVersion);
    }
    let bytes = history
        .version(to_sha256)?
        .ok_or(WriteError::UnknownVersion)?;
    let content = String::from_utf8(bytes).map_err(|_| WriteError::InvalidContent)?;
    commit(vault, history, rel_path, &content, expected, author, true)
}

fn commit(
    vault: &Vault,
    history: &History,
    rel_path: &str,
    content: &str,
    expected: &Expected,
    author: Author,
    is_rollback: bool,
) -> Result<WriteOutcome, WriteError> {
    if history.profile() != vault.profile() {
        return Err(KnowledgeError::WrongProfile.into());
    }
    let limits = vault.limits();
    let segments = validate_note_path(rel_path, limits)?;
    if let Expected::Sha256(hash) = expected
        && !is_sha256(hash)
    {
        return Err(WriteError::InvalidExpected);
    }
    if content.len() as u64 > limits.max_file_bytes {
        return Err(WriteError::TooLarge);
    }
    if matches!(author, Author::Extalia { .. }) {
        let split = frontmatter::split(content).map_err(|_| WriteError::InvalidContent)?;
        if split
            .front_matter
            .profile
            .as_ref()
            .is_some_and(|declared| declared != vault.profile())
        {
            return Err(WriteError::InvalidContent);
        }
        if !is_managed(content) {
            return Err(WriteError::NotManagedContent);
        }
    }
    let root = vault.validate()?;
    let parent = ensure_parent(&root, &segments[..segments.len() - 1])?;
    let target = parent.join(segments[segments.len() - 1]);
    let note = Note {
        vault,
        history,
        rel_path,
        parent: &parent,
        author,
    };

    let current = read_current(&target, limits.max_file_bytes)?;
    let current_sha = current.as_ref().map(|current| current.sha256.clone());
    let matches = match (expected, &current_sha) {
        (Expected::Absent, None) => true,
        (Expected::Sha256(hash), Some(sha)) => hash == sha,
        _ => false,
    };
    if !matches {
        return note.conflict(content, current_sha, ConflictReason::HashMismatch);
    }
    if let (Author::Extalia { .. }, Some(current)) = (author, &current)
        && !std::str::from_utf8(&current.bytes).is_ok_and(is_managed)
    {
        return note.conflict(content, current_sha, ConflictReason::NotManaged);
    }
    let sha256 = hex_digest(content.as_bytes());
    if current_sha.as_deref() == Some(sha256.as_str()) {
        return Ok(WriteOutcome::Unchanged {
            path: rel_path.to_owned(),
            sha256,
        });
    }

    // Every version that is replaced or written is recoverable before anything changes.
    if let Some(current) = &current {
        history.store(&current.bytes, &current.sha256)?;
    }
    history.store(content.as_bytes(), &sha256)?;
    let mode = current
        .as_ref()
        .map_or(PRIVATE_FILE_MODE, |current| current.mode);
    let temp = TempFile::create(&parent, content.as_bytes(), mode)?;
    before_swap(&target);

    // Compare-and-swap: the note must still be exactly what was checked.
    check_same_dir(&root, &parent)?;
    let now = match read_current(&target, limits.max_file_bytes) {
        Ok(now) => now.map(|now| now.sha256),
        Err(WriteError::Unsafe(_) | WriteError::TooLarge) => Some(String::new()),
        Err(error) => return Err(error),
    };
    if now != current_sha {
        drop(temp);
        let now = now.filter(|sha| !sha.is_empty());
        return note.conflict(content, now, ConflictReason::ChangedDuringWrite);
    }
    if current.is_none() {
        // Must still be absent: a hard link never replaces an existing name.
        match fs::hard_link(&temp.path, &target) {
            Ok(()) => drop(temp),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                drop(temp);
                let now = read_current(&target, limits.max_file_bytes)
                    .ok()
                    .flatten()
                    .map(|now| now.sha256);
                return note.conflict(content, now, ConflictReason::ChangedDuringWrite);
            }
            Err(error) => return Err(error.into()),
        }
    } else {
        fs::rename(&temp.path, &target)?;
        temp.disarm();
    }
    sync_dir(&parent)?;

    let op = if is_rollback {
        HistoryOp::Rollback
    } else if current.is_some() {
        HistoryOp::Update
    } else {
        HistoryOp::Create
    };
    history.append(&HistoryEntry {
        at: crate::time::format_utc(crate::time::now_millis()),
        op,
        path: rel_path.to_owned(),
        previous_sha256: current_sha.clone(),
        sha256: sha256.clone(),
        author: author.label(),
        conflict_path: None,
        reason: None,
    })?;
    Ok(WriteOutcome::Written {
        path: rel_path.to_owned(),
        previous_sha256: current_sha,
        sha256,
    })
}

/// The note being written, for conflict copies.
struct Note<'a> {
    vault: &'a Vault,
    history: &'a History,
    rel_path: &'a str,
    parent: &'a Path,
    author: Author,
}

impl Note<'_> {
    /// Write the proposal next to the note under a new name; never replaces anything.
    fn conflict(
        &self,
        proposal: &str,
        current_sha256: Option<String>,
        reason: ConflictReason,
    ) -> Result<WriteOutcome, WriteError> {
        let limits = self.vault.limits();
        let text = conflict_content(proposal, self.rel_path, current_sha256.as_deref());
        if text.len() as u64 > limits.max_file_bytes {
            return Err(WriteError::TooLarge);
        }
        let sha256 = hex_digest(text.as_bytes());
        let short = &hex_digest(proposal.as_bytes())[..8];
        let stamp: String = crate::time::format_utc(crate::time::now_millis())
            .chars()
            .filter(|ch| !matches!(ch, '-' | ':'))
            .collect();
        let stamp = format!("{}Z", &stamp[..15]);
        let (folder, name) = match self.rel_path.rsplit_once('/') {
            Some((folder, name)) => (Some(folder), name),
            None => (None, self.rel_path),
        };
        let (stem, extension) = name.split_at(name.len() - 3);
        let mut chosen = None;
        for attempt in 1..=MAX_CONFLICT_NAMES {
            let suffix = if attempt == 1 {
                format!(" (conflict {stamp} {short}){extension}")
            } else {
                format!(" (conflict {stamp} {short} {attempt}){extension}")
            };
            let prefix_bytes = folder.map_or(0, |folder| folder.len() + 1);
            let room = limits
                .max_path_bytes
                .checked_sub(prefix_bytes + suffix.len())
                .filter(|room| *room > 0)
                .ok_or(WriteError::InvalidPath)?;
            let mut end = stem.len().min(room);
            while !stem.is_char_boundary(end) {
                end -= 1;
            }
            if end == 0 {
                return Err(WriteError::InvalidPath);
            }
            let file_name = format!("{}{suffix}", &stem[..end]);
            let rel = match folder {
                Some(folder) => format!("{folder}/{file_name}"),
                None => file_name.clone(),
            };
            let path = self.parent.join(&file_name);
            match read_current(&path, limits.max_file_bytes) {
                Ok(Some(existing)) if existing.sha256 == sha256 => {
                    chosen = Some(rel);
                    break;
                }
                Ok(Some(_)) | Err(WriteError::Unsafe(_) | WriteError::TooLarge) => continue,
                Ok(None) => {}
                Err(error) => return Err(error),
            }
            self.history.store(text.as_bytes(), &sha256)?;
            let temp = TempFile::create(self.parent, text.as_bytes(), PRIVATE_FILE_MODE)?;
            match fs::hard_link(&temp.path, &path) {
                Ok(()) => {
                    drop(temp);
                    sync_dir(self.parent)?;
                    chosen = Some(rel);
                    break;
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
        }
        let conflict_path = chosen.ok_or(WriteError::InvalidPath)?;
        self.history.append(&HistoryEntry {
            at: crate::time::format_utc(crate::time::now_millis()),
            op: HistoryOp::Conflict,
            path: self.rel_path.to_owned(),
            previous_sha256: current_sha256.clone(),
            sha256,
            author: self.author.label(),
            conflict_path: Some(conflict_path.clone()),
            reason: Some(reason),
        })?;
        Ok(WriteOutcome::Conflict {
            current_sha256,
            conflict_path,
            reason,
        })
    }
}

/// The conflict copy's text: provenance keys first, identity keys renamed (module
/// documentation). Content without valid front matter gets a new block in front.
fn conflict_content(proposal: &str, rel_path: &str, base: Option<&str>) -> String {
    let header = format!(
        "conflict_of: \"{}\"\nconflict_base_sha256: {}\n",
        rel_path.replace('\\', "\\\\").replace('"', "\\\""),
        base.unwrap_or("none")
    );
    let lines: Vec<&str> = proposal.split_inclusive('\n').collect();
    let is_fence = |line: &str| line.trim_end_matches(['\n', '\r']) == "---";
    let closes = |line: &str| {
        matches!(
            line.trim_end_matches(['\n', '\r']).trim_end(),
            "---" | "..."
        )
    };
    let close = (frontmatter::split(proposal).is_ok()
        && lines.first().is_some_and(|l| is_fence(l)))
    .then(|| {
        lines
            .iter()
            .skip(1)
            .position(|line| closes(line))
            .map(|i| i + 1)
    })
    .flatten();
    let Some(close) = close else {
        return format!("---\n{header}---\n{proposal}");
    };
    let mut out = String::with_capacity(proposal.len() + header.len() + 64);
    out.push_str(lines[0]);
    out.push_str(&header);
    let mut dropping = false;
    for line in &lines[1..close] {
        let trimmed = line.trim();
        let continuation =
            line.starts_with([' ', '\t']) || trimmed == "-" || trimmed.starts_with("- ");
        if dropping && continuation {
            continue;
        }
        dropping = false;
        let key = (!line.starts_with([' ', '\t']))
            .then(|| line.split_once(':').map(|(key, _)| key))
            .flatten();
        match key {
            Some(key) if key.starts_with("conflict_") => dropping = true,
            Some(key) if CONFLICT_RENAMED_KEYS.contains(&key) => {
                out.push_str("conflict_");
                out.push_str(line);
            }
            _ => out.push_str(line),
        }
    }
    for line in &lines[close..] {
        out.push_str(line);
    }
    out
}

/// `managed_by: extalia` in valid front matter.
pub fn is_managed(text: &str) -> bool {
    front_matter_value(text, MANAGED_KEY).as_deref() == Some(MANAGED_VALUE)
}

/// The scalar value of a top-level key in valid front matter (other keys' values are not
/// typed by [`frontmatter`]). Quotes and a trailing ` # comment` are removed.
pub fn front_matter_value(text: &str, key: &str) -> Option<String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    frontmatter::split(text).ok()?;
    let mut lines = text.lines();
    if lines.next()? != "---" {
        return None;
    }
    for line in lines {
        if matches!(line.trim_end(), "---" | "...") {
            break;
        }
        let Some(rest) = line
            .strip_prefix(key)
            .and_then(|rest| rest.strip_prefix(':'))
        else {
            continue;
        };
        let rest = rest.trim();
        let value = if let Some(inner) = rest.strip_prefix('"') {
            inner.split_once('"').map(|(value, _)| value)?
        } else if let Some(inner) = rest.strip_prefix('\'') {
            inner.split_once('\'').map(|(value, _)| value)?
        } else {
            rest.split(" #").next().unwrap_or("").trim_end()
        };
        return Some(value.to_owned());
    }
    None
}

/// Validate a vault-relative note path with the walker's rules; returns its segments.
pub fn validate_note_path<'a>(
    rel_path: &'a str,
    limits: &VaultLimits,
) -> Result<Vec<&'a str>, WriteError> {
    if rel_path.is_empty() || rel_path.len() > limits.max_path_bytes {
        return Err(WriteError::InvalidPath);
    }
    let segments: Vec<&str> = rel_path.split('/').collect();
    let valid = segments.iter().all(|segment| {
        !segment.is_empty()
            && !segment.starts_with('.')
            && !segment.contains('\\')
            && !segment.chars().any(char::is_control)
    });
    let name = segments[segments.len() - 1];
    if !valid || !is_note_name(name) || segments.len() - 1 > limits.max_depth {
        return Err(WriteError::InvalidPath);
    }
    Ok(segments)
}

fn is_sha256(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Create (`0700`) or check each folder below the canonical root; returns the canonical
/// parent folder.
fn ensure_parent(root: &Path, folders: &[&str]) -> Result<PathBuf, WriteError> {
    let mut dir = root.to_path_buf();
    for folder in folders {
        dir.push(folder);
        match fs::symlink_metadata(&dir) {
            Ok(meta) => check_dir(&meta)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                match fs::create_dir(&dir) {
                    Ok(()) => set_mode(&dir, PRIVATE_DIRECTORY_MODE)?,
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error.into()),
                }
                check_dir(&fs::symlink_metadata(&dir)?)?;
            }
            Err(error) => return Err(error.into()),
        }
    }
    let canonical = fs::canonicalize(&dir)?;
    if !canonical.starts_with(root) {
        return Err(WriteError::Unsafe(SkipReason::Symlink));
    }
    Ok(canonical)
}

fn check_same_dir(root: &Path, parent: &Path) -> Result<(), WriteError> {
    check_dir(&fs::symlink_metadata(parent)?)?;
    if fs::canonicalize(parent)? != parent || !parent.starts_with(root) {
        return Err(WriteError::Unsafe(SkipReason::Symlink));
    }
    Ok(())
}

fn check_dir(meta: &Metadata) -> Result<(), WriteError> {
    let kind = meta.file_type();
    if kind.is_symlink() {
        Err(WriteError::Unsafe(SkipReason::Symlink))
    } else if !kind.is_dir() {
        Err(WriteError::Unsafe(SkipReason::SpecialFile))
    } else {
        Ok(())
    }
}

fn private_dir(dir: &Path) -> Result<(), WriteError> {
    match fs::create_dir(dir) {
        Ok(()) => set_mode(dir, PRIVATE_DIRECTORY_MODE)?,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    if !fs::symlink_metadata(dir)?.file_type().is_dir() {
        return Err(WriteError::History);
    }
    Ok(())
}

/// The note on disk, read through the inode that was checked.
struct Current {
    bytes: Vec<u8>,
    sha256: String,
    mode: u32,
}

fn read_current(path: &Path, cap: u64) -> Result<Option<Current>, WriteError> {
    for _ in 0..READ_ATTEMPTS {
        let before = match fs::symlink_metadata(path) {
            Ok(meta) => meta,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        check_regular(&before)?;
        if before.len() > cap {
            return Err(WriteError::TooLarge);
        }
        let mut file = match File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        let opened = file.metadata()?;
        if !same_file(&before, &opened) {
            continue;
        }
        check_regular(&opened)?;
        let mut bytes = Vec::new();
        (&mut file)
            .take(cap.saturating_add(1))
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > cap {
            return Err(WriteError::TooLarge);
        }
        let sha256 = hex_digest(&bytes);
        return Ok(Some(Current {
            bytes,
            sha256,
            mode: permission_bits(&opened),
        }));
    }
    Err(KnowledgeError::Changed.into())
}

fn check_regular(meta: &Metadata) -> Result<(), WriteError> {
    let kind = meta.file_type();
    if kind.is_symlink() {
        Err(WriteError::Unsafe(SkipReason::Symlink))
    } else if !kind.is_file() {
        Err(WriteError::Unsafe(SkipReason::SpecialFile))
    } else if link_count(meta) > 1 {
        Err(WriteError::Unsafe(SkipReason::HardLink))
    } else {
        Ok(())
    }
}

/// A hidden temporary file (ignored by the walker), removed on drop unless disarmed.
struct TempFile {
    path: PathBuf,
    armed: Cell<bool>,
}

impl TempFile {
    fn create(dir: &Path, bytes: &[u8], mode: u32) -> Result<Self, WriteError> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        loop {
            let path = dir.join(format!(
                ".extalia-write-{}-{}-{}.tmp",
                std::process::id(),
                crate::time::now_millis(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, mode);
            let mut file = match options.open(&path) {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            };
            let temp = Self {
                path,
                armed: Cell::new(true),
            };
            set_mode(&temp.path, mode)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            return Ok(temp);
        }
    }

    fn disarm(self) {
        self.armed.set(false);
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        if self.armed.get() {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(unix)]
fn sync_dir(dir: &Path) -> io::Result<()> {
    File::open(dir)?.sync_all()
}

/// Windows cannot open a folder for flushing; the rename is durable on NTFS commit.
#[cfg(not(unix))]
fn sync_dir(_dir: &Path) -> io::Result<()> {
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

#[cfg(unix)]
fn permission_bits(meta: &Metadata) -> u32 {
    std::os::unix::fs::PermissionsExt::mode(&meta.permissions()) & 0o777
}

#[cfg(not(unix))]
fn permission_bits(_meta: &Metadata) -> u32 {
    PRIVATE_FILE_MODE
}

#[cfg(test)]
type SwapHook = Option<Box<dyn FnOnce(&Path)>>;

#[cfg(test)]
thread_local! {
    /// Runs between writing the temporary file and the second hash (tests only).
    pub(super) static BEFORE_SWAP: std::cell::RefCell<SwapHook> = const { std::cell::RefCell::new(None) };
}

fn before_swap(_target: &Path) {
    #[cfg(test)]
    if let Some(hook) = BEFORE_SWAP.with(|hook| hook.borrow_mut().take()) {
        hook(_target);
    }
}

#[cfg(test)]
pub(super) mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::*;
    use crate::knowledge::{KnowledgeStore, ProfileScope, SyncMode};

    pub(crate) struct TempDir(pub PathBuf);

    impl TempDir {
        pub(crate) fn new() -> Self {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            loop {
                let dir = std::env::temp_dir().join(format!(
                    "extalia-knowledge-write-test-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
                match fs::create_dir(&dir) {
                    Ok(()) => return Self(dir),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(error) => panic!("cannot create a temporary directory: {error}"),
                }
            }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A data directory with a vault and history for profile `work`.
    pub(crate) struct Env {
        pub dir: TempDir,
        pub vault: Vault,
        pub history: History,
    }

    impl Env {
        pub(crate) fn new() -> Self {
            let dir = TempDir::new();
            let profile = ProfileId::parse("work").unwrap();
            let vault = Vault::open_default(&dir.0, &profile, VaultLimits::default()).unwrap();
            let history = History::open(&dir.0, &profile).unwrap();
            Self {
                dir,
                vault,
                history,
            }
        }

        pub(crate) fn root(&self) -> PathBuf {
            self.dir.0.join("vaults").join("work")
        }

        pub(crate) fn read(&self, rel: &str) -> String {
            fs::read_to_string(self.root().join(rel)).unwrap()
        }

        pub(crate) fn put(&self, rel: &str, text: &str) {
            let path = self.root().join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }

        pub(crate) fn notes(&self) -> Vec<String> {
            fn walk(dir: &Path, prefix: &str, out: &mut Vec<String>) {
                let mut entries: Vec<_> = fs::read_dir(dir).unwrap().map(|e| e.unwrap()).collect();
                entries.sort_by_key(|entry| entry.file_name());
                for entry in entries {
                    let name = entry.file_name().into_string().unwrap();
                    let rel = if prefix.is_empty() {
                        name.clone()
                    } else {
                        format!("{prefix}/{name}")
                    };
                    if entry.file_type().unwrap().is_dir() {
                        walk(&entry.path(), &rel, out);
                    } else {
                        out.push(rel);
                    }
                }
            }
            let mut out = Vec::new();
            walk(&self.root(), "", &mut out);
            out
        }

        fn write(&self, rel: &str, text: &str, expected: &Expected) -> WriteOutcome {
            write_note(
                &self.vault,
                &self.history,
                rel,
                text,
                expected,
                Author::User,
            )
            .unwrap()
        }
    }

    pub(crate) fn sha(text: &str) -> String {
        hex_digest(text.as_bytes())
    }

    const IMPORT: Author = Author::Extalia {
        component: "test-learning",
    };
    const MANAGED: &str = "---\nid: know.alpha\nmanaged_by: extalia\n---\n# Alpha\n";

    #[test]
    fn creates_and_replaces_with_matching_hash() {
        let env = Env::new();
        let first = env.write("Knowledge/Alpha.md", "# Alpha\n", &Expected::Absent);
        assert_eq!(
            first,
            WriteOutcome::Written {
                path: "Knowledge/Alpha.md".into(),
                previous_sha256: None,
                sha256: sha("# Alpha\n"),
            }
        );
        let second = env.write(
            "Knowledge/Alpha.md",
            "# Alpha v2\n",
            &Expected::Sha256(sha("# Alpha\n")),
        );
        assert!(
            matches!(second, WriteOutcome::Written { previous_sha256: Some(ref p), .. } if *p == sha("# Alpha\n"))
        );
        assert_eq!(env.read("Knowledge/Alpha.md"), "# Alpha v2\n");
        let again = env.write(
            "Knowledge/Alpha.md",
            "# Alpha v2\n",
            &Expected::Sha256(sha("# Alpha v2\n")),
        );
        assert!(matches!(again, WriteOutcome::Unchanged { .. }));
        // New notes are private; no temporary files are left behind.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(env.root().join("Knowledge/Alpha.md"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
            let dir_mode = fs::metadata(env.root().join("Knowledge"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(dir_mode & 0o777, 0o700);
        }
        assert_eq!(env.notes(), vec!["Knowledge/Alpha.md".to_owned()]);
    }

    #[test]
    fn mismatch_writes_conflict_copy_and_keeps_original() {
        let env = Env::new();
        env.put(
            "Notes/Beta.md",
            "---\nid: know.beta\naliases: [B]\n---\n# Beta (user edit)\n",
        );
        let stale = sha("---\nid: know.beta\n---\n# Beta\n");
        let proposal = "---\nid: know.beta\naliases:\n  - B\nmanaged_by: extalia\n---\n# Beta v2\n";
        let outcome = env.write("Notes/Beta.md", proposal, &Expected::Sha256(stale));
        let WriteOutcome::Conflict {
            current_sha256,
            conflict_path,
            reason,
        } = outcome
        else {
            panic!("expected a conflict");
        };
        let original = "---\nid: know.beta\naliases: [B]\n---\n# Beta (user edit)\n";
        assert_eq!(current_sha256, Some(sha(original)));
        assert_eq!(reason, ConflictReason::HashMismatch);
        assert_eq!(env.read("Notes/Beta.md"), original);
        let short = &sha(proposal)[..8];
        assert!(
            conflict_path.starts_with("Notes/Beta (conflict "),
            "{conflict_path}"
        );
        assert!(
            conflict_path.ends_with(&format!(" {short}).md")),
            "{conflict_path}"
        );
        let copy = env.read(&conflict_path);
        assert_eq!(
            copy,
            format!(
                "---\nconflict_of: \"Notes/Beta.md\"\nconflict_base_sha256: {}\nconflict_id: know.beta\nconflict_aliases:\n  - B\nconflict_managed_by: extalia\n---\n# Beta v2\n",
                sha(original)
            )
        );
        let parsed = frontmatter::split(&copy).unwrap().front_matter;
        assert_eq!(parsed.id, None);
        assert!(parsed.aliases.is_empty());
        assert!(!is_managed(&copy));
        // The same proposal again reuses the identical copy (same second) or adds a new
        // name; it never touches the original.
        let entries = env.history.entries("Notes/Beta.md").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].op, HistoryOp::Conflict);
        assert_eq!(
            entries[0].conflict_path.as_deref(),
            Some(conflict_path.as_str())
        );
        assert_eq!(entries[0].reason, Some(ConflictReason::HashMismatch));
        // Absent expected on an existing note, and a hash for a missing note, conflict too.
        let outcome = env.write("Notes/Beta.md", "# other\n", &Expected::Absent);
        assert!(matches!(
            outcome,
            WriteOutcome::Conflict {
                reason: ConflictReason::HashMismatch,
                ..
            }
        ));
        let outcome = env.write("Notes/Gone.md", "# gone\n", &Expected::Sha256(sha("x")));
        let WriteOutcome::Conflict {
            current_sha256,
            conflict_path,
            ..
        } = outcome
        else {
            panic!("expected a conflict");
        };
        assert_eq!(current_sha256, None);
        assert!(!env.root().join("Notes/Gone.md").exists());
        assert!(
            env.read(&conflict_path)
                .contains("conflict_base_sha256: none\n---\n# gone\n")
        );
    }

    #[test]
    fn concurrent_change_between_hash_and_rename_is_detected() {
        let env = Env::new();
        env.write("Gamma.md", "# Gamma\n", &Expected::Absent);
        BEFORE_SWAP.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(|target: &Path| {
                fs::write(target, "# Gamma (edited in Obsidian)\n").unwrap();
            }));
        });
        let outcome = env.write(
            "Gamma.md",
            "# Gamma v2\n",
            &Expected::Sha256(sha("# Gamma\n")),
        );
        let WriteOutcome::Conflict {
            current_sha256,
            reason,
            conflict_path,
        } = outcome
        else {
            panic!("expected a conflict");
        };
        assert_eq!(reason, ConflictReason::ChangedDuringWrite);
        assert_eq!(current_sha256, Some(sha("# Gamma (edited in Obsidian)\n")));
        assert_eq!(env.read("Gamma.md"), "# Gamma (edited in Obsidian)\n");
        assert!(env.read(&conflict_path).ends_with("---\n# Gamma v2\n"));

        // A note created by someone else while a new note is being written is kept too.
        BEFORE_SWAP.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(|target: &Path| {
                fs::write(target, "# Delta by user\n").unwrap();
            }));
        });
        let outcome = env.write("Delta.md", "# Delta\n", &Expected::Absent);
        assert!(matches!(
            outcome,
            WriteOutcome::Conflict {
                reason: ConflictReason::ChangedDuringWrite,
                ..
            }
        ));
        assert_eq!(env.read("Delta.md"), "# Delta by user\n");
        // Temporary files never remain.
        assert!(
            env.notes()
                .iter()
                .all(|path| !path.contains(".extalia-write-"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_and_hard_links_are_refused() {
        use std::os::unix::fs::symlink;
        let env = Env::new();
        let outside = env.dir.0.join("outside.md");
        fs::write(&outside, "# outside\n").unwrap();
        symlink(&outside, env.root().join("Link.md")).unwrap();
        let error = write_note(
            &env.vault,
            &env.history,
            "Link.md",
            "# x\n",
            &Expected::Sha256(sha("# outside\n")),
            Author::User,
        )
        .unwrap_err();
        assert!(matches!(error, WriteError::Unsafe(SkipReason::Symlink)));
        assert_eq!(fs::read_to_string(&outside).unwrap(), "# outside\n");

        let outside_dir = env.dir.0.join("outside-dir");
        fs::create_dir(&outside_dir).unwrap();
        symlink(&outside_dir, env.root().join("Linked")).unwrap();
        let error = write_note(
            &env.vault,
            &env.history,
            "Linked/New.md",
            "# x\n",
            &Expected::Absent,
            Author::User,
        )
        .unwrap_err();
        assert!(matches!(error, WriteError::Unsafe(SkipReason::Symlink)));
        assert_eq!(fs::read_dir(&outside_dir).unwrap().count(), 0);

        env.put("Hard.md", "# hard\n");
        fs::hard_link(env.root().join("Hard.md"), env.dir.0.join("hard-copy.md")).unwrap();
        let error = write_note(
            &env.vault,
            &env.history,
            "Hard.md",
            "# x\n",
            &Expected::Sha256(sha("# hard\n")),
            Author::User,
        )
        .unwrap_err();
        assert!(matches!(error, WriteError::Unsafe(SkipReason::HardLink)));
        assert_eq!(env.read("Hard.md"), "# hard\n");
        assert!(matches!(
            read_note(&env.vault, "Hard.md"),
            Err(WriteError::Unsafe(SkipReason::HardLink))
        ));
    }

    #[test]
    fn path_and_content_rules() {
        let env = Env::new();
        let limits = VaultLimits {
            max_depth: 2,
            max_path_bytes: 40,
            max_file_bytes: 16,
            ..VaultLimits::default()
        };
        for bad in [
            "",
            "/abs.md",
            "a//b.md",
            "./a.md",
            "../a.md",
            "a/../b.md",
            ".hidden.md",
            "a/.obsidian/b.md",
            "a\\b.md",
            "note.txt",
            ".md",
            "a/b/c/d.md",
            "tab\there.md",
            "a/",
            "ok/this-name-is-far-too-long-for-the-cap.md",
        ] {
            assert!(validate_note_path(bad, &limits).is_err(), "{bad:?}");
        }
        for good in ["a.md", "A.MD", "x/y/z.md", "Ünïcode note (1).md"] {
            assert!(validate_note_path(good, &limits).is_ok(), "{good:?}");
        }
        let big = "x".repeat(VaultLimits::default().max_file_bytes as usize + 1);
        assert!(matches!(
            write_note(
                &env.vault,
                &env.history,
                "Big.md",
                &big,
                &Expected::Absent,
                Author::User
            ),
            Err(WriteError::TooLarge)
        ));
        assert!(matches!(
            write_note(
                &env.vault,
                &env.history,
                "A.md",
                "x",
                &Expected::Sha256("ABC".into()),
                Author::User
            ),
            Err(WriteError::InvalidExpected)
        ));
        // Extalia content must be valid, for this profile, and managed.
        for (content, invalid) in [
            ("---\nid: [unterminated\n---\n", true),
            ("---\nprofile: personal\nmanaged_by: extalia\n---\n", true),
            ("# no front matter\n", false),
        ] {
            let error = write_note(
                &env.vault,
                &env.history,
                "E.md",
                content,
                &Expected::Absent,
                IMPORT,
            )
            .unwrap_err();
            if invalid {
                assert!(matches!(error, WriteError::InvalidContent), "{content}");
            } else {
                assert!(matches!(error, WriteError::NotManagedContent), "{content}");
            }
        }
        // A different profile's history is refused.
        let other = History::open(&env.dir.0, &ProfileId::parse("personal").unwrap()).unwrap();
        assert!(matches!(
            write_note(
                &env.vault,
                &other,
                "A.md",
                "x",
                &Expected::Absent,
                Author::User
            ),
            Err(WriteError::Knowledge(KnowledgeError::WrongProfile))
        ));
        assert!(env.notes().is_empty());
    }

    #[test]
    fn history_keeps_every_version_and_rollback_restores() {
        let env = Env::new();
        let v1 = "# One\n";
        let v2 = "# Two\n";
        env.write("Log.md", v1, &Expected::Absent);
        env.write("Log.md", v2, &Expected::Sha256(sha(v1)));
        // An external edit is captured as the previous version of the next write.
        env.put("Log.md", "# Two (typo fixed)\n");
        let edited = sha("# Two (typo fixed)\n");
        env.write("Log.md", "# Three\n", &Expected::Sha256(edited.clone()));
        assert_eq!(
            env.history.version(&edited).unwrap().unwrap(),
            b"# Two (typo fixed)\n"
        );
        let ops: Vec<_> = env
            .history
            .entries("Log.md")
            .unwrap()
            .iter()
            .map(|e| e.op)
            .collect();
        assert_eq!(
            ops,
            [HistoryOp::Create, HistoryOp::Update, HistoryOp::Update]
        );

        // Rollback goes through compare-and-swap: a stale expected hash conflicts.
        let stale = rollback(
            &env.vault,
            &env.history,
            "Log.md",
            &sha(v1),
            &Expected::Sha256(sha(v2)),
            Author::User,
        )
        .unwrap();
        assert!(matches!(stale, WriteOutcome::Conflict { .. }));
        assert_eq!(env.read("Log.md"), "# Three\n");
        let restored = rollback(
            &env.vault,
            &env.history,
            "Log.md",
            &sha(v1),
            &Expected::Sha256(sha("# Three\n")),
            Author::User,
        )
        .unwrap();
        assert!(matches!(restored, WriteOutcome::Written { .. }));
        assert_eq!(env.read("Log.md"), v1);
        assert_eq!(
            env.history.entries("Log.md").unwrap().last().unwrap().op,
            HistoryOp::Rollback
        );
        // Only versions from the note's own history.
        env.write("Other.md", "# other\n", &Expected::Absent);
        assert!(matches!(
            rollback(
                &env.vault,
                &env.history,
                "Log.md",
                &sha("# other\n"),
                &Expected::Sha256(sha(v1)),
                Author::User
            ),
            Err(WriteError::UnknownVersion)
        ));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let journal = env.history.dir().join(JOURNAL_FILE);
            assert_eq!(
                fs::metadata(&journal).unwrap().permissions().mode() & 0o777,
                0o600
            );
            let object = env.history.dir().join(OBJECTS_DIR).join(sha(v1));
            assert_eq!(
                fs::metadata(&object).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(env.history.dir())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
    }

    #[test]
    fn extalia_updates_only_managed_notes() {
        let env = Env::new();
        let created = write_note(
            &env.vault,
            &env.history,
            "Knowledge/Alpha.md",
            MANAGED,
            &Expected::Absent,
            IMPORT,
        )
        .unwrap();
        assert!(matches!(created, WriteOutcome::Written { .. }));
        let v2 = MANAGED.replace("# Alpha", "# Alpha v2");
        let updated = write_note(
            &env.vault,
            &env.history,
            "Knowledge/Alpha.md",
            &v2,
            &Expected::Sha256(sha(MANAGED)),
            IMPORT,
        )
        .unwrap();
        assert!(matches!(updated, WriteOutcome::Written { .. }));
        assert!(
            read_note(&env.vault, "Knowledge/Alpha.md")
                .unwrap()
                .unwrap()
                .managed
        );

        // The user takes the note over by removing the marker: Extalia may only propose.
        let user = "---\nid: know.alpha\n---\n# Alpha, mine now\n";
        let outcome = env.write("Knowledge/Alpha.md", user, &Expected::Sha256(sha(&v2)));
        assert!(matches!(outcome, WriteOutcome::Written { .. }));
        let read = read_note(&env.vault, "Knowledge/Alpha.md")
            .unwrap()
            .unwrap();
        assert!(!read.managed);
        let v3 = MANAGED.replace("# Alpha", "# Alpha v3");
        let outcome = write_note(
            &env.vault,
            &env.history,
            "Knowledge/Alpha.md",
            &v3,
            &Expected::Sha256(read.sha256),
            IMPORT,
        )
        .unwrap();
        let WriteOutcome::Conflict {
            reason,
            conflict_path,
            ..
        } = outcome
        else {
            panic!("expected a proposal");
        };
        assert_eq!(reason, ConflictReason::NotManaged);
        assert_eq!(env.read("Knowledge/Alpha.md"), user);
        assert!(env.read(&conflict_path).contains("# Alpha v3"));

        // A user note that never was managed: same rule; the user may still write it.
        env.put("Mine.md", "# mine\n");
        let outcome = write_note(
            &env.vault,
            &env.history,
            "Mine.md",
            MANAGED,
            &Expected::Sha256(sha("# mine\n")),
            IMPORT,
        )
        .unwrap();
        assert!(matches!(
            outcome,
            WriteOutcome::Conflict {
                reason: ConflictReason::NotManaged,
                ..
            }
        ));
        assert_eq!(env.read("Mine.md"), "# mine\n");
        let outcome = env.write("Mine.md", "# mine v2\n", &Expected::Sha256(sha("# mine\n")));
        assert!(matches!(outcome, WriteOutcome::Written { .. }));
    }

    #[test]
    fn indexer_sees_written_notes_and_conflict_copies() {
        let env = Env::new();
        let mut store = KnowledgeStore::open(&env.dir.0, env.vault.profile()).unwrap();
        let scope = ProfileScope::new(env.vault.profile().clone());
        let note = "---\nid: know.alpha\naliases: [First]\nmanaged_by: extalia\n---\n# Alpha\nRelated: [[Beta]]\n";
        write_note(
            &env.vault,
            &env.history,
            "Knowledge/Alpha.md",
            note,
            &Expected::Absent,
            IMPORT,
        )
        .unwrap();
        env.write("Knowledge/Beta.md", "# Beta\n", &Expected::Absent);
        let report = store.sync(&env.vault, SyncMode::Incremental).unwrap();
        assert_eq!(report.notes, 2);
        assert!(report.skipped.is_empty(), "{:?}", report.skipped);
        let alpha = store.node(&scope, "know.alpha").unwrap().unwrap();
        assert_eq!(alpha.path, "Knowledge/Alpha.md");

        let outcome = write_note(
            &env.vault,
            &env.history,
            "Knowledge/Alpha.md",
            &note.replace("# Alpha", "# Alpha v2"),
            &Expected::Sha256(sha("stale")),
            IMPORT,
        )
        .unwrap();
        let WriteOutcome::Conflict { conflict_path, .. } = outcome else {
            panic!("expected a conflict");
        };
        let report = store.sync(&env.vault, SyncMode::Incremental).unwrap();
        assert_eq!(report.notes, 3);
        assert!(report.skipped.is_empty(), "{:?}", report.skipped);
        // The original keeps its id; the copy is a separate, path-identified note.
        assert_eq!(
            store.node(&scope, "know.alpha").unwrap().unwrap().path,
            "Knowledge/Alpha.md"
        );
        let copy = store.node_by_path(&scope, &conflict_path).unwrap().unwrap();
        assert_eq!(copy.node_id, format!("path:{conflict_path}"));
        assert!(copy.aliases.is_empty());
        let rebuilt = store.sync(&env.vault, SyncMode::Rebuild).unwrap();
        assert_eq!(rebuilt.notes, 3);
    }
}
