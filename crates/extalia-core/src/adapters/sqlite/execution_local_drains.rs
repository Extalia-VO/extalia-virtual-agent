//! Immutable evidence for Extalia-owned local operations. Never grants authority.
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};

use super::CoreStore;
use super::execution_receipts::{StoredObservation, load_admission, load_observation};
use super::mission_snapshot::snapshot_in_transaction;
use super::missions::{finish, later};
use crate::mission::{
    ExecutionAdmission, ExecutionLocalDrain, ExecutionLocalDrainAck, ExecutionLocalDrainRecord,
    MissionError, canonical, contract,
};
use crate::time::parse_utc;

const fn corrupt() -> MissionError {
    MissionError::Corrupt("local drain receipt invariants")
}
const fn conflict() -> MissionError {
    MissionError::Conflict("local drain identity differs")
}

struct StoredDrain {
    drain: ExecutionLocalDrain,
    recorded_at: String,
}
fn load_drain(
    tx: &Transaction<'_>,
    profile: &str,
    admission: &ExecutionAdmission,
    observation: Option<&StoredObservation>,
) -> Result<Option<StoredDrain>, MissionError> {
    let stored=tx.query_row("SELECT proof_id,mission_id,task_id,holder_agent_id,supervisor_id,attempt,admission_digest,kind,coverage,provider_operations,tool_operations,recorded_at,digest,payload FROM execution_local_drains WHERE profile_id=?1 AND lease_id=?2",
        params![profile,admission.lease_id],|row|Ok((ExecutionLocalDrain {
            proof_id:row.get(0)?,mission_id:row.get(1)?,task_id:row.get(2)?,lease_id:admission.lease_id.clone(),holder_agent_id:row.get(3)?,supervisor_id:row.get(4)?,attempt:row.get::<_,i64>(5)? as u64,admission_digest:row.get(6)?,kind:row.get(7)?,coverage:row.get(8)?,provider_operations:row.get::<_,i64>(9)? as u64,tool_operations:row.get::<_,i64>(10)? as u64,
        },row.get::<_,String>(11)?,row.get::<_,String>(12)?,row.get::<_,String>(13)?))).optional()?;
    let Some((row, recorded_at, digest, payload)) = stored else {
        return Ok(None);
    };
    let observation = observation.ok_or_else(corrupt)?;
    let value: Value = serde_json::from_str(&payload).map_err(|_| corrupt())?;
    let drain =
        contract::execution_local_drain(&value["localDrain"], "localDrain", &mut Vec::new())
            .ok_or_else(corrupt)?;
    if value.as_object().is_none_or(|fields| fields.len() != 2)
        || value["recordedAt"] != recorded_at
        || parse_utc(&recorded_at).is_none()
        || parse_utc(&recorded_at) < parse_utc(&admission.admitted_at)
        || parse_utc(&recorded_at) < parse_utc(&observation.recorded_at)
        || drain != row
        || !drain.matches(admission)
        || canonical::to_string(&value) != payload
        || canonical::digest(&value) != digest
    {
        return Err(corrupt());
    }
    Ok(Some(StoredDrain { drain, recorded_at }))
}
pub(super) fn load_record(
    tx: &Transaction<'_>,
    profile: &str,
    admission: &ExecutionAdmission,
    observation: Option<&StoredObservation>,
) -> Result<Option<ExecutionLocalDrainRecord>, MissionError> {
    Ok(
        load_drain(tx, profile, admission, observation)?.map(|saved| ExecutionLocalDrainRecord {
            proof_id: saved.drain.proof_id,
            kind: saved.drain.kind,
            coverage: saved.drain.coverage,
            provider_operations: saved.drain.provider_operations,
            tool_operations: saved.drain.tool_operations,
            recorded_at: saved.recorded_at,
        }),
    )
}
impl CoreStore {
    /// Requires the exact admission and its weaker observation, including after recovery.
    /// Writes only this immutable record; leases, journal, state and results are untouched.
    pub fn record_local_drain(
        &mut self,
        profile: &str,
        drain: &ExecutionLocalDrain,
        now: i64,
    ) -> Result<ExecutionLocalDrainAck, MissionError> {
        if contract::execution_local_drain(&drain.to_value(), "localDrain", &mut Vec::new())
            .is_none()
        {
            return Err(MissionError::Invalid("invalid local drain"));
        }
        let inject = self.inject_failure();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        snapshot_in_transaction(&tx, profile, &drain.mission_id)?;
        let admission = load_admission(&tx, profile, &drain.mission_id, &drain.lease_id)?
            .ok_or(MissionError::NotFound)?;
        if !drain.matches(&admission) {
            return Err(conflict());
        }
        let observation = load_observation(&tx, profile, &admission)?.ok_or(
            MissionError::Conflict("local drain requires turn observation"),
        )?;
        let global: Option<(String, String)> = tx
            .query_row(
                "SELECT profile_id,lease_id FROM execution_local_drains WHERE proof_id=?1",
                [&drain.proof_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if global
            .as_ref()
            .is_some_and(|(owner, lease)| owner != profile || lease != &admission.lease_id)
        {
            return Err(conflict());
        }
        if let Some(saved) = load_drain(&tx, profile, &admission, Some(&observation))? {
            if saved.drain != *drain {
                return Err(conflict());
            }
            return Ok(ack(drain, saved.recorded_at, true));
        }
        if global.is_some() {
            return Err(corrupt());
        }
        let recorded_at = later(now, &observation.recorded_at);
        if parse_utc(&recorded_at).is_none() {
            return Err(MissionError::Invalid("invalid local drain time"));
        }
        let payload = json!({"localDrain":drain.to_value(),"recordedAt":recorded_at});
        tx.execute("INSERT INTO execution_local_drains (proof_id,profile_id,mission_id,task_id,lease_id,holder_agent_id,supervisor_id,attempt,admission_digest,kind,coverage,provider_operations,tool_operations,recorded_at,digest,payload) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",params![drain.proof_id,profile,drain.mission_id,drain.task_id,drain.lease_id,drain.holder_agent_id,drain.supervisor_id,drain.attempt as i64,drain.admission_digest,drain.kind,drain.coverage,drain.provider_operations as i64,drain.tool_operations as i64,recorded_at,canonical::digest(&payload),canonical::to_string(&payload)])?;
        finish(tx, inject)?;
        Ok(ack(drain, recorded_at, false))
    }
}
fn ack(
    drain: &ExecutionLocalDrain,
    recorded_at: String,
    duplicate: bool,
) -> ExecutionLocalDrainAck {
    ExecutionLocalDrainAck {
        mission_id: drain.mission_id.clone(),
        task_id: drain.task_id.clone(),
        lease_id: drain.lease_id.clone(),
        proof_id: drain.proof_id.clone(),
        recorded_at,
        duplicate,
    }
}
