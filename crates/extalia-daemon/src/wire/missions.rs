//! Wire mapping of the slice A operations (`mission.create`, `task.transition`,
//! `event.commit`). Parameters are validated by the core's orchestration contract rules
//! (`extalia_core::mission::contract`), so the daemon and the store share one validator;
//! results are checked here like the other results.

use extalia_core::mission::{AgentEvent, EventAck, MissionAck, TaskState, TransitionAck, contract};
use serde_json::{Map, Value};

use super::{Check, MAX_SAFE_INTEGER, RequestParams, ResponseResult, object};

const PARAMS: &str = "frame.params";
const RESULT: &str = "frame.result";

pub(super) fn mission_create(check: &mut Check, params: &Value) -> Option<RequestParams> {
    contract::mission_create(params, PARAMS, &mut check.errors).map(RequestParams::MissionCreate)
}

pub(super) fn task_transition(check: &mut Check, params: &Value) -> Option<RequestParams> {
    contract::task_transition(params, PARAMS, &mut check.errors).map(RequestParams::TaskTransition)
}

pub(super) fn event_commit(check: &mut Check, params: &Value) -> Option<RequestParams> {
    contract::event_commit(params, PARAMS, &mut check.errors).map(RequestParams::EventCommit)
}

pub(super) fn event_commit_params(event: &AgentEvent) -> Value {
    object([("event", event.to_value())])
}

fn sequence(check: &mut Check, fields: &Map<String, Value>) -> Option<u64> {
    fields
        .get("sequence")
        .and_then(|value| check.integer(value, "frame.result.sequence", 1, MAX_SAFE_INTEGER))
}

pub(super) fn mission_create_result(check: &mut Check, result: &Value) -> Option<ResponseResult> {
    let fields = check.object(result, RESULT, &["missionId", "version"], &[])?;
    let mission_id = check.uuid(fields.get("missionId"), "frame.result.missionId");
    let version = fields
        .get("version")
        .and_then(|value| check.integer(value, "frame.result.version", 1, MAX_SAFE_INTEGER));
    Some(ResponseResult::MissionCreate(MissionAck {
        mission_id: mission_id?,
        version: version?,
    }))
}

pub(super) fn task_transition_result(check: &mut Check, result: &Value) -> Option<ResponseResult> {
    let fields = check.object(
        result,
        RESULT,
        &["missionId", "taskId", "state", "sequence"],
        &[],
    )?;
    let mission_id = check.uuid(fields.get("missionId"), "frame.result.missionId");
    let task_id = check.uuid(fields.get("taskId"), "frame.result.taskId");
    let state = check.name(fields.get("state"), "frame.result.state", TaskState::parse);
    let sequence = sequence(check, fields);
    Some(ResponseResult::TaskTransition(TransitionAck {
        mission_id: mission_id?,
        task_id: task_id?,
        state: state?,
        sequence: sequence?,
    }))
}

pub(super) fn event_commit_result(check: &mut Check, result: &Value) -> Option<ResponseResult> {
    let fields = check.object(
        result,
        RESULT,
        &["eventId", "missionId", "sequence", "duplicate"],
        &[],
    )?;
    let event_id = check.uuid(fields.get("eventId"), "frame.result.eventId");
    let mission_id = check.uuid(fields.get("missionId"), "frame.result.missionId");
    let sequence = sequence(check, fields);
    let duplicate = fields.get("duplicate").and_then(|value| {
        let flag = value.as_bool();
        if flag.is_none() {
            check.fail("frame.result.duplicate", "expected a boolean");
        }
        flag
    });
    Some(ResponseResult::EventCommit(EventAck {
        event_id: event_id?,
        mission_id: mission_id?,
        sequence: sequence?,
        duplicate: duplicate?,
    }))
}

pub(super) fn mission_ack_value(ack: &MissionAck) -> Value {
    object([
        ("missionId", ack.mission_id.clone().into()),
        ("version", ack.version.into()),
    ])
}

pub(super) fn transition_ack_value(ack: &TransitionAck) -> Value {
    object([
        ("missionId", ack.mission_id.clone().into()),
        ("taskId", ack.task_id.clone().into()),
        ("state", ack.state.as_str().into()),
        ("sequence", ack.sequence.into()),
    ])
}

pub(super) fn event_ack_value(ack: &EventAck) -> Value {
    object([
        ("eventId", ack.event_id.clone().into()),
        ("missionId", ack.mission_id.clone().into()),
        ("sequence", ack.sequence.into()),
        ("duplicate", ack.duplicate.into()),
    ])
}

pub(super) fn mission_snapshot(check: &mut Check, params: &Value) -> Option<RequestParams> {
    let fields = check.object(params, PARAMS, &["missionId"], &[])?;
    Some(RequestParams::MissionSnapshot {
        mission_id: check.uuid(fields.get("missionId"), "frame.params.missionId")?,
    })
}

fn snapshot_time(
    check: &mut Check,
    fields: &Map<String, Value>,
    key: &str,
    path: &str,
) -> Option<String> {
    let value = fields
        .get(key)?
        .as_str()
        .filter(|text| extalia_core::time::parse_utc(text).is_some());
    if value.is_none() {
        check.fail(&format!("{path}.{key}"), "expected a real UTC timestamp");
    }
    value.map(str::to_owned)
}

fn snapshot_array<'a>(
    check: &mut Check,
    fields: &'a Map<String, Value>,
    key: &str,
    min: usize,
) -> Option<&'a Vec<Value>> {
    let items = fields
        .get(key)?
        .as_array()
        .filter(|items| (min..=64).contains(&items.len()));
    if items.is_none() {
        check.fail(
            &format!("frame.result.{key}"),
            "invalid snapshot array size",
        );
    }
    items
}

pub(super) fn mission_snapshot_result(check: &mut Check, result: &Value) -> Option<ResponseResult> {
    use extalia_core::mission::{
        MAX_EVENTS_PER_MISSION, MissionSnapshot, MissionState, SnapshotLease, SnapshotTask,
    };
    use std::collections::HashSet;
    let fields = check.object(
        result,
        RESULT,
        &[
            "missionId",
            "workspaceId",
            "version",
            "state",
            "updatedAt",
            "sequence",
            "tasks",
            "leases",
        ],
        &[],
    )?;
    let mission_id = check.uuid(fields.get("missionId"), "frame.result.missionId")?;
    let workspace_id = check.uuid(fields.get("workspaceId"), "frame.result.workspaceId")?;
    let version = check.integer(
        fields.get("version")?,
        "frame.result.version",
        1,
        MAX_SAFE_INTEGER,
    )?;
    let state = check.name(
        fields.get("state"),
        "frame.result.state",
        MissionState::parse,
    )?;
    let updated_at = snapshot_time(check, fields, "updatedAt", RESULT)?;
    let sequence = check.integer(
        fields.get("sequence")?,
        "frame.result.sequence",
        1,
        MAX_EVENTS_PER_MISSION,
    )?;
    let mut tasks = Vec::new();
    let mut task_ids = HashSet::new();
    for (index, value) in snapshot_array(check, fields, "tasks", 1)?
        .iter()
        .enumerate()
    {
        let path = format!("frame.result.tasks[{index}]");
        let fields = check.object(
            value,
            &path,
            &["taskId", "state", "attempt"],
            &["assignedAgentId"],
        )?;
        let task_id = check.uuid(fields.get("taskId"), &format!("{path}.taskId"))?;
        let assigned_agent_id = match fields.get("assignedAgentId") {
            None => None,
            Some(value) => Some(check.uuid(Some(value), &format!("{path}.assignedAgentId"))?),
        };
        let state = check.name(
            fields.get("state"),
            &format!("{path}.state"),
            TaskState::parse,
        )?;
        let attempt = check.integer(
            fields.get("attempt")?,
            &format!("{path}.attempt"),
            0,
            MAX_SAFE_INTEGER,
        )?;
        if !task_ids.insert(task_id.clone()) {
            check.fail(&path, "duplicate task ID");
        }
        if state.in_flight() && assigned_agent_id.is_none() {
            check.fail(&path, "in-flight task requires an assignee");
        }
        tasks.push(SnapshotTask {
            task_id,
            assigned_agent_id,
            state,
            attempt,
        });
    }
    let mut leases = Vec::new();
    let mut lease_ids = HashSet::new();
    let mut leased_tasks = HashSet::new();
    for (index, value) in snapshot_array(check, fields, "leases", 0)?
        .iter()
        .enumerate()
    {
        let path = format!("frame.result.leases[{index}]");
        let fields = check.object(
            value,
            &path,
            &[
                "leaseId",
                "taskId",
                "holderAgentId",
                "acquiredAt",
                "expiresAt",
            ],
            &[],
        )?;
        let lease = SnapshotLease {
            lease_id: check.uuid(fields.get("leaseId"), &format!("{path}.leaseId"))?,
            task_id: check.uuid(fields.get("taskId"), &format!("{path}.taskId"))?,
            holder_agent_id: check.uuid(
                fields.get("holderAgentId"),
                &format!("{path}.holderAgentId"),
            )?,
            acquired_at: snapshot_time(check, fields, "acquiredAt", &path)?,
            expires_at: snapshot_time(check, fields, "expiresAt", &path)?,
        };
        if !lease_ids.insert(lease.lease_id.clone()) || !leased_tasks.insert(lease.task_id.clone())
        {
            check.fail(&path, "duplicate lease or task ID");
        }
        if !tasks.iter().any(|task| {
            task.task_id == lease.task_id
                && task.assigned_agent_id.as_ref() == Some(&lease.holder_agent_id)
                && task.state.in_flight()
                && task.state != TaskState::Assigned
        }) {
            check.fail(&path, "lease does not match a running task and holder");
        }
        if extalia_core::time::parse_utc(&lease.expires_at)
            < extalia_core::time::parse_utc(&lease.acquired_at)
        {
            check.fail(&path, "lease expiry precedes acquisition");
        }
        leases.push(lease);
    }
    for task in &tasks {
        if task.state.in_flight()
            && task.state != TaskState::Assigned
            && !leased_tasks.contains(&task.task_id)
        {
            check.fail("frame.result.leases", "running task requires its lease");
        }
    }
    Some(ResponseResult::MissionSnapshot(MissionSnapshot {
        mission_id,
        workspace_id,
        version,
        state,
        updated_at,
        sequence,
        tasks,
        leases,
    }))
}
