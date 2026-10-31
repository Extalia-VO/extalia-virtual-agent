//! Read-only authoritative inspection. The deferred transaction pins one SQLite snapshot;
//! no transition, recovery, renewal, journal append or other execution effect occurs here.
use std::collections::HashSet;

use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};

use super::CoreStore;
use super::missions::{decode_mission, decode_task};
use crate::mission::{
    MAX_EVENT_BYTES_PER_MISSION, MAX_EVENTS_PER_MISSION, MAX_TASKS_PER_MISSION, MissionError,
    MissionSnapshot, SnapshotLease, SnapshotTask, TaskGraph, TaskState, canonical, contract,
};
use crate::time::parse_utc;

const MAX_PAYLOAD_BYTES: i64 = 1024 * 1024;
const fn corrupt() -> MissionError {
    MissionError::Corrupt("mission snapshot invariants")
}

fn canonical_payload(value: &serde_json::Value, payload: &str, digest: &str) -> bool {
    canonical::to_string(value) == payload && canonical::digest(value) == digest
}

impl CoreStore {
    /// Return this profile's complete canonical graph and recorded leases atomically.
    /// Foreign-profile and missing IDs both return `NotFound` without exposing identity.
    pub fn mission_snapshot(
        &mut self,
        profile: &str,
        mission_id: &str,
    ) -> Result<MissionSnapshot, MissionError> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Deferred)?;
        let snapshot = snapshot_in_transaction(&tx, profile, mission_id)?;
        tx.commit()?;
        Ok(snapshot)
    }
}

/// The same complete invariant checks under an existing transaction, for atomic reaping.
pub(super) fn snapshot_in_transaction(
    tx: &Transaction<'_>,
    profile: &str,
    mission_id: &str,
) -> Result<MissionSnapshot, MissionError> {
    if !contract::is_uuid(mission_id) {
        return Err(MissionError::Invalid("invalid mission ID"));
    }
    // Bound the stored payloads before retrieving/decoding them. One task graph is
    // admitted through a bounded daemon frame, and inspection never needs the journal
    // bodies (up to 8 MiB), only its bounded aggregates.
    let mission_bytes: Option<i64> = tx.query_row(
        "SELECT length(CAST(payload AS BLOB)) FROM missions WHERE profile_id = ?1 AND mission_id = ?2",
        params![profile, mission_id], |row| row.get(0),
    ).optional()?;
    let mission_bytes = mission_bytes.ok_or(MissionError::NotFound)?;
    let (task_count, task_bytes): (i64, i64) = tx.query_row(
        "SELECT count(*), coalesce(sum(length(CAST(payload AS BLOB))), 0) FROM (SELECT payload FROM tasks WHERE profile_id = ?1 AND mission_id = ?2 LIMIT 65)",
        params![profile, mission_id], |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if task_count == 0 {
        return Err(corrupt());
    }
    if task_count > MAX_TASKS_PER_MISSION as i64 || mission_bytes + task_bytes > MAX_PAYLOAD_BYTES {
        return Err(MissionError::Capacity("mission snapshot payload"));
    }
    let mission = tx.query_row(
        "SELECT workspace_id, state, version, created_at, updated_at, digest, payload FROM missions WHERE profile_id = ?1 AND mission_id = ?2",
        params![profile, mission_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?)),
    )?;
    let (workspace, state, version, created_at, updated_at, digest, payload) = mission;
    let mission = decode_mission(&payload)?;
    if mission.id != mission_id
        || mission.workspace_id != workspace
        || mission.state.as_str() != state
        || mission.version as i64 != version
        || mission.created_at != created_at
        || mission.updated_at != updated_at
        || !canonical_payload(&mission.to_value(), &payload, &digest)
    {
        return Err(corrupt());
    }
    let mut tasks = Vec::new();
    {
        let mut statement = tx.prepare("SELECT task_id, state, attempt, updated_at, digest, payload FROM tasks WHERE profile_id = ?1 AND mission_id = ?2 ORDER BY task_id LIMIT 65")?;
        let mut rows = statement.query(params![profile, mission_id])?;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let state: String = row.get(1)?;
            let attempt: i64 = row.get(2)?;
            let updated: String = row.get(3)?;
            let digest: String = row.get(4)?;
            let payload: String = row.get(5)?;
            let task = decode_task(&payload)?;
            if task.id != id
                || task.mission_id != mission_id
                || task.state.as_str() != state
                || task.attempt as i64 != attempt
                || parse_utc(&updated).is_none()
                || !canonical_payload(&task.to_value(), &payload, &digest)
            {
                return Err(corrupt());
            }
            tasks.push(task);
        }
    }
    let graph = TaskGraph {
        mission_id: mission_id.into(),
        tasks,
    };
    contract::task_graph(&graph.to_value(), "graph", &mut Vec::new()).ok_or(corrupt())?;
    let mut leases = Vec::new();
    let mut leased_tasks = HashSet::new();
    {
        let mut statement = tx.prepare("SELECT l.lease_id, l.task_id, l.holder_agent_id, l.acquired_at, l.expires_at FROM leases l JOIN tasks t ON t.profile_id = l.profile_id AND t.task_id = l.task_id WHERE l.profile_id = ?1 AND t.mission_id = ?2 ORDER BY l.task_id LIMIT 65")?;
        let mut rows = statement.query(params![profile, mission_id])?;
        while let Some(row) = rows.next()? {
            let lease = SnapshotLease {
                lease_id: row.get(0)?,
                task_id: row.get(1)?,
                holder_agent_id: row.get(2)?,
                acquired_at: row.get(3)?,
                expires_at: row.get(4)?,
            };
            let task = graph
                .tasks
                .iter()
                .find(|task| task.id == lease.task_id)
                .ok_or(corrupt())?;
            if !contract::is_uuid(&lease.lease_id)
                || !contract::is_uuid(&lease.holder_agent_id)
                || task.lease_id.as_ref() != Some(&lease.lease_id)
                || task.assigned_agent_id.as_ref() != Some(&lease.holder_agent_id)
                || !task.state.in_flight()
                || task.state == TaskState::Assigned
                || !leased_tasks.insert(lease.task_id.clone())
            {
                return Err(corrupt());
            }
            let acquired = parse_utc(&lease.acquired_at).ok_or(corrupt())?;
            let expires = parse_utc(&lease.expires_at).ok_or(corrupt())?;
            if expires < acquired {
                return Err(corrupt());
            }
            leases.push(lease);
        }
    }
    for task in &graph.tasks {
        let needs_lease = task.state.in_flight() && task.state != TaskState::Assigned;
        if needs_lease != leased_tasks.contains(&task.id) || task.lease_id.is_some() != needs_lease
        {
            return Err(corrupt());
        }
    }
    let (count, first, last, bytes): (i64, i64, i64, i64) = tx.query_row(
        "SELECT count(*), coalesce(min(sequence), 0), coalesce(max(sequence), 0), coalesce(sum(length(CAST(payload AS BLOB))), 0) FROM (SELECT sequence, payload FROM events WHERE profile_id = ?1 AND mission_id = ?2 LIMIT 8193)",
        params![profile, mission_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    let totals: Option<(i64, i64, i64)> = tx.query_row(
        "SELECT event_count, last_sequence, payload_bytes FROM mission_totals WHERE profile_id = ?1 AND mission_id = ?2",
        params![profile, mission_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional()?;
    if first != 1
        || count != last
        || !(1..=MAX_EVENTS_PER_MISSION as i64).contains(&last)
        || !(1..=MAX_EVENT_BYTES_PER_MISSION as i64).contains(&bytes)
        || totals != Some((count, last, bytes))
    {
        return Err(corrupt());
    }
    let snapshot = MissionSnapshot {
        mission_id: mission.id,
        workspace_id: mission.workspace_id,
        version: mission.version,
        state: mission.state,
        updated_at: mission.updated_at,
        sequence: last as u64,
        tasks: graph
            .tasks
            .into_iter()
            .map(|task| SnapshotTask {
                task_id: task.id,
                assigned_agent_id: task.assigned_agent_id,
                state: task.state,
                attempt: task.attempt,
            })
            .collect(),
        leases,
    };
    Ok(snapshot)
}
