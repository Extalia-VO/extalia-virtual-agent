//! Temporary stores only. No host, provider, real profile or external configuration.
use super::migrate::{MIGRATIONS, Migration};
use super::tests::TempDir;
use super::{
    CoreStore, DelegationLedgerError as Error, DelegationPoolSnapshot,
    DelegationReservationScope as Scope, StoreError,
};
use crate::mission::canonical;
use rusqlite::{Connection, params};
use serde_json::{Value, json};

const NOW: &str = "2026-01-01T00:10:00Z";
fn uuid(value: u64) -> String {
    format!("{value:08x}-1111-4111-8111-111111111111")
}
fn scope() -> Scope {
    Scope {
        profile_id: uuid(2),
        workspace_id: uuid(3),
        root_mission_id: uuid(4),
        root_run_id: uuid(5),
    }
}
fn fixtures() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../packages/core/test/fixtures/delegation-inspection.json"
    ))
    .unwrap()
}
fn seed() -> Value {
    fixtures()["parent"].clone()
}
fn child() -> Value {
    let mut value = fixtures()["child"].clone();
    value["childRemaining"] = json!(2);
    for key in [
        "maxWallClockMs",
        "maxTokens",
        "maxToolCalls",
        "maxEstimatedCostMicrousd",
    ] {
        value["budget"][key] = json!(10);
    }
    value
}
fn sibling(value: &Value, n: u64) -> Value {
    let mut v = value.clone();
    v["delegationId"] = json!(uuid(n));
    v["taskId"] = json!(uuid(n + 1));
    v["idempotencyKey"] = json!(format!("intent-{n}"));
    v
}
fn grandchild(parent: &Value) -> Value {
    let mut value = sibling(parent, 90);
    value["sourceEngineId"] = parent["targetEngineId"].clone();
    value["parentTaskId"] = parent["taskId"].clone();
    value["lineage"]
        .as_array_mut()
        .unwrap()
        .push(json!({"engineId":parent["targetEngineId"],"taskId":parent["taskId"]}));
    value["executionId"] = json!(uuid(93));
    value["authorityRef"] = json!("grant-c");
    value["hopRemaining"] = json!(1);
    value["childRemaining"] = json!(0);
    for key in [
        "maxWallClockMs",
        "maxTokens",
        "maxToolCalls",
        "maxEstimatedCostMicrousd",
    ] {
        value["budget"][key] = json!(5);
    }
    value
}
fn initialized() -> (TempDir, CoreStore) {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    let ack = store
        .initialize_delegation_pool(&scope(), &seed(), NOW)
        .unwrap();
    assert!(!ack.dispatch_eligible && !ack.authority_verified);
    (dir, store)
}
fn snapshot(store: &mut CoreStore) -> DelegationPoolSnapshot {
    let value = store.inspect_delegation_pool(&scope()).unwrap();
    assert!(!value.dispatch_eligible && !value.authority_verified);
    value
}

#[test]
fn initialization_is_explicit_scoped_immutable_and_does_not_mint_authority() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    assert!(matches!(
        store.reserve_delegation(&scope(), &uuid(1), &child(), 1, NOW),
        Err(Error::NotFound)
    ));
    let original = store
        .initialize_delegation_pool(&scope(), &seed(), NOW)
        .unwrap();
    assert_eq!(original.pool_version, 1);
    assert!(!original.duplicate);
    let replay = store
        .initialize_delegation_pool(&scope(), &seed(), NOW)
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.recorded_at, original.recorded_at);
    let before = snapshot(&mut store);
    let mut changed = seed();
    changed["engineGeneration"] = json!(2);
    assert!(matches!(
        store.initialize_delegation_pool(&scope(), &changed, NOW),
        Err(Error::Conflict)
    ));
    assert_eq!(snapshot(&mut store), before);
    let mut foreign = scope();
    foreign.profile_id = uuid(99);
    assert!(matches!(
        store.inspect_delegation_pool(&foreign),
        Err(Error::NotFound)
    ));
    assert!(matches!(
        store.initialize_delegation_pool(&foreign, &seed(), NOW),
        Err(Error::Invalid)
    ));
    assert_eq!(
        store
            .conn
            .query_row("SELECT count(*) FROM missions", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn hierarchical_escrow_deducts_the_subtree_once_and_not_again_from_ancestors() {
    let (_dir, mut store) = initialized();
    let c = child();
    store
        .reserve_delegation(&scope(), &uuid(1), &c, 1, NOW)
        .unwrap();
    let before = snapshot(&mut store);
    let root = before
        .branches
        .iter()
        .find(|b| b.branch_id == uuid(1))
        .unwrap();
    assert_eq!(root.remaining_descendants, 9);
    assert_eq!(root.remaining_budget["maxTokens"], json!(49_990));
    let g = grandchild(&c);
    store
        .reserve_delegation(&scope(), &uuid(9), &g, 2, NOW)
        .unwrap();
    let after = snapshot(&mut store);
    assert_eq!(after.state_version, 3);
    assert_eq!(
        after
            .branches
            .iter()
            .find(|b| b.branch_id == uuid(1))
            .unwrap(),
        root
    );
    let branch = after
        .branches
        .iter()
        .find(|b| b.branch_id == uuid(9))
        .unwrap();
    assert_eq!(branch.remaining_descendants, 1);
    assert_eq!(branch.remaining_budget["maxTokens"], json!(5));
}

#[test]
fn sibling_subtree_slots_cannot_oversubscribe_even_when_each_envelope_is_valid() {
    let (_dir, mut store) = initialized();
    let mut c = child();
    c["childRemaining"] = json!(11);
    store
        .reserve_delegation(&scope(), &uuid(1), &c, 1, NOW)
        .unwrap();
    let before = snapshot(&mut store);
    assert!(matches!(
        store.reserve_delegation(&scope(), &uuid(1), &sibling(&c, 30), 2, NOW),
        Err(Error::Exhausted)
    ));
    assert_eq!(snapshot(&mut store), before);
    assert_eq!(before.branches[0].remaining_descendants, 0);
}

#[test]
fn each_budget_dimension_is_atomic_and_cannot_be_spent_by_two_siblings() {
    for key in [
        "maxWallClockMs",
        "maxTokens",
        "maxToolCalls",
        "maxEstimatedCostMicrousd",
    ] {
        let (_dir, mut store) = initialized();
        let mut c = child();
        c["childRemaining"] = json!(0);
        c["budget"][key] = seed()["budget"][key].clone();
        store
            .reserve_delegation(&scope(), &uuid(1), &c, 1, NOW)
            .unwrap();
        let before = snapshot(&mut store);
        let mut next = sibling(&c, 30);
        next["budget"][key] = json!(1);
        assert!(
            matches!(
                store.reserve_delegation(&scope(), &uuid(1), &next, 2, NOW),
                Err(Error::Exhausted)
            ),
            "{key}"
        );
        assert_eq!(snapshot(&mut store), before);
    }
}

#[test]
fn two_callers_using_one_cas_revision_cannot_both_reserve() {
    use std::sync::{Arc, Barrier, Mutex};
    let (_dir, store) = initialized();
    let store = Arc::new(Mutex::new(store));
    let barrier = Arc::new(Barrier::new(2));
    let threads: Vec<_> = (0..2)
        .map(|i| {
            let store = Arc::clone(&store);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                store.lock().unwrap().reserve_delegation(
                    &scope(),
                    &uuid(1),
                    &sibling(&child(), 30 + i * 2),
                    1,
                    NOW,
                )
            })
        })
        .collect();
    let results: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Err(Error::Conflict)))
            .count(),
        1
    );
    let value = snapshot(&mut store.lock().unwrap());
    assert_eq!(value.state_version, 2);
    assert_eq!(value.branches.len(), 2);
}

#[test]
fn exact_replay_survives_restart_revocation_expiry_and_stale_cas_without_new_allocation() {
    let (dir, mut store) = initialized();
    let c = child();
    let first = store
        .reserve_delegation(&scope(), &uuid(1), &c, 1, NOW)
        .unwrap();
    store.revoke_delegation_pool(&scope(), 2, NOW).unwrap();
    let before = snapshot(&mut store);
    store.close().unwrap();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    assert_eq!(snapshot(&mut store), before);
    let duplicate = store
        .reserve_delegation(&scope(), &uuid(1), &c, 1, "2026-01-01T02:00:00Z")
        .unwrap();
    assert!(duplicate.duplicate);
    assert_eq!(duplicate.pool_version, first.pool_version);
    assert_eq!(duplicate.recorded_at, first.recorded_at);
    let after = snapshot(&mut store);
    assert_eq!(after.branches, before.branches);
    assert_eq!(after.state_version, before.state_version);
    assert!(after.revoked);
    let mut other = sibling(&c, 40);
    other["issuedAt"] = json!("2026-01-01T00:11:00Z");
    assert!(matches!(
        store.reserve_delegation(&scope(), &uuid(1), &other, 3, "2026-01-01T02:00:00Z"),
        Err(Error::Revoked)
    ));
}

#[test]
fn idempotency_binds_every_intent_and_the_explicit_parent_allocation() {
    let (_dir, mut store) = initialized();
    let c = child();
    store
        .reserve_delegation(&scope(), &uuid(1), &c, 1, NOW)
        .unwrap();
    let before = snapshot(&mut store);
    for key in [
        "authorityRef",
        "taskDefinitionDigest",
        "taskId",
        "delegationId",
    ] {
        let mut changed = c.clone();
        changed[key] = if key == "taskDefinitionDigest" {
            json!("b".repeat(64))
        } else if key.ends_with("Id") {
            json!(uuid(99))
        } else {
            json!("different-grant")
        };
        assert!(
            matches!(
                store.reserve_delegation(&scope(), &uuid(1), &changed, 2, NOW),
                Err(Error::Conflict)
            ),
            "{key}"
        );
    }
    assert!(matches!(
        store.reserve_delegation(&scope(), &uuid(90), &c, 2, NOW),
        Err(Error::Conflict)
    ));
    let mut numeric = c.clone();
    numeric["engineGeneration"] = json!(1.0);
    assert!(
        store
            .reserve_delegation(&scope(), &uuid(1), &numeric, 1, NOW)
            .unwrap()
            .duplicate
    );
    assert_eq!(snapshot(&mut store), before);
}

#[test]
fn refused_expiry_persists_clock_observation_so_a_rewound_clock_cannot_revive_capacity() {
    let (_dir, mut store) = initialized();
    assert!(matches!(
        store.reserve_delegation(&scope(), &uuid(1), &child(), 1, "2026-01-01T02:00:00Z"),
        Err(Error::Inactive)
    ));
    let late = snapshot(&mut store);
    assert_eq!(late.state_version, 1);
    assert_eq!(late.branches.len(), 1);
    assert!(matches!(
        store.reserve_delegation(&scope(), &uuid(1), &child(), 1, NOW),
        Err(Error::Inactive)
    ));
    assert_eq!(snapshot(&mut store), late);
}

#[test]
fn expiry_revocation_generation_and_foreign_scope_do_not_create_or_refund_allocations() {
    let (_dir, mut store) = initialized();
    let c = child();
    let before = snapshot(&mut store);
    let mut stale = c.clone();
    stale["engineGeneration"] = json!(2);
    assert!(matches!(
        store.reserve_delegation(&scope(), &uuid(1), &stale, 1, NOW),
        Err(Error::Invalid)
    ));
    let mut foreign = c.clone();
    foreign["profileId"] = json!(uuid(50));
    assert!(matches!(
        store.reserve_delegation(&scope(), &uuid(1), &foreign, 1, NOW),
        Err(Error::Invalid)
    ));
    assert_eq!(snapshot(&mut store), before);
    store
        .reserve_delegation(&scope(), &uuid(1), &c, 1, NOW)
        .unwrap();
    let allocated = snapshot(&mut store);
    let revoked = store.revoke_delegation_pool(&scope(), 2, NOW).unwrap();
    assert!(revoked.revoked);
    assert_eq!(revoked.branches, allocated.branches);
    assert!(matches!(
        store.reserve_delegation(&scope(), &uuid(9), &grandchild(&c), 3, NOW),
        Err(Error::Revoked)
    ));
    assert!(
        matches!(store.initialize_delegation_pool(&scope(),&seed(),NOW),Ok(ack) if ack.duplicate)
    );
    assert_eq!(snapshot(&mut store), revoked);
}

#[test]
fn failed_commit_rolls_back_balances_branch_receipt_version_and_clock_together() {
    let (_dir, mut store) = initialized();
    let before = snapshot(&mut store);
    store.fail_before_commit.set(true);
    assert!(matches!(
        store.reserve_delegation(&scope(), &uuid(1), &child(), 1, "2026-01-01T00:11:00Z"),
        Err(Error::Storage(_))
    ));
    store.fail_before_commit.set(false);
    assert_eq!(snapshot(&mut store), before);
    assert_eq!(
        store
            .conn
            .query_row("SELECT count(*) FROM delegation_reservations", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
    assert!(
        !store
            .reserve_delegation(&scope(), &uuid(1), &child(), 1, NOW)
            .unwrap()
            .duplicate
    );
}

#[test]
fn sql_guards_and_conservation_checks_reject_history_or_counter_corruption() {
    let (_dir, mut store) = initialized();
    store
        .reserve_delegation(&scope(), &uuid(1), &child(), 1, NOW)
        .unwrap();
    for sql in [
        "DELETE FROM delegation_reservations",
        "UPDATE delegation_reservations SET intent_payload='{}'",
        "UPDATE delegation_pools SET revoked=1; UPDATE delegation_pools SET revoked=0",
        "UPDATE delegation_branches SET slots_remaining=1000",
        "DELETE FROM delegation_branches",
    ] {
        assert!(store.conn.execute_batch(sql).is_err(), "{sql}");
    }
    // Decreasing a balance is SQL-valid but cannot pretend to be a recorded allocation.
    store
        .conn
        .execute(
            "UPDATE delegation_branches SET tokens_remaining=tokens_remaining-1 WHERE branch_id=?1",
            [uuid(1)],
        )
        .unwrap();
    assert!(matches!(
        store.inspect_delegation_pool(&scope()),
        Err(Error::Corrupt)
    ));
    assert!(matches!(
        store.reserve_delegation(&scope(), &uuid(1), &sibling(&child(), 40), 2, NOW),
        Err(Error::Corrupt)
    ));
}

#[test]
fn migration_from_eight_preserves_old_rows_backups_and_rejects_downgrade() {
    let dir = TempDir::new();
    let store = CoreStore::open_with(&dir.store(), &MIGRATIONS[..8]).unwrap();
    let old = json!({"schemaVersion":1,"id":uuid(20),"workspaceId":uuid(21),"leadAgentId":uuid(22),"budgetId":uuid(23),"state":"draft","createdAt":NOW,"updatedAt":NOW,"version":1});
    let payload = canonical::to_string(&old);
    store.conn.execute("INSERT INTO missions (mission_id,profile_id,workspace_id,state,version,created_at,updated_at,digest,payload) VALUES (?1,'legacy-profile',?2,'draft',1,?3,?3,?4,?5)",params![uuid(20),uuid(21),NOW,canonical::digest(&old),payload]).unwrap();
    store.close().unwrap();
    let mut store = CoreStore::open_with(&dir.store(), &MIGRATIONS[..9]).unwrap();
    assert_eq!(store.schema_version().unwrap(), 9);
    assert_eq!(
        store
            .conn
            .query_row("SELECT payload FROM missions", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        payload
    );
    assert!(matches!(
        store.inspect_delegation_pool(&scope()),
        Err(Error::NotFound)
    ));
    store.close().unwrap();
    let backup = std::fs::read_dir(dir.store().parent().unwrap())
        .unwrap()
        .filter_map(|entry| entry.ok())
        .find(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("core.sqlite.bak-8-")
        })
        .unwrap();
    let copy = Connection::open(backup.path()).unwrap();
    assert_eq!(
        copy.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        8
    );
    assert_eq!(
        copy.query_row("SELECT payload FROM missions", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        payload
    );
    assert!(matches!(
        CoreStore::open_with(&dir.store(), &MIGRATIONS[..8]),
        Err(StoreError::NewerSchema {
            found: 9,
            supported: 8
        })
    ));
}

#[test]
fn failed_migration_nine_keeps_the_old_schema_and_can_retry_cleanly() {
    let dir = TempDir::new();
    CoreStore::open_with(&dir.store(), &MIGRATIONS[..8])
        .unwrap()
        .close()
        .unwrap();
    let mut broken = MIGRATIONS[..8].to_vec();
    broken.push(Migration {
        version: 9,
        sql: "CREATE TABLE partial_nine(x); INSERT INTO missing_table VALUES (1);",
    });
    assert!(matches!(
        CoreStore::open_with(&dir.store(), &broken),
        Err(StoreError::Migration { version: 9, .. })
    ));
    let conn = Connection::open(dir.store()).unwrap();
    assert_eq!(
        conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        8
    );
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name='partial_nine'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    drop(conn);
    assert_eq!(
        CoreStore::open_with(&dir.store(), &MIGRATIONS[..9])
            .unwrap()
            .schema_version()
            .unwrap(),
        9
    );
}

#[test]
fn changed_seed_conflict_pins_the_clock_and_survives_restart() {
    let (dir, mut store) = initialized();
    let before = snapshot(&mut store);
    let mut changed = seed();
    changed["engineGeneration"] = json!(2);
    assert!(matches!(
        store.initialize_delegation_pool(&scope(), &changed, "2026-01-01T02:00:00Z"),
        Err(Error::Conflict)
    ));
    let late = snapshot(&mut store);
    assert_eq!(late.branches, before.branches);
    assert_eq!(late.state_version, before.state_version);
    assert!(late.observed_ms > before.observed_ms);
    store.close().unwrap();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    assert!(matches!(
        store.reserve_delegation(&scope(), &uuid(1), &child(), 1, NOW),
        Err(Error::Inactive)
    ));
    assert_eq!(snapshot(&mut store), late);
}

#[test]
fn clock_only_denial_and_replay_initialization_and_revocation_failures_roll_back() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    store.fail_before_commit.set(true);
    assert!(matches!(
        store.initialize_delegation_pool(&scope(), &seed(), NOW),
        Err(Error::Storage(_))
    ));
    store.fail_before_commit.set(false);
    assert!(matches!(
        store.inspect_delegation_pool(&scope()),
        Err(Error::NotFound)
    ));
    store
        .initialize_delegation_pool(&scope(), &seed(), NOW)
        .unwrap();
    let before = snapshot(&mut store);
    let mut changed = seed();
    changed["engineGeneration"] = json!(2);
    store.fail_before_commit.set(true);
    assert!(matches!(
        store.initialize_delegation_pool(&scope(), &changed, "2026-01-01T02:00:00Z"),
        Err(Error::Storage(_))
    ));
    assert!(matches!(
        store.reserve_delegation(&scope(), &uuid(1), &child(), 1, "2026-01-01T02:00:00Z"),
        Err(Error::Storage(_))
    ));
    store.fail_before_commit.set(false);
    assert_eq!(snapshot(&mut store), before);
    store
        .reserve_delegation(&scope(), &uuid(1), &child(), 1, NOW)
        .unwrap();
    let allocated = snapshot(&mut store);
    store.fail_before_commit.set(true);
    assert!(matches!(
        store.reserve_delegation(&scope(), &uuid(1), &child(), 1, "2026-01-01T02:00:00Z"),
        Err(Error::Storage(_))
    ));
    assert!(matches!(
        store.revoke_delegation_pool(&scope(), 2, "2026-01-01T00:20:00Z"),
        Err(Error::Storage(_))
    ));
    store.fail_before_commit.set(false);
    assert_eq!(snapshot(&mut store), allocated);
}

#[test]
fn sql_failure_after_debit_cannot_leave_partial_balances_or_receipts() {
    let (_dir, mut store) = initialized();
    let before = snapshot(&mut store);
    store.conn.execute_batch("CREATE TRIGGER test_fail_receipt BEFORE INSERT ON delegation_reservations BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END;").unwrap();
    assert!(matches!(
        store.reserve_delegation(&scope(), &uuid(1), &child(), 1, "2026-01-01T00:11:00Z"),
        Err(Error::Storage(_))
    ));
    store
        .conn
        .execute_batch("DROP TRIGGER test_fail_receipt")
        .unwrap();
    assert_eq!(snapshot(&mut store), before);
    assert_eq!(
        store
            .conn
            .query_row("SELECT count(*) FROM delegation_reservations", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
    assert!(
        store
            .reserve_delegation(&scope(), &uuid(1), &child(), 1, NOW)
            .is_ok()
    );
}

fn edit_receipts(store: &mut CoreStore, sql: &str) {
    let definition: String = store
        .conn
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE name='delegation_reservations_no_update'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    store
        .conn
        .execute_batch("DROP TRIGGER delegation_reservations_no_update")
        .unwrap();
    store.conn.execute_batch(sql).unwrap();
    store.conn.execute_batch(&definition).unwrap();
}

#[test]
fn unexplained_revisions_and_noncausal_receipt_order_are_corrupt() {
    let (_dir, mut store) = initialized();
    store
        .conn
        .execute(
            "UPDATE delegation_pools SET state_version=state_version+1",
            [],
        )
        .unwrap();
    assert!(matches!(
        store.inspect_delegation_pool(&scope()),
        Err(Error::Corrupt)
    ));
    let (_dir, mut store) = initialized();
    let c = child();
    store
        .reserve_delegation(&scope(), &uuid(1), &c, 1, NOW)
        .unwrap();
    store
        .reserve_delegation(&scope(), &uuid(9), &grandchild(&c), 2, NOW)
        .unwrap();
    edit_receipts(
        &mut store,
        &format!(
            "UPDATE delegation_reservations SET pool_version=100 WHERE branch_id='{}'; UPDATE delegation_reservations SET pool_version=2 WHERE branch_id='{}'; UPDATE delegation_reservations SET pool_version=3 WHERE branch_id='{}';",
            uuid(9),
            uuid(90),
            uuid(9)
        ),
    );
    assert!(matches!(
        store.inspect_delegation_pool(&scope()),
        Err(Error::Corrupt)
    ));
    let (_dir, mut store) = initialized();
    store
        .reserve_delegation(&scope(), &uuid(1), &child(), 1, NOW)
        .unwrap();
    store
        .reserve_delegation(&scope(), &uuid(1), &sibling(&child(), 30), 2, NOW)
        .unwrap();
    store
        .conn
        .execute(
            "UPDATE delegation_pools SET observed_ms=observed_ms+600000",
            [],
        )
        .unwrap();
    edit_receipts(
        &mut store,
        "UPDATE delegation_reservations SET recorded_at='2026-01-01T00:12:00Z' WHERE pool_version=2",
    );
    assert!(matches!(
        store.inspect_delegation_pool(&scope()),
        Err(Error::Corrupt)
    ));
}

#[test]
fn malformed_payload_digest_and_missing_receipt_never_pass_reconstruction() {
    let (_dir, mut store) = initialized();
    store
        .reserve_delegation(&scope(), &uuid(1), &child(), 1, NOW)
        .unwrap();
    edit_receipts(
        &mut store,
        "UPDATE delegation_reservations SET intent_digest='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'",
    );
    assert!(matches!(
        store.inspect_delegation_pool(&scope()),
        Err(Error::Corrupt)
    ));
    let (_dir, mut store) = initialized();
    store
        .reserve_delegation(&scope(), &uuid(1), &child(), 1, NOW)
        .unwrap();
    edit_receipts(
        &mut store,
        "UPDATE delegation_reservations SET intent_payload='{}'",
    );
    assert!(matches!(
        store.inspect_delegation_pool(&scope()),
        Err(Error::Corrupt)
    ));
    let (_dir, mut store) = initialized();
    store
        .reserve_delegation(&scope(), &uuid(1), &child(), 1, NOW)
        .unwrap();
    let definition: String = store
        .conn
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE name='delegation_reservations_no_delete'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    store
        .conn
        .execute_batch(
            "DROP TRIGGER delegation_reservations_no_delete; DELETE FROM delegation_reservations",
        )
        .unwrap();
    store.conn.execute_batch(&definition).unwrap();
    assert!(matches!(
        store.inspect_delegation_pool(&scope()),
        Err(Error::Corrupt)
    ));
}

#[test]
fn zero_caps_leaf_and_max_safe_caps_stay_provisional_without_overflow_or_replenishment() {
    for cap in [0_i64, 9_007_199_254_740_991] {
        let dir = TempDir::new();
        let mut store = CoreStore::open(&dir.store()).unwrap();
        let mut root = seed();
        let mut c = child();
        c["childRemaining"] = json!(0);
        c["hopRemaining"] = json!(0);
        for key in [
            "maxWallClockMs",
            "maxTokens",
            "maxToolCalls",
            "maxEstimatedCostMicrousd",
        ] {
            root["budget"][key] = json!(cap);
            c["budget"][key] = json!(cap);
        }
        store
            .initialize_delegation_pool(&scope(), &root, NOW)
            .unwrap();
        let ack = store
            .reserve_delegation(&scope(), &uuid(1), &c, 1, NOW)
            .unwrap();
        assert!(!ack.authority_verified && !ack.dispatch_eligible);
        let before = snapshot(&mut store);
        assert_eq!(
            before
                .branches
                .iter()
                .find(|b| b.branch_id == uuid(1))
                .unwrap()
                .remaining_budget["maxTokens"],
            json!(0)
        );
        assert!(matches!(
            store.reserve_delegation(&scope(), &uuid(9), &grandchild(&c), 2, NOW),
            Err(Error::Invalid)
        ));
        assert_eq!(snapshot(&mut store), before);
        assert!(
            store
                .initialize_delegation_pool(&scope(), &root, NOW)
                .unwrap()
                .duplicate
        );
        assert_eq!(snapshot(&mut store), before);
    }
}

#[test]
fn issue_is_inclusive_expiry_is_exclusive_and_nested_history_reopens_unchanged() {
    let dir = TempDir::new();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    store
        .initialize_delegation_pool(&scope(), &seed(), "2026-01-01T00:00:00Z")
        .unwrap();
    let c = child();
    store
        .reserve_delegation(&scope(), &uuid(1), &c, 1, "2026-01-01T00:01:00Z")
        .unwrap();
    store
        .reserve_delegation(&scope(), &uuid(9), &grandchild(&c), 2, NOW)
        .unwrap();
    let before = snapshot(&mut store);
    store.close().unwrap();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    assert_eq!(snapshot(&mut store), before);
    assert!(matches!(
        store.reserve_delegation(
            &scope(),
            &uuid(1),
            &sibling(&c, 40),
            3,
            "2026-01-01T00:30:00Z"
        ),
        Err(Error::Inactive)
    ));
    let expired = snapshot(&mut store);
    store.close().unwrap();
    let mut store = CoreStore::open(&dir.store()).unwrap();
    assert_eq!(snapshot(&mut store), expired);
    assert!(matches!(
        store.reserve_delegation(&scope(), &uuid(1), &sibling(&c, 40), 3, NOW),
        Err(Error::Inactive)
    ));
}
