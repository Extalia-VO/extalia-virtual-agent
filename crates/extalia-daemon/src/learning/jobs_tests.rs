use super::*;

fn begin() -> Value {
    json!({"profileId":"default","revision":"r1","workspaceId":"workspace","sessionId":"session","runId":"run","promptSha256":"a".repeat(64),"policy":{"enabled":true,"skills":true,"notes":true},"evidence":[{"toolCallId":"source-one","name":"test_result","content":"Reported test output","isError":false}],"tools":[{"name":"knowledge_search","description":"Search the pinned vault","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"],"additionalProperties":false}}]})
}
fn submit(ids: Value) -> Value {
    json!({"id":"submit-one","name":"submit_learning","input":{"title":"Finding","lesson":"Retain the documented procedure and recheck outcomes before reuse.","evidenceIds":ids,"skill":{"name":"documented-procedure","description":"Use when applying the documented procedure.","instructions":"## When to Use\nUse for the matching procedure.\n## Procedure\nCheck the current documentation.\n## Pitfalls\nDo not assume a prior result still holds.\n## Verification\nCheck the actual result."}}})
}
fn model(job: &mut Job, calls: Vec<Value>) {
    let effect_id = job.pending.as_ref().unwrap()["effectId"].clone();
    job.action("job.advance", &json!({"effectId":effect_id,"completion":{"kind":"model","result":{"text":"","stop":"tool_use","toolCalls":calls}}})).unwrap();
}
fn read(job: &mut Job, completion: Value) {
    let effect_id = job.pending.as_ref().unwrap()["effectId"].clone();
    job.action(
        "job.advance",
        &json!({"effectId":effect_id,"completion":completion}),
    )
    .unwrap();
}
fn search(call_id: &str, query: &str) -> Value {
    json!({"id":call_id,"name":"knowledge_search","input":{"query":query}})
}

#[test]
fn nested_skill_schema_describes_all_required_fields() {
    let job = Job::begin(&begin()).unwrap();
    let tools = job.pending.as_ref().unwrap()["tools"].as_array().unwrap();
    let submit = tools
        .iter()
        .find(|tool| tool["name"] == "submit_learning")
        .unwrap();
    let skill = &submit["parameters"]["properties"]["skill"];
    assert_eq!(
        skill["required"],
        json!(["name", "description", "instructions"])
    );
    assert_eq!(skill["properties"].as_object().unwrap().len(), 9);
    assert_eq!(skill["properties"]["sourceUrls"]["items"]["type"], "string");
    assert_eq!(skill["additionalProperties"], false);
}

fn begin_with_reads() -> Value {
    let mut input = begin();
    for name in [
        "knowledge_read",
        "skill_candidate_list",
        "skill_candidate_read",
    ] {
        input["tools"].as_array_mut().unwrap().push(json!({"name":name,"description":"Read scoped evidence","parameters":{"type":"object"}}));
    }
    input
}
fn knowledge_result(sha: &str) -> Value {
    json!({"status":"found","path":"Guides/Prior.md","sha256":sha,"profileId":"default","workspaceId":"workspace","body":"# Prior\nKnown prior procedure.","offset":0,"truncated":false,"nativeTruncated":false})
}
fn related_submission() -> Value {
    let mut call = submit(json!(["source-one"]));
    call["input"]["lesson"] =
        "The current evidence suggests a correction to [[Prior#Prior|the prior procedure]].".into();
    call["input"]["relatedNotes"] = json!([{"path":"Guides/Prior.md","relation":"contradicts","reason":"The current result differs; verify before reuse.","evidenceIds":["source-one"]}]);
    call
}
fn ready_with_knowledge(sha: &str) -> Job {
    let mut job = Job::begin(&begin_with_reads()).unwrap();
    model(
        &mut job,
        vec![json!({"id":"read-prior","name":"knowledge_read","input":{"path":"Guides/Prior.md"}})],
    );
    read(
        &mut job,
        json!({"kind":"read","ok":true,"output":knowledge_result(sha).to_string()}),
    );
    model(&mut job, vec![related_submission()]);
    assert_eq!(job.status, "ready");
    job
}

#[test]
fn grounded_job_requires_current_snapshot_and_source_change_is_specific() {
    let mut job = ready_with_knowledge(&"a".repeat(64));
    let view = job.view();
    assert_eq!(
        view["knowledgeReads"],
        json!([{"path":"Guides/Prior.md","sha256":"a".repeat(64)}])
    );
    assert!(
        s(&view["submission"], "lesson").contains("[[Guides/Prior.md#Prior|the prior procedure]]")
    );
    assert!(job.action("job.finish", &json!({})).is_err());
    job.action("job.revalidate",&json!({"reads":[{"path":"Guides/Prior.md","ok":true,"output":knowledge_result(&"b".repeat(64)).to_string()}]})).unwrap();
    assert_eq!(job.status, "failed");
    assert!(
        job.reason
            .as_ref()
            .unwrap()
            .contains("knowledge_source_changed")
    );
    assert!(job.view().get("submission").is_none());
    let mut valid = ready_with_knowledge(&"a".repeat(64));
    valid.action("job.revalidate",&json!({"reads":[{"path":"Guides/Prior.md","ok":true,"output":knowledge_result(&"a".repeat(64)).to_string()}]})).unwrap();
    valid.action("job.finish", &json!({})).unwrap();
    assert_eq!(valid.status, "completed");
}

#[test]
fn note_dedup_identity_includes_relationship_and_source_snapshot() {
    let original = ready_with_knowledge(&"a".repeat(64));
    let changed = ready_with_knowledge(&"b".repeat(64));
    assert_ne!(original.view()["noteSha256"], changed.view()["noteSha256"]);
    assert_ne!(
        original.view()["contentSha256"],
        changed.view()["contentSha256"]
    );
    let mut relation = ready_with_knowledge(&"a".repeat(64));
    relation.submission.as_mut().unwrap()["relatedNotes"][0]["relation"] = "updates".into();
    assert_ne!(original.view()["noteSha256"], relation.view()["noteSha256"]);
}

#[test]
fn invalid_link_gets_one_targeted_repair_without_a_hidden_retry_loop() {
    let mut job = Job::begin(&begin_with_reads()).unwrap();
    model(&mut job, vec![related_submission()]);
    assert_eq!(job.status, "running");
    assert!(
        job.messages
            .last()
            .unwrap()
            .to_string()
            .contains("unread_knowledge_link")
    );
    let mut again = related_submission();
    again["id"] = "second-submission".into();
    model(&mut job, vec![again]);
    assert_eq!(job.status, "failed");
    assert_eq!(job.models, 2);
    assert_eq!(job.reads, 0);
    assert!(job.submission.is_none());
}

#[test]
fn refinement_requires_complete_same_scope_skill_md_review_in_this_job() {
    for (complete, foreign_scope, path, accepted) in [
        (true, false, "SKILL.md", true),
        (false, false, "SKILL.md", false),
        (true, true, "SKILL.md", false),
        (true, false, "references/example.md", false),
    ] {
        let mut job = Job::begin(&begin_with_reads()).unwrap();
        let revision = format!("skr_{}", "b".repeat(64));
        model(
            &mut job,
            vec![
                json!({"id":"review","name":"skill_candidate_read","input":{"revisionId":revision,"path":path}}),
            ],
        );
        let output = json!({"revisionId":revision,"path":path,"content":"## Procedure\nPrior procedure.","skillMdSha256":"c".repeat(64),"reviewReceipt":"d".repeat(64),"readComplete":complete,"provenance":{"profileId":"default","workspaceId":if foreign_scope { "elsewhere" } else { "workspace" }}});
        read(
            &mut job,
            json!({"kind":"read","ok":true,"output":output.to_string()}),
        );
        let mut call = submit(json!(["source-one"]));
        call["input"]["skill"]["baseRevisionId"] = revision.into();
        call["input"]["skill"]["baseSkillSha256"] = "c".repeat(64).into();
        call["input"]["skill"]["baseReadReceipt"] = "d".repeat(64).into();
        call["input"]["skill"]["refinementReason"] =
            "The current user correction clarifies the verification step.".into();
        model(&mut job, vec![call]);
        assert_eq!(job.status, if accepted { "ready" } else { "running" });
        if !accepted {
            assert!(
                job.messages
                    .last()
                    .unwrap()
                    .to_string()
                    .contains("unreviewed_skill_refinement")
            );
        }
    }
}

#[test]
fn valid_submit_is_terminal_and_has_an_independent_publication_lease() {
    let mut job = Job::begin(&begin()).unwrap();
    job.deadline = Instant::now() + Duration::from_secs(5);
    model(&mut job, vec![submit(json!(["source-one"]))]);
    assert_eq!(job.status, "ready");
    assert_eq!(job.models, 1);
    assert!(job.pending.is_none());
    assert!(job.deadline > Instant::now() + Duration::from_secs(85));
    let view = job.view();
    assert!(view.get("submission").is_some());
    assert!(view.get("pendingEffectId").is_none());
    assert_eq!(
        view["noteSha256"],
        hash(json!(["note", "workspace", "r1", view["submission"]["lesson"]]).to_string())
    );
    job.action("job.finish", &json!({})).unwrap();
    assert_eq!(job.status, "completed");
}

#[test]
fn mixed_or_duplicate_terminal_calls_never_start_reads_or_publish() {
    let terminal = submit(json!(["source-one"]));
    let mut second = terminal.clone();
    second["id"] = "submit-two".into();
    for calls in [
        vec![search("read-first", "procedure"), terminal.clone()],
        vec![terminal.clone(), search("read-after", "procedure")],
        vec![terminal.clone(), second],
        vec![terminal.clone(), terminal.clone()],
    ] {
        let mut job = Job::begin(&begin()).unwrap();
        model(&mut job, calls);
        assert_eq!(job.status, "failed");
        assert!(job.pending.is_none());
        assert!(job.submission.is_none());
        assert_eq!(job.reads, 0);
    }
}

#[test]
fn last_allowed_request_can_submit_without_a_seventh_request() {
    let mut job = Job::begin(&begin()).unwrap();
    for index in 0..5 {
        model(
            &mut job,
            vec![json!({"id":format!("repair-{index}"),"name":"not_offered","input":{}})],
        );
        assert_eq!(job.status, "running");
    }
    assert_eq!(
        job.pending.as_ref().unwrap()["tools"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(s(job.pending.as_ref().unwrap(), "system").contains("FINALIZATION REQUIRED"));
    model(&mut job, vec![submit(json!(["source-one"]))]);
    assert_eq!(job.status, "ready");
    assert_eq!(job.models, 6);
    assert!(job.pending.is_none());
}

#[test]
fn duplicate_queries_reuse_one_bounded_result_without_another_read() {
    let mut job = Job::begin(&begin()).unwrap();
    model(&mut job, vec![search("first", "procedure")]);
    assert_eq!(job.pending.as_ref().unwrap()["kind"], "read");
    read(
        &mut job,
        json!({"kind":"read","ok":true,"output":"Known note: [[Procedure]]"}),
    );
    model(&mut job, vec![search("same-query", "procedure")]);
    assert_eq!(job.pending.as_ref().unwrap()["kind"], "model");
    assert_eq!(job.reads, 1);
    assert!(
        job.messages
            .last()
            .unwrap()
            .to_string()
            .contains("Known note")
    );
    model(&mut job, vec![submit(json!(["source-one"]))]);
    assert_eq!(job.status, "ready");
}

#[test]
fn optional_read_failure_still_allows_a_grounded_submission() {
    let mut job = Job::begin(&begin()).unwrap();
    model(&mut job, vec![search("first", "procedure")]);
    read(
        &mut job,
        json!({"kind":"failed","stage":"read","code":"timeout"}),
    );
    assert_eq!(job.status, "running");
    assert!(job.messages.last().unwrap().to_string().contains("timeout"));
    model(&mut job, vec![submit(json!(["source-one"]))]);
    assert_eq!(job.status, "ready");
    assert!(job.failure.is_none());
}

#[test]
fn provider_failure_has_only_a_bounded_typed_cause() {
    let mut job = Job::begin(&begin()).unwrap();
    read(
        &mut job,
        json!({"kind":"failed","stage":"provider","code":"invalid-request"}),
    );
    assert_eq!(job.status, "failed");
    assert_eq!(
        job.view()["failure"],
        json!({"stage":"provider","code":"invalid-request"})
    );
    assert!(job.submission.is_none());
}

#[test]
fn no_tool_conversation_retains_claim_labels_and_does_not_invent_verification() {
    let mut input = begin();
    input["evidence"] = json!([]);
    input["sourceContext"] = json!({"user":"Use a concise release checklist.","assistant":"I will use that checklist. Authorization: Bearer synthetic-secret-value"});
    let mut job = Job::begin(&input).unwrap();
    assert_eq!(job.status, "running");
    assert_eq!(job.evidence.len(), 2);
    assert_eq!(job.evidence[0]["name"], "conversation_user");
    assert!(
        job.evidence[0]["content"]
            .as_str()
            .unwrap()
            .contains("not a tool result")
    );
    assert!(!job.view().to_string().contains("synthetic-secret-value"));
    let evidence_ids = json!([job.evidence[0]["id"]]);
    model(&mut job, vec![submit(evidence_ids)]);
    assert_eq!(job.status, "ready");
    let record = json!({"profileId":"default","revision":"r1","workspaceId":"workspace","sessionId":"session","runId":"run","promptSha256":"a".repeat(64),"title":"Preference","lesson":"The user requested a concise checklist.","evidence":job.view()["evidence"]});
    let markdown = text::learning_markdown(&record).unwrap();
    assert!(markdown.contains("attributed conversation claims"));
    assert!(!markdown.contains("limited to successful tool results"));
}

#[test]
fn context_slots_are_retained_with_a_full_tool_evidence_batch() {
    let mut input = begin();
    input["sourceContext"] =
        json!({"user":"Retain the decision.","assistant":"The final check completed."});
    input["evidence"] = json!((0..10).map(|index| json!({"toolCallId":format!("result-{index}"),"name":"test_result","content":"Successful tool output","isError":false})).collect::<Vec<_>>());
    let job = Job::begin(&input).unwrap();
    assert_eq!(job.evidence.len(), 10);
    assert_eq!(job.evidence[0]["name"], "conversation_user");
    assert_eq!(job.evidence[1]["name"], "conversation_assistant");
    assert_eq!(job.evidence[2]["id"], "result-2");
    assert_eq!(job.evidence[9]["id"], "result-9");
}

#[test]
fn estimated_input_has_per_request_and_aggregate_admission_caps() {
    let mut oversized = begin();
    oversized["evidence"] = json!((0..10).map(|index| json!({"toolCallId":format!("result-{index}"),"name":"test_result","content":"界".repeat(2000),"isError":false})).collect::<Vec<_>>());
    let rejected = Job::begin(&oversized).unwrap();
    assert_eq!(rejected.status, "failed");
    assert!(rejected.pending.is_none());
    assert_eq!(rejected.models, 0);

    let mut job = Job::begin(&begin()).unwrap();
    let mut observed_finalization = false;
    for index in 0..6 {
        if job.status != "running" {
            break;
        }
        observed_finalization |= job.finalizing;
        let effect_id = job.pending.as_ref().unwrap()["effectId"].clone();
        job.action("job.advance", &json!({"effectId":effect_id,"completion":{"kind":"model","result":{"text":"x".repeat(6000),"stop":"tool_use","toolCalls":[{"id":format!("unknown-{index}"),"name":"not_offered","input":{}}]}}})).unwrap();
        assert!(job.estimated_input <= MAX_TOTAL_ESTIMATE);
        if let Some(effect) = &job.pending {
            assert!(
                request_estimate(
                    &json!({"system":effect["system"],"messages":effect["messages"],"tools":effect["tools"]})
                ) <= MAX_REQUEST_ESTIMATE
            );
        }
    }
    assert!(observed_finalization);
    assert_eq!(job.status, "failed");
    assert!(job.models <= MAX_MODEL_STEPS);
}

#[test]
fn note_digest_is_destination_and_workspace_bound_and_independent_of_skill() {
    let mut first = Job::begin(&begin()).unwrap();
    model(&mut first, vec![submit(json!(["source-one"]))]);
    let mut input = begin();
    input["workspaceId"] = "other-workspace".into();
    let mut other = Job::begin(&input).unwrap();
    model(&mut other, vec![submit(json!(["source-one"]))]);
    assert_ne!(first.view()["noteSha256"], other.view()["noteSha256"]);
    assert_eq!(first.view()["skillSha256"], other.view()["skillSha256"]);
    let mut changed_destination = begin();
    changed_destination["revision"] = "r2".into();
    let mut changed_destination = Job::begin(&changed_destination).unwrap();
    model(
        &mut changed_destination,
        vec![submit(json!(["source-one"]))],
    );
    assert_ne!(
        first.view()["noteSha256"],
        changed_destination.view()["noteSha256"]
    );
    assert_eq!(
        first.view()["skillSha256"],
        changed_destination.view()["skillSha256"]
    );
    let mut note_only = Job::begin(&begin()).unwrap();
    let mut without_skill = submit(json!(["source-one"]));
    without_skill["input"]
        .as_object_mut()
        .unwrap()
        .remove("skill");
    model(&mut note_only, vec![without_skill]);
    assert_eq!(first.view()["noteSha256"], note_only.view()["noteSha256"]);
}
