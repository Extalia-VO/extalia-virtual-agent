//! Transactional planning lifetime receipts; no lease, expiry, cancellation or restart reaping.
use super::{CoreStore, missions::finish};
use crate::mission::{MissionError, canonical, contract};
use crate::planning::{
    MAX_PLANNING_BYTES, MAX_PLANNING_HISTORY, PlanningAdmission, PlanningBegin, PlanningInspection,
    PlanningObservation, PlanningObservationRecord,
};
use crate::time::{format_utc, parse_utc};
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::Value;
use std::collections::BTreeSet;

const fn corrupt() -> MissionError {
    MissionError::Corrupt("planning lifetime receipt invariants")
}
fn resources(begin: &PlanningBegin) -> Vec<(String, String)> {
    let mut resources = begin
        .connection_ids
        .iter()
        .map(|id| ("connection".into(), id.clone()))
        .collect::<Vec<_>>();
    resources.push(("session".into(), begin.session_id.clone()));
    resources.sort();
    resources
}
fn observation_digest(profile: &str, record: &PlanningObservationRecord) -> String {
    canonical::digest(
        &serde_json::json!({"domain":"extalia.core/planning-observation/v1","profileId":profile,"observation":record.to_value()}),
    )
}
fn profile_valid(profile: &str) -> Result<(), MissionError> {
    if profile.is_empty() || profile.len() > 200 {
        Err(MissionError::Invalid("invalid planning profile"))
    } else {
        Ok(())
    }
}

fn load(tx: &Transaction<'_>, profile: &str, id: &str) -> Result<PlanningInspection, MissionError> {
    let bytes:Option<i64>=tx.query_row("SELECT length(CAST(payload AS BLOB)) FROM planning_admissions WHERE profile_id=?1 AND invocation_id=?2",params![profile,id],|row|row.get(0)).optional()?;
    if bytes.ok_or(MissionError::NotFound)? > MAX_PLANNING_BYTES as i64 {
        return Err(corrupt());
    }
    let (supervisor,session,workspace,time,digest,payload):(String,String,String,String,String,String)=tx.query_row(
        "SELECT supervisor_id,session_id,workspace_id,admitted_at,admission_digest,payload FROM planning_admissions WHERE profile_id=?1 AND invocation_id=?2",
        params![profile,id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)))?;
    let value: Value = serde_json::from_str(&payload).map_err(|_| corrupt())?;
    let admission = PlanningAdmission::from_value(&value).map_err(|_| corrupt())?;
    if admission.begin.invocation_id != id
        || admission.begin.supervisor_id != supervisor
        || admission.begin.session_id != session
        || admission.begin.workspace_id != workspace
        || admission.admitted_at != time
        || admission.admission_digest != digest
        || admission.captured_digest(profile) != digest
        || canonical::to_string(&value) != payload
    {
        return Err(corrupt());
    }
    let claims=tx.prepare("SELECT resource_kind,resource_id FROM planning_resource_claims WHERE profile_id=?1 AND invocation_id=?2 ORDER BY resource_kind,resource_id LIMIT 18")?
        .query_map(params![profile,id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    if claims != resources(&admission.begin) {
        return Err(corrupt());
    }
    let bytes:Option<i64>=tx.query_row("SELECT length(CAST(payload AS BLOB)) FROM planning_observations WHERE profile_id=?1 AND invocation_id=?2",params![profile,id],|row|row.get(0)).optional()?;
    let observation = if let Some(bytes) = bytes {
        if bytes > MAX_PLANNING_BYTES as i64 {
            return Err(corrupt());
        }
        let (digest,kind,time,hash,payload):(String,String,String,String,String)=tx.query_row("SELECT admission_digest,kind,recorded_at,digest,payload FROM planning_observations WHERE profile_id=?1 AND invocation_id=?2",
            params![profile,id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)))?;
        let value: Value = serde_json::from_str(&payload).map_err(|_| corrupt())?;
        let record = PlanningObservationRecord::from_value(&value).map_err(|_| corrupt())?;
        if record.observation.invocation_id != id
            || record.observation.admission_digest != admission.admission_digest
            || record.observation.admission_digest != digest
            || kind != "local-pipeline-settled"
            || time != record.recorded_at
            || hash != observation_digest(profile, &record)
            || parse_utc(&time) < parse_utc(&admission.admitted_at)
            || canonical::to_string(&value) != payload
        {
            return Err(corrupt());
        }
        Some(record)
    } else {
        None
    };
    Ok(PlanningInspection {
        admission,
        observation,
    })
}
fn overlapping(
    tx: &Transaction<'_>,
    profile: &str,
    begin: &PlanningBegin,
) -> Result<BTreeSet<String>, MissionError> {
    let mut owners = BTreeSet::new();
    // Consult original admission scope too: a corrupt missing claim must not make a
    // pending lifetime disappear. The SQL history cap bounds this scan to 1024 rows.
    let placeholders = (0..begin.connection_ids.len())
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT invocation_id FROM planning_admissions WHERE profile_id=? AND (session_id=? OR EXISTS(SELECT 1 FROM json_each(payload,'$.connectionIds') WHERE value IN ({placeholders}))) LIMIT 1025"
    );
    let mut values = vec![profile, begin.session_id.as_str()];
    values.extend(begin.connection_ids.iter().map(String::as_str));
    let mut statement = tx.prepare(&sql)?;
    for owner in statement.query_map(rusqlite::params_from_iter(values), |row| {
        row.get::<_, String>(0)
    })? {
        owners.insert(owner?);
    }
    for (kind, id) in resources(begin) {
        let mut statement=tx.prepare("SELECT invocation_id FROM planning_resource_claims WHERE profile_id=?1 AND resource_kind=?2 AND resource_id=?3 LIMIT 1025")?;
        for owner in
            statement.query_map(params![profile, kind, id], |row| row.get::<_, String>(0))?
        {
            owners.insert(owner?);
        }
        if owners.len() > MAX_PLANNING_HISTORY {
            return Err(corrupt());
        }
    }
    if owners.len() > MAX_PLANNING_HISTORY {
        return Err(corrupt());
    }
    Ok(owners)
}
fn guard_pending(
    tx: &Transaction<'_>,
    profile: &str,
    inspection: &PlanningInspection,
) -> Result<(), MissionError> {
    if inspection.observation.is_some() {
        return Ok(());
    }
    for owner in overlapping(tx, profile, &inspection.admission.begin)? {
        if owner != inspection.admission.begin.invocation_id
            && load(tx, profile, &owner)?.observation.is_none()
        {
            return Err(corrupt());
        }
    }
    Ok(())
}
impl CoreStore {
    /// Exact retries return the original admission. Unobserved work holds resources forever.
    pub fn begin_planning(
        &mut self,
        profile: &str,
        begin: &PlanningBegin,
        now: i64,
    ) -> Result<PlanningAdmission, MissionError> {
        profile_valid(profile)?;
        PlanningBegin::from_value(&begin.to_value())?;
        let time = format_utc(now);
        if parse_utc(&time).is_none() {
            return Err(MissionError::Invalid("invalid planning time"));
        }
        let inject = self.inject_failure();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        match load(&tx, profile, &begin.invocation_id) {
            Ok(existing) => {
                if existing.admission.begin != *begin {
                    return Err(MissionError::Conflict("planning invocation differs"));
                }
                guard_pending(&tx, profile, &existing)?;
                return Ok(existing.admission);
            }
            Err(MissionError::NotFound) => {}
            Err(error) => return Err(error),
        }
        let count: i64 = tx.query_row(
            "SELECT count(*) FROM planning_admissions WHERE profile_id=?1",
            [profile],
            |row| row.get(0),
        )?;
        if count >= MAX_PLANNING_HISTORY as i64 {
            return Err(MissionError::Capacity("planning lifetime history"));
        }
        for owner in overlapping(&tx, profile, begin)? {
            if load(&tx, profile, &owner)?.observation.is_none() {
                return Err(MissionError::Conflict("planning resource remains pending"));
            }
        }
        let mut admission = PlanningAdmission {
            begin: begin.clone(),
            admitted_at: time,
            admission_digest: String::new(),
        };
        admission.admission_digest = admission.captured_digest(profile);
        let payload = canonical::to_string(&admission.to_value());
        if payload.len() > MAX_PLANNING_BYTES {
            return Err(MissionError::Capacity("planning admission"));
        }
        tx.execute("INSERT INTO planning_admissions (profile_id,invocation_id,supervisor_id,session_id,workspace_id,admitted_at,admission_digest,payload) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![profile,begin.invocation_id,begin.supervisor_id,begin.session_id,begin.workspace_id,admission.admitted_at,admission.admission_digest,payload])?;
        for (kind, id) in resources(begin) {
            tx.execute("INSERT INTO planning_resource_claims (profile_id,invocation_id,resource_kind,resource_id) VALUES (?1,?2,?3,?4)",params![profile,begin.invocation_id,kind,id])?;
        }
        finish(tx, inject)?;
        Ok(admission)
    }
    /// Only the complete local pipeline's settled promise is recorded; errors/abort do not imply this.
    pub fn observe_planning(
        &mut self,
        profile: &str,
        observation: &PlanningObservation,
        now: i64,
    ) -> Result<PlanningObservationRecord, MissionError> {
        profile_valid(profile)?;
        PlanningObservation::from_value(&observation.to_value())?;
        let inject = self.inject_failure();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = load(&tx, profile, &observation.invocation_id)?;
        guard_pending(&tx, profile, &existing)?;
        if existing.admission.admission_digest != observation.admission_digest {
            return Err(MissionError::Conflict("planning admission digest differs"));
        }
        if let Some(record) = existing.observation {
            return Ok(record);
        }
        let record = PlanningObservationRecord {
            observation: observation.clone(),
            recorded_at: format_utc(now),
        };
        if parse_utc(&record.recorded_at).is_none()
            || parse_utc(&record.recorded_at) < parse_utc(&existing.admission.admitted_at)
        {
            return Err(MissionError::Invalid(
                "planning observation predates admission",
            ));
        }
        let payload = canonical::to_string(&record.to_value());
        tx.execute("INSERT INTO planning_observations (profile_id,invocation_id,admission_digest,kind,recorded_at,digest,payload) VALUES (?1,?2,?3,'local-pipeline-settled',?4,?5,?6)",
            params![profile,observation.invocation_id,observation.admission_digest,record.recorded_at,observation_digest(profile,&record),payload])?;
        finish(tx, inject)?;
        Ok(record)
    }
    /// Read-only, scoped, bounded lifetime inspection; it never settles pending work.
    pub fn inspect_planning(
        &mut self,
        profile: &str,
        id: &str,
    ) -> Result<PlanningInspection, MissionError> {
        profile_valid(profile)?;
        if !contract::is_uuid(id) {
            return Err(MissionError::Invalid("invalid planning invocation"));
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Deferred)?;
        let inspection = load(&tx, profile, id)?;
        guard_pending(&tx, profile, &inspection)?;
        tx.commit()?;
        Ok(inspection)
    }
}
