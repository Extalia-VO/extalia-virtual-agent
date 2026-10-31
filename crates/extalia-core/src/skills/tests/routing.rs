//! Source and scope observations in disposable profiles; never execution authority.
use super::preflight::{inspected, package, snapshot};
use super::*;
use crate::skills::registry::RegistryRoutingRequest;
use crate::skills::routing::{
    RoutingExclusionReason, RoutingInputIssue, RoutingReport, RoutingStatus,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const WORKSPACE_A: &str = "00000000-0000-4000-8000-000000000001";
const WORKSPACE_B: &str = "00000000-0000-4000-8000-000000000002";

fn request(candidates: &[&str]) -> RegistryRoutingRequest {
    RegistryRoutingRequest {
        categories: BTreeSet::from(["quality".into()]),
        intents: BTreeSet::new(),
        candidate_revision_ids: candidates.iter().map(|id| (*id).into()).collect(),
        pins: BTreeMap::new(),
        workspace_id: None,
        runtime_facts: BTreeMap::new(),
        permissions_ceiling: Permissions::default(),
        max_results: 16,
    }
}

fn observe(
    store: &mut CoreStore,
    dir: &TempDir,
    input: &RegistryRoutingRequest,
    ctx: &PolicyContext,
) -> Result<RoutingReport, SkillError> {
    let before = snapshot(store);
    let result =
        SkillRegistry::new(store, &dir.data(), profile("default")).routing_preview(input, ctx, NOW);
    assert_eq!(
        snapshot(store),
        before,
        "routing preview must not write any skill table"
    );
    if let Ok(report) = &result {
        assert!(!report.dispatch_eligible());
    }
    result
}

fn active(
    store: &mut CoreStore,
    dir: &TempDir,
    id: &str,
    extra: Value,
    scope: Option<&str>,
    relation_fixture: bool,
) -> String {
    let inspector = FakeInspector::clean();
    let ctx = PolicyContext::current(&inspector);
    let source = package(dir, id, "1.0.0", extra);
    let revision = {
        let mut registry = SkillRegistry::new(store, &dir.data(), profile("default"));
        let revision = inspected(&mut registry, &source, &inspector);
        let outcome = registry.validate(&revision, &ctx, NOW);
        if relation_fixture {
            assert!(matches!(
                outcome,
                Err(SkillError::Denied("resolver_unavailable"))
            ));
        } else {
            outcome.unwrap();
        }
        revision
    };
    if relation_fixture {
        // Temporary fixture for an already-validated relation-bearing active package.
        // The production validation gate above stays closed; source bytes are unchanged.
        store
            .connection()
            .execute(
                "UPDATE skill_revisions SET state='validated' WHERE revision_id=?1",
                [&revision],
            )
            .unwrap();
    }
    let mut registry = SkillRegistry::new(store, &dir.data(), profile("default"));
    registry
        .record_evaluation(
            &revision,
            EvaluationResult::Passed,
            None,
            Some("evidence:fixture"),
            NOW,
        )
        .unwrap();
    assert!(matches!(
        registry
            .decide(&revision, &ctx, &ProfileGrants::default(), NOW)
            .unwrap(),
        Route::AwaitingApproval(_)
    ));
    let record = registry.revision(&revision).unwrap();
    let approval = registry
        .approve(
            &ApprovalRequest {
                revision_id: &revision,
                shown_tree_sha256: &record.tree_sha256,
                shown_permission_digest: &record.permission_digest,
                workspace_id: scope,
                approver: "user:owner",
                expires_at_ms: LATER,
            },
            &ctx,
            NOW,
        )
        .unwrap();
    registry.activate(&revision, approval, &ctx, NOW).unwrap();
    revision
}

#[test]
fn routing_snapshot_uses_real_manifest_metadata_not_category_index_and_keeps_deprecated_pointer() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let ctx = PolicyContext::current(&FakeInspector::clean());
    let first = active(
        &mut store,
        &dir,
        "review",
        json!({"categories":["quality.review"],"intents":["review_code"]}),
        None,
        false,
    );
    let second = active(
        &mut store,
        &dir,
        "tests",
        json!({"categories":["quality.tests"],"intents":["run_tests"]}),
        None,
        false,
    );
    store
        .connection()
        .execute(
            "DELETE FROM skill_category_map WHERE revision_id=?1",
            [&first],
        )
        .unwrap();
    store.connection().execute("INSERT INTO skill_category_map(profile_id,revision_id,category_id) VALUES('default',?1,'quality.tests')",[&first]).unwrap();
    let mut input = request(&[&first, &second]);
    input.intents.insert("review_code".into());
    let report = observe(&mut store, &dir, &input, &ctx).unwrap();
    assert_eq!(report.status, RoutingStatus::Matched);
    assert_eq!(report.candidates.len(), 1);
    assert_eq!(report.candidates[0].identity.revision_id, first);
    assert_eq!(
        report.candidates[0].matches.descendant_categories[0].declared,
        "quality.review"
    );
    SkillRegistry::new(&mut store, &dir.data(), profile("default"))
        .deprecate("review", NOW)
        .unwrap();
    assert_eq!(
        observe(&mut store, &dir, &input, &ctx).unwrap().status,
        RoutingStatus::Matched
    );
}

#[test]
fn routing_snapshot_requires_root_approval_scope_and_never_infers_workspace() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let ctx = PolicyContext::current(&FakeInspector::clean());
    let root = active(
        &mut store,
        &dir,
        "review",
        json!({"categories":["quality.review"]}),
        Some(WORKSPACE_A),
        false,
    );
    for scope in [None, Some(WORKSPACE_B), Some(WORKSPACE_A)] {
        let mut input = request(&[&root]);
        input.workspace_id = scope.map(str::to_owned);
        let report = observe(&mut store, &dir, &input, &ctx).unwrap();
        assert_eq!(
            report.status,
            if scope == Some(WORKSPACE_A) {
                RoutingStatus::Matched
            } else {
                RoutingStatus::NoSafeSkill
            }
        );
    }
}

#[test]
fn routing_snapshot_checks_dependency_scope_but_retains_unrelated_ambient_context() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let ctx = PolicyContext::current(&FakeInspector::clean());
    let dep = active(
        &mut store,
        &dir,
        "dependency",
        json!({}),
        Some(WORKSPACE_A),
        false,
    );
    active(
        &mut store,
        &dir,
        "ambient",
        json!({}),
        Some(WORKSPACE_B),
        false,
    );
    let root = active(
        &mut store,
        &dir,
        "review",
        json!({"categories":["quality.review"],"dependencies":[{"id":"dependency","range":"^1"}]}),
        None,
        true,
    );
    let mut input = request(&[&root]);
    input.pins.insert("dependency".into(), dep);
    for scope in [None, Some(WORKSPACE_B), Some(WORKSPACE_A)] {
        input.workspace_id = scope.map(str::to_owned);
        let report = observe(&mut store, &dir, &input, &ctx).unwrap();
        assert_eq!(
            report.status,
            if scope == Some(WORKSPACE_A) {
                RoutingStatus::Matched
            } else {
                RoutingStatus::NoSafeSkill
            }
        );
        if scope != Some(WORKSPACE_A) {
            assert_eq!(
                report.exclusions[0].reason,
                RoutingExclusionReason::InconsistentPreflight
            );
        }
    }
}

#[test]
fn routing_snapshot_drops_inactive_unscanned_and_stale_roots_before_ranking() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let inspector = FakeInspector::clean();
    let ctx = PolicyContext::current(&inspector);
    let inactive = {
        let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
        inspected(
            &mut registry,
            &package(&dir, "inactive", "1.0.0", json!({"categories":["quality"]})),
            &inspector,
        )
    };
    let unscanned = SkillRegistry::new(&mut store, &dir.data(), profile("default"))
        .import(
            &package(
                &dir,
                "unscanned",
                "1.0.0",
                json!({"categories":["quality"]}),
            ),
            Origin::User,
            "test",
            NOW,
        )
        .unwrap()
        .revision_id;
    let root = active(
        &mut store,
        &dir,
        "review",
        json!({"categories":["quality.review"]}),
        None,
        false,
    );
    let report = observe(
        &mut store,
        &dir,
        &request(&[&inactive, &unscanned, &root]),
        &ctx,
    )
    .unwrap();
    assert_eq!(report.status, RoutingStatus::Matched);
    assert_eq!(report.candidates[0].identity.revision_id, root);
    let mut stale = ctx.clone();
    stale.scanner.normalizer_version = Some("changed".into());
    let report = observe(&mut store, &dir, &request(&[&root]), &stale).unwrap();
    assert_eq!(report.status, RoutingStatus::Invalid);
    assert!(report.issues.contains(&RoutingInputIssue::InvalidContext));
    assert!(report.candidates.is_empty());
}

#[test]
fn routing_snapshot_denies_tampered_foreign_and_builtin_sources_without_writes() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let inspector = FakeInspector::clean();
    let ctx = PolicyContext::current(&inspector);
    let root = active(
        &mut store,
        &dir,
        "review",
        json!({"categories":["quality"]}),
        None,
        false,
    );
    let object = {
        let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
        let hash = registry.revision(&root).unwrap().tree_sha256;
        registry.object_store().object_dir(&hash).join("SKILL.md")
    };
    tamper(&object, b"changed");
    assert!(matches!(
        observe(&mut store, &dir, &request(&[&root]), &ctx),
        Err(SkillError::Denied("preflight_source_integrity"))
    ));
    let foreign = {
        let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("other"));
        inspected(
            &mut registry,
            &package(&dir, "foreign", "1.0.0", json!({})),
            &inspector,
        )
    };
    assert!(matches!(
        observe(&mut store, &dir, &request(&[&foreign]), &ctx),
        Err(SkillError::Denied("preflight_revision_unavailable"))
    ));
    let mut catalog = BuiltinCatalog::new(&dir.data(), &profile("default"));
    let builtin = catalog
        .register(
            &mut store,
            &package(&dir, "bundled", "1.0.0", json!({})),
            NOW,
        )
        .unwrap()
        .revision_id
        .clone();
    assert!(matches!(
        observe(&mut store, &dir, &request(&[&builtin]), &ctx),
        Err(SkillError::Denied("preflight_revision_unavailable"))
    ));
}

#[test]
fn routing_snapshot_refuses_bounds_and_invalid_scope_before_source_reads() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let ctx = PolicyContext::current(&FakeInspector::clean());
    let root = format!("skr_{}", "a".repeat(64));
    let base = request(&[&root]);
    let mut selectors = base.clone();
    selectors.categories = BTreeSet::from(["../private".into()]);
    let mut oversized = base.clone();
    oversized.categories = BTreeSet::from(["a.".repeat(100_000)]);
    let mut scope = base.clone();
    scope.workspace_id = Some("foreign/path".into());
    let mut duplicates = base.clone();
    duplicates.candidate_revision_ids.push(root.clone());
    let mut count = base.clone();
    count.candidate_revision_ids = (0..17).map(|i| format!("skr_{i:064x}")).collect();
    let mut facts = base.clone();
    facts.runtime_facts = (0..129)
        .map(|i| (format!("fact-{i}"), "1.0.0".into()))
        .collect();
    let mut results = base;
    results.max_results = 17;
    for input in [
        selectors, oversized, scope, duplicates, count, facts, results,
    ] {
        assert!(matches!(
            observe(&mut store, &dir, &input, &ctx),
            Err(SkillError::Denied("routing_input_bound"))
        ));
    }
}

#[test]
fn routing_snapshot_preserves_conflicts_from_foreign_scoped_ambient_packages() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let ctx = PolicyContext::current(&FakeInspector::clean());
    let root = active(
        &mut store,
        &dir,
        "review",
        json!({"categories":["quality.review"]}),
        Some(WORKSPACE_A),
        false,
    );
    active(
        &mut store,
        &dir,
        "ambient-conflict",
        json!({"conflicts":[{"id":"review"}]}),
        Some(WORKSPACE_B),
        true,
    );
    let mut input = request(&[&root]);
    input.workspace_id = Some(WORKSPACE_A.into());
    let report = observe(&mut store, &dir, &input, &ctx).unwrap();
    assert_eq!(report.status, RoutingStatus::NoSafeSkill);
    assert_eq!(
        report.exclusions[0].reason,
        RoutingExclusionReason::InconsistentPreflight
    );
    assert!(report.candidates.is_empty());
}
