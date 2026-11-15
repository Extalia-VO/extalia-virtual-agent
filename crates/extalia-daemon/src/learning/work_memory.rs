//! Profile-local operational memory; source authorization is rechecked by host consumers.
use super::*;
use extalia_core::skills::ProfileId;
use extalia_core::work_memory::{WorkMemoryError, WorkMemoryStore};

fn failure(error: WorkMemoryError) -> Failure {
    match error {
        WorkMemoryError::Denied("capacity_reached") => {
            (ErrorCode::CapacityExceeded, Some("work_memory_capacity"))
        }
        WorkMemoryError::Denied("record_conflict") => refuse("work_memory_conflict"),
        WorkMemoryError::Denied(_) => refuse("work_memory_unavailable"),
        WorkMemoryError::Storage => (ErrorCode::StorageFailure, Some("work_memory_storage")),
    }
}
impl Learning {
    fn work_memory_store(&mut self, input: &Value) -> Result<&mut WorkMemoryStore> {
        self.data_handle()?;
        let profile =
            ProfileId::parse(s(&input["scope"], "profileId")).ok_or(refuse("invalid_profile"))?;
        if !self.work_memory.contains_key(profile.as_str()) {
            if self.work_memory.len() >= 8
                && let Some(key) = self.work_memory.keys().min().cloned()
            {
                self.work_memory.remove(&key);
            }
            let store = WorkMemoryStore::open(&self.data, &profile).map_err(failure)?;
            self.work_memory.insert(profile.as_str().into(), store);
        }
        self.work_memory
            .get_mut(profile.as_str())
            .ok_or(refuse("work_memory_unavailable"))
    }
    pub(super) fn work_memory_action(&mut self, action: &str, input: &Value) -> Result<Value> {
        match action {
            "memory.capture" => self
                .work_memory_store(input)?
                .capture(input)
                .map_err(failure),
            "memory.search" => self
                .work_memory_store(input)?
                .search(input)
                .map_err(failure),
            "memory.read" => self.work_memory_store(input)?.read(input).map_err(failure),
            "memory.revoke" => self
                .work_memory_store(input)?
                .revoke(input)
                .map_err(failure),
            _ => Err((ErrorCode::InvalidRequest, None)),
        }
    }
}
