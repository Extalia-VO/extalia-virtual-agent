//! Owned, single-use inspection admissions. Fields stay private to the registry.
use super::super::inspect::{InspectionRequest, ScannerIdentity};
use std::path::PathBuf;

#[derive(Debug)]
pub struct PreparedInspection {
    pub(super) profile: String,
    pub(super) revision_id: String,
    pub(super) tree_sha256: String,
    pub(super) object_dir: PathBuf,
    pub(super) identity: ScannerIdentity,
    pub(super) policy_version: String,
    pub(super) started: String,
    pub(super) event_seq: i64,
}
impl PreparedInspection {
    pub fn scanner_identity(&self) -> &ScannerIdentity {
        &self.identity
    }
    pub fn request(&self) -> InspectionRequest<'_> {
        InspectionRequest {
            revision_id: &self.revision_id,
            tree_sha256: &self.tree_sha256,
            object_dir: &self.object_dir,
            policy_version: &self.policy_version,
        }
    }
}
