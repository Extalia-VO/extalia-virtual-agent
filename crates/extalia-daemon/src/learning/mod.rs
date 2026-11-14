//! Local learning owner. No model credentials, secondary store, provider transport,
//! runtime launch or skill activation lives here. Jobs emit narrowly typed effects.
mod files;
mod intake;
mod jobs;
mod observed;
#[cfg(all(test, unix))]
mod observed_tests;
#[cfg(all(test, unix))]
mod tests;
mod text;
use crate::wire::{ErrorCode, Op, ResponseResult};
use files::{Draft, Pin, Stage};
use jobs::Job;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
pub const CAPABILITIES: [Op; 1] = [Op::LearningProcess];
const RETAIN: Duration = Duration::from_secs(600);
const MAX_HANDLES: usize = 32;
type Failure = (ErrorCode, Option<&'static str>);
type Result<T> = std::result::Result<T, Failure>;
fn refuse(reason: &'static str) -> Failure {
    (ErrorCode::Denied, Some(reason))
}
fn io_fail(_: impl std::fmt::Debug) -> Failure {
    (ErrorCode::StorageFailure, Some("io_failure"))
}
fn hash(bytes: impl AsRef<[u8]>) -> String {
    Sha256::digest(bytes.as_ref())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn uid() -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    hash(format!(
        "{}:{}:{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ))
}
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
fn id(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 200
        && v.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn digest(v: &str) -> bool {
    v.len() == 64
        && v.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn ids(v: &Value, keys: &[&str]) -> Result<()> {
    if keys.iter().all(|k| id(s(v, k))) {
        Ok(())
    } else {
        Err(refuse("invalid_identity"))
    }
}
#[derive(Debug)]
pub struct Learning {
    data: PathBuf,
    data_identity: Option<(std::fs::File, PathBuf)>,
    profile: String,
    pins: HashMap<String, Pin>,
    drafts: HashMap<String, Draft>,
    stages: HashMap<String, Stage>,
    jobs: HashMap<String, Job>,
    intakes: HashMap<String, intake::Intake>,
    observed: HashMap<String, extalia_core::observed_memory::ObservedMemoryStore>,
    #[cfg(test)]
    hold: Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>,
}
impl Learning {
    pub fn new(data: &Path, profile: &str) -> Self {
        Self {
            data: data.into(),
            data_identity: extalia_core::skills::ProfileId::parse(profile)
                .and_then(|_| files::pin_data(data)),
            profile: profile.into(),
            pins: HashMap::new(),
            drafts: HashMap::new(),
            stages: HashMap::new(),
            jobs: HashMap::new(),
            intakes: HashMap::new(),
            observed: HashMap::new(),
            #[cfg(test)]
            hold: None,
        }
    }
    pub fn handle(&mut self, params: &Value) -> Result<ResponseResult> {
        if !crate::wire::learning::valid_params(params) {
            return Err((ErrorCode::InvalidRequest, None));
        }
        #[cfg(test)]
        if let Some((entered, release)) = self.hold.take() {
            let _ = entered.send(());
            let _ = release.recv();
        }
        self.expire();
        let action = s(params, "action");
        let input = &params["input"];
        let mut result = match action {
            action if action.starts_with("observed.") => self.observed_action(action, input)?,
            "evidence.begin" => {
                if self.intakes.len() >= 4 {
                    return Err((ErrorCode::CapacityExceeded, Some("learning_capacity")));
                }
                let intake_id = uid();
                self.intakes
                    .insert(intake_id.clone(), intake::Intake::new());
                json!({"intakeId":intake_id})
            }
            "evidence.append" => {
                let intake = self
                    .intakes
                    .get_mut(s(input, "intakeId"))
                    .ok_or(refuse("invalid_handle"))?;
                json!({"complete":intake.append(input)?})
            }
            "evidence.release" => {
                self.intakes
                    .remove(s(input, "intakeId"))
                    .ok_or(refuse("invalid_handle"))?;
                json!({"released":true})
            }
            "vault.ensure" => self.ensure_vault(input)?,
            "note.pin" => self.pin(input)?,
            "note.prepare" => self.prepare(input)?,
            "note.commit" => self.commit(input)?,
            "note.discard" => {
                self.drafts
                    .remove(s(input, "draftId"))
                    .ok_or(refuse("invalid_handle"))?;
                json!({"released":true})
            }
            "note.release" => {
                let pin_id = s(input, "pinId");
                self.pins.remove(pin_id).ok_or(refuse("invalid_handle"))?;
                self.drafts.retain(|_, d| d.pin_id != pin_id);
                json!({"released":true})
            }
            "skill.normalize" => {
                let proposal = text::proposal(&input["proposal"])?;
                let mut out = json!({"proposal":proposal});
                if input.get("provenance").is_some() {
                    out["provenance"] = text::provenance(&input["provenance"])?;
                }
                out
            }
            "skill.stage" => self.stage(input)?,
            "skill.stageFolder" => self.stage_folder(input)?,
            "skill.cleanup" => {
                self.stages
                    .remove(s(input, "stageId"))
                    .ok_or(refuse("invalid_handle"))?;
                json!({"released":true})
            }
            "receipt.claim" => json!({"claimed":self.claim(input)?}),
            "job.begin" => {
                self.data_handle()?;
                if self.jobs.len() >= MAX_HANDLES {
                    return Err((ErrorCode::CapacityExceeded, Some("learning_capacity")));
                }
                let mut prepared = input.clone();
                if input.get("intakeId").is_some() {
                    let intake = self
                        .intakes
                        .remove(s(input, "intakeId"))
                        .ok_or(refuse("invalid_handle"))?;
                    prepared["evidence"] = intake.finish()?;
                }
                let job = Job::begin(&prepared)?;
                let out = job.view();
                self.jobs.insert(job.id.clone(), job);
                json!({"job":out})
            }
            "job.release" => {
                let job = self
                    .jobs
                    .get(s(input, "jobId"))
                    .ok_or(refuse("invalid_handle"))?;
                if job.pending.is_some() || job.status == "running" {
                    return Err(refuse("effect_pending"));
                }
                self.jobs.remove(s(input, "jobId"));
                json!({"released":true})
            }
            _ => {
                let job = self
                    .jobs
                    .get_mut(s(input, "jobId"))
                    .ok_or(refuse("invalid_handle"))?;
                job.action(action, input)?;
                json!({"job":job.view()})
            }
        };
        result["action"] = Value::String(action.into());
        if !crate::wire::learning::valid_result(&result) {
            return Err((ErrorCode::Internal, Some("learning_result_invalid")));
        }
        Ok(ResponseResult::Learning(result))
    }
    fn expire(&mut self) {
        self.intakes
            .retain(|_, i| i.created.elapsed() < Duration::from_secs(120));
        self.pins.retain(|_, p| p.created.elapsed() < RETAIN);
        self.drafts
            .retain(|_, d| d.created.elapsed() < RETAIN && self.pins.contains_key(&d.pin_id));
        self.stages.retain(|_, s| s.created.elapsed() < RETAIN);
        // Outstanding effects remain owned until an explicit actual-drain acknowledgement.
        for job in self.jobs.values_mut() {
            job.expire();
        }
        self.jobs
            .retain(|_, j| j.pending.is_some() || j.created.elapsed() < RETAIN);
    }
}
