use super::*;

#[test]
fn generated_evaluation_handles_are_blind_single_use_and_require_user_approval() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let source = dir.0.join("candidate");
    let instructions = "---\nname: demo\ndescription: Verify synthetic input.\ncategories: [\"development.testing\"]\nintents: [\"verify_result\"]\n---\n## When to Use\nUse for a synthetic result.\n## Procedure\nReport the verification token only when supported.\n## Pitfalls\nDo not invent observations.\n## Verification\nCheck the supplied evidence.\n";
    let manifest=json!({"schema":"extalia.skill-manifest.v1","id":"demo","version":"1.0.0","risk_class":"declarative","categories":["development.testing"],"intents":["verify_result"]}).to_string();
    let tests=json!({"schema":"extalia.skill-verification.v1","cases":[{"id":"verify","input":"Evaluate supplied synthetic observations.","expectedIncludes":["VERIFIED"],"forbiddenIncludes":["guaranteed"]}]}).to_string();
    write_files(
        &source,
        &[
            ("SKILL.md", instructions),
            ("extalia-skill.json", &manifest),
            ("TESTS.json", &tests),
        ],
    );
    let scanner = FakeInspector(Severity::None);
    let ctx = PolicyContext::current(&scanner);
    let (revision, tree) = {
        let mut registry = SkillRegistry::new(
            &mut store,
            &dir.data(),
            ProfileId::parse("default").unwrap(),
        );
        let imported = registry
            .import(&source, Origin::Generated, "test", 1)
            .unwrap();
        registry
            .inspect(&imported.revision_id, &scanner, POLICY_VERSION, 1)
            .unwrap();
        registry.validate(&imported.revision_id, &ctx, 1).unwrap();
        (imported.revision_id, imported.tree_sha256)
    };
    let mut session = start(&dir, store, "default", Some(scanner));
    let begin = json!({"revisionId":revision,"treeSha256":tree});
    let plan = op(&mut session, "skill.evaluationBegin", begin.clone()).unwrap();
    assert!(!plan.to_string().contains("VERIFIED"));
    assert!(!plan.to_string().contains("expectedIncludes"));
    assert_eq!(plan["subjects"][0]["cases"][0]["id"], "verify");
    assert_eq!(
        op(&mut session, "skill.evaluationBegin", begin.clone()),
        refused("denied", "evaluation_busy")
    );
    let complete = json!({"evaluationId":plan["evaluationId"],"provider":"test","model":"deterministic-fixture","subjects":[{"subject":"candidate","outputs":[{"caseId":"verify","text":"VERIFIED"}]}]});
    let result = op(&mut session, "skill.evaluationComplete", complete.clone()).unwrap();
    assert_eq!(result["state"], "awaiting_approval");
    assert_eq!(result["learnedQuality"]["evaluation"]["status"], "passed");
    assert_eq!(
        op(&mut session, "skill.evaluationComplete", complete),
        refused("denied", "evaluation_handle_invalid")
    );
    let inspected = op(
        &mut session,
        "skill.inspect",
        json!({"revisionId":revision}),
    )
    .unwrap();
    assert_eq!(inspected["revision"]["active"], false);
    assert_eq!(inspected["approvals"], json!([]));
    let rerun = op(&mut session, "skill.evaluationBegin", begin).unwrap();
    let unavailable=op(&mut session,"skill.evaluationComplete",json!({"evaluationId":rerun["evaluationId"],"provider":"unavailable","model":"none","subjects":[]})).unwrap();
    assert_eq!(unavailable["state"], "validated");
    assert_eq!(
        unavailable["learnedQuality"]["evaluation"]["status"],
        "insufficient-evidence"
    );
}

#[test]
fn candidate_review_wire_accepts_four_references_and_two_data_files_but_not_seven_paths() {
    let paths = json!([
        "references/one.md",
        "references/two.md",
        "references/three.md",
        "references/four.md",
        "extalia-skill.json",
        "TESTS.json"
    ]);
    let mut value = json!({"schemaVersion":1,"kind":"response","requestId":ID,"op":"skill.reviewRead","result":{
      "revisionId":format!("skr_{}","a".repeat(64)),"packageId":"demo","path":"SKILL.md","size":4,"sha256":"a".repeat(64),"content":"text","skillMdSha256":"b".repeat(64),"untrusted":true,"reviewReceipt":"c".repeat(64),
      "provenance":{"profileId":"default","workspaceId":"workspace-one","sessionId":"session-one","promptSha256":"d".repeat(64)},"referencePaths":paths
    }});
    let frame = wire::parse_frame(&value).expect("six review paths are valid");
    assert_eq!(frame.to_value(), value);
    wire::encode(&frame).unwrap();
    value["result"]["referencePaths"]
        .as_array_mut()
        .unwrap()
        .push(json!("references/five.md"));
    assert!(wire::parse_frame(&value).is_err());
}
