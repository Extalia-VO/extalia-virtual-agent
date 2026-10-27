//! Knowledge tests (temporary directories only).

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::frontmatter::{self, FrontMatter};
use super::links::{self, EdgeType, Link};
use super::resolve::{self, NoteRef, Outcome, Resolution, Resolver};
use super::store::{self, KnowledgeStore};
use super::*;
use crate::skills::ProfileId;

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        loop {
            let dir = std::env::temp_dir().join(format!(
                "extalia-knowledge-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&dir) {
                Ok(()) => return Self(dir),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
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

fn profile(id: &str) -> ProfileId {
    ProfileId::parse(id).unwrap()
}

/// A data directory with an opened vault and index for one profile.
struct Fixture {
    dir: TempDir,
    profile: ProfileId,
    vault: Vault,
    store: KnowledgeStore,
    /// Monotonic old mtimes, so stat-based change detection is exercised deterministically.
    clock: u64,
}

impl Fixture {
    fn new(id: &str) -> Self {
        Self::with_limits(id, VaultLimits::default())
    }

    fn with_limits(id: &str, limits: VaultLimits) -> Self {
        let dir = TempDir::new();
        let profile = profile(id);
        let vault = Vault::open_default(&dir.0, &profile, limits).unwrap();
        let store = KnowledgeStore::open(&dir.0, &profile).unwrap();
        Self {
            dir,
            profile,
            vault,
            store,
            clock: 1_600_000_000,
        }
    }

    fn root(&self) -> PathBuf {
        self.dir.0.join("vaults").join(self.profile.as_str())
    }

    fn scope(&self) -> ProfileScope {
        ProfileScope::new(self.profile.clone())
    }

    fn write(&mut self, rel: &str, content: impl AsRef<[u8]>) {
        let path = self.root().join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, content).unwrap();
        self.clock += 10;
        let file = fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(UNIX_EPOCH + Duration::from_secs(self.clock))
            .unwrap();
    }

    fn remove(&self, rel: &str) {
        fs::remove_file(self.root().join(rel)).unwrap();
    }

    fn rename(&self, from: &str, to: &str) {
        let to_path = self.root().join(to);
        fs::create_dir_all(to_path.parent().unwrap()).unwrap();
        fs::rename(self.root().join(from), to_path).unwrap();
    }

    fn sync(&mut self) -> IndexReport {
        self.store.sync(&self.vault, SyncMode::Incremental).unwrap()
    }

    fn rebuild(&mut self) -> IndexReport {
        self.store.sync(&self.vault, SyncMode::Rebuild).unwrap()
    }

    fn node(&self, id: &str) -> Option<NodeView> {
        self.store.node(&self.scope(), id).unwrap()
    }

    fn id_at(&self, path: &str) -> String {
        self.store
            .node_by_path(&self.scope(), path)
            .unwrap()
            .unwrap_or_else(|| panic!("{path} is not indexed"))
            .node_id
    }

    fn outgoing(&self, id: &str) -> Vec<EdgeView> {
        self.store.outgoing(&self.scope(), id).unwrap()
    }

    fn targets(&self, id: &str) -> Vec<LinkTarget> {
        self.outgoing(id)
            .into_iter()
            .map(|edge| edge.target)
            .collect()
    }

    fn backlink_sources(&self, id: &str) -> Vec<String> {
        self.store
            .backlinks(&self.scope(), id)
            .unwrap()
            .into_iter()
            .map(|edge| edge.source_node_id)
            .collect()
    }

    fn search(&self, text: &str) -> Vec<String> {
        self.store
            .search(&self.scope(), text, 50)
            .unwrap()
            .into_iter()
            .map(|hit| hit.path)
            .collect()
    }

    /// Every derived row except `node_seq` and `observed_at`, sorted.
    fn snapshot(&self) -> Vec<String> {
        let conn = &self.store.conn;
        let mut out = Vec::new();
        for sql in [
            "SELECT 'doc', path, size, mtime_ns, sha256, status, skip_reason, claimed_id \
             FROM knowledge_documents",
            "SELECT 'node', node_id, id_source, path, path_key, stem_key, kind, title, tags_json, \
             visibility, origin, trust_status, source_sha256, source_mtime_ns, \
             declared_verification, declared_revision, declared_source_task_ids \
             FROM knowledge_nodes",
            "SELECT 'alias', node_id, alias, alias_key FROM knowledge_aliases",
            "SELECT 'edge', source_node_id, ordinal, edge_type, embed, line, target_text, target, \
             target_key, path_only, heading, display, target_node_id, resolution, visibility, \
             source_sha256 FROM knowledge_edges",
            "SELECT 'candidate', source_node_id, ordinal, candidate_node_id \
             FROM knowledge_edge_candidates",
            // Each node has exactly its own FTS row.
            "SELECT 'fts', n.node_id FROM knowledge_nodes n \
             WHERE n.node_seq IN (SELECT rowid FROM knowledge_fts)",
            "SELECT 'fts-count', count(*) FROM knowledge_fts",
        ] {
            let mut statement = conn.prepare(sql).unwrap();
            let columns = statement.column_count();
            let rows = statement
                .query_map([], |row| {
                    let mut text = Vec::new();
                    for index in 0..columns {
                        let value: rusqlite::types::Value = row.get(index)?;
                        text.push(format!("{value:?}"));
                    }
                    Ok(text.join("|"))
                })
                .unwrap();
            for row in rows {
                out.push(row.unwrap());
            }
        }
        out.sort();
        out
    }
}

fn resolved(id: &str, via: Resolution) -> LinkTarget {
    LinkTarget::Resolved {
        node_id: id.to_owned(),
        via,
    }
}

fn link_targets(body: &str) -> Vec<String> {
    links::parse(body, 1)
        .links
        .into_iter()
        .map(|link| link.target)
        .collect()
}

// ---------------------------------------------------------------- front matter

#[test]
fn front_matter_subset_is_parsed() {
    let text = [
        "---",
        "id: know.laravel.n-plus-one",
        "kind: knowledge",
        "profile: work",
        "verification: verified # only a mirror",
        "source_task_ids: [task-123, \"task-456\"]",
        "revision: 3",
        "aliases:",
        "  - N+1 Query Optimization",
        "  - 'Eager loading'",
        "tags: [\"#laravel\", db]",
        "cssclasses:",
        "  nested: { a: 1 }",
        "description: |",
        "  free text: with colons",
        "---",
        "# Title",
        "",
    ]
    .join("\r\n");
    let text = text.as_str();
    let split = frontmatter::split(text).unwrap();
    assert_eq!(
        split.front_matter,
        FrontMatter {
            id: Some("know.laravel.n-plus-one".into()),
            kind: Some("knowledge".into()),
            profile: Some(profile("work")),
            verification: Some("verified".into()),
            source_task_ids: vec!["task-123".into(), "task-456".into()],
            revision: Some(3),
            aliases: vec!["N+1 Query Optimization".into(), "Eager loading".into()],
            tags: vec!["laravel".into(), "db".into()],
            extra_keys: vec!["cssclasses".into(), "description".into()],
        }
    );
    assert_eq!(split.body, "# Title\r\n");
    assert_eq!(split.body_first_line, 17);
}

#[test]
fn front_matter_is_strict() {
    let no_front_matter = frontmatter::split("# Just a note\n---\n").unwrap();
    assert_eq!(no_front_matter.front_matter, FrontMatter::default());
    assert_eq!(no_front_matter.body_first_line, 1);
    let empty = frontmatter::split("---\n---\nbody").unwrap();
    assert_eq!(empty.body, "body");
    let nulls =
        frontmatter::split("---\nid: ~\ntags: # none\naliases:\nkind: null\n---\n").unwrap();
    assert_eq!(nulls.front_matter, FrontMatter::default());
    for invalid in [
        "---\nid: a\n",                       // unterminated
        "---\nid: a\nid: b\n---\n",           // duplicate key
        "---\nid: Has Spaces\n---\n",         // invalid id
        "---\nid: a:b\n---\n",                // ':' reserved for derived ids
        "---\nprofile: Work!\n---\n",         // invalid profile id
        "---\nrevision: -1\n---\n",           // not a non-negative integer
        "---\nkind: &anchor note\n---\n",     // anchors are not in the subset
        "---\naliases: |\n  text\n---\n",     // block scalar on a known key
        "---\naliases: [a, [b]]\n---\n",      // nested sequence
        "---\naliases: [unterminated\n---\n", // unclosed flow sequence
        "---\nkind: \"bad \\x escape\"\n---\n",
        "---\n  indented: value\n---\n", // indentation without a key
        "---\n- item\n---\n",            // list without a key
        "---\nnot a key line\n---\n",
        "---\naliases: [\"[[link]]\"]\n---\n", // link syntax in an alias
    ] {
        assert!(frontmatter::split(invalid).is_err(), "accepted {invalid:?}");
    }
}

// ---------------------------------------------------------------- wikilinks

#[test]
fn wikilink_forms() {
    let parsed = links::parse(
        "# Main *Title* #\n\
         See [[Target]], [[Other|shown text]] and [[Deep#Section|alias]].\n\
         ![[folder/Image]] and ![[Note#^block-1]]\n\
         | [[Table\\|cell]] |\n\
         [[ spaced target ]] [[#Only heading]] [[]] [[a [[nested]]\n",
        10,
    );
    assert_eq!(parsed.title.as_deref(), Some("Main *Title*"));
    let link = |target: &str, heading: Option<&str>, display: Option<&str>, embed, line| Link {
        target: target.into(),
        heading: heading.map(Into::into),
        display: display.map(Into::into),
        embed,
        edge_type: EdgeType::LinksTo,
        line,
    };
    assert_eq!(
        parsed.links,
        vec![
            link("Target", None, None, false, 11),
            link("Other", None, Some("shown text"), false, 11),
            link("Deep", Some("Section"), Some("alias"), false, 11),
            link("folder/Image", None, None, true, 12),
            link("Note", Some("^block-1"), None, true, 12),
            link("Table", None, Some("cell"), false, 13),
            link("spaced target", None, None, false, 14),
            link("nested", None, None, false, 14),
        ]
    );
}

#[test]
fn code_and_escapes_are_not_links() {
    let body = "Before [[A]]\n\
        ```rust\n\
        let x = \"[[InFence]]\";\n\
        ```\n\
        ~~~~\n\
        [[InTilde]]\n\
        ~~~\n\
        still fenced [[InTilde2]]\n\
        ~~~~\n\
        Inline `[[InCode]]` and ``a ` [[InDouble]]`` but [[B]]\n\
        Escaped \\[[NotLink]] and \\![[NotEmbed]] and \\\\[[C]]\n\
        Unclosed `tick then [[D]]\n\
        Unclosed [[link\n\
        ```\n\
        [[InUnclosedFence]]\n";
    // `\!` only escapes the embed mark: the link stays, as a plain link.
    assert_eq!(link_targets(body), ["A", "B", "NotEmbed", "C", "D"]);
    let embeds: Vec<bool> = links::parse("\\![[x]] ![[y]]", 1)
        .links
        .iter()
        .map(|link| link.embed)
        .collect();
    assert_eq!(embeds, [false, true]);
}

#[test]
fn typed_lines_set_edge_types() {
    let parsed = links::parse(
        "Related: [[Laravel Eloquent]], [[MySQL Indexing]]\n\
         Learned from: [[Experiences/Example-Query-Optimization]]\n\
         - **Depends on**: [[Base]]\n\
         * supersedes: [[Old]]\n\
         1. Used_by: [[Consumer]]\n\
         learned-from: [[Other]]\n\
         Note: [[Plain]]\n\
         [[Head]]: related: [[Plain2]]\n",
        1,
    );
    let types: Vec<(&str, EdgeType)> = parsed
        .links
        .iter()
        .map(|link| (link.target.as_str(), link.edge_type))
        .collect();
    assert_eq!(
        types,
        [
            ("Laravel Eloquent", EdgeType::RelatedTo),
            ("MySQL Indexing", EdgeType::RelatedTo),
            (
                "Experiences/Example-Query-Optimization",
                EdgeType::LearnedFrom
            ),
            ("Base", EdgeType::DependsOn),
            ("Old", EdgeType::Supersedes),
            ("Consumer", EdgeType::UsedBy),
            ("Other", EdgeType::LearnedFrom),
            ("Plain", EdgeType::LinksTo),
            ("Head", EdgeType::LinksTo),
            ("Plain2", EdgeType::LinksTo),
        ]
    );
}

// ---------------------------------------------------------------- resolution

#[test]
fn targets_are_normalized() {
    let norm = |source: &str, raw: &str| {
        let target = resolve::normalize(source, raw);
        (target.target, target.key, target.path_only)
    };
    assert_eq!(
        norm("a/b.md", "Note.MD"),
        ("Note".into(), "note".into(), false)
    );
    assert_eq!(
        norm("a/b.md", "./Sib"),
        ("a/Sib".into(), "a/sib".into(), true)
    );
    assert_eq!(
        norm("a/b/c.md", "../Up"),
        ("a/Up".into(), "a/up".into(), true)
    );
    assert_eq!(
        norm("a/b.md", "/Root/X"),
        ("Root/X".into(), "root/x".into(), true)
    );
    assert_eq!(
        norm("a/b.md", "folder//Ünïcode"),
        ("folder/Ünïcode".into(), "folder/ünïcode".into(), false)
    );
    // Climbing above the root never matches an indexed path.
    let escaped = resolve::normalize("top.md", "../../etc/passwd");
    assert!(escaped.key.starts_with(".."));
    assert!(escaped.path_only);
}

fn note(id: &str, path: &str, aliases: &[&str]) -> NoteRef {
    NoteRef {
        node_id: id.into(),
        path: path.into(),
        aliases: aliases.iter().map(|alias| (*alias).to_owned()).collect(),
    }
}

#[test]
fn resolution_tiers_and_disambiguation() {
    let resolver = Resolver::new([
        note("root", "Topic.md", &[]),
        note("nested", "notes/Topic.md", &[]),
        note("deep", "a/folder/Leaf.md", &[]),
        note("other-leaf", "b/Leaf.md", &[]),
        note("twin-1", "x/Twin.md", &["Shared"]),
        note("twin-2", "y/twin.md", &[]),
        note("alias-owner", "Owner.md", &["Nick", "nick"]),
        note("alias-twin", "Owner2.md", &["Shared"]),
        note("case-a", "c/Case.md", &[]),
        note("case-b", "d/CASE.md", &[]),
    ]);
    let resolve = |source: &str, raw: &str| resolver.resolve(&resolve::normalize(source, raw));
    // Exact path beats a title match elsewhere.
    assert_eq!(
        resolve("z.md", "Topic"),
        Outcome::Resolved(Resolution::Path, "root".into())
    );
    assert_eq!(
        resolve("z.md", "notes/topic"),
        Outcome::Resolved(Resolution::Path, "nested".into())
    );
    // Folder form matches a unique path suffix.
    assert_eq!(
        resolve("z.md", "folder/Leaf"),
        Outcome::Resolved(Resolution::PathSuffix, "deep".into())
    );
    // Same title twice, no exact-case winner: ambiguous with sorted candidates; the alias
    // tier below is not consulted.
    assert_eq!(
        resolve("z.md", "Leaf"),
        Outcome::Ambiguous(vec!["deep".into(), "other-leaf".into()])
    );
    assert_eq!(
        resolve("z.md", "shared"),
        Outcome::Ambiguous(vec!["alias-twin".into(), "twin-1".into()])
    );
    assert_eq!(
        resolve("z.md", "TWIN"),
        Outcome::Ambiguous(vec!["twin-1".into(), "twin-2".into()])
    );
    // Exactly one exact-case candidate wins.
    assert_eq!(
        resolve("z.md", "Twin"),
        Outcome::Resolved(Resolution::Title, "twin-1".into())
    );
    assert_eq!(
        resolve("z.md", "CASE"),
        Outcome::Resolved(Resolution::Title, "case-b".into())
    );
    // Aliases are case-insensitive and deduplicated per note.
    assert_eq!(
        resolve("z.md", "NICK"),
        Outcome::Resolved(Resolution::Alias, "alias-owner".into())
    );
    // Path-only targets use the path tier only.
    assert_eq!(
        resolve("z.md", "/Owner2"),
        Outcome::Resolved(Resolution::Path, "alias-twin".into())
    );
    assert_eq!(resolve("z.md", "/Nick"), Outcome::Missing);
    assert_eq!(
        resolve("notes/Topic.md", "./Topic"),
        Outcome::Resolved(Resolution::Path, "nested".into())
    );
    assert_eq!(resolve("Topic.md", "../Topic"), Outcome::Missing);
    assert_eq!(resolve("z.md", "Nowhere"), Outcome::Missing);
}

// ---------------------------------------------------------------- index

const EXAMPLE: &str = "---\n\
id: know.laravel.n-plus-one\n\
kind: knowledge\n\
profile: work\n\
verification: verified\n\
source_task_ids: [task-123]\n\
revision: 3\n\
---\n\
# N+1 Query Optimization\n\
Related: [[Laravel Eloquent]], [[MySQL Indexing]]\n\
Learned from: [[Experiences/Example-Query-Optimization]]\n";

#[test]
fn indexes_the_prd_example_with_provenance() {
    let mut fx = Fixture::new("work");
    fx.write("Knowledge/N+1.md", EXAMPLE);
    fx.write("Knowledge/Laravel Eloquent.md", "# Eloquent\nORM notes.");
    fx.write(
        "Experiences/Example-Query-Optimization.md",
        "---\naliases: [Query story]\n---\nWe fixed it.",
    );
    let report = fx.sync();
    assert_eq!(
        (report.notes, report.added, report.unresolved_links),
        (3, 3, 1)
    );
    assert_eq!(report.generation, 1);

    let node = fx.node("know.laravel.n-plus-one").unwrap();
    assert_eq!(node.path, "Knowledge/N+1.md");
    assert_eq!(node.kind, "knowledge");
    assert_eq!(node.title, "N+1 Query Optimization");
    assert!(node.id_from_front_matter);
    assert_eq!(
        (node.origin.as_str(), node.trust_status.as_str()),
        ("vault", "untrusted")
    );
    assert_eq!(node.declared_verification.as_deref(), Some("verified"));
    assert_eq!(node.declared_revision, Some(3));
    assert_eq!(node.declared_source_task_ids, ["task-123"]);
    assert_eq!(
        node.source_sha256,
        crate::sha256::hex_digest(EXAMPLE.as_bytes())
    );

    let edges = fx.outgoing("know.laravel.n-plus-one");
    let summary: Vec<(EdgeType, &str, &LinkTarget, u32)> = edges
        .iter()
        .map(|edge| {
            (
                edge.edge_type,
                edge.target_text.as_str(),
                &edge.target,
                edge.line,
            )
        })
        .collect();
    let eloquent = "path:Knowledge/Laravel Eloquent.md";
    let story = "path:Experiences/Example-Query-Optimization.md";
    assert_eq!(
        summary,
        [
            (
                EdgeType::RelatedTo,
                "Laravel Eloquent",
                &resolved(eloquent, Resolution::Title),
                10
            ),
            (
                EdgeType::RelatedTo,
                "MySQL Indexing",
                &LinkTarget::Missing,
                10
            ),
            (
                EdgeType::LearnedFrom,
                "Experiences/Example-Query-Optimization",
                &resolved(story, Resolution::Path),
                11
            ),
        ]
    );
    assert_eq!(fx.backlink_sources(story), ["know.laravel.n-plus-one"]);
    assert_eq!(fx.node(story).unwrap().aliases, ["Query story"]);
    assert_eq!(fx.node(eloquent).unwrap().title, "Eloquent");

    // A second sync with nothing changed reads nothing and keeps the generation.
    let again = fx.sync();
    assert_eq!((again.unchanged, again.added, again.updated), (3, 0, 0));
    assert_eq!(again.generation, 1);
}

#[test]
fn ambiguous_links_keep_candidates_until_resolved() {
    let mut fx = Fixture::new("work");
    fx.write("a/Topic.md", "first");
    fx.write("b/Topic.md", "second");
    fx.write("Index.md", "[[topic]] and [[a/Topic]]");
    fx.sync();
    let index = fx.id_at("Index.md");
    assert_eq!(
        fx.targets(&index),
        [
            LinkTarget::Ambiguous {
                candidates: vec!["path:a/Topic.md".into(), "path:b/Topic.md".into()]
            },
            resolved("path:a/Topic.md", Resolution::Path),
        ]
    );
    assert_eq!(
        fx.store
            .sync(&fx.vault, SyncMode::Incremental)
            .unwrap()
            .unresolved_links,
        1
    );
    fx.remove("b/Topic.md");
    let report = fx.sync();
    assert_eq!((report.removed, report.unresolved_links), (1, 0));
    assert_eq!(
        fx.targets(&index)[0],
        resolved("path:a/Topic.md", Resolution::Title)
    );
    // A new exact path match beats the title match.
    fx.write("topic.md", "root");
    fx.sync();
    assert_eq!(
        fx.targets(&index)[0],
        resolved("path:topic.md", Resolution::Path)
    );
}

#[test]
fn renames_are_detected_by_content_hash() {
    let mut fx = Fixture::new("work");
    fx.write("Old Name.md", "---\nid: stable.note\n---\nbody one");
    fx.write("Plain.md", "plain body");
    fx.write(
        "Links.md",
        "[[Old Name]] [[Plain]] [[New Name]] [[Moved/Plain]]",
    );
    fx.sync();
    let links = fx.id_at("Links.md");
    fx.rename("Old Name.md", "New Name.md");
    fx.rename("Plain.md", "Moved/Plain.md");
    let report = fx.sync();
    assert_eq!(
        report.renamed,
        [
            Rename {
                from: "Plain.md".into(),
                to: "Moved/Plain.md".into()
            },
            Rename {
                from: "Old Name.md".into(),
                to: "New Name.md".into()
            },
        ]
    );
    assert_eq!((report.added, report.removed, report.notes), (0, 0, 3));
    // A front matter id survives the rename; a derived id follows the path.
    assert_eq!(fx.node("stable.note").unwrap().path, "New Name.md");
    assert!(fx.node("path:Plain.md").is_none());
    assert_eq!(
        fx.targets(&links),
        [
            LinkTarget::Missing,
            resolved("path:Moved/Plain.md", Resolution::Title),
            resolved("stable.note", Resolution::Path),
            resolved("path:Moved/Plain.md", Resolution::Path),
        ]
    );
}

#[test]
fn deletions_and_broken_links() {
    let mut fx = Fixture::new("work");
    fx.write("A.md", "[[B]] [[Missing]]");
    fx.write("B.md", "target");
    let first = fx.sync();
    let a = fx.id_at("A.md");
    assert_eq!(fx.backlink_sources("path:B.md"), std::slice::from_ref(&a));
    fx.remove("B.md");
    let report = fx.sync();
    assert_eq!(
        (report.removed, report.notes, report.unresolved_links),
        (1, 1, 2)
    );
    assert!(report.generation > first.generation);
    assert_eq!(fx.targets(&a), [LinkTarget::Missing, LinkTarget::Missing]);
    // The broken link resolves as soon as its target exists.
    fx.write("missing.md", "now here");
    fx.sync();
    assert_eq!(
        fx.targets(&a),
        [
            LinkTarget::Missing,
            resolved("path:missing.md", Resolution::Path)
        ]
    );
    // Deleting the source removes its edges and backlinks.
    fx.remove("A.md");
    fx.sync();
    assert!(fx.backlink_sources("path:missing.md").is_empty());
    assert!(fx.outgoing(&a).is_empty());
}

#[test]
fn cycles_and_self_links_are_allowed() {
    let mut fx = Fixture::new("work");
    fx.write("A.md", "[[B]] [[A]]");
    fx.write("B.md", "[[C]]");
    fx.write("C.md", "[[A]]");
    fx.write("D.md", "[[C]]");
    fx.sync();
    let (a, b, c, d) = ("path:A.md", "path:B.md", "path:C.md", "path:D.md");
    assert_eq!(fx.backlink_sources(a), [a, c]);
    let graph = fx.store.local_graph(&fx.scope(), a, 3, 100).unwrap();
    assert_eq!(
        graph.nodes.keys().map(String::as_str).collect::<Vec<_>>(),
        [a, b, c, d]
    );
    assert_eq!(graph.edges.len(), 5);
    assert!(!graph.truncated);
    let near = fx.store.local_graph(&fx.scope(), a, 1, 100).unwrap();
    assert_eq!(near.nodes.len(), 3);
    let capped = fx.store.local_graph(&fx.scope(), a, 3, 2).unwrap();
    assert_eq!(capped.nodes.len(), 2);
    assert!(capped.truncated);
}

#[test]
fn overview_ranks_by_degree_and_keeps_only_distinct_resolved_links() {
    let mut fx = Fixture::new("work");
    fx.write(
        "Hub.md",
        "[[A]] [[A]] [[B]] [[C]] [[Missing]] [[Dup]] [[Hub]]\nRelated: [[A]]\n",
    );
    fx.write("A.md", "---\ntags: [x, y]\n---\n[[Hub]]");
    fx.write("B.md", "[[A]]");
    fx.write("C.md", "no links");
    fx.write("X/Dup.md", "");
    fx.write("Y/Dup.md", "");
    fx.sync();
    let (hub, a, b, c) = ("path:Hub.md", "path:A.md", "path:B.md", "path:C.md");
    let scope = fx.scope();
    let all = fx.store.overview_nodes(&scope, 100).unwrap();
    // Hub→A twice as links_to collapses; links_to and related_to stay apart; the missing,
    // ambiguous and self links are left out.
    assert_eq!((all.total_nodes, all.total_edges), (6, 6));
    let ranked: Vec<(&str, u64, u64)> = all
        .nodes
        .iter()
        .map(|node| (node.node_id.as_str(), node.in_degree, node.out_degree))
        .collect();
    assert_eq!(
        ranked,
        [
            (hub, 1, 4),
            (a, 3, 1),
            (b, 1, 1),
            (c, 1, 0),
            ("path:X/Dup.md", 0, 0),
            ("path:Y/Dup.md", 0, 0),
        ]
    );
    assert_eq!(all.nodes[1].tags, ["x", "y"]);
    assert_eq!(all.nodes[1].path, "A.md");
    assert_eq!(all.nodes[0].degree(), 5);
    let ids: Vec<&str> = all.nodes.iter().map(|node| node.node_id.as_str()).collect();
    let edges: Vec<(String, String, EdgeType)> = fx
        .store
        .overview_edges(&scope, &ids, 100)
        .unwrap()
        .into_iter()
        .map(|edge| (edge.source, edge.target, edge.edge_type))
        .collect();
    let edge = |s: &str, t: &str, k| (s.to_owned(), t.to_owned(), k);
    assert_eq!(
        edges,
        [
            edge(a, hub, EdgeType::LinksTo),
            edge(hub, a, EdgeType::LinksTo),
            edge(hub, a, EdgeType::RelatedTo),
            edge(hub, b, EdgeType::LinksTo),
            edge(b, a, EdgeType::LinksTo),
            edge(hub, c, EdgeType::LinksTo),
        ]
    );
    // Limits keep the most connected notes and the heaviest edges among them only.
    let top = fx.store.overview_nodes(&scope, 2).unwrap();
    assert_eq!(top.total_nodes, 6);
    let top_ids: Vec<&str> = top.nodes.iter().map(|node| node.node_id.as_str()).collect();
    assert_eq!(top_ids, [hub, a]);
    let top_edges = fx.store.overview_edges(&scope, &top_ids, 2).unwrap();
    assert_eq!(
        top_edges
            .iter()
            .map(|edge| (edge.source.as_str(), edge.target.as_str()))
            .collect::<Vec<_>>(),
        [(a, hub), (hub, a)]
    );
    assert!(fx.store.overview_edges(&scope, &[], 10).unwrap().is_empty());
    assert!(
        fx.store
            .overview_edges(&scope, &[c], 10)
            .unwrap()
            .is_empty()
    );
    // Another profile's scope sees nothing.
    let other = ProfileScope::new(profile("personal"));
    assert_eq!(
        fx.store.overview_nodes(&other, 100).unwrap(),
        OverviewNodes::default()
    );
    assert!(
        fx.store
            .overview_edges(&other, &ids, 100)
            .unwrap()
            .is_empty()
    );
}

#[cfg(unix)]
#[test]
fn symlinks_never_leave_the_root() {
    let mut fx = Fixture::new("work");
    let outside = TempDir::new();
    fs::write(outside.0.join("secret.md"), "classified-word").unwrap();
    fs::create_dir(outside.0.join("dir")).unwrap();
    fs::write(outside.0.join("dir").join("inner.md"), "classified-word").unwrap();
    fx.write("Visible.md", "[[secret]] [[inner]]");
    let root = fx.root();
    std::os::unix::fs::symlink(outside.0.join("secret.md"), root.join("secret.md")).unwrap();
    std::os::unix::fs::symlink(outside.0.join("dir"), root.join("linked")).unwrap();
    fs::create_dir(root.join(".obsidian")).unwrap();
    fs::write(root.join(".obsidian").join("hidden.md"), "classified-word").unwrap();
    fs::write(root.join(".hidden.md"), "classified-word").unwrap();
    fs::write(root.join("attachment.png"), "classified-word").unwrap();
    let report = fx.sync();
    assert_eq!(report.notes, 1);
    assert_eq!(
        report.skipped,
        [
            Skipped {
                path: "linked".into(),
                reason: SkipReason::Symlink
            },
            Skipped {
                path: "secret.md".into(),
                reason: SkipReason::Symlink
            },
        ]
    );
    assert!(fx.search("classified").is_empty());
    let visible = fx.id_at("Visible.md");
    assert_eq!(
        fx.targets(&visible),
        [LinkTarget::Missing, LinkTarget::Missing]
    );

    // A vault root that is itself a link is unavailable, never followed.
    let data = TempDir::new();
    let target = TempDir::new();
    fs::create_dir(data.0.join("vaults")).unwrap();
    std::os::unix::fs::symlink(&target.0, data.0.join("vaults").join("work")).unwrap();
    assert!(matches!(
        Vault::open_default(&data.0, &profile("work"), VaultLimits::default()),
        Err(KnowledgeError::VaultUnavailable)
    ));
}

#[test]
fn oversize_and_non_utf8_notes_are_skipped() {
    let limits = VaultLimits {
        max_file_bytes: 64,
        ..VaultLimits::default()
    };
    let mut fx = Fixture::with_limits("work", limits);
    fx.write("Big.md", "x".repeat(65));
    fx.write("Latin1.md", [b'c', b'a', b'f', 0xe9]);
    fx.write("Bom.md", "\u{feff}---\nid: bom.note\n---\nok");
    fx.write("Ok.md", "[[Big]] [[Latin1]]");
    let report = fx.sync();
    assert_eq!(report.notes, 2);
    assert!(fx.node("bom.note").is_some());
    assert_eq!(
        report.skipped,
        [
            Skipped {
                path: "Big.md".into(),
                reason: SkipReason::TooLarge
            },
            Skipped {
                path: "Latin1.md".into(),
                reason: SkipReason::NotUtf8
            },
        ]
    );
    let ok = fx.id_at("Ok.md");
    assert_eq!(fx.targets(&ok), [LinkTarget::Missing, LinkTarget::Missing]);
    // Unchanged skipped files are not read again; fixed files are indexed.
    assert_eq!(fx.sync().unchanged, 4);
    fx.write("Latin1.md", "café");
    fx.write("Big.md", "small now");
    let report = fx.sync();
    assert!(report.skipped.is_empty());
    assert_eq!(report.notes, 4);
    assert_eq!(
        fx.targets(&ok),
        [
            resolved("path:Big.md", Resolution::Path),
            resolved("path:Latin1.md", Resolution::Path)
        ]
    );
    // Too many notes fails the sync and leaves the index as it was.
    let limits = VaultLimits {
        max_notes: 1,
        ..VaultLimits::default()
    };
    let small = Vault::open_default(&fx.dir.0, &fx.profile, limits).unwrap();
    let generation = fx.store.generation().unwrap();
    assert!(matches!(
        fx.store.sync(&small, SyncMode::Incremental),
        Err(KnowledgeError::VaultTooLarge)
    ));
    assert_eq!(fx.store.generation().unwrap(), generation);
    assert_eq!(fx.search("café"), ["Latin1.md"]);
}

#[test]
fn profile_mismatch_is_not_indexed_and_looks_missing() {
    let mut fx = Fixture::new("work");
    fx.write("Mine.md", "---\nprofile: work\n---\n[[Secret]] [[Nothing]]");
    fx.write(
        "Secret.md",
        "---\nprofile: personal\naliases: [Hidden]\n---\nprivate-word",
    );
    fx.write("Broken.md", "---\nid: [unclosed\n---\n");
    let report = fx.sync();
    assert_eq!(report.notes, 1);
    assert_eq!(
        report.skipped,
        [
            Skipped {
                path: "Broken.md".into(),
                reason: SkipReason::InvalidFrontMatter
            },
            Skipped {
                path: "Secret.md".into(),
                reason: SkipReason::ProfileMismatch
            },
        ]
    );
    let mine = fx.id_at("Mine.md");
    let edges = fx.outgoing(&mine);
    // Denied and missing are indistinguishable apart from the written text.
    assert_eq!(edges[0].target, LinkTarget::Missing);
    assert_eq!(edges[1].target, LinkTarget::Missing);
    let strip = |edge: &EdgeView| EdgeView {
        target_text: String::new(),
        ordinal: 0,
        ..edge.clone()
    };
    assert_eq!(strip(&edges[0]), strip(&edges[1]));
    let raw: Vec<(String, String)> = fx
        .store
        .conn
        .prepare("SELECT resolution, target_key FROM knowledge_edges ORDER BY ordinal")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        raw,
        [
            ("missing".into(), "secret".into()),
            ("missing".into(), "nothing".into())
        ]
    );
    assert!(fx.search("private").is_empty());

    // Another profile's scope sees nothing of this index.
    let other = ProfileScope::new(profile("personal"));
    assert!(fx.store.node(&other, &mine).unwrap().is_none());
    assert!(fx.store.outgoing(&other, &mine).unwrap().is_empty());
    assert!(fx.store.backlinks(&other, &mine).unwrap().is_empty());
    assert!(fx.store.search(&other, "secret", 10).unwrap().is_empty());
    assert!(
        fx.store
            .local_graph(&other, &mine, 2, 10)
            .unwrap()
            .nodes
            .is_empty()
    );
    // A vault of another profile cannot be synced into this index.
    let personal =
        Vault::open_default(&fx.dir.0, &profile("personal"), VaultLimits::default()).unwrap();
    assert!(matches!(
        fx.store.sync(&personal, SyncMode::Incremental),
        Err(KnowledgeError::WrongProfile)
    ));
    // An index file of one profile does not open for another.
    let path = store::index_path(&fx.dir.0, &fx.profile);
    drop(fx.store);
    assert!(matches!(
        KnowledgeStore::open_path(&path, &profile("personal"), false),
        Err(KnowledgeError::WrongProfile)
    ));
}

#[test]
fn duplicate_ids_go_to_the_smallest_path() {
    let mut fx = Fixture::new("work");
    fx.write("b.md", "---\nid: same\n---\nfrom b");
    fx.write("c.md", "---\nid: same\n---\nfrom c");
    let report = fx.sync();
    assert_eq!(fx.node("same").unwrap().path, "b.md");
    assert_eq!(
        report.skipped,
        [Skipped {
            path: "c.md".into(),
            reason: SkipReason::DuplicateId
        }]
    );
    // A smaller path takes the id over; removing it hands the id back.
    fx.write("a.md", "---\nid: same\n---\nfrom a");
    fx.sync();
    assert_eq!(fx.node("same").unwrap().path, "a.md");
    fx.remove("a.md");
    fx.remove("b.md");
    let report = fx.sync();
    assert_eq!(fx.node("same").unwrap().path, "c.md");
    assert!(report.skipped.is_empty());
    let incremental = fx.snapshot();
    fx.rebuild();
    assert_eq!(fx.snapshot(), incremental);
}

#[test]
fn full_text_search_is_scoped_and_literal() {
    let mut fx = Fixture::new("work");
    fx.write(
        "Cats.md",
        "---\naliases: [Felines]\n---\n# Cats\nWhiskers and naps.",
    );
    fx.write("Dogs.md", "# Dogs\nFetch, naps and résumé.");
    fx.write("Code.md", "```\nnaps\n```");
    fx.sync();
    let mut naps = fx.search("naps");
    naps.sort();
    assert_eq!(naps, ["Cats.md", "Code.md", "Dogs.md"]);
    assert_eq!(fx.search("felines"), ["Cats.md"]);
    assert_eq!(fx.search("resume"), ["Dogs.md"]);
    assert_eq!(fx.search("whiskers naps"), ["Cats.md"]);
    // FTS syntax is quoted, never interpreted.
    assert!(fx.search("naps OR NOT \"x").is_empty());
    assert!(fx.search("title:cats").is_empty());
    assert!(fx.search("*").is_empty());
    assert!(fx.search("   ").is_empty());
    fx.remove("Cats.md");
    fx.sync();
    assert!(fx.search("felines").is_empty());
}

#[test]
fn the_indexer_never_writes_notes() {
    let mut fx = Fixture::new("work");
    fx.write("A.md", "---\nid: a\n---\n[[B]]");
    fx.write("dir/B.md", "x");
    let before = vault_state(&fx.root());
    fx.sync();
    fx.rebuild();
    assert_eq!(vault_state(&fx.root()), before);
}

fn vault_state(root: &Path) -> Vec<(PathBuf, Vec<u8>, SystemTime)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let meta = fs::symlink_metadata(&path).unwrap();
            if meta.is_dir() {
                stack.push(path);
            } else {
                out.push((
                    path.clone(),
                    fs::read(&path).unwrap(),
                    meta.modified().unwrap(),
                ));
            }
        }
    }
    out.sort();
    out
}

#[test]
fn racy_edits_are_detected() {
    let mut fx = Fixture::new("work");
    let path = fx.root().join("Now.md");
    fs::write(&path, "aaaa").unwrap();
    fx.sync();
    let mtime = fs::metadata(&path).unwrap().modified().unwrap();
    // Same size, same (recent) mtime: still re-hashed because it is inside the window.
    fs::write(&path, "bbbb").unwrap();
    fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(mtime)
        .unwrap();
    let report = fx.sync();
    assert_eq!(report.updated, 1);
    assert_eq!(fx.search("bbbb"), ["Now.md"]);
}

// ---------------------------------------------------------------- store

#[test]
fn store_file_rules() {
    let dir = TempDir::new();
    let work = profile("work");
    let store = KnowledgeStore::open(&dir.0, &work).unwrap();
    assert_eq!(store.schema_version().unwrap(), KnowledgeStore::LATEST);
    assert_eq!(store.profile(), &work);
    // One writer per file.
    assert!(matches!(
        KnowledgeStore::open(&dir.0, &work),
        Err(KnowledgeError::Locked)
    ));
    let path = store::index_path(&dir.0, &work);
    assert_eq!(
        path,
        dir.0.join("profiles").join("work").join("knowledge.sqlite")
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(path.parent().unwrap()), 0o700);
    }
    store.close().unwrap();
    // Reopening keeps the file; a foreign object fails closed until recreated.
    KnowledgeStore::open(&dir.0, &work)
        .unwrap()
        .close()
        .unwrap();
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE intruder (x INTEGER)")
            .unwrap();
    }
    assert!(matches!(
        KnowledgeStore::open(&dir.0, &work),
        Err(KnowledgeError::SchemaMismatch)
    ));
    let store = KnowledgeStore::recreate(&dir.0, &work).unwrap();
    assert_eq!(store.generation().unwrap(), 0);
    store.close().unwrap();
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.pragma_update(None, "user_version", 99).unwrap();
    }
    assert!(matches!(
        KnowledgeStore::open(&dir.0, &work),
        Err(KnowledgeError::NewerSchema { found: 99, .. })
    ));
    KnowledgeStore::recreate(&dir.0, &work).unwrap();
}

#[test]
fn deleted_index_is_rebuilt_from_markdown() {
    let mut fx = Fixture::new("work");
    fx.write("A.md", "[[B]]");
    fx.write("B.md", "---\naliases: [Bee]\n---\n");
    fx.sync();
    let before = fx.snapshot();
    let Fixture {
        dir,
        profile,
        vault,
        store,
        ..
    } = fx;
    store.close().unwrap();
    let mut store = KnowledgeStore::recreate(&dir.0, &profile).unwrap();
    store.sync(&vault, SyncMode::Incremental).unwrap();
    let fx = Fixture {
        dir,
        profile,
        vault,
        store,
        clock: 0,
    };
    assert_eq!(fx.snapshot(), before);
}

// ---------------------------------------------------------------- property

/// xorshift64*: deterministic, no dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.below(items.len())]
    }
}

const NAMES: &[&str] = &["Alpha", "beta", "Gamma", "alpha", "Delta", "Epsilon"];
const FOLDERS: &[&str] = &["", "Knowledge/", "Projects/x/", "knowledge/"];
const IDS: &[&str] = &["shared.id", "other.id", "third.id"];

fn random_note(rng: &mut Rng) -> String {
    let mut text = String::new();
    if rng.below(2) == 0 {
        text.push_str("---\n");
        if rng.below(2) == 0 {
            text.push_str(&format!("id: {}\n", rng.pick(IDS)));
        }
        if rng.below(3) == 0 {
            text.push_str(&format!("aliases: [{}]\n", rng.pick(NAMES)));
        }
        match rng.below(8) {
            0 => text.push_str("profile: personal\n"),
            1 => text.push_str("profile: work\n"),
            2 => text.push_str("kind: [broken\n"),
            _ => {}
        }
        text.push_str("---\n");
    }
    for _ in 0..rng.below(5) {
        let target = match rng.below(5) {
            0 => format!("{}{}", rng.pick(FOLDERS), rng.pick(NAMES)),
            1 => format!("./{}", rng.pick(NAMES)),
            2 => format!("x/{}|shown", rng.pick(NAMES)),
            _ => rng.pick(NAMES).to_owned(),
        };
        let prefix = if rng.below(4) == 0 { "Related: " } else { "" };
        text.push_str(&format!("{prefix}[[{target}]] word{}\n", rng.below(4)));
    }
    if rng.below(6) == 0 {
        text.push_str("```\n[[Alpha]]\n```\n");
    }
    text
}

#[test]
fn rebuild_equals_incremental_over_random_edits() {
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for seed in 1..=12u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
        let mut fx = Fixture::new("work");
        let mut paths: Vec<String> = Vec::new();
        for step in 0..40 {
            match rng.below(6) {
                0 | 1 => {
                    let path = format!("{}{}.md", rng.pick(FOLDERS), rng.pick(NAMES));
                    let note = random_note(&mut rng);
                    fx.write(&path, note);
                    // Case-insensitive file systems fold `alpha.md` onto `Alpha.md`.
                    if !paths.iter().any(|known| known.eq_ignore_ascii_case(&path)) {
                        paths.push(path);
                    }
                }
                2 if !paths.is_empty() => {
                    let path = paths[rng.below(paths.len())].clone();
                    let note = random_note(&mut rng);
                    fx.write(&path, note);
                }
                3 if !paths.is_empty() => {
                    let path = paths.remove(rng.below(paths.len()));
                    fx.remove(&path);
                }
                4 if !paths.is_empty() => {
                    let from = paths[rng.below(paths.len())].clone();
                    let to = format!("{}{}.md", rng.pick(FOLDERS), rng.pick(NAMES));
                    if !paths.iter().any(|known| known.eq_ignore_ascii_case(&to)) {
                        fx.rename(&from, &to);
                        paths.retain(|path| *path != from);
                        paths.push(to);
                    }
                }
                _ => {
                    // Same bytes rewritten: only the stat changes.
                    if let Some(path) = paths.first().cloned() {
                        let bytes = fs::read(fx.root().join(&path)).unwrap();
                        fx.write(&path, bytes);
                    }
                }
            }
            if rng.below(3) == 0 || step == 39 {
                fx.sync();
                let incremental = fx.snapshot();
                fx.rebuild();
                assert_eq!(fx.snapshot(), incremental, "seed {seed} step {step}");
                for state in [
                    "\"ambiguous\"",
                    "\"duplicate_id\"",
                    "\"profile_mismatch\"",
                    "\"invalid_front_matter\"",
                    "\"path_suffix\"",
                    "\"title\"",
                    "\"alias\"",
                    "\"related_to\"",
                ] {
                    if incremental.iter().any(|row| row.contains(state)) {
                        seen.insert(state);
                    }
                }
            }
        }
    }
    // The random edits reach every interesting state.
    assert_eq!(seen.len(), 8, "{seen:?}");
}

#[test]
fn custom_vault_roots_are_validated_pinned_and_never_created() {
    let temp = TempDir::new();
    let data = temp.0.join("data");
    fs::create_dir_all(data.join("state")).unwrap();
    fs::create_dir_all(data.join("vaults/work/Nested")).unwrap();
    let outside = temp.0.join("My Vault");
    fs::create_dir(&outside).unwrap();
    let work = profile("work");
    let open = |root: &Path| Vault::open_custom(root, &data, &work, VaultLimits::default());

    let vault = open(&outside).unwrap();
    assert!(vault.is_custom());
    fs::write(outside.join("Note.md"), "# Note\n").unwrap();
    assert_eq!(vault.walk().unwrap().notes.len(), 1);
    // The profile's own default root (or below it) is allowed; nothing else of the data dir.
    open(&data.join("vaults/work/Nested")).unwrap();
    let refused = [
        PathBuf::from("relative"),
        PathBuf::from("/"),
        temp.0.clone(),
        data.clone(),
        data.join("state"),
        data.join("vaults"),
        temp.0.join("missing"),
        outside.join("Note.md"),
    ];
    for root in &refused {
        assert!(
            matches!(open(root), Err(KnowledgeError::VaultUnavailable)),
            "{}",
            root.display()
        );
    }
    assert!(!temp.0.join("missing").exists(), "never created");
    #[cfg(unix)]
    {
        let link = temp.0.join("Link");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(matches!(open(&link), Err(KnowledgeError::VaultUnavailable)));
        // A root replaced after opening is unavailable; nothing falls back.
        let moved = temp.0.join("Moved");
        fs::rename(&outside, &moved).unwrap();
        assert!(matches!(
            vault.walk(),
            Err(KnowledgeError::VaultUnavailable)
        ));
        std::os::unix::fs::symlink(&moved, &outside).unwrap();
        assert!(matches!(
            vault.walk(),
            Err(KnowledgeError::VaultUnavailable)
        ));
    }
}
