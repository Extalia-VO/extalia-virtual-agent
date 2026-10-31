//! Durable planning lifetime tests: temporary profiles only, never host configurations.
use super::{CoreStore, tests::TempDir};
use crate::mission::MissionError;
use crate::planning::{MAX_PLANNING_HISTORY, PlanningBegin, PlanningObservation};
use crate::time::parse_utc;
use rusqlite::params;
use serde_json::json;

fn uuid(n: usize) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}
fn now() -> i64 {
    parse_utc("2026-10-30T12:00:00.000Z").unwrap()
}
fn begin(n: usize) -> PlanningBegin {
    PlanningBegin {
        invocation_id: uuid(n),
        supervisor_id: uuid(9000),
        session_id: format!("s_{n}"),
        workspace_id: "w_example".into(),
        connection_ids: vec![format!("c_{n}")],
    }
}
fn observation(admission: &crate::planning::PlanningAdmission) -> PlanningObservation {
    PlanningObservation {
        invocation_id: admission.begin.invocation_id.clone(),
        admission_digest: admission.admission_digest.clone(),
    }
}
fn dump(store: &CoreStore) -> Vec<String> {
    let mut result = Vec::new();
    for table in [
        "planning_admissions",
        "planning_observations",
        "planning_resource_claims",
        "missions",
        "tasks",
        "leases",
        "events",
        "execution_admissions",
    ] {
        let mut statement = store
            .conn
            .prepare(&format!("SELECT * FROM {table} ORDER BY 1,2"))
            .unwrap();
        let columns = statement.column_count();
        let mut rows = statement.query([]).unwrap();
        while let Some(row) = rows.next().unwrap() {
            result.push(format!(
                "{table}:{:?}",
                (0..columns)
                    .map(|i| row.get::<_, rusqlite::types::Value>(i).unwrap())
                    .collect::<Vec<_>>()
            ));
        }
    }
    result
}

#[test]
fn planning_receipts_are_profile_scoped_idempotent_and_weak() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let params = begin(1);
    let admission = store.begin_planning("default", &params, now()).unwrap();
    let before = dump(&store);
    assert_eq!(
        store
            .begin_planning("default", &params, now() + 100)
            .unwrap(),
        admission
    );
    assert_eq!(dump(&store), before);
    assert!(
        store
            .inspect_planning("default", &params.invocation_id)
            .unwrap()
            .observation
            .is_none()
    );
    assert!(matches!(
        store.inspect_planning("other", &params.invocation_id),
        Err(MissionError::NotFound)
    ));
    let other = store.begin_planning("other", &params, now()).unwrap();
    assert_ne!(admission.admission_digest, other.admission_digest);
    let mut changed = params.clone();
    changed.supervisor_id = uuid(9001);
    assert!(matches!(
        store.begin_planning("default", &changed, now()),
        Err(MissionError::Conflict(_))
    ));
    let record = store
        .observe_planning("default", &observation(&admission), now() + 200)
        .unwrap();
    let before = dump(&store);
    assert_eq!(
        store
            .observe_planning("default", &observation(&admission), now() + 300)
            .unwrap(),
        record
    );
    assert_eq!(
        store
            .begin_planning("default", &params, now() + 400)
            .unwrap(),
        admission
    );
    assert_eq!(dump(&store), before);
    assert_eq!(record.to_value()["kind"], "local-pipeline-settled");
    assert!(
        !record
            .to_value()
            .as_object()
            .unwrap()
            .contains_key("physicalSettlement")
    );
    for table in ["missions", "tasks", "leases", "execution_admissions"] {
        assert_eq!(
            store
                .conn
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}

#[test]
fn planning_pending_blocks_session_or_any_connection_across_workspaces_until_observed() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let mut first = begin(1);
    first.connection_ids = vec!["c_alpha".into(), "c_beta".into()];
    let admission = store.begin_planning("default", &first, now()).unwrap();
    for session_overlap in [true, false] {
        let mut next = begin(2);
        next.workspace_id = "w_other".into();
        if session_overlap {
            next.session_id = first.session_id.clone();
        } else {
            next.connection_ids = vec!["c_beta".into(), "c_other".into()];
        }
        let before = dump(&store);
        assert!(matches!(
            store.begin_planning("default", &next, now() + 1),
            Err(MissionError::Conflict(_))
        ));
        assert_eq!(dump(&store), before);
    }
    let mut wrong = observation(&admission);
    wrong.admission_digest = "0".repeat(64);
    let before = dump(&store);
    assert!(matches!(
        store.observe_planning("default", &wrong, now() + 1),
        Err(MissionError::Conflict(_))
    ));
    assert_eq!(dump(&store), before);
    store
        .observe_planning("default", &observation(&admission), now() + 2)
        .unwrap();
    let mut next = begin(2);
    next.session_id = first.session_id;
    next.connection_ids = first.connection_ids;
    store.begin_planning("default", &next, now() + 3).unwrap();
}

#[test]
fn planning_admission_and_observation_failure_roll_back_claims_atomically() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let params = begin(1);
    let before = dump(&store);
    store.fail_before_commit.set(true);
    assert!(store.begin_planning("default", &params, now()).is_err());
    assert_eq!(dump(&store), before);
    store.fail_before_commit.set(false);
    let admission = store.begin_planning("default", &params, now()).unwrap();
    let before = dump(&store);
    store.fail_before_commit.set(true);
    assert!(
        store
            .observe_planning("default", &observation(&admission), now() + 1)
            .is_err()
    );
    assert_eq!(dump(&store), before);
    store.fail_before_commit.set(false);
    let mut next = begin(2);
    next.connection_ids = params.connection_ids;
    assert!(matches!(
        store.begin_planning("default", &next, now() + 2),
        Err(MissionError::Conflict(_))
    ));
    assert!(
        store
            .inspect_planning("default", &params.invocation_id)
            .unwrap()
            .observation
            .is_none()
    );
}

#[test]
fn planning_pending_survives_restart_recovery_and_reaping_without_expiry() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let params = begin(1);
    let admission = store.begin_planning("default", &params, now()).unwrap();
    store.close().unwrap();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let future = now() + 100 * 365 * 24 * 60 * 60 * 1000;
    store.recover("default", future).unwrap();
    store.reap_expired_leases("default", future).unwrap();
    let inspection = store
        .inspect_planning("default", &params.invocation_id)
        .unwrap();
    assert_eq!(inspection.admission, admission);
    assert!(inspection.observation.is_none());
    let mut next = begin(2);
    next.session_id = params.session_id;
    assert!(matches!(
        store.begin_planning("default", &next, future),
        Err(MissionError::Conflict(_))
    ));
}

#[test]
fn planning_direct_contract_bounds_reject_unsafe_scope_and_unsorted_connections() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let before = dump(&store);
    for n in 0..8 {
        let mut params = begin(1);
        match n {
            0 => params.session_id = "/projects/example".into(),
            1 => params.workspace_id = "https://example.com".into(),
            2 => params.connection_ids.clear(),
            3 => params.connection_ids = vec!["c_b".into(), "c_a".into()],
            4 => params.connection_ids = vec!["c_a".into(), "c_a".into()],
            5 => params.connection_ids = (0..17).map(|i| format!("c_{i:02}")).collect(),
            6 => params.supervisor_id = "invalid".into(),
            _ => params.session_id = "x".repeat(32769),
        };
        assert!(store.begin_planning("default", &params, now()).is_err());
        assert_eq!(dump(&store), before);
    }
    let mut value = begin(1).to_value();
    value["prompt"] = "private payload".into();
    assert!(PlanningBegin::from_value(&value).is_err());
}

#[test]
fn planning_sql_is_immutable_without_rowid_replacement_aliases() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let admission = store.begin_planning("default", &begin(1), now()).unwrap();
    store
        .observe_planning("default", &observation(&admission), now() + 1)
        .unwrap();
    for recursive in [false, true] {
        store
            .conn
            .pragma_update(None, "recursive_triggers", recursive)
            .unwrap();
        for table in [
            "planning_admissions",
            "planning_observations",
            "planning_resource_claims",
        ] {
            let before = dump(&store);
            for sql in [
                format!("UPDATE {table} SET invocation_id=invocation_id"),
                format!("DELETE FROM {table}"),
                format!("INSERT OR REPLACE INTO {table} SELECT * FROM {table}"),
                format!("REPLACE INTO {table} SELECT * FROM {table}"),
            ] {
                assert!(store.conn.execute_batch(&sql).is_err(), "{sql}");
                assert_eq!(dump(&store), before);
            }
            for alias in ["rowid", "_rowid_", "oid"] {
                assert!(
                    store
                        .conn
                        .prepare(&format!("SELECT {alias} FROM {table}"))
                        .is_err()
                );
            }
        }
    }
}

#[test]
fn planning_corrupt_receipt_or_missing_claim_fails_closed_without_writes() {
    for case in 0..4 {
        let dir = TempDir::new();
        let mut store = CoreStore::open(&dir.store()).unwrap();
        let params = begin(1);
        let admission = store.begin_planning("default", &params, now()).unwrap();
        match case {
            0 => {
                store.conn.execute_batch("DROP TRIGGER planning_admissions_no_update; UPDATE planning_admissions SET admission_digest=printf('%064d',0);").unwrap();
            }
            1 => {
                store.conn.execute_batch("DROP TRIGGER planning_resource_claims_no_delete; DELETE FROM planning_resource_claims WHERE resource_kind='connection';").unwrap();
            }
            2 => {
                store
                    .observe_planning("default", &observation(&admission), now() + 1)
                    .unwrap();
                store.conn.execute_batch("DROP TRIGGER planning_observations_no_update; UPDATE planning_observations SET digest=printf('%064d',0);").unwrap();
            }
            _ => {
                let mut value = admission.to_value();
                value["workspaceId"] = "w_other".into();
                store
                    .conn
                    .execute_batch("DROP TRIGGER planning_admissions_no_update;")
                    .unwrap();
                store
                    .conn
                    .execute(
                        "UPDATE planning_admissions SET payload=?1",
                        [crate::mission::canonical::to_string(&value)],
                    )
                    .unwrap();
            }
        }
        let before = dump(&store);
        assert!(
            store
                .inspect_planning("default", &params.invocation_id)
                .is_err()
        );
        assert!(
            store
                .observe_planning("default", &observation(&admission), now() + 2)
                .is_err()
        );
        let mut next = begin(2);
        next.connection_ids = params.connection_ids;
        assert!(store.begin_planning("default", &next, now() + 2).is_err());
        assert_eq!(dump(&store), before);
    }
}

#[test]
fn planning_history_capacity_counts_settled_records_and_exact_retries_remain_available() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let first = store.begin_planning("default", &begin(1), now()).unwrap();
    store
        .observe_planning("default", &observation(&first), now())
        .unwrap();
    for n in 2..=MAX_PLANNING_HISTORY {
        store.begin_planning("default", &begin(n), now()).unwrap();
    }
    let before = dump(&store);
    assert!(matches!(
        store.begin_planning("default", &begin(MAX_PLANNING_HISTORY + 1), now()),
        Err(MissionError::Capacity(_))
    ));
    assert_eq!(
        store.begin_planning("default", &begin(1), now()).unwrap(),
        first
    );
    assert_eq!(dump(&store), before);
    store
        .begin_planning("other", &begin(MAX_PLANNING_HISTORY + 1), now())
        .unwrap();
}

#[test]
fn planning_sql_refuses_pending_overlap_and_foreign_observation_digest() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let first = store.begin_planning("default", &begin(1), now()).unwrap();
    let second = store.begin_planning("default", &begin(2), now()).unwrap();
    let before = dump(&store);
    assert!(store.conn.execute("INSERT INTO planning_resource_claims (profile_id,invocation_id,resource_kind,resource_id) VALUES ('default',?1,'connection',?2)",params![second.begin.invocation_id,first.begin.connection_ids[0]]).is_err());
    let record = json!({"invocationId":first.begin.invocation_id,"admissionDigest":second.admission_digest,"kind":"local-pipeline-settled","recordedAt":"2026-10-30T12:00:00.000Z"});
    assert!(store.conn.execute("INSERT INTO planning_observations (profile_id,invocation_id,admission_digest,kind,recorded_at,digest,payload) VALUES ('default',?1,?2,'local-pipeline-settled','2026-10-30T12:00:00.000Z',?3,?4)",params![first.begin.invocation_id,second.admission_digest,"0".repeat(64),record.to_string()]).is_err());
    assert_eq!(dump(&store), before);
}
