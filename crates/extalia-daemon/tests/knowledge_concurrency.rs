//! Knowledge requests run on their own thread (`session.rs`): while a sync is in flight the
//! daemon keeps answering other requests promptly, answers leave out of request order but
//! carry their request ids, knowledge requests keep their arrival order, and stdin EOF
//! finishes the sync before the daemon ends. `serve` runs in process on OS pipes with a
//! sync hook that holds the sync until the test releases it; one test spawns the binary.

use std::fs;
use std::io::{PipeWriter, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use extalia_core::CoreStore;
use extalia_core::adapters::sqlite::store_path;
use extalia_core::knowledge::KnowledgeStore;
use extalia_core::skills::ProfileId;
use extalia_daemon::knowledge::Knowledge;
use extalia_daemon::missions::Missions;
use extalia_daemon::session::{Exit, Session, serve};
use extalia_daemon::wire::{FrameReader, MAX_FRAME_BYTES};
use serde_json::{Value, json};

mod support;

use support::Isolation;

/// An answer to a request that does not wait for the held sync arrives well within this.
const PROMPT: Duration = Duration::from_secs(2);
/// Upper bound for anything the test waits for (a hung daemon fails instead of hanging).
const PATIENCE: Duration = Duration::from_secs(30);
const WORKSPACE: &str = "00000000-0000-4000-8000-000000000001";
const LEAD: &str = "00000000-0000-4000-8000-000000000003";
const WORKER: &str = "00000000-0000-4000-8000-000000000004";
const SESSION: &str = "00000000-0000-4000-8000-000000000014";

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
                "extalia-daemon-kconc-{}-{}",
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

    /// Write `count` linked notes into the default profile's vault (created private).
    fn notes(&self, count: usize) {
        let root = self.data().join("vaults/default");
        fs::create_dir_all(&root).unwrap();
        #[cfg(unix)]
        for dir in [&root, &self.data().join("vaults")] {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).unwrap();
        }
        for n in 0..count {
            let next = (n + 1) % count;
            fs::write(
                root.join(format!("Note {n}.md")),
                format!("# Note {n}\nSee [[Note {next}]] about wombat {n}.\n"),
            )
            .unwrap();
        }
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn uuid(n: u64) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}

fn request(id: &str, op: &str, params: Value) -> Value {
    json!({ "schemaVersion": 1, "kind": "request", "requestId": id, "op": op, "params": params })
}

fn hello(id: &str) -> Value {
    request(
        id,
        "hello",
        json!({ "clientVersion": "test", "capabilities": ["hello"] }),
    )
}

fn encoded(value: &Value) -> Vec<u8> {
    let payload = serde_json::to_vec(value).unwrap();
    [(payload.len() as u32).to_be_bytes().as_slice(), &payload].concat()
}

/// A daemon session served by `serve` on a thread, over OS pipes.
struct Served {
    input: Option<PipeWriter>,
    answers: Receiver<Value>,
    server: JoinHandle<(Exit, Session)>,
}

/// Gate of the sync hook: `started` fires when a sync request begins; it then waits until
/// the test sends on `release` (or [`PATIENCE`] passes).
struct Gate {
    started: Receiver<()>,
    release: Sender<()>,
}

impl Served {
    /// `serve` the default profile of `dir` with a core store and a held sync.
    fn start(dir: &TempDir) -> (Self, Gate) {
        let (started, started_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let knowledge = Knowledge::new(&dir.data(), "default").with_sync_hook(move || {
            started.send(()).unwrap();
            let _ = release_rx.recv_timeout(PATIENCE);
        });
        let missions = Missions::new(
            CoreStore::open(&store_path(&dir.data())).unwrap(),
            "default".to_owned(),
        );
        let (input, input_writer) = std::io::pipe().unwrap();
        let (mut output_reader, output) = std::io::pipe().unwrap();
        let server = thread::spawn(move || {
            let mut session = Session::with_missions(missions).with_knowledge(knowledge);
            let exit = serve(input, output, &mut session).unwrap();
            (exit, session)
        });
        let (answer, answers) = mpsc::channel();
        thread::spawn(move || {
            let mut reader = FrameReader::new(MAX_FRAME_BYTES);
            let mut chunk = vec![0; 64 * 1024];
            loop {
                let read = match output_reader.read(&mut chunk) {
                    Ok(0) | Err(_) => return,
                    Ok(read) => read,
                };
                for frame in reader.push(&chunk[..read]) {
                    if answer.send(frame.unwrap().to_value()).is_err() {
                        return;
                    }
                }
            }
        });
        let served = Self {
            input: Some(input_writer),
            answers,
            server,
        };
        let gate = Gate {
            started: started_rx,
            release,
        };
        (served, gate)
    }

    fn send(&mut self, value: &Value) {
        self.input
            .as_mut()
            .expect("stdin is open")
            .write_all(&encoded(value))
            .unwrap();
    }

    fn next(&self) -> Value {
        self.answers
            .recv_timeout(PATIENCE)
            .expect("the daemon answers")
    }

    /// Send `value` and return its answer with the time it took.
    fn call(&mut self, value: &Value) -> (Value, Duration) {
        let sent = Instant::now();
        self.send(value);
        let answer = self.next();
        (answer, sent.elapsed())
    }
}

impl Gate {
    fn wait_started(&self) {
        self.started
            .recv_timeout(PATIENCE)
            .expect("the sync started");
    }
}

fn create_params(mission: &str, task: &str) -> Value {
    json!({
        "mission": { "schemaVersion": 1, "id": mission, "workspaceId": WORKSPACE, "leadAgentId": LEAD,
            "budgetId": "00000000-0000-4000-8000-000000000006", "state": "queued",
            "createdAt": "2026-10-22T11:00:00.000Z", "updatedAt": "2026-10-22T11:00:00.000Z", "version": 1 },
        "graph": { "schemaVersion": 1, "missionId": mission, "tasks": [
            { "schemaVersion": 1, "id": task, "missionId": mission, "dependsOn": [],
              "assignedAgentId": WORKER, "state": "queued", "attempt": 0,
              "requirements": ["Build artifact"], "evidenceIds": [] }] },
    })
}

fn running(mission: &str, id: &str) -> Value {
    json!({ "event": { "schemaVersion": 1, "id": id, "workspaceId": WORKSPACE, "sessionId": SESSION,
        "missionId": mission, "agentId": LEAD,
        "source": { "runtime": "extalia-native", "channel": "system" },
        "observedAt": "2026-10-22T12:00:00.000Z", "confidence": "reported",
        "body": { "type": "mission.state", "state": "running" } } })
}

#[test]
fn a_sync_in_flight_never_holds_back_other_requests() {
    let dir = TempDir::new();
    dir.notes(4);
    let (mut daemon, gate) = Served::start(&dir);
    let (answer, _) = daemon.call(&hello(&uuid(1)));
    assert_eq!(answer["requestId"], uuid(1));

    let sync = uuid(2);
    daemon.send(
        &json!({ "schemaVersion": 1, "kind": "request", "requestId": sync,
        "op": "knowledge.sync", "deadlineMs": 600_000, "params": { "mode": "incremental" } }),
    );
    gate.wait_started();

    // The sync is held: every other request is answered, promptly, ahead of it.
    let mission = uuid(0x10);
    for (id, op, params, result) in [
        (uuid(3), "health", json!({}), "status"),
        (
            uuid(4),
            "permission.check",
            json!({ "access": "read", "mode": "workspace",
                "workspacePermissions": { "fileWrite": "ask", "commands": "ask" }, "sessionGrants": [] }),
            "decision",
        ),
        (
            uuid(5),
            "mission.create",
            create_params(&mission, &uuid(0x11)),
            "missionId",
        ),
        (
            uuid(6),
            "event.commit",
            running(&mission, &uuid(0x12)),
            "sequence",
        ),
    ] {
        let (answer, took) = daemon.call(&request(&id, op, params));
        assert_eq!(
            (answer["kind"].as_str(), answer["requestId"].as_str()),
            (Some("response"), Some(id.as_str())),
            "{op}: {answer}"
        );
        assert!(answer["result"].get(result).is_some(), "{op}: {answer}");
        assert!(
            took < PROMPT,
            "{op} took {took:?} while a sync was in flight"
        );
    }

    // Knowledge requests queue behind the sync, in arrival order; one whose deadline passed
    // while it waited is not run.
    daemon.send(&request(&uuid(7), "knowledge.status", json!({})));
    daemon.send(
        &json!({ "schemaVersion": 1, "kind": "request", "requestId": uuid(8),
        "op": "knowledge.search", "deadlineMs": 1, "params": { "query": "wombat" } }),
    );
    let (answer, took) = daemon.call(&request(&uuid(9), "health", json!({})));
    assert_eq!(answer["requestId"], uuid(9), "{answer}");
    assert!(took < PROMPT);

    gate.release.send(()).unwrap();
    let answers: Vec<Value> = (0..3).map(|_| daemon.next()).collect();
    let ids: Vec<_> = answers.iter().map(|a| a["requestId"].clone()).collect();
    assert_eq!(ids, [json!(sync), json!(uuid(7)), json!(uuid(8))]);
    assert_eq!(answers[0]["op"], "knowledge.sync");
    assert_eq!(answers[0]["result"]["notes"], 4);
    assert_eq!(answers[1]["result"]["state"], "ready");
    assert_eq!(answers[1]["result"]["counts"]["notes"], 4);
    assert_eq!(answers[2]["kind"], "error");
    assert_eq!(answers[2]["error"]["code"], "deadline_exceeded");

    // Afterwards knowledge requests are answered as before.
    let (answer, _) = daemon.call(&request(
        &uuid(10),
        "knowledge.search",
        json!({ "query": "wombat" }),
    ));
    assert_eq!(answer["requestId"], uuid(10));
    assert!(!answer["result"]["hits"].as_array().unwrap().is_empty());

    drop(daemon.input.take());
    let (exit, _session) = daemon.server.join().unwrap();
    assert_eq!(exit, Exit::Eof);
}

#[test]
fn stdin_ending_during_a_sync_finishes_it_then_ends_cleanly() {
    let dir = TempDir::new();
    dir.notes(3);
    let (mut daemon, gate) = Served::start(&dir);
    daemon.call(&hello(&uuid(1)));
    daemon.send(&request(
        &uuid(2),
        "knowledge.sync",
        json!({ "mode": "rebuild" }),
    ));
    daemon.send(&request(&uuid(3), "knowledge.status", json!({})));
    gate.wait_started();
    // EOF while the sync is held: `serve` cannot return before the queued requests ran.
    drop(daemon.input.take());
    assert!(
        daemon
            .answers
            .recv_timeout(Duration::from_millis(200))
            .is_err(),
        "nothing is answered while the sync is held"
    );
    assert!(!daemon.server.is_finished());

    gate.release.send(()).unwrap();
    let sync = daemon.next();
    assert_eq!(
        (sync["requestId"].as_str(), &sync["result"]["notes"]),
        (Some(uuid(2).as_str()), &json!(3))
    );
    assert_eq!(daemon.next()["result"]["state"], "ready");
    let (exit, session) = daemon.server.join().unwrap();
    assert_eq!(exit, Exit::Eof);
    assert!(
        daemon.answers.recv_timeout(PATIENCE).is_err(),
        "the output ends with the daemon"
    );
    // The index (and its lock) is released with the session.
    drop(session);
    let profile = ProfileId::parse("default").unwrap();
    let index = KnowledgeStore::open(&dir.data(), &profile).unwrap();
    assert_eq!(index.stats().unwrap().notes, 3);
}

#[test]
fn the_binary_finishes_a_long_sync_after_stdin_ends() {
    let dir = TempDir::spawning();
    dir.notes(2_000);
    let data = dir.data();
    let mut child = Command::new(env!("CARGO_BIN_EXE_extalia-daemon"))
        .args(["--data-dir", data.to_str().unwrap()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("daemon starts");
    let mut stdin = child.stdin.take().unwrap();
    for value in [
        hello(&uuid(1)),
        request(&uuid(2), "knowledge.sync", json!({ "mode": "incremental" })),
        request(&uuid(3), "health", json!({})),
    ] {
        stdin.write_all(&encoded(&value)).unwrap();
    }
    // Stdin ends while the sync walks the vault.
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(0));
    let answers: Vec<Value> = FrameReader::new(MAX_FRAME_BYTES)
        .push(&output.stdout)
        .into_iter()
        .map(|frame| frame.unwrap().to_value())
        .collect();
    let mut ids: Vec<_> = answers
        .iter()
        .map(|answer| answer["requestId"].as_str().unwrap().to_owned())
        .collect();
    ids.sort();
    assert_eq!(ids, [uuid(1), uuid(2), uuid(3)]);
    let sync = answers
        .iter()
        .find(|answer| answer["requestId"] == uuid(2))
        .unwrap();
    assert_eq!(sync["result"]["notes"], 2_000);
}
