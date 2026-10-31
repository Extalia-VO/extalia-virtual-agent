//! Read-only routing diagnostics with daemon-owned policy context and empty facts/grants.
use super::*;
use crate::wire::SkillRoutingInput;
use extalia_core::skills::registry::RegistryRoutingRequest;
use extalia_core::skills::resolver::PlannedPackage;
use extalia_core::skills::routing::{
    RoutingDiagnosticCode as Code, RoutingExclusionReason, RoutingInputIssue as Issue,
    RoutingStatus,
};
use std::collections::BTreeMap;

fn package_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn identity(p: &PlannedPackage) -> Value {
    json!({"packageId":p.package_id,"version":p.version,"revisionId":p.revision_id,"treeSha256":p.tree_sha256,"permissionDigest":p.permissions_digest})
}
fn code(c: Code) -> &'static str {
    match c {
        Code::BadPin(_) => "bad_pin",
        Code::MissingPin => "missing_pin",
        Code::DependencyUnavailable => "dependency_unavailable",
        Code::DependencyInactive => "dependency_inactive",
        Code::RootUnavailable => "root_unavailable",
        Code::RangeMismatch => "range_mismatch",
        Code::UnsupportedRange(_) => "unsupported_range",
        Code::CompatibilityUnknown => "compatibility_unknown",
        Code::CompatibilityMismatch => "compatibility_mismatch",
        Code::Conflict => "conflict",
        Code::Cycle => "cycle",
        Code::PermissionOutsideCeiling(_) => "permission_outside_ceiling",
        Code::BoundExceeded(_) => "bound_exceeded",
    }
}
fn issue(i: &Issue) -> &'static str {
    match i {
        Issue::EmptySelectors => "empty_selectors",
        Issue::SelectorLimit => "selector_limit",
        Issue::InvalidCategory => "invalid_category",
        Issue::InvalidIntent => "invalid_intent",
        Issue::InvalidResultLimit => "invalid_result_limit",
        Issue::CandidateLimit => "candidate_limit",
        Issue::ContextLimit => "context_limit",
        Issue::GraphNodeLimit => "graph_node_limit",
        Issue::GraphEdgeLimit => "graph_edge_limit",
        Issue::MetadataLimit => "metadata_limit",
        Issue::InvalidClaim => "invalid_claim",
        Issue::InvalidContext => "invalid_context",
        Issue::DuplicateCandidatePackage => "duplicate_candidate_package",
        Issue::RuntimeFactLimit => "runtime_fact_limit",
        Issue::PermissionCeilingLimit => "permission_ceiling_limit",
    }
}
fn diagnostic(d: &extalia_core::skills::routing::RoutingDiagnostic) -> Value {
    let mut item = json!({"code":code(d.code)});
    if let Some(id) = d.package_id.as_deref().filter(|id| package_id(id)) {
        item["packageId"] = json!(id);
    }
    if let Some(id) = d.related_id.as_deref().filter(|id| package_id(id)) {
        item["relatedPackageId"] = json!(id);
    }
    item
}
pub(super) fn run(
    skills: &Skills,
    store: &mut CoreStore,
    input: &SkillRoutingInput,
    ctx: &PolicyContext,
    now: i64,
) -> Result<Value, SkillError> {
    let report = skills.registry(store).routing_preview(
        &RegistryRoutingRequest {
            categories: input.categories.iter().cloned().collect(),
            intents: input.intents.iter().cloned().collect(),
            candidate_revision_ids: input.candidate_revision_ids.clone(),
            pins: input.pins.clone(),
            workspace_id: input.workspace_id.clone(),
            runtime_facts: BTreeMap::new(),
            permissions_ceiling: Permissions::default(),
            max_results: input.max_results,
        },
        ctx,
        now,
    )?;
    let value = json!({"input":input,"dispatchEligible":false,"status":match report.status {RoutingStatus::Invalid=>"invalid",RoutingStatus::NoSafeSkill=>"no_safe_skill",RoutingStatus::Matched=>"matched",RoutingStatus::Ambiguous=>"ambiguous"},
        "eligibleCount":report.eligible_count,"topTieCount":report.top_tie_count,"issues":report.issues.iter().map(issue).collect::<Vec<_>>(),
        "candidates":report.candidates.iter().map(|c|json!({"identity":identity(&c.identity),"score":{"exactIntents":c.score.exact_intents,"exactCategories":c.score.exact_categories,"descendantCategories":c.score.descendant_categories},
            "matches":{"exactIntents":c.matches.exact_intents,"exactCategories":c.matches.exact_categories,"descendantCategories":c.matches.descendant_categories.iter().map(|p|json!({"requested":p.requested,"declared":p.declared})).collect::<Vec<_>>(),"rationaleTruncated":c.matches.rationale_truncated},"plan":c.plan.iter().map(identity).collect::<Vec<_>>()})).collect::<Vec<_>>(),
        "exclusions":report.exclusions.iter().map(|e|json!({"identity":identity(&e.identity),"reason":match e.reason {RoutingExclusionReason::SelectorMismatch=>"selector_mismatch",RoutingExclusionReason::RootInactive=>"root_inactive",RoutingExclusionReason::RootUnavailable=>"root_unavailable",RoutingExclusionReason::InconsistentPreflight=>"inconsistent_preflight"},
            "diagnostics":e.diagnostics.iter().map(diagnostic).collect::<Vec<_>>(),"omittedDiagnostics":e.omitted_diagnostics})).collect::<Vec<_>>()});
    if serde_json::to_vec(&value)
        .map_err(|_| SkillError::Denied("routing_output_bound"))?
        .len()
        > 512 * 1024
    {
        return Err(SkillError::Denied("routing_output_bound"));
    }
    Ok(value)
}
