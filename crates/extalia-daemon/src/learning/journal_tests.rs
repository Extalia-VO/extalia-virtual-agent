//! Synthetic crash boundaries; no provider, external application or real profile.
use super::*;

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("extalia-learning-journal-{}", uid()));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn owner(&self) -> Learning {
        Learning::new(&self.0, "default")
    }
    fn folder(&self, job_id: &str) -> PathBuf {
        self.0
            .join("learning-jobs")
            .join(hash("default"))
            .join(hash("default"))
            .join(job_id)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn begin() -> Value {
    json!({"profileId":"default","revision":"vault-r1","workspaceId":"workspace","sessionId":"session","runId":"run","promptSha256":"a".repeat(64),"routeFingerprint":"b".repeat(64),"policy":{"enabled":true,"skills":true,"notes":true},"evidence":[{"toolCallId":"source-1","name":"test_result","content":"Reported test output; retain uncertainty.","isError":false}],"tools":[{"name":"knowledge_read","description":"Read a pinned page","parameters":{"type":"object"}}]})
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
fn recovery(job: &Value) -> Value {
    let v = begin();
    json!({"jobId":job["jobId"],"profileId":v["profileId"],"workspaceId":v["workspaceId"],"sessionId":v["sessionId"],"runId":v["runId"],"promptSha256":v["promptSha256"],"destinationRevision":v["revision"],"routeFingerprint":v["routeFingerprint"],"policy":v["policy"],"tools":v["tools"]})
}
fn enter(owner: &mut Learning, job: &Value) {
    run(
        owner,
        "job.enter",
        json!({"jobId":job["jobId"],"effectId":job["effect"]["effectId"]}),
    );
}
fn advance(owner: &mut Learning, job: &Value, completion: Value) -> Value {
    run(
        owner,
        "job.advance",
        json!({"jobId":job["jobId"],"effectId":job["effect"]["effectId"],"completion":completion}),
    )["job"]
        .clone()
}
fn model(calls: Vec<Value>) -> Value {
    json!({"kind":"model","result":{"text":"","stop":"tool_use","toolCalls":calls,"usage":{"inputTokens":20,"outputTokens":5}}})
}
fn submit() -> Value {
    json!({"id":"submit-1","name":"submit_learning","input":{"title":"Retained finding","lesson":"Recheck the documented result before reuse.","evidenceIds":["source-1"],"skill":{"name":"check-results","description":"Use when checking a procedure result.","instructions":"## When to Use\nCheck a procedure result.\n## Procedure\nInspect current evidence.\n## Pitfalls\nPast outcomes may change.\n## Verification\nRecheck the actual result."}}})
}
fn knowledge(sha: &str) -> Value {
    json!({"status":"found","path":"Guides/Prior.md","sha256":sha,"profileId":"default","workspaceId":"workspace","body":"# Prior\nPrior finding.","offset":0,"truncated":false,"nativeTruncated":false})
}

#[test]
fn restart_resumes_only_the_unentered_effect_with_exact_budget_and_source() {
    let temp = Temp::new();
    let mut first = temp.owner();
    let job = run(&mut first, "job.begin", begin())["job"].clone();
    assert_eq!(list(&mut first)["jobs"][0]["active"], true);
    assert_eq!(
        call(&mut first, "job.recover", recovery(&job))
            .unwrap_err()
            .1,
        Some("learning_job_active")
    );
    drop(first);
    let mut next = temp.owner();
    let records = list(&mut next);
    assert_eq!(records["jobs"][0]["state"], "resumable");
    assert_eq!(records["jobs"][0]["modelRequests"], 1);
    assert_eq!(records["jobs"][0]["active"], false);
    let resumed = run(&mut next, "job.recover", recovery(&job))["job"].clone();
    assert_eq!(resumed["effect"], job["effect"]);
    assert_eq!(resumed["provenance"], job["provenance"]);
    assert_eq!(
        resumed["recovery"],
        json!({"resumed":true,"skillReviewRequired":false})
    );
    assert_eq!(call(&mut next, "job.advance", json!({"jobId":resumed["jobId"],"effectId":resumed["effect"]["effectId"],"completion":model(vec![submit()])})).unwrap_err().1, Some("effect_not_entered"));
    enter(&mut next, &resumed);
    assert_eq!(
        call(
            &mut next,
            "job.enter",
            json!({"jobId":resumed["jobId"],"effectId":resumed["effect"]["effectId"]})
        )
        .unwrap_err()
        .1,
        Some("effect_already_entered")
    );
    let ready = advance(&mut next, &resumed, model(vec![submit()]));
    assert_eq!(ready["status"], "ready");
    assert_eq!(ready["usage"]["inputTokens"], 20);
}

#[test]
fn lost_entry_acknowledgement_remains_uncertain_even_after_handle_release() {
    let temp = Temp::new();
    let mut owner = temp.owner();
    let job = run(&mut owner, "job.begin", begin())["job"].clone();
    enter(&mut owner, &job);
    run(&mut owner, "job.release", json!({"jobId":job["jobId"]}));
    let record = list(&mut owner)["jobs"][0].clone();
    assert_eq!(record["state"], "uncertain");
    assert_eq!(record["active"], false);
    assert_eq!(
        call(&mut owner, "job.recover", recovery(&job))
            .unwrap_err()
            .1,
        Some("learning_recovery_effect_uncertain")
    );
    drop(owner);
    assert_eq!(
        call(&mut temp.owner(), "job.recover", recovery(&job))
            .unwrap_err()
            .1,
        Some("learning_recovery_effect_uncertain")
    );
}

#[test]
fn durable_read_result_survives_lost_advance_ack_without_repeating_the_read() {
    let temp = Temp::new();
    let mut owner = temp.owner();
    let first = run(&mut owner, "job.begin", begin())["job"].clone();
    enter(&mut owner, &first);
    let read = advance(
        &mut owner,
        &first,
        model(vec![
            json!({"id":"read-1","name":"knowledge_read","input":{"path":"Guides/Prior.md"}}),
        ]),
    );
    enter(&mut owner, &read);
    let next = advance(
        &mut owner,
        &read,
        json!({"kind":"read","ok":true,"output":knowledge(&"c".repeat(64)).to_string()}),
    );
    drop(owner);
    let mut restarted = temp.owner();
    let resumed = run(&mut restarted, "job.recover", recovery(&first))["job"].clone();
    assert_eq!(resumed["effect"], next["effect"]);
    assert_eq!(resumed["effect"]["kind"], "model");
    let record = list(&mut restarted)["jobs"][0].clone();
    assert_eq!(record["reads"], 1);
    assert_eq!(record["modelRequests"], 2);
    enter(&mut restarted, &resumed);
    let mut finding = submit();
    finding["input"]["lesson"] = "Recheck [[Guides/Prior.md#Prior|the prior finding]].".into();
    let ready = advance(&mut restarted, &resumed, model(vec![finding]));
    assert_eq!(ready["status"], "ready");
    assert_eq!(ready["knowledgeReads"][0]["sha256"], "c".repeat(64));
}

#[test]
fn retained_submission_and_independent_receipts_survive_publication_interruption() {
    let temp = Temp::new();
    let mut owner = temp.owner();
    let job = run(&mut owner, "job.begin", begin())["job"].clone();
    enter(&mut owner, &job);
    let ready = advance(&mut owner, &job, model(vec![submit()]));
    let note = json!({"profileId":"default","runId":"run","contentSha256":ready["noteSha256"]});
    assert_eq!(
        run(&mut owner, "receipt.claim", note.clone())["claimed"],
        true
    );
    let mut record = note.clone();
    record["receipt"] = json!({"kind":"note","data":"{\"path\":\"Learning/Finding.md\"}"});
    run(&mut owner, "receipt.record", record);
    let skill = json!({"profileId":"default","runId":"run","contentSha256":ready["skillSha256"]});
    run(&mut owner, "receipt.claim", skill.clone());
    run(&mut owner, "job.release", json!({"jobId":ready["jobId"]}));
    let mut restarted = temp.owner();
    let resumed = run(&mut restarted, "job.recover", recovery(&ready))["job"].clone();
    assert_eq!(resumed["submission"], ready["submission"]);
    for key in ["contentSha256", "noteSha256", "skillSha256"] {
        assert_eq!(resumed[key], ready[key]);
    }
    assert!(resumed.get("effect").is_none());
    assert_eq!(
        run(
            &mut restarted,
            "receipt.get",
            json!({"profileId":"default","contentSha256":ready["noteSha256"]})
        )["status"],
        "recorded"
    );
    assert_eq!(
        run(
            &mut restarted,
            "receipt.get",
            json!({"profileId":"default","contentSha256":ready["skillSha256"]})
        )["status"],
        "attempted"
    );
    assert_eq!(
        run(&mut restarted, "receipt.claim", skill)["claimed"],
        false
    );
}

#[test]
fn recovered_knowledge_needs_fresh_read_validation_before_finish() {
    let temp = Temp::new();
    let mut owner = temp.owner();
    let job = run(&mut owner, "job.begin", begin())["job"].clone();
    enter(&mut owner, &job);
    let read = advance(
        &mut owner,
        &job,
        model(vec![
            json!({"id":"read-1","name":"knowledge_read","input":{"path":"Guides/Prior.md"}}),
        ]),
    );
    enter(&mut owner, &read);
    let model_job = advance(
        &mut owner,
        &read,
        json!({"kind":"read","ok":true,"output":knowledge(&"c".repeat(64)).to_string()}),
    );
    enter(&mut owner, &model_job);
    let mut finding = submit();
    finding["input"]["lesson"] = "Review [[Guides/Prior.md]].".into();
    let ready = advance(&mut owner, &model_job, model(vec![finding]));
    run(
        &mut owner,
        "job.revalidate",
        json!({"jobId":ready["jobId"],"reads":[{"path":"Guides/Prior.md","ok":true,"output":knowledge(&"c".repeat(64)).to_string()}]}),
    );
    drop(owner);
    let mut restarted = temp.owner();
    let resumed = run(&mut restarted, "job.recover", recovery(&ready))["job"].clone();
    assert_eq!(
        call(
            &mut restarted,
            "job.finish",
            json!({"jobId":resumed["jobId"]})
        )
        .unwrap_err()
        .1,
        Some("wrong_job_state")
    );
    let failed = run(
        &mut restarted,
        "job.revalidate",
        json!({"jobId":resumed["jobId"],"reads":[{"path":"Guides/Prior.md","ok":true,"output":knowledge(&"d".repeat(64)).to_string()}]}),
    );
    assert_eq!(failed["job"]["status"], "failed");
    assert!(s(&failed["job"], "reason").contains("knowledge_source_changed"));
}

#[test]
fn recovery_rejects_each_changed_authority_binding_and_tool_contract() {
    let temp = Temp::new();
    let mut owner = temp.owner();
    let job = run(&mut owner, "job.begin", begin())["job"].clone();
    drop(owner);
    for (key, value, reason) in [
        (
            "workspaceId",
            json!("other-workspace"),
            "learning_recovery_scope_changed",
        ),
        (
            "sessionId",
            json!("other-session"),
            "learning_recovery_scope_changed",
        ),
        (
            "runId",
            json!("other-run"),
            "learning_recovery_scope_changed",
        ),
        (
            "promptSha256",
            json!("d".repeat(64)),
            "learning_recovery_scope_changed",
        ),
        (
            "destinationRevision",
            json!("vault-r2"),
            "learning_recovery_scope_changed",
        ),
        (
            "policy",
            json!({"enabled":true,"skills":false,"notes":true}),
            "learning_recovery_scope_changed",
        ),
        (
            "routeFingerprint",
            json!("e".repeat(64)),
            "learning_recovery_route_changed",
        ),
        ("tools", json!([]), "learning_recovery_tools_changed"),
    ] {
        let mut input = recovery(&job);
        input[key] = value;
        assert_eq!(
            call(&mut temp.owner(), "job.recover", input).unwrap_err().1,
            Some(reason),
            "{key}"
        );
    }
    let mut changed_profile = recovery(&job);
    changed_profile["profileId"] = "other-profile".into();
    assert_eq!(
        call(&mut temp.owner(), "job.recover", changed_profile)
            .unwrap_err()
            .1,
        Some("learning_checkpoint_missing")
    );
    assert_eq!(
        run(
            &mut Learning::new(&temp.0, "other-profile"),
            "job.list",
            json!({"profileId":"default"})
        )["jobs"],
        json!([])
    );
}

#[test]
fn claiming_recovery_fences_a_stale_daemon_before_it_can_enter_an_effect() {
    let temp = Temp::new();
    let mut stale = temp.owner();
    let job = run(&mut stale, "job.begin", begin())["job"].clone();
    let mut current = temp.owner();
    let resumed = run(&mut current, "job.recover", recovery(&job))["job"].clone();
    assert_eq!(
        call(
            &mut stale,
            "job.enter",
            json!({"jobId":job["jobId"],"effectId":job["effect"]["effectId"]})
        )
        .unwrap_err()
        .1,
        Some("learning_checkpoint_superseded")
    );
    enter(&mut current, &resumed);
    assert_eq!(list(&mut current)["jobs"][0]["state"], "uncertain");
}

#[test]
fn incomplete_highest_generation_never_falls_back_to_an_unentered_effect() {
    let temp = Temp::new();
    let mut owner = temp.owner();
    let job = run(&mut owner, "job.begin", begin())["job"].clone();
    std::fs::write(
        temp.folder(s(&job, "jobId")).join("00000002.json"),
        b"{\"schema\":",
    )
    .unwrap();
    drop(owner);
    let mut restarted = temp.owner();
    let listed = list(&mut restarted);
    assert_eq!(listed["jobs"], json!([]));
    assert_eq!(listed["omitted"], 1);
    assert_eq!(
        call(&mut restarted, "job.recover", recovery(&job))
            .unwrap_err()
            .1,
        Some("learning_checkpoint_invalid")
    );
}

#[test]
fn sensitive_provider_native_content_keeps_the_preceding_entered_checkpoint() {
    let temp = Temp::new();
    let mut owner = temp.owner();
    let job = run(&mut owner, "job.begin", begin())["job"].clone();
    enter(&mut owner, &job);
    let mut completion = model(vec![
        json!({"id":"read-1","name":"knowledge_read","input":{"path":"Guides/Prior.md"}}),
    ]);
    let secret = "sk-abcdefghijklmnopqrstuv012345"; // extalia-allow-secret
    completion["result"]["native"] = json!({"api":"openai-responses","content":{"text":secret}});
    assert_eq!(call(&mut owner, "job.advance", json!({"jobId":job["jobId"],"effectId":job["effect"]["effectId"],"completion":completion})).unwrap_err().1, Some("learning_checkpoint_sensitive_content"));
    assert_eq!(list(&mut owner)["jobs"][0]["state"], "uncertain");
    for file in std::fs::read_dir(temp.folder(s(&job, "jobId"))).unwrap() {
        assert!(
            !std::fs::read_to_string(file.unwrap().path())
                .unwrap()
                .contains(secret)
        );
    }
}

#[test]
fn actual_cancelled_effect_drain_is_persisted_and_never_recovered_as_success() {
    let temp = Temp::new();
    let mut owner = temp.owner();
    let job = run(&mut owner, "job.begin", begin())["job"].clone();
    enter(&mut owner, &job);
    run(&mut owner, "job.cancel", json!({"jobId":job["jobId"]}));
    run(
        &mut owner,
        "job.settle",
        json!({"jobId":job["jobId"],"effectId":job["effect"]["effectId"]}),
    );
    drop(owner);
    let mut restarted = temp.owner();
    assert_eq!(list(&mut restarted)["jobs"][0]["state"], "terminal");
    assert_eq!(
        call(&mut restarted, "job.recover", recovery(&job))
            .unwrap_err()
            .1,
        Some("learning_recovery_terminal")
    );
}

#[test]
fn checkpoint_symlinks_and_tampering_are_refused_without_external_writes() {
    use std::os::unix::fs::symlink;
    let temp = Temp::new();
    let outside = Temp::new();
    let mut owner = temp.owner();
    let job = run(&mut owner, "job.begin", begin())["job"].clone();
    let folder = temp.folder(s(&job, "jobId"));
    std::fs::remove_dir_all(&folder).unwrap();
    symlink(&outside.0, &folder).unwrap();
    drop(owner);
    assert!(call(&mut temp.owner(), "job.recover", recovery(&job)).is_err());
    assert_eq!(std::fs::read_dir(&outside.0).unwrap().count(), 0);
}

#[test]
fn observed_recovery_rechecks_the_original_episode_and_refuses_revoked_source() {
    let temp = Temp::new();
    let mut owner = temp.owner();
    let scope = json!({"profileId":"default","workspaceId":"workspace","sessionId":"observed","sourceId":"codex","nativeSessionId":"native-session","boundary":"c".repeat(64)});
    let captured = run(&mut owner, "observed.capture", json!({"scope":scope,"episodeId":"episode-1","sourceRevision":"native-r1","entries":[{"id":"user-1","kind":"user","text":"Use the standard library."},{"id":"assistant-1","kind":"assistant","text":"I report success; the result was not independently checked."}],"coverage":{"mode":"partial","omittedEntries":0,"truncated":false,"limits":[]}}))["episode"].clone();
    let source = json!({"scope":scope,"episodeId":captured["id"],"revision":captured["revision"]});
    let mut input = source.clone();
    for key in [
        "runId",
        "promptSha256",
        "policy",
        "routeFingerprint",
        "tools",
    ] {
        input[key] = begin()[key].clone();
    }
    input["destinationRevision"] = "vault-r1".into();
    let job = run(&mut owner, "observed.jobBegin", input)["job"].clone();
    drop(owner);
    let mut binding = recovery(&job);
    binding["sessionId"] = "observed".into();
    binding["observedSource"] = source;
    let mut restarted = temp.owner();
    let resumed = run(&mut restarted, "job.recover", binding.clone())["job"].clone();
    assert_eq!(resumed["effect"], job["effect"]);
    assert!(
        resumed["evidence"]
            .to_string()
            .contains("UNTRUSTED OBSERVED CLAIM")
    );
    run(&mut restarted, "job.release", json!({"jobId":job["jobId"]}));
    run(&mut restarted, "observed.revoke", json!({"scope":scope}));
    assert!(call(&mut restarted, "job.recover", binding).is_err());
    assert_eq!(list(&mut restarted)["jobs"][0]["active"], false);
}

#[test]
fn recovered_refinement_keeps_findings_but_marks_volatile_skill_review_unusable() {
    let temp = Temp::new();
    let mut owner = temp.owner();
    let mut input = begin();
    input["tools"].as_array_mut().unwrap().push(json!({"name":"skill_candidate_read","description":"Read the scoped candidate","parameters":{"type":"object"}}));
    let first = run(&mut owner, "job.begin", input.clone())["job"].clone();
    enter(&mut owner, &first);
    let revision = format!("skr_{}", "c".repeat(64));
    let read = advance(
        &mut owner,
        &first,
        model(vec![
            json!({"id":"candidate-read","name":"skill_candidate_read","input":{"revisionId":revision,"path":"SKILL.md"}}),
        ]),
    );
    enter(&mut owner, &read);
    let proof = json!({"revisionId":revision,"path":"SKILL.md","content":"## Procedure\nCheck the source.","skillMdSha256":"d".repeat(64),"reviewReceipt":"e".repeat(64),"readComplete":true,"provenance":{"profileId":"default","workspaceId":"workspace"}});
    let next = advance(
        &mut owner,
        &read,
        json!({"kind":"read","ok":true,"output":proof.to_string()}),
    );
    enter(&mut owner, &next);
    let mut finding = submit();
    finding["input"]["skill"]["baseRevisionId"] = revision.into();
    finding["input"]["skill"]["baseSkillSha256"] = "d".repeat(64).into();
    finding["input"]["skill"]["baseReadReceipt"] = "e".repeat(64).into();
    finding["input"]["skill"]["refinementReason"] =
        "The current correction improves the verification step.".into();
    let ready = advance(&mut owner, &next, model(vec![finding]));
    assert_eq!(ready["status"], "ready");
    drop(owner);
    let mut restarted = temp.owner();
    let mut binding = recovery(&ready);
    binding["tools"] = input["tools"].clone();
    let recovered = run(&mut restarted, "job.recover", binding)["job"].clone();
    assert_eq!(recovered["recovery"]["skillReviewRequired"], true);
    assert_eq!(recovered["submission"], ready["submission"]);
    assert_eq!(recovered["noteSha256"], ready["noteSha256"]);
}

#[test]
fn abandoned_unentered_live_handles_expire_without_losing_resumable_work() {
    let temp = Temp::new();
    let mut owner = temp.owner();
    let job = run(&mut owner, "job.begin", begin())["job"].clone();
    owner.jobs.get_mut(s(&job, "jobId")).unwrap().created =
        Instant::now() - RETAIN - Duration::from_secs(1);
    let record = list(&mut owner)["jobs"][0].clone();
    assert_eq!(record["active"], false);
    assert_eq!(record["state"], "resumable");
    assert_eq!(
        run(&mut owner, "job.recover", recovery(&job))["job"]["effect"],
        job["effect"]
    );
}

#[test]
fn journal_capacity_is_bounded_and_expired_snapshots_cannot_resume() {
    let temp = Temp::new();
    let mut owner = temp.owner();
    let mut first = Value::Null;
    for index in 0..64 {
        let job = run(&mut owner, "job.begin", begin())["job"].clone();
        if index == 0 {
            first = job.clone();
        }
        run(&mut owner, "job.release", json!({"jobId":job["jobId"]}));
    }
    let records = list(&mut owner);
    assert_eq!(records["jobs"].as_array().unwrap().len(), 32);
    assert_eq!(records["omitted"], 32);
    assert_eq!(
        call(&mut owner, "job.begin", begin()).unwrap_err().1,
        Some("learning_journal_capacity")
    );
    let file = temp.folder(s(&first, "jobId")).join("00000001.json");
    let mut expired: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    expired["createdAt"] = 1.into();
    expired["updatedAt"] = 1.into();
    expired["expiresAt"] = (7_u64 * 24 * 60 * 60 * 1000 + 1).into();
    std::fs::write(file, serde_json::to_vec(&expired).unwrap()).unwrap();
    assert_eq!(
        call(&mut owner, "job.recover", recovery(&first))
            .unwrap_err()
            .1,
        Some("learning_checkpoint_expired")
    );
    assert_eq!(
        run(&mut owner, "job.begin", begin())["job"]["status"],
        "running"
    );
    assert!(!temp.folder(s(&first, "jobId")).exists());
}
