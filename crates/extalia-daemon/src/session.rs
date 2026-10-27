//! One host connection over stdio (ADR 0020): handshake state, dispatch and the frame loop.
//!
//! Rules beyond the contract text:
//! - The daemon answers requests only. A response frame from the host is answered with
//!   `invalid_frame`; an error frame is logged and not answered, so errors never ping-pong.
//! - Defined operations this daemon does not implement yet are answered with `unknown_op`
//!   after the handshake (`hello` advertises only the implemented ones). Without an open
//!   core store (`--data-dir`), that includes `mission.create`, `task.transition`,
//!   `event.commit`, the skill registry operations (`skills.rs`) and the knowledge index
//!   operations (`knowledge.rs`, served with a data directory). Before `hello`, every
//!   valid request other than `hello` gets `handshake_required`.
//! - A repeated `hello` is answered again with the same result.
//! - `unsupported_schema_version` and `frame_too_large` end the connection.
//! - Knowledge requests can be long (a sync walks the whole vault). [`serve`] runs them on
//!   one dedicated thread that owns the knowledge index (and its lock), strictly in arrival
//!   order, while this thread keeps answering every other request. Answers can therefore
//!   leave in another order than the requests came; the host correlates them by request id.
//!   One writer lock covers each whole frame, so frames never interleave. A knowledge request
//!   whose deadline passed while it waited behind another is answered `deadline_exceeded`
//!   without running. When stdin ends (or a fatal error ends the connection), the knowledge
//!   requests already received are still run and answered, then [`serve`] returns.
//!   [`Session::handle`] alone (no [`serve`]) runs knowledge requests inline.

use std::io::{self, Read, Write};
use std::sync::Mutex;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use extalia_core::security::permissions;

use crate::knowledge::{self, Knowledge};
use crate::missions::{self, Missions};
use crate::skills::{self, Skills};
use crate::wire::{
    self, ErrorCode, ErrorFrame, Frame, FrameReader, HealthStatus, KnowledgeRequest,
    MAX_FRAME_BYTES, Op, Rejection, RequestParams, Response, ResponseResult,
};

/// Operations this daemon implements, advertised in the `hello` result.
pub const CAPABILITIES: [Op; 3] = [Op::Hello, Op::PermissionCheck, Op::Health];
const READ_CHUNK_BYTES: usize = 64 * 1024;
const MAX_SAFE_MS: u128 = (1 << 53) - 1;

/// What one incoming frame produced.
#[derive(Debug, PartialEq)]
pub struct Reply {
    pub frame: Option<Frame>,
    /// The connection cannot continue (fail closed).
    pub end: bool,
}

/// How the frame loop ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Exit {
    /// Stdin ended on a frame boundary: the host closed the pipe.
    Eof,
    /// Stdin ended inside a frame.
    Truncated,
    /// A fatal protocol error was answered and the connection ended.
    ProtocolError,
}

/// A knowledge request handed to the knowledge thread.
#[derive(Debug)]
struct KnowledgeJob {
    request_id: String,
    request: KnowledgeRequest,
    /// When the request's relative deadline passes, counted from its arrival.
    deadline: Option<Instant>,
}

#[derive(Debug)]
pub struct Session {
    started: Instant,
    handshaken: bool,
    missions: Option<Missions>,
    skills: Option<Skills>,
    /// The knowledge index when requests run inline; taken by [`serve`]'s knowledge thread.
    knowledge: Option<Knowledge>,
    /// The queue of [`serve`]'s knowledge thread while it owns the index.
    knowledge_jobs: Option<Sender<KnowledgeJob>>,
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

impl Session {
    pub fn new() -> Self {
        Self {
            started: Instant::now(),
            handshaken: false,
            missions: None,
            skills: None,
            knowledge: None,
            knowledge_jobs: None,
        }
    }

    /// A session that serves the slice A operations from one profile's core store.
    pub fn with_missions(missions: Missions) -> Self {
        Self {
            missions: Some(missions),
            ..Self::new()
        }
    }

    /// Also serve the skill registry operations of the store's profile. Without a store
    /// they stay unadvertised and answer `unknown_op`.
    pub fn with_skills(mut self, skills: Skills) -> Self {
        self.skills = Some(skills);
        self
    }

    /// Also serve the knowledge index operations of `knowledge`'s profile (W5). They need a
    /// data directory but not the core store; without one they stay unadvertised.
    pub fn with_knowledge(mut self, knowledge: Knowledge) -> Self {
        self.knowledge = Some(knowledge);
        self
    }

    /// The skill registry, for daemon-internal registration of built-in skills.
    pub fn skills_mut(&mut self) -> Option<&mut Skills> {
        self.skills.as_mut()
    }

    /// Daemon-internal registration of a built-in skill on the open store (gap-map
    /// decision 10); `None` without a store. No wire operation reaches this.
    pub fn register_builtin(
        &mut self,
        source: &std::path::Path,
    ) -> Option<Result<String, extalia_core::skills::SkillError>> {
        match (&mut self.missions, &mut self.skills) {
            (Some(missions), Some(skills)) => {
                Some(skills.register_builtin(missions.store_mut(), source))
            }
            _ => None,
        }
    }

    /// Hand the store back, for an explicit close after the connection ended.
    pub fn into_missions(self) -> Option<Missions> {
        self.missions
    }

    pub fn handle(&mut self, incoming: Result<Frame, Rejection>) -> Reply {
        let frame = match incoming {
            Ok(frame) => frame,
            Err(rejection) => {
                let end = rejection.fatal || rejection.code == ErrorCode::UnsupportedSchemaVersion;
                return Reply {
                    frame: Some(error(rejection.request_id, rejection.code)),
                    end,
                };
            }
        };
        let reply = match frame {
            Frame::Request(request) => {
                let result = match request.params {
                    RequestParams::Hello { .. } => {
                        self.handshaken = true;
                        Ok(ResponseResult::Hello {
                            daemon_version: env!("CARGO_PKG_VERSION").to_owned(),
                            capabilities: CAPABILITIES
                                .iter()
                                .chain(self.missions.iter().flat_map(|_| &missions::CAPABILITIES))
                                .chain(
                                    self.missions
                                        .iter()
                                        .zip(&self.skills)
                                        .flat_map(|_| &skills::CAPABILITIES),
                                )
                                .chain(
                                    self.serves_knowledge()
                                        .then_some(&knowledge::CAPABILITIES)
                                        .into_iter()
                                        .flatten(),
                                )
                                .copied()
                                .collect(),
                            max_frame_bytes: MAX_FRAME_BYTES as u64,
                        })
                    }
                    _ if !self.handshaken => Err((ErrorCode::HandshakeRequired, None)),
                    RequestParams::Health => Ok(ResponseResult::Health {
                        status: HealthStatus::Ok,
                        uptime_ms: self.started.elapsed().as_millis().min(MAX_SAFE_MS) as u64,
                    }),
                    // The daemon is the decision point (ADR 0026); the host only enforces it.
                    RequestParams::PermissionCheck(check) => Ok(ResponseResult::PermissionCheck {
                        decision: permissions::decide(
                            check.access,
                            check.workspace_permissions,
                            &check.session_grants,
                            check.mode,
                        ),
                    }),
                    ref params @ (RequestParams::MissionCreate(_)
                    | RequestParams::MissionSnapshot { .. }
                    | RequestParams::TaskTransition(_)
                    | RequestParams::EventCommit(_)) => match &mut self.missions {
                        Some(missions) => missions.handle(params).map_err(|code| (code, None)),
                        None => Err((ErrorCode::UnknownOp, None)),
                    },
                    RequestParams::Skill(ref request) => {
                        match (&mut self.missions, &mut self.skills) {
                            (Some(missions), Some(skills)) => {
                                skills.handle(missions.store_mut(), request)
                            }
                            _ => Err((ErrorCode::UnknownOp, None)),
                        }
                    }
                    RequestParams::Knowledge(knowledge_request) => {
                        match (&mut self.knowledge, &self.knowledge_jobs) {
                            (Some(knowledge), _) => knowledge.handle(&knowledge_request),
                            (None, Some(jobs)) => {
                                let job = KnowledgeJob {
                                    deadline: request
                                        .deadline_ms
                                        .map(|ms| Instant::now() + Duration::from_millis(ms)),
                                    request_id: request.request_id,
                                    request: knowledge_request,
                                };
                                match jobs.send(job) {
                                    // Answered by the knowledge thread.
                                    Ok(()) => return Reply::none(),
                                    Err(mpsc::SendError(job)) => {
                                        eprintln!(
                                            "extalia-daemon: the knowledge thread is gone; {} refused",
                                            job.request.op().as_str()
                                        );
                                        return Reply {
                                            frame: Some(error(
                                                Some(job.request_id),
                                                ErrorCode::Internal,
                                            )),
                                            end: false,
                                        };
                                    }
                                }
                            }
                            (None, None) => Err((ErrorCode::UnknownOp, None)),
                        }
                    }
                    RequestParams::Unvalidated { .. } => Err((ErrorCode::UnknownOp, None)),
                };
                Some(answer(request.request_id, result))
            }
            Frame::Response(response) => {
                Some(error(Some(response.request_id), ErrorCode::InvalidFrame))
            }
            Frame::Error(_) => None,
        };
        Reply {
            frame: reply,
            end: false,
        }
    }

    fn serves_knowledge(&self) -> bool {
        self.knowledge.is_some() || self.knowledge_jobs.is_some()
    }
}

impl Reply {
    fn none() -> Self {
        Self {
            frame: None,
            end: false,
        }
    }
}

/// The response or error frame answering `request_id`.
fn answer(
    request_id: String,
    result: Result<ResponseResult, (ErrorCode, Option<&'static str>)>,
) -> Frame {
    match result {
        Ok(result) => Frame::Response(Response { request_id, result }),
        Err((code, reason)) => refused(Some(request_id), code, reason.map(str::to_owned)),
    }
}

fn error(request_id: Option<String>, code: ErrorCode) -> Frame {
    refused(request_id, code, None)
}

fn refused(request_id: Option<String>, code: ErrorCode, reason: Option<String>) -> Frame {
    let message = match code {
        ErrorCode::InvalidFrame => "Invalid frame.",
        ErrorCode::FrameTooLarge => "Frame exceeds the maximum size.",
        ErrorCode::UnsupportedSchemaVersion => "Unsupported schema version.",
        ErrorCode::HandshakeRequired => "Send hello first.",
        ErrorCode::UnknownOp => "Operation is not supported by this daemon.",
        ErrorCode::InvalidRequest => "Invalid request parameters.",
        _ => "Request failed.",
    };
    Frame::Error(ErrorFrame {
        request_id,
        code,
        message: Some(message.to_owned()),
        reason,
    })
}

/// Read frames from `input` until EOF or a fatal error, answering each on `output`.
/// Diagnostics go to stderr, never stdout, and never contain payload contents.
///
/// With a knowledge index, its requests run on a dedicated thread (module notes); the
/// queued ones are finished before this returns.
pub fn serve<R: Read, W: Write + Send>(
    input: R,
    output: W,
    session: &mut Session,
) -> io::Result<Exit> {
    let output = Mutex::new(output);
    let Some(mut knowledge) = session.knowledge.take() else {
        return read_frames(input, &output, session);
    };
    let (jobs, queue) = mpsc::channel();
    session.knowledge_jobs = Some(jobs);
    let (outcome, worker) = thread::scope(|scope| {
        let (index, writer) = (&mut knowledge, &output);
        let worker = thread::Builder::new()
            .name("knowledge".to_owned())
            .spawn_scoped(scope, move || run_knowledge(index, queue, writer));
        let worker = match worker {
            Ok(worker) => worker,
            Err(error) => return (Err(error), None),
        };
        let outcome = read_frames(input, &output, session);
        // No further knowledge request: the thread finishes the queued ones, then ends.
        session.knowledge_jobs = None;
        (outcome, Some(worker.join()))
    });
    session.knowledge_jobs = None;
    session.knowledge = Some(knowledge);
    let worker = match worker {
        Some(Ok(result)) => result,
        Some(Err(panic)) => std::panic::resume_unwind(panic),
        None => Ok(()),
    };
    let exit = outcome?;
    worker?;
    Ok(exit)
}

fn read_frames<R: Read, W: Write>(
    mut input: R,
    output: &Mutex<W>,
    session: &mut Session,
) -> io::Result<Exit> {
    let mut reader = FrameReader::new(MAX_FRAME_BYTES);
    let mut chunk = vec![0; READ_CHUNK_BYTES];
    loop {
        let read = match input.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        for incoming in reader.push(&chunk[..read]) {
            if let Err(rejection) = &incoming {
                eprintln!(
                    "extalia-daemon: rejected a frame ({})",
                    rejection.code.as_str()
                );
            }
            if let Ok(Frame::Error(frame)) = &incoming {
                eprintln!(
                    "extalia-daemon: ignored an error frame from the host ({})",
                    frame.code.as_str()
                );
            }
            let reply = session.handle(incoming);
            if let Some(frame) = reply.frame {
                write_frame(output, &frame)?;
            }
            if reply.end {
                return Ok(Exit::ProtocolError);
            }
        }
    }
    Ok(if reader.pending() > 0 {
        Exit::Truncated
    } else {
        Exit::Eof
    })
}

/// The knowledge thread: run each queued request in arrival order and answer it. Ends when
/// the queue is closed and empty, or when the output fails.
fn run_knowledge<W: Write>(
    knowledge: &mut Knowledge,
    queue: Receiver<KnowledgeJob>,
    output: &Mutex<W>,
) -> io::Result<()> {
    for job in queue {
        let result = if job
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            eprintln!(
                "extalia-daemon: {} passed its deadline while queued; not run",
                job.request.op().as_str()
            );
            Err((ErrorCode::DeadlineExceeded, None))
        } else {
            knowledge.handle(&job.request)
        };
        write_frame(output, &answer(job.request_id, result))?;
    }
    Ok(())
}

/// Encode and write one whole frame under the writer lock, then flush.
fn write_frame<W: Write>(output: &Mutex<W>, frame: &Frame) -> io::Result<()> {
    let bytes = wire::encode(frame).map_err(|error| io::Error::other(format!("{error:?}")))?;
    // Poisoned: a thread panicked while writing and may have left half a frame; fail closed.
    let mut output = output
        .lock()
        .map_err(|_| io::Error::other("the output writer failed"))?;
    output.write_all(&bytes)?;
    output.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "00000000-0000-4000-8000-000000000100";

    fn frame(value: serde_json::Value) -> Vec<u8> {
        wire::encode(&wire::parse_frame(&value).unwrap()).unwrap()
    }

    #[test]
    fn answers_requests_only_and_repeats_hello() {
        let hello = json!({ "schemaVersion": 1, "kind": "request", "requestId": ID, "op": "hello",
            "params": { "clientVersion": "1", "capabilities": ["hello"] } });
        let host_response = json!({ "schemaVersion": 1, "kind": "response", "requestId": ID, "op": "health",
            "result": { "status": "ok", "uptimeMs": 1 } });
        let host_error =
            json!({ "schemaVersion": 1, "kind": "error", "error": { "code": "internal" } });
        let input = [
            frame(hello.clone()),
            frame(hello),
            frame(host_response),
            frame(host_error),
        ]
        .concat();
        let mut output = Vec::new();
        let exit = serve(input.as_slice(), &mut output, &mut Session::new()).unwrap();
        assert_eq!(exit, Exit::Eof);
        let mut reader = FrameReader::new(MAX_FRAME_BYTES);
        let replies: Vec<_> = reader
            .push(&output)
            .into_iter()
            .map(Result::unwrap)
            .collect();
        assert_eq!(replies.len(), 3, "the host's error frame is not answered");
        assert_eq!(replies[0], replies[1]);
        assert!(matches!(
            &replies[2],
            Frame::Error(ErrorFrame {
                code: ErrorCode::InvalidFrame,
                request_id: Some(_),
                ..
            })
        ));
    }
}
