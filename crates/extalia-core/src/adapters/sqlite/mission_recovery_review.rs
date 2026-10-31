//! Pin canonical state, full graph hashes and execution evidence in one SQLite read view.
use super::{
    CoreStore,
    execution_receipts::executions_in_transaction,
    mission_snapshot::snapshot_in_transaction,
    missions::{load_mission, load_task},
    planned_tasks,
};
use crate::mission::{MissionError, MissionRecoveryReview, TaskGraph, canonical};
use rusqlite::{Transaction, TransactionBehavior};

impl CoreStore {
    /// Read-only: no lease renewal, reaping, journal entry, receipt or worktree mutation.
    pub fn mission_recovery_review(
        &mut self,
        profile: &str,
        mission_id: &str,
    ) -> Result<MissionRecoveryReview, MissionError> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Deferred)?;
        let review = review_in_transaction(&tx, profile, mission_id)?;
        tx.commit()?;
        Ok(review)
    }
}

/// Shared by coherent review and future transactional review comparison. Grants no authority.
pub(super) fn review_in_transaction(
    tx: &Transaction<'_>,
    profile: &str,
    mission_id: &str,
) -> Result<MissionRecoveryReview, MissionError> {
    let snapshot = snapshot_in_transaction(tx, profile, mission_id)?;
    let executions = executions_in_transaction(tx, profile, mission_id)?;
    // snapshot_in_transaction validated each complete canonical payload and its stored digest.
    let mission = load_mission(tx, profile, mission_id)?;
    let graph = TaskGraph {
        mission_id: mission_id.into(),
        tasks: snapshot
            .tasks
            .iter()
            .map(|task| load_task(tx, profile, mission_id, &task.task_id))
            .collect::<Result<_, _>>()?,
    };
    planned_tasks::guard(tx, profile, &mission, &graph)?;
    let missing_admission_task_ids = snapshot
        .tasks
        .iter()
        .filter(|task| {
            !executions
                .iter()
                .any(|entry| entry.admission.task_id == task.task_id)
        })
        .map(|task| task.task_id.clone())
        .collect();
    let mut review = MissionRecoveryReview {
        snapshot,
        executions,
        mission_digest: canonical::digest(&mission.to_value()),
        graph_digest: canonical::digest(&graph.to_value()),
        review_digest: String::new(),
        missing_admission_task_ids,
    };
    review.review_digest = review.captured_digest(profile);
    // Keep the bounded response safely below the negotiated 1 MiB frame maximum.
    if canonical::to_string(&review.to_value()).len() > 512 * 1024 {
        return Err(MissionError::Capacity("recovery review"));
    }
    Ok(review)
}
