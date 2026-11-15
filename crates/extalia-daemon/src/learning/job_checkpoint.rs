//! Serializable curator checkpoints. No live pin, publication draft or permission
//! is restored from disk; admission and source-read validation happen again.
use super::*;

pub(super) fn status<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<String, D::Error> {
    match String::deserialize(d)?.as_str() {
        "running" => Ok("running".into()),
        "ready" => Ok("ready".into()),
        "skipped" => Ok("skipped".into()),
        "failed" => Ok("failed".into()),
        "cancelled" => Ok("cancelled".into()),
        "completed" => Ok("completed".into()),
        _ => Err(serde::de::Error::custom(
            "invalid learning checkpoint state",
        )),
    }
}

impl Job {
    pub(in crate::learning) fn durable(&self) -> bool {
        self.route_fingerprint.is_some()
    }

    pub(in crate::learning) fn retain_live_handle(&self) -> bool {
        self.created.elapsed() < RETAIN
            || self.pending.is_some() && (!self.durable() || self.entered)
    }

    pub(in crate::learning) fn binding(&self) -> Value {
        let mut out = self.provenance.clone();
        out["destinationRevision"] = self.destination_revision.clone().into();
        out["routeFingerprint"] = self.route_fingerprint.clone().unwrap_or_default().into();
        out["policy"] = self.policy.clone();
        if let Some(source) = &self.observed_source {
            out["observedSource"] = source.clone();
        }
        out
    }

    pub(in crate::learning) fn recovery_record(
        &self,
        updated: u64,
        expires: u64,
        active: bool,
    ) -> Value {
        let mut out = self.binding();
        out["jobId"] = self.id.clone().into();
        out["active"] = active.into();
        out["updatedAt"] = updated.into();
        out["expiresAt"] = expires.into();
        out["modelRequests"] = self.models.into();
        out["reads"] = self.reads.into();
        out["skillReviewRequired"] = self.refinement().into();
        let (state, reason) = if expires <= super::super::journal::now_ms() {
            (
                "expired",
                Some("The retained learning checkpoint has expired."),
            )
        } else if self.entered {
            (
                "uncertain",
                Some(
                    "An effect was admitted without a durable result. Recovery cannot repeat it or infer that it settled.",
                ),
            )
        } else if self.status == "ready" {
            (
                "publication",
                Some(
                    "Retained findings need fresh destination authorization, source reads and independent artifact receipt checks.",
                ),
            )
        } else if self.status == "running" {
            ("resumable", None)
        } else {
            ("terminal", self.reason.as_deref())
        };
        out["state"] = state.into();
        if let Some(reason) = reason {
            out["reason"] = text::clean(reason, 500).into();
        }
        let view = self.view();
        for key in ["noteSha256", "skillSha256"] {
            if let Some(value) = view.get(key) {
                out[key] = value.clone();
            }
        }
        out
    }

    fn refinement(&self) -> bool {
        self.submission
            .as_ref()
            .is_some_and(|value| value["skill"].get("baseRevisionId").is_some())
    }

    pub(in crate::learning) fn snapshot(&self) -> Result<Value> {
        let mut copy = self.clone();
        // Once inference has ended, its provider-native history and optional read
        // cache are unnecessary. Keep the normalized evidence and submitted work.
        if self.status != "running" {
            copy.messages.clear();
            copy.calls.clear();
            copy.results.clear();
            copy.read_results.clear();
            copy.memory_context.clear();
            copy.candidate_reads.clear();
            copy.knowledge = knowledge_grounding::Reads::default();
        }
        serde_json::to_value(copy).map_err(io_fail)
    }

    pub(in crate::learning) fn restore(value: Value) -> Result<Self> {
        let job: Self =
            serde_json::from_value(value).map_err(|_| refuse("learning_checkpoint_invalid"))?;
        let binding = job.binding();
        let view = json!({"action":"job.begin","job":job.view()});
        let record =
            json!({"action":"job.list","jobs":[job.recovery_record(1, 2, false)],"omitted":0});
        if !job.durable()
            || !digest(&job.id)
            || !digest(s(&binding, "routeFingerprint"))
            || ids(
                &job.provenance,
                &["profileId", "workspaceId", "sessionId", "runId"],
            )
            .is_err()
            || text::provenance(&job.provenance).is_err()
            || !crate::wire::learning::valid_result(&view)
            || !crate::wire::learning::valid_result(&record)
            || job.models > MAX_MODEL_STEPS
            || job.reads > MAX_READS
            || job.estimated_input > MAX_TOTAL_ESTIMATE
            || job.submission_repairs > 2
            || job.serial > (MAX_MODEL_STEPS + MAX_READS) as u64
            || job.tools.len() > 16
            || job.messages.len() > 32
            || job.calls.len() > 16
            || job.results.len() > 16
            || job.read_results.len() > MAX_READS
            || job.candidate_reads.len() > MAX_READS
            || job.entered && job.pending.is_none()
            || job.status == "running" && (job.pending.is_none() || job.messages.is_empty())
            || matches!(job.status.as_str(), "ready" | "completed")
                && (job.pending.is_some() || job.submission.is_none())
            || job.observed != job.observed_source.is_some()
            || job.observed_scope.as_ref()
                != job.observed_source.as_ref().map(|source| &source["scope"])
            || job.observed_source.as_ref().is_some_and(|source| {
                ["profileId", "workspaceId", "sessionId"]
                    .iter()
                    .any(|key| source["scope"][*key] != job.provenance[*key])
            })
            || job
                .pending
                .as_ref()
                .is_some_and(|effect| s(effect, "effectId") != format!("{}-{}", job.id, job.serial))
        {
            return Err(refuse("learning_checkpoint_invalid"));
        }
        Ok(job)
    }

    pub(in crate::learning) fn recover(&mut self, input: &Value) -> Result<()> {
        let binding = self.binding();
        for key in [
            "profileId",
            "workspaceId",
            "sessionId",
            "runId",
            "promptSha256",
            "destinationRevision",
            "policy",
            "observedSource",
        ] {
            if binding.get(key) != input.get(key) {
                return Err(refuse("learning_recovery_scope_changed"));
            }
        }
        if binding["routeFingerprint"] != input["routeFingerprint"] {
            return Err(refuse("learning_recovery_route_changed"));
        }
        if input["tools"] != json!(self.tools) {
            return Err(refuse("learning_recovery_tools_changed"));
        }
        if self.entered {
            return Err(refuse("learning_recovery_effect_uncertain"));
        }
        if !matches!(self.status.as_str(), "running" | "ready") {
            return Err(refuse("learning_recovery_terminal"));
        }
        self.recovered = true;
        self.skill_review_required = self.refinement();
        self.created = Instant::now();
        self.deadline = Instant::now()
            + if self.status == "ready" {
                PUBLICATION_LEASE
            } else {
                Duration::from_secs(120)
            };
        // Disk state is not a live source-read or in-process skill review lease.
        self.knowledge_revalidated = self.knowledge_reads.is_empty();
        self.candidate_reads.clear();
        for message in &self.messages {
            for call in message["toolCalls"].as_array().into_iter().flatten() {
                if matches!(
                    s(call, "name"),
                    "skill_candidate_list" | "skill_candidate_read"
                ) {
                    self.read_results.remove(&read_key(call));
                }
            }
        }
        Ok(())
    }
}
