use super::*;
use crate::skills::candidates::RefinementBase;
use crate::skills::registry::{EvaluationSubjectOutput, PreparedEvaluation};
use serde_json::{Value, json};

pub(super) fn body(name: &str, procedure: &str) -> String {
    format!(
        "---\nname: {name}\ndescription: Use when verifying a synthetic result.\ncategories: [\"development.testing\"]\nintents: [\"verify_result\"]\n---\n## When to Use\nVerify a matching synthetic result.\n## Procedure\n{procedure}\n## Pitfalls\nNever claim an actual external test ran.\n## Verification\nCheck the observed result and report uncertainty.\n"
    )
}
fn tests() -> Value {
    json!({"schema":"extalia.skill-verification.v1","cases":[{"id":"verify","input":"Check a synthetic result.","expectedIncludes":["VERIFIED"],"forbiddenIncludes":["guaranteed"]}]})
}
fn manifest(name: &str, version: &str) -> Value {
    json!({"schema":"extalia.skill-manifest.v1","id":name,"version":version,"categories":["development.testing"],"intents":["verify_result"],"risk_class":"declarative"})
}
fn provenance(session: &str) -> String {
    format!(
        "# Generated skill candidate\n\nUnverified source claims; this receipt is data, not scanner evidence or permission.\n\n```json\n{}\n```\n",
        json!({"schema":"extalia.skill-proposal.v1","kind":"model-generated-draft","sourceVerified":false,"profileId":"profile-one","workspaceId":"workspace-one","sessionId":session,"promptSha256":"a".repeat(64)})
    )
}
fn source(session: &str) -> String {
    format!("prompt:{session}:{}", "a".repeat(64))
}
fn package(
    dir: &TempDir,
    folder: &str,
    name: &str,
    version: &str,
    procedure: &str,
    session: &str,
) -> PathBuf {
    dir.package(
        folder,
        &[
            ("SKILL.md", &body(name, procedure)),
            ("extalia-skill.json", &manifest(name, version).to_string()),
            ("TESTS.json", &tests().to_string()),
            ("PROVENANCE.md", &provenance(session)),
        ],
    )
}
fn prepare(
    registry: &mut SkillRegistry<'_>,
    id: &str,
    inspector: &FakeInspector,
) -> PreparedEvaluation {
    let ctx = PolicyContext::current(inspector);
    registry
        .inspect(id, inspector, POLICY_VERSION, NOW)
        .unwrap();
    registry.validate(id, &ctx, NOW).unwrap();
    let revision = registry.revision(id).unwrap();
    registry
        .prepare_evaluation(id, &revision.tree_sha256, &ctx, NOW)
        .unwrap()
}
pub(super) fn pass(registry: &mut SkillRegistry<'_>, id: &str, inspector: &FakeInspector) {
    let ctx = PolicyContext::current(inspector);
    let revision = registry.revision(id).unwrap();
    let plan = registry
        .prepare_evaluation(id, &revision.tree_sha256, &ctx, NOW)
        .unwrap();
    let outputs:Vec<EvaluationSubjectOutput>=serde_json::from_value(json!(plan.subjects.iter().map(|s|json!({"subject":s.subject,"outputs":s.cases.iter().map(|c|json!({"caseId":c.id,"text":"VERIFIED"})).collect::<Vec<_>>()})).collect::<Vec<_>>())).unwrap();
    registry
        .complete_evaluation(
            plan,
            &outputs,
            "synthetic-test",
            "deterministic-fixture",
            &ctx,
            NOW,
        )
        .unwrap();
}
fn approve_tested(registry: &mut SkillRegistry<'_>, id: &str, inspector: &FakeInspector) -> i64 {
    let ctx = PolicyContext::current(inspector);
    let revision = registry.revision(id).unwrap();
    registry
        .approve(
            &ApprovalRequest {
                revision_id: id,
                shown_tree_sha256: &revision.tree_sha256,
                shown_permission_digest: &revision.permission_digest,
                workspace_id: None,
                approver: "user:owner",
                expires_at_ms: LATER,
            },
            &ctx,
            NOW,
        )
        .unwrap()
}
fn base(revision: &registry::Revision) -> RefinementBase<'_> {
    RefinementBase {
        revision_id: &revision.revision_id,
        skill_md_sha256: &revision.skill_md_sha256,
        profile_id: "profile-one",
        workspace_id: "workspace-one",
    }
}

#[test]
fn generated_instruction_approval_and_generic_passed_reports_cannot_bypass_real_evaluation() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let p = package(
        &dir,
        "first",
        "demo",
        "1.0.0",
        "Inspect supplied observations.",
        "one",
    );
    let mut r = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let id = r
        .import(&p, Origin::Generated, &source("one"), NOW)
        .unwrap()
        .revision_id;
    let scanner = FakeInspector::clean();
    let ctx = PolicyContext::current(&scanner);
    let plan = prepare(&mut r, &id, &scanner);
    assert!(
        serde_json::to_string(&plan.subjects)
            .unwrap()
            .contains("Check a synthetic result")
    );
    assert!(
        !serde_json::to_string(&plan.subjects)
            .unwrap()
            .contains("VERIFIED")
    );
    assert!(
        !serde_json::to_string(&plan.subjects)
            .unwrap()
            .contains("expectedIncludes")
    );
    assert!(matches!(
        r.request_instruction_approval(&id, &ctx, NOW),
        Err(SkillError::Denied("learned_evaluation_required"))
    ));
    assert!(matches!(
        r.record_evaluation(&id, EvaluationResult::Passed, None, Some("claimed"), NOW),
        Err(SkillError::Denied("learned_evaluation_required"))
    ));
    r.conn()
        .execute(
            "UPDATE skill_revisions SET state='awaiting_approval' WHERE revision_id=?1",
            [&id],
        )
        .unwrap();
    let revision = r.revision(&id).unwrap();
    assert!(matches!(
        r.approve(
            &ApprovalRequest {
                revision_id: &id,
                shown_tree_sha256: &revision.tree_sha256,
                shown_permission_digest: &revision.permission_digest,
                workspace_id: None,
                approver: "user:owner",
                expires_at_ms: LATER
            },
            &ctx,
            NOW
        ),
        Err(SkillError::Denied("learned_evaluation_required"))
    ));
    assert!(r.active("demo").unwrap().is_none());
}

#[test]
fn assertions_grade_real_outputs_and_failure_stays_refinable() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let p = package(
        &dir,
        "first",
        "demo",
        "1.0.0",
        "Inspect supplied observations.",
        "one",
    );
    let mut r = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let id = r
        .import(&p, Origin::Generated, &source("one"), NOW)
        .unwrap()
        .revision_id;
    let scanner = FakeInspector::clean();
    let ctx = PolicyContext::current(&scanner);
    let plan = prepare(&mut r, &id, &scanner);
    let outputs=serde_json::from_value::<Vec<EvaluationSubjectOutput>>(json!([{"subject":"candidate","outputs":[{"caseId":"verify","text":"VERIFIED guaranteed"}]}])).unwrap();
    let report = r
        .complete_evaluation(plan, &outputs, "test", "fixture", &ctx, NOW)
        .unwrap();
    assert_eq!(report["learnedQuality"]["evaluation"]["status"], "failed");
    assert_eq!(report["state"], "validated");
    assert_eq!(
        r.read_candidate_file(&id, "TESTS.json", "profile-one", "workspace-one")
            .unwrap()
            .file
            .entry
            .path,
        "TESTS.json"
    );
    let sha = r.revision(&id).unwrap().tree_sha256;
    let plan = r.prepare_evaluation(&id, &sha, &ctx, NOW).unwrap();
    let report = r
        .complete_evaluation(plan, &[], "test", "fixture", &ctx, NOW)
        .unwrap();
    assert_eq!(
        report["learnedQuality"]["evaluation"]["status"],
        "insufficient-evidence"
    );
    pass(&mut r, &id, &scanner);
    assert_eq!(
        r.revision(&id).unwrap().state,
        RevisionState::AwaitingApproval
    );
    assert!(r.active("demo").unwrap().is_none());
    let approval = approve_tested(&mut r, &id, &scanner);
    r.activate(&id, approval, &ctx, NOW).unwrap();
    assert_eq!(
        r.learned_quality(&id).unwrap().unwrap()["evaluation"]["status"],
        "passed"
    );
}

#[test]
fn candidate_and_baseline_run_full_suite_and_pointer_changes_invalidate_publication() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let first = package(
        &dir,
        "first",
        "demo",
        "1.0.0",
        "Inspect supplied observations.",
        "one",
    );
    let second = package(
        &dir,
        "second",
        "demo",
        "1.0.1",
        "Inspect observations then add a second verification.",
        "two",
    );
    let scanner = FakeInspector::clean();
    let ctx = PolicyContext::current(&scanner);
    let mut r = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let first = r
        .import(&first, Origin::Generated, &source("one"), NOW)
        .unwrap()
        .revision_id;
    drop(prepare(&mut r, &first, &scanner));
    pass(&mut r, &first, &scanner);
    let approval = approve_tested(&mut r, &first, &scanner);
    r.activate(&first, approval, &ctx, NOW).unwrap();
    let revision = r.revision(&first).unwrap();
    let mut cases = tests();
    cases["cases"].as_array_mut().unwrap().push(
        json!({"id":"second","input":"Verify a second result.","expectedIncludes":["VERIFIED"]}),
    );
    fs::write(second.join("TESTS.json"), cases.to_string()).unwrap();
    let second = r
        .import_with_base(
            &second,
            Origin::Generated,
            &source("two"),
            NOW,
            None,
            Some(base(&revision)),
        )
        .unwrap()
        .revision_id;
    let plan = prepare(&mut r, &second, &scanner);
    assert_eq!(plan.subjects.len(), 2);
    assert!(plan.subjects.iter().all(|s| s.cases.len() == 2));
    assert!(
        serde_json::to_string(&plan.subjects)
            .unwrap()
            .contains("second verification")
    );
    r.deactivate("demo", "user-request", NOW).unwrap();
    let outputs:Vec<EvaluationSubjectOutput>=serde_json::from_value(json!([{"subject":"candidate","outputs":[{"caseId":"verify","text":"VERIFIED"},{"caseId":"second","text":"VERIFIED"}]},{"subject":"baseline","outputs":[{"caseId":"verify","text":"VERIFIED"},{"caseId":"second","text":"unknown"}]}])).unwrap();
    assert!(matches!(
        r.complete_evaluation(plan, &outputs, "test", "fixture", &ctx, NOW),
        Err(SkillError::Denied("learned_evaluation_stale"))
    ));
    assert_eq!(r.revision(&second).unwrap().state, RevisionState::Validated);
}

#[test]
fn changed_base_after_passing_evaluation_blocks_approval_and_activation() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let first = package(
        &dir,
        "first",
        "demo",
        "1.0.0",
        "Inspect supplied observations.",
        "one",
    );
    let second = package(
        &dir,
        "second",
        "demo",
        "1.0.1",
        "Inspect observations then verify the conclusion.",
        "two",
    );
    let scanner = FakeInspector::clean();
    let ctx = PolicyContext::current(&scanner);
    let mut r = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let first = r
        .import(&first, Origin::Generated, &source("one"), NOW)
        .unwrap()
        .revision_id;
    drop(prepare(&mut r, &first, &scanner));
    pass(&mut r, &first, &scanner);
    let approval = approve_tested(&mut r, &first, &scanner);
    r.activate(&first, approval, &ctx, NOW).unwrap();
    let prior = r.revision(&first).unwrap();
    let second = r
        .import_with_base(
            &second,
            Origin::Generated,
            &source("two"),
            NOW,
            None,
            Some(base(&prior)),
        )
        .unwrap()
        .revision_id;
    drop(prepare(&mut r, &second, &scanner));
    pass(&mut r, &second, &scanner);
    let approval = approve_tested(&mut r, &second, &scanner);
    r.deactivate("demo", "user-request", NOW).unwrap();
    assert_eq!(
        r.learned_quality(&second).unwrap().unwrap()["evaluation"]["status"],
        "stale"
    );
    assert!(matches!(
        r.activate(&second, approval, &ctx, NOW),
        Err(SkillError::Denied("learned_evaluation_stale"))
    ));
    assert!(r.active("demo").unwrap().is_none());
    pass(&mut r, &second, &scanner);
    assert_eq!(
        r.revision(&second).unwrap().state,
        RevisionState::AwaitingApproval
    );
    let old = r
        .conn()
        .query_row(
            "SELECT status FROM skill_approvals WHERE approval_id=?1",
            [approval],
            |row| row.get::<_, String>(0),
        )
        .unwrap();
    assert_eq!(old, "revoked");
    let fresh = approve_tested(&mut r, &second, &scanner);
    r.activate(&second, fresh, &ctx, NOW).unwrap();
}

#[test]
fn refinement_preserves_fixture_assertions_and_identical_payload_is_idempotent() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let first = package(
        &dir,
        "first",
        "demo",
        "1.0.0",
        "Inspect supplied observations.",
        "one",
    );
    let same = package(
        &dir,
        "same",
        "demo",
        "1.0.0",
        "Inspect supplied observations.",
        "two",
    );
    let changed = package(
        &dir,
        "changed",
        "demo",
        "1.0.1",
        "Inspect observations again.",
        "three",
    );
    let mut r = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let first = r
        .import(&first, Origin::Generated, &source("one"), NOW)
        .unwrap()
        .revision_id;
    let revision = r.revision(&first).unwrap();
    let reused = r
        .import_with_base(
            &same,
            Origin::Generated,
            &source("two"),
            NOW,
            None,
            Some(base(&revision)),
        )
        .unwrap();
    assert!(!reused.created);
    assert_eq!(reused.revision_id, first);
    let mut cases = tests();
    cases["cases"][0]["expectedIncludes"] = json!(["easier"]);
    fs::write(changed.join("TESTS.json"), cases.to_string()).unwrap();
    assert!(matches!(
        r.import_with_base(
            &changed,
            Origin::Generated,
            &source("three"),
            NOW,
            None,
            Some(base(&revision))
        ),
        Err(SkillError::Denied("refinement_tests_changed"))
    ));
    assert_eq!(r.list(None, None, 20).unwrap().len(), 1);
}

#[test]
fn exact_aliases_are_refused_and_distinct_same_category_procedures_remain_separate() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let first = package(
        &dir,
        "first",
        "demo",
        "1.0.0",
        "Inspect supplied observations.",
        "one",
    );
    let alias = package(
        &dir,
        "alias",
        "alternate",
        "1.0.0",
        "Inspect supplied observations.",
        "two",
    );
    let other = package(
        &dir,
        "other",
        "different",
        "1.0.0",
        "Produce a histogram from numeric buckets, compare quantiles, and describe the distribution without modifying the dataset.",
        "three",
    );
    let mut r = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    r.import(&first, Origin::Generated, &source("one"), NOW)
        .unwrap();
    assert!(matches!(
        r.import(&alias, Origin::Generated, &source("two"), NOW),
        Err(SkillError::Denied("generated_duplicate_candidate"))
    ));
    assert!(
        r.import(&other, Origin::Generated, &source("three"), NOW)
            .unwrap()
            .created
    );
    assert_eq!(r.list(None, None, 20).unwrap().len(), 2);
}

#[test]
fn completeness_ignores_fenced_fake_sections_and_fixture_assertion_conflicts() {
    assert_eq!(
        verification::missing_sections(
            "```md\n## When to Use\nA\n## Procedure\nB\n## Pitfalls\nC\n## Verification\nD\n```\n"
        )
        .len(),
        4
    );
    assert!(verification::missing_sections("# WHEN TO USE #\nUse.\n### Procedure\nAct.\n## Pitfalls\nAvoid.\n#### Verification\nCheck.").is_empty());
    assert_eq!(
        verification::missing_sections("## When to Use\n<!-- not real content -->\n---\n").len(),
        4
    );
    assert!(verification::cases(&json!([{"id":"case","input":"input","expectedIncludes":["always unsafe"],"forbiddenIncludes":["unsafe"]}])).is_err());
}

#[test]
fn refinement_cannot_drop_existing_references() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let first = package(
        &dir,
        "first",
        "demo",
        "1.0.0",
        "Read references/context.md before verifying.",
        "one",
    );
    fs::create_dir(first.join("references")).unwrap();
    fs::write(first.join("references/context.md"), "Supporting context.").unwrap();
    let next = package(
        &dir,
        "next",
        "demo",
        "1.0.1",
        "Verify with no supporting context.",
        "two",
    );
    let mut r = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let id = r
        .import(&first, Origin::Generated, &source("one"), NOW)
        .unwrap()
        .revision_id;
    let prior = r.revision(&id).unwrap();
    assert!(matches!(
        r.import_with_base(
            &next,
            Origin::Generated,
            &source("two"),
            NOW,
            None,
            Some(base(&prior))
        ),
        Err(SkillError::Denied("refinement_references_removed"))
    ));
}
#[test]
fn pending_revision_does_not_hide_duplicate_of_active_revision() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let first = package(
        &dir,
        "first",
        "demo",
        "1.0.0",
        "Inspect supplied observations.",
        "one",
    );
    let next = package(
        &dir,
        "next",
        "demo",
        "1.0.1",
        "Produce statistical charts using bucket frequency distribution estimates, then compare numerical quartiles and arithmetic medians.",
        "two",
    );
    let alias = package(
        &dir,
        "alias",
        "alternate",
        "1.0.0",
        "Inspect supplied observations.",
        "three",
    );
    let mut r = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let scanner = FakeInspector::clean();
    let ctx = PolicyContext::current(&scanner);
    let id = r
        .import(&first, Origin::Generated, &source("one"), NOW)
        .unwrap()
        .revision_id;
    drop(prepare(&mut r, &id, &scanner));
    pass(&mut r, &id, &scanner);
    let approval = approve_tested(&mut r, &id, &scanner);
    r.activate(&id, approval, &ctx, NOW).unwrap();
    let prior = r.revision(&id).unwrap();
    r.import_with_base(
        &next,
        Origin::Generated,
        &source("two"),
        NOW,
        None,
        Some(base(&prior)),
    )
    .unwrap();
    assert!(matches!(
        r.import(&alias, Origin::Generated, &source("three"), NOW),
        Err(SkillError::Denied("generated_duplicate_candidate"))
    ));
}
#[test]
fn completeness_keeps_nested_sections_and_rejects_fake_closers_and_placeholders() {
    assert!(verification::missing_sections("## When to Use\nUse this.\n## Procedure\n### Step one\nDo this.\n## Pitfalls\nAvoid this.\n## Verification\nCheck this.").is_empty());
    assert_eq!(
        verification::missing_sections("```md\n```not-a-close\n## Procedure\nNot prose.\n```")
            .len(),
        4
    );
    assert_eq!(
        verification::missing_sections("    ## Procedure\n    Not prose.").len(),
        4
    );
    assert_eq!(
        verification::missing_sections("## Procedure\n- **TODO**\n## Verification\n1. TBD").len(),
        4
    );
}

#[test]
fn near_duplicate_class_is_flagged_without_collapsing_unrelated_category_members() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let procedure = "Inspect the supplied observations, identify the expected condition, compare actual evidence against every stated requirement, record missing context, distinguish measured facts from assumptions, and report each verification result with supporting details.";
    let first = package(&dir, "first", "demo", "1.0.0", procedure, "one");
    let similar = package(
        &dir,
        "similar",
        "alternate",
        "1.0.0",
        &format!("{procedure} Recheck evidence."),
        "two",
    );
    let mut r = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    r.import(&first, Origin::Generated, &source("one"), NOW)
        .unwrap();
    assert!(matches!(
        r.import(&similar, Origin::Generated, &source("two"), NOW),
        Err(SkillError::Denied("generated_possible_duplicate"))
    ));
}

#[test]
fn generated_gate_follows_package_and_revision_origin_across_manual_imports() {
    for generated_first in [true, false] {
        let dir = TempDir::new();
        let mut store = open(&dir);
        let first = package(
            &dir,
            "first",
            "demo",
            "1.0.0",
            "Inspect supplied observations.",
            "one",
        );
        let next = package(
            &dir,
            "next",
            "demo",
            "1.0.1",
            "Verify additional observations.",
            "two",
        );
        let mut r = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
        r.import(
            &first,
            if generated_first {
                Origin::Generated
            } else {
                Origin::User
            },
            &source("one"),
            NOW,
        )
        .unwrap();
        let id = r
            .import(
                if generated_first { &next } else { &first },
                if generated_first {
                    Origin::User
                } else {
                    Origin::Generated
                },
                &source("two"),
                NOW,
            )
            .unwrap()
            .revision_id;
        let scanner = FakeInspector::clean();
        let ctx = PolicyContext::current(&scanner);
        r.inspect(&id, &scanner, POLICY_VERSION, NOW).unwrap();
        r.validate(&id, &ctx, NOW).unwrap();
        assert!(r.learned_quality(&id).unwrap().is_some());
        assert!(matches!(
            r.request_instruction_approval(&id, &ctx, NOW),
            Err(SkillError::Denied("learned_evaluation_required"))
        ));
        assert!(matches!(
            r.record_evaluation(&id, EvaluationResult::Passed, None, None, NOW),
            Err(SkillError::Denied("learned_evaluation_required"))
        ));
    }
}

#[test]
fn simultaneous_alias_imports_serialize_before_duplicate_check_and_commit() {
    use std::sync::{Arc, Barrier, Mutex};
    let dir = TempDir::new();
    let store = Arc::new(Mutex::new(open(&dir)));
    let barrier = Arc::new(Barrier::new(2));
    let first = package(
        &dir,
        "first",
        "demo",
        "1.0.0",
        "Inspect supplied observations.",
        "one",
    );
    let alias = package(
        &dir,
        "alias",
        "alternate",
        "1.0.0",
        "Inspect supplied observations.",
        "two",
    );
    std::thread::scope(|scope| {
        let handles = [(first, "one"), (alias, "two")]
            .into_iter()
            .map(|(path, session)| {
                let store = store.clone();
                let barrier = barrier.clone();
                let data = dir.data();
                scope.spawn(move || {
                    barrier.wait();
                    let mut guard = store.lock().unwrap();
                    let mut r = SkillRegistry::new(&mut guard, &data, profile("default"));
                    r.import(&path, Origin::Generated, &source(session), NOW)
                })
            })
            .collect::<Vec<_>>();
        let results = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|r| matches!(r, Err(SkillError::Denied("generated_duplicate_candidate"))))
                .count(),
            1
        );
    });
    let mut guard = store.lock().unwrap();
    let mut registry = SkillRegistry::new(&mut guard, &dir.data(), profile("default"));
    assert_eq!(registry.list(None, None, 20).unwrap().len(), 1);
}
