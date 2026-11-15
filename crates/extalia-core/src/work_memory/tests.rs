use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "extalia-work-memory-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn profile() -> ProfileId {
    ProfileId::parse("default").unwrap()
}
fn scope() -> Value {
    json!({"profileId":"default","workspaceId":"workspace-one","boundary":"a".repeat(64)})
}
fn input() -> Value {
    json!({"scope":scope(),"source":{"kind":"native","sourceId":"extalia-native","sessionId":"session-one","episodeId":"turn-one","revision":"b".repeat(64)},"outcome":"completed","title":"Parser preserves row order","summary":"Batch processing keeps the first duplicate and uses limit 73.","entries":[{"id":"request-one","kind":"user","text":"Keep row order when removing duplicates."},{"id":"result-one","kind":"tool","text":"Parser regression check: duplicate order and batch limit 73 passed."}],"coverage":{"mode":"partial","omittedEntries":0,"truncated":false,"limits":["Only visible tool outcomes are retained."]}})
}
fn read_args(record: &Value) -> Value {
    json!({"scope":scope(),"id":record["id"],"revision":record["revision"],"limit":32})
}
fn search(store: &WorkMemoryStore, query: &str) -> Value {
    store
        .search(&json!({"scope":scope(),"query":query}))
        .unwrap()
}

#[test]
fn atomic_capture_replays_after_restart_and_recalls_from_another_session() {
    let temp = Temp::new();
    let mut store = WorkMemoryStore::open(&temp.0, &profile()).unwrap();
    let first = store.capture(&input()).unwrap();
    assert_eq!(first["created"], true);
    assert_eq!(first["record"]["trust"], "attributed-evidence");
    drop(store);
    let mut reopened = WorkMemoryStore::open(&temp.0, &profile()).unwrap();
    let replay = reopened.capture(&input()).unwrap();
    assert_eq!(replay["created"], false);
    assert_eq!(replay["record"], first["record"]);
    assert_eq!(
        search(&reopened, "duplicate batch 73")["hits"][0]["record"],
        first["record"]
    );
    let mut another = input();
    another["source"]["sessionId"] = "session-two".into();
    assert_eq!(reopened.capture(&another).unwrap()["created"], true);
    assert_eq!(
        search(&reopened, "duplicate")["hits"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        reopened.read(&read_args(&first["record"])).unwrap()["total"],
        2
    );
}

#[test]
fn scope_profile_and_boundary_guards_exclude_other_workspaces() {
    let temp = Temp::new();
    let mut store = WorkMemoryStore::open(&temp.0, &profile()).unwrap();
    let record = store.capture(&input()).unwrap()["record"].clone();
    for (field, value) in [
        ("profileId", "profile-other"),
        ("workspaceId", "workspace-other"),
        ("boundary", &"c".repeat(64)),
    ] {
        let mut args = read_args(&record);
        args["scope"][field] = value.into();
        assert!(store.read(&args).is_err());
        let result = store.search(&json!({"scope":args["scope"],"query":"parser"}));
        assert!(result.is_err() || result.unwrap()["hits"] == json!([]));
    }
    let mut second = input();
    second["scope"]["workspaceId"] = "workspace-other".into();
    second["title"] = "private amphibian findings".into();
    second["summary"] = "Only another workspace".into();
    store.capture(&second).unwrap();
    assert_eq!(search(&store, "amphibian")["hits"], json!([]));
}

#[test]
fn observed_records_require_current_source_allowlist_on_search_and_read() {
    let temp = Temp::new();
    let mut store = WorkMemoryStore::open(&temp.0, &profile()).unwrap();
    let native = store.capture(&input()).unwrap()["record"].clone();
    let mut observed = input();
    observed["source"]["kind"] = "observed".into();
    assert!(store.capture(&observed).is_err());
    observed["source"]["accessKey"] = "c".repeat(64).into();
    observed["source"]["sourceId"] = "external-agent".into();
    let record = store.capture(&observed).unwrap()["record"].clone();
    assert_eq!(
        search(&store, "parser")["hits"].as_array().unwrap().len(),
        1
    );
    let mut query = json!({"scope":scope(),"query":"parser","observedSourceKeys":["d".repeat(64)]});
    assert_eq!(
        store.search(&query).unwrap()["hits"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    query["observedSourceKeys"] = json!(["c".repeat(64)]);
    assert_eq!(
        store.search(&query).unwrap()["hits"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let mut read = read_args(&record);
    assert!(store.read(&read).is_err());
    read["observedSourceKeys"] = json!(["c".repeat(64)]);
    assert_eq!(store.read(&read).unwrap()["record"]["id"], record["id"]);
    let removed = store.revoke(&json!({"scope":scope(),"sourceKind":"observed","sessionId":"session-one","episodeId":"turn-one","accessKey":"c".repeat(64)})).unwrap();
    assert_eq!(removed["removed"], 1);
    assert!(store.read(&read).is_err());
    assert_eq!(
        store.search(&query).unwrap()["hits"][0]["record"]["id"],
        native["id"]
    );
}

#[test]
fn failed_and_cancelled_outcomes_remain_attributed_reusable_evidence() {
    let temp = Temp::new();
    let mut store = WorkMemoryStore::open(&temp.0, &profile()).unwrap();
    for outcome in ["failed", "cancelled"] {
        let mut args = input();
        args["source"]["episodeId"] = outcome.into();
        args["outcome"] = outcome.into();
        args["title"] = format!("Parser attempt {outcome}").into();
        args["summary"] =
            "Attempt stopped before independent verification. Retry must recheck the cause.".into();
        let result = store.capture(&args).unwrap();
        assert_eq!(result["record"]["outcome"], outcome);
        assert_eq!(result["record"]["trust"], "attributed-evidence");
    }
    assert_eq!(
        search(&store, "attempt")["hits"].as_array().unwrap().len(),
        2
    );
}

#[test]
fn conflicting_replays_and_stale_revisions_cannot_replace_or_read_records() {
    let temp = Temp::new();
    let mut store = WorkMemoryStore::open(&temp.0, &profile()).unwrap();
    let record = store.capture(&input()).unwrap()["record"].clone();
    for field in ["title", "summary", "outcome"] {
        let mut changed = input();
        changed[field] = if field == "outcome" {
            "failed"
        } else {
            "Changed evidence"
        }
        .into();
        assert!(matches!(
            store.capture(&changed),
            Err(WorkMemoryError::Denied("record_conflict"))
        ));
    }
    let mut changed = input();
    changed["source"]["revision"] = "c".repeat(64).into();
    assert!(store.capture(&changed).is_err());
    let mut read = read_args(&record);
    read["revision"] = "d".repeat(64).into();
    assert!(store.read(&read).is_err());
    assert_eq!(store.capture(&input()).unwrap()["record"], record);
}

#[test]
fn credentials_and_control_characters_are_removed_before_fts_and_storage() {
    let temp = Temp::new();
    let mut store = WorkMemoryStore::open(&temp.0, &profile()).unwrap();
    let secret = format!("sk-{}", "x".repeat(48));
    let mut args = input();
    args["title"] = format!("Credential {secret}").into();
    args["summary"] = format!("Bearer {secret}").into();
    args["entries"][0]["text"] = format!("API key {secret}\0 safe text").into();
    let record = store.capture(&args).unwrap()["record"].clone();
    let page = store.read(&read_args(&record)).unwrap();
    assert!(!page.to_string().contains(&secret));
    assert!(!page["entries"][0]["text"].as_str().unwrap().contains('\0'));
    assert_eq!(search(&store, &"x".repeat(48))["hits"], json!([]));
    assert!(
        search(&store, "credential safe")["hits"]
            .as_array()
            .unwrap()
            .len()
            == 1
    );
}

#[test]
fn bounded_unicode_pages_and_coverage_report_truncation() {
    let temp = Temp::new();
    let mut store = WorkMemoryStore::open(&temp.0, &profile()).unwrap();
    let mut args = input();
    args["entries"][0]["text"] = "🦊".repeat(2000).into();
    let record = store.capture(&args).unwrap()["record"].clone();
    assert_eq!(record["coverage"]["truncated"], true);
    let mut read = read_args(&record);
    read["limit"] = 1.into();
    let page = store.read(&read).unwrap();
    assert_eq!(page["nextOffset"], 1);
    assert_eq!(
        text(&page["entries"][0], "text").encode_utf16().count(),
        2000
    );
    read["offset"] = 1.into();
    assert_eq!(store.read(&read).unwrap()["entries"][0]["id"], "result-one");
    read["offset"] = 3.into();
    assert!(store.read(&read).is_err());
    args["entries"][0]["text"] = "🦊".repeat(4001).into();
    assert!(store.capture(&args).is_err());
}

#[test]
fn fts_operators_and_punctuation_cannot_escape_scope_or_run_query_syntax() {
    let temp = Temp::new();
    let mut store = WorkMemoryStore::open(&temp.0, &profile()).unwrap();
    store.capture(&input()).unwrap();
    for query in [
        "\"",
        "*",
        "NEAR(",
        "title:parser OR scope_key:*",
        "parser'; DROP TABLE work_memory_records; --",
        "修正 parser",
        "dan yang untuk",
    ] {
        let result = search(&store, query);
        assert!(result["hits"].as_array().unwrap().len() <= 1);
    }
    assert_eq!(search(&store, "the and dan yang")["hits"], json!([]));
    assert_eq!(
        search(&store, "parser")["hits"].as_array().unwrap().len(),
        1
    );
}

#[test]
fn explicit_capacity_refusal_keeps_old_records_and_exact_revoke_frees_space() {
    let temp = Temp::new();
    let mut store = WorkMemoryStore::open(&temp.0, &profile()).unwrap();
    // Fill only the bounded row-count gate; these sentinels are never retrieved.
    let key = scope_key(&scope(), &profile()).unwrap();
    for n in 0..SCOPE_LIMIT {
        store.conn.execute("INSERT INTO work_memory_records(id,scope_key,source_kind,source_id,source_session,source_episode,source_access,revision,captured_at,record_json) VALUES(?1,?2,'native','source','older',?1,'','',0,'{}')",params![format!("sentinel-{n}"),key]).unwrap();
    }
    assert!(matches!(
        store.capture(&input()),
        Err(WorkMemoryError::Denied("capacity_reached"))
    ));
    assert_eq!(store.revoke(&json!({"scope":scope(),"sourceKind":"native","sessionId":"older","episodeId":"sentinel-0"})).unwrap()["removed"],1);
    assert_eq!(store.capture(&input()).unwrap()["created"], true);
    assert_eq!(store.capture(&input()).unwrap()["created"], false);
}

#[test]
fn corrupt_record_and_foreign_or_changed_schema_are_not_reset_or_returned() {
    let temp = Temp::new();
    let mut store = WorkMemoryStore::open(&temp.0, &profile()).unwrap();
    let record = store.capture(&input()).unwrap()["record"].clone();
    store
        .conn
        .execute("UPDATE work_memory_records SET record_json='{}'", [])
        .unwrap();
    assert!(store.read(&read_args(&record)).is_err());
    assert!(
        store
            .search(&json!({"scope":scope(),"query":"parser"}))
            .is_err()
    );
    store
        .conn
        .execute_batch("CREATE TABLE foreign_table(value TEXT)")
        .unwrap();
    drop(store);
    assert!(WorkMemoryStore::open(&temp.0, &profile()).is_err());
    let file = temp.0.join("profiles/default/work-memory.sqlite");
    let conn = Connection::open(file).unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM work_memory_records", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn locked_store_refuses_second_owner() {
    let temp = Temp::new();
    let first = WorkMemoryStore::open(&temp.0, &profile()).unwrap();
    assert!(WorkMemoryStore::open(&temp.0, &profile()).is_err());
    drop(first);
    assert!(WorkMemoryStore::open(&temp.0, &profile()).is_ok());
}

#[test]
fn exact_source_revoke_retains_another_provider_with_the_same_turn_labels() {
    let temp = Temp::new();
    let mut store = WorkMemoryStore::open(&temp.0, &profile()).unwrap();
    let first = store.capture(&input()).unwrap()["record"].clone();
    let mut other = input();
    other["source"]["sourceId"] = "other-connection".into();
    let retained = store.capture(&other).unwrap()["record"].clone();
    assert_eq!(store.revoke(&json!({"scope":scope(),"sourceKind":"native","sourceId":"extalia-native","sessionId":"session-one","episodeId":"turn-one"})).unwrap()["removed"],1);
    assert!(store.read(&read_args(&first)).is_err());
    assert_eq!(
        store.read(&read_args(&retained)).unwrap()["record"],
        retained
    );
}

#[cfg(unix)]
#[test]
fn profile_symlinks_and_database_hardlinks_are_refused() {
    use std::os::unix::fs::symlink;
    let temp = Temp::new();
    fs::create_dir(temp.0.join("profiles")).unwrap();
    let other = temp.0.join("other");
    fs::create_dir(&other).unwrap();
    symlink(&other, temp.0.join("profiles/default")).unwrap();
    assert!(WorkMemoryStore::open(&temp.0, &profile()).is_err());
    fs::remove_file(temp.0.join("profiles/default")).unwrap();
    let first = WorkMemoryStore::open(&temp.0, &profile()).unwrap();
    drop(first);
    fs::hard_link(
        temp.0.join("profiles/default/work-memory.sqlite"),
        temp.0.join("alias.sqlite"),
    )
    .unwrap();
    assert!(WorkMemoryStore::open(&temp.0, &profile()).is_err());
}
