//! Durable preparation lifetime tests: temporary profiles only, never host configurations.
use super::{CoreStore, tests::TempDir};
use crate::mission::MissionError;
use crate::preparation::{MAX_PREPARATION_HISTORY, PreparationBegin, PreparationObservation};
use crate::time::parse_utc;
use rusqlite::params;
use serde_json::json;

fn uuid(n: usize) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}
fn now() -> i64 {
    parse_utc("2026-10-30T12:00:00.000Z").unwrap()
}
fn begin(n: usize) -> PreparationBegin {
    PreparationBegin {
        invocation_id: uuid(n),
        mission_id: uuid(8000 + n),
        supervisor_id: uuid(9000),
        canonical_workspace_id: uuid(10000),
        session_id: format!("s_{n}"),
        workspace_id: "w_example".into(),
        connection_ids: vec![format!("c_{n}")],
    }
}
fn observation(admission: &crate::preparation::PreparationAdmission) -> PreparationObservation {
    PreparationObservation {
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
        "preparation_admissions",
        "preparation_observations",
        "preparation_resource_claims",
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
fn preparation_receipts_are_profile_scoped_idempotent_and_weak() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let params = begin(1);
    let admission = store.begin_preparation("default", &params, now()).unwrap();
    let before = dump(&store);
    assert_eq!(
        store
            .begin_preparation("default", &params, now() + 100)
            .unwrap(),
        admission
    );
    assert_eq!(dump(&store), before);
    assert!(
        store
            .inspect_preparation("default", &params.invocation_id)
            .unwrap()
            .observation
            .is_none()
    );
    assert!(matches!(
        store.inspect_preparation("other", &params.invocation_id),
        Err(MissionError::NotFound)
    ));
    let other = store.begin_preparation("other", &params, now()).unwrap();
    assert_ne!(admission.admission_digest, other.admission_digest);
    let mut changed = params.clone();
    changed.supervisor_id = uuid(9001);
    assert!(matches!(
        store.begin_preparation("default", &changed, now()),
        Err(MissionError::Conflict(_))
    ));
    let record = store
        .observe_preparation("default", &observation(&admission), now() + 200)
        .unwrap();
    let before = dump(&store);
    assert_eq!(
        store
            .observe_preparation("default", &observation(&admission), now() + 300)
            .unwrap(),
        record
    );
    assert_eq!(
        store
            .begin_preparation("default", &params, now() + 400)
            .unwrap(),
        admission
    );
    assert_eq!(dump(&store), before);
    assert_eq!(record.to_value()["kind"], "local-preparation-settled");
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
fn preparation_pending_blocks_session_or_any_connection_across_workspaces_until_observed() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let mut first = begin(1);
    first.connection_ids = vec!["c_alpha".into(), "c_beta".into()];
    let admission = store.begin_preparation("default", &first, now()).unwrap();
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
            store.begin_preparation("default", &next, now() + 1),
            Err(MissionError::Conflict(_))
        ));
        assert_eq!(dump(&store), before);
    }
    let mut wrong = observation(&admission);
    wrong.admission_digest = "0".repeat(64);
    let before = dump(&store);
    assert!(matches!(
        store.observe_preparation("default", &wrong, now() + 1),
        Err(MissionError::Conflict(_))
    ));
    assert_eq!(dump(&store), before);
    store
        .observe_preparation("default", &observation(&admission), now() + 2)
        .unwrap();
    let mut next = begin(2);
    next.session_id = first.session_id;
    next.connection_ids = first.connection_ids;
    store
        .begin_preparation("default", &next, now() + 3)
        .unwrap();
}

#[test]
fn preparation_admission_and_observation_failure_roll_back_claims_atomically() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let params = begin(1);
    let before = dump(&store);
    store.fail_before_commit.set(true);
    assert!(store.begin_preparation("default", &params, now()).is_err());
    assert_eq!(dump(&store), before);
    store.fail_before_commit.set(false);
    let admission = store.begin_preparation("default", &params, now()).unwrap();
    let before = dump(&store);
    store.fail_before_commit.set(true);
    assert!(
        store
            .observe_preparation("default", &observation(&admission), now() + 1)
            .is_err()
    );
    assert_eq!(dump(&store), before);
    store.fail_before_commit.set(false);
    let mut next = begin(2);
    next.connection_ids = params.connection_ids;
    assert!(matches!(
        store.begin_preparation("default", &next, now() + 2),
        Err(MissionError::Conflict(_))
    ));
    assert!(
        store
            .inspect_preparation("default", &params.invocation_id)
            .unwrap()
            .observation
            .is_none()
    );
}

#[test]
fn preparation_pending_survives_restart_recovery_and_reaping_without_expiry() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let params = begin(1);
    let admission = store.begin_preparation("default", &params, now()).unwrap();
    store.close().unwrap();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let future = now() + 100 * 365 * 24 * 60 * 60 * 1000;
    store.recover("default", future).unwrap();
    store.reap_expired_leases("default", future).unwrap();
    let inspection = store
        .inspect_preparation("default", &params.invocation_id)
        .unwrap();
    assert_eq!(inspection.admission, admission);
    assert!(inspection.observation.is_none());
    let mut next = begin(2);
    next.session_id = params.session_id;
    assert!(matches!(
        store.begin_preparation("default", &next, future),
        Err(MissionError::Conflict(_))
    ));
}

#[test]
fn preparation_direct_contract_bounds_reject_unsafe_scope_and_unsorted_connections() {
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
        assert!(store.begin_preparation("default", &params, now()).is_err());
        assert_eq!(dump(&store), before);
    }
    let mut value = begin(1).to_value();
    value["prompt"] = "private payload".into();
    assert!(PreparationBegin::from_value(&value).is_err());
}

#[test]
fn preparation_sql_is_immutable_without_rowid_replacement_aliases() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let admission = store
        .begin_preparation("default", &begin(1), now())
        .unwrap();
    store
        .observe_preparation("default", &observation(&admission), now() + 1)
        .unwrap();
    for recursive in [false, true] {
        store
            .conn
            .pragma_update(None, "recursive_triggers", recursive)
            .unwrap();
        for table in [
            "preparation_admissions",
            "preparation_observations",
            "preparation_resource_claims",
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
fn preparation_corrupt_receipt_or_missing_claim_fails_closed_without_writes() {
    for case in 0..4 {
        let dir = TempDir::new();
        let mut store = CoreStore::open(&dir.store()).unwrap();
        let params = begin(1);
        let admission = store.begin_preparation("default", &params, now()).unwrap();
        match case {
            0 => {
                store.conn.execute_batch("DROP TRIGGER preparation_admissions_no_update; UPDATE preparation_admissions SET admission_digest=printf('%064d',0);").unwrap();
            }
            1 => {
                store.conn.execute_batch("DROP TRIGGER preparation_resource_claims_no_delete; DELETE FROM preparation_resource_claims WHERE resource_kind='connection';").unwrap();
            }
            2 => {
                store
                    .observe_preparation("default", &observation(&admission), now() + 1)
                    .unwrap();
                store.conn.execute_batch("DROP TRIGGER preparation_observations_no_update; UPDATE preparation_observations SET digest=printf('%064d',0);").unwrap();
            }
            _ => {
                let mut value = admission.to_value();
                value["workspaceId"] = "w_other".into();
                store
                    .conn
                    .execute_batch("DROP TRIGGER preparation_admissions_no_update;")
                    .unwrap();
                store
                    .conn
                    .execute(
                        "UPDATE preparation_admissions SET payload=?1",
                        [crate::mission::canonical::to_string(&value)],
                    )
                    .unwrap();
            }
        }
        let before = dump(&store);
        assert!(
            store
                .inspect_preparation("default", &params.invocation_id)
                .is_err()
        );
        assert!(
            store
                .observe_preparation("default", &observation(&admission), now() + 2)
                .is_err()
        );
        let mut next = begin(2);
        next.connection_ids = params.connection_ids;
        assert!(
            store
                .begin_preparation("default", &next, now() + 2)
                .is_err()
        );
        assert_eq!(dump(&store), before);
    }
}

#[test]
fn preparation_history_capacity_counts_settled_records_and_exact_retries_remain_available() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let first = store
        .begin_preparation("default", &begin(1), now())
        .unwrap();
    store
        .observe_preparation("default", &observation(&first), now())
        .unwrap();
    for n in 2..=MAX_PREPARATION_HISTORY {
        store
            .begin_preparation("default", &begin(n), now())
            .unwrap();
    }
    let before = dump(&store);
    assert!(matches!(
        store.begin_preparation("default", &begin(MAX_PREPARATION_HISTORY + 1), now()),
        Err(MissionError::Capacity(_))
    ));
    assert_eq!(
        store
            .begin_preparation("default", &begin(1), now())
            .unwrap(),
        first
    );
    assert_eq!(dump(&store), before);
    store
        .begin_preparation("other", &begin(MAX_PREPARATION_HISTORY + 1), now())
        .unwrap();
}

#[test]
fn preparation_sql_refuses_pending_overlap_and_foreign_observation_digest() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let first = store
        .begin_preparation("default", &begin(1), now())
        .unwrap();
    let second = store
        .begin_preparation("default", &begin(2), now())
        .unwrap();
    let before = dump(&store);
    assert!(store.conn.execute("INSERT INTO preparation_resource_claims (profile_id,invocation_id,resource_kind,resource_id) VALUES ('default',?1,'connection',?2)",params![second.begin.invocation_id,first.begin.connection_ids[0]]).is_err());
    let record = json!({"invocationId":first.begin.invocation_id,"admissionDigest":second.admission_digest,"kind":"local-preparation-settled","recordedAt":"2026-10-30T12:00:00.000Z"});
    assert!(store.conn.execute("INSERT INTO preparation_observations (profile_id,invocation_id,admission_digest,kind,recorded_at,digest,payload) VALUES ('default',?1,?2,'local-preparation-settled','2026-10-30T12:00:00.000Z',?3,?4)",params![first.begin.invocation_id,second.admission_digest,"0".repeat(64),record.to_string()]).is_err());
    assert_eq!(dump(&store), before);
}

#[test]
fn preparation_identity_is_exact_for_all_bound_fields_and_daemon_time_is_monotone() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let params = begin(1);
    let admission = store.begin_preparation("default", &params, now()).unwrap();
    for field in [
        "missionId",
        "supervisorId",
        "canonicalWorkspaceId",
        "sessionId",
        "workspaceId",
        "connectionIds",
    ] {
        let mut changed = params.to_value();
        changed[field] = match field {
            "connectionIds" => json!(["c_other"]),
            "sessionId" | "workspaceId" => json!("other"),
            _ => json!(uuid(99999)),
        };
        let before = dump(&store);
        assert!(matches!(
            store.begin_preparation(
                "default",
                &PreparationBegin::from_value(&changed).unwrap(),
                now()
            ),
            Err(MissionError::Conflict(_))
        ));
        assert_eq!(before, dump(&store));
    }
    let before = dump(&store);
    assert!(matches!(
        store.observe_preparation("default", &observation(&admission), now() - 1),
        Err(MissionError::Invalid(_))
    ));
    assert_eq!(before, dump(&store));
    assert_eq!(admission.admitted_at, crate::time::format_utc(now()));
    let record = store
        .observe_preparation("default", &observation(&admission), now())
        .unwrap();
    assert_eq!(record.recorded_at, admission.admitted_at);
    // Exact retries retain the original time, even if the supplied clock moves backward.
    assert_eq!(
        store
            .observe_preparation("default", &observation(&admission), now() - 1)
            .unwrap(),
        record
    );
    for field in ["missionId", "canonicalWorkspaceId"] {
        let mut value = params.to_value();
        value[field] = json!("invalid");
        assert!(PreparationBegin::from_value(&value).is_err());
    }
}

fn planning(n: usize) -> crate::planning::PlanningBegin {
    crate::planning::PlanningBegin {
        invocation_id: uuid(20000 + n),
        supervisor_id: uuid(9000),
        session_id: format!("planning_{n}"),
        workspace_id: "w_planning".into(),
        connection_ids: vec![format!("planning_c_{n}")],
    }
}

#[test]
fn preparation_and_planning_exclude_pending_session_or_connection_in_both_directions() {
    for preparation_first in [false, true] {
        for session_overlap in [false, true] {
            let dir = TempDir::new();
            let mut store = CoreStore::open(&dir.store()).unwrap();
            let prep = begin(1);
            let mut plan = planning(1);
            if session_overlap {
                plan.session_id = prep.session_id.clone();
            } else {
                plan.connection_ids = prep.connection_ids.clone();
            }
            if preparation_first {
                let admission = store.begin_preparation("default", &prep, now()).unwrap();
                let before = dump(&store);
                assert!(matches!(
                    store.begin_planning("default", &plan, now()),
                    Err(MissionError::Conflict(_))
                ));
                assert_eq!(before, dump(&store));
                store.begin_planning("other", &plan, now()).unwrap();
                store
                    .observe_preparation("default", &observation(&admission), now())
                    .unwrap();
                store.begin_planning("default", &plan, now()).unwrap();
            } else {
                let admission = store.begin_planning("default", &plan, now()).unwrap();
                let before = dump(&store);
                assert!(matches!(
                    store.begin_preparation("default", &prep, now()),
                    Err(MissionError::Conflict(_))
                ));
                assert_eq!(before, dump(&store));
                store.begin_preparation("other", &prep, now()).unwrap();
                store
                    .observe_planning(
                        "default",
                        &crate::planning::PlanningObservation {
                            invocation_id: plan.invocation_id,
                            admission_digest: admission.admission_digest,
                        },
                        now(),
                    )
                    .unwrap();
                store.begin_preparation("default", &prep, now()).unwrap();
            }
        }
    }
}

#[test]
fn preparation_cross_kind_corrupt_missing_claims_fail_closed_in_both_directions() {
    for preparation_first in [false, true] {
        let dir = TempDir::new();
        let mut store = CoreStore::open(&dir.store()).unwrap();
        let prep = begin(1);
        let mut plan = planning(1);
        plan.connection_ids = prep.connection_ids.clone();
        if preparation_first {
            store.begin_preparation("default", &prep, now()).unwrap();
            store.conn.execute_batch("DROP TRIGGER preparation_resource_claims_no_delete; DELETE FROM preparation_resource_claims WHERE resource_kind='connection'").unwrap();
            let before = dump(&store);
            assert!(matches!(
                store.begin_planning("default", &plan, now()),
                Err(MissionError::Corrupt(_))
            ));
            assert_eq!(before, dump(&store));
        } else {
            store.begin_planning("default", &plan, now()).unwrap();
            store.conn.execute_batch("DROP TRIGGER planning_resource_claims_no_delete; DELETE FROM planning_resource_claims WHERE resource_kind='connection'").unwrap();
            let before = dump(&store);
            assert!(matches!(
                store.begin_preparation("default", &prep, now()),
                Err(MissionError::Corrupt(_))
            ));
            assert_eq!(before, dump(&store));
        }
    }
}

#[test]
fn preparation_cross_kind_sql_guards_protect_both_claim_directions() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let prep = store
        .begin_preparation("default", &begin(1), now())
        .unwrap();
    let plan = store
        .begin_planning("default", &planning(1), now())
        .unwrap();
    let before = dump(&store);
    for (table, invocation, connection) in [
        (
            "planning_resource_claims",
            &plan.begin.invocation_id,
            &prep.begin.connection_ids[0],
        ),
        (
            "preparation_resource_claims",
            &prep.begin.invocation_id,
            &plan.begin.connection_ids[0],
        ),
    ] {
        assert!(store.conn.execute(&format!("INSERT INTO {table} (profile_id,invocation_id,resource_kind,resource_id) VALUES ('default',?1,'connection',?2)"), params![invocation, connection]).is_err());
        assert_eq!(before, dump(&store));
    }
}

#[test]
fn preparation_invalid_profiles_clocks_and_oversized_values_write_nothing() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let params = begin(1);
    let before = dump(&store);
    for profile in ["".to_owned(), "p".repeat(201)] {
        assert!(matches!(
            store.begin_preparation(&profile, &params, now()),
            Err(MissionError::Invalid(_))
        ));
        assert!(
            store
                .inspect_preparation(&profile, &params.invocation_id)
                .is_err()
        );
    }
    for time in [i64::MIN, i64::MAX] {
        assert!(matches!(
            store.begin_preparation("default", &params, time),
            Err(MissionError::Invalid(_))
        ));
    }
    assert_eq!(before, dump(&store));
    let mut value = params.to_value();
    value["sessionId"] = json!("x".repeat(32769));
    assert!(matches!(
        PreparationBegin::from_value(&value),
        Err(MissionError::Capacity(_))
    ));
    let admission = store.begin_preparation("default", &params, now()).unwrap();
    let before = dump(&store);
    assert!(store.conn.execute("INSERT INTO preparation_admissions (profile_id,invocation_id,mission_id,supervisor_id,canonical_workspace_id,session_id,workspace_id,admitted_at,admission_digest,payload) VALUES ('default',?1,?2,?3,?4,'s_other','w_other',?5,?6,?7)", params![uuid(2),uuid(3),uuid(4),uuid(5),admission.admitted_at,admission.admission_digest,"x".repeat(32769)]).is_err());
    assert_eq!(before, dump(&store));
}

#[test]
fn preparation_migration_13_preserves_existing_planning_receipts() {
    let dir = TempDir::new();
    let store = CoreStore::open_with(&dir.store(), &super::migrate::MIGRATIONS[..12]).unwrap();
    let begin = planning(1);
    let mut admission = crate::planning::PlanningAdmission {
        begin: begin.clone(),
        admitted_at: crate::time::format_utc(now()),
        admission_digest: String::new(),
    };
    admission.admission_digest = admission.captured_digest("default");
    store.conn.execute("INSERT INTO planning_admissions (profile_id,invocation_id,supervisor_id,session_id,workspace_id,admitted_at,admission_digest,payload) VALUES ('default',?1,?2,?3,?4,?5,?6,?7)", params![begin.invocation_id,begin.supervisor_id,begin.session_id,begin.workspace_id,admission.admitted_at,admission.admission_digest,crate::mission::canonical::to_string(&admission.to_value())]).unwrap();
    for (kind, id) in [
        ("session", &begin.session_id),
        ("connection", &begin.connection_ids[0]),
    ] {
        store
            .conn
            .execute(
                "INSERT INTO planning_resource_claims VALUES ('default',?1,?2,?3)",
                params![begin.invocation_id, kind, id],
            )
            .unwrap();
    }
    store.close().unwrap();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    assert_eq!(store.schema_version().unwrap(), CoreStore::LATEST);
    assert_eq!(
        store
            .inspect_planning("default", &begin.invocation_id)
            .unwrap()
            .admission,
        admission
    );
    let mut prep = crate::adapters::sqlite::preparation_tests::begin(1);
    prep.connection_ids = begin.connection_ids;
    assert!(matches!(
        store.begin_preparation("default", &prep, now()),
        Err(MissionError::Conflict(_))
    ));
}
