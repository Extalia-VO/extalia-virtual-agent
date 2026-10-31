//! Immutable authority admissions and narrow supervisor promise observations.
//! These records never establish physical effect settlement or clear quarantine.
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};

use super::CoreStore;
use super::mission_snapshot::snapshot_in_transaction;
use super::missions::{finish, later, load_mission, load_task};
use super::planned_tasks;
use crate::mission::{
    ExecutionAdmission, ExecutionObservation, ExecutionObservationAck, ExecutionObservationRecord,
    MAX_TASKS_PER_MISSION, Mission, MissionError, MissionExecution, MissionExecutions, Task,
    canonical, contract,
};
use crate::time::parse_utc;

const fn corrupt() -> MissionError {
    MissionError::Corrupt("execution receipt invariants")
}
const fn conflict() -> MissionError {
    MissionError::Conflict("execution observation identity differs")
}

pub(super) fn admit(
    tx: &Transaction<'_>,
    profile: &str,
    mission: &Mission,
    task: &Task,
    supervisor: &str,
    now: &str,
) -> Result<ExecutionAdmission, MissionError> {
    let count: i64 = tx.query_row(
        "SELECT count(*) FROM execution_admissions WHERE profile_id=?1 AND mission_id=?2",
        params![profile, mission.id],
        |row| row.get(0),
    )?;
    if count >= MAX_TASKS_PER_MISSION as i64 {
        return Err(MissionError::Capacity("execution admissions"));
    }
    let graph = planned_tasks::current_graph(tx, profile, &mission.id)?;
    if !graph.tasks.iter().any(|saved| saved == task) {
        return Err(corrupt());
    }
    planned_tasks::guard(tx, profile, mission, &graph)?;
    let mut admission = ExecutionAdmission {
        mission_id: mission.id.clone(),
        workspace_id: mission.workspace_id.clone(),
        task_id: task.id.clone(),
        lease_id: task.lease_id.clone().ok_or_else(corrupt)?,
        holder_agent_id: task.assigned_agent_id.clone().ok_or_else(corrupt)?,
        supervisor_id: supervisor.into(),
        attempt: task.attempt,
        mission_version: mission.version,
        task_digest: canonical::digest(&task.to_value()),
        graph_digest: canonical::digest(&graph.to_value()),
        admission_digest: String::new(),
        admitted_at: now.into(),
    };
    admission.admission_digest = admission.captured_digest(profile);
    if contract::execution_admission(&admission.to_value(), "admission", &mut Vec::new()).is_none()
    {
        return Err(corrupt());
    }
    tx.execute("INSERT INTO execution_admissions (lease_id,profile_id,mission_id,workspace_id,task_id,holder_agent_id,supervisor_id,attempt,mission_version,task_digest,graph_digest,admission_digest,admitted_at,payload)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",params![admission.lease_id,profile,admission.mission_id,admission.workspace_id,admission.task_id,admission.holder_agent_id,admission.supervisor_id,admission.attempt as i64,admission.mission_version as i64,admission.task_digest,admission.graph_digest,admission.admission_digest,admission.admitted_at,canonical::to_string(&admission.to_value())])?;
    Ok(admission)
}

pub(super) fn load_admission(
    tx: &Transaction<'_>,
    profile: &str,
    mission_id: &str,
    lease_id: &str,
) -> Result<Option<ExecutionAdmission>, MissionError> {
    let stored=tx.query_row("SELECT mission_id,workspace_id,task_id,holder_agent_id,supervisor_id,attempt,mission_version,task_digest,graph_digest,admission_digest,admitted_at,payload FROM execution_admissions WHERE profile_id=?1 AND mission_id=?2 AND lease_id=?3",
        params![profile,mission_id,lease_id],|row|Ok((ExecutionAdmission {
            mission_id:row.get(0)?,workspace_id:row.get(1)?,task_id:row.get(2)?,lease_id:lease_id.into(),holder_agent_id:row.get(3)?,supervisor_id:row.get(4)?,attempt:row.get::<_,i64>(5)? as u64,mission_version:row.get::<_,i64>(6)? as u64,task_digest:row.get(7)?,graph_digest:row.get(8)?,admission_digest:row.get(9)?,admitted_at:row.get(10)?,
        },row.get::<_,String>(11)?))).optional()?;
    let Some((row, payload)) = stored else {
        return Ok(None);
    };
    let value: Value = serde_json::from_str(&payload).map_err(|_| corrupt())?;
    let admission =
        contract::execution_admission(&value, "admission", &mut Vec::new()).ok_or_else(corrupt)?;
    if admission != row
        || canonical::to_string(&value) != payload
        || admission.captured_digest(profile) != admission.admission_digest
    {
        return Err(corrupt());
    }
    let mission = load_mission(tx, profile, mission_id)?;
    let task = load_task(tx, profile, mission_id, &admission.task_id)?;
    if mission.workspace_id != admission.workspace_id
        || mission.version < admission.mission_version
        || task.assigned_agent_id.as_deref() != Some(admission.holder_agent_id.as_str())
        || task.attempt != admission.attempt
    {
        return Err(corrupt());
    }
    // Bind the immutable receipt to its actual running-admission journal record.
    let (event_task,event_type,digest,event_payload):(Option<String>,String,String,String)=tx.query_row(
        "SELECT task_id,event_type,digest,payload FROM events WHERE profile_id=?1 AND mission_id=?2 AND event_id=?3",
        params![profile,mission_id,lease_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))?;
    let event: Value = serde_json::from_str(&event_payload).map_err(|_| corrupt())?;
    let transition = json!({"missionId":admission.mission_id,"taskId":admission.task_id,"eventId":admission.lease_id,
        "from":event["from"],"to":"running","supervisorId":admission.supervisor_id});
    let transition = contract::task_transition(&transition, "transition", &mut Vec::new())
        .ok_or_else(corrupt)?;
    if event_task.as_deref() != Some(admission.task_id.as_str())
        || event_type != "task.state"
        || event["record"] != "task.transition"
        || event["state"] != "running"
        || event["to"] != "running"
        || event["missionId"] != admission.mission_id
        || event["taskId"] != admission.task_id
        || event["eventId"] != admission.lease_id
        || event["supervisorId"] != admission.supervisor_id
        || canonical::digest(&transition.to_value()) != digest
    {
        return Err(corrupt());
    }
    Ok(Some(admission))
}

pub(super) struct StoredObservation {
    pub(super) observation: ExecutionObservation,
    pub(super) recorded_at: String,
}
pub(super) fn load_observation(
    tx: &Transaction<'_>,
    profile: &str,
    admission: &ExecutionAdmission,
) -> Result<Option<StoredObservation>, MissionError> {
    let stored=tx.query_row("SELECT observation_id,mission_id,task_id,holder_agent_id,supervisor_id,attempt,admission_digest,kind,recorded_at,digest,payload FROM execution_observations WHERE profile_id=?1 AND lease_id=?2",
        params![profile,admission.lease_id],|row|Ok((ExecutionObservation {
            observation_id:row.get(0)?,mission_id:row.get(1)?,task_id:row.get(2)?,lease_id:admission.lease_id.clone(),holder_agent_id:row.get(3)?,supervisor_id:row.get(4)?,attempt:row.get::<_,i64>(5)? as u64,admission_digest:row.get(6)?,kind:row.get(7)?,
        },row.get::<_,String>(8)?,row.get::<_,String>(9)?,row.get::<_,String>(10)?))).optional()?;
    let Some((row, recorded_at, digest, payload)) = stored else {
        return Ok(None);
    };
    let value: Value = serde_json::from_str(&payload).map_err(|_| corrupt())?;
    let observation =
        contract::execution_observation(&value["observation"], "observation", &mut Vec::new())
            .ok_or_else(corrupt)?;
    if value.as_object().is_none_or(|fields| fields.len() != 2)
        || value["recordedAt"] != recorded_at
        || parse_utc(&recorded_at).is_none()
        || parse_utc(&recorded_at) < parse_utc(&admission.admitted_at)
        || observation != row
        || !observation.matches(admission)
        || canonical::to_string(&value) != payload
        || canonical::digest(&value) != digest
    {
        return Err(corrupt());
    }
    Ok(Some(StoredObservation {
        observation,
        recorded_at,
    }))
}

impl CoreStore {
    /// Record only that this exact admission's supervisor observed its turn promise settle.
    /// This remains admissible after expiry/reaping/restart and never changes authority or results.
    pub fn observe_execution(
        &mut self,
        profile: &str,
        observation: &ExecutionObservation,
        now: i64,
    ) -> Result<ExecutionObservationAck, MissionError> {
        if contract::execution_observation(&observation.to_value(), "observation", &mut Vec::new())
            .is_none()
        {
            return Err(MissionError::Invalid("invalid execution observation"));
        }
        let inject = self.inject_failure();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        snapshot_in_transaction(&tx, profile, &observation.mission_id)?;
        let admission =
            load_admission(&tx, profile, &observation.mission_id, &observation.lease_id)?
                .ok_or(MissionError::NotFound)?;
        if !observation.matches(&admission) {
            return Err(conflict());
        }
        let global: Option<(String, String)> = tx
            .query_row(
                "SELECT profile_id,lease_id FROM execution_observations WHERE observation_id=?1",
                [&observation.observation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if global
            .as_ref()
            .is_some_and(|(owner, lease)| owner != profile || lease != &admission.lease_id)
        {
            return Err(conflict());
        }
        if let Some(saved) = load_observation(&tx, profile, &admission)? {
            if saved.observation != *observation {
                return Err(conflict());
            }
            return Ok(ExecutionObservationAck {
                mission_id: observation.mission_id.clone(),
                task_id: observation.task_id.clone(),
                lease_id: observation.lease_id.clone(),
                observation_id: observation.observation_id.clone(),
                recorded_at: saved.recorded_at,
                duplicate: true,
            });
        }
        if global.is_some() {
            return Err(corrupt());
        }
        let recorded_at = later(now, &admission.admitted_at);
        if parse_utc(&recorded_at).is_none() {
            return Err(MissionError::Invalid("invalid observation time"));
        }
        let payload = json!({"observation":observation.to_value(),"recordedAt":recorded_at});
        tx.execute("INSERT INTO execution_observations (observation_id,profile_id,mission_id,task_id,lease_id,holder_agent_id,supervisor_id,attempt,admission_digest,kind,recorded_at,digest,payload)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",params![observation.observation_id,profile,observation.mission_id,observation.task_id,observation.lease_id,observation.holder_agent_id,observation.supervisor_id,observation.attempt as i64,observation.admission_digest,observation.kind,recorded_at,canonical::digest(&payload),canonical::to_string(&payload)])?;
        finish(tx, inject)?;
        Ok(ExecutionObservationAck {
            mission_id: observation.mission_id.clone(),
            task_id: observation.task_id.clone(),
            lease_id: observation.lease_id.clone(),
            observation_id: observation.observation_id.clone(),
            recorded_at,
            duplicate: false,
        })
    }

    /// Read immutable capture metadata and narrow promise observations, never infer legacy admissions.
    pub fn list_mission_executions(
        &mut self,
        profile: &str,
        mission_id: &str,
    ) -> Result<MissionExecutions, MissionError> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Deferred)?;
        snapshot_in_transaction(&tx, profile, mission_id)?;
        let executions = executions_in_transaction(&tx, profile, mission_id)?;
        tx.commit()?;
        Ok(MissionExecutions {
            mission_id: mission_id.into(),
            executions,
        })
    }
}

/// Reuse the caller's pinned read view; never open a nested transaction.
pub(super) fn executions_in_transaction(
    tx: &Transaction<'_>,
    profile: &str,
    mission_id: &str,
) -> Result<Vec<MissionExecution>, MissionError> {
    let leases=tx.prepare("SELECT lease_id FROM execution_admissions WHERE profile_id=?1 AND mission_id=?2 ORDER BY task_id LIMIT 65")?
            .query_map(params![profile,mission_id],|row|row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    if leases.len() > MAX_TASKS_PER_MISSION {
        return Err(MissionError::Capacity("execution admissions"));
    }
    let mut executions = Vec::with_capacity(leases.len());
    for lease in leases {
        let admission = load_admission(tx, profile, mission_id, &lease)?.ok_or_else(corrupt)?;
        let saved_observation = load_observation(tx, profile, &admission)?;
        let local_drain = super::execution_local_drains::load_record(
            tx,
            profile,
            &admission,
            saved_observation.as_ref(),
        )?;
        let observation = saved_observation.map(|saved| ExecutionObservationRecord {
            observation_id: saved.observation.observation_id,
            kind: saved.observation.kind,
            recorded_at: saved.recorded_at,
        });
        executions.push(MissionExecution {
            admission,
            observation,
            local_drain,
        });
    }
    Ok(executions)
}
