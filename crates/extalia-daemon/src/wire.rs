//! Daemon wire contract v1 (ADR 0020), mirroring `@extalia/protocol` (`daemon.ts`,
//! `daemonValidate.ts`, `daemonFrame.ts`): an unsigned 32-bit big-endian payload length,
//! then that many bytes of UTF-8 JSON. The shared fixtures in
//! `packages/protocol/test/fixtures/daemon/` keep both sides' verdicts equal.
//!
//! Envelopes, error frames and every operation of contract v1 are validated completely; the
//! slice A operations (`mission.create`, `task.transition`, `event.commit`) use the core's
//! orchestration contract rules (`wire/missions.rs`) and the skill registry operations
//! (`skill.*`) are mapped in `wire/skills.rs` and the knowledge index operations
//! (`knowledge.*`) in `wire/knowledge.rs`. `Unvalidated` remains for operations a
//! newer contract defines before this daemon implements them; parsing never produces it
//! today. Rust's JSON parser is stricter than `JSON.parse` in one place: lone UTF-16
//! surrogate escapes are rejected.

mod knowledge;
mod missions;
mod skills;

pub use knowledge::{
    KnowledgeRequest, NodeTarget, SyncMode as KnowledgeSyncMode,
    is_history_author as is_knowledge_history_author, is_node_id as is_knowledge_node_id,
    is_vault_label as is_knowledge_vault_label, is_vault_path as is_knowledge_path,
    limits as knowledge_limits, validate_result as validate_knowledge_result,
};
pub use skills::{
    LIST_MAX_LIMIT as SKILL_LIST_MAX_LIMIT, READ_MAX_BYTES as SKILL_READ_MAX_BYTES, is_reason,
};
pub use skills::{ReviewDecision, SkillRequest};

use extalia_core::mission::{
    AgentEvent, EventAck, MissionAck, MissionCreate, MissionSnapshot, TaskTransition, TransitionAck,
};
use extalia_core::security::permissions::{
    Decision, PermissionMode, SessionPermissionMode, ToolAccess, WorkspacePermissions,
};
use serde_json::{Map, Value};

pub const SCHEMA_VERSION: u64 = 1;
/// Largest JSON payload of one frame in bytes, excluding the length prefix.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const HEADER_BYTES: usize = 4;
/// Upper bound of a request's relative deadline.
pub const MAX_DEADLINE_MS: u64 = 10 * 60_000;
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

macro_rules! names {
    ($(#[$meta:meta])* $name:ident { $($variant:ident = $text:literal,)+ }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum $name { $($variant,)+ }

        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant,)+];

            pub fn as_str(self) -> &'static str {
                match self { $($name::$variant => $text,)+ }
            }

            pub fn parse(text: &str) -> Option<Self> {
                match text { $($text => Some($name::$variant),)+ _ => None }
            }
        }
    };
}

names!(
    /// Operations defined by contract v1.
    Op {
        Hello = "hello",
        MissionCreate = "mission.create",
        MissionSnapshot = "mission.snapshot",
        TaskTransition = "task.transition",
        EventCommit = "event.commit",
        PermissionCheck = "permission.check",
        Health = "health",
        SkillImport = "skill.import",
        SkillList = "skill.list",
        SkillInspect = "skill.inspect",
        SkillReview = "skill.review",
        SkillApprove = "skill.approve",
        SkillActivate = "skill.activate",
        SkillDeactivate = "skill.deactivate",
        SkillRollback = "skill.rollback",
        SkillRevoke = "skill.revoke",
        SkillRead = "skill.read",
        SkillScanner = "skill.scanner",
        KnowledgeStatus = "knowledge.status",
        KnowledgeSync = "knowledge.sync",
        KnowledgeNode = "knowledge.node",
        KnowledgeLinks = "knowledge.links",
        KnowledgeBacklinks = "knowledge.backlinks",
        KnowledgeSearch = "knowledge.search",
        KnowledgeGraph = "knowledge.graph",
        KnowledgeOverview = "knowledge.overview",
        KnowledgeRead = "knowledge.read",
        KnowledgeWrite = "knowledge.write",
        KnowledgeHistory = "knowledge.history",
        KnowledgeRollback = "knowledge.rollback",
        KnowledgeImportMemory = "knowledge.importMemory",
    }
);

names!(
    /// Stable error codes; see `DAEMON_ERROR_CODES` in `daemon.ts` for their meaning.
    ErrorCode {
        InvalidFrame = "invalid_frame",
        FrameTooLarge = "frame_too_large",
        UnsupportedSchemaVersion = "unsupported_schema_version",
        HandshakeRequired = "handshake_required",
        UnknownOp = "unknown_op",
        InvalidRequest = "invalid_request",
        NotFound = "not_found",
        Conflict = "conflict",
        CapacityExceeded = "capacity_exceeded",
        StorageFailure = "storage_failure",
        DeadlineExceeded = "deadline_exceeded",
        ShuttingDown = "shutting_down",
        Internal = "internal",
        Denied = "denied",
        IntegrityFailure = "integrity_failure",
    }
);

names!(
    HealthStatus {
        Ok = "ok",
        Degraded = "degraded",
    }
);

#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Request(Request),
    Response(Response),
    Error(ErrorFrame),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub request_id: String,
    /// Relative budget in milliseconds.
    pub deadline_ms: Option<u64>,
    pub params: RequestParams,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RequestParams {
    Hello {
        client_version: String,
        capabilities: Vec<Op>,
    },
    Health,
    PermissionCheck(PermissionCheck),
    MissionCreate(MissionCreate),
    MissionSnapshot {
        mission_id: String,
    },
    TaskTransition(TaskTransition),
    /// A mission control event (`missionId` required).
    EventCommit(AgentEvent),
    /// A skill registry operation (`skill.*`).
    Skill(SkillRequest),
    /// A knowledge index operation (`knowledge.*`).
    Knowledge(KnowledgeRequest),
    /// A defined operation whose parameters this daemon does not inspect yet.
    Unvalidated {
        op: Op,
        params: Value,
    },
}

/// `permission.check` parameters: the inputs of `decide()` (ADR 0026).
#[derive(Debug, Clone, PartialEq)]
pub struct PermissionCheck {
    pub access: ToolAccess,
    pub mode: SessionPermissionMode,
    pub workspace_permissions: WorkspacePermissions,
    /// Unique; kept in wire order so the frame round-trips exactly.
    pub session_grants: Vec<ToolAccess>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Response {
    pub request_id: String,
    pub result: ResponseResult,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ResponseResult {
    Hello {
        daemon_version: String,
        capabilities: Vec<Op>,
        max_frame_bytes: u64,
    },
    Health {
        status: HealthStatus,
        uptime_ms: u64,
    },
    PermissionCheck {
        decision: Decision,
    },
    MissionCreate(MissionAck),
    MissionSnapshot(MissionSnapshot),
    TaskTransition(TransitionAck),
    EventCommit(EventAck),
    /// A skill registry result, validated field by field and kept as that JSON (only the
    /// daemon produces these).
    Skill {
        op: Op,
        result: Value,
    },
    /// A knowledge index result, validated field by field and kept as that JSON.
    Knowledge {
        op: Op,
        result: Value,
    },
    /// A defined operation whose result this daemon does not inspect yet.
    Unvalidated {
        op: Op,
        result: Value,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ErrorFrame {
    /// Absent only when the failing frame could not be correlated.
    pub request_id: Option<String>,
    pub code: ErrorCode,
    /// Generic and sanitized: never raw storage errors, paths or parameters.
    pub message: Option<String>,
    /// Stable refusal code (`SKILL_REASON_PATTERN`); skill and knowledge operations only.
    pub reason: Option<String>,
}

/// A rejected frame: stable code, the frame's request ID when it named a valid one,
/// diagnostics (never sent on the wire) and whether the stream can continue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejection {
    pub code: ErrorCode,
    pub request_id: Option<String>,
    pub errors: Vec<String>,
    pub fatal: bool,
}

impl RequestParams {
    pub fn op(&self) -> Op {
        match self {
            Self::Hello { .. } => Op::Hello,
            Self::Health => Op::Health,
            Self::PermissionCheck(_) => Op::PermissionCheck,
            Self::MissionCreate(_) => Op::MissionCreate,
            Self::MissionSnapshot { .. } => Op::MissionSnapshot,
            Self::TaskTransition(_) => Op::TaskTransition,
            Self::EventCommit(_) => Op::EventCommit,
            Self::Skill(request) => request.op(),
            Self::Knowledge(request) => request.op(),
            Self::Unvalidated { op, .. } => *op,
        }
    }
}

impl ResponseResult {
    pub fn op(&self) -> Op {
        match self {
            Self::Hello { .. } => Op::Hello,
            Self::Health { .. } => Op::Health,
            Self::PermissionCheck { .. } => Op::PermissionCheck,
            Self::MissionCreate(_) => Op::MissionCreate,
            Self::MissionSnapshot(_) => Op::MissionSnapshot,
            Self::TaskTransition(_) => Op::TaskTransition,
            Self::EventCommit(_) => Op::EventCommit,
            Self::Skill { op, .. } => *op,
            Self::Knowledge { op, .. } => *op,
            Self::Unvalidated { op, .. } => *op,
        }
    }
}

impl Frame {
    /// False when the frame carries parameters or a result this daemon did not validate.
    pub fn fully_validated(&self) -> bool {
        !matches!(
            self,
            Frame::Request(Request {
                params: RequestParams::Unvalidated { .. },
                ..
            }) | Frame::Response(Response {
                result: ResponseResult::Unvalidated { .. },
                ..
            })
        )
    }

    /// The frame as JSON with the contract's camelCase field names.
    pub fn to_value(&self) -> Value {
        let mut frame = Map::new();
        frame.insert("schemaVersion".into(), SCHEMA_VERSION.into());
        match self {
            Frame::Request(request) => {
                frame.insert("kind".into(), "request".into());
                frame.insert("requestId".into(), request.request_id.clone().into());
                frame.insert("op".into(), request.params.op().as_str().into());
                if let Some(deadline) = request.deadline_ms {
                    frame.insert("deadlineMs".into(), deadline.into());
                }
                let params = match &request.params {
                    RequestParams::Hello {
                        client_version,
                        capabilities,
                    } => object([
                        ("clientVersion", client_version.clone().into()),
                        ("capabilities", ops(capabilities)),
                    ]),
                    RequestParams::Health => Value::Object(Map::new()),
                    RequestParams::PermissionCheck(check) => object([
                        ("access", check.access.as_str().into()),
                        ("mode", check.mode.as_str().into()),
                        (
                            "workspacePermissions",
                            object([
                                (
                                    "fileWrite",
                                    check.workspace_permissions.file_write.as_str().into(),
                                ),
                                (
                                    "commands",
                                    check.workspace_permissions.commands.as_str().into(),
                                ),
                            ]),
                        ),
                        (
                            "sessionGrants",
                            check
                                .session_grants
                                .iter()
                                .map(|access| Value::from(access.as_str()))
                                .collect(),
                        ),
                    ]),
                    RequestParams::MissionCreate(params) => params.to_value(),
                    RequestParams::MissionSnapshot { mission_id } => {
                        object([("missionId", mission_id.clone().into())])
                    }
                    RequestParams::TaskTransition(params) => params.to_value(),
                    RequestParams::EventCommit(event) => missions::event_commit_params(event),
                    RequestParams::Skill(request) => request.to_value(),
                    RequestParams::Knowledge(request) => request.to_value(),
                    RequestParams::Unvalidated { params, .. } => params.clone(),
                };
                frame.insert("params".into(), params);
            }
            Frame::Response(response) => {
                frame.insert("kind".into(), "response".into());
                frame.insert("requestId".into(), response.request_id.clone().into());
                frame.insert("op".into(), response.result.op().as_str().into());
                let result = match &response.result {
                    ResponseResult::Hello {
                        daemon_version,
                        capabilities,
                        max_frame_bytes,
                    } => object([
                        ("daemonVersion", daemon_version.clone().into()),
                        ("capabilities", ops(capabilities)),
                        ("maxFrameBytes", (*max_frame_bytes).into()),
                    ]),
                    ResponseResult::Health { status, uptime_ms } => object([
                        ("status", status.as_str().into()),
                        ("uptimeMs", (*uptime_ms).into()),
                    ]),
                    ResponseResult::PermissionCheck { decision } => {
                        object([("decision", decision.as_str().into())])
                    }
                    ResponseResult::MissionCreate(ack) => missions::mission_ack_value(ack),
                    ResponseResult::MissionSnapshot(snapshot) => snapshot.to_value(),
                    ResponseResult::TaskTransition(ack) => missions::transition_ack_value(ack),
                    ResponseResult::EventCommit(ack) => missions::event_ack_value(ack),
                    ResponseResult::Skill { result, .. } => result.clone(),
                    ResponseResult::Knowledge { result, .. } => result.clone(),
                    ResponseResult::Unvalidated { result, .. } => result.clone(),
                };
                frame.insert("result".into(), result);
            }
            Frame::Error(error) => {
                frame.insert("kind".into(), "error".into());
                if let Some(id) = &error.request_id {
                    frame.insert("requestId".into(), id.clone().into());
                }
                let mut body = Map::new();
                body.insert("code".into(), error.code.as_str().into());
                if let Some(message) = &error.message {
                    body.insert("message".into(), message.clone().into());
                }
                if let Some(reason) = &error.reason {
                    body.insert("reason".into(), reason.clone().into());
                }
                frame.insert("error".into(), Value::Object(body));
            }
        }
        Value::Object(frame)
    }
}

fn object<const N: usize>(fields: [(&str, Value); N]) -> Value {
    Value::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
}

fn ops(list: &[Op]) -> Value {
    list.iter().map(|op| Value::from(op.as_str())).collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncodeError {
    /// The frame would not pass validation; the daemon never emits such a frame.
    Invalid(ErrorCode),
    TooLarge(usize),
}

/// Validate and encode one frame with its length prefix.
pub fn encode(frame: &Frame) -> Result<Vec<u8>, EncodeError> {
    let value = frame.to_value();
    if let Err(rejection) = parse_frame(&value) {
        return Err(EncodeError::Invalid(rejection.code));
    }
    let payload =
        serde_json::to_vec(&value).map_err(|_| EncodeError::Invalid(ErrorCode::Internal))?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err(EncodeError::TooLarge(payload.len()));
    }
    let length = u32::try_from(payload.len()).map_err(|_| EncodeError::TooLarge(payload.len()))?;
    let mut bytes = Vec::with_capacity(HEADER_BYTES + payload.len());
    bytes.extend_from_slice(&length.to_be_bytes());
    bytes.extend_from_slice(&payload);
    Ok(bytes)
}

/// Decode and validate one payload (without its length prefix). Never fatal.
pub fn decode_payload(payload: &[u8]) -> Result<Frame, Rejection> {
    match serde_json::from_slice::<Value>(payload) {
        Ok(raw) => parse_frame(&raw),
        Err(_) => Err(Rejection {
            code: ErrorCode::InvalidFrame,
            request_id: None,
            errors: vec!["Frame payload is not UTF-8 JSON.".into()],
            fatal: false,
        }),
    }
}

/// Incremental reader for a byte stream. A malformed payload is reported and skipped,
/// since its length is known; a declared length above the limit is fatal and latches.
#[derive(Debug)]
pub struct FrameReader {
    limit: usize,
    buffer: Vec<u8>,
    failure: Option<Rejection>,
}

impl FrameReader {
    /// `limit` must be between 1 and [`MAX_FRAME_BYTES`].
    pub fn new(limit: usize) -> Self {
        assert!(
            (1..=MAX_FRAME_BYTES).contains(&limit),
            "frame limit must be between 1 and {MAX_FRAME_BYTES}"
        );
        Self {
            limit,
            buffer: Vec::new(),
            failure: None,
        }
    }

    /// Bytes buffered for an incomplete frame.
    pub fn pending(&self) -> usize {
        self.buffer.len()
    }

    /// True after a fatal framing error; every later push repeats it.
    pub fn failed(&self) -> bool {
        self.failure.is_some()
    }

    /// Append received bytes; returns every frame completed by them, in order.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<Result<Frame, Rejection>> {
        if let Some(failure) = &self.failure {
            return vec![Err(failure.clone())];
        }
        self.buffer.extend_from_slice(chunk);
        let mut results = Vec::new();
        let mut offset = 0;
        while self.buffer.len() - offset >= HEADER_BYTES {
            let header: [u8; HEADER_BYTES] = self.buffer[offset..offset + HEADER_BYTES]
                .try_into()
                .expect("header slice has the header length");
            let length = u32::from_be_bytes(header) as usize;
            if length > self.limit {
                let failure = Rejection {
                    code: ErrorCode::FrameTooLarge,
                    request_id: None,
                    errors: vec![format!(
                        "Frame length {length} exceeds {} bytes.",
                        self.limit
                    )],
                    fatal: true,
                };
                self.failure = Some(failure.clone());
                self.buffer = Vec::new();
                results.push(Err(failure));
                return results;
            }
            let start = offset + HEADER_BYTES;
            if self.buffer.len() - start < length {
                break;
            }
            results.push(if length == 0 {
                Err(Rejection {
                    code: ErrorCode::InvalidFrame,
                    request_id: None,
                    errors: vec!["Frame payload is empty.".into()],
                    fatal: false,
                })
            } else {
                decode_payload(&self.buffer[start..start + length])
            });
            offset = start + length;
        }
        self.buffer.drain(..offset);
        results
    }
}

/// Validate one decoded frame, in the same order and with the same codes as
/// `parseDaemonFrame`. Success does not authorize the operation.
pub fn parse_frame(raw: &Value) -> Result<Frame, Rejection> {
    let request_id = raw
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|id| is_uuid(id))
        .map(str::to_owned);
    let reject = |code, errors: Vec<String>| {
        Err(Rejection {
            code,
            request_id: request_id.clone(),
            errors,
            fatal: false,
        })
    };
    let Some(object) = raw.as_object() else {
        return reject(
            ErrorCode::InvalidFrame,
            vec!["frame: expected a plain object.".into()],
        );
    };
    let Some(version) = object.get("schemaVersion").and_then(safe_integer) else {
        return reject(
            ErrorCode::InvalidFrame,
            vec!["frame.schemaVersion: expected an integer.".into()],
        );
    };
    if version != SCHEMA_VERSION as i64 {
        let relation = if version > SCHEMA_VERSION as i64 {
            "newer"
        } else {
            "older"
        };
        return reject(
            ErrorCode::UnsupportedSchemaVersion,
            vec![format!(
                "frame.schemaVersion: {relation} than supported version {SCHEMA_VERSION}."
            )],
        );
    }
    let mut check = Check::default();
    let kind = object.get("kind").and_then(Value::as_str);
    let frame = match kind {
        Some("error") => error_frame(&mut check, object),
        Some(kind @ ("request" | "response")) => {
            let Some(name) = object.get("op").and_then(Value::as_str) else {
                return reject(
                    ErrorCode::InvalidFrame,
                    vec!["frame.op: required operation name.".into()],
                );
            };
            let Some(op) = Op::parse(name) else {
                return reject(
                    ErrorCode::UnknownOp,
                    vec![format!("frame.op: unknown operation {name:?}.")],
                );
            };
            if kind == "request" {
                request(&mut check, object, op)
            } else {
                response(&mut check, object, op)
            }
        }
        _ => {
            return reject(
                ErrorCode::InvalidFrame,
                vec!["frame.kind: expected one of request, response, error.".into()],
            );
        }
    };
    match frame {
        Some(frame) if check.errors.is_empty() => Ok(frame),
        _ => {
            if check.errors.is_empty() {
                check.errors.push("frame: invalid.".into());
            }
            let params_only = check.errors.iter().all(|error| {
                error
                    .strip_prefix("frame.params")
                    .is_some_and(|rest| rest.starts_with(['.', ':', '[']))
            });
            let code = if kind == Some("request") && params_only {
                ErrorCode::InvalidRequest
            } else {
                ErrorCode::InvalidFrame
            };
            reject(code, check.errors)
        }
    }
}

fn request(check: &mut Check, object: &Map<String, Value>, op: Op) -> Option<Frame> {
    check.fields(
        object,
        "frame",
        &["schemaVersion", "kind", "requestId", "op", "params"],
        &["deadlineMs"],
    );
    let request_id = check.uuid(object.get("requestId"), "frame.requestId");
    let deadline_ms = match object.get("deadlineMs") {
        None => Some(None),
        Some(value) => check
            .integer(value, "frame.deadlineMs", 1, MAX_DEADLINE_MS)
            .map(Some),
    };
    let params = object.get("params").and_then(|params| match op {
        Op::Hello => {
            let fields = check.object(
                params,
                "frame.params",
                &["clientVersion", "capabilities"],
                &[],
            )?;
            let client_version = check.text(
                fields.get("clientVersion"),
                "frame.params.clientVersion",
                64,
            );
            let capabilities = check.ops(fields.get("capabilities"), "frame.params.capabilities");
            Some(RequestParams::Hello {
                client_version: client_version?,
                capabilities: capabilities?,
            })
        }
        Op::Health => check
            .object(params, "frame.params", &[], &[])
            .map(|_| RequestParams::Health),
        Op::PermissionCheck => permission_check(check, params).map(RequestParams::PermissionCheck),
        Op::MissionCreate => missions::mission_create(check, params),
        Op::MissionSnapshot => missions::mission_snapshot(check, params),
        Op::TaskTransition => missions::task_transition(check, params),
        Op::EventCommit => missions::event_commit(check, params),
        Op::SkillImport
        | Op::SkillList
        | Op::SkillInspect
        | Op::SkillReview
        | Op::SkillApprove
        | Op::SkillActivate
        | Op::SkillDeactivate
        | Op::SkillRollback
        | Op::SkillRevoke
        | Op::SkillRead
        | Op::SkillScanner => skills::request(check, op, params),
        Op::KnowledgeStatus
        | Op::KnowledgeSync
        | Op::KnowledgeNode
        | Op::KnowledgeLinks
        | Op::KnowledgeBacklinks
        | Op::KnowledgeSearch
        | Op::KnowledgeGraph
        | Op::KnowledgeOverview
        | Op::KnowledgeRead
        | Op::KnowledgeWrite
        | Op::KnowledgeHistory
        | Op::KnowledgeRollback
        | Op::KnowledgeImportMemory => knowledge::request(check, op, params),
    });
    Some(Frame::Request(Request {
        request_id: request_id?,
        deadline_ms: deadline_ms?,
        params: params?,
    }))
}

fn response(check: &mut Check, object: &Map<String, Value>, op: Op) -> Option<Frame> {
    check.fields(
        object,
        "frame",
        &["schemaVersion", "kind", "requestId", "op", "result"],
        &[],
    );
    let request_id = check.uuid(object.get("requestId"), "frame.requestId");
    let result = object.get("result").and_then(|result| match op {
        Op::Hello => {
            let fields = check.object(
                result,
                "frame.result",
                &["daemonVersion", "capabilities", "maxFrameBytes"],
                &[],
            )?;
            let daemon_version = check.text(
                fields.get("daemonVersion"),
                "frame.result.daemonVersion",
                64,
            );
            let capabilities = check.ops(fields.get("capabilities"), "frame.result.capabilities");
            let max_frame_bytes = fields.get("maxFrameBytes").and_then(|value| {
                check.integer(
                    value,
                    "frame.result.maxFrameBytes",
                    1,
                    MAX_FRAME_BYTES as u64,
                )
            });
            Some(ResponseResult::Hello {
                daemon_version: daemon_version?,
                capabilities: capabilities?,
                max_frame_bytes: max_frame_bytes?,
            })
        }
        Op::Health => {
            let fields = check.object(result, "frame.result", &["status", "uptimeMs"], &[])?;
            let status = check.name(
                fields.get("status"),
                "frame.result.status",
                HealthStatus::parse,
            );
            let uptime_ms = fields.get("uptimeMs").and_then(|value| {
                check.integer(value, "frame.result.uptimeMs", 0, MAX_SAFE_INTEGER)
            });
            Some(ResponseResult::Health {
                status: status?,
                uptime_ms: uptime_ms?,
            })
        }
        Op::PermissionCheck => {
            let fields = check.object(result, "frame.result", &["decision"], &[])?;
            let decision = check.name(
                fields.get("decision"),
                "frame.result.decision",
                Decision::parse,
            );
            Some(ResponseResult::PermissionCheck {
                decision: decision?,
            })
        }
        Op::MissionCreate => missions::mission_create_result(check, result),
        Op::MissionSnapshot => missions::mission_snapshot_result(check, result),
        Op::TaskTransition => missions::task_transition_result(check, result),
        Op::EventCommit => missions::event_commit_result(check, result),
        Op::SkillImport
        | Op::SkillList
        | Op::SkillInspect
        | Op::SkillReview
        | Op::SkillApprove
        | Op::SkillActivate
        | Op::SkillDeactivate
        | Op::SkillRollback
        | Op::SkillRevoke
        | Op::SkillRead
        | Op::SkillScanner => skills::result(check, op, result),
        Op::KnowledgeStatus
        | Op::KnowledgeSync
        | Op::KnowledgeNode
        | Op::KnowledgeLinks
        | Op::KnowledgeBacklinks
        | Op::KnowledgeSearch
        | Op::KnowledgeGraph
        | Op::KnowledgeOverview
        | Op::KnowledgeRead
        | Op::KnowledgeWrite
        | Op::KnowledgeHistory
        | Op::KnowledgeRollback
        | Op::KnowledgeImportMemory => knowledge::result(check, op, result),
    });
    Some(Frame::Response(Response {
        request_id: request_id?,
        result: result?,
    }))
}

fn permission_check(check: &mut Check, params: &Value) -> Option<PermissionCheck> {
    let fields = check.object(
        params,
        "frame.params",
        &["access", "mode", "workspacePermissions", "sessionGrants"],
        &[],
    )?;
    let access = check.name(
        fields.get("access"),
        "frame.params.access",
        ToolAccess::parse,
    );
    let mode = check.name(
        fields.get("mode"),
        "frame.params.mode",
        SessionPermissionMode::parse,
    );
    let workspace_permissions = fields.get("workspacePermissions").and_then(|value| {
        let path = "frame.params.workspacePermissions";
        let policy = check.object(value, path, &["fileWrite", "commands"], &[])?;
        let file_write = check.name(
            policy.get("fileWrite"),
            &format!("{path}.fileWrite"),
            PermissionMode::parse,
        );
        let commands = check.name(
            policy.get("commands"),
            &format!("{path}.commands"),
            PermissionMode::parse,
        );
        Some(WorkspacePermissions {
            file_write: file_write?,
            commands: commands?,
        })
    });
    let session_grants = check.unique_names(
        fields.get("sessionGrants"),
        "frame.params.sessionGrants",
        0,
        ToolAccess::ALL.len(),
        ToolAccess::parse,
    );
    Some(PermissionCheck {
        access: access?,
        mode: mode?,
        workspace_permissions: workspace_permissions?,
        session_grants: session_grants?,
    })
}

fn error_frame(check: &mut Check, object: &Map<String, Value>) -> Option<Frame> {
    check.fields(
        object,
        "frame",
        &["schemaVersion", "kind", "error"],
        &["requestId"],
    );
    let request_id = match object.get("requestId") {
        None => Some(None),
        Some(id) => check.uuid(Some(id), "frame.requestId").map(Some),
    };
    let body = object.get("error").and_then(|error| {
        let fields = check.object(error, "frame.error", &["code"], &["message", "reason"])?;
        let code = check.name(fields.get("code"), "frame.error.code", ErrorCode::parse);
        let message = match fields.get("message") {
            None => Some(None),
            Some(message) => check
                .text(Some(message), "frame.error.message", 500)
                .map(Some),
        };
        let reason = match fields.get("reason") {
            None => Some(None),
            Some(reason) => match reason.as_str().filter(|text| is_reason(text)) {
                Some(text) => Some(Some(text.to_owned())),
                None => {
                    check.fail("frame.error.reason", "expected a reason code");
                    None
                }
            },
        };
        Some((code?, message?, reason?))
    });
    let (code, message, reason) = body?;
    Some(Frame::Error(ErrorFrame {
        request_id: request_id?,
        code,
        message,
        reason,
    }))
}

/// Accumulates failures as `<path>: <message>.`, like the TypeScript rules. A field check
/// given `None` reports nothing: missing required fields are reported by [`Check::fields`].
#[derive(Default)]
struct Check {
    errors: Vec<String>,
}

impl Check {
    fn fail(&mut self, path: &str, message: &str) {
        self.errors.push(format!("{path}: {message}."));
    }

    /// Unknown fields and missing required fields of an object.
    fn fields(
        &mut self,
        object: &Map<String, Value>,
        path: &str,
        required: &[&str],
        optional: &[&str],
    ) {
        for key in object.keys() {
            if !required.contains(&key.as_str()) && !optional.contains(&key.as_str()) {
                self.fail(&format!("{path}.{key}"), "unknown field");
            }
        }
        for key in required {
            if !object.contains_key(*key) {
                self.fail(&format!("{path}.{key}"), "required field");
            }
        }
    }

    fn object<'a>(
        &mut self,
        value: &'a Value,
        path: &str,
        required: &[&str],
        optional: &[&str],
    ) -> Option<&'a Map<String, Value>> {
        let Some(object) = value.as_object() else {
            self.fail(path, "expected a plain object");
            return None;
        };
        self.fields(object, path, required, optional);
        Some(object)
    }

    fn uuid(&mut self, value: Option<&Value>, path: &str) -> Option<String> {
        let value = value?;
        match value.as_str() {
            Some(id) if is_uuid(id) => Some(id.to_owned()),
            _ => {
                self.fail(path, "expected a lowercase UUID");
                None
            }
        }
    }

    fn text(&mut self, value: Option<&Value>, path: &str, max: usize) -> Option<String> {
        let value = value?;
        match value.as_str() {
            Some(text) if is_text(text, max) => Some(text.to_owned()),
            _ => {
                self.fail(
                    path,
                    &format!("expected nonempty single-line text of at most {max} characters"),
                );
                None
            }
        }
    }

    fn integer(&mut self, value: &Value, path: &str, min: u64, max: u64) -> Option<u64> {
        match safe_integer(value).and_then(|number| u64::try_from(number).ok()) {
            Some(number) if (min..=max).contains(&number) => Some(number),
            _ => {
                self.fail(
                    path,
                    &format!("expected a safe integer between {min} and {max}"),
                );
                None
            }
        }
    }

    fn name<T>(
        &mut self,
        value: Option<&Value>,
        path: &str,
        parse: fn(&str) -> Option<T>,
    ) -> Option<T> {
        let value = value?;
        let parsed = value.as_str().and_then(parse);
        if parsed.is_none() {
            self.fail(path, "expected one of the defined values");
        }
        parsed
    }

    /// A unique list of 1 to `Op::ALL.len()` operation names.
    fn ops(&mut self, value: Option<&Value>, path: &str) -> Option<Vec<Op>> {
        self.unique_names(value, path, 1, Op::ALL.len(), Op::parse)
    }

    /// A unique list of `min` to `max` defined names (the `array(rule, true, min, max)` rule).
    fn unique_names<T>(
        &mut self,
        value: Option<&Value>,
        path: &str,
        min: usize,
        max: usize,
        parse: fn(&str) -> Option<T>,
    ) -> Option<Vec<T>> {
        let value = value?;
        let Some(items) = value
            .as_array()
            .filter(|items| (min..=max).contains(&items.len()))
        else {
            self.fail(
                path,
                &format!("expected an array with {min} to {max} items"),
            );
            return None;
        };
        // Same as `new Set(items)`: primitives compare by value, objects and arrays never do.
        let duplicate = items.iter().enumerate().any(|(index, item)| {
            !item.is_object() && !item.is_array() && items[..index].contains(item)
        });
        if duplicate {
            self.fail(path, "duplicate values");
        }
        let mut parsed = Vec::with_capacity(items.len());
        for (index, item) in items.iter().enumerate() {
            parsed.push(self.name(Some(item), &format!("{path}[{index}]"), parse));
        }
        if duplicate {
            return None;
        }
        parsed.into_iter().collect()
    }
}

/// The number if it is a safe integer in JavaScript terms (`1.0` included).
fn safe_integer(value: &Value) -> Option<i64> {
    let number = value.as_number()?;
    let integer = if let Some(integer) = number.as_i64() {
        integer
    } else if number.is_u64() {
        return None; // Above i64::MAX, hence above the safe range.
    } else {
        let float = number.as_f64()?;
        if !float.is_finite() || float.fract() != 0.0 || float.abs() > MAX_SAFE_INTEGER as f64 {
            return None;
        }
        float as i64
    };
    (integer.unsigned_abs() <= MAX_SAFE_INTEGER).then_some(integer)
}

/// Lowercase RFC 9562 UUID, versions 1-8.
pub fn is_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, &byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            14 => (b'1'..=b'8').contains(&byte),
            19 => matches!(byte, b'8' | b'9' | b'a' | b'b'),
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
        })
}

/// Whitespace removed by JavaScript's `String.prototype.trim`.
fn is_js_space(character: char) -> bool {
    matches!(
        character,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// Nonblank, no control characters, at most `max` UTF-16 code units (the `text` rule).
fn is_text(text: &str, max: usize) -> bool {
    text.chars().any(|character| !is_js_space(character))
        && text.encode_utf16().count() <= max
        && !text
            .chars()
            .any(|character| (character as u32) < 32 || character as u32 == 127)
}
