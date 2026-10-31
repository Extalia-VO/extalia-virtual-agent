//! Non-executable native edit intents, bound to actual admissions. No approval/grant/consume route.
use super::CoreStore;
use super::execution_receipts::load_admission;
use super::mission_snapshot::snapshot_in_transaction;
use super::missions::{live_lease, load_mission, load_task};
use crate::control::native_action::NativeActionRequest;
use crate::mission::{
    ExecutionAdmission, MissionError, MissionState, TaskState, canonical, contract,
};
use crate::time::{format_utc, parse_utc};
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};
use std::fmt;

#[derive(Debug)]
pub enum NativeActionIntentError {
    Invalid,
    NotFound,
    Conflict,
    Inactive,
    Capacity,
    Corrupt,
    Storage(rusqlite::Error),
}
impl fmt::Display for NativeActionIntentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Invalid => "invalid native action intent",
            Self::NotFound => "native action not found in this profile",
            Self::Conflict => "native action identity or version differs",
            Self::Inactive => "native action admission or validity window is inactive",
            Self::Capacity => "native action request limit reached",
            Self::Corrupt => "native action history invariants failed",
            Self::Storage(_) => "native action storage failed",
        })
    }
}
impl std::error::Error for NativeActionIntentError {}
impl From<rusqlite::Error> for NativeActionIntentError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Storage(e)
    }
}
impl From<MissionError> for NativeActionIntentError {
    fn from(e: MissionError) -> Self {
        match e {
            MissionError::Storage(e) => Self::Storage(e),
            MissionError::NotFound => Self::NotFound,
            MissionError::Corrupt(_) => Self::Corrupt,
            MissionError::Capacity(_) => Self::Capacity,
            MissionError::Invalid(_) => Self::Invalid,
            MissionError::Conflict(_) => Self::Inactive,
        }
    }
}
type Result<T> = std::result::Result<T, NativeActionIntentError>;
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeActionIntentRecord {
    pub request_id: String,
    pub request_digest: String,
    pub state: String,
    pub state_version: u64,
    pub requested_at: String,
    pub expires_at: String,
    pub closed_at: Option<String>,
    pub closure_reason: Option<String>,
    pub duplicate: bool,
    /// Historical immutable admission binding, not a statement of current authority.
    pub admission_bound: bool,
    pub parameters_verified: bool,
    pub policy_verified: bool,
    pub dispatch_eligible: bool,
}
struct Stored {
    intent: NativeActionRequest,
    digest: String,
    requested_at: String,
    mission_version: u64,
    task_digest: String,
    state: String,
    closed_at: Option<String>,
    reason: Option<String>,
}
fn profile_valid(profile: &str) -> bool {
    !profile.trim().is_empty()
        && profile.encode_utf16().count() <= 200
        && !profile.chars().any(|c| c < ' ' || c == '\u{7f}')
}
fn valid_now(now: i64) -> bool {
    parse_utc(&format_utc(now)) == Some(now)
}
fn digest_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn matches(intent: &NativeActionRequest, a: &ExecutionAdmission) -> bool {
    intent.mission_id == a.mission_id
        && intent.workspace_id == a.workspace_id
        && intent.task_id == a.task_id
        && intent.lease_id == a.lease_id
        && intent.holder_agent_id == a.holder_agent_id
        && intent.supervisor_id == a.supervisor_id
        && intent.attempt == a.attempt
        && intent.admission_digest == a.admission_digest
}
fn finish(tx: Transaction<'_>, inject: bool) -> Result<()> {
    if inject {
        return Err(NativeActionIntentError::Storage(
            rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_IOERR),
                None,
            ),
        ));
    }
    tx.commit()?;
    Ok(())
}
fn clock(tx: &Transaction<'_>, profile: &str, lease: &str) -> Result<Option<i64>> {
    let value = tx
        .query_row(
            "SELECT observed_ms FROM native_action_clocks WHERE profile_id=?1 AND lease_id=?2",
            params![profile, lease],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if value.is_some_and(|v| !valid_now(v)) {
        return Err(NativeActionIntentError::Corrupt);
    }
    Ok(value)
}
fn observe(tx: &Transaction<'_>, profile: &str, lease: &str, now: i64) -> Result<i64> {
    let previous = clock(tx, profile, lease)?;
    let effective = previous.unwrap_or(now).max(now);
    let changed = if previous.is_some() {
        tx.execute(
            "UPDATE native_action_clocks SET observed_ms=?3 WHERE profile_id=?1 AND lease_id=?2",
            params![profile, lease, effective],
        )?
    } else {
        tx.execute(
            "INSERT INTO native_action_clocks (profile_id,lease_id,observed_ms) VALUES (?1,?2,?3)",
            params![profile, lease, effective],
        )?
    };
    if changed != 1 {
        return Err(NativeActionIntentError::Corrupt);
    }
    Ok(effective)
}
fn record(saved: &Stored, duplicate: bool) -> NativeActionIntentRecord {
    NativeActionIntentRecord {
        request_id: saved.intent.request_id.clone(),
        request_digest: saved.digest.clone(),
        state: saved.state.clone(),
        state_version: if saved.closed_at.is_some() { 2 } else { 1 },
        requested_at: saved.requested_at.clone(),
        expires_at: saved.intent.expires_at.clone(),
        closed_at: saved.closed_at.clone(),
        closure_reason: saved.reason.clone(),
        duplicate,
        admission_bound: true,
        parameters_verified: false,
        policy_verified: false,
        dispatch_eligible: false,
    }
}
fn bound(
    tx: &Transaction<'_>,
    profile: &str,
    intent: &NativeActionRequest,
) -> Result<ExecutionAdmission> {
    let admission = load_admission(tx, profile, &intent.mission_id, &intent.lease_id)?
        .ok_or(NativeActionIntentError::NotFound)?;
    if !matches(intent, &admission) {
        return Err(NativeActionIntentError::Conflict);
    }
    Ok(admission)
}
/// Validate the complete canonical mission and exact lease under the caller's transaction.
fn live(
    tx: &Transaction<'_>,
    profile: &str,
    intent: &NativeActionRequest,
    now: i64,
) -> Result<Option<(u64, String, i64)>> {
    snapshot_in_transaction(tx, profile, &intent.mission_id)?;
    let admission = bound(tx, profile, intent)?;
    let mission = load_mission(tx, profile, &intent.mission_id)?;
    let task = load_task(tx, profile, &intent.mission_id, &intent.task_id)?;
    if mission.state != MissionState::Running
        || task.state != TaskState::Running
        || !task.write_access
        || parse_utc(&admission.admitted_at).is_none_or(|at| now < at)
    {
        return Ok(None);
    }
    let lease = match live_lease(tx, profile, &task, now) {
        Ok(lease) => lease,
        Err(MissionError::Conflict(_)) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if lease.lease_id != intent.lease_id
        || lease.holder_agent_id != intent.holder_agent_id
        || parse_utc(&lease.acquired_at).is_none_or(|at| now < at)
    {
        return Ok(None);
    }
    Ok(Some((
        mission.version,
        canonical::digest(&task.to_value()),
        parse_utc(&lease.expires_at).ok_or(NativeActionIntentError::Corrupt)?,
    )))
}
fn load(tx: &Transaction<'_>, profile: &str, id: &str) -> Result<Stored> {
    let bytes:Option<i64>=tx.query_row("SELECT length(CAST(a.payload AS BLOB)) FROM approvals a JOIN native_action_requests n ON n.approval_id=a.approval_id AND n.profile_id=a.profile_id WHERE a.profile_id=?1 AND a.approval_id=?2",params![profile,id],|row|row.get(0)).optional()?;
    if !matches!(bytes, Some(1..=32768)) {
        return Err(if bytes.is_none() {
            NativeActionIntentError::NotFound
        } else {
            NativeActionIntentError::Corrupt
        });
    }
    let (mission,task,status,requested,expiry,decided,digest,payload,lease,key,kind)=tx.query_row("SELECT a.mission_id,a.task_id,a.status,a.requested_at,a.expires_at,a.decided_at,a.digest,a.payload,n.lease_id,n.idempotency_key,n.kind FROM approvals a JOIN native_action_requests n ON n.approval_id=a.approval_id AND n.profile_id=a.profile_id WHERE a.profile_id=?1 AND a.approval_id=?2",params![profile,id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,Option<String>>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,Option<String>>(5)?,row.get::<_,String>(6)?,row.get::<_,String>(7)?,row.get::<_,String>(8)?,row.get::<_,String>(9)?,row.get::<_,String>(10)?)))?;
    let value: Value =
        serde_json::from_str(&payload).map_err(|_| NativeActionIntentError::Corrupt)?;
    let intent = NativeActionRequest::from_value(&value["request"])
        .ok_or(NativeActionIntentError::Corrupt)?;
    let admission =
        contract::execution_admission(&value["admission"], "admission", &mut Vec::new())
            .ok_or(NativeActionIntentError::Corrupt)?;
    let actual = bound(tx, profile, &intent)?;
    let version = value["missionVersion"]
        .as_u64()
        .filter(|v| *v >= admission.mission_version && *v <= 9_007_199_254_740_991)
        .ok_or(NativeActionIntentError::Corrupt)?;
    let task_digest = value["taskDigest"]
        .as_str()
        .filter(|s| digest_valid(s))
        .ok_or(NativeActionIntentError::Corrupt)?
        .to_owned();
    if value.as_object().is_none_or(|m| m.len() != 7)
        || value["kind"] != "native-action-intent-record.v1"
        || value["profileId"] != profile
        || value["requestedAt"] != requested
        || canonical::to_string(&value) != payload
        || canonical::digest(&value) != digest
        || intent.request_id != id
        || intent.mission_id != mission
        || task.as_deref() != Some(intent.task_id.as_str())
        || intent.lease_id != lease
        || intent.idempotency_key != key
        || intent.expires_at != expiry
        || decided.is_some()
        || kind != "intent-only"
        || actual != admission
    {
        return Err(NativeActionIntentError::Corrupt);
    }
    let requested_ms = parse_utc(&requested).ok_or(NativeActionIntentError::Corrupt)?;
    let expiry_ms = parse_utc(&expiry).ok_or(NativeActionIntentError::Corrupt)?;
    let observed = clock(tx, profile, &lease)?.ok_or(NativeActionIntentError::Corrupt)?;
    if requested_ms < parse_utc(&admission.admitted_at).ok_or(NativeActionIntentError::Corrupt)?
        || expiry_ms <= requested_ms
        || expiry_ms - requested_ms > 600_000
        || observed < requested_ms
    {
        return Err(NativeActionIntentError::Corrupt);
    }
    let closure=tx.query_row("SELECT status,reason,recorded_at,digest,payload FROM native_action_closures WHERE profile_id=?1 AND approval_id=?2",params![profile,id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?))).optional()?;
    let mut saved = Stored {
        intent,
        digest,
        requested_at: requested,
        mission_version: version,
        task_digest,
        state: "pending".into(),
        closed_at: None,
        reason: None,
    };
    if let Some((state, reason, at, hash, payload)) = closure {
        let body: Value =
            serde_json::from_str(&payload).map_err(|_| NativeActionIntentError::Corrupt)?;
        let time = parse_utc(&at).ok_or(NativeActionIntentError::Corrupt)?;
        if body
            != json!({"requestId":id,"requestDigest":saved.digest,"state":state,"reason":reason,"recordedAt":at})
            || canonical::to_string(&body) != payload
            || canonical::digest(&body) != hash
            || time < requested_ms
            || time > observed
            || !matches!(
                (state.as_str(), reason.as_str()),
                ("revoked", "withdrawn") | ("expired", "expiry" | "authority-lost" | "recovery")
            )
            || (reason == "expiry" && time < expiry_ms)
        {
            return Err(NativeActionIntentError::Corrupt);
        }
        saved.state = state;
        saved.closed_at = Some(at);
        saved.reason = Some(reason);
    }
    if status != saved.state {
        return Err(NativeActionIntentError::Corrupt);
    }
    Ok(saved)
}
fn close(
    tx: &Transaction<'_>,
    profile: &str,
    saved: &Stored,
    state: &str,
    reason: &str,
    now: i64,
) -> Result<()> {
    let at = format_utc(now);
    let body = json!({"requestId":saved.intent.request_id,"requestDigest":saved.digest,"state":state,"reason":reason,"recordedAt":at});
    tx.execute("INSERT INTO native_action_closures (profile_id,approval_id,status,reason,recorded_at,digest,payload) VALUES (?1,?2,?3,?4,?5,?6,?7)",params![profile,saved.intent.request_id,state,reason,at,canonical::digest(&body),canonical::to_string(&body)])?;
    let changed=tx.execute("UPDATE approvals SET status=?1 WHERE profile_id=?2 AND approval_id=?3 AND status='pending'",params![state,profile,saved.intent.request_id])?;
    if changed != 1 {
        return Err(NativeActionIntentError::Corrupt);
    }
    Ok(())
}
fn refresh(tx: &Transaction<'_>, profile: &str, saved: Stored, now: i64) -> Result<Stored> {
    if saved.closed_at.is_some() {
        return Ok(saved);
    }
    let reason =
        if now >= parse_utc(&saved.intent.expires_at).ok_or(NativeActionIntentError::Corrupt)? {
            Some("expiry")
        } else {
            match live(tx, profile, &saved.intent, now)? {
                Some((version, digest, _))
                    if version == saved.mission_version && digest == saved.task_digest =>
                {
                    None
                }
                _ => Some("authority-lost"),
            }
        };
    if let Some(reason) = reason {
        close(tx, profile, &saved, "expired", reason, now)?;
        return load(tx, profile, &saved.intent.request_id);
    }
    Ok(saved)
}
impl CoreStore {
    /// Capture a pending, permanently non-executable intent. Parameter/policy references stay unverified.
    pub fn record_native_action_request(
        &mut self,
        profile: &str,
        request: &NativeActionRequest,
        now: i64,
    ) -> Result<NativeActionIntentRecord> {
        if !profile_valid(profile)
            || !valid_now(now)
            || NativeActionRequest::from_value(&request.to_value()).as_ref() != Some(request)
        {
            return Err(NativeActionIntentError::Invalid);
        }
        let inject = self.inject_failure();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let admission = bound(&tx, profile, request)?;
        let previous = clock(&tx, profile, &request.lease_id)?;
        let effective = observe(&tx, profile, &request.lease_id, now)?;
        let existing:Option<String>=tx.query_row("SELECT approval_id FROM native_action_requests WHERE profile_id=?1 AND lease_id=?2 AND idempotency_key=?3",params![profile,request.lease_id,request.idempotency_key],|row|row.get(0)).optional()?;
        if let Some(id) = existing {
            let saved = load(&tx, profile, &id)?;
            if canonical::to_string(&saved.intent.to_value())
                != canonical::to_string(&request.to_value())
            {
                finish(tx, inject)?;
                return Err(NativeActionIntentError::Conflict);
            }
            let result = record(&refresh(&tx, profile, saved, effective)?, true);
            finish(tx, inject)?;
            return Ok(result);
        }
        if tx.query_row(
            "SELECT count(*) FROM approvals WHERE approval_id=?1",
            [&request.request_id],
            |row| row.get::<_, i64>(0),
        )? != 0
        {
            finish(tx, inject)?;
            return Err(NativeActionIntentError::Conflict);
        }
        let source = live(&tx, profile, request, effective)?;
        let expiry = parse_utc(&request.expires_at).ok_or(NativeActionIntentError::Invalid)?;
        let Some((version, task_digest, lease_expiry)) = source.filter(|_| {
            previous.is_none_or(|old| now >= old)
                && expiry > effective
                && expiry - effective <= 600_000
        }) else {
            finish(tx, inject)?;
            return Err(NativeActionIntentError::Inactive);
        };
        if expiry > lease_expiry {
            finish(tx, inject)?;
            return Err(NativeActionIntentError::Inactive);
        }
        if tx.query_row(
            "SELECT count(*) FROM native_action_requests WHERE profile_id=?1 AND lease_id=?2",
            params![profile, request.lease_id],
            |row| row.get::<_, i64>(0),
        )? >= 128
        {
            finish(tx, inject)?;
            return Err(NativeActionIntentError::Capacity);
        }
        let at = format_utc(effective);
        let body = json!({"kind":"native-action-intent-record.v1","profileId":profile,"request":request.to_value(),"admission":admission.to_value(),"missionVersion":version,"taskDigest":task_digest,"requestedAt":at});
        let payload = canonical::to_string(&body);
        if payload.len() > 32768 {
            return Err(NativeActionIntentError::Invalid);
        }
        tx.execute("INSERT INTO approvals (approval_id,profile_id,mission_id,task_id,status,requested_at,expires_at,decided_at,digest,payload) VALUES (?1,?2,?3,?4,'pending',?5,?6,NULL,?7,?8)",params![request.request_id,profile,request.mission_id,request.task_id,at,request.expires_at,canonical::digest(&body),payload])?;
        tx.execute("INSERT INTO native_action_requests (approval_id,profile_id,lease_id,idempotency_key,kind) VALUES (?1,?2,?3,?4,'intent-only')",params![request.request_id,profile,request.lease_id,request.idempotency_key])?;
        let result = record(&load(&tx, profile, &request.request_id)?, false);
        finish(tx, inject)?;
        Ok(result)
    }
    /// Observe/expire intent history. Never returns an allow decision or an execution permit.
    pub fn inspect_native_action_request(
        &mut self,
        profile: &str,
        id: &str,
        now: i64,
    ) -> Result<NativeActionIntentRecord> {
        if !profile_valid(profile) || !contract::is_uuid(id) || !valid_now(now) {
            return Err(NativeActionIntentError::Invalid);
        }
        let inject = self.inject_failure();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let saved = load(&tx, profile, id)?;
        let effective = observe(&tx, profile, &saved.intent.lease_id, now)?;
        let result = record(&refresh(&tx, profile, saved, effective)?, false);
        finish(tx, inject)?;
        Ok(result)
    }
    /// Withdraw only. There is intentionally no grant, user-decision, or consume operation for this format.
    pub fn withdraw_native_action_request(
        &mut self,
        profile: &str,
        id: &str,
        displayed_digest: &str,
        expected_version: u64,
        now: i64,
    ) -> Result<NativeActionIntentRecord> {
        if !profile_valid(profile)
            || !contract::is_uuid(id)
            || !digest_valid(displayed_digest)
            || !(1..=2).contains(&expected_version)
            || !valid_now(now)
        {
            return Err(NativeActionIntentError::Invalid);
        }
        let inject = self.inject_failure();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let saved = load(&tx, profile, id)?;
        if saved.digest != displayed_digest {
            return Err(NativeActionIntentError::Conflict);
        }
        let effective = observe(&tx, profile, &saved.intent.lease_id, now)?;
        let saved = refresh(&tx, profile, saved, effective)?;
        if saved.closed_at.is_some() {
            let result = record(&saved, true);
            finish(tx, inject)?;
            return Ok(result);
        }
        if expected_version != 1 {
            finish(tx, inject)?;
            return Err(NativeActionIntentError::Conflict);
        }
        close(&tx, profile, &saved, "revoked", "withdrawn", effective)?;
        let result = record(&load(&tx, profile, id)?, false);
        finish(tx, inject)?;
        Ok(result)
    }
}
/// Part of the same canonical profile recovery transaction that removes old native leases.
pub(super) fn expire_profile(
    tx: &Transaction<'_>,
    profile: &str,
    now: i64,
) -> std::result::Result<(), MissionError> {
    let result = (|| -> Result<()> {
        if !valid_now(now) {
            return Err(NativeActionIntentError::Invalid);
        }
        let ids=tx.prepare("SELECT a.approval_id FROM approvals a JOIN native_action_requests n ON n.approval_id=a.approval_id AND n.profile_id=a.profile_id WHERE a.profile_id=?1 AND a.status='pending' ORDER BY a.approval_id")?.query_map([profile],|row|row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        for id in ids {
            let saved = load(tx, profile, &id)?;
            let effective = observe(tx, profile, &saved.intent.lease_id, now)?;
            close(tx, profile, &saved, "expired", "recovery", effective)?;
            load(tx, profile, &id)?;
        }
        Ok(())
    })();
    result.map_err(|e| match e {
        NativeActionIntentError::Storage(e) => MissionError::Storage(e),
        NativeActionIntentError::Invalid => MissionError::Invalid("native action recovery clock"),
        _ => MissionError::Corrupt("native action recovery records"),
    })
}
