//! Pure delegation claim/attenuation inspection. Success is never authorization or replay permission.
use super::{enumeration, fail, field, literal, object, text, timestamp, uuid};
use crate::time::parse_utc;
use serde_json::Value;
use std::collections::HashSet;

const ENGINES: [&str; 3] = ["native", "hermes", "openclaw"];
const BUDGET_FIELDS: [&str; 4] = [
    "maxWallClockMs",
    "maxTokens",
    "maxToolCalls",
    "maxEstimatedCostMicrousd",
];
const SCOPE: [&str; 6] = [
    "profileId",
    "workspaceId",
    "rootMissionId",
    "rootRunId",
    "rootEngineId",
    "engineGeneration",
];
fn integer(value: &Value, path: &str, min: f64, max: f64, errors: &mut Vec<String>) {
    if !value
        .as_f64()
        .is_some_and(|value| value.fract() == 0.0 && (min..=max).contains(&value))
    {
        fail(errors, path, "expected a bounded safe integer");
    }
}
fn utc(value: &Value) -> i64 {
    value.as_str().and_then(parse_utc).unwrap_or_default()
}
fn refused(reason: &str) -> Result<(), Vec<String>> {
    Err(vec![reason.to_owned()])
}
// The validated wire contains only safe integer numbers. Match JavaScript's 1 === 1.0.
fn same_json(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same_json(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| same_json(a, b)))
        }
        _ => a == b,
    }
}

/// Check shape and internally consistent claims; do not resolve grants, records or source truth.
pub fn validate_delegation_envelope(value: &Value) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();
    let mut keys = vec![
        "protocol",
        "schemaVersion",
        "kind",
        "delegationId",
        "profileId",
        "workspaceId",
        "rootMissionId",
        "rootRunId",
        "rootEngineId",
        "sourceEngineId",
        "targetEngineId",
        "parentTaskId",
        "taskId",
        "executionId",
        "engineGeneration",
        "taskDefinitionVersion",
        "taskDefinitionDigest",
        "authorityRef",
        "lineage",
        "hopRemaining",
        "childRemaining",
        "budget",
        "idempotencyKey",
        "issuedAt",
        "expiresAt",
    ];
    if value.get("approvalRef").is_some() {
        keys.push("approvalRef");
    }
    let Some(map) = object(value, "$", &keys, &mut errors) else {
        return Err(errors);
    };
    field(map, "protocol", "$", &mut errors, |value, path, errors| {
        literal(value, path, "extalia.control.v1", errors)
    });
    field(
        map,
        "schemaVersion",
        "$",
        &mut errors,
        |value, path, errors| {
            if value.as_f64() != Some(1.0) {
                fail(errors, path, "expected 1");
            }
        },
    );
    field(map, "kind", "$", &mut errors, |value, path, errors| {
        literal(value, path, "delegation", errors)
    });
    for key in [
        "delegationId",
        "profileId",
        "workspaceId",
        "rootMissionId",
        "rootRunId",
        "parentTaskId",
        "taskId",
        "executionId",
    ] {
        field(map, key, "$", &mut errors, uuid);
    }
    for key in ["rootEngineId", "sourceEngineId", "targetEngineId"] {
        field(map, key, "$", &mut errors, |value, path, errors| {
            enumeration(value, path, &ENGINES, errors)
        });
    }
    for key in ["authorityRef", "approvalRef", "idempotencyKey"] {
        field(map, key, "$", &mut errors, |value, path, errors| {
            text(value, path, 200, errors)
        });
    }
    for key in ["issuedAt", "expiresAt"] {
        field(map, key, "$", &mut errors, timestamp);
    }
    for key in ["engineGeneration", "taskDefinitionVersion"] {
        field(map, key, "$", &mut errors, |value, path, errors| {
            integer(value, path, 1.0, 9_007_199_254_740_991.0, errors)
        });
    }
    field(
        map,
        "taskDefinitionDigest",
        "$",
        &mut errors,
        |value, path, errors| {
            if !value.as_str().is_some_and(|text| {
                text.len() == 64
                    && text
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            }) {
                fail(errors, path, "expected a lowercase SHA-256 digest");
            }
        },
    );
    field(
        map,
        "hopRemaining",
        "$",
        &mut errors,
        |value, path, errors| integer(value, path, 0.0, 32.0, errors),
    );
    field(
        map,
        "childRemaining",
        "$",
        &mut errors,
        |value, path, errors| integer(value, path, 0.0, 1_000.0, errors),
    );
    field(map, "budget", "$", &mut errors, |value, path, errors| {
        let Some(map) = object(value, path, &BUDGET_FIELDS, errors) else {
            return;
        };
        for key in BUDGET_FIELDS {
            field(map, key, path, errors, |value, path, errors| {
                integer(value, path, 0.0, 9_007_199_254_740_991.0, errors)
            });
        }
    });
    field(map, "lineage", "$", &mut errors, |value, path, errors| {
        let Some(entries) = value
            .as_array()
            .filter(|entries| (1..=32).contains(&entries.len()))
        else {
            fail(errors, path, "expected 1 to 32 ancestors");
            return;
        };
        for (index, entry) in entries.iter().enumerate() {
            let path = format!("{path}[{index}]");
            let Some(map) = object(entry, &path, &["engineId", "taskId"], errors) else {
                continue;
            };
            field(map, "engineId", &path, errors, |value, path, errors| {
                enumeration(value, path, &ENGINES, errors)
            });
            field(map, "taskId", &path, errors, uuid);
        }
    });
    if !errors.is_empty() {
        return Err(errors);
    }
    if utc(&value["expiresAt"]) <= utc(&value["issuedAt"]) {
        fail(&mut errors, "$.expiresAt", "must be after issuedAt");
    }
    let lineage = value["lineage"].as_array().expect("validated lineage");
    if lineage[0]["engineId"] != value["rootEngineId"] {
        fail(
            &mut errors,
            "$.lineage",
            "first engine must match rootEngineId",
        );
    }
    let last = lineage.last().expect("nonempty lineage");
    if last["engineId"] != value["sourceEngineId"] || last["taskId"] != value["parentTaskId"] {
        fail(
            &mut errors,
            "$.lineage",
            "last entry must identify the delegating source task",
        );
    }
    let mut tasks = HashSet::new();
    for entry in lineage {
        if !tasks.insert(entry["taskId"].as_str().expect("validated ID"))
            || entry["taskId"] == value["taskId"]
        {
            fail(
                &mut errors,
                "$.lineage",
                "repeated task identity or target cycle",
            );
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

/// Necessary branch-consistency checks only. No atomic reservation, authority resolution or effect.
pub fn inspect_delegation_extension(
    parent: &Value,
    child: &Value,
    now: &str,
) -> Result<(), Vec<String>> {
    if validate_delegation_envelope(parent).is_err() {
        return refused("invalid-parent");
    }
    if validate_delegation_envelope(child).is_err() {
        return refused("invalid-child");
    }
    let Some(now) = parse_utc(now) else {
        return refused("invalid-time");
    };
    if [parent, child]
        .iter()
        .any(|value| now < utc(&value["issuedAt"]) || now >= utc(&value["expiresAt"]))
    {
        return refused("inactive-window");
    }
    if SCOPE
        .iter()
        .any(|key| !same_json(&parent[*key], &child[*key]))
    {
        return refused("foreign-scope");
    }
    if child["sourceEngineId"] != parent["targetEngineId"]
        || child["parentTaskId"] != parent["taskId"]
    {
        return refused("broken-parent");
    }
    if [
        "delegationId",
        "executionId",
        "authorityRef",
        "idempotencyKey",
    ]
    .iter()
    .any(|key| child[*key] == parent[*key])
    {
        return refused("reused-identity");
    }
    let previous = parent["lineage"]
        .as_array()
        .expect("validated parent lineage");
    let lineage = child["lineage"]
        .as_array()
        .expect("validated child lineage");
    if lineage.len() != previous.len() + 1 || lineage[..previous.len()] != previous[..] {
        return refused("broken-lineage");
    }
    let last = lineage.last().expect("validated nonempty lineage");
    if last["engineId"] != parent["targetEngineId"] || last["taskId"] != parent["taskId"] {
        return refused("broken-lineage");
    }
    let hops = parent["hopRemaining"].as_f64().unwrap_or_default();
    let children = parent["childRemaining"].as_f64().unwrap_or_default();
    if hops == 0.0
        || children == 0.0
        || child["hopRemaining"].as_f64().unwrap_or_default() > hops - 1.0
        || child["childRemaining"].as_f64().unwrap_or_default() > children - 1.0
    {
        return refused("exhausted-or-expanded-limits");
    }
    if utc(&child["issuedAt"]) < utc(&parent["issuedAt"])
        || utc(&child["expiresAt"]) > utc(&parent["expiresAt"])
    {
        return refused("expanded-window");
    }
    if BUDGET_FIELDS.iter().any(|key| {
        child["budget"][*key].as_f64().unwrap_or_default()
            > parent["budget"][*key].as_f64().unwrap_or_default()
    }) {
        return refused("expanded-budget");
    }
    Ok(())
}

/// Equality is not permission to resend. No durable idempotency receipt is stored or resolved.
pub fn compare_delegation_replay(previous: &Value, candidate: &Value) -> Result<(), Vec<String>> {
    if validate_delegation_envelope(previous).is_err() {
        return refused("invalid-previous");
    }
    if validate_delegation_envelope(candidate).is_err() {
        return refused("invalid-candidate");
    }
    if ["profileId", "workspaceId", "rootMissionId", "rootRunId"]
        .iter()
        .any(|key| previous[*key] != candidate[*key])
    {
        return refused("foreign-scope");
    }
    if previous["idempotencyKey"] != candidate["idempotencyKey"] {
        return refused("different-key");
    }
    if !same_json(previous, candidate) {
        return refused("conflicting-intent");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_envelope_fixtures_agree() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/test/fixtures/control/delegation-envelope.json"
        ))
        .unwrap();
        for case in fixtures["cases"].as_array().unwrap() {
            let result = validate_delegation_envelope(&case["value"]);
            assert_eq!(
                result.is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}: {result:?}",
                case["name"]
            );
        }
    }
    #[test]
    fn shared_extension_and_replay_inspections_agree() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../../packages/core/test/fixtures/delegation-inspection.json"
        ))
        .unwrap();
        for case in fixtures["extensionCases"].as_array().unwrap() {
            let result = inspect_delegation_extension(
                case.get("parent").unwrap_or(&fixtures["parent"]),
                case.get("child").unwrap_or(&fixtures["child"]),
                case.get("now")
                    .unwrap_or(&fixtures["now"])
                    .as_str()
                    .unwrap_or_default(),
            );
            assert_eq!(
                result.is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}: {result:?}",
                case["name"]
            );
            if let Err(errors) = result {
                assert_eq!(
                    errors[0],
                    case["reason"].as_str().unwrap(),
                    "{}",
                    case["name"]
                );
            }
        }
        for case in fixtures["replayCases"].as_array().unwrap() {
            let result = compare_delegation_replay(
                case.get("previous").unwrap_or(&fixtures["parent"]),
                case.get("candidate").unwrap_or(&fixtures["parent"]),
            );
            assert_eq!(
                result.is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}: {result:?}",
                case["name"]
            );
            if let Err(errors) = result {
                assert_eq!(
                    errors[0],
                    case["reason"].as_str().unwrap(),
                    "{}",
                    case["name"]
                );
            }
        }
    }
}
