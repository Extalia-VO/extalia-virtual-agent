//! Bounded, read-only dependency preflight over explicit immutable revision claims.
//!
//! A successful report is a diagnostic ordering, never an execution admission. Inputs
//! (including runtime facts, active status, tree hashes and permission digests) are
//! claims: only a store adapter can verify their provenance and actual object bytes.
//! This module performs no I/O, selects no replacement version and grants nothing.

use std::collections::{BTreeMap, BTreeSet};

use super::manifest::{self, Capability, Manifest, Permissions};
use super::version_range;

pub const MAX_NODES: usize = 128;
pub const MAX_EDGES: usize = 512;
pub const MAX_DEPTH: usize = 32;

/// Claimed availability of exactly the named revision, not of its package generally.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Availability {
    Active,
    Inactive,
    Unavailable,
}

/// Explicit candidate. Constructing this value does not attest any field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageClaim {
    pub manifest: Manifest,
    pub revision_id: String,
    pub tree_sha256: String,
    pub permissions_digest: String,
    pub availability: Availability,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolverLimits {
    pub max_nodes: usize,
    pub max_edges: usize,
    /// Root is depth zero. Limits can tighten, but never raise, the hard caps.
    pub max_depth: usize,
}

impl Default for ResolverLimits {
    fn default() -> Self {
        Self {
            max_nodes: MAX_NODES,
            max_edges: MAX_EDGES,
            max_depth: MAX_DEPTH,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreflightRequest {
    pub root: PackageClaim,
    /// One exact candidate per package. Missing entries never fall back to an active
    /// revision or an automatically selected version.
    pub pins: BTreeMap<String, PackageClaim>,
    /// Other currently active revisions, including packages outside the root closure.
    /// They participate in conflicts in both directions, but not in the ordering.
    pub active_packages: BTreeMap<String, PackageClaim>,
    /// Unverified runtime/framework version claims. Missing or malformed is unknown.
    pub runtime_facts: BTreeMap<String, String>,
    /// Declared ceiling only. Passing it is not evidence of any host permission grant.
    pub permissions_ceiling: Permissions,
    pub limits: ResolverLimits,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PinProblem {
    InvalidPackageId,
    PackageIdMismatch,
    InvalidManifest,
    InvalidRevisionIdentity,
    PermissionDigestMismatch,
    ConflictingRootPin,
    ConflictingActivePin,
    InactiveActivePackage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RangeUse {
    Dependency,
    Compatibility,
    Conflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Bound {
    Nodes,
    Edges,
    Depth,
    RuntimeFacts,
    RuntimeFactText,
    PermissionScopes,
    PermissionScopeText,
}

/// Structured diagnostics contain identifiers only, never source paths, file bodies,
/// arbitrary parser errors, runtime fact values or credential contents.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum PreflightIssue {
    BadPin {
        /// Invalid identifiers are deliberately not echoed.
        package_id: Option<String>,
        problem: PinProblem,
    },
    MissingPin {
        package_id: String,
        dependency_id: String,
    },
    DependencyUnavailable {
        package_id: String,
        dependency_id: String,
    },
    DependencyInactive {
        package_id: String,
        dependency_id: String,
    },
    RootUnavailable {
        package_id: String,
    },
    RangeMismatch {
        package_id: String,
        dependency_id: String,
    },
    UnsupportedRange {
        package_id: String,
        target_id: String,
        usage: RangeUse,
    },
    CompatibilityUnknown {
        package_id: String,
        fact_id: String,
    },
    CompatibilityMismatch {
        package_id: String,
        fact_id: String,
    },
    Conflict {
        package_id: String,
        conflicting_id: String,
    },
    Cycle {
        /// Closed path in deterministic traversal order, first and last equal.
        packages: Vec<String>,
    },
    PermissionOutsideCeiling {
        package_id: String,
        capability: Capability,
        /// A declared scope/reference, never a resolved credential.
        scope: String,
    },
    BoundExceeded {
        bound: Bound,
        limit: usize,
    },
}

/// Content-addressed claim in the dependency-before-dependent diagnostic ordering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedPackage {
    pub package_id: String,
    pub version: String,
    pub revision_id: String,
    pub tree_sha256: String,
    pub permissions_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreflightReport {
    pub issues: Vec<PreflightIssue>,
    /// Absent whenever any diagnostic prevents a consistent ordering. Even a present
    /// plan is not executable and carries no attestation, approval or grants.
    pub plan: Option<Vec<PlannedPackage>>,
}

impl PreflightReport {
    /// No result from this diagnostics-only API can authorize dispatch.
    pub const fn dispatch_eligible(&self) -> bool {
        false
    }
}

/// Inspect explicit pins without modifying lifecycle, activation, approvals or routing.
pub fn preflight(request: &PreflightRequest) -> PreflightReport {
    let limits = ResolverLimits {
        max_nodes: request.limits.max_nodes.min(MAX_NODES),
        max_edges: request.limits.max_edges.min(MAX_EDGES),
        max_depth: request.limits.max_depth.min(MAX_DEPTH),
    };
    let mut issues = BTreeSet::new();
    context_bounds(request, &mut issues);
    if !issues.is_empty() {
        return report(issues, Vec::new());
    }
    // Bound supplied claims as well as traversal: unused pins and unrelated active
    // packages must not create an unbounded validation/conflict pass.
    let supplied = request
        .pins
        .len()
        .saturating_add(request.active_packages.len());
    if supplied > MAX_NODES * 2 {
        issues.insert(PreflightIssue::BoundExceeded {
            bound: Bound::Nodes,
            limit: limits.max_nodes,
        });
        return report(issues, Vec::new());
    }
    let mut all_ids: BTreeSet<&str> = request.pins.keys().map(String::as_str).collect();
    all_ids.extend(request.active_packages.keys().map(String::as_str));
    all_ids.insert(&request.root.manifest.id);
    if all_ids.len() > limits.max_nodes {
        issues.insert(PreflightIssue::BoundExceeded {
            bound: Bound::Nodes,
            limit: limits.max_nodes,
        });
        return report(issues, Vec::new());
    }
    if all_ids.iter().any(|id| !super::is_package_name(id)) {
        issues.insert(PreflightIssue::BadPin {
            package_id: None,
            problem: PinProblem::InvalidPackageId,
        });
        return report(issues, Vec::new());
    }
    let mut invalid = BTreeSet::new();
    if !validate_claim(&request.root.manifest.id, &request.root, &mut issues) {
        invalid.insert(request.root.manifest.id.clone());
    }
    for (id, claim) in request.pins.iter().chain(request.active_packages.iter()) {
        if !validate_claim(id, claim, &mut issues) {
            invalid.insert(id.clone());
        }
    }
    for (id, claim) in &request.active_packages {
        if claim.availability != Availability::Active {
            bad_pin(id, PinProblem::InactiveActivePackage, &mut issues);
            invalid.insert(id.clone());
        }
        if id != &request.root.manifest.id
            && let Some(pin) = request.pins.get(id)
            && pin.availability == Availability::Active
            && pin != claim
        {
            bad_pin(id, PinProblem::ConflictingActivePin, &mut issues);
            invalid.insert(id.clone());
        }
    }
    if let Some(pin) = request.pins.get(&request.root.manifest.id)
        && pin != &request.root
    {
        bad_pin(
            &request.root.manifest.id,
            PinProblem::ConflictingRootPin,
            &mut issues,
        );
    }
    // Count unique dependency/conflict graph edges, so the same active pin supplied
    // in both maps does not consume the budget twice.
    let mut edges = BTreeSet::new();
    for (_, claim) in std::iter::once((&request.root.manifest.id, &request.root))
        .chain(request.pins.iter())
        .chain(request.active_packages.iter())
        .filter(|(id, _)| !invalid.contains(*id))
    {
        edges.extend(
            claim
                .manifest
                .dependencies
                .keys()
                .map(|target| (&claim.manifest.id, false, target)),
        );
        edges.extend(
            claim
                .manifest
                .conflicts
                .keys()
                .map(|target| (&claim.manifest.id, true, target)),
        );
    }
    if edges.len() > limits.max_edges {
        issues.insert(PreflightIssue::BoundExceeded {
            bound: Bound::Edges,
            limit: limits.max_edges,
        });
        return report(issues, Vec::new());
    }
    let mut walk = Walk {
        request,
        limits,
        invalid,
        issues,
        visited: BTreeSet::new(),
        path: Vec::new(),
        ordered: Vec::new(),
    };
    let root_id = &request.root.manifest.id;
    if !walk.invalid.contains(root_id) {
        if request.root.availability == Availability::Unavailable {
            walk.issues.insert(PreflightIssue::RootUnavailable {
                package_id: root_id.clone(),
            });
        }
        walk.visit(root_id, 0);
    }
    walk.conflicts();
    walk.reverse_dependencies();
    walk.check_depth();
    report(walk.issues, walk.ordered)
}

fn context_bounds(request: &PreflightRequest, issues: &mut BTreeSet<PreflightIssue>) {
    if request.runtime_facts.len() > 128 {
        issues.insert(PreflightIssue::BoundExceeded {
            bound: Bound::RuntimeFacts,
            limit: 128,
        });
    } else if request
        .runtime_facts
        .iter()
        .any(|(id, version)| id.len() > 128 || version.len() > 128)
    {
        issues.insert(PreflightIssue::BoundExceeded {
            bound: Bound::RuntimeFactText,
            limit: 128,
        });
    }
    let permissions = &request.permissions_ceiling;
    let scopes = [
        &permissions.filesystem_read,
        &permissions.filesystem_write,
        &permissions.network,
        &permissions.secrets,
    ];
    let count = scopes
        .iter()
        .map(|scope| scope.len())
        .fold(usize::from(permissions.terminal), usize::saturating_add);
    if count > 256 {
        issues.insert(PreflightIssue::BoundExceeded {
            bound: Bound::PermissionScopes,
            limit: 256,
        });
    } else if scopes
        .iter()
        .any(|scopes| scopes.iter().any(|scope| scope.len() > 256))
    {
        issues.insert(PreflightIssue::BoundExceeded {
            bound: Bound::PermissionScopeText,
            limit: 256,
        });
    }
}

fn report(issues: BTreeSet<PreflightIssue>, ordered: Vec<PlannedPackage>) -> PreflightReport {
    PreflightReport {
        plan: issues.is_empty().then_some(ordered),
        issues: issues.into_iter().collect(),
    }
}

fn bad_pin(id: &str, problem: PinProblem, issues: &mut BTreeSet<PreflightIssue>) {
    issues.insert(PreflightIssue::BadPin {
        package_id: super::is_package_name(id).then(|| id.to_owned()),
        problem,
    });
}

fn validate_claim(id: &str, claim: &PackageClaim, issues: &mut BTreeSet<PreflightIssue>) -> bool {
    let mut valid = true;
    if !super::is_package_name(id) {
        bad_pin(id, PinProblem::InvalidPackageId, issues);
        valid = false;
    }
    if id != claim.manifest.id {
        bad_pin(id, PinProblem::PackageIdMismatch, issues);
        valid = false;
    }
    // Manifest fields are public: a caller can construct an unvalidated value.
    // Reparse canonical metadata and never forward arbitrary validator messages.
    let manifest_valid = metadata_bounded(&claim.manifest)
        && manifest::parse_manifest(claim.manifest.canonical_json().as_bytes()).is_ok();
    if !manifest_valid {
        bad_pin(id, PinProblem::InvalidManifest, issues);
        valid = false;
    }
    let hash = &claim.tree_sha256;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || claim.revision_id != format!("skr_{hash}")
    {
        bad_pin(id, PinProblem::InvalidRevisionIdentity, issues);
        valid = false;
    }
    if manifest_valid && claim.permissions_digest != claim.manifest.permissions.digest() {
        bad_pin(id, PinProblem::PermissionDigestMismatch, issues);
        valid = false;
    }
    valid
}

fn metadata_bounded(manifest: &Manifest) -> bool {
    let small = |text: &String| text.len() <= 256;
    let permissions = &manifest.permissions;
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
        && [
            &permissions.filesystem_read,
            &permissions.filesystem_write,
            &permissions.network,
            &permissions.secrets,
        ]
        .into_iter()
        .all(|scopes| scopes.len() <= 64 && scopes.iter().all(small))
}

struct Walk<'a> {
    request: &'a PreflightRequest,
    limits: ResolverLimits,
    invalid: BTreeSet<String>,
    issues: BTreeSet<PreflightIssue>,
    visited: BTreeSet<String>,
    path: Vec<String>,
    ordered: Vec<PlannedPackage>,
}

impl<'a> Walk<'a> {
    fn check_depth(&mut self) {
        // A shared dependency may first be visited along a short path. Propagating
        // longest distances through the completed topological order checks every DAG
        // path without revisiting a potentially exponential number of paths.
        let mut depths = BTreeMap::from([(self.request.root.manifest.id.as_str(), 0usize)]);
        for planned in self.ordered.iter().rev() {
            let Some(depth) = depths.get(planned.package_id.as_str()).copied() else {
                continue;
            };
            let Some(claim) = self.selected(&planned.package_id) else {
                continue;
            };
            for dependency in claim.manifest.dependencies.keys() {
                let next = depth + 1;
                depths
                    .entry(dependency)
                    .and_modify(|seen| *seen = (*seen).max(next))
                    .or_insert(next);
                if next > self.limits.max_depth {
                    self.issues.insert(PreflightIssue::BoundExceeded {
                        bound: Bound::Depth,
                        limit: self.limits.max_depth,
                    });
                }
            }
        }
    }

    fn selected(&self, id: &str) -> Option<&'a PackageClaim> {
        if id == self.request.root.manifest.id {
            Some(&self.request.root)
        } else {
            self.request.pins.get(id)
        }
    }

    fn visit(&mut self, id: &str, depth: usize) {
        if let Some(start) = self.path.iter().position(|item| item == id) {
            let mut packages = self.path[start..].to_vec();
            packages.push(id.to_owned());
            self.issues.insert(PreflightIssue::Cycle { packages });
            return;
        }
        if depth > self.limits.max_depth {
            self.issues.insert(PreflightIssue::BoundExceeded {
                bound: Bound::Depth,
                limit: self.limits.max_depth,
            });
            return;
        }
        if self.visited.contains(id) || self.invalid.contains(id) {
            return;
        }
        let Some(claim) = self.selected(id) else {
            return;
        };
        self.path.push(id.to_owned());
        for (capability, scope) in claim
            .manifest
            .permissions
            .outside(&self.request.permissions_ceiling)
        {
            self.issues
                .insert(PreflightIssue::PermissionOutsideCeiling {
                    package_id: id.to_owned(),
                    capability,
                    scope,
                });
        }
        for (fact, range) in &claim.manifest.compatibility {
            let issue = match self.request.runtime_facts.get(fact) {
                None => Some(PreflightIssue::CompatibilityUnknown {
                    package_id: id.to_owned(),
                    fact_id: fact.clone(),
                }),
                Some(version) if !manifest::is_semver(version) => {
                    Some(PreflightIssue::CompatibilityUnknown {
                        package_id: id.to_owned(),
                        fact_id: fact.clone(),
                    })
                }
                Some(version) => match version_range::matches(range, version) {
                    Ok(true) => None,
                    Ok(false) => Some(PreflightIssue::CompatibilityMismatch {
                        package_id: id.to_owned(),
                        fact_id: fact.clone(),
                    }),
                    Err(_) => Some(PreflightIssue::UnsupportedRange {
                        package_id: id.to_owned(),
                        target_id: fact.clone(),
                        usage: RangeUse::Compatibility,
                    }),
                },
            };
            if let Some(issue) = issue {
                self.issues.insert(issue);
            }
        }
        for (dependency, range) in &claim.manifest.dependencies {
            let Some(pin) = self.selected(dependency) else {
                self.issues.insert(PreflightIssue::MissingPin {
                    package_id: id.to_owned(),
                    dependency_id: dependency.clone(),
                });
                continue;
            };
            if self.invalid.contains(dependency) {
                continue;
            }
            match pin.availability {
                Availability::Active => {}
                Availability::Inactive => {
                    self.issues.insert(PreflightIssue::DependencyInactive {
                        package_id: id.to_owned(),
                        dependency_id: dependency.clone(),
                    });
                }
                Availability::Unavailable => {
                    self.issues.insert(PreflightIssue::DependencyUnavailable {
                        package_id: id.to_owned(),
                        dependency_id: dependency.clone(),
                    });
                }
            }
            match version_range::matches(range, &pin.manifest.version) {
                Ok(true) => {}
                Ok(false) => {
                    self.issues.insert(PreflightIssue::RangeMismatch {
                        package_id: id.to_owned(),
                        dependency_id: dependency.clone(),
                    });
                }
                Err(_) => {
                    self.issues.insert(PreflightIssue::UnsupportedRange {
                        package_id: id.to_owned(),
                        target_id: dependency.clone(),
                        usage: RangeUse::Dependency,
                    });
                }
            }
            self.visit(dependency, depth + 1);
        }
        self.path.pop();
        self.visited.insert(id.to_owned());
        self.ordered.push(PlannedPackage {
            package_id: id.to_owned(),
            version: claim.manifest.version.clone(),
            revision_id: claim.revision_id.clone(),
            tree_sha256: claim.tree_sha256.clone(),
            permissions_digest: claim.permissions_digest.clone(),
        });
    }

    fn conflicts(&mut self) {
        let mut participants: BTreeMap<&str, &PackageClaim> = self
            .request
            .active_packages
            .iter()
            .filter(|(id, _)| !self.invalid.contains(*id))
            .map(|(id, claim)| (id.as_str(), claim))
            .collect();
        for id in &self.visited {
            if let Some(claim) = self.selected(id) {
                participants.insert(id, claim);
            }
        }
        for (id, claim) in &participants {
            for (other_id, range) in &claim.manifest.conflicts {
                let Some(other) = participants.get(other_id.as_str()) else {
                    continue;
                };
                let conflict = match range {
                    None => true,
                    Some(range) => match version_range::matches(range, &other.manifest.version) {
                        Ok(matches) => matches,
                        Err(_) => {
                            self.issues.insert(PreflightIssue::UnsupportedRange {
                                package_id: (*id).to_owned(),
                                target_id: other_id.clone(),
                                usage: RangeUse::Conflict,
                            });
                            false
                        }
                    },
                };
                if conflict {
                    self.issues.insert(PreflightIssue::Conflict {
                        package_id: (*id).to_owned(),
                        conflicting_id: other_id.clone(),
                    });
                }
            }
        }
    }

    fn reverse_dependencies(&mut self) {
        // Replacing a package can break an already-active consumer which is outside
        // the candidate's forward closure. Compare that consumer with the proposed
        // exact version, without requiring unrelated ambient dependencies to be pinned.
        for (id, claim) in &self.request.active_packages {
            if self.invalid.contains(id) || self.visited.contains(id) {
                continue;
            }
            for (dependency_id, range) in &claim.manifest.dependencies {
                if !self.visited.contains(dependency_id) {
                    continue;
                }
                let Some(selected) = self.selected(dependency_id) else {
                    continue;
                };
                match version_range::matches(range, &selected.manifest.version) {
                    Ok(true) => {}
                    Ok(false) => {
                        self.issues.insert(PreflightIssue::RangeMismatch {
                            package_id: id.clone(),
                            dependency_id: dependency_id.clone(),
                        });
                    }
                    Err(_) => {
                        self.issues.insert(PreflightIssue::UnsupportedRange {
                            package_id: id.clone(),
                            target_id: dependency_id.clone(),
                            usage: RangeUse::Dependency,
                        });
                    }
                }
            }
        }
    }
}
