use super::*;

struct Store(PathBuf);
impl Store {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("extalia-receipts-{}", uid()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn owner(&self) -> Learning {
        Learning::new(&self.0, "default")
    }
    fn folder(&self) -> PathBuf {
        self.0.join("automatic-learning")
    }
    fn admission(&self, input: &Value) -> PathBuf {
        self.folder().join(format!(
            "{}-{}.json",
            hash(s(input, "profileId")),
            s(input, "contentSha256")
        ))
    }
    fn confirmation(&self, input: &Value) -> PathBuf {
        self.folder().join(format!(
            "{}-{}.confirmed.json",
            hash(s(input, "profileId")),
            s(input, "contentSha256")
        ))
    }
}
impl Drop for Store {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn input() -> Value {
    json!({"profileId":"profile-example","contentSha256":hash("example-note"),"runId":"run-example"})
}
fn lookup(input: &Value) -> Value {
    json!({"profileId":input["profileId"],"contentSha256":input["contentSha256"]})
}
fn confirmation(input: &Value) -> Value {
    let mut input = input.clone();
    input["receipt"] = json!({"kind":"note","data":json!({"path":"Learning/workspace/run-example.md"}).to_string()});
    input
}
fn request(action: &str, input: Value) -> Value {
    json!({"action":action,"input":input})
}
fn run(owner: &mut Learning, action: &str, input: Value) -> Value {
    match owner.handle(&request(action, input)).unwrap() {
        ResponseResult::Learning(result) => result,
        _ => panic!("unexpected receipt result"),
    }
}

#[test]
fn receipts_require_admission_and_missing_reads_do_not_create_state() {
    let store = Store::new();
    let mut owner = store.owner();
    let input = input();
    assert_eq!(
        run(&mut owner, "receipt.get", lookup(&input))["status"],
        "missing"
    );
    assert!(!store.folder().exists());
    assert!(
        owner
            .handle(&request("receipt.record", confirmation(&input)))
            .is_err()
    );
    assert!(!store.folder().exists());
}

#[test]
fn confirmed_receipt_survives_restart_and_duplicate_acknowledgement() {
    let store = Store::new();
    let mut owner = store.owner();
    let input = input();
    assert_eq!(
        run(&mut owner, "receipt.claim", input.clone())["claimed"],
        true
    );
    let admission = std::fs::read(store.admission(&input)).unwrap();
    drop(owner);
    let mut owner = store.owner();
    let attempted = run(&mut owner, "receipt.get", lookup(&input));
    assert_eq!(attempted["status"], "attempted");
    assert!(attempted.get("receipt").is_none());
    let record = confirmation(&input);
    assert_eq!(
        run(&mut owner, "receipt.record", record.clone())["replayed"],
        false
    );
    assert_eq!(std::fs::read(store.admission(&input)).unwrap(), admission);
    drop(owner);
    let mut owner = store.owner();
    let recorded = run(&mut owner, "receipt.get", lookup(&input));
    assert_eq!(recorded["status"], "recorded");
    assert_eq!(recorded["receipt"], record["receipt"]);
    assert_eq!(run(&mut owner, "receipt.record", record)["replayed"], true);
    assert_eq!(
        run(&mut owner, "receipt.claim", input.clone())["claimed"],
        false
    );
    assert_eq!(std::fs::read(store.admission(&input)).unwrap(), admission);
    let bytes = std::fs::read_to_string(store.confirmation(&input)).unwrap();
    assert!(!bytes.contains("profile-example"));
    assert!(!bytes.contains("\"runId\""));
    assert_eq!(std::fs::read_dir(store.folder()).unwrap().count(), 2);
}

#[test]
fn receipt_confirmation_cannot_change_claim_identity_or_committed_artifact() {
    let store = Store::new();
    let mut owner = store.owner();
    let input = input();
    run(&mut owner, "receipt.claim", input.clone());
    for (field, value) in [
        ("runId", json!("another-run")),
        ("profileId", json!("another-profile")),
        ("contentSha256", json!(hash("another-content"))),
    ] {
        let mut changed = confirmation(&input);
        changed[field] = value;
        assert!(owner.handle(&request("receipt.record", changed)).is_err());
    }
    assert_eq!(
        run(&mut owner, "receipt.get", lookup(&input))["status"],
        "attempted"
    );
    let record = confirmation(&input);
    run(&mut owner, "receipt.record", record.clone());
    let before = std::fs::read(store.confirmation(&input)).unwrap();
    let mut changed = record.clone();
    changed["receipt"]["data"] = json!({"path":"Learning/workspace/another.md"})
        .to_string()
        .into();
    assert!(owner.handle(&request("receipt.record", changed)).is_err());
    assert_eq!(std::fs::read(store.confirmation(&input)).unwrap(), before);
    assert_eq!(
        run(&mut owner, "receipt.get", lookup(&input))["receipt"],
        record["receipt"]
    );
}

#[test]
fn independent_artifact_receipts_preserve_partial_success() {
    let store = Store::new();
    let mut owner = store.owner();
    let note = input();
    let mut skill = input();
    skill["contentSha256"] = hash("skill:example").into();
    run(&mut owner, "receipt.claim", note.clone());
    run(&mut owner, "receipt.claim", skill.clone());
    run(&mut owner, "receipt.record", confirmation(&note));
    drop(owner);
    let mut owner = store.owner();
    assert_eq!(
        run(&mut owner, "receipt.get", lookup(&note))["status"],
        "recorded"
    );
    assert_eq!(
        run(&mut owner, "receipt.get", lookup(&skill))["status"],
        "attempted"
    );
    assert_eq!(
        run(&mut owner, "receipt.claim", skill.clone())["claimed"],
        false
    );
    let mut record = skill.clone();
    record["receipt"] = json!({"kind":"skill","data":json!({"packageId":"package-example","revisionId":"revision-example","activationPerformed":false}).to_string()});
    run(&mut owner, "receipt.record", record.clone());
    assert_eq!(
        run(&mut owner, "receipt.get", lookup(&skill))["receipt"],
        record["receipt"]
    );
}

#[test]
fn malformed_or_orphaned_receipts_never_become_success_or_replay() {
    let input = input();
    for corrupt_admission in [true, false] {
        let store = Store::new();
        let mut owner = store.owner();
        run(&mut owner, "receipt.claim", input.clone());
        let path = if corrupt_admission {
            store.admission(&input)
        } else {
            store.confirmation(&input)
        };
        std::fs::write(&path, b"{unfinished").unwrap();
        assert!(
            owner
                .handle(&request("receipt.get", lookup(&input)))
                .is_err()
        );
        assert!(
            owner
                .handle(&request("receipt.record", confirmation(&input)))
                .is_err()
        );
        assert_eq!(
            run(&mut owner, "receipt.claim", input.clone())["claimed"],
            false
        );
        assert_eq!(std::fs::read(path).unwrap(), b"{unfinished");
    }
    let store = Store::new();
    let mut owner = store.owner();
    run(&mut owner, "receipt.claim", input.clone());
    run(&mut owner, "receipt.record", confirmation(&input));
    std::fs::remove_file(store.admission(&input)).unwrap();
    assert!(
        owner
            .handle(&request("receipt.get", lookup(&input)))
            .is_err()
    );
    assert!(
        owner
            .handle(&request("receipt.record", confirmation(&input)))
            .is_err()
    );
}

#[test]
fn receipt_reads_and_records_refuse_symlinks_hardlinks_and_special_files() {
    use std::os::unix::fs::symlink;
    let input = input();
    for confirmation_target in [true, false] {
        let store = Store::new();
        let mut owner = store.owner();
        run(&mut owner, "receipt.claim", input.clone());
        let outside = store.0.join("outside.json");
        let target = if confirmation_target {
            store.confirmation(&input)
        } else {
            store.admission(&input)
        };
        if !confirmation_target {
            std::fs::rename(&target, &outside).unwrap();
        } else {
            std::fs::write(&outside, b"outside").unwrap();
        }
        let before = std::fs::read(&outside).unwrap();
        symlink(&outside, &target).unwrap();
        assert!(
            owner
                .handle(&request("receipt.get", lookup(&input)))
                .is_err()
        );
        assert!(
            owner
                .handle(&request("receipt.record", confirmation(&input)))
                .is_err()
        );
        assert_eq!(std::fs::read(&outside).unwrap(), before);
        std::fs::remove_file(&target).unwrap();
        std::fs::hard_link(&outside, &target).unwrap();
        assert!(
            owner
                .handle(&request("receipt.get", lookup(&input)))
                .is_err()
        );
        assert!(
            owner
                .handle(&request("receipt.record", confirmation(&input)))
                .is_err()
        );
        std::fs::remove_file(&target).unwrap();
        std::fs::create_dir(&target).unwrap();
        assert!(
            owner
                .handle(&request("receipt.get", lookup(&input)))
                .is_err()
        );
    }
    let store = Store::new();
    let mut owner = store.owner();
    let outside = store.0.join("outside");
    std::fs::create_dir(&outside).unwrap();
    symlink(&outside, store.folder()).unwrap();
    assert!(
        owner
            .handle(&request("receipt.get", lookup(&input)))
            .is_err()
    );
    assert!(
        owner
            .handle(&request("receipt.record", confirmation(&input)))
            .is_err()
    );
    assert_eq!(std::fs::read_dir(outside).unwrap().count(), 0);
}

#[test]
fn receipt_payloads_are_bounded_json_without_credentials_or_unsafe_note_paths() {
    let store = Store::new();
    let mut owner = store.owner();
    let input = input();
    run(&mut owner, "receipt.claim", input.clone());
    for data in [
        "[]".into(),
        "{unfinished".into(),
        json!({"path":"../outside.md"}).to_string(),
        json!({"path":"/outside.md"}).to_string(),
        json!({"path":"C:/outside.md"}).to_string(),
        json!({"path":"Learning/./note.md"}).to_string(),
        json!({"path":"Learning/note.md","token":"private-value"}).to_string(),
        json!({"path":"Learning/note.md","text":"界".repeat(3000)}).to_string(),
    ] {
        let mut record = confirmation(&input);
        record["receipt"]["data"] = data.into();
        assert!(owner.handle(&request("receipt.record", record)).is_err());
    }
    assert!(!store.confirmation(&input).exists());
    assert_eq!(
        run(&mut owner, "receipt.get", lookup(&input))["status"],
        "attempted"
    );
}

#[test]
fn confirmed_receipt_binding_is_validated_on_every_read() {
    let store = Store::new();
    let mut owner = store.owner();
    let input = input();
    run(&mut owner, "receipt.claim", input.clone());
    run(&mut owner, "receipt.record", confirmation(&input));
    let path = store.confirmation(&input);
    let original = std::fs::read_to_string(&path).unwrap();
    let original: Value = serde_json::from_str(&original).unwrap();
    for field in ["profileHash", "contentSha256", "runSha256"] {
        let mut corrupt = original.clone();
        corrupt[field] = hash("wrong-binding").into();
        std::fs::write(&path, corrupt.to_string()).unwrap();
        assert!(
            owner
                .handle(&request("receipt.get", lookup(&input)))
                .is_err()
        );
        assert!(
            owner
                .handle(&request("receipt.record", confirmation(&input)))
                .is_err()
        );
    }
}
