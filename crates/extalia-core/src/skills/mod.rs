//! Secure skill registry, W3 slice 1 (ADR 0025; ADRs 0023, 0024, 0026).
//!
//! - [`tree`] stages a package directory into the per-profile quarantine object store
//!   (copy, never link; symlinks, special files, hard links, hidden entries and oversize
//!   packages refused) and defines the canonical tree SHA-256 that names a revision.
//! - [`manifest`] parses and validates `extalia-skill.json` (strict, unknown fields
//!   rejected) and cross-checks the `SKILL.md` front matter; it infers a manifest for a
//!   package without one.
//! - [`lifecycle`] is the single reconciled revision state machine and its transition table.
//! - [`inspect`] is the `SkillInspector` port. The only adapter in this slice,
//!   [`inspect::UnavailableInspector`], answers `scanner-unavailable`: every package stays
//!   quarantined until a verified scanner pin exists (ADR 0023).
//! - [`policy`] holds the pure decisions: verdict mapping, attestation validity, permission
//!   increase and the approval / auto-eligibility route.
//! - [`registry`] applies them to the core store: import, inspection, validation,
//!   evaluation records, approval, activation with the append-only history, rollback,
//!   revocation, deprecation, crash recovery of interrupted inspections and the verified
//!   file read used at execution time; [`views`] holds its bounded read-only queries.
//! - [`review`] records the local user's review of a `review_required` revision (accept →
//!   `validated`, reject → `quarantined`) and stores matched W0 consent as review input.
//! - [`consent`] reads the W0 `skill-consent.json` as review input only (ADR 0025 §7): a
//!   consent is matched to revisions by the `SKILL.md` SHA-256 and never changes a state.
//! - [`builtin`] is the built-in skill catalog (gap-map decision 10): packages shipped with
//!   the app, staged and content-hashed like any other, exempt from the scanner gate and
//!   registered only through this daemon-internal API, never through an import. Their
//!   registrations are recorded in `skill_builtin_registrations` (not as revisions) and
//!   re-verified against the object store when the daemon starts.
//!
//! Hash points (ADR 0025 §6): (a) the staged copy at import, (b) before and (c) after the
//! scan, (d) before an evaluation is recorded, (e) when an approval is recorded (the caller
//! passes the digest it showed), (f) inside the activation transaction, (g) when a file is
//! read for execution. A mismatch revokes the revision with reason `integrity`; nothing
//! ever falls back to the source copy.

pub mod builtin;
pub mod consent;
pub mod inspect;
pub mod lifecycle;
pub mod manifest;
pub mod policy;
pub mod registry;
pub mod review;
#[cfg(test)]
mod tests;
pub mod tree;
pub mod views;

use std::fmt;
use std::io;

pub use builtin::BuiltinCatalog;
pub use inspect::{
    InspectionOutcome, ScannerIdentity, ScannerStatus, SkillInspector, UnavailableInspector,
};
pub use lifecycle::RevisionState;
pub use registry::SkillRegistry;

/// A profile id (ADR 0024): `^[a-z0-9][a-z0-9-]{0,63}$`. It names a directory of the
/// object store, so it is validated before any path is built from it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ProfileId(String);

impl ProfileId {
    pub fn parse(text: &str) -> Option<Self> {
        is_package_name(text).then(|| Self(text.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Longest workspace id (`SKILL_WORKSPACE_ID_MAX_LENGTH`): a UUID.
pub const MAX_WORKSPACE_ID_LEN: usize = 36;

/// `HOST_WORKSPACE_ID_PATTERN` of `@extalia/protocol`, the ids the host generates
/// (`newId('w')`): `w_`, the creation time in milliseconds as 1 to 11 base-36 characters,
/// then 8 lowercase hex characters (`^w_[0-9a-z]{1,11}[0-9a-f]{8}$`). Safe as one path segment.
pub fn is_host_workspace_id(text: &str) -> bool {
    let Some(rest) = text.strip_prefix("w_") else {
        return false;
    };
    let bytes = rest.as_bytes();
    (9..=19).contains(&bytes.len())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_digit() || byte.is_ascii_lowercase())
        && bytes[bytes.len() - 8..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

/// `SKILL_WORKSPACE_ID_PATTERN`: a host workspace id, or a lowercase UUID (versions 1-8),
/// which the skill contract first required and still accepts.
pub fn is_workspace_id(text: &str) -> bool {
    is_host_workspace_id(text) || crate::mission::contract::is_uuid(text)
}

/// `SKILL_NAME_PATTERN` of `@extalia/platform`, shared by package and profile ids.
pub(crate) fn is_package_name(text: &str) -> bool {
    let bytes = text.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

/// Where an imported package came from. Every origin here passes the scanner gate.
/// Built-in skills have no variant on purpose: they ship with the app and enter only
/// through [`BuiltinCatalog::register`], so no import (and no wire request) can claim to
/// be built in (gap-map decision 10).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    User,
    Workspace,
    Imported,
    Generated,
}

impl Origin {
    pub const ALL: [Origin; 4] = [Self::User, Self::Workspace, Self::Imported, Self::Generated];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Workspace => "workspace",
            Self::Imported => "imported",
            Self::Generated => "generated",
        }
    }

    /// `builtin` (or anything else) is not an import origin.
    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|origin| origin.as_str() == text)
    }
}

/// The origin label of a built-in skill in listings; never stored in `skill_packages`
/// (built-ins are recorded in `skill_builtin_registrations`).
pub const BUILTIN_ORIGIN: &str = "builtin";

/// Why staging refused a package. Codes are stable and contain no source paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// The source is not a directory (or is itself a symbolic link).
    NotADirectory,
    Symlink,
    /// FIFO, socket, device or anything else that is not a regular file or directory.
    SpecialFile,
    /// A regular file with more than one link: it may alias a file outside the package.
    HardLink,
    /// A name outside the portable set (see [`tree`]) or not UTF-8.
    InvalidName,
    /// A name starting with `.`; hidden content is not reviewable.
    HiddenEntry,
    /// Two paths that differ only by ASCII case.
    PathCollision,
    TooDeep,
    FileTooLarge,
    PackageTooLarge,
    TooManyEntries,
    Empty,
    MissingSkillMd,
    /// The source is inside the skill store itself.
    InsideStore,
    /// The source file changed identity while it was copied.
    Changed,
}

impl Refusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotADirectory => "not_a_directory",
            Self::Symlink => "symlink",
            Self::SpecialFile => "special_file",
            Self::HardLink => "hard_link",
            Self::InvalidName => "invalid_name",
            Self::HiddenEntry => "hidden_entry",
            Self::PathCollision => "path_collision",
            Self::TooDeep => "too_deep",
            Self::FileTooLarge => "file_too_large",
            Self::PackageTooLarge => "package_too_large",
            Self::TooManyEntries => "too_many_entries",
            Self::Empty => "empty",
            Self::MissingSkillMd => "missing_skill_md",
            Self::InsideStore => "inside_store",
            Self::Changed => "changed",
        }
    }
}

/// Errors of the skill registry. Messages are generic: no paths, SQL or file contents.
#[derive(Debug)]
pub enum SkillError {
    InvalidProfile,
    /// Staging refused the package; `path` is the package-relative path when it is valid.
    Refused {
        refusal: Refusal,
        path: Option<String>,
    },
    /// The manifest or `SKILL.md` is invalid; each issue names a field.
    Manifest(Vec<String>),
    /// No such package, revision or approval in this profile.
    NotFound,
    /// The lifecycle table forbids this change.
    InvalidTransition {
        from: RevisionState,
        to: RevisionState,
    },
    /// The operation needs the revision in another state.
    WrongState(RevisionState),
    /// Stored bytes no longer match the recorded hash; the revision was revoked.
    Integrity,
    /// A policy check refused the operation; the reason code says which.
    Denied(&'static str),
    /// A stored row is inconsistent with its own constraints.
    Corrupt(&'static str),
    Io(io::Error),
    Sqlite(rusqlite::Error),
}

impl fmt::Display for SkillError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidProfile => f.write_str("invalid profile id"),
            Self::Refused { refusal, .. } => {
                write!(f, "skill package refused: {}", refusal.as_str())
            }
            Self::Manifest(issues) => write!(f, "invalid skill manifest ({} issues)", issues.len()),
            Self::NotFound => f.write_str("skill record not found"),
            Self::InvalidTransition { from, to } => write!(
                f,
                "skill revision cannot move from {} to {}",
                from.as_str(),
                to.as_str()
            ),
            Self::WrongState(state) => {
                write!(f, "skill revision is {}", state.as_str())
            }
            Self::Integrity => f.write_str("skill revision bytes changed; revision revoked"),
            Self::Denied(reason) => write!(f, "skill operation denied: {reason}"),
            Self::Corrupt(what) => write!(f, "skill store record is corrupt: {what}"),
            Self::Io(_) => f.write_str("skill store file access failed"),
            Self::Sqlite(_) => f.write_str("skill store database operation failed"),
        }
    }
}

impl std::error::Error for SkillError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(source) => Some(source),
            Self::Sqlite(source) => Some(source),
            _ => None,
        }
    }
}

impl From<io::Error> for SkillError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<rusqlite::Error> for SkillError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

pub(crate) fn refused(refusal: Refusal, path: Option<&str>) -> SkillError {
    SkillError::Refused {
        refusal,
        path: path.map(str::to_owned),
    }
}
