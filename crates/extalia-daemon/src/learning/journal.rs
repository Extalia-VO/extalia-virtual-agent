//! Bounded, profile-owned curator journal. Every exposed effect is checkpointed;
//! an exclusive entered checkpoint precedes external work. The highest generation
//! is authoritative even if incomplete: falling back could replay a paid effect.
use super::*;
use files::platform;
use serde::{Deserialize, Serialize};
use std::fs::File;

const MAX_JOBS: usize = 64;
const MAX_CHECKPOINT_BYTES: usize = 1024 * 1024;
const RETENTION_MS: u64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Clone, Debug)]
pub(super) struct Cursor {
    generation: u64,
    owner: String,
    created: u64,
    updated: u64,
    expires: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Checkpoint {
    schema: String,
    daemon_profile: String,
    profile: String,
    job_id: String,
    generation: u64,
    owner: String,
    created_at: u64,
    updated_at: u64,
    expires_at: u64,
    state_sha256: String,
    state: Value,
}

pub(super) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min((1_u128 << 53) - 1) as u64
}

#[cfg(unix)]
fn names(parent: &File, limit: usize) -> Result<Vec<String>> {
    let mut out = Vec::new();
    let mut dir = rustix::fs::Dir::read_from(parent).map_err(io_fail)?;
    for entry in &mut dir {
        let entry = entry.map_err(io_fail)?;
        let name = entry
            .file_name()
            .to_str()
            .map_err(|_| refuse("learning_checkpoint_invalid"))?;
        if matches!(name, "." | "..") {
            continue;
        }
        if out.len() >= limit {
            return Err((
                ErrorCode::CapacityExceeded,
                Some("learning_journal_capacity"),
            ));
        }
        out.push(name.into());
    }
    out.sort();
    Ok(out)
}

#[cfg(not(unix))]
fn names(_: &File, _: usize) -> Result<Vec<String>> {
    Err(refuse("platform_unavailable"))
}

fn generation(name: &str) -> Result<u64> {
    let digits = name
        .strip_suffix(".json")
        .ok_or(refuse("learning_checkpoint_invalid"))?;
    if digits.len() != 8 || !digits.bytes().all(|v| v.is_ascii_digit()) {
        return Err(refuse("learning_checkpoint_invalid"));
    }
    digits
        .parse()
        .ok()
        .filter(|n| *n > 0)
        .ok_or(refuse("learning_checkpoint_invalid"))
}

fn privacy_safe(value: &Value, depth: usize) -> bool {
    if depth > 32 {
        return false;
    }
    match value {
        Value::String(text) => extalia_core::knowledge::import::mask_credentials(text).1 == 0,
        Value::Array(values) => {
            values.len() <= 512 && values.iter().all(|v| privacy_safe(v, depth + 1))
        }
        Value::Object(values) => {
            values.len() <= 256
                && values.iter().all(|(k, v)| {
                    ![
                        "token",
                        "secret",
                        "password",
                        "credential",
                        "credentials",
                        "apikey",
                        "api_key",
                        "authorization",
                        "cookie",
                        "access_token",
                        "refresh_token",
                    ]
                    .contains(&k.to_ascii_lowercase().as_str())
                        && privacy_safe(&Value::String(k.clone()), depth + 1)
                        && privacy_safe(v, depth + 1)
                })
        }
        _ => true,
    }
}

struct Store {
    root: File,
    daemon: File,
    profile: File,
    daemon_name: String,
    profile_name: String,
}

impl Store {
    fn verify(&self, owner: &Learning) -> Result<()> {
        let data = owner.data_handle()?;
        if !platform::same(&self.root, &platform::child(&data, "learning-jobs", false)?)
            || !platform::same(
                &self.daemon,
                &platform::child(&self.root, &self.daemon_name, false)?,
            )
            || !platform::same(
                &self.profile,
                &platform::child(&self.daemon, &self.profile_name, false)?,
            )
        {
            return Err(refuse("learning_journal_changed"));
        }
        Ok(())
    }

    fn load(&self, owner: &Learning, job_id: &str) -> Result<Job> {
        if !digest(job_id) {
            return Err(refuse("invalid_identity"));
        }
        let folder = platform::child(&self.profile, job_id, false)?;
        let files = names(&folder, 128)?;
        let mut latest = 0;
        for name in &files {
            latest = latest.max(generation(name)?);
        }
        if latest == 0 {
            return Err(refuse("learning_checkpoint_incomplete"));
        }
        let bytes = platform::read(&folder, &format!("{latest:08}.json"), MAX_CHECKPOINT_BYTES)?
            .ok_or(refuse("learning_checkpoint_incomplete"))?;
        let checkpoint: Checkpoint =
            serde_json::from_slice(&bytes).map_err(|_| refuse("learning_checkpoint_invalid"))?;
        let now = now_ms();
        if checkpoint.schema != "extalia.learning-checkpoint.v1"
            || checkpoint.daemon_profile != self.daemon_name
            || checkpoint.profile != self.profile_name
            || checkpoint.job_id != job_id
            || checkpoint.generation != latest
            || !digest(&checkpoint.owner)
            || checkpoint.created_at == 0
            || checkpoint.updated_at < checkpoint.created_at
            || checkpoint.updated_at > now.saturating_add(60_000)
            || checkpoint.expires_at != checkpoint.created_at.saturating_add(RETENTION_MS)
            || checkpoint.state_sha256 != hash(checkpoint.state.to_string())
            || !privacy_safe(&checkpoint.state, 0)
        {
            return Err(refuse("learning_checkpoint_invalid"));
        }
        let mut job = Job::restore(checkpoint.state)?;
        if job.id != job_id || hash(s(&job.binding(), "profileId")) != self.profile_name {
            return Err(refuse("learning_checkpoint_scope_mismatch"));
        }
        job.journal = Some(Cursor {
            generation: latest,
            owner: checkpoint.owner,
            created: checkpoint.created_at,
            updated: checkpoint.updated_at,
            expires: checkpoint.expires_at,
        });
        self.verify(owner)?;
        if !platform::same(&folder, &platform::child(&self.profile, job_id, false)?) {
            return Err(refuse("learning_journal_changed"));
        }
        Ok(job)
    }

    fn prune(&self, owner: &Learning) -> Result<()> {
        let ids = names(&self.profile, MAX_JOBS)?;
        let full = ids.len() >= MAX_JOBS;
        for job_id in ids {
            if !digest(&job_id) {
                return Err(refuse("learning_checkpoint_invalid"));
            }
            if owner.jobs.contains_key(&job_id) {
                continue;
            }
            let Ok(job) = self.load(owner, &job_id) else {
                continue;
            };
            let cursor = job
                .journal
                .as_ref()
                .ok_or(refuse("learning_checkpoint_invalid"))?;
            let record = job.recovery_record(cursor.updated, cursor.expires, false);
            if cursor.expires > now_ms() && (!full || record["state"] != "terminal") {
                continue;
            }
            let folder = platform::child(&self.profile, &job_id, false)?;
            for name in names(&folder, 128)? {
                generation(&name)?;
                platform::remove(&folder, &name, false);
            }
            platform::remove(&self.profile, &job_id, true);
        }
        self.verify(owner)
    }
}

impl Learning {
    fn journal_store(&self, profile_id: &str, create: bool) -> Result<Option<Store>> {
        if !id(profile_id) {
            return Err(refuse("invalid_identity"));
        }
        let data = self.data_handle()?;
        let daemon_name = hash(&self.profile);
        let profile_name = hash(profile_id);
        let optional = |parent: &File, name: &str| -> Result<Option<File>> {
            if create {
                platform::child(parent, name, true).map(Some)
            } else {
                platform::optional_child(parent, name)
            }
        };
        let Some(root) = optional(&data, "learning-jobs")? else {
            return Ok(None);
        };
        let Some(daemon) = optional(&root, &daemon_name)? else {
            return Ok(None);
        };
        let Some(profile) = optional(&daemon, &profile_name)? else {
            return Ok(None);
        };
        let store = Store {
            root,
            daemon,
            profile,
            daemon_name,
            profile_name,
        };
        store.verify(self)?;
        Ok(Some(store))
    }

    pub(super) fn checkpoint_job(&self, job: &mut Job, claim: bool) -> Result<()> {
        if !job.durable() {
            return Ok(());
        }
        let state = job.snapshot()?;
        // Do not rewrite opaque native proofs after masking. If a provider/read
        // supplied credentials, retain the preceding entered checkpoint instead.
        if !privacy_safe(&state, 0) {
            return Err(refuse("learning_checkpoint_sensitive_content"));
        }
        if state.to_string().len() > MAX_CHECKPOINT_BYTES - 2048 {
            return Err(refuse("learning_checkpoint_too_large"));
        }
        let binding = job.binding();
        let store = self
            .journal_store(s(&binding, "profileId"), true)?
            .ok_or(refuse("learning_journal_unavailable"))?;
        let now = now_ms();
        let (folder, cursor) = if let Some(cursor) = job.journal.clone() {
            let current = store.load(self, &job.id)?;
            let saved = current
                .journal
                .as_ref()
                .ok_or(refuse("learning_checkpoint_invalid"))?;
            if saved.generation != cursor.generation || saved.owner != cursor.owner {
                return Err(refuse("learning_checkpoint_superseded"));
            }
            if cursor.expires <= now {
                return Err(refuse("learning_checkpoint_expired"));
            }
            (platform::child(&store.profile, &job.id, false)?, cursor)
        } else {
            store.prune(self)?;
            if names(&store.profile, MAX_JOBS)?.len() >= MAX_JOBS {
                return Err((
                    ErrorCode::CapacityExceeded,
                    Some("learning_journal_capacity"),
                ));
            }
            (
                platform::new_child(&store.profile, &job.id)?,
                Cursor {
                    generation: 0,
                    owner: uid(),
                    created: now,
                    updated: now,
                    expires: now + RETENTION_MS,
                },
            )
        };
        let next = cursor
            .generation
            .checked_add(1)
            .filter(|v| *v <= 99_999_999)
            .ok_or(refuse("learning_checkpoint_limit"))?;
        let next_owner = if claim { uid() } else { cursor.owner.clone() };
        let updated = now.max(cursor.updated);
        let checkpoint = Checkpoint {
            schema: "extalia.learning-checkpoint.v1".into(),
            daemon_profile: store.daemon_name.clone(),
            profile: store.profile_name.clone(),
            job_id: job.id.clone(),
            generation: next,
            owner: next_owner.clone(),
            created_at: cursor.created,
            updated_at: updated,
            expires_at: cursor.expires,
            state_sha256: hash(state.to_string()),
            state,
        };
        let bytes = serde_json::to_vec(&checkpoint).map_err(io_fail)?;
        if bytes.len() > MAX_CHECKPOINT_BYTES {
            return Err(refuse("learning_checkpoint_too_large"));
        }
        let name = format!("{next:08}.json");
        // Exclusive create is a durable compare-and-swap. A crash during writing
        // leaves an incomplete highest generation which must never fall back.
        platform::create(&folder, &name, &bytes)?
            .ok_or(refuse("learning_checkpoint_superseded"))?;
        store.verify(self)?;
        if !platform::same(&folder, &platform::child(&store.profile, &job.id, false)?)
            || platform::read(&folder, &name, MAX_CHECKPOINT_BYTES)?.as_deref()
                != Some(bytes.as_slice())
        {
            return Err(refuse("learning_journal_changed"));
        }
        // Keep the previous generation for diagnostics, never as a recovery fallback.
        for old in names(&folder, 128)? {
            if generation(&old)? + 1 < next {
                platform::remove(&folder, &old, false);
            }
        }
        job.journal = Some(Cursor {
            generation: next,
            owner: next_owner,
            created: cursor.created,
            updated,
            expires: cursor.expires,
        });
        Ok(())
    }

    pub(super) fn job_action(&mut self, action: &str, input: &Value) -> Result<Value> {
        let job_id = s(input, "jobId");
        let original = self.jobs.remove(job_id).ok_or(refuse("invalid_handle"))?;
        let mut next = original.clone();
        if let Err(error) = next.action(action, input) {
            self.jobs.insert(original.id.clone(), original);
            return Err(error);
        }
        // A failed checkpoint revokes this live handle. The caller must inspect
        // the durable record; continuing in memory could skip an entered marker.
        self.checkpoint_job(&mut next, false)?;
        let view = next.view();
        self.jobs.insert(next.id.clone(), next);
        Ok(json!({"job":view}))
    }

    pub(super) fn list_jobs(&self, input: &Value) -> Result<Value> {
        let Some(store) = self.journal_store(s(input, "profileId"), false)? else {
            return Ok(json!({"jobs":[],"omitted":0}));
        };
        let mut records = Vec::new();
        let mut omitted = 0;
        for job_id in names(&store.profile, MAX_JOBS)? {
            let Ok(job) = store.load(self, &job_id) else {
                omitted += 1;
                continue;
            };
            let binding = job.binding();
            if ["workspaceId", "sessionId"]
                .iter()
                .any(|key| input.get(key).is_some_and(|v| *v != binding[*key]))
            {
                continue;
            }
            let cursor = job
                .journal
                .as_ref()
                .ok_or(refuse("learning_checkpoint_invalid"))?;
            records.push(job.recovery_record(
                cursor.updated,
                cursor.expires,
                self.jobs.contains_key(&job.id),
            ));
        }
        let priority = |record: &Value| match s(record, "state") {
            "resumable" | "publication" if record["active"] == false => 0,
            "uncertain" => 1,
            "resumable" | "publication" => 2,
            "terminal" => 3,
            _ => 4,
        };
        records.sort_by(|a, b| {
            priority(a)
                .cmp(&priority(b))
                .then_with(|| b["updatedAt"].as_u64().cmp(&a["updatedAt"].as_u64()))
                .then_with(|| s(a, "jobId").cmp(s(b, "jobId")))
        });
        let limit = input["limit"].as_u64().unwrap_or(32).clamp(1, 32) as usize;
        omitted += records.len().saturating_sub(limit);
        records.truncate(limit);
        store.verify(self)?;
        Ok(json!({"jobs":records,"omitted":omitted}))
    }

    pub(super) fn recover_job(&mut self, input: &Value) -> Result<Value> {
        let job_id = s(input, "jobId");
        if self.jobs.contains_key(job_id) {
            return Err(refuse("learning_job_active"));
        }
        if self.jobs.len() >= MAX_HANDLES {
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
        job.recover(input)?;
        if let Some(source) = input.get("observedSource") {
            // Revocation or a different immutable episode invalidates recovery even
            // when the host still holds the old episode descriptor.
            let mut read = source.clone();
            read["offset"] = 0.into();
            read["limit"] = 1.into();
            self.observed_action("observed.read", &read)?;
        }
        self.checkpoint_job(&mut job, true)?;
        let view = job.view();
        self.jobs.insert(job.id.clone(), job);
        Ok(json!({"job":view}))
    }
}
