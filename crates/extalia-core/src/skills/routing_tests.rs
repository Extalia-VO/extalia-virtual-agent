use std::collections::{BTreeMap, BTreeSet};

use super::manifest::{Manifest, Permissions, RiskClass};
use super::resolver::{Availability, PackageClaim};
use super::routing::{
    self, DescendantCategoryMatch, RoutingDiagnosticCode, RoutingExclusionReason,
    RoutingInputIssue, RoutingRequest, RoutingScore, RoutingStatus, preview,
};

fn strings(values: &[&str]) -> BTreeSet<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

fn claim(id: &str, categories: &[&str], intents: &[&str]) -> PackageClaim {
    let manifest = Manifest {
        id: id.into(),
        version: "1.2.3".into(),
        categories: strings(categories),
        intents: strings(intents),
        compatibility: BTreeMap::new(),
        dependencies: BTreeMap::new(),
        conflicts: BTreeMap::new(),
        permissions: Permissions::default(),
        risk_class: RiskClass::Declarative,
    };
    let tree_sha256 = "a".repeat(64);
    PackageClaim {
        permissions_digest: manifest.permissions.digest(),
        manifest,
        revision_id: format!("skr_{tree_sha256}"),
        tree_sha256,
        availability: Availability::Active,
    }
}

fn request(candidates: Vec<PackageClaim>) -> RoutingRequest {
    RoutingRequest {
        categories: strings(&["code"]),
        intents: BTreeSet::new(),
        candidates,
        pins: BTreeMap::new(),
        active_packages: BTreeMap::new(),
        runtime_facts: BTreeMap::new(),
        permissions_ceiling: Permissions::default(),
        max_results: routing::MAX_CANDIDATES,
    }
}

fn invalid(input: &RoutingRequest, issue: RoutingInputIssue) {
    let report = preview(input);
    assert_eq!(report.status, RoutingStatus::Invalid);
    assert!(report.issues.contains(&issue), "{:?}", report.issues);
    assert!(report.candidates.is_empty());
    assert!(report.exclusions.is_empty());
    assert_eq!(report.eligible_count, 0);
    assert_eq!(report.top_tie_count, 0);
    assert!(!report.dispatch_eligible());
}

#[test]
fn routing_is_permutation_deterministic_and_reports_exact_rationale() {
    let alpha = claim("alpha", &["code", "code.rust"], &["fix", "review"]);
    let beta = claim("beta", &["code.rust"], &["fix"]);
    let mut first = request(vec![beta.clone(), alpha.clone()]);
    first.categories = strings(&["code", "code.rust"]);
    first.intents = strings(&["fix", "review"]);
    let mut permuted = first.clone();
    permuted.candidates.reverse();
    let report = preview(&first);
    assert_eq!(report, preview(&permuted));
    assert_eq!(report.status, RoutingStatus::Matched);
    assert_eq!(report.candidates[0].identity.package_id, "alpha");
    assert_eq!(
        report.candidates[0].score,
        RoutingScore {
            exact_intents: 2,
            exact_categories: 2,
            descendant_categories: 1,
        }
    );
    assert_eq!(
        report.candidates[0].matches.exact_intents,
        vec!["fix", "review"]
    );
    assert_eq!(
        report.candidates[0].matches.exact_categories,
        vec!["code", "code.rust"]
    );
    assert_eq!(
        report.candidates[0].matches.descendant_categories,
        vec![DescendantCategoryMatch {
            requested: "code".into(),
            declared: "code.rust".into(),
        }]
    );
    assert_eq!(report.candidates[0].plan[0], report.candidates[0].identity);
    assert!(!report.dispatch_eligible());
}

#[test]
fn routing_keeps_ties_ambiguous_before_result_truncation() {
    let mut input = request(vec![
        claim("beta", &["code"], &[]),
        claim("alpha", &["code"], &[]),
    ]);
    input.max_results = 1;
    let report = preview(&input);
    assert_eq!(report.status, RoutingStatus::Ambiguous);
    assert_eq!(report.eligible_count, 2);
    assert_eq!(report.top_tie_count, 2);
    assert_eq!(report.candidates.len(), 1);
    assert_eq!(report.candidates[0].identity.package_id, "alpha");
    input.candidates.reverse();
    assert_eq!(report, preview(&input));
}

#[test]
fn routing_matches_only_exact_or_requested_parent_dot_descendants() {
    for (requested, declared, matched) in [
        ("code", "code.rust", true),
        ("code", "code", true),
        ("code", "coder", false),
        ("code", "code-tools", false),
        ("code.rust", "code", false),
        ("code", "coding", false),
    ] {
        let mut input = request(vec![claim("root", &[declared], &[])]);
        input.categories = strings(&[requested]);
        let report = preview(&input);
        assert_eq!(
            report.status == RoutingStatus::Matched,
            matched,
            "{requested}/{declared}"
        );
    }
}

#[test]
fn routing_uses_or_within_dimensions_and_and_across_dimensions() {
    let mut input = request(vec![
        claim("both", &["code.rust"], &["fix"]),
        claim("category-only", &["code"], &["write"]),
        claim("intent-only", &["docs"], &["review"]),
    ]);
    input.categories = strings(&["code", "design"]);
    input.intents = strings(&["fix", "review"]);
    let report = preview(&input);
    assert_eq!(report.status, RoutingStatus::Matched);
    assert_eq!(report.candidates[0].identity.package_id, "both");
    assert_eq!(report.exclusions.len(), 2);
    assert!(
        report
            .exclusions
            .iter()
            .all(|item| item.reason == RoutingExclusionReason::SelectorMismatch)
    );
    input.categories.clear();
    assert_eq!(preview(&input).eligible_count, 2);
}

#[test]
fn routing_filters_unsafe_high_scores_before_ranking() {
    for availability in [Availability::Inactive, Availability::Unavailable] {
        let mut unsafe_root = claim("unsafe-root", &["code"], &["fix", "review"]);
        unsafe_root.availability = availability;
        let mut input = request(vec![
            unsafe_root,
            claim("safe-root", &["code.rust"], &["fix"]),
        ]);
        input.intents = strings(&["fix", "review"]);
        let report = preview(&input);
        assert_eq!(report.status, RoutingStatus::Matched);
        assert_eq!(report.candidates[0].identity.package_id, "safe-root");
        assert_eq!(
            report.exclusions[0].reason,
            if availability == Availability::Inactive {
                RoutingExclusionReason::RootInactive
            } else {
                RoutingExclusionReason::RootUnavailable
            }
        );
    }
    let mut forbidden = claim("forbidden", &["code"], &[]);
    forbidden
        .manifest
        .permissions
        .network
        .insert("private.example.com".into());
    forbidden.permissions_digest = forbidden.manifest.permissions.digest();
    let input = request(vec![forbidden, claim("safe", &["code.rust"], &[])]);
    let report = preview(&input);
    assert_eq!(report.status, RoutingStatus::Matched);
    assert_eq!(report.candidates[0].identity.package_id, "safe");
    assert!(report.exclusions[0].diagnostics.iter().any(|item| matches!(
        item.code,
        RoutingDiagnosticCode::PermissionOutsideCeiling(_)
    )));
    assert!(!format!("{report:?}").contains("private.example.com"));
}

#[test]
fn routing_requires_explicit_active_dependency_pins_and_never_uses_ambient_as_pins() {
    let mut root = claim("root", &["code"], &[]);
    root.manifest
        .dependencies
        .insert("dependency".into(), "^1".into());
    let mut input = request(vec![root]);
    input
        .active_packages
        .insert("dependency".into(), claim("dependency", &[], &[]));
    let report = preview(&input);
    assert_eq!(report.status, RoutingStatus::NoSafeSkill);
    assert!(
        report.exclusions[0]
            .diagnostics
            .iter()
            .any(|item| item.code == RoutingDiagnosticCode::MissingPin)
    );
    input.active_packages.clear();
    for availability in [Availability::Inactive, Availability::Unavailable] {
        let mut dependency = claim("dependency", &[], &[]);
        dependency.availability = availability;
        input.pins.insert("dependency".into(), dependency);
        let report = preview(&input);
        assert_eq!(report.status, RoutingStatus::NoSafeSkill);
        assert!(report.exclusions[0].diagnostics.iter().any(|item| item.code
            == if availability == Availability::Inactive {
                RoutingDiagnosticCode::DependencyInactive
            } else {
                RoutingDiagnosticCode::DependencyUnavailable
            }));
    }
    input
        .pins
        .insert("dependency".into(), claim("dependency", &[], &[]));
    let report = preview(&input);
    assert_eq!(report.status, RoutingStatus::Matched);
    assert_eq!(
        report.candidates[0]
            .plan
            .iter()
            .map(|item| item.package_id.as_str())
            .collect::<Vec<_>>(),
        vec!["dependency", "root"]
    );
}

#[test]
fn routing_removes_dependency_invalid_high_score_and_checks_full_ambient_context() {
    let mut broken = claim("broken", &["code"], &[]);
    broken
        .manifest
        .dependencies
        .insert("missing".into(), "^1".into());
    let mut input = request(vec![broken, claim("safe", &["code.rust"], &[])]);
    assert_eq!(preview(&input).candidates[0].identity.package_id, "safe");
    let mut ambient = claim("ambient", &[], &[]);
    ambient.manifest.conflicts.insert("safe".into(), None);
    input.active_packages.insert("ambient".into(), ambient);
    let report = preview(&input);
    assert_eq!(report.status, RoutingStatus::NoSafeSkill);
    assert!(report.exclusions.iter().any(|item| {
        item.diagnostics
            .iter()
            .any(|d| d.code == RoutingDiagnosticCode::Conflict)
    }));
}

#[test]
fn routing_does_not_replace_conflicting_root_or_active_pins() {
    let root = claim("root", &["code"], &[]);
    let mut replacement = root.clone();
    replacement.manifest.version = "1.2.4".into();
    let mut input = request(vec![root]);
    input.pins.insert("root".into(), replacement);
    let report = preview(&input);
    assert_eq!(report.status, RoutingStatus::NoSafeSkill);
    assert!(
        report.exclusions[0]
            .diagnostics
            .iter()
            .any(|item| matches!(item.code, RoutingDiagnosticCode::BadPin(_)))
    );
}

#[test]
fn routing_rejects_empty_malformed_and_oversized_selectors() {
    let mut input = request(vec![]);
    input.categories.clear();
    invalid(&input, RoutingInputIssue::EmptySelectors);
    for category in ["bad..category", "Code", "code/other"] {
        input.categories = strings(&[category]);
        invalid(&input, RoutingInputIssue::InvalidCategory);
    }
    input.categories = strings(&["code"]);
    input.intents = strings(&["fix it"]);
    invalid(&input, RoutingInputIssue::InvalidIntent);
    input.intents = (0..33).map(|n| format!("intent_{n}")).collect();
    invalid(&input, RoutingInputIssue::SelectorLimit);
    input.intents.clear();
    input.categories = (0..33).map(|n| format!("category{n}")).collect();
    invalid(&input, RoutingInputIssue::SelectorLimit);
}

#[test]
fn routing_rejects_duplicate_package_candidates_even_for_distinct_revisions() {
    let first = claim("root", &["code"], &[]);
    let mut second = first.clone();
    invalid(
        &request(vec![first.clone(), second.clone()]),
        RoutingInputIssue::DuplicateCandidatePackage,
    );
    second.tree_sha256 = "b".repeat(64);
    second.revision_id = format!("skr_{}", second.tree_sha256);
    invalid(
        &request(vec![first, second]),
        RoutingInputIssue::DuplicateCandidatePackage,
    );
}

#[test]
fn routing_validates_all_metadata_and_context_even_when_not_matching() {
    let mut input = request(vec![claim("root", &["unrelated"], &[])]);
    input.candidates[0].manifest.version = "malformed-private-text".into();
    invalid(&input, RoutingInputIssue::InvalidClaim);
    assert!(!format!("{:?}", preview(&input)).contains("malformed-private-text"));
    input.candidates[0] = claim("root", &["code"], &[]);
    input
        .pins
        .insert("different-id".into(), claim("unused", &[], &[]));
    invalid(&input, RoutingInputIssue::InvalidContext);
    input.pins.clear();
    let mut inactive = claim("unused", &[], &[]);
    inactive.availability = Availability::Inactive;
    input.active_packages.insert("unused".into(), inactive);
    invalid(&input, RoutingInputIssue::InvalidContext);
    input.active_packages.clear();
    input
        .pins
        .insert("unused".into(), claim("unused", &[], &[]));
    input.pins.get_mut("unused").unwrap().tree_sha256 = "z".repeat(64);
    invalid(&input, RoutingInputIssue::InvalidClaim);
}

#[test]
fn routing_bounds_candidates_results_claims_facts_and_ceiling_before_copying() {
    let mut input = request(
        (0..17)
            .map(|n| claim(&format!("root-{n}"), &["code"], &[]))
            .collect(),
    );
    invalid(&input, RoutingInputIssue::CandidateLimit);
    input.candidates.truncate(1);
    for max_results in [0, 17, usize::MAX] {
        input.max_results = max_results;
        invalid(&input, RoutingInputIssue::InvalidResultLimit);
    }
    input.max_results = 1;
    input.candidates[0]
        .manifest
        .categories
        .insert("x".repeat(257));
    invalid(&input, RoutingInputIssue::MetadataLimit);
    input.candidates[0] = claim("root", &["code"], &[]);
    input.candidates[0].permissions_digest = "x".repeat(65);
    invalid(&input, RoutingInputIssue::MetadataLimit);
    input.candidates[0] = claim("root", &["code"], &[]);
    input
        .runtime_facts
        .insert("runtime".into(), "x".repeat(129));
    invalid(&input, RoutingInputIssue::RuntimeFactLimit);
    input.runtime_facts = (0..129)
        .map(|n| (format!("runtime{n}"), "1.0.0".into()))
        .collect();
    invalid(&input, RoutingInputIssue::RuntimeFactLimit);
    input.runtime_facts.clear();
    input.permissions_ceiling.network.insert("x".repeat(257));
    invalid(&input, RoutingInputIssue::PermissionCeilingLimit);
    input.permissions_ceiling.network = (0..257).map(|n| format!("host{n}.example.com")).collect();
    invalid(&input, RoutingInputIssue::PermissionCeilingLimit);
}

#[test]
fn routing_caps_unique_graph_ids_including_unsupplied_dependencies() {
    let mut input = request(vec![claim("root", &["code"], &[])]);
    for n in 0..127 {
        input
            .pins
            .insert(format!("pin-{n}"), claim(&format!("pin-{n}"), &[], &[]));
    }
    assert_ne!(preview(&input).status, RoutingStatus::Invalid);
    input.candidates[0]
        .manifest
        .dependencies
        .insert("missing".into(), "^1".into());
    invalid(&input, RoutingInputIssue::GraphNodeLimit);
    input.pins.insert("extra".into(), claim("extra", &[], &[]));
    invalid(&input, RoutingInputIssue::GraphNodeLimit);
    input
        .pins
        .insert("extra-two".into(), claim("extra-two", &[], &[]));
    invalid(&input, RoutingInputIssue::ContextLimit);
}

#[test]
fn routing_caps_global_edges_and_resolver_depth() {
    let mut input = request(vec![claim("root", &["code"], &[])]);
    for n in 0..9 {
        let mut pin = claim(&format!("pin-{n}"), &[], &[]);
        for target in 0..64 {
            pin.manifest
                .dependencies
                .insert(format!("target-{target}"), "^1".into());
        }
        input.pins.insert(pin.manifest.id.clone(), pin);
    }
    invalid(&input, RoutingInputIssue::GraphEdgeLimit);
    input.pins.clear();
    input.candidates[0]
        .manifest
        .dependencies
        .insert("chain-0".into(), "^1".into());
    for n in 0..33 {
        let mut pin = claim(&format!("chain-{n}"), &[], &[]);
        if n < 32 {
            pin.manifest
                .dependencies
                .insert(format!("chain-{}", n + 1), "^1".into());
        }
        input.pins.insert(pin.manifest.id.clone(), pin);
    }
    let report = preview(&input);
    assert_eq!(report.status, RoutingStatus::NoSafeSkill);
    assert!(
        report.exclusions[0]
            .diagnostics
            .iter()
            .any(|d| matches!(d.code, RoutingDiagnosticCode::BoundExceeded(_)))
    );
}

#[test]
fn routing_bounds_aggregate_diagnostics_and_preserves_omission_counts() {
    let mut input = request(vec![]);
    for n in 0..16 {
        let mut root = claim(&format!("root-{n}"), &["code"], &[]);
        for target in 0..32 {
            root.manifest
                .dependencies
                .insert(format!("missing-{target}"), "^1".into());
        }
        input.candidates.push(root);
    }
    let report = preview(&input);
    assert_eq!(report.status, RoutingStatus::NoSafeSkill);
    assert_eq!(report.exclusions.len(), 16);
    assert_eq!(
        report
            .exclusions
            .iter()
            .map(|item| item.diagnostics.len())
            .sum::<usize>(),
        routing::MAX_REPORT_DIAGNOSTICS
    );
    assert_eq!(
        report
            .exclusions
            .iter()
            .map(|item| item.omitted_diagnostics)
            .sum::<usize>(),
        16 * 32 - routing::MAX_REPORT_DIAGNOSTICS
    );
    input.candidates.reverse();
    assert_eq!(report, preview(&input));
}

#[test]
fn routing_treats_fact_values_as_claims_and_never_echoes_them() {
    let mut root = claim("root", &["code"], &[]);
    root.manifest
        .compatibility
        .insert("runtime".into(), "^1".into());
    let mut input = request(vec![root]);
    input
        .runtime_facts
        .insert("runtime".into(), "private-runtime-claim".into());
    let report = preview(&input);
    assert_eq!(report.status, RoutingStatus::NoSafeSkill);
    assert!(
        report.exclusions[0]
            .diagnostics
            .iter()
            .any(|d| d.code == RoutingDiagnosticCode::CompatibilityUnknown)
    );
    assert!(!format!("{report:?}").contains("private-runtime-claim"));
}

#[test]
fn routing_counts_descendant_selectors_instead_of_metadata_leaf_volume() {
    let input = request(vec![
        claim("alpha", &["code.a"], &[]),
        claim("beta", &["code.a", "code.b", "code.c"], &[]),
    ]);
    let report = preview(&input);
    assert_eq!(report.status, RoutingStatus::Ambiguous);
    assert_eq!(report.top_tie_count, 2);
    assert!(
        report
            .candidates
            .iter()
            .all(|item| item.score.descendant_categories == 1)
    );
}

#[test]
fn routing_bounds_display_rationale_without_hiding_selector_score() {
    let mut root = claim("root", &[], &[]);
    root.manifest.categories = (0..32).map(|n| format!("code.a.leaf{n}")).collect();
    let mut input = request(vec![root]);
    input.categories = strings(&["code", "code.a"]);
    let report = preview(&input);
    assert_eq!(report.status, RoutingStatus::Matched);
    assert_eq!(report.candidates[0].score.descendant_categories, 2);
    assert_eq!(report.candidates[0].matches.descendant_categories.len(), 32);
    assert!(report.candidates[0].matches.rationale_truncated);
}

#[test]
fn routing_never_previews_a_replacement_of_a_different_ambient_active_revision() {
    let root = claim("root", &["code"], &[]);
    let mut active = root.clone();
    active.manifest.version = "1.2.4".into();
    active.tree_sha256 = "b".repeat(64);
    active.revision_id = format!("skr_{}", active.tree_sha256);
    let mut input = request(vec![root, claim("safe", &["code.rust"], &[])]);
    input.active_packages.insert("root".into(), active);
    let report = preview(&input);
    assert_eq!(report.status, RoutingStatus::Matched);
    assert_eq!(report.candidates[0].identity.package_id, "safe");
    assert_eq!(
        report.exclusions[0].reason,
        RoutingExclusionReason::InconsistentPreflight
    );
    assert!(
        report.exclusions[0]
            .diagnostics
            .iter()
            .any(|d| matches!(d.code, RoutingDiagnosticCode::BadPin(_)))
    );
    input
        .active_packages
        .insert("root".into(), input.candidates[0].clone());
    assert_eq!(preview(&input).candidates[0].identity.package_id, "root");
}

#[test]
fn routing_invalid_graph_diagnostics_are_permutation_deterministic() {
    let mut input = request(vec![]);
    for n in 0..9 {
        let mut root = claim(&format!("root-{n}"), &["code"], &[]);
        for target in 0..64 {
            let prefix = if n == 8 { "different" } else { "shared" };
            root.manifest
                .dependencies
                .insert(format!("{prefix}-{target}"), "^1".into());
        }
        input.candidates.push(root);
    }
    let report = preview(&input);
    assert_eq!(report.status, RoutingStatus::Invalid);
    assert!(report.issues.contains(&RoutingInputIssue::GraphNodeLimit));
    assert!(report.issues.contains(&RoutingInputIssue::GraphEdgeLimit));
    input.candidates.reverse();
    assert_eq!(report, preview(&input));
}
