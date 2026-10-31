//! Original planner membership, captured only by mission creation, never reconstructed.
//! This history is an integrity prerequisite, not execution or effect-settlement authority.
use super::{MissionCreate, MissionError, Task, TaskGraph, canonical, contract};
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OriginalPlannedTask {
    pub task_id: String,
    pub task_digest: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlannedTaskMembership {
    pub mission_id: String,
    pub workspace_id: String,
    pub creation_version: u64,
    pub graph_digest: String,
    /// Sorted unique identities and their original, full canonical task digests.
    pub tasks: Vec<OriginalPlannedTask>,
    /// The original validated graph; state changes never update this history.
    pub graph: TaskGraph,
    pub membership_digest: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PlannedTaskMembershipAvailability {
    /// A pre-capture mission. Absence is never upgraded to planner certification.
    LegacyUnavailable,
    Available(PlannedTaskMembership),
}

impl PlannedTaskMembership {
    pub(crate) fn capture(profile: &str, create: &MissionCreate) -> Self {
        let mut graph = create.graph.clone();
        graph.tasks.sort_by(|a, b| a.id.cmp(&b.id));
        let mut membership = Self {
            mission_id: create.mission.id.clone(),
            workspace_id: create.mission.workspace_id.clone(),
            creation_version: create.mission.version,
            graph_digest: canonical::digest(&graph.to_value()),
            tasks: graph
                .tasks
                .iter()
                .map(|task| OriginalPlannedTask {
                    task_id: task.id.clone(),
                    task_digest: canonical::digest(&task.to_value()),
                })
                .collect(),
            graph,
            membership_digest: String::new(),
        };
        membership.membership_digest = membership.captured_digest(profile);
        membership
    }

    pub(crate) fn to_value(&self) -> Value {
        json!({"kind":"extalia-original-planned-tasks-v1", "missionId":self.mission_id,
            "workspaceId":self.workspace_id, "creationVersion":self.creation_version,
            "graphDigest":self.graph_digest, "tasks":self.tasks.iter().map(|task|
                json!({"taskId":task.task_id,"taskDigest":task.task_digest})).collect::<Vec<_>>(),
            "graph":self.graph.to_value(), "membershipDigest":self.membership_digest})
    }

    pub(crate) fn captured_digest(&self, profile: &str) -> String {
        let mut value = self.to_value();
        value
            .as_object_mut()
            .expect("membership object")
            .remove("membershipDigest");
        value["profileId"] = profile.into();
        canonical::digest(&value)
    }

    /// Validate the canonical stored history by reconstructing all derived hashes.
    pub(crate) fn decode(profile: &str, value: &Value) -> Result<Self, MissionError> {
        let corrupt = || MissionError::Corrupt("original planned task membership");
        let graph =
            contract::task_graph(&value["graph"], "graph", &mut Vec::new()).ok_or_else(corrupt)?;
        let mission_id = value["missionId"].as_str().ok_or_else(corrupt)?;
        let workspace_id = value["workspaceId"].as_str().ok_or_else(corrupt)?;
        let creation_version = value["creationVersion"].as_u64().ok_or_else(corrupt)?;
        if !contract::is_uuid(mission_id)
            || !contract::is_uuid(workspace_id)
            || graph.mission_id != mission_id
            || creation_version == 0
            || creation_version > 9_007_199_254_740_991
            || graph.tasks.is_empty()
            || graph.tasks.len() > super::MAX_TASKS_PER_MISSION
        {
            return Err(corrupt());
        }
        // Creation policy is also checked on load: these must be original queued tasks.
        if graph.tasks.iter().any(|task| {
            task.state != super::TaskState::Queued
                || task.attempt != 0
                || task.lease_id.is_some()
                || !task.evidence_ids.is_empty()
                || task.verification.is_some()
        }) {
            return Err(corrupt());
        }
        let mut expected = Self {
            mission_id: mission_id.into(),
            workspace_id: workspace_id.into(),
            creation_version,
            graph_digest: canonical::digest(&graph.to_value()),
            tasks: graph
                .tasks
                .iter()
                .map(|task| OriginalPlannedTask {
                    task_id: task.id.clone(),
                    task_digest: canonical::digest(&task.to_value()),
                })
                .collect(),
            graph,
            membership_digest: String::new(),
        };
        if expected
            .tasks
            .windows(2)
            .any(|pair| pair[0].task_id >= pair[1].task_id)
        {
            return Err(corrupt());
        }
        expected.membership_digest = expected.captured_digest(profile);
        if expected.to_value() != *value {
            return Err(corrupt());
        }
        Ok(expected)
    }

    pub(crate) fn matches_current(&self, graph: &TaskGraph) -> bool {
        if self.mission_id != graph.mission_id || self.tasks.len() != graph.tasks.len() {
            return false;
        }
        let mut current = graph.tasks.iter().collect::<Vec<_>>();
        current.sort_by(|a, b| a.id.cmp(&b.id));
        self.graph
            .tasks
            .iter()
            .zip(current)
            .all(|(original, current)| definition(original) == definition(current))
    }
}

/// Assignment authority, execution state, leases and evidence evolve independently of the plan.
fn definition(task: &Task) -> Value {
    let mut value = task.to_value();
    let fields = value.as_object_mut().expect("task object");
    for key in [
        "assignedAgentId",
        "state",
        "attempt",
        "leaseId",
        "evidenceIds",
        "verification",
    ] {
        fields.remove(key);
    }
    value
}
