//! Learning uses a finite action union. The generated protocol schema is the shared
//! structural validator; semantic identity/authority checks stay in the Rust owner.
use super::{Check, RequestParams, ResponseResult};
use serde_json::Value;
use std::sync::OnceLock;
static SCHEMA: OnceLock<Value> = OnceLock::new();
fn schema() -> &'static Value {
    SCHEMA.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../packages/protocol/schemas/daemon-frame.schema.json"
        ))
        .expect("generated learning schema")
    })
}
fn opaque(value: &Value, depth: usize) -> bool {
    if depth > 16 {
        return false;
    }
    match value {
        Value::String(s) => s.encode_utf16().count() <= 131072,
        Value::Array(a) => a.len() <= 256 && a.iter().all(|v| opaque(v, depth + 1)),
        Value::Object(o) => {
            o.len() <= 128
                && o.iter()
                    .all(|(k, v)| k.encode_utf16().count() <= 200 && opaque(v, depth + 1))
        }
        _ => true,
    }
}
fn matches(value: &Value, s: &Value) -> bool {
    if !s.is_object() {
        return false;
    }
    // Schema evolution must fail closed until this bounded subset implements it.
    if s.as_object().is_some_and(|o| {
        o.keys().any(|k| {
            !matches!(
                k.as_str(),
                "description"
                    | "type"
                    | "oneOf"
                    | "const"
                    | "enum"
                    | "properties"
                    | "required"
                    | "additionalProperties"
                    | "minItems"
                    | "maxItems"
                    | "uniqueItems"
                    | "items"
                    | "minLength"
                    | "maxLength"
                    | "minimum"
                    | "maximum"
            )
        })
    }) {
        return false;
    }

    if s.get("description")
        .and_then(Value::as_str)
        .is_some_and(|s| s.starts_with("JSON data bounded"))
        && (!opaque(value, 0) || value.to_string().encode_utf16().count() > 131072)
    {
        return false;
    }
    if let Some(choices) = s.get("oneOf").and_then(Value::as_array) {
        return choices.iter().filter(|s| matches(value, s)).count() == 1;
    }
    if let Some(c) = s.get("const")
        && c != value
    {
        return false;
    }
    if let Some(e) = s.get("enum").and_then(Value::as_array)
        && !e.contains(value)
    {
        return false;
    }
    match s.get("type").and_then(Value::as_str) {
        Some("object") => {
            let Some(o) = value.as_object() else {
                return false;
            };
            let props = s.get("properties").and_then(Value::as_object);
            if s.get("additionalProperties") == Some(&Value::Bool(false))
                && o.keys().any(|k| props.is_none_or(|p| !p.contains_key(k)))
            {
                return false;
            }
            if s.get("required")
                .and_then(Value::as_array)
                .is_some_and(|r| r.iter().any(|k| !o.contains_key(k.as_str().unwrap_or(""))))
            {
                return false;
            }
            if let Some(props) = props
                && o.iter()
                    .any(|(k, v)| props.get(k).is_some_and(|s| !matches(v, s)))
            {
                return false;
            }
        }
        Some("array") => {
            let Some(a) = value.as_array() else {
                return false;
            };
            if a.len() < s.get("minItems").and_then(Value::as_u64).unwrap_or(0) as usize
                || a.len()
                    > s.get("maxItems")
                        .and_then(Value::as_u64)
                        .unwrap_or(u64::MAX) as usize
            {
                return false;
            }
            if s.get("uniqueItems") == Some(&Value::Bool(true))
                && a.iter().enumerate().any(|(i, v)| a[..i].contains(v))
            {
                return false;
            }
            if let Some(item) = s.get("items")
                && a.iter().any(|v| !matches(v, item))
            {
                return false;
            }
        }
        Some("string") => {
            let Some(t) = value.as_str() else {
                return false;
            };
            let n = t.encode_utf16().count();
            if n < s.get("minLength").and_then(Value::as_u64).unwrap_or(0) as usize
                || n > s
                    .get("maxLength")
                    .and_then(Value::as_u64)
                    .unwrap_or(u64::MAX) as usize
            {
                return false;
            }
        }
        Some("integer") | Some("number") => {
            let Some(n) = value.as_f64() else {
                return false;
            };
            if s["type"] == "integer" && n.fract() != 0.0
                || n < s
                    .get("minimum")
                    .and_then(Value::as_f64)
                    .unwrap_or(f64::NEG_INFINITY)
                || n > s
                    .get("maximum")
                    .and_then(Value::as_f64)
                    .unwrap_or(f64::INFINITY)
            {
                return false;
            }
        }
        Some("boolean") => {
            if !value.is_boolean() {
                return false;
            }
        }
        None => {}
        _ => return false,
    }
    true
}
pub fn valid_params(value: &Value) -> bool {
    matches(value, &schema()["$defs"]["DaemonLearningProcessParams"])
}
pub fn valid_result(value: &Value) -> bool {
    matches(value, &schema()["$defs"]["DaemonLearningProcessResult"])
}
pub(super) fn request(check: &mut Check, value: &Value) -> Option<RequestParams> {
    if !valid_params(value) {
        check.fail("frame.params", "invalid learning action or bounded payload");
        return None;
    }
    Some(RequestParams::Learning(value.clone()))
}
pub(super) fn result(check: &mut Check, value: &Value) -> Option<ResponseResult> {
    if !valid_result(value) {
        check.fail("frame.result", "invalid learning result");
        return None;
    }
    Some(ResponseResult::Learning(value.clone()))
}
