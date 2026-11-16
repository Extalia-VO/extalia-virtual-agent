use super::*;
use extalia_core::skills::registry::{EvaluationSubjectOutput, PreparedEvaluation};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
pub(super) type Plans = Arc<Mutex<HashMap<String, (Instant, PreparedEvaluation)>>>;
impl Skills {
    pub(super) fn evaluation(
        &self,
        store: &mut CoreStore,
        complete: bool,
        input: &Value,
        ctx: &PolicyContext,
        now: i64,
    ) -> Result<Value, SkillError> {
        let mut plans = self
            .evaluations
            .lock()
            .map_err(|_| SkillError::Denied("evaluation_owner_unavailable"))?;
        plans.retain(|_, (created, _)| created.elapsed() < Duration::from_secs(600));
        let mut registry = self.registry(store);
        if complete {
            let id = input["evaluationId"]
                .as_str()
                .ok_or(SkillError::Denied("evaluation_handle_invalid"))?;
            let (_, plan) = plans
                .remove(id)
                .ok_or(SkillError::Denied("evaluation_handle_invalid"))?;
            drop(plans);
            let outputs: Vec<EvaluationSubjectOutput> =
                serde_json::from_value(input["subjects"].clone())
                    .map_err(|_| SkillError::Denied("evaluation_outputs_invalid"))?;
            registry.complete_evaluation(
                plan,
                &outputs,
                input["provider"].as_str().unwrap_or(""),
                input["model"].as_str().unwrap_or(""),
                ctx,
                now,
            )
        } else {
            if plans.len() >= 8 {
                return Err(SkillError::Denied("evaluation_capacity"));
            }
            let id = input["revisionId"]
                .as_str()
                .ok_or(SkillError::Denied("evaluation_revision_invalid"))?;
            if plans.values().any(|(_, plan)| plan.revision_id() == id) {
                return Err(SkillError::Denied("evaluation_busy"));
            }
            self.refuse_builtin(store, id)?;
            let mut registry = self.registry(store);
            let plan = registry.prepare_evaluation(
                id,
                input["treeSha256"].as_str().unwrap_or(""),
                ctx,
                now,
            )?;
            static SEQUENCE: AtomicU64 = AtomicU64::new(0);
            let id: String = Sha256::digest(format!(
                "{}:{now}:{}:{:?}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed),
                Instant::now()
            ))
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
            let mut output = json!({"evaluationId":id,"revisionId":plan.revision_id(),"treeSha256":plan.tree_sha256(),"subjects":plan.subjects});
            if let Some((revision, tree)) = plan.baseline() {
                output["baselineRevisionId"] = revision.into();
                output["baselineTreeSha256"] = tree.into();
            }
            plans.insert(id, (Instant::now(), plan));
            Ok(output)
        }
    }
}
