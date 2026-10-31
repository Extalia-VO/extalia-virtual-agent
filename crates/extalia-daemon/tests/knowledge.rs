//! Knowledge index operations over the wire (W5 slice 2a). Sessions run in process (the
//! knowledge index needs no core store); one test spawns the binary. Every frame the daemon
//! answers is re-encoded, so it is validated against the contract and the frame limit.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};

use extalia_core::knowledge::{KnowledgeStore, VaultLimits};
use extalia_core::skills::ProfileId;
use extalia_daemon::knowledge::Knowledge;
use extalia_daemon::session::Session;
use extalia_daemon::wire::{self, Frame, FrameReader, MAX_FRAME_BYTES, Op};
use serde_json::{Value, json};

const ID: &str = "00000000-0000-4000-8000-000000000100";

mod support;

use support::Isolation;

/// A private temporary directory; it also keeps the test's [`support`] isolation.
struct TempDir(
    PathBuf,
    #[allow(dead_code, reason = "held until the test ends")] Isolation,
);

impl TempDir {
    /// For a test that holds store locks in this process.
    fn new() -> Self {
        Self::with(Isolation::HoldsLocks(support::holds_locks()))
    }

    /// For a test that spawns the daemon binary.
    fn spawning() -> Self {
        Self::with(Isolation::SpawnsDaemon(support::spawns_daemon()))
    }

    fn with(isolation: Isolation) -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        loop {
            let dir = std::env::temp_dir().join(format!(
                "extalia-daemon-knowledge-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&dir) {
                Ok(()) => {
                    fs::create_dir(dir.join("data")).unwrap();
                    return Self(dir, isolation);
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => panic!("cannot create a temporary directory: {error}"),
            }
        }
    }

    fn data(&self) -> PathBuf {
        self.0.join("data")
    }

    fn vault(&self, profile: &str) -> PathBuf {
        self.data().join("vaults").join(profile)
    }

    /// Write notes into `profile`'s vault (created private when missing).
    fn notes(&self, profile: &str, files: &[(&str, &str)]) {
        let root = self.vault(profile);
        if !root.exists() {
            fs::create_dir_all(&root).unwrap();
            private(&root);
            private(&self.data().join("vaults"));
        }
        for (path, text) in files {
            let file = root.join(path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, text).unwrap();
        }
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[cfg(unix)]
fn private(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

#[cfg(not(unix))]
fn private(_path: &Path) {}

fn start(dir: &TempDir, profile: &str) -> Session {
    start_with(Knowledge::new(&dir.data(), profile))
}

fn start_with(knowledge: Knowledge) -> Session {
    let mut session = Session::new().with_knowledge(knowledge);
    hello(&mut session);
    session
}

fn hello(session: &mut Session) -> Vec<String> {
    let reply = send(
        session,
        json!({ "schemaVersion": 1, "kind": "request", "requestId": ID, "op": "hello",
            "params": { "clientVersion": "test", "capabilities": ["hello"] } }),
    );
    reply.unwrap()["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|op| op.as_str().unwrap().to_owned())
        .collect()
}

type Answer = Result<Value, (String, Option<String>)>;

/// Send one request value; `Ok(result)` or `Err((code, reason))`. The answer is encoded, so
/// it passed the contract validator and fits a frame.
fn send(session: &mut Session, value: Value) -> Answer {
    let reply = session.handle(wire::parse_frame(&value));
    let frame = reply.frame.expect("a request is answered");
    let bytes = wire::encode(&frame).expect("the answer follows the contract");
    assert!(bytes.len() <= MAX_FRAME_BYTES + 4);
    match frame.to_value() {
        value if value["kind"] == "response" => Ok(value["result"].clone()),
        value => Err((
            value["error"]["code"].as_str().unwrap().to_owned(),
            value["error"]["reason"].as_str().map(str::to_owned),
        )),
    }
}

fn op(session: &mut Session, name: &str, params: Value) -> Answer {
    send(
        session,
        json!({ "schemaVersion": 1, "kind": "request", "requestId": ID, "op": name, "params": params }),
    )
}

fn refused(code: &str, reason: &str) -> Answer {
    Err((code.to_owned(), Some(reason.to_owned())))
}

fn sync(session: &mut Session, mode: &str) -> Value {
    op(session, "knowledge.sync", json!({ "mode": mode })).unwrap()
}

fn ids(list: &Value, key: &str) -> Vec<String> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|item| item[key].as_str().unwrap().to_owned())
        .collect()
}

const ALPHA: &str = "---\nid: proj.alpha\nkind: project\naliases: [First]\ntags: [demo]\nverification: verified\n---\n# Alpha\nRelated: [[Beta]]\nSee [[Missing note]] and [[Dup]] and ![[Beta#Intro|the beta]]\nA zebra crossing is mentioned here.\n";
const BETA: &str = "# Beta\nBack to [[Projects/Alpha]].\n";

fn seed(dir: &TempDir, profile: &str) {
    dir.notes(
        profile,
        &[
            ("Projects/Alpha.md", ALPHA),
            ("Beta.md", BETA),
            ("A/Dup.md", "# Dup A\n"),
            ("B/Dup.md", "# Dup B\n"),
        ],
    );
}

#[test]
fn hello_advertises_knowledge_operations_only_with_a_data_directory() {
    let mut bare = Session::new();
    let capabilities = hello(&mut bare);
    assert!(capabilities.iter().all(|op| !op.starts_with("knowledge.")));
    assert_eq!(
        op(&mut bare, "knowledge.status", json!({})),
        Err(("unknown_op".to_owned(), None))
    );

    let dir = TempDir::new();
    let mut session = start(&dir, "default");
    let capabilities = hello(&mut session);
    for name in Op::ALL
        .iter()
        .map(|op| op.as_str())
        .filter(|op| op.starts_with("knowledge."))
    {
        assert!(capabilities.iter().any(|op| op == name), "{name}");
    }
    // Opening is lazy: nothing exists before the first knowledge operation.
    assert!(!dir.data().join("profiles").exists());
    assert!(!dir.data().join("vaults").exists());
}

#[test]
fn first_sync_creates_the_vault_and_status_reports_no_absolute_path() {
    let dir = TempDir::new();
    let mut session = start(&dir, "default");
    let status = op(&mut session, "knowledge.status", json!({})).unwrap();
    assert_eq!(status["state"], "ready");
    assert_eq!(status["vaultRoot"], "vaults/default");
    assert_eq!(status["vaultPresent"], false);
    assert_eq!(status["generation"], 0);
    assert_eq!(status["schemaVersion"], 1);
    assert!(status.get("lastSync").is_none());
    assert!(
        dir.data()
            .join("profiles/default/knowledge.sqlite")
            .is_file()
    );
    assert!(
        !dir.vault("default").exists(),
        "status never creates the vault"
    );

    let report = sync(&mut session, "incremental");
    assert_eq!(report["vaultCreated"], true);
    assert_eq!(report["notes"], 0);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(dir.vault("default"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
    }
    seed(&dir, "default");
    let report = sync(&mut session, "incremental");
    assert_eq!(report["vaultCreated"], false);
    assert_eq!(
        (report["notes"].as_u64(), report["added"].as_u64()),
        (Some(4), Some(4))
    );
    let status = op(&mut session, "knowledge.status", json!({})).unwrap();
    assert_eq!(status["vaultPresent"], true);
    assert_eq!(status["counts"]["notes"], 4);
    assert_eq!(status["counts"]["unresolvedLinks"], 2);
    assert_eq!(status["lastSync"]["added"], 4);
    assert_eq!(status["lastSync"]["generation"], status["generation"]);
    let data = dir.data().to_string_lossy().into_owned();
    for value in [&status, &report] {
        assert!(
            !value.to_string().contains(&data),
            "no absolute path: {value}"
        );
    }
}

#[test]
fn reads_nodes_links_backlinks_search_and_graph() {
    let dir = TempDir::new();
    seed(&dir, "default");
    let mut session = start(&dir, "default");
    sync(&mut session, "incremental");

    let node = op(
        &mut session,
        "knowledge.node",
        json!({ "nodeId": "proj.alpha" }),
    )
    .unwrap();
    assert_eq!(node["node"]["path"], "Projects/Alpha.md");
    assert_eq!(node["node"]["title"], "Alpha");
    assert_eq!(node["node"]["kind"], "project");
    assert_eq!(node["node"]["aliases"], json!(["First"]));
    assert_eq!(node["node"]["trustStatus"], "untrusted");
    assert_eq!(node["node"]["declaredVerification"], "verified");
    assert_eq!(node["bodyStatus"], "current");
    assert_eq!(node["bodyTruncated"], false);
    let body = node["body"].as_str().unwrap();
    assert!(
        body.starts_with("# Alpha\n") && !body.contains("id: proj.alpha"),
        "{body}"
    );

    let by_path = op(&mut session, "knowledge.node", json!({ "path": "Beta.md" })).unwrap();
    assert_eq!(by_path["node"]["nodeId"], "path:Beta.md");
    assert_eq!(by_path["node"]["idFromFrontMatter"], false);

    let links = op(
        &mut session,
        "knowledge.links",
        json!({ "nodeId": "proj.alpha" }),
    )
    .unwrap();
    let statuses: Vec<_> = links["links"]
        .as_array()
        .unwrap()
        .iter()
        .map(|link| {
            (
                link["target"].as_str().unwrap(),
                link["status"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        statuses,
        [
            ("Beta", "resolved"),
            ("Missing note", "missing"),
            ("Dup", "ambiguous"),
            ("Beta", "resolved")
        ]
    );
    let links_list = links["links"].as_array().unwrap();
    assert_eq!(links_list[0]["edgeType"], "related_to");
    assert_eq!(links_list[0]["via"], "path");
    assert_eq!(
        links_list[2]["candidates"],
        json!(["path:A/Dup.md", "path:B/Dup.md"])
    );
    assert_eq!(links_list[3]["embed"], true);
    assert_eq!(links_list[3]["heading"], "Intro");
    assert_eq!(links_list[3]["display"], "the beta");
    assert_eq!(ids(&links["nodes"], "nodeId"), ["path:Beta.md"]);
    assert!(links.get("nextCursor").is_none());

    let page = op(
        &mut session,
        "knowledge.links",
        json!({ "nodeId": "proj.alpha", "limit": 1, "cursor": 1 }),
    )
    .unwrap();
    assert_eq!(page["links"][0]["ordinal"], 1);
    assert_eq!(page["nextCursor"], 2);

    let backlinks = op(
        &mut session,
        "knowledge.backlinks",
        json!({ "nodeId": "path:Beta.md" }),
    )
    .unwrap();
    assert_eq!(
        ids(&backlinks["links"], "sourceNodeId"),
        ["proj.alpha", "proj.alpha"]
    );
    assert_eq!(ids(&backlinks["nodes"], "nodeId"), ["proj.alpha"]);

    let search = op(
        &mut session,
        "knowledge.search",
        json!({ "query": "ZEBRA" }),
    )
    .unwrap();
    assert_eq!(ids(&search["hits"], "nodeId"), ["proj.alpha"]);
    let snippet = search["hits"][0]["snippet"].as_str().unwrap();
    assert!(snippet.contains("zebra crossing"), "{snippet}");
    let none = op(
        &mut session,
        "knowledge.search",
        json!({ "query": "\"OR\" NEAR(" }),
    )
    .unwrap();
    assert_eq!(none["hits"], json!([]));

    let graph = op(
        &mut session,
        "knowledge.graph",
        json!({ "nodeId": "proj.alpha" }),
    )
    .unwrap();
    assert_eq!(graph["rootNodeId"], "proj.alpha");
    assert_eq!(graph["depth"], 1);
    assert_eq!(
        ids(&graph["nodes"], "nodeId"),
        ["proj.alpha", "path:Beta.md"]
    );
    assert_eq!(graph["truncated"], false);
    assert!(graph["edges"].as_array().unwrap().iter().any(|edge| edge
        == &json!({ "source": "path:Beta.md", "target": "proj.alpha", "edgeType": "links_to" })));

    // An edit not yet synced: the body is newer than the index.
    dir.notes("default", &[("Beta.md", "# Beta v2\n")]);
    let stale = op(&mut session, "knowledge.node", json!({ "path": "Beta.md" })).unwrap();
    assert_eq!(stale["bodyStatus"], "changed");
    assert_eq!(stale["body"], "# Beta v2\n");
}

#[test]
fn overview_ranks_notes_and_keeps_only_resolved_links() {
    let dir = TempDir::new();
    seed(&dir, "default");
    let mut session = start(&dir, "default");
    let generation = sync(&mut session, "incremental")["generation"].clone();

    let all = op(&mut session, "knowledge.overview", json!({})).unwrap();
    assert_eq!(all["generation"], generation);
    // Alpha→Beta as related_to and links_to (embed), Beta→Alpha; [[Missing note]] and the
    // ambiguous [[Dup]] are left out.
    assert_eq!(
        (all["totalNodes"].as_u64(), all["totalEdges"].as_u64()),
        (Some(4), Some(3))
    );
    assert_eq!(all["truncated"], false);
    // Equal degrees fall back to node id order.
    assert_eq!(
        ids(&all["nodes"], "nodeId"),
        [
            "path:Beta.md",
            "proj.alpha",
            "path:A/Dup.md",
            "path:B/Dup.md"
        ]
    );
    let alpha = &all["nodes"][1];
    assert_eq!(alpha["path"], "Projects/Alpha.md");
    assert_eq!(alpha["folder"], "Projects");
    assert_eq!(alpha["title"], "Alpha");
    assert_eq!(alpha["kind"], "project");
    assert_eq!(alpha["tags"], json!(["demo"]));
    assert_eq!(
        (
            alpha["degree"].as_u64(),
            alpha["inDegree"].as_u64(),
            alpha["outDegree"].as_u64()
        ),
        (Some(3), Some(1), Some(2))
    );
    assert!(alpha["modifiedAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(all["nodes"][0]["folder"], "");
    assert_eq!(all["nodes"][2]["degree"], 0);
    assert_eq!(
        all["edges"],
        json!([
            { "source": "path:Beta.md", "target": "proj.alpha", "type": "links_to" },
            { "source": "proj.alpha", "target": "path:Beta.md", "type": "links_to" },
            { "source": "proj.alpha", "target": "path:Beta.md", "type": "related_to" },
        ])
    );

    // Limits keep the most connected notes and only edges between them.
    let one = op(
        &mut session,
        "knowledge.overview",
        json!({ "nodeLimit": 1 }),
    )
    .unwrap();
    assert_eq!(ids(&one["nodes"], "nodeId"), ["path:Beta.md"]);
    assert_eq!(one["edges"], json!([]));
    assert_eq!(
        (one["truncated"].as_bool(), one["totalNodes"].as_u64()),
        (Some(true), Some(4))
    );
    let two = op(
        &mut session,
        "knowledge.overview",
        json!({ "nodeLimit": 2, "edgeLimit": 1 }),
    )
    .unwrap();
    assert_eq!(ids(&two["nodes"], "nodeId"), ["path:Beta.md", "proj.alpha"]);
    assert_eq!(ids(&two["edges"], "source"), ["path:Beta.md"]);
    assert_eq!(two["truncated"], true);
    assert_eq!(
        op(
            &mut session,
            "knowledge.overview",
            json!({ "nodeLimit": 2001 })
        ),
        Err(("invalid_request".to_owned(), None))
    );
}

#[test]
#[cfg_attr(
    windows,
    ignore = "its note paths use quotes and exceed Windows path limits"
)]
fn overview_stays_below_the_frame_limit_at_the_maximum_sizes() {
    let dir = TempDir::new();
    // 300 notes with long escaped and multi-byte paths, titles and tags, each linking to the
    // hub and its next six notes: far more than one frame at the maximum limits, with both the
    // node and the edge byte budget reached.
    const NOTES: usize = 300;
    const LINKS: usize = 6;
    let stem = |index: usize| format!("n{index:03}-{}", "\u{20ac}".repeat(60));
    let path = |index: usize| {
        format!(
            "d{}/{}/{}/{}.md",
            index % 4,
            "\"a".repeat(100),
            "\u{20ac}\"".repeat(50),
            stem(index)
        )
    };
    let tags: Vec<String> = (0..10)
        .map(|tag| format!("t{tag}-{}", "x".repeat(120)))
        .collect();
    let mut files: Vec<(String, String)> = vec![("Hub.md".into(), "# Hub\n".into())];
    for index in 0..NOTES {
        files.push((
            path(index),
            format!(
                "---\ntags: [{}]\n---\n# {}\n[[Hub]] {}\n",
                tags.join(", "),
                "\"".repeat(500),
                (1..=LINKS)
                    .map(|step| format!("[[{}]]", stem((index + step) % NOTES)))
                    .collect::<String>()
            ),
        ));
    }
    let borrowed: Vec<(&str, &str)> = files
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    dir.notes("default", &borrowed);
    let mut session = start(&dir, "default");
    assert_eq!(sync(&mut session, "incremental")["notes"], NOTES + 1);

    // `send` checks the contract and the frame limit of the answer.
    let overview = op(
        &mut session,
        "knowledge.overview",
        json!({ "nodeLimit": 2000, "edgeLimit": 8000 }),
    )
    .unwrap();
    assert!(serde_json::to_vec(&overview).unwrap().len() <= 960 * 1024);
    assert_eq!(overview["totalNodes"], NOTES + 1);
    assert_eq!(overview["totalEdges"], (LINKS + 1) * NOTES);
    assert_eq!(overview["truncated"], true);
    let nodes = overview["nodes"].as_array().unwrap();
    let edges = overview["edges"].as_array().unwrap();
    assert!(nodes.len() > 10 && nodes.len() < NOTES, "{}", nodes.len());
    assert!(!edges.is_empty());
    // The edges stopped at the byte budget, not for lack of edges among the kept notes.
    let kept: std::collections::BTreeSet<&str> = nodes
        .iter()
        .map(|node| node["nodeId"].as_str().unwrap())
        .collect();
    assert!(kept.len() > 100);
    assert!(edges.len() < (kept.len() - 1) * 2, "{}", edges.len());
    assert_eq!(nodes[0]["nodeId"], "path:Hub.md");
    assert_eq!(nodes[0]["inDegree"], NOTES);
    let degree = |id: &Value| {
        nodes
            .iter()
            .find(|node| &node["nodeId"] == id)
            .map(|node| node["degree"].as_u64().unwrap())
            .expect("edge ends are included nodes")
    };
    let degrees: Vec<u64> = nodes
        .iter()
        .map(|node| node["degree"].as_u64().unwrap())
        .collect();
    assert!(degrees.windows(2).all(|pair| pair[0] >= pair[1]));
    let weights: Vec<u64> = edges
        .iter()
        .map(|edge| degree(&edge["source"]) + degree(&edge["target"]))
        .collect();
    assert!(weights.windows(2).all(|pair| pair[0] >= pair[1]));
    for node in &nodes[1..] {
        let tags = node["tags"].as_array().unwrap();
        assert_eq!(tags.len(), 8);
        assert!(
            tags.iter()
                .all(|tag| tag.as_str().unwrap().encode_utf16().count() <= 64)
        );
        assert_eq!(node["title"], "\"".repeat(500));
        assert!(
            node["path"]
                .as_str()
                .unwrap()
                .starts_with(node["folder"].as_str().unwrap())
        );
    }
}

#[test]
fn refusals_carry_stable_reasons() {
    let dir = TempDir::new();
    seed(&dir, "default");
    dir.notes(
        "default",
        &[("Broken.md", "---\nid: [unterminated\n---\nbody\n")],
    );
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        dir.vault("default").join("Beta.md"),
        dir.vault("default").join("Link.md"),
    )
    .unwrap();
    let mut session = start(&dir, "default");
    let report = sync(&mut session, "incremental");
    let skipped: Vec<_> = report["skipped"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item["path"].as_str().unwrap(),
                item["reason"].as_str().unwrap(),
            )
        })
        .collect();
    assert!(
        skipped.contains(&("Broken.md", "invalid_front_matter")),
        "{skipped:?}"
    );
    #[cfg(unix)]
    assert!(skipped.contains(&("Link.md", "symlink")), "{skipped:?}");
    assert_eq!(report["skippedTotal"].as_u64(), Some(skipped.len() as u64));

    for (name, params) in [
        ("knowledge.node", json!({ "nodeId": "absent.note" })),
        ("knowledge.node", json!({ "path": "Link.md" })),
        ("knowledge.node", json!({ "path": "Broken.md" })),
        ("knowledge.links", json!({ "nodeId": "absent.note" })),
        ("knowledge.backlinks", json!({ "nodeId": "path:Nope.md" })),
        ("knowledge.graph", json!({ "nodeId": "absent.note" })),
    ] {
        assert_eq!(
            op(&mut session, name, params.clone()),
            refused("not_found", "node_not_found"),
            "{name} {params}"
        );
    }
    for params in [
        json!({ "path": "../state/core.sqlite" }),
        json!({ "path": "/etc/passwd.md" }),
        json!({ "nodeId": "path:Beta.md", "path": "Beta.md" }),
    ] {
        assert_eq!(
            op(&mut session, "knowledge.node", params),
            Err(("invalid_request".to_owned(), None))
        );
    }

    // A vault above the note cap fails the sync and leaves the index unchanged.
    let limits = VaultLimits {
        max_notes: 2,
        ..VaultLimits::default()
    };
    drop(session);
    let mut small = start_with(Knowledge::with_limits(&dir.data(), "default", limits));
    let before = op(&mut small, "knowledge.status", json!({})).unwrap();
    assert_eq!(
        sync_answer(&mut small, "rebuild"),
        refused("capacity_exceeded", "vault_too_large")
    );
    assert_eq!(
        op(&mut small, "knowledge.status", json!({})).unwrap()["counts"],
        before["counts"]
    );
}

fn sync_answer(session: &mut Session, mode: &str) -> Answer {
    op(session, "knowledge.sync", json!({ "mode": mode }))
}

#[test]
fn an_unusable_index_never_stops_the_daemon() {
    let dir = TempDir::new();
    seed(&dir, "default");
    let profile = ProfileId::parse("default").unwrap();
    // Another opener holds the index lock.
    let holder = KnowledgeStore::open(&dir.data(), &profile).unwrap();
    let mut session = start(&dir, "default");
    let status = op(&mut session, "knowledge.status", json!({})).unwrap();
    assert_eq!(
        (status["state"].as_str(), status["reason"].as_str()),
        (Some("unavailable"), Some("index_locked"))
    );
    assert_eq!(
        sync_answer(&mut session, "incremental"),
        refused("storage_failure", "index_locked")
    );
    assert_eq!(
        op(
            &mut session,
            "knowledge.search",
            json!({ "query": "zebra" })
        ),
        refused("storage_failure", "index_locked")
    );
    assert!(
        op(&mut session, "health", json!({})).is_ok(),
        "other operations keep working"
    );
    // Opening is retried once the lock is released.
    holder.close().unwrap();
    assert_eq!(sync(&mut session, "incremental")["notes"], 4);
    drop(session);

    // A file with a foreign schema: reported, then discarded by an explicit rebuild.
    let index = dir.data().join("profiles/default/knowledge.sqlite");
    for suffix in ["", "-wal", "-shm"] {
        let _ = fs::remove_file(format!("{}{suffix}", index.display()));
    }
    {
        let conn = rusqlite::Connection::open(&index).unwrap();
        conn.execute_batch("CREATE TABLE foreign_table (x); PRAGMA user_version = 1;")
            .unwrap();
    }
    let mut session = start(&dir, "default");
    let status = op(&mut session, "knowledge.status", json!({})).unwrap();
    assert_eq!(
        (status["state"].as_str(), status["reason"].as_str()),
        (Some("unavailable"), Some("index_corrupt"))
    );
    assert_eq!(
        op(
            &mut session,
            "knowledge.node",
            json!({ "nodeId": "proj.alpha" })
        ),
        refused("integrity_failure", "index_corrupt")
    );
    assert_eq!(
        sync_answer(&mut session, "incremental"),
        refused("integrity_failure", "index_corrupt")
    );
    assert_eq!(sync(&mut session, "rebuild")["notes"], 4);
    assert_eq!(
        op(&mut session, "knowledge.status", json!({})).unwrap()["state"],
        "ready"
    );
}

#[test]
fn a_vault_that_disappears_is_unavailable_and_never_recreated_empty() {
    let dir = TempDir::new();
    seed(&dir, "default");
    let mut session = start(&dir, "default");
    sync(&mut session, "incremental");
    fs::rename(dir.vault("default"), dir.0.join("moved")).unwrap();
    let status = op(&mut session, "knowledge.status", json!({})).unwrap();
    assert_eq!(
        (status["state"].as_str(), status["vaultPresent"].as_bool()),
        (Some("ready"), Some(false))
    );
    for mode in ["incremental", "rebuild"] {
        assert_eq!(
            sync_answer(&mut session, mode),
            refused("storage_failure", "vault_unavailable")
        );
    }
    assert!(!dir.vault("default").exists());
    // The index still answers; the body is unavailable.
    let node = op(
        &mut session,
        "knowledge.node",
        json!({ "nodeId": "proj.alpha" }),
    )
    .unwrap();
    assert_eq!(node["bodyStatus"], "unavailable");
    assert!(node.get("body").is_none());
    assert_eq!(
        op(&mut session, "knowledge.status", json!({})).unwrap()["counts"]["notes"],
        4
    );
    // A symbolic link in place of the root is refused as well.
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(dir.0.join("moved"), dir.vault("default")).unwrap();
        assert_eq!(
            sync_answer(&mut session, "incremental"),
            refused("storage_failure", "vault_unavailable")
        );
        let node = op(
            &mut session,
            "knowledge.node",
            json!({ "nodeId": "proj.alpha" }),
        )
        .unwrap();
        assert_eq!(node["bodyStatus"], "unavailable");
    }
}

#[test]
fn profiles_are_isolated_across_two_daemons() {
    let dir = TempDir::new();
    dir.notes("work", &[("Secret.md", "# Secret\nquokka-plan details\n")]);
    dir.notes(
        "personal",
        &[("Diary.md", "# Diary\nSee [[Secret]] and [[Diary]].\n")],
    );
    // Both daemons run at the same time on one data directory: separate files and locks.
    let mut work = start(&dir, "work");
    let mut personal = start(&dir, "personal");
    assert_eq!(sync(&mut work, "incremental")["notes"], 1);
    assert_eq!(sync(&mut personal, "incremental")["notes"], 1);

    let links = op(
        &mut personal,
        "knowledge.links",
        json!({ "nodeId": "path:Diary.md" }),
    )
    .unwrap();
    assert_eq!(
        links["links"][0]["status"], "missing",
        "another profile's note reads as missing"
    );
    assert!(links["links"][0].get("candidates").is_none());
    assert_eq!(ids(&links["nodes"], "nodeId"), ["path:Diary.md"]);
    for (name, params) in [
        ("knowledge.node", json!({ "path": "Secret.md" })),
        ("knowledge.node", json!({ "nodeId": "path:Secret.md" })),
        ("knowledge.backlinks", json!({ "nodeId": "path:Secret.md" })),
        ("knowledge.graph", json!({ "nodeId": "path:Secret.md" })),
    ] {
        assert_eq!(
            op(&mut personal, name, params),
            refused("not_found", "node_not_found")
        );
    }
    assert_eq!(
        op(
            &mut personal,
            "knowledge.search",
            json!({ "query": "quokka-plan" })
        )
        .unwrap()["hits"],
        json!([])
    );
    assert_eq!(
        op(&mut personal, "knowledge.status", json!({})).unwrap()["vaultRoot"],
        "vaults/personal"
    );
    // The overview shows only the profile's own notes; the self link and the link to another
    // profile's note are not edges.
    let overview = op(&mut personal, "knowledge.overview", json!({})).unwrap();
    assert_eq!(ids(&overview["nodes"], "nodeId"), ["path:Diary.md"]);
    assert_eq!(
        (
            overview["totalNodes"].as_u64(),
            overview["totalEdges"].as_u64()
        ),
        (Some(1), Some(0))
    );
    assert_eq!(overview["edges"], json!([]));
    let overview = op(&mut work, "knowledge.overview", json!({})).unwrap();
    assert_eq!(ids(&overview["nodes"], "nodeId"), ["path:Secret.md"]);
    // The owner sees its own note.
    let hits = op(
        &mut work,
        "knowledge.search",
        json!({ "query": "quokka-plan" }),
    )
    .unwrap();
    assert_eq!(ids(&hits["hits"], "nodeId"), ["path:Secret.md"]);
    assert_eq!(
        op(&mut work, "knowledge.node", json!({ "path": "Diary.md" })),
        refused("not_found", "node_not_found")
    );
}

/// Results without the fields that legitimately differ between a rebuild and incremental
/// syncs (`generation`, `observedAt`).
fn normalized(mut value: Value) -> Value {
    fn strip(value: &mut Value) {
        match value {
            Value::Object(map) => {
                map.remove("generation");
                map.remove("observedAt");
                for item in map.values_mut() {
                    strip(item);
                }
            }
            Value::Array(items) => items.iter_mut().for_each(strip),
            _ => {}
        }
    }
    strip(&mut value);
    value
}

fn snapshot(session: &mut Session) -> Vec<Value> {
    let status = op(session, "knowledge.status", json!({})).unwrap();
    let mut out = vec![status["counts"].clone()];
    let hits = op(
        session,
        "knowledge.search",
        json!({ "query": "note", "limit": 50 }),
    )
    .unwrap();
    out.push(normalized(hits.clone()));
    for id in ids(&hits["hits"], "nodeId") {
        for name in ["knowledge.node", "knowledge.links", "knowledge.backlinks"] {
            out.push(normalized(
                op(session, name, json!({ "nodeId": id })).unwrap(),
            ));
        }
        out.push(normalized(
            op(
                session,
                "knowledge.graph",
                json!({ "nodeId": id, "depth": 3 }),
            )
            .unwrap(),
        ));
    }
    out
}

#[test]
fn rebuild_and_incremental_syncs_agree_over_the_wire() {
    let dir = TempDir::new();
    let mut session = start(&dir, "default");
    dir.notes(
        "default",
        &[
            ("One.md", "# One note\n[[Two]] [[Three]] [[Gone]]\n"),
            (
                "Two.md",
                "---\nid: two\naliases: [Deux]\n---\n# Two note\n[[One]] [[Deux]]\n",
            ),
            ("Three.md", "# Three note\n"),
        ],
    );
    sync(&mut session, "incremental");
    // Add, modify, rename and delete between incremental syncs.
    dir.notes(
        "default",
        &[
            ("Gone.md", "# Gone note\n[[One]]\n"),
            ("Two.md", "---\nid: two\n---\n# Two note v2\n[[Three]]\n"),
        ],
    );
    sync(&mut session, "incremental");
    fs::rename(
        dir.vault("default").join("Three.md"),
        dir.vault("default").join("Folder-Three.md"),
    )
    .unwrap();
    let report = sync(&mut session, "incremental");
    assert_eq!(
        report["renamed"],
        json!([{ "from": "Three.md", "to": "Folder-Three.md" }])
    );
    fs::remove_file(dir.vault("default").join("Gone.md")).unwrap();
    dir.notes(
        "default",
        &[("Four.md", "# Four note\n[[Folder-Three]] [[One]]\n")],
    );
    sync(&mut session, "incremental");

    let incremental = snapshot(&mut session);
    assert!(incremental.len() > 10, "the snapshot covers every note");
    let rebuilt = sync(&mut session, "rebuild");
    assert_eq!(rebuilt["mode"], "rebuild");
    assert_eq!(snapshot(&mut session), incremental);
}

#[test]
#[cfg_attr(
    windows,
    ignore = "its note paths use quotes and exceed Windows path limits"
)]
fn large_results_stay_below_the_frame_limit() {
    let dir = TempDir::new();
    // A hub linking to 600 notes with long names, and a note body above the body cap.
    let name = |index: usize| format!("{index:04}-{}", "\u{20ac}\"".repeat(60));
    let mut hub = String::from("# Hub\n");
    let mut files: Vec<(String, String)> = Vec::new();
    for index in 0..600 {
        hub.push_str(&format!("[[{}|{}]] ", name(index), "\"".repeat(200)));
        files.push((
            format!("{}.md", name(index)),
            format!("# {}\n[[Hub]]\n", "\u{20ac}".repeat(150)),
        ));
    }
    files.push(("Hub.md".into(), hub));
    // 300 links to a title shared by 16 notes with long paths: ambiguous with 16 candidates
    // each, more than the page byte budget at the maximum page size.
    let deep = |index: usize| {
        format!(
            "d{index:02}/{}/{}/{}/Amb.md",
            "a".repeat(200),
            "b".repeat(200),
            "c".repeat(200)
        )
    };
    for index in 0..16 {
        files.push((deep(index), "# Amb\n".into()));
    }
    files.push((
        "Fan.md".into(),
        format!("# Fan\n{}", "[[Amb]]\n".repeat(300)),
    ));
    files.push((
        "Big.md".into(),
        format!("# Big\n{}", "\"\u{1}".repeat(400 * 1024)),
    ));
    let borrowed: Vec<(&str, &str)> = files
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    dir.notes("default", &borrowed);
    let mut session = start(&dir, "default");
    assert_eq!(sync(&mut session, "incremental")["notes"], 619);

    let big = op(&mut session, "knowledge.node", json!({ "path": "Big.md" })).unwrap();
    assert_eq!(big["bodyTruncated"], true);
    let body = big["body"].as_str().unwrap();
    assert!(body.len() <= 256 * 1024 && !body.contains('\u{1}'));

    // Pages follow `nextCursor` until every link was returned exactly once.
    let mut ordinals = Vec::new();
    let mut cursor = 0;
    let mut pages = 0;
    loop {
        let page = op(
            &mut session,
            "knowledge.links",
            json!({ "nodeId": "path:Hub.md", "cursor": cursor, "limit": 200 }),
        )
        .unwrap();
        pages += 1;
        ordinals.extend(
            page["links"]
                .as_array()
                .unwrap()
                .iter()
                .map(|link| link["ordinal"].as_u64().unwrap()),
        );
        match page.get("nextCursor") {
            Some(next) => cursor = next.as_u64().unwrap(),
            None => break,
        }
    }
    assert_eq!(ordinals, (0..600).collect::<Vec<u64>>());
    assert!(pages >= 3);
    let fan = op(
        &mut session,
        "knowledge.links",
        json!({ "nodeId": "path:Fan.md", "limit": 200 }),
    )
    .unwrap();
    let first = fan["links"].as_array().unwrap();
    assert!(
        first.len() < 200
            && first
                .iter()
                .all(|link| link["candidates"].as_array().unwrap().len() == 16)
    );
    assert_eq!(fan["nextCursor"].as_u64(), Some(first.len() as u64));
    let backlinks = op(
        &mut session,
        "knowledge.backlinks",
        json!({ "nodeId": "path:Hub.md", "limit": 200 }),
    )
    .unwrap();
    assert_eq!(backlinks["links"].as_array().unwrap().len(), 200);

    let graph = op(
        &mut session,
        "knowledge.graph",
        json!({ "nodeId": "path:Hub.md", "depth": 3, "limit": 500 }),
    )
    .unwrap();
    assert_eq!(graph["truncated"], true);
    assert_eq!(graph["nodes"][0]["nodeId"], "path:Hub.md");
    let hits = op(
        &mut session,
        "knowledge.search",
        json!({ "query": "hub", "limit": 50 }),
    )
    .unwrap();
    assert!(!hits["hits"].as_array().unwrap().is_empty());
}

/// Send `requests` to a spawned daemon and return the decoded answers.
fn run_binary(args: &[&str], requests: &[Value]) -> Vec<Frame> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_extalia-daemon"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("daemon starts");
    let mut stdin = child.stdin.take().unwrap();
    for value in requests {
        let payload = serde_json::to_vec(value).unwrap();
        stdin
            .write_all(&(payload.len() as u32).to_be_bytes())
            .unwrap();
        stdin.write_all(&payload).unwrap();
    }
    drop(stdin);
    let mut output = Vec::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_end(&mut output)
        .unwrap();
    assert_eq!(child.wait().unwrap().code(), Some(0));
    FrameReader::new(MAX_FRAME_BYTES)
        .push(&output)
        .into_iter()
        .map(Result::unwrap)
        .collect()
}

#[test]
fn the_binary_serves_one_profile_per_data_directory() {
    let dir = TempDir::spawning();
    dir.notes("work", &[("Plan.md", "# Plan\nwombat-strategy\n")]);
    dir.notes("default", &[("Home.md", "# Home\n")]);
    let data = dir.data();
    let data = data.to_str().unwrap();
    let request = |op: &str, params: Value| json!({ "schemaVersion": 1, "kind": "request", "requestId": ID, "op": op, "params": params });
    let hello = request(
        "hello",
        json!({ "clientVersion": "test", "capabilities": ["hello"] }),
    );
    let run = |profile: &str| {
        run_binary(
            &["--data-dir", data, "--profile", profile],
            &[
                hello.clone(),
                request("knowledge.sync", json!({ "mode": "incremental" })),
                request("knowledge.search", json!({ "query": "wombat-strategy" })),
                request("knowledge.status", json!({})),
            ],
        )
        .into_iter()
        .map(|frame| frame.to_value())
        .collect::<Vec<_>>()
    };
    let work = run("work");
    let capabilities = &work[0]["result"]["capabilities"];
    assert!(
        capabilities
            .as_array()
            .unwrap()
            .iter()
            .any(|op| op == "knowledge.graph")
    );
    assert_eq!(work[1]["result"]["notes"], 1);
    assert_eq!(ids(&work[2]["result"]["hits"], "nodeId"), ["path:Plan.md"]);
    assert_eq!(work[3]["result"]["vaultRoot"], "vaults/work");
    // The next daemon on the same data directory serves another profile and sees nothing of it.
    let other = run("default");
    assert_eq!(other[1]["result"]["notes"], 1);
    assert_eq!(other[2]["result"]["hits"], json!([]));
    for frame in work.iter().chain(&other) {
        assert!(
            !frame.to_string().contains(data),
            "no absolute path: {frame}"
        );
    }
}
