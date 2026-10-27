//! Pure skill policy (FR-16, FR-18; ADRs 0023 §4, 0025 §5, 0026 §3). No IO, clock or
//! state: the registry gathers the facts and applies the result.
//!
//! - Verdict mapping: scanner unavailable, failed, timed out, invalid or incomplete →
//!   stays `quarantined`; critical/high → `blocked`; medium → `review_required` (human
//!   review); low → `inspected`, conditional; none → `inspected`.
//! - An attestation is valid only for the same tree hash, the same pinned scanner
//!   identity and the same policy version, with complete coverage.
//! - Auto-eligibility (hybrid activation) needs all of: valid attestation, `declarative`
//!   risk class, verdict `none` (or `low` with no declared permission), a passed
//!   evaluation, no permission increase over the active revision, declared permissions
//!   within the profile's pre-authorized grants, and auto-activation enabled. Anything else
//!   awaits explicit approval, with every reason listed. A clean scan is necessary, never
//!   sufficient.

use super::inspect::{Coverage, InspectionOutcome, ScannerIdentity, Severity};
use super::manifest::{Permissions, RiskClass};

/// Version of these rules, bound into every attestation and approval. Changing the rules
/// means a new version, which makes every attestation stale (re-inspection).
pub const POLICY_VERSION: &str = "extalia.skill-policy.v1";

/// Default expiry of a revision approval: 10 minutes, the `once` default of ADR 0026
/// (question 1). It is the window for the user's activation after the approval is shown;
/// a consumed approval keeps authorizing re-activation of the same revision (see the
/// registry). Callers may ask for a different expiry up to [`MAX_APPROVAL_TTL_MS`].
pub const DEFAULT_APPROVAL_TTL_MS: i64 = 10 * 60_000;
/// Upper bound of a requested approval expiry (24 hours).
pub const MAX_APPROVAL_TTL_MS: i64 = 24 * 60 * 60_000;

/// What an inspection outcome does to a revision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    /// Back to (or stay in) `quarantined`, with the outcome code as reason.
    Quarantine(&'static str),
    /// `blocked`, terminal.
    Block(&'static str),
    /// `review_required`: a human must review the findings.
    Review,
    /// `inspected`; `conditional` for low findings.
    Pass { conditional: bool },
}

pub fn disposition(outcome: &InspectionOutcome) -> Disposition {
    match outcome {
        InspectionOutcome::Failed(failure) => Disposition::Quarantine(failure.as_str()),
        InspectionOutcome::Completed { coverage, .. } if *coverage != Coverage::Complete => {
            Disposition::Quarantine("incomplete")
        }
        InspectionOutcome::Completed { verdict, .. } => match verdict {
            Severity::Critical => Disposition::Block("finding-critical"),
            Severity::High => Disposition::Block("finding-high"),
            Severity::Medium => Disposition::Review,
            Severity::Low => Disposition::Pass { conditional: true },
            Severity::None => Disposition::Pass { conditional: false },
        },
    }
}

/// A stored attestation, as the policy sees it.
#[derive(Debug, Clone, Copy)]
pub struct Attestation<'a> {
    pub tree_sha256: &'a str,
    pub scanner: &'a ScannerIdentity,
    pub policy_version: &'a str,
    pub completed: bool,
    pub coverage: Coverage,
    pub verdict: Option<Severity>,
}

/// The current values an attestation must still match.
#[derive(Debug, Clone, Copy)]
pub struct Current<'a> {
    pub tree_sha256: &'a str,
    pub scanner: &'a ScannerIdentity,
    pub policy_version: &'a str,
}

/// `Ok` while the attestation still holds, otherwise the reason code.
pub fn check_attestation(
    attestation: &Attestation<'_>,
    current: &Current<'_>,
) -> Result<(), &'static str> {
    if !attestation.completed || attestation.coverage != Coverage::Complete {
        return Err("attestation_incomplete");
    }
    if matches!(
        attestation.verdict,
        None | Some(Severity::High | Severity::Critical)
    ) {
        return Err("attestation_blocking");
    }
    if attestation.scanner.pin.is_none() || current.scanner.pin.is_none() {
        return Err("scanner_unpinned");
    }
    if attestation.scanner != current.scanner {
        return Err("scanner_changed");
    }
    if attestation.policy_version != current.policy_version {
        return Err("policy_changed");
    }
    if attestation.tree_sha256 != current.tree_sha256 {
        return Err("hash_mismatch");
    }
    Ok(())
}

/// Result of a sandboxed evaluation (FR-22); recorded by the core, never by the worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvaluationResult {
    Passed,
    Failed,
    InsufficientEvidence,
}

impl EvaluationResult {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::InsufficientEvidence => "insufficient_evidence",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "passed" => Some(Self::Passed),
            "failed" => Some(Self::Failed),
            "insufficient_evidence" => Some(Self::InsufficientEvidence),
            _ => None,
        }
    }
}

/// True when `new` declares anything the currently active revision did not (a first
/// revision with any permission is an increase).
pub fn permission_increase(new: &Permissions, previous: Option<&Permissions>) -> bool {
    match previous {
        Some(previous) => !new.outside(previous).is_empty(),
        None => !new.is_empty(),
    }
}

/// Facts for the approval route of an evaluated revision.
#[derive(Debug, Clone, Copy)]
pub struct RouteFacts<'a> {
    /// [`check_attestation`] passed for the revision's latest inspection.
    pub attestation_valid: bool,
    pub verdict: Severity,
    pub risk_class: RiskClass,
    pub permissions: &'a Permissions,
    /// Declared permissions of the package's active revision, if any.
    pub previous: Option<&'a Permissions>,
    /// Profile-level pre-authorized grants (ADR 0026 §3).
    pub preauthorized: &'a Permissions,
    pub evaluation: Option<EvaluationResult>,
    /// Profile setting for hybrid auto-activation; off unless the user turned it on.
    pub auto_activation: bool,
}

/// Where an evaluated revision goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    AutoEligible,
    AwaitingApproval(Vec<&'static str>),
}

pub fn route(facts: &RouteFacts<'_>) -> Route {
    let mut reasons = Vec::new();
    if !facts.attestation_valid {
        reasons.push("attestation_invalid");
    }
    if facts.risk_class != RiskClass::Declarative {
        reasons.push("risk_class");
    }
    match facts.verdict {
        Severity::None => {}
        Severity::Low if facts.permissions.is_empty() => {}
        Severity::Low => reasons.push("conditional_finding"),
        Severity::Medium | Severity::High | Severity::Critical => reasons.push("reviewed_finding"),
    }
    match facts.evaluation {
        Some(EvaluationResult::Passed) => {}
        Some(_) => reasons.push("evaluation_not_passed"),
        None => reasons.push("evaluation_missing"),
    }
    if permission_increase(facts.permissions, facts.previous) {
        reasons.push("permission_increase");
    }
    if !facts.permissions.outside(facts.preauthorized).is_empty() {
        reasons.push("exceeds_preauthorized_grants");
    }
    if !facts.auto_activation {
        reasons.push("auto_activation_disabled");
    }
    if reasons.is_empty() {
        Route::AutoEligible
    } else {
        Route::AwaitingApproval(reasons)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::inspect::Failure;

    fn pinned() -> ScannerIdentity {
        ScannerIdentity {
            id: "fake".into(),
            pin: Some("commit+artifact".into()),
            version: Some("1.0.0".into()),
            normalizer_version: Some("1".into()),
        }
    }

    fn completed(verdict: Severity, coverage: Coverage) -> InspectionOutcome {
        InspectionOutcome::Completed {
            verdict,
            coverage,
            report_ref: None,
        }
    }

    #[test]
    fn verdict_mapping_fails_closed() {
        for failure in [
            Failure::ScannerUnavailable,
            Failure::Incomplete,
            Failure::Timeout,
            Failure::Error,
            Failure::InvalidOutput,
        ] {
            assert_eq!(
                disposition(&InspectionOutcome::Failed(failure)),
                Disposition::Quarantine(failure.as_str())
            );
        }
        assert_eq!(
            disposition(&completed(Severity::None, Coverage::Partial)),
            Disposition::Quarantine("incomplete")
        );
        assert_eq!(
            disposition(&completed(Severity::Critical, Coverage::Complete)),
            Disposition::Block("finding-critical")
        );
        assert_eq!(
            disposition(&completed(Severity::High, Coverage::Complete)),
            Disposition::Block("finding-high")
        );
        assert_eq!(
            disposition(&completed(Severity::Medium, Coverage::Complete)),
            Disposition::Review
        );
        assert_eq!(
            disposition(&completed(Severity::Low, Coverage::Complete)),
            Disposition::Pass { conditional: true }
        );
        assert_eq!(
            disposition(&completed(Severity::None, Coverage::Complete)),
            Disposition::Pass { conditional: false }
        );
    }

    #[test]
    fn attestation_binds_hash_scanner_and_policy() {
        let scanner = pinned();
        let attestation = Attestation {
            tree_sha256: "a",
            scanner: &scanner,
            policy_version: POLICY_VERSION,
            completed: true,
            coverage: Coverage::Complete,
            verdict: Some(Severity::None),
        };
        let current = Current {
            tree_sha256: "a",
            scanner: &scanner,
            policy_version: POLICY_VERSION,
        };
        assert_eq!(check_attestation(&attestation, &current), Ok(()));
        assert_eq!(
            check_attestation(
                &attestation,
                &Current {
                    tree_sha256: "b",
                    ..current
                }
            ),
            Err("hash_mismatch")
        );
        assert_eq!(
            check_attestation(
                &attestation,
                &Current {
                    policy_version: "v2",
                    ..current
                }
            ),
            Err("policy_changed")
        );
        let upgraded = ScannerIdentity {
            version: Some("1.0.1".into()),
            ..pinned()
        };
        assert_eq!(
            check_attestation(
                &attestation,
                &Current {
                    scanner: &upgraded,
                    ..current
                }
            ),
            Err("scanner_changed")
        );
        let unavailable =
            crate::skills::inspect::SkillInspector::identity(&crate::skills::UnavailableInspector);
        assert_eq!(
            check_attestation(
                &attestation,
                &Current {
                    scanner: &unavailable,
                    ..current
                }
            ),
            Err("scanner_unpinned")
        );
        let partial = Attestation {
            coverage: Coverage::Partial,
            ..attestation
        };
        assert_eq!(
            check_attestation(&partial, &current),
            Err("attestation_incomplete")
        );
    }

    fn facts<'a>(permissions: &'a Permissions, preauthorized: &'a Permissions) -> RouteFacts<'a> {
        RouteFacts {
            attestation_valid: true,
            verdict: Severity::None,
            risk_class: RiskClass::Declarative,
            permissions,
            previous: None,
            preauthorized,
            evaluation: Some(EvaluationResult::Passed),
            auto_activation: true,
        }
    }

    #[test]
    fn auto_eligible_only_when_every_gate_passes() {
        let none = Permissions::default();
        assert_eq!(route(&facts(&none, &none)), Route::AutoEligible);
        let cases: [(RouteFacts<'_>, &str); 6] = [
            (
                RouteFacts {
                    attestation_valid: false,
                    ..facts(&none, &none)
                },
                "attestation_invalid",
            ),
            (
                RouteFacts {
                    risk_class: RiskClass::ToolUsing,
                    ..facts(&none, &none)
                },
                "risk_class",
            ),
            (
                RouteFacts {
                    verdict: Severity::Medium,
                    ..facts(&none, &none)
                },
                "reviewed_finding",
            ),
            (
                RouteFacts {
                    evaluation: None,
                    ..facts(&none, &none)
                },
                "evaluation_missing",
            ),
            (
                RouteFacts {
                    evaluation: Some(EvaluationResult::InsufficientEvidence),
                    ..facts(&none, &none)
                },
                "evaluation_not_passed",
            ),
            (
                RouteFacts {
                    auto_activation: false,
                    ..facts(&none, &none)
                },
                "auto_activation_disabled",
            ),
        ];
        for (facts, reason) in cases {
            assert_eq!(route(&facts), Route::AwaitingApproval(vec![reason]));
        }
    }

    #[test]
    fn permission_increase_requires_approval() {
        let mut read = Permissions::default();
        read.filesystem_read.insert("src/**".into());
        let mut more = read.clone();
        more.network.insert("example.com".into());
        // First revision with a permission, beyond the grants.
        let none = Permissions::default();
        assert_eq!(
            route(&facts(&read, &none)),
            Route::AwaitingApproval(vec!["permission_increase", "exceeds_preauthorized_grants"])
        );
        // Within the grants but more than the active revision.
        assert_eq!(
            route(&RouteFacts {
                previous: Some(&read),
                ..facts(&more, &more)
            }),
            Route::AwaitingApproval(vec!["permission_increase"])
        );
        // Same permissions as the active revision and within the grants.
        assert_eq!(
            route(&RouteFacts {
                previous: Some(&read),
                ..facts(&read, &read)
            }),
            Route::AutoEligible
        );
        // Low finding is only unconditional without permissions.
        assert_eq!(
            route(&RouteFacts {
                verdict: Severity::Low,
                previous: Some(&read),
                ..facts(&read, &read)
            }),
            Route::AwaitingApproval(vec!["conditional_finding"])
        );
        assert!(permission_increase(&more, Some(&read)));
        assert!(!permission_increase(&read, Some(&more)));
    }
}
