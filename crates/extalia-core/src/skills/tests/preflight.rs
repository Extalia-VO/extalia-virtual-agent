//! Actual staged objects and temporary profiles, never a real user data directory.

use std::collections::BTreeMap;

use super::*;
use crate::skills::registry::RegistryPreflightRequest;
use crate::skills::resolver::{PreflightIssue, PreflightReport, ResolverLimits};
use rusqlite::params;
use serde_json::{Value, json};

pub(super) fn package(dir: &TempDir, id: &str, version: &str, extra: Value) -> PathBuf {
    let mut manifest = json!({
        "schema": "extalia.skill-manifest.v1", "id": id,
        "version": version, "risk_class": "declarative",
    });
    manifest
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    dir.package(
        &format!("{id}-{version}"),
        &[
            (
                "SKILL.md",
                &format!("---\nname: {id}\ndescription: Test skill\n---\nRead the workspace.\n"),
            ),
            ("extalia-skill.json", &manifest.to_string()),
        ],
    )
}

pub(super) fn inspected(
    registry: &mut SkillRegistry<'_>,
    source: &Path,
    inspector: &FakeInspector,
) -> String {
    let id = registry
        .import(source, Origin::User, "test", NOW)
        .unwrap()
        .revision_id;
    assert_eq!(
        registry
            .inspect(&id, inspector, POLICY_VERSION, NOW)
            .unwrap()
            .state,
        RevisionState::Inspected
    );
    id
}

fn input(root: &str, pins: &[(&str, &str)]) -> RegistryPreflightRequest {
    RegistryPreflightRequest {
        root_revision_id: root.into(),
        pins: pins
            .iter()
            .map(|(id, revision)| ((*id).into(), (*revision).into()))
            .collect(),
        runtime_facts: BTreeMap::new(),
        permissions_ceiling: Permissions::default(),
        limits: ResolverLimits::default(),
    }
}

/// Snapshot every skill table, including activation/index and append-only history.
/// Rows are compared directly so a compensating write cannot hide behind row counts.
pub(super) fn snapshot(store: &mut CoreStore) -> Vec<(String, Vec<Vec<rusqlite::types::Value>>)> {
    let conn = store.connection();
    let tables = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'skill_%' ORDER BY name").unwrap()
        .query_map([], |row| row.get::<_, String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    tables
        .into_iter()
        .map(|table| {
            let mut statement = conn
                .prepare(&format!("SELECT * FROM \"{table}\" ORDER BY rowid"))
                .unwrap();
            let count = statement.column_count();
            let rows = statement
                .query_map([], |row| {
                    (0..count)
                        .map(|index| row.get(index))
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            (table, rows)
        })
        .collect()
}

fn observe(
    dir: &TempDir,
    profile_id: &str,
    request: &RegistryPreflightRequest,
    ctx: &PolicyContext,
) -> Result<PreflightReport, SkillError> {
    let mut store = open(dir);
    observe_store(&mut store, dir, profile_id, request, ctx)
}

fn observe_store(
    store: &mut CoreStore,
    dir: &TempDir,
    profile_id: &str,
    request: &RegistryPreflightRequest,
    ctx: &PolicyContext,
) -> Result<PreflightReport, SkillError> {
    let before = snapshot(store);
    let result = {
        let mut registry = SkillRegistry::new(store, &dir.data(), profile(profile_id));
        registry.dependency_preflight(request, ctx, NOW)
    };
    assert_eq!(
        snapshot(store),
        before,
        "preflight must not change any skill table"
    );
    if let Ok(report) = &result {
        assert!(!report.dispatch_eligible());
    }
    result
}

#[test]
fn preflight_adapter_reads_exact_active_dependency_without_approving_root() {
    let dir = TempDir::new();
    let inspector = FakeInspector::clean();
    let ctx = PolicyContext::current(&inspector);
    let mut store = open(&dir);
    let (root, dependency) = {
        let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
        let (dependency, approval) = approve(
            &mut registry,
            &package(&dir, "dependency", "1.2.0", json!({})),
            &inspector,
        );
        registry.activate(&dependency, approval, &ctx, NOW).unwrap();
        let root = inspected(
            &mut registry,
            &package(
                &dir,
                "root",
                "1.0.0",
                json!({"dependencies": [{"id":"dependency", "range":"^1"}]}),
            ),
            &inspector,
        );
        assert!(matches!(
            registry.validate(&root, &ctx, NOW),
            Err(SkillError::Denied("resolver_unavailable"))
        ));
        (root, dependency)
    };
    drop(store);
    let request = input(&root, &[("dependency", &dependency)]);
    let report = observe(&dir, "default", &request, &ctx).unwrap();
    assert!(report.issues.is_empty());
    assert_eq!(
        report
            .plan
            .unwrap()
            .iter()
            .map(|item| item.package_id.as_str())
            .collect::<Vec<_>>(),
        vec!["dependency", "root"]
    );
    let mut store = open(&dir);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    assert_eq!(
        registry.revision(&root).unwrap().state,
        RevisionState::Inspected
    );
    assert!(matches!(
        registry.validate(&root, &ctx, NOW),
        Err(SkillError::Denied("resolver_unavailable"))
    ));
}

#[test]
fn preflight_adapter_requires_exact_pins_and_current_activation_but_accepts_deprecated_pointer() {
    let dir = TempDir::new();
    let inspector = FakeInspector::clean();
    let ctx = PolicyContext::current(&inspector);
    let mut store = open(&dir);
    let (root, dependency) = {
        let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
        let (dependency, approval) = approve(
            &mut registry,
            &package(&dir, "dependency", "1.0.0", json!({})),
            &inspector,
        );
        registry.activate(&dependency, approval, &ctx, NOW).unwrap();
        let root = inspected(
            &mut registry,
            &package(
                &dir,
                "root",
                "1.0.0",
                json!({"dependencies": [{"id":"dependency", "range":"^1"}]}),
            ),
            &inspector,
        );
        (root, dependency)
    };
    drop(store);
    let missing = observe(&dir, "default", &input(&root, &[]), &ctx).unwrap();
    assert!(missing.issues.contains(&PreflightIssue::MissingPin {
        package_id: "root".into(),
        dependency_id: "dependency".into()
    }));
    assert!(missing.plan.is_none());
    {
        let mut store = open(&dir);
        SkillRegistry::new(&mut store, &dir.data(), profile("default"))
            .deprecate("dependency", NOW)
            .unwrap();
    }
    let request = input(&root, &[("dependency", &dependency)]);
    let deprecated = observe(&dir, "default", &request, &ctx).unwrap();
    assert!(deprecated.issues.is_empty());
    {
        let mut store = open(&dir);
        SkillRegistry::new(&mut store, &dir.data(), profile("default"))
            .deactivate("dependency", "test", NOW)
            .unwrap();
    }
    let inactive = observe(&dir, "default", &request, &ctx).unwrap();
    assert!(
        inactive
            .issues
            .contains(&PreflightIssue::DependencyInactive {
                package_id: "root".into(),
                dependency_id: "dependency".into()
            })
    );
    assert!(inactive.plan.is_none());
}

#[test]
fn preflight_adapter_denies_foreign_root_foreign_dependency_and_wrong_package_pin() {
    let dir = TempDir::new();
    let inspector = FakeInspector::clean();
    let ctx = PolicyContext::current(&inspector);
    let mut store = open(&dir);
    let (root, local) = {
        let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
        let root = inspected(
            &mut registry,
            &package(&dir, "root", "1.0.0", json!({})),
            &inspector,
        );
        let local = inspected(
            &mut registry,
            &package(&dir, "local", "1.0.0", json!({})),
            &inspector,
        );
        (root, local)
    };
    let foreign = {
        let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("other"));
        inspected(
            &mut registry,
            &package(&dir, "foreign", "1.0.0", json!({})),
            &inspector,
        )
    };
    drop(store);
    for request in [input(&foreign, &[]), input(&root, &[("foreign", &foreign)])] {
        assert!(matches!(
            observe(&dir, "default", &request, &ctx),
            Err(SkillError::Denied("preflight_revision_unavailable"))
        ));
    }
    assert!(matches!(
        observe(&dir, "other", &input(&root, &[]), &ctx),
        Err(SkillError::Denied("preflight_revision_unavailable"))
    ));
    assert!(matches!(
        observe(
            &dir,
            "default",
            &input(&root, &[("wrong-package", &local)]),
            &ctx
        ),
        Err(SkillError::Denied("preflight_pin_mismatch"))
    ));
}

#[test]
fn preflight_adapter_unscanned_and_stale_attestation_roots_remain_unavailable() {
    let dir = TempDir::new();
    let inspector = FakeInspector::clean();
    let ctx = PolicyContext::current(&inspector);
    let mut store = open(&dir);
    let (unscanned, scanned) = {
        let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
        let unscanned = registry
            .import(
                &package(&dir, "unscanned", "1.0.0", json!({})),
                Origin::User,
                "test",
                NOW,
            )
            .unwrap()
            .revision_id;
        let scanned = inspected(
            &mut registry,
            &package(&dir, "scanned", "1.0.0", json!({})),
            &inspector,
        );
        (unscanned, scanned)
    };
    drop(store);
    let mut stale = ctx.clone();
    stale.scanner.version = Some("2.0.0".into());
    for (id, context) in [(&unscanned, &ctx), (&scanned, &stale)] {
        let report = observe(&dir, "default", &input(id, &[]), context).unwrap();
        assert!(
            report.issues.contains(&PreflightIssue::RootUnavailable {
                package_id: if id == &unscanned {
                    "unscanned"
                } else {
                    "scanned"
                }
                .into()
            })
        );
        assert!(report.plan.is_none());
    }
}

#[test]
fn preflight_adapter_tampered_object_fails_without_revocation_or_history_writes() {
    let dir = TempDir::new();
    let inspector = FakeInspector::clean();
    let ctx = PolicyContext::current(&inspector);
    let mut store = open(&dir);
    let (root, object) = {
        let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
        let root = inspected(
            &mut registry,
            &package(&dir, "root", "1.0.0", json!({})),
            &inspector,
        );
        let revision = registry.revision(&root).unwrap();
        let object = registry
            .object_store()
            .object_dir(&revision.tree_sha256)
            .join("SKILL.md");
        (root, object)
    };
    drop(store);
    tamper(&object, b"changed staged instructions");
    assert!(matches!(
        observe(&dir, "default", &input(&root, &[]), &ctx),
        Err(SkillError::Denied("preflight_source_integrity"))
    ));
}

#[test]
fn preflight_adapter_rejects_corrupt_hash_manifest_and_permissions_without_writes() {
    for corruption in ["tree", "manifest", "permissions"] {
        let dir = TempDir::new();
        let inspector = FakeInspector::clean();
        let ctx = PolicyContext::current(&inspector);
        let mut store = open(&dir);
        let root = {
            let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
            inspected(
                &mut registry,
                &package(&dir, "root", "1.0.0", json!({})),
                &inspector,
            )
        };
        // Simulate damaged persisted metadata, bypassing immutability only in this
        // temporary fixture. Preflight must detect it without trying to repair it.
        match corruption {
            "tree" => {
                store.connection().execute_batch("DROP TRIGGER skill_revisions_immutable; PRAGMA ignore_check_constraints = ON;").unwrap();
                store
                    .connection()
                    .execute(
                        "UPDATE skill_revisions SET tree_sha256 = ?1 WHERE revision_id = ?2",
                        params!["/".repeat(64), root],
                    )
                    .unwrap();
            }
            "manifest" => {
                store
                    .connection()
                    .execute_batch("DROP TRIGGER skill_revisions_immutable;")
                    .unwrap();
                let changed = manifest::parse_manifest(&serde_json::to_vec(&json!({"schema":"extalia.skill-manifest.v1", "id":"root", "version":"2.0.0", "risk_class":"declarative"})).unwrap()).unwrap().canonical_json();
                store
                    .connection()
                    .execute(
                        "UPDATE skill_revisions SET manifest_json = ?1 WHERE revision_id = ?2",
                        params![changed, root],
                    )
                    .unwrap();
            }
            _ => {
                store.connection().execute("INSERT INTO skill_permissions (profile_id, revision_id, capability, scope) VALUES ('default', ?1, 'terminal', '*')", [&root]).unwrap();
            }
        }
        assert!(
            matches!(
                observe_store(&mut store, &dir, "default", &input(&root, &[]), &ctx),
                Err(SkillError::Denied("preflight_source_integrity"))
            ),
            "{corruption}"
        );
    }
}

#[test]
fn preflight_adapter_compatibility_and_ceiling_are_claims_without_grants() {
    let dir = TempDir::new();
    let inspector = FakeInspector::clean();
    let ctx = PolicyContext::current(&inspector);
    let mut store = open(&dir);
    let root = {
        let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
        inspected(
            &mut registry,
            &package(
                &dir,
                "root",
                "1.0.0",
                json!({"compatibility":{"runtime": "^2"}, "permissions":{"filesystem_read":["src/**"]}}),
            ),
            &inspector,
        )
    };
    drop(store);
    let mut request = input(&root, &[]);
    let report = observe(&dir, "default", &request, &ctx).unwrap();
    assert!(
        report
            .issues
            .contains(&PreflightIssue::CompatibilityUnknown {
                package_id: "root".into(),
                fact_id: "runtime".into()
            })
    );
    assert!(
        report
            .issues
            .iter()
            .any(|issue| matches!(issue, PreflightIssue::PermissionOutsideCeiling { .. }))
    );
    request
        .runtime_facts
        .insert("runtime".into(), "2.1.0".into());
    request
        .permissions_ceiling
        .filesystem_read
        .insert("src/**".into());
    let report = observe(&dir, "default", &request, &ctx).unwrap();
    assert!(report.issues.is_empty());
    assert!(report.plan.is_some());
    assert!(!report.dispatch_eligible());
}

#[test]
fn preflight_adapter_checks_unreachable_active_consumers_against_candidate_replacement() {
    let dir = TempDir::new();
    let inspector = FakeInspector::clean();
    let ctx = PolicyContext::current(&inspector);
    let mut store = open(&dir);
    let (root, consumer) = {
        let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
        let (old, approval) = approve(
            &mut registry,
            &package(&dir, "root", "1.0.0", json!({})),
            &inspector,
        );
        registry.activate(&old, approval, &ctx, NOW).unwrap();
        let consumer = inspected(
            &mut registry,
            &package(
                &dir,
                "consumer",
                "1.0.0",
                json!({
                    "dependencies": [{"id":"root", "range":"^1"}],
                    "conflicts": [{"id":"root", "range":">=2"}],
                }),
            ),
            &inspector,
        );
        assert!(matches!(
            registry.validate(&consumer, &ctx, NOW),
            Err(SkillError::Denied("resolver_unavailable"))
        ));
        let root = inspected(
            &mut registry,
            &package(&dir, "root", "2.0.0", json!({})),
            &inspector,
        );
        (root, consumer)
    };
    // Seed pre-existing readiness in this temporary profile only. This represents a
    // previously validated relation-bearing revision; the production validation gate
    // above remains closed. Actual bytes, inspection and later approval stay bound.
    store
        .connection()
        .execute(
            "UPDATE skill_revisions SET state = 'validated' WHERE revision_id = ?1",
            [&consumer],
        )
        .unwrap();
    {
        let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
        registry
            .record_evaluation(
                &consumer,
                EvaluationResult::Passed,
                None,
                Some("evidence:fixture"),
                NOW,
            )
            .unwrap();
        assert!(matches!(
            registry
                .decide(&consumer, &ctx, &ProfileGrants::default(), NOW)
                .unwrap(),
            Route::AwaitingApproval(_)
        ));
        let revision = registry.revision(&consumer).unwrap();
        let approval = registry
            .approve(
                &ApprovalRequest {
                    revision_id: &consumer,
                    shown_tree_sha256: &revision.tree_sha256,
                    shown_permission_digest: &revision.permission_digest,
                    workspace_id: None,
                    approver: "user:owner",
                    expires_at_ms: LATER,
                },
                &ctx,
                NOW,
            )
            .unwrap();
        registry.activate(&consumer, approval, &ctx, NOW).unwrap();
    }
    drop(store);
    let report = observe(&dir, "default", &input(&root, &[]), &ctx).unwrap();
    assert!(report.issues.contains(&PreflightIssue::Conflict {
        package_id: "consumer".into(),
        conflicting_id: "root".into()
    }));
    assert!(report.issues.contains(&PreflightIssue::RangeMismatch {
        package_id: "consumer".into(),
        dependency_id: "root".into()
    }));
    assert!(report.plan.is_none());
}

#[test]
fn preflight_adapter_bounds_inputs_before_materializing_sources() {
    let dir = TempDir::new();
    let inspector = FakeInspector::clean();
    let ctx = PolicyContext::current(&inspector);
    let mut store = open(&dir);
    let root = {
        let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
        inspected(
            &mut registry,
            &package(&dir, "root", "1.0.0", json!({})),
            &inspector,
        )
    };
    drop(store);
    let base = input(&root, &[]);
    let mut invalid_id = base.clone();
    invalid_id.root_revision_id = "invalid".into();
    let mut pins = base.clone();
    pins.pins = (0..129)
        .map(|index| (format!("dependency-{index}"), root.clone()))
        .collect();
    let mut facts = base.clone();
    facts.runtime_facts = (0..129)
        .map(|index| (format!("runtime-{index}"), "1.0.0".into()))
        .collect();
    let mut fact_text = base.clone();
    fact_text
        .runtime_facts
        .insert("runtime".into(), "x".repeat(129));
    let mut scopes = base.clone();
    scopes.permissions_ceiling.filesystem_read =
        (0..257).map(|index| format!("scope-{index}")).collect();
    let mut scope_text = base;
    scope_text
        .permissions_ceiling
        .filesystem_read
        .insert("x".repeat(257));
    for request in [invalid_id, pins, facts, fact_text, scopes, scope_text] {
        assert!(matches!(
            observe(&dir, "default", &request, &ctx),
            Err(SkillError::Denied("preflight_input_bound"))
        ));
    }
}

#[test]
fn preflight_adapter_bounds_active_snapshot_before_loading_any_pointer() {
    let dir = TempDir::new();
    let inspector = FakeInspector::clean();
    let ctx = PolicyContext::current(&inspector);
    let mut store = open(&dir);
    let root = {
        let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
        inspected(
            &mut registry,
            &package(&dir, "root", "1.0.0", json!({})),
            &inspector,
        )
    };
    // Malformed ambient pointers deliberately have no backing package or approval.
    // Cardinality must be checked first, without attempting to observe these sources.
    store
        .connection()
        .execute_batch("PRAGMA foreign_keys = OFF;")
        .unwrap();
    for index in 0..129 {
        store.connection().execute("INSERT INTO skill_activations (profile_id, package_id, revision_id, approval_id, activated_at) VALUES ('default', ?1, ?2, 999, '2027-01-01T00:00:00.000Z')", params![format!("ambient-{index}"), root]).unwrap();
    }
    assert!(matches!(
        observe_store(&mut store, &dir, "default", &input(&root, &[]), &ctx),
        Err(SkillError::Denied("preflight_snapshot_bound"))
    ));
}
