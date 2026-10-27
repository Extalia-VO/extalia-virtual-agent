//! Knowledge operations (W5 slices 2a and 2c; ADR 0024 and its amendment and notes, ADR 0027)
//! on the daemon's one profile: index reads and sync, and the reviewed note read, compare-and-
//! swap write, history, rollback and legacy memory import of the core's write path.
//!
//! - The index `<data>/profiles/<profile>/knowledge.sqlite` is its own file with its own
//!   lock (not `core.sqlite`) and is opened lazily by the first knowledge operation. An index
//!   that cannot be opened makes `knowledge.status` report `unavailable` with a reason and
//!   the other operations refuse with it; the daemon keeps serving. Opening is retried on
//!   the next operation (a lock held by another process may be released).
//! - `knowledge.sync` creates the default vault root `<data>/vaults/<profile>/` when it is
//!   absent and nothing was indexed yet; a root that disappears later is `vault_unavailable`
//!   (never recreated empty, ADR 0024 §5). `rebuild` discards an index that failed its schema, integrity or owner check
//!   and rebuilds it from Markdown (it is derived data).
//! - Nothing absolute leaves the daemon: paths are vault-relative and the vault root is the
//!   label `vaults/<profile>`. `knowledge.node` returns the note body after its front matter
//!   only, at most [`knowledge_limits::BODY_BYTES`] bytes, read under the walker's rules.
//! - Text the wire cannot carry is replaced by U+FFFD; an item whose id or path stays
//!   unrepresentable is left out of a list (and counted on stderr). Every result is
//!   validated against the contract and kept below the frame limit before it is sent.
//! - `knowledge.overview` is the bounded whole-vault graph: the core ranks notes and the
//!   distinct resolved links among them in SQL; nodes, then edges, stop at a byte budget.
//! - Refusals carry a stable `reason`; diagnostics go to stderr without paths or contents.
//! - Vault root: `<data>/vaults/<profile>` (label `vaults/<profile>`) or a user-chosen folder
//!   (`--vault-root`, label `custom:<folder name>`). A custom root is validated by the core
//!   (`Vault::open_custom`: existing real directory, never created, not the data directory, an
//!   ancestor of it or a folder inside it other than the profile's own default root, pinned
//!   to its canonical path) and here (not the home directory or one of its ancestors). An
//!   invalid or vanished custom root makes the vault unavailable; nothing falls back.
//! - Writes (`knowledge.write`, `knowledge.rollback`) are always by the user, with the hash of
//!   a `knowledge.read`; `knowledge.importMemory` reads only
//!   `<data>/workspaces/<workspace id>/memory/` (the host's `MemoryStore` folder). A change
//!   to the vault is followed by an incremental sync (failures are logged, the write stands).
//!   The default root is created by a write only under the first-sync rule (nothing indexed).

use std::cell::OnceCell;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use extalia_core::knowledge::frontmatter;
use extalia_core::knowledge::import::{is_memory_name, memory_note_path};
use extalia_core::knowledge::write::{HistoryEntry, HistoryOp, validate_note_path};
use extalia_core::knowledge::{
    Author, EdgeView, Expected, History, ImportOutcome, KnowledgeError, KnowledgeStore, LinkTarget,
    NodeView, OverviewNode, ProfileScope, SyncMode, Vault, VaultLimits, WriteError, WriteOutcome,
    import_memory_notes, preview_memory_import, read_note, rollback, write_note,
};
use extalia_core::skills::ProfileId;
use extalia_core::time::{format_utc, now_millis};
use serde_json::{Map, Value, json};

use crate::wire::{
    ErrorCode, KnowledgeRequest, KnowledgeSyncMode, NodeTarget, Op, ResponseResult,
    is_knowledge_history_author as is_history_author, is_knowledge_node_id, is_knowledge_path,
    knowledge_limits as limits, validate_knowledge_result,
};

/// Knowledge operations served with a data directory, advertised in the `hello` result.
pub const CAPABILITIES: [Op; 13] = [
    Op::KnowledgeStatus,
    Op::KnowledgeSync,
    Op::KnowledgeNode,
    Op::KnowledgeLinks,
    Op::KnowledgeBacklinks,
    Op::KnowledgeSearch,
    Op::KnowledgeGraph,
    Op::KnowledgeOverview,
    Op::KnowledgeRead,
    Op::KnowledgeWrite,
    Op::KnowledgeHistory,
    Op::KnowledgeRollback,
    Op::KnowledgeImportMemory,
];
/// A link page stops growing past this many JSON bytes (frames are at most 1 MiB).
pub const PAGE_BYTE_BUDGET: usize = 768 * 1024;
/// Graph nodes, then edges, stop growing past these JSON byte budgets.
pub const GRAPH_NODE_BYTE_BUDGET: usize = 512 * 1024;
pub const GRAPH_BYTE_BUDGET: usize = 896 * 1024;
/// Overview nodes, then edges, stop growing past these JSON byte budgets (each item counted
/// with its separating comma): nodes take at most ~60 % so the edges among them still fit.
pub const OVERVIEW_NODE_BYTE_BUDGET: usize = 576 * 1024;
pub const OVERVIEW_BYTE_BUDGET: usize = 928 * 1024;
/// Latest representable modification time (9999-12-31T23:59:59.999Z), in milliseconds.
const MAX_MILLIS: i64 = 253_402_300_799_999;
/// Largest result sent; the envelope adds well under 1 KiB.
pub const RESULT_BYTE_BUDGET: usize = 960 * 1024;
/// A `knowledge.read` body stops at this many JSON bytes (escaping included), below
/// [`RESULT_BYTE_BUDGET`] with room for the path and hash.
pub const READ_JSON_BUDGET: usize = 896 * 1024;
/// `knowledge.importMemory` notes stop growing past this many JSON bytes.
pub const IMPORT_BYTE_BUDGET: usize = 768 * 1024;
const SEARCH_TERMS: usize = 16;
const ELLIPSIS: char = '\u{2026}';
const REPLACEMENT: char = '\u{fffd}';

/// A refusal: wire code and stable reason.
pub type KnowledgeRefusal = (ErrorCode, Option<&'static str>);

/// The knowledge index of the daemon's profile.
pub struct Knowledge {
    data_dir: PathBuf,
    profile: ProfileId,
    limits: VaultLimits,
    store: Option<KnowledgeStore>,
    last_sync: Option<Value>,
    /// A user-chosen vault root (`--vault-root`), as configured.
    custom_root: Option<PathBuf>,
    /// The custom vault once opened: its canonical path stays pinned for this process.
    custom_vault: OnceCell<Vault>,
    /// Refused as a custom root, with its ancestors.
    home: Option<PathBuf>,
    /// Test hook run at the start of every sync ([`Knowledge::with_sync_hook`]).
    sync_hook: Option<Box<dyn Fn() + Send>>,
}

impl std::fmt::Debug for Knowledge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Knowledge")
            .field("profile", &self.profile)
            .field("open", &self.store.is_some())
            .finish()
    }
}

/// Wire code and reason of a core knowledge error.
pub fn refusal(error: &KnowledgeError) -> (ErrorCode, &'static str) {
    match error {
        KnowledgeError::Locked => (ErrorCode::StorageFailure, "index_locked"),
        KnowledgeError::NewerSchema { .. } => (ErrorCode::StorageFailure, "index_newer_schema"),
        KnowledgeError::SchemaMismatch
        | KnowledgeError::Integrity
        | KnowledgeError::WrongProfile => (ErrorCode::IntegrityFailure, "index_corrupt"),
        KnowledgeError::VaultUnavailable => (ErrorCode::StorageFailure, "vault_unavailable"),
        KnowledgeError::VaultTooLarge => (ErrorCode::CapacityExceeded, "vault_too_large"),
        KnowledgeError::Changed => (ErrorCode::Conflict, "note_changed"),
        KnowledgeError::Io(_) => (ErrorCode::StorageFailure, "io_failure"),
        KnowledgeError::InvalidPath
        | KnowledgeError::Pragma(_)
        | KnowledgeError::Migration { .. }
        | KnowledgeError::Sqlite(_) => (ErrorCode::StorageFailure, "index_unavailable"),
    }
}

fn refuse(error: KnowledgeError) -> KnowledgeRefusal {
    let (code, reason) = refusal(&error);
    eprintln!("extalia-daemon: knowledge operation refused ({error})");
    (code, Some(reason))
}

const NOT_FOUND: KnowledgeRefusal = (ErrorCode::NotFound, Some("node_not_found"));

impl Knowledge {
    /// The knowledge index of `profile` under `data_dir`, with the default vault limits.
    /// Nothing is opened or created until the first operation. `profile` must be valid.
    pub fn new(data_dir: &Path, profile: &str) -> Self {
        Self::with_limits(data_dir, profile, VaultLimits::default())
    }

    /// The same with other vault limits (tests).
    pub fn with_limits(data_dir: &Path, profile: &str, limits: VaultLimits) -> Self {
        Self {
            data_dir: data_dir.to_owned(),
            profile: ProfileId::parse(profile).expect("valid profile id"),
            limits,
            store: None,
            last_sync: None,
            custom_root: None,
            custom_vault: OnceCell::new(),
            home: std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(PathBuf::from)
                .filter(|home| home.is_absolute()),
            sync_hook: None,
        }
    }

    /// Test hook: `hook` runs on the thread serving knowledge requests at the start of every
    /// `knowledge.sync` request, before the vault is walked (for example to hold a sync in flight).
    /// No wire operation or argument reaches it.
    #[doc(hidden)]
    pub fn with_sync_hook(mut self, hook: impl Fn() + Send + 'static) -> Self {
        self.sync_hook = Some(Box::new(hook));
        self
    }

    /// Use a user-chosen vault root instead of `<data>/vaults/<profile>`. It is validated
    /// on use (never created); an invalid root leaves the vault unavailable.
    pub fn with_vault_root(mut self, root: PathBuf) -> Self {
        self.custom_root = Some(root);
        self
    }

    /// The home directory refused as a custom root (default: from the environment).
    pub fn with_home_dir(mut self, home: Option<PathBuf>) -> Self {
        self.home = home;
        self
    }

    /// The vault root as reported: never a path.
    fn vault_label(&self) -> String {
        match &self.custom_root {
            None => format!("vaults/{}", self.profile.as_str()),
            Some(root) => {
                let name = root
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let mut out = String::new();
                for character in name.chars() {
                    let character = if is_control(character) || character == '\\' {
                        REPLACEMENT
                    } else {
                        character
                    };
                    if out.encode_utf16().count() + character.len_utf16() > limits::CUSTOM_LABEL {
                        break;
                    }
                    out.push(character);
                }
                if out.is_empty() {
                    out.push(REPLACEMENT);
                }
                format!("custom:{out}")
            }
        }
    }

    /// The custom vault, opened (and pinned) on first success.
    fn custom_vault(&self, root: &Path) -> Result<Vault, KnowledgeError> {
        if let Some(vault) = self.custom_vault.get() {
            return Ok(vault.clone());
        }
        if let (Some(home), Ok(canonical)) = (&self.home, fs::canonicalize(root)) {
            let home = fs::canonicalize(home).unwrap_or_else(|_| home.clone());
            if home.starts_with(&canonical) {
                eprintln!(
                    "extalia-daemon: the vault root may not be the home directory or contain it"
                );
                return Err(KnowledgeError::VaultUnavailable);
            }
        }
        let vault = Vault::open_custom(root, &self.data_dir, &self.profile, self.limits)
            .inspect_err(|error| {
                eprintln!("extalia-daemon: the custom vault root was refused ({error})")
            })?;
        Ok(self.custom_vault.get_or_init(|| vault).clone())
    }

    /// The validated vault. `create`: the default root may be created (callers apply the
    /// first-sync rule); a custom root never is.
    fn vault(&self, create: bool) -> Result<Vault, KnowledgeError> {
        match &self.custom_root {
            Some(root) => {
                let vault = self.custom_vault(root)?;
                vault.check()?;
                Ok(vault)
            }
            None if create || self.vault_present() => {
                Vault::open_default(&self.data_dir, &self.profile, self.limits)
            }
            None => Err(KnowledgeError::VaultUnavailable),
        }
    }

    fn scope(&self) -> ProfileScope {
        ProfileScope::new(self.profile.clone())
    }

    fn vault_root(&self) -> PathBuf {
        self.data_dir.join("vaults").join(self.profile.as_str())
    }

    fn vault_present(&self) -> bool {
        match &self.custom_root {
            Some(_) => self.vault(false).is_ok(),
            None => fs::symlink_metadata(self.vault_root()).is_ok_and(|meta| meta.is_dir()),
        }
    }

    /// The vault for a write: the default root may be created only while nothing was
    /// indexed (the first-sync rule: a vanished root is never recreated empty).
    fn writable_vault(&mut self) -> Result<Vault, KnowledgeError> {
        if self.custom_root.is_some() || self.vault_present() {
            return self.vault(false);
        }
        self.never_indexed()?;
        self.vault(true)
    }

    /// `Ok` while the index holds nothing: an absent default root was never created yet.
    fn never_indexed(&mut self) -> Result<(), KnowledgeError> {
        let store = self.store()?;
        let stats = store.stats()?;
        if store.generation()? > 0 || stats.notes > 0 || stats.skipped_documents > 0 {
            return Err(KnowledgeError::VaultUnavailable);
        }
        Ok(())
    }

    /// Bring the index in line after a change; the change stands when this fails.
    fn after_change(&mut self) {
        if let Err(error) = self.sync(KnowledgeSyncMode::Incremental) {
            eprintln!("extalia-daemon: the index sync after a note change failed ({error})");
        }
    }

    /// The open index, opening it on first use.
    fn store(&mut self) -> Result<&mut KnowledgeStore, KnowledgeError> {
        if self.store.is_none() {
            self.store = Some(KnowledgeStore::open(&self.data_dir, &self.profile)?);
        }
        Ok(self.store.as_mut().expect("opened above"))
    }

    /// The open index for a rebuild: an index that failed its schema, integrity or owner
    /// check is discarded and recreated (derived data). A lock is never broken.
    fn store_for_rebuild(&mut self) -> Result<&mut KnowledgeStore, KnowledgeError> {
        match self.store() {
            Ok(_) => {}
            Err(
                KnowledgeError::SchemaMismatch
                | KnowledgeError::Integrity
                | KnowledgeError::WrongProfile
                | KnowledgeError::NewerSchema { .. },
            ) => {
                eprintln!("extalia-daemon: discarding the knowledge index for a rebuild");
                self.store = Some(KnowledgeStore::recreate(&self.data_dir, &self.profile)?);
            }
            Err(error) => return Err(error),
        }
        Ok(self.store.as_mut().expect("opened above"))
    }

    /// Run one knowledge request.
    pub fn handle(
        &mut self,
        request: &KnowledgeRequest,
    ) -> Result<ResponseResult, KnowledgeRefusal> {
        let op = request.op();
        let result = self.dispatch(request)?;
        if let Err(errors) = validate_knowledge_result(op, &result) {
            eprintln!(
                "extalia-daemon: {} produced a result outside the contract ({} problem(s))",
                op.as_str(),
                errors.len()
            );
            return Err((ErrorCode::Internal, Some("unrepresentable_result")));
        }
        if json_len(&result) > RESULT_BYTE_BUDGET {
            return Err((ErrorCode::CapacityExceeded, Some("result_too_large")));
        }
        Ok(ResponseResult::Knowledge { op, result })
    }

    fn dispatch(&mut self, request: &KnowledgeRequest) -> Result<Value, KnowledgeRefusal> {
        match request {
            KnowledgeRequest::Status => Ok(self.status()),
            KnowledgeRequest::Sync { mode } => {
                if let Some(hook) = &self.sync_hook {
                    hook();
                }
                self.sync(*mode).map_err(refuse)
            }
            KnowledgeRequest::Node { target } => self.node(target),
            KnowledgeRequest::Links {
                node_id,
                cursor,
                limit,
            } => self.link_page(node_id, *cursor, *limit, false),
            KnowledgeRequest::Backlinks {
                node_id,
                cursor,
                limit,
            } => self.link_page(node_id, *cursor, *limit, true),
            KnowledgeRequest::Search { query, limit } => self.search(query, *limit),
            KnowledgeRequest::Graph {
                node_id,
                depth,
                limit,
            } => self.graph(node_id, *depth, *limit),
            KnowledgeRequest::Overview {
                node_limit,
                edge_limit,
            } => self.overview(*node_limit, *edge_limit),
            KnowledgeRequest::Read { path } => self.read(path),
            KnowledgeRequest::Write {
                path,
                content,
                expected_sha256,
            } => {
                let expected = expected_of(expected_sha256.as_ref().and_then(Option::as_deref));
                self.write(path, |vault, history| {
                    write_note(vault, history, path, content, &expected, Author::User)
                })
            }
            KnowledgeRequest::History { path, limit } => self.history(path, *limit),
            KnowledgeRequest::Rollback {
                path,
                to_sha256,
                expected_sha256,
            } => {
                let expected = expected_of(expected_sha256.as_deref());
                self.write(path, |vault, history| {
                    rollback(vault, history, path, to_sha256, &expected, Author::User)
                })
            }
            KnowledgeRequest::ImportMemory {
                workspace_id,
                dry_run,
            } => self.import_memory(workspace_id, dry_run.unwrap_or(false)),
        }
    }

    fn status(&mut self) -> Value {
        let mut value = json!({
            "vaultRoot": self.vault_label(),
            "vaultPresent": self.vault_present(),
        });
        let opened = self
            .store()
            .and_then(|store| Ok((store.schema_version()?, store.generation()?, store.stats()?)));
        match opened {
            Ok((schema, generation, stats)) => {
                value["state"] = "ready".into();
                value["schemaVersion"] = schema.into();
                value["generation"] = generation.into();
                value["counts"] = json!({
                    "notes": stats.notes,
                    "edges": stats.edges,
                    "unresolvedLinks": stats.unresolved_links,
                    "skipped": stats.skipped_documents,
                });
            }
            Err(error) => {
                eprintln!("extalia-daemon: knowledge index unavailable ({error})");
                value["state"] = "unavailable".into();
                value["reason"] = refusal(&error).1.into();
                value["generation"] = 0.into();
            }
        }
        if let Some(summary) = &self.last_sync {
            value["lastSync"] = summary.clone();
        }
        value
    }

    fn sync(&mut self, mode: KnowledgeSyncMode) -> Result<Value, KnowledgeError> {
        // The default root is created on the first sync only. A root that disappears after
        // notes were indexed disables the vault (ADR 0024 §5): recreating it empty would
        // silently drop every note from the index.
        let vault_created = self.custom_root.is_none() && !self.vault_present();
        if self.custom_root.is_some() {
            self.vault(false)?;
        }
        let store = match mode {
            KnowledgeSyncMode::Rebuild => self.store_for_rebuild()?,
            KnowledgeSyncMode::Incremental => self.store()?,
        };
        if vault_created {
            let stats = store.stats()?;
            if store.generation()? > 0 || stats.notes > 0 || stats.skipped_documents > 0 {
                return Err(KnowledgeError::VaultUnavailable);
            }
        }
        let vault = self.vault(true)?;
        let store = self.store.as_mut().expect("opened above");
        let core_mode = match mode {
            KnowledgeSyncMode::Rebuild => SyncMode::Rebuild,
            KnowledgeSyncMode::Incremental => SyncMode::Incremental,
        };
        let report = store.sync(&vault, core_mode)?;
        let at = format_utc(now_millis());
        let mut omitted = 0usize;
        let renamed: Vec<Value> = report
            .renamed
            .iter()
            .filter_map(
                |rename| match (report_path(&rename.from), report_path(&rename.to)) {
                    (Some(from), Some(to)) => Some(json!({ "from": from, "to": to })),
                    _ => {
                        omitted += 1;
                        None
                    }
                },
            )
            .take(limits::REPORT_ITEMS)
            .collect();
        let skipped: Vec<Value> = report
            .skipped
            .iter()
            .filter_map(|skipped| match report_path(&skipped.path) {
                Some(path) => Some(json!({ "path": path, "reason": skipped.reason.as_str() })),
                None => {
                    omitted += 1;
                    None
                }
            })
            .take(limits::REPORT_ITEMS)
            .collect();
        if omitted > 0 {
            eprintln!(
                "extalia-daemon: {omitted} unrepresentable path(s) left out of a sync report"
            );
        }
        self.last_sync = Some(json!({
            "mode": mode.as_str(),
            "at": at,
            "generation": report.generation,
            "notes": report.notes,
            "added": report.added,
            "updated": report.updated,
            "removed": report.removed,
            "unchanged": report.unchanged,
            "renamed": report.renamed.len(),
            "skipped": report.skipped.len(),
            "unresolvedLinks": report.unresolved_links,
        }));
        Ok(json!({
            "mode": mode.as_str(),
            "at": at,
            "generation": report.generation,
            "notes": report.notes,
            "added": report.added,
            "updated": report.updated,
            "removed": report.removed,
            "unchanged": report.unchanged,
            "unresolvedLinks": report.unresolved_links,
            "renamed": renamed,
            "renamedTotal": report.renamed.len(),
            "skipped": skipped,
            "skippedTotal": report.skipped.len(),
            "vaultCreated": vault_created,
        }))
    }

    /// The open store, its generation and the scope, or the refusal.
    fn reader(&mut self) -> Result<(u64, ProfileScope), KnowledgeRefusal> {
        let scope = self.scope();
        let generation = self
            .store()
            .and_then(|store| store.generation())
            .map_err(refuse)?;
        Ok((generation, scope))
    }

    fn open_store(&self) -> &KnowledgeStore {
        self.store.as_ref().expect("reader() opened the store")
    }

    fn lookup(&self, scope: &ProfileScope, node_id: &str) -> Result<NodeView, KnowledgeRefusal> {
        self.open_store()
            .node(scope, node_id)
            .map_err(refuse)?
            .ok_or(NOT_FOUND)
    }

    fn node(&mut self, target: &NodeTarget) -> Result<Value, KnowledgeRefusal> {
        let (generation, scope) = self.reader()?;
        let store = self.open_store();
        let found = match target {
            NodeTarget::Id(id) => store.node(&scope, id),
            NodeTarget::Path(path) => store.node_by_path(&scope, path),
        }
        .map_err(refuse)?;
        let node = found.ok_or(NOT_FOUND)?;
        let mut value = json!({
            "generation": generation,
            "node": node_value(&node).ok_or((ErrorCode::Internal, Some("unrepresentable_result")))?,
            "bodyStatus": "unavailable",
            "bodyTruncated": false,
        });
        if let Some((body, current, truncated)) = self.read_body(&node.path, &node.source_sha256) {
            value["body"] = body.into();
            value["bodyStatus"] = if current { "current" } else { "changed" }.into();
            value["bodyTruncated"] = truncated.into();
        }
        Ok(value)
    }

    /// The note body after its front matter, sanitized and bounded: `(body, unchanged since
    /// indexed, truncated)`. `None` when the vault or note cannot be read as a note.
    fn read_body(&self, path: &str, indexed_sha256: &str) -> Option<(String, bool, bool)> {
        let text = self.read_note(path)?;
        let (text, sha256) = text;
        let body = frontmatter::split(&text).ok()?.body;
        let (body, truncated) = bounded_body(body);
        Some((body, sha256 == indexed_sha256, truncated))
    }

    fn read_note(&self, path: &str) -> Option<(String, String)> {
        let vault = self.vault(false).ok()?;
        // The write path's reader: walker path rules, no links on the path, size cap, UTF-8.
        match read_note(&vault, path) {
            Ok(Some(note)) => {
                let text = match note.text.strip_prefix('\u{feff}') {
                    Some(rest) => rest.to_owned(),
                    None => note.text,
                };
                Some((text, note.sha256))
            }
            Ok(None) => None,
            Err(error) => {
                eprintln!("extalia-daemon: a note could not be read ({error})");
                None
            }
        }
    }

    fn link_page(
        &mut self,
        node_id: &str,
        cursor: Option<u64>,
        limit: Option<u64>,
        backlinks: bool,
    ) -> Result<Value, KnowledgeRefusal> {
        let (generation, scope) = self.reader()?;
        self.lookup(&scope, node_id)?;
        let store = self.open_store();
        let edges = if backlinks {
            store.backlinks(&scope, node_id)
        } else {
            store.outgoing(&scope, node_id)
        }
        .map_err(refuse)?;
        let start = usize::try_from(cursor.unwrap_or(0)).unwrap_or(usize::MAX);
        let limit = limit.unwrap_or(limits::PAGE_DEFAULT) as usize;
        let mut links = Vec::new();
        let mut nodes = Vec::new();
        let mut seen = BTreeSet::new();
        let mut bytes = 0usize;
        let mut next = None;
        let mut omitted = 0usize;
        for (index, edge) in edges.iter().enumerate().skip(start) {
            if links.len() >= limit {
                next = Some(index);
                break;
            }
            let Some(link) = link_value(edge) else {
                omitted += 1;
                continue;
            };
            let other = if backlinks {
                Some(edge.source_node_id.clone())
            } else {
                match &edge.target {
                    LinkTarget::Resolved { node_id, .. } => Some(node_id.clone()),
                    _ => None,
                }
            };
            let reference = match other {
                Some(other) if !seen.contains(&other) => store
                    .node(&scope, &other)
                    .map_err(refuse)?
                    .and_then(|node| node_ref(&node)),
                _ => None,
            };
            let size = json_len(&link) + reference.as_ref().map_or(0, json_len);
            if !links.is_empty() && bytes + size > PAGE_BYTE_BUDGET {
                next = Some(index);
                break;
            }
            bytes += size;
            links.push(link);
            if let Some(reference) = reference {
                seen.insert(reference["nodeId"].as_str().unwrap_or_default().to_owned());
                nodes.push(reference);
            }
        }
        if omitted > 0 {
            eprintln!("extalia-daemon: {omitted} unrepresentable link(s) left out of a page");
        }
        let mut value = json!({
            "generation": generation,
            "nodeId": node_id,
            "links": links,
            "nodes": nodes,
        });
        if let Some(next) = next {
            value["nextCursor"] = next.into();
        }
        Ok(value)
    }

    fn search(&mut self, query: &str, limit: Option<u64>) -> Result<Value, KnowledgeRefusal> {
        let (generation, scope) = self.reader()?;
        let limit = limit.unwrap_or(limits::SEARCH_DEFAULT) as usize;
        let hits = self
            .open_store()
            .search(&scope, query, limit)
            .map_err(refuse)?;
        let terms: Vec<String> = query
            .split_whitespace()
            .take(SEARCH_TERMS)
            .map(str::to_lowercase)
            .collect();
        let mut values = Vec::new();
        for hit in hits.iter().take(limit) {
            let Some(path) = report_path(&hit.path).filter(|path| path == &hit.path) else {
                continue;
            };
            if !is_knowledge_node_id(&hit.node_id) {
                continue;
            }
            let mut value = json!({
                "nodeId": hit.node_id,
                "path": path,
                "title": clean_text(&hit.title, limits::TITLE),
            });
            if let Some(snippet) = self.read_note(&hit.path).and_then(|(text, _)| {
                frontmatter::split(&text)
                    .ok()
                    .and_then(|split| snippet(split.body, &terms))
            }) {
                value["snippet"] = snippet.into();
            }
            values.push(value);
        }
        Ok(json!({ "generation": generation, "hits": values }))
    }

    fn graph(
        &mut self,
        node_id: &str,
        depth: Option<u64>,
        limit: Option<u64>,
    ) -> Result<Value, KnowledgeRefusal> {
        let (generation, scope) = self.reader()?;
        let root = self.lookup(&scope, node_id)?;
        let depth = depth.unwrap_or(limits::GRAPH_DEPTH_DEFAULT);
        let limit = limit.unwrap_or(limits::GRAPH_NODES_DEFAULT);
        let graph = self
            .open_store()
            .local_graph(&scope, node_id, depth as usize, limit as usize)
            .map_err(refuse)?;
        let mut truncated = graph.truncated;
        let mut kept = BTreeSet::new();
        let mut nodes = Vec::new();
        let mut bytes = 0usize;
        // The root first, then the others in id order.
        let others = graph.nodes.iter().filter(|(id, _)| **id != root.node_id);
        for (id, title) in std::iter::once((&root.node_id, &root.title)).chain(others) {
            if !is_knowledge_node_id(id) {
                continue;
            }
            let value = json!({ "nodeId": id, "title": clean_text(title, limits::TITLE) });
            let size = json_len(&value);
            if !nodes.is_empty() && bytes + size > GRAPH_NODE_BYTE_BUDGET {
                truncated = true;
                break;
            }
            bytes += size;
            kept.insert(id.clone());
            nodes.push(value);
        }
        let mut edges = Vec::new();
        for (source, kind, target) in &graph.edges {
            if !kept.contains(source) || !kept.contains(target) {
                continue;
            }
            let value = json!({ "source": source, "target": target, "edgeType": kind.as_str() });
            let size = json_len(&value);
            if edges.len() >= limits::GRAPH_EDGES || bytes + size > GRAPH_BYTE_BUDGET {
                truncated = true;
                break;
            }
            bytes += size;
            edges.push(value);
        }
        Ok(json!({
            "generation": generation,
            "rootNodeId": node_id,
            "depth": depth,
            "nodes": nodes,
            "edges": edges,
            "truncated": truncated,
        }))
    }
}

impl Knowledge {
    /// The bounded whole-vault graph. The core ranks notes (degree, then id) and edges
    /// (summed end degrees) in SQL; here nodes stop at [`OVERVIEW_NODE_BYTE_BUDGET`] and edges
    /// among the kept nodes at [`OVERVIEW_BYTE_BUDGET`], so the frame stays below the limit.
    fn overview(
        &mut self,
        node_limit: Option<u64>,
        edge_limit: Option<u64>,
    ) -> Result<Value, KnowledgeRefusal> {
        let (generation, scope) = self.reader()?;
        let node_limit = node_limit.unwrap_or(limits::OVERVIEW_NODES) as usize;
        let edge_limit = edge_limit.unwrap_or(limits::OVERVIEW_EDGES) as usize;
        let store = self.open_store();
        let ranked = store.overview_nodes(&scope, node_limit).map_err(refuse)?;
        let mut nodes = Vec::new();
        let mut kept: Vec<&str> = Vec::new();
        let mut bytes = 0usize;
        let mut omitted = 0usize;
        for node in &ranked.nodes {
            let Some(value) = overview_node_value(node) else {
                omitted += 1;
                continue;
            };
            let size = json_len(&value) + 1;
            if bytes + size > OVERVIEW_NODE_BYTE_BUDGET {
                break;
            }
            bytes += size;
            kept.push(&node.node_id);
            nodes.push(value);
        }
        if omitted > 0 {
            eprintln!("extalia-daemon: {omitted} unrepresentable note(s) left out of an overview");
        }
        let mut edges = Vec::new();
        for edge in store
            .overview_edges(&scope, &kept, edge_limit)
            .map_err(refuse)?
        {
            let value = json!({
                "source": edge.source,
                "target": edge.target,
                "type": edge.edge_type.as_str(),
            });
            let size = json_len(&value) + 1;
            if bytes + size > OVERVIEW_BYTE_BUDGET {
                break;
            }
            bytes += size;
            edges.push(value);
        }
        let truncated =
            (nodes.len() as u64) < ranked.total_nodes || (edges.len() as u64) < ranked.total_edges;
        Ok(json!({
            "generation": generation,
            "totalNodes": ranked.total_nodes,
            "totalEdges": ranked.total_edges,
            "truncated": truncated,
            "nodes": nodes,
            "edges": edges,
        }))
    }
}

impl Knowledge {
    /// The reviewed read: the file exactly as stored and the hash of all its bytes.
    fn read(&mut self, path: &str) -> Result<Value, KnowledgeRefusal> {
        validate_note_path(path, &self.limits).map_err(write_refusal)?;
        if self.custom_root.is_none() && !self.vault_present() {
            // Never created (nothing indexed): no note exists. A vanished root stays unavailable.
            self.never_indexed().map_err(refuse)?;
            return Err((ErrorCode::NotFound, Some("note_not_found")));
        }
        let vault = self.vault(false).map_err(refuse)?;
        let note = read_note(&vault, path)
            .map_err(write_refusal)?
            .ok_or((ErrorCode::NotFound, Some("note_not_found")))?;
        let (body, truncated) = bounded_read(&note.text);
        Ok(json!({
            "path": path,
            "sha256": note.sha256,
            "managed": note.managed,
            "body": body,
            "truncated": truncated,
        }))
    }

    /// A user write or rollback through the core's compare-and-swap, then an index sync.
    fn write(
        &mut self,
        path: &str,
        apply: impl FnOnce(&Vault, &History) -> Result<WriteOutcome, WriteError>,
    ) -> Result<Value, KnowledgeRefusal> {
        validate_note_path(path, &self.limits).map_err(write_refusal)?;
        let vault = self.writable_vault().map_err(refuse)?;
        let history = History::open(&self.data_dir, &self.profile).map_err(write_refusal)?;
        let outcome = apply(&vault, &history).map_err(write_refusal)?;
        let value = match outcome {
            WriteOutcome::Written {
                path,
                previous_sha256,
                sha256,
            } => {
                let mut value = json!({ "outcome": "written", "path": path, "sha256": sha256 });
                if let Some(previous) = previous_sha256 {
                    value["previousSha256"] = previous.into();
                }
                value
            }
            WriteOutcome::Unchanged { path, sha256 } => {
                return Ok(json!({ "outcome": "unchanged", "path": path, "sha256": sha256 }));
            }
            WriteOutcome::Conflict {
                current_sha256,
                conflict_path,
                reason,
            } => {
                let mut value = json!({
                    "outcome": "conflict",
                    "path": path,
                    "conflictPath": conflict_path,
                    "conflictReason": reason.as_str(),
                });
                if let Some(current) = current_sha256 {
                    value["sha256"] = current.into();
                }
                value
            }
        };
        self.after_change();
        Ok(value)
    }

    /// The note's journal, newest first, with versions written outside Extalia (`external`).
    fn history(&mut self, path: &str, limit: Option<u64>) -> Result<Value, KnowledgeRefusal> {
        validate_note_path(path, &self.limits).map_err(write_refusal)?;
        let history = History::open(&self.data_dir, &self.profile).map_err(write_refusal)?;
        let journal = history.entries(path).map_err(write_refusal)?;
        let limit = limit.unwrap_or(limits::HISTORY_DEFAULT) as usize;
        let mut entries = Vec::new();
        let mut omitted = 0usize;
        // The content Extalia last left at `path`, to see versions written by others.
        let mut known: Option<String> = None;
        for entry in &journal {
            if entry.path != path {
                // `path` is this entry's conflict copy.
                match history_value(entry, "conflict") {
                    Some(value) => entries.push(value),
                    None => omitted += 1,
                }
                continue;
            }
            if let Some(previous) = &entry.previous_sha256
                && known.as_ref() != Some(previous)
            {
                entries.push(json!({
                    "sha256": previous,
                    "at": entry.at,
                    "kind": "external",
                    "author": "external",
                }));
            }
            let kind = match entry.op {
                HistoryOp::Create | HistoryOp::Update => "write",
                HistoryOp::Rollback => "rollback",
                HistoryOp::Conflict => "conflict",
            };
            known = if entry.op == HistoryOp::Conflict {
                entry.previous_sha256.clone()
            } else {
                Some(entry.sha256.clone())
            };
            match history_value(entry, kind) {
                Some(value) => entries.push(value),
                None => omitted += 1,
            }
        }
        if omitted > 0 {
            eprintln!("extalia-daemon: {omitted} unrepresentable journal entr(ies) left out");
        }
        entries.reverse();
        entries.truncate(limit);
        Ok(json!({ "path": path, "entries": entries }))
    }

    /// Import (or preview) the host's memory notes of one workspace of this profile.
    fn import_memory(
        &mut self,
        workspace_id: &str,
        dry_run: bool,
    ) -> Result<Value, KnowledgeRefusal> {
        // `MemoryStore`'s folder (`packages/host/src/memory.ts`, `service.ts`).
        let source = self
            .data_dir
            .join("workspaces")
            .join(workspace_id)
            .join("memory");
        let vault = self.writable_vault().map_err(refuse)?;
        let history = History::open(&self.data_dir, &self.profile).map_err(write_refusal)?;
        let report = if dry_run {
            preview_memory_import(&source, workspace_id, &vault, &history)
        } else {
            import_memory_notes(&source, workspace_id, &vault, &history)
        }
        .map_err(write_refusal)?;
        let mut counts = json!({
            "total": report.notes.len(), "created": 0, "updated": 0, "unchanged": 0, "conflict": 0,
            "pendingConflict": 0, "missingInVault": 0, "skipped": 0, "masked": 0,
        });
        let mut notes = Vec::new();
        let mut bytes = 0usize;
        let mut truncated = false;
        let mut changed = false;
        for note in &report.notes {
            let key = match &note.outcome {
                ImportOutcome::Created { .. } => "created",
                ImportOutcome::Updated { .. } => "updated",
                ImportOutcome::Unchanged => "unchanged",
                ImportOutcome::Conflict { .. } => "conflict",
                ImportOutcome::PendingConflict => "pendingConflict",
                ImportOutcome::MissingInVault => "missingInVault",
                ImportOutcome::Skipped(_) => "skipped",
            };
            changed |= matches!(key, "created" | "updated" | "conflict");
            counts[key] = (counts[key].as_u64().unwrap_or(0) + 1).into();
            counts["masked"] = (counts["masked"].as_u64().unwrap_or(0) + note.masked as u64).into();
            let mut value = json!({
                "name": clean_text(&note.name, limits::IMPORT_NAME),
                "outcome": note.outcome.as_str(),
                "masked": note.masked,
            });
            let vault_path = note.vault_path.clone().or_else(|| {
                is_memory_name(&note.name).then(|| memory_note_path(workspace_id, &note.name))
            });
            if let Some(vault_path) = vault_path.filter(|path| is_knowledge_path(path)) {
                value["vaultPath"] = vault_path.into();
            } else if !matches!(note.outcome, ImportOutcome::Skipped(_)) {
                eprintln!(
                    "extalia-daemon: an imported note without a reportable path was left out"
                );
                continue;
            }
            if let ImportOutcome::Skipped(reason) = &note.outcome {
                value["reason"] = reason.as_str().into();
            }
            let size = json_len(&value) + 1;
            if truncated || notes.len() >= limits::IMPORT_NOTES || bytes + size > IMPORT_BYTE_BUDGET
            {
                truncated = true;
                continue;
            }
            bytes += size;
            notes.push(value);
        }
        if changed && !dry_run {
            self.after_change();
        }
        let mut value = json!({ "notes": notes, "counts": counts });
        if truncated {
            value["truncated"] = true.into();
        }
        Ok(value)
    }
}

/// A journal entry as sent; `None` when a path or author cannot be carried.
fn history_value(entry: &HistoryEntry, kind: &str) -> Option<Value> {
    if !is_history_author(&entry.author) {
        return None;
    }
    let mut value = json!({
        "sha256": entry.sha256,
        "at": entry.at,
        "kind": kind,
        "author": entry.author,
    });
    if let Some(previous) = &entry.previous_sha256 {
        value["previousSha256"] = previous.clone().into();
    }
    if kind == "conflict" {
        let copy = entry
            .conflict_path
            .as_ref()
            .filter(|path| is_knowledge_path(path))?;
        value["conflictPath"] = copy.clone().into();
    }
    Some(value)
}

fn expected_of(hash: Option<&str>) -> Expected {
    hash.map_or(Expected::Absent, |hash| Expected::Sha256(hash.to_owned()))
}

/// Wire code and reason of a write path error.
pub fn write_refusal(error: WriteError) -> KnowledgeRefusal {
    let refusal = match &error {
        WriteError::InvalidPath => (ErrorCode::InvalidRequest, "invalid_path"),
        WriteError::InvalidExpected => (ErrorCode::InvalidRequest, "invalid_expected"),
        WriteError::TooLarge => (ErrorCode::CapacityExceeded, "too_large"),
        WriteError::InvalidContent => (ErrorCode::Denied, "not_utf8"),
        WriteError::NotManagedContent => (ErrorCode::Denied, "not_managed"),
        WriteError::Unsafe(_) => (ErrorCode::Denied, "unsafe_path"),
        WriteError::UnknownVersion => (ErrorCode::NotFound, "unknown_version"),
        WriteError::History => (ErrorCode::StorageFailure, "history_unavailable"),
        WriteError::Knowledge(error) => refusal(error),
        WriteError::Io(_) => (ErrorCode::StorageFailure, "io_failure"),
    };
    eprintln!("extalia-daemon: knowledge write refused ({error})");
    (refusal.0, Some(refusal.1))
}

/// JSON bytes `serde_json` writes for `character` inside a string.
fn escaped_len(character: char) -> usize {
    match character {
        '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
        _ if (character as u32) < 32 => 6,
        _ => character.len_utf8(),
    }
}

/// The file text cut at a character boundary to at most [`limits::READ_BYTES`] UTF-8 bytes
/// and [`READ_JSON_BUDGET`] escaped bytes: `(body, truncated)`. Nothing is replaced.
fn bounded_read(text: &str) -> (String, bool) {
    let mut bytes = 0usize;
    let mut escaped = 0usize;
    for (index, character) in text.char_indices() {
        bytes += character.len_utf8();
        escaped += escaped_len(character);
        if bytes > limits::READ_BYTES || escaped > READ_JSON_BUDGET {
            return (text[..index].to_owned(), true);
        }
    }
    (text.to_owned(), false)
}

fn is_control(character: char) -> bool {
    (character as u32) < 32 || character as u32 == 127
}

/// An overview node as sent; `None` when its id or path cannot be carried.
fn overview_node_value(node: &OverviewNode) -> Option<Value> {
    if !is_knowledge_node_id(&node.node_id) || !is_knowledge_path(&node.path) {
        return None;
    }
    let folder = node.path.rsplit_once('/').map_or("", |(folder, _)| folder);
    let mut tags: Vec<String> = Vec::new();
    for tag in &node.tags {
        if tags.len() == limits::OVERVIEW_TAGS {
            break;
        }
        let tag = clean_text(tag, limits::OVERVIEW_TAG);
        if !tags.contains(&tag) {
            tags.push(tag);
        }
    }
    let millis = node
        .source_mtime_ns
        .div_euclid(1_000_000)
        .clamp(0, MAX_MILLIS);
    Some(json!({
        "nodeId": node.node_id,
        "title": clean_text(&node.title, limits::TITLE),
        "path": node.path,
        "kind": clean_text(&node.kind, limits::KIND),
        "folder": folder,
        "tags": tags,
        "degree": node.degree(),
        "inDegree": node.in_degree,
        "outDegree": node.out_degree,
        "modifiedAt": format_utc(millis),
    }))
}

fn json_len(value: &Value) -> usize {
    serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len())
}

fn is_js_space(character: char) -> bool {
    character.is_whitespace() || character == '\u{feff}'
}

/// Control characters → U+FFFD, at most `max` UTF-16 units, never blank.
fn clean_text(text: &str, max: usize) -> String {
    let mut out = String::new();
    let mut units = 0;
    for character in text.chars() {
        let character = if (character as u32) < 32 || character as u32 == 127 {
            REPLACEMENT
        } else {
            character
        };
        units += character.len_utf16();
        if units > max {
            break;
        }
        out.push(character);
    }
    if out.chars().all(is_js_space) {
        REPLACEMENT.to_string()
    } else {
        out
    }
}

/// A vault path as reported: control characters and backslashes → U+FFFD, clipped with an
/// ellipsis when too long; `None` when it still is not a vault path.
fn report_path(path: &str) -> Option<String> {
    let mut out = String::new();
    let mut units = 0;
    for character in path.chars() {
        let character = if (character as u32) < 32 || character as u32 == 127 || character == '\\' {
            REPLACEMENT
        } else {
            character
        };
        if units + character.len_utf16() > limits::PATH - 1 {
            out.push(ELLIPSIS);
            break;
        }
        units += character.len_utf16();
        out.push(character);
    }
    is_knowledge_path(&out).then_some(out)
}

fn node_ref(node: &NodeView) -> Option<Value> {
    (is_knowledge_node_id(&node.node_id) && is_knowledge_path(&node.path)).then(|| {
        json!({
            "nodeId": node.node_id,
            "path": node.path,
            "title": clean_text(&node.title, limits::TITLE),
        })
    })
}

fn texts(list: &[String], max: usize) -> Vec<String> {
    list.iter()
        .take(limits::LIST_ITEMS)
        .map(|item| clean_text(item, max))
        .collect()
}

fn node_value(node: &NodeView) -> Option<Value> {
    if !is_knowledge_node_id(&node.node_id) || !is_knowledge_path(&node.path) {
        return None;
    }
    let mut value = Map::new();
    let mut put = |key: &str, item: Value| {
        value.insert(key.to_owned(), item);
    };
    put("nodeId", node.node_id.clone().into());
    put("idFromFrontMatter", node.id_from_front_matter.into());
    put("path", node.path.clone().into());
    put("kind", clean_text(&node.kind, limits::KIND).into());
    put("title", clean_text(&node.title, limits::TITLE).into());
    put("aliases", texts(&node.aliases, limits::ALIAS).into());
    put("tags", texts(&node.tags, limits::TAG).into());
    put("origin", node.origin.clone().into());
    put("trustStatus", node.trust_status.clone().into());
    put("sourceSha256", node.source_sha256.clone().into());
    // Year 9999 at most; a file time before the epoch is not reported.
    let millis = node.source_mtime_ns.div_euclid(1_000_000);
    if (0..=253_402_300_799_999).contains(&millis) {
        put("sourceModifiedAt", format_utc(millis).into());
    }
    put("observedAt", node.observed_at.clone().into());
    if let Some(verification) = &node.declared_verification {
        put(
            "declaredVerification",
            clean_text(verification, limits::VERIFICATION).into(),
        );
    }
    if let Some(revision) = node.declared_revision {
        put("declaredRevision", revision.into());
    }
    put(
        "declaredSourceTaskIds",
        texts(&node.declared_source_task_ids, limits::TASK_ID).into(),
    );
    Some(Value::Object(value))
}

fn link_value(edge: &EdgeView) -> Option<Value> {
    if !is_knowledge_node_id(&edge.source_node_id) {
        return None;
    }
    let mut value = json!({
        "sourceNodeId": edge.source_node_id,
        "ordinal": edge.ordinal,
        "edgeType": edge.edge_type.as_str(),
        "embed": edge.embed,
        "line": edge.line.max(1),
        "target": clean_text(&edge.target_text, limits::LINK_TEXT),
    });
    if let Some(heading) = &edge.heading {
        value["heading"] = clean_text(heading, limits::LINK_TEXT).into();
    }
    if let Some(display) = &edge.display {
        value["display"] = clean_text(display, limits::LINK_TEXT).into();
    }
    match &edge.target {
        LinkTarget::Resolved { node_id, via } => {
            if !is_knowledge_node_id(node_id) {
                return None;
            }
            value["status"] = "resolved".into();
            value["via"] = via.as_str().into();
            value["targetNodeId"] = node_id.clone().into();
        }
        LinkTarget::Missing => value["status"] = "missing".into(),
        LinkTarget::Ambiguous { candidates } => {
            let candidates: Vec<&String> = candidates
                .iter()
                .filter(|id| is_knowledge_node_id(id))
                .take(limits::CANDIDATES)
                .collect();
            if candidates.is_empty() {
                value["status"] = "missing".into();
            } else {
                value["status"] = "ambiguous".into();
                value["candidates"] = json!(candidates);
            }
        }
    }
    Some(value)
}

/// The body with control characters other than tab, LF and CR replaced, cut at a character
/// boundary to at most [`limits::BODY_BYTES`] bytes: `(body, truncated)`.
fn bounded_body(body: &str) -> (String, bool) {
    let mut out = String::with_capacity(body.len().min(limits::BODY_BYTES));
    for character in body.chars() {
        let character = match character {
            '\t' | '\n' | '\r' => character,
            _ if (character as u32) < 32 || character as u32 == 127 => REPLACEMENT,
            _ => character,
        };
        if out.len() + character.len_utf8() > limits::BODY_BYTES {
            return (out, true);
        }
        out.push(character);
    }
    (out, false)
}

/// A single-line excerpt around the first occurrence of a search term (case-insensitive),
/// at most [`limits::SNIPPET`] UTF-16 units; `None` when no term occurs literally.
fn snippet(body: &str, terms: &[String]) -> Option<String> {
    const BEFORE: usize = 80;
    let terms: Vec<Vec<char>> = terms
        .iter()
        .map(|term| term.chars().collect())
        .filter(|term: &Vec<char>| !term.is_empty())
        .collect();
    for line in body.lines() {
        let chars: Vec<char> = line.chars().collect();
        // Lowercased characters with the index of the original character they came from.
        let lowered: Vec<(char, usize)> = chars
            .iter()
            .enumerate()
            .flat_map(|(index, character)| character.to_lowercase().map(move |low| (low, index)))
            .collect();
        let found = (0..lowered.len()).find(|&start| {
            terms.iter().any(|term| {
                lowered.len() - start >= term.len()
                    && term
                        .iter()
                        .zip(&lowered[start..])
                        .all(|(want, (have, _))| want == have)
            })
        });
        let Some(found) = found else {
            continue;
        };
        let origin = lowered[found].1;
        let start = origin.saturating_sub(BEFORE);
        let mut out = String::new();
        if start > 0 {
            out.push(ELLIPSIS);
        }
        let mut units = out.encode_utf16().count();
        let mut last_space = false;
        let mut cut = false;
        for &character in &chars[start..] {
            let character = if character.is_whitespace()
                || (character as u32) < 32
                || character as u32 == 127
            {
                ' '
            } else {
                character
            };
            if character == ' ' && last_space {
                continue;
            }
            last_space = character == ' ';
            if units + character.len_utf16() > limits::SNIPPET - 1 {
                cut = true;
                break;
            }
            units += character.len_utf16();
            out.push(character);
        }
        if cut {
            out.push(ELLIPSIS);
        }
        let out = out.trim().to_owned();
        if !out.chars().all(is_js_space) {
            return Some(out);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snippets_are_bounded_single_lines_around_the_match() {
        let body = format!(
            "intro\n{}Needle in\ta haystack{}\n",
            "x ".repeat(200),
            " y".repeat(300)
        );
        let text = snippet(&body, &["needle".into()]).unwrap();
        assert!(
            text.starts_with(ELLIPSIS) && text.ends_with(ELLIPSIS),
            "{text}"
        );
        assert!(text.contains("Needle in a haystack"));
        assert!(text.encode_utf16().count() <= limits::SNIPPET);
        assert_eq!(snippet("nothing here", &["absent".into()]), None);
        assert_eq!(
            snippet("İstanbul", &["i̇stanbul".into()]).as_deref(),
            Some("İstanbul")
        );
    }

    #[test]
    fn bodies_and_paths_are_sanitized_and_bounded() {
        let (body, truncated) = bounded_body("a\u{1}b\tc\r\n");
        assert_eq!((body.as_str(), truncated), ("a\u{fffd}b\tc\r\n", false));
        let (body, truncated) = bounded_body(&"€".repeat(limits::BODY_BYTES));
        assert!(truncated && body.len() <= limits::BODY_BYTES && body.len() % 3 == 0);
        assert_eq!(
            report_path("a\\b\n.md").as_deref(),
            Some("a\u{fffd}b\u{fffd}.md")
        );
        let long = report_path(&"x".repeat(5_000)).unwrap();
        assert_eq!(long.encode_utf16().count(), limits::PATH);
        assert_eq!(clean_text(" \u{7} ", 10), " \u{fffd} ");
        assert_eq!(clean_text("   ", 10), "\u{fffd}");
    }
}
