//! Orchestration contract validation for slice A, mirroring `parseOrchestration`
//! (`packages/protocol/src/orchestrationValidate.ts`) and the daemon parameter rules of
//! `daemonValidate.ts` for `mission.create`, `task.transition` and `event.commit`.
//!
//! Each function appends `<path>: <message>.` failures to `errors` and returns the typed
//! value only when it added none. Structure is checked first; semantic rules (timestamp
//! order, graph references, cycles, envelope requirements) run only on a structurally valid
//! value, as in TypeScript. The shared fixtures keep both verdicts equal; error texts
//! follow the TypeScript wording but are diagnostics, not part of the contract.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use super::event_body;
use super::{
    ASSIGNED_TASK_STATES, AgentEvent, ExecutionAdmission, ExecutionLocalDrain,
    ExecutionObservation, LeaseClaim, MAX_TASKS_PER_MISSION, Mission, MissionCreate,
    MissionHeartbeat, MissionState, Task, TaskGraph, TaskState, TaskTransition, Verification,
};
use crate::time::parse_utc;

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const MAX_ARRAY: usize = 1_000;
const LABEL_MAX: usize = 2_000;
const CONFIDENCE: [&str; 3] = ["reported", "observed", "inferred"];
/// `EVENT_CHANNELS` of `events.ts`.
pub(super) const EVENT_CHANNELS: [&str; 8] = [
    "stream",
    "hook",
    "transcript",
    "mcp",
    "bridge",
    "import",
    "user",
    "system",
];

pub(super) fn fail(errors: &mut Vec<String>, path: &str, message: &str) {
    errors.push(format!("{path}: {message}."));
}

/// Lowercase RFC 9562 UUID, versions 1-8 (`UUID_PATTERN`).
pub fn is_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, &byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            14 => (b'1'..=b'8').contains(&byte),
            19 => matches!(byte, b'8' | b'9' | b'a' | b'b'),
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
        })
}

/// Whitespace removed by JavaScript's `String.prototype.trim`.
pub(super) fn is_js_space(character: char) -> bool {
    matches!(
        character,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// Length in UTF-16 code units, like JavaScript's `length`.
pub(super) fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The `text(max)` rule: nonblank, no control characters, at most `max` code units.
fn is_text(text: &str, max: usize) -> bool {
    text.chars().any(|character| !is_js_space(character))
        && js_length(text) <= max
        && !text
            .chars()
            .any(|character| (character as u32) < 32 || character as u32 == 127)
}

/// `RUNTIME_ID_PATTERN`: `^[a-z0-9][a-z0-9._-]{0,63}$`.
pub(super) fn is_runtime_id(text: &str) -> bool {
    let bytes = text.as_bytes();
    (1..=64).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes[1..].iter().all(|&byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

/// A JSON number as JavaScript sees it.
pub(super) fn number(value: &Value) -> Option<f64> {
    value.as_number().and_then(serde_json::Number::as_f64)
}

/// `Number.isSafeInteger`.
fn safe_integer(value: &Value) -> Option<u64> {
    let float = number(value)?;
    (float.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER).contains(&float)).then_some(float as u64)
}

/// Field checks of one object. Like the TypeScript `object()` rule: unknown keys and
/// missing required keys fail; present keys are checked by the caller.
struct Fields<'a> {
    map: &'a Map<String, Value>,
    path: &'a str,
}

fn object<'a>(
    value: &'a Value,
    path: &'a str,
    required: &[&str],
    optional: &[&str],
    errors: &mut Vec<String>,
) -> Option<Fields<'a>> {
    let Some(map) = value.as_object() else {
        fail(errors, path, "expected a plain object");
        return None;
    };
    for key in map.keys() {
        if !required.contains(&key.as_str()) && !optional.contains(&key.as_str()) {
            fail(errors, &format!("{path}.{key}"), "unknown field");
        }
    }
    for key in required {
        if !map.contains_key(*key) {
            fail(errors, &format!("{path}.{key}"), "required field");
        }
    }
    Some(Fields { map, path })
}

impl<'a> Fields<'a> {
    fn at(&self, key: &str) -> String {
        format!("{}.{key}", self.path)
    }

    fn get(&self, key: &str) -> Option<&'a Value> {
        self.map.get(key)
    }

    /// A required field checked by `rule`; `None` when absent or invalid.
    fn field<T>(
        &self,
        key: &str,
        errors: &mut Vec<String>,
        rule: impl FnOnce(&'a Value, &str, &mut Vec<String>) -> Option<T>,
    ) -> Option<T> {
        let value = self.get(key)?;
        rule(value, &self.at(key), errors)
    }

    /// An optional field: `Some(None)` when absent, `None` when present and invalid.
    fn optional<T>(
        &self,
        key: &str,
        errors: &mut Vec<String>,
        rule: impl FnOnce(&'a Value, &str, &mut Vec<String>) -> Option<T>,
    ) -> Option<Option<T>> {
        match self.get(key) {
            None => Some(None),
            Some(value) => rule(value, &self.at(key), errors).map(Some),
        }
    }
}

fn schema_version(value: &Value, path: &str, errors: &mut Vec<String>) -> Option<()> {
    if number(value) == Some(1.0) {
        Some(())
    } else {
        fail(errors, path, "expected 1");
        None
    }
}

pub(super) fn uuid(value: &Value, path: &str, errors: &mut Vec<String>) -> Option<String> {
    match value.as_str() {
        Some(id) if is_uuid(id) => Some(id.to_owned()),
        _ => {
            fail(errors, path, "expected a lowercase UUID");
            None
        }
    }
}

fn text(value: &Value, path: &str, max: usize, errors: &mut Vec<String>) -> Option<String> {
    match value.as_str() {
        Some(text) if is_text(text, max) => Some(text.to_owned()),
        _ => {
            fail(
                errors,
                path,
                &format!("expected nonempty single-line text of at most {max} characters"),
            );
            None
        }
    }
}

fn timestamp(value: &Value, path: &str, errors: &mut Vec<String>) -> Option<String> {
    match value.as_str() {
        Some(text) if parse_utc(text).is_some() => Some(text.to_owned()),
        _ => {
            fail(errors, path, "expected a real UTC timestamp");
            None
        }
    }
}

fn integer(value: &Value, path: &str, min: u64, errors: &mut Vec<String>) -> Option<u64> {
    match safe_integer(value) {
        Some(number) if number >= min => Some(number),
        _ => {
            fail(
                errors,
                path,
                &format!("expected a safe integer between {min} and 9007199254740991"),
            );
            None
        }
    }
}

fn name<T>(
    value: &Value,
    path: &str,
    parse: fn(&str) -> Option<T>,
    all: &[&str],
    errors: &mut Vec<String>,
) -> Option<T> {
    let parsed = value.as_str().and_then(parse);
    if parsed.is_none() {
        fail(errors, path, &format!("expected one of {}", all.join(", ")));
    }
    parsed
}

fn enumeration(value: &Value, path: &str, all: &[&str], errors: &mut Vec<String>) -> Option<()> {
    if value.as_str().is_some_and(|text| all.contains(&text)) {
        Some(())
    } else {
        fail(errors, path, &format!("expected one of {}", all.join(", ")));
        None
    }
}

fn task_state(value: &Value, path: &str, errors: &mut Vec<String>) -> Option<TaskState> {
    let all: Vec<_> = TaskState::ALL.iter().map(|state| state.as_str()).collect();
    name(value, path, TaskState::parse, &all, errors)
}

fn mission_state(value: &Value, path: &str, errors: &mut Vec<String>) -> Option<MissionState> {
    let all: Vec<_> = MissionState::ALL
        .iter()
        .map(|state| state.as_str())
        .collect();
    name(value, path, MissionState::parse, &all, errors)
}

/// The `array(item, unique, min, max)` rule. `new Set(items)` compares primitives by value
/// and never equates objects or arrays.
fn array<T>(
    value: &Value,
    path: &str,
    unique: bool,
    min: usize,
    errors: &mut Vec<String>,
    mut item: impl FnMut(&Value, &str, &mut Vec<String>) -> Option<T>,
) -> Option<Vec<T>> {
    let Some(items) = value
        .as_array()
        .filter(|items| (min..=MAX_ARRAY).contains(&items.len()))
    else {
        fail(
            errors,
            path,
            &format!("expected an array with {min} to {MAX_ARRAY} items"),
        );
        return None;
    };
    let duplicate = unique
        && items.iter().enumerate().any(|(index, entry)| {
            !entry.is_object() && !entry.is_array() && items[..index].contains(entry)
        });
    if duplicate {
        fail(errors, path, "duplicate values");
    }
    let parsed: Vec<Option<T>> = items
        .iter()
        .enumerate()
        .map(|(index, entry)| item(entry, &format!("{path}[{index}]"), errors))
        .collect();
    if duplicate {
        return None;
    }
    parsed.into_iter().collect()
}

fn ids(value: &Value, path: &str, errors: &mut Vec<String>) -> Option<Vec<String>> {
    array(value, path, true, 0, errors, uuid)
}

/// `ordered(start, end)`: `Date.parse(end) < Date.parse(start)` fails.
fn ordered(start: &str, end: &str, path: &str, errors: &mut Vec<String>) {
    if parse_utc(end) < parse_utc(start) {
        fail(errors, path, "must be at or after the start timestamp");
    }
}

/// Structure of a `Mission`.
fn mission_structure(value: &Value, path: &str, errors: &mut Vec<String>) -> Option<Mission> {
    let fields = object(
        value,
        path,
        &[
            "schemaVersion",
            "id",
            "workspaceId",
            "leadAgentId",
            "budgetId",
            "state",
            "createdAt",
            "updatedAt",
            "version",
        ],
        &[],
        errors,
    )?;
    let version_ok = fields.field("schemaVersion", errors, schema_version);
    let id = fields.field("id", errors, uuid);
    let workspace_id = fields.field("workspaceId", errors, uuid);
    let lead_agent_id = fields.field("leadAgentId", errors, uuid);
    let budget_id = fields.field("budgetId", errors, uuid);
    let state = fields.field("state", errors, mission_state);
    let created_at = fields.field("createdAt", errors, timestamp);
    let updated_at = fields.field("updatedAt", errors, timestamp);
    let version = fields.field("version", errors, |value, path, errors| {
        integer(value, path, 1, errors)
    });
    version_ok?;
    Some(Mission {
        id: id?,
        workspace_id: workspace_id?,
        lead_agent_id: lead_agent_id?,
        budget_id: budget_id?,
        state: state?,
        created_at: created_at?,
        updated_at: updated_at?,
        version: version?,
    })
}

/// A complete `Mission` contract: structure, then `createdAt <= updatedAt`.
pub fn mission(value: &Value, path: &str, errors: &mut Vec<String>) -> Option<Mission> {
    let before = errors.len();
    let mission = mission_structure(value, path, errors).filter(|_| errors.len() == before)?;
    ordered(&mission.created_at, &mission.updated_at, path, errors);
    (errors.len() == before).then_some(mission)
}

fn task_structure(value: &Value, path: &str, errors: &mut Vec<String>) -> Option<Task> {
    let fields = object(
        value,
        path,
        &[
            "schemaVersion",
            "id",
            "missionId",
            "dependsOn",
            "state",
            "attempt",
            "requirements",
            "evidenceIds",
        ],
        &[
            "parentTaskId",
            "assignedAgentId",
            "leaseId",
            "verification",
            "access",
        ],
        errors,
    )?;
    let version_ok = fields.field("schemaVersion", errors, schema_version);
    let id = fields.field("id", errors, uuid);
    let mission_id = fields.field("missionId", errors, uuid);
    let parent_task_id = fields.optional("parentTaskId", errors, uuid);
    let depends_on = fields.field("dependsOn", errors, ids);
    let assigned_agent_id = fields.optional("assignedAgentId", errors, uuid);
    let state = fields.field("state", errors, task_state);
    let attempt = fields.field("attempt", errors, |value, path, errors| {
        integer(value, path, 0, errors)
    });
    let lease_id = fields.optional("leaseId", errors, uuid);
    let requirements = fields.field("requirements", errors, |value, path, errors| {
        array(value, path, true, 0, errors, |item, path, errors| {
            text(item, path, LABEL_MAX, errors)
        })
    });
    let evidence_ids = fields.field("evidenceIds", errors, ids);
    let verification = fields.optional("verification", errors, |value, path, errors| {
        name(
            value,
            path,
            Verification::parse,
            &["unverified", "verified"],
            errors,
        )
    });
    // `access` is the literal "write" when present (ADR 0028).
    let write_access = fields.optional("access", errors, |value, path, errors| {
        enumeration(value, path, &["write"], errors)
    });
    version_ok?;
    Some(Task {
        id: id?,
        mission_id: mission_id?,
        parent_task_id: parent_task_id?,
        depends_on: depends_on?,
        assigned_agent_id: assigned_agent_id?,
        state: state?,
        attempt: attempt?,
        lease_id: lease_id?,
        requirements: requirements?,
        evidence_ids: evidence_ids?,
        verification: verification?,
        write_access: write_access?.is_some(),
    })
}

/// `checkTask`: the semantic rules of one task.
pub fn check_task(task: &Task, path: &str, errors: &mut Vec<String>) {
    if task.depends_on.contains(&task.id) || task.parent_task_id.as_ref() == Some(&task.id) {
        fail(errors, path, "task cannot reference itself");
    }
    if ASSIGNED_TASK_STATES.contains(&task.state) && task.assigned_agent_id.is_none() {
        fail(
            errors,
            &format!("{path}.assignedAgentId"),
            "required for assigned work",
        );
    }
    if task.state == TaskState::Running && (task.lease_id.is_none() || task.attempt == 0) {
        fail(
            errors,
            path,
            "running work needs a lease and a positive attempt number",
        );
    }
    if task.state == TaskState::Completed && task.verification.is_none() {
        fail(
            errors,
            &format!("{path}.verification"),
            "completed work must declare verification",
        );
    }
    if task.verification == Some(Verification::Verified)
        && (task.state != TaskState::Completed || task.evidence_ids.is_empty())
    {
        fail(
            errors,
            path,
            "verified work must be completed and cite evidence",
        );
    }
}

/// `acyclic`: depth-first search over the edges whose target is a known key.
fn acyclic(edges: &[(String, Vec<String>)], path: &str, errors: &mut Vec<String>) {
    let index: HashMap<&str, &[String]> = edges
        .iter()
        .map(|(id, targets)| (id.as_str(), targets.as_slice()))
        .collect();
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    fn walk<'a>(
        id: &'a str,
        index: &HashMap<&'a str, &'a [String]>,
        visiting: &mut HashSet<&'a str>,
        visited: &mut HashSet<&'a str>,
    ) -> bool {
        if visiting.contains(id) {
            return false;
        }
        if visited.contains(id) {
            return true;
        }
        visiting.insert(id);
        for target in index.get(id).copied().unwrap_or_default() {
            if index.contains_key(target.as_str()) && !walk(target, index, visiting, visited) {
                return false;
            }
        }
        visiting.remove(id);
        visited.insert(id);
        true
    }
    for (id, _) in edges {
        if !walk(id, &index, &mut visiting, &mut visited) {
            fail(errors, path, "cycle detected");
            return;
        }
    }
}

/// `checkGraph`: duplicate IDs, task rules, references, dependency completion, cycles.
fn check_graph(graph: &TaskGraph, path: &str, errors: &mut Vec<String>) {
    let mut tasks: HashMap<&str, &Task> = HashMap::new();
    for task in &graph.tasks {
        if tasks.insert(task.id.as_str(), task).is_some() {
            fail(errors, &format!("{path}.tasks"), "duplicate ID");
        }
    }
    let mut dependencies = Vec::new();
    let mut parents = Vec::new();
    for task in &graph.tasks {
        check_task(task, &format!("{path}.tasks[{}]", task.id), errors);
        if task.mission_id != graph.mission_id {
            fail(errors, path, "task belongs to another mission");
        }
        for id in task.depends_on.iter().chain(&task.parent_task_id) {
            if !tasks.contains_key(id.as_str()) {
                fail(errors, path, &format!("unknown task reference {id}"));
            }
        }
        let started = matches!(
            task.state,
            TaskState::Running | TaskState::Verifying | TaskState::Completed
        );
        if started
            && task.depends_on.iter().any(|id| {
                tasks.get(id.as_str()).map(|task| task.state) != Some(TaskState::Completed)
            })
        {
            fail(
                errors,
                path,
                "started or completed work requires completed dependencies",
            );
        }
        dependencies.push((task.id.clone(), task.depends_on.clone()));
        parents.push((
            task.id.clone(),
            task.parent_task_id.iter().cloned().collect(),
        ));
    }
    acyclic(&dependencies, &format!("{path}.dependsOn"), errors);
    acyclic(&parents, &format!("{path}.parentTaskId"), errors);
}

/// A complete `TaskGraph` contract.
pub fn task_graph(value: &Value, path: &str, errors: &mut Vec<String>) -> Option<TaskGraph> {
    let before = errors.len();
    let fields = object(
        value,
        path,
        &["schemaVersion", "missionId", "tasks"],
        &[],
        errors,
    )?;
    let version_ok = fields.field("schemaVersion", errors, schema_version);
    let mission_id = fields.field("missionId", errors, uuid);
    let tasks = fields.field("tasks", errors, |value, path, errors| {
        array(value, path, false, 0, errors, task_structure)
    });
    version_ok?;
    let graph = TaskGraph {
        mission_id: mission_id?,
        tasks: tasks?,
    };
    if errors.len() != before {
        return None;
    }
    check_graph(&graph, path, errors);
    (errors.len() == before).then_some(graph)
}

/// A complete `Task` contract (structure and `checkTask`).
pub fn task(value: &Value, path: &str, errors: &mut Vec<String>) -> Option<Task> {
    let before = errors.len();
    let task = task_structure(value, path, errors).filter(|_| errors.len() == before)?;
    check_task(&task, path, errors);
    (errors.len() == before).then_some(task)
}

fn event_source(value: &Value, path: &str, errors: &mut Vec<String>) -> Option<()> {
    let fields = object(
        value,
        path,
        &["runtime", "channel"],
        &["adapter", "adapterVersion"],
        errors,
    )?;
    let runtime_id = |value: &Value, path: &str, errors: &mut Vec<String>| {
        if value.as_str().is_some_and(is_runtime_id) {
            Some(())
        } else {
            fail(
                errors,
                path,
                "expected a lowercase adapter or engine identifier",
            );
            None
        }
    };
    let runtime = fields.field("runtime", errors, runtime_id);
    let channel = fields.field("channel", errors, |value, path, errors| {
        enumeration(value, path, &EVENT_CHANNELS, errors)
    });
    let adapter = fields.optional("adapter", errors, runtime_id);
    let adapter_version = fields.optional("adapterVersion", errors, |value, path, errors| {
        text(value, path, 64, errors)
    });
    runtime
        .and(channel)
        .and(adapter)
        .and(adapter_version.map(drop))
}

/// The `AgentEvent` body rule: control bodies, otherwise a valid v0 event body.
fn event_body_rule(value: &Value, path: &str, errors: &mut Vec<String>) -> Option<()> {
    let kind = value
        .as_object()
        .and_then(|body| body.get("type"))
        .and_then(Value::as_str);
    match kind {
        Some(kind @ ("mission.state" | "task.state")) => {
            let fields = object(value, path, &["type", "state"], &[], errors)?;
            let literal = fields.field("type", errors, |value, path, errors| {
                if value.as_str() == Some(kind) {
                    Some(())
                } else {
                    fail(errors, path, &format!("expected {kind:?}"));
                    None
                }
            });
            let state = fields.field("state", errors, |value, path, errors| {
                if kind == "mission.state" {
                    mission_state(value, path, errors).map(drop)
                } else {
                    task_state(value, path, errors).map(drop)
                }
            });
            literal.and(state)
        }
        _ => {
            let mut body_errors = Vec::new();
            event_body::check(value, &mut body_errors);
            for error in &body_errors {
                errors.push(format!("{path}: {error}."));
            }
            body_errors.is_empty().then_some(())
        }
    }
}

/// A complete `AgentEvent` contract.
pub fn agent_event(value: &Value, path: &str, errors: &mut Vec<String>) -> Option<AgentEvent> {
    let before = errors.len();
    let fields = object(
        value,
        path,
        &[
            "schemaVersion",
            "id",
            "workspaceId",
            "sessionId",
            "source",
            "observedAt",
            "confidence",
            "body",
        ],
        &[
            "missionId",
            "taskId",
            "agentId",
            "parentId",
            "correlationId",
            "sourceTimestamp",
            "sequence",
        ],
        errors,
    )?;
    fields.field("schemaVersion", errors, schema_version);
    for key in ["id", "workspaceId", "sessionId"] {
        fields.field(key, errors, uuid);
    }
    for key in [
        "missionId",
        "taskId",
        "agentId",
        "parentId",
        "correlationId",
    ] {
        fields.optional(key, errors, uuid);
    }
    fields.field("source", errors, event_source);
    fields.optional("sourceTimestamp", errors, timestamp);
    fields.field("observedAt", errors, timestamp);
    fields.optional("sequence", errors, |value, path, errors| {
        integer(value, path, 0, errors)
    });
    fields.field("confidence", errors, |value, path, errors| {
        enumeration(value, path, &CONFIDENCE, errors)
    });
    fields.field("body", errors, event_body_rule);
    if errors.len() != before {
        return None;
    }
    // Semantic rules (`checkSemantic('agentEvent')`), on a structurally valid event.
    let map = fields.map;
    let has = |key: &str| map.contains_key(key);
    let body = map["body"].as_object().expect("structure checked");
    let kind = body["type"].as_str().expect("structure checked");
    if has("taskId") && !has("missionId") {
        fail(errors, path, "task events require mission context");
    }
    if kind == "mission.state" && !has("missionId") {
        fail(errors, path, "mission state requires missionId");
    } else if kind == "task.state" && !has("taskId") {
        fail(errors, path, "task state requires taskId");
    } else if kind != "mission.state" && kind != "task.state" {
        for key in event_body::required_envelope(kind) {
            if !has(key) {
                fail(errors, path, &format!("{key}: required for {kind}"));
            }
        }
    }
    (errors.len() == before).then(|| AgentEvent::from_validated(map.clone()))
}

/// `mission.create` parameters: a mission, its task graph, and the graph's mission ID.
pub fn mission_create(
    value: &Value,
    path: &str,
    errors: &mut Vec<String>,
) -> Option<MissionCreate> {
    let before = errors.len();
    let fields = object(value, path, &["mission", "graph"], &[], errors)?;
    let mission = fields.field("mission", errors, mission);
    let graph = fields.field("graph", errors, task_graph);
    if errors.len() != before {
        return None;
    }
    let (mission, graph) = (mission?, graph?);
    if graph.mission_id != mission.id {
        fail(
            errors,
            &format!("{path}.graph.missionId"),
            "graph belongs to another mission",
        );
        return None;
    }
    Some(MissionCreate { mission, graph })
}

/// `task.transition` parameters.
pub fn task_transition(
    value: &Value,
    path: &str,
    errors: &mut Vec<String>,
) -> Option<TaskTransition> {
    let before = errors.len();
    let fields = object(
        value,
        path,
        &["missionId", "taskId", "eventId", "from", "to"],
        &["supervisorId"],
        errors,
    )?;
    let mission_id = fields.field("missionId", errors, uuid);
    let task_id = fields.field("taskId", errors, uuid);
    let event_id = fields.field("eventId", errors, uuid);
    let from = fields.field("from", errors, task_state);
    let to = fields.field("to", errors, task_state);
    let supervisor_id = fields.optional("supervisorId", errors, uuid)?;
    let transition = TaskTransition {
        mission_id: mission_id?,
        task_id: task_id?,
        event_id: event_id?,
        from: from?,
        to: to?,
        supervisor_id,
    };
    if transition.supervisor_id.is_some()
        && !(transition.to == TaskState::Running
            && matches!(transition.from, TaskState::Queued | TaskState::Assigned))
    {
        fail(
            errors,
            path,
            "supervisorId is only allowed when admitting running work",
        );
    }
    (errors.len() == before).then_some(transition)
}

fn digest(value: &Value, path: &str, errors: &mut Vec<String>) -> Option<String> {
    match value.as_str() {
        Some(value)
            if value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) =>
        {
            Some(value.into())
        }
        _ => {
            fail(errors, path, "expected a lowercase SHA-256 digest");
            None
        }
    }
}

pub fn execution_admission(
    value: &Value,
    path: &str,
    errors: &mut Vec<String>,
) -> Option<ExecutionAdmission> {
    let before = errors.len();
    let fields = object(
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
        errors,
    )?;
    let admission = ExecutionAdmission {
        mission_id: fields.field("missionId", errors, uuid)?,
        workspace_id: fields.field("workspaceId", errors, uuid)?,
        task_id: fields.field("taskId", errors, uuid)?,
        lease_id: fields.field("leaseId", errors, uuid)?,
        holder_agent_id: fields.field("holderAgentId", errors, uuid)?,
        supervisor_id: fields.field("supervisorId", errors, uuid)?,
        attempt: fields.field("attempt", errors, |v, p, e| integer(v, p, 1, e))?,
        mission_version: fields.field("missionVersion", errors, |v, p, e| integer(v, p, 1, e))?,
        task_digest: fields.field("taskDigest", errors, digest)?,
        graph_digest: fields.field("graphDigest", errors, digest)?,
        admission_digest: fields.field("admissionDigest", errors, digest)?,
        admitted_at: fields.field("admittedAt", errors, timestamp)?,
    };
    (errors.len() == before).then_some(admission)
}

pub fn execution_observation(
    value: &Value,
    path: &str,
    errors: &mut Vec<String>,
) -> Option<ExecutionObservation> {
    let before = errors.len();
    let fields = object(
        value,
        path,
        &[
            "missionId",
            "taskId",
            "leaseId",
            "holderAgentId",
            "supervisorId",
            "attempt",
            "admissionDigest",
            "observationId",
            "kind",
        ],
        &[],
        errors,
    )?;
    let observation = ExecutionObservation {
        mission_id: fields.field("missionId", errors, uuid)?,
        task_id: fields.field("taskId", errors, uuid)?,
        lease_id: fields.field("leaseId", errors, uuid)?,
        holder_agent_id: fields.field("holderAgentId", errors, uuid)?,
        supervisor_id: fields.field("supervisorId", errors, uuid)?,
        attempt: fields.field("attempt", errors, |v, p, e| integer(v, p, 1, e))?,
        admission_digest: fields.field("admissionDigest", errors, digest)?,
        observation_id: fields.field("observationId", errors, uuid)?,
        kind: fields.field("kind", errors, |v, p, e| {
            enumeration(v, p, &["turn-promise-settled"], e)?;
            v.as_str().map(str::to_owned)
        })?,
    };
    (errors.len() == before).then_some(observation)
}

/// A bounded, scoped assertion; the store binds it to the captured admission.
pub fn execution_local_drain(
    value: &Value,
    path: &str,
    errors: &mut Vec<String>,
) -> Option<ExecutionLocalDrain> {
    let before = errors.len();
    let fields = object(
        value,
        path,
        &[
            "missionId",
            "taskId",
            "leaseId",
            "holderAgentId",
            "supervisorId",
            "attempt",
            "admissionDigest",
            "proofId",
            "kind",
            "coverage",
            "providerOperations",
            "toolOperations",
        ],
        &[],
        errors,
    )?;
    let drain = ExecutionLocalDrain {
        mission_id: fields.field("missionId", errors, uuid)?,
        task_id: fields.field("taskId", errors, uuid)?,
        lease_id: fields.field("leaseId", errors, uuid)?,
        holder_agent_id: fields.field("holderAgentId", errors, uuid)?,
        supervisor_id: fields.field("supervisorId", errors, uuid)?,
        attempt: fields.field("attempt", errors, |v, p, e| integer(v, p, 1, e))?,
        admission_digest: fields.field("admissionDigest", errors, digest)?,
        proof_id: fields.field("proofId", errors, uuid)?,
        kind: fields.field("kind", errors, |v, p, e| {
            enumeration(v, p, &["local-operations-drained"], e)?;
            v.as_str().map(str::to_owned)
        })?,
        coverage: fields.field("coverage", errors, |v, p, e| {
            enumeration(v, p, &["extalia-native-local-v1"], e)?;
            v.as_str().map(str::to_owned)
        })?,
        provider_operations: fields.field("providerOperations", errors, |v, p, e| {
            bounded_operation_count(v, p, 20, e)
        })?,
        tool_operations: fields.field("toolOperations", errors, |v, p, e| {
            bounded_operation_count(v, p, 80, e)
        })?,
    };
    (errors.len() == before).then_some(drain)
}
fn bounded_operation_count(
    value: &Value,
    path: &str,
    max: u64,
    errors: &mut Vec<String>,
) -> Option<u64> {
    let count = integer(value, path, 0, errors)?;
    if count > max {
        fail(errors, path, "operation count exceeds coverage limit");
        return None;
    }
    Some(count)
}

/// `mission.heartbeat` parameters: bounded, unique task lease ownership claims.
pub fn mission_heartbeat(
    value: &Value,
    path: &str,
    errors: &mut Vec<String>,
) -> Option<MissionHeartbeat> {
    let before = errors.len();
    let fields = object(value, path, &["missionId", "leases"], &[], errors)?;
    let mission_id = fields.field("missionId", errors, uuid);
    let items = fields.get("leases")?.as_array();
    let Some(items) = items.filter(|items| (1..=MAX_TASKS_PER_MISSION).contains(&items.len()))
    else {
        fail(
            errors,
            &format!("{path}.leases"),
            "expected 1 to 64 lease claims",
        );
        return None;
    };
    let mut task_ids = HashSet::new();
    let mut lease_ids = HashSet::new();
    let mut leases = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let item_path = format!("{path}.leases[{index}]");
        let fields = object(
            item,
            &item_path,
            &["taskId", "leaseId", "holderAgentId"],
            &[],
            errors,
        )?;
        let claim = LeaseClaim {
            task_id: fields.field("taskId", errors, uuid)?,
            lease_id: fields.field("leaseId", errors, uuid)?,
            holder_agent_id: fields.field("holderAgentId", errors, uuid)?,
        };
        if !task_ids.insert(claim.task_id.clone()) || !lease_ids.insert(claim.lease_id.clone()) {
            fail(
                errors,
                &item_path,
                "lease claims require unique tasks and leases",
            );
        }
        leases.push(claim);
    }
    (errors.len() == before).then_some(MissionHeartbeat {
        mission_id: mission_id?,
        leases,
    })
}

/// `event.commit` parameters: a mission control event, which must name its mission.
pub fn event_commit(value: &Value, path: &str, errors: &mut Vec<String>) -> Option<AgentEvent> {
    let before = errors.len();
    let fields = object(value, path, &["event"], &[], errors)?;
    let event = fields.field("event", errors, agent_event);
    if fields
        .get("event")
        .and_then(Value::as_object)
        .is_some_and(|event| !event.contains_key("missionId"))
    {
        fail(
            errors,
            &format!("{path}.event.missionId"),
            "required for mission control events",
        );
    }
    event.filter(|_| errors.len() == before)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn task_json(id: &str, state: &str) -> Value {
        json!({ "schemaVersion": 1, "id": id, "missionId": "00000000-0000-4000-8000-000000000002",
            "dependsOn": [], "state": state, "attempt": 0, "requirements": [], "evidenceIds": [] })
    }

    #[test]
    fn task_semantics_follow_check_task() {
        let mut errors = Vec::new();
        let id = "00000000-0000-4000-8000-000000000005";
        assert!(task(&task_json(id, "queued"), "task", &mut errors).is_some());
        assert!(task(&task_json(id, "assigned"), "task", &mut errors).is_none());
        assert!(task(&task_json(id, "completed"), "task", &mut errors).is_none());
        let mut running = task_json(id, "running");
        running["assignedAgentId"] = json!("00000000-0000-4000-8000-000000000003");
        running["leaseId"] = json!("00000000-0000-4000-8000-000000000030");
        running["attempt"] = json!(1);
        errors.clear();
        assert!(task(&running, "task", &mut errors).is_some(), "{errors:?}");
        running["attempt"] = json!(0);
        assert!(task(&running, "task", &mut errors).is_none());
        let mut verified = task_json(id, "queued");
        verified["verification"] = json!("verified");
        assert!(task(&verified, "task", &mut errors).is_none());
    }

    #[test]
    fn event_semantics_and_v0_bodies() {
        let base = json!({ "schemaVersion": 1, "id": "00000000-0000-4000-8000-000000000013",
            "workspaceId": "00000000-0000-4000-8000-000000000001", "sessionId": "00000000-0000-4000-8000-000000000014",
            "missionId": "00000000-0000-4000-8000-000000000002", "taskId": "00000000-0000-4000-8000-000000000005",
            "agentId": "00000000-0000-4000-8000-000000000003",
            "source": { "runtime": "extalia-native", "channel": "system" },
            "observedAt": "2026-01-01T00:01:00.000Z", "confidence": "reported",
            "body": { "type": "tool.started", "tool": "read", "kind": "read", "label": "read" } });
        let mut errors = Vec::new();
        assert!(
            agent_event(&base, "event", &mut errors).is_some(),
            "{errors:?}"
        );
        let cases = [
            (
                "body",
                json!({ "type": "tool.started", "tool": "read", "kind": "nope", "label": "read" }),
            ),
            (
                "body",
                json!({ "type": "agent.state", "state": "working", "extra": 1 }),
            ),
            ("body", json!({ "type": "no.such.type" })),
            ("body", json!({ "type": "task.state", "state": "paused" })),
            (
                "body",
                json!({ "type": "turn.completed", "usage": { "inputTokens": 1.5 } }),
            ),
            (
                "source",
                json!({ "runtime": "Extalia", "channel": "system" }),
            ),
            ("observedAt", json!("2026-02-30T00:00:00Z")),
        ];
        for (key, value) in cases {
            let mut event = base.clone();
            event[key] = value.clone();
            assert!(
                agent_event(&event, "event", &mut Vec::new()).is_none(),
                "{key}: {value}"
            );
        }
        // Envelope requirements of v0 bodies apply after the structural check.
        let mut event = base.clone();
        event.as_object_mut().unwrap().remove("agentId");
        event["body"] = json!({ "type": "agent.state", "state": "working" });
        assert!(agent_event(&event, "event", &mut Vec::new()).is_none());
        let mut event = base.clone();
        event.as_object_mut().unwrap().remove("missionId");
        assert!(agent_event(&event, "event", &mut Vec::new()).is_none());
    }

    #[test]
    fn graph_references_and_cycles() {
        let a = "00000000-0000-4000-8000-000000000005";
        let b = "00000000-0000-4000-8000-000000000020";
        let graph = |tasks: Vec<Value>| json!({ "schemaVersion": 1, "missionId": "00000000-0000-4000-8000-000000000002", "tasks": tasks });
        let mut first = task_json(a, "queued");
        let mut second = task_json(b, "queued");
        second["dependsOn"] = json!([a]);
        assert!(
            task_graph(
                &graph(vec![first.clone(), second.clone()]),
                "g",
                &mut Vec::new()
            )
            .is_some()
        );
        first["dependsOn"] = json!([b]);
        assert!(
            task_graph(
                &graph(vec![first.clone(), second.clone()]),
                "g",
                &mut Vec::new()
            )
            .is_none()
        );
        second["dependsOn"] = json!(["00000000-0000-4000-8000-000000000099"]);
        first["dependsOn"] = json!([]);
        assert!(task_graph(&graph(vec![first.clone(), second]), "g", &mut Vec::new()).is_none());
        assert!(task_graph(&graph(vec![first.clone(), first]), "g", &mut Vec::new()).is_none());
    }
}
