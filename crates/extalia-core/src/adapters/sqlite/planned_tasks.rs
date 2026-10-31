//! Bounded, immutable original planner membership; absence is explicitly legacy.
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::Value;

use super::{
    CoreStore,
    missions::{decode_task, load_mission},
};
use crate::mission::{
    MAX_TASKS_PER_MISSION, Mission, MissionError, PlannedTaskMembership,
    PlannedTaskMembershipAvailability, TaskGraph, canonical, contract,
};
use crate::time::parse_utc;

const MAX_BYTES: i64 = 1024 * 1024;
const fn corrupt() -> MissionError {
    MissionError::Corrupt("original planned task membership")
}

impl CoreStore {
    /// Internal Rust read API only. Available history is not recovery or execution certification.
    /// It validates the historical record, not every current mission-row column/digest;
    /// use the canonical recovery review for a coherent current-state inspection.
    pub fn mission_planned_tasks(
        &mut self,
        profile: &str,
        mission_id: &str,
    ) -> Result<PlannedTaskMembershipAvailability, MissionError> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Deferred)?;
        let bytes: Option<i64> = tx.query_row("SELECT length(CAST(payload AS BLOB)) FROM missions WHERE profile_id=?1 AND mission_id=?2",
            params![profile,mission_id], |row| row.get(0)).optional()?;
        if bytes.ok_or(MissionError::NotFound)? > MAX_BYTES {
            return Err(MissionError::Capacity("mission payload"));
        }
        let mission = load_mission(&tx, profile, mission_id)?;
        let membership = load(&tx, profile, &mission)?;
        tx.commit()?;
        Ok(membership)
    }
}

pub(super) fn capture(
    tx: &Transaction<'_>,
    profile: &str,
    membership: &PlannedTaskMembership,
) -> Result<(), MissionError> {
    let payload = canonical::to_string(&membership.to_value());
    if payload.len() > MAX_BYTES as usize {
        return Err(MissionError::Capacity("original planned tasks"));
    }
    tx.execute("INSERT INTO mission_planned_tasks (mission_id,profile_id,workspace_id,creation_version,task_count,graph_digest,membership_digest,payload)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",params![membership.mission_id,profile,membership.workspace_id,membership.creation_version as i64,
        membership.tasks.len() as i64,membership.graph_digest,membership.membership_digest,payload])?;
    Ok(())
}

pub(super) fn load(
    tx: &Transaction<'_>,
    profile: &str,
    mission: &Mission,
) -> Result<PlannedTaskMembershipAvailability, MissionError> {
    let bytes: Option<i64> = tx.query_row("SELECT length(CAST(payload AS BLOB)) FROM mission_planned_tasks WHERE profile_id=?1 AND mission_id=?2",
        params![profile,mission.id], |row| row.get(0)).optional()?;
    let Some(bytes) = bytes else {
        return Ok(PlannedTaskMembershipAvailability::LegacyUnavailable);
    };
    if bytes > MAX_BYTES {
        return Err(MissionError::Capacity("original planned tasks"));
    }
    let (workspace,version,count,graph_digest,digest,payload): (String,i64,i64,String,String,String) = tx.query_row(
        "SELECT workspace_id,creation_version,task_count,graph_digest,membership_digest,payload FROM mission_planned_tasks WHERE profile_id=?1 AND mission_id=?2",
        params![profile,mission.id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)))?;
    let value: Value = serde_json::from_str(&payload).map_err(|_| corrupt())?;
    let membership = PlannedTaskMembership::decode(profile, &value)?;
    if membership.mission_id != mission.id
        || membership.workspace_id != mission.workspace_id
        || workspace != membership.workspace_id
        || version as u64 != membership.creation_version
        || mission.version < membership.creation_version
        || count as usize != membership.tasks.len()
        || graph_digest != membership.graph_digest
        || digest != membership.membership_digest
        || canonical::to_string(&value) != payload
    {
        return Err(corrupt());
    }
    Ok(PlannedTaskMembershipAvailability::Available(membership))
}

pub(super) fn guard(
    tx: &Transaction<'_>,
    profile: &str,
    mission: &Mission,
    graph: &TaskGraph,
) -> Result<(), MissionError> {
    if let PlannedTaskMembershipAvailability::Available(membership) = load(tx, profile, mission)?
        && !membership.matches_current(graph)
    {
        return Err(corrupt());
    }
    // No legacy backfill or implied certification: the separate read API reports unavailable.
    Ok(())
}

pub(super) fn current_graph(
    tx: &Transaction<'_>,
    profile: &str,
    mission_id: &str,
) -> Result<TaskGraph, MissionError> {
    let (count, bytes): (i64, i64) = tx.query_row(
        "SELECT count(*),coalesce(sum(length(CAST(payload AS BLOB))),0) FROM
        (SELECT payload FROM tasks WHERE profile_id=?1 AND mission_id=?2 LIMIT 65)",
        params![profile, mission_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if count > MAX_TASKS_PER_MISSION as i64 || bytes > MAX_BYTES {
        return Err(MissionError::Capacity("execution graph"));
    }
    let mut tasks = Vec::new();
    let mut statement = tx.prepare("SELECT task_id,state,attempt,updated_at,digest,payload FROM tasks WHERE profile_id=?1 AND mission_id=?2 ORDER BY task_id LIMIT 65")?;
    let mut rows = statement.query(params![profile, mission_id])?;
    while let Some(row) = rows.next()? {
        let (id, state, attempt, updated, digest, payload): (
            String,
            String,
            i64,
            String,
            String,
            String,
        ) = (
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
            row.get(5)?,
        );
        let task = decode_task(&payload)?;
        let value = task.to_value();
        if task.id != id
            || task.mission_id != mission_id
            || task.state.as_str() != state
            || task.attempt as i64 != attempt
            || parse_utc(&updated).is_none()
            || canonical::to_string(&value) != payload
            || canonical::digest(&value) != digest
        {
            return Err(corrupt());
        }
        tasks.push(task);
    }
    let graph = TaskGraph {
        mission_id: mission_id.into(),
        tasks,
    };
    if graph.tasks.is_empty()
        || contract::task_graph(&graph.to_value(), "graph", &mut Vec::new()).is_none()
    {
        return Err(corrupt());
    }
    Ok(graph)
}
