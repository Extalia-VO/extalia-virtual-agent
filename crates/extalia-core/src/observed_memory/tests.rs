use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "extalia-observed-memory-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&dir).unwrap();
        Self(fs::canonicalize(dir).unwrap())
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
    json!({"profileId":"default","workspaceId":"workspace-one","sessionId":"observed-one","sourceId":"codex","nativeSessionId":"native-one","boundary":"a".repeat(64)})
}
fn input() -> Value {
    json!({"scope":scope(),"episodeId":"terminal-one","sourceRevision":"source-r1","entries":[{"id":"prompt-one","kind":"user","text":"Preserve row order and limit batch size to 73."},{"id":"answer-one","kind":"assistant","text":"I claim all tests passed; still needs independent verification."}],"coverage":{"mode":"partial","omittedEntries":0,"truncated":false,"limits":["Only visible transcript events."]}})
}
fn read_args(episode: &Value) -> Value {
    json!({"scope":scope(),"episodeId":episode["id"],"revision":episode["revision"],"limit":32})
}
#[test]
fn persists_deduplicates_and_reads_attributed_claims_after_restart() {
    let temp = Temp::new();
    let mut store = ObservedMemoryStore::open(&temp.0, &profile()).unwrap();
    let first = store.capture(&input()).unwrap();
    assert_eq!(first["created"], true);
    assert_eq!(first["episode"]["trust"], "untrusted-observed");
    assert_eq!(first["episode"]["entries"], 2);
    assert_eq!(store.capture(&input()).unwrap()["created"], false);
    drop(store);
    let mut reopened = ObservedMemoryStore::open(&temp.0, &profile()).unwrap();
    assert_eq!(reopened.capture(&input()).unwrap()["created"], false);
    let found = reopened
        .search(&json!({"scope":scope(),"query":"batch 73"}))
        .unwrap();
    assert_eq!(found["hits"].as_array().unwrap().len(), 1);
    let page = reopened.read(&read_args(&first["episode"])).unwrap();
    assert_eq!(page["entries"][1]["kind"], "assistant");
    assert!(page.to_string().contains("I claim"));
    assert_eq!(page["episode"]["coverage"]["mode"], "partial");
}
#[test]
fn rejects_foreign_profile_workspace_native_and_boundary_reads() {
    let temp = Temp::new();
    let mut store = ObservedMemoryStore::open(&temp.0, &profile()).unwrap();
    let episode = store.capture(&input()).unwrap()["episode"].clone();
    for (key, value) in [
        ("profileId", "another-profile"),
        ("workspaceId", "workspace-two"),
        ("nativeSessionId", "native-two"),
        ("boundary", &"b".repeat(64)),
    ] {
        let mut args = read_args(&episode);
        args["scope"][key] = value.into();
        assert!(store.read(&args).is_err());
        let search = store.search(&json!({"scope":args["scope"],"query":"73"}));
        assert!(search.is_err() || search.unwrap()["hits"].as_array().unwrap().is_empty());
    }
    let other = ProfileId::parse("another-profile").unwrap();
    let second = ObservedMemoryStore::open(&temp.0, &other).unwrap();
    let mut own = scope();
    own["profileId"] = "another-profile".into();
    assert_eq!(
        second.search(&json!({"scope":own,"query":"73"})).unwrap()["hits"],
        json!([])
    );
}
#[test]
fn protects_immutable_episode_revision_and_alias_idempotency() {
    let temp = Temp::new();
    let mut store = ObservedMemoryStore::open(&temp.0, &profile()).unwrap();
    let first = store.capture(&input()).unwrap();
    let mut changed = input();
    changed["entries"][0]["text"] = "A conflicting edit".into();
    assert!(store.capture(&changed).is_err());
    let mut alias = input();
    alias["scope"]["sessionId"] = "observed-alias".into();
    let duplicate = store.capture(&alias).unwrap();
    assert_eq!(duplicate["created"], false);
    assert_eq!(duplicate["episode"]["id"], first["episode"]["id"]);
    let mut args = read_args(&first["episode"]);
    args["revision"] = "b".repeat(64).into();
    assert!(store.read(&args).is_err());
    args = read_args(&first["episode"]);
    args["scope"]["sessionId"] = "observed-alias".into();
    assert_eq!(store.read(&args).unwrap()["total"], 2);
}
#[test]
fn rust_masks_credentials_and_marks_clipped_unicode_evidence() {
    let temp = Temp::new();
    let mut store = ObservedMemoryStore::open(&temp.0, &profile()).unwrap();
    let mut raw = input();
    let secret = ["sk-", "abcdefghijklmnop1234"].concat();
    raw["entries"][0]["text"] = format!("key {secret} {}", "🦀".repeat(1100)).into();
    let episode = store.capture(&raw).unwrap()["episode"].clone();
    assert_eq!(episode["coverage"]["truncated"], true);
    let page = store.read(&read_args(&episode)).unwrap();
    let body = text(&page["entries"][0], "text");
    assert!(!body.contains(&secret));
    assert!(body.contains("[redacted]"));
    assert!(body.encode_utf16().count() <= 2000);
    let file = temp.0.join("profiles/default/observed-memory.sqlite");
    assert!(
        !fs::read(&file)
            .unwrap()
            .windows(secret.len())
            .any(|w| w == secret.as_bytes())
    );
}
#[test]
fn revision_aware_paging_and_scope_revocation_are_bounded() {
    let temp = Temp::new();
    let mut store = ObservedMemoryStore::open(&temp.0, &profile()).unwrap();
    let episode = store.capture(&input()).unwrap()["episode"].clone();
    let mut args = read_args(&episode);
    args["limit"] = 1.into();
    let page = store.read(&args).unwrap();
    assert_eq!(page["entries"].as_array().unwrap().len(), 1);
    assert_eq!(page["nextOffset"], 1);
    args["offset"] = 1.into();
    assert!(store.read(&args).unwrap().get("nextOffset").is_none());
    args["limit"] = 33.into();
    assert!(store.read(&args).is_err());
    let mut wrong = scope();
    wrong["workspaceId"] = "workspace-two".into();
    assert_eq!(store.revoke(&wrong).unwrap()["removed"], 0);
    assert_eq!(store.revoke(&scope()).unwrap()["removed"], 1);
    assert!(store.read(&read_args(&episode)).is_err());
    assert_eq!(
        store.search(&json!({"scope":scope(),"query":""})).unwrap()["hits"],
        json!([])
    );
}
#[test]
fn source_capacity_refuses_without_silent_eviction_or_duplicate_escape() {
    let temp = Temp::new();
    let mut store = ObservedMemoryStore::open(&temp.0, &profile()).unwrap();
    for index in 0..SOURCE_LIMIT {
        let mut raw = input();
        raw["episodeId"] = format!("terminal-{index}").into();
        store.capture(&raw).unwrap();
    }
    let mut extra = input();
    extra["episodeId"] = "over-capacity".into();
    assert!(matches!(
        store.capture(&extra),
        Err(ObservedMemoryError::Denied("capacity_reached"))
    ));
    extra["episodeId"] = "terminal-0".into();
    assert_eq!(store.capture(&extra).unwrap()["created"], false);
    let search = store
        .search(&json!({"scope":scope(),"query":"73","limit":3}))
        .unwrap();
    assert_eq!(search["hits"].as_array().unwrap().len(), 3);
    assert_eq!(search["omitted"], SOURCE_LIMIT - 3);
}
#[test]
fn rejects_foreign_schema_and_holds_single_writer_lock() {
    let temp = Temp::new();
    let store = ObservedMemoryStore::open(&temp.0, &profile()).unwrap();
    assert!(matches!(
        ObservedMemoryStore::open(&temp.0, &profile()),
        Err(ObservedMemoryError::Denied("locked"))
    ));
    drop(store);
    let file = temp.0.join("profiles/default/observed-memory.sqlite");
    let conn = Connection::open(&file).unwrap();
    conn.execute_batch("CREATE TABLE foreign_data (body TEXT)")
        .unwrap();
    drop(conn);
    assert!(matches!(
        ObservedMemoryStore::open(&temp.0, &profile()),
        Err(ObservedMemoryError::Denied("schema_mismatch"))
    ));
    let conn = Connection::open(file).unwrap();
    assert!(conn.prepare("SELECT body FROM foreign_data").is_ok());
}
#[cfg(unix)]
#[test]
fn refuses_symlinked_profile_and_store_paths() {
    use std::os::unix::fs::symlink;
    let temp = Temp::new();
    let outside = Temp::new();
    fs::create_dir(temp.0.join("profiles")).unwrap();
    symlink(&outside.0, temp.0.join("profiles/default")).unwrap();
    assert!(ObservedMemoryStore::open(&temp.0, &profile()).is_err());
    fs::remove_file(temp.0.join("profiles/default")).unwrap();
    fs::create_dir(temp.0.join("profiles/default")).unwrap();
    let target = outside.0.join("foreign.sqlite");
    fs::write(&target, b"unchanged").unwrap();
    symlink(
        &target,
        temp.0.join("profiles/default/observed-memory.sqlite"),
    )
    .unwrap();
    assert!(ObservedMemoryStore::open(&temp.0, &profile()).is_err());
    assert_eq!(fs::read(target).unwrap(), b"unchanged");
}

#[test]
fn refuses_record_text_tampering_without_valid_digest() {
    let temp = Temp::new();
    let mut store = ObservedMemoryStore::open(&temp.0, &profile()).unwrap();
    let episode = store.capture(&input()).unwrap()["episode"].clone();
    let original: String = store
        .conn
        .query_row(
            "SELECT record_json FROM observed_episodes WHERE id=?1",
            [text(&episode, "id")],
            |r| r.get(0),
        )
        .unwrap();
    let mut altered: Value = serde_json::from_str(&original).unwrap();
    altered["entries"][0]["text"] = "A changed source claim".into();
    store
        .conn
        .execute(
            "UPDATE observed_episodes SET record_json=?1 WHERE id=?2",
            params![altered.to_string(), text(&episode, "id")],
        )
        .unwrap();
    assert!(store.read(&read_args(&episode)).is_err());
    assert!(
        store
            .search(&json!({"scope":scope(),"query":"73"}))
            .is_err()
    );
    assert!(store.capture(&input()).is_err());
}

#[cfg(unix)]
#[test]
fn cached_store_refuses_profile_directory_replacement() {
    let temp = Temp::new();
    let mut store = ObservedMemoryStore::open(&temp.0, &profile()).unwrap();
    let episode = store.capture(&input()).unwrap()["episode"].clone();
    let directory = temp.0.join("profiles/default");
    let old = temp.0.join("profiles/previous-profile-directory");
    fs::rename(&directory, &old).unwrap();
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("observed-memory.sqlite"), b"replacement").unwrap();
    assert!(store.capture(&input()).is_err());
    assert!(store.read(&read_args(&episode)).is_err());
    assert!(
        store
            .search(&json!({"scope":scope(),"query":"73"}))
            .is_err()
    );
    assert!(store.revoke(&scope()).is_err());
}
