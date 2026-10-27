//! Canonical JSON of stored records, matching `canonical()` in
//! `packages/host/src/missionCheckpoints.ts`: object keys sorted by UTF-16 code units,
//! arrays in order, no whitespace, strings escaped like `JSON.stringify`. Integral numbers
//! within the safe range print without a fraction, as JavaScript does (`1.0` -> `1`).
//! Equal canonical text means an identical record (ADR 0014 idempotency).

use serde_json::Value;

use crate::sha256::hex_digest;

/// Canonical text of `value`.
pub fn to_string(value: &Value) -> String {
    let mut out = String::new();
    write(value, &mut out);
    out
}

/// Lowercase SHA-256 of the canonical text.
pub fn digest(value: &Value) -> String {
    hex_digest(to_string(value).as_bytes())
}

fn write(value: &Value, out: &mut String) {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => {
            out.push_str(&serde_json::to_string(value).expect("JSON scalars serialize"));
        }
        Value::Number(number) => {
            match number.as_f64().filter(|_| number.is_f64()) {
                Some(float) if float.fract() == 0.0 && float.abs() <= 9_007_199_254_740_991.0 => {
                    // `-0` prints as `0` in JavaScript.
                    out.push_str(&format!("{}", float as i64));
                }
                _ => out.push_str(&number.to_string()),
            }
        }
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).expect("strings serialize"));
                out.push(':');
                write(&map[key], out);
            }
            out.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn sorts_keys_and_prints_like_json_stringify() {
        let value = json!({ "b": [1.0, 2.5, -0.0, "x\n\u{2028}\u{7f}"], "a": { "z": null, "y": true }, "A": 1 });
        assert_eq!(
            super::to_string(&value),
            "{\"A\":1,\"a\":{\"y\":true,\"z\":null},\"b\":[1,2.5,0,\"x\\n\u{2028}\u{7f}\"]}"
        );
        assert_eq!(
            super::digest(&json!({})),
            "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
        );
    }
}
