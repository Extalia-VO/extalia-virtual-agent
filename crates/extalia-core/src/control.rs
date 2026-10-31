//! Additive discovery-claim validation for `extalia.control.v1` (ADR 0036).
//!
//! Mirrors `packages/protocol/src/controlValidate.ts`. This checks shape and claim
//! conformance only: it neither resolves references nor grants driver authority.

use serde_json::{Map, Value};
pub mod delegation;
pub mod native_action;
pub mod task;
use std::collections::HashSet;

use crate::{mission::contract::is_uuid, time::parse_utc};

const CAPABILITIES: [&str; 18] = [
    "discover",
    "observe",
    "createSession",
    "sendPrompt",
    "streamEvents",
    "resume",
    "fork",
    "interrupt",
    "cancel",
    "queuePrompt",
    "liveSteer",
    "approvalRelay",
    "readArtifacts",
    "listSessions",
    "usage",
    "cost",
    "subagents",
    "gitDiff",
];
const OBSERVER_CAPABILITIES: [&str; 9] = [
    "discover",
    "observe",
    "streamEvents",
    "approvalRelay",
    "readArtifacts",
    "listSessions",
    "usage",
    "cost",
    "gitDiff",
];
const IMPORT_CAPABILITIES: [&str; 6] = [
    "discover",
    "readArtifacts",
    "listSessions",
    "usage",
    "cost",
    "gitDiff",
];
const INACTIVE_STATES: [&str; 4] = [
    "unsupported",
    "disabled_by_policy",
    "unavailable",
    "needs_verification",
];
const INTERFACES: [&str; 8] = [
    "sdk", "cli", "acp", "gateway", "hook", "otel", "import", "api",
];

fn fail(errors: &mut Vec<String>, path: &str, message: &str) {
    errors.push(format!("{path}: {message}."));
}

/// Closed object, checking every required field even when other fields fail.
fn object<'a>(
    value: &'a Value,
    path: &str,
    required: &[&str],
    errors: &mut Vec<String>,
) -> Option<&'a Map<String, Value>> {
    let Some(map) = value.as_object() else {
        fail(errors, path, "expected a plain object");
        return None;
    };
    for key in map.keys() {
        if !required.contains(&key.as_str()) {
            fail(errors, &format!("{path}.{key}"), "unknown field");
        }
    }
    for key in required {
        if !map.contains_key(*key) {
            fail(errors, &format!("{path}.{key}"), "required field");
        }
    }
    Some(map)
}

fn field(
    map: &Map<String, Value>,
    key: &str,
    path: &str,
    errors: &mut Vec<String>,
    check: impl FnOnce(&Value, &str, &mut Vec<String>),
) {
    if let Some(value) = map.get(key) {
        check(value, &format!("{path}.{key}"), errors);
    }
}

fn enumeration(value: &Value, path: &str, values: &[&str], errors: &mut Vec<String>) {
    if !value.as_str().is_some_and(|text| values.contains(&text)) {
        fail(
            errors,
            path,
            &format!("expected one of {}", values.join(", ")),
        );
    }
}

fn literal(value: &Value, path: &str, expected: &str, errors: &mut Vec<String>) {
    if value.as_str() != Some(expected) {
        fail(errors, path, &format!("expected {expected:?}"));
    }
}

/// Whitespace removed by JavaScript's `String.prototype.trim`, including BOM.
fn is_js_space(character: char) -> bool {
    matches!(
        character,
        '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
            | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

fn text(value: &Value, path: &str, max: usize, errors: &mut Vec<String>) {
    let valid = value.as_str().is_some_and(|text| {
        text.chars().any(|character| !is_js_space(character))
            && text.encode_utf16().count() <= max
            && !text
                .chars()
                .any(|character| character < ' ' || character == '\u{7f}')
    });
    if !valid {
        fail(
            errors,
            path,
            &format!("expected nonempty single-line text of at most {max} characters"),
        );
    }
}

fn uuid(value: &Value, path: &str, errors: &mut Vec<String>) {
    if !value.as_str().is_some_and(is_uuid) {
        fail(errors, path, "expected a lowercase UUID");
    }
}

fn timestamp(value: &Value, path: &str, errors: &mut Vec<String>) {
    if !value.as_str().is_some_and(|text| parse_utc(text).is_some()) {
        fail(errors, path, "expected a real UTC timestamp");
    }
}

fn runtime_id(value: &Value, path: &str, errors: &mut Vec<String>) {
    let valid = value.as_str().is_some_and(|text| {
        let bytes = text.as_bytes();
        (1..=64).contains(&bytes.len())
            && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
            && bytes[1..].iter().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'.' | b'_' | b'-')
            })
    });
    if !valid {
        fail(
            errors,
            path,
            "expected a lowercase adapter or engine identifier",
        );
    }
}

fn verification(value: &Value, path: &str, errors: &mut Vec<String>) {
    let Some(map) = object(
        value,
        path,
        &[
            "runtimeVersion",
            "policyRef",
            "configurationRef",
            "evidenceRefs",
            "checkedAt",
        ],
        errors,
    ) else {
        return;
    };
    field(
        map,
        "runtimeVersion",
        path,
        errors,
        |value, path, errors| text(value, path, 128, errors),
    );
    for key in ["policyRef", "configurationRef"] {
        field(map, key, path, errors, |value, path, errors| {
            text(value, path, 200, errors)
        });
    }
    field(map, "checkedAt", path, errors, timestamp);
    field(map, "evidenceRefs", path, errors, |value, path, errors| {
        let Some(items) = value
            .as_array()
            .filter(|items| (1..=64).contains(&items.len()))
        else {
            fail(errors, path, "expected an array with 1 to 64 items");
            return;
        };
        // Identifiers are strings. For invalid non-string objects JavaScript's Set
        // uses identity; their identifier check still guarantees rejection.
        if items
            .iter()
            .enumerate()
            .any(|(index, item)| item.is_string() && items[..index].contains(item))
        {
            fail(errors, path, "duplicate values");
        }
        for (index, item) in items.iter().enumerate() {
            text(item, &format!("{path}[{index}]"), 200, errors);
        }
    });
}

fn capability(value: &Value, path: &str, permitted: bool, errors: &mut Vec<String>) {
    let state = value.get("state").and_then(Value::as_str);
    let active = matches!(state, Some("supported" | "experimental"));
    if !state.is_some_and(|state| INACTIVE_STATES.contains(&state)) && !(permitted && active) {
        fail(errors, &format!("{path}.state"), "unknown discriminant");
        return;
    }
    let required: &[&str] = match state {
        Some("supported") => &["reason", "interface", "state", "verification"],
        Some("experimental") => &[
            "reason",
            "interface",
            "state",
            "verification",
            "optInRequired",
        ],
        _ => &["reason", "interface", "state"],
    };
    let Some(map) = object(value, path, required, errors) else {
        return;
    };
    field(map, "reason", path, errors, |value, path, errors| {
        text(value, path, 2_000, errors)
    });
    field(map, "interface", path, errors, |value, path, errors| {
        enumeration(value, path, &INTERFACES, errors)
    });
    if active {
        field(map, "verification", path, errors, verification);
    }
    if state == Some("experimental") {
        field(map, "optInRequired", path, errors, |value, path, errors| {
            if value.as_bool() != Some(true) {
                fail(errors, path, "expected true");
            }
        });
    }
}

fn subject(value: &Value, path: &str, errors: &mut Vec<String>) {
    let kind = value.get("kind").and_then(Value::as_str);
    if !matches!(kind, Some("engine" | "worker" | "provider")) {
        fail(errors, &format!("{path}.kind"), "unknown discriminant");
        return;
    }
    let Some(map) = object(value, path, &["kind", "id", "adapterVersion"], errors) else {
        return;
    };
    field(
        map,
        "adapterVersion",
        path,
        errors,
        |value, path, errors| text(value, path, 128, errors),
    );
    field(map, "id", path, errors, |value, path, errors| match kind {
        Some("engine") => enumeration(value, path, &["native", "hermes", "openclaw"], errors),
        Some("worker") => enumeration(
            value,
            path,
            &["codex", "claude-code", "opencode", "kiro", "google"],
            errors,
        ),
        _ => runtime_id(value, path, errors),
    });
}

/// Validate a discovery manifest without consulting policy, registries, evidence,
/// runtime, database or profile data. Success is never permission to execute.
pub fn validate_capability_manifest(value: &Value) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();
    let mode = value.get("mode").and_then(Value::as_str);
    if !matches!(mode, Some("managed" | "observer" | "import-only")) {
        fail(&mut errors, "$.mode", "unknown discriminant");
        return Err(errors);
    }
    let Some(map) = object(
        value,
        "$",
        &[
            "protocol",
            "schemaVersion",
            "profileId",
            "workspaceId",
            "subject",
            "mode",
            "authMethod",
            "detectedAt",
            "capabilities",
        ],
        &mut errors,
    ) else {
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
    for key in ["profileId", "workspaceId"] {
        field(map, key, "$", &mut errors, uuid);
    }
    field(map, "subject", "$", &mut errors, subject);
    field(map, "detectedAt", "$", &mut errors, timestamp);
    field(
        map,
        "authMethod",
        "$",
        &mut errors,
        |value, path, errors| {
            enumeration(
                value,
                path,
                &[
                    "none",
                    "external_official_login",
                    "user_api_key",
                    "user_oauth_authorized",
                    "local_model",
                    "gateway_scoped",
                    "enterprise_adc",
                ],
                errors,
            )
        },
    );
    field(
        map,
        "capabilities",
        "$",
        &mut errors,
        |value, path, errors| {
            let Some(map) = object(value, path, &CAPABILITIES, errors) else {
                return;
            };
            for name in CAPABILITIES {
                let permitted = mode == Some("managed")
                    || if mode == Some("observer") {
                        OBSERVER_CAPABILITIES.contains(&name)
                    } else {
                        IMPORT_CAPABILITIES.contains(&name)
                    };
                field(map, name, path, errors, |value, path, errors| {
                    capability(value, path, permitted, errors)
                });
            }
        },
    );
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

fn identity_source(value: &Value, path: &str, errors: &mut Vec<String>) {
    let Some(map) = object(
        value,
        path,
        &["family", "system", "instanceId", "workspaceId", "id"],
        errors,
    ) else {
        return;
    };
    let family = map.get("family").and_then(Value::as_str);
    field(map, "family", path, errors, |value, path, errors| {
        enumeration(
            value,
            path,
            &["extalia.v0", "orchestration.v1", "external"],
            errors,
        )
    });
    field(map, "system", path, errors, |value, path, errors| {
        if family == Some("external") {
            runtime_id(value, path, errors);
        } else {
            literal(value, path, "extalia", errors);
        }
    });
    field(map, "instanceId", path, errors, |value, path, errors| {
        text(value, path, 200, errors)
    });
    for key in ["workspaceId", "id"] {
        field(map, key, path, errors, |value, path, errors| {
            if family == Some("orchestration.v1") {
                uuid(value, path, errors);
            } else {
                text(value, path, 200, errors);
            }
        });
    }
}

/// Validate explicit one-to-one mappings. This grants no ownership or execution authority.
pub fn validate_identity_map(value: &Value) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();
    let Some(map) = object(
        value,
        "$",
        &[
            "protocol",
            "schemaVersion",
            "kind",
            "profileId",
            "workspaceId",
            "bindings",
        ],
        &mut errors,
    ) else {
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
        literal(value, path, "identity-map", errors)
    });
    for key in ["profileId", "workspaceId"] {
        field(map, key, "$", &mut errors, uuid);
    }
    field(map, "bindings", "$", &mut errors, |value, path, errors| {
        let Some(entries) = value.as_array().filter(|entries| entries.len() <= 1_000) else {
            fail(errors, path, "expected an array with at most 1000 items");
            return;
        };
        let mut sources = HashSet::new();
        let mut canonical_ids = HashSet::new();
        for (index, entry) in entries.iter().enumerate() {
            let path = format!("{path}[{index}]");
            let start_errors = errors.len();
            let Some(binding) = object(
                entry,
                &path,
                &["entityKind", "source", "canonicalId"],
                errors,
            ) else {
                continue;
            };
            field(
                binding,
                "entityKind",
                &path,
                errors,
                |value, path, errors| enumeration(value, path, &["session", "workspace"], errors),
            );
            field(binding, "source", &path, errors, identity_source);
            field(binding, "canonicalId", &path, errors, uuid);
            if errors.len() == start_errors {
                let source = &entry["source"];
                let key: Vec<String> = [
                    &entry["entityKind"],
                    &source["family"],
                    &source["system"],
                    &source["instanceId"],
                    &source["workspaceId"],
                    &source["id"],
                ]
                .iter()
                .filter_map(|value| value.as_str().map(str::to_owned))
                .collect();
                let canonical_id = entry["canonicalId"].as_str().unwrap_or_default().to_owned();
                let unique_source = sources.insert(key);
                let unique_canonical = canonical_ids.insert(canonical_id);
                if !unique_source || !unique_canonical {
                    fail(errors, &path, "ambiguous identity binding");
                }
            }
        }
    });
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
    fn shared_identity_map_fixtures_agree() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/test/fixtures/control/identity-map.json"
        ))
        .expect("identity fixtures JSON");
        for case in fixtures["cases"].as_array().expect("fixture cases") {
            let result = validate_identity_map(&case["value"]);
            assert_eq!(
                result.is_ok(),
                case["valid"].as_bool().expect("verdict"),
                "{}: {result:?}",
                case["name"]
            );
        }
    }

    #[test]
    fn identity_map_bounds_and_utf16_limits() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/test/fixtures/control/identity-map.json"
        ))
        .unwrap();
        let mut value = fixtures["cases"][0]["value"].clone();
        value["bindings"][0]["source"]["id"] = Value::String("😀".repeat(100));
        assert!(validate_identity_map(&value).is_ok());
        value["bindings"][0]["source"]["id"] = Value::String(format!("{}x", "😀".repeat(100)));
        assert!(validate_identity_map(&value).is_err());
        value["bindings"] = Value::Array(vec![value["bindings"][0].clone(); 1_001]);
        assert!(validate_identity_map(&value).is_err());
    }

    #[test]
    fn identity_map_accepts_exactly_one_thousand_unique_bindings() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/test/fixtures/control/identity-map.json"
        ))
        .unwrap();
        let mut value = fixtures["cases"][0]["value"].clone();
        let binding = value["bindings"][0].clone();
        value["bindings"] = Value::Array(
            (0..1_000)
                .map(|index| {
                    let mut entry = binding.clone();
                    entry["canonicalId"] =
                        json!(format!("{index:08x}-1111-4111-8111-111111111111"));
                    entry["source"]["id"] = json!(format!("legacy-{index}"));
                    entry
                })
                .collect(),
        );
        assert!(validate_identity_map(&value).is_ok());
        value["bindings"].as_array_mut().unwrap().push(binding);
        assert!(validate_identity_map(&value).is_err());
    }

    #[test]
    fn shared_typescript_rust_golden_fixtures_agree() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/test/fixtures/control/capability-manifest.json"
        ))
        .expect("shared control manifest fixtures are JSON");
        let cases = fixtures["cases"].as_array().expect("fixture cases");
        assert!(!cases.is_empty());
        for case in cases {
            let expected = case["valid"].as_bool().expect("fixture verdict");
            let result = validate_capability_manifest(&case["value"]);
            assert_eq!(result.is_ok(), expected, "{}: {result:?}", case["name"]);
        }
    }

    fn manifest() -> Value {
        json!({
            "protocol": "extalia.control.v1",
            "schemaVersion": 1,
            "profileId": "11111111-1111-4111-8111-111111111111",
            "workspaceId": "22222222-2222-4222-8222-222222222222",
            "subject": { "kind": "engine", "id": "native", "adapterVersion": "1.0" },
            "mode": "managed",
            "authMethod": "none",
            "detectedAt": "2026-01-01T00:00:00Z",
            "capabilities": CAPABILITIES.into_iter().map(|name| (
                name.to_owned(), json!({ "state": "unsupported", "reason": "No surface", "interface": "cli" })
            )).collect::<Map<String, Value>>()
        })
    }

    fn supported() -> Value {
        json!({
            "state": "supported", "reason": "Recorded claim", "interface": "sdk",
            "verification": {
                "runtimeVersion": "1.0", "policyRef": "policy-unresolved",
                "configurationRef": "configuration-unresolved", "evidenceRefs": ["evidence-unresolved"],
                "checkedAt": "0001-01-01T00:00:00Z"
            }
        })
    }

    #[test]
    fn preserves_explicit_claims_without_resolving_or_authorizing_them() {
        let mut value = manifest();
        for state in INACTIVE_STATES {
            value["capabilities"]["discover"]["state"] = json!(state);
            let before = value.clone();
            assert_eq!(validate_capability_manifest(&value), Ok(()));
            assert_eq!(value, before);
        }
        // Neither old timestamps nor unresolved evidence imply execution authority.
        value["capabilities"]["discover"] = supported();
        assert_eq!(validate_capability_manifest(&value), Ok(()));
        value["capabilities"]["discover"]["state"] = json!("experimental");
        assert!(validate_capability_manifest(&value).is_err());
        value["capabilities"]["discover"]["optInRequired"] = json!(true);
        assert_eq!(validate_capability_manifest(&value), Ok(()));
        value["capabilities"]["discover"]["optInRequired"] = json!(false);
        assert!(validate_capability_manifest(&value).is_err());
    }

    #[test]
    fn mode_restrictions_require_nonlive_entries_for_every_disallowed_capability() {
        for (mode, permitted) in [
            ("managed", CAPABILITIES.as_slice()),
            ("observer", OBSERVER_CAPABILITIES.as_slice()),
            ("import-only", IMPORT_CAPABILITIES.as_slice()),
        ] {
            for name in CAPABILITIES {
                let mut value = manifest();
                value["mode"] = json!(mode);
                value["capabilities"][name] = supported();
                assert_eq!(
                    validate_capability_manifest(&value).is_ok(),
                    permitted.contains(&name),
                    "{mode}/{name}"
                );
                value["capabilities"][name]["state"] = json!("experimental");
                value["capabilities"][name]["optInRequired"] = json!(true);
                assert_eq!(
                    validate_capability_manifest(&value).is_ok(),
                    permitted.contains(&name),
                    "{mode}/{name}"
                );
            }
        }
    }

    #[test]
    fn subject_namespaces_do_not_alias_and_provider_ids_stay_open() {
        for kind in ["engine", "worker", "provider"] {
            for id in [
                "native",
                "hermes",
                "openclaw",
                "codex",
                "claude-code",
                "opencode",
                "kiro",
                "google",
                "custom.adapter_1",
            ] {
                let mut value = manifest();
                value["subject"]["kind"] = json!(kind);
                value["subject"]["id"] = json!(id);
                let expected = match kind {
                    "engine" => ["native", "hermes", "openclaw"].contains(&id),
                    "worker" => {
                        ["codex", "claude-code", "opencode", "kiro", "google"].contains(&id)
                    }
                    _ => true,
                };
                assert_eq!(
                    validate_capability_manifest(&value).is_ok(),
                    expected,
                    "{kind}/{id}"
                );
            }
        }
        let mut value = manifest();
        value["subject"]["kind"] = json!("provider");
        for id in ["", "Uppercase", "é", "a/b", "-adapter", &"a".repeat(65)] {
            value["subject"]["id"] = json!(id);
            assert!(validate_capability_manifest(&value).is_err(), "{id}");
        }
        value["subject"]["id"] = json!("a".repeat(64));
        assert_eq!(validate_capability_manifest(&value), Ok(()));
    }

    #[test]
    fn text_uses_javascript_trim_controls_and_utf16_boundaries() {
        let mut value = manifest();
        for valid in [
            "😀".repeat(1_000),
            "a".repeat(2_000),
            "\u{85}".into(),
            "\u{200b}".into(),
        ] {
            value["capabilities"]["discover"]["reason"] = json!(valid);
            assert_eq!(validate_capability_manifest(&value), Ok(()));
        }
        for invalid in [
            "😀".repeat(1_001),
            "a".repeat(2_001),
            "\u{feff}\u{a0}".into(),
            "\n".into(),
            "x\u{7f}".into(),
        ] {
            value["capabilities"]["discover"]["reason"] = json!(invalid);
            assert!(validate_capability_manifest(&value).is_err());
        }
        value["capabilities"]["discover"] = supported();
        for (pointer, units) in [
            ("/subject/adapterVersion", 128),
            ("/capabilities/discover/verification/runtimeVersion", 128),
            ("/capabilities/discover/verification/policyRef", 200),
            ("/capabilities/discover/verification/configurationRef", 200),
            ("/capabilities/discover/verification/evidenceRefs/0", 200),
        ] {
            *value.pointer_mut(pointer).unwrap() = json!("😀".repeat(units / 2));
            assert_eq!(validate_capability_manifest(&value), Ok(()), "{pointer}");
            *value.pointer_mut(pointer).unwrap() = json!("😀".repeat(units / 2) + "x");
            assert!(validate_capability_manifest(&value).is_err(), "{pointer}");
            *value.pointer_mut(pointer).unwrap() = json!("valid");
        }
    }

    #[test]
    fn closed_objects_require_entries_and_reject_nested_unknown_fields() {
        for pointer in [
            "",
            "/subject",
            "/capabilities",
            "/capabilities/discover",
            "/capabilities/discover/verification",
        ] {
            let mut value = manifest();
            value["capabilities"]["discover"] = supported();
            value
                .pointer_mut(pointer)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("unexpected".into(), json!(true));
            assert!(validate_capability_manifest(&value).is_err(), "{pointer}");
        }
        for pointer in [
            "",
            "/subject",
            "/capabilities",
            "/capabilities/discover",
            "/capabilities/discover/verification",
        ] {
            let mut complete = manifest();
            complete["capabilities"]["discover"] = supported();
            let keys: Vec<_> = complete
                .pointer(pointer)
                .unwrap()
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect();
            for key in keys {
                let mut value = complete.clone();
                value
                    .pointer_mut(pointer)
                    .unwrap()
                    .as_object_mut()
                    .unwrap()
                    .remove(&key);
                assert!(
                    validate_capability_manifest(&value).is_err(),
                    "{pointer}/{key}"
                );
            }
        }
    }

    #[test]
    fn evidence_references_are_unique_bounded_identifiers() {
        let mut value = manifest();
        value["capabilities"]["discover"] = supported();
        for refs in [
            json!([]),
            json!(["same", "same"]),
            json!([" "]),
            json!([null]),
            json!(vec!["x"; 65]),
        ] {
            value["capabilities"]["discover"]["verification"]["evidenceRefs"] = refs;
            assert!(validate_capability_manifest(&value).is_err());
        }
        value["capabilities"]["discover"]["verification"]["evidenceRefs"] = json!(
            (0..64)
                .map(|index| format!("ref-{index}"))
                .collect::<Vec<_>>()
        );
        assert_eq!(validate_capability_manifest(&value), Ok(()));
    }

    #[test]
    fn versions_are_numeric_and_timestamps_and_ids_remain_strict() {
        for version in [json!(0), json!(2), json!("1"), json!(true), json!(null)] {
            let mut value = manifest();
            value["schemaVersion"] = version;
            assert!(validate_capability_manifest(&value).is_err());
        }
        let mut value = manifest();
        value["schemaVersion"] = json!(1.0);
        assert_eq!(validate_capability_manifest(&value), Ok(()));
        for protocol in [
            "extalia.control.v0",
            "extalia.control.v2",
            "extalia.control.v1 ",
        ] {
            value["protocol"] = json!(protocol);
            assert!(validate_capability_manifest(&value).is_err());
        }
        for date in [
            "2026-02-29T00:00:00Z",
            "2026-01-01T24:00:00Z",
            "2026-01-01T00:00:00+00:00",
        ] {
            let mut value = manifest();
            value["detectedAt"] = json!(date);
            assert!(validate_capability_manifest(&value).is_err());
        }
        for id in [
            "workspace-legacy",
            "11111111-1111-0111-8111-111111111111",
            "aaaaaaaa-aaaa-4aaa-caaa-aaaaaaaaaaaa",
            "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
        ] {
            let mut value = manifest();
            value["workspaceId"] = json!(id);
            assert!(validate_capability_manifest(&value).is_err());
        }
    }
}
