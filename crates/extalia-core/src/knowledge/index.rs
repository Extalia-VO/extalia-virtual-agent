//! Full rebuild and incremental sync of a profile's index from its vault.
//!
//! A sync walks the vault, then in one immediate transaction:
//!
//! 1. A note whose size and mtime equal the stored ones is unchanged and not read, unless
//!    its mtime is within [`RACY_WINDOW_NS`] of the sync start (an edit in the same clock
//!    tick could keep both). Other notes are read and hashed; an equal SHA-256 only
//!    refreshes the stored stat.
//! 2. Changed or new notes are parsed: front matter (invalid → skipped), the profile ACL
//!    (a front matter `profile` other than the vault's → skipped `profile_mismatch`, never
//!    indexed), the node id (front matter `id`, else `path:<path>`), title, aliases, tags
//!    and links.
//! 3. Duplicate front matter ids: the claimant with the smallest path (byte order) is
//!    indexed, the others are skipped `duplicate_id`. Claimants whose status changes
//!    because another claimant changed are re-read, so the result never depends on the
//!    order of edits.
//! 4. Nodes of removed and changed notes leave (their outgoing edges with them), new nodes
//!    enter, and every remaining edge whose target key matches a key of a leaving or
//!    entering note is resolved again ([`super::resolve`]).
//! 5. Renames are detected by content hash (a removed and an added note with the same
//!    SHA-256) and reported; a derived `path:` id follows the path, so notes that need a
//!    stable identity across renames carry a front matter `id`.
//!
//! [`SyncMode::Rebuild`] clears the profile's rows and runs the same steps from empty, so a
//! rebuild and any sequence of incremental syncs over the same files give the same rows
//! (except `node_seq` and `observed_at`). The indexer never writes a note.

use std::collections::{BTreeMap, BTreeSet};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Transaction, TransactionBehavior, params};

use super::frontmatter::{self, FrontMatter};
use super::links::{self, Link, clip};
use super::resolve::{self, NoteRef, Outcome, Resolver, Target};
use super::vault::{Content, NoteFile, SkipReason, Vault, VaultLimits};
use super::{KnowledgeError, KnowledgeStore};
use crate::skills::ProfileId;

/// Notes modified this close to the sync start are always re-hashed.
pub const RACY_WINDOW_NS: i64 = 2_000_000_000;
const MAX_TITLE_BYTES: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncMode {
    /// Re-read only notes whose stat changed.
    Incremental,
    /// Discard the profile's rows and index every note again.
    Rebuild,
}

/// A rename detected by content hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rename {
    pub from: String,
    pub to: String,
}

/// A file that is not indexed, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skipped {
    pub path: String,
    pub reason: SkipReason,
}

/// Outcome of a sync. Paths are vault-relative and reported only to the vault's profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexReport {
    pub generation: u64,
    /// Indexed notes after the sync.
    pub notes: usize,
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub unchanged: usize,
    pub renamed: Vec<Rename>,
    /// Every file currently not indexed, sorted by path.
    pub skipped: Vec<Skipped>,
    /// Edges whose target is missing or ambiguous.
    pub unresolved_links: usize,
}

/// A note ready to become a node.
#[derive(Debug, Clone)]
pub(crate) struct ParsedNote {
    pub node_id: String,
    pub id_from_front_matter: bool,
    pub front_matter: FrontMatter,
    pub kind: String,
    pub title: String,
    pub links: Vec<(Link, Target)>,
    pub body: String,
}

/// Parse a note's text. `Err` is the reason it is skipped.
pub(crate) fn parse_note(
    path: &str,
    text: &str,
    profile: &ProfileId,
    limits: &VaultLimits,
) -> Result<ParsedNote, SkipReason> {
    let split = frontmatter::split(text).map_err(|_| SkipReason::InvalidFrontMatter)?;
    let front_matter = split.front_matter;
    if front_matter
        .profile
        .as_ref()
        .is_some_and(|declared| declared != profile)
    {
        return Err(SkipReason::ProfileMismatch);
    }
    let parsed = links::parse(split.body, split.body_first_line);
    let stem = resolve::strip_md(path).rsplit('/').next().unwrap_or(path);
    let title = clip(parsed.title.as_deref().unwrap_or(stem), MAX_TITLE_BYTES);
    let (node_id, id_from_front_matter) = match &front_matter.id {
        Some(id) => (id.clone(), true),
        None => (format!("path:{path}"), false),
    };
    let links = parsed
        .links
        .into_iter()
        .take(limits.max_links_per_note)
        .map(|link| {
            let target = resolve::normalize(path, &link.target);
            (link, target)
        })
        .collect();
    Ok(ParsedNote {
        node_id,
        id_from_front_matter,
        kind: front_matter
            .kind
            .clone()
            .unwrap_or_else(|| "note".to_owned()),
        front_matter,
        title,
        links,
        body: split.body.to_owned(),
    })
}

#[derive(Debug, Clone)]
struct DocRow {
    size: i64,
    mtime_ns: i64,
    sha256: Option<String>,
    skip: Option<SkipReason>,
    claimed_id: Option<String>,
    /// `(node_id, id from front matter)` when indexed.
    node: Option<(String, bool)>,
}

impl DocRow {
    /// The front matter id this document holds or claims.
    fn claim(&self) -> Option<&str> {
        match (&self.node, &self.claimed_id) {
            (Some((id, true)), _) => Some(id),
            (_, Some(id)) => Some(id),
            _ => None,
        }
    }
}

#[derive(Debug)]
struct Fresh {
    size: i64,
    mtime_ns: i64,
    sha256: Option<String>,
    outcome: Result<ParsedNote, SkipReason>,
}

impl Fresh {
    fn claim(&self) -> Option<&str> {
        match &self.outcome {
            Ok(note) if note.id_from_front_matter => Some(&note.node_id),
            _ => None,
        }
    }
}

fn read_fresh(
    path: &str,
    file: &NoteFile,
    profile: &ProfileId,
    limits: &VaultLimits,
) -> Result<Fresh, KnowledgeError> {
    let (sha256, outcome) = match file.read(limits.max_file_bytes)? {
        Content::TooLarge => (None, Err(SkipReason::TooLarge)),
        Content::NotUtf8 { sha256 } => (Some(sha256), Err(SkipReason::NotUtf8)),
        Content::Text { text, sha256 } => {
            let outcome = parse_note(path, &text, profile, limits);
            (Some(sha256), outcome)
        }
    };
    Ok(Fresh {
        size: i64::try_from(file.size).unwrap_or(i64::MAX),
        mtime_ns: file.mtime_ns,
        sha256,
        outcome,
    })
}

impl KnowledgeStore {
    /// Bring the index in line with the vault. The vault must belong to this profile.
    pub fn sync(&mut self, vault: &Vault, mode: SyncMode) -> Result<IndexReport, KnowledgeError> {
        if vault.profile() != &self.profile {
            return Err(KnowledgeError::WrongProfile);
        }
        let walk = vault.walk()?;
        let total: u64 = walk
            .notes
            .values()
            .map(|file| file.size)
            .filter(|size| *size <= vault.limits().max_file_bytes)
            .sum();
        if total > vault.limits().max_total_bytes {
            return Err(KnowledgeError::VaultTooLarge);
        }
        let now_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| {
                i64::try_from(elapsed.as_nanos()).unwrap_or(i64::MAX)
            });
        let observed_at = crate::time::format_utc(crate::time::now_millis());
        let profile = self.profile.clone();
        let limits = *vault.limits();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let p = profile.as_str();
        if mode == SyncMode::Rebuild {
            clear(&tx, p)?;
        }
        let docs = load_docs(&tx, p)?;

        // 1. Classify by stat, then by content digest.
        let mut fresh: BTreeMap<String, Fresh> = BTreeMap::new();
        let mut touched: Vec<(String, i64, i64)> = Vec::new();
        let mut unchanged = 0usize;
        for (path, file) in &walk.notes {
            let size = i64::try_from(file.size).unwrap_or(i64::MAX);
            let racy = file.mtime_ns >= now_ns.saturating_sub(RACY_WINDOW_NS);
            let doc = docs.get(path);
            if let Some(doc) = doc
                && doc.size == size
                && doc.mtime_ns == file.mtime_ns
                && !racy
            {
                unchanged += 1;
                continue;
            }
            let read = read_fresh(path, file, &profile, &limits)?;
            match doc {
                Some(doc) if doc.sha256 == read.sha256 => {
                    if doc.size != read.size || doc.mtime_ns != read.mtime_ns {
                        touched.push((path.clone(), read.size, read.mtime_ns));
                    }
                    unchanged += 1;
                }
                _ => {
                    fresh.insert(path.clone(), read);
                }
            }
        }
        let removed: BTreeSet<String> = docs
            .keys()
            .filter(|path| !walk.notes.contains_key(*path))
            .cloned()
            .collect();

        // 3. Duplicate ids: re-read stable claimants whose status must change.
        let winners = loop {
            let mut affected: BTreeSet<String> = BTreeSet::new();
            for path in removed.iter().chain(fresh.keys()) {
                if let Some(id) = docs.get(path).and_then(DocRow::claim) {
                    affected.insert(id.to_owned());
                }
            }
            affected.extend(fresh.values().filter_map(Fresh::claim).map(str::to_owned));
            let mut claimants: BTreeMap<&str, Vec<(&String, Option<bool>)>> = BTreeMap::new();
            for (path, doc) in &docs {
                if fresh.contains_key(path) || removed.contains(path) {
                    continue;
                }
                if let Some(id) = doc.claim().filter(|id| affected.contains(*id)) {
                    claimants
                        .entry(id)
                        .or_default()
                        .push((path, Some(doc.node.is_some())));
                }
            }
            for (path, item) in &fresh {
                if let Some(id) = item.claim() {
                    claimants.entry(id).or_default().push((path, None));
                }
            }
            let mut winners: BTreeMap<String, String> = BTreeMap::new();
            let mut reload: Vec<String> = Vec::new();
            for (id, list) in &claimants {
                let Some(winner) = list.iter().map(|(path, _)| *path).min() else {
                    continue;
                };
                for (path, indexed) in list {
                    if let Some(indexed) = indexed
                        && (*path == winner) != *indexed
                    {
                        reload.push((*path).clone());
                    }
                }
                winners.insert((*id).to_owned(), winner.clone());
            }
            if reload.is_empty() {
                break winners;
            }
            for path in reload {
                let file = &walk.notes[&path];
                let read = read_fresh(&path, file, &profile, &limits)?;
                fresh.insert(path, read);
            }
        };

        // 5. Renames: a removed document and a new path with the same digest.
        let mut gone_by_sha: BTreeMap<&str, Vec<&String>> = BTreeMap::new();
        for path in &removed {
            if let Some(sha) = docs[path].sha256.as_deref() {
                gone_by_sha.entry(sha).or_default().push(path);
            }
        }
        let mut renamed = Vec::new();
        for (path, item) in &fresh {
            if docs.contains_key(path) {
                continue;
            }
            if let Some(list) = item
                .sha256
                .as_deref()
                .and_then(|sha| gone_by_sha.get_mut(sha))
                && !list.is_empty()
            {
                let from = list.remove(0);
                renamed.push(Rename {
                    from: from.clone(),
                    to: path.clone(),
                });
            }
        }
        let added = fresh
            .keys()
            .filter(|path| !docs.contains_key(*path))
            .count()
            - renamed.len();
        let updated = fresh.keys().filter(|path| docs.contains_key(*path)).count();
        let removed_count = removed.len() - renamed.len();
        let changed = !fresh.is_empty() || !removed.is_empty();

        // 4. Apply.
        let mut affected_keys: BTreeSet<String> = BTreeSet::new();
        let mut leaving: Vec<String> = Vec::new();
        for path in removed.iter().chain(fresh.keys()) {
            if let Some((node_id, _)) = docs.get(path).and_then(|doc| doc.node.as_ref()) {
                affected_keys.extend(stored_keys(&tx, p, node_id)?);
                leaving.push(node_id.clone());
            }
        }
        let entering: Vec<(&String, &Fresh, &ParsedNote)> = fresh
            .iter()
            .filter_map(|(path, item)| match &item.outcome {
                Ok(note)
                    if !note.id_from_front_matter || winners.get(&note.node_id) == Some(path) =>
                {
                    Some((path, item, note))
                }
                _ => None,
            })
            .collect();
        for (path, _, note) in &entering {
            affected_keys.extend(parsed_keys(path, note));
        }
        let leaving_set: BTreeSet<&str> = leaving.iter().map(String::as_str).collect();
        let mut again: BTreeSet<(String, i64)> = BTreeSet::new();
        for key in &affected_keys {
            let mut statement = tx.prepare(
                "SELECT source_node_id, ordinal FROM knowledge_edges \
                 WHERE profile_id = ?1 AND target_key = ?2",
            )?;
            let rows = statement.query_map(params![p, key], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?;
            for row in rows {
                let (source, ordinal) = row?;
                if !leaving_set.contains(source.as_str()) {
                    again.insert((source, ordinal));
                }
            }
        }
        for node_id in &leaving {
            let mut statement = tx.prepare(
                "SELECT source_node_id, ordinal FROM knowledge_edges \
                 WHERE profile_id = ?1 AND target_node_id = ?2 \
                 UNION SELECT source_node_id, ordinal FROM knowledge_edge_candidates \
                 WHERE profile_id = ?1 AND candidate_node_id = ?2",
            )?;
            let rows = statement.query_map(params![p, node_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?;
            for row in rows {
                let (source, ordinal) = row?;
                if !leaving_set.contains(source.as_str()) {
                    again.insert((source, ordinal));
                }
            }
        }
        for (source, ordinal) in &again {
            unresolve(&tx, p, source, *ordinal)?;
        }
        // Outgoing edges of every leaving node first: they may target another leaving node.
        for node_id in &leaving {
            tx.execute(
                "DELETE FROM knowledge_edges WHERE profile_id = ?1 AND source_node_id = ?2",
                params![p, node_id],
            )?;
        }
        for node_id in &leaving {
            tx.execute(
                "DELETE FROM knowledge_fts WHERE rowid = \
                 (SELECT node_seq FROM knowledge_nodes WHERE profile_id = ?1 AND node_id = ?2)",
                params![p, node_id],
            )?;
            tx.execute(
                "DELETE FROM knowledge_nodes WHERE profile_id = ?1 AND node_id = ?2",
                params![p, node_id],
            )?;
        }
        for path in &removed {
            tx.execute(
                "DELETE FROM knowledge_documents WHERE profile_id = ?1 AND path = ?2",
                params![p, path],
            )?;
        }
        for (path, size, mtime_ns) in &touched {
            tx.execute(
                "UPDATE knowledge_documents SET size = ?3, mtime_ns = ?4 \
                 WHERE profile_id = ?1 AND path = ?2",
                params![p, path, size, mtime_ns],
            )?;
            tx.execute(
                "UPDATE knowledge_nodes SET source_mtime_ns = ?3 WHERE profile_id = ?1 AND path = ?2",
                params![p, path, mtime_ns],
            )?;
        }
        for (path, item) in &fresh {
            let (status, reason, claimed) = match &item.outcome {
                Ok(note)
                    if note.id_from_front_matter && winners.get(&note.node_id) != Some(path) =>
                {
                    (
                        "skipped",
                        Some(SkipReason::DuplicateId),
                        Some(&note.node_id),
                    )
                }
                Ok(_) => ("indexed", None, None),
                Err(reason) => ("skipped", Some(*reason), None),
            };
            tx.execute(
                "INSERT INTO knowledge_documents \
                 (profile_id, path, size, mtime_ns, sha256, status, skip_reason, claimed_id) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
                 ON CONFLICT (profile_id, path) DO UPDATE SET size = excluded.size, \
                 mtime_ns = excluded.mtime_ns, sha256 = excluded.sha256, \
                 status = excluded.status, skip_reason = excluded.skip_reason, \
                 claimed_id = excluded.claimed_id",
                params![
                    p,
                    path,
                    item.size,
                    item.mtime_ns,
                    item.sha256,
                    status,
                    reason.map(SkipReason::as_str),
                    claimed
                ],
            )?;
        }
        for (path, item, note) in &entering {
            insert_node(&tx, p, path, item, note, &observed_at)?;
        }

        if !entering.is_empty() || !again.is_empty() {
            let resolver = Resolver::new(load_note_refs(&tx, p)?);
            for (_, item, note) in &entering {
                let sha = item.sha256.as_deref().unwrap_or_default();
                for (ordinal, (link, target)) in note.links.iter().enumerate() {
                    let ordinal = i64::try_from(ordinal).unwrap_or(i64::MAX);
                    insert_edge(&tx, p, &note.node_id, ordinal, link, target, sha)?;
                    store_outcome(&tx, p, &note.node_id, ordinal, &resolver.resolve(target))?;
                }
            }
            for (source, ordinal) in &again {
                let target: Target = tx.query_row(
                    "SELECT target, target_key, path_only FROM knowledge_edges \
                     WHERE profile_id = ?1 AND source_node_id = ?2 AND ordinal = ?3",
                    params![p, source, ordinal],
                    |row| {
                        Ok(Target {
                            target: row.get(0)?,
                            key: row.get(1)?,
                            path_only: row.get(2)?,
                        })
                    },
                )?;
                store_outcome(&tx, p, source, *ordinal, &resolver.resolve(&target))?;
            }
        }
        if changed || mode == SyncMode::Rebuild {
            tx.execute(
                "UPDATE knowledge_index_state SET generation = generation + 1 WHERE profile_id = ?1",
                [p],
            )?;
        }

        let mut skipped: Vec<Skipped> = walk
            .skipped
            .iter()
            .map(|(path, reason)| Skipped {
                path: path.clone(),
                reason: *reason,
            })
            .collect();
        {
            let mut statement = tx.prepare(
                "SELECT path, skip_reason FROM knowledge_documents \
                 WHERE profile_id = ?1 AND status = 'skipped'",
            )?;
            let rows = statement.query_map([p], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (path, reason) = row?;
                let reason = SkipReason::parse(&reason).ok_or(KnowledgeError::Integrity)?;
                skipped.push(Skipped { path, reason });
            }
        }
        skipped.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
        let count = |sql: &str| -> Result<usize, KnowledgeError> {
            let value: i64 = tx.query_row(sql, [p], |row| row.get(0))?;
            Ok(usize::try_from(value).unwrap_or(0))
        };
        let notes = count("SELECT count(*) FROM knowledge_nodes WHERE profile_id = ?1")?;
        let unresolved_links = count(
            "SELECT count(*) FROM knowledge_edges WHERE profile_id = ?1 AND target_node_id IS NULL",
        )?;
        let generation: i64 = tx.query_row(
            "SELECT generation FROM knowledge_index_state WHERE profile_id = ?1",
            [p],
            |row| row.get(0),
        )?;
        tx.commit()?;
        Ok(IndexReport {
            generation: u64::try_from(generation).unwrap_or(0),
            notes,
            added,
            updated,
            removed: removed_count,
            unchanged,
            renamed,
            skipped,
            unresolved_links,
        })
    }
}

fn clear(tx: &Transaction<'_>, p: &str) -> Result<(), KnowledgeError> {
    tx.execute(
        "DELETE FROM knowledge_fts WHERE rowid IN \
         (SELECT node_seq FROM knowledge_nodes WHERE profile_id = ?1)",
        [p],
    )?;
    tx.execute(
        "DELETE FROM knowledge_edge_candidates WHERE profile_id = ?1",
        [p],
    )?;
    tx.execute("DELETE FROM knowledge_edges WHERE profile_id = ?1", [p])?;
    tx.execute("DELETE FROM knowledge_aliases WHERE profile_id = ?1", [p])?;
    tx.execute("DELETE FROM knowledge_nodes WHERE profile_id = ?1", [p])?;
    tx.execute("DELETE FROM knowledge_documents WHERE profile_id = ?1", [p])?;
    Ok(())
}

fn load_docs(tx: &Transaction<'_>, p: &str) -> Result<BTreeMap<String, DocRow>, KnowledgeError> {
    let mut statement = tx.prepare(
        "SELECT d.path, d.size, d.mtime_ns, d.sha256, d.skip_reason, d.claimed_id, \
         n.node_id, n.id_source \
         FROM knowledge_documents d LEFT JOIN knowledge_nodes n \
         ON n.profile_id = d.profile_id AND n.path = d.path \
         WHERE d.profile_id = ?1",
    )?;
    let rows = statement.query_map([p], |row| {
        let node_id: Option<String> = row.get(6)?;
        let id_source: Option<String> = row.get(7)?;
        let skip: Option<String> = row.get(4)?;
        Ok((
            row.get::<_, String>(0)?,
            DocRow {
                size: row.get(1)?,
                mtime_ns: row.get(2)?,
                sha256: row.get(3)?,
                skip: skip.as_deref().and_then(SkipReason::parse),
                claimed_id: row.get(5)?,
                node: node_id.map(|id| (id, id_source.as_deref() == Some("front_matter"))),
            },
        ))
    })?;
    let mut out = BTreeMap::new();
    for row in rows {
        let (path, doc) = row?;
        if doc.node.is_none() && doc.skip.is_none() {
            return Err(KnowledgeError::Integrity);
        }
        out.insert(path, doc);
    }
    Ok(out)
}

/// Lookup keys of a stored node.
fn stored_keys(
    tx: &Transaction<'_>,
    p: &str,
    node_id: &str,
) -> Result<Vec<String>, KnowledgeError> {
    let (path_key, stem_key): (String, String) = tx.query_row(
        "SELECT path_key, stem_key FROM knowledge_nodes WHERE profile_id = ?1 AND node_id = ?2",
        params![p, node_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let aliases = tx
        .prepare("SELECT alias_key FROM knowledge_aliases WHERE profile_id = ?1 AND node_id = ?2")?
        .query_map(params![p, node_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(resolve::note_keys(&path_key, &stem_key, &aliases))
}

fn path_keys(path: &str) -> (String, String) {
    let exact = resolve::strip_md(path);
    let stem = exact.rsplit('/').next().unwrap_or(exact);
    (exact.to_lowercase(), stem.to_lowercase())
}

fn alias_keys(note: &ParsedNote) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for alias in &note.front_matter.aliases {
        let key = alias.to_lowercase();
        if !out.iter().any(|(existing, _)| *existing == key) {
            out.push((key, alias.clone()));
        }
    }
    out
}

fn parsed_keys(path: &str, note: &ParsedNote) -> Vec<String> {
    let (path_key, stem_key) = path_keys(path);
    let aliases: Vec<String> = alias_keys(note).into_iter().map(|(key, _)| key).collect();
    resolve::note_keys(&path_key, &stem_key, &aliases)
}

fn insert_node(
    tx: &Transaction<'_>,
    p: &str,
    path: &str,
    item: &Fresh,
    note: &ParsedNote,
    observed_at: &str,
) -> Result<(), KnowledgeError> {
    let (path_key, stem_key) = path_keys(path);
    let json = |items: &[String]| serde_json::Value::from(items.to_vec()).to_string();
    let front = &note.front_matter;
    tx.execute(
        "INSERT INTO knowledge_nodes (profile_id, node_id, id_source, path, path_key, stem_key, \
         kind, title, tags_json, visibility, origin, trust_status, source_sha256, \
         source_mtime_ns, observed_at, declared_verification, declared_revision, \
         declared_source_task_ids) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'profile', 'vault', 'untrusted', ?10, ?11, \
         ?12, ?13, ?14, ?15)",
        params![
            p,
            note.node_id,
            if note.id_from_front_matter {
                "front_matter"
            } else {
                "path"
            },
            path,
            path_key,
            stem_key,
            note.kind,
            note.title,
            json(&front.tags),
            item.sha256.as_deref().unwrap_or_default(),
            item.mtime_ns,
            observed_at,
            front.verification,
            front.revision,
            json(&front.source_task_ids),
        ],
    )?;
    let node_seq = tx.last_insert_rowid();
    let aliases = alias_keys(note);
    for (key, alias) in &aliases {
        tx.execute(
            "INSERT INTO knowledge_aliases (profile_id, node_id, alias, alias_key) \
             VALUES (?1, ?2, ?3, ?4)",
            params![p, note.node_id, alias, key],
        )?;
    }
    let alias_text = aliases
        .iter()
        .map(|(_, alias)| alias.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    tx.execute(
        "INSERT INTO knowledge_fts (rowid, title, aliases, body) VALUES (?1, ?2, ?3, ?4)",
        params![node_seq, note.title, alias_text, note.body],
    )?;
    Ok(())
}

fn insert_edge(
    tx: &Transaction<'_>,
    p: &str,
    source: &str,
    ordinal: i64,
    link: &Link,
    target: &Target,
    sha: &str,
) -> Result<(), KnowledgeError> {
    tx.prepare(
        "INSERT INTO knowledge_edges (profile_id, source_node_id, ordinal, edge_type, embed, \
         line, target_text, target, target_key, path_only, heading, display, target_node_id, \
         resolution, visibility, source_sha256) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL, 'missing', 'profile', ?13)",
    )?
    .execute(params![
        p,
        source,
        ordinal,
        link.edge_type.as_str(),
        link.embed,
        link.line,
        link.target,
        target.target,
        target.key,
        target.path_only,
        link.heading.as_deref().map(|text| clip(text, links::MAX_LINK_BYTES)),
        link.display.as_deref().map(|text| clip(text, links::MAX_LINK_BYTES)),
        sha,
    ])?;
    Ok(())
}

fn unresolve(
    tx: &Transaction<'_>,
    p: &str,
    source: &str,
    ordinal: i64,
) -> Result<(), KnowledgeError> {
    tx.prepare(
        "DELETE FROM knowledge_edge_candidates \
         WHERE profile_id = ?1 AND source_node_id = ?2 AND ordinal = ?3",
    )?
    .execute(params![p, source, ordinal])?;
    tx.prepare(
        "UPDATE knowledge_edges SET target_node_id = NULL, resolution = 'missing' \
         WHERE profile_id = ?1 AND source_node_id = ?2 AND ordinal = ?3",
    )?
    .execute(params![p, source, ordinal])?;
    Ok(())
}

fn store_outcome(
    tx: &Transaction<'_>,
    p: &str,
    source: &str,
    ordinal: i64,
    outcome: &Outcome,
) -> Result<(), KnowledgeError> {
    let target = match outcome {
        Outcome::Resolved(_, node_id) => Some(node_id.as_str()),
        _ => None,
    };
    tx.prepare(
        "UPDATE knowledge_edges SET target_node_id = ?4, resolution = ?5 \
         WHERE profile_id = ?1 AND source_node_id = ?2 AND ordinal = ?3",
    )?
    .execute(params![
        p,
        source,
        ordinal,
        target,
        outcome.resolution().as_str()
    ])?;
    if let Outcome::Ambiguous(candidates) = outcome {
        for candidate in candidates {
            tx.prepare(
                "INSERT INTO knowledge_edge_candidates \
                 (profile_id, source_node_id, ordinal, candidate_node_id) VALUES (?1, ?2, ?3, ?4)",
            )?
            .execute(params![p, source, ordinal, candidate])?;
        }
    }
    Ok(())
}

fn load_note_refs(tx: &Transaction<'_>, p: &str) -> Result<Vec<NoteRef>, KnowledgeError> {
    let mut aliases: BTreeMap<String, Vec<String>> = BTreeMap::new();
    {
        let mut statement = tx.prepare(
            "SELECT node_id, alias FROM knowledge_aliases WHERE profile_id = ?1 \
             ORDER BY node_id, alias",
        )?;
        let rows = statement.query_map([p], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (node_id, alias) = row?;
            aliases.entry(node_id).or_default().push(alias);
        }
    }
    let mut statement =
        tx.prepare("SELECT node_id, path FROM knowledge_nodes WHERE profile_id = ?1")?;
    let rows = statement.query_map([p], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (node_id, path) = row?;
        out.push(NoteRef {
            aliases: aliases.remove(&node_id).unwrap_or_default(),
            node_id,
            path,
        });
    }
    Ok(out)
}
