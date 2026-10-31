//! Slice A operations on the core store: `mission.create`, `task.transition`,
//! `event.commit` and restart recovery. Each runs in one `BEGIN IMMEDIATE` transaction
//! and either commits completely or writes nothing (ADR 0014).
//!
//! - **Profiles.** Every query is scoped by the caller's profile ID (ADR 0024). Rows of
//!   another profile are never read back: an unknown mission is `NotFound`, and an ID that
//!   another profile already uses is a `Conflict` without that row's data.
//! - **Sequence.** Each mission has one journal with a sequence starting at 1 (the
//!   creation record), assigned inside the transaction; the caller's `sequence` is ignored.
//!   Sequence and caps come from the mission's running totals (`mission_totals`, schema 3),
//!   so a commit's cost does not grow with the journal.
//! - **Idempotency.** An event ID already stored with the same digest returns the original
//!   acknowledgement (`duplicate`), anything else with that ID is a conflict.
//! - **Leases.** Running work holds a lease (holder, expiry), renewed by its holder's
//!   activity. On open every lease is orphaned: the store lock proves the previous holder
//!   process is gone. [`CoreStore::recover`] turns in-flight tasks into `unknown` and their
//!   missions into `recovering`, records no event and replays nothing (ADR 0013).

use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Map, Value, json};

use super::CoreStore;
use super::execution_receipts::{admit, load_admission};
use super::planned_tasks;
use crate::mission::{
    AgentEvent, EventAck, HeartbeatAck, LEASE_TTL_MS, MAX_EVENT_BYTES, MAX_EVENT_BYTES_PER_MISSION,
    MAX_EVENTS_PER_MISSION, MAX_TASKS_PER_MISSION, Mission, MissionAck, MissionCreate,
    MissionError, MissionHeartbeat, MissionState, PlannedTaskMembership,
    PlannedTaskMembershipAvailability, SnapshotLease, Task, TaskState, TaskTransition,
    TransitionAck, Verification, canonical, contract, policy,
};
use crate::sha256;
use crate::time::{format_utc, parse_utc};

/// What restart recovery or a live lease-reaper transaction changed for one profile.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RecoveryReport {
    /// Missions moved to `recovering` (or whose recovery version advanced while quarantining live tasks).
    pub missions: u64,
    /// In-flight tasks moved to `unknown`.
    pub tasks: u64,
    /// Cleared leases with expiry at or before the transaction's supplied time.
    pub expired_leases: u64,
    /// Unexpired leases whose holder process is gone, leases of tasks that are no longer
    /// in flight, and running work without a lease. For live reaping, unexpired
    /// sibling leases cleared because the same mission now has uncertain work.
    pub orphaned_leases: u64,
}

const fn conflict(reason: &'static str) -> MissionError {
    MissionError::Conflict(reason)
}

const fn corrupt(reason: &'static str) -> MissionError {
    MissionError::Corrupt(reason)
}

/// Deterministic ID of a mission's creation record: a UUIDv8 from SHA-256, so an
/// identical create retry addresses the same journal row.
fn creation_event_id(mission_id: &str) -> String {
    let mut bytes = sha256::digest(format!("extalia.core/mission.create\0{mission_id}").as_bytes());
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

pub(super) fn decode_mission(payload: &str) -> Result<Mission, MissionError> {
    let value: Value = serde_json::from_str(payload).map_err(|_| corrupt("mission payload"))?;
    contract::mission(&value, "mission", &mut Vec::new()).ok_or(corrupt("mission payload"))
}

pub(super) fn decode_task(payload: &str) -> Result<Task, MissionError> {
    let value: Value = serde_json::from_str(payload).map_err(|_| corrupt("task payload"))?;
    contract::task(&value, "task", &mut Vec::new()).ok_or(corrupt("task payload"))
}

pub(super) fn load_mission(
    tx: &Transaction<'_>,
    profile: &str,
    mission_id: &str,
) -> Result<Mission, MissionError> {
    let payload: Option<String> = tx
        .query_row(
            "SELECT payload FROM missions WHERE profile_id = ?1 AND mission_id = ?2",
            params![profile, mission_id],
            |row| row.get(0),
        )
        .optional()?;
    let mission = decode_mission(&payload.ok_or(MissionError::NotFound)?)?;
    if mission.id != mission_id {
        return Err(corrupt("mission row"));
    }
    Ok(mission)
}

pub(super) fn load_task(
    tx: &Transaction<'_>,
    profile: &str,
    mission_id: &str,
    task_id: &str,
) -> Result<Task, MissionError> {
    let payload: Option<String> = tx
        .query_row(
            "SELECT payload FROM tasks WHERE profile_id = ?1 AND mission_id = ?2 AND task_id = ?3",
            params![profile, mission_id, task_id],
            |row| row.get(0),
        )
        .optional()?;
    let task = decode_task(&payload.ok_or(MissionError::NotFound)?)?;
    if task.id != task_id || task.mission_id != mission_id {
        return Err(corrupt("task row"));
    }
    Ok(task)
}

pub(super) fn save_mission(
    tx: &Transaction<'_>,
    profile: &str,
    mission: &Mission,
) -> Result<(), MissionError> {
    let value = mission.to_value();
    let changed = tx.execute(
        "UPDATE missions SET state = ?3, version = ?4, updated_at = ?5, digest = ?6, payload = ?7
         WHERE profile_id = ?1 AND mission_id = ?2",
        params![
            profile,
            mission.id,
            mission.state.as_str(),
            mission.version as i64,
            mission.updated_at,
            canonical::digest(&value),
            canonical::to_string(&value)
        ],
    )?;
    if changed == 1 {
        Ok(())
    } else {
        Err(corrupt("mission row"))
    }
}

pub(super) fn save_task(
    tx: &Transaction<'_>,
    profile: &str,
    task: &Task,
    now: &str,
) -> Result<(), MissionError> {
    let mut errors = Vec::new();
    contract::check_task(task, "task", &mut errors);
    if !errors.is_empty() {
        return Err(corrupt("task update would break the task contract"));
    }
    let value = task.to_value();
    let changed = tx.execute(
        "UPDATE tasks SET state = ?3, attempt = ?4, updated_at = ?5, digest = ?6, payload = ?7
         WHERE profile_id = ?1 AND task_id = ?2",
        params![
            profile,
            task.id,
            task.state.as_str(),
            task.attempt as i64,
            now,
            canonical::digest(&value),
            canonical::to_string(&value)
        ],
    )?;
    if changed == 1 {
        Ok(())
    } else {
        Err(corrupt("task row"))
    }
}

/// A stored event with this ID, in any profile.
struct StoredEvent {
    profile: String,
    mission_id: String,
    sequence: u64,
    digest: String,
}

fn stored_event(tx: &Transaction<'_>, event_id: &str) -> Result<Option<StoredEvent>, MissionError> {
    Ok(tx
        .query_row(
            "SELECT profile_id, mission_id, sequence, digest FROM events WHERE event_id = ?1",
            [event_id],
            |row| {
                Ok(StoredEvent {
                    profile: row.get(0)?,
                    mission_id: row.get(1)?,
                    sequence: row.get::<_, i64>(2)? as u64,
                    digest: row.get(3)?,
                })
            },
        )
        .optional()?)
}

/// The original acknowledgement of an identical retry, a conflict for any other reuse.
fn replay(
    stored: StoredEvent,
    profile: &str,
    mission_id: &str,
    digest: &str,
) -> Result<StoredEvent, MissionError> {
    if stored.profile == profile && stored.mission_id == mission_id && stored.digest == digest {
        Ok(stored)
    } else {
        Err(conflict("event ID is already used by another event"))
    }
}

/// One journal record to append. `record` has no `sequence`; the stored payload gets the
/// assigned one.
pub(super) struct Entry<'a> {
    profile: &'a str,
    mission_id: &'a str,
    task_id: Option<&'a str>,
    event_id: &'a str,
    event_type: &'a str,
    digest: &'a str,
    record: Map<String, Value>,
}

/// Append one record to a mission's journal under the caps; returns its sequence.
fn append(tx: &Transaction<'_>, entry: Entry<'_>, now: &str) -> Result<u64, MissionError> {
    let Entry {
        profile,
        mission_id,
        task_id,
        event_id,
        event_type,
        digest,
        mut record,
    } = entry;
    // Running totals (migration 3), kept equal to the journal's aggregates by triggers in this
    // transaction: one primary-key read instead of a scan of the mission's journal.
    let totals: Option<(i64, i64, i64)> = tx
        .query_row(
            "SELECT event_count, last_sequence, payload_bytes
             FROM mission_totals WHERE profile_id = ?1 AND mission_id = ?2",
            params![profile, mission_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let (count, last, bytes) = totals.ok_or(corrupt("mission totals"))?;
    if count != last {
        return Err(corrupt("mission journal has a gap"));
    }
    if count as u64 >= MAX_EVENTS_PER_MISSION {
        return Err(MissionError::Capacity("events per mission"));
    }
    let sequence = count as u64 + 1;
    record.insert("sequence".into(), sequence.into());
    let payload = canonical::to_string(&Value::Object(record));
    if payload.len() > MAX_EVENT_BYTES {
        return Err(MissionError::Capacity("event size"));
    }
    if bytes as u64 + payload.len() as u64 > MAX_EVENT_BYTES_PER_MISSION {
        return Err(MissionError::Capacity("event bytes per mission"));
    }
    tx.execute(
        "INSERT INTO events (event_id, profile_id, mission_id, task_id, sequence, event_type, committed_at, digest, payload)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            event_id,
            profile,
            mission_id,
            task_id,
            sequence as i64,
            event_type,
            now,
            digest,
            payload
        ],
    )?;
    Ok(sequence)
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => unreachable!("records are objects"),
    }
}

/// `max(now, current)` as a contract timestamp, so `updatedAt` never moves backwards.
pub(super) fn later(now: i64, current: &str) -> String {
    format_utc(now.max(parse_utc(current).unwrap_or(now)))
}

/// Read and fence the task's exact current epoch before accepting new activity.
pub(super) fn live_lease(
    tx: &Transaction<'_>,
    profile: &str,
    task: &Task,
    now: i64,
) -> Result<SnapshotLease, MissionError> {
    let lease: Option<SnapshotLease> = tx.query_row(
        "SELECT lease_id, holder_agent_id, acquired_at, expires_at FROM leases WHERE profile_id = ?1 AND task_id = ?2",
        params![profile, task.id], |row| Ok(SnapshotLease {
            lease_id: row.get(0)?, task_id: task.id.clone(), holder_agent_id: row.get(1)?,
            acquired_at: row.get(2)?, expires_at: row.get(3)?,
        }),
    ).optional()?;
    let lease = lease.ok_or_else(|| conflict("task has no current lease"))?;
    if task.lease_id.as_deref() != Some(lease.lease_id.as_str())
        || task.assigned_agent_id.as_deref() != Some(lease.holder_agent_id.as_str())
    {
        return Err(corrupt("task lease ownership"));
    }
    let acquired = parse_utc(&lease.acquired_at).ok_or_else(|| corrupt("lease acquisition"))?;
    let expires = parse_utc(&lease.expires_at).ok_or_else(|| corrupt("lease expiry"))?;
    if expires <= acquired {
        return Err(corrupt("lease time order"));
    }
    if expires <= now {
        return Err(conflict("task lease expired"));
    }
    Ok(lease)
}

fn renew_lease(
    tx: &Transaction<'_>,
    profile: &str,
    task: &Task,
    now: i64,
) -> Result<SnapshotLease, MissionError> {
    let mut lease = live_lease(tx, profile, task, now)?;
    let expires = parse_utc(&lease.expires_at).ok_or_else(|| corrupt("lease expiry"))?;
    // A clock adjustment cannot shorten a lease already granted, or revive an expired epoch.
    lease.expires_at = format_utc(expires.max(now.saturating_add(LEASE_TTL_MS)));
    let changed = tx.execute(
        "UPDATE leases SET expires_at = ?3 WHERE profile_id = ?1 AND task_id = ?2 AND lease_id = ?4 AND holder_agent_id = ?5",
        params![profile, task.id, lease.expires_at, lease.lease_id, lease.holder_agent_id],
    )?;
    if changed != 1 {
        return Err(corrupt("lease renewal"));
    }
    Ok(lease)
}

fn fence_mission_leases(
    tx: &Transaction<'_>,
    profile: &str,
    mission_id: &str,
    now: i64,
) -> Result<(), MissionError> {
    let payloads = tx
        .prepare("SELECT payload FROM tasks WHERE profile_id = ?1 AND mission_id = ?2 LIMIT 65")?
        .query_map(params![profile, mission_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if payloads.len() > MAX_TASKS_PER_MISSION {
        return Err(corrupt("mission task count"));
    }
    for payload in payloads {
        let task = decode_task(&payload)?;
        if task.lease_id.is_some()
            || matches!(
                task.state,
                TaskState::Running
                    | TaskState::Waiting
                    | TaskState::AwaitingApproval
                    | TaskState::Verifying
            )
        {
            live_lease(tx, profile, &task, now)?;
        }
    }
    Ok(())
}

/// Commit `tx`, unless a test injected a failure after the writes: dropping the
/// transaction then rolls every write back, as a crash before the commit would.
pub(super) fn finish(tx: Transaction<'_>, inject_failure: bool) -> Result<(), MissionError> {
    if inject_failure {
        return Err(MissionError::Storage(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_IOERR),
            Some("injected failure before commit".into()),
        )));
    }
    tx.commit()?;
    Ok(())
}

impl CoreStore {
    #[cfg(test)]
    pub(super) fn inject_failure(&self) -> bool {
        self.fail_before_commit.get()
    }

    /// Renew exact, live lease epochs atomically. Heartbeats are independent of the
    /// bounded mission journal and never alter task attempts or mission versions.
    pub fn heartbeat_mission(
        &mut self,
        profile: &str,
        heartbeat: &MissionHeartbeat,
        now: i64,
    ) -> Result<HeartbeatAck, MissionError> {
        if !(1..=MAX_TASKS_PER_MISSION).contains(&heartbeat.leases.len())
            || contract::mission_heartbeat(&heartbeat.to_value(), "heartbeat", &mut Vec::new())
                .is_none()
        {
            return Err(MissionError::Invalid("invalid heartbeat claims"));
        }
        let inject = self.inject_failure();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mission = load_mission(&tx, profile, &heartbeat.mission_id)?;
        if mission.state.terminal() || mission.state == MissionState::Recovering {
            return Err(conflict("mission cannot accept heartbeats"));
        }
        let mut tasks = Vec::with_capacity(heartbeat.leases.len());
        for claim in &heartbeat.leases {
            let task = load_task(&tx, profile, &heartbeat.mission_id, &claim.task_id)?;
            if !task.state.in_flight()
                || task.lease_id.as_deref() != Some(claim.lease_id.as_str())
                || task.assigned_agent_id.as_deref() != Some(claim.holder_agent_id.as_str())
            {
                return Err(conflict("heartbeat does not own this task epoch"));
            }
            let lease = live_lease(&tx, profile, &task, now)?;
            if lease.lease_id != claim.lease_id || lease.holder_agent_id != claim.holder_agent_id {
                return Err(conflict("heartbeat does not own this lease"));
            }
            tasks.push(task);
        }
        let leases = tasks
            .iter()
            .map(|task| renew_lease(&tx, profile, task, now))
            .collect::<Result<Vec<_>, _>>()?;
        finish(tx, inject)?;
        Ok(HeartbeatAck {
            mission_id: heartbeat.mission_id.clone(),
            leases,
        })
    }

    #[cfg(not(test))]
    pub(super) fn inject_failure(&self) -> bool {
        false
    }

    /// Create a fresh mission, its tasks and the journal's creation record together.
    pub fn create_mission(
        &mut self,
        profile: &str,
        create: &MissionCreate,
        now: i64,
    ) -> Result<MissionAck, MissionError> {
        let MissionCreate { mission, graph } = create;
        if graph.tasks.len() > MAX_TASKS_PER_MISSION {
            return Err(MissionError::Capacity("tasks per mission"));
        }
        if profile.is_empty()
            || profile.len() > 200
            || contract::mission_create(&create.to_value(), "create", &mut Vec::new()).as_ref()
                != Some(create)
        {
            return Err(MissionError::Invalid("invalid mission creation contract"));
        }
        if graph.tasks.is_empty() || graph.mission_id != mission.id {
            return Err(MissionError::Invalid("a mission needs its own task graph"));
        }
        // A fresh plan only, as the native runtime accepts it (`runNativeMission`).
        if !matches!(
            mission.state,
            MissionState::Draft | MissionState::Planning | MissionState::Queued
        ) || graph.tasks.iter().any(|task| {
            task.state != TaskState::Queued
                || task.attempt != 0
                || task.lease_id.is_some()
                || !task.evidence_ids.is_empty()
                || task.verification.is_some()
        }) {
            return Err(MissionError::Invalid(
                "only a fresh mission with queued tasks can be created",
            ));
        }
        let ack = MissionAck {
            mission_id: mission.id.clone(),
            version: mission.version,
        };
        let mission_value = mission.to_value();
        let mission_payload = canonical::to_string(&mission_value);
        let membership = PlannedTaskMembership::capture(profile, create);
        if canonical::to_string(&membership.to_value()).len() > 1024 * 1024 {
            return Err(MissionError::Capacity("original planned tasks"));
        }
        let now_text = format_utc(now);
        let inject = self.inject_failure();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<(String, String)> = tx
            .query_row(
                "SELECT profile_id, payload FROM missions WHERE mission_id = ?1",
                [&mission.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((owner, payload)) = existing {
            if owner != profile || payload != mission_payload {
                return Err(conflict("mission ID is already used"));
            }
            let mut stored: Vec<(String, String)> =
                planned_tasks::current_graph(&tx, profile, &mission.id)?
                    .tasks
                    .into_iter()
                    .map(|task| (task.id.clone(), canonical::to_string(&task.to_value())))
                    .collect();
            let mut requested: Vec<(String, String)> = graph
                .tasks
                .iter()
                .map(|task| (task.id.clone(), canonical::to_string(&task.to_value())))
                .collect();
            stored.sort();
            requested.sort();
            return if stored == requested {
                if let PlannedTaskMembershipAvailability::Available(original) =
                    planned_tasks::load(&tx, profile, mission)?
                    && original != membership
                {
                    return Err(conflict("original planned tasks differ"));
                }
                Ok(ack)
            } else {
                Err(conflict("mission ID is already used"))
            };
        }
        tx.execute(
            "INSERT INTO missions (mission_id, profile_id, workspace_id, state, version, created_at, updated_at, digest, payload)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                mission.id,
                profile,
                mission.workspace_id,
                mission.state.as_str(),
                mission.version as i64,
                mission.created_at,
                mission.updated_at,
                canonical::digest(&mission_value),
                mission_payload
            ],
        )?;
        for task in &graph.tasks {
            let used: bool = tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM tasks WHERE task_id = ?1)",
                [&task.id],
                |row| row.get(0),
            )?;
            if used {
                return Err(conflict("task ID is already used"));
            }
            let value = task.to_value();
            tx.execute(
                "INSERT INTO tasks (task_id, profile_id, mission_id, state, attempt, updated_at, digest, payload)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    task.id,
                    profile,
                    mission.id,
                    task.state.as_str(),
                    task.attempt as i64,
                    now_text,
                    canonical::digest(&value),
                    canonical::to_string(&value)
                ],
            )?;
        }
        planned_tasks::capture(&tx, profile, &membership)?;
        let record = json!({
            "record": "mission.create", "type": "mission.state", "missionId": mission.id,
            "state": mission.state.as_str(), "version": mission.version,
        });
        let event_id = creation_event_id(&mission.id);
        if stored_event(&tx, &event_id)?.is_some() {
            return Err(conflict("event ID is already used by another event"));
        }
        let digest = canonical::digest(&record);
        let entry = Entry {
            profile,
            mission_id: &mission.id,
            task_id: None,
            event_id: &event_id,
            event_type: "mission.state",
            digest: &digest,
            record: object(record),
        };
        append(&tx, entry, &now_text)?;
        finish(tx, inject)?;
        Ok(ack)
    }

    /// Compare-and-set one task state, journaled as a `task.state` record with the
    /// caller's event ID. Entering running work acquires the task's lease; leaving it
    /// releases the lease.
    pub fn transition_task(
        &mut self,
        profile: &str,
        transition: &TaskTransition,
        now: i64,
    ) -> Result<TransitionAck, MissionError> {
        let TaskTransition {
            mission_id,
            task_id,
            event_id,
            from,
            to,
            supervisor_id,
        } = transition;
        let (from, to) = (*from, *to);
        let starts =
            to == TaskState::Running && matches!(from, TaskState::Queued | TaskState::Assigned);
        if supervisor_id
            .as_ref()
            .is_some_and(|id| !starts || !contract::is_uuid(id))
        {
            return Err(MissionError::Invalid(
                "supervisorId is only valid for new running admissions",
            ));
        }
        let digest = canonical::digest(&transition.to_value());
        let now_text = format_utc(now);
        let inject = self.inject_failure();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(stored) = stored_event(&tx, event_id)? {
            let stored = replay(stored, profile, mission_id, &digest)?;
            if starts {
                let mission = load_mission(&tx, profile, mission_id)?;
                let graph = planned_tasks::current_graph(&tx, profile, mission_id)?;
                planned_tasks::guard(&tx, profile, &mission, &graph)?;
            }
            let admission = if supervisor_id.is_some() {
                Some(
                    load_admission(&tx, profile, mission_id, event_id)?
                        .ok_or_else(|| corrupt("missing execution admission"))?,
                )
            } else {
                None
            };
            return Ok(TransitionAck {
                mission_id: mission_id.clone(),
                task_id: task_id.clone(),
                state: to,
                sequence: stored.sequence,
                admission,
            });
        }
        let mission = load_mission(&tx, profile, mission_id)?;
        if starts {
            let graph = planned_tasks::current_graph(&tx, profile, mission_id)?;
            planned_tasks::guard(&tx, profile, &mission, &graph)?;
        }
        let mut task = load_task(&tx, profile, mission_id, task_id)?;
        if task.state != from {
            return Err(conflict("task state changed"));
        }
        if !from.can_transition_to(to) {
            return Err(MissionError::Invalid("task transition is not allowed"));
        }
        if mission.state.terminal() {
            return Err(conflict("mission is finished"));
        }
        if mission.state == MissionState::Recovering {
            return Err(conflict("mission is recovering; task changes are refused"));
        }
        if task.lease_id.is_some()
            || matches!(
                from,
                TaskState::Running
                    | TaskState::Waiting
                    | TaskState::AwaitingApproval
                    | TaskState::Verifying
            )
        {
            live_lease(&tx, profile, &task, now)?;
        }
        if to.in_flight() && task.assigned_agent_id.is_none() {
            return Err(conflict("task has no assignee"));
        }
        if starts {
            for dependency in &task.depends_on {
                let state = load_task(&tx, profile, mission_id, dependency)?.state;
                if state != TaskState::Completed {
                    return Err(conflict("task dependencies are not completed"));
                }
            }
            task.attempt += 1;
        }
        let leased = matches!(
            to,
            TaskState::Running
                | TaskState::Waiting
                | TaskState::AwaitingApproval
                | TaskState::Verifying
        );
        if leased && task.lease_id.is_some() {
            renew_lease(&tx, profile, &task, now)?;
        } else if leased {
            if to != TaskState::Running {
                return Err(corrupt("in-flight task without a lease"));
            }
            tx.execute(
                "INSERT INTO leases (lease_id, profile_id, task_id, holder_agent_id, acquired_at, expires_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    event_id,
                    profile,
                    task.id,
                    task.assigned_agent_id,
                    now_text,
                    format_utc(now + LEASE_TTL_MS)
                ],
            )?;
            task.lease_id = Some(event_id.clone());
        } else {
            tx.execute(
                "DELETE FROM leases WHERE profile_id = ?1 AND task_id = ?2",
                params![profile, task.id],
            )?;
            task.lease_id = None;
        }
        if to == TaskState::Completed && task.verification.is_none() {
            // Completion is a claim; only evidence can make it verified.
            task.verification = Some(Verification::Unverified);
        }
        task.state = to;
        save_task(&tx, profile, &task, &now_text)?;
        let mut record = object(json!({
            "record": "task.transition", "type": "task.state", "eventId": event_id,
            "missionId": mission_id, "taskId": task_id, "from": from.as_str(), "to": to.as_str(),
            "state": to.as_str(),
        }));
        if let Some(supervisor) = supervisor_id {
            record.insert("supervisorId".into(), supervisor.clone().into());
        }
        let entry = Entry {
            profile,
            mission_id,
            task_id: Some(task_id),
            event_id,
            event_type: "task.state",
            digest: &digest,
            record,
        };
        let sequence = append(&tx, entry, &now_text)?;
        let admission = if let Some(supervisor) = supervisor_id {
            Some(admit(&tx, profile, &mission, &task, supervisor, &now_text)?)
        } else {
            None
        };
        finish(tx, inject)?;
        Ok(TransitionAck {
            mission_id: mission_id.clone(),
            task_id: task_id.clone(),
            state: to,
            sequence,
            admission,
        })
    }

    /// Commit one native mission control event (ADR 0014). A `mission.state` event by the
    /// mission lead applies that mission state; task events must match the stored task.
    pub fn commit_event(
        &mut self,
        profile: &str,
        event: &AgentEvent,
        now: i64,
    ) -> Result<EventAck, MissionError> {
        let Some(mission_id) = event.mission_id() else {
            return Err(MissionError::Invalid(
                "mission control events name their mission",
            ));
        };
        let admission = policy::admit(event)?;
        let normalized = event.normalized();
        let digest = canonical::digest(&normalized);
        let now_text = format_utc(now);
        let inject = self.inject_failure();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(stored) = stored_event(&tx, event.id())? {
            let stored = replay(stored, profile, mission_id, &digest)?;
            return Ok(EventAck {
                event_id: event.id().to_owned(),
                mission_id: mission_id.to_owned(),
                sequence: stored.sequence,
                duplicate: true,
            });
        }
        let mut mission = load_mission(&tx, profile, mission_id)?;
        if event.workspace_id() != mission.workspace_id {
            return Err(conflict("event belongs to another workspace"));
        }
        let session: Option<String> = tx
            .query_row(
                "SELECT json_extract(payload, '$.sessionId') FROM events
                 WHERE profile_id = ?1 AND mission_id = ?2 AND json_extract(payload, '$.sessionId') IS NOT NULL
                 ORDER BY sequence LIMIT 1",
                params![profile, mission_id],
                |row| row.get(0),
            )
            .optional()?;
        if session.is_some_and(|session| session != event.session_id()) {
            return Err(conflict("event belongs to another session"));
        }
        if mission.state.terminal() {
            return Err(conflict("mission is finished"));
        }
        if mission.state == MissionState::Recovering {
            return Err(conflict("mission is recovering; late events are refused"));
        }
        let body = event.body();
        let state = body.get("state").and_then(Value::as_str);
        if event.body_type() == "mission.state" {
            if event.agent_id() != Some(mission.lead_agent_id.as_str()) {
                return Err(conflict("only the mission lead reports mission state"));
            }
            fence_mission_leases(&tx, profile, mission_id, now)?;
            let to = state
                .and_then(MissionState::parse)
                .ok_or(corrupt("event body"))?;
            if to != mission.state {
                if !mission.state.can_transition_to(to) {
                    return Err(conflict("mission state change is not allowed"));
                }
                mission.state = to;
                mission.version += 1;
                mission.updated_at = later(now, &mission.updated_at);
                save_mission(&tx, profile, &mission)?;
            }
        } else {
            let task_id = event.task_id().ok_or(corrupt("event task"))?;
            let task = load_task(&tx, profile, mission_id, task_id)?;
            if task.assigned_agent_id.as_deref() != event.agent_id() {
                return Err(conflict("event agent is not the task's assignee"));
            }
            if task.lease_id.is_some()
                || matches!(
                    task.state,
                    TaskState::Running
                        | TaskState::Waiting
                        | TaskState::AwaitingApproval
                        | TaskState::Verifying
                )
            {
                live_lease(&tx, profile, &task, now)?;
            }
            // Edit activity only for a write-capable worker (ADR 0028); read-only tasks keep refusing it.
            if !admission.permits(task.write_access) {
                return Err(MissionError::Invalid(
                    "edit activity needs a write-capable task",
                ));
            }
            match event.body_type() {
                "task.state" => {
                    if state != Some(task.state.as_str()) {
                        return Err(conflict("task state differs; use task.transition"));
                    }
                }
                "task.assigned" => {
                    let assignee = body.get("assigneeAgentId").and_then(Value::as_str);
                    if assignee != task.assigned_agent_id.as_deref()
                        || !matches!(task.state, TaskState::Queued | TaskState::Assigned)
                    {
                        return Err(conflict("assignment does not match the task"));
                    }
                }
                _ => {
                    // Activity of running work; it renews the holder's lease.
                    if !task.state.in_flight() {
                        return Err(conflict("task is not in flight"));
                    }
                    renew_lease(&tx, profile, &task, now)?;
                }
            }
        }
        let entry = Entry {
            profile,
            mission_id,
            task_id: event.task_id(),
            event_id: event.id(),
            event_type: event.body_type(),
            digest: &digest,
            record: object(normalized),
        };
        let sequence = append(&tx, entry, &now_text)?;
        finish(tx, inject)?;
        Ok(EventAck {
            event_id: event.id().to_owned(),
            mission_id: mission_id.to_owned(),
            sequence,
            duplicate: false,
        })
    }

    /// Restart recovery for one profile, before serving any request: in-flight tasks
    /// become `unknown` and release their leases, their missions (and active missions)
    /// become `recovering`. Nothing is replayed and no event is synthesized (ADR 0013,
    /// ADR 0014). Other profiles are untouched.
    pub fn recover(&mut self, profile: &str, now: i64) -> Result<RecoveryReport, MissionError> {
        let now_text = format_utc(now);
        let mut report = RecoveryReport::default();
        let inject = self.inject_failure();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let in_flight: Vec<(String, String)> = tx
            .prepare(
                "SELECT mission_id, payload FROM tasks WHERE profile_id = ?1
                 AND state IN ('assigned', 'running', 'waiting', 'awaiting_approval', 'verifying')
                 ORDER BY mission_id, task_id",
            )?
            .query_map([profile], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut missions: Vec<String> = Vec::new();
        for (mission_id, payload) in in_flight {
            let mut task = decode_task(&payload)?;
            let expires: Option<String> = tx
                .query_row(
                    "SELECT expires_at FROM leases WHERE profile_id = ?1 AND task_id = ?2",
                    params![profile, task.id],
                    |row| row.get(0),
                )
                .optional()?;
            match expires.map(|expires| parse_utc(&expires)) {
                Some(Some(expires)) if expires <= now => report.expired_leases += 1,
                Some(_) => report.orphaned_leases += 1,
                None if task.state == TaskState::Running => report.orphaned_leases += 1,
                None => {}
            }
            tx.execute(
                "DELETE FROM leases WHERE profile_id = ?1 AND task_id = ?2",
                params![profile, task.id],
            )?;
            task.state = TaskState::Unknown;
            task.lease_id = None;
            save_task(&tx, profile, &task, &now_text)?;
            report.tasks += 1;
            if missions.last() != Some(&mission_id) {
                missions.push(mission_id);
            }
        }
        report.orphaned_leases +=
            tx.execute("DELETE FROM leases WHERE profile_id = ?1", [profile])? as u64;
        let active: Vec<String> = tx
            .prepare(
                "SELECT mission_id FROM missions WHERE profile_id = ?1
                 AND state IN ('running', 'waiting', 'awaiting_approval', 'reviewing')",
            )?
            .query_map([profile], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        missions.extend(active);
        missions.sort();
        missions.dedup();
        for mission_id in missions {
            let mut mission = load_mission(&tx, profile, &mission_id)?;
            if mission.state.terminal() || mission.state == MissionState::Recovering {
                continue;
            }
            mission.state = MissionState::Recovering;
            mission.version += 1;
            mission.updated_at = later(now, &mission.updated_at);
            save_mission(&tx, profile, &mission)?;
            report.missions += 1;
        }
        // Older frozen migration fixtures have no intent records. Production opens
        // the complete schema; recovery invalidates pending intents with its leases.
        if tx.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))? >= 10 {
            super::native_action_requests::expire_profile(&tx, profile, now)?;
        }
        finish(tx, inject)?;
        Ok(report)
    }
}

/// Hooks for the store tests in this adapter.
#[cfg(test)]
pub(super) mod tests_support {
    use super::{Entry, MissionError, Transaction};
    use serde_json::{Map, Value};

    const DIGEST: &str = "0000000000000000000000000000000000000000000000000000000000000000";

    pub(in crate::adapters::sqlite) fn entry<'a>(
        profile: &'a str,
        mission_id: &'a str,
        event_id: &'a str,
        record: Map<String, Value>,
    ) -> Entry<'a> {
        Entry {
            profile,
            mission_id,
            task_id: None,
            event_id,
            event_type: "agent.state",
            digest: DIGEST,
            record,
        }
    }

    pub(in crate::adapters::sqlite) fn append(
        tx: &Transaction<'_>,
        entry: Entry<'_>,
    ) -> Result<u64, MissionError> {
        super::append(tx, entry, "2026-10-22T12:00:00.000Z")
    }
}
