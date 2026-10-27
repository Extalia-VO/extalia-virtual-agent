//! Slice A over stdio (audit PR 6): the built daemon serves `mission.create`,
//! `task.transition` and `event.commit` from `<data>/state/core.sqlite`, one daemon per
//! store, one profile per daemon. Temporary directories only.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};

use extalia_daemon::wire::{self, ErrorCode, Frame, Op, ResponseResult};
use rusqlite::Connection;
use serde_json::{Value, json};

const WORKSPACE: &str = "00000000-0000-4000-8000-000000000001";
const LEAD: &str = "00000000-0000-4000-8000-000000000003";
const WORKER: &str = "00000000-0000-4000-8000-000000000004";
const SESSION: &str = "00000000-0000-4000-8000-000000000014";

fn uuid(n: u64) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        loop {
            let dir = std::env::temp_dir().join(format!(
                "extalia-missions-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match std::fs::create_dir(&dir) {
                Ok(()) => return Self(dir),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => panic!("cannot create a temporary directory: {error}"),
            }
        }
    }

    fn arg(&self) -> String {
        self.0.to_str().unwrap().to_owned()
    }

    fn store(&self) -> PathBuf {
        self.0.join("state").join("core.sqlite")
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Daemon {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: ChildStdout,
    next: u64,
}

impl Daemon {
    fn spawn(args: &[&str]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_extalia-daemon"))
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("daemon starts");
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        Self {
            child,
            stdin,
            stdout,
            next: 0x100,
        }
    }

    /// Spawn on `dir` and complete the handshake; returns the advertised capabilities.
    fn ready(dir: &TempDir, profile: Option<&str>) -> (Self, Vec<Op>) {
        let data_dir = dir.arg();
        let mut args = vec!["--data-dir", data_dir.as_str()];
        if let Some(profile) = profile {
            args.extend(["--profile", profile]);
        }
        let mut daemon = Self::spawn(&args);
        let capabilities = match daemon.call(
            "hello",
            json!({ "clientVersion": "0.0.0-test", "capabilities": ["hello", "mission.create"] }),
        ) {
            Ok(ResponseResult::Hello { capabilities, .. }) => capabilities,
            other => panic!("expected the hello response, got {other:?}"),
        };
        (daemon, capabilities)
    }

    fn frame(&mut self, op: &str, params: Value) -> (String, Vec<u8>) {
        self.next += 1;
        let id = uuid(self.next);
        let value = json!({ "schemaVersion": 1, "kind": "request", "requestId": id, "op": op, "params": params });
        let payload = serde_json::to_vec(&value).unwrap();
        let mut bytes = (payload.len() as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(&payload);
        (id, bytes)
    }

    fn receive(&mut self) -> Frame {
        let mut header = [0; 4];
        self.stdout.read_exact(&mut header).unwrap();
        let mut payload = vec![0; u32::from_be_bytes(header) as usize];
        self.stdout.read_exact(&mut payload).unwrap();
        wire::decode_payload(&payload).expect("daemon output follows the contract")
    }

    /// One request and its answer: the result, or the error code.
    fn call(&mut self, op: &str, params: Value) -> Result<ResponseResult, ErrorCode> {
        let (id, bytes) = self.frame(op, params);
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(&bytes).unwrap();
        stdin.flush().unwrap();
        match self.receive() {
            Frame::Response(response) => {
                assert_eq!(response.request_id, id);
                Ok(response.result)
            }
            Frame::Error(error) => {
                assert_eq!(error.request_id.as_deref(), Some(id.as_str()));
                Err(error.code)
            }
            other => panic!("unexpected frame {other:?}"),
        }
    }

    fn finish(mut self) -> i32 {
        drop(self.stdin.take());
        let mut rest = Vec::new();
        self.stdout.read_to_end(&mut rest).unwrap();
        assert!(rest.is_empty(), "unexpected output after the last frame");
        self.child.wait().unwrap().code().expect("exited normally")
    }
}

fn create_params(mission: &str, tasks: &[&str]) -> Value {
    let tasks: Vec<Value> = tasks
        .iter()
        .map(|id| {
            json!({ "schemaVersion": 1, "id": id, "missionId": mission, "dependsOn": [],
                "assignedAgentId": WORKER, "state": "queued", "attempt": 0,
                "requirements": ["Build artifact"], "evidenceIds": [] })
        })
        .collect();
    json!({
        "mission": { "schemaVersion": 1, "id": mission, "workspaceId": WORKSPACE, "leadAgentId": LEAD,
            "budgetId": "00000000-0000-4000-8000-000000000006", "state": "queued",
            "createdAt": "2026-10-22T11:00:00.000Z", "updatedAt": "2026-10-22T11:00:00.000Z", "version": 1 },
        "graph": { "schemaVersion": 1, "missionId": mission, "tasks": tasks },
    })
}

fn transition(mission: &str, task: &str, event: &str, from: &str, to: &str) -> Value {
    json!({ "missionId": mission, "taskId": task, "eventId": event, "from": from, "to": to })
}

fn event(mission: &str, task: Option<&str>, id: &str, body: Value) -> Value {
    let mut event = json!({ "schemaVersion": 1, "id": id, "workspaceId": WORKSPACE, "sessionId": SESSION,
        "missionId": mission, "agentId": WORKER,
        "source": { "runtime": "extalia-native", "channel": "system" },
        "observedAt": "2026-10-22T12:00:00.000Z", "confidence": "reported", "body": body });
    match task {
        Some(task) => event["taskId"] = json!(task),
        None => event["agentId"] = json!(LEAD),
    }
    json!({ "event": event })
}

fn activity(mission: &str, task: &str, id: &str) -> Value {
    event(
        mission,
        Some(task),
        id,
        json!({ "type": "agent.state", "state": "working", "activity": "read" }),
    )
}

fn sequence(result: Result<ResponseResult, ErrorCode>) -> (u64, bool) {
    match result {
        Ok(ResponseResult::EventCommit(ack)) => (ack.sequence, ack.duplicate),
        Ok(ResponseResult::TaskTransition(ack)) => (ack.sequence, false),
        other => panic!("expected an acknowledgement, got {other:?}"),
    }
}

/// Inspect the file after the daemon exited (it holds the only writer otherwise).
fn inspect(path: &Path) -> Connection {
    Connection::open(path).unwrap()
}

#[test]
fn round_trip_of_all_three_operations() {
    let dir = TempDir::new();
    let (mut daemon, capabilities) = Daemon::ready(&dir, None);
    for op in [Op::MissionCreate, Op::TaskTransition, Op::EventCommit] {
        assert!(capabilities.contains(&op), "{op:?} advertised");
    }
    let mission = uuid(2);
    let (task, other_task) = (uuid(5), uuid(0x20));
    let created = daemon.call(
        "mission.create",
        create_params(&mission, &[&task, &other_task]),
    );
    match created {
        Ok(ResponseResult::MissionCreate(ack)) => {
            assert_eq!((ack.mission_id, ack.version), (mission.clone(), 1))
        }
        other => panic!("{other:?}"),
    }
    // An identical retry returns the original acknowledgement.
    assert!(matches!(
        daemon.call(
            "mission.create",
            create_params(&mission, &[&task, &other_task])
        ),
        Ok(ResponseResult::MissionCreate(_))
    ));
    let running = event(
        &mission,
        None,
        &uuid(0x30),
        json!({ "type": "mission.state", "state": "running" }),
    );
    assert_eq!(sequence(daemon.call("event.commit", running)), (2, false));
    let start = transition(&mission, &task, &uuid(0x31), "queued", "running");
    match daemon.call("task.transition", start.clone()) {
        Ok(ResponseResult::TaskTransition(ack)) => {
            assert_eq!((ack.state.as_str(), ack.sequence), ("running", 3));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(
        sequence(daemon.call("task.transition", start)),
        (3, false),
        "idempotent"
    );
    let first = activity(&mission, &task, &uuid(0x32));
    assert_eq!(
        sequence(daemon.call("event.commit", first.clone())),
        (4, false)
    );
    assert_eq!(
        sequence(daemon.call("event.commit", first)),
        (4, true),
        "duplicate"
    );
    let conflicting = event(
        &mission,
        Some(&task),
        &uuid(0x32),
        json!({ "type": "agent.state", "state": "idle" }),
    );
    assert_eq!(
        daemon.call("event.commit", conflicting),
        Err(ErrorCode::Conflict)
    );
    let stale = transition(&mission, &task, &uuid(0x33), "queued", "running");
    assert_eq!(
        daemon.call("task.transition", stale),
        Err(ErrorCode::Conflict)
    );
    let unknown = transition(&uuid(0x99), &task, &uuid(0x34), "queued", "running");
    assert_eq!(
        daemon.call("task.transition", unknown),
        Err(ErrorCode::NotFound)
    );
    let prose = event(
        &mission,
        Some(&task),
        &uuid(0x35),
        json!({ "type": "model.delta", "text": "hello" }),
    );
    assert_eq!(
        daemon.call("event.commit", prose),
        Err(ErrorCode::InvalidRequest)
    );
    let done = transition(&mission, &task, &uuid(0x36), "running", "completed");
    assert_eq!(sequence(daemon.call("task.transition", done)), (5, false));
    assert_eq!(daemon.finish(), 0);

    // Everything acknowledged is in the file, in sequence order.
    let conn = inspect(&dir.store());
    let sequences: Vec<i64> = conn
        .prepare("SELECT sequence FROM events WHERE mission_id = ?1 ORDER BY sequence")
        .unwrap()
        .query_map([&mission], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(sequences, [1, 2, 3, 4, 5]);
    let profile: String = conn
        .query_row("SELECT DISTINCT profile_id FROM tasks", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(profile, "default");
}

#[test]
fn profiles_are_isolated_per_daemon() {
    let dir = TempDir::new();
    let mission = uuid(2);
    let task = uuid(5);
    let (mut daemon, _) = Daemon::ready(&dir, Some("work"));
    assert!(
        daemon
            .call("mission.create", create_params(&mission, &[&task]))
            .is_ok()
    );
    assert_eq!(daemon.finish(), 0);

    let (mut daemon, _) = Daemon::ready(&dir, None);
    let start = transition(&mission, &task, &uuid(0x40), "queued", "running");
    assert_eq!(
        daemon.call("task.transition", start),
        Err(ErrorCode::NotFound)
    );
    let mission_event = event(
        &mission,
        None,
        &uuid(0x41),
        json!({ "type": "mission.state", "state": "running" }),
    );
    assert_eq!(
        daemon.call("event.commit", mission_event),
        Err(ErrorCode::NotFound)
    );
    assert_eq!(
        daemon.call("mission.create", create_params(&mission, &[&task])),
        Err(ErrorCode::Conflict)
    );
    assert_eq!(daemon.finish(), 0);
    let conn = inspect(&dir.store());
    let rows: i64 = conn
        .query_row(
            "SELECT count(*) FROM events WHERE profile_id <> 'work'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(rows, 0, "the default profile wrote nothing");

    for invalid in ["Work", "-work", "", "a/b"] {
        let data_dir = dir.arg();
        let daemon = Daemon::spawn(&["--data-dir", &data_dir, "--profile", invalid]);
        assert_eq!(daemon.finish(), 2, "{invalid:?}");
    }
}

#[test]
fn without_a_store_the_operations_are_not_offered() {
    let mut daemon = Daemon::spawn(&[]);
    match daemon.call(
        "hello",
        json!({ "clientVersion": "0.0.0-test", "capabilities": ["hello"] }),
    ) {
        Ok(ResponseResult::Hello { capabilities, .. }) => {
            assert!(!capabilities.contains(&Op::MissionCreate));
            assert!(!capabilities.contains(&Op::MissionSnapshot));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(
        daemon.call("mission.create", create_params(&uuid(2), &[&uuid(5)])),
        Err(ErrorCode::UnknownOp)
    );
    assert_eq!(
        daemon.call("mission.snapshot", json!({ "missionId": uuid(2) })),
        Err(ErrorCode::UnknownOp)
    );
    assert_eq!(daemon.finish(), 0);
}

#[test]
fn a_second_daemon_on_the_same_data_dir_is_refused() {
    let dir = TempDir::new();
    let (mut first, _) = Daemon::ready(&dir, None);
    // The second one exits before reading any frame, without touching the store.
    let data_dir = dir.arg();
    let mut second = Daemon::spawn(&["--data-dir", &data_dir, "--profile", "work"]);
    let status = second.child.wait().unwrap();
    assert_eq!(status.code(), Some(4));
    let mut output = Vec::new();
    second.stdout.read_to_end(&mut output).unwrap();
    assert!(output.is_empty(), "no frame was answered");
    // The first daemon is unaffected.
    assert!(
        first
            .call("mission.create", create_params(&uuid(2), &[&uuid(5)]))
            .is_ok()
    );
    assert_eq!(first.finish(), 0);
    // Released on exit.
    let (daemon, _) = Daemon::ready(&dir, None);
    assert_eq!(daemon.finish(), 0);
}

#[test]
fn killed_mid_run_leaves_nothing_partial_and_recovers_as_unknown() {
    let dir = TempDir::new();
    let (mut daemon, _) = Daemon::ready(&dir, None);
    let mission = uuid(2);
    let task = uuid(5);
    assert!(
        daemon
            .call("mission.create", create_params(&mission, &[&task]))
            .is_ok()
    );
    let running = event(
        &mission,
        None,
        &uuid(0x50),
        json!({ "type": "mission.state", "state": "running" }),
    );
    sequence(daemon.call("event.commit", running));
    sequence(daemon.call(
        "task.transition",
        transition(&mission, &task, &uuid(0x51), "queued", "running"),
    ));

    // A burst of activity events and new missions, killed while the daemon works on it.
    let mut requests = Vec::new();
    let mut expected = Vec::new();
    for index in 0..240u64 {
        let (id, bytes) = if index % 4 == 3 {
            let other = uuid(0x1000 + index);
            let tasks = [uuid(0x2000 + 2 * index), uuid(0x2001 + 2 * index)];
            daemon.frame(
                "mission.create",
                create_params(&other, &[&tasks[0], &tasks[1]]),
            )
        } else {
            daemon.frame(
                "event.commit",
                activity(&mission, &task, &uuid(0x100 + index)),
            )
        };
        expected.push((id, index));
        requests.extend(bytes);
    }
    let mut stdin = daemon.stdin.take().unwrap();
    let writer = std::thread::spawn(move || {
        // The pipe breaks when the daemon is killed; that is expected.
        let _ = stdin.write_all(&requests);
        stdin
    });
    let mut acknowledged = Vec::new();
    for (id, index) in expected.iter().take(60) {
        match daemon.receive() {
            Frame::Response(response) => {
                assert_eq!(&response.request_id, id);
                acknowledged.push(*index);
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    daemon.child.kill().unwrap();
    daemon.child.wait().unwrap();
    drop(writer.join());

    let conn = inspect(&dir.store());
    assert_eq!(
        conn.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    // Every acknowledged request is durable.
    for index in &acknowledged {
        let present: bool = if index % 4 == 3 {
            conn.query_row(
                "SELECT EXISTS (SELECT 1 FROM missions WHERE mission_id = ?1)",
                [uuid(0x1000 + index)],
                |row| row.get(0),
            )
        } else {
            conn.query_row(
                "SELECT EXISTS (SELECT 1 FROM events WHERE event_id = ?1)",
                [uuid(0x100 + index)],
                |row| row.get(0),
            )
        }
        .unwrap();
        assert!(present, "acknowledged request {index} is durable");
    }
    // Nothing partial: each journal is contiguous from 1, each mission has its tasks and
    // its creation record.
    let journals: Vec<(String, i64, i64, i64)> = conn
        .prepare("SELECT mission_id, count(*), min(sequence), max(sequence) FROM events GROUP BY mission_id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let missions: i64 = conn
        .query_row("SELECT count(*) FROM missions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(journals.len() as i64, missions);
    for (mission_id, count, first, last) in &journals {
        assert_eq!((*first, *last), (1, *count), "{mission_id}");
        let tasks: i64 = conn
            .query_row(
                "SELECT count(*) FROM tasks WHERE mission_id = ?1",
                [mission_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            tasks,
            if *mission_id == mission { 1 } else { 2 },
            "{mission_id}"
        );
    }
    drop(conn);

    // The lock died with the process. On restart the running task becomes unknown and its
    // mission recovering; the interrupted work is never resumed.
    let (mut daemon, _) = Daemon::ready(&dir, None);
    let finish = transition(&mission, &task, &uuid(0x60), "running", "completed");
    assert_eq!(
        daemon.call("task.transition", finish),
        Err(ErrorCode::Conflict)
    );
    let restart = transition(&mission, &task, &uuid(0x61), "unknown", "running");
    assert_eq!(
        daemon.call("task.transition", restart),
        Err(ErrorCode::InvalidRequest)
    );
    assert_eq!(
        daemon.call("event.commit", activity(&mission, &task, &uuid(0x62))),
        Err(ErrorCode::Conflict)
    );
    // Earlier acknowledgements are still answered identically.
    if let Some(index) = acknowledged.iter().find(|index| *index % 4 != 3) {
        let (_, duplicate) = sequence(daemon.call(
            "event.commit",
            activity(&mission, &task, &uuid(0x100 + index)),
        ));
        assert!(duplicate);
    }
    assert_eq!(daemon.finish(), 0);
    let conn = inspect(&dir.store());
    let (task_state, mission_state): (String, String) = conn
        .query_row(
            "SELECT t.state, m.state FROM tasks t JOIN missions m USING (mission_id) WHERE t.task_id = ?1",
            [&task],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (task_state.as_str(), mission_state.as_str()),
        ("unknown", "recovering")
    );
    let leases: i64 = conn
        .query_row("SELECT count(*) FROM leases", [], |row| row.get(0))
        .unwrap();
    assert_eq!(leases, 0);
}

fn snapshot(daemon: &mut Daemon, mission: &str) -> extalia_core::mission::MissionSnapshot {
    match daemon.call("mission.snapshot", json!({ "missionId": mission })) {
        Ok(ResponseResult::MissionSnapshot(snapshot)) => snapshot,
        other => panic!("expected an authoritative snapshot, got {other:?}"),
    }
}

#[test]
fn snapshot_reads_live_recorded_leases_and_recovery_without_a_new_sequence() {
    let dir = TempDir::new();
    let (mut daemon, capabilities) = Daemon::ready(&dir, None);
    assert!(capabilities.contains(&Op::MissionSnapshot));
    let (mission, task) = (uuid(2), uuid(5));
    daemon
        .call("mission.create", create_params(&mission, &[&task]))
        .unwrap();
    let queued = snapshot(&mut daemon, &mission);
    assert_eq!((queued.version, queued.sequence), (1, 1));
    assert_eq!(queued.state.as_str(), "queued");
    daemon
        .call(
            "event.commit",
            event(
                &mission,
                None,
                &uuid(0x30),
                json!({ "type": "mission.state", "state": "running" }),
            ),
        )
        .unwrap();
    daemon
        .call(
            "task.transition",
            transition(&mission, &task, &uuid(0x31), "queued", "running"),
        )
        .unwrap();
    daemon
        .call("event.commit", activity(&mission, &task, &uuid(0x32)))
        .unwrap();
    let running = snapshot(&mut daemon, &mission);
    assert_eq!((running.version, running.sequence), (2, 4));
    assert_eq!(running.state.as_str(), "running");
    assert_eq!(running.tasks[0].attempt, 1);
    assert_eq!(running.leases[0].lease_id, uuid(0x31));
    assert_eq!(running.leases[0].holder_agent_id, WORKER);
    let conn = Connection::open_with_flags(dir.store(), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .unwrap();
    let times: (String, String) = conn
        .query_row("SELECT acquired_at, expires_at FROM leases", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();
    assert_eq!(
        (
            &running.leases[0].acquired_at,
            &running.leases[0].expires_at
        ),
        (&times.0, &times.1)
    );
    assert_eq!(
        snapshot(&mut daemon, &mission),
        running,
        "inspection neither renews nor writes"
    );
    drop(conn);
    assert_eq!(daemon.finish(), 0);
    let (mut daemon, _) = Daemon::ready(&dir, None);
    let recovered = snapshot(&mut daemon, &mission);
    assert_eq!(recovered.state.as_str(), "recovering");
    assert_eq!((recovered.version, recovered.sequence), (3, 4));
    assert_eq!(recovered.tasks[0].state.as_str(), "unknown");
    assert!(recovered.leases.is_empty());
    assert_eq!(snapshot(&mut daemon, &mission), recovered);
    assert_eq!(daemon.finish(), 0);
}

#[test]
fn snapshot_handshake_validation_profiles_and_unknown_ids_fail_closed() {
    let dir = TempDir::new();
    let (mission, task) = (uuid(2), uuid(5));
    let mut daemon = Daemon::spawn(&["--data-dir", &dir.arg(), "--profile", "work"]);
    assert_eq!(
        daemon.call("mission.snapshot", json!({ "missionId": mission })),
        Err(ErrorCode::HandshakeRequired)
    );
    daemon
        .call(
            "hello",
            json!({ "clientVersion": "test", "capabilities": ["hello", "mission.snapshot"] }),
        )
        .unwrap();
    assert_eq!(
        daemon.call(
            "mission.snapshot",
            json!({ "missionId": mission, "profileId": "default" })
        ),
        Err(ErrorCode::InvalidRequest)
    );
    assert_eq!(
        daemon.call("mission.snapshot", json!({ "missionId": "invalid" })),
        Err(ErrorCode::InvalidRequest)
    );
    assert_eq!(
        daemon.call("mission.snapshot", json!({ "missionId": mission })),
        Err(ErrorCode::NotFound)
    );
    daemon
        .call("mission.create", create_params(&mission, &[&task]))
        .unwrap();
    let own = snapshot(&mut daemon, &mission);
    assert_eq!(daemon.finish(), 0);
    let (mut other, _) = Daemon::ready(&dir, None);
    assert_eq!(
        other.call("mission.snapshot", json!({ "missionId": mission })),
        Err(ErrorCode::NotFound)
    );
    assert_eq!(other.finish(), 0);
    let (mut daemon, _) = Daemon::ready(&dir, Some("work"));
    assert_eq!(snapshot(&mut daemon, &mission), own);
    assert_eq!(daemon.finish(), 0);
}

#[test]
fn snapshot_denies_corrupt_payloads_without_exposing_storage_details() {
    let dir = TempDir::new();
    let (mut daemon, _) = Daemon::ready(&dir, None);
    let (mission, task) = (uuid(2), uuid(5));
    daemon
        .call("mission.create", create_params(&mission, &[&task]))
        .unwrap();
    assert_eq!(daemon.finish(), 0);
    let conn = inspect(&dir.store());
    conn.execute("UPDATE missions SET digest = printf('%064d', 0)", [])
        .unwrap();
    drop(conn);
    let (mut daemon, _) = Daemon::ready(&dir, None);
    assert_eq!(
        daemon.call("mission.snapshot", json!({ "missionId": mission })),
        Err(ErrorCode::StorageFailure)
    );
    assert_eq!(
        daemon.call("mission.snapshot", json!({ "missionId": mission })),
        Err(ErrorCode::StorageFailure)
    );
    assert_eq!(daemon.finish(), 0);
    let conn = inspect(&dir.store());
    let events: i64 = conn
        .query_row("SELECT count(*) FROM events", [], |row| row.get(0))
        .unwrap();
    assert_eq!(events, 1, "refusal did not append an event");
}

#[test]
fn snapshot_serves_a_complete_maximum_size_task_graph() {
    let dir = TempDir::new();
    let (mut daemon, _) = Daemon::ready(&dir, None);
    let mission = uuid(2);
    let tasks: Vec<_> = (0..64).map(|n| uuid(0x1000 + n)).collect();
    let ids: Vec<_> = tasks.iter().map(String::as_str).collect();
    daemon
        .call("mission.create", create_params(&mission, &ids))
        .unwrap();
    let result = snapshot(&mut daemon, &mission);
    assert_eq!(result.tasks.len(), 64);
    assert_eq!(
        result
            .tasks
            .iter()
            .map(|task| task.task_id.as_str())
            .collect::<Vec<_>>(),
        ids
    );
    assert!(result.leases.is_empty());
    assert_eq!(daemon.finish(), 0);
}
