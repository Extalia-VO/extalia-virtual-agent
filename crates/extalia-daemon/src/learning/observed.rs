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
                let jobs: Vec<_> = self
                    .jobs
                    .values()
                    .filter(|job| job.uses_observed_scope(&input["scope"]))
                    .map(|job| job.id.clone())
                    .collect();
                let mut first_error = None;
                for job_id in jobs {
                    if let Err(error) = self.job_action("job.cancel", &json!({"jobId":job_id})) {
                        first_error.get_or_insert(error);
                    }
                }
                // Source deletion happens first. Even if a local journal error
                // follows, its episode cannot become accessible or admitted again.
                // A durable tombstone also prevents recapturing identical source
                // text from reviving a previously withdrawn deferred intent.
                if let Err(error) = self.cancel_queued_observed_scope(&input["scope"]) {
                    first_error.get_or_insert(error);
                }
                if let Some(error) = first_error {
                    return Err(error);
                }
                Ok(result)
            }
            "observed.jobBegin" | "observed.queueCapture" => {
                if action == "observed.jobBegin" && self.jobs.len() >= MAX_HANDLES {
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
                if action == "observed.queueCapture" {
                    return self.capture_prepared_queue(&prepared);
                }
                let mut job = Job::begin(&prepared)?;
                self.checkpoint_job(&mut job, false)?;
                let view = job.view();
                self.jobs.insert(job.id.clone(), job);
                Ok(json!({"job":view}))
            }
            _ => Err((ErrorCode::InvalidRequest, None)),
        }
    }
}
