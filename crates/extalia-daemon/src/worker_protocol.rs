//! Probe-only worker data protocol. Parsing never establishes readiness or authority.

use serde_json::{Map, Value, json};

/// Includes the terminating LF and an optional preceding CR.
pub const MAX_FRAME_BYTES: usize = 65_536;
pub const MAX_FRAMES_PER_PUSH: usize = 64;
pub const MAX_DEADLINE_MS: u64 = 300_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    InvalidRequest,
    UnsupportedOperation,
    Cancelled,
    Unavailable,
    InternalError,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::UnsupportedOperation => "unsupported_operation",
            Self::Cancelled => "cancelled",
            Self::Unavailable => "unavailable",
            Self::InternalError => "internal_error",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "invalid_request" => Self::InvalidRequest,
            "unsupported_operation" => Self::UnsupportedOperation,
            "cancelled" => Self::Cancelled,
            "unavailable" => Self::Unavailable,
            "internal_error" => Self::InternalError,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Frame {
    Hello {
        worker_version: String,
    },
    Request {
        request_id: String,
        deadline_ms: u64,
    },
    Cancel {
        request_id: String,
    },
    Response {
        request_id: String,
        worker_version: String,
    },
    Error {
        request_id: String,
        code: ErrorCode,
    },
}

impl Frame {
    /// A claim's JSON representation; use `encode` to validate before transmission.
    pub fn to_value(&self) -> Value {
        match self {
            Self::Hello { worker_version } => {
                json!({"schema_version":1,"kind":"hello","worker_version":worker_version,"operations":["health"]})
            }
            Self::Request {
                request_id,
                deadline_ms,
            } => {
                json!({"schema_version":1,"kind":"request","request_id":request_id,"operation":"health","deadline_ms":deadline_ms,"payload":{}})
            }
            Self::Cancel { request_id } => {
                json!({"schema_version":1,"kind":"cancel","request_id":request_id})
            }
            Self::Response {
                request_id,
                worker_version,
            } => {
                json!({"schema_version":1,"kind":"response","request_id":request_id,"result":{"status":"ok","worker_version":worker_version}})
            }
            Self::Error { request_id, code } => {
                json!({"schema_version":1,"kind":"error","request_id":request_id,"error":{"code":code.as_str()}})
            }
        }
    }

    pub(crate) fn valid(&self) -> bool {
        match self {
            Self::Hello { worker_version } => valid_version(worker_version),
            Self::Request {
                request_id,
                deadline_ms,
            } => valid_request_id(request_id) && (1..=MAX_DEADLINE_MS).contains(deadline_ms),
            Self::Cancel { request_id } | Self::Error { request_id, .. } => {
                valid_request_id(request_id)
            }
            Self::Response {
                request_id,
                worker_version,
            } => valid_request_id(request_id) && valid_version(worker_version),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeError {
    InvalidFrame,
    Oversize,
    TooManyFrames,
    Truncated,
    Closed,
}

pub(crate) fn valid_version(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=128).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || b".+_-".contains(b))
}

pub(crate) fn valid_request_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                *b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(b)
            }
        })
        && (b'1'..=b'8').contains(&bytes[14])
        && b"89ab".contains(&bytes[19])
}

fn object<'a>(value: &'a Value, keys: &[&str]) -> Result<&'a Map<String, Value>, DecodeError> {
    let map = value.as_object().ok_or(DecodeError::InvalidFrame)?;
    // Bound keys before inspecting values or copying anything from an input Value.
    if map.len() != keys.len()
        || map
            .keys()
            .any(|key| key.len() > 32 || !keys.contains(&key.as_str()))
    {
        return Err(DecodeError::InvalidFrame);
    }
    Ok(map)
}

fn string<'a>(map: &'a Map<String, Value>, key: &str) -> Result<&'a str, DecodeError> {
    map.get(key)
        .and_then(Value::as_str)
        .ok_or(DecodeError::InvalidFrame)
}

fn request_id(map: &Map<String, Value>) -> Result<String, DecodeError> {
    let value = string(map, "request_id")?;
    if !valid_request_id(value) {
        return Err(DecodeError::InvalidFrame);
    }
    Ok(value.to_owned())
}

fn version(map: &Map<String, Value>) -> Result<String, DecodeError> {
    let value = string(map, "worker_version")?;
    if !valid_version(value) {
        return Err(DecodeError::InvalidFrame);
    }
    Ok(value.to_owned())
}

pub fn parse_frame(value: &Value) -> Result<Frame, DecodeError> {
    let root = value.as_object().ok_or(DecodeError::InvalidFrame)?;
    if root.len() > 6 || root.keys().any(|key| key.len() > 32) {
        return Err(DecodeError::InvalidFrame);
    }
    if root.get("schema_version").and_then(Value::as_f64) != Some(1.0) {
        return Err(DecodeError::InvalidFrame);
    }
    match string(root, "kind")? {
        "hello" => {
            let root = object(
                value,
                &["schema_version", "kind", "worker_version", "operations"],
            )?;
            let operations = root["operations"]
                .as_array()
                .ok_or(DecodeError::InvalidFrame)?;
            if operations.len() != 1 || operations[0].as_str() != Some("health") {
                return Err(DecodeError::InvalidFrame);
            }
            Ok(Frame::Hello {
                worker_version: version(root)?,
            })
        }
        "request" => {
            let root = object(
                value,
                &[
                    "schema_version",
                    "kind",
                    "request_id",
                    "operation",
                    "deadline_ms",
                    "payload",
                ],
            )?;
            if string(root, "operation")? != "health" {
                return Err(DecodeError::InvalidFrame);
            }
            object(&root["payload"], &[])?;
            // JSON Schema integers are semantic numbers, including 50.0 / 5e1.
            let deadline_ms = root["deadline_ms"]
                .as_f64()
                .filter(|v| {
                    v.is_finite() && v.fract() == 0.0 && (1.0..=MAX_DEADLINE_MS as f64).contains(v)
                })
                .ok_or(DecodeError::InvalidFrame)?;
            Ok(Frame::Request {
                request_id: request_id(root)?,
                deadline_ms: deadline_ms as u64,
            })
        }
        "cancel" => {
            let root = object(value, &["schema_version", "kind", "request_id"])?;
            Ok(Frame::Cancel {
                request_id: request_id(root)?,
            })
        }
        "response" => {
            let root = object(value, &["schema_version", "kind", "request_id", "result"])?;
            let result = object(&root["result"], &["status", "worker_version"])?;
            if string(result, "status")? != "ok" {
                return Err(DecodeError::InvalidFrame);
            }
            Ok(Frame::Response {
                request_id: request_id(root)?,
                worker_version: version(result)?,
            })
        }
        "error" => {
            let root = object(value, &["schema_version", "kind", "request_id", "error"])?;
            let error = object(&root["error"], &["code"])?;
            let code = ErrorCode::parse(string(error, "code")?).ok_or(DecodeError::InvalidFrame)?;
            Ok(Frame::Error {
                request_id: request_id(root)?,
                code,
            })
        }
        _ => Err(DecodeError::InvalidFrame),
    }
}

pub fn encode(frame: &Frame) -> Result<Vec<u8>, DecodeError> {
    // Validate before to_value clones any strings supplied by a caller.
    if !frame.valid() {
        return Err(DecodeError::InvalidFrame);
    }
    let mut bytes = serde_json::to_vec(&frame.to_value()).map_err(|_| DecodeError::InvalidFrame)?;
    if bytes.len() >= MAX_FRAME_BYTES {
        return Err(DecodeError::Oversize);
    }
    bytes.push(b'\n');
    Ok(bytes)
}

enum RawContainer {
    Object {
        keys: Vec<String>,
        expecting_key: bool,
    },
    Array,
}

/// Bound and validate a string token before asking serde_json to decode it.
fn raw_string(line: &[u8], start: usize) -> Result<(String, usize), DecodeError> {
    let mut index = start + 1;
    let mut characters = 0;
    while let Some(&byte) = line.get(index) {
        match byte {
            b'"' => {
                let decoded: String = serde_json::from_slice(&line[start..=index])
                    .map_err(|_| DecodeError::InvalidFrame)?;
                return Ok((decoded, index + 1));
            }
            b'\\' => {
                index += 1;
                match line.get(index).copied() {
                    Some(b'u') => {
                        let digits = line
                            .get(index + 1..index + 5)
                            .ok_or(DecodeError::InvalidFrame)?;
                        let mut code = 0_u16;
                        for digit in digits {
                            code = (code << 4)
                                | match digit {
                                    b'0'..=b'9' => (digit - b'0') as u16,
                                    b'a'..=b'f' => (digit - b'a' + 10) as u16,
                                    b'A'..=b'F' => (digit - b'A' + 10) as u16,
                                    _ => return Err(DecodeError::InvalidFrame),
                                };
                        }
                        if code > 0x7f {
                            return Err(DecodeError::InvalidFrame);
                        }
                        index += 4;
                    }
                    Some(b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't') => {}
                    _ => return Err(DecodeError::InvalidFrame),
                }
            }
            0x20..=0x7f => {}
            _ => return Err(DecodeError::InvalidFrame),
        }
        characters += 1;
        if characters > 128 {
            return Err(DecodeError::InvalidFrame);
        }
        index += 1;
    }
    Err(DecodeError::InvalidFrame)
}

/// Raw lexical limits apply before duplicate keys could be overwritten by a JSON
/// object decoder. The final serde_json parser still validates the full grammar.
fn validate_raw_json(line: &[u8]) -> Result<(), DecodeError> {
    let mut stack = Vec::with_capacity(2);
    let mut index = 0;
    while let Some(&byte) = line.get(index) {
        match byte {
            b'"' => {
                let (decoded, next) = raw_string(line, index)?;
                if let Some(RawContainer::Object {
                    keys,
                    expecting_key,
                }) = stack.last_mut()
                    && *expecting_key
                {
                    if decoded.len() > 32 || keys.len() >= 6 || keys.contains(&decoded) {
                        return Err(DecodeError::InvalidFrame);
                    }
                    keys.push(decoded);
                    *expecting_key = false;
                }
                index = next;
                continue;
            }
            b'{' | b'[' => {
                if stack.len() >= 2 {
                    return Err(DecodeError::InvalidFrame);
                }
                stack.push(if byte == b'{' {
                    RawContainer::Object {
                        keys: Vec::new(),
                        expecting_key: true,
                    }
                } else {
                    RawContainer::Array
                });
            }
            b'}' => {
                if !matches!(stack.pop(), Some(RawContainer::Object { .. })) {
                    return Err(DecodeError::InvalidFrame);
                }
            }
            b']' => {
                if !matches!(stack.pop(), Some(RawContainer::Array)) {
                    return Err(DecodeError::InvalidFrame);
                }
            }
            b',' => {
                if let Some(RawContainer::Object { expecting_key, .. }) = stack.last_mut() {
                    *expecting_key = true;
                }
            }
            b' '
            | b'\t'
            | b'\r'
            | b'\n'
            | b':'
            | b'-'
            | b'+'
            | b'.'
            | b'0'..=b'9'
            | b'e'
            | b'E'
            | b't'
            | b'r'
            | b'u'
            | b'f'
            | b'a'
            | b'l'
            | b's'
            | b'n' => {}
            _ => return Err(DecodeError::InvalidFrame),
        }
        index += 1;
    }
    if !stack.is_empty() {
        return Err(DecodeError::InvalidFrame);
    }
    Ok(())
}

/// One stream, incremental bounded buffering, atomic push results, terminal failures.
#[derive(Default)]
pub struct FrameReader {
    pending: Vec<u8>,
    closed: bool,
}

impl FrameReader {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Frame>, DecodeError> {
        if self.closed {
            return Err(DecodeError::Closed);
        }
        let result = self.push_open(bytes);
        if result.is_err() {
            self.closed = true;
            self.pending.clear();
        }
        result
    }

    fn push_open(&mut self, bytes: &[u8]) -> Result<Vec<Frame>, DecodeError> {
        let mut frames = Vec::new();
        for &byte in bytes {
            if byte == b'\n' {
                if frames.len() == MAX_FRAMES_PER_PUSH {
                    return Err(DecodeError::TooManyFrames);
                }
                let line = self.pending.strip_suffix(b"\r").unwrap_or(&self.pending);
                validate_raw_json(line)?;
                let value: Value =
                    serde_json::from_slice(line).map_err(|_| DecodeError::InvalidFrame)?;
                frames.push(parse_frame(&value)?);
                self.pending.clear();
            } else {
                // Reserve one byte for LF. No allocation scales with the input chunk.
                if self.pending.len() >= MAX_FRAME_BYTES - 1 {
                    return Err(DecodeError::Oversize);
                }
                self.pending.push(byte);
            }
        }
        Ok(frames)
    }

    pub fn finish(&mut self) -> Result<(), DecodeError> {
        if self.closed {
            return Err(DecodeError::Closed);
        }
        self.closed = true;
        if self.pending.is_empty() {
            Ok(())
        } else {
            self.pending.clear();
            Err(DecodeError::Truncated)
        }
    }
}
