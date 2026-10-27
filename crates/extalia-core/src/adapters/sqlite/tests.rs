//! Store tests. Every test works in its own temporary directory only.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use rusqlite::{Connection, params};

use super::migrate::{MIGRATIONS, Migration};
use super::{CoreStore, StoreError, store_path};

const MISSION: &str = "00000000-0000-4000-8000-000000000002";
const OTHER_MISSION: &str = "00000000-0000-4000-8000-000000000003";
const WORKSPACE: &str = "00000000-0000-4000-8000-000000000001";
const TASK: &str = "00000000-0000-4000-8000-000000000005";
const EVENT: &str = "00000000-0000-4000-8000-000000000013";
const DIGEST: &str = "0000000000000000000000000000000000000000000000000000000000000000";

pub(super) struct TempDir(pub(super) PathBuf);

impl TempDir {
    pub(super) fn new() -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        loop {
            let dir = std::env::temp_dir().join(format!(
                "extalia-core-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&dir) {
                Ok(()) => return Self(dir),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => panic!("cannot create a temporary directory: {error}"),
            }
        }
    }

    pub(super) fn store(&self) -> PathBuf {
        store_path(&self.0)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const BROKEN: Migration = Migration {
    version: 7,
    sql: "CREATE TABLE extra (id INTEGER PRIMARY KEY) STRICT;
          INSERT INTO extra (id) VALUES (1);
          INSERT INTO missing_table VALUES (1);",
};
const SECOND: Migration = Migration {
    version: 7,
    sql: "CREATE INDEX missions_state ON missions (profile_id, state);",
};

/// The released migrations followed by one test migration.
fn plus(extra: Migration) -> Vec<Migration> {
    let mut all = MIGRATIONS.to_vec();
    all.push(extra);
    all
}

fn insert_mission(conn: &Connection, id: &str, profile: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO missions (mission_id, profile_id, workspace_id, state, version, created_at, updated_at, digest, payload)
         VALUES (?1, ?2, ?3, 'draft', 1, 't', 't', ?4, '{}')",
        params![id, profile, WORKSPACE, DIGEST],
    )
}

fn insert_event(
    conn: &Connection,
    id: &str,
    profile: &str,
    sequence: i64,
) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO events (event_id, profile_id, mission_id, sequence, event_type, committed_at, digest, payload)
         VALUES (?1, ?2, ?3, ?4, 'task.state', 't', ?5, '{}')",
        params![id, profile, MISSION, sequence, DIGEST],
    )
}

fn backups(dir: &Path) -> Vec<PathBuf> {
    let state = dir.join("state");
    let mut found: Vec<_> = fs::read_dir(state)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .contains(".bak-")
        })
        .collect();
    found.sort();
    found
}

fn raw(path: &Path) -> Connection {
    Connection::open(path).unwrap()
}

fn version_of(conn: &Connection) -> i64 {
    super::migrate::user_version(conn).unwrap()
}

#[test]
fn creates_a_fresh_store_with_durable_pragmas() {
    let dir = TempDir::new();
    let store = CoreStore::open(&dir.store()).unwrap();
    assert_eq!(store.schema_version().unwrap(), CoreStore::LATEST);
    assert_eq!(CoreStore::LATEST, 6);
    let conn = &store.conn;
    let pragma = |name: &str| -> String {
        conn.pragma_query_value(None, name, |row| row.get::<_, rusqlite::types::Value>(0))
            .map(|value| match value {
                rusqlite::types::Value::Integer(number) => number.to_string(),
                rusqlite::types::Value::Text(text) => text,
                other => format!("{other:?}"),
            })
            .unwrap()
    };
    assert_eq!(pragma("journal_mode"), "wal");
    assert_eq!(pragma("synchronous"), "2");
    assert_eq!(pragma("foreign_keys"), "1");
    assert_eq!(pragma("busy_timeout"), "1000");
    let objects: Vec<(String, String)> = conn
        .prepare("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite%' AND name NOT LIKE 'skill%' AND name NOT LIKE 'learning%' ORDER BY type, name")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let names: Vec<_> = objects
        .iter()
        .map(|(kind, name)| format!("{kind} {name}"))
        .collect();
    assert_eq!(
        names,
        [
            "index approvals_mission",
            "index tasks_mission",
            "table approvals",
            "table events",
            "table leases",
            "table mission_totals",
            "table missions",
            "table tasks",
            "trigger mission_totals_on_event_delete",
            "trigger mission_totals_on_event_insert",
            "trigger mission_totals_on_event_update",
            "trigger mission_totals_on_mission_insert",
        ]
    );
    let skill_tables: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name LIKE 'skill%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        skill_tables, 22,
        "schema 2 adds the skill registry, schema 4 reviews, inputs and built-ins"
    );
    let learning: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'learning%' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        learning,
        [
            "learning_candidate_decisions",
            "learning_candidate_evidence",
            "learning_candidate_experiences",
            "learning_candidates",
            "learning_evidence",
            "learning_experience_evidence",
            "learning_experiences",
        ],
        "schema 6 adds the learning loop"
    );
    assert!(backups(&dir.0).is_empty(), "an empty file is not backed up");
}

#[test]
fn reopening_is_idempotent() {
    let dir = TempDir::new();
    let store = CoreStore::open(&dir.store()).unwrap();
    insert_mission(&store.conn, MISSION, "default").unwrap();
    store.close().unwrap();
    for _ in 0..2 {
        let store = CoreStore::open(&dir.store()).unwrap();
        assert_eq!(store.schema_version().unwrap(), 6);
        let count: i64 = store
            .conn
            .query_row("SELECT count(*) FROM missions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        store.close().unwrap();
    }
    assert!(backups(&dir.0).is_empty(), "no migration ran, so no backup");
}

#[test]
fn newer_user_version_fails_closed_without_writing() {
    let dir = TempDir::new();
    CoreStore::open(&dir.store()).unwrap().close().unwrap();
    raw(&dir.store())
        .pragma_update(None, "user_version", 7)
        .unwrap();
    let before = fs::read(dir.store()).unwrap();
    match CoreStore::open(&dir.store()) {
        Err(StoreError::NewerSchema {
            found: 7,
            supported: 6,
        }) => {}
        other => panic!("expected NewerSchema, got {other:?}"),
    }
    assert_eq!(
        fs::read(dir.store()).unwrap(),
        before,
        "file left untouched"
    );
    assert_eq!(version_of(&raw(&dir.store())), 7);
    assert!(backups(&dir.0).is_empty());
}

#[test]
fn tampered_or_foreign_schema_fails_closed() {
    let tampering = [
        "CREATE TABLE intruder (id INTEGER) STRICT",
        "DROP INDEX tasks_mission",
        "ALTER TABLE missions ADD COLUMN note TEXT",
        "CREATE TRIGGER missions_touch AFTER UPDATE ON missions BEGIN SELECT 1; END",
    ];
    for sql in tampering {
        let dir = TempDir::new();
        CoreStore::open(&dir.store()).unwrap().close().unwrap();
        raw(&dir.store()).execute_batch(sql).unwrap();
        assert!(
            matches!(
                CoreStore::open(&dir.store()),
                Err(StoreError::SchemaMismatch)
            ),
            "{sql}"
        );
    }
    // A foreign file at version 0 is never adopted.
    let dir = TempDir::new();
    fs::create_dir_all(dir.0.join("state")).unwrap();
    raw(&dir.store())
        .execute_batch("CREATE TABLE missions (id TEXT)")
        .unwrap();
    assert!(matches!(
        CoreStore::open(&dir.store()),
        Err(StoreError::SchemaMismatch)
    ));
    assert_eq!(version_of(&raw(&dir.store())), 0);
}

#[test]
fn injected_failure_mid_migration_keeps_the_previous_state() {
    let dir = TempDir::new();
    let store = CoreStore::open(&dir.store()).unwrap();
    insert_mission(&store.conn, MISSION, "default").unwrap();
    store.close().unwrap();

    match CoreStore::open_with(&dir.store(), &plus(BROKEN)) {
        Err(StoreError::Migration { version: 7, .. }) => {}
        other => panic!("expected a failed migration 7, got {other:?}"),
    }
    let conn = raw(&dir.store());
    assert_eq!(version_of(&conn), 6);
    super::migrate::verify_schema(&conn, MIGRATIONS).unwrap();
    let missions: i64 = conn
        .query_row("SELECT count(*) FROM missions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(missions, 1);
    drop(conn);

    let copies = backups(&dir.0);
    assert_eq!(copies.len(), 1);
    let name = copies[0]
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert!(name.starts_with("core.sqlite.bak-6-"), "{name}");
    let copy = raw(&copies[0]);
    assert_eq!(version_of(&copy), 6);
    let saved: i64 = copy
        .query_row("SELECT count(*) FROM missions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(saved, 1);

    // The released build still opens the untouched version 6.
    CoreStore::open(&dir.store()).unwrap().close().unwrap();
}

#[test]
fn injected_failure_in_the_first_migration_leaves_an_empty_file() {
    let dir = TempDir::new();
    let broken = Migration {
        version: 1,
        sql: "CREATE TABLE a (x INTEGER) STRICT; SELECT * FROM missing_table;",
    };
    assert!(matches!(
        CoreStore::open_with(&dir.store(), &[broken]),
        Err(StoreError::Migration { version: 1, .. })
    ));
    let conn = raw(&dir.store());
    assert_eq!(version_of(&conn), 0);
    let objects: i64 = conn
        .query_row("SELECT count(*) FROM sqlite_schema", [], |row| row.get(0))
        .unwrap();
    assert_eq!(objects, 0);
    drop(conn);
    CoreStore::open(&dir.store()).unwrap().close().unwrap();
}

#[test]
fn upgrade_backs_up_then_migrates() {
    let dir = TempDir::new();
    CoreStore::open(&dir.store()).unwrap().close().unwrap();
    let store = CoreStore::open_with(&dir.store(), &plus(SECOND)).unwrap();
    assert_eq!(store.schema_version().unwrap(), 7);
    store.close().unwrap();
    let copies = backups(&dir.0);
    assert_eq!(copies.len(), 1);
    assert_eq!(version_of(&raw(&copies[0])), 6);
    // This build does not know version 7.
    assert!(matches!(
        CoreStore::open(&dir.store()),
        Err(StoreError::NewerSchema {
            found: 7,
            supported: 6
        })
    ));
}

#[test]
fn upgrades_a_schema_1_mission_store_to_the_skill_registry() {
    let dir = TempDir::new();
    let store = CoreStore::open_with(&dir.store(), &MIGRATIONS[..1]).unwrap();
    assert_eq!(store.schema_version().unwrap(), 1);
    insert_mission(&store.conn, MISSION, "default").unwrap();
    insert_event(&store.conn, EVENT, "default", 1).unwrap();
    store.close().unwrap();

    let mut store = CoreStore::open(&dir.store()).unwrap();
    assert_eq!(store.schema_version().unwrap(), CoreStore::LATEST);
    let count = |conn: &Connection, table: &str| -> i64 {
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
    };
    assert_eq!(count(&store.conn, "missions"), 1, "mission data kept");
    assert_eq!(count(&store.conn, "events"), 1);
    assert_eq!(count(&store.conn, "skill_revisions"), 0);
    super::migrate::verify_schema(store.connection(), MIGRATIONS).unwrap();
    store.close().unwrap();

    let copies = backups(&dir.0);
    assert_eq!(copies.len(), 1, "backed up before migrating");
    let name = copies[0]
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert!(name.starts_with("core.sqlite.bak-1-"), "{name}");
    let copy = raw(&copies[0]);
    assert_eq!(version_of(&copy), 1);
    assert_eq!(count(&copy, "missions"), 1);
    super::migrate::verify_schema(&copy, &MIGRATIONS[..1]).unwrap();
    // Reopening the upgraded file runs no migration and makes no new backup.
    drop(copy);
    CoreStore::open(&dir.store()).unwrap().close().unwrap();
    assert_eq!(backups(&dir.0).len(), 1);
}

#[test]
fn upgrades_a_schema_2_store_and_backfills_mission_totals() {
    let dir = TempDir::new();
    let store = CoreStore::open_with(&dir.store(), &MIGRATIONS[..2]).unwrap();
    assert_eq!(store.schema_version().unwrap(), 2);
    insert_mission(&store.conn, MISSION, "default").unwrap();
    insert_mission(&store.conn, OTHER_MISSION, "work").unwrap();
    for sequence in 1..=3_i64 {
        let id = format!("00000000-0000-4000-8000-0000000001{sequence:02}");
        insert_event(&store.conn, &id, "default", sequence).unwrap();
    }
    store.close().unwrap();

    let mut store = CoreStore::open(&dir.store()).unwrap();
    assert_eq!(store.schema_version().unwrap(), CoreStore::LATEST);
    let totals: Vec<(String, String, i64, i64, i64)> = store
        .conn
        .prepare("SELECT * FROM mission_totals ORDER BY profile_id")
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        totals,
        [
            ("default".into(), MISSION.into(), 3, 3, 6),
            ("work".into(), OTHER_MISSION.into(), 0, 0, 0),
        ],
        "backfilled from the journal: count, last sequence, payload bytes"
    );
    super::migrate::verify_schema(store.connection(), MIGRATIONS).unwrap();
    // Missions created after the migration get their row from the trigger.
    store
        .conn
        .execute(
            "INSERT INTO missions (mission_id, profile_id, workspace_id, state, version, created_at, updated_at, digest, payload)
             VALUES ('00000000-0000-4000-8000-000000000004', 'default', ?1, 'draft', 1, 't', 't', ?2, '{}')",
            params![WORKSPACE, DIGEST],
        )
        .unwrap();
    let rows: i64 = store
        .conn
        .query_row("SELECT count(*) FROM mission_totals", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 3);
    store.close().unwrap();

    let copies = backups(&dir.0);
    assert_eq!(copies.len(), 1, "backed up before migrating");
    let name = copies[0]
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert!(name.starts_with("core.sqlite.bak-2-"), "{name}");
    let copy = raw(&copies[0]);
    assert_eq!(version_of(&copy), 2);
    super::migrate::verify_schema(&copy, &MIGRATIONS[..2]).unwrap();
    drop(copy);
    CoreStore::open(&dir.store()).unwrap().close().unwrap();
    assert_eq!(backups(&dir.0).len(), 1, "a reopen migrates nothing");
}

const TREE: &str = "abababababababababababababababababababababababababababababababab";

/// A `review_required` revision with one completed inspection, written with plain SQL so
/// it works on schema 3.
fn insert_reviewable_revision(conn: &Connection, profile: &str) -> String {
    let revision = format!("skr_{TREE}");
    conn.execute_batch(&format!(
        "INSERT INTO skill_packages (profile_id, package_id, origin, source_ref, created_at)
           VALUES ('{profile}', 'demo', 'user', 'demo', 't');
         INSERT INTO skill_revisions (profile_id, revision_id, package_id, version, tree_sha256,
           skill_md_sha256, manifest_json, manifest_inferred, risk_class, permission_digest,
           state, state_reason, created_at, updated_at)
           VALUES ('{profile}', '{revision}', 'demo', '1.0.0', '{TREE}', '{DIGEST}', '{{}}', 0,
             'declarative', '{DIGEST}', 'review_required', 'finding-medium', 't', 't');
         INSERT INTO skill_inspections (inspection_id, profile_id, revision_id, tree_sha256,
           scanner_id, scanner_pin, policy_version, outcome, coverage, verdict, started_at, finished_at)
           VALUES (1, '{profile}', '{revision}', '{TREE}', 'fake', 'pin', 'v1', 'completed',
             'complete', 'medium', 't', 't');"
    ))
    .unwrap();
    revision
}

fn insert_review(conn: &Connection, revision: &str, principal: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO skill_reviews (profile_id, revision_id, tree_sha256, inspection_id, principal,
           decision, note, created_at) VALUES ('default', ?1, ?2, 1, ?3, 'accept', NULL, 't')",
        params![revision, TREE, principal],
    )
}

#[test]
fn upgrades_a_schema_3_store_with_skill_data_to_reviews() {
    let dir = TempDir::new();
    let store = CoreStore::open_with(&dir.store(), &MIGRATIONS[..3]).unwrap();
    assert_eq!(store.schema_version().unwrap(), 3);
    insert_mission(&store.conn, MISSION, "default").unwrap();
    insert_event(&store.conn, EVENT, "default", 1).unwrap();
    let revision = insert_reviewable_revision(&store.conn, "default");
    store.close().unwrap();

    let mut store = CoreStore::open(&dir.store()).unwrap();
    assert_eq!(store.schema_version().unwrap(), CoreStore::LATEST);
    let count = |conn: &Connection, table: &str| -> i64 {
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
    };
    for (table, rows) in [
        ("missions", 1),
        ("events", 1),
        ("mission_totals", 1),
        ("skill_packages", 1),
        ("skill_revisions", 1),
        ("skill_inspections", 1),
        ("skill_reviews", 0),
        ("skill_review_inputs", 0),
        ("skill_builtin_registrations", 0),
    ] {
        assert_eq!(count(&store.conn, table), rows, "{table}");
    }
    super::migrate::verify_schema(store.connection(), MIGRATIONS).unwrap();
    // The new tables accept rows bound to the kept revision and its inspection.
    insert_review(&store.conn, &revision, "user:local").unwrap();
    store.close().unwrap();

    let copies = backups(&dir.0);
    assert_eq!(copies.len(), 1, "backed up before migrating");
    let name = copies[0]
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert!(name.starts_with("core.sqlite.bak-3-"), "{name}");
    let copy = raw(&copies[0]);
    assert_eq!(version_of(&copy), 3);
    assert_eq!(count(&copy, "skill_revisions"), 1);
    super::migrate::verify_schema(&copy, &MIGRATIONS[..3]).unwrap();
    drop(copy);
    CoreStore::open(&dir.store()).unwrap().close().unwrap();
    assert_eq!(backups(&dir.0).len(), 1, "a reopen migrates nothing");
}

#[test]
fn schema_4_reviews_inputs_and_builtins_are_append_only_and_bound() {
    let dir = TempDir::new();
    let store = CoreStore::open(&dir.store()).unwrap();
    let conn = &store.conn;
    let revision = insert_reviewable_revision(conn, "default");
    // Only the local user principal, only within the profile, only a real inspection.
    for principal in ["agent:planner", "model:x", "policy:auto", "USER:x", "user:"] {
        assert!(
            insert_review(conn, &revision, principal).is_err(),
            "{principal}"
        );
    }
    insert_review(conn, &revision, "user:local").unwrap();
    assert!(
        conn.execute(
            "INSERT INTO skill_reviews (profile_id, revision_id, tree_sha256, inspection_id, principal,
               decision, created_at) VALUES ('work', ?1, ?2, 1, 'user:local', 'accept', 't')",
            params![revision, TREE],
        )
        .is_err(),
        "another profile cannot reference the revision"
    );
    assert!(
        conn.execute(
            "INSERT INTO skill_reviews (profile_id, revision_id, tree_sha256, inspection_id, principal,
               decision, note, created_at) VALUES ('default', ?1, ?2, 1, 'user:local', 'reject', ?3, 't')",
            params![revision, TREE, "x".repeat(2001)],
        )
        .is_err(),
        "notes are at most 2000 characters"
    );
    conn.execute(
        "INSERT INTO skill_review_inputs (profile_id, revision_id, source, workspace_id,
           consent_sha256, allowed_at, observed_at)
         VALUES ('default', ?1, 'w0-consent', ?2, ?3, NULL, 't')",
        params![revision, WORKSPACE, DIGEST],
    )
    .unwrap();
    assert!(
        conn.execute(
            "INSERT INTO skill_review_inputs (profile_id, revision_id, source, workspace_id,
               consent_sha256, observed_at)
             VALUES ('default', ?1, 'w0-consent', ?2, ?3, 't')",
            params![revision, WORKSPACE, TREE],
        )
        .is_err(),
        "consent must match the stored SKILL.md"
    );
    conn.execute(
        "INSERT INTO skill_builtin_registrations (profile_id, package_id, revision_id, tree_sha256,
           skill_md_sha256, version, risk_class, permission_digest, event, at)
         VALUES ('default', 'planning', ?1, ?2, ?3, '1.0.0', 'declarative', ?3, 'registered', 't')",
        params![revision, TREE, DIGEST],
    )
    .unwrap();
    for (table, column) in [
        ("skill_reviews", "decision = 'reject'"),
        ("skill_review_inputs", "observed_at = 'u'"),
        ("skill_builtin_registrations", "event = 'retired'"),
    ] {
        assert!(
            conn.execute(&format!("UPDATE {table} SET {column}"), [])
                .is_err(),
            "{table} update"
        );
        assert!(
            conn.execute(&format!("DELETE FROM {table}"), []).is_err(),
            "{table} delete"
        );
    }
    // Built-ins never become packages: the import origins are unchanged.
    assert!(
        conn.execute(
            "INSERT INTO skill_packages (profile_id, package_id, origin, source_ref, created_at)
             VALUES ('default', 'planning', 'builtin', 'x', 't')",
            [],
        )
        .is_err()
    );
}

const HOST_WORKSPACE: &str = "w_mh3p2k1x9f04c2a7";
/// The tables migration 5 rebuilds.
const REBUILT: [&str; 4] = [
    "skill_approvals",
    "skill_activations",
    "skill_activation_events",
    "skill_review_inputs",
];

/// Every row of `table` as text, in primary-key order.
fn dump(conn: &Connection, table: &str) -> Vec<String> {
    let mut statement = conn
        .prepare(&format!("SELECT * FROM {table} ORDER BY 1, 2"))
        .unwrap();
    let columns = statement.column_count();
    statement
        .query_map([], |row| {
            (0..columns)
                .map(|index| {
                    row.get::<_, rusqlite::types::Value>(index)
                        .map(|value| format!("{value:?}"))
                })
                .collect::<rusqlite::Result<Vec<_>>>()
                .map(|values| values.join("|"))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

/// Index and trigger names (and the SQL of each) attached to `table`.
fn attached(conn: &Connection, table: &str) -> Vec<(String, String, Option<String>)> {
    conn.prepare(
        "SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = ?1 AND type IN ('index', 'trigger') ORDER BY type, name",
    )
    .unwrap()
    .query_map([table], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
    .unwrap()
    .collect::<rusqlite::Result<_>>()
    .unwrap()
}

/// Approvals (granted with a UUID workspace, revoked without one), an activation with its
/// event and a W0 review input, written with plain SQL as schema 4 admits them.
fn insert_schema_4_skill_rows(conn: &Connection, revision: &str) {
    conn.execute_batch(&format!(
        "INSERT INTO skill_approvals (approval_id, profile_id, revision_id, tree_sha256, inspection_id,
           workspace_id, permission_digest, kind, approver, status, created_at, expires_at, revoked_at)
           VALUES (3, 'default', '{revision}', '{TREE}', 1, '{WORKSPACE}', '{DIGEST}', 'user', 'user:local',
             'granted', 't', 'u', NULL),
                  (9, 'default', '{revision}', '{TREE}', 1, NULL, '{DIGEST}', 'auto', 'policy:auto',
             'revoked', 't', 'u', 'v');
         INSERT INTO skill_activations (profile_id, package_id, revision_id, approval_id, activated_at)
           VALUES ('default', 'demo', '{revision}', 3, 't');
         INSERT INTO skill_activation_events (event_seq, profile_id, package_id, action,
           from_revision_id, to_revision_id, approval_id, reason, at)
           VALUES (5, 'default', 'demo', 'activate', NULL, '{revision}', 3, NULL, 't'),
                  (6, 'default', 'demo', 'deactivate', '{revision}', NULL, NULL, 'user-request', 'u');
         INSERT INTO skill_review_inputs (input_id, profile_id, revision_id, source, workspace_id,
           consent_sha256, allowed_at, observed_at)
           VALUES (4, 'default', '{revision}', 'w0-consent', '{WORKSPACE}', '{DIGEST}',
             '2026-10-21T08:00:00.000Z', 't');"
    ))
    .unwrap();
}

#[test]
fn upgrades_a_schema_4_store_keeping_skill_rows_and_admits_host_workspace_ids() {
    let dir = TempDir::new();
    let store = CoreStore::open_with(&dir.store(), &MIGRATIONS[..4]).unwrap();
    assert_eq!(store.schema_version().unwrap(), 4);
    insert_mission(&store.conn, MISSION, "default").unwrap();
    let revision = insert_reviewable_revision(&store.conn, "default");
    insert_review(&store.conn, &revision, "user:local").unwrap();
    insert_schema_4_skill_rows(&store.conn, &revision);
    // Schema 4 refuses host workspace ids: the gap this migration closes.
    assert!(
        store
            .conn
            .execute(
                "INSERT INTO skill_review_inputs (profile_id, revision_id, source, workspace_id,
                   consent_sha256, observed_at) VALUES ('default', ?1, 'w0-consent', ?2, ?3, 't')",
                params![revision, HOST_WORKSPACE, DIGEST],
            )
            .is_err()
    );
    let tables = [
        "missions",
        "skill_packages",
        "skill_revisions",
        "skill_inspections",
        "skill_reviews",
        "skill_approvals",
        "skill_activations",
        "skill_activation_events",
        "skill_review_inputs",
    ];
    let before: Vec<_> = tables
        .iter()
        .map(|table| dump(&store.conn, table))
        .collect();
    let attached_before: Vec<_> = REBUILT
        .iter()
        .map(|table| attached(&store.conn, table))
        .collect();
    store.close().unwrap();

    let mut store = CoreStore::open(&dir.store()).unwrap();
    assert_eq!(store.schema_version().unwrap(), CoreStore::LATEST);
    let after: Vec<_> = tables
        .iter()
        .map(|table| dump(&store.conn, table))
        .collect();
    assert_eq!(after, before, "every row kept with its id");
    assert_eq!(dump(&store.conn, "skill_approvals").len(), 2);
    assert_eq!(dump(&store.conn, "skill_activation_events").len(), 2);
    // Same indexes and append-only triggers by name; only the workspace CHECK changed.
    for (table, previous) in REBUILT.iter().zip(&attached_before) {
        let names = |list: &[(String, String, Option<String>)]| {
            list.iter()
                .map(|(kind, name, _)| format!("{kind} {name}"))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            names(&attached(&store.conn, table)),
            names(previous),
            "{table}"
        );
    }
    // Children still reference skill_approvals (not a renamed or temporary table).
    for child in ["skill_activations", "skill_activation_events"] {
        let parents: Vec<String> = store
            .conn
            .prepare(&format!(
                "SELECT DISTINCT \"table\" FROM pragma_foreign_key_list('{child}') ORDER BY 1"
            ))
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert!(
            parents.contains(&"skill_approvals".to_owned()),
            "{child}: {parents:?}"
        );
    }
    super::migrate::verify_schema(store.connection(), MIGRATIONS).unwrap();
    super::migrate::verify_integrity(store.connection()).unwrap();
    store.close().unwrap();

    let copies = backups(&dir.0);
    assert_eq!(copies.len(), 1, "backed up before migrating");
    let name = copies[0]
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert!(name.starts_with("core.sqlite.bak-4-"), "{name}");
    let copy = raw(&copies[0]);
    assert_eq!(version_of(&copy), 4);
    super::migrate::verify_schema(&copy, &MIGRATIONS[..4]).unwrap();
    assert_eq!(dump(&copy, "skill_approvals"), before[5]);
    drop(copy);
    CoreStore::open(&dir.store()).unwrap().close().unwrap();
    assert_eq!(backups(&dir.0).len(), 1, "a reopen migrates nothing");
}

#[test]
fn schema_5_workspace_ids_are_bounded_and_skill_history_stays_append_only() {
    let dir = TempDir::new();
    let store = CoreStore::open(&dir.store()).unwrap();
    let conn = &store.conn;
    let revision = insert_reviewable_revision(conn, "default");
    insert_schema_4_skill_rows(conn, &revision);
    let input = |workspace: &str| {
        conn.execute(
            "INSERT INTO skill_review_inputs (profile_id, revision_id, source, workspace_id,
               consent_sha256, observed_at) VALUES ('default', ?1, 'w0-consent', ?2, ?3, 't')",
            params![revision, workspace, DIGEST],
        )
    };
    let approval = |workspace: &str| {
        conn.execute(
            "INSERT INTO skill_approvals (profile_id, revision_id, tree_sha256, inspection_id,
               workspace_id, permission_digest, kind, approver, status, created_at, expires_at)
             VALUES ('default', ?1, ?2, 1, ?3, ?4, 'user', 'user:local', 'granted', 't', 'u')",
            params![revision, TREE, workspace, DIGEST],
        )
    };
    for good in [HOST_WORKSPACE, "w_00123abcd", "w_2gosa7pa2gv0123abcd"] {
        input(good).unwrap();
        approval(good).unwrap();
    }
    assert!(
        input(HOST_WORKSPACE).is_err(),
        "each input is recorded once"
    );
    for bad in [
        "w_",
        "w_0123abcd",
        "w_../../etc/passwd",
        "w_MH3P2K1X9F04C2A7",
        "w_mh3p2k1x9f04c2ag",
        "x_mh3p2k1x9f04c2a7",
        "w_zzzzzzzzzzzz0123abcd",
        "",
        "short",
    ] {
        assert!(input(bad).is_err(), "input {bad}");
        assert!(approval(bad).is_err(), "approval {bad}");
    }
    // Append-only and immutable as before the rebuild.
    for sql in [
        "UPDATE skill_review_inputs SET observed_at = 'v'",
        "DELETE FROM skill_review_inputs",
        "UPDATE skill_approvals SET workspace_id = 'w_mh3p2k1x9f04c2a8' WHERE approval_id = 3",
        "UPDATE skill_approvals SET status = 'granted', revoked_at = NULL WHERE approval_id = 9",
        "DELETE FROM skill_approvals WHERE approval_id = 9",
        "UPDATE skill_activation_events SET reason = 'x'",
        "DELETE FROM skill_activation_events",
    ] {
        assert!(conn.execute(sql, []).is_err(), "{sql}");
    }
    conn.execute(
        "UPDATE skill_approvals SET status = 'revoked', revoked_at = 'v' WHERE approval_id = 3",
        [],
    )
    .unwrap();
    // Foreign keys still bind the children to the rebuilt parent.
    assert!(
        conn.execute(
            "INSERT INTO skill_activation_events (profile_id, package_id, action, to_revision_id,
               approval_id, at) VALUES ('default', 'demo', 'activate', ?1, 99, 't')",
            [&revision],
        )
        .is_err(),
        "unknown approval"
    );
    assert!(
        conn.execute(
            "INSERT INTO skill_review_inputs (profile_id, revision_id, source, workspace_id,
               consent_sha256, observed_at) VALUES ('default', ?1, 'w0-consent', ?2, ?3, 't')",
            params![revision, "w_mh3p2k1x9f04c2a9", TREE],
        )
        .is_err(),
        "consent must match the stored SKILL.md"
    );
    // The migration leaves no temporary table behind.
    let replay = Connection::open_in_memory().unwrap();
    for migration in MIGRATIONS {
        replay.execute_batch(migration.sql).unwrap();
    }
    let temp: i64 = replay
        .query_row("SELECT count(*) FROM temp.sqlite_schema", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(temp, 0);
}

#[test]
fn upgrades_a_schema_5_store_with_data_to_the_learning_loop() {
    let dir = TempDir::new();
    let store = CoreStore::open_with(&dir.store(), &MIGRATIONS[..5]).unwrap();
    assert_eq!(store.schema_version().unwrap(), 5);
    insert_mission(&store.conn, MISSION, "default").unwrap();
    store
        .conn
        .execute(
            "INSERT INTO tasks (task_id, profile_id, mission_id, state, attempt, updated_at, digest, payload)
             VALUES (?1, 'default', ?2, 'completed', 1, 't', ?3, '{}')",
            params![TASK, MISSION, DIGEST],
        )
        .unwrap();
    insert_event(&store.conn, EVENT, "default", 1).unwrap();
    let revision = insert_reviewable_revision(&store.conn, "default");
    insert_review(&store.conn, &revision, "user:local").unwrap();
    insert_schema_4_skill_rows(&store.conn, &revision);
    let tables = [
        "missions",
        "mission_totals",
        "tasks",
        "events",
        "skill_revisions",
        "skill_reviews",
        "skill_approvals",
        "skill_activation_events",
        "skill_review_inputs",
    ];
    let before: Vec<_> = tables
        .iter()
        .map(|table| dump(&store.conn, table))
        .collect();
    store.close().unwrap();

    let mut store = CoreStore::open(&dir.store()).unwrap();
    assert_eq!(store.schema_version().unwrap(), 6);
    let after: Vec<_> = tables
        .iter()
        .map(|table| dump(&store.conn, table))
        .collect();
    assert_eq!(after, before, "every row kept");
    for table in [
        "learning_evidence",
        "learning_experiences",
        "learning_experience_evidence",
        "learning_candidates",
        "learning_candidate_experiences",
        "learning_candidate_evidence",
        "learning_candidate_decisions",
    ] {
        assert!(dump(&store.conn, table).is_empty(), "{table}");
    }
    // The new tables bind to the existing mission and task of the same profile only.
    let evidence = |profile: &str, kind: &str, trust: &str, by: &str| {
        store.conn.execute(
            "INSERT INTO learning_evidence (profile_id, mission_id, task_id, kind, claim, trust_status,
               digest, ref, masked_count, recorded_by, observed_at)
             VALUES (?1, ?2, ?3, ?4, 'success', ?5, ?6, 'gate:1', 0, ?7, 't')",
            params![profile, MISSION, TASK, kind, trust, DIGEST, by],
        )
    };
    evidence("default", "test_gate", "verified", "extalia:integration").unwrap();
    assert!(evidence("work", "user_confirmation", "verified", "user:local").is_err());
    assert!(evidence("default", "observed_claim", "verified", "extalia:observer").is_err());
    assert!(
        store
            .conn
            .execute("DELETE FROM learning_evidence", [])
            .is_err()
    );
    super::migrate::verify_schema(store.connection(), MIGRATIONS).unwrap();
    super::migrate::verify_integrity(store.connection()).unwrap();
    store.close().unwrap();

    let copies = backups(&dir.0);
    assert_eq!(copies.len(), 1, "backed up before migrating");
    let name = copies[0]
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert!(name.starts_with("core.sqlite.bak-5-"), "{name}");
    let copy = raw(&copies[0]);
    assert_eq!(version_of(&copy), 5);
    super::migrate::verify_schema(&copy, &MIGRATIONS[..5]).unwrap();
    assert_eq!(dump(&copy, "missions"), before[0]);
    drop(copy);
    CoreStore::open(&dir.store()).unwrap().close().unwrap();
    assert_eq!(backups(&dir.0).len(), 1, "a reopen migrates nothing");
}

#[test]
fn schema_enforces_profiles_sequences_and_event_ids() {
    let dir = TempDir::new();
    let store = CoreStore::open(&dir.store()).unwrap();
    let conn = &store.conn;
    insert_mission(conn, MISSION, "default").unwrap();
    insert_mission(conn, OTHER_MISSION, "work").unwrap();
    assert!(
        insert_mission(conn, MISSION, "default").is_err(),
        "mission id is unique"
    );

    insert_event(conn, EVENT, "default", 1).unwrap();
    assert!(
        insert_event(conn, EVENT, "default", 2).is_err(),
        "event id is unique"
    );
    assert!(
        insert_event(conn, "00000000-0000-4000-8000-000000000014", "default", 1).is_err(),
        "per-mission sequence is unique"
    );
    assert!(
        insert_event(conn, "00000000-0000-4000-8000-000000000015", "work", 2).is_err(),
        "an event cannot belong to another profile than its mission"
    );
    assert!(
        insert_event(conn, "00000000-0000-4000-8000-000000000016", "default", 0).is_err(),
        "sequences start at 1"
    );
    let oversize = "x".repeat(4097);
    assert!(
        conn.execute(
            "INSERT INTO events (event_id, profile_id, mission_id, sequence, event_type, committed_at, digest, payload)
             VALUES ('00000000-0000-4000-8000-000000000017', 'default', ?1, 2, 'task.state', 't', ?2, ?3)",
            params![MISSION, DIGEST, oversize],
        )
        .is_err(),
        "events are capped at 4 KiB"
    );

    let task = |mission: &str, profile: &str| {
        conn.execute(
            "INSERT INTO tasks (task_id, profile_id, mission_id, state, attempt, updated_at, digest, payload)
             VALUES (?1, ?2, ?3, 'queued', 0, 't', ?4, '{}')",
            params![TASK, profile, mission, DIGEST],
        )
    };
    assert!(
        task(MISSION, "work").is_err(),
        "task profile must match its mission"
    );
    assert!(
        task("00000000-0000-4000-8000-000000000099", "default").is_err(),
        "unknown mission"
    );
    task(MISSION, "default").unwrap();
    conn.execute(
        "INSERT INTO leases (lease_id, profile_id, task_id, holder_agent_id, acquired_at, expires_at)
         VALUES ('00000000-0000-4000-8000-000000000030', 'default', ?1, ?2, 't', 'u')",
        params![TASK, WORKSPACE],
    )
    .unwrap();

    conn.execute("DELETE FROM missions WHERE mission_id = ?1", [MISSION])
        .unwrap();
    for table in ["tasks", "events", "leases"] {
        let left: i64 = conn
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(left, 0, "{table} cascade with their mission");
    }
}

#[test]
fn rejects_in_memory_and_empty_paths() {
    assert!(matches!(
        CoreStore::open(Path::new("")),
        Err(StoreError::InvalidPath)
    ));
    assert!(matches!(
        CoreStore::open(Path::new(":memory:")),
        Err(StoreError::InvalidPath)
    ));
}

#[cfg(unix)]
#[test]
fn store_files_and_backups_are_private() {
    use std::os::unix::fs::PermissionsExt;
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    let dir = TempDir::new();
    fs::create_dir_all(dir.0.join("state")).unwrap();
    fs::set_permissions(dir.0.join("state"), fs::Permissions::from_mode(0o755)).unwrap();
    CoreStore::open(&dir.store()).unwrap().close().unwrap();
    let store = CoreStore::open_with(&dir.store(), &plus(SECOND)).unwrap();
    assert_eq!(mode(&dir.0.join("state")), 0o700);
    assert_eq!(mode(&dir.store()), 0o600);
    assert_eq!(mode(&super::sibling(&dir.store(), "-wal")), 0o600);
    assert_eq!(mode(&super::sibling(&dir.store(), "-shm")), 0o600);
    for copy in backups(&dir.0) {
        assert_eq!(mode(&copy), 0o600);
    }
    store.close().unwrap();
}

#[cfg(unix)]
#[test]
fn refuses_a_symlinked_store() {
    let dir = TempDir::new();
    fs::create_dir_all(dir.0.join("state")).unwrap();
    let target = dir.0.join("elsewhere.sqlite");
    fs::write(&target, b"").unwrap();
    std::os::unix::fs::symlink(&target, dir.store()).unwrap();
    assert!(matches!(
        CoreStore::open(&dir.store()),
        Err(StoreError::InvalidPath)
    ));
}
