//! Knowledge foundation, W5 slice 1 (ADR 0024 and its 2026-10-23 amendment; ADR 0027).
//!
//! Markdown in a profile's vault is the authored truth; this module derives a
//! rebuildable graph index from it (the indexer never writes a note). Slice 2b adds the
//! only write path, [`write`], and the legacy memory import, [`import`].
//!
//! - [`vault`]: the validated vault root `<data>/vaults/<profile-id>/` and the safe walker
//!   (no symbolic links, hidden names ignored, size/count caps, UTF-8 only).
//! - [`frontmatter`]: the strict front matter subset (`id`, `kind`, `profile`,
//!   `verification`, `source_task_ids`, `revision`, `aliases`, `tags`).
//! - [`links`]: the wikilink parser (aliases, headings, embeds, code excluded, typed lines).
//! - [`resolve`]: case-insensitive link resolution with deterministic disambiguation.
//! - [`store`]: the per-profile index file `<data>/profiles/<profile-id>/knowledge.sqlite`
//!   with its own migrator (not `core.sqlite`).
//! - [`index`]: full rebuild and incremental sync by file (size, mtime, SHA-256), rename
//!   detection by content hash, deletions, duplicate ids, profile ACL.
//! - [`query`]: profile-scoped reads (node, outgoing edges, backlinks, full-text search,
//!   bounded local graph, bounded whole-vault overview). A link the scope may not see looks exactly like a missing one.
//! - [`write`]: compare-and-swap note writes (atomic rename, conflict copies, no links),
//!   the revision journal `<data>/profiles/<profile-id>/knowledge-history/` and rollback.
//! - [`import`]: idempotent import of `<data>/workspaces/<id>/memory/*.md` into the vault.

pub mod frontmatter;
pub mod import;
pub mod index;
pub mod links;
pub mod query;
pub mod resolve;
pub mod store;
#[cfg(test)]
mod tests;
pub mod vault;
pub mod write;

use std::fmt;
use std::io;

pub use import::{
    ImportOutcome, ImportReport, ImportedNote, import_memory_notes, preview_memory_import,
};
pub use index::{IndexReport, Rename, Skipped, SyncMode};
pub use links::EdgeType;
pub use query::{
    EdgeView, LinkTarget, LocalGraph, NodeView, OverviewEdge, OverviewNode, OverviewNodes,
    ProfileScope, SearchHit,
};
pub use resolve::Resolution;
pub use store::KnowledgeStore;
pub use vault::{SkipReason, Vault, VaultLimits};
pub use write::{
    Author, ConflictReason, Expected, History, NoteRead, WriteError, WriteOutcome, read_note,
    rollback, write_note,
};

/// Why a knowledge operation failed. Messages are generic: no paths, note text or SQL.
#[derive(Debug)]
pub enum KnowledgeError {
    /// The index path or a sibling is not a private regular file.
    InvalidPath,
    /// Another opener holds the index lock (single writer, ADR 0019).
    Locked,
    /// Written by a newer release; left untouched (the caller may recreate it).
    NewerSchema {
        found: i64,
        supported: u32,
    },
    /// Objects differ from the expected schema of the file's version.
    SchemaMismatch,
    /// `integrity_check` or `foreign_key_check` reported a problem.
    Integrity,
    /// A required pragma did not take effect.
    Pragma(&'static str),
    /// A schema step failed and was rolled back.
    Migration {
        version: u32,
        source: rusqlite::Error,
    },
    /// The index or vault belongs to another profile.
    WrongProfile,
    /// The vault root is missing, not a real directory, or outside the data directory.
    VaultUnavailable,
    /// The vault exceeds an entry, note or byte cap; the index was not changed.
    VaultTooLarge,
    /// A note changed between the walk and its read; retry the sync.
    Changed,
    Io(io::Error),
    Sqlite(rusqlite::Error),
}

impl fmt::Display for KnowledgeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath => f.write_str("knowledge index path is not a private regular file"),
            Self::Locked => f.write_str("knowledge index is locked by another process"),
            Self::NewerSchema { found, supported } => write!(
                f,
                "knowledge index schema {found} is newer than supported {supported}"
            ),
            Self::SchemaMismatch => {
                f.write_str("knowledge index schema does not match its version")
            }
            Self::Integrity => f.write_str("knowledge index integrity check failed"),
            Self::Pragma(name) => write!(f, "knowledge index pragma {name} could not be applied"),
            Self::Migration { version, .. } => {
                write!(
                    f,
                    "knowledge index schema step {version} failed and was rolled back"
                )
            }
            Self::WrongProfile => f.write_str("knowledge index belongs to another profile"),
            Self::VaultUnavailable => f.write_str("vault root is unavailable"),
            Self::VaultTooLarge => f.write_str("vault exceeds the indexing limits"),
            Self::Changed => f.write_str("a note changed while it was indexed"),
            Self::Io(_) => f.write_str("knowledge file access failed"),
            Self::Sqlite(_) => f.write_str("knowledge index database operation failed"),
        }
    }
}

impl std::error::Error for KnowledgeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Migration { source, .. } | Self::Sqlite(source) => Some(source),
            Self::Io(source) => Some(source),
            _ => None,
        }
    }
}

impl From<io::Error> for KnowledgeError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<rusqlite::Error> for KnowledgeError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}
