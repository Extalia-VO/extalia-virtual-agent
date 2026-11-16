//! Isolated, bounded OpenAI-compatible model catalog discovery. No profile or credential stores.

use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::time::{Duration, Instant};

use reqwest::Url;
use reqwest::blocking::Client;
use reqwest::header::{AUTHORIZATION, HeaderValue};
use serde::Deserialize;
use serde_json::{Value, json};

const SCHEMA: &str = "extalia.provider-models.v1";
const REQUEST_LIMIT: u64 = 16 * 1024;
const BODY_LIMIT: usize = 2 * 1024 * 1024;
const ROW_LIMIT: usize = 10_000;
const MODEL_LIMIT: usize = 500;
const REPLY_LIMIT: usize = 128 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawRequest {
    schema: String,
    request_id: String,
    client_version: String,
    base_url: String,
    api_key: Option<String>,
    headers: Option<Headers>,
    timeout_ms: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Headers {
    #[serde(rename = "x-omniroute-no-memory")]
    no_memory: Option<String>,
}

struct Request {
    url: Url,
    authorization: Option<HeaderValue>,
    no_memory: bool,
    timeout: Duration,
}

#[derive(Clone, Copy)]
struct Failure {
    code: &'static str,
    status: Option<u16>,
}

impl Failure {
    fn new(code: &'static str) -> Self {
        Self { code, status: None }
    }
}

fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
        && (b'1'..=b'8').contains(&value.as_bytes()[14])
        && b"89ab".contains(&value.as_bytes()[19])
}

fn clean(value: &str, limit: usize) -> bool {
    value.encode_utf16().count() <= limit && !value.chars().any(char::is_control)
}

fn validate(bytes: &[u8], value: &Value) -> Option<Request> {
    // Deserialize the original bytes too: duplicate fields must not be silently overwritten.
    let raw: RawRequest = serde_json::from_slice(bytes).ok()?;
    if raw.schema != SCHEMA
        || !uuid(&raw.request_id)
        || !clean(&raw.client_version, 64)
        || raw.client_version.trim().is_empty()
        || !clean(&raw.base_url, 4096)
        || raw.base_url.trim().is_empty()
        || !(1..=15_000).contains(&raw.timeout_ms)
        || value.get("apiKey").is_some_and(Value::is_null)
        || value.get("headers").is_some_and(Value::is_null)
    {
        return None;
    }
    let base = raw.base_url.trim();
    if base.contains(['?', '#', '\\']) || base.chars().any(char::is_whitespace) {
        return None;
    }
    let mut url = Url::parse(base).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || base.split_once("://")?.1.split('/').next()?.contains('@')
    {
        return None;
    }
    let path = format!("{}/models", url.path().trim_end_matches('/'));
    url.set_path(&path);
    let authorization = match raw.api_key {
        Some(key) if !key.is_empty() => {
            if !clean(&key, 8192) {
                return None;
            }
            let mut header = HeaderValue::from_str(&format!("Bearer {key}")).ok()?;
            header.set_sensitive(true);
            Some(header)
        }
        _ => None,
    };
    let no_memory = match raw.headers {
        Some(headers) => match headers.no_memory.as_deref() {
            Some("true") => true,
            _ => return None,
        },
        None => false,
    };
    Some(Request {
        url,
        authorization,
        no_memory,
        timeout: Duration::from_millis(raw.timeout_ms),
    })
}

fn model_id(id: &str) -> bool {
    (1..=200).contains(&id.len())
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:/@+-".contains(&b))
}

fn discover(request: Request) -> Result<(Vec<String>, bool), Failure> {
    let started = Instant::now();
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(request.timeout)
        .timeout(request.timeout)
        .build()
        .map_err(|_| Failure::new("transport_error"))?;
    let remaining = request
        .timeout
        .checked_sub(started.elapsed())
        .ok_or_else(|| Failure::new("timeout"))?;
    let mut call = client.get(request.url).timeout(remaining);
    if let Some(authorization) = request.authorization {
        call = call.header(AUTHORIZATION, authorization);
    }
    if request.no_memory {
        call = call.header("x-omniroute-no-memory", "true");
    }
    let mut response = call.send().map_err(|error| {
        Failure::new(if error.is_timeout() {
            "timeout"
        } else {
            "transport_error"
        })
    })?;
    if !response.status().is_success() {
        if !(100..=599).contains(&response.status().as_u16()) {
            return Err(Failure::new("invalid_response"));
        }
        return Err(Failure {
            code: "http_error",
            status: Some(response.status().as_u16()),
        });
    }
    let mut body = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        if started.elapsed() >= request.timeout {
            return Err(Failure::new("timeout"));
        }
        let read = response.read(&mut chunk).map_err(|error| {
            let timeout = error.kind() == std::io::ErrorKind::TimedOut
                || error
                    .get_ref()
                    .and_then(|e| e.downcast_ref::<reqwest::Error>())
                    .is_some_and(reqwest::Error::is_timeout);
            Failure::new(if timeout {
                "timeout"
            } else {
                "transport_error"
            })
        })?;
        if read == 0 {
            break;
        }
        if body.len() + read > BODY_LIMIT {
            return Err(Failure::new("response_too_large"));
        }
        body.extend_from_slice(&chunk[..read]);
    }
    let value: Value =
        serde_json::from_slice(&body).map_err(|_| Failure::new("invalid_response"))?;
    let rows = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| Failure::new("invalid_response"))?;
    if rows.len() > ROW_LIMIT {
        return Err(Failure::new("response_too_large"));
    }
    let models: BTreeSet<_> = rows
        .iter()
        .filter_map(|row| row.get("id").and_then(Value::as_str))
        .filter(|id| model_id(id))
        .map(str::to_owned)
        .collect();
    let truncated = models.len() > MODEL_LIMIT;
    Ok((models.into_iter().take(MODEL_LIMIT).collect(), truncated))
}

/// Read exactly one EOF-terminated JSON document, emit at most one bounded reply, then exit.
/// Invalid input without a usable correlation identifier exits 2 without output.
pub fn serve(mut input: impl Read, mut output: impl Write) -> u8 {
    let mut bytes = Vec::new();
    if input
        .by_ref()
        .take(REQUEST_LIMIT + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() > REQUEST_LIMIT as usize
    {
        return 2;
    }
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return 2;
    };
    let Some(request_id) = value
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|id| uuid(id))
    else {
        return 2;
    };
    let result = validate(&bytes, &value)
        .ok_or_else(|| Failure::new("invalid_request"))
        .and_then(discover);
    let mut reply = json!({
        "schema": SCHEMA, "requestId": request_id, "daemonVersion": env!("CARGO_PKG_VERSION")
    });
    match result {
        Ok((models, truncated)) => {
            reply["outcome"] = json!("ok");
            reply["models"] = json!(models);
            reply["truncated"] = json!(truncated);
        }
        Err(failure) => {
            reply["outcome"] = json!("error");
            reply["code"] = json!(failure.code);
            if let Some(status) = failure.status {
                reply["status"] = json!(status);
            }
        }
    }
    let Ok(mut bytes) = serde_json::to_vec(&reply) else {
        return 1;
    };
    bytes.push(b'\n');
    if bytes.len() >= REPLY_LIMIT
        || output
            .write_all(&bytes)
            .and_then(|()| output.flush())
            .is_err()
    {
        return 1;
    }
    0
}
