use super::*;
use extalia_core::skills::registry::ApprovalRequest;
use extalia_core::time::now_millis;

fn registered(
    dir: &TempDir,
    store: &mut CoreStore,
    name: &str,
    extra: Value,
    scope: Option<&str>,
    activate: bool,
    relations: bool,
) -> String {
    let mut m: Value = serde_json::from_str(&manifest("1.0.0")).unwrap();
    m["id"] = json!(name);
    for (key, value) in extra.as_object().unwrap() {
        m[key] = value.clone();
    }
    let skill = SKILL_MD.replace("name: demo", &format!("name: {name}"));
    let source = dir.inbox_package(
        "default",
        name,
        &[("SKILL.md", &skill), ("extalia-skill.json", &m.to_string())],
    );
    let inspector = FakeInspector(Severity::None);
    let ctx = PolicyContext::current(&inspector);
    let now = now_millis();
    let revision = {
        let mut registry =
            SkillRegistry::new(store, &dir.data(), ProfileId::parse("default").unwrap());
        let revision = registry
            .import(&source, Origin::User, "fixture", now)
            .unwrap()
            .revision_id;
        registry
            .inspect(&revision, &inspector, POLICY_VERSION, now)
            .unwrap();
        revision
    };
    if !activate {
        return revision;
    }
    {
        let mut registry =
            SkillRegistry::new(store, &dir.data(), ProfileId::parse("default").unwrap());
        let result = registry.validate(&revision, &ctx, now);
        if relations {
            assert!(result.is_err());
        } else {
            result.unwrap();
        }
    }
    if relations {
        // A historical relation-bearing activation fixture; production validation stays closed.
        rusqlite::Connection::open(store_path(&dir.data()))
            .unwrap()
            .execute(
                "UPDATE skill_revisions SET state='validated' WHERE revision_id=?1",
                [&revision],
            )
            .unwrap();
    }
    let mut registry = SkillRegistry::new(store, &dir.data(), ProfileId::parse("default").unwrap());
    registry
        .record_evaluation(
            &revision,
            EvaluationResult::Passed,
            None,
            Some("evidence:fixture"),
            now,
        )
        .unwrap();
    registry
        .decide(&revision, &ctx, &ProfileGrants::default(), now)
        .unwrap();
    let record = registry.revision(&revision).unwrap();
    let approval = registry
        .approve(
            &ApprovalRequest {
                revision_id: &revision,
                shown_tree_sha256: &record.tree_sha256,
                shown_permission_digest: &record.permission_digest,
                workspace_id: scope,
                approver: USER,
                expires_at_ms: now + 600_000,
            },
            &ctx,
            now,
        )
        .unwrap();
    registry.activate(&revision, approval, &ctx, now).unwrap();
    revision
}
fn input(ids: &[&str]) -> Value {
    json!({"categories":["quality"],"intents":[],"candidateRevisionIds":ids,"pins":{},"maxResults":16})
}
fn preview(
    dir: &TempDir,
    session: &mut Session,
    input: Value,
) -> Result<Value, (String, Option<String>)> {
    let before = super::preflight::snapshot(dir);
    let result = op(session, "skill.routingPreview", input);
    assert_eq!(super::preflight::snapshot(dir), before);
    result
}
#[test]
fn eligibility_precedes_ranking_and_tie_survives_truncation_without_writes() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let inactive = registered(
        &dir,
        &mut store,
        "inactive",
        json!({"categories":["quality"]}),
        None,
        false,
        false,
    );
    let a = registered(
        &dir,
        &mut store,
        "alpha",
        json!({"categories":["quality.review"]}),
        None,
        true,
        false,
    );
    let b = registered(
        &dir,
        &mut store,
        "beta",
        json!({"categories":["quality.tests"]}),
        None,
        true,
        false,
    );
    let mut session = start(&dir, store, "default", Some(FakeInspector(Severity::None)));
    assert!(hello(&mut session).contains(&"skill.routingPreview".into()));
    let mut request = input(&[&inactive, &a, &b]);
    request["maxResults"] = json!(1);
    let report = preview(&dir, &mut session, request).unwrap();
    assert_eq!(report["status"], "ambiguous");
    assert_eq!(report["dispatchEligible"], false);
    assert_eq!(report["eligibleCount"], 2);
    assert_eq!(report["topTieCount"], 2);
    assert_eq!(report["candidates"].as_array().unwrap().len(), 1);
    assert_eq!(report["candidates"][0]["identity"]["packageId"], "alpha");
    assert_eq!(report["exclusions"][0]["reason"], "root_inactive");
}
#[test]
fn approval_workspace_and_explicit_missing_pins_are_diagnostics_only() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let scoped = registered(
        &dir,
        &mut store,
        "scoped",
        json!({"categories":["quality"]}),
        Some(WORKSPACE),
        true,
        false,
    );
    let dependency = registered(&dir, &mut store, "dependency", json!({}), None, true, false);
    let root = registered(
        &dir,
        &mut store,
        "root",
        json!({"categories":["quality"],"dependencies":[{"id":"dependency","range":"^1"}]}),
        None,
        true,
        true,
    );
    let mut session = start(&dir, store, "default", Some(FakeInspector(Severity::None)));
    assert_eq!(
        preview(&dir, &mut session, input(&[&scoped])).unwrap()["status"],
        "no_safe_skill"
    );
    let mut request = input(&[&scoped]);
    request["workspaceId"] = json!(WORKSPACE);
    assert_eq!(
        preview(&dir, &mut session, request).unwrap()["status"],
        "matched"
    );
    let missing = preview(&dir, &mut session, input(&[&root])).unwrap();
    assert_eq!(missing["status"], "no_safe_skill");
    assert!(
        missing["exclusions"][0]["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["code"] == "missing_pin")
    );
    let mut pinned = input(&[&root]);
    pinned["pins"] = json!({"dependency":dependency});
    let result = preview(&dir, &mut session, pinned).unwrap();
    assert_eq!(result["status"], "matched");
    assert_eq!(
        result["candidates"][0]["plan"][0]["packageId"],
        "dependency"
    );
}
#[test]
fn unavailable_scanner_and_tampered_staged_sources_do_not_mutate_registry() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let revision = registered(
        &dir,
        &mut store,
        "alpha",
        json!({"categories":["quality"]}),
        None,
        true,
        false,
    );
    let mut unavailable = start(&dir, store, "default", None);
    assert_eq!(
        preview(&dir, &mut unavailable, input(&[&revision])).unwrap()["status"],
        "invalid"
    );
    let store = close(unavailable);
    let mut session = start(&dir, store, "default", Some(FakeInspector(Severity::None)));
    let object = dir
        .data()
        .join("profiles/default/skills/objects")
        .join(revision.strip_prefix("skr_").unwrap())
        .join("SKILL.md");
    make_writable(&object);
    fs::write(&object, b"tampered").unwrap();
    assert!(preview(&dir, &mut session, input(&[&revision])).is_err());
}
