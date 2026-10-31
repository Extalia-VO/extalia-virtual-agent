//! Additive task snapshot claim validation, never authority or legacy-state mutation.
use super::{enumeration, fail, field, literal, object, text, uuid};
use serde_json::Value;

const STATES: [&str; 15] = [
    "created",
    "blocked",
    "ready",
    "leased",
    "running",
    "waiting_approval",
    "retry_wait",
    "validating",
    "completed",
    "failed",
    "cancelling",
    "cancelled",
    "unknown",
    "manual_intervention",
    "superseded",
];
const OUTCOMES: [&str; 6] = [
    "not_started",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "unknown",
];

fn positive(value: &Value, path: &str, errors: &mut Vec<String>) {
    if !value.as_f64().is_some_and(|value| {
        value.fract() == 0.0 && (1.0..=9_007_199_254_740_991.0).contains(&value)
    }) {
        fail(errors, path, "expected a positive safe integer");
    }
}

fn validation(value: &Value, path: &str, errors: &mut Vec<String>) {
    let resolved = matches!(
        value.get("state").and_then(Value::as_str),
        Some("passed" | "failed")
    );
    let keys: &[&str] = if resolved {
        &["state", "recordRef"]
    } else {
        &["state"]
    };
    let Some(map) = object(value, path, keys, errors) else {
        return;
    };
    field(map, "state", path, errors, |value, path, errors| {
        enumeration(
            value,
            path,
            if resolved {
                &["passed", "failed"]
            } else {
                &["not_run", "pending", "unknown"]
            },
            errors,
        )
    });
    if resolved {
        field(map, "recordRef", path, errors, |value, path, errors| {
            text(value, path, 200, errors)
        });
    }
}

fn acceptance(value: &Value, path: &str, errors: &mut Vec<String>) {
    let state = value.get("state").and_then(Value::as_str);
    let resolved = matches!(state, Some("accepted" | "rejected" | "waived"));
    let keys: &[&str] = if state == Some("waived") {
        &["state", "recordRef", "reason"]
    } else if resolved {
        &["state", "recordRef"]
    } else {
        &["state"]
    };
    let Some(map) = object(value, path, keys, errors) else {
        return;
    };
    field(map, "state", path, errors, |value, path, errors| {
        enumeration(
            value,
            path,
            if state == Some("waived") {
                &["waived"]
            } else if resolved {
                &["accepted", "rejected"]
            } else {
                &["not_reviewed", "pending", "unknown"]
            },
            errors,
        )
    });
    if resolved {
        field(map, "recordRef", path, errors, |value, path, errors| {
            text(value, path, 200, errors)
        });
    }
    if state == Some("waived") {
        field(map, "reason", path, errors, |value, path, errors| {
            text(value, path, 2_000, errors)
        });
    }
}

/// Structural and consistency checks of a caller's snapshot. References remain unresolved claims.
pub fn validate_task_snapshot(value: &Value) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();
    let keys = [
        "protocol",
        "schemaVersion",
        "kind",
        "profileId",
        "workspaceId",
        "missionId",
        "taskId",
        "definitionVersion",
        "stateVersion",
        "state",
        "executionOutcome",
        "validation",
        "acceptance",
        "evidenceIds",
    ];
    // The one optional field remains strict when present.
    let mut fields = keys.to_vec();
    if value.get("executionId").is_some() {
        fields.push("executionId");
    }
    let Some(map) = object(value, "$", &fields, &mut errors) else {
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
        literal(value, path, "task-snapshot", errors)
    });
    for key in [
        "profileId",
        "workspaceId",
        "missionId",
        "taskId",
        "executionId",
    ] {
        field(map, key, "$", &mut errors, uuid);
    }
    for key in ["definitionVersion", "stateVersion"] {
        field(map, key, "$", &mut errors, positive);
    }
    field(map, "state", "$", &mut errors, |value, path, errors| {
        enumeration(value, path, &STATES, errors)
    });
    field(
        map,
        "executionOutcome",
        "$",
        &mut errors,
        |value, path, errors| enumeration(value, path, &OUTCOMES, errors),
    );
    field(map, "validation", "$", &mut errors, validation);
    field(map, "acceptance", "$", &mut errors, acceptance);
    field(
        map,
        "evidenceIds",
        "$",
        &mut errors,
        |value, path, errors| {
            let Some(entries) = value.as_array().filter(|entries| entries.len() <= 1_000) else {
                fail(errors, path, "expected at most 1000 evidence IDs");
                return;
            };
            let mut ids = std::collections::HashSet::new();
            for (index, id) in entries.iter().enumerate() {
                uuid(id, &format!("{path}[{index}]"), errors);
                if let Some(id) = id.as_str()
                    && !ids.insert(id)
                {
                    fail(errors, path, "duplicate evidence ID");
                }
            }
        },
    );
    if !errors.is_empty() {
        return Err(errors);
    }
    let outcome = value["executionOutcome"].as_str().unwrap_or_default();
    let accepted = value["acceptance"]["state"].as_str().unwrap_or_default();
    if !matches!(outcome, "not_started" | "unknown") && !map.contains_key("executionId") {
        fail(
            &mut errors,
            "$.executionId",
            "required for a known started execution",
        );
    }
    if accepted == "accepted"
        && (outcome != "succeeded"
            || value["validation"]["state"] != "passed"
            || value["evidenceIds"].as_array().is_none_or(Vec::is_empty))
    {
        fail(
            &mut errors,
            "$.acceptance",
            "accepted output requires successful execution and passed validation with evidence",
        );
    }
    if value["state"] == "completed"
        && (outcome != "succeeded" || !matches!(accepted, "accepted" | "waived"))
    {
        fail(
            &mut errors,
            "$.state",
            "completed requires successful execution and explicit acceptance or waiver",
        );
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shared_task_snapshot_fixtures_agree() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/test/fixtures/control/task-snapshot.json"
        ))
        .expect("shared task fixtures");
        for case in fixtures["cases"].as_array().unwrap() {
            let result = validate_task_snapshot(&case["value"]);
            assert_eq!(
                result.is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}: {result:?}",
                case["name"]
            );
        }
    }

    #[test]
    fn boundaries_and_waiver_reason_use_safe_integers_and_utf16() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/test/fixtures/control/task-snapshot.json"
        ))
        .unwrap();
        let mut value = fixtures["cases"][0]["value"].clone();
        value["definitionVersion"] = json!(9_007_199_254_740_991_u64);
        value["stateVersion"] = json!(2);
        value["acceptance"] =
            json!({"state":"waived", "recordRef":"waiver-record", "reason":"😀".repeat(1_000)});
        assert!(validate_task_snapshot(&value).is_ok());
        value["acceptance"]["reason"] = json!(format!("{}x", "😀".repeat(1_000)));
        assert!(validate_task_snapshot(&value).is_err());
        value["acceptance"] = json!({"state":"unknown"});
        value["stateVersion"] = json!(9_007_199_254_740_992_u64);
        assert!(validate_task_snapshot(&value).is_err());
    }
}
