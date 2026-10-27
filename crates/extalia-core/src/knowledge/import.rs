//! Import of the host's Markdown memory notes into a profile's vault, W5 slice 2b
//! (ADR 0024 §7 and its slice 2b note; ADR 0027).
//!
//! Source: `<data>/workspaces/<workspace-id>/memory/<name>.md` as written by `MemoryStore`
//! (`packages/host/src/memory.ts`): flat files, `name` matching
//! `^[a-z0-9][a-z0-9-]{0,63}$`, at most 20 000 characters, credentials masked with the
//! host's `redact` patterns, no front matter. Other files are ignored like `list()` does;
//! `*.md` files with another name, symbolic links, special files, hard-linked files,
//! oversized or non-UTF-8 files are reported as skipped. The source folder and its files
//! are only read: originals stay in place, unchanged (not even made read-only, so the host
//! keeps working until the cutover), and are never deleted.
//!
//! Target: `Projects/<workspace-id>/Memory/<name>.md`, written with [`super::write`]
//! (compare-and-swap, journal, conflict copies) as [`Author::Extalia`] `memory-import`,
//! with front matter:
//!
//! ```text
//! id: mem.<workspace-id>.<name>
//! kind: knowledge
//! profile: <profile-id>
//! scope: workspace
//! workspace_id: <workspace-id>
//! verification: unverified
//! managed_by: extalia
//! source: legacy-memory
//! source_path: workspaces/<workspace-id>/memory/<name>.md
//! source_sha256: <SHA-256 of the source bytes>
//! imported_at: <UTC timestamp>
//! masked_credentials: <count masked by this import>
//! ```
//!
//! `kind` is `knowledge` for every legacy note: memory notes are durable facts (the
//! `memory_*` tools declare `kind: 'knowledge'`), and an `experience` (PRD L1) needs task
//! evidence, outcome and timestamps that legacy notes do not carry. ADR 0024 §7 proposed
//! `kind: memory`, which is not in the PRD taxonomy; `source: legacy-memory` keeps the
//! notes identifiable. `source_path` is a label relative to the data directory, never an
//! absolute path. Imported notes are untrusted agent output (ADR 0027): `verification`
//! only mirrors the evidence store.
//!
//! Masking: the body is passed through [`mask_credentials`], a port of the host's
//! `redact` patterns, as a safety net for files edited outside Extalia. Values already
//! masked (`[redacted]`) stay masked; the import never reads or restores an original value.
//!
//! Idempotency: a marker `<data>/profiles/<profile>/knowledge-history/memory-import.json`
//! (`0600`) records per source note the source digest, the vault path and the digest of
//! the version the import wrote. A rerun:
//!
//! - unchanged source digest → `unchanged` (whatever the user did to the vault note);
//! - changed source, vault note still exactly what the import wrote → a new revision via
//!   compare-and-swap (`updated`; the old version stays in the journal);
//! - changed source, vault note edited or no longer managed → a conflict copy
//!   (`conflict`), recorded so the same source does not produce another copy
//!   (`pending_conflict`);
//! - vault note removed or moved by the user after an import → `missing_in_vault`, never
//!   recreated;
//! - no marker entry but a vault note at the path: adopted when its `source_sha256` equals
//!   the source, otherwise a conflict copy.

use std::collections::BTreeMap;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;

use super::frontmatter::is_note_id;
use super::vault::{SkipReason, Vault, set_mode};
use super::write::{
    Author, Expected, History, WriteError, WriteOutcome, front_matter_value, read_note, write_note,
};
use crate::sha256::hex_digest;
use crate::skills::is_workspace_id;

/// The importing component, as written in the journal (`extalia:memory-import`).
pub const IMPORT_AUTHOR: Author = Author::Extalia {
    component: "memory-import",
};
/// `MEMORY_CONTENT_LIMIT` is 20 000 UTF-16 code units: at most 60 000 UTF-8 bytes.
pub const MAX_SOURCE_BYTES: u64 = 60_000;
pub const MARKER_FILE: &str = "memory-import.json";
const MARKER_VERSION: u64 = 1;
const REDACTED: &str = "[redacted]";

/// The vault path of an imported memory note.
pub fn memory_note_path(workspace_id: &str, name: &str) -> String {
    format!("Projects/{workspace_id}/Memory/{name}.md")
}

/// `MEMORY_NAME_PATTERN` of `packages/host/src/memory.ts`.
pub fn is_memory_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

/// What happened to one source note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImportOutcome {
    Created {
        sha256: String,
    },
    Updated {
        previous_sha256: String,
        sha256: String,
    },
    Unchanged,
    Conflict {
        conflict_path: String,
        current_sha256: Option<String>,
    },
    /// An earlier conflict copy for this source digest awaits review.
    PendingConflict,
    /// The user removed or moved the imported note; it is not recreated.
    MissingInVault,
    Skipped(SkipReason),
}

impl ImportOutcome {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Created { .. } => "created",
            Self::Updated { .. } => "updated",
            Self::Unchanged => "unchanged",
            Self::Conflict { .. } => "conflict",
            Self::PendingConflict => "pending_conflict",
            Self::MissingInVault => "missing_in_vault",
            Self::Skipped(_) => "skipped",
        }
    }
}

/// One source note in the report. Paths are labels (data-directory or vault relative).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedNote {
    /// The source file name (without `.md` when it is a valid memory name).
    pub name: String,
    pub source_path: String,
    pub vault_path: Option<String>,
    pub outcome: ImportOutcome,
    /// Credentials masked by this import (already masked values are not counted).
    pub masked: usize,
}

/// Per-note report, sorted by source file name.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportReport {
    pub notes: Vec<ImportedNote>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct MarkerEntry {
    source_sha256: String,
    vault_path: String,
    /// Digest of the version the import last wrote (`None`: it never wrote one).
    vault_sha256: Option<String>,
    /// Source digest that already produced a conflict copy.
    conflict_source_sha256: Option<String>,
    imported_at: Option<String>,
}

/// Import one workspace's memory notes into `vault` (module documentation). The profile is
/// the vault's; the caller resolves the workspace's profile (ADR 0024 decision 2).
pub fn import_memory_notes(
    source_dir: &Path,
    workspace_id: &str,
    vault: &Vault,
    history: &History,
) -> Result<ImportReport, WriteError> {
    import(source_dir, workspace_id, vault, history, false)
}

/// What [`import_memory_notes`] would do now, without writing a note, the journal or the
/// marker. A predicted conflict has an empty `conflict_path` (no copy is named before it is
/// written); `Created`/`Updated` carry the digest of the text that would be written now.
pub fn preview_memory_import(
    source_dir: &Path,
    workspace_id: &str,
    vault: &Vault,
    history: &History,
) -> Result<ImportReport, WriteError> {
    import(source_dir, workspace_id, vault, history, true)
}

fn import(
    source_dir: &Path,
    workspace_id: &str,
    vault: &Vault,
    history: &History,
    dry_run: bool,
) -> Result<ImportReport, WriteError> {
    if !is_workspace_id(workspace_id) || !is_note_id(&format!("mem.{workspace_id}.x")) {
        return Err(WriteError::InvalidPath);
    }
    let mut report = ImportReport::default();
    match fs::symlink_metadata(source_dir) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(WriteError::Unsafe(SkipReason::Symlink));
        }
        Ok(meta) if !meta.file_type().is_dir() => {
            return Err(WriteError::Unsafe(SkipReason::SpecialFile));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(report),
        Err(error) => return Err(error.into()),
    }
    let marker_path = history.dir().join(MARKER_FILE);
    let mut marker = load_marker(&marker_path)?;
    let mut names = Vec::new();
    for entry in fs::read_dir(source_dir)? {
        names.push(entry?.file_name());
    }
    names.sort();
    for os_name in names {
        let Some(file_name) = os_name.to_str() else {
            continue;
        };
        if file_name.starts_with('.') || !file_name.ends_with(".md") {
            continue;
        }
        let name = &file_name[..file_name.len() - 3];
        let source_path = format!("workspaces/{workspace_id}/memory/{file_name}");
        let mut note = ImportedNote {
            name: name.to_owned(),
            source_path: source_path.clone(),
            vault_path: None,
            outcome: ImportOutcome::Unchanged,
            masked: 0,
        };
        if !is_memory_name(name) {
            note.outcome = ImportOutcome::Skipped(SkipReason::InvalidName);
            report.notes.push(note);
            continue;
        }
        let bytes = match read_source(&source_dir.join(file_name)) {
            Ok(bytes) => bytes,
            Err(reason) => {
                note.outcome = ImportOutcome::Skipped(reason?);
                report.notes.push(note);
                continue;
            }
        };
        let source_sha = hex_digest(&bytes);
        let Ok(text) = String::from_utf8(bytes) else {
            note.outcome = ImportOutcome::Skipped(SkipReason::NotUtf8);
            report.notes.push(note);
            continue;
        };
        let vault_path = memory_note_path(workspace_id, name);
        note.vault_path = Some(vault_path.clone());
        let key = format!("{workspace_id}/{name}");
        let previous = marker.get(&key).cloned();
        if previous
            .as_ref()
            .is_some_and(|entry| entry.source_sha256 == source_sha)
        {
            report.notes.push(note);
            continue;
        }
        if previous
            .as_ref()
            .is_some_and(|entry| entry.conflict_source_sha256.as_deref() == Some(&source_sha))
        {
            note.outcome = ImportOutcome::PendingConflict;
            report.notes.push(note);
            continue;
        }
        let current = read_note(vault, &vault_path)?;
        let wrote = previous
            .as_ref()
            .and_then(|entry| entry.vault_sha256.clone());
        let expected = match (&current, &wrote) {
            (None, Some(_)) => {
                note.outcome = ImportOutcome::MissingInVault;
                report.notes.push(note);
                continue;
            }
            (None, None) => Expected::Absent,
            (Some(_), Some(wrote)) => Expected::Sha256(wrote.clone()),
            (Some(current), None) => {
                if front_matter_value(&current.text, "source_sha256").as_deref()
                    == Some(source_sha.as_str())
                {
                    marker.insert(
                        key,
                        MarkerEntry {
                            source_sha256: source_sha,
                            vault_path,
                            vault_sha256: Some(current.sha256.clone()),
                            conflict_source_sha256: None,
                            imported_at: None,
                        },
                    );
                    if !dry_run {
                        save_marker(&marker_path, &marker)?;
                    }
                    report.notes.push(note);
                    continue;
                }
                // Somebody else's note at this path: propose, never replace.
                Expected::Absent
            }
        };
        let (body, masked) = mask_credentials(text.strip_prefix('\u{feff}').unwrap_or(&text));
        note.masked = masked;
        let imported_at = crate::time::format_utc(crate::time::now_millis());
        let content = imported_content(
            workspace_id,
            name,
            vault.profile().as_str(),
            &source_path,
            &source_sha,
            &imported_at,
            masked,
            &body,
        );
        if dry_run {
            // `write_note`'s decision without writing: the expected version must be on disk
            // and, for an update, still managed.
            let sha256 = hex_digest(content.as_bytes());
            note.outcome = match (&expected, &current) {
                (Expected::Absent, None) => ImportOutcome::Created { sha256 },
                (Expected::Sha256(wrote), Some(current))
                    if *wrote == current.sha256 && current.managed =>
                {
                    ImportOutcome::Updated {
                        previous_sha256: current.sha256.clone(),
                        sha256,
                    }
                }
                _ => ImportOutcome::Conflict {
                    conflict_path: String::new(),
                    current_sha256: current.as_ref().map(|current| current.sha256.clone()),
                },
            };
            report.notes.push(note);
            continue;
        }
        let mut entry = previous.unwrap_or_default();
        entry.vault_path = vault_path.clone();
        match write_note(
            vault,
            history,
            &vault_path,
            &content,
            &expected,
            IMPORT_AUTHOR,
        )? {
            WriteOutcome::Written {
                previous_sha256,
                sha256,
                ..
            } => {
                note.outcome = match previous_sha256 {
                    Some(previous_sha256) => ImportOutcome::Updated {
                        previous_sha256,
                        sha256: sha256.clone(),
                    },
                    None => ImportOutcome::Created {
                        sha256: sha256.clone(),
                    },
                };
                entry.source_sha256 = source_sha;
                entry.vault_sha256 = Some(sha256);
                entry.conflict_source_sha256 = None;
                entry.imported_at = Some(imported_at);
            }
            WriteOutcome::Unchanged { sha256, .. } => {
                entry.source_sha256 = source_sha;
                entry.vault_sha256 = Some(sha256);
            }
            WriteOutcome::Conflict {
                current_sha256,
                conflict_path,
                ..
            } => {
                note.outcome = ImportOutcome::Conflict {
                    conflict_path,
                    current_sha256,
                };
                entry.conflict_source_sha256 = Some(source_sha);
            }
        }
        marker.insert(key, entry);
        save_marker(&marker_path, &marker)?;
        report.notes.push(note);
    }
    Ok(report)
}

#[allow(clippy::too_many_arguments)]
fn imported_content(
    workspace_id: &str,
    name: &str,
    profile: &str,
    source_path: &str,
    source_sha: &str,
    imported_at: &str,
    masked: usize,
    body: &str,
) -> String {
    let mut out = format!(
        "---\nid: mem.{workspace_id}.{name}\nkind: knowledge\nprofile: {profile}\n\
         scope: workspace\nworkspace_id: {workspace_id}\nverification: unverified\n\
         managed_by: extalia\nsource: legacy-memory\nsource_path: {source_path}\n\
         source_sha256: {source_sha}\nimported_at: \"{imported_at}\"\n\
         masked_credentials: {masked}\n---\n{body}"
    );
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// Read a source note without following links. `Err(Ok(reason))` skips it.
fn read_source(path: &Path) -> Result<Vec<u8>, Result<SkipReason, WriteError>> {
    let before = fs::symlink_metadata(path).map_err(|error| Err(error.into()))?;
    let kind = before.file_type();
    if kind.is_symlink() {
        return Err(Ok(SkipReason::Symlink));
    }
    if !kind.is_file() {
        return Err(Ok(SkipReason::SpecialFile));
    }
    if link_count(&before) > 1 {
        return Err(Ok(SkipReason::HardLink));
    }
    if before.len() > MAX_SOURCE_BYTES {
        return Err(Ok(SkipReason::TooLarge));
    }
    let mut file = File::open(path).map_err(|error| Err(error.into()))?;
    let opened = file.metadata().map_err(|error| Err(error.into()))?;
    if !same_file(&before, &opened) || link_count(&opened) > 1 {
        return Err(Err(super::KnowledgeError::Changed.into()));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| Err(error.into()))?;
    if bytes.len() as u64 > MAX_SOURCE_BYTES {
        return Err(Ok(SkipReason::TooLarge));
    }
    Ok(bytes)
}

fn load_marker(path: &Path) -> Result<BTreeMap<String, MarkerEntry>, WriteError> {
    let text = match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_file() => fs::read_to_string(path)?,
        Ok(_) => return Err(WriteError::History),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(error.into()),
    };
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|_| WriteError::History)?;
    if value.get("version").and_then(serde_json::Value::as_u64) != Some(MARKER_VERSION) {
        return Err(WriteError::History);
    }
    let mut out = BTreeMap::new();
    let Some(notes) = value.get("notes").and_then(serde_json::Value::as_object) else {
        return Err(WriteError::History);
    };
    for (key, entry) in notes {
        let text = |field: &str| {
            entry
                .get(field)
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        };
        let (Some(source_sha256), Some(vault_path)) = (text("source_sha256"), text("vault_path"))
        else {
            return Err(WriteError::History);
        };
        out.insert(
            key.clone(),
            MarkerEntry {
                source_sha256,
                vault_path,
                vault_sha256: text("vault_sha256"),
                conflict_source_sha256: text("conflict_source_sha256"),
                imported_at: text("imported_at"),
            },
        );
    }
    Ok(out)
}

/// Replace the marker atomically (temporary file, `fsync`, rename), private `0600`.
fn save_marker(path: &Path, marker: &BTreeMap<String, MarkerEntry>) -> Result<(), WriteError> {
    let notes: serde_json::Map<String, serde_json::Value> = marker
        .iter()
        .map(|(key, entry)| {
            (
                key.clone(),
                serde_json::json!({
                    "source_sha256": entry.source_sha256,
                    "vault_path": entry.vault_path,
                    "vault_sha256": entry.vault_sha256,
                    "conflict_source_sha256": entry.conflict_source_sha256,
                    "imported_at": entry.imported_at,
                }),
            )
        })
        .collect();
    let text = serde_json::json!({ "version": MARKER_VERSION, "notes": notes }).to_string();
    let temp = path.with_extension("json.tmp");
    match fs::symlink_metadata(&temp) {
        Ok(meta) if meta.file_type().is_file() => fs::remove_file(&temp)?,
        Ok(_) => return Err(WriteError::History),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(&temp)?;
    set_mode(&temp, 0o600)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()?;
    if let Ok(meta) = fs::symlink_metadata(path)
        && !meta.file_type().is_file()
    {
        return Err(WriteError::History);
    }
    fs::rename(&temp, path)?;
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

// ---------------------------------------------------------------------------------------
// Credential masking: a port of `redact` in `packages/core/src/privacy.ts` (same patterns,
// same order, same replacement text). Pattern-based detection is a safety net, not a
// guarantee.

/// Mask likely credentials; returns the text and how many values were newly masked.
pub fn mask_credentials(input: &str) -> (String, usize) {
    let mut count = 0;
    let mut text = replace_all(input, &mut count, url_credentials);
    let passes: [Matcher; 9] = [
        private_key,
        prefixed_key,
        github_token,
        slack_token,
        aws_key,
        google_key,
        jwt,
        bearer,
        assignment,
    ];
    for pass in passes {
        text = replace_all(&text, &mut count, pass);
    }
    (text, count)
}

/// A match at byte `start`: `(end, kept_prefix_end)`; `[start, kept)` is kept and
/// `[kept, end)` becomes `[redacted]`.
type Matcher = fn(&str, usize) -> Option<(usize, usize)>;

fn replace_all(text: &str, count: &mut usize, matcher: Matcher) -> String {
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < text.len() {
        if let Some((end, kept)) = matcher(text, index) {
            out.push_str(&text[index..kept]);
            out.push_str(REDACTED);
            if &text[kept..end] != REDACTED {
                *count += 1;
            }
            index = end;
            continue;
        }
        let ch = text[index..].chars().next().unwrap_or('\0');
        out.push(ch);
        index += ch.len_utf8().max(1);
    }
    out
}

fn is_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// `\b` before a word character at `index`.
fn word_start(text: &str, index: usize) -> bool {
    index == 0 || !is_word(text.as_bytes()[index - 1])
}

/// End of the longest run of ASCII bytes matching `class` from `index`.
fn run(text: &str, index: usize, class: impl Fn(u8) -> bool) -> usize {
    let bytes = text.as_bytes();
    let mut end = index;
    while end < bytes.len() && class(bytes[end]) {
        end += 1;
    }
    end
}

/// End of the longest run of characters matching `class` from `index`.
fn char_run(text: &str, index: usize, class: impl Fn(char) -> bool) -> usize {
    let mut end = index;
    for ch in text[index..].chars() {
        if !class(ch) {
            break;
        }
        end += ch.len_utf8();
    }
    end
}

/// JavaScript `\s`.
fn is_js_space(ch: char) -> bool {
    ch.is_whitespace() || ch == '\u{feff}'
}

fn starts_with_ignore_case(text: &str, index: usize, prefix: &str) -> bool {
    text.as_bytes()
        .get(index..index + prefix.len())
        .is_some_and(|slice| slice.eq_ignore_ascii_case(prefix.as_bytes()))
}

fn token_class(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
}

/// `\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@` (case-insensitive) → `$1[redacted]@`.
fn url_credentials(text: &str, index: usize) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    if !bytes[index].is_ascii_alphabetic() || !word_start(text, index) {
        return None;
    }
    let scheme_end = run(text, index + 1, |byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'-')
    });
    if !text[scheme_end..].starts_with("://") {
        return None;
    }
    let kept = scheme_end + 3;
    let user_end = char_run(text, kept, |ch| {
        !matches!(ch, '/' | ':' | '@') && !is_js_space(ch)
    });
    if user_end == kept || bytes.get(user_end) != Some(&b':') {
        return None;
    }
    let pass_end = char_run(text, user_end + 1, |ch| {
        !matches!(ch, '/' | '@') && !is_js_space(ch)
    });
    if pass_end == user_end + 1 || bytes.get(pass_end) != Some(&b'@') {
        return None;
    }
    // `$1[redacted]@`: the `@` is part of the match and written back after the mask.
    Some((pass_end, kept))
}

/// `-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`.
fn private_key(text: &str, index: usize) -> Option<(usize, usize)> {
    fn armor(text: &str, index: usize, word: &str) -> Option<usize> {
        let rest = text
            .get(index..)?
            .strip_prefix("-----")?
            .strip_prefix(word)?;
        let start = text.len() - rest.len();
        let end = run(text, start, |byte| {
            byte.is_ascii_uppercase() || byte == b' '
        });
        (text[start..end].ends_with("PRIVATE KEY") && text[end..].starts_with("-----"))
            .then_some(end + 5)
    }
    let mut search = armor(text, index, "BEGIN ")?;
    while let Some(offset) = text[search..].find("-----END ") {
        let at = search + offset;
        if let Some(end) = armor(text, at, "END ") {
            return Some((end, index));
        }
        search = at + 1;
    }
    None
}

/// `\b(?:sk|pk|rk)-(?:proj-|live-|test-|ant-)?[A-Za-z0-9_-]{16,}`.
fn prefixed_key(text: &str, index: usize) -> Option<(usize, usize)> {
    let rest = text.get(index..)?;
    if !(rest.starts_with("sk-") || rest.starts_with("pk-") || rest.starts_with("rk-"))
        || !word_start(text, index)
    {
        return None;
    }
    let end = run(text, index + 3, token_class);
    (end - (index + 3) >= 16).then_some((end, index))
}

/// `\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}`.
fn github_token(text: &str, index: usize) -> Option<(usize, usize)> {
    if !word_start(text, index) {
        return None;
    }
    let bytes = text.as_bytes();
    if bytes.get(index..index + 2) == Some(b"gh")
        && bytes
            .get(index + 2)
            .is_some_and(|byte| b"pousr".contains(byte))
        && bytes.get(index + 3) == Some(&b'_')
    {
        let end = run(text, index + 4, |byte| byte.is_ascii_alphanumeric());
        if end - (index + 4) >= 20 {
            return Some((end, index));
        }
    }
    if text[index..].starts_with("github_pat_") {
        let start = index + "github_pat_".len();
        let end = run(text, start, |byte| {
            byte.is_ascii_alphanumeric() || byte == b'_'
        });
        if end - start >= 20 {
            return Some((end, index));
        }
    }
    None
}

/// `\bxox[abprs]-[A-Za-z0-9-]{10,}`.
fn slack_token(text: &str, index: usize) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    if !text[index..].starts_with("xox")
        || !bytes
            .get(index + 3)
            .is_some_and(|byte| b"abprs".contains(byte))
        || bytes.get(index + 4) != Some(&b'-')
        || !word_start(text, index)
    {
        return None;
    }
    let end = run(text, index + 5, |byte| {
        byte.is_ascii_alphanumeric() || byte == b'-'
    });
    (end - (index + 5) >= 10).then_some((end, index))
}

/// `\bAKIA[0-9A-Z]{16}\b`.
fn aws_key(text: &str, index: usize) -> Option<(usize, usize)> {
    if !text[index..].starts_with("AKIA") || !word_start(text, index) {
        return None;
    }
    let start = index + 4;
    let end = start + 16;
    let bytes = text.as_bytes();
    let body = bytes.get(start..end)?;
    (body
        .iter()
        .all(|byte| byte.is_ascii_digit() || byte.is_ascii_uppercase())
        && !bytes.get(end).is_some_and(|byte| is_word(*byte)))
    .then_some((end, index))
}

/// `\bAIza[0-9A-Za-z_-]{30,}`.
fn google_key(text: &str, index: usize) -> Option<(usize, usize)> {
    if !text[index..].starts_with("AIza") || !word_start(text, index) {
        return None;
    }
    let end = run(text, index + 4, token_class);
    (end - (index + 4) >= 30).then_some((end, index))
}

/// `\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}`.
fn jwt(text: &str, index: usize) -> Option<(usize, usize)> {
    if !text[index..].starts_with("eyJ") || !word_start(text, index) {
        return None;
    }
    let bytes = text.as_bytes();
    let first = run(text, index + 3, token_class);
    if first - (index + 3) < 10 || bytes.get(first) != Some(&b'.') {
        return None;
    }
    let second = run(text, first + 1, token_class);
    if second - (first + 1) < 10 || bytes.get(second) != Some(&b'.') {
        return None;
    }
    let third = run(text, second + 1, token_class);
    (third - (second + 1) >= 8).then_some((third, index))
}

/// `\bbearer\s+[A-Za-z0-9._~+/=-]{16,}` (case-insensitive).
fn bearer(text: &str, index: usize) -> Option<(usize, usize)> {
    if !starts_with_ignore_case(text, index, "bearer") || !word_start(text, index) {
        return None;
    }
    let spaces = char_run(text, index + 6, is_js_space);
    if spaces == index + 6 {
        return None;
    }
    let end = run(text, spaces, |byte| {
        byte.is_ascii_alphanumeric() || b"._~+/=-".contains(&byte)
    });
    (end - spaces >= 16).then_some((end, index))
}

/// `(?<![A-Za-z0-9])((?:api[_-]?key|secret|token|passwd|password|client[_-]?secret|
/// access[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;}{]{6,}` (case-insensitive) → `$1[redacted]`.
fn assignment(text: &str, index: usize) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    if index > 0 && bytes[index - 1].is_ascii_alphanumeric() {
        return None;
    }
    let keyword = |prefix: &str, suffix: &str| -> Option<usize> {
        if !starts_with_ignore_case(text, index, prefix) {
            return None;
        }
        let mut at = index + prefix.len();
        if suffix.is_empty() {
            return Some(at);
        }
        if matches!(bytes.get(at), Some(b'_' | b'-'))
            && starts_with_ignore_case(text, at + 1, suffix)
        {
            return Some(at + 1 + suffix.len());
        }
        starts_with_ignore_case(text, at, suffix).then(|| {
            at += suffix.len();
            at
        })
    };
    let mut at = keyword("api", "key")
        .or_else(|| keyword("secret", ""))
        .or_else(|| keyword("token", ""))
        .or_else(|| keyword("passwd", ""))
        .or_else(|| keyword("password", ""))
        .or_else(|| keyword("client", "secret"))
        .or_else(|| keyword("access", "key"))?;
    if matches!(bytes.get(at), Some(b'"' | b'\'')) {
        at += 1;
    }
    at = char_run(text, at, is_js_space);
    if !matches!(bytes.get(at), Some(b':' | b'=')) {
        return None;
    }
    at = char_run(text, at + 1, is_js_space);
    if matches!(bytes.get(at), Some(b'"' | b'\'')) {
        at += 1;
    }
    let end = char_run(text, at, |ch| {
        !is_js_space(ch) && !matches!(ch, '"' | '\'' | ',' | ';' | '}' | '{')
    });
    (text[at..end].chars().count() >= 6).then_some((end, at))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::write::tests::{Env, sha};
    use crate::knowledge::write::{ConflictReason, HistoryOp};
    use crate::knowledge::{KnowledgeStore, ProfileScope, SyncMode, frontmatter};

    const WS: &str = "w_mabc1234deadbeef";

    struct Source {
        dir: std::path::PathBuf,
    }

    impl Source {
        fn new(env: &Env) -> Self {
            let dir = env.dir.0.join("workspaces").join(WS).join("memory");
            fs::create_dir_all(&dir).unwrap();
            Self { dir }
        }

        fn put(&self, name: &str, text: &str) {
            fs::write(self.dir.join(name), text).unwrap();
        }

        fn snapshot(&self) -> Vec<(String, Vec<u8>, std::time::SystemTime)> {
            let mut out: Vec<_> = fs::read_dir(&self.dir)
                .unwrap()
                .map(|entry| {
                    let entry = entry.unwrap();
                    let meta = fs::symlink_metadata(entry.path()).unwrap();
                    let bytes = if meta.file_type().is_file() {
                        fs::read(entry.path()).unwrap()
                    } else {
                        Vec::new()
                    };
                    (
                        entry.file_name().into_string().unwrap(),
                        bytes,
                        meta.modified().unwrap(),
                    )
                })
                .collect();
            out.sort();
            out
        }
    }

    fn import(env: &Env, source: &Source) -> ImportReport {
        import_memory_notes(&source.dir, WS, &env.vault, &env.history).unwrap()
    }

    fn outcomes(report: &ImportReport) -> Vec<(String, &'static str)> {
        report
            .notes
            .iter()
            .map(|note| (note.name.clone(), note.outcome.as_str()))
            .collect()
    }

    #[test]
    fn masking_matches_the_host_patterns() {
        // Expected outputs produced by `redact` of `packages/core/src/privacy.ts`.
        let cases = [
            ("key sk-abcdefghijklmnop1234 end", "key [redacted] end"), // extalia-allow-secret
            (
                "sk-proj-abcdefghijk short sk-short",
                "[redacted] short sk-short",
            ),
            ("xsk-abcdefghijklmnop1234", "xsk-abcdefghijklmnop1234"),
            (
                "ghp_abcdefghijklmnopqrstuvwxyz and github_pat_ABCDEFGHIJ_klmnopqrstu", // extalia-allow-secret
                "[redacted] and [redacted]",
            ),
            ("xoxb-1234567890-abc", "[redacted]"), // extalia-allow-secret
            (
                "AKIAABCDEFGHIJKLMNOP AKIAABCDEFGHIJKLMNOPQ", // extalia-allow-secret
                "[redacted] AKIAABCDEFGHIJKLMNOPQ",
            ),
            ("AIzaSyA1234567890abcdefghijklmnopqrstu", "[redacted]"), // extalia-allow-secret
            (
                "jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdefghij", // extalia-allow-secret
                "jwt [redacted]",
            ),
            (
                "Authorization: Bearer abcdefghijklmnop.qrs",
                "Authorization: [redacted]",
            ),
            (
                "api_key=supersecretvalue, password: \"hunter22\" token='abc'",
                "api_key=[redacted], password: \"[redacted]\" token='abc'",
            ),
            (
                "API-KEY = longvalue123; client_secret:xyzxyzxyz",
                "API-KEY = [redacted]; client_secret:[redacted]",
            ),
            (
                "mytoken=abcdefgh xtoken=abcdefgh",
                "mytoken=abcdefgh xtoken=abcdefgh",
            ),
            (
                "https://user:pa55word@example.com/path and ftp://a:b@host",
                "https://[redacted]@example.com/path and ftp://[redacted]@host",
            ),
            (
                "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY----- after", // extalia-allow-secret
                "[redacted] after",
            ),
            (
                "api_key=[redacted] and [redacted]",
                "api_key=[redacted] and [redacted]",
            ),
            ("secret: café-secret-value end", "secret: [redacted] end"),
            ("password=ab\u{a0}cdefgh", "password=ab\u{a0}cdefgh"),
        ];
        for (input, expected) in cases {
            assert_eq!(mask_credentials(input).0, expected, "{input:?}");
        }
        // Already masked values are kept and not counted again.
        assert_eq!(mask_credentials("api_key=[redacted] x").1, 0);
        assert_eq!(
            mask_credentials("token=abcdefgh and sk-abcdefghijklmnop1234").1, // extalia-allow-secret
            2
        );
    }

    #[test]
    fn imports_with_front_matter_and_provenance_and_keeps_originals() {
        let env = Env::new();
        let source = Source::new(&env);
        source.put("build-commands.md", "# Build\nRun `pnpm check`.\n");
        source.put(
            "api-setup.md",
            "# API\napi_key=[redacted]\nNew: token=abcdef123456\n",
        );
        source.put("Bad_Name.md", "# ignored\n");
        source.put("notes.txt", "not a note");
        let before = source.snapshot();
        let report = import(&env, &source);
        assert_eq!(
            outcomes(&report),
            [
                ("Bad_Name".to_owned(), "skipped"),
                ("api-setup".to_owned(), "created"),
                ("build-commands".to_owned(), "created"),
            ]
        );
        assert_eq!(
            report.notes[0].outcome,
            ImportOutcome::Skipped(SkipReason::InvalidName)
        );
        assert_eq!(source.snapshot(), before, "originals must stay untouched");

        let path = memory_note_path(WS, "build-commands");
        assert_eq!(path, format!("Projects/{WS}/Memory/build-commands.md"));
        let text = env.read(&path);
        let split = frontmatter::split(&text).unwrap();
        let fm = split.front_matter;
        assert_eq!(
            fm.id.as_deref(),
            Some(format!("mem.{WS}.build-commands").as_str())
        );
        assert_eq!(fm.kind.as_deref(), Some("knowledge"));
        assert_eq!(fm.profile.as_ref().map(|p| p.as_str()), Some("work"));
        assert_eq!(fm.verification.as_deref(), Some("unverified"));
        assert_eq!(split.body, "# Build\nRun `pnpm check`.\n");
        let source_sha = sha("# Build\nRun `pnpm check`.\n");
        assert_eq!(front_matter_value(&text, "source_sha256"), Some(source_sha));
        assert_eq!(
            front_matter_value(&text, "source_path").as_deref(),
            Some(format!("workspaces/{WS}/memory/build-commands.md").as_str())
        );
        assert_eq!(
            front_matter_value(&text, "source").as_deref(),
            Some("legacy-memory")
        );
        assert_eq!(
            front_matter_value(&text, "scope").as_deref(),
            Some("workspace")
        );
        assert!(
            crate::time::parse_utc(&front_matter_value(&text, "imported_at").unwrap()).is_some()
        );
        assert!(super::super::write::is_managed(&text));
        let entries = env.history.entries(&path).unwrap();
        assert_eq!(entries[0].author, "extalia:memory-import");

        // Masked values stay masked; a raw credential edited into the source is masked.
        let api = env.read(&memory_note_path(WS, "api-setup"));
        assert!(
            api.contains("api_key=[redacted]\nNew: token=[redacted]\n"),
            "{api}"
        );
        assert!(!api.contains("abcdef123456"));
        assert_eq!(report.notes[1].masked, 1);
        assert_eq!(
            front_matter_value(&api, "masked_credentials").as_deref(),
            Some("1")
        );
        // Nothing Extalia stored keeps the raw value.
        for entry in fs::read_dir(env.history.dir().join("objects")).unwrap() {
            let bytes = fs::read(entry.unwrap().path()).unwrap();
            assert!(!String::from_utf8_lossy(&bytes).contains("abcdef123456"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let marker = env.history.dir().join(MARKER_FILE);
            assert_eq!(
                fs::metadata(marker).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn rerun_is_idempotent_and_changes_become_revisions_or_conflicts() {
        let env = Env::new();
        let source = Source::new(&env);
        source.put("prefs.md", "# Prefs\nTabs.\n");
        source.put("setup.md", "# Setup\n");
        source.put("gone.md", "# Gone\n");
        import(&env, &source);
        let notes_before = env.notes();

        let report = import(&env, &source);
        assert!(
            report
                .notes
                .iter()
                .all(|note| note.outcome == ImportOutcome::Unchanged)
        );
        assert_eq!(env.notes(), notes_before, "a rerun must not duplicate");

        // Changed source, untouched vault note → a new revision through compare-and-swap.
        let prefs = memory_note_path(WS, "prefs");
        let first_sha = sha(&env.read(&prefs));
        source.put("prefs.md", "# Prefs\nSpaces.\n");
        // Changed source, user-edited vault note → conflict copy, the user's edit is kept.
        let setup = memory_note_path(WS, "setup");
        let edited = env.read(&setup).replace("# Setup", "# Setup (my edit)");
        fs::write(env.root().join(&setup), &edited).unwrap();
        source.put("setup.md", "# Setup v2\n");
        // Removed from the vault by the user → not recreated.
        let gone = memory_note_path(WS, "gone");
        fs::rename(env.root().join(&gone), env.root().join("Moved.md")).unwrap();
        source.put("gone.md", "# Gone v2\n");

        let report = import(&env, &source);
        assert_eq!(
            outcomes(&report),
            [
                ("gone".to_owned(), "missing_in_vault"),
                ("prefs".to_owned(), "updated"),
                ("setup".to_owned(), "conflict"),
            ]
        );
        let ImportOutcome::Updated {
            previous_sha256, ..
        } = &report.notes[1].outcome
        else {
            panic!("expected an update");
        };
        assert_eq!(previous_sha256, &first_sha);
        assert!(env.read(&prefs).ends_with("---\n# Prefs\nSpaces.\n"));
        assert!(
            env.history.version(&first_sha).unwrap().is_some(),
            "old revision kept"
        );
        assert_eq!(env.read(&setup), edited);
        let ImportOutcome::Conflict { conflict_path, .. } = &report.notes[2].outcome else {
            panic!("expected a conflict");
        };
        assert!(env.read(conflict_path).ends_with("# Setup v2\n"));
        let last = env.history.entries(&setup).unwrap().pop().unwrap();
        assert_eq!(last.op, HistoryOp::Conflict);
        assert_eq!(last.reason, Some(ConflictReason::HashMismatch));
        assert!(!env.root().join(&gone).exists());

        // Same sources again: nothing new, no second conflict copy.
        let notes_now = env.notes();
        let report = import(&env, &source);
        assert_eq!(
            outcomes(&report),
            [
                ("gone".to_owned(), "missing_in_vault"),
                ("prefs".to_owned(), "unchanged"),
                ("setup".to_owned(), "pending_conflict"),
            ]
        );
        assert_eq!(env.notes(), notes_now);
    }

    #[test]
    fn preview_predicts_the_import_and_writes_nothing() {
        let env = Env::new();
        let source = Source::new(&env);
        let preview = |env: &Env, source: &Source| {
            preview_memory_import(&source.dir, WS, &env.vault, &env.history).unwrap()
        };
        let journal = env.history.dir().join("journal.jsonl");
        let marker = env.history.dir().join(MARKER_FILE);
        source.put("prefs.md", "# Prefs\nkey sk-abcdefghijklmnop1234\n"); // extalia-allow-secret
        source.put("setup.md", "# Setup\n");
        let report = preview(&env, &source);
        assert_eq!(
            outcomes(&report),
            [
                ("prefs".to_owned(), "created"),
                ("setup".to_owned(), "created")
            ]
        );
        assert_eq!(report.notes[0].masked, 1);
        assert!(env.notes().is_empty() && !journal.exists() && !marker.exists());

        import(&env, &source);
        let notes = env.notes();
        let journal_text = fs::read_to_string(&journal).unwrap();
        let marker_text = fs::read_to_string(&marker).unwrap();
        source.put("prefs.md", "# Prefs v2\n");
        let setup = memory_note_path(WS, "setup");
        let edited = env.read(&setup).replace("# Setup", "# Mine");
        fs::write(env.root().join(&setup), &edited).unwrap();
        source.put("setup.md", "# Setup v2\n");
        let report = preview(&env, &source);
        assert_eq!(
            outcomes(&report),
            [
                ("prefs".to_owned(), "updated"),
                ("setup".to_owned(), "conflict")
            ]
        );
        let ImportOutcome::Conflict {
            conflict_path,
            current_sha256,
        } = &report.notes[1].outcome
        else {
            panic!("expected a predicted conflict");
        };
        assert!(conflict_path.is_empty());
        assert_eq!(current_sha256.as_deref(), Some(sha(&edited).as_str()));
        assert_eq!(env.notes(), notes);
        assert_eq!(fs::read_to_string(&journal).unwrap(), journal_text);
        assert_eq!(fs::read_to_string(&marker).unwrap(), marker_text);
        // The real import then does what the preview said.
        assert_eq!(outcomes(&import(&env, &source)), outcomes(&report));
    }

    #[test]
    fn existing_note_without_marker_is_adopted_or_left_alone() {
        let env = Env::new();
        let source = Source::new(&env);
        source.put("alpha.md", "# Alpha\n");
        source.put("beta.md", "# Beta\n");
        import(&env, &source);
        // The marker is lost: an identical import is adopted.
        fs::remove_file(env.history.dir().join(MARKER_FILE)).unwrap();
        // A user note already sits where another import would go.
        let beta = memory_note_path(WS, "beta");
        fs::write(env.root().join(&beta), "# Beta, written by hand\n").unwrap();
        let report = import(&env, &source);
        assert_eq!(
            outcomes(&report),
            [
                ("alpha".to_owned(), "unchanged"),
                ("beta".to_owned(), "conflict")
            ]
        );
        assert_eq!(env.read(&beta), "# Beta, written by hand\n");
    }

    #[cfg(unix)]
    #[test]
    fn unsafe_sources_are_skipped() {
        use std::os::unix::fs::symlink;
        let env = Env::new();
        let source = Source::new(&env);
        let outside = env.dir.0.join("outside.md");
        fs::write(&outside, "# secret outside\n").unwrap();
        symlink(&outside, source.dir.join("linked.md")).unwrap();
        source.put("hard.md", "# hard\n");
        fs::hard_link(source.dir.join("hard.md"), env.dir.0.join("hard-copy.md")).unwrap();
        source.put("big.md", &"x".repeat(MAX_SOURCE_BYTES as usize + 1));
        fs::write(source.dir.join("binary.md"), [0xff, 0xfe, 0x00]).unwrap();
        let report = import(&env, &source);
        let reasons: Vec<_> = report
            .notes
            .iter()
            .map(|note| (note.name.as_str(), note.outcome.clone()))
            .collect();
        assert_eq!(
            reasons,
            [
                ("big", ImportOutcome::Skipped(SkipReason::TooLarge)),
                ("binary", ImportOutcome::Skipped(SkipReason::NotUtf8)),
                ("hard", ImportOutcome::Skipped(SkipReason::HardLink)),
                ("linked", ImportOutcome::Skipped(SkipReason::Symlink)),
            ]
        );
        assert!(env.notes().is_empty());
        // A missing source folder is an empty import; a bad workspace id is refused.
        let missing =
            import_memory_notes(&env.dir.0.join("nope"), WS, &env.vault, &env.history).unwrap();
        assert!(missing.notes.is_empty());
        assert!(matches!(
            import_memory_notes(&source.dir, "../etc", &env.vault, &env.history),
            Err(WriteError::InvalidPath)
        ));
    }

    #[test]
    fn imported_notes_are_indexed() {
        let env = Env::new();
        let source = Source::new(&env);
        source.put("build-commands.md", "# Build commands\nSee [[deploy]].\n");
        source.put("deploy.md", "# Deploy\n");
        import(&env, &source);
        let mut store = KnowledgeStore::open(&env.dir.0, env.vault.profile()).unwrap();
        let report = store.sync(&env.vault, SyncMode::Incremental).unwrap();
        assert_eq!(report.notes, 2);
        assert!(report.skipped.is_empty(), "{:?}", report.skipped);
        let scope = ProfileScope::new(env.vault.profile().clone());
        let node = store
            .node(&scope, &format!("mem.{WS}.build-commands"))
            .unwrap()
            .unwrap();
        assert_eq!(node.kind, "knowledge");
        assert_eq!(node.trust_status, "untrusted");
        assert_eq!(node.declared_verification.as_deref(), Some("unverified"));
        assert_eq!(report.unresolved_links, 0);
    }
}
