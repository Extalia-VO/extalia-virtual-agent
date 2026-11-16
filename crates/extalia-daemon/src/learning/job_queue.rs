//! A deferred intent is the first state of the same durable curator job. It owns
//! sanitized evidence, but no reader, provider effect, vault pin or live handle.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Queued {
    capture_sha256: String,
    delay_seconds: u64,
}

impl Job {
    fn capture_sha256(&self) -> String {
        hash(
            json!([
                "learning-queue-capture-v1",
                self.binding(),
                self.evidence,
                self.messages
            ])
            .to_string(),
        )
    }

    pub(in crate::learning) fn enqueue(input: &Value, daemon_profile: &str) -> Result<Self> {
        if !digest(s(input, "routeFingerprint")) {
            return Err(refuse("invalid_route_fingerprint"));
        }
        let mut prepared = input.clone();
        prepared["tools"] = json!([]);
        let mut job = Self::initialize(&prepared, true)?;
        // Source identity, rather than current routing, deduplicates a retry.
        // Changed evidence, policy or model for this source must never fork a job.
        job.id = hash(
            json!([
                "learning-queued-job-v1",
                daemon_profile,
                job.provenance["profileId"],
                job.provenance["workspaceId"],
                job.provenance["sessionId"],
                job.provenance["runId"]
            ])
            .to_string(),
        );
        job.queued = Some(Queued {
            capture_sha256: job.capture_sha256(),
            delay_seconds: 60,
        });
        Ok(job)
    }

    pub(in crate::learning) fn same_capture(&self, other: &Self) -> bool {
        self.id == other.id
            && self.binding() == other.binding()
            && self
                .queued
                .as_ref()
                .zip(other.queued.as_ref())
                .is_some_and(|(a, b)| a.capture_sha256 == b.capture_sha256)
    }

    pub(in crate::learning) fn queue_metadata(&self) -> Value {
        self.queued.as_ref().map_or(Value::Null, |queued| json!({
            "revision":self.journal.as_ref().map_or_else(|| "0".repeat(64), |cursor| cursor.revision(&self.id)),
            "delaySeconds":queued.delay_seconds
        }))
    }

    pub(super) fn valid_queue(&self) -> bool {
        let Some(queue) = &self.queued else {
            return self.status != "queued";
        };
        digest(&queue.capture_sha256)
            && matches!(queue.delay_seconds, 60 | 600)
            && (self.status != "queued"
                || self.models == 0
                    && self.reads == 0
                    && self.serial == 0
                    && self.estimated_input == 0
                    && self.pending.is_none()
                    && !self.entered
                    && self.tools.is_empty()
                    && self.calls.is_empty()
                    && self.results.is_empty()
                    && self.read_results.is_empty()
                    && self.candidate_reads.is_empty()
                    && self.knowledge_reads.is_empty()
                    && self.knowledge_revalidated
                    && self.memory_context.is_empty()
                    && self.messages.len() == 1
                    && self.messages[0]["role"] == "user"
                    && self.submission.is_none()
                    && !self.evidence.is_empty()
                    && self.policy["enabled"] == true
                    && (self.policy["notes"] == true || self.policy["skills"] == true)
                    && self.submission_repairs == 0
                    && !self.finalizing
                    && !self.recovered
                    && !self.skill_review_required
                    && self.usage == json!({})
                    && self.usage_unknown.is_empty()
                    && queue.capture_sha256 == self.capture_sha256())
    }

    pub(in crate::learning) fn queue_action(&mut self, action: &str, input: &Value) -> Result<()> {
        self.check_binding(input)?;
        if self.status != "queued" || self.queued.is_none() {
            return Err(refuse("learning_queue_already_admitted"));
        }
        if self.queue_metadata()["revision"] != input["queueRevision"] {
            return Err(refuse("learning_queue_changed"));
        }
        match action {
            "queue.delay" => {
                let delay = input["delaySeconds"]
                    .as_u64()
                    .filter(|d| matches!(d, 60 | 600))
                    .ok_or(refuse("invalid_queue_delay"))?;
                self.queued.as_mut().unwrap().delay_seconds = delay;
            }
            "queue.cancel" => {
                self.status = "cancelled".into();
                self.reason =
                    Some("Deferred learning was cancelled before any effect was admitted.".into());
            }
            "queue.admit" => {
                self.tools = Self::read_tools(&input["tools"])?;
                if let Some(memory) = input.get("memoryContext") {
                    let memory = memory.as_str().ok_or(refuse("invalid_memory_context"))?;
                    if memory.encode_utf16().count() > 6000 {
                        return Err(refuse("invalid_memory_context"));
                    }
                    self.memory_context = text::clean(memory, 6000);
                }
                let timeout = input["timeoutMs"]
                    .as_u64()
                    .unwrap_or(90000)
                    .clamp(1, 120000);
                self.created = Instant::now();
                self.deadline = Instant::now() + Duration::from_millis(timeout);
                self.status = "running".into();
                self.next_model();
            }
            _ => return Err((ErrorCode::InvalidRequest, None)),
        }
        Ok(())
    }
}
