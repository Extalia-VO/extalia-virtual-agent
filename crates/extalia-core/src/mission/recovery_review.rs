//! A coherent read-only review, never an execution or reconciliation authorization.
use super::{MissionExecution, MissionExecutions, MissionSnapshot, canonical};
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissionRecoveryReview {
    pub snapshot: MissionSnapshot,
    pub executions: Vec<MissionExecution>,
    pub mission_digest: String,
    pub graph_digest: String,
    pub review_digest: String,
    /// Every graph task without a durable admission, including tasks never started.
    /// An empty list does not certify planner, worktree or remote-effect settlement.
    pub missing_admission_task_ids: Vec<String>,
}
impl MissionRecoveryReview {
    pub fn to_value(&self) -> Value {
        json!({"kind":"extalia-recovery-review-v1", "snapshot":self.snapshot.to_value(),
            "executions":MissionExecutions { mission_id:self.snapshot.mission_id.clone(), executions:self.executions.clone() }.to_value()["executions"],
            "missionDigest":self.mission_digest,"graphDigest":self.graph_digest,"reviewDigest":self.review_digest,
            "missingAdmissionTaskIds":self.missing_admission_task_ids,"worktreeOwnership":"unverified"})
    }
    /// Domain-separated and profile-bound. Include evidence even when version/sequence did not change.
    /// Future decisions must re-read and compare inside their own write transaction.
    pub fn captured_digest(&self, profile: &str) -> String {
        let mut value = self.to_value();
        value
            .as_object_mut()
            .expect("review object")
            .remove("reviewDigest");
        value["profileId"] = profile.into();
        canonical::digest(&value)
    }
}
