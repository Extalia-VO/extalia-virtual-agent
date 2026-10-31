//! Original planner membership regressions. All persistence uses temporary stores.
use rusqlite::params;
use serde_json::json;

use super::{CoreStore, StoreError, migrate::MIGRATIONS, tests::TempDir};
use crate::mission::{
    LEASE_TTL_MS, MissionCreate, MissionError, PlannedTaskMembership,
    PlannedTaskMembershipAvailability, Task, TaskState, TaskTransition, canonical, contract,
};
use crate::time::parse_utc;

const PROFILE: &str = "default";
const MISSION: &str = "00000000-0000-4000-8000-000000000002";
const WORKSPACE: &str = "00000000-0000-4000-8000-000000000001";
const TASK: &str = "00000000-0000-4000-8000-000000000005";
const SECOND: &str = "00000000-0000-4000-8000-000000000006";
fn uuid(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}
fn now() -> i64 {
    parse_utc("2026-10-22T12:00:00.000Z").unwrap()
}

fn plan() -> MissionCreate {
    let task = |id| {
        json!({"schemaVersion":1,"id":id,"missionId":MISSION,"dependsOn":[],
        "assignedAgentId":uuid(4),"state":"queued","attempt":0,"requirements":["Build artifact"],"evidenceIds":[]})
    };
    let value = json!({"mission":{"schemaVersion":1,"id":MISSION,"workspaceId":WORKSPACE,"leadAgentId":uuid(3),
        "budgetId":uuid(7),"state":"queued","version":1,"createdAt":"2026-10-22T11:00:00.000Z","updatedAt":"2026-10-22T11:00:00.000Z"},
        "graph":{"schemaVersion":1,"missionId":MISSION,"tasks":[task(TASK),task(SECOND)]}});
    contract::mission_create(&value, "create", &mut Vec::new()).unwrap()
}
fn membership(store: &mut CoreStore) -> PlannedTaskMembership {
    match store.mission_planned_tasks(PROFILE, MISSION).unwrap() {
        PlannedTaskMembershipAvailability::Available(record) => record,
        PlannedTaskMembershipAvailability::LegacyUnavailable => {
            panic!("new mission lacks original membership")
        }
    }
}
fn dump(store: &CoreStore) -> Vec<String> {
    let mut result = Vec::new();
    for table in [
        "missions",
        "tasks",
        "mission_totals",
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
        let mut rows = statement.query([]).unwrap();
        while let Some(row) = rows.next().unwrap() {
            let values: Vec<_> = (0..columns)
                .map(|i| format!("{:?}", row.get::<_, rusqlite::types::Value>(i).unwrap()))
                .collect();
            result.push(format!("{table}:{}", values.join("|")));
        }
    }
    result
}
fn write_task(store: &CoreStore, task: &Task) {
    let value = task.to_value();
    store.conn.execute("UPDATE tasks SET mission_id=?1,state=?2,attempt=?3,digest=?4,payload=?5 WHERE task_id=?6",
        params![task.mission_id,task.state.as_str(),task.attempt as i64,canonical::digest(&value),canonical::to_string(&value),task.id]).unwrap();
}
fn insert_task(store: &CoreStore, task: &Task, profile: &str, mission_id: &str) {
    let value = task.to_value();
    store.conn.execute("INSERT INTO tasks (task_id,profile_id,mission_id,state,attempt,updated_at,digest,payload)
        VALUES (?1,?2,?3,?4,?5,'2026-10-22T12:00:00.000Z',?6,?7)",
        params![task.id,profile,mission_id,task.state.as_str(),task.attempt as i64,canonical::digest(&value),canonical::to_string(&value)]).unwrap();
}
fn start(task_id: &str, n: u32, from: TaskState) -> TaskTransition {
    TaskTransition {
        mission_id: MISSION.into(),
        task_id: task_id.into(),
        event_id: uuid(n),
        from,
        to: TaskState::Running,
        supervisor_id: Some(uuid(90)),
    }
}

#[test]
fn planned_tasks_capture_sorted_original_ids_digests_and_scope() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let mut create = plan();
    create.graph.tasks.reverse();
    store.create_mission(PROFILE, &create, now()).unwrap();
    let record = membership(&mut store);
    assert_eq!(
        record
            .tasks
            .iter()
            .map(|task| task.task_id.as_str())
            .collect::<Vec<_>>(),
        vec![TASK, SECOND]
    );
    assert_eq!(record.mission_id, MISSION);
    assert_eq!(record.workspace_id, WORKSPACE);
    assert_eq!(record.creation_version, 1);
    assert_eq!(
        record.graph_digest,
        canonical::digest(&record.graph.to_value())
    );
    for (identity, task) in record.tasks.iter().zip(&record.graph.tasks) {
        assert_eq!(identity.task_digest, canonical::digest(&task.to_value()));
    }
    assert_eq!(record.membership_digest, record.captured_digest(PROFILE));
    assert_ne!(record.membership_digest, record.captured_digest("other"));
    for index in 0..3 {
        let mut changed = record.clone();
        match index {
            0 => changed.workspace_id = uuid(80),
            1 => changed.mission_id = uuid(81),
            _ => changed.creation_version += 1,
        };
        assert_ne!(record.membership_digest, changed.captured_digest(PROFILE));
    }
    let before = dump(&store);
    assert!(matches!(
        store.mission_planned_tasks("other", MISSION),
        Err(MissionError::NotFound)
    ));
    assert!(matches!(
        store.create_mission("other", &create, now()),
        Err(MissionError::Conflict(_))
    ));
    assert_eq!(dump(&store), before);
}

#[test]
fn planned_tasks_creation_is_atomic_and_reordered_retries_are_identical() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let create = plan();
    let before = dump(&store);
    store.fail_before_commit.set(true);
    assert!(store.create_mission(PROFILE, &create, now()).is_err());
    assert_eq!(dump(&store), before);
    store.fail_before_commit.set(false);
    let ack = store.create_mission(PROFILE, &create, now()).unwrap();
    let captured = membership(&mut store);
    let before = dump(&store);
    assert_eq!(store.create_mission(PROFILE, &create, now()).unwrap(), ack);
    let mut reordered = create.clone();
    reordered.graph.tasks.reverse();
    assert_eq!(
        store.create_mission(PROFILE, &reordered, now()).unwrap(),
        ack
    );
    assert_eq!(membership(&mut store), captured);
    assert_eq!(dump(&store), before);
    let mut changed = create;
    changed.graph.tasks[0].requirements = vec!["Different definition".into()];
    assert!(matches!(
        store.create_mission(PROFILE, &changed, now()),
        Err(MissionError::Conflict(_))
    ));
    assert_eq!(dump(&store), before);
}

#[test]
fn planned_tasks_reject_invalid_direct_creates_without_mutation() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let before = dump(&store);
    for index in 0..7 {
        let mut create = plan();
        match index {
            0 => create.graph.tasks.push(create.graph.tasks[0].clone()),
            1 => create.graph.tasks[0].mission_id = uuid(80),
            2 => create.graph.tasks[0].id = "invalid".into(),
            3 => create.graph.tasks[0].depends_on = vec![uuid(80)],
            4 => create.mission.version = 0,
            5 => create.graph.tasks.clear(),
            _ => create.graph.tasks[0].requirements = vec!["x".repeat(1024 * 1024)],
        };
        assert!(
            store.create_mission(PROFILE, &create, now()).is_err(),
            "case {index}"
        );
        assert_eq!(dump(&store), before);
    }
}

#[test]
fn planned_tasks_sql_history_cannot_be_updated_deleted_or_replaced() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    store.create_mission(PROFILE, &plan(), now()).unwrap();
    // These protections must work with either recursive-trigger setting.
    for recursive in [false, true] {
        store
            .conn
            .pragma_update(None, "recursive_triggers", recursive)
            .unwrap();
        let before = dump(&store);
        for sql in [
            "UPDATE mission_planned_tasks SET creation_version=creation_version+1",
            "DELETE FROM mission_planned_tasks",
            "INSERT OR REPLACE INTO mission_planned_tasks SELECT * FROM mission_planned_tasks",
            "REPLACE INTO mission_planned_tasks SELECT * FROM mission_planned_tasks",
            "INSERT INTO mission_planned_tasks SELECT * FROM mission_planned_tasks WHERE 1 ON CONFLICT(mission_id) DO UPDATE SET task_count=1",
        ] {
            assert!(store.conn.execute_batch(sql).is_err(), "{sql}");
            assert_eq!(dump(&store), before);
        }
        assert!(
            store
                .conn
                .execute("DELETE FROM missions WHERE mission_id=?1", [MISSION])
                .is_err()
        );
        assert_eq!(dump(&store), before);
    }
}

#[test]
fn planned_tasks_rowid_alias_replace_cannot_downgrade_an_existing_manifest() {
    for alias in ["rowid", "_rowid_", "oid"] {
        let dir = TempDir::new();
        let mut store = CoreStore::open(&dir.store()).unwrap();
        store.create_mission(PROFILE, &plan(), now()).unwrap();
        let original = membership(&mut store);
        // A valid legacy parent has no manifest and satisfies all insertion scope checks.
        let mut legacy = plan().mission;
        legacy.id = uuid(80);
        let value = legacy.to_value();
        store.conn.execute("INSERT INTO missions (mission_id,profile_id,workspace_id,state,version,created_at,updated_at,digest,payload)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![legacy.id,PROFILE,legacy.workspace_id,legacy.state.as_str(),legacy.version as i64,
            legacy.created_at,legacy.updated_at,canonical::digest(&value),canonical::to_string(&value)]).unwrap();
        store
            .conn
            .pragma_update(None, "recursive_triggers", false)
            .unwrap();
        let before = dump(&store);
        // An ordinary rowid-table REPLACE could delete the original through a hidden
        // alias collision, even though NEW.mission_id does not collide with its key.
        let sql = format!("INSERT OR REPLACE INTO mission_planned_tasks ({alias},mission_id,profile_id,workspace_id,creation_version,task_count,graph_digest,membership_digest,payload)
            SELECT 1,?1,profile_id,workspace_id,creation_version,task_count,graph_digest,membership_digest,payload FROM mission_planned_tasks WHERE mission_id=?2");
        assert!(
            store
                .conn
                .execute(&sql, params![legacy.id, MISSION])
                .is_err(),
            "{alias} must not replace original history"
        );
        assert_eq!(dump(&store), before);
        assert_eq!(membership(&mut store), original);
        assert_eq!(
            store.mission_planned_tasks(PROFILE, &legacy.id).unwrap(),
            PlannedTaskMembershipAvailability::LegacyUnavailable
        );
    }
}

#[test]
fn planned_tasks_missing_extra_foreign_and_definition_drift_refuse_admission_and_review() {
    for case in 0..8 {
        let dir = TempDir::new();
        let mut store = CoreStore::open(&dir.store()).unwrap();
        let create = plan();
        store.create_mission(PROFILE, &create, now()).unwrap();
        let mut changed = create.graph.tasks[1].clone();
        match case {
            0 => {
                store
                    .conn
                    .execute("DELETE FROM tasks WHERE task_id=?1", [SECOND])
                    .unwrap();
            }
            1 => {
                changed.id = uuid(80);
                insert_task(&store, &changed, PROFILE, MISSION);
            }
            2 => {
                changed.mission_id = uuid(81);
                let value = changed.to_value();
                store
                    .conn
                    .execute(
                        "UPDATE tasks SET payload=?1,digest=?2 WHERE task_id=?3",
                        params![
                            canonical::to_string(&value),
                            canonical::digest(&value),
                            SECOND
                        ],
                    )
                    .unwrap();
            }
            3 => {
                changed.requirements = vec!["Changed definition".into()];
                write_task(&store, &changed);
            }
            4 => {
                changed.write_access = true;
                write_task(&store, &changed);
            }
            5 => {
                changed.depends_on = vec![TASK.into()];
                write_task(&store, &changed);
            }
            6 => {
                changed.parent_task_id = Some(TASK.into());
                write_task(&store, &changed);
            }
            _ => {
                store
                    .conn
                    .execute("DELETE FROM tasks WHERE task_id=?1", [SECOND])
                    .unwrap();
                changed.id = uuid(80);
                insert_task(&store, &changed, PROFILE, MISSION);
            }
        }
        let before = dump(&store);
        assert!(
            store
                .transition_task(PROFILE, &start(TASK, 100, TaskState::Queued), now())
                .is_err(),
            "admission case {case}"
        );
        assert_eq!(dump(&store), before);
        assert!(
            store.mission_recovery_review(PROFILE, MISSION).is_err(),
            "review case {case}"
        );
        assert_eq!(dump(&store), before);
    }
}

#[test]
fn planned_tasks_assignment_and_execution_state_evolve_without_changing_history() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let create = plan();
    store.create_mission(PROFILE, &create, now()).unwrap();
    let original = membership(&mut store);
    // Roster history is not an assertion that the original assignee owns future execution.
    let mut task = create.graph.tasks[0].clone();
    task.assigned_agent_id = Some(uuid(88));
    write_task(&store, &task);
    let running = start(TASK, 100, TaskState::Queued);
    let admission = store
        .transition_task(PROFILE, &running, now())
        .unwrap()
        .admission
        .unwrap();
    assert_eq!(admission.holder_agent_id, uuid(88));
    assert_eq!(membership(&mut store), original);
    for (n, from, to) in [
        (101, TaskState::Running, TaskState::Waiting),
        (102, TaskState::Waiting, TaskState::Running),
        (103, TaskState::Running, TaskState::Completed),
    ] {
        let mut transition = start(TASK, n, from);
        transition.to = to;
        transition.supervisor_id = None;
        store
            .transition_task(PROFILE, &transition, now() + i64::from(n))
            .unwrap();
        store.mission_recovery_review(PROFILE, MISSION).unwrap();
        assert_eq!(membership(&mut store), original);
    }
    store.close().unwrap();
    let mut next = CoreStore::open(&dir.store()).unwrap();
    assert_eq!(membership(&mut next), original);
    next.mission_recovery_review(PROFILE, MISSION).unwrap();
}

#[test]
fn planned_tasks_survive_reaping_and_restart_quarantine() {
    for restart in [false, true] {
        let dir = TempDir::new();
        let mut store = CoreStore::open(&dir.store()).unwrap();
        store.create_mission(PROFILE, &plan(), now()).unwrap();
        let original = membership(&mut store);
        store
            .transition_task(PROFILE, &start(TASK, 100, TaskState::Queued), now())
            .unwrap();
        if restart {
            store.close().unwrap();
            store = CoreStore::open(&dir.store()).unwrap();
            store.recover(PROFILE, now() + 1).unwrap();
        } else {
            store
                .reap_expired_leases(PROFILE, now() + LEASE_TTL_MS)
                .unwrap();
        }
        assert_eq!(membership(&mut store), original);
        store.mission_recovery_review(PROFILE, MISSION).unwrap();
    }
}

#[test]
fn planned_tasks_schema_10_history_remains_explicitly_unavailable_without_backfill() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let create = plan();
    store.create_mission(PROFILE, &create, now()).unwrap();
    store.close().unwrap();
    // Build an exact schema-10 fixture with genuine canonical mission/journal rows.
    let conn = rusqlite::Connection::open(dir.store()).unwrap();
    conn.execute_batch("DROP TRIGGER mission_planned_tasks_no_update; DROP TRIGGER mission_planned_tasks_no_delete; DROP TRIGGER mission_planned_tasks_no_replace; DROP TRIGGER mission_planned_tasks_scope; DROP TABLE mission_planned_tasks;").unwrap();
    conn.execute_batch("DROP TABLE planning_resource_claims; DROP TABLE planning_observations; DROP TABLE planning_admissions;").unwrap();
    conn.pragma_update(None, "user_version", 10).unwrap();
    super::migrate::verify_schema(&conn, &MIGRATIONS[..10]).unwrap();
    drop(conn);
    let mut store = CoreStore::open(&dir.store()).unwrap();
    assert_eq!(store.schema_version().unwrap(), CoreStore::LATEST);
    assert_eq!(
        store.mission_planned_tasks(PROFILE, MISSION).unwrap(),
        PlannedTaskMembershipAvailability::LegacyUnavailable
    );
    store.create_mission(PROFILE, &create, now()).unwrap();
    store.mission_recovery_review(PROFILE, MISSION).unwrap();
    store
        .transition_task(PROFILE, &start(TASK, 100, TaskState::Queued), now())
        .unwrap();
    store.mission_recovery_review(PROFILE, MISSION).unwrap();
    assert_eq!(
        store.mission_planned_tasks(PROFILE, MISSION).unwrap(),
        PlannedTaskMembershipAvailability::LegacyUnavailable
    );
    store.close().unwrap();
    assert!(matches!(
        CoreStore::open_with(&dir.store(), &MIGRATIONS[..10]),
        Err(StoreError::NewerSchema {
            found: 12,
            supported: 10
        })
    ));
}

#[test]
fn planned_tasks_maximum_graph_is_bounded_and_inspectable() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let mut create = plan();
    let task = create.graph.tasks[0].clone();
    create.graph.tasks = (0..64)
        .map(|n| {
            let mut task = task.clone();
            task.id = uuid(1000 + n);
            task
        })
        .collect();
    store.create_mission(PROFILE, &create, now()).unwrap();
    assert_eq!(membership(&mut store).tasks.len(), 64);
    store.mission_recovery_review(PROFILE, MISSION).unwrap();
    let before = dump(&store);
    create.graph.tasks.push(task);
    assert!(matches!(
        store.create_mission(PROFILE, &create, now()),
        Err(MissionError::Capacity(_))
    ));
    assert_eq!(dump(&store), before);
}

#[test]
fn planned_tasks_serialized_capture_and_current_reads_are_bounded() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let mut create = plan();
    create.graph.tasks[0].requirements = (0..700)
        .map(|n| format!("{n:04}{}", "x".repeat(1600)))
        .collect();
    // This is a valid direct contract; the independent serialized capture cap refuses it.
    assert!(contract::mission_create(&create.to_value(), "create", &mut Vec::new()).is_some());
    let before = dump(&store);
    assert!(matches!(
        store.create_mission(PROFILE, &create, now()),
        Err(MissionError::Capacity(_))
    ));
    assert_eq!(dump(&store), before);
    store.create_mission(PROFILE, &plan(), now()).unwrap();
    // Bound stored bytes before materializing or decoding an externally corrupted payload.
    store
        .conn
        .execute(
            "UPDATE tasks SET payload=?1 WHERE task_id=?2",
            params![" ".repeat(1024 * 1024 + 1), SECOND],
        )
        .unwrap();
    let before = dump(&store);
    assert!(matches!(
        store.transition_task(PROFILE, &start(TASK, 100, TaskState::Queued), now()),
        Err(MissionError::Capacity(_))
    ));
    assert!(matches!(
        store.mission_recovery_review(PROFILE, MISSION),
        Err(MissionError::Capacity(_))
    ));
    assert_eq!(dump(&store), before);
}

#[test]
fn planned_tasks_corrupt_history_never_returns_available_or_admits_work() {
    for case in 0..7 {
        let dir = TempDir::new();
        let mut store = CoreStore::open(&dir.store()).unwrap();
        store.create_mission(PROFILE, &plan(), now()).unwrap();
        let record = membership(&mut store);
        let mut value = record.to_value();
        match case {
            0 => value["membershipDigest"] = "0".repeat(64).into(),
            1 => value["tasks"][0]["taskDigest"] = "0".repeat(64).into(),
            2 => value["graphDigest"] = "0".repeat(64).into(),
            3 => value["graph"]["tasks"][0]["missionId"] = uuid(81).into(),
            4 => value["tasks"].as_array_mut().unwrap().reverse(),
            5 => value["creationVersion"] = 2.into(),
            _ => value["membershipDigest"] = record.captured_digest("other-profile").into(),
        }
        // Simulate corruption outside normal SQL writes; the ordinary trigger forbids this.
        store
            .conn
            .execute_batch("DROP TRIGGER mission_planned_tasks_no_update;")
            .unwrap();
        store
            .conn
            .execute(
                "UPDATE mission_planned_tasks SET payload=?1",
                [canonical::to_string(&value)],
            )
            .unwrap();
        let before = dump(&store);
        assert!(
            matches!(
                store.mission_planned_tasks(PROFILE, MISSION),
                Err(MissionError::Corrupt(_))
            ),
            "history case {case}"
        );
        assert!(
            store
                .transition_task(PROFILE, &start(TASK, 100, TaskState::Queued), now())
                .is_err()
        );
        assert!(store.mission_recovery_review(PROFILE, MISSION).is_err());
        assert_eq!(dump(&store), before);
    }
}

#[test]
fn planned_tasks_replayed_and_unsupervised_starts_also_refuse_drift() {
    for replayed in [false, true] {
        let dir = TempDir::new();
        let mut store = CoreStore::open(&dir.store()).unwrap();
        let create = plan();
        store.create_mission(PROFILE, &create, now()).unwrap();
        let mut request = start(TASK, 100, TaskState::Queued);
        if replayed {
            store.transition_task(PROFILE, &request, now()).unwrap();
        } else {
            request.supervisor_id = None;
        }
        let mut changed = create.graph.tasks[1].clone();
        changed.requirements = vec!["Changed definition".into()];
        write_task(&store, &changed);
        let before = dump(&store);
        assert!(store.transition_task(PROFILE, &request, now() + 1).is_err());
        assert_eq!(dump(&store), before);
    }
}
