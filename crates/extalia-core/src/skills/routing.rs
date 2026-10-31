//! Bounded, deterministic routing diagnostics over explicit package claims.
//!
//! Selectors are structured metadata only: OR within either dimension and AND
//! between populated dimensions. Categories match exactly or from a requested
//! parent to a declared descendant at a dot boundary. No aliases, semantic text,
//! replacement revisions, implicit dependency pins or built-in exemptions exist.
//! An ambient active claim for the root package must equal that exact root claim;
//! dependency preflight alone also supports activation diagnostics and is broader.
//!
//! Every input is an unverified claim. A store adapter must verify source bytes,
//! scope and lifecycle observations. Even a matched report never admits dispatch,
//! changes activation, supplies approvals or grants permissions.

use std::collections::{BTreeMap, BTreeSet};

use super::manifest::{self, Capability, Manifest, Permissions};
use super::resolver::{
    self, Availability, Bound, PackageClaim, PinProblem, PlannedPackage, PreflightIssue,
    PreflightRequest, RangeUse, ResolverLimits,
};

pub const MAX_CANDIDATES: usize = 16;
pub const MAX_SELECTORS: usize = 32;
/// Per exclusion. The number omitted remains visible without forwarding more data.
pub const MAX_DIAGNOSTICS: usize = 32;
/// Shared across every exclusion in a report, assigned in package identity order.
pub const MAX_REPORT_DIAGNOSTICS: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutingRequest {
    pub categories: BTreeSet<String>,
    pub intents: BTreeSet<String>,
    /// One revision per distinct package id. Multiple versions are not a replacement policy.
    pub candidates: Vec<PackageClaim>,
    pub pins: BTreeMap<String, PackageClaim>,
    /// Full ambient active context, including packages outside every candidate closure.
    pub active_packages: BTreeMap<String, PackageClaim>,
    pub runtime_facts: BTreeMap<String, String>,
    pub permissions_ceiling: Permissions,
    pub max_results: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoutingStatus {
    Invalid,
    NoSafeSkill,
    Matched,
    Ambiguous,
}

/// Fixed codes only: invalid input is never echoed into a diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RoutingInputIssue {
    EmptySelectors,
    SelectorLimit,
    InvalidCategory,
    InvalidIntent,
    InvalidResultLimit,
    CandidateLimit,
    ContextLimit,
    GraphNodeLimit,
    GraphEdgeLimit,
    MetadataLimit,
    InvalidClaim,
    InvalidContext,
    DuplicateCandidatePackage,
    RuntimeFactLimit,
    PermissionCeilingLimit,
}

/// Lexicographic integer ranking, with earlier fields taking precedence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct RoutingScore {
    pub exact_intents: u16,
    pub exact_categories: u16,
    /// Distinct requested categories with at least one declared descendant (at most 32).
    pub descendant_categories: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DescendantCategoryMatch {
    pub requested: String,
    pub declared: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutingMatches {
    /// Exact intersections, each bounded by MAX_SELECTORS.
    pub exact_intents: Vec<String>,
    pub exact_categories: Vec<String>,
    /// Actual dot-boundary pairs, capped at MAX_SELECTORS for display.
    pub descendant_categories: Vec<DescendantCategoryMatch>,
    /// Ranking still counts every matched selector before display truncation.
    pub rationale_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutingCandidate {
    pub identity: PlannedPackage,
    pub score: RoutingScore,
    pub matches: RoutingMatches,
    /// Exact dependency-before-dependent diagnostic ordering, never an execution plan.
    pub plan: Vec<PlannedPackage>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RoutingDiagnosticCode {
    BadPin(PinProblem),
    MissingPin,
    DependencyUnavailable,
    DependencyInactive,
    RootUnavailable,
    RangeMismatch,
    UnsupportedRange(RangeUse),
    CompatibilityUnknown,
    CompatibilityMismatch,
    Conflict,
    Cycle,
    PermissionOutsideCeiling(Capability),
    BoundExceeded(Bound),
}

/// Sanitized resolver evidence: validated identifiers, fixed codes and counts only.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct RoutingDiagnostic {
    pub code: RoutingDiagnosticCode,
    pub package_id: Option<String>,
    pub related_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoutingExclusionReason {
    SelectorMismatch,
    RootInactive,
    RootUnavailable,
    InconsistentPreflight,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutingExclusion {
    pub identity: PlannedPackage,
    pub reason: RoutingExclusionReason,
    pub diagnostics: Vec<RoutingDiagnostic>,
    pub omitted_diagnostics: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutingReport {
    pub status: RoutingStatus,
    /// Ranked eligible results; ties use package/revision identity for presentation only.
    pub candidates: Vec<RoutingCandidate>,
    /// One exclusion per rejected candidate, at most MAX_CANDIDATES.
    pub exclusions: Vec<RoutingExclusion>,
    pub issues: Vec<RoutingInputIssue>,
    pub eligible_count: usize,
    /// Count before max_results truncation, so max_results=1 cannot hide ambiguity.
    pub top_tie_count: usize,
}

impl RoutingReport {
    pub const fn dispatch_eligible(&self) -> bool {
        false
    }
}

pub fn preview(request: &RoutingRequest) -> RoutingReport {
    let issues = validate_input(request);
    let mut report = RoutingReport {
        status: RoutingStatus::Invalid,
        candidates: Vec::new(),
        exclusions: Vec::new(),
        issues,
        eligible_count: 0,
        top_tie_count: 0,
    };
    if !report.issues.is_empty() {
        return report;
    }
    // All supplied metadata and context have been bounded and validated before
    // constructing any owned preflight request, including unused ambient claims.
    let mut roots: Vec<&PackageClaim> = request.candidates.iter().collect();
    roots.sort_by(|a, b| (&a.manifest.id, &a.revision_id).cmp(&(&b.manifest.id, &b.revision_id)));
    let mut diagnostics_remaining = MAX_REPORT_DIAGNOSTICS;
    for root in roots {
        let (matches, score) = selector_matches(request, &root.manifest);
        let category_matches =
            !matches.exact_categories.is_empty() || !matches.descendant_categories.is_empty();
        let reason = if (!request.categories.is_empty() && !category_matches)
            || (!request.intents.is_empty() && matches.exact_intents.is_empty())
        {
            Some(RoutingExclusionReason::SelectorMismatch)
        } else {
            match root.availability {
                Availability::Active => None,
                Availability::Inactive => Some(RoutingExclusionReason::RootInactive),
                Availability::Unavailable => Some(RoutingExclusionReason::RootUnavailable),
            }
        };
        if let Some(reason) = reason {
            report.exclusions.push(RoutingExclusion {
                identity: identity(root),
                reason,
                diagnostics: Vec::new(),
                omitted_diagnostics: 0,
            });
            continue;
        }
        // Dependency preflight also supports activation diagnostics and permits a
        // root replacement. Routing has no such policy: an explicit ambient claim
        // for the same package must be exactly this revision and metadata.
        if request
            .active_packages
            .get(&root.manifest.id)
            .is_some_and(|active| active != root)
        {
            let diagnostics = if diagnostics_remaining > 0 {
                diagnostics_remaining -= 1;
                vec![RoutingDiagnostic {
                    code: RoutingDiagnosticCode::BadPin(PinProblem::ConflictingActivePin),
                    package_id: Some(root.manifest.id.clone()),
                    related_id: None,
                }]
            } else {
                Vec::new()
            };
            report.exclusions.push(RoutingExclusion {
                identity: identity(root),
                reason: RoutingExclusionReason::InconsistentPreflight,
                omitted_diagnostics: usize::from(diagnostics.is_empty()),
                diagnostics,
            });
            continue;
        }
        let preflight = resolver::preflight(&PreflightRequest {
            root: root.clone(),
            pins: request.pins.clone(),
            active_packages: request.active_packages.clone(),
            runtime_facts: request.runtime_facts.clone(),
            permissions_ceiling: request.permissions_ceiling.clone(),
            limits: ResolverLimits::default(),
        });
        if let Some(plan) = preflight.plan {
            report.candidates.push(RoutingCandidate {
                identity: identity(root),
                score,
                matches,
                plan,
            });
        } else {
            let sanitized: BTreeSet<_> = preflight.issues.iter().map(sanitize).collect();
            let budget = MAX_DIAGNOSTICS.min(diagnostics_remaining);
            let omitted_diagnostics = sanitized.len().saturating_sub(budget);
            let diagnostics: Vec<_> = sanitized.into_iter().take(budget).collect();
            diagnostics_remaining -= diagnostics.len();
            report.exclusions.push(RoutingExclusion {
                identity: identity(root),
                reason: RoutingExclusionReason::InconsistentPreflight,
                omitted_diagnostics,
                diagnostics,
            });
        }
    }
    report.candidates.sort_by(|a, b| {
        b.score.cmp(&a.score).then_with(|| {
            (&a.identity.package_id, &a.identity.revision_id)
                .cmp(&(&b.identity.package_id, &b.identity.revision_id))
        })
    });
    report.eligible_count = report.candidates.len();
    report.top_tie_count = report.candidates.first().map_or(0, |top| {
        report
            .candidates
            .iter()
            .take_while(|item| item.score == top.score)
            .count()
    });
    report.status = match report.top_tie_count {
        0 => RoutingStatus::NoSafeSkill,
        1 => RoutingStatus::Matched,
        _ => RoutingStatus::Ambiguous,
    };
    report.candidates.truncate(request.max_results);
    report
}

fn selector_matches(
    request: &RoutingRequest,
    manifest: &Manifest,
) -> (RoutingMatches, RoutingScore) {
    let exact_intents: Vec<_> = request
        .intents
        .intersection(&manifest.intents)
        .cloned()
        .collect();
    let exact_categories: Vec<_> = request
        .categories
        .intersection(&manifest.categories)
        .cloned()
        .collect();
    let mut descendant_categories = Vec::new();
    let mut descendant_selectors = 0;
    let mut rationale_truncated = false;
    for requested in &request.categories {
        let mut matched = false;
        for declared in &manifest.categories {
            if declared
                .strip_prefix(requested)
                .is_some_and(|suffix| suffix.starts_with('.'))
            {
                matched = true;
                if descendant_categories.len() < MAX_SELECTORS {
                    descendant_categories.push(DescendantCategoryMatch {
                        requested: requested.clone(),
                        declared: declared.clone(),
                    });
                } else {
                    rationale_truncated = true;
                }
            }
        }
        if matched {
            descendant_selectors += 1;
        }
    }
    let score = RoutingScore {
        exact_intents: exact_intents.len() as u16,
        exact_categories: exact_categories.len() as u16,
        descendant_categories: descendant_selectors,
    };
    (
        RoutingMatches {
            exact_intents,
            exact_categories,
            descendant_categories,
            rationale_truncated,
        },
        score,
    )
}

fn identity(claim: &PackageClaim) -> PlannedPackage {
    PlannedPackage {
        package_id: claim.manifest.id.clone(),
        version: claim.manifest.version.clone(),
        revision_id: claim.revision_id.clone(),
        tree_sha256: claim.tree_sha256.clone(),
        permissions_digest: claim.permissions_digest.clone(),
    }
}

fn validate_input(request: &RoutingRequest) -> Vec<RoutingInputIssue> {
    use RoutingInputIssue as Issue;
    let mut issues = BTreeSet::new();
    if request.categories.is_empty() && request.intents.is_empty() {
        issues.insert(Issue::EmptySelectors);
    }
    if request.categories.len() > MAX_SELECTORS || request.intents.len() > MAX_SELECTORS {
        issues.insert(Issue::SelectorLimit);
    } else {
        // Length is checked before validators that tokenize their input.
        if request
            .categories
            .iter()
            .any(|id| id.len() > 128 || !manifest::is_category_id(id))
        {
            issues.insert(Issue::InvalidCategory);
        }
        if request.intents.iter().any(|id| !manifest::is_intent(id)) {
            issues.insert(Issue::InvalidIntent);
        }
    }
    if !(1..=MAX_CANDIDATES).contains(&request.max_results) {
        issues.insert(Issue::InvalidResultLimit);
    }
    if request.candidates.len() > MAX_CANDIDATES {
        issues.insert(Issue::CandidateLimit);
    }
    if request.pins.len() > resolver::MAX_NODES
        || request.active_packages.len() > resolver::MAX_NODES
    {
        issues.insert(Issue::ContextLimit);
    }
    if request.runtime_facts.len() > 128
        || request
            .runtime_facts
            .iter()
            .any(|(id, value)| id.len() > 128 || value.len() > 128)
    {
        issues.insert(Issue::RuntimeFactLimit);
    }
    if !permissions_bounded(&request.permissions_ceiling, false) {
        issues.insert(Issue::PermissionCeilingLimit);
    }
    if !issues.is_empty() {
        return issues.into_iter().collect();
    }
    if request
        .pins
        .keys()
        .chain(request.active_packages.keys())
        .any(|key| key.len() > 64)
    {
        return vec![Issue::MetadataLimit];
    }
    let all_claims = || {
        request
            .candidates
            .iter()
            .chain(request.pins.values())
            .chain(request.active_packages.values())
    };
    if all_claims().any(|claim| {
        !metadata_bounded(&claim.manifest)
            || claim.revision_id.len() > 68
            || claim.tree_sha256.len() > 64
            || claim.permissions_digest.len() > 64
    }) {
        return vec![Issue::MetadataLimit];
    }
    // Count all referenced graph ids, including missing pins and conflicts. These
    // sets hold only borrowed strings and stop growing at the hard bound.
    let mut ids = BTreeSet::new();
    let mut edges = BTreeSet::new();
    let mut candidates = BTreeSet::new();
    for claim in &request.candidates {
        if !candidates.insert(claim.manifest.id.as_str()) {
            issues.insert(Issue::DuplicateCandidatePackage);
        }
    }
    for key in request.pins.keys().chain(request.active_packages.keys()) {
        bounded_graph_id(key, &mut ids, &mut issues);
        if !super::is_package_name(key) {
            issues.insert(Issue::InvalidContext);
        }
    }
    for claim in all_claims() {
        bounded_graph_id(&claim.manifest.id, &mut ids, &mut issues);
        for target in claim.manifest.dependencies.keys() {
            bounded_graph_id(target, &mut ids, &mut issues);
            bounded_graph_edge((&claim.manifest.id, false, target), &mut edges, &mut issues);
        }
        for target in claim.manifest.conflicts.keys() {
            bounded_graph_id(target, &mut ids, &mut issues);
            bounded_graph_edge((&claim.manifest.id, true, target), &mut edges, &mut issues);
        }
    }
    // Complete bounded graph/context checks before canonicalization allocates any
    // metadata copies. Both bound codes are retained independent of candidate order.
    if !issues.is_empty() {
        return issues.into_iter().collect();
    }
    for claim in all_claims() {
        if !claim_valid(claim) {
            issues.insert(Issue::InvalidClaim);
        }
    }
    for (id, claim) in request.pins.iter().chain(request.active_packages.iter()) {
        if id != &claim.manifest.id {
            issues.insert(Issue::InvalidContext);
        }
    }
    if request
        .active_packages
        .values()
        .any(|claim| claim.availability != Availability::Active)
    {
        issues.insert(Issue::InvalidContext);
    }
    issues.into_iter().collect()
}

fn bounded_graph_id<'a>(
    id: &'a str,
    ids: &mut BTreeSet<&'a str>,
    issues: &mut BTreeSet<RoutingInputIssue>,
) {
    if !issues.contains(&RoutingInputIssue::GraphNodeLimit) {
        ids.insert(id);
        if ids.len() > resolver::MAX_NODES {
            issues.insert(RoutingInputIssue::GraphNodeLimit);
        }
    }
}

fn bounded_graph_edge<'a>(
    edge: (&'a str, bool, &'a str),
    edges: &mut BTreeSet<(&'a str, bool, &'a str)>,
    issues: &mut BTreeSet<RoutingInputIssue>,
) {
    if !issues.contains(&RoutingInputIssue::GraphEdgeLimit) {
        edges.insert(edge);
        if edges.len() > resolver::MAX_EDGES {
            issues.insert(RoutingInputIssue::GraphEdgeLimit);
        }
    }
}

fn metadata_bounded(manifest: &Manifest) -> bool {
    let small = |text: &String| text.len() <= 256;
    manifest.id.len() <= 64
        && manifest.version.len() <= 128
        && manifest.categories.len() <= 32
        && manifest.intents.len() <= 64
        && manifest.compatibility.len() <= 64
        && manifest.dependencies.len() <= 64
        && manifest.conflicts.len() <= 64
        && manifest.categories.iter().all(small)
        && manifest.intents.iter().all(small)
        && manifest
            .compatibility
            .iter()
            .all(|(id, range)| small(id) && small(range))
        && manifest
            .dependencies
            .iter()
            .all(|(id, range)| small(id) && small(range))
        && manifest
            .conflicts
            .iter()
            .all(|(id, range)| small(id) && range.as_ref().is_none_or(small))
        && permissions_bounded(&manifest.permissions, true)
}

fn permissions_bounded(permissions: &Permissions, per_manifest: bool) -> bool {
    let scopes = [
        &permissions.filesystem_read,
        &permissions.filesystem_write,
        &permissions.network,
        &permissions.secrets,
    ];
    let total = scopes
        .iter()
        .map(|set| set.len())
        .fold(usize::from(permissions.terminal), usize::saturating_add);
    (!per_manifest || scopes.iter().all(|set| set.len() <= 64))
        && (per_manifest || total <= 256)
        && scopes
            .iter()
            .all(|set| set.len() <= 256 && set.iter().all(|scope| scope.len() <= 256))
}

fn claim_valid(claim: &PackageClaim) -> bool {
    let hash = &claim.tree_sha256;
    super::is_package_name(&claim.manifest.id)
        && hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && claim.revision_id.strip_prefix("skr_") == Some(hash.as_str())
        && manifest::parse_manifest(claim.manifest.canonical_json().as_bytes()).is_ok()
        && claim.permissions_digest == claim.manifest.permissions.digest()
}

fn sanitize(issue: &PreflightIssue) -> RoutingDiagnostic {
    use RoutingDiagnosticCode as Code;
    let (code, package, related) = match issue {
        PreflightIssue::BadPin {
            package_id,
            problem,
        } => (Code::BadPin(*problem), package_id.as_deref(), None),
        PreflightIssue::MissingPin {
            package_id,
            dependency_id,
        } => (
            Code::MissingPin,
            Some(package_id.as_str()),
            Some(dependency_id.as_str()),
        ),
        PreflightIssue::DependencyUnavailable {
            package_id,
            dependency_id,
        } => (
            Code::DependencyUnavailable,
            Some(package_id.as_str()),
            Some(dependency_id.as_str()),
        ),
        PreflightIssue::DependencyInactive {
            package_id,
            dependency_id,
        } => (
            Code::DependencyInactive,
            Some(package_id.as_str()),
            Some(dependency_id.as_str()),
        ),
        PreflightIssue::RootUnavailable { package_id } => {
            (Code::RootUnavailable, Some(package_id.as_str()), None)
        }
        PreflightIssue::RangeMismatch {
            package_id,
            dependency_id,
        } => (
            Code::RangeMismatch,
            Some(package_id.as_str()),
            Some(dependency_id.as_str()),
        ),
        PreflightIssue::UnsupportedRange {
            package_id,
            target_id,
            usage,
        } => (
            Code::UnsupportedRange(*usage),
            Some(package_id.as_str()),
            Some(target_id.as_str()),
        ),
        PreflightIssue::CompatibilityUnknown {
            package_id,
            fact_id,
        } => (
            Code::CompatibilityUnknown,
            Some(package_id.as_str()),
            Some(fact_id.as_str()),
        ),
        PreflightIssue::CompatibilityMismatch {
            package_id,
            fact_id,
        } => (
            Code::CompatibilityMismatch,
            Some(package_id.as_str()),
            Some(fact_id.as_str()),
        ),
        PreflightIssue::Conflict {
            package_id,
            conflicting_id,
        } => (
            Code::Conflict,
            Some(package_id.as_str()),
            Some(conflicting_id.as_str()),
        ),
        PreflightIssue::Cycle { packages } => (
            Code::Cycle,
            packages.first().map(String::as_str),
            packages.get(1).map(String::as_str),
        ),
        PreflightIssue::PermissionOutsideCeiling {
            package_id,
            capability,
            ..
        } => (
            Code::PermissionOutsideCeiling(*capability),
            Some(package_id.as_str()),
            None,
        ),
        PreflightIssue::BoundExceeded { bound, .. } => (Code::BoundExceeded(*bound), None, None),
    };
    // A fact id is not a package id. Both grammars contain only bounded public
    // metadata characters; arbitrary context keys and values are never echoed.
    let safe_id = |id: Option<&str>| {
        id.filter(|id| {
            id.len() <= 64
                && id.bytes().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_' | b'.')
                })
        })
        .map(str::to_owned)
    };
    RoutingDiagnostic {
        code,
        package_id: safe_id(package),
        related_id: safe_id(related),
    }
}
