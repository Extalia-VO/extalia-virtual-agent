//! Slice A store tests: transactions, idempotency, leases and recovery, profiles, caps.
//! Every test works in its own temporary directory only.

use rusqlite::params;
use serde_json::{Value, json};

use super::tests::TempDir;
use super::{CoreStore, StoreError};
use crate::mission::{
    AgentEvent, LEASE_TTL_MS, MAX_EVENT_BYTES, MAX_EVENTS_PER_MISSION, MissionCreate, MissionError,
    TaskState, TaskTransition, contract,
};
use crate::time::parse_utc;

const PROFILE: &str = "default";
const OTHER_PROFILE: &str = "work";
const WORKSPACE: &str = "00000000-0000-4000-8000-000000000001";
const MISSION: &str = "00000000-0000-4000-8000-000000000002";
const LEAD: &str = "00000000-0000-4000-8000-000000000003";
const WORKER: &str = "00000000-0000-4000-8000-000000000004";
const TASK: &str = "00000000-0000-4000-8000-000000000005";
const SECOND_TASK: &str = "00000000-0000-4000-8000-000000000020";
const SESSION: &str = "00000000-0000-4000-8000-000000000014";

fn now() -> i64 {
    parse_utc("2026-10-22T12:00:00.000Z").unwrap()
}

fn uuid(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}

fn task_json(id: &str, depends_on: &[&str]) -> Value {
    json!({ "schemaVersion": 1, "id": id, "missionId": MISSION, "dependsOn": depends_on,
        "assignedAgentId": WORKER, "state": "queued", "attempt": 0,
        "requirements": ["Build artifact"], "evidenceIds": [] })
}

fn create_json(state: &str) -> Value {
    json!({
        "mission": { "schemaVersion": 1, "id": MISSION, "workspaceId": WORKSPACE, "leadAgentId": LEAD,
            "budgetId": "00000000-0000-4000-8000-000000000006", "state": state,
            "createdAt": "2026-10-22T11:00:00.000Z", "updatedAt": "2026-10-22T11:00:00.000Z", "version": 1 },
        "graph": { "schemaVersion": 1, "missionId": MISSION,
            "tasks": [task_json(TASK, &[]), task_json(SECOND_TASK, &[TASK])] },
    })
}

fn create(value: &Value) -> MissionCreate {
    let mut errors = Vec::new();
    contract::mission_create(value, "params", &mut errors).unwrap_or_else(|| panic!("{errors:?}"))
}

fn transition(event: u32, task: &str, from: TaskState, to: TaskState) -> TaskTransition {
    TaskTransition {
        mission_id: MISSION.into(),
        task_id: task.into(),
        event_id: uuid(event),
        from,
        to,
    }
}

fn event_json(id: u32, body: Value) -> Value {
    let mut event = json!({ "schemaVersion": 1, "id": uuid(id), "workspaceId": WORKSPACE,
        "sessionId": SESSION, "missionId": MISSION, "taskId": TASK, "agentId": WORKER,
        "source": { "runtime": "extalia-native", "channel": "system" },
        "observedAt": "2026-10-22T12:00:00.000Z", "sequence": 99, "confidence": "reported", "body": body });
    if body_type(&event) == "mission.state" {
        event.as_object_mut().unwrap().remove("taskId");
        event["agentId"] = json!(LEAD);
    }
    event
}

fn body_type(event: &Value) -> &str {
    event["body"]["type"].as_str().unwrap()
}

fn event(value: &Value) -> AgentEvent {
    let mut errors = Vec::new();
    contract::agent_event(value, "event", &mut errors).unwrap_or_else(|| panic!("{errors:?}"))
}

fn activity(id: u32) -> AgentEvent {
    event(&event_json(
        id,
        json!({ "type": "agent.state", "state": "working", "activity": "read" }),
    ))
}

/// Every row of every table, for "nothing was written" comparisons.
fn dump(store: &CoreStore) -> Vec<String> {
    let mut rows = Vec::new();
    for table in [
        "missions",
        "mission_totals",
        "tasks",
        "events",
        "leases",
        "approvals",
    ] {
        let mut statement = store
            .conn
            .prepare(&format!("SELECT * FROM {table} ORDER BY 1"))
            .unwrap();
        let columns = statement.column_count();
        let mut query = statement.query([]).unwrap();
        while let Some(row) = query.next().unwrap() {
            let values: Vec<String> = (0..columns)
                .map(|index| format!("{:?}", row.get::<_, rusqlite::types::Value>(index).unwrap()))
                .collect();
            rows.push(format!("{table}: {}", values.join(" | ")));
        }
    }
    rows
}

fn task_state(store: &CoreStore, task: &str) -> (String, Value) {
    store
        .conn
        .query_row(
            "SELECT state, payload FROM tasks WHERE task_id = ?1",
            [task],
            |row| {
                let payload: String = row.get(1)?;
                Ok((row.get(0)?, serde_json::from_str(&payload).unwrap()))
            },
        )
        .unwrap()
}

fn sequences(store: &CoreStore, profile: &str) -> Vec<i64> {
    store
        .conn
        .prepare(
            "SELECT sequence FROM events WHERE profile_id = ?1 AND mission_id = ?2 ORDER BY rowid",
        )
        .unwrap()
        .query_map(params![profile, MISSION], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn lease_count(store: &CoreStore) -> i64 {
    store
        .conn
        .query_row("SELECT count(*) FROM leases", [], |row| row.get(0))
        .unwrap()
}

/// A store with the standard mission, its first task running under a lease.
fn running_store(dir: &TempDir) -> CoreStore {
    let mut store = CoreStore::open(&dir.store()).unwrap();
    store
        .create_mission(PROFILE, &create(&create_json("queued")), now())
        .unwrap();
    store
        .commit_event(
            PROFILE,
            &event(&event_json(
                50,
                json!({ "type": "mission.state", "state": "running" }),
            )),
            now(),
        )
        .unwrap();
    store
        .transition_task(
            PROFILE,
            &transition(51, TASK, TaskState::Queued, TaskState::Running),
            now(),
        )
        .unwrap();
    store
}

#[test]
fn creates_atomically_and_sequences_monotonically() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let ack = store
        .create_mission(PROFILE, &create(&create_json("draft")), now())
        .unwrap();
    assert_eq!((ack.mission_id.as_str(), ack.version), (MISSION, 1));
    assert_eq!(sequences(&store, PROFILE), [1], "creation record");
    let (state, task) = task_state(&store, TASK);
    assert_eq!(state, "queued");
    assert_eq!(task, task_json(TASK, &[]));

    let mut expected = vec![1];
    let running = store
        .commit_event(
            PROFILE,
            &event(&event_json(
                10,
                json!({ "type": "mission.state", "state": "running" }),
            )),
            now(),
        )
        .unwrap();
    expected.push(running.sequence as i64);
    let assigned = event(&event_json(
        11,
        json!({ "type": "task.assigned", "assigneeAgentId": WORKER }),
    ));
    expected.push(
        store
            .commit_event(PROFILE, &assigned, now())
            .unwrap()
            .sequence as i64,
    );
    let ack = store
        .transition_task(
            PROFILE,
            &transition(12, TASK, TaskState::Queued, TaskState::Running),
            now(),
        )
        .unwrap();
    assert_eq!(ack.state, TaskState::Running);
    expected.push(ack.sequence as i64);
    let (_, task) = task_state(&store, TASK);
    assert_eq!(task["attempt"], 1);
    assert_eq!(
        task["leaseId"],
        uuid(12),
        "the acquiring event names the lease"
    );
    assert_eq!(lease_count(&store), 1);
    for id in 13..20 {
        expected.push(
            store
                .commit_event(PROFILE, &activity(id), now())
                .unwrap()
                .sequence as i64,
        );
    }
    let done = store
        .transition_task(
            PROFILE,
            &transition(20, TASK, TaskState::Running, TaskState::Completed),
            now(),
        )
        .unwrap();
    expected.push(done.sequence as i64);
    let (state, task) = task_state(&store, TASK);
    assert_eq!(state, "completed");
    assert_eq!(task["verification"], "unverified");
    assert!(task.get("leaseId").is_none());
    assert_eq!(lease_count(&store), 0, "finishing releases the lease");
    // Stored sequences are contiguous from 1, equal to the acknowledgements.
    assert_eq!(
        sequences(&store, PROFILE),
        (1..=expected.len() as i64).collect::<Vec<_>>()
    );
    assert_eq!(sequences(&store, PROFILE), expected);
    // The caller's run-local sequence (99) is replaced by the assigned one.
    let payload: String = store
        .conn
        .query_row(
            "SELECT payload FROM events WHERE event_id = ?1",
            [uuid(13)],
            |row| row.get(0),
        )
        .unwrap();
    let stored: Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(stored["sequence"], 5);
    // The mission state event applied the state and bumped the version.
    let (mission_state, version): (String, i64) = store
        .conn
        .query_row("SELECT state, version FROM missions", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();
    assert_eq!((mission_state.as_str(), version), ("running", 2));
}

#[test]
fn duplicate_event_ids_identical_or_conflicting() {
    let dir = TempDir::new();
    let mut store = running_store(&dir);
    let first = store.commit_event(PROFILE, &activity(60), now()).unwrap();
    assert!(!first.duplicate);
    let before = dump(&store);
    // An identical retry, even with another caller sequence, returns the original ack.
    let mut retry = event_json(
        60,
        json!({ "type": "agent.state", "state": "working", "activity": "read" }),
    );
    retry["sequence"] = json!(7);
    let again = store
        .commit_event(PROFILE, &event(&retry), now() + 5)
        .unwrap();
    assert_eq!((again.sequence, again.duplicate), (first.sequence, true));
    assert_eq!(dump(&store), before, "a duplicate writes nothing");
    // Conflicting reuse fails atomically.
    let conflicting = event(&event_json(
        60,
        json!({ "type": "agent.state", "state": "working", "activity": "search" }),
    ));
    assert!(matches!(
        store.commit_event(PROFILE, &conflicting, now()),
        Err(MissionError::Conflict(_))
    ));
    let transition_reuse = transition(60, SECOND_TASK, TaskState::Queued, TaskState::Blocked);
    assert!(matches!(
        store.transition_task(PROFILE, &transition_reuse, now()),
        Err(MissionError::Conflict(_))
    ));
    assert_eq!(dump(&store), before, "a conflict writes nothing");

    // Transitions are idempotent by event ID as well.
    let blocked = transition(61, SECOND_TASK, TaskState::Queued, TaskState::Blocked);
    let ack = store.transition_task(PROFILE, &blocked, now()).unwrap();
    let before = dump(&store);
    assert_eq!(
        store.transition_task(PROFILE, &blocked, now()).unwrap(),
        ack
    );
    assert_eq!(dump(&store), before);
    let mut other = blocked.clone();
    other.to = TaskState::Cancelled;
    assert!(matches!(
        store.transition_task(PROFILE, &other, now()),
        Err(MissionError::Conflict(_))
    ));
    // A stale `from` is a conflict, an impossible transition is invalid.
    let stale = transition(62, SECOND_TASK, TaskState::Queued, TaskState::Cancelled);
    assert!(matches!(
        store.transition_task(PROFILE, &stale, now()),
        Err(MissionError::Conflict(_))
    ));
    let impossible = transition(63, SECOND_TASK, TaskState::Blocked, TaskState::Completed);
    assert!(matches!(
        store.transition_task(PROFILE, &impossible, now()),
        Err(MissionError::Invalid(_))
    ));
    assert_eq!(dump(&store), before);

    // mission.create: identical retry returns the original ack, any difference conflicts.
    let mut fresh = CoreStore::open(&TempDir::new().store()).unwrap();
    let params = create(&create_json("queued"));
    let ack = fresh.create_mission(PROFILE, &params, now()).unwrap();
    let before = dump(&fresh);
    assert_eq!(
        fresh.create_mission(PROFILE, &params, now() + 1).unwrap(),
        ack
    );
    let mut changed = create_json("queued");
    changed["graph"]["tasks"][1]["requirements"] = json!(["Other"]);
    assert!(matches!(
        fresh.create_mission(PROFILE, &create(&changed), now()),
        Err(MissionError::Conflict(_))
    ));
    assert_eq!(dump(&fresh), before);
}

/// One store operation returning its acknowledged sequence.
type Op<'a> = dyn Fn(&mut CoreStore) -> Result<u64, MissionError> + 'a;

#[test]
fn injected_failure_before_commit_writes_nothing() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let params = create(&create_json("queued"));
    store.fail_before_commit.set(true);
    assert!(matches!(
        store.create_mission(PROFILE, &params, now()),
        Err(MissionError::Storage(_))
    ));
    assert!(dump(&store).is_empty(), "no mission, task or event row");
    store.fail_before_commit.set(false);
    store.create_mission(PROFILE, &params, now()).unwrap();

    let start = transition(70, TASK, TaskState::Queued, TaskState::Running);
    let ops: [&Op<'_>; 3] = [
        &|store| {
            store
                .commit_event(
                    PROFILE,
                    &event(&event_json(
                        71,
                        json!({ "type": "mission.state", "state": "running" }),
                    )),
                    now(),
                )
                .map(|ack| ack.sequence)
        },
        &|store| {
            store
                .transition_task(PROFILE, &start, now())
                .map(|ack| ack.sequence)
        },
        &|store| {
            store
                .commit_event(PROFILE, &activity(72), now())
                .map(|ack| ack.sequence)
        },
    ];
    for (index, op) in ops.iter().enumerate() {
        let before = dump(&store);
        store.fail_before_commit.set(true);
        assert!(
            matches!(op(&mut store), Err(MissionError::Storage(_))),
            "op {index}"
        );
        store.fail_before_commit.set(false);
        assert_eq!(dump(&store), before, "op {index} left nothing partial");
        // The same request then succeeds with the next sequence: no gap, no duplicate.
        assert_eq!(op(&mut store).unwrap(), index as u64 + 2);
    }
    store.fail_before_commit.set(true);
    let before = dump(&store);
    assert!(matches!(
        store.recover(PROFILE, now()),
        Err(MissionError::Storage(_))
    ));
    assert_eq!(
        dump(&store),
        before,
        "a failed recovery leaves the running task"
    );
    store.fail_before_commit.set(false);

    // Reopening sees only committed state.
    store.close().unwrap();
    let store = CoreStore::open(&dir.store()).unwrap();
    assert_eq!(sequences(&store, PROFILE), [1, 2, 3, 4]);
    assert_eq!(task_state(&store, TASK).0, "running");
}

#[test]
fn stale_lease_is_recovered_as_unknown_and_never_replayed() {
    let dir = TempDir::new();
    let store = running_store(&dir);
    let events_before = sequences(&store, PROFILE);
    drop(store); // The holder process is gone without finishing its work.

    let mut store = CoreStore::open(&dir.store()).unwrap();
    let report = store.recover(PROFILE, now() + LEASE_TTL_MS + 1).unwrap();
    assert_eq!(
        (
            report.missions,
            report.tasks,
            report.expired_leases,
            report.orphaned_leases
        ),
        (1, 1, 1, 0)
    );
    let (state, task) = task_state(&store, TASK);
    assert_eq!(state, "unknown");
    assert!(task.get("leaseId").is_none());
    assert_eq!(task["attempt"], 1, "the attempt is not repeated");
    assert_eq!(lease_count(&store), 0);
    assert_eq!(
        task_state(&store, SECOND_TASK).0,
        "queued",
        "work that never started stays"
    );
    let (mission_state, version): (String, i64) = store
        .conn
        .query_row("SELECT state, version FROM missions", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();
    assert_eq!((mission_state.as_str(), version), ("recovering", 3));
    assert_eq!(
        sequences(&store, PROFILE),
        events_before,
        "no synthesized event"
    );

    // Nothing resumes the stale work: the old holder's completion, a restart of the task,
    // late activity and new starts are all refused.
    let before = dump(&store);
    let late = transition(80, TASK, TaskState::Running, TaskState::Completed);
    assert!(matches!(
        store.transition_task(PROFILE, &late, now()),
        Err(MissionError::Conflict(_))
    ));
    let replay = transition(81, TASK, TaskState::Unknown, TaskState::Running);
    assert!(matches!(
        store.transition_task(PROFILE, &replay, now()),
        Err(MissionError::Invalid(_))
    ));
    let start = transition(82, SECOND_TASK, TaskState::Queued, TaskState::Running);
    assert!(matches!(
        store.transition_task(PROFILE, &start, now()),
        Err(MissionError::Conflict(_))
    ));
    assert!(matches!(
        store.commit_event(PROFILE, &activity(83), now()),
        Err(MissionError::Conflict(_))
    ));
    assert_eq!(dump(&store), before);
    // A second recovery changes nothing.
    assert_eq!(store.recover(PROFILE, now()).unwrap(), Default::default());
    // Resolution without replay is allowed.
    let resolve = transition(84, TASK, TaskState::Unknown, TaskState::Failed);
    store.transition_task(PROFILE, &resolve, now()).unwrap();

    // An unexpired lease is orphaned at open: the store lock proves its holder is gone.
    let dir = TempDir::new();
    drop(running_store(&dir));
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let report = store.recover(PROFILE, now() + 1).unwrap();
    assert_eq!(
        (report.tasks, report.expired_leases, report.orphaned_leases),
        (1, 0, 1)
    );
    assert_eq!(task_state(&store, TASK).0, "unknown");
}

#[test]
fn activity_renews_the_lease() {
    let dir = TempDir::new();
    let mut store = running_store(&dir);
    let expiry = |store: &CoreStore| -> i64 {
        let text: String = store
            .conn
            .query_row("SELECT expires_at FROM leases", [], |row| row.get(0))
            .unwrap();
        parse_utc(&text).unwrap()
    };
    assert_eq!(expiry(&store), now() + LEASE_TTL_MS);
    store
        .commit_event(PROFILE, &activity(90), now() + 1_000)
        .unwrap();
    assert_eq!(expiry(&store), now() + 1_000 + LEASE_TTL_MS);
}

#[test]
fn other_profiles_are_neither_read_nor_written() {
    let dir = TempDir::new();
    let store = running_store(&dir);
    let before = dump(&store);
    drop(store);
    let mut store = CoreStore::open(&dir.store()).unwrap();
    // Recovery of another profile leaves this profile's running work alone.
    assert_eq!(
        store.recover(OTHER_PROFILE, now()).unwrap(),
        Default::default()
    );
    let next = transition(100, SECOND_TASK, TaskState::Queued, TaskState::Blocked);
    assert!(matches!(
        store.transition_task(OTHER_PROFILE, &next, now()),
        Err(MissionError::NotFound)
    ));
    assert!(matches!(
        store.commit_event(OTHER_PROFILE, &activity(101), now()),
        Err(MissionError::NotFound)
    ));
    // Reused IDs of another profile conflict without revealing that profile's data.
    assert!(matches!(
        store.create_mission(OTHER_PROFILE, &create(&create_json("queued")), now()),
        Err(MissionError::Conflict(_))
    ));
    assert!(matches!(
        store.transition_task(
            OTHER_PROFILE,
            &transition(51, TASK, TaskState::Queued, TaskState::Running),
            now()
        ),
        Err(MissionError::Conflict(_))
    ));
    assert_eq!(dump(&store), before);
}

#[test]
fn admission_policy_and_ownership() {
    let dir = TempDir::new();
    let mut store = running_store(&dir);
    let before = dump(&store);
    let invalid =
        |store: &mut CoreStore, value: Value| store.commit_event(PROFILE, &event(&value), now());
    // Not native control metadata (ADR 0014).
    for body in [
        json!({ "type": "model.delta", "text": "prose" }),
        json!({ "type": "tool.started", "tool": "shell", "kind": "command", "label": "shell" }),
        json!({ "type": "turn.failed", "error": "raw provider error text" }),
        json!({ "type": "agent.state", "state": "working", "summary": "free text" }),
        // Edit activity of a read-only task (ADR 0028): refused as before.
        json!({ "type": "agent.state", "state": "working", "activity": "edit" }),
        json!({ "type": "tool.started", "tool": "write_file", "kind": "edit", "label": "write_file" }),
        json!({ "type": "tool.completed", "tool": "edit_file", "kind": "edit", "label": "edit_file",
            "ok": true, "target": "src/app.ts" }),
    ] {
        assert!(
            matches!(
                invalid(&mut store, event_json(110, body.clone())),
                Err(MissionError::Invalid(_))
            ),
            "{body}"
        );
    }
    let mut observed = event_json(111, json!({ "type": "agent.state", "state": "working" }));
    observed["confidence"] = json!("observed");
    assert!(matches!(
        invalid(&mut store, observed),
        Err(MissionError::Invalid(_))
    ));
    // Ownership against stored state.
    let mut stranger = event_json(112, json!({ "type": "agent.state", "state": "working" }));
    stranger["agentId"] = json!(uuid(999));
    assert!(matches!(
        invalid(&mut store, stranger),
        Err(MissionError::Conflict(_))
    ));
    let mut workspace = event_json(113, json!({ "type": "agent.state", "state": "working" }));
    workspace["workspaceId"] = json!(uuid(998));
    assert!(matches!(
        invalid(&mut store, workspace),
        Err(MissionError::Conflict(_))
    ));
    let mut session = event_json(114, json!({ "type": "agent.state", "state": "working" }));
    session["sessionId"] = json!(uuid(997));
    assert!(matches!(
        invalid(&mut store, session),
        Err(MissionError::Conflict(_))
    ));
    let mut unknown_task = event_json(115, json!({ "type": "agent.state", "state": "working" }));
    unknown_task["taskId"] = json!(uuid(996));
    assert!(matches!(
        invalid(&mut store, unknown_task),
        Err(MissionError::NotFound)
    ));
    let stale_state = event_json(116, json!({ "type": "task.state", "state": "queued" }));
    assert!(matches!(
        invalid(&mut store, stale_state),
        Err(MissionError::Conflict(_))
    ));
    let mut not_lead = event_json(
        117,
        json!({ "type": "mission.state", "state": "completed" }),
    );
    not_lead["agentId"] = json!(WORKER);
    assert!(matches!(
        invalid(&mut store, not_lead),
        Err(MissionError::Conflict(_))
    ));
    let backwards = event_json(118, json!({ "type": "mission.state", "state": "draft" }));
    assert!(matches!(
        invalid(&mut store, backwards),
        Err(MissionError::Conflict(_))
    ));
    let idle_task = {
        let mut value = event_json(119, json!({ "type": "agent.state", "state": "working" }));
        value["taskId"] = json!(SECOND_TASK);
        value
    };
    assert!(matches!(
        invalid(&mut store, idle_task),
        Err(MissionError::Conflict(_))
    ));
    assert_eq!(dump(&store), before, "every refusal wrote nothing");

    // A matching task.state restates the stored state; the lead finishes the mission,
    // after which late events are refused.
    invalid(
        &mut store,
        event_json(120, json!({ "type": "task.state", "state": "running" })),
    )
    .unwrap();
    invalid(
        &mut store,
        event_json(121, json!({ "type": "mission.state", "state": "failed" })),
    )
    .unwrap();
    assert!(matches!(
        invalid(
            &mut store,
            event_json(122, json!({ "type": "agent.state", "state": "idle" }))
        ),
        Err(MissionError::Conflict(_))
    ));
    let late = transition(123, TASK, TaskState::Running, TaskState::Completed);
    assert!(matches!(
        store.transition_task(PROFILE, &late, now()),
        Err(MissionError::Conflict(_))
    ));

    // Creation accepts fresh plans only.
    let mut fresh = CoreStore::open(&TempDir::new().store()).unwrap();
    let mut running = create_json("running");
    assert!(matches!(
        fresh.create_mission(PROFILE, &create(&running), now()),
        Err(MissionError::Invalid(_))
    ));
    running = create_json("queued");
    running["graph"]["tasks"][0]["state"] = json!("blocked");
    assert!(matches!(
        fresh.create_mission(PROFILE, &create(&running), now()),
        Err(MissionError::Invalid(_))
    ));
    // Dependencies gate the start of work.
    fresh
        .create_mission(PROFILE, &create(&create_json("queued")), now())
        .unwrap();
    let early = transition(130, SECOND_TASK, TaskState::Queued, TaskState::Running);
    assert!(matches!(
        fresh.transition_task(PROFILE, &early, now()),
        Err(MissionError::Conflict(_))
    ));
}

#[test]
fn caps_mirror_adr_0014() {
    let dir = TempDir::new();
    let mut store = running_store(&dir);
    let filler = |store: &mut CoreStore, count: u64, bytes: usize| {
        let tx = store.conn.transaction().unwrap();
        let next: i64 = tx
            .query_row(
                "SELECT max(sequence) FROM events WHERE mission_id = ?1",
                [MISSION],
                |row| row.get(0),
            )
            .unwrap();
        for offset in 0..count as i64 {
            tx.execute(
                "INSERT INTO events (event_id, profile_id, mission_id, sequence, event_type, committed_at, digest, payload)
                 VALUES (?1, ?2, ?3, ?4, 'agent.state', 't', ?5, ?6)",
                params![uuid(0x10_0000 + (next + offset) as u32), PROFILE, MISSION, next + offset + 1, "0".repeat(64), "x".repeat(bytes)],
            )
            .unwrap();
        }
        tx.commit().unwrap();
    };
    // Count: 8,192 events per mission, the creation record included.
    let used = sequences(&store, PROFILE).len() as u64;
    filler(&mut store, MAX_EVENTS_PER_MISSION - used - 1, 1);
    store.commit_event(PROFILE, &activity(140), now()).unwrap();
    let before = dump(&store);
    assert!(matches!(
        store.commit_event(PROFILE, &activity(141), now()),
        Err(MissionError::Capacity(_))
    ));
    let next = transition(142, TASK, TaskState::Running, TaskState::Completed);
    assert!(matches!(
        store.transition_task(PROFILE, &next, now()),
        Err(MissionError::Capacity(_))
    ));
    assert_eq!(dump(&store), before);

    // Bytes: 8 MiB of encoded events per mission.
    let dir = TempDir::new();
    let mut store = running_store(&dir);
    filler(&mut store, 2_048, MAX_EVENT_BYTES);
    assert!(matches!(
        store.commit_event(PROFILE, &activity(143), now()),
        Err(MissionError::Capacity(_))
    ));

    // Size: 4 KiB per stored record, checked on the canonical payload with its sequence.
    let dir = TempDir::new();
    let mut store = running_store(&dir);
    let tx = store.conn.transaction().unwrap();
    let mut record = serde_json::Map::new();
    record.insert("pad".into(), "y".repeat(MAX_EVENT_BYTES).into());
    let id = uuid(144);
    let entry = super::missions::tests_support::entry(PROFILE, MISSION, &id, record);
    assert!(matches!(
        super::missions::tests_support::append(&tx, entry),
        Err(MissionError::Capacity(_))
    ));
}

#[test]
fn a_second_opener_is_locked_out() {
    let dir = TempDir::new();
    let store = CoreStore::open(&dir.store()).unwrap();
    assert!(matches!(
        CoreStore::open(&dir.store()),
        Err(StoreError::Locked)
    ));
    store.close().unwrap();
    CoreStore::open(&dir.store()).unwrap().close().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let lock = super::sibling(&dir.store(), super::LOCK_SUFFIX);
        assert_eq!(
            std::fs::metadata(lock).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

/// Every mission's running totals next to the aggregates recomputed from its journal.
fn totals_and_aggregates(store: &CoreStore) -> (Vec<[i64; 3]>, Vec<[i64; 3]>) {
    let rows = |sql: &str| -> Vec<[i64; 3]> {
        store
            .conn
            .prepare(sql)
            .unwrap()
            .query_map([], |row| Ok([row.get(0)?, row.get(1)?, row.get(2)?]))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    let totals = rows(
        "SELECT t.event_count, t.last_sequence, t.payload_bytes
         FROM missions AS m LEFT JOIN mission_totals AS t
           ON t.profile_id = m.profile_id AND t.mission_id = m.mission_id
         ORDER BY m.profile_id, m.mission_id",
    );
    let aggregates = rows(
        "SELECT count(e.event_id), coalesce(max(e.sequence), 0),
                coalesce(sum(length(CAST(e.payload AS BLOB))), 0)
         FROM missions AS m LEFT JOIN events AS e
           ON e.profile_id = m.profile_id AND e.mission_id = m.mission_id
         GROUP BY m.profile_id, m.mission_id ORDER BY m.profile_id, m.mission_id",
    );
    (totals, aggregates)
}

fn assert_totals_exact(store: &CoreStore, step: &str) {
    let (totals, aggregates) = totals_and_aggregates(store);
    assert_eq!(
        totals, aggregates,
        "totals differ from the journal after {step}"
    );
    let rows: i64 = store
        .conn
        .query_row("SELECT count(*) FROM mission_totals", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        rows as usize,
        totals.len(),
        "one totals row per mission after {step}"
    );
}

/// A mission of `profile` with two tasks, its first task running under a lease.
struct Fixture {
    profile: &'static str,
    mission: String,
    task: String,
}

fn fixture_create(mission: &str, first: &str, second: &str) -> MissionCreate {
    let mut value = create_json("queued");
    value["mission"]["id"] = json!(mission);
    value["graph"]["missionId"] = json!(mission);
    let mut tasks = [task_json(first, &[]), task_json(second, &[first])];
    for task in &mut tasks {
        task["missionId"] = json!(mission);
    }
    value["graph"]["tasks"] = json!(tasks);
    create(&value)
}

fn fixture_json(id: u32, fixture: &Fixture, body: Value) -> Value {
    let mut value = event_json(id, body);
    value["missionId"] = json!(fixture.mission);
    if value.get("taskId").is_some() {
        value["taskId"] = json!(fixture.task);
    }
    value
}

fn fixture_event(id: u32, fixture: &Fixture, body: Value) -> AgentEvent {
    event(&fixture_json(id, fixture, body))
}

/// Deterministic xorshift64*, so a failing seed reproduces.
struct Rng(u64);

impl Rng {
    fn below(&mut self, bound: u64) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d) % bound
    }
}

#[test]
fn running_totals_equal_the_journal_after_random_workloads() {
    for seed in [1_u64, 7, 42, 0x5eed] {
        let dir = TempDir::new();
        let mut store = CoreStore::open(&dir.store()).unwrap();
        let mut rng = Rng(seed);
        let mut next_id = 0x2_0000_u32;
        let mut id = || {
            next_id += 1;
            next_id
        };
        let mut fixtures = Vec::new();
        for (index, profile) in [PROFILE, PROFILE, OTHER_PROFILE].into_iter().enumerate() {
            let base = 0x3_0000 + 16 * index as u32;
            let fixture = Fixture {
                profile,
                mission: uuid(base),
                task: uuid(base + 1),
            };
            let create = fixture_create(&fixture.mission, &fixture.task, &uuid(base + 2));
            store.create_mission(profile, &create, now()).unwrap();
            let running = fixture_event(
                id(),
                &fixture,
                json!({ "type": "mission.state", "state": "running" }),
            );
            store.commit_event(profile, &running, now()).unwrap();
            let start = TaskTransition {
                mission_id: fixture.mission.clone(),
                task_id: fixture.task.clone(),
                event_id: uuid(id()),
                from: TaskState::Queued,
                to: TaskState::Running,
            };
            store.transition_task(profile, &start, now()).unwrap();
            fixtures.push(fixture);
        }
        assert_totals_exact(&store, "setup");
        let activities = [
            json!({ "type": "agent.state", "state": "working", "activity": "read" }),
            json!({ "type": "tool.started", "tool": "read_file", "kind": "read", "label": "read_file" }),
            json!({ "type": "agent.state", "state": "working", "activity": "search" }),
        ];
        let mut committed: Vec<(usize, Value)> = Vec::new();
        let mut waiting = vec![false; fixtures.len()];
        for step in 0..300 {
            let which = rng.below(fixtures.len() as u64) as usize;
            let fixture = &fixtures[which];
            let body = activities[rng.below(activities.len() as u64) as usize].clone();
            let before = dump(&store);
            let (count_before, _) = totals_and_aggregates(&store);
            let label = match rng.below(10) {
                // New activity: the acknowledged sequence is the new event count.
                0..=3 => {
                    let value = fixture_json(id(), fixture, body);
                    let ack = store
                        .commit_event(fixture.profile, &event(&value), now())
                        .unwrap_or_else(|error| panic!("seed {seed} step {step}: {error:?}"));
                    assert!(!ack.duplicate);
                    let count: i64 = store
                        .conn
                        .query_row(
                            "SELECT event_count FROM mission_totals WHERE mission_id = ?1",
                            [&fixture.mission],
                            |row| row.get(0),
                        )
                        .unwrap();
                    assert_eq!(ack.sequence as i64, count, "seed {seed} step {step}");
                    committed.push((which, value));
                    "commit"
                }
                // Identical retry: the original acknowledgement, nothing written.
                4 if !committed.is_empty() => {
                    let (owner, value) = &committed[rng.below(committed.len() as u64) as usize];
                    let ack = store
                        .commit_event(fixtures[*owner].profile, &event(value), now())
                        .unwrap();
                    assert!(ack.duplicate);
                    assert_eq!(dump(&store), before, "seed {seed} step {step}");
                    "duplicate"
                }
                // Reused ID with another body, or another profile: refused, nothing written.
                5 if !committed.is_empty() => {
                    let (owner, original) = &committed[rng.below(committed.len() as u64) as usize];
                    let mut value = original.clone();
                    value["body"] = if value["body"] == activities[0] {
                        activities[2].clone()
                    } else {
                        activities[0].clone()
                    };
                    let conflicting = event(&value);
                    let original = event(original);
                    assert!(
                        store
                            .commit_event(fixtures[*owner].profile, &conflicting, now())
                            .is_err()
                    );
                    let other = if fixtures[*owner].profile == PROFILE {
                        OTHER_PROFILE
                    } else {
                        PROFILE
                    };
                    assert!(store.commit_event(other, &original, now()).is_err());
                    assert_eq!(dump(&store), before, "seed {seed} step {step}");
                    "conflict"
                }
                // Injected failure before commit: everything, totals included, rolls back.
                6 | 7 => {
                    store.fail_before_commit.set(true);
                    let result = if rng.below(2) == 0 {
                        store
                            .commit_event(
                                fixture.profile,
                                &fixture_event(id(), fixture, body),
                                now(),
                            )
                            .map(|_| ())
                    } else {
                        store.recover(fixture.profile, now()).map(|_| ())
                    };
                    store.fail_before_commit.set(false);
                    assert!(matches!(result, Err(MissionError::Storage(_))));
                    assert_eq!(dump(&store), before, "seed {seed} step {step}");
                    "rollback"
                }
                // Task transitions append through the same totals.
                _ => {
                    let (from, to) = if waiting[which] {
                        (TaskState::Waiting, TaskState::Running)
                    } else {
                        (TaskState::Running, TaskState::Waiting)
                    };
                    let transition = TaskTransition {
                        mission_id: fixture.mission.clone(),
                        task_id: fixture.task.clone(),
                        event_id: uuid(id()),
                        from,
                        to,
                    };
                    store
                        .transition_task(fixture.profile, &transition, now())
                        .unwrap();
                    waiting[which] = !waiting[which];
                    "transition"
                }
            };
            assert_totals_exact(&store, &format!("seed {seed} step {step} ({label})"));
            let (count_after, _) = totals_and_aggregates(&store);
            assert!(
                count_after
                    .iter()
                    .zip(&count_before)
                    .all(|(after, before)| after[0] >= before[0]),
                "totals never move backwards"
            );
        }

        // Recovery writes no event and leaves the totals exact; so does a reopen.
        let before = totals_and_aggregates(&store).0;
        store.recover(PROFILE, now()).unwrap();
        store.recover(OTHER_PROFILE, now()).unwrap();
        assert_totals_exact(&store, "recovery");
        assert_eq!(totals_and_aggregates(&store).0, before);
        store.close().unwrap();
        let mut store = CoreStore::open(&dir.store()).unwrap();
        assert_totals_exact(&store, "reopen");
        assert_eq!(totals_and_aggregates(&store).0, before);
        // A recovering mission still records its lead's state through the totals.
        let fixture = &fixtures[0];
        let failed = fixture_event(
            id(),
            fixture,
            json!({ "type": "mission.state", "state": "failed" }),
        );
        let ack = store.commit_event(fixture.profile, &failed, now()).unwrap();
        assert_eq!(ack.sequence as i64, before[0][0] + 1);
        assert_totals_exact(&store, "after recovery");

        // Writers outside the store code keep them exact too: edit, delete, cascade.
        store
            .conn
            .execute(
                "UPDATE events SET payload = '{\"edited\":true}' WHERE mission_id = ?1 AND sequence = 2",
                [&fixtures[1].mission],
            )
            .unwrap();
        assert_totals_exact(&store, "raw update");
        store
            .conn
            .execute(
                "DELETE FROM events WHERE mission_id = ?1 AND sequence = 3",
                [&fixtures[1].mission],
            )
            .unwrap();
        assert_totals_exact(&store, "raw delete");
        // The hole is detected as before: the next append is refused as corrupt.
        let fixture = &fixtures[1];
        let late = fixture_event(
            id(),
            fixture,
            json!({ "type": "mission.state", "state": "failed" }),
        );
        assert!(matches!(
            store.commit_event(fixture.profile, &late, now()),
            Err(MissionError::Corrupt(_))
        ));
        store
            .conn
            .execute(
                "DELETE FROM missions WHERE mission_id = ?1",
                [&fixtures[2].mission],
            )
            .unwrap();
        assert_totals_exact(&store, "mission cascade");
    }
}

#[test]
fn a_missing_totals_row_fails_closed() {
    let dir = TempDir::new();
    let mut store = running_store(&dir);
    store
        .conn
        .execute("DELETE FROM mission_totals", [])
        .unwrap();
    let before = dump(&store);
    assert!(matches!(
        store.commit_event(PROFILE, &activity(150), now()),
        Err(MissionError::Corrupt("mission totals"))
    ));
    assert_eq!(dump(&store), before);
}

/// ADR 0028: a task created with `access: "write"` journals bounded edit activity; the
/// access survives in the stored task, and contents or unbounded paths stay refused.
#[test]
fn write_capable_tasks_journal_bounded_edits() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let mut value = create_json("queued");
    value["graph"]["tasks"][0]["access"] = json!("write");
    store
        .create_mission(PROFILE, &create(&value), now())
        .unwrap();
    store
        .commit_event(
            PROFILE,
            &event(&event_json(
                200,
                json!({ "type": "mission.state", "state": "running" }),
            )),
            now(),
        )
        .unwrap();
    store
        .transition_task(
            PROFILE,
            &transition(201, TASK, TaskState::Queued, TaskState::Running),
            now(),
        )
        .unwrap();
    assert_eq!(task_state(&store, TASK).1["access"], "write");
    assert!(task_state(&store, SECOND_TASK).1.get("access").is_none());
    for (id, body) in [
        (
            202,
            json!({ "type": "agent.state", "state": "working", "activity": "edit" }),
        ),
        (
            203,
            json!({ "type": "tool.started", "tool": "write_file", "kind": "edit",
            "label": "write_file", "target": "src/app.ts" }),
        ),
        (
            204,
            json!({ "type": "tool.completed", "tool": "write_file", "kind": "edit",
            "label": "write_file", "ok": true, "target": "src/app.ts" }),
        ),
        (
            205,
            json!({ "type": "tool.started", "tool": "read_file", "kind": "read", "label": "read_file" }),
        ),
    ] {
        store
            .commit_event(PROFILE, &event(&event_json(id, body.clone())), now())
            .unwrap_or_else(|error| panic!("{body}: {error:?}"));
    }
    let before = dump(&store);
    for (id, body) in [
        (
            210,
            json!({ "type": "tool.completed", "tool": "write_file", "kind": "edit",
            "label": "write_file", "ok": true, "output": "file contents" }),
        ),
        (
            211,
            json!({ "type": "tool.started", "tool": "write_file", "kind": "edit",
            "label": "write_file", "target": "../outside.txt" }),
        ),
        (
            212,
            json!({ "type": "tool.started", "tool": "apply_patch", "kind": "edit", "label": "apply_patch" }),
        ),
        (
            213,
            json!({ "type": "tool.started", "tool": "shell", "kind": "command", "label": "shell" }),
        ),
        (
            214,
            json!({ "type": "agent.state", "state": "working", "activity": "edit",
            "target": "src/app.ts" }),
        ),
    ] {
        assert!(
            matches!(
                store.commit_event(PROFILE, &event(&event_json(id, body.clone())), now()),
                Err(MissionError::Invalid(_))
            ),
            "{body}"
        );
    }
    assert_eq!(dump(&store), before, "every refusal wrote nothing");
}

#[test]
fn snapshot_is_profile_scoped_atomic_read_with_recorded_leases_and_journal_sequence() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    store
        .create_mission(PROFILE, &create(&create_json("queued")), now())
        .unwrap();
    let before = dump(&store);
    assert!(matches!(
        store.mission_snapshot(OTHER_PROFILE, MISSION),
        Err(MissionError::NotFound)
    ));
    assert!(matches!(
        store.mission_snapshot(PROFILE, &uuid(0xffff)),
        Err(MissionError::NotFound)
    ));
    assert_eq!(dump(&store), before);
    let queued = store.mission_snapshot(PROFILE, MISSION).unwrap();
    assert_eq!(queued.version, 1);
    assert_eq!(queued.sequence, 1);
    assert_eq!(queued.tasks.len(), 2);
    assert!(queued.leases.is_empty());
    store
        .commit_event(
            PROFILE,
            &event(&event_json(
                0x90,
                json!({"type": "mission.state", "state": "running"}),
            )),
            now(),
        )
        .unwrap();
    store
        .transition_task(
            PROFILE,
            &transition(0x91, TASK, TaskState::Queued, TaskState::Running),
            now(),
        )
        .unwrap();
    store
        .commit_event(PROFILE, &activity(0x92), now() + 1234)
        .unwrap();
    let before = dump(&store);
    let snapshot = store.mission_snapshot(PROFILE, MISSION).unwrap();
    assert_eq!(snapshot.mission_id, MISSION);
    assert_eq!(snapshot.workspace_id, WORKSPACE);
    assert_eq!(snapshot.state, crate::mission::MissionState::Running);
    assert_eq!(snapshot.version, 2);
    assert_eq!(snapshot.sequence, 4);
    let task = snapshot
        .tasks
        .iter()
        .find(|task| task.task_id == TASK)
        .unwrap();
    assert_eq!(task.state, TaskState::Running);
    assert_eq!(task.attempt, 1);
    assert_eq!(task.assigned_agent_id.as_deref(), Some(WORKER));
    assert_eq!(snapshot.leases.len(), 1);
    let lease = &snapshot.leases[0];
    assert_eq!(lease.lease_id, uuid(0x91));
    assert_eq!(lease.holder_agent_id, WORKER);
    assert_eq!(lease.task_id, TASK);
    assert_eq!(parse_utc(&lease.acquired_at), Some(now()));
    assert_eq!(
        parse_utc(&lease.expires_at),
        Some(now() + 1234 + LEASE_TTL_MS)
    );
    assert_eq!(dump(&store), before);
    // Inspection of an expired lease still changes nothing: no live reaping or renewal.
    store
        .conn
        .execute("UPDATE leases SET expires_at = acquired_at", [])
        .unwrap();
    let before = dump(&store);
    assert_eq!(
        store.mission_snapshot(PROFILE, MISSION).unwrap().leases[0].expires_at,
        lease.acquired_at
    );
    assert_eq!(dump(&store), before);
    store.recover(PROFILE, now() + LEASE_TTL_MS + 1).unwrap();
    let before = dump(&store);
    let recovered = store.mission_snapshot(PROFILE, MISSION).unwrap();
    assert_eq!(recovered.state, crate::mission::MissionState::Recovering);
    assert_eq!(recovered.version, 3);
    assert_eq!(recovered.sequence, 4); // Recovery is not a journal event.
    assert!(recovered.leases.is_empty());
    assert_eq!(
        recovered
            .tasks
            .iter()
            .find(|task| task.task_id == TASK)
            .unwrap()
            .state,
        TaskState::Unknown
    );
    assert_eq!(dump(&store), before);
}

#[test]
fn snapshot_reads_terminal_states_without_mutation() {
    for terminal in ["completed", "failed", "cancelled"] {
        let dir = TempDir::new();
        let mut store = CoreStore::open(&dir.store()).unwrap();
        store
            .create_mission(PROFILE, &create(&create_json("queued")), now())
            .unwrap();
        store
            .commit_event(
                PROFILE,
                &event(&event_json(
                    0x90,
                    json!({"type": "mission.state", "state": "running"}),
                )),
                now(),
            )
            .unwrap();
        for (index, task) in [TASK, SECOND_TASK].iter().enumerate() {
            store
                .transition_task(
                    PROFILE,
                    &transition(
                        0x91 + index as u32 * 2,
                        task,
                        TaskState::Queued,
                        TaskState::Running,
                    ),
                    now(),
                )
                .unwrap();
            store
                .transition_task(
                    PROFILE,
                    &transition(
                        0x92 + index as u32 * 2,
                        task,
                        TaskState::Running,
                        TaskState::Completed,
                    ),
                    now(),
                )
                .unwrap();
        }
        store
            .commit_event(
                PROFILE,
                &event(&event_json(
                    0x99,
                    json!({"type": "mission.state", "state": terminal}),
                )),
                now(),
            )
            .unwrap();
        let before = dump(&store);
        let snapshot = store.mission_snapshot(PROFILE, MISSION).unwrap();
        assert_eq!(snapshot.state.as_str(), terminal);
        assert!(snapshot.tasks.iter().all(|task| task.state.terminal()));
        assert!(snapshot.leases.is_empty());
        assert_eq!(dump(&store), before);
    }
}

#[test]
fn snapshot_rejects_corrupt_rows_graph_leases_and_totals_without_writes() {
    let corruptions = [
        "UPDATE missions SET workspace_id = '00000000-0000-4000-8000-000000000099'",
        "UPDATE missions SET version = version + 1",
        "UPDATE missions SET state = 'recovering'",
        "UPDATE missions SET updated_at = '2026-10-23T12:00:00.000Z'",
        "UPDATE missions SET digest = printf('%064d', 0)",
        "UPDATE missions SET payload = '{}'",
        "UPDATE tasks SET state = 'unknown'",
        "UPDATE tasks SET attempt = attempt + 1",
        "UPDATE tasks SET updated_at = 'invalid'",
        "UPDATE tasks SET digest = printf('%064d', 0)",
        "UPDATE tasks SET payload = '{}'",
        "DELETE FROM tasks WHERE task_id = '00000000-0000-4000-8000-000000000005'",
        "DELETE FROM leases",
        "UPDATE leases SET holder_agent_id = '00000000-0000-4000-8000-000000000099'",
        "UPDATE leases SET lease_id = '00000000-0000-4000-8000-000000000099'",
        "UPDATE leases SET expires_at = 'invalid'",
        "UPDATE leases SET expires_at = '2020-01-01T00:00:00Z'",
        "UPDATE mission_totals SET last_sequence = last_sequence + 1",
    ];
    for sql in corruptions {
        let dir = TempDir::new();
        let mut store = CoreStore::open(&dir.store()).unwrap();
        store
            .create_mission(PROFILE, &create(&create_json("queued")), now())
            .unwrap();
        store
            .transition_task(
                PROFILE,
                &transition(0x91, TASK, TaskState::Queued, TaskState::Running),
                now(),
            )
            .unwrap();
        store.conn.execute(sql, []).unwrap();
        let before = dump(&store);
        assert!(
            matches!(
                store.mission_snapshot(PROFILE, MISSION),
                Err(MissionError::Corrupt(_))
            ),
            "{sql}"
        );
        assert_eq!(dump(&store), before, "{sql}");
    }
}
