//! Native Observe storage is separate from Native task evidence and success receipts.
use super::*;
use extalia_core::observed_memory::{ObservedMemoryError, ObservedMemoryStore};
use extalia_core::skills::ProfileId;
fn failure(error: ObservedMemoryError) -> Failure {
    match error {
        ObservedMemoryError::Denied("capacity_reached") => (
            ErrorCode::CapacityExceeded,
            Some("observed_memory_capacity"),
        ),
        ObservedMemoryError::Denied(_) => refuse("observed_memory_unavailable"),
        ObservedMemoryError::Storage => {
            (ErrorCode::StorageFailure, Some("observed_memory_storage"))
        }
    }
}
impl Learning {
    fn observed_store(&mut self, input: &Value) -> Result<&mut ObservedMemoryStore> {
        self.data_handle()?;
        let profile =
            ProfileId::parse(s(&input["scope"], "profileId")).ok_or(refuse("invalid_profile"))?;
        if !self.observed.contains_key(profile.as_str()) {
            // Read operations own no opaque store handles; idle stores may be reopened.
            if self.observed.len() >= 8
                && let Some(key) = self.observed.keys().min().cloned()
            {
                self.observed.remove(&key);
            }
            let store = ObservedMemoryStore::open(&self.data, &profile).map_err(failure)?;
            self.observed.insert(profile.as_str().into(), store);
        }
        self.observed
            .get_mut(profile.as_str())
            .ok_or(refuse("observed_memory_unavailable"))
    }
    pub(super) fn observed_action(&mut self, action: &str, input: &Value) -> Result<Value> {
        match action {
            "observed.capture" => self.observed_store(input)?.capture(input).map_err(failure),
            "observed.search" => self.observed_store(input)?.search(input).map_err(failure),
            "observed.read" => self.observed_store(input)?.read(input).map_err(failure),
            "observed.revoke" => {
                let result = self
                    .observed_store(input)?
                    .revoke(&input["scope"])
                    .map_err(failure)?;
                for job in self
                    .jobs
                    .values_mut()
                    .filter(|job| job.uses_observed_scope(&input["scope"]))
                {
                    job.action("job.cancel", &json!({}))?;
                }
                Ok(result)
            }
            "observed.jobBegin" => {
                if self.jobs.len() >= MAX_HANDLES {
                    return Err((ErrorCode::CapacityExceeded, Some("learning_capacity")));
                }
                let mut read = input.clone();
                read["offset"] = 0.into();
                read["limit"] = 32.into();
                let episode = self.observed_store(input)?.read(&read).map_err(failure)?;
                let mut prepared = input.clone();
                for key in ["profileId", "workspaceId", "sessionId"] {
                    prepared[key] = input["scope"][key].clone();
                }
                prepared["observedSource"] = episode;
                let job = Job::begin(&prepared)?;
                let view = job.view();
                self.jobs.insert(job.id.clone(), job);
                Ok(json!({"job":view}))
            }
            _ => Err((ErrorCode::InvalidRequest, None)),
        }
    }
}
