//! Wire mapping of the slice A operations (`mission.create`, `task.transition`,
//! `event.commit`). Parameters are validated by the core's orchestration contract rules
//! (`extalia_core::mission::contract`), so the daemon and the store share one validator;
//! results are checked here like the other results.

use extalia_core::mission::{
    AgentEvent, EventAck, ExecutionAdmission, ExecutionLocalDrainAck, ExecutionLocalDrainRecord,
    ExecutionObservationAck, ExecutionObservationRecord, MissionAck, MissionExecution,
    MissionExecutions, TaskState, TransitionAck, contract,
};
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
        &["admission"],
    )?;
    let mission_id = check.uuid(fields.get("missionId"), "frame.result.missionId");
    let task_id = check.uuid(fields.get("taskId"), "frame.result.taskId");
    let state = check.name(fields.get("state"), "frame.result.state", TaskState::parse);
    let sequence = sequence(check, fields);
    let admission = fields
        .get("admission")
        .and_then(|value| execution_admission_result(check, value, "frame.result.admission"));
    if fields.contains_key("admission")
        && (state != Some(TaskState::Running)
            || admission.as_ref().is_some_and(|value| {
                Some(value.mission_id.as_str()) != mission_id.as_deref()
                    || Some(value.task_id.as_str()) != task_id.as_deref()
            }))
    {
        check.fail(
            "frame.result.admission",
            "admission must match the running transition",
        );
    }
    Some(ResponseResult::TaskTransition(TransitionAck {
        mission_id: mission_id?,
        task_id: task_id?,
        state: state?,
        sequence: sequence?,
        admission,
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
    let mut result = object([
        ("missionId", ack.mission_id.clone().into()),
        ("taskId", ack.task_id.clone().into()),
        ("state", ack.state.as_str().into()),
        ("sequence", ack.sequence.into()),
    ]);
    if let Some(admission) = &ack.admission {
        result["admission"] = admission.to_value();
    }
    result
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

pub(super) fn mission_executions(check: &mut Check, params: &Value) -> Option<RequestParams> {
    let fields = check.object(params, PARAMS, &["missionId"], &[])?;
    Some(RequestParams::MissionExecutions {
        mission_id: check.uuid(fields.get("missionId"), "frame.params.missionId")?,
    })
}

pub(super) fn execution_observe(check: &mut Check, params: &Value) -> Option<RequestParams> {
    contract::execution_observation(params, PARAMS, &mut check.errors)
        .map(RequestParams::ExecutionObserve)
}

pub(super) fn execution_record_local_drain(
    check: &mut Check,
    params: &Value,
) -> Option<RequestParams> {
    contract::execution_local_drain(params, PARAMS, &mut check.errors)
        .map(RequestParams::ExecutionRecordLocalDrain)
}

/// Wire shape only. Digest preimage binding is checked by the store, not by the
/// portable frame validator, so Rust and TypeScript validate the same wire grammar.
fn execution_admission_result(
    check: &mut Check,
    value: &Value,
    path: &str,
) -> Option<ExecutionAdmission> {
    let fields = check.object(
        value,
        path,
        &[
            "missionId",
            "workspaceId",
            "taskId",
            "leaseId",
            "holderAgentId",
            "supervisorId",
            "attempt",
            "missionVersion",
            "taskDigest",
            "graphDigest",
            "admissionDigest",
            "admittedAt",
        ],
        &[],
    )?;
    let mission_id = check.uuid(fields.get("missionId"), &format!("{path}.missionId"));
    let workspace_id = check.uuid(fields.get("workspaceId"), &format!("{path}.workspaceId"));
    let task_id = check.uuid(fields.get("taskId"), &format!("{path}.taskId"));
    let lease_id = check.uuid(fields.get("leaseId"), &format!("{path}.leaseId"));
    let holder_agent_id = check.uuid(
        fields.get("holderAgentId"),
        &format!("{path}.holderAgentId"),
    );
    let supervisor_id = check.uuid(fields.get("supervisorId"), &format!("{path}.supervisorId"));
    let attempt = fields
        .get("attempt")
        .and_then(|value| check.integer(value, &format!("{path}.attempt"), 1, MAX_SAFE_INTEGER));
    let mission_version = fields.get("missionVersion").and_then(|value| {
        check.integer(
            value,
            &format!("{path}.missionVersion"),
            1,
            MAX_SAFE_INTEGER,
        )
    });
    let task_digest = wire_digest(
        check,
        fields.get("taskDigest"),
        &format!("{path}.taskDigest"),
    );
    let graph_digest = wire_digest(
        check,
        fields.get("graphDigest"),
        &format!("{path}.graphDigest"),
    );
    let admission_digest = wire_digest(
        check,
        fields.get("admissionDigest"),
        &format!("{path}.admissionDigest"),
    );
    let admitted_at = snapshot_time(check, fields, "admittedAt", path);
    Some(ExecutionAdmission {
        mission_id: mission_id?,
        workspace_id: workspace_id?,
        task_id: task_id?,
        lease_id: lease_id?,
        holder_agent_id: holder_agent_id?,
        supervisor_id: supervisor_id?,
        attempt: attempt?,
        mission_version: mission_version?,
        task_digest: task_digest?,
        graph_digest: graph_digest?,
        admission_digest: admission_digest?,
        admitted_at: admitted_at?,
    })
}

fn wire_digest(check: &mut Check, value: Option<&Value>, path: &str) -> Option<String> {
    match value.and_then(Value::as_str) {
        Some(value)
            if value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) =>
        {
            Some(value.to_owned())
        }
        _ => {
            check.fail(path, "expected a lowercase SHA-256 digest");
            None
        }
    }
}

pub(super) fn execution_observe_result(
    check: &mut Check,
    result: &Value,
) -> Option<ResponseResult> {
    let fields = check.object(
        result,
        RESULT,
        &[
            "missionId",
            "taskId",
            "leaseId",
            "observationId",
            "recordedAt",
            "duplicate",
        ],
        &[],
    )?;
    let mission_id = check.uuid(fields.get("missionId"), "frame.result.missionId");
    let task_id = check.uuid(fields.get("taskId"), "frame.result.taskId");
    let lease_id = check.uuid(fields.get("leaseId"), "frame.result.leaseId");
    let observation_id = check.uuid(fields.get("observationId"), "frame.result.observationId");
    let recorded_at = snapshot_time(check, fields, "recordedAt", RESULT);
    let duplicate = fields.get("duplicate").and_then(|value| {
        let flag = value.as_bool();
        if flag.is_none() {
            check.fail("frame.result.duplicate", "expected a boolean");
        }
        flag
    });
    Some(ResponseResult::ExecutionObserve(ExecutionObservationAck {
        mission_id: mission_id?,
        task_id: task_id?,
        lease_id: lease_id?,
        observation_id: observation_id?,
        recorded_at: recorded_at?,
        duplicate: duplicate?,
    }))
}

pub(super) fn execution_record_local_drain_result(
    check: &mut Check,
    result: &Value,
) -> Option<ResponseResult> {
    let fields = check.object(
        result,
        RESULT,
        &[
            "missionId",
            "taskId",
            "leaseId",
            "proofId",
            "recordedAt",
            "duplicate",
        ],
        &[],
    )?;
    let mission_id = check.uuid(fields.get("missionId"), "frame.result.missionId");
    let task_id = check.uuid(fields.get("taskId"), "frame.result.taskId");
    let lease_id = check.uuid(fields.get("leaseId"), "frame.result.leaseId");
    let proof_id = check.uuid(fields.get("proofId"), "frame.result.proofId");
    let recorded_at = snapshot_time(check, fields, "recordedAt", RESULT);
    let duplicate = fields.get("duplicate").and_then(|value| {
        let flag = value.as_bool();
        if flag.is_none() {
            check.fail("frame.result.duplicate", "expected a boolean");
        }
        flag
    });
    Some(ResponseResult::ExecutionRecordLocalDrain(
        ExecutionLocalDrainAck {
            mission_id: mission_id?,
            task_id: task_id?,
            lease_id: lease_id?,
            proof_id: proof_id?,
            recorded_at: recorded_at?,
            duplicate: duplicate?,
        },
    ))
}

pub(super) fn mission_executions_result(
    check: &mut Check,
    result: &Value,
) -> Option<ResponseResult> {
    use std::collections::HashSet;
    let fields = check.object(result, RESULT, &["missionId", "executions"], &[])?;
    let mission_id = check.uuid(fields.get("missionId"), "frame.result.missionId")?;
    let items = fields
        .get("executions")?
        .as_array()
        .filter(|items| items.len() <= 64);
    if items.is_none() {
        check.fail(
            "frame.result.executions",
            "expected an array with 0 to 64 items",
        );
    }
    let mut executions = Vec::with_capacity(items.map_or(0, Vec::len));
    let (mut tasks, mut leases, mut observations, mut proofs) = (
        HashSet::new(),
        HashSet::new(),
        HashSet::new(),
        HashSet::new(),
    );
    for (index, item) in items?.iter().enumerate() {
        let path = format!("frame.result.executions[{index}]");
        let entry = check.object(item, &path, &["admission"], &["observation", "localDrain"])?;
        let admission_value = entry.get("admission")?;
        let admission =
            execution_admission_result(check, admission_value, &format!("{path}.admission"))?;
        if admission.mission_id != mission_id {
            check.fail(
                &format!("{path}.admission.missionId"),
                "admission belongs to another mission",
            );
        }
        if !tasks.insert(admission.task_id.clone()) || !leases.insert(admission.lease_id.clone()) {
            check.fail(&path, "duplicate execution identity");
        }
        let observation = entry.get("observation").and_then(|value| {
            let fields = check.object(
                value,
                &format!("{path}.observation"),
                &["observationId", "kind", "recordedAt"],
                &[],
            )?;
            let observation_id = check.uuid(
                fields.get("observationId"),
                &format!("{path}.observation.observationId"),
            )?;
            let kind = check.name(
                fields.get("kind"),
                &format!("{path}.observation.kind"),
                |value| (value == "turn-promise-settled").then_some(value.to_owned()),
            )?;
            let recorded_at =
                snapshot_time(check, fields, "recordedAt", &format!("{path}.observation"))?;
            if extalia_core::time::parse_utc(&recorded_at)
                < extalia_core::time::parse_utc(&admission.admitted_at)
            {
                check.fail(
                    &format!("{path}.observation.recordedAt"),
                    "observation precedes admission",
                );
            }
            if !observations.insert(observation_id.clone()) {
                check.fail(&path, "duplicate observation ID");
            }
            Some(ExecutionObservationRecord {
                observation_id,
                kind,
                recorded_at,
            })
        });
        let local_drain = entry.get("localDrain").and_then(|value| {
            let drain_path = format!("{path}.localDrain");
            let fields = check.object(
                value,
                &drain_path,
                &[
                    "proofId",
                    "kind",
                    "coverage",
                    "providerOperations",
                    "toolOperations",
                    "recordedAt",
                ],
                &[],
            )?;
            let proof_id = check.uuid(fields.get("proofId"), &format!("{drain_path}.proofId"))?;
            let kind = check.name(fields.get("kind"), &format!("{drain_path}.kind"), |v| {
                (v == "local-operations-drained").then_some(v.to_owned())
            })?;
            let coverage = check.name(
                fields.get("coverage"),
                &format!("{drain_path}.coverage"),
                |v| (v == "extalia-native-local-v1").then_some(v.to_owned()),
            )?;
            let provider_operations = check.integer(
                fields.get("providerOperations")?,
                &format!("{drain_path}.providerOperations"),
                0,
                20,
            )?;
            let tool_operations = check.integer(
                fields.get("toolOperations")?,
                &format!("{drain_path}.toolOperations"),
                0,
                80,
            )?;
            let recorded_at = snapshot_time(check, fields, "recordedAt", &drain_path)?;
            if observation.as_ref().is_none_or(|observation| {
                extalia_core::time::parse_utc(&recorded_at)
                    < extalia_core::time::parse_utc(&observation.recorded_at)
            }) || extalia_core::time::parse_utc(&recorded_at)
                < extalia_core::time::parse_utc(&admission.admitted_at)
            {
                check.fail(
                    &drain_path,
                    "local drain requires a prior turn observation and admission",
                );
            }
            if !proofs.insert(proof_id.clone()) {
                check.fail(&drain_path, "duplicate proof ID");
            }
            Some(ExecutionLocalDrainRecord {
                proof_id,
                kind,
                coverage,
                provider_operations,
                tool_operations,
                recorded_at,
            })
        });
        executions.push(MissionExecution {
            admission,
            observation,
            local_drain,
        });
    }
    Some(ResponseResult::MissionExecutions(MissionExecutions {
        mission_id,
        executions,
    }))
}

pub(super) fn mission_heartbeat(check: &mut Check, params: &Value) -> Option<RequestParams> {
    contract::mission_heartbeat(params, PARAMS, &mut check.errors)
        .map(RequestParams::MissionHeartbeat)
}

pub(super) fn mission_heartbeat_result(
    check: &mut Check,
    result: &Value,
) -> Option<ResponseResult> {
    use extalia_core::mission::{HeartbeatAck, SnapshotLease};
    use std::collections::HashSet;
    let fields = check.object(result, RESULT, &["missionId", "leases"], &[])?;
    let mission_id = check.uuid(fields.get("missionId"), "frame.result.missionId")?;
    let items = snapshot_array(check, fields, "leases", 1)?;
    let mut tasks = HashSet::new();
    let mut ids = HashSet::new();
    let mut leases = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let path = format!("frame.result.leases[{index}]");
        let fields = check.object(
            item,
            &path,
            &[
                "taskId",
                "leaseId",
                "holderAgentId",
                "acquiredAt",
                "expiresAt",
            ],
            &[],
        )?;
        let lease = SnapshotLease {
            task_id: check.uuid(fields.get("taskId"), &format!("{path}.taskId"))?,
            lease_id: check.uuid(fields.get("leaseId"), &format!("{path}.leaseId"))?,
            holder_agent_id: check.uuid(
                fields.get("holderAgentId"),
                &format!("{path}.holderAgentId"),
            )?,
            acquired_at: snapshot_time(check, fields, "acquiredAt", &path)?,
            expires_at: snapshot_time(check, fields, "expiresAt", &path)?,
        };
        if !tasks.insert(lease.task_id.clone()) || !ids.insert(lease.lease_id.clone()) {
            check.fail(&path, "lease members must be unique");
        }
        if extalia_core::time::parse_utc(&lease.expires_at)
            <= extalia_core::time::parse_utc(&lease.acquired_at)
        {
            check.fail(&path, "lease expiry must follow acquisition");
        }
        leases.push(lease);
    }
    Some(ResponseResult::MissionHeartbeat(HeartbeatAck {
        mission_id,
        leases,
    }))
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

pub(super) fn mission_recovery_review(check: &mut Check, params: &Value) -> Option<RequestParams> {
    let fields = check.object(params, PARAMS, &["missionId"], &[])?;
    Some(RequestParams::MissionRecoveryReview {
        mission_id: check.uuid(fields.get("missionId"), "frame.params.missionId")?,
    })
}

pub(super) fn mission_recovery_review_result(
    check: &mut Check,
    result: &Value,
) -> Option<ResponseResult> {
    use extalia_core::mission::MissionRecoveryReview;
    use std::collections::HashSet;
    let fields = check.object(
        result,
        RESULT,
        &[
            "kind",
            "snapshot",
            "executions",
            "missionDigest",
            "graphDigest",
            "reviewDigest",
            "missingAdmissionTaskIds",
            "worktreeOwnership",
        ],
        &[],
    )?;
    check.name(fields.get("kind"), "frame.result.kind", |value| {
        (value == "extalia-recovery-review-v1").then_some(())
    })?;
    check.name(
        fields.get("worktreeOwnership"),
        "frame.result.worktreeOwnership",
        |value| (value == "unverified").then_some(()),
    )?;
    let ResponseResult::MissionSnapshot(snapshot) =
        mission_snapshot_result(check, fields.get("snapshot")?)?
    else {
        return None;
    };
    let executions_value =
        serde_json::json!({"missionId":snapshot.mission_id,"executions":fields.get("executions")?});
    let ResponseResult::MissionExecutions(executions) =
        mission_executions_result(check, &executions_value)?
    else {
        return None;
    };
    let mut admitted = HashSet::new();
    for entry in &executions.executions {
        let admission = &entry.admission;
        let task = snapshot
            .tasks
            .iter()
            .find(|task| task.task_id == admission.task_id);
        if task.is_none_or(|task| {
            task.assigned_agent_id.as_ref() != Some(&admission.holder_agent_id)
                || task.attempt != admission.attempt
        }) || admission.workspace_id != snapshot.workspace_id
            || admission.mission_version > snapshot.version
            || snapshot.leases.iter().any(|lease| {
                lease.task_id == admission.task_id && lease.lease_id != admission.lease_id
            })
        {
            check.fail(
                "frame.result.executions",
                "execution does not match the reviewed snapshot",
            );
        }
        admitted.insert(admission.task_id.as_str());
    }
    let items = fields
        .get("missingAdmissionTaskIds")?
        .as_array()
        .filter(|items| items.len() <= 64);
    if items.is_none() {
        check.fail(
            "frame.result.missingAdmissionTaskIds",
            "expected at most 64 UUIDs",
        );
    }
    let missing = items?
        .iter()
        .map(|value| check.uuid(Some(value), "frame.result.missingAdmissionTaskIds"))
        .collect::<Option<Vec<_>>>()?;
    let expected: HashSet<_> = snapshot
        .tasks
        .iter()
        .filter(|task| !admitted.contains(task.task_id.as_str()))
        .map(|task| task.task_id.as_str())
        .collect();
    let actual: HashSet<_> = missing.iter().map(String::as_str).collect();
    if expected != actual || actual.len() != missing.len() {
        check.fail(
            "frame.result.missingAdmissionTaskIds",
            "missing membership must exactly match the graph",
        );
    }
    Some(ResponseResult::MissionRecoveryReview(
        MissionRecoveryReview {
            snapshot,
            executions: executions.executions,
            mission_digest: wire_digest(
                check,
                fields.get("missionDigest"),
                "frame.result.missionDigest",
            )?,
            graph_digest: wire_digest(
                check,
                fields.get("graphDigest"),
                "frame.result.graphDigest",
            )?,
            review_digest: wire_digest(
                check,
                fields.get("reviewDigest"),
                "frame.result.reviewDigest",
            )?,
            missing_admission_task_ids: missing,
        },
    ))
}
