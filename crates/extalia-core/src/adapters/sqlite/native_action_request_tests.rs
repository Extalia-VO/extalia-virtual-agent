//! Temporary native missions and stores only. No provider, user profile or executable grant.
use super::migrate::{MIGRATIONS, Migration};
use super::tests::TempDir;
use super::{CoreStore, NativeActionIntentError as Error, NativeActionIntentRecord};
use crate::control::native_action::NativeActionRequest;
use crate::mission::{ExecutionAdmission, MissionError, TaskState, TaskTransition, contract};
use crate::time::{format_utc, parse_utc};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

const PROFILE: &str = "default";
fn id(n: u64) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}
fn now() -> i64 {
    parse_utc("2026-01-01T00:00:00.000Z").unwrap()
}
fn setup(write: bool) -> (TempDir, CoreStore, ExecutionAdmission) {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let mut task = json!({"schemaVersion":1,"id":id(5),"missionId":id(2),"dependsOn":[],"assignedAgentId":id(4),"state":"queued","attempt":0,"requirements":[],"evidenceIds":[]});
    if write {
        task["access"] = json!("write");
    }
    let create = json!({"mission":{"schemaVersion":1,"id":id(2),"workspaceId":id(1),"leadAgentId":id(3),"budgetId":id(6),"state":"queued","createdAt":format_utc(now()),"updatedAt":format_utc(now()),"version":1},"graph":{"schemaVersion":1,"missionId":id(2),"tasks":[task]}});
    let create = contract::mission_create(&create, "params", &mut Vec::new()).unwrap();
    store.create_mission(PROFILE, &create, now()).unwrap();
    let event = json!({"schemaVersion":1,"id":id(10),"workspaceId":id(1),"sessionId":id(7),"missionId":id(2),"agentId":id(3),"source":{"runtime":"extalia-native","channel":"system"},"observedAt":format_utc(now()),"sequence":0,"confidence":"reported","body":{"type":"mission.state","state":"running"}});
    store
        .commit_event(
            PROFILE,
            &contract::agent_event(&event, "event", &mut Vec::new()).unwrap(),
            now(),
        )
        .unwrap();
    let admission = store
        .transition_task(
            PROFILE,
            &TaskTransition {
                mission_id: id(2),
                task_id: id(5),
                event_id: id(11),
                from: TaskState::Queued,
                to: TaskState::Running,
                supervisor_id: Some(id(12)),
            },
            now(),
        )
        .unwrap()
        .admission
        .unwrap();
    (dir, store, admission)
}
fn request(a: &ExecutionAdmission) -> NativeActionRequest {
    NativeActionRequest {
        request_id: id(30),
        idempotency_key: "edit-a".into(),
        mission_id: a.mission_id.clone(),
        workspace_id: a.workspace_id.clone(),
        task_id: a.task_id.clone(),
        lease_id: a.lease_id.clone(),
        holder_agent_id: a.holder_agent_id.clone(),
        supervisor_id: a.supervisor_id.clone(),
        attempt: a.attempt,
        admission_digest: a.admission_digest.clone(),
        tool: "write_file".into(),
        target: "src/main.ts".into(),
        parameters_digest: "a".repeat(64),
        policy_ref: "unresolved-policy-snapshot".into(),
        policy_version: "1".into(),
        policy_digest: "b".repeat(64),
        skill_revision_refs: vec![],
        expires_at: format_utc(now() + 60_000),
    }
}
fn unprivileged(record: &NativeActionIntentRecord) {
    assert!(record.admission_bound);
    assert!(!record.parameters_verified && !record.policy_verified && !record.dispatch_eligible);
    assert_ne!(record.state, "granted");
}
fn count(store: &CoreStore, table: &str) -> i64 {
    store
        .conn
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
}
fn dump(store: &CoreStore) -> Vec<(String, Vec<Vec<rusqlite::types::Value>>)> {
    [
        "missions",
        "tasks",
        "leases",
        "approvals",
        "native_action_clocks",
        "native_action_requests",
        "native_action_closures",
    ]
    .into_iter()
    .map(|table| {
        let mut statement = store
            .conn
            .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
            .unwrap();
        let columns = statement.column_count();
        let rows = statement
            .query_map([], |row| {
                (0..columns)
                    .map(|i| row.get(i))
                    .collect::<rusqlite::Result<Vec<rusqlite::types::Value>>>()
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        (table.to_owned(), rows)
    })
    .collect()
}

#[test]
fn actual_native_admission_and_lease_bind_a_non_executable_request_without_raw_args() {
    let (_dir, mut store, a) = setup(true);
    let before = store.mission_snapshot(PROFILE, &a.mission_id).unwrap();
    let r = request(&a);
    let result = store
        .record_native_action_request(PROFILE, &r, now())
        .unwrap();
    unprivileged(&result);
    assert_eq!(result.state, "pending");
    assert_eq!(result.state_version, 1);
    assert!(!result.duplicate);
    assert_eq!(
        store.mission_snapshot(PROFILE, &a.mission_id).unwrap(),
        before
    );
    assert_eq!(count(&store, "native_action_requests"), 1);
    let payload: String = store
        .conn
        .query_row("SELECT payload FROM approvals", [], |row| row.get(0))
        .unwrap();
    let value: Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(value["admission"], a.to_value());
    assert_eq!(
        value["request"]["parametersDigestScheme"],
        "unverified-sha256"
    );
    assert_eq!(value["request"]["parametersDigest"], r.parameters_digest);
    assert!(value["request"].get("arguments").is_none());
    assert_eq!(
        store
            .inspect_native_action_request(PROFILE, &r.request_id, now())
            .unwrap(),
        result
    );
}

#[test]
fn unknown_or_foreign_admission_and_wrong_owner_cannot_create_request_or_clock() {
    let (_dir, mut store, a) = setup(true);
    let r = request(&a);
    let before = dump(&store);
    for key in [
        "missionId",
        "workspaceId",
        "taskId",
        "leaseId",
        "holderAgentId",
        "supervisorId",
    ] {
        let mut v = r.to_value();
        v[key] = json!(id(99));
        let changed = NativeActionRequest::from_value(&v).unwrap();
        assert!(
            store
                .record_native_action_request(PROFILE, &changed, now())
                .is_err(),
            "{key}"
        );
    }
    let mut changed = r.clone();
    changed.admission_digest = "c".repeat(64);
    assert!(
        store
            .record_native_action_request(PROFILE, &changed, now())
            .is_err()
    );
    changed = r.clone();
    changed.attempt += 1;
    assert!(
        store
            .record_native_action_request(PROFILE, &changed, now())
            .is_err()
    );
    assert!(matches!(
        store.record_native_action_request("other-profile", &r, now()),
        Err(Error::NotFound)
    ));
    assert_eq!(dump(&store), before);
}

#[test]
fn read_only_execution_and_a_historical_lease_are_not_current_edit_authority() {
    let (_dir, mut store, a) = setup(false);
    assert!(matches!(
        store.record_native_action_request(PROFILE, &request(&a), now()),
        Err(Error::Inactive)
    ));
    assert_eq!(count(&store, "approvals"), 0);
    let (_dir, mut store, a) = setup(true);
    store
        .transition_task(
            PROFILE,
            &TaskTransition {
                mission_id: a.mission_id.clone(),
                task_id: a.task_id.clone(),
                event_id: id(40),
                from: TaskState::Running,
                to: TaskState::Completed,
                supervisor_id: None,
            },
            now() + 1,
        )
        .unwrap();
    assert!(matches!(
        store.record_native_action_request(PROFILE, &request(&a), now() + 2),
        Err(Error::Inactive)
    ));
    assert_eq!(count(&store, "native_action_requests"), 0);
}

#[test]
fn exact_scoped_replay_is_history_and_changed_intent_is_a_conflict() {
    let (_dir, mut store, a) = setup(true);
    let r = request(&a);
    let original = store
        .record_native_action_request(PROFILE, &r, now())
        .unwrap();
    let replay = store
        .record_native_action_request(PROFILE, &r, now() + 1)
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.request_digest, original.request_digest);
    assert_eq!(replay.requested_at, original.requested_at);
    unprivileged(&replay);
    for key in [
        "target",
        "parametersDigest",
        "policyRef",
        "policyVersion",
        "policyDigest",
        "requestId",
        "expiresAt",
    ] {
        let mut v = r.to_value();
        v[key] = match key {
            "requestId" => json!(id(90)),
            "parametersDigest" | "policyDigest" => json!("c".repeat(64)),
            "expiresAt" => json!(format_utc(now() + 50_000)),
            _ => json!("different"),
        };
        let changed = NativeActionRequest::from_value(&v).unwrap();
        assert!(
            matches!(
                store.record_native_action_request(PROFILE, &changed, now() + 2),
                Err(Error::Conflict)
            ),
            "{key}"
        );
    }
    assert_eq!(count(&store, "approvals"), 1);
    assert_eq!(count(&store, "native_action_closures"), 0);
}

#[test]
fn withdrawal_binds_the_displayed_digest_and_cas_without_an_allow_decision() {
    let (_dir, mut store, a) = setup(true);
    let r = request(&a);
    let initial = store
        .record_native_action_request(PROFILE, &r, now())
        .unwrap();
    let before = dump(&store);
    assert!(matches!(
        store.withdraw_native_action_request(PROFILE, &r.request_id, &"f".repeat(64), 1, now()),
        Err(Error::Conflict)
    ));
    assert_eq!(dump(&store), before);
    assert!(matches!(
        store.withdraw_native_action_request(
            PROFILE,
            &r.request_id,
            &initial.request_digest,
            2,
            now()
        ),
        Err(Error::Conflict)
    ));
    let closed = store
        .withdraw_native_action_request(
            PROFILE,
            &r.request_id,
            &initial.request_digest,
            1,
            now() + 5,
        )
        .unwrap();
    unprivileged(&closed);
    assert_eq!(closed.state, "revoked");
    assert_eq!(closed.state_version, 2);
    assert_eq!(closed.closure_reason.as_deref(), Some("withdrawn"));
    let replay = store
        .withdraw_native_action_request(
            PROFILE,
            &r.request_id,
            &initial.request_digest,
            1,
            now() + 70_000,
        )
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.closed_at, closed.closed_at);
    assert_eq!(replay.state, "revoked");
    assert_eq!(count(&store, "native_action_closures"), 1);
}

#[test]
fn expiry_is_sticky_and_new_request_ids_cannot_reset_the_execution_clock() {
    let (dir, mut store, a) = setup(true);
    let r = request(&a);
    store
        .record_native_action_request(PROFILE, &r, now())
        .unwrap();
    let expired = store
        .inspect_native_action_request(PROFILE, &r.request_id, now() + 60_000)
        .unwrap();
    assert_eq!(expired.state, "expired");
    assert_eq!(expired.closure_reason.as_deref(), Some("expiry"));
    store.close().unwrap();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    assert_eq!(
        store
            .inspect_native_action_request(PROFILE, &r.request_id, now())
            .unwrap(),
        expired
    );
    let mut new = r.clone();
    new.request_id = id(31);
    new.idempotency_key = "edit-b".into();
    new.expires_at = format_utc(now() + 120_000);
    assert!(matches!(
        store.record_native_action_request(PROFILE, &new, now()),
        Err(Error::Inactive)
    ));
    assert_eq!(count(&store, "approvals"), 1);
    let history = store
        .record_native_action_request(PROFILE, &r, now())
        .unwrap();
    assert!(history.duplicate);
    assert_eq!(history.state, "expired");
    unprivileged(&history);
}

#[test]
fn a_recorded_expired_lease_denial_cannot_be_bypassed_with_new_ids_and_clock_rewind() {
    let (_dir, mut store, a) = setup(true);
    let mut r = request(&a);
    assert!(matches!(
        store.record_native_action_request(PROFILE, &r, now() + 600_000),
        Err(Error::Inactive)
    ));
    assert_eq!(count(&store, "approvals"), 0);
    assert_eq!(count(&store, "native_action_clocks"), 1);
    r.request_id = id(32);
    r.idempotency_key = "new-request".into();
    assert!(matches!(
        store.record_native_action_request(PROFILE, &r, now()),
        Err(Error::Inactive)
    ));
    assert_eq!(count(&store, "native_action_requests"), 0);
}

#[test]
fn changed_actual_source_state_expires_the_intent_without_mutating_mission_result() {
    let (_dir, mut store, a) = setup(true);
    let r = request(&a);
    store
        .record_native_action_request(PROFILE, &r, now())
        .unwrap();
    store
        .transition_task(
            PROFILE,
            &TaskTransition {
                mission_id: a.mission_id.clone(),
                task_id: a.task_id.clone(),
                event_id: id(40),
                from: TaskState::Running,
                to: TaskState::Completed,
                supervisor_id: None,
            },
            now() + 1,
        )
        .unwrap();
    let before = store.mission_snapshot(PROFILE, &a.mission_id).unwrap();
    let record = store
        .inspect_native_action_request(PROFILE, &r.request_id, now() + 2)
        .unwrap();
    assert_eq!(record.state, "expired");
    assert_eq!(record.closure_reason.as_deref(), Some("authority-lost"));
    unprivileged(&record);
    assert_eq!(
        store.mission_snapshot(PROFILE, &a.mission_id).unwrap(),
        before
    );
}

#[test]
fn canonical_recovery_expires_pending_intents_with_old_leases_atomically() {
    let (dir, mut store, a) = setup(true);
    let r = request(&a);
    store
        .record_native_action_request(PROFILE, &r, now())
        .unwrap();
    store.close().unwrap();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    store.recover(PROFILE, now() + 1).unwrap();
    let recovered = store.mission_snapshot(PROFILE, &a.mission_id).unwrap();
    assert!(recovered.leases.is_empty());
    assert_eq!(recovered.tasks[0].state, TaskState::Unknown);
    let result = store
        .inspect_native_action_request(PROFILE, &r.request_id, now() + 2)
        .unwrap();
    assert_eq!(result.state, "expired");
    assert_eq!(result.closure_reason.as_deref(), Some("recovery"));
    unprivileged(&result);
    let replay = store
        .record_native_action_request(PROFILE, &r, now() + 3)
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.state, "expired");
    assert_eq!(
        store.mission_snapshot(PROFILE, &a.mission_id).unwrap(),
        recovered
    );
}

#[test]
fn native_intent_cannot_be_promoted_to_granted_or_changed_by_projection_writes() {
    let (_dir, mut store, a) = setup(true);
    let r = request(&a);
    store
        .record_native_action_request(PROFILE, &r, now())
        .unwrap();
    for sql in [
        "UPDATE approvals SET status='granted'",
        "UPDATE approvals SET status='rejected'",
        "UPDATE approvals SET payload='{}'",
        "DELETE FROM approvals",
        "UPDATE native_action_requests SET idempotency_key='other'",
        "DELETE FROM native_action_clocks",
    ] {
        assert!(store.conn.execute_batch(sql).is_err(), "{sql}");
    }
    let record = store
        .inspect_native_action_request(PROFILE, &r.request_id, now())
        .unwrap();
    assert_eq!(record.state, "pending");
    unprivileged(&record);
}

#[test]
fn record_withdrawal_expiry_and_recovery_failures_leave_no_partial_writes() {
    let (_dir, mut store, a) = setup(true);
    let r = request(&a);
    let before = dump(&store);
    store.fail_before_commit.set(true);
    assert!(matches!(
        store.record_native_action_request(PROFILE, &r, now()),
        Err(Error::Storage(_))
    ));
    store.fail_before_commit.set(false);
    assert_eq!(dump(&store), before);
    let original = store
        .record_native_action_request(PROFILE, &r, now())
        .unwrap();
    let before = dump(&store);
    store.fail_before_commit.set(true);
    assert!(matches!(
        store.withdraw_native_action_request(
            PROFILE,
            &r.request_id,
            &original.request_digest,
            1,
            now() + 5
        ),
        Err(Error::Storage(_))
    ));
    assert!(matches!(
        store.inspect_native_action_request(PROFILE, &r.request_id, now() + 60_000),
        Err(Error::Storage(_))
    ));
    assert!(matches!(
        store.recover(PROFILE, now() + 1),
        Err(MissionError::Storage(_))
    ));
    store.fail_before_commit.set(false);
    assert_eq!(dump(&store), before);
}

#[test]
fn sql_failure_after_projection_insert_or_closure_insert_rolls_back_every_write() {
    let (_dir, mut store, a) = setup(true);
    let r = request(&a);
    let before = dump(&store);
    store.conn.execute_batch("CREATE TRIGGER fail_native_request BEFORE INSERT ON native_action_requests BEGIN SELECT RAISE(ABORT,'injected request failure'); END").unwrap();
    assert!(matches!(
        store.record_native_action_request(PROFILE, &r, now()),
        Err(Error::Storage(_))
    ));
    store
        .conn
        .execute_batch("DROP TRIGGER fail_native_request")
        .unwrap();
    assert_eq!(dump(&store), before);
    store
        .record_native_action_request(PROFILE, &r, now())
        .unwrap();
    let before = dump(&store);
    store.conn.execute_batch("CREATE TRIGGER fail_native_close BEFORE UPDATE ON approvals WHEN NEW.status='expired' BEGIN SELECT RAISE(ABORT,'injected closure failure'); END").unwrap();
    assert!(matches!(
        store.inspect_native_action_request(PROFILE, &r.request_id, now() + 60_000),
        Err(Error::Storage(_))
    ));
    store
        .conn
        .execute_batch("DROP TRIGGER fail_native_close")
        .unwrap();
    assert_eq!(dump(&store), before);
}

#[test]
fn request_format_rejects_aliases_bad_targets_unbounded_data_and_other_tools() {
    let (_dir, _store, a) = setup(true);
    let original = request(&a).to_value();
    for target in [
        "../secret",
        "/absolute/path",
        "a//b",
        ".",
        "a/../b",
        "C:\\folder\\file",
    ] {
        let mut v = original.clone();
        v["target"] = json!(target);
        assert!(NativeActionRequest::from_value(&v).is_none(), "{target}");
    }
    for (key, value) in [
        ("tool", json!("run_command")),
        ("attempt", json!(0)),
        ("parametersDigestScheme", json!("sha256")),
        ("policyRef", json!("")),
        ("parametersDigest", json!("not-digest")),
        ("executionId", json!(id(90))),
        ("arguments", json!({"contents":"not-stored"})),
    ] {
        let mut v = original.clone();
        v[key] = value;
        assert!(NativeActionRequest::from_value(&v).is_none(), "{key}");
    }
    let mut v = original;
    v["skillRevisionRefs"] = json!(["same", "same"]);
    assert!(NativeActionRequest::from_value(&v).is_none());
}

#[test]
fn lifetime_is_explicit_and_cannot_outlast_the_current_lease_or_refresh_on_replay() {
    let (_dir, mut store, a) = setup(true);
    let mut r = request(&a);
    r.expires_at = format_utc(now());
    assert!(matches!(
        store.record_native_action_request(PROFILE, &r, now()),
        Err(Error::Inactive)
    ));
    r.expires_at = format_utc(now() + 600_001);
    assert!(matches!(
        store.record_native_action_request(PROFILE, &r, now()),
        Err(Error::Inactive)
    ));
    r.expires_at = format_utc(now() + 60_000);
    let original = store
        .record_native_action_request(PROFILE, &r, now())
        .unwrap();
    let replay = store
        .record_native_action_request(PROFILE, &r, now() + 20_000)
        .unwrap();
    assert_eq!(replay.expires_at, original.expires_at);
    assert_eq!(replay.requested_at, original.requested_at);
}

#[test]
fn request_limit_is_per_real_admission_and_replays_do_not_consume_it() {
    let (_dir, mut store, a) = setup(true);
    for n in 0..128 {
        let mut r = request(&a);
        r.request_id = id(100 + n);
        r.idempotency_key = format!("edit-{n}");
        store
            .record_native_action_request(PROFILE, &r, now())
            .unwrap();
    }
    let mut extra = request(&a);
    extra.request_id = id(300);
    assert!(matches!(
        store.record_native_action_request(PROFILE, &extra, now()),
        Err(Error::Capacity)
    ));
    assert_eq!(count(&store, "native_action_requests"), 128);
    extra.request_id = id(100);
    extra.idempotency_key = "edit-0".into();
    assert!(
        store
            .record_native_action_request(PROFILE, &extra, now())
            .unwrap()
            .duplicate
    );
}

#[test]
fn migration_nine_to_ten_keeps_legacy_approval_and_pool_rows_and_no_backfill() {
    let dir = TempDir::new();
    let mut store = CoreStore::open_with(&dir.store(), &MIGRATIONS[..9]).unwrap();
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../packages/core/test/fixtures/delegation-inspection.json"
    ))
    .unwrap();
    let root = &fixture["parent"];
    let pool_scope = super::DelegationReservationScope {
        profile_id: root["profileId"].as_str().unwrap().into(),
        workspace_id: root["workspaceId"].as_str().unwrap().into(),
        root_mission_id: root["rootMissionId"].as_str().unwrap().into(),
        root_run_id: root["rootRunId"].as_str().unwrap().into(),
    };
    store
        .initialize_delegation_pool(&pool_scope, root, &format_utc(now()))
        .unwrap();
    store
        .reserve_delegation(
            &pool_scope,
            root["delegationId"].as_str().unwrap(),
            &fixture["child"],
            1,
            &format_utc(now() + 120_000),
        )
        .unwrap();
    let pool_before = store.inspect_delegation_pool(&pool_scope).unwrap();
    let mission = json!({"schemaVersion":1,"id":id(2),"workspaceId":id(1),"leadAgentId":id(3),"budgetId":id(6),"state":"draft","createdAt":format_utc(now()),"updatedAt":format_utc(now()),"version":1});
    store.conn.execute("INSERT INTO missions (mission_id,profile_id,workspace_id,state,version,created_at,updated_at,digest,payload) VALUES (?1,?2,?3,'draft',1,?4,?4,?5,?6)",params![id(2),PROFILE,id(1),format_utc(now()),crate::mission::canonical::digest(&mission),crate::mission::canonical::to_string(&mission)]).unwrap();
    store.conn.execute("INSERT INTO approvals (approval_id,profile_id,mission_id,task_id,status,requested_at,expires_at,decided_at,digest,payload) VALUES (?1,?2,?3,NULL,'granted',?4,?4,NULL,?5,?6)",params![id(30),PROFILE,id(2),format_utc(now()),"a".repeat(64),"legacy-approval"]).unwrap();
    store.close().unwrap();
    let mut store = CoreStore::open_with(&dir.store(), &MIGRATIONS[..10]).unwrap();
    assert_eq!(store.schema_version().unwrap(), 10);
    assert_eq!(
        store.inspect_delegation_pool(&pool_scope).unwrap(),
        pool_before
    );
    assert_eq!(count(&store, "native_action_requests"), 0);
    assert_eq!(count(&store, "native_action_clocks"), 0);
    assert_eq!(
        store
            .conn
            .query_row("SELECT payload FROM approvals", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "legacy-approval"
    );
    assert!(matches!(
        store.inspect_native_action_request(PROFILE, &id(30), now()),
        Err(Error::NotFound)
    ));
    store.close().unwrap();
    let backup = std::fs::read_dir(dir.store().parent().unwrap())
        .unwrap()
        .filter_map(|e| e.ok())
        .find(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("core.sqlite.bak-9-")
        })
        .unwrap();
    let copy = Connection::open(backup.path()).unwrap();
    assert_eq!(
        copy.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        9
    );
    assert_eq!(
        copy.query_row("SELECT payload FROM approvals", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "legacy-approval"
    );
    assert!(matches!(
        CoreStore::open_with(&dir.store(), &MIGRATIONS[..9]),
        Err(super::StoreError::NewerSchema {
            found: 10,
            supported: 9
        })
    ));
}

#[test]
fn failed_migration_ten_preserves_nine_and_retries_without_partial_intents() {
    let dir = TempDir::new();
    CoreStore::open_with(&dir.store(), &MIGRATIONS[..9])
        .unwrap()
        .close()
        .unwrap();
    let mut broken = MIGRATIONS[..9].to_vec();
    broken.push(Migration {
        version: 10,
        sql: "CREATE TABLE incomplete_action(x); INSERT INTO missing_action_table VALUES(1);",
    });
    assert!(CoreStore::open_with(&dir.store(), &broken).is_err());
    let conn = Connection::open(dir.store()).unwrap();
    assert_eq!(
        conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        9
    );
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name='incomplete_action'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    drop(conn);
    assert_eq!(
        CoreStore::open_with(&dir.store(), &MIGRATIONS[..10])
            .unwrap()
            .schema_version()
            .unwrap(),
        10
    );
}

#[test]
fn sqlite_replacement_cannot_rewind_a_recorded_lease_denial() {
    let (_dir, mut store, a) = setup(true);
    let r = request(&a);
    assert!(matches!(
        store.record_native_action_request(PROFILE, &r, now() + 600_000),
        Err(Error::Inactive)
    ));
    let before = dump(&store);
    assert!(store.conn.execute("INSERT OR REPLACE INTO native_action_clocks (profile_id,lease_id,observed_ms) VALUES (?1,?2,?3)",params![PROFILE,a.lease_id,now()]).is_err());
    assert_eq!(dump(&store), before);
    let mut other = r.clone();
    other.request_id = id(90);
    other.idempotency_key = "new-intent".into();
    assert!(matches!(
        store.record_native_action_request(PROFILE, &other, now()),
        Err(Error::Inactive)
    ));
    assert_eq!(count(&store, "approvals"), 0);
}

#[test]
fn sqlite_replacement_cannot_rewrite_intents_projections_or_terminal_closures() {
    let (_dir, mut store, a) = setup(true);
    let r = request(&a);
    let saved = store
        .record_native_action_request(PROFILE, &r, now())
        .unwrap();
    let before = dump(&store);
    for table in ["approvals", "native_action_requests"] {
        assert!(
            store
                .conn
                .execute(
                    &format!("INSERT OR REPLACE INTO {table} SELECT * FROM {table}"),
                    []
                )
                .is_err(),
            "{table}"
        );
        assert_eq!(dump(&store), before);
    }
    store
        .withdraw_native_action_request(PROFILE, &r.request_id, &saved.request_digest, 1, now())
        .unwrap();
    let closed = dump(&store);
    assert!(store.conn.execute("INSERT OR REPLACE INTO native_action_closures SELECT * FROM native_action_closures",[]).is_err());
    assert_eq!(dump(&store), closed);
}

#[test]
fn an_existing_legacy_grant_cannot_be_attached_as_a_native_intent() {
    let (_dir, mut store, a) = setup(true);
    store.conn.execute("INSERT INTO approvals (approval_id,profile_id,mission_id,task_id,status,requested_at,expires_at,decided_at,digest,payload) VALUES (?1,?2,?3,?4,'granted',?5,?5,NULL,?6,'legacy')",params![id(90),PROFILE,a.mission_id,a.task_id,format_utc(now()),"a".repeat(64)]).unwrap();
    assert!(store.conn.execute("INSERT INTO native_action_requests (approval_id,profile_id,lease_id,idempotency_key,kind) VALUES (?1,?2,?3,'legacy','intent-only')",params![id(90),PROFILE,a.lease_id]).is_err());
    assert!(matches!(
        store.inspect_native_action_request(PROFILE, &id(90), now()),
        Err(Error::NotFound)
    ));
    assert_eq!(count(&store, "native_action_requests"), 0);
}

#[test]
fn heartbeat_renewal_does_not_refresh_the_captured_request_expiry() {
    let (_dir, mut store, a) = setup(true);
    let r = request(&a);
    store
        .record_native_action_request(PROFILE, &r, now())
        .unwrap();
    store
        .heartbeat_mission(
            PROFILE,
            &crate::mission::MissionHeartbeat {
                mission_id: a.mission_id.clone(),
                leases: vec![crate::mission::LeaseClaim {
                    task_id: a.task_id.clone(),
                    lease_id: a.lease_id.clone(),
                    holder_agent_id: a.holder_agent_id.clone(),
                }],
            },
            now() + 50_000,
        )
        .unwrap();
    let result = store
        .inspect_native_action_request(PROFILE, &r.request_id, now() + 60_000)
        .unwrap();
    assert_eq!(result.state, "expired");
    assert_eq!(result.expires_at, r.expires_at);
    assert_eq!(result.closure_reason.as_deref(), Some("expiry"));
    unprivileged(&result);
}

#[test]
fn corrupt_pending_history_aborts_recovery_and_preserves_execution_state() {
    let (_dir, mut store, a) = setup(true);
    let r = request(&a);
    store
        .record_native_action_request(PROFILE, &r, now())
        .unwrap();
    let definition: String = store
        .conn
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE name='native_action_approval_guard'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    store
        .conn
        .execute_batch(
            "DROP TRIGGER native_action_approval_guard; UPDATE approvals SET payload='{}'",
        )
        .unwrap();
    store.conn.execute_batch(&definition).unwrap();
    let before = dump(&store);
    assert!(matches!(
        store.inspect_native_action_request(PROFILE, &r.request_id, now()),
        Err(Error::Corrupt)
    ));
    assert!(matches!(
        store.recover(PROFILE, now() + 1),
        Err(MissionError::Corrupt(_))
    ));
    assert_eq!(dump(&store), before);
}

#[test]
fn concurrent_withdrawal_and_expiry_preserve_a_single_irreversible_closure() {
    use std::sync::{Arc, Barrier, Mutex};
    let (_dir, mut store, a) = setup(true);
    let r = request(&a);
    let captured = store
        .record_native_action_request(PROFILE, &r, now())
        .unwrap();
    let store = Arc::new(Mutex::new(store));
    let barrier = Arc::new(Barrier::new(2));
    let left = {
        let store = Arc::clone(&store);
        let barrier = Arc::clone(&barrier);
        let request_id = r.request_id.clone();
        let digest = captured.request_digest.clone();
        std::thread::spawn(move || {
            barrier.wait();
            store
                .lock()
                .unwrap()
                .withdraw_native_action_request(PROFILE, &request_id, &digest, 1, now() + 1)
                .unwrap()
        })
    };
    let right = {
        let store = Arc::clone(&store);
        let barrier = Arc::clone(&barrier);
        let request_id = r.request_id.clone();
        std::thread::spawn(move || {
            barrier.wait();
            store
                .lock()
                .unwrap()
                .inspect_native_action_request(PROFILE, &request_id, now() + 60_000)
                .unwrap()
        })
    };
    let a = left.join().unwrap();
    let b = right.join().unwrap();
    unprivileged(&a);
    unprivileged(&b);
    assert_eq!(a.state, b.state);
    assert_eq!(a.closed_at, b.closed_at);
    assert_eq!(count(&store.lock().unwrap(), "native_action_closures"), 1);
}
