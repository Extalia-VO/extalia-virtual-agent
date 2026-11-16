//! Isolated OpenAI-compatible completion execution. No profile, stores or ambient credentials.

mod outbound;
mod response;
pub mod worker;

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::time::{Duration, Instant};

use reqwest::Url;
use reqwest::blocking::{Client, Response};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Value, json};

const SCHEMA: &str = "extalia.provider-complete.v1";
const REQUEST_LIMIT: u64 = 128 * 1024 * 1024;
const WIRE_LIMIT: usize = 64 * 1024 * 1024;
const FRAME_LIMIT: usize = 32 * 1024 * 1024;
const TEXT_LIMIT: usize = 8 * 1024 * 1024;
const TOOL_LIMIT: usize = 128;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    schema: String,
    request_id: String,
    client_version: String,
    connection: Connection,
    system: String,
    messages: Vec<Message>,
    tools: Vec<Tool>,
    timeout_ms: u64,
    request_usage: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Connection {
    base_url: String,
    model: String,
    api_key: Option<String>,
    headers: Option<BTreeMap<String, String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Role {
    User,
    Assistant,
    Tool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Message {
    role: Role,
    text: Option<String>,
    images: Option<Vec<Image>>,
    tool_calls: Option<Vec<ToolCall>>,
    native: Option<Value>,
    results: Option<Vec<ToolResult>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Image {
    mime_type: String,
    data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolCall {
    id: String,
    name: String,
    input: Box<RawValue>,
    #[serde(rename = "inputError")]
    _input_error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolResult {
    tool_call_id: String,
    #[serde(rename = "name")]
    _name: String,
    content: String,
    is_error: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Tool {
    name: String,
    description: String,
    parameters: Box<RawValue>,
}

#[derive(Debug)]
struct Failure {
    code: &'static str,
    status: Option<u16>,
    retryable: bool,
}
impl Failure {
    fn new(code: &'static str) -> Self {
        Self {
            code,
            status: None,
            retryable: false,
        }
    }
}

type Result<T> = std::result::Result<T, Failure>;

fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit() && !b.is_ascii_uppercase()
            }
        })
        && (b'1'..=b'8').contains(&value.as_bytes()[14])
        && b"89ab".contains(&value.as_bytes()[19])
}

fn clean(value: &str, limit: usize) -> bool {
    value.len() <= limit && !value.chars().any(char::is_control)
}

// serde's recursion limit bounds parsing; this also bounds protocol object complexity.
fn bounded_json(value: &Value) -> bool {
    fn visit(value: &Value, depth: usize, remaining: &mut usize) -> bool {
        if depth > 64 || *remaining == 0 {
            return false;
        }
        *remaining -= 1;
        match value {
            Value::Array(values) => values.iter().all(|v| visit(v, depth + 1, remaining)),
            Value::Object(values) => values.values().all(|v| visit(v, depth + 1, remaining)),
            _ => true,
        }
    }
    visit(value, 0, &mut 100_000)
}

fn bounded_raw(value: &RawValue) -> bool {
    serde_json::from_str::<Value>(value.get())
        .is_ok_and(|value| value.is_object() && bounded_json(&value))
}

#[derive(Serialize)]
struct Envelope<'a, T> {
    schema: &'static str,
    #[serde(rename = "requestId")]
    request_id: &'a str,
    seq: u64,
    #[serde(flatten)]
    payload: T,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Terminal {
    Result {
        result: response::CompletionResult,
        #[serde(
            rename = "streamOptionsRejected",
            skip_serializing_if = "Option::is_none"
        )]
        stream_options_rejected: Option<bool>,
    },
    Error {
        code: &'static str,
        retryable: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<u16>,
    },
}

/// Framed writes propagate broken pipes immediately; only callers write the terminal frame.
struct Frames<W> {
    output: W,
    request_id: String,
    seq: u64,
}
trait TextSink {
    fn text(&mut self, text: &str) -> Result<()>;
}
impl TextSink for Vec<String> {
    fn text(&mut self, text: &str) -> Result<()> {
        self.push(text.to_owned());
        Ok(())
    }
}
impl<W: Write> TextSink for Frames<W> {
    fn text(&mut self, text: &str) -> Result<()> {
        Frames::text(self, text)
    }
}
impl<W: Write> Frames<W> {
    fn emit(&mut self, payload: impl Serialize) -> Result<()> {
        let bytes = serde_json::to_vec(&Envelope {
            schema: SCHEMA,
            request_id: &self.request_id,
            seq: self.seq,
            payload,
        })
        .map_err(|_| Failure::new("response_too_large"))?;
        if bytes.len() > FRAME_LIMIT {
            return Err(Failure::new("response_too_large"));
        }
        self.output
            .write_all(&(bytes.len() as u32).to_le_bytes())
            .and_then(|()| self.output.write_all(&bytes))
            .and_then(|()| self.output.flush())
            .map_err(|_| Failure::new("output_error"))?;
        self.seq += 1;
        Ok(())
    }
    fn text(&mut self, mut text: &str) -> Result<()> {
        while !text.is_empty() {
            if self.seq >= 1_000_000 {
                return Err(Failure::new("response_too_large"));
            }
            let mut end = text.len().min(16 * 1024);
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            self.emit(json!({"kind":"delta", "text": &text[..end]}))?;
            text = &text[end..];
        }
        Ok(())
    }
}

impl Request {
    fn prepare(&self) -> Result<(Url, HeaderMap)> {
        let invalid = || Failure::new("invalid_request");
        if self.schema != SCHEMA
            || !clean(&self.client_version, 64)
            || self.client_version.trim().is_empty()
            || !(1..=600_000).contains(&self.timeout_ms)
            || !clean(&self.connection.model, 4096)
            || self.connection.model.trim().is_empty()
            || self.tools.len() > TOOL_LIMIT
            || self.messages.len() > 100_000
        {
            return Err(invalid());
        }
        let base = self.connection.base_url.trim();
        if !clean(base, 4096)
            || base.contains(['?', '#', '\\'])
            || base.chars().any(char::is_whitespace)
        {
            return Err(invalid());
        }
        let mut url = Url::parse(base).map_err(|_| invalid())?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || base
                .split_once("://")
                .ok_or_else(invalid)?
                .1
                .split('/')
                .next()
                .ok_or_else(invalid)?
                .contains('@')
        {
            return Err(invalid());
        }
        url.set_path(&format!(
            "{}/chat/completions",
            url.path().trim_end_matches('/')
        ));
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        if let Some(key) = self
            .connection
            .api_key
            .as_ref()
            .filter(|key| !key.is_empty())
        {
            if !clean(key, 8192) {
                return Err(invalid());
            }
            let mut value =
                HeaderValue::from_str(&format!("Bearer {key}")).map_err(|_| invalid())?;
            value.set_sensitive(true);
            headers.insert(AUTHORIZATION, value);
        }
        if let Some(custom) = &self.connection.headers {
            if custom.len() > 128
                || custom.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>() > 64 * 1024
            {
                return Err(invalid());
            }
            for (name, value) in custom {
                if name.len() > 256 || !clean(value, 8192) {
                    return Err(invalid());
                }
                let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| invalid())?;
                let mut value = HeaderValue::from_str(value).map_err(|_| invalid())?;
                value.set_sensitive(true);
                headers.insert(name, value);
            }
        }
        for message in &self.messages {
            match message.role {
                Role::User => {
                    if message.text.is_none()
                        || message.tool_calls.is_some()
                        || message.results.is_some()
                        || message.native.is_some()
                    {
                        return Err(invalid());
                    }
                    if message.images.as_ref().is_some_and(|images| {
                        images.len() > 128
                            || images.iter().any(|i| {
                                !matches!(
                                    i.mime_type.as_str(),
                                    "image/png" | "image/jpeg" | "image/webp" | "image/gif"
                                )
                            })
                    }) {
                        return Err(invalid());
                    }
                }
                Role::Assistant => {
                    if message.text.is_none()
                        || message.images.is_some()
                        || message.results.is_some()
                    {
                        return Err(invalid());
                    }
                    let calls = message.tool_calls.as_ref().ok_or_else(invalid)?;
                    if calls.len() > TOOL_LIMIT
                        || calls.iter().any(|t| !bounded_raw(&t.input))
                        || message.native.as_ref().is_some_and(|v| !bounded_json(v))
                    {
                        return Err(invalid());
                    }
                }
                Role::Tool => {
                    if message.results.is_none()
                        || message.text.is_some()
                        || message.images.is_some()
                        || message.tool_calls.is_some()
                        || message.native.is_some()
                    {
                        return Err(invalid());
                    }
                }
            }
        }
        if self.tools.iter().any(|t| !bounded_raw(&t.parameters)) {
            return Err(invalid());
        }
        Ok((url, headers))
    }

    fn body(&self, usage: bool) -> Result<Vec<u8>> {
        outbound::body(self, usage)
    }
}

fn transport(error: reqwest::Error) -> Failure {
    Failure::new(if error.is_timeout() {
        "timeout"
    } else {
        "transport_error"
    })
}

fn read_chunk(response: &mut Response, bytes: &mut [u8]) -> Result<usize> {
    response.read(bytes).map_err(|error| {
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
    })
}

fn read_body(response: &mut Response) -> Result<Vec<u8>> {
    let mut body = Vec::new();
    let mut chunk = [0; 8192];
    loop {
        let read = read_chunk(response, &mut chunk)?;
        if read == 0 {
            return Ok(body);
        }
        if body.len() + read > WIRE_LIMIT {
            return Err(Failure::new("response_too_large"));
        }
        body.extend_from_slice(&chunk[..read]);
    }
}

fn error_detail(body: &[u8]) -> String {
    if let Ok(value) = serde_json::from_slice::<Value>(body) {
        let detail = value
            .get("error")
            .and_then(|v| {
                v.as_str()
                    .or_else(|| v.get("message").and_then(Value::as_str))
            })
            .or_else(|| value.get("message").and_then(Value::as_str))
            .unwrap_or("");
        detail.to_owned()
    } else {
        String::from_utf8_lossy(&body[..body.len().min(1200)])
            .chars()
            .take(300)
            .collect()
    }
}

fn complete<W: Write>(
    request: &Request,
    frames: &mut Frames<W>,
) -> Result<(response::CompletionResult, bool)> {
    let (url, headers) = request.prepare()?;
    let timeout = Duration::from_millis(request.timeout_ms);
    let started = Instant::now();
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(timeout)
        .timeout(timeout)
        .build()
        .map_err(transport)?;
    let send = |usage| -> Result<Response> {
        let body = request.body(usage)?;
        let remaining = timeout
            .checked_sub(started.elapsed())
            .ok_or_else(|| Failure::new("timeout"))?;
        client
            .post(url.clone())
            .headers(headers.clone())
            .timeout(remaining)
            .body(body)
            .send()
            .map_err(transport)
    };
    let mut response = send(request.request_usage)?;
    let mut failure_body = None;
    let mut rejected = false;
    if response.status().as_u16() == 400 && request.request_usage {
        let body = read_body(&mut response)?;
        if response::stream_options_rejected(&error_detail(&body)) {
            response = send(false)?;
            rejected = response.status().is_success();
        } else {
            failure_body = Some(body);
        }
    }
    if !response.status().is_success() {
        let status = response.status().as_u16();
        if !(100..=599).contains(&status) {
            return Err(Failure::new("invalid_response"));
        }
        let body = match failure_body {
            Some(body) => body,
            None => read_body(&mut response)?,
        };
        return Err(Failure {
            code: "http_error",
            status: Some(status),
            retryable: status != 401
                && (matches!(status, 402 | 408 | 429 | 500..=599)
                    || response::quota(&error_detail(&body))),
        });
    }
    let mut state = response::State::default();
    let is_json = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .contains("application/json");
    if is_json {
        let body = read_body(&mut response)?;
        let value = serde_json::from_slice(&body).map_err(|_| Failure::new("invalid_response"))?;
        state.absorb(value, frames)?;
    } else {
        response::stream(&mut response, &mut state, frames)?;
    }
    Ok((state.finish()?, rejected))
}

/// One EOF-terminated request; framed progress followed by one terminal response.
pub fn serve(mut input: impl Read, output: impl Write) -> u8 {
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
    let Ok(request) = serde_json::from_slice::<Request>(&bytes) else {
        return 2;
    };
    drop(bytes);
    if !uuid(&request.request_id) {
        return 2;
    }
    let mut frames = Frames {
        output,
        request_id: request.request_id.clone(),
        seq: 0,
    };
    let terminal = match complete(&request, &mut frames) {
        Ok((result, rejected)) => Terminal::Result {
            result,
            stream_options_rejected: rejected.then_some(true),
        },
        Err(error) if error.code == "output_error" => return 1,
        Err(error) => Terminal::Error {
            code: error.code,
            retryable: error.retryable,
            status: error.status,
        },
    };
    match frames.emit(terminal) {
        Ok(()) => 0,
        Err(error) if error.code == "response_too_large" => {
            if frames
                .emit(Terminal::Error {
                    code: "response_too_large",
                    retryable: false,
                    status: None,
                })
                .is_ok()
            {
                0
            } else {
                1
            }
        }
        Err(_) => 1,
    }
}
