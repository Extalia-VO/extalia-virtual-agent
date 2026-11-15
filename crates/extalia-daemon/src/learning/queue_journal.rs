//! Queue capture and admission share one journal identity and one CAS history.
//! No provider effect can be exposed by a capture, delay or cancellation action.
use super::*;

impl Learning {
    pub(in crate::learning) fn cancel_queued_observed_scope(
        &mut self,
        scope: &Value,
    ) -> Result<()> {
        let Some(store) = self.journal_store(s(scope, "profileId"), false)? else {
            return Ok(());
        };
        let mut first_error = None;
        for job_id in names(&store.profile, MAX_JOBS)? {
            // A damaged checkpoint already refuses admission. Continue cancelling
            // healthy records rather than allowing one corrupt file to block them.
            let Ok(job) = store.load(self, &job_id) else {
                continue;
            };
            if job.status != "queued"
                || !job.uses_observed_scope(scope)
                || job
                    .journal
                    .as_ref()
                    .is_none_or(|cursor| cursor.expires <= now_ms())
            {
                continue;
            }
            let mut control = job.binding();
            control["jobId"] = job.id.clone().into();
            control["queueRevision"] = job.queue_metadata()["revision"].clone();
            if let Err(error) = self.queue_action("queue.cancel", &control) {
                first_error.get_or_insert(error);
            }
        }
        store.verify(self)?;
        first_error.map_or(Ok(()), Err)
    }

    pub(in crate::learning) fn capture_queue(&mut self, input: &Value) -> Result<Value> {
        self.data_handle()?;
        let mut prepared = input.clone();
        if input.get("intakeId").is_some() {
            let intake = self
                .intakes
                .remove(s(input, "intakeId"))
                .ok_or(refuse("invalid_handle"))?;
            prepared["evidence"] = intake.finish()?;
        }
        self.capture_prepared_queue(&prepared)
    }

    pub(in crate::learning) fn capture_prepared_queue(
        &mut self,
        prepared: &Value,
    ) -> Result<Value> {
        let mut job = Job::enqueue(prepared, &self.profile)?;
        let binding = job.binding();
        let store = self
            .journal_store(s(&binding, "profileId"), true)?
            .ok_or(refuse("learning_journal_unavailable"))?;
        let existing = if platform::optional_child(&store.profile, &job.id)?.is_some() {
            Some(store.load(self, &job.id)?)
        } else {
            None
        };
        if let Some(existing) = existing {
            if !job.same_capture(&existing) {
                return Err(refuse("learning_queue_source_changed"));
            }
            let cursor = existing
                .journal
                .as_ref()
                .ok_or(refuse("learning_checkpoint_invalid"))?;
            return Ok(
                json!({"record":existing.recovery_record(cursor.updated, cursor.expires,
                self.jobs.contains_key(&existing.id)),"created":false}),
            );
        }
        self.checkpoint_job(&mut job, false)?;
        let cursor = job
            .journal
            .as_ref()
            .ok_or(refuse("learning_checkpoint_invalid"))?;
        Ok(
            json!({"record":job.recovery_record(cursor.updated, cursor.expires, false),"created":true}),
        )
    }

    pub(in crate::learning) fn queue_action(
        &mut self,
        action: &str,
        input: &Value,
    ) -> Result<Value> {
        let job_id = s(input, "jobId");
        if self.jobs.contains_key(job_id) {
            return Err(refuse("learning_job_active"));
        }
        if action == "queue.admit" && self.jobs.len() >= MAX_HANDLES {
            return Err((ErrorCode::CapacityExceeded, Some("learning_capacity")));
        }
        let store = self
            .journal_store(s(input, "profileId"), false)?
            .ok_or(refuse("learning_checkpoint_missing"))?;
        let mut job = store.load(self, job_id)?;
        if job
            .journal
            .as_ref()
            .is_none_or(|cursor| cursor.expires <= now_ms())
        {
            return Err(refuse("learning_checkpoint_expired"));
        }
        job.queue_action(action, input)?;
        if action == "queue.admit" {
            if let Some(source) = input.get("observedSource") {
                // An old queued descriptor cannot revive revoked Observe evidence.
                let mut read = source.clone();
                read["offset"] = 0.into();
                read["limit"] = 1.into();
                self.observed_action("observed.read", &read)?;
            }
            // The same identity changes state before its first effect is exposed.
            // A lost acknowledgement leaves an ordinary unentered checkpoint;
            // retrying queue.admit cannot create or repeat another model request.
            self.checkpoint_job(&mut job, true)?;
            let view = job.view();
            self.jobs.insert(job.id.clone(), job);
            Ok(json!({"job":view}))
        } else {
            self.checkpoint_job(&mut job, false)?;
            let cursor = job
                .journal
                .as_ref()
                .ok_or(refuse("learning_checkpoint_invalid"))?;
            Ok(json!({"record":job.recovery_record(cursor.updated, cursor.expires, false)}))
        }
    }
}
