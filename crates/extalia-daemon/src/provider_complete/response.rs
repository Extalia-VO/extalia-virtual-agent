use std::collections::BTreeMap;

use reqwest::blocking::Response;
use serde::Serialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};

use super::{Failure, Result, TEXT_LIMIT, TOOL_LIMIT, TextSink, WIRE_LIMIT, read_chunk};

const PENDING_LIMIT: usize = 2 * 1024 * 1024;
const ARGS_LIMIT: usize = 8 * 1024 * 1024;

pub(super) fn stream_options_rejected(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    if text.contains("stream_options") {
        return true;
    }
    // Equivalent to (unknown|unrecognized|unsupported)\s+(request\s+)?(parameter|argument|field).
    text.char_indices().any(|(offset, _)| {
        let rest = &text[offset..];
        ["unknown", "unrecognized", "unsupported"]
            .iter()
            .any(|prefix| {
                let Some(rest) = rest.strip_prefix(prefix) else {
                    return false;
                };
                let trimmed = rest.trim_start_matches(char::is_whitespace);
                if rest.len() == trimmed.len() {
                    return false;
                }
                let rest = if let Some(after) = trimmed.strip_prefix("request") {
                    let next = after.trim_start_matches(char::is_whitespace);
                    if next.len() == after.len() {
                        trimmed
                    } else {
                        next
                    }
                } else {
                    trimmed
                };
                ["parameter", "argument", "field"]
                    .iter()
                    .any(|word| rest.starts_with(word))
            })
    })
}

pub(super) fn quota(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    if text.contains("context")
        || text.contains("prompt is too long")
        || text
            .find("maximum")
            .is_some_and(|i| text[i..].contains("length"))
    {
        return false;
    }
    if [
        "quota",
        "credit",
        "billing",
        "payment required",
        "too many requests",
        "usage limit",
        "limit exceeded",
        "limit reached",
        "exceeded your",
        "out of tokens",
        "token limit exceeded",
        "token limit reached",
        "tokens limit exceeded",
        "tokens limit reached",
        "token budget exceeded",
        "token budget reached",
        "tokens budget exceeded",
        "tokens budget reached",
    ]
    .iter()
    .any(|s| text.contains(s))
    {
        return true;
    }
    ["ratelimit", "rate_limit", "rate-limit", "rate limit"]
        .iter()
        .any(|s| text.contains(s))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CompletionResult {
    text: String,
    tool_calls: Vec<ReturnedCall>,
    stop: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    refusal: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReturnedCall {
    id: String,
    name: String,
    input: Box<RawValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    input_error: Option<&'static str>,
}

#[derive(Default)]
struct Call {
    id: String,
    name: String,
    args: String,
}

#[derive(Default)]
pub(super) struct State {
    text: String,
    finish: Option<String>,
    model: Option<String>,
    usage: Map<String, Value>,
    calls: BTreeMap<usize, Call>,
    args_bytes: usize,
}

impl State {
    fn usage(&mut self, raw: Option<&Value>) {
        let Some(raw) = raw.and_then(Value::as_object) else {
            return;
        };
        for (target, primary, alternate) in [
            ("inputTokens", "prompt_tokens", "input_tokens"),
            ("outputTokens", "completion_tokens", "output_tokens"),
        ] {
            if let Some(value) = raw.get(primary).or_else(|| raw.get(alternate)) {
                self.usage.insert(
                    target.into(),
                    count(value).map_or(Value::Null, |n| json!(n)),
                );
            }
        }
        if let Some(value) = raw
            .get("prompt_tokens_details")
            .and_then(|v| v.get("cached_tokens"))
        {
            self.usage.insert(
                "cachedInputTokens".into(),
                count(value).map_or(Value::Null, |n| json!(n)),
            );
        }
    }

    fn text(&mut self, text: Option<&Value>, frames: &mut impl TextSink) -> Result<()> {
        if let Some(text) = text.and_then(Value::as_str).filter(|s| !s.is_empty()) {
            if self.text.len() + text.len() > TEXT_LIMIT {
                return Err(Failure::new("response_too_large"));
            }
            self.text.push_str(text);
            frames.text(text)?;
        }
        Ok(())
    }

    fn call(&mut self, index: usize, value: &Value, replace: bool) -> Result<()> {
        if !self.calls.contains_key(&index) && self.calls.len() >= TOOL_LIMIT {
            return Err(Failure::new("response_too_large"));
        }
        let call = self.calls.entry(index).or_default();
        if replace {
            self.args_bytes -= call.args.len();
            *call = Call::default();
        }
        if let Some(id) = value
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            if id.len() > 4096 {
                return Err(Failure::new("response_too_large"));
            }
            call.id = id.into();
        }
        if let Some(function) = value.get("function") {
            if let Some(name) = function.get("name").and_then(Value::as_str) {
                if call.name.len() + name.len() > 4096 {
                    return Err(Failure::new("response_too_large"));
                }
                call.name.push_str(name);
            }
            if let Some(args) = function.get("arguments").and_then(Value::as_str) {
                if self.args_bytes + args.len() > ARGS_LIMIT {
                    return Err(Failure::new("response_too_large"));
                }
                call.args.push_str(args);
                self.args_bytes += args.len();
            }
        }
        Ok(())
    }

    pub(super) fn absorb(&mut self, chunk: Value, frames: &mut impl TextSink) -> Result<()> {
        if !chunk.is_object() {
            return Err(Failure::new("invalid_response"));
        }
        if let Some(message) = chunk
            .get("error")
            .and_then(|v| v.get("message"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            return Err(Failure {
                code: "provider_error",
                status: None,
                retryable: quota(message),
            });
        }
        if let Some(model) = chunk
            .get("model")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            if model.len() > 4096 || model.trim().is_empty() {
                return Err(Failure::new("response_too_large"));
            }
            self.model = Some(model.into());
        }
        self.usage(chunk.get("usage"));
        if let Some(choices) = chunk.get("choices") {
            let choices = choices
                .as_array()
                .ok_or_else(|| Failure::new("invalid_response"))?;
            if choices.len() > 128 {
                return Err(Failure::new("response_too_large"));
            }
            for choice in choices {
                self.usage(choice.get("usage"));
                let delta = choice.get("delta");
                self.usage(delta.and_then(|d| d.get("usage")));
                if let Some(finish) = choice
                    .get("finish_reason")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    if finish.len() > 1024 {
                        return Err(Failure::new("response_too_large"));
                    }
                    self.finish = Some(finish.into());
                }
                if let Some(message) = choice.get("message") {
                    self.text(message.get("content"), frames)?;
                    if let Some(calls) = message.get("tool_calls") {
                        let calls = calls
                            .as_array()
                            .ok_or_else(|| Failure::new("invalid_response"))?;
                        if calls.len() > TOOL_LIMIT {
                            return Err(Failure::new("response_too_large"));
                        }
                        for (index, call) in calls.iter().enumerate() {
                            self.call(index, call, true)?;
                        }
                    }
                }
                if let Some(delta) = delta {
                    self.text(delta.get("content"), frames)?;
                    if let Some(calls) = delta.get("tool_calls") {
                        let calls = calls
                            .as_array()
                            .ok_or_else(|| Failure::new("invalid_response"))?;
                        if calls.len() > TOOL_LIMIT {
                            return Err(Failure::new("response_too_large"));
                        }
                        for call in calls {
                            let index = match call.get("index") {
                                None | Some(Value::Null) => self.calls.len(),
                                Some(value) => value
                                    .as_u64()
                                    .and_then(|n| usize::try_from(n).ok())
                                    .filter(|n| *n <= 9_007_199_254_740_991)
                                    .ok_or_else(|| Failure::new("invalid_response"))?,
                            };
                            self.call(index, call, false)?;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    pub(super) fn finish(mut self) -> Result<CompletionResult> {
        let truncated = self.finish.as_deref() == Some("length");
        let filtered = self.finish.as_deref() == Some("content_filter");
        // A filtered response never authorizes tools accumulated before its terminal chunk.
        if filtered {
            self.calls.clear();
        }
        let mut calls = Vec::with_capacity(self.calls.len());
        for (index, call) in self.calls {
            let empty = || RawValue::from_string("{}".into()).expect("constant JSON object");
            let (input, error) = if truncated {
                (
                    empty(),
                    Some("Tool arguments were truncated by the provider."),
                )
            } else if call.args.trim().is_empty() {
                (empty(), None)
            } else {
                match serde_json::from_str::<Value>(&call.args) {
                    Ok(value) if value.is_object() => {
                        if !super::bounded_json(&value) {
                            return Err(Failure::new("response_too_large"));
                        }
                        let raw = RawValue::from_string(call.args)
                            .map_err(|_| Failure::new("invalid_response"))?;
                        (raw, None)
                    }
                    Ok(_) => (empty(), Some("Tool arguments must be a JSON object.")),
                    Err(_) => (empty(), Some("Tool arguments were not valid JSON.")),
                }
            };
            calls.push(ReturnedCall {
                id: if call.id.is_empty() {
                    format!("call_{index}")
                } else {
                    call.id
                },
                name: call.name,
                input,
                input_error: error,
            });
        }
        self.usage.retain(|_, v| !v.is_null());
        if let (Some(input), Some(cached)) = (
            self.usage.get("inputTokens").and_then(count),
            self.usage.get("cachedInputTokens").and_then(count),
        ) && cached > input
        {
            self.usage.remove("cachedInputTokens");
        }
        let stop = if filtered {
            "refusal"
        } else if truncated {
            "max_tokens"
        } else if !calls.is_empty() {
            "tool_use"
        } else {
            match self.finish.as_deref() {
                None | Some("stop") => "end",
                Some("content_filter") => "refusal",
                _ => "other",
            }
        };
        Ok(CompletionResult {
            text: self.text,
            tool_calls: calls,
            stop,
            model: self.model,
            prompt_tokens: self.usage.get("inputTokens").and_then(count),
            usage: (!self.usage.is_empty()).then_some(self.usage),
            refusal: filtered.then_some("The provider filtered this response."),
        })
    }
}

fn count(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .filter(|n| *n <= 9_007_199_254_740_991)
        .or_else(|| {
            value
                .as_f64()
                .filter(|n| {
                    n.is_finite() && *n >= 0.0 && *n <= 9_007_199_254_740_991.0 && n.fract() == 0.0
                })
                .map(|n| n as u64)
        })
}

fn event(block: &[u8], state: &mut State, frames: &mut impl TextSink) -> Result<bool> {
    let text = String::from_utf8_lossy(block);
    let data: Vec<_> = text
        .split('\n')
        .filter_map(|line| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            let (name, value) = line.split_once(':').unwrap_or((line, ""));
            (name == "data").then(|| value.strip_prefix(' ').unwrap_or(value))
        })
        .collect();
    if data.is_empty() {
        return Ok(false);
    }
    let data = data.join("\n");
    if data == "[DONE]" {
        return Ok(true);
    }
    // Keep legacy tolerance for malformed event JSON; malformed arguments are handled explicitly.
    if let Ok(value) = serde_json::from_str(&data) {
        state.absorb(value, frames)?;
    }
    Ok(false)
}

#[derive(Default)]
pub(super) struct Sse {
    wire_bytes: usize,
    pending: Vec<u8>,
    scan: usize,
    line_start: usize,
    done: bool,
}
impl Sse {
    pub(super) fn feed(
        &mut self,
        bytes: &[u8],
        eof: bool,
        state: &mut State,
        frames: &mut impl TextSink,
    ) -> Result<bool> {
        if self.done {
            return Ok(true);
        }
        self.wire_bytes += bytes.len();
        if self.wire_bytes > WIRE_LIMIT {
            return Err(Failure::new("response_too_large"));
        }
        // Async HTTP chunks may exceed the pending-event bound; scan small slices.
        for bytes in bytes.chunks(8192) {
            self.pending.extend_from_slice(bytes);
            let mut consumed = 0;
            while self.scan < self.pending.len() {
                if self.pending[self.scan] == b'\n' {
                    let line = &self.pending[self.line_start..self.scan];
                    if line.is_empty() || line == b"\r" {
                        if self.scan + 1 - consumed > PENDING_LIMIT {
                            return Err(Failure::new("response_too_large"));
                        }
                        if event(&self.pending[consumed..self.line_start], state, frames)? {
                            self.done = true;
                            return Ok(true);
                        }
                        consumed = self.scan + 1;
                    }
                    self.line_start = self.scan + 1;
                }
                self.scan += 1;
            }
            if consumed > 0 {
                self.pending.drain(..consumed);
                self.scan -= consumed;
                self.line_start -= consumed;
            }
            if self.pending.len() > PENDING_LIMIT {
                return Err(Failure::new("response_too_large"));
            }
        }
        if eof {
            event(&self.pending, state, frames)?;
            self.done = true;
        }
        Ok(self.done)
    }
}

pub(super) fn stream(
    response: &mut Response,
    state: &mut State,
    frames: &mut impl TextSink,
) -> Result<()> {
    let mut sse = Sse::default();
    let mut chunk = [0; 8192];
    loop {
        let read = read_chunk(response, &mut chunk)?;
        if sse.feed(&chunk[..read], read == 0, state, frames)? {
            return Ok(());
        }
    }
}
