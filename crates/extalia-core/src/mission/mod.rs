//! Durable mission domain, slice A (audit §9 PR 6): missions with their task graph, task
//! state transitions and mission control events (ADRs 0013, 0014), stored per profile
//! (ADR 0024) by the SQLite adapter.
//!
//! - [`contract`] validates the orchestration contracts (`Mission`, `TaskGraph`,
//!   `AgentEvent`) like `parseOrchestration` in `@extalia/protocol`.
//! - [`policy`] is the store's admission policy: only native control metadata is accepted
//!   (ADR 0014), a stricter rule than the wire contract.
//! - [`transitions`] holds the task and mission transition tables shared with
//!   `@extalia/protocol`; they decide which state changes the store applies.

pub mod canonical;
pub mod contract;
mod event_body;
mod execution;
mod planned_tasks;
pub use planned_tasks::{
    OriginalPlannedTask, PlannedTaskMembership, PlannedTaskMembershipAvailability,
};
mod recovery_review;
pub use recovery_review::MissionRecoveryReview;
pub mod policy;
mod transitions;
pub use execution::{
    ExecutionAdmission, ExecutionLocalDrain, ExecutionLocalDrainAck, ExecutionLocalDrainRecord,
    ExecutionObservation, ExecutionObservationAck, ExecutionObservationRecord, MissionExecution,
    MissionExecutions,
};

use std::fmt;

use serde_json::{Map, Value};

macro_rules! names {
    ($(#[$meta:meta])* $name:ident { $($variant:ident = $text:literal,)+ }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum $name { $($variant,)+ }

        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant,)+];

            pub fn as_str(self) -> &'static str {
                match self { $($name::$variant => $text,)+ }
            }

            pub fn parse(text: &str) -> Option<Self> {
                match text { $($text => Some($name::$variant),)+ _ => None }
            }
        }
    };
}

names!(
    /// `MissionState` of the orchestration contract.
    MissionState {
        Draft = "draft",
        Planning = "planning",
        Queued = "queued",
        Running = "running",
        Waiting = "waiting",
        AwaitingApproval = "awaiting_approval",
        Reviewing = "reviewing",
        Completed = "completed",
        Failed = "failed",
        Cancelled = "cancelled",
        Recovering = "recovering",
    }
);

names!(
    /// `TaskState` of the orchestration contract.
    TaskState {
        Queued = "queued",
        Blocked = "blocked",
        Assigned = "assigned",
        Running = "running",
        Waiting = "waiting",
        AwaitingApproval = "awaiting_approval",
        Verifying = "verifying",
        Completed = "completed",
        Failed = "failed",
        Cancelled = "cancelled",
        Unknown = "unknown",
    }
);

names!(
    Verification {
        Unverified = "unverified",
        Verified = "verified",
    }
);

/// Control events per mission (`MAX_EVENTS = 8192` in `packages/host/src/missionCheckpoints.ts`;
/// "8,192 per run", ADR 0014). The initial creation record counts.
pub const MAX_EVENTS_PER_MISSION: u64 = 8_192;
/// Encoded bytes of one stored event (`MAX_EVENT_BYTES = 4096` in `missionCheckpoints.ts`;
/// "capped at 4 KiB each", ADR 0014), measured on the canonical payload with its sequence.
pub const MAX_EVENT_BYTES: usize = 4_096;
/// Encoded event bytes per mission (`MAX_BYTES = 8 * 1024 * 1024` in `missionCheckpoints.ts`;
/// ADR 0014 caps "8 MiB of encoded event data per session"; the daemon has no session
/// ownership, so the same bound applies to each mission's journal).
pub const MAX_EVENT_BYTES_PER_MISSION: u64 = 8 * 1024 * 1024;
/// Tasks per created mission (`MAX_TASKS = 64` in `packages/runtime/src/mission.ts`).
pub const MAX_TASKS_PER_MISSION: usize = 64;
/// Lifetime of a task lease without activity: the largest native task timeout
/// (`timeoutMs` at most 600 000 in `packages/runtime/src/mission.ts`). Independent
/// epoch-bound heartbeats and accepted task activity renew only unexpired leases.
pub const LEASE_TTL_MS: i64 = 600_000;
/// Maximum missions quarantined by one live lease-reaper tick. Each graph has at most 64 tasks.
pub const MAX_REAP_MISSIONS_PER_TICK: usize = 16;

/// Task states that hold an assignee (`ASSIGNED_TASK_STATES` of the contract's `checkTask`).
pub const ASSIGNED_TASK_STATES: [TaskState; 5] = [
    TaskState::Assigned,
    TaskState::Running,
    TaskState::Waiting,
    TaskState::AwaitingApproval,
    TaskState::Verifying,
];

impl TaskState {
    /// Work that may have started: it becomes `unknown` after a restart (ADR 0013, 0014).
    pub fn in_flight(self) -> bool {
        ASSIGNED_TASK_STATES.contains(&self)
    }

    pub fn terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }

    /// Transitions the store applies: `TASK_TRANSITIONS` of `@extalia/protocol`, loaded from
    /// the shared `transitions.json`. `unknown` never returns to queued or running: work
    /// whose outcome is unknown is resolved, not replayed (ADR 0013).
    pub fn can_transition_to(self, to: TaskState) -> bool {
        transitions::task_allows(self, to)
    }
}

impl MissionState {
    pub fn terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }

    /// Missions whose work may be executing; they become `recovering` after a restart.
    pub fn active(self) -> bool {
        matches!(
            self,
            Self::Running | Self::Waiting | Self::AwaitingApproval | Self::Reviewing
        )
    }

    /// Mission state changes applied by a `mission.state` control event:
    /// `MISSION_TRANSITIONS` of `@extalia/protocol`, loaded from the shared
    /// `transitions.json`. `recovering` is resolved to a terminal state, never resumed
    /// (ADR 0013).
    pub fn can_transition_to(self, to: MissionState) -> bool {
        transitions::mission_allows(self, to)
    }
}

/// A validated `Mission` contract.
#[derive(Debug, Clone, PartialEq)]
pub struct Mission {
    pub id: String,
    pub workspace_id: String,
    pub lead_agent_id: String,
    pub budget_id: String,
    pub state: MissionState,
    pub created_at: String,
    pub updated_at: String,
    pub version: u64,
}

/// A validated `Task` contract.
#[derive(Debug, Clone, PartialEq)]
pub struct Task {
    pub id: String,
    pub mission_id: String,
    pub parent_task_id: Option<String>,
    pub depends_on: Vec<String>,
    pub assigned_agent_id: Option<String>,
    pub state: TaskState,
    pub attempt: u64,
    pub lease_id: Option<String>,
    pub requirements: Vec<String>,
    pub evidence_ids: Vec<String>,
    pub verification: Option<Verification>,
    /// `access: "write"`: a write-capable worker task (ADR 0028); the journal admits its bounded
    /// edit activity ([`policy::Admission`]). False: read-only (the field is absent).
    pub write_access: bool,
}

/// A validated `TaskGraph` contract.
#[derive(Debug, Clone, PartialEq)]
pub struct TaskGraph {
    pub mission_id: String,
    pub tasks: Vec<Task>,
}

/// A validated `AgentEvent` contract: the exact JSON object and its routing fields.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentEvent {
    value: Map<String, Value>,
}

/// `mission.create` parameters.
#[derive(Debug, Clone, PartialEq)]
pub struct MissionCreate {
    pub mission: Mission,
    pub graph: TaskGraph,
}

/// `task.transition` parameters: compare-and-set of one task state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskTransition {
    pub mission_id: String,
    pub task_id: String,
    pub event_id: String,
    pub from: TaskState,
    pub to: TaskState,
    pub supervisor_id: Option<String>,
}

/// Epoch-bound ownership claim for one running task lease.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaseClaim {
    pub task_id: String,
    pub lease_id: String,
    pub holder_agent_id: String,
}

/// Independent renewal of up to 64 exact leases, without appending journal events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissionHeartbeat {
    pub mission_id: String,
    pub leases: Vec<LeaseClaim>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeartbeatAck {
    pub mission_id: String,
    pub leases: Vec<SnapshotLease>,
}

impl MissionHeartbeat {
    pub fn to_value(&self) -> Value {
        serde_json::json!({ "missionId": self.mission_id,
            "leases": self.leases.iter().map(|lease| serde_json::json!({
                "taskId": lease.task_id, "leaseId": lease.lease_id,
                "holderAgentId": lease.holder_agent_id,
            })).collect::<Vec<_>>() })
    }
}

impl HeartbeatAck {
    pub fn to_value(&self) -> Value {
        serde_json::json!({ "missionId": self.mission_id,
            "leases": self.leases.iter().map(|lease| serde_json::json!({
                "taskId": lease.task_id, "leaseId": lease.lease_id,
                "holderAgentId": lease.holder_agent_id,
                "acquiredAt": lease.acquired_at, "expiresAt": lease.expires_at,
            })).collect::<Vec<_>>() })
    }
}

/// Atomic, read-only canonical mission inspection (ADR 0030).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissionSnapshot {
    pub mission_id: String,
    pub workspace_id: String,
    pub version: u64,
    pub state: MissionState,
    pub updated_at: String,
    pub sequence: u64,
    pub tasks: Vec<SnapshotTask>,
    pub leases: Vec<SnapshotLease>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotTask {
    pub task_id: String,
    pub assigned_agent_id: Option<String>,
    pub state: TaskState,
    pub attempt: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotLease {
    pub lease_id: String,
    pub task_id: String,
    pub holder_agent_id: String,
    pub acquired_at: String,
    pub expires_at: String,
}

impl MissionSnapshot {
    pub fn to_value(&self) -> Value {
        serde_json::json!({
            "missionId": self.mission_id, "workspaceId": self.workspace_id,
            "version": self.version, "state": self.state.as_str(), "updatedAt": self.updated_at,
            "sequence": self.sequence,
            "tasks": self.tasks.iter().map(|task| {
                let mut value = serde_json::json!({ "taskId": task.task_id,
                    "state": task.state.as_str(), "attempt": task.attempt });
                if let Some(id) = &task.assigned_agent_id { value["assignedAgentId"] = id.clone().into(); }
                value
            }).collect::<Vec<_>>(),
            "leases": self.leases.iter().map(|lease| serde_json::json!({
                "leaseId": lease.lease_id, "taskId": lease.task_id, "holderAgentId": lease.holder_agent_id,
                "acquiredAt": lease.acquired_at, "expiresAt": lease.expires_at,
            })).collect::<Vec<_>>(),
        })
    }
}

/// Acknowledgement of `mission.create`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissionAck {
    pub mission_id: String,
    pub version: u64,
}

/// Acknowledgement of `task.transition`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransitionAck {
    pub mission_id: String,
    pub task_id: String,
    pub state: TaskState,
    pub sequence: u64,
    pub admission: Option<ExecutionAdmission>,
}

/// Acknowledgement of `event.commit`; `duplicate` marks an identical retry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventAck {
    pub event_id: String,
    pub mission_id: String,
    pub sequence: u64,
    pub duplicate: bool,
}

/// Why an operation wrote nothing. Every failure leaves the store unchanged.
#[derive(Debug)]
pub enum MissionError {
    /// Rejected by the admission policy (ADR 0014) or an impossible transition.
    Invalid(&'static str),
    /// No such mission or task in this profile. Other profiles' rows are never visible.
    NotFound,
    /// Stale `from` state, conflicting reuse of an ID, or an ownership mismatch.
    Conflict(&'static str),
    /// A retention or size cap is exhausted (ADR 0013/0014).
    Capacity(&'static str),
    /// The transaction failed and was rolled back.
    Storage(rusqlite::Error),
    /// Stored rows contradict their invariants; fail closed.
    Corrupt(&'static str),
}

impl fmt::Display for MissionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(reason) => write!(f, "rejected: {reason}"),
            Self::NotFound => f.write_str("not found in this profile"),
            Self::Conflict(reason) => write!(f, "conflict: {reason}"),
            Self::Capacity(reason) => write!(f, "capacity exceeded: {reason}"),
            Self::Storage(_) => f.write_str("core store transaction failed"),
            Self::Corrupt(reason) => write!(f, "core store is inconsistent: {reason}"),
        }
    }
}

impl std::error::Error for MissionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Storage(source) => Some(source),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for MissionError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Storage(error)
    }
}

fn insert(map: &mut Map<String, Value>, key: &str, value: impl Into<Value>) {
    map.insert(key.to_owned(), value.into());
}

fn insert_some(map: &mut Map<String, Value>, key: &str, value: &Option<String>) {
    if let Some(value) = value {
        insert(map, key, value.clone());
    }
}

fn strings(values: &[String]) -> Value {
    values.iter().cloned().map(Value::from).collect()
}

impl Mission {
    /// The contract JSON.
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        insert(&mut map, "schemaVersion", 1);
        insert(&mut map, "id", self.id.clone());
        insert(&mut map, "workspaceId", self.workspace_id.clone());
        insert(&mut map, "leadAgentId", self.lead_agent_id.clone());
        insert(&mut map, "budgetId", self.budget_id.clone());
        insert(&mut map, "state", self.state.as_str());
        insert(&mut map, "createdAt", self.created_at.clone());
        insert(&mut map, "updatedAt", self.updated_at.clone());
        insert(&mut map, "version", self.version);
        Value::Object(map)
    }
}

impl Task {
    /// The contract JSON.
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        insert(&mut map, "schemaVersion", 1);
        insert(&mut map, "id", self.id.clone());
        insert(&mut map, "missionId", self.mission_id.clone());
        insert_some(&mut map, "parentTaskId", &self.parent_task_id);
        insert(&mut map, "dependsOn", strings(&self.depends_on));
        insert_some(&mut map, "assignedAgentId", &self.assigned_agent_id);
        insert(&mut map, "state", self.state.as_str());
        insert(&mut map, "attempt", self.attempt);
        insert_some(&mut map, "leaseId", &self.lease_id);
        insert(&mut map, "requirements", strings(&self.requirements));
        insert(&mut map, "evidenceIds", strings(&self.evidence_ids));
        if let Some(verification) = self.verification {
            insert(&mut map, "verification", verification.as_str());
        }
        if self.write_access {
            insert(&mut map, "access", "write");
        }
        Value::Object(map)
    }
}

impl TaskGraph {
    /// The contract JSON.
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        insert(&mut map, "schemaVersion", 1);
        insert(&mut map, "missionId", self.mission_id.clone());
        insert(
            &mut map,
            "tasks",
            self.tasks.iter().map(Task::to_value).collect::<Value>(),
        );
        Value::Object(map)
    }
}

impl MissionCreate {
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        insert(&mut map, "mission", self.mission.to_value());
        insert(&mut map, "graph", self.graph.to_value());
        Value::Object(map)
    }
}

impl TaskTransition {
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        insert(&mut map, "missionId", self.mission_id.clone());
        insert(&mut map, "taskId", self.task_id.clone());
        insert(&mut map, "eventId", self.event_id.clone());
        insert(&mut map, "from", self.from.as_str());
        insert(&mut map, "to", self.to.as_str());
        insert_some(&mut map, "supervisorId", &self.supervisor_id);
        Value::Object(map)
    }
}

impl AgentEvent {
    /// Wrap an object that passed [`contract::agent_event`]; callers outside the contract
    /// module cannot construct an unvalidated event.
    pub(crate) fn from_validated(value: Map<String, Value>) -> Self {
        Self { value }
    }

    fn text(&self, key: &str) -> Option<&str> {
        self.value.get(key).and_then(Value::as_str)
    }

    pub fn id(&self) -> &str {
        self.text("id").unwrap_or_default()
    }

    pub fn workspace_id(&self) -> &str {
        self.text("workspaceId").unwrap_or_default()
    }

    pub fn session_id(&self) -> &str {
        self.text("sessionId").unwrap_or_default()
    }

    pub fn mission_id(&self) -> Option<&str> {
        self.text("missionId")
    }

    pub fn task_id(&self) -> Option<&str> {
        self.text("taskId")
    }

    pub fn agent_id(&self) -> Option<&str> {
        self.text("agentId")
    }

    pub fn body(&self) -> &Map<String, Value> {
        self.value
            .get("body")
            .and_then(Value::as_object)
            .expect("a validated event has an object body")
    }

    pub fn body_type(&self) -> &str {
        self.body()
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
    }

    /// The exact contract JSON as received.
    pub fn to_value(&self) -> Value {
        Value::Object(self.value.clone())
    }

    /// The event without the caller's run-local `sequence`, which the store replaces
    /// (ADR 0014); the idempotency digest covers this form.
    pub fn normalized(&self) -> Value {
        let mut value = self.value.clone();
        value.remove("sequence");
        Value::Object(value)
    }
}
