//! Durable supervision observations, deliberately weaker than effect settlement.
use super::canonical;
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionAdmission {
    pub mission_id: String,
    pub workspace_id: String,
    pub task_id: String,
    pub lease_id: String,
    pub holder_agent_id: String,
    pub supervisor_id: String,
    pub attempt: u64,
    pub mission_version: u64,
    pub task_digest: String,
    pub graph_digest: String,
    pub admission_digest: String,
    pub admitted_at: String,
}

impl ExecutionAdmission {
    /// Identity captured by the authority at admission; its hashes are not a
    /// promise that historical task/graph contents remain reconstructible.
    pub fn identity_value(&self) -> Value {
        json!({"missionId":self.mission_id,"workspaceId":self.workspace_id,"taskId":self.task_id,
            "leaseId":self.lease_id,"holderAgentId":self.holder_agent_id,"supervisorId":self.supervisor_id,
            "attempt":self.attempt,"missionVersion":self.mission_version,"taskDigest":self.task_digest,
            "graphDigest":self.graph_digest,"admittedAt":self.admitted_at})
    }
    pub fn to_value(&self) -> Value {
        let mut value = self.identity_value();
        value["admissionDigest"] = self.admission_digest.clone().into();
        value
    }
    pub fn captured_digest(&self, profile: &str) -> String {
        let mut identity = self.identity_value();
        identity["profileId"] = profile.into();
        canonical::digest(&identity)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionObservation {
    pub mission_id: String,
    pub task_id: String,
    pub lease_id: String,
    pub holder_agent_id: String,
    pub supervisor_id: String,
    pub attempt: u64,
    pub admission_digest: String,
    pub observation_id: String,
    pub kind: String,
}

impl ExecutionObservation {
    pub fn to_value(&self) -> Value {
        json!({"missionId":self.mission_id,"taskId":self.task_id,"leaseId":self.lease_id,
            "holderAgentId":self.holder_agent_id,"supervisorId":self.supervisor_id,"attempt":self.attempt,
            "admissionDigest":self.admission_digest,"observationId":self.observation_id,"kind":self.kind})
    }
    pub fn matches(&self, admission: &ExecutionAdmission) -> bool {
        self.mission_id == admission.mission_id
            && self.task_id == admission.task_id
            && self.lease_id == admission.lease_id
            && self.holder_agent_id == admission.holder_agent_id
            && self.supervisor_id == admission.supervisor_id
            && self.attempt == admission.attempt
            && self.admission_digest == admission.admission_digest
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionObservationAck {
    pub mission_id: String,
    pub task_id: String,
    pub lease_id: String,
    pub observation_id: String,
    pub recorded_at: String,
    pub duplicate: bool,
}
impl ExecutionObservationAck {
    pub fn to_value(&self) -> Value {
        json!({"missionId":self.mission_id,"taskId":self.task_id,"leaseId":self.lease_id,
            "observationId":self.observation_id,"recordedAt":self.recorded_at,"duplicate":self.duplicate})
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionObservationRecord {
    pub observation_id: String,
    pub kind: String,
    pub recorded_at: String,
}
impl ExecutionObservationRecord {
    pub fn to_value(&self) -> Value {
        json!({"observationId":self.observation_id,"kind":self.kind,"recordedAt":self.recorded_at})
    }
}

/// Scoped evidence for operations owned by Extalia Native's local adapters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionLocalDrain {
    pub mission_id: String,
    pub task_id: String,
    pub lease_id: String,
    pub holder_agent_id: String,
    pub supervisor_id: String,
    pub attempt: u64,
    pub admission_digest: String,
    pub proof_id: String,
    pub kind: String,
    pub coverage: String,
    pub provider_operations: u64,
    pub tool_operations: u64,
}
impl ExecutionLocalDrain {
    pub fn to_value(&self) -> Value {
        json!({"missionId":self.mission_id,"taskId":self.task_id,"leaseId":self.lease_id,
            "holderAgentId":self.holder_agent_id,"supervisorId":self.supervisor_id,"attempt":self.attempt,
            "admissionDigest":self.admission_digest,"proofId":self.proof_id,"kind":self.kind,
            "coverage":self.coverage,"providerOperations":self.provider_operations,"toolOperations":self.tool_operations})
    }
    pub fn matches(&self, admission: &ExecutionAdmission) -> bool {
        self.mission_id == admission.mission_id
            && self.task_id == admission.task_id
            && self.lease_id == admission.lease_id
            && self.holder_agent_id == admission.holder_agent_id
            && self.supervisor_id == admission.supervisor_id
            && self.attempt == admission.attempt
            && self.admission_digest == admission.admission_digest
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionLocalDrainAck {
    pub mission_id: String,
    pub task_id: String,
    pub lease_id: String,
    pub proof_id: String,
    pub recorded_at: String,
    pub duplicate: bool,
}
impl ExecutionLocalDrainAck {
    pub fn to_value(&self) -> Value {
        json!({"missionId":self.mission_id,"taskId":self.task_id,"leaseId":self.lease_id,
            "proofId":self.proof_id,"recordedAt":self.recorded_at,"duplicate":self.duplicate})
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionLocalDrainRecord {
    pub proof_id: String,
    pub kind: String,
    pub coverage: String,
    pub provider_operations: u64,
    pub tool_operations: u64,
    pub recorded_at: String,
}
impl ExecutionLocalDrainRecord {
    pub fn to_value(&self) -> Value {
        json!({"proofId":self.proof_id,"kind":self.kind,"coverage":self.coverage,
            "providerOperations":self.provider_operations,"toolOperations":self.tool_operations,"recordedAt":self.recorded_at})
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissionExecution {
    pub admission: ExecutionAdmission,
    pub observation: Option<ExecutionObservationRecord>,
    pub local_drain: Option<ExecutionLocalDrainRecord>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissionExecutions {
    pub mission_id: String,
    pub executions: Vec<MissionExecution>,
}
impl MissionExecutions {
    pub fn to_value(&self) -> Value {
        json!({"missionId":self.mission_id,"executions":self.executions.iter().map(|entry| {
            let mut value=json!({"admission":entry.admission.to_value()});
            if let Some(observation)=&entry.observation { value["observation"]=observation.to_value(); }
            if let Some(local_drain)=&entry.local_drain { value["localDrain"]=local_drain.to_value(); }
            value
        }).collect::<Vec<_>>()})
    }
}
