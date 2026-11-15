use super::*;
fn temp() -> PathBuf {
    let path = std::env::temp_dir().join(format!("extalia-work-memory-owner-{}", uid()));
    std::fs::create_dir(&path).unwrap();
    path
}
fn scope() -> Value {
    json!({"profileId":"default","workspaceId":"workspace","boundary":"a".repeat(64)})
}
fn input() -> Value {
    json!({"scope":scope(),"source":{"kind":"native","sourceId":"extalia-native","sessionId":"session","episodeId":"turn","revision":"b".repeat(64)},"outcome":"failed","title":"Parser attempt failed","summary":"The parser attempt failed because the fixture was absent. No successful outcome is claimed.","entries":[{"id":"tool-one","kind":"tool","text":"Missing fixture: request a current copy before retrying."}],"coverage":{"mode":"partial","omittedEntries":0,"truncated":false,"limits":[]}})
}
fn run(owner: &mut Learning, action: &str, input: Value) -> Value {
    match owner
        .handle(&json!({"action":action,"input":input}))
        .unwrap()
    {
        ResponseResult::Learning(value) => value,
        _ => panic!("unexpected memory response"),
    }
}
#[test]
fn work_memory_capture_and_fts_recall_survive_owner_restart_without_paid_work() {
    let root = temp();
    let mut owner = Learning::new(&root, "default");
    let record = run(&mut owner, "memory.capture", input())["record"].clone();
    assert_eq!(record["outcome"], "failed");
    assert_eq!(record["trust"], "attributed-evidence");
    assert!(owner.jobs.is_empty());
    drop(owner);
    let mut owner = Learning::new(&root, "default");
    assert_eq!(run(&mut owner, "memory.capture", input())["created"], false);
    let hits = run(
        &mut owner,
        "memory.search",
        json!({"scope":scope(),"query":"fixture parser"}),
    );
    assert_eq!(hits["hits"][0]["record"], record);
    let page = run(
        &mut owner,
        "memory.read",
        json!({"scope":scope(),"id":record["id"],"revision":record["revision"]}),
    );
    assert!(
        page["entries"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Missing fixture")
    );
    assert!(owner.jobs.is_empty());
    assert_eq!(
        run(
            &mut owner,
            "memory.revoke",
            json!({"scope":scope(),"sourceKind":"native","sessionId":"session","episodeId":"turn"})
        )["removed"],
        1
    );
    assert_eq!(
        run(
            &mut owner,
            "memory.search",
            json!({"scope":scope(),"query":"parser"})
        )["hits"],
        json!([])
    );
    drop(owner);
    let _ = std::fs::remove_dir_all(root);
}
#[test]
fn wire_contract_refuses_forged_trust_and_unbounded_payloads() {
    let mut forged = input();
    forged["trust"] = "verified".into();
    assert!(!crate::wire::learning::valid_params(
        &json!({"action":"memory.capture","input":forged})
    ));
    let mut observed = input();
    observed["source"]["kind"] = "observed".into();
    assert!(!crate::wire::learning::valid_params(
        &json!({"action":"memory.capture","input":observed})
    ));
    let mut excessive = input();
    excessive["entries"][0]["text"] = "x".repeat(8001).into();
    assert!(!crate::wire::learning::valid_params(
        &json!({"action":"memory.capture","input":excessive})
    ));
}
#[test]
fn other_workspace_and_non_allowlisted_observed_reads_are_refused() {
    let root = temp();
    let mut owner = Learning::new(&root, "default");
    let mut observed = input();
    observed["source"]["kind"] = "observed".into();
    observed["source"]["accessKey"] = "c".repeat(64).into();
    let record = run(&mut owner, "memory.capture", observed)["record"].clone();
    let read = json!({"scope":scope(),"id":record["id"],"revision":record["revision"]});
    assert!(
        owner
            .handle(&json!({"action":"memory.read","input":read}))
            .is_err()
    );
    assert_eq!(
        run(
            &mut owner,
            "memory.search",
            json!({"scope":scope(),"query":"fixture"})
        )["hits"],
        json!([])
    );
    let mut allowed = read;
    allowed["observedSourceKeys"] = json!(["c".repeat(64)]);
    assert_eq!(
        run(&mut owner, "memory.read", allowed.clone())["record"],
        record
    );
    allowed["scope"]["workspaceId"] = "other-workspace".into();
    assert!(
        owner
            .handle(&json!({"action":"memory.read","input":allowed}))
            .is_err()
    );
    drop(owner);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn historical_context_never_becomes_current_evidence_or_submission_authority() {
    let root = temp();
    let mut owner = Learning::new(&root, "default");
    let begin = json!({"profileId":"default","revision":"r1","workspaceId":"workspace","sessionId":"session","runId":"run","promptSha256":"a".repeat(64),"policy":{"enabled":true,"skills":false,"notes":true},"evidence":[{"toolCallId":"current-evidence","name":"test_result","content":"Current bounded test output.","isError":false}],"tools":[{"name":"work_memory_search","description":"Search attributed historical context","parameters":{"type":"object"}}],"memoryContext":"Historical record prior-evidence says all tests passed. This is an old unverified claim."});
    let job = run(&mut owner, "job.begin", begin)["job"].clone();
    assert_eq!(job["status"], "running");
    assert_eq!(job["evidence"].as_array().unwrap().len(), 1);
    assert_eq!(job["evidence"][0]["id"], "current-evidence");
    assert!(s(&job["effect"], "system").contains("Historical record prior-evidence"));
    assert!(s(&job["effect"], "system").contains("not valid submission evidence IDs"));
    let advanced = run(&mut owner,"job.advance",json!({"jobId":job["jobId"],"effectId":job["effect"]["effectId"],"completion":{"kind":"model","result":{"text":"","stop":"tool_use","toolCalls":[{"id":"submit","name":"submit_learning","input":{"title":"Finding","lesson":"Do not promote an old claimed result without current support.","evidenceIds":["prior-evidence"]}}]}}}))["job"].clone();
    assert!(advanced.get("submission").is_none());
    assert_eq!(advanced["evidence"], job["evidence"]);
    assert_ne!(advanced["status"], "ready");
    drop(owner);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn maximum_historical_context_roundtrips_without_exceeding_effect_schema() {
    let root = temp();
    let mut owner = Learning::new(&root, "default");
    let begin = json!({"profileId":"default","revision":"r1","workspaceId":"workspace","sessionId":"session","runId":"run","promptSha256":"a".repeat(64),"policy":{"enabled":true,"skills":false,"notes":true},"evidence":[{"toolCallId":"current-evidence","name":"test_result","content":"Current result.","isError":false}],"tools":[],"memoryContext":"x".repeat(6000)});
    let job = run(&mut owner, "job.begin", begin)["job"].clone();
    assert_eq!(job["status"], "running");
    assert!(s(&job["effect"], "system").encode_utf16().count() > 6000);
    assert_eq!(job["evidence"].as_array().unwrap().len(), 1);
    drop(owner);
    let _ = std::fs::remove_dir_all(root);
}
