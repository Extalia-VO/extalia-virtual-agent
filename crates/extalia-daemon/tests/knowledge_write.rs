//! Note writes, history, rollback, memory import and custom vault roots over the wire (W5
//! slice 2c). Every answer is re-encoded, so it passed the contract validator and fits a frame.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};

use extalia_daemon::knowledge::Knowledge;
use extalia_daemon::session::Session;
use extalia_daemon::wire::{self, MAX_FRAME_BYTES};
use serde_json::{Value, json};

const ID: &str = "00000000-0000-4000-8000-000000000100";
const WS: &str = "w_mabc1234deadbeef";
/// A fake credential the import must mask.
const FAKE_KEY: &str = "sk-abcdefghijklmnop1234"; // extalia-allow-secret

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
                "extalia-daemon-kwrite-{}-{}",
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
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn start(knowledge: Knowledge) -> Session {
    let mut session = Session::new().with_knowledge(knowledge);
    op(
        &mut session,
        "hello",
        json!({ "clientVersion": "test", "capabilities": ["hello"] }),
    )
    .unwrap();
    session
}

fn default_session(dir: &TempDir, profile: &str) -> Session {
    start(Knowledge::new(&dir.data(), profile).with_home_dir(None))
}

type Answer = Result<Value, (String, Option<String>)>;

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

fn read(session: &mut Session, path: &str) -> Answer {
    op(session, "knowledge.read", json!({ "path": path }))
}

fn write(session: &mut Session, path: &str, content: &str, expected: Value) -> Answer {
    op(
        session,
        "knowledge.write",
        json!({ "path": path, "content": content, "expectedSha256": expected, "author": "user" }),
    )
}

/// The hash the daemon reports for a note's current bytes.
fn sha_of(session: &mut Session, path: &str) -> Value {
    read(session, path).unwrap()["sha256"].clone()
}

fn body(session: &mut Session, path: &str) -> Value {
    op(session, "knowledge.node", json!({ "path": path })).unwrap()["body"].clone()
}

#[test]
fn compare_and_swap_over_the_wire() {
    let dir = TempDir::new();
    let mut session = default_session(&dir, "default");
    assert_eq!(
        read(&mut session, "Inbox/Idea.md"),
        refused("not_found", "note_not_found")
    );

    // A new note: the vault is created under the first-sync rule and the index follows.
    let created = write(&mut session, "Inbox/Idea.md", "# Idea\nv1\n", Value::Null).unwrap();
    assert_eq!(created["outcome"], "written");
    assert_eq!(created["sha256"], sha_of(&mut session, "Inbox/Idea.md"));
    assert!(created.get("previousSha256").is_none());
    assert_eq!(body(&mut session, "Inbox/Idea.md"), "# Idea\nv1\n");

    let first = read(&mut session, "Inbox/Idea.md").unwrap();
    assert_eq!(first["body"], "# Idea\nv1\n");
    assert_eq!(
        (first["managed"].clone(), first["truncated"].clone()),
        (json!(false), json!(false))
    );
    // Absent expected hash = must not exist: a conflict copy, the note is kept.
    let conflict = op(
        &mut session,
        "knowledge.write",
        json!({ "path": "Inbox/Idea.md", "content": "# Mine\n", "author": "user" }),
    )
    .unwrap();
    assert_eq!(conflict["outcome"], "conflict");
    assert_eq!(conflict["conflictReason"], "hash_mismatch");
    assert_eq!(conflict["sha256"], first["sha256"]);
    let copy = conflict["conflictPath"].as_str().unwrap().to_owned();
    assert!(copy.starts_with("Inbox/Idea (conflict "), "{copy}");
    assert!(
        read(&mut session, &copy).unwrap()["body"]
            .as_str()
            .unwrap()
            .contains("conflict_of: \"Inbox/Idea.md\"")
    );
    assert_eq!(
        fs::read_to_string(dir.vault("default").join("Inbox/Idea.md")).unwrap(),
        "# Idea\nv1\n"
    );

    // An external edit after the read: the stale hash produces a conflict, nothing is replaced.
    fs::write(
        dir.vault("default").join("Inbox/Idea.md"),
        "# Idea\nexternal\n",
    )
    .unwrap();
    let stale = write(
        &mut session,
        "Inbox/Idea.md",
        "# Idea\nv2\n",
        first["sha256"].clone(),
    )
    .unwrap();
    assert_eq!(stale["outcome"], "conflict");
    assert_eq!(stale["sha256"], sha_of(&mut session, "Inbox/Idea.md"));
    let current = read(&mut session, "Inbox/Idea.md").unwrap();
    let written = write(
        &mut session,
        "Inbox/Idea.md",
        "# Idea\nv2\n",
        current["sha256"].clone(),
    )
    .unwrap();
    assert_eq!(written["outcome"], "written");
    assert_eq!(written["previousSha256"], current["sha256"]);
    assert_eq!(body(&mut session, "Inbox/Idea.md"), "# Idea\nv2\n");
    let unchanged = write(
        &mut session,
        "Inbox/Idea.md",
        "# Idea\nv2\n",
        written["sha256"].clone(),
    )
    .unwrap();
    assert_eq!(
        unchanged,
        json!({ "outcome": "unchanged", "path": "Inbox/Idea.md", "sha256": written["sha256"] })
    );

    // Only the user writes over the wire; paths follow the walker's rules.
    for author in ["extalia:memory-import", "extalia"] {
        assert_eq!(
            op(
                &mut session,
                "knowledge.write",
                json!({ "path": "a.md", "content": "x", "author": author })
            ),
            Err(("invalid_request".to_owned(), None))
        );
    }
    assert_eq!(
        write(&mut session, "notes.txt", "x", Value::Null),
        refused("invalid_request", "invalid_path")
    );
    assert_eq!(
        read(&mut session, "a/b.txt"),
        refused("invalid_request", "invalid_path")
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(dir.0.join("outside"), dir.vault("default").join("Link"))
            .unwrap();
        fs::create_dir(dir.0.join("outside")).unwrap();
        assert_eq!(
            write(&mut session, "Link/x.md", "x", Value::Null),
            refused("denied", "unsafe_path")
        );
        assert!(!dir.0.join("outside/x.md").exists());
    }
    let data = dir.data().to_string_lossy().into_owned();
    for value in [&created, &conflict, &stale, &written] {
        assert!(!value.to_string().contains(&data), "{value}");
    }
}

#[test]
fn history_lists_every_version_and_rollback_restores_one() {
    let dir = TempDir::new();
    let mut session = default_session(&dir, "default");
    let v1 = write(&mut session, "Plan.md", "v1\n", Value::Null).unwrap()["sha256"].clone();
    let v2 = write(&mut session, "Plan.md", "v2\n", v1.clone()).unwrap()["sha256"].clone();
    fs::write(dir.vault("default").join("Plan.md"), "outside\n").unwrap();
    let outside = sha_of(&mut session, "Plan.md");
    let outside = outside.as_str().unwrap().to_owned();
    let v3 = write(&mut session, "Plan.md", "v3\n", json!(outside)).unwrap()["sha256"].clone();
    let conflict = write(&mut session, "Plan.md", "late\n", v1.clone()).unwrap();

    let copy_sha = sha_of(&mut session, conflict["conflictPath"].as_str().unwrap());
    let history = op(
        &mut session,
        "knowledge.history",
        json!({ "path": "Plan.md" }),
    )
    .unwrap();
    let kinds: Vec<(&str, &str)> = history["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry["kind"].as_str().unwrap(),
                entry["sha256"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        kinds,
        [
            ("conflict", copy_sha.as_str().unwrap()),
            ("write", v3.as_str().unwrap()),
            ("external", outside.as_str()),
            ("write", v2.as_str().unwrap()),
            ("write", v1.as_str().unwrap()),
        ]
    );
    let entries = history["entries"].as_array().unwrap();
    assert_eq!(entries[0]["previousSha256"], v3);
    assert_eq!(entries[0]["conflictPath"], conflict["conflictPath"]);
    assert_eq!(entries[2]["author"], "external");
    assert_eq!(entries[1]["author"], "user");
    let limited = op(
        &mut session,
        "knowledge.history",
        json!({ "path": "Plan.md", "limit": 2 }),
    )
    .unwrap();
    assert_eq!(limited["entries"].as_array().unwrap().len(), 2);
    let copy = op(
        &mut session,
        "knowledge.history",
        json!({ "path": conflict["conflictPath"] }),
    )
    .unwrap();
    assert_eq!(copy["entries"][0]["kind"], "conflict");
    assert_eq!(
        op(
            &mut session,
            "knowledge.history",
            json!({ "path": "Missing.md" })
        )
        .unwrap()["entries"],
        json!([])
    );

    // Roll back to the external version, then to v1, through compare-and-swap.
    let stale = op(
        &mut session,
        "knowledge.rollback",
        json!({ "path": "Plan.md", "toSha256": outside, "expectedSha256": v1 }),
    )
    .unwrap();
    assert_eq!(stale["outcome"], "conflict");
    let restored = op(
        &mut session,
        "knowledge.rollback",
        json!({ "path": "Plan.md", "toSha256": outside, "expectedSha256": v3 }),
    )
    .unwrap();
    assert_eq!(
        (restored["outcome"].clone(), restored["sha256"].clone()),
        (json!("written"), json!(outside))
    );
    assert_eq!(body(&mut session, "Plan.md"), "outside\n");
    op(
        &mut session,
        "knowledge.rollback",
        json!({ "path": "Plan.md", "toSha256": v1, "expectedSha256": outside }),
    )
    .unwrap();
    assert_eq!(read(&mut session, "Plan.md").unwrap()["body"], "v1\n");
    let latest = op(
        &mut session,
        "knowledge.history",
        json!({ "path": "Plan.md", "limit": 1 }),
    )
    .unwrap();
    assert_eq!(latest["entries"][0]["kind"], "rollback");
    assert_eq!(
        op(
            &mut session,
            "knowledge.rollback",
            json!({ "path": "Plan.md", "toSha256": "f".repeat(64), "expectedSha256": v1 }),
        ),
        refused("not_found", "unknown_version")
    );
    // A deleted note is restored with a null expected hash.
    fs::remove_file(dir.vault("default").join("Plan.md")).unwrap();
    let back = op(
        &mut session,
        "knowledge.rollback",
        json!({ "path": "Plan.md", "toSha256": v2, "expectedSha256": null }),
    )
    .unwrap();
    assert_eq!(back["outcome"], "written");
    assert_eq!(read(&mut session, "Plan.md").unwrap()["body"], "v2\n");
}

#[test]
fn memory_import_is_previewed_idempotent_and_masked() {
    let dir = TempDir::new();
    let source = dir.data().join("workspaces").join(WS).join("memory");
    fs::create_dir_all(&source).unwrap();
    fs::write(
        source.join("setup.md"),
        format!("# Setup\nkey {FAKE_KEY}\n"),
    )
    .unwrap();
    fs::write(source.join("prefs.md"), "# Prefs\nwombat-preference\n").unwrap();
    fs::write(source.join("Bad Name.md"), "# Bad\n").unwrap();
    let mut session = default_session(&dir, "default");
    let import = |session: &mut Session, dry_run: bool| {
        op(
            session,
            "knowledge.importMemory",
            json!({ "workspaceId": WS, "dryRun": dry_run }),
        )
        .unwrap()
    };
    let outcomes = |report: &Value| -> Vec<(String, String)> {
        report["notes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|note| {
                (
                    note["name"].as_str().unwrap().to_owned(),
                    note["outcome"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    };

    let preview = import(&mut session, true);
    assert_eq!(
        outcomes(&preview),
        [
            ("Bad Name", "skipped"),
            ("prefs", "created"),
            ("setup", "created")
        ]
        .map(|(a, b)| (a.to_owned(), b.to_owned()))
    );
    assert_eq!(preview["notes"][0]["reason"], "invalid_name");
    assert!(preview["notes"][0].get("vaultPath").is_none());
    assert_eq!(preview["counts"]["masked"], 1);
    let memory = dir.vault("default").join("Projects").join(WS);
    assert!(!memory.exists(), "a preview writes no note");

    let report = import(&mut session, false);
    assert_eq!(outcomes(&report), outcomes(&preview));
    assert_eq!(
        report["counts"],
        json!({ "total": 3, "created": 2, "updated": 0, "unchanged": 0, "conflict": 0, "pendingConflict": 0, "missingInVault": 0, "skipped": 1, "masked": 1 })
    );
    let setup = format!("Projects/{WS}/Memory/setup.md");
    assert_eq!(report["notes"][2]["vaultPath"], setup);
    let text = read(&mut session, &setup).unwrap();
    assert_eq!(text["managed"], true);
    assert!(text["body"].as_str().unwrap().contains("key [redacted]"));
    assert!(!text["body"].as_str().unwrap().contains(FAKE_KEY));
    let hits = op(
        &mut session,
        "knowledge.search",
        json!({ "query": "wombat-preference" }),
    )
    .unwrap();
    assert_eq!(
        hits["hits"][0]["path"],
        format!("Projects/{WS}/Memory/prefs.md")
    );
    // The originals stay in place, unchanged.
    assert!(
        fs::read_to_string(source.join("setup.md"))
            .unwrap()
            .contains(FAKE_KEY)
    );

    let again = import(&mut session, false);
    assert_eq!(again["counts"]["unchanged"], 2);
    assert_eq!(again["counts"]["created"], 0);
    // A user edit, then a changed source: a single conflict copy, then pending.
    let current = read(&mut session, &setup).unwrap();
    let edited = current["body"]
        .as_str()
        .unwrap()
        .replace("# Setup", "# Setup (mine)");
    write(&mut session, &setup, &edited, current["sha256"].clone()).unwrap();
    fs::write(source.join("setup.md"), "# Setup v2\n").unwrap();
    assert_eq!(import(&mut session, true)["counts"]["conflict"], 1);
    assert_eq!(import(&mut session, false)["counts"]["conflict"], 1);
    assert_eq!(import(&mut session, false)["counts"]["pendingConflict"], 1);
    assert_eq!(read(&mut session, &setup).unwrap()["body"], edited);

    // Another workspace without memory notes: nothing to import.
    let empty = op(
        &mut session,
        "knowledge.importMemory",
        json!({ "workspaceId": "w_mzzz9999deadbeef" }),
    )
    .unwrap();
    assert_eq!(empty["counts"]["total"], 0);
    assert_eq!(
        op(
            &mut session,
            "knowledge.importMemory",
            json!({ "workspaceId": WS, "path": "/tmp" })
        ),
        Err(("invalid_request".to_owned(), None))
    );
}

#[test]
fn custom_vault_roots_are_validated_and_reported_by_folder_name() {
    let dir = TempDir::new();
    let root = dir.0.join("My Vault");
    fs::create_dir(&root).unwrap();
    let mut session = start(
        Knowledge::new(&dir.data(), "work")
            .with_vault_root(root.clone())
            .with_home_dir(None),
    );
    let status = op(&mut session, "knowledge.status", json!({})).unwrap();
    assert_eq!(status["vaultRoot"], "custom:My Vault");
    assert_eq!(status["vaultPresent"], true);
    write(
        &mut session,
        "Note.md",
        "# Note\nquokka-fact\n",
        Value::Null,
    )
    .unwrap();
    assert!(
        root.join("Note.md").is_file(),
        "writes go to the custom root"
    );
    assert!(
        !dir.vault("work").exists(),
        "the default root is not created"
    );
    let hits = op(
        &mut session,
        "knowledge.search",
        json!({ "query": "quokka-fact" }),
    )
    .unwrap();
    assert_eq!(hits["hits"][0]["path"], "Note.md");
    let sync = op(
        &mut session,
        "knowledge.sync",
        json!({ "mode": "incremental" }),
    )
    .unwrap();
    assert_eq!(sync["vaultCreated"], false);
    let data = dir.data().to_string_lossy().into_owned();
    let parent = dir.0.to_string_lossy().into_owned();
    for value in [&status, &sync, &hits] {
        assert!(
            !value.to_string().contains(&data) && !value.to_string().contains(&parent),
            "{value}"
        );
    }

    // A root that disappears is unavailable and never recreated or replaced by the default.
    fs::rename(&root, dir.0.join("Elsewhere")).unwrap();
    assert_eq!(
        op(&mut session, "knowledge.status", json!({})).unwrap()["vaultPresent"],
        false
    );
    assert_eq!(
        read(&mut session, "Note.md"),
        refused("storage_failure", "vault_unavailable")
    );
    assert_eq!(
        write(&mut session, "New.md", "x", Value::Null),
        refused("storage_failure", "vault_unavailable")
    );
    assert_eq!(
        op(
            &mut session,
            "knowledge.sync",
            json!({ "mode": "incremental" })
        ),
        refused("storage_failure", "vault_unavailable")
    );
    assert!(!root.exists() && !dir.vault("work").exists());

    // Refused roots: the home directory and its ancestors, the data directory, its state.
    fs::create_dir_all(dir.data().join("state")).unwrap();
    let home = dir.0.join("home");
    fs::create_dir(&home).unwrap();
    for (root, home) in [
        (home.clone(), Some(home.clone())),
        (dir.0.clone(), Some(home.clone())),
        (dir.data(), None),
        (dir.data().join("state"), None),
        (dir.0.join("missing"), None),
    ] {
        let mut session = start(
            Knowledge::new(&dir.data(), "work")
                .with_vault_root(root.clone())
                .with_home_dir(home),
        );
        let status = op(&mut session, "knowledge.status", json!({})).unwrap();
        assert_eq!(status["vaultPresent"], false, "{}", root.display());
        assert_eq!(
            write(&mut session, "x.md", "x", Value::Null),
            refused("storage_failure", "vault_unavailable"),
            "{}",
            root.display()
        );
        assert!(!dir.0.join("missing").exists());
    }
}

#[test]
fn profiles_keep_their_own_notes_and_history() {
    let dir = TempDir::new();
    let mut work = default_session(&dir, "work");
    let mut personal = default_session(&dir, "personal");
    let v1 = write(&mut work, "Secret.md", "# Work only\n", Value::Null).unwrap()["sha256"].clone();
    assert_eq!(
        read(&mut personal, "Secret.md"),
        refused("not_found", "note_not_found")
    );
    assert_eq!(
        op(
            &mut personal,
            "knowledge.history",
            json!({ "path": "Secret.md" })
        )
        .unwrap()["entries"],
        json!([])
    );
    assert_eq!(
        op(
            &mut personal,
            "knowledge.rollback",
            json!({ "path": "Secret.md", "toSha256": v1, "expectedSha256": null })
        ),
        refused("not_found", "unknown_version")
    );
    assert!(!dir.vault("personal").join("Secret.md").exists());
}

#[test]
fn large_reads_are_truncated_below_the_frame_limit() {
    let dir = TempDir::new();
    fs::create_dir_all(dir.vault("default")).unwrap();
    // 1 MiB of control characters: each one escapes to six JSON bytes.
    let text = "\u{1}".repeat(1024 * 1024);
    fs::write(dir.vault("default").join("Big.md"), &text).unwrap();
    let plain = "x".repeat(300 * 1024);
    fs::write(dir.vault("default").join("Plain.md"), &plain).unwrap();
    let mut session = default_session(&dir, "default");
    let big = read(&mut session, "Big.md").unwrap();
    assert_eq!(big["truncated"], true);
    assert_ne!(big["sha256"], sha_of(&mut session, "Plain.md"));
    assert!(big["body"].as_str().unwrap().len() < 256 * 1024);
    let read_plain = read(&mut session, "Plain.md").unwrap();
    assert_eq!(read_plain["body"].as_str().unwrap().len(), 256 * 1024);
    // The largest content that fits a frame is written.
    let content = "y".repeat(MAX_FRAME_BYTES - 1024);
    assert_eq!(
        write(&mut session, "Max.md", &content, Value::Null).unwrap()["outcome"],
        "written"
    );
    // Over the note cap (1 MiB): too large.
    fs::write(
        dir.vault("default").join("Huge.md"),
        "z".repeat(1024 * 1024 + 1),
    )
    .unwrap();
    assert_eq!(
        read(&mut session, "Huge.md"),
        refused("capacity_exceeded", "too_large")
    );
}

#[test]
fn the_binary_checks_the_vault_root_argument() {
    let dir = TempDir::spawning();
    let root = dir.0.join("Vault");
    fs::create_dir(&root).unwrap();
    let data = dir.data();
    let run = |args: &[&str]| {
        let mut child = Command::new(env!("CARGO_BIN_EXE_extalia-daemon"))
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let hello = json!({ "schemaVersion": 1, "kind": "request", "requestId": ID, "op": "hello",
            "params": { "clientVersion": "test", "capabilities": ["hello"] } });
        let status = json!({ "schemaVersion": 1, "kind": "request", "requestId": ID, "op": "knowledge.status", "params": {} });
        let mut stdin = child.stdin.take().unwrap();
        for value in [hello, status] {
            let payload = serde_json::to_vec(&value).unwrap();
            let _ = stdin.write_all(&(payload.len() as u32).to_be_bytes());
            let _ = stdin.write_all(&payload);
        }
        drop(stdin);
        let output = child.wait_with_output().unwrap();
        let frames: Vec<Value> = wire::FrameReader::new(MAX_FRAME_BYTES)
            .push(&output.stdout)
            .into_iter()
            .map(|frame| frame.unwrap().to_value())
            .collect();
        (output.status.code(), frames)
    };
    let data = data.to_str().unwrap();
    let root_text = root.to_str().unwrap();
    assert_eq!(
        run(&["--data-dir", data, "--vault-root", "relative/vault"]).0,
        Some(2)
    );
    assert_eq!(run(&["--vault-root", root_text]).0, Some(2));
    assert_eq!(
        run(&[
            "--data-dir",
            data,
            "--vault-root",
            root_text,
            "--vault-root",
            root_text
        ])
        .0,
        Some(2)
    );
    let (code, frames) = run(&[
        "--data-dir",
        data,
        "--profile",
        "work",
        &format!("--vault-root={root_text}"),
    ]);
    assert_eq!(code, Some(0));
    assert_eq!(frames[1]["result"]["vaultRoot"], "custom:Vault");
    assert_eq!(frames[1]["result"]["vaultPresent"], true);
    assert!(!frames[1].to_string().contains(root_text));
    let _ = Path::new(root_text);
}
