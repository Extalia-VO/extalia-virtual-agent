//! Synthetic deferred admission boundaries. No real profile, provider or vault.
use super::*;

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("extalia-learning-queue-{}", uid()));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn owner(&self) -> Learning {
        Learning::new(&self.0, "default")
    }
    fn folder(&self, record: &Value) -> PathBuf {
        self.0
            .join("learning-jobs")
            .join(hash("default"))
            .join(hash(s(record, "profileId")))
            .join(s(record, "jobId"))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn input() -> Value {
    json!({"profileId":"default","revision":"vault-r1","workspaceId":"workspace","sessionId":"session","runId":"run","promptSha256":"a".repeat(64),"routeFingerprint":"b".repeat(64),"policy":{"enabled":true,"skills":true,"notes":true},"evidence":[{"toolCallId":"source-1","name":"test_result","content":"Reported test output; retain uncertainty.","isError":false}],"sourceContext":{"user":"Keep the procedure reusable.","assistant":"The check was reported as successful."}})
}
fn tools() -> Value {
    json!([{"name":"knowledge_read","description":"Read an authorized note","parameters":{"type":"object"}}])
}
fn control(record: &Value) -> Value {
    let mut out = json!({});
    for key in [
        "profileId",
        "workspaceId",
        "sessionId",
        "runId",
        "promptSha256",
        "destinationRevision",
        "routeFingerprint",
        "policy",
        "observedSource",
        "jobId",
    ] {
        if let Some(value) = record.get(key) {
            out[key] = value.clone();
        }
    }
    out["queueRevision"] = record["queue"]["revision"].clone();
    out
}
fn admit(record: &Value) -> Value {
    let mut out = control(record);
    out["tools"] = tools();
    out
}
fn call(owner: &mut Learning, action: &str, input: Value) -> Result<Value> {
    match owner.handle(&json!({"action":action,"input":input}))? {
        ResponseResult::Learning(value) => Ok(value),
        _ => panic!("wrong learning result"),
    }
}
fn run(owner: &mut Learning, action: &str, input: Value) -> Value {
    call(owner, action, input).unwrap()
}
fn list(owner: &mut Learning) -> Value {
    run(owner, "job.list", json!({"profileId":"default"}))
}
fn capture(owner: &mut Learning) -> Value {
    run(owner, "queue.capture", input())["record"].clone()
}

#[test]
fn queue_survives_restart_with_zero_effects_and_the_same_source_identity() {
    let temp = Temp::new();
    let mut first = temp.owner();
    let record = capture(&mut first);
    assert_eq!(record["state"], "queued");
    assert_eq!(record["active"], false);
    assert_eq!(record["modelRequests"], 0);
    assert_eq!(record["reads"], 0);
    assert_eq!(record["queue"]["delaySeconds"], 60);
    assert!(first.jobs.is_empty() && first.pins.is_empty());
    assert!(record.get("evidence").is_none() && record.get("sourceContext").is_none());
    drop(first);
    let mut next = temp.owner();
    assert_eq!(list(&mut next)["jobs"][0], record);
    let job = run(&mut next, "queue.admit", admit(&record))["job"].clone();
    assert_eq!(job["jobId"], record["jobId"]);
    assert_eq!(job["status"], "running");
    assert_eq!(job["effect"]["kind"], "model");
    assert!(s(&job["effect"]["messages"][0], "text").contains("Keep the procedure reusable"));
    assert_eq!(list(&mut next)["jobs"][0]["modelRequests"], 1);
    assert!(next.pins.is_empty());
}

#[test]
fn capture_ack_loss_and_duplicate_source_delivery_never_fork_a_job() {
    let temp = Temp::new();
    let mut first = temp.owner();
    let original = capture(&mut first);
    drop(first);
    let mut next = temp.owner();
    let replay = run(&mut next, "queue.capture", input());
    assert_eq!(replay["created"], false);
    assert_eq!(replay["record"], original);
    let job = run(&mut next, "queue.admit", admit(&original))["job"].clone();
    let replay = run(&mut next, "queue.capture", input());
    assert_eq!(replay["created"], false);
    assert_eq!(replay["record"]["jobId"], job["jobId"]);
    assert_eq!(replay["record"]["state"], "resumable");
    assert_eq!(list(&mut next)["jobs"].as_array().unwrap().len(), 1);
}

#[test]
fn changed_capture_payload_cannot_rebind_an_existing_source() {
    let temp = Temp::new();
    let mut owner = temp.owner();
    capture(&mut owner);
    for key in [
        "revision",
        "routeFingerprint",
        "promptSha256",
        "evidence",
        "sourceContext",
        "policy",
    ] {
        let mut changed = input();
        changed[key] = match key {
            "routeFingerprint" | "promptSha256" => json!("c".repeat(64)),
            "evidence" => json!([]),
            "sourceContext" => json!({"user":"Changed source","assistant":"Different claim"}),
            "policy" => json!({"enabled":true,"notes":false,"skills":true}),
            _ => json!("changed-revision"),
        };
        assert_eq!(
            call(&mut owner, "queue.capture", changed).unwrap_err().1,
            Some("learning_queue_source_changed"),
            "{key}"
        );
    }
    assert_eq!(list(&mut owner)["jobs"].as_array().unwrap().len(), 1);
}

#[test]
fn every_admission_binding_is_rechecked_before_the_first_effect() {
    let temp = Temp::new();
    let mut owner = temp.owner();
    let record = capture(&mut owner);
    for key in [
        "workspaceId",
        "sessionId",
        "runId",
        "promptSha256",
        "destinationRevision",
        "routeFingerprint",
        "policy",
    ] {
        let mut changed = admit(&record);
        changed[key] = match key {
            "routeFingerprint" | "promptSha256" => json!("c".repeat(64)),
            "policy" => json!({"enabled":true,"notes":false,"skills":true}),
            _ => json!("changed"),
        };
        assert!(call(&mut owner, "queue.admit", changed).is_err(), "{key}");
        assert_eq!(list(&mut owner)["jobs"][0]["modelRequests"], 0);
        assert!(owner.jobs.is_empty());
    }
    let mut wrong_profile = admit(&record);
    wrong_profile["profileId"] = "foreign-profile".into();
    assert!(call(&mut owner, "queue.admit", wrong_profile).is_err());
}

#[test]
fn snooze_is_durable_and_stale_actions_cannot_overwrite_it() {
    let temp = Temp::new();
    let mut owner = temp.owner();
    let record = capture(&mut owner);
    let mut delay = control(&record);
    delay["delaySeconds"] = 600.into();
    let snoozed = run(&mut owner, "queue.delay", delay.clone())["record"].clone();
    assert_eq!(snoozed["queue"]["delaySeconds"], 600);
    assert_ne!(snoozed["queue"]["revision"], record["queue"]["revision"]);
    assert_eq!(
        call(&mut owner, "queue.delay", delay).unwrap_err().1,
        Some("learning_queue_changed")
    );
    assert_eq!(
        call(&mut owner, "queue.admit", admit(&record))
            .unwrap_err()
            .1,
        Some("learning_queue_changed")
    );
    drop(owner);
    let mut next = temp.owner();
    assert_eq!(list(&mut next)["jobs"][0], snoozed);
    assert_eq!(run(&mut next, "queue.capture", input())["record"], snoozed);
    let mut reset = control(&snoozed);
    reset["delaySeconds"] = 60.into();
    let reset = run(&mut next, "queue.delay", reset)["record"].clone();
    assert_ne!(reset["queue"]["revision"], record["queue"]["revision"]);
}

#[test]
fn cancelled_queue_never_reappears_on_recapture_or_owner_restart() {
    let temp = Temp::new();
    let mut owner = temp.owner();
    let record = capture(&mut owner);
    let cancelled = run(&mut owner, "queue.cancel", control(&record))["record"].clone();
    assert_eq!(cancelled["state"], "terminal");
    assert_eq!(cancelled["modelRequests"], 0);
    assert!(owner.jobs.is_empty());
    drop(owner);
    let mut next = temp.owner();
    assert_eq!(
        run(&mut next, "queue.capture", input())["record"],
        cancelled
    );
    assert_eq!(
        call(&mut next, "queue.admit", admit(&record))
            .unwrap_err()
            .1,
        Some("learning_queue_already_admitted")
    );
}

#[test]
fn lost_admission_acknowledgement_requires_normal_recovery_without_re_admission() {
    let temp = Temp::new();
    let mut first = temp.owner();
    let record = capture(&mut first);
    let job = run(&mut first, "queue.admit", admit(&record))["job"].clone();
    assert_eq!(
        call(&mut first, "queue.admit", admit(&record))
            .unwrap_err()
            .1,
        Some("learning_job_active")
    );
    drop(first);
    let mut next = temp.owner();
    assert_eq!(list(&mut next)["jobs"][0]["state"], "resumable");
    assert_eq!(
        call(&mut next, "queue.admit", admit(&record))
            .unwrap_err()
            .1,
        Some("learning_queue_already_admitted")
    );
    let mut recovery = admit(&record);
    recovery.as_object_mut().unwrap().remove("queueRevision");
    let recovered = run(&mut next, "job.recover", recovery)["job"].clone();
    assert_eq!(recovered["effect"], job["effect"]);
    assert_eq!(list(&mut next)["jobs"][0]["modelRequests"], 1);
}

#[test]
fn entered_effect_uncertainty_remains_after_queued_origin_and_process_loss() {
    let temp = Temp::new();
    let mut first = temp.owner();
    let record = capture(&mut first);
    let job = run(&mut first, "queue.admit", admit(&record))["job"].clone();
    run(
        &mut first,
        "job.enter",
        json!({"jobId":job["jobId"],"effectId":job["effect"]["effectId"]}),
    );
    drop(first);
    let mut next = temp.owner();
    assert_eq!(list(&mut next)["jobs"][0]["state"], "uncertain");
    assert_eq!(
        call(&mut next, "queue.admit", admit(&record))
            .unwrap_err()
            .1,
        Some("learning_queue_already_admitted")
    );
}

#[test]
fn queue_persists_only_sanitized_bounded_native_evidence() {
    let temp = Temp::new();
    let mut owner = temp.owner();
    let mut capture = input();
    let secret = "sk-abcdefghijklmnopqrstuv012345"; // extalia-allow-secret
    capture["evidence"][0]["content"] = format!("{secret} {}", "bounded ".repeat(5000)).into();
    capture["sourceContext"]["user"] = format!("Do not retain {secret}").into();
    let record = run(&mut owner, "queue.capture", capture)["record"].clone();
    let saved = std::fs::read_to_string(temp.folder(&record).join("00000001.json")).unwrap();
    assert!(!saved.contains(secret));
    assert!(saved.len() < 16000);
    let job = run(&mut owner, "queue.admit", admit(&record))["job"].clone();
    assert!(!job.to_string().contains(secret));
}

#[test]
fn partial_latest_queue_checkpoint_never_falls_back_or_recreates_source() {
    let temp = Temp::new();
    let mut owner = temp.owner();
    let record = capture(&mut owner);
    let mut delay = control(&record);
    delay["delaySeconds"] = 600.into();
    run(&mut owner, "queue.delay", delay);
    std::fs::write(temp.folder(&record).join("00000002.json"), b"{").unwrap();
    drop(owner);
    let mut next = temp.owner();
    assert_eq!(list(&mut next)["omitted"], 1);
    assert!(call(&mut next, "queue.capture", input()).is_err());
    assert!(call(&mut next, "queue.admit", admit(&record)).is_err());
    assert!(next.jobs.is_empty());
}

#[test]
fn empty_or_disabled_capture_is_terminal_without_an_effect() {
    let temp = Temp::new();
    let mut owner = temp.owner();
    let mut empty = input();
    empty["evidence"] = json!([]);
    empty.as_object_mut().unwrap().remove("sourceContext");
    let record = run(&mut owner, "queue.capture", empty)["record"].clone();
    assert_eq!(record["state"], "terminal");
    assert_eq!(record["modelRequests"], 0);
    assert!(record.get("queue").is_none());
    assert!(owner.jobs.is_empty());
}

#[test]
fn intake_is_normalized_before_capture_and_incomplete_intake_leaves_no_job() {
    let temp = Temp::new();
    let mut owner = temp.owner();
    let intake = run(&mut owner, "evidence.begin", json!({}))["intakeId"].clone();
    run(
        &mut owner,
        "evidence.append",
        json!({"intakeId":intake,"toolCallId":"source-2","name":"read_result","isError":false,"chunk":"A source fact","final":false}),
    );
    let mut capture = input();
    capture.as_object_mut().unwrap().remove("evidence");
    capture["intakeId"] = intake;
    assert_eq!(
        call(&mut owner, "queue.capture", capture).unwrap_err().1,
        Some("evidence_incomplete")
    );
    assert!(list(&mut owner)["jobs"].as_array().unwrap().is_empty());
}

fn observed_scope(profile: &str, workspace: &str) -> Value {
    json!({"profileId":profile,"workspaceId":workspace,"sessionId":"observed","sourceId":"codex","nativeSessionId":"native-source","boundary":"c".repeat(64)})
}
fn observed_capture(owner: &mut Learning, scope: &Value) -> Value {
    let episode = run(owner,"observed.capture",json!({"scope":scope,"episodeId":"terminal-one","sourceRevision":"native-r1","entries":[{"id":"user-one","kind":"user","text":"Use the standard library."},{"id":"assistant-one","kind":"assistant","text":"The tests reportedly passed."}],"coverage":{"mode":"partial","omittedEntries":1,"truncated":true,"limits":["Visible transcript only"]}}))["episode"].clone();
    run(owner,"observed.queueCapture",json!({"scope":scope,"episodeId":episode["id"],"revision":episode["revision"],"destinationRevision":"vault-r1","runId":format!("observed-{}",hash(scope.to_string())),"promptSha256":"a".repeat(64),"routeFingerprint":"b".repeat(64),"policy":{"enabled":true,"skills":true,"notes":true}}))["record"].clone()
}

#[test]
fn observed_global_and_isolated_queues_preserve_exact_scope_and_claim_attribution() {
    let temp = Temp::new();
    let mut first = temp.owner();
    let global = observed_capture(&mut first, &observed_scope("default", "global-observe"));
    let isolated = observed_capture(
        &mut first,
        &observed_scope("isolated-profile", "isolated-workspace"),
    );
    assert_ne!(global["jobId"], isolated["jobId"]);
    assert!(first.jobs.is_empty());
    drop(first);
    let mut next = temp.owner();
    for record in [&global, &isolated] {
        let job = run(&mut next, "queue.admit", admit(record))["job"].clone();
        assert_eq!(job["provenance"]["profileId"], record["profileId"]);
        assert!(s(&job["evidence"][0], "content").contains("UNTRUSTED OBSERVED CLAIM"));
        assert!(s(&job["effect"], "system").contains("not independent verification"));
    }
}

#[test]
fn revoked_observed_episode_cannot_be_admitted_after_owner_restart() {
    let temp = Temp::new();
    let mut first = temp.owner();
    let scope = observed_scope("default", "workspace");
    let record = observed_capture(&mut first, &scope);
    run(&mut first, "observed.revoke", json!({"scope":scope}));
    drop(first);
    let mut next = temp.owner();
    assert!(call(&mut next, "queue.admit", admit(&record)).is_err());
    assert_eq!(list(&mut next)["jobs"][0]["modelRequests"], 0);
    assert!(next.jobs.is_empty());
}

#[test]
fn queued_source_and_tool_contract_cannot_gain_a_generic_write_tool() {
    let temp = Temp::new();
    let mut owner = temp.owner();
    let record = capture(&mut owner);
    let mut input = admit(&record);
    input["tools"] = json!([{"name":"write_file","description":"Write arbitrary content","parameters":{"type":"object"}}]);
    assert_eq!(
        call(&mut owner, "queue.admit", input).unwrap_err().1,
        Some("unsupported_learning_tool")
    );
    assert_eq!(list(&mut owner)["jobs"][0]["state"], "queued");
}

#[test]
fn revoke_tombstones_only_its_queued_source_even_if_the_same_episode_is_recaptured() {
    let temp = Temp::new();
    let mut first = temp.owner();
    let scope = observed_scope("default", "workspace");
    let record = observed_capture(&mut first, &scope);
    let mut other_scope = scope.clone();
    other_scope["nativeSessionId"] = "another-native-source".into();
    let other = observed_capture(&mut first, &other_scope);
    let isolated = observed_capture(&mut first, &observed_scope("isolated-profile", "workspace"));
    drop(first);
    let mut next = temp.owner();
    run(&mut next, "observed.revoke", json!({"scope":scope}));
    let records = list(&mut next)["jobs"].as_array().unwrap().clone();
    let tombstone = records
        .iter()
        .find(|v| v["jobId"] == record["jobId"])
        .unwrap();
    assert_eq!(tombstone["state"], "terminal");
    assert_eq!(tombstone["modelRequests"], 0);
    assert_eq!(
        records
            .iter()
            .find(|v| v["jobId"] == other["jobId"])
            .unwrap()["state"],
        "queued"
    );
    assert_eq!(observed_capture(&mut next, &scope), *tombstone);
    assert_eq!(
        call(&mut next, "queue.admit", admit(&record))
            .unwrap_err()
            .1,
        Some("learning_queue_already_admitted")
    );
    assert_eq!(
        run(&mut next, "queue.admit", admit(&other))["job"]["status"],
        "running"
    );
    assert_eq!(
        run(&mut next, "queue.admit", admit(&isolated))["job"]["status"],
        "running"
    );
}

#[test]
fn a_corrupt_checkpoint_cannot_block_revocation_of_healthy_observed_queues() {
    let temp = Temp::new();
    let mut owner = temp.owner();
    let corrupt = capture(&mut owner);
    std::fs::write(temp.folder(&corrupt).join("00000001.json"), b"{").unwrap();
    let scope = observed_scope("default", "workspace");
    let record = observed_capture(&mut owner, &scope);
    run(&mut owner, "observed.revoke", json!({"scope":scope}));
    let records = list(&mut owner);
    assert_eq!(records["omitted"], 1);
    assert_eq!(records["jobs"][0]["jobId"], record["jobId"]);
    assert_eq!(records["jobs"][0]["state"], "terminal");
    let mut read = record["observedSource"].clone();
    read["offset"] = 0.into();
    read["limit"] = 1.into();
    assert!(call(&mut owner, "observed.read", read).is_err());
}

#[test]
fn competing_daemons_cannot_admit_a_stale_queue_revision() {
    let temp = Temp::new();
    let mut first = temp.owner();
    let record = capture(&mut first);
    let mut second = temp.owner();
    let mut delay = control(&record);
    delay["delaySeconds"] = 600.into();
    let latest = run(&mut second, "queue.delay", delay)["record"].clone();
    assert_eq!(
        call(&mut first, "queue.admit", admit(&record))
            .unwrap_err()
            .1,
        Some("learning_queue_changed")
    );
    run(&mut second, "queue.admit", admit(&latest));
    assert_eq!(
        call(&mut first, "queue.admit", admit(&latest))
            .unwrap_err()
            .1,
        Some("learning_queue_already_admitted")
    );
    assert!(first.jobs.is_empty());
}

#[test]
fn repeated_snoozes_keep_only_two_authoritative_generations() {
    let temp = Temp::new();
    let mut owner = temp.owner();
    let mut record = capture(&mut owner);
    for _ in 0..130 {
        let mut delay = control(&record);
        delay["delaySeconds"] = 600.into();
        record = run(&mut owner, "queue.delay", delay)["record"].clone();
    }
    let count = std::fs::read_dir(temp.folder(&record)).unwrap().count();
    assert_eq!(count, 2);
    drop(owner);
    let mut next = temp.owner();
    assert_eq!(list(&mut next)["jobs"][0], record);
    assert_eq!(
        run(&mut next, "queue.admit", admit(&record))["job"]["status"],
        "running"
    );
}
