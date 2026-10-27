//! Store admission policy for `event.commit`, mirroring `nativeEvent` in
//! `packages/host/src/missionCheckpoints.ts` (ADR 0014): only native control metadata.
//! Model prose, tool arguments/results, arbitrary labels and raw errors are refused even
//! though the wire contract accepts them. Rules that need stored state (mission, task,
//! assignee, current states, the task's write access) are applied by the store inside its
//! transaction.
//!
//! Worker activity (`agent.state`, `tool.started`, `tool.completed`) follows the shared
//! journal admission table of `@extalia/protocol` (`missionJournalRole`, ADR 0028): the
//! generated `packages/protocol/schemas/journal-admission.json` is embedded at compile time
//! and parsed once, so the daemon and the TypeScript host cannot drift. A read-only worker
//! reports read/search activity; a write-capable worker may also report bounded edits.

use std::sync::OnceLock;

use serde_json::{Map, Value};

use super::{AgentEvent, MissionError};

/// `packages/protocol/schemas/journal-admission.json`.
const ADMISSION_SOURCE: &str =
    include_str!("../../../../packages/protocol/schemas/journal-admission.json");

/// Worker roles of the journal admission table, least privileged first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerRole {
    /// `read-only-worker`: any task.
    ReadOnly,
    /// `write-worker`: only a task with `access: "write"`.
    Write,
}

impl WorkerRole {
    /// Table order: the first role that admits an activity is the one it needs.
    pub const ALL: [Self; 2] = [Self::ReadOnly, Self::Write];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only-worker",
            Self::Write => "write-worker",
        }
    }
}

/// What an admitted event still needs from the stored task.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Admission {
    /// The least privileged worker role that may journal the event.
    pub role: WorkerRole,
}

impl Admission {
    const ANY: Self = Self {
        role: WorkerRole::ReadOnly,
    };

    /// Whether a task with (or without) write access may journal the event.
    pub const fn permits(self, write_access: bool) -> bool {
        matches!(self.role, WorkerRole::ReadOnly) || write_access
    }
}

struct RoleActivity {
    agent_activities: Vec<String>,
    tool_kinds: Vec<String>,
}

struct AdmissionTable {
    roles: Vec<RoleActivity>,
    edit_tools: Vec<String>,
    target_max_length: usize,
    target_max_segments: usize,
    target_punctuation: String,
}

fn strings(value: &Value, what: &str) -> Vec<String> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("journal-admission.json lists {what}"))
        .iter()
        .map(|item| {
            item.as_str()
                .unwrap_or_else(|| panic!("journal-admission.json names {what}"))
                .to_owned()
        })
        .collect()
}

fn table() -> &'static AdmissionTable {
    static TABLE: OnceLock<AdmissionTable> = OnceLock::new();
    TABLE.get_or_init(|| {
        let root: Value =
            serde_json::from_str(ADMISSION_SOURCE).expect("journal-admission.json is JSON");
        let names = strings(&root["roles"], "roles");
        assert_eq!(
            names,
            WorkerRole::ALL.map(WorkerRole::as_str),
            "journal-admission.json orders the known roles"
        );
        let target = &root["editTarget"];
        let bound = |key: &str| {
            target[key]
                .as_u64()
                .and_then(|value| usize::try_from(value).ok())
                .unwrap_or_else(|| panic!("journal-admission.json bounds {key}"))
        };
        AdmissionTable {
            roles: names
                .iter()
                .map(|name| RoleActivity {
                    agent_activities: strings(
                        &root["activity"][name]["agentActivities"],
                        "agent activities",
                    ),
                    tool_kinds: strings(&root["activity"][name]["toolKinds"], "tool kinds"),
                })
                .collect(),
            edit_tools: strings(&root["editTools"], "edit tools"),
            target_max_length: bound("maxLength"),
            target_max_segments: bound("maxSegments"),
            target_punctuation: target["punctuation"]
                .as_str()
                .expect("journal-admission.json lists the target punctuation")
                .to_owned(),
        }
    })
}

/// `isJournalEditTarget`: a bounded ASCII path relative to the worker's worktree.
pub fn is_edit_target(text: &str) -> bool {
    let table = table();
    if text.is_empty() || text.len() > table.target_max_length {
        return false;
    }
    let mut segments = 0;
    for segment in text.split('/') {
        segments += 1;
        if segments > table.target_max_segments
            || segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.starts_with(' ')
            || segment.ends_with(' ')
            || !segment.chars().all(|character| {
                character.is_ascii_alphanumeric() || table.target_punctuation.contains(character)
            })
        {
            return false;
        }
    }
    true
}

fn role_admits(rules: &RoleActivity, body: &Map<String, Value>) -> bool {
    let text = |key: &str| body.get(key).and_then(Value::as_str);
    if text("type") == Some("agent.state") {
        return body.get("activity").is_none_or(|activity| {
            activity
                .as_str()
                .is_some_and(|activity| rules.agent_activities.iter().any(|item| item == activity))
        });
    }
    let Some(kind) = text("kind") else {
        return false;
    };
    if !rules.tool_kinds.iter().any(|item| item == kind)
        || !text("tool").is_some_and(is_tool_name)
        || text("label") != text("tool")
    {
        return false;
    }
    match body.get("target") {
        None => kind != "edit" || is_edit_tool(text("tool")),
        Some(target) => {
            kind == "edit"
                && is_edit_tool(text("tool"))
                && target.as_str().is_some_and(is_edit_target)
        }
    }
}

fn is_edit_tool(tool: Option<&str>) -> bool {
    tool.is_some_and(|tool| table().edit_tools.iter().any(|item| item == tool))
}

/// `missionJournalRole`: the least privileged role that may journal an activity body
/// (`agent.state`, `tool.started`, `tool.completed`), or `None` when no worker may.
pub fn journal_role(body: &Map<String, Value>) -> Option<WorkerRole> {
    WorkerRole::ALL
        .into_iter()
        .zip(&table().roles)
        .find(|(_, rules)| role_admits(rules, body))
        .map(|(role, _)| role)
}

/// Source runtime of native control events (`event.source.runtime` in `nativeEvent`).
pub const NATIVE_RUNTIME: &str = "extalia-native";

/// Native control body types and the only keys each may carry.
const BODY_FIELDS: [(&str, &[&str]); 8] = [
    ("mission.state", &["type", "state"]),
    ("task.state", &["type", "state"]),
    ("task.assigned", &["type", "assigneeAgentId"]),
    ("agent.state", &["type", "state", "activity"]),
    ("tool.started", &["type", "tool", "kind", "label", "target"]),
    (
        "tool.completed",
        &["type", "tool", "kind", "label", "ok", "target"],
    ),
    ("turn.completed", &["type", "usage"]),
    ("turn.failed", &["type", "error"]),
];

/// `TURN_FAILURE_CODES`: bounded turn outcome codes instead of raw errors.
const TURN_FAILURE_CODES: [&str; 11] = [
    "provider-failed",
    "turn-incomplete",
    "cancelled",
    "timeout",
    "execution-unknown",
    "dependency-failed",
    "capacity-unknown",
    "persistence-failed",
    "budget-exhausted",
    "usage-unknown",
    "mission-deadline",
];
/// Upper bound of a reported token count (`nativeEvent`, ADR 0015).
const MAX_REPORTED_TOKENS: f64 = 1_000_000_000_000.0;

/// `^[a-zA-Z][\w.-]{0,63}$`: a named native read/search tool.
fn is_tool_name(text: &str) -> bool {
    let bytes = text.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_alphabetic()
        && bytes[1..]
            .iter()
            .all(|&byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

const fn invalid(reason: &'static str) -> MissionError {
    MissionError::Invalid(reason)
}

/// Event-local rules. A valid result still needs the store's ownership checks and, for
/// activity only a write-capable worker may journal, the task's write access
/// ([`Admission::permits`]).
pub fn admit(event: &AgentEvent) -> Result<Admission, MissionError> {
    let value = event.to_value();
    let source = value["source"].as_object().expect("validated event");
    if event.agent_id().is_none()
        || value["confidence"] != "reported"
        || source.get("runtime").and_then(Value::as_str) != Some(NATIVE_RUNTIME)
        || source.get("channel").and_then(Value::as_str) != Some("system")
        || source.len() != 2
    {
        return Err(invalid("not a native control event"));
    }
    let body = event.body();
    let kind = event.body_type();
    let Some((_, allowed)) = BODY_FIELDS.iter().find(|(name, _)| *name == kind) else {
        return Err(invalid("event type is not native control metadata"));
    };
    if body.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid("event body carries fields beyond control metadata"));
    }
    let text = |key: &str| body.get(key).and_then(Value::as_str);
    match kind {
        "mission.state" if event.task_id().is_some() => {
            Err(invalid("mission state events carry no task"))
        }
        "mission.state" => Ok(Admission::ANY),
        _ if event.task_id().is_none() => Err(invalid("control event needs its task")),
        "agent.state" | "tool.started" | "tool.completed" => journal_role(body)
            .map(|role| Admission { role })
            .ok_or(invalid(
                "worker activity is not admitted for native workers",
            )),
        "turn.failed" if !text("error").is_some_and(|code| TURN_FAILURE_CODES.contains(&code)) => {
            Err(invalid("turn failure is not a bounded outcome code"))
        }
        "turn.completed" => match body.get("usage") {
            None => Ok(Admission::ANY),
            Some(Value::Object(usage))
                if !usage.is_empty()
                    && usage.iter().all(|(key, count)| {
                        (key == "inputTokens" || key == "outputTokens")
                            && count.as_f64().is_some_and(|count| {
                                count.fract() == 0.0 && (0.0..=MAX_REPORTED_TOKENS).contains(&count)
                            })
                    }) =>
            {
                Ok(Admission::ANY)
            }
            Some(_) => Err(invalid("usage is not reported token counts")),
        },
        _ => Ok(Admission::ANY),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde_json::json;

    use super::*;
    use crate::mission::contract;

    fn read(relative: &str) -> String {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative);
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
    }

    #[test]
    fn the_embedded_table_is_the_committed_file() {
        assert_eq!(
            read("../../packages/protocol/schemas/journal-admission.json"),
            ADMISSION_SOURCE
        );
        // Parsing succeeds and a write worker may do everything a read-only worker may.
        let table = table();
        for (read_only, write) in [
            (
                &table.roles[0].agent_activities,
                &table.roles[1].agent_activities,
            ),
            (&table.roles[0].tool_kinds, &table.roles[1].tool_kinds),
        ] {
            assert!(read_only.iter().all(|item| write.contains(item)));
            assert!(!read_only.iter().any(|item| item == "edit"));
        }
    }

    /// The shared TypeScript fixture: the same role for every body, and the store verdict
    /// for a read-only and a write-capable task.
    #[test]
    fn verdicts_match_the_shared_fixture() {
        let fixture: Value = serde_json::from_str(&read(
            "../../packages/protocol/test/fixtures/journal/admission.json",
        ))
        .unwrap();
        assert_eq!(fixture["contract"], "missionJournalRole");
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() > 20);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let expected = case["role"].as_str();
            let body = case["body"].clone();
            assert_eq!(
                journal_role(body.as_object().unwrap()).map(WorkerRole::as_str),
                expected,
                "{name}: role"
            );
            let raw = json!({ "schemaVersion": 1, "id": "00000000-0000-4000-8000-000000000001",
                "workspaceId": "00000000-0000-4000-8000-000000000002", "sessionId": "00000000-0000-4000-8000-000000000003",
                "missionId": "00000000-0000-4000-8000-000000000006", "taskId": "00000000-0000-4000-8000-000000000004",
                "agentId": "00000000-0000-4000-8000-000000000005",
                "source": { "runtime": "extalia-native", "channel": "system" },
                "observedAt": "2026-01-01T00:00:00.000Z", "confidence": "reported", "body": body });
            let mut errors = Vec::new();
            let admission = contract::agent_event(&raw, "event", &mut errors)
                .ok_or(invalid("contract"))
                .and_then(|event| admit(&event))
                .ok();
            for write_access in [false, true] {
                let admitted = admission.is_some_and(|admission| admission.permits(write_access));
                let wanted = match expected {
                    Some("read-only-worker") => true,
                    Some("write-worker") => write_access,
                    _ => false,
                };
                assert_eq!(admitted, wanted, "{name}: write access {write_access}");
            }
        }
    }
}
