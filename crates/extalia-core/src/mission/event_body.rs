//! v0 event bodies inside an `AgentEvent`, mirroring `EVENT_SPECS` and `checkField` of
//! `packages/protocol/src/validate.ts`. A wire `event.commit` may carry any of them; the
//! store's admission policy then accepts only native control metadata (ADR 0014).

use serde_json::Value;

use super::contract::{is_js_space, js_length, number};

const ID_LIMIT: usize = 200;
const LABEL_LIMIT: usize = 2_000;
/// `TEXT_LIMIT` of `validate.ts`.
const TEXT_LIMIT: usize = 200_000;
const MAX_PROMPT_ATTACHMENTS: usize = 10;
const MAX_SKILL_LOAD_ENTRIES: usize = 8;
const MAX_SKILL_LOAD_CHARACTERS: u64 = 24_000;
const SKILL_LOAD_REASONS: &[&str] = &[
    "default-memory",
    "configured-team",
    "explicit-request",
    "current-context",
    "recent-context",
    "dependency",
];
const SKILL_LOAD_STATUSES: &[&str] = &["loaded", "budget", "unavailable", "not-configured"];
const SKILL_LOAD_INTENTS: &[&str] = &[
    "planning",
    "debugging",
    "testing",
    "review",
    "security",
    "documentation",
    "design",
    "refactoring",
    "delivery",
];

const AGENT_STATES: &[&str] = &[
    "idle",
    "thinking",
    "working",
    "waiting",
    "delegating",
    "blocked",
    "offline",
];
const AGENT_PHASES: &[&str] = &[
    "planning",
    "approval",
    "input",
    "compacting",
    "interrupted",
    "error",
    "ended",
];
const STOP_REASONS: &[&str] = &[
    "quota",
    "rate-limit",
    "overloaded",
    "auth",
    "context",
    "crash",
    "interrupted",
];
const ACTIVITY_KINDS: &[&str] = &[
    "edit",
    "command",
    "test",
    "search",
    "read",
    "web",
    "delegate",
    "knowledge",
    "think",
    "tool",
];

#[derive(Clone, Copy)]
enum Rule {
    Id,
    Label,
    Text,
    Boolean,
    Usage,
    Labels,
    Attachments,
    SkillLoads,
    Number {
        integer: bool,
        min: Option<f64>,
        max: Option<f64>,
    },
    Enum(&'static [&'static str]),
}

#[derive(Clone, Copy)]
struct Field {
    name: &'static str,
    rule: Rule,
    optional: bool,
}

struct Spec {
    kind: &'static str,
    fields: &'static [Field],
    /// Envelope fields the event cannot be interpreted without.
    requires: &'static [&'static str],
}

const fn req(name: &'static str, rule: Rule) -> Field {
    Field {
        name,
        rule,
        optional: false,
    }
}

const fn opt(name: &'static str, rule: Rule) -> Field {
    Field {
        name,
        rule,
        optional: true,
    }
}

const RATIO: Rule = Rule::Number {
    integer: false,
    min: Some(0.0),
    max: Some(1.0),
};
const COUNT: Rule = Rule::Number {
    integer: true,
    min: Some(0.0),
    max: None,
};
const SKILL_LOAD_COUNT: Rule = Rule::Number {
    integer: true,
    min: Some(0.0),
    max: Some(MAX_SKILL_LOAD_CHARACTERS as f64),
};
const AGENT_STATE: Rule = Rule::Enum(AGENT_STATES);
const ACTIVITY: Rule = Rule::Enum(ACTIVITY_KINDS);
const PHASE: Rule = Rule::Enum(AGENT_PHASES);
const REASON: Rule = Rule::Enum(STOP_REASONS);
const AGENT: &[&str] = &["agentId"];
const TASK: &[&str] = &["taskId"];

const fn spec(kind: &'static str, fields: &'static [Field]) -> Spec {
    Spec {
        kind,
        fields,
        requires: &[],
    }
}

const fn spec_requiring(
    kind: &'static str,
    fields: &'static [Field],
    requires: &'static [&'static str],
) -> Spec {
    Spec {
        kind,
        fields,
        requires,
    }
}

/// `EVENT_SPECS`, in the same order.
const SPECS: &[Spec] = &[
    spec(
        "session.started",
        &[
            req("control", Rule::Enum(&["managed", "observed"])),
            opt("title", Rule::Label),
            opt("model", Rule::Label),
            opt("cwd", Rule::Label),
        ],
    ),
    spec(
        "session.updated",
        &[req("revision", Rule::Id), req("messageCount", COUNT)],
    ),
    spec("session.ended", &[opt("reason", Rule::Label)]),
    spec(
        "prompt.submitted",
        &[
            req("text", Rule::Text),
            req("via", Rule::Enum(&["extalia", "native"])),
            opt("attachments", Rule::Attachments),
        ],
    ),
    spec(
        "user.intervention",
        &[
            req(
                "action",
                Rule::Enum(&["steer", "pause", "resume", "cancel"]),
            ),
            opt("text", Rule::Text),
        ],
    ),
    spec("model.thinking", &[]),
    spec(
        "skills.loaded",
        &[
            req("skills", Rule::SkillLoads),
            req("characters", SKILL_LOAD_COUNT),
            req("budgetCharacters", SKILL_LOAD_COUNT),
            opt(
                "omitted",
                Rule::Number {
                    integer: true,
                    min: Some(0.0),
                    max: Some(4096.0),
                },
            ),
        ],
    ),
    spec("model.delta", &[req("text", Rule::Text)]),
    spec(
        "model.completed",
        &[
            req("text", Rule::Text),
            opt("model", Rule::Label),
            opt("usage", Rule::Usage),
        ],
    ),
    spec(
        "turn.completed",
        &[
            opt("summary", Rule::Text),
            opt("model", Rule::Label),
            opt("usage", Rule::Usage),
            opt(
                "costUsd",
                Rule::Number {
                    integer: false,
                    min: Some(0.0),
                    max: None,
                },
            ),
        ],
    ),
    spec(
        "turn.failed",
        &[req("error", Rule::Text), opt("reason", REASON)],
    ),
    spec_requiring(
        "agent.created",
        &[
            req("name", Rule::Label),
            opt("role", Rule::Label),
            opt("parentAgentId", Rule::Id),
        ],
        AGENT,
    ),
    spec_requiring(
        "agent.state",
        &[
            req("state", AGENT_STATE),
            opt("activity", ACTIVITY),
            opt("summary", Rule::Label),
            opt("target", Rule::Label),
            opt("progress", RATIO),
            opt("phase", PHASE),
            opt("reason", REASON),
        ],
        AGENT,
    ),
    spec_requiring("agent.stopped", &[opt("reason", Rule::Label)], AGENT),
    spec_requiring(
        "agent.error",
        &[
            req("message", Rule::Text),
            opt("recoverable", Rule::Boolean),
        ],
        AGENT,
    ),
    spec_requiring(
        "subagent.spawned",
        &[
            req("subagentId", Rule::Id),
            opt("role", Rule::Label),
            opt("label", Rule::Label),
            opt("model", Rule::Label),
        ],
        AGENT,
    ),
    spec_requiring(
        "subagent.state",
        &[
            req("subagentId", Rule::Id),
            req("state", AGENT_STATE),
            opt("summary", Rule::Label),
            opt("phase", PHASE),
            opt("reason", REASON),
        ],
        AGENT,
    ),
    spec(
        "tool.started",
        &[
            opt("toolCallId", Rule::Id),
            req("tool", Rule::Label),
            req("kind", ACTIVITY),
            req("label", Rule::Label),
            opt("target", Rule::Label),
        ],
    ),
    spec(
        "tool.output",
        &[opt("toolCallId", Rule::Id), req("text", Rule::Text)],
    ),
    spec(
        "tool.completed",
        &[
            opt("toolCallId", Rule::Id),
            req("tool", Rule::Label),
            req("kind", ACTIVITY),
            req("label", Rule::Label),
            req("ok", Rule::Boolean),
            opt("target", Rule::Label),
            opt("output", Rule::Text),
            opt("attachments", Rule::Attachments),
        ],
    ),
    spec(
        "command.started",
        &[
            opt("commandId", Rule::Id),
            req("command", Rule::Text),
            opt("cwd", Rule::Label),
        ],
    ),
    spec(
        "command.output",
        &[
            opt("commandId", Rule::Id),
            req("stream", Rule::Enum(&["stdout", "stderr"])),
            req("text", Rule::Text),
        ],
    ),
    spec(
        "command.completed",
        &[
            opt("commandId", Rule::Id),
            req(
                "exitCode",
                Rule::Number {
                    integer: true,
                    min: None,
                    max: None,
                },
            ),
            opt("durationMs", COUNT),
        ],
    ),
    spec("file.read", &[req("path", Rule::Label)]),
    spec(
        "file.written",
        &[
            req("path", Rule::Label),
            req("change", Rule::Enum(&["add", "update", "delete"])),
            opt("toolCallId", Rule::Id),
        ],
    ),
    spec_requiring(
        "task.created",
        &[req("title", Rule::Label), opt("parentTaskId", Rule::Id)],
        TASK,
    ),
    spec_requiring("task.assigned", &[req("assigneeAgentId", Rule::Id)], TASK),
    spec_requiring(
        "task.progress",
        &[req("progress", RATIO), opt("summary", Rule::Label)],
        TASK,
    ),
    spec_requiring(
        "task.completed",
        &[req("ok", Rule::Boolean), opt("summary", Rule::Text)],
        TASK,
    ),
    spec(
        "approval.requested",
        &[
            req("approvalId", Rule::Id),
            req("action", Rule::Label),
            opt("detail", Rule::Text),
            opt("risk", Rule::Enum(&["low", "medium", "high"])),
        ],
    ),
    spec(
        "approval.resolved",
        &[
            req("approvalId", Rule::Id),
            req("decision", Rule::Enum(&["granted", "rejected"])),
            req("by", Rule::Enum(&["user", "policy"])),
            opt("choice", Rule::Enum(&["once", "session", "reject"])),
        ],
    ),
    spec(
        "git.status",
        &[
            req("changedFiles", COUNT),
            opt("branch", Rule::Label),
            opt("ahead", COUNT),
            opt("behind", COUNT),
        ],
    ),
    spec(
        "git.commit",
        &[req("sha", Rule::Id), opt("message", Rule::Text)],
    ),
    spec(
        "git.push",
        &[
            req("ok", Rule::Boolean),
            opt("remote", Rule::Label),
            opt("branch", Rule::Label),
        ],
    ),
    spec(
        "meeting.started",
        &[
            req("meetingId", Rule::Id),
            req("participants", Rule::Labels),
            opt("topic", Rule::Label),
            opt("roomId", Rule::Enum(&["meeting-a", "meeting-b"])),
        ],
    ),
    spec_requiring(
        "meeting.contribution",
        &[
            req("meetingId", Rule::Id),
            req(
                "round",
                Rule::Number {
                    integer: true,
                    min: Some(1.0),
                    max: Some(2.0),
                },
            ),
            req("text", Rule::Text),
        ],
        AGENT,
    ),
    spec(
        "meeting.completed",
        &[
            req("meetingId", Rule::Id),
            opt("decisions", Rule::Labels),
            opt("actionItems", Rule::Labels),
            opt("outcome", Rule::Enum(&["completed", "cancelled", "failed"])),
            opt("notePath", Rule::Label),
        ],
    ),
];

fn find(kind: &str) -> Option<&'static Spec> {
    SPECS.iter().find(|spec| spec.kind == kind)
}

/// Envelope fields (`agentId`, `taskId`) a v0 body type requires.
pub(super) fn required_envelope(kind: &str) -> &'static [&'static str] {
    find(kind).map_or(&[], |spec| spec.requires)
}

/// `checkString(value, path, limit, allowEmpty, singleLine)`.
fn string(
    value: &Value,
    path: &str,
    limit: usize,
    allow_empty: bool,
    single_line: bool,
    errors: &mut Vec<String>,
) {
    let Some(text) = value.as_str() else {
        errors.push(format!("{path}: expected a string"));
        return;
    };
    if !allow_empty && text.chars().all(is_js_space) {
        errors.push(format!("{path}: must not be empty"));
    }
    if js_length(text) > limit {
        errors.push(format!("{path}: longer than {limit} characters"));
    }
    if single_line && text.contains(['\r', '\n']) {
        errors.push(format!("{path}: must be a single line"));
    }
}

fn skill_load_count(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(number)
        .filter(|value| {
            value.is_finite()
                && value.fract() == 0.0
                && (0.0..=MAX_SKILL_LOAD_CHARACTERS as f64).contains(value)
        })
        .map(|value| value as u64)
}

fn skill_loads(value: &Value, path: &str, errors: &mut Vec<String>) {
    let Some(items) = value
        .as_array()
        .filter(|items| items.len() <= MAX_SKILL_LOAD_ENTRIES)
    else {
        errors.push(format!(
            "{path}: expected up to {MAX_SKILL_LOAD_ENTRIES} skill entries"
        ));
        return;
    };
    let mut names = std::collections::HashSet::new();
    for (index, item) in items.iter().enumerate() {
        let at = format!("{path}[{index}]");
        let Some(record) = item.as_object() else {
            errors.push(format!("{at}: expected an object"));
            continue;
        };
        for key in record.keys() {
            if ![
                "name",
                "source",
                "reason",
                "status",
                "characters",
                "intent",
                "revisionId",
            ]
            .contains(&key.as_str())
            {
                errors.push(format!("{at}.{key}: unknown field"));
            }
        }
        match record.get("name").and_then(Value::as_str) {
            Some(name)
                if (1..=64).contains(&name.len())
                    && name.as_bytes()[0].is_ascii_alphanumeric()
                    && name.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                    }) =>
            {
                if !names.insert(name) {
                    errors.push(format!("{at}.name: duplicate skill name"));
                }
            }
            _ => errors.push(format!("{at}.name: invalid skill name")),
        }
        let source = record.get("source").and_then(Value::as_str);
        if !source.is_some_and(|source| ["builtin", "registry"].contains(&source)) {
            errors.push(format!("{at}.source: expected builtin or registry"));
        }
        for (key, values) in [
            ("reason", SKILL_LOAD_REASONS),
            ("status", SKILL_LOAD_STATUSES),
        ] {
            if !record
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(|value| values.contains(&value))
            {
                errors.push(format!("{at}.{key}: unknown skill-load value"));
            }
        }
        match skill_load_count(record.get("characters")) {
            Some(characters) => {
                let loaded = record.get("status").and_then(Value::as_str) == Some("loaded");
                if (loaded && characters == 0) || (!loaded && characters != 0) {
                    errors.push(format!("{at}.characters: inconsistent with skill status"));
                }
            }
            None => errors.push(format!("{at}.characters: invalid character count")),
        }
        if let Some(intent) = record.get("intent")
            && !intent
                .as_str()
                .is_some_and(|intent| SKILL_LOAD_INTENTS.contains(&intent))
        {
            errors.push(format!("{at}.intent: unknown skill intent"));
        }
        if let Some(revision) = record.get("revisionId")
            && (source != Some("registry")
                || !revision.as_str().is_some_and(|revision| {
                    revision.len() == 68
                        && revision.starts_with("skr_")
                        && revision[4..]
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                }))
        {
            errors.push(format!(
                "{at}.revisionId: invalid registry revision identifier"
            ));
        }
    }
}

fn skill_load_totals(record: &serde_json::Map<String, Value>, errors: &mut Vec<String>) {
    let Some(characters) = skill_load_count(record.get("characters")) else {
        return;
    };
    if skill_load_count(record.get("budgetCharacters")).is_some_and(|budget| characters > budget) {
        errors.push("body.characters: exceeds the context budget".into());
    }
    if let Some(skills) = record
        .get("skills")
        .and_then(Value::as_array)
        .filter(|skills| skills.len() <= MAX_SKILL_LOAD_ENTRIES)
    {
        let loaded: u64 = skills
            .iter()
            .filter(|skill| skill.get("status").and_then(Value::as_str) == Some("loaded"))
            .filter_map(|skill| skill_load_count(skill.get("characters")))
            .sum();
        if loaded > characters {
            errors.push("body.characters: smaller than the loaded instruction total".into());
        }
    }
}

/// `checkField`.
fn field(value: &Value, rule: Rule, path: &str, errors: &mut Vec<String>) {
    match rule {
        Rule::SkillLoads => skill_loads(value, path, errors),
        Rule::Id => string(value, path, ID_LIMIT, false, true, errors),
        Rule::Label => string(value, path, LABEL_LIMIT, false, false, errors),
        Rule::Text => string(value, path, TEXT_LIMIT, true, false, errors),
        Rule::Boolean => {
            if !value.is_boolean() {
                errors.push(format!("{path}: expected true or false"));
            }
        }
        Rule::Enum(values) => {
            if !value.as_str().is_some_and(|text| values.contains(&text)) {
                errors.push(format!("{path}: expected one of {}", values.join(", ")));
            }
        }
        Rule::Number { integer, min, max } => {
            let Some(number) = number(value).filter(|number| number.is_finite()) else {
                errors.push(format!("{path}: expected a finite number"));
                return;
            };
            if integer && number.fract() != 0.0 {
                errors.push(format!("{path}: expected an integer"));
            }
            if min.is_some_and(|min| number < min) {
                errors.push(format!("{path}: below the minimum"));
            }
            if max.is_some_and(|max| number > max) {
                errors.push(format!("{path}: above the maximum"));
            }
        }
        Rule::Labels => {
            let Some(items) = value.as_array() else {
                errors.push(format!("{path}: expected an array of strings"));
                return;
            };
            for (index, item) in items.iter().enumerate() {
                string(
                    item,
                    &format!("{path}[{index}]"),
                    LABEL_LIMIT,
                    false,
                    false,
                    errors,
                );
            }
        }
        Rule::Attachments => {
            let Some(items) = value
                .as_array()
                .filter(|items| items.len() <= MAX_PROMPT_ATTACHMENTS)
            else {
                errors.push(format!(
                    "{path}: expected up to {MAX_PROMPT_ATTACHMENTS} attachments"
                ));
                return;
            };
            for (index, item) in items.iter().enumerate() {
                let at = format!("{path}[{index}]");
                let Some(record) = item.as_object() else {
                    errors.push(format!("{at}: expected an object"));
                    continue;
                };
                for key in record.keys() {
                    if !["name", "kind", "size", "ref"].contains(&key.as_str()) {
                        errors.push(format!("{at}.{key}: unknown field"));
                    }
                }
                if let Some(reference) = record.get("ref")
                    && !reference.as_str().is_some_and(|text| {
                        text.len() == 64
                            && text
                                .bytes()
                                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                    })
                {
                    errors.push(format!("{at}.ref: expected a SHA-256 hex digest"));
                }
                // A missing name or size is `undefined`, which fails like a wrong type.
                let null = Value::Null;
                string(
                    record.get("name").unwrap_or(&null),
                    &format!("{at}.name"),
                    LABEL_LIMIT,
                    false,
                    true,
                    errors,
                );
                if !record
                    .get("kind")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| ["image", "text", "file"].contains(&kind))
                {
                    errors.push(format!("{at}.kind: expected image, text or file"));
                }
                field(
                    record.get("size").unwrap_or(&null),
                    COUNT,
                    &format!("{at}.size"),
                    errors,
                );
            }
        }
        Rule::Usage => {
            let Some(record) = value.as_object() else {
                errors.push(format!("{path}: expected an object"));
                return;
            };
            for (key, count) in record {
                if ["inputTokens", "outputTokens", "cachedInputTokens"].contains(&key.as_str()) {
                    field(count, COUNT, &format!("{path}.{key}"), errors);
                } else {
                    errors.push(format!("{path}.{key}: unknown field"));
                }
            }
        }
    }
}

/// Body checks of `parseEvent` (the envelope is supplied by the `AgentEvent`).
pub(super) fn check(body: &Value, errors: &mut Vec<String>) {
    let Some(record) = body.as_object() else {
        errors.push("body: expected an object".into());
        return;
    };
    let kind = record.get("type").and_then(Value::as_str);
    let Some(spec) = kind.and_then(find) else {
        errors.push("body.type: unknown event type".into());
        return;
    };
    for key in record.keys() {
        if key != "type" && !spec.fields.iter().any(|field| field.name == key) {
            errors.push(format!("body.{key}: unknown field for {}", spec.kind));
        }
    }
    for rule in spec.fields {
        match record.get(rule.name) {
            None if !rule.optional => {
                errors.push(format!("body.{}: required for {}", rule.name, spec.kind));
            }
            None => {}
            Some(value) => field(value, rule.rule, &format!("body.{}", rule.name), errors),
        }
    }
    if spec.kind == "skills.loaded" {
        skill_load_totals(record, errors);
    }
}

#[cfg(test)]
mod skill_load_tests {
    use super::*;
    use crate::mission::{contract, policy};
    use serde_json::json;

    fn receipt() -> Value {
        json!({ "type": "skills.loaded", "skills": [
            { "name": "memory-recall", "source": "builtin", "reason": "default-memory", "status": "loaded", "characters": 120 },
            { "name": "orchestrator", "source": "builtin", "reason": "configured-team", "status": "not-configured", "characters": 0 }
        ], "characters": 200, "budgetCharacters": 24000 })
    }

    fn accepts(body: &Value) -> bool {
        let mut errors = Vec::new();
        check(body, &mut errors);
        errors.is_empty()
    }

    #[test]
    fn tool_result_image_metadata_matches_shared_contract_cases() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/test/fixtures/orchestration/agent-event.json"
        ))
        .unwrap();
        let mut compared = 0;
        for case in fixtures["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            if name.starts_with("tool image ") {
                assert_eq!(
                    accepts(&case["value"]["body"]),
                    case["valid"].as_bool().unwrap(),
                    "{name}"
                );
                compared += 1;
            }
        }
        assert_eq!(compared, 5);
    }

    #[test]
    fn skill_load_receipt_accepts_bounded_metadata_and_empty_results() {
        let mut body = receipt();
        assert!(accepts(&body));
        body["skills"][1] = json!({ "name": "registered-review", "source": "registry", "reason": "current-context", "status": "loaded", "characters": 40, "intent": "review", "revisionId": format!("skr_{}", "a".repeat(64)) });
        assert!(accepts(&body));
        assert!(accepts(
            &json!({ "type": "skills.loaded", "skills": [], "characters": 0, "budgetCharacters": 0 })
        ));
    }

    #[test]
    fn skill_load_receipt_bounds_optional_omitted_candidate_counts() {
        for omitted in [json!(0), json!(1), json!(4096)] {
            let mut body = receipt();
            body["omitted"] = omitted;
            assert!(accepts(&body));
        }
        for omitted in [json!(-1), json!(1.5), json!(4097), json!(null), json!("1")] {
            let mut body = receipt();
            body["omitted"] = omitted;
            assert!(!accepts(&body));
        }
    }

    #[test]
    fn skill_load_receipt_refuses_instruction_payloads_and_unknown_claims() {
        for (key, value) in [
            ("body", json!("Injected instructions")),
            ("name", json!("bad name")),
            ("name", json!("skill\n")),
            ("name", json!("x".repeat(65))),
            ("source", json!("file")),
            ("reason", json!("a private prompt quote")),
            ("status", json!("applied")),
            ("intent", json!("execute")),
            ("revisionId", json!(format!("skr_{}", "a".repeat(64)))),
        ] {
            let mut body = receipt();
            body["skills"][0][key] = value;
            assert!(!accepts(&body), "{key}: {body}");
        }
        let mut body = receipt();
        body["context"] = json!("Unrecorded instructions");
        assert!(!accepts(&body));
    }

    #[test]
    fn skill_load_receipt_preserves_entry_and_aggregate_count_invariants() {
        for characters in [json!(0), json!(-1), json!(1.5), json!(24001)] {
            let mut body = receipt();
            body["skills"][0]["characters"] = characters;
            assert!(!accepts(&body));
        }
        for key in ["characters", "budgetCharacters"] {
            let mut body = receipt();
            body[key] = json!(24001);
            assert!(!accepts(&body));
        }
        let mut body = receipt();
        body["characters"] = json!(119);
        assert!(!accepts(&body));
        body = receipt();
        body["budgetCharacters"] = json!(199);
        assert!(!accepts(&body));
        body = receipt();
        body["skills"][1]["characters"] = json!(1);
        assert!(!accepts(&body));
        body = receipt();
        body["skills"][1]["name"] = json!("memory-recall");
        assert!(!accepts(&body));
        body = receipt();
        body["skills"] = json!((0..9).map(|i| json!({ "name": format!("skill-{i}"), "source": "builtin", "reason": "current-context", "status": "loaded", "characters": 1 })).collect::<Vec<_>>());
        assert!(!accepts(&body));
    }

    #[test]
    fn skill_load_receipt_requires_fields_and_exact_registry_revisions() {
        for key in ["skills", "characters", "budgetCharacters"] {
            let mut body = receipt();
            body.as_object_mut().unwrap().remove(key);
            assert!(!accepts(&body));
        }
        for key in ["name", "source", "reason", "status", "characters"] {
            let mut body = receipt();
            body["skills"][0].as_object_mut().unwrap().remove(key);
            assert!(!accepts(&body));
        }
        for revision in [
            json!(null),
            json!("revision-1"),
            json!(format!("skr_{}\n", "a".repeat(64))),
        ] {
            let mut body = receipt();
            body["skills"][0]["source"] = json!("registry");
            body["skills"][0]["revisionId"] = revision;
            assert!(!accepts(&body));
        }
    }

    #[test]
    fn skill_load_receipt_is_valid_wire_metadata_but_never_a_mission_journal_grant() {
        let body = receipt();
        let raw = json!({ "schemaVersion": 1, "id": "00000000-0000-4000-8000-000000000001",
            "workspaceId": "00000000-0000-4000-8000-000000000002", "sessionId": "00000000-0000-4000-8000-000000000003",
            "missionId": "00000000-0000-4000-8000-000000000004", "taskId": "00000000-0000-4000-8000-000000000005",
            "agentId": "00000000-0000-4000-8000-000000000006", "source": { "runtime": "extalia-native", "channel": "system" },
            "observedAt": "2026-11-11T00:00:00Z", "confidence": "reported", "body": body });
        let mut errors = Vec::new();
        let event = contract::agent_event(&raw, "event", &mut errors)
            .expect("display receipt validates on the wire");
        assert!(errors.is_empty());
        assert!(policy::admit(&event).is_err());
        assert!(policy::journal_role(body.as_object().unwrap()).is_none());
    }
}
