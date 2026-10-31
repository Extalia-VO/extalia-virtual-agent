use std::collections::BTreeMap;

use super::manifest::{self, Permissions};
use super::resolver::{
    Availability, Bound, PackageClaim, PinProblem, PreflightIssue, PreflightRequest, RangeUse,
    ResolverLimits, preflight,
};
use serde_json::json;

fn claim(id: &str, dependencies: &[(&str, &str)]) -> PackageClaim {
    let manifest = manifest::parse_manifest(
        &serde_json::to_vec(&json!({
            "schema": "extalia.skill-manifest.v1",
            "id": id,
            "version": "1.2.3",
            "risk_class": "declarative",
            "dependencies": dependencies.iter().map(|(id, range)| json!({"id": id, "range": range})).collect::<Vec<_>>()
        }))
        .unwrap(),
    )
    .unwrap();
    let tree_sha256 = "a".repeat(64);
    PackageClaim {
        permissions_digest: manifest.permissions.digest(),
        manifest,
        revision_id: format!("skr_{tree_sha256}"),
        tree_sha256,
        availability: Availability::Active,
    }
}

fn request(root: PackageClaim, pins: Vec<PackageClaim>) -> PreflightRequest {
    PreflightRequest {
        root,
        pins: pins
            .into_iter()
            .map(|pin| (pin.manifest.id.clone(), pin))
            .collect(),
        active_packages: BTreeMap::new(),
        runtime_facts: BTreeMap::new(),
        permissions_ceiling: Permissions::default(),
        limits: ResolverLimits::default(),
    }
}

#[test]
fn resolver_orders_explicit_pins_before_dependents_and_never_admits_dispatch() {
    let mut root = claim("root", &[("beta", "^1.0"), ("alpha", ">=1 <2")]);
    root.availability = Availability::Inactive;
    let alpha = claim("alpha", &[("shared", "1.x")]);
    let beta = claim("beta", &[("shared", "~1.2")]);
    let shared = claim("shared", &[]);
    let first = preflight(&request(
        root.clone(),
        vec![beta.clone(), shared.clone(), alpha.clone()],
    ));
    let permuted = preflight(&request(root, vec![alpha, shared, beta]));
    assert_eq!(first, permuted);
    assert!(first.issues.is_empty(), "{:?}", first.issues);
    assert_eq!(
        first
            .plan
            .as_ref()
            .unwrap()
            .iter()
            .map(|pin| pin.package_id.as_str())
            .collect::<Vec<_>>(),
        vec!["shared", "alpha", "beta", "root"]
    );
    assert!(!first.dispatch_eligible());
    assert!(
        first
            .plan
            .unwrap()
            .iter()
            .all(|pin| pin.revision_id == format!("skr_{}", pin.tree_sha256))
    );
}

#[test]
fn resolver_missing_pin_does_not_select_a_current_active_version() {
    let mut input = request(claim("root", &[("dependency", "^1")]), vec![]);
    input
        .active_packages
        .insert("dependency".into(), claim("dependency", &[]));
    let report = preflight(&input);
    assert_eq!(
        report.issues,
        vec![PreflightIssue::MissingPin {
            package_id: "root".into(),
            dependency_id: "dependency".into()
        }]
    );
    assert!(report.plan.is_none());
    assert!(!report.dispatch_eligible());
}

#[test]
fn resolver_distinguishes_unavailable_inactive_and_exact_version_mismatch() {
    for (availability, expected) in [
        (
            Availability::Inactive,
            PreflightIssue::DependencyInactive {
                package_id: "root".into(),
                dependency_id: "dependency".into(),
            },
        ),
        (
            Availability::Unavailable,
            PreflightIssue::DependencyUnavailable {
                package_id: "root".into(),
                dependency_id: "dependency".into(),
            },
        ),
    ] {
        let mut dependency = claim("dependency", &[]);
        dependency.availability = availability;
        let report = preflight(&request(
            claim("root", &[("dependency", "^2")]),
            vec![dependency],
        ));
        assert!(report.issues.contains(&expected));
        assert!(report.issues.contains(&PreflightIssue::RangeMismatch {
            package_id: "root".into(),
            dependency_id: "dependency".into()
        }));
        assert!(report.plan.is_none());
    }
}

#[test]
fn resolver_checks_manifest_and_identity_claims_without_echoing_invalid_metadata() {
    for problem in [
        PinProblem::InvalidManifest,
        PinProblem::InvalidRevisionIdentity,
        PinProblem::PermissionDigestMismatch,
    ] {
        let mut dependency = claim("dependency", &[]);
        match problem {
            PinProblem::InvalidManifest => dependency.manifest.version = "invalid".into(),
            PinProblem::InvalidRevisionIdentity => {
                dependency.revision_id = format!("skr_{}", "b".repeat(64))
            }
            PinProblem::PermissionDigestMismatch => dependency.permissions_digest = "b".repeat(64),
            _ => unreachable!(),
        }
        let report = preflight(&request(
            claim("root", &[("dependency", "*")]),
            vec![dependency],
        ));
        assert!(report.issues.contains(&PreflightIssue::BadPin {
            package_id: Some("dependency".into()),
            problem
        }));
        assert!(report.plan.is_none());
    }
    let mut input = request(claim("root", &[]), vec![]);
    input
        .pins
        .insert("/invalid/private/value".into(), claim("dependency", &[]));
    let report = preflight(&input);
    assert!(report.issues.iter().any(|issue| matches!(
        issue,
        PreflightIssue::BadPin {
            package_id: None,
            ..
        }
    )));
    assert!(!format!("{report:?}").contains("private/value"));
}

#[test]
fn resolver_reports_deterministic_cycles_without_a_plan() {
    let root = claim("root", &[("alpha", "*"), ("beta", "*")]);
    let alpha = claim("alpha", &[("beta", "*")]);
    let beta = claim("beta", &[("alpha", "*")]);
    let first = preflight(&request(root.clone(), vec![alpha.clone(), beta.clone()]));
    let other = preflight(&request(root, vec![beta, alpha]));
    assert_eq!(first, other);
    assert!(first.issues.contains(&PreflightIssue::Cycle {
        packages: vec!["alpha".into(), "beta".into(), "alpha".into()]
    }));
    assert!(first.plan.is_none());
}

#[test]
fn resolver_checks_conflicts_in_both_directions_with_unreachable_active_packages() {
    let root = claim("root", &[("dependency", "*")]);
    let mut dependency = claim("dependency", &[]);
    dependency
        .manifest
        .conflicts
        .insert("outside".into(), Some("^1".into()));
    let mut outside = claim("outside", &[]);
    outside.manifest.conflicts.insert("root".into(), None);
    let mut input = request(root, vec![dependency]);
    input.active_packages.insert("outside".into(), outside);
    let report = preflight(&input);
    assert_eq!(
        report.issues,
        vec![
            PreflightIssue::Conflict {
                package_id: "dependency".into(),
                conflicting_id: "outside".into()
            },
            PreflightIssue::Conflict {
                package_id: "outside".into(),
                conflicting_id: "root".into()
            },
        ]
    );
    assert!(report.plan.is_none());
}

#[test]
fn resolver_nonmatching_conflicts_do_not_block_the_plan() {
    let mut root = claim("root", &[]);
    root.manifest
        .conflicts
        .insert("outside".into(), Some(">=2".into()));
    let mut input = request(root, vec![]);
    input
        .active_packages
        .insert("outside".into(), claim("outside", &[]));
    let report = preflight(&input);
    assert!(report.issues.is_empty());
    assert_eq!(report.plan.unwrap().len(), 1);
}

#[test]
fn resolver_unavailable_root_is_blocked_while_dependencies_are_still_analyzed() {
    let mut root = claim("root", &[("missing", "*")]);
    root.availability = Availability::Unavailable;
    let report = preflight(&request(root, vec![]));
    assert!(report.issues.contains(&PreflightIssue::RootUnavailable {
        package_id: "root".into()
    }));
    assert!(report.issues.contains(&PreflightIssue::MissingPin {
        package_id: "root".into(),
        dependency_id: "missing".into()
    }));
    assert!(report.plan.is_none());
}

#[test]
fn resolver_replacement_checks_ambient_reverse_constraints_and_replaces_old_conflicts() {
    let mut proposed = claim("root", &[]);
    proposed.manifest.version = "2.0.0".into();
    proposed.availability = Availability::Inactive;
    let mut old = claim("root", &[]);
    old.manifest.conflicts.insert("consumer".into(), None);
    let consumer = claim("consumer", &[("root", "^1")]);
    let mut input = request(proposed, vec![]);
    input.active_packages.insert("root".into(), old);
    input.active_packages.insert("consumer".into(), consumer);
    let report = preflight(&input);
    assert_eq!(
        report.issues,
        vec![PreflightIssue::RangeMismatch {
            package_id: "consumer".into(),
            dependency_id: "root".into()
        }]
    );
    assert!(report.plan.is_none());
}

#[test]
fn resolver_missing_or_invalid_compatibility_facts_are_unknown() {
    let mut root = claim("root", &[]);
    root.manifest
        .compatibility
        .insert("runtime".into(), ">=2".into());
    let mut input = request(root, vec![]);
    for fact in [None, Some("malformed"), Some("1.2.3"), Some("2.0.0")] {
        input.runtime_facts = fact
            .map(|version| BTreeMap::from([("runtime".into(), version.into())]))
            .unwrap_or_default();
        let report = preflight(&input);
        match fact {
            None | Some("malformed") => assert_eq!(
                report.issues,
                vec![PreflightIssue::CompatibilityUnknown {
                    package_id: "root".into(),
                    fact_id: "runtime".into()
                }]
            ),
            Some("1.2.3") => assert_eq!(
                report.issues,
                vec![PreflightIssue::CompatibilityMismatch {
                    package_id: "root".into(),
                    fact_id: "runtime".into()
                }]
            ),
            _ => assert!(report.issues.is_empty()),
        }
        assert!(!report.dispatch_eligible());
    }
}

#[test]
fn resolver_permission_ceiling_uses_exact_scopes_and_never_grants() {
    let mut dependency = claim("dependency", &[]);
    dependency
        .manifest
        .permissions
        .filesystem_read
        .insert("src/**".into());
    dependency.manifest.permissions.terminal = true;
    dependency.permissions_digest = dependency.manifest.permissions.digest();
    let mut input = request(
        claim("root", &[("dependency", "*")]),
        vec![dependency.clone()],
    );
    input
        .permissions_ceiling
        .filesystem_read
        .insert("**".into());
    let denied = preflight(&input);
    assert_eq!(denied.issues.len(), 2);
    assert!(
        denied
            .issues
            .iter()
            .all(|issue| matches!(issue, PreflightIssue::PermissionOutsideCeiling { .. }))
    );
    assert!(denied.plan.is_none());
    input.permissions_ceiling = dependency.manifest.permissions;
    let consistent = preflight(&input);
    assert!(consistent.issues.is_empty());
    assert!(consistent.plan.is_some());
    assert!(!consistent.dispatch_eligible());
}

#[test]
fn resolver_respects_node_edge_and_depth_caps() {
    let root = claim("root", &[("alpha", "*")]);
    let alpha = claim("alpha", &[("beta", "*")]);
    let beta = claim("beta", &[]);
    for (limits, bound, limit) in [
        (
            ResolverLimits {
                max_nodes: 2,
                ..ResolverLimits::default()
            },
            Bound::Nodes,
            2,
        ),
        (
            ResolverLimits {
                max_edges: 1,
                ..ResolverLimits::default()
            },
            Bound::Edges,
            1,
        ),
        (
            ResolverLimits {
                max_depth: 1,
                ..ResolverLimits::default()
            },
            Bound::Depth,
            1,
        ),
    ] {
        let mut input = request(root.clone(), vec![alpha.clone(), beta.clone()]);
        input.limits = limits;
        let report = preflight(&input);
        assert!(
            report
                .issues
                .contains(&PreflightIssue::BoundExceeded { bound, limit })
        );
        assert!(report.plan.is_none());
    }
}

#[test]
fn resolver_depth_checks_longer_paths_to_already_visited_shared_dependencies() {
    let root = claim("root", &[("alpha", "*"), ("zeta", "*")]);
    let alpha = claim("alpha", &[("leaf", "*")]);
    let zeta = claim("zeta", &[("alpha", "*")]);
    let leaf = claim("leaf", &[]);
    let mut input = request(root, vec![alpha, zeta, leaf]);
    input.limits.max_depth = 2;
    let report = preflight(&input);
    assert!(report.issues.contains(&PreflightIssue::BoundExceeded {
        bound: Bound::Depth,
        limit: 2
    }));
    assert!(report.plan.is_none());
}

#[test]
fn resolver_context_claims_are_bounded_before_analysis() {
    let base = request(claim("root", &[]), vec![]);
    let mut facts = base.clone();
    facts.runtime_facts = (0..129)
        .map(|index| (format!("fact-{index}"), "1.0.0".into()))
        .collect();
    let mut text = base.clone();
    text.runtime_facts.insert("runtime".into(), "x".repeat(129));
    let mut scopes = base.clone();
    scopes.permissions_ceiling.filesystem_read =
        (0..257).map(|index| format!("scope-{index}")).collect();
    let mut scope_text = base;
    scope_text
        .permissions_ceiling
        .filesystem_read
        .insert("x".repeat(257));
    for (input, bound, limit) in [
        (facts, Bound::RuntimeFacts, 128),
        (text, Bound::RuntimeFactText, 128),
        (scopes, Bound::PermissionScopes, 256),
        (scope_text, Bound::PermissionScopeText, 256),
    ] {
        let report = preflight(&input);
        assert_eq!(
            report.issues,
            vec![PreflightIssue::BoundExceeded { bound, limit }]
        );
        assert!(report.plan.is_none());
    }
}

#[test]
fn resolver_caller_cannot_raise_hard_caps() {
    let mut nodes = request(
        claim("root", &[]),
        (0..128)
            .map(|index| claim(&format!("node-{index}"), &[]))
            .collect(),
    );
    nodes.limits = ResolverLimits {
        max_nodes: usize::MAX,
        max_edges: usize::MAX,
        max_depth: usize::MAX,
    };
    assert!(
        preflight(&nodes)
            .issues
            .contains(&PreflightIssue::BoundExceeded {
                bound: Bound::Nodes,
                limit: 128
            })
    );

    let mut chain = Vec::new();
    for index in 0..34 {
        let next = format!("node-{}", index + 1);
        chain.push(if index == 33 {
            claim(&format!("node-{index}"), &[])
        } else {
            claim(&format!("node-{index}"), &[(next.as_str(), "*")])
        });
    }
    let mut deep = request(chain.remove(0), chain);
    deep.limits = nodes.limits;
    assert!(
        preflight(&deep)
            .issues
            .contains(&PreflightIssue::BoundExceeded {
                bound: Bound::Depth,
                limit: 32
            })
    );

    let leaves = (0..64)
        .map(|index| format!("leaf-{index}"))
        .collect::<Vec<_>>();
    let mut pins = leaves.iter().map(|id| claim(id, &[])).collect::<Vec<_>>();
    for index in 0..9 {
        pins.push(claim(
            &format!("node-{index}"),
            &leaves
                .iter()
                .map(|id| (id.as_str(), "*"))
                .collect::<Vec<_>>(),
        ));
    }
    let mut edges = request(claim("root", &[]), pins);
    edges.limits = nodes.limits;
    assert!(
        preflight(&edges)
            .issues
            .contains(&PreflightIssue::BoundExceeded {
                bound: Bound::Edges,
                limit: 512
            })
    );
}

#[test]
fn resolver_rejects_contradictory_active_revision_claims() {
    let selected = claim("dependency", &[]);
    let mut ambient = selected.clone();
    ambient.tree_sha256 = "b".repeat(64);
    ambient.revision_id = format!("skr_{}", ambient.tree_sha256);
    let mut input = request(claim("root", &[("dependency", "*")]), vec![selected]);
    input.active_packages.insert("dependency".into(), ambient);
    let report = preflight(&input);
    assert!(report.issues.contains(&PreflightIssue::BadPin {
        package_id: Some("dependency".into()),
        problem: PinProblem::ConflictingActivePin
    }));
    assert!(report.plan.is_none());
}

#[test]
fn resolver_range_failure_is_typed_if_manifest_syntax_exceeds_matcher_support() {
    // The manifest syntax checker accepts an operator with a wildcard. The matcher
    // deliberately rejects that form, so it must produce a blocker, never success.
    let input = request(
        claim("root", &[("dependency", ">=1.x")]),
        vec![claim("dependency", &[])],
    );
    let report = preflight(&input);
    assert!(report.issues.contains(&PreflightIssue::UnsupportedRange {
        package_id: "root".into(),
        target_id: "dependency".into(),
        usage: RangeUse::Dependency
    }));
    assert!(report.plan.is_none());
}
