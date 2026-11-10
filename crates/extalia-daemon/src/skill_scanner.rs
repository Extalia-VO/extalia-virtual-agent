//! Pinned one-shot SkillSpector adapter. Worker output is evidence only; the core
//! alone binds it to immutable package bytes and requires separate user approval.
mod bundle;
mod process;
use bundle::Bundle;
use extalia_core::skills::inspect::{
    Coverage, Failure, InspectionOutcome, InspectionRequest, ScannerIdentity, ScannerStatus,
    Severity, SkillInspector,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
pub const VERSION: &str = "2.13.4";
pub const SOURCE: &str = "54824463814a0be01360792523ec7245a69190fc";
pub const NORMALIZER: &str = "extalia-skillspector-v1";
const PIN: Option<&str> = option_env!("EXTALIA_SKILLSPECTOR_MANIFEST_SHA256");
#[derive(Debug)]
pub struct SkillSpector {
    root: Option<PathBuf>,
    pin: Option<String>,
}
impl SkillSpector {
    pub fn bundled() -> Self {
        let root = PIN.and_then(|pin| {
            let executable = std::env::current_exe().ok()?;
            let parent = executable.parent()?;
            let mut candidates = Vec::new();
            if let Some(root) = std::env::var_os("EXTALIA_SKILLSPECTOR_ROOT") {
                candidates.push(PathBuf::from(root));
            }
            candidates.push(parent.join("skillspector"));
            if let Some(parent) = parent.parent() {
                candidates.push(parent.join("skillspector"));
            }
            candidates
                .into_iter()
                .find(|root| Bundle::observe(root, pin).is_some())
        });
        Self {
            root,
            pin: PIN.map(str::to_owned),
        }
    }
    fn bundle(&self) -> Option<Bundle> {
        Bundle::observe(self.root.as_ref()?, self.pin.as_deref()?)
    }
}
impl SkillInspector for SkillSpector {
    fn identity(&self) -> ScannerIdentity {
        ScannerIdentity {
            id: "nvidia-skillspector".into(),
            pin: process::supported()
                .then(|| self.bundle())
                .flatten()
                .map(|bundle| format!("{SOURCE}:sha256:{}", bundle.manifest_pin)),
            version: Some(VERSION.into()),
            normalizer_version: Some(NORMALIZER.into()),
        }
    }
    fn status(&self) -> ScannerStatus {
        if !cfg!(target_os = "macos") || !process::supported() || self.bundle().is_none() {
            ScannerStatus::Unavailable
        } else {
            ScannerStatus::Ready
        }
    }
    fn inspect(&self, request: &InspectionRequest<'_>) -> InspectionOutcome {
        self.inspect_with_timeout(request, std::time::Duration::from_secs(60))
    }
    fn inspect_with_timeout(
        &self,
        request: &InspectionRequest<'_>,
        timeout: std::time::Duration,
    ) -> InspectionOutcome {
        let started = std::time::Instant::now();
        let Some(bundle) = self.bundle() else {
            return InspectionOutcome::Failed(Failure::ScannerUnavailable);
        };
        if !process::supported() {
            return InspectionOutcome::Failed(Failure::ScannerUnavailable);
        }
        let bytes = match process::scan(&bundle, request, timeout.saturating_sub(started.elapsed()))
        {
            Ok(bytes) => bytes,
            Err(failure) => return InspectionOutcome::Failed(failure),
        };
        if self.bundle().is_none() {
            return InspectionOutcome::Failed(Failure::ScannerUnavailable);
        }
        normalize(&bytes, request)
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Report {
    schema_version: u64,
    revision_id: String,
    tree_sha256: String,
    policy_version: String,
    scanner_version: String,
    source_commit: String,
    normalizer_version: String,
    outcome: String,
    severity: String,
    coverage: String,
    issue_count: u64,
}
fn normalize(bytes: &[u8], request: &InspectionRequest<'_>) -> InspectionOutcome {
    let failed = || InspectionOutcome::Failed(Failure::InvalidOutput);
    let Ok(report) = serde_json::from_slice::<Report>(bytes) else {
        return failed();
    };
    if report.schema_version != 1
        || report.revision_id != request.revision_id
        || report.tree_sha256 != request.tree_sha256
        || report.policy_version != request.policy_version
        || report.scanner_version != VERSION
        || report.source_commit != SOURCE
        || report.normalizer_version != NORMALIZER
        || report.issue_count > 10000
    {
        return failed();
    }
    match report.outcome.as_str() {
        "error" => return InspectionOutcome::Failed(Failure::Error),
        "invalid-output" => return failed(),
        "incomplete" => return InspectionOutcome::Failed(Failure::Incomplete),
        "completed" => {}
        _ => return failed(),
    }
    let Some(verdict) = Severity::parse(&report.severity) else {
        return failed();
    };
    if report.coverage != "complete" {
        return InspectionOutcome::Failed(Failure::Incomplete);
    }
    if (report.issue_count == 0) != (verdict == Severity::None) {
        return failed();
    }
    InspectionOutcome::Completed {
        verdict,
        coverage: Coverage::Complete,
        report_ref: Some(format!(
            "skillspector:sha256:{}",
            hex(&Sha256::digest(bytes))
        )),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    fn request() -> InspectionRequest<'static> {
        InspectionRequest {
            revision_id: "skr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            tree_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            object_dir: std::path::Path::new("/temporary/package"),
            policy_version: "extalia.skill-policy.v2",
        }
    }
    fn report() -> Value {
        let r = request();
        json!({"schema_version":1,"revision_id":r.revision_id,"tree_sha256":r.tree_sha256,"policy_version":r.policy_version,"scanner_version":VERSION,"source_commit":SOURCE,"normalizer_version":NORMALIZER,"outcome":"completed","severity":"none","coverage":"complete","issue_count":0})
    }
    #[test]
    fn exact_complete_report_attests_but_incomplete_does_not() {
        let mut value = report();
        assert!(matches!(
            normalize(&serde_json::to_vec(&value).unwrap(), &request()),
            InspectionOutcome::Completed {
                verdict: Severity::None,
                ..
            }
        ));
        value["coverage"] = json!("partial");
        assert_eq!(
            normalize(&serde_json::to_vec(&value).unwrap(), &request()),
            InspectionOutcome::Failed(Failure::Incomplete)
        );
    }
    #[test]
    fn bad_identity_unknown_fields_and_contradictory_findings_are_refused() {
        for key in [
            "revision_id",
            "tree_sha256",
            "policy_version",
            "scanner_version",
            "source_commit",
            "normalizer_version",
        ] {
            let mut v = report();
            v[key] = json!("wrong");
            assert_eq!(
                normalize(&serde_json::to_vec(&v).unwrap(), &request()),
                InspectionOutcome::Failed(Failure::InvalidOutput)
            );
        }
        let mut v = report();
        v["extra"] = json!("not allowed");
        assert_eq!(
            normalize(&serde_json::to_vec(&v).unwrap(), &request()),
            InspectionOutcome::Failed(Failure::InvalidOutput)
        );
        let mut v = report();
        v["issue_count"] = json!(1);
        assert_eq!(
            normalize(&serde_json::to_vec(&v).unwrap(), &request()),
            InspectionOutcome::Failed(Failure::InvalidOutput)
        );
    }
    #[test]
    fn malicious_complete_report_retains_high_verdict() {
        let mut v = report();
        v["severity"] = json!("high");
        v["issue_count"] = json!(2);
        assert!(matches!(
            normalize(&serde_json::to_vec(&v).unwrap(), &request()),
            InspectionOutcome::Completed {
                verdict: Severity::High,
                ..
            }
        ));
    }
    #[test]
    fn duplicate_protocol_fields_are_not_last_write_wins() {
        let bytes = serde_json::to_string(&report()).unwrap();
        let duplicated = bytes.replacen("{", "{\"schema_version\":99,", 1);
        assert_eq!(
            normalize(duplicated.as_bytes(), &request()),
            InspectionOutcome::Failed(Failure::InvalidOutput)
        );
    }
}
