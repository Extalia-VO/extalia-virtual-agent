//! Slice A store tests: transactions, idempotency, leases and recovery, profiles, caps.
//! Every test works in its own temporary directory only.

use rusqlite::params;
use serde_json::{Value, json};

use super::tests::TempDir;
use super::{CoreStore, StoreError};
use crate::mission::{
    AgentEvent, LEASE_TTL_MS, LeaseClaim, MAX_EVENT_BYTES, MAX_EVENTS_PER_MISSION, MissionCreate,
    MissionError, MissionHeartbeat, TaskState, TaskTransition, contract,
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
        supervisor_id: None,
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
        "execution_admissions",
        "execution_observations",
        "execution_local_drains",
        "mission_planned_tasks",
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
    // Generic transitions cannot resolve uncertainty; controlled reconciliation is separate.
    let resolve = transition(84, TASK, TaskState::Unknown, TaskState::Failed);
    assert!(matches!(
        store.transition_task(PROFILE, &resolve, now()),
        Err(MissionError::Conflict(_))
    ));
    assert_eq!(dump(&store), before);

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

fn heartbeat(task: &str, epoch: u32) -> MissionHeartbeat {
    MissionHeartbeat {
        mission_id: MISSION.into(),
        leases: vec![LeaseClaim {
            task_id: task.into(),
            lease_id: uuid(epoch),
            holder_agent_id: WORKER.into(),
        }],
    }
}

#[test]
fn independent_heartbeat_renews_without_journal_growth_or_clock_rollback_shortening() {
    let dir = TempDir::new();
    let mut store = running_store(&dir);
    let initial = store.mission_snapshot(PROFILE, MISSION).unwrap();
    for offset in 1..=100 {
        let ack = store
            .heartbeat_mission(PROFILE, &heartbeat(TASK, 51), now() + offset * 1_000)
            .unwrap();
        assert_eq!(ack.mission_id, MISSION);
        assert_eq!(ack.leases.len(), 1);
        assert_eq!(ack.leases[0].lease_id, uuid(51));
        assert_eq!(parse_utc(&ack.leases[0].acquired_at), Some(now()));
        assert_eq!(
            parse_utc(&ack.leases[0].expires_at),
            Some(now() + offset * 1_000 + LEASE_TTL_MS)
        );
    }
    let before = dump(&store);
    let ack = store
        .heartbeat_mission(PROFILE, &heartbeat(TASK, 51), now() - 1_000)
        .unwrap();
    assert_eq!(
        parse_utc(&ack.leases[0].expires_at),
        Some(now() + 100_000 + LEASE_TTL_MS)
    );
    assert_eq!(
        dump(&store),
        before,
        "clock rollback does not change an existing grant"
    );
    let snapshot = store.mission_snapshot(PROFILE, MISSION).unwrap();
    assert_eq!(snapshot.tasks, initial.tasks);
    assert_eq!(
        (snapshot.version, snapshot.sequence, snapshot.updated_at),
        (initial.version, initial.sequence, initial.updated_at)
    );
}

#[test]
fn heartbeat_refuses_wrong_profile_mission_task_epoch_and_holder_without_writes() {
    let dir = TempDir::new();
    let mut store = running_store(&dir);
    let before = dump(&store);
    assert!(matches!(
        store.heartbeat_mission(OTHER_PROFILE, &heartbeat(TASK, 51), now()),
        Err(MissionError::NotFound)
    ));
    let mut foreign_mission = heartbeat(TASK, 51);
    foreign_mission.mission_id = uuid(999);
    assert!(matches!(
        store.heartbeat_mission(PROFILE, &foreign_mission, now()),
        Err(MissionError::NotFound)
    ));
    for mut invalid in [
        heartbeat(TASK, 99),
        heartbeat(SECOND_TASK, 51),
        heartbeat(TASK, 51),
    ] {
        if invalid == heartbeat(TASK, 51) {
            invalid.leases[0].holder_agent_id = LEAD.into();
        }
        assert!(matches!(
            store.heartbeat_mission(PROFILE, &invalid, now()),
            Err(MissionError::Conflict(_))
        ));
    }
    assert_eq!(dump(&store), before);
}

#[test]
fn heartbeat_batch_validates_all_members_and_rolls_back_storage_failure() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let mut plan = create_json("queued");
    plan["graph"]["tasks"][1]["dependsOn"] = json!([]);
    store
        .create_mission(PROFILE, &create(&plan), now())
        .unwrap();
    for (task, epoch) in [(TASK, 51), (SECOND_TASK, 52)] {
        store
            .transition_task(
                PROFILE,
                &transition(epoch, task, TaskState::Queued, TaskState::Running),
                now(),
            )
            .unwrap();
    }
    let mut request = heartbeat(TASK, 51);
    request.leases.extend(heartbeat(SECOND_TASK, 52).leases);
    let before = dump(&store);
    let mut invalid = request.clone();
    invalid.leases[1].lease_id = uuid(99);
    assert!(matches!(
        store.heartbeat_mission(PROFILE, &invalid, now() + 1_000),
        Err(MissionError::Conflict(_))
    ));
    assert_eq!(dump(&store), before);
    store.fail_before_commit.set(true);
    assert!(matches!(
        store.heartbeat_mission(PROFILE, &request, now() + 1_000),
        Err(MissionError::Storage(_))
    ));
    store.fail_before_commit.set(false);
    assert_eq!(dump(&store), before);
    let ack = store
        .heartbeat_mission(PROFILE, &request, now() + 1_000)
        .unwrap();
    assert_eq!(
        ack.leases
            .iter()
            .map(|lease| lease.task_id.as_str())
            .collect::<Vec<_>>(),
        [TASK, SECOND_TASK]
    );
    assert!(
        ack.leases
            .iter()
            .all(|lease| parse_utc(&lease.expires_at) == Some(now() + 1_000 + LEASE_TTL_MS))
    );
}

#[test]
fn exact_expiry_fences_heartbeat_activity_task_state_and_terminal_transitions() {
    for offset in [0, 1] {
        let dir = TempDir::new();
        let mut store = running_store(&dir);
        let at = now() + LEASE_TTL_MS + offset;
        let before = dump(&store);
        assert!(matches!(
            store.heartbeat_mission(PROFILE, &heartbeat(TASK, 51), at),
            Err(MissionError::Conflict(_))
        ));
        assert!(matches!(
            store.commit_event(PROFILE, &activity(100), at),
            Err(MissionError::Conflict(_))
        ));
        let same_state = event(&event_json(
            101,
            json!({"type": "task.state", "state": "running"}),
        ));
        assert!(matches!(
            store.commit_event(PROFILE, &same_state, at),
            Err(MissionError::Conflict(_))
        ));
        for to in [
            TaskState::Completed,
            TaskState::Failed,
            TaskState::Cancelled,
            TaskState::Waiting,
        ] {
            let change = transition(102, TASK, TaskState::Running, to);
            assert!(matches!(
                store.transition_task(PROFILE, &change, at),
                Err(MissionError::Conflict(_))
            ));
        }
        let terminal = event(&event_json(
            103,
            json!({"type": "mission.state", "state": "completed"}),
        ));
        assert!(matches!(
            store.commit_event(PROFILE, &terminal, at),
            Err(MissionError::Conflict(_))
        ));
        assert_eq!(dump(&store), before);
    }
    let dir = TempDir::new();
    let mut store = running_store(&dir);
    assert!(
        store
            .heartbeat_mission(PROFILE, &heartbeat(TASK, 51), now() + LEASE_TTL_MS - 1)
            .is_ok()
    );
}

#[test]
fn restart_quarantine_refuses_late_heartbeats_and_completions_but_allows_identical_acks() {
    let dir = TempDir::new();
    let mut store = running_store(&dir);
    let original = activity(95);
    let original_ack = store.commit_event(PROFILE, &original, now() + 1).unwrap();
    store.close().unwrap();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    store.recover(PROFILE, now() + 2).unwrap();
    let before = dump(&store);
    assert!(matches!(
        store.heartbeat_mission(PROFILE, &heartbeat(TASK, 51), now() + 3),
        Err(MissionError::Conflict(_))
    ));
    assert!(
        store
            .transition_task(
                PROFILE,
                &transition(96, TASK, TaskState::Unknown, TaskState::Completed),
                now() + 3
            )
            .is_err()
    );
    assert!(matches!(
        store.transition_task(
            PROFILE,
            &transition(97, TASK, TaskState::Unknown, TaskState::Failed),
            now() + 3
        ),
        Err(MissionError::Conflict(_))
    ));
    assert!(matches!(
        store.commit_event(PROFILE, &activity(98), now() + 3),
        Err(MissionError::Conflict(_))
    ));
    let terminal = event(&event_json(
        99,
        json!({"type": "mission.state", "state": "failed"}),
    ));
    assert!(matches!(
        store.commit_event(PROFILE, &terminal, now() + 3),
        Err(MissionError::Conflict(_))
    ));
    let retried = store
        .commit_event(PROFILE, &original, now() + LEASE_TTL_MS * 2)
        .unwrap();
    assert!(retried.duplicate);
    assert_eq!(retried.sequence, original_ack.sequence);
    assert!(
        store
            .transition_task(
                PROFILE,
                &transition(51, TASK, TaskState::Queued, TaskState::Running),
                now() + LEASE_TTL_MS * 2
            )
            .is_ok()
    );
    assert_eq!(dump(&store), before);
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
                supervisor_id: None,
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
                        supervisor_id: None,
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
        // A recovering mission refuses fresh lead state changes too, preserving quarantine.
        let fixture = &fixtures[0];
        let failed = fixture_event(
            id(),
            fixture,
            json!({ "type": "mission.state", "state": "failed" }),
        );
        assert!(matches!(
            store.commit_event(fixture.profile, &failed, now()),
            Err(MissionError::Conflict(_))
        ));
        assert_eq!(totals_and_aggregates(&store).0, before);
        assert_totals_exact(&store, "after recovery");

        // Writers outside the store code keep totals exact; planner history forbids mission deletion.
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
        // Exercise the append invariant directly: the recovering-state fence above
        // intentionally prevents public late events from reaching this lower layer.
        {
            let tx = store.conn.transaction().unwrap();
            let event_id = uuid(id());
            let entry = super::missions::tests_support::entry(
                fixture.profile,
                &fixture.mission,
                &event_id,
                serde_json::Map::new(),
            );
            assert!(matches!(
                super::missions::tests_support::append(&tx, entry),
                Err(MissionError::Corrupt(_))
            ));
        }
        assert!(
            store
                .conn
                .execute(
                    "DELETE FROM missions WHERE mission_id = ?1",
                    [&fixtures[2].mission],
                )
                .is_err()
        );
        assert_totals_exact(&store, "refused mission cascade");
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

/// A disjoint one-task mission for bounded live-reaper batch tests.
fn reaper_fixture(store: &mut CoreStore, profile: &str, index: u32) -> (String, String) {
    let mission_id = uuid(0x10000 + index * 16);
    let task_id = uuid(0x10001 + index * 16);
    let mut plan = create_json("queued");
    plan["mission"]["id"] = mission_id.clone().into();
    plan["graph"]["missionId"] = mission_id.clone().into();
    let mut task = task_json(&task_id, &[]);
    task["missionId"] = mission_id.clone().into();
    plan["graph"]["tasks"] = json!([task]);
    store
        .create_mission(profile, &create(&plan), now())
        .unwrap();
    store
        .transition_task(
            profile,
            &TaskTransition {
                supervisor_id: None,
                mission_id: mission_id.clone(),
                task_id: task_id.clone(),
                event_id: uuid(0x10002 + index * 16),
                from: TaskState::Queued,
                to: TaskState::Running,
            },
            now(),
        )
        .unwrap();
    (mission_id, task_id)
}

#[test]
fn live_reaper_exact_expiry_is_idempotent_and_preserves_queued_tasks_and_journal() {
    let dir = TempDir::new();
    let mut store = running_store(&dir);
    let before = dump(&store);
    let snapshot = store.mission_snapshot(PROFILE, MISSION).unwrap();
    let queued = task_state(&store, SECOND_TASK);
    assert_eq!(
        store
            .reap_expired_leases(PROFILE, now() + LEASE_TTL_MS - 1)
            .unwrap(),
        Default::default()
    );
    assert_eq!(dump(&store), before);
    let report = store
        .reap_expired_leases(PROFILE, now() + LEASE_TTL_MS)
        .unwrap();
    assert_eq!(
        (
            report.missions,
            report.tasks,
            report.expired_leases,
            report.orphaned_leases
        ),
        (1, 1, 1, 0)
    );
    let reaped = store.mission_snapshot(PROFILE, MISSION).unwrap();
    assert_eq!(reaped.state.as_str(), "recovering");
    assert_eq!(reaped.version, snapshot.version + 1);
    assert_eq!(reaped.sequence, snapshot.sequence);
    assert_eq!(
        reaped
            .tasks
            .iter()
            .find(|task| task.task_id == TASK)
            .unwrap()
            .state,
        TaskState::Unknown
    );
    assert_eq!(
        reaped
            .tasks
            .iter()
            .find(|task| task.task_id == TASK)
            .unwrap()
            .attempt,
        1
    );
    assert!(reaped.leases.is_empty());
    assert_eq!(task_state(&store, SECOND_TASK), queued);
    let after = dump(&store);
    assert_eq!(
        store
            .reap_expired_leases(PROFILE, now() + LEASE_TTL_MS * 2)
            .unwrap(),
        Default::default()
    );
    assert_eq!(dump(&store), after);
    store.close().unwrap();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    assert_eq!(
        store.recover(PROFILE, now() + LEASE_TTL_MS * 3).unwrap(),
        Default::default()
    );
    assert_eq!(store.mission_snapshot(PROFILE, MISSION).unwrap(), reaped);
    assert!(
        store
            .transition_task(
                PROFILE,
                &transition(0x999, TASK, TaskState::Unknown, TaskState::Running),
                now() + LEASE_TTL_MS * 3
            )
            .is_err()
    );
    assert_eq!(dump(&store), after);
}

#[test]
fn live_reaper_quarantines_unexpired_and_assigned_siblings_without_touching_terminal_results() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let assigned = uuid(0x21);
    let queued = uuid(0x22);
    let completed = uuid(0x23);
    let mut plan = create_json("queued");
    plan["graph"]["tasks"] = json!([
        task_json(TASK, &[]),
        task_json(SECOND_TASK, &[]),
        task_json(&assigned, &[]),
        task_json(&queued, &[]),
        task_json(&completed, &[]),
    ]);
    store
        .create_mission(PROFILE, &create(&plan), now())
        .unwrap();
    for (id, task, time) in [
        (51, TASK, now()),
        (52, SECOND_TASK, now() + 1_000),
        (53, &completed, now()),
    ] {
        store
            .transition_task(
                PROFILE,
                &transition(id, task, TaskState::Queued, TaskState::Running),
                time,
            )
            .unwrap();
    }
    store
        .transition_task(
            PROFILE,
            &transition(54, &completed, TaskState::Running, TaskState::Completed),
            now() + 1,
        )
        .unwrap();
    store
        .transition_task(
            PROFILE,
            &transition(55, &assigned, TaskState::Queued, TaskState::Assigned),
            now(),
        )
        .unwrap();
    let queued_before = task_state(&store, &queued);
    let completed_before = task_state(&store, &completed);
    let sequence = sequences(&store, PROFILE);
    let report = store
        .reap_expired_leases(PROFILE, now() + LEASE_TTL_MS)
        .unwrap();
    assert_eq!(
        (
            report.missions,
            report.tasks,
            report.expired_leases,
            report.orphaned_leases
        ),
        (1, 3, 1, 1)
    );
    for task in [TASK, SECOND_TASK, assigned.as_str()] {
        assert_eq!(task_state(&store, task).0, "unknown");
    }
    assert_eq!(task_state(&store, &queued), queued_before);
    assert_eq!(task_state(&store, &completed), completed_before);
    assert_eq!(lease_count(&store), 0);
    assert_eq!(sequences(&store, PROFILE), sequence);
}

#[test]
fn live_reaper_batches_missions_and_never_mutates_another_profile() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let max = crate::mission::MAX_REAP_MISSIONS_PER_TICK;
    let own = (0..max + 3)
        .map(|index| reaper_fixture(&mut store, PROFILE, index as u32))
        .collect::<Vec<_>>();
    let (foreign, _) = reaper_fixture(&mut store, OTHER_PROFILE, 100);
    let foreign_before = store.mission_snapshot(OTHER_PROFILE, &foreign).unwrap();
    let report = store
        .reap_expired_leases(PROFILE, now() + LEASE_TTL_MS)
        .unwrap();
    assert_eq!(
        (report.missions, report.tasks, report.expired_leases),
        (max as u64, max as u64, max as u64)
    );
    assert_eq!(
        store.mission_snapshot(OTHER_PROFILE, &foreign).unwrap(),
        foreign_before
    );
    assert_eq!(
        own.iter()
            .filter(|(mission, _)| store
                .mission_snapshot(PROFILE, mission)
                .unwrap()
                .state
                .as_str()
                == "recovering")
            .count(),
        max
    );
    let report = store
        .reap_expired_leases(PROFILE, now() + LEASE_TTL_MS)
        .unwrap();
    assert_eq!(
        (report.missions, report.tasks, report.expired_leases),
        (3, 3, 3)
    );
    assert_eq!(
        store
            .reap_expired_leases(PROFILE, now() + LEASE_TTL_MS)
            .unwrap(),
        Default::default()
    );
    for (mission, _) in own {
        let snapshot = store.mission_snapshot(PROFILE, &mission).unwrap();
        assert_eq!((snapshot.version, snapshot.sequence), (2, 2));
    }
    assert_eq!(
        store.mission_snapshot(OTHER_PROFILE, &foreign).unwrap(),
        foreign_before
    );
}

#[test]
fn live_reaper_respects_serialized_renewal_order_and_never_resurrects_quarantine() {
    let dir = TempDir::new();
    let mut store = running_store(&dir);
    let ack = store
        .heartbeat_mission(PROFILE, &heartbeat(TASK, 51), now() + LEASE_TTL_MS - 1)
        .unwrap();
    let before = dump(&store);
    assert_eq!(
        store
            .reap_expired_leases(PROFILE, now() + LEASE_TTL_MS)
            .unwrap(),
        Default::default()
    );
    assert_eq!(dump(&store), before);
    let expires = parse_utc(&ack.leases[0].expires_at).unwrap();
    assert_eq!(
        store
            .reap_expired_leases(PROFILE, expires)
            .unwrap()
            .missions,
        1
    );
    let quarantined = dump(&store);
    assert!(matches!(
        store.heartbeat_mission(PROFILE, &heartbeat(TASK, 51), expires),
        Err(MissionError::Conflict(_))
    ));
    assert!(
        store
            .transition_task(
                PROFILE,
                &transition(0x99, TASK, TaskState::Unknown, TaskState::Failed),
                expires
            )
            .is_err()
    );
    assert_eq!(dump(&store), quarantined);
}

#[test]
fn live_reaper_storage_failure_rolls_back_the_entire_batch() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    for index in 0..3 {
        reaper_fixture(&mut store, PROFILE, index);
    }
    let before = dump(&store);
    store.fail_before_commit.set(true);
    assert!(matches!(
        store.reap_expired_leases(PROFILE, now() + LEASE_TTL_MS),
        Err(MissionError::Storage(_))
    ));
    store.fail_before_commit.set(false);
    assert_eq!(dump(&store), before);
    assert_eq!(
        store
            .reap_expired_leases(PROFILE, now() + LEASE_TTL_MS)
            .unwrap()
            .missions,
        3
    );
}

#[test]
fn live_reaper_refuses_corruption_or_terminal_leases_without_erasing_evidence() {
    for sql in [
        "UPDATE leases SET expires_at = 'invalid'",
        "UPDATE leases SET expires_at = '2026-02-30T12:00:00.000Z'",
        "UPDATE leases SET holder_agent_id = '00000000-0000-4000-8000-000000000099'",
        "UPDATE leases SET lease_id = '00000000-0000-4000-8000-000000000099' WHERE task_id = '00000000-0000-4000-8000-000000000005'",
        "UPDATE tasks SET attempt = attempt + 1",
        "UPDATE missions SET version = version + 1",
    ] {
        let dir = TempDir::new();
        let mut store = running_store(&dir);
        // A valid sibling mission must not be partially reaped before the refusal.
        reaper_fixture(&mut store, PROFILE, 0);
        store.conn.execute(sql, []).unwrap();
        let before = dump(&store);
        assert!(
            matches!(
                store.reap_expired_leases(PROFILE, now() + LEASE_TTL_MS),
                Err(MissionError::Corrupt(_))
            ),
            "{sql}"
        );
        assert_eq!(dump(&store), before, "{sql}");
    }
    let dir = TempDir::new();
    let mut store = running_store(&dir);
    store
        .commit_event(
            PROFILE,
            &event(&event_json(
                99,
                json!({"type":"mission.state","state":"completed"}),
            )),
            now(),
        )
        .unwrap();
    let before = dump(&store);
    assert!(matches!(
        store.reap_expired_leases(PROFILE, now() + LEASE_TTL_MS),
        Err(MissionError::Corrupt(_))
    ));
    assert_eq!(dump(&store), before);
}

#[test]
fn live_reaper_parses_timestamps_and_handles_a_full_64_task_mission() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let tasks = (0..64).map(|index| uuid(0x100 + index)).collect::<Vec<_>>();
    let mut plan = create_json("queued");
    plan["graph"]["tasks"] = Value::Array(tasks.iter().map(|task| task_json(task, &[])).collect());
    store
        .create_mission(PROFILE, &create(&plan), now())
        .unwrap();
    for (index, task) in tasks.iter().enumerate() {
        store
            .transition_task(
                PROFILE,
                &transition(
                    0x1000 + index as u32,
                    task,
                    TaskState::Queued,
                    TaskState::Running,
                ),
                now() + i64::from(index != 0),
            )
            .unwrap();
    }
    // A real equivalent UTC instant without fractional digits must be compared
    // numerically, not skipped because 'Z' sorts after '.000Z'.
    store
        .conn
        .execute(
            "UPDATE leases SET expires_at = replace(expires_at, '.000Z', 'Z') WHERE task_id = ?1",
            [&tasks[0]],
        )
        .unwrap();
    let report = store
        .reap_expired_leases(PROFILE, now() + LEASE_TTL_MS)
        .unwrap();
    assert_eq!(
        (
            report.missions,
            report.tasks,
            report.expired_leases,
            report.orphaned_leases
        ),
        (1, 64, 1, 63)
    );
    let snapshot = store.mission_snapshot(PROFILE, MISSION).unwrap();
    assert!(
        snapshot
            .tasks
            .iter()
            .all(|task| task.state == TaskState::Unknown && task.attempt == 1)
    );
    assert_eq!(snapshot.sequence, 65);
}

#[test]
fn live_reaper_advances_an_already_recovering_mission_only_when_quarantining_tasks() {
    let dir = TempDir::new();
    let mut store = running_store(&dir);
    store
        .commit_event(
            PROFILE,
            &event(&event_json(
                99,
                json!({"type":"mission.state","state":"recovering"}),
            )),
            now(),
        )
        .unwrap();
    let before = store.mission_snapshot(PROFILE, MISSION).unwrap();
    let report = store
        .reap_expired_leases(PROFILE, now() + LEASE_TTL_MS)
        .unwrap();
    assert_eq!(
        (
            report.missions,
            report.tasks,
            report.expired_leases,
            report.orphaned_leases
        ),
        (1, 1, 1, 0)
    );
    let after = store.mission_snapshot(PROFILE, MISSION).unwrap();
    assert_eq!(
        (after.version, after.sequence),
        (before.version + 1, before.sequence)
    );
    let saved = dump(&store);
    assert_eq!(
        store
            .reap_expired_leases(PROFILE, now() + LEASE_TTL_MS)
            .unwrap(),
        Default::default()
    );
    assert_eq!(dump(&store), saved);
}

fn admitted_execution(store: &mut CoreStore) -> crate::mission::ExecutionAdmission {
    store
        .create_mission(PROFILE, &create(&create_json("queued")), now())
        .unwrap();
    store
        .commit_event(
            PROFILE,
            &event(&event_json(
                200,
                json!({"type":"mission.state","state":"running"}),
            )),
            now(),
        )
        .unwrap();
    let mut request = transition(201, TASK, TaskState::Queued, TaskState::Running);
    request.supervisor_id = Some(uuid(202));
    let ack = store.transition_task(PROFILE, &request, now()).unwrap();
    let admission = ack.admission.unwrap();
    assert_eq!(
        store
            .transition_task(PROFILE, &request, now() + 1)
            .unwrap()
            .admission,
        Some(admission.clone())
    );
    admission
}
fn observation(
    admission: &crate::mission::ExecutionAdmission,
) -> crate::mission::ExecutionObservation {
    crate::mission::ExecutionObservation {
        mission_id: admission.mission_id.clone(),
        task_id: admission.task_id.clone(),
        lease_id: admission.lease_id.clone(),
        holder_agent_id: admission.holder_agent_id.clone(),
        supervisor_id: admission.supervisor_id.clone(),
        attempt: admission.attempt,
        admission_digest: admission.admission_digest.clone(),
        observation_id: uuid(203),
        kind: "turn-promise-settled".into(),
    }
}

#[test]
fn execution_admission_is_atomic_and_legacy_absence_is_not_backfilled() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    store
        .create_mission(PROFILE, &create(&create_json("queued")), now())
        .unwrap();
    let before = dump(&store);
    let mut request = transition(201, TASK, TaskState::Queued, TaskState::Running);
    request.supervisor_id = Some(uuid(202));
    store.fail_before_commit.set(true);
    assert!(store.transition_task(PROFILE, &request, now()).is_err());
    assert_eq!(dump(&store), before);
    store.fail_before_commit.set(false);
    let admission = store
        .transition_task(PROFILE, &request, now())
        .unwrap()
        .admission
        .unwrap();
    assert_eq!(admission.lease_id, request.event_id);
    assert_eq!(admission.attempt, 1);
    assert_eq!(
        admission.admission_digest,
        admission.captured_digest(PROFILE)
    );
    assert_ne!(
        admission.admission_digest,
        admission.captured_digest(OTHER_PROFILE)
    );
    assert!(
        store
            .conn
            .execute("UPDATE execution_admissions SET attempt=2", [])
            .is_err()
    );
    assert!(
        store
            .conn
            .execute("DELETE FROM execution_admissions", [])
            .is_err()
    );
    let mut second = transition(204, SECOND_TASK, TaskState::Queued, TaskState::Running);
    second.supervisor_id = None;
    // Dependency has not completed, so do not infer a historical admission for the second task.
    assert!(store.transition_task(PROFILE, &second, now()).is_err());
    let legacy_dir = TempDir::new();
    let mut legacy = CoreStore::open(&legacy_dir.store()).unwrap();
    legacy
        .create_mission(PROFILE, &create(&create_json("queued")), now())
        .unwrap();
    legacy
        .transition_task(
            PROFILE,
            &transition(201, TASK, TaskState::Queued, TaskState::Running),
            now(),
        )
        .unwrap();
    assert!(
        legacy
            .list_mission_executions(PROFILE, MISSION)
            .unwrap()
            .executions
            .is_empty()
    );
    legacy.recover(PROFILE, now() + 1).unwrap();
    assert!(
        legacy
            .list_mission_executions(PROFILE, MISSION)
            .unwrap()
            .executions
            .is_empty()
    );
}

#[test]
fn execution_observation_survives_reaping_and_restart_without_changing_authority_or_events() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let admission = admitted_execution(&mut store);
    let recorded = observation(&admission);
    assert!(
        store
            .list_mission_executions(PROFILE, MISSION)
            .unwrap()
            .executions[0]
            .observation
            .is_none()
    );
    store
        .reap_expired_leases(PROFILE, now() + LEASE_TTL_MS)
        .unwrap();
    let before = dump(&store);
    let ack = store
        .observe_execution(PROFILE, &recorded, now() + LEASE_TTL_MS + 1)
        .unwrap();
    assert!(!ack.duplicate);
    let after = dump(&store);
    assert_eq!(
        before
            .iter()
            .filter(|line| !line.starts_with("execution_observations:"))
            .collect::<Vec<_>>(),
        after
            .iter()
            .filter(|line| !line.starts_with("execution_observations:"))
            .collect::<Vec<_>>()
    );
    let expected = store.list_mission_executions(PROFILE, MISSION).unwrap();
    assert_eq!(expected.executions[0].admission, admission);
    assert!(expected.executions[0].observation.is_some());
    let repeated = store
        .observe_execution(PROFILE, &recorded, now() + LEASE_TTL_MS + 99)
        .unwrap();
    assert!(repeated.duplicate);
    assert_eq!(repeated.recorded_at, ack.recorded_at);
    store.close().unwrap();
    let mut next = CoreStore::open(&dir.store()).unwrap();
    next.recover(PROFILE, now() + LEASE_TTL_MS + 100).unwrap();
    assert_eq!(
        next.list_mission_executions(PROFILE, MISSION).unwrap(),
        expected
    );
    let snapshot = next.mission_snapshot(PROFILE, MISSION).unwrap();
    assert_eq!(snapshot.state, crate::mission::MissionState::Recovering);
    assert!(snapshot.leases.is_empty());
    assert_eq!(
        snapshot
            .tasks
            .iter()
            .find(|task| task.task_id == TASK)
            .unwrap()
            .state,
        TaskState::Unknown
    );
    assert!(
        next.transition_task(
            PROFILE,
            &transition(210, TASK, TaskState::Unknown, TaskState::Failed),
            now() + LEASE_TTL_MS + 101
        )
        .is_err()
    );
}

#[test]
fn execution_observation_rejects_wrong_identity_reuse_and_rolls_back_failed_writes() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let admission = admitted_execution(&mut store);
    let recorded = observation(&admission);
    let before = dump(&store);
    for key in [
        "missionId",
        "taskId",
        "leaseId",
        "holderAgentId",
        "supervisorId",
        "attempt",
        "admissionDigest",
    ] {
        let mut value = recorded.to_value();
        value[key] = match key {
            "attempt" => json!(2),
            "admissionDigest" => json!("d".repeat(64)),
            _ => json!(uuid(220)),
        };
        let wrong =
            contract::execution_observation(&value, "observation", &mut Vec::new()).unwrap();
        assert!(
            store.observe_execution(PROFILE, &wrong, now() + 1).is_err(),
            "{key}"
        );
        assert_eq!(dump(&store), before, "{key}");
    }
    assert!(
        store
            .observe_execution(OTHER_PROFILE, &recorded, now() + 1)
            .is_err()
    );
    store.fail_before_commit.set(true);
    assert!(
        store
            .observe_execution(PROFILE, &recorded, now() + 1)
            .is_err()
    );
    assert_eq!(dump(&store), before);
    store.fail_before_commit.set(false);
    let ack = store
        .observe_execution(PROFILE, &recorded, now() - 1)
        .unwrap();
    assert_eq!(
        ack.recorded_at, admission.admitted_at,
        "clock rollback cannot predate admission"
    );
    let mut reused = recorded.clone();
    reused.observation_id = uuid(221);
    assert!(
        store
            .observe_execution(PROFILE, &reused, now() + 2)
            .is_err()
    );
    assert!(
        store
            .conn
            .execute(
                "UPDATE execution_observations SET kind='effects-settled'",
                []
            )
            .is_err()
    );
    assert!(
        store
            .conn
            .execute("DELETE FROM execution_observations", [])
            .is_err()
    );
}

fn local_drain(
    admission: &crate::mission::ExecutionAdmission,
) -> crate::mission::ExecutionLocalDrain {
    crate::mission::ExecutionLocalDrain {
        mission_id: admission.mission_id.clone(),
        task_id: admission.task_id.clone(),
        lease_id: admission.lease_id.clone(),
        holder_agent_id: admission.holder_agent_id.clone(),
        supervisor_id: admission.supervisor_id.clone(),
        attempt: admission.attempt,
        admission_digest: admission.admission_digest.clone(),
        proof_id: uuid(230),
        kind: "local-operations-drained".into(),
        coverage: "extalia-native-local-v1".into(),
        provider_operations: 2,
        tool_operations: 3,
    }
}

#[test]
fn local_drain_requires_exact_admission_weak_observation_and_atomic_scoped_record() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let admission = admitted_execution(&mut store);
    let proof = local_drain(&admission);
    let before = dump(&store);
    assert!(store.record_local_drain(PROFILE, &proof, now()).is_err());
    assert_eq!(dump(&store), before);
    let weak = store
        .observe_execution(PROFILE, &observation(&admission), now() + 100)
        .unwrap();
    let before = dump(&store);
    for (key, value) in [
        ("missionId", json!(uuid(240))),
        ("taskId", json!(uuid(240))),
        ("leaseId", json!(uuid(240))),
        ("holderAgentId", json!(uuid(240))),
        ("supervisorId", json!(uuid(240))),
        ("attempt", json!(2)),
        ("admissionDigest", json!("f".repeat(64))),
    ] {
        let mut value_proof = proof.to_value();
        value_proof[key] = value;
        let wrong =
            contract::execution_local_drain(&value_proof, "localDrain", &mut Vec::new()).unwrap();
        assert!(
            store.record_local_drain(PROFILE, &wrong, now()).is_err(),
            "{key}"
        );
        assert_eq!(dump(&store), before, "{key}");
    }
    assert!(
        store
            .record_local_drain(OTHER_PROFILE, &proof, now())
            .is_err()
    );
    for (key, value) in [
        ("kind", json!("all-effects-stopped")),
        ("coverage", json!("remote")),
        ("providerOperations", json!(21)),
        ("toolOperations", json!(81)),
        ("providerOperations", json!(-1)),
        ("toolOperations", json!(0.5)),
        ("output", json!("untrusted")),
    ] {
        let mut invalid = proof.to_value();
        invalid[key] = value;
        assert!(
            contract::execution_local_drain(&invalid, "localDrain", &mut Vec::new()).is_none(),
            "{key}"
        );
    }
    let mut invalid = proof.clone();
    invalid.provider_operations = 21;
    assert!(store.record_local_drain(PROFILE, &invalid, now()).is_err());
    store.fail_before_commit.set(true);
    assert!(store.record_local_drain(PROFILE, &proof, now()).is_err());
    assert_eq!(dump(&store), before);
    store.fail_before_commit.set(false);
    let ack = store
        .record_local_drain(PROFILE, &proof, now() - 1)
        .unwrap();
    assert_eq!(
        ack.recorded_at, weak.recorded_at,
        "clock rollback cannot predate weak observation or admission"
    );
    assert!(!ack.duplicate);
    let after = dump(&store);
    assert_eq!(
        before,
        after
            .iter()
            .filter(|line| !line.starts_with("execution_local_drains:"))
            .cloned()
            .collect::<Vec<_>>()
    );
    let duplicate = store
        .record_local_drain(PROFILE, &proof, now() + 1000)
        .unwrap();
    assert!(duplicate.duplicate);
    assert_eq!(duplicate.recorded_at, ack.recorded_at);
    for (key, value) in [
        ("proofId", json!(uuid(241))),
        ("toolOperations", json!(4)),
        ("providerOperations", json!(0)),
    ] {
        let mut conflict = proof.to_value();
        conflict[key] = value;
        let conflict =
            contract::execution_local_drain(&conflict, "localDrain", &mut Vec::new()).unwrap();
        assert!(store.record_local_drain(PROFILE, &conflict, now()).is_err());
    }
    for sql in [
        "UPDATE execution_local_drains SET tool_operations=4",
        "DELETE FROM execution_local_drains",
    ] {
        assert!(store.conn.execute(sql, []).is_err());
    }
    assert_eq!(dump(&store), after);
}

#[test]
fn local_drain_survives_reaper_and_restart_and_accepts_late_proof_without_authority() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let admission = admitted_execution(&mut store);
    store
        .observe_execution(PROFILE, &observation(&admission), now() + 1)
        .unwrap();
    store
        .reap_expired_leases(PROFILE, now() + LEASE_TTL_MS)
        .unwrap();
    store.close().unwrap();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    store.recover(PROFILE, now() + LEASE_TTL_MS + 1).unwrap();
    let before = store.mission_snapshot(PROFILE, MISSION).unwrap();
    let proof = local_drain(&admission);
    store
        .record_local_drain(PROFILE, &proof, now() + LEASE_TTL_MS + 2)
        .unwrap();
    assert_eq!(store.mission_snapshot(PROFILE, MISSION).unwrap(), before);
    assert!(before.leases.is_empty());
    let expected = store.list_mission_executions(PROFILE, MISSION).unwrap();
    let saved = expected.executions[0].local_drain.as_ref().unwrap();
    assert_eq!(saved.proof_id, proof.proof_id);
    assert_eq!(saved.tool_operations, 3);
    store.close().unwrap();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    assert_eq!(
        store.list_mission_executions(PROFILE, MISSION).unwrap(),
        expected
    );
    assert!(
        store
            .record_local_drain(PROFILE, &proof, now())
            .unwrap()
            .duplicate
    );
}

#[test]
fn local_drain_accepts_terminal_task_and_rejects_global_proof_id_reuse() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let admission = admitted_execution(&mut store);
    store
        .observe_execution(PROFILE, &observation(&admission), now())
        .unwrap();
    store
        .transition_task(
            PROFILE,
            &transition(250, TASK, TaskState::Running, TaskState::Completed),
            now() + 1,
        )
        .unwrap();
    let before = store.mission_snapshot(PROFILE, MISSION).unwrap();
    let proof = local_drain(&admission);
    store
        .record_local_drain(PROFILE, &proof, now() + 2)
        .unwrap();
    assert_eq!(store.mission_snapshot(PROFILE, MISSION).unwrap(), before);
    let mut request = transition(251, SECOND_TASK, TaskState::Queued, TaskState::Running);
    request.supervisor_id = Some(uuid(252));
    let second = store
        .transition_task(PROFILE, &request, now() + 3)
        .unwrap()
        .admission
        .unwrap();
    let mut weak = observation(&second);
    weak.observation_id = uuid(253);
    store.observe_execution(PROFILE, &weak, now() + 4).unwrap();
    let reused = local_drain(&second);
    let before = dump(&store);
    assert!(
        store
            .record_local_drain(PROFILE, &reused, now() + 5)
            .is_err()
    );
    assert_eq!(dump(&store), before);
}

#[test]
fn migration_7_to_8_preserves_all_existing_rows_without_invented_local_proofs() {
    let dir = TempDir::new();
    // Current creation requires schema 11. Copy genuine canonical legacy-shaped rows
    // into the historical schema instead of running current writes against old tables.
    let fixture = TempDir::new();
    let mut source = CoreStore::open(&fixture.store()).unwrap();
    let admission = admitted_execution(&mut source);
    source
        .observe_execution(PROFILE, &observation(&admission), now())
        .unwrap();
    source.close().unwrap();
    let store = CoreStore::open_with(&dir.store(), &super::migrate::MIGRATIONS[..7]).unwrap();
    store
        .conn
        .execute(
            "ATTACH DATABASE ?1 AS fixture",
            [std::fs::canonicalize(fixture.store())
                .unwrap()
                .to_str()
                .unwrap()],
        )
        .unwrap();
    for table in [
        "missions",
        "tasks",
        "events",
        "leases",
        "execution_admissions",
        "execution_observations",
    ] {
        store
            .conn
            .execute_batch(&format!(
                "INSERT INTO {table} SELECT * FROM fixture.{table};"
            ))
            .unwrap();
    }
    store
        .conn
        .execute_batch("DETACH DATABASE fixture;")
        .unwrap();
    fn every_row(store: &CoreStore) -> Vec<(String, Vec<Vec<rusqlite::types::Value>>)> {
        let tables = store.conn.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='execution_local_drains' ORDER BY name").unwrap()
            .query_map([],|row|row.get::<_,String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
        tables
            .into_iter()
            .map(|name| {
                let mut statement = store
                    .conn
                    .prepare(&format!("SELECT * FROM {name} ORDER BY rowid"))
                    .unwrap();
                let columns = statement.column_count();
                let rows = statement
                    .query_map([], |row| {
                        (0..columns)
                            .map(|index| row.get(index))
                            .collect::<rusqlite::Result<Vec<rusqlite::types::Value>>>()
                    })
                    .unwrap()
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .unwrap();
                (name, rows)
            })
            .collect()
    }
    let before = every_row(&store);
    store.close().unwrap();
    let mut store = CoreStore::open_with(&dir.store(), &super::migrate::MIGRATIONS[..8]).unwrap();
    assert_eq!(store.schema_version().unwrap(), 8);
    assert_eq!(every_row(&store), before);
    assert!(
        store
            .list_mission_executions(PROFILE, MISSION)
            .unwrap()
            .executions[0]
            .local_drain
            .is_none()
    );
    assert_eq!(
        store
            .conn
            .query_row("SELECT count(*) FROM execution_local_drains", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn recovery_review_is_stable_read_only_and_profile_bound() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    admitted_execution(&mut store);
    let before = dump(&store);
    let first = store.mission_recovery_review(PROFILE, MISSION).unwrap();
    assert_eq!(
        first,
        store.mission_recovery_review(PROFILE, MISSION).unwrap()
    );
    assert_eq!(
        first.snapshot,
        store.mission_snapshot(PROFILE, MISSION).unwrap()
    );
    assert_eq!(
        first.executions,
        store
            .list_mission_executions(PROFILE, MISSION)
            .unwrap()
            .executions
    );
    assert_eq!(first.review_digest, first.captured_digest(PROFILE));
    assert_ne!(first.review_digest, first.captured_digest(OTHER_PROFILE));
    assert_eq!(first.to_value()["worktreeOwnership"], "unverified");
    assert_eq!(
        first.missing_admission_task_ids,
        vec![SECOND_TASK.to_owned()]
    );
    assert_eq!(dump(&store), before);
    assert!(matches!(
        store.mission_recovery_review(OTHER_PROFILE, MISSION),
        Err(MissionError::NotFound)
    ));
    assert!(matches!(
        store.mission_recovery_review(PROFILE, &uuid(999)),
        Err(MissionError::NotFound)
    ));
    assert!(matches!(
        store.mission_recovery_review(PROFILE, "bad"),
        Err(MissionError::Invalid(_))
    ));
    assert_eq!(dump(&store), before);
}

#[test]
fn recovery_review_never_infers_missing_or_legacy_admissions() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    store
        .create_mission(PROFILE, &create(&create_json("queued")), now())
        .unwrap();
    let queued = store.mission_recovery_review(PROFILE, MISSION).unwrap();
    assert_eq!(
        queued.missing_admission_task_ids,
        vec![TASK.to_owned(), SECOND_TASK.to_owned()]
    );
    // Legacy admissions omitted the supervisor; a running task still has no captured execution identity.
    store
        .transition_task(
            PROFILE,
            &transition(44, TASK, TaskState::Queued, TaskState::Running),
            now(),
        )
        .unwrap();
    store
        .reap_expired_leases(PROFILE, now() + LEASE_TTL_MS)
        .unwrap();
    let reviewed = store.mission_recovery_review(PROFILE, MISSION).unwrap();
    assert!(reviewed.executions.is_empty());
    assert_eq!(
        reviewed.missing_admission_task_ids,
        vec![TASK.to_owned(), SECOND_TASK.to_owned()]
    );
    assert_eq!(reviewed.snapshot.tasks[0].state, TaskState::Unknown);
    store.close().unwrap();
    let mut next = CoreStore::open(&dir.store()).unwrap();
    assert_eq!(
        next.mission_recovery_review(PROFILE, MISSION).unwrap(),
        reviewed
    );
}

#[test]
fn recovery_review_changes_for_late_evidence_without_version_or_sequence_change() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let admission = admitted_execution(&mut store);
    store
        .reap_expired_leases(PROFILE, now() + LEASE_TTL_MS)
        .unwrap();
    let first = store.mission_recovery_review(PROFILE, MISSION).unwrap();
    let weak = observation(&admission);
    store
        .observe_execution(PROFILE, &weak, now() + LEASE_TTL_MS + 1)
        .unwrap();
    let observed = store.mission_recovery_review(PROFILE, MISSION).unwrap();
    assert_eq!(first.snapshot, observed.snapshot);
    assert_ne!(first.review_digest, observed.review_digest);
    let drain = local_drain(&admission);
    store
        .record_local_drain(PROFILE, &drain, now() + LEASE_TTL_MS + 2)
        .unwrap();
    let drained = store.mission_recovery_review(PROFILE, MISSION).unwrap();
    assert_eq!(observed.snapshot, drained.snapshot);
    assert_ne!(observed.review_digest, drained.review_digest);
    assert_eq!(first.mission_digest, drained.mission_digest);
    assert_eq!(first.graph_digest, drained.graph_digest);
    let before = dump(&store);
    store
        .record_local_drain(PROFILE, &drain, now() + LEASE_TTL_MS + 9)
        .unwrap();
    assert_eq!(
        drained,
        store.mission_recovery_review(PROFILE, MISSION).unwrap()
    );
    assert_eq!(dump(&store), before);
    store.close().unwrap();
    let mut next = CoreStore::open(&dir.store()).unwrap();
    assert_eq!(
        next.mission_recovery_review(PROFILE, MISSION).unwrap(),
        drained
    );
}

#[test]
fn recovery_review_tracks_renewal_and_journal_changes() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let admission = admitted_execution(&mut store);
    let first = store.mission_recovery_review(PROFILE, MISSION).unwrap();
    store
        .heartbeat_mission(
            PROFILE,
            &MissionHeartbeat {
                mission_id: MISSION.into(),
                leases: vec![LeaseClaim {
                    task_id: TASK.into(),
                    lease_id: admission.lease_id,
                    holder_agent_id: WORKER.into(),
                }],
            },
            now() + 100,
        )
        .unwrap();
    let renewed = store.mission_recovery_review(PROFILE, MISSION).unwrap();
    assert_eq!(first.snapshot.sequence, renewed.snapshot.sequence);
    assert_ne!(first.review_digest, renewed.review_digest);
    store
        .commit_event(
            PROFILE,
            &event(&event_json(
                91,
                json!({"type":"agent.state","state":"working","activity":"read"}),
            )),
            now() + 101,
        )
        .unwrap();
    let journal = store.mission_recovery_review(PROFILE, MISSION).unwrap();
    assert_ne!(renewed.review_digest, journal.review_digest);
    assert!(journal.snapshot.sequence > renewed.snapshot.sequence);
}

#[test]
fn recovery_review_uses_one_pinned_sqlite_view() {
    use super::mission_recovery_review::review_in_transaction;
    use crate::mission::canonical;
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    store
        .create_mission(PROFILE, &create(&create_json("queued")), now())
        .unwrap();
    let before = store.mission_recovery_review(PROFILE, MISSION).unwrap();
    let tx = store.conn.transaction().unwrap();
    // Pin before a synthetic concurrent canonical writer changes non-projected task content.
    let mut task = super::missions::load_task(&tx, PROFILE, MISSION, TASK).unwrap();
    task.requirements = vec!["Changed task detail".into()];
    let external = rusqlite::Connection::open(dir.store()).unwrap();
    external
        .execute(
            "UPDATE tasks SET payload=?1,digest=?2 WHERE profile_id=?3 AND task_id=?4",
            params![
                canonical::to_string(&task.to_value()),
                canonical::digest(&task.to_value()),
                PROFILE,
                TASK
            ],
        )
        .unwrap();
    assert_eq!(
        review_in_transaction(&tx, PROFILE, MISSION).unwrap(),
        before
    );
    tx.commit().unwrap();
    // The original plan now detects this definition drift in a fresh read view.
    assert!(matches!(
        store.mission_recovery_review(PROFILE, MISSION),
        Err(MissionError::Corrupt(_))
    ));
}

#[test]
fn recovery_review_refuses_corrupt_evidence_without_writes() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    admitted_execution(&mut store);
    store
        .conn
        .execute_batch("DROP TRIGGER execution_admissions_no_update;")
        .unwrap();
    store
        .conn
        .execute(
            "UPDATE execution_admissions SET admission_digest=?1",
            ["f".repeat(64)],
        )
        .unwrap();
    let before = dump(&store);
    assert!(store.mission_recovery_review(PROFILE, MISSION).is_err());
    assert_eq!(dump(&store), before);
}

#[test]
fn recovery_review_covers_the_complete_bounded_graph() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let mut value = create_json("queued");
    value["graph"]["tasks"] = (0..64)
        .map(|index| task_json(&uuid(1000 + index), &[]))
        .collect();
    store
        .create_mission(PROFILE, &create(&value), now())
        .unwrap();
    let before = dump(&store);
    let review = store.mission_recovery_review(PROFILE, MISSION).unwrap();
    assert_eq!(review.snapshot.tasks.len(), 64);
    assert_eq!(review.missing_admission_task_ids.len(), 64);
    assert_eq!(
        review.missing_admission_task_ids,
        review
            .snapshot
            .tasks
            .iter()
            .map(|task| task.task_id.clone())
            .collect::<Vec<_>>()
    );
    assert!(review.executions.is_empty());
    assert!(crate::mission::canonical::to_string(&review.to_value()).len() < 512 * 1024);
    assert_eq!(dump(&store), before);
}
