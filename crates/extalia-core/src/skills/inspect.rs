//! The `SkillInspector` port (ADR 0023 §1). A real scanner adapter runs in the Python
//! worker (ADR 0022) behind this trait once a verified pin exists; until then the only
//! adapter is [`UnavailableInspector`], which fails closed with `scanner-unavailable`.
//!
//! An inspector reports an outcome only. It never writes inspections, approvals or
//! activations; the registry records the outcome, binds it to the tree hash, scanner
//! identity and policy version, and applies the policy (blueprint §7).

use std::path::Path;

/// Identity of the scanner that produced an attestation. An attestation is valid only
/// while every field equals the current inspector's, and only if `pin` is set: an
/// unpinned scanner never attests (ADR 0023 §2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScannerIdentity {
    /// Stable adapter id, for example `unavailable`.
    pub id: String,
    /// Upstream commit plus installed artifact hash; `None` until verified.
    pub pin: Option<String>,
    /// The scanner's self-reported version.
    pub version: Option<String>,
    /// Version of the Extalia-owned report normalizer.
    pub normalizer_version: Option<String>,
}

/// Highest finding severity of a completed scan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    None,
    Low,
    Medium,
    High,
    Critical,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Critical => "critical",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "none" => Some(Self::None),
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            "critical" => Some(Self::Critical),
            _ => None,
        }
    }
}

/// How much of the package the scanner covered. Only `Complete` can attest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Coverage {
    Complete,
    Partial,
    None,
}

impl Coverage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Complete => "complete",
            Self::Partial => "partial",
            Self::None => "none",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "complete" => Some(Self::Complete),
            "partial" => Some(Self::Partial),
            "none" => Some(Self::None),
            _ => None,
        }
    }
}

/// Why a scan produced no usable verdict. Every case keeps the package quarantined.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// No verified scanner is installed (the default until ADR 0023's pin exists).
    ScannerUnavailable,
    Incomplete,
    Timeout,
    Error,
    InvalidOutput,
}

impl Failure {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ScannerUnavailable => "scanner-unavailable",
            Self::Incomplete => "incomplete",
            Self::Timeout => "timeout",
            Self::Error => "error",
            Self::InvalidOutput => "invalid-output",
        }
    }
}

/// What an inspector reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InspectionOutcome {
    Failed(Failure),
    Completed {
        verdict: Severity,
        coverage: Coverage,
        /// Reference to the redacted report (never the report itself).
        report_ref: Option<String>,
    },
}

impl InspectionOutcome {
    /// The `skill_inspections.outcome` code.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Failed(failure) => failure.as_str(),
            Self::Completed { .. } => "completed",
        }
    }
}

/// What the inspector may look at: the immutable object, read-only.
#[derive(Debug, Clone, Copy)]
pub struct InspectionRequest<'a> {
    pub revision_id: &'a str,
    pub tree_sha256: &'a str,
    pub object_dir: &'a Path,
    pub policy_version: &'a str,
}

/// What the installed inspector can do (`SKILL_SCANNER_STATUSES`, wire `skill.scanner`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScannerStatus {
    /// An adapter with a verified pin is installed; imports are inspected.
    Ready,
    /// An adapter is installed without a verified pin; it is never run (ADR 0023).
    Unpinned,
    /// No scanner can run: none installed ([`UnavailableInspector`]), or a pinned scanner
    /// whose worker is missing.
    Unavailable,
}

impl ScannerStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Unpinned => "unpinned",
            Self::Unavailable => "unavailable",
        }
    }
}

/// The inspection port.
pub trait SkillInspector {
    fn identity(&self) -> ScannerIdentity;
    fn inspect(&self, request: &InspectionRequest<'_>) -> InspectionOutcome;

    /// Whether this inspector can attest. By default an adapter is `Ready` exactly when its
    /// identity carries a pin; an adapter that can detect a missing worker overrides this
    /// with `Unavailable`. `Ready` is never reported without a pin.
    fn status(&self) -> ScannerStatus {
        if self.identity().pin.is_some() {
            ScannerStatus::Ready
        } else {
            ScannerStatus::Unpinned
        }
    }
}

/// The default adapter while no scanner pin is verified: always `scanner-unavailable`.
#[derive(Debug, Clone, Copy, Default)]
pub struct UnavailableInspector;

impl UnavailableInspector {
    pub const ID: &'static str = "unavailable";
}

impl SkillInspector for UnavailableInspector {
    fn identity(&self) -> ScannerIdentity {
        ScannerIdentity {
            id: Self::ID.to_owned(),
            pin: None,
            version: None,
            normalizer_version: None,
        }
    }

    fn inspect(&self, _request: &InspectionRequest<'_>) -> InspectionOutcome {
        InspectionOutcome::Failed(Failure::ScannerUnavailable)
    }

    fn status(&self) -> ScannerStatus {
        ScannerStatus::Unavailable
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake(Option<&'static str>);

    impl SkillInspector for Fake {
        fn identity(&self) -> ScannerIdentity {
            ScannerIdentity {
                id: "fake".into(),
                pin: self.0.map(str::to_owned),
                version: None,
                normalizer_version: None,
            }
        }

        fn inspect(&self, _request: &InspectionRequest<'_>) -> InspectionOutcome {
            InspectionOutcome::Failed(Failure::Error)
        }
    }

    #[test]
    fn status_follows_the_pin_and_the_unavailable_adapter() {
        assert_eq!(UnavailableInspector.status(), ScannerStatus::Unavailable);
        assert_eq!(UnavailableInspector.identity().pin, None);
        assert_eq!(Fake(None).status(), ScannerStatus::Unpinned);
        assert_eq!(Fake(Some("abc+sha256:1")).status(), ScannerStatus::Ready);
        assert_eq!(
            [
                ScannerStatus::Unpinned,
                ScannerStatus::Ready,
                ScannerStatus::Unavailable
            ]
            .map(ScannerStatus::as_str),
            ["unpinned", "ready", "unavailable"]
        );
    }
}
