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
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use extalia_core::security::permissions;
use extalia_core::time::now_millis;

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
const REAPER_INTERVAL: Duration = Duration::from_secs(1);

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
    missions: Option<Arc<Mutex<Missions>>>,
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
            missions: Some(Arc::new(Mutex::new(missions))),
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
        match (&self.missions, &mut self.skills) {
            (Some(missions), Some(skills)) => Some(match missions.lock() {
                Ok(mut missions) if missions.available() => {
                    skills.register_builtin(missions.store_mut(), source)
                }
                _ => Err(extalia_core::skills::SkillError::Corrupt(
                    "store_unavailable",
                )),
            }),
            _ => None,
        }
    }

    /// Hand the store back, for an explicit close after the connection ended.
    pub fn into_missions(self) -> Option<Missions> {
        let shared = self.missions?;
        let mutex = Arc::into_inner(shared)?;
        Some(match mutex.into_inner() {
            Ok(missions) => missions,
            Err(poisoned) => {
                let mut missions = poisoned.into_inner();
                missions.fail();
                missions
            }
        })
    }

    fn storage_available(&self) -> bool {
        self.missions
            .as_ref()
            .is_none_or(|missions| missions.lock().is_ok_and(|missions| missions.available()))
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
                        status: if self.storage_available() {
                            HealthStatus::Ok
                        } else {
                            HealthStatus::Degraded
                        },
                        uptime_ms: self.started.elapsed().as_millis().min(MAX_SAFE_MS) as u64,
                    }),
                    // The daemon is the decision point (ADR 0026); the host only enforces it.
                    RequestParams::PermissionCheck(_) if !self.storage_available() => {
                        Err((ErrorCode::StorageFailure, None))
                    }
                    RequestParams::PermissionCheck(check) => Ok(ResponseResult::PermissionCheck {
                        decision: permissions::decide(
                            check.access,
                            check.workspace_permissions,
                            &check.session_grants,
                            check.mode,
                        ),
                    }),
                    ref params @ (RequestParams::MissionCreate(_)
                    | RequestParams::PlanningBegin(_)
                    | RequestParams::PlanningObserve(_)
                    | RequestParams::PlanningInspect { .. }
                    | RequestParams::MissionSnapshot { .. }
                    | RequestParams::MissionHeartbeat(_)
                    | RequestParams::MissionExecutions { .. }
                    | RequestParams::MissionRecoveryReview { .. }
                    | RequestParams::ExecutionObserve(_)
                    | RequestParams::ExecutionRecordLocalDrain(_)
                    | RequestParams::TaskTransition(_)
                    | RequestParams::EventCommit(_)) => match &self.missions {
                        Some(missions) => match missions.lock() {
                            Ok(mut missions) => {
                                missions.handle(params).map_err(|code| (code, None))
                            }
                            Err(_) => Err((ErrorCode::StorageFailure, None)),
                        },
                        None => Err((ErrorCode::UnknownOp, None)),
                    },
                    RequestParams::Skill(ref request) => match (&self.missions, &mut self.skills) {
                        (Some(missions), Some(skills)) => match missions.lock() {
                            Ok(mut missions) if missions.available() => {
                                skills.handle(missions.store_mut(), request)
                            }
                            _ => Err((ErrorCode::StorageFailure, None)),
                        },
                        _ => Err((ErrorCode::UnknownOp, None)),
                    },
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
    let (stop, stopped) = mpsc::channel();
    let missions = session.missions.as_ref().map(Arc::clone);
    thread::scope(|scope| {
        // Reader stays on the calling thread: stdin's lock need not be Send.
        let reaper = match missions {
            Some(missions) => Some(
                thread::Builder::new()
                    .name("mission-reaper".to_owned())
                    .spawn_scoped(scope, move || run_reaper(missions, stopped))?,
            ),
            None => None,
        };
        let stop = ReaperStop(stop);
        let outcome = serve_connection(input, &output, session, &stop.0);
        stop.send();
        if let Some(reaper) = reaper {
            reaper
                .join()
                .map_err(|_| io::Error::other("the mission reaper failed"))?;
        }
        outcome
    })
}

/// Wakes the reaper even if the connection path unwinds before returning.
struct ReaperStop(Sender<()>);

impl ReaperStop {
    fn send(&self) {
        let _ = self.0.send(());
    }
}

impl Drop for ReaperStop {
    fn drop(&mut self) {
        self.send();
    }
}

fn run_reaper(missions: Arc<Mutex<Missions>>, stop: Receiver<()>) {
    loop {
        match stop.recv_timeout(REAPER_INTERVAL) {
            Ok(()) | Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {}
        }
        let mut missions = match missions.lock() {
            Ok(missions) => missions,
            Err(poisoned) => {
                // Only latch refusal; never repair the poisoned lock or use its store.
                poisoned.into_inner().fail();
                eprintln!(
                    "extalia-daemon: the core store lock is poisoned; mission execution fenced"
                );
                return;
            }
        };
        match missions.reap_expired(now_millis()) {
            Ok(report) if report.missions > 0 => eprintln!(
                "extalia-daemon: lease reaper quarantined {} mission(s) and {} task(s); nothing is replayed",
                report.missions, report.tasks
            ),
            Ok(_) => {}
            Err(_) => return,
        }
    }
}

fn serve_connection<R: Read, W: Write + Send>(
    input: R,
    output: &Mutex<W>,
    session: &mut Session,
    stop: &Sender<()>,
) -> io::Result<Exit> {
    let Some(mut knowledge) = session.knowledge.take() else {
        let outcome = read_frames(input, output, session);
        let _ = stop.send(());
        return outcome;
    };
    let (jobs, queue) = mpsc::channel();
    session.knowledge_jobs = Some(jobs);
    let (outcome, worker) = thread::scope(|scope| {
        let (index, writer) = (&mut knowledge, output);
        let worker = thread::Builder::new()
            .name("knowledge".to_owned())
            .spawn_scoped(scope, move || run_knowledge(index, queue, writer));
        let worker = match worker {
            Ok(worker) => worker,
            Err(error) => return (Err(error), None),
        };
        let outcome = read_frames(input, output, session);
        let _ = stop.send(());
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
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    const ID: &str = "00000000-0000-4000-8000-000000000100";

    fn frame(value: serde_json::Value) -> Vec<u8> {
        wire::encode(&wire::parse_frame(&value).unwrap()).unwrap()
    }

    struct TempStore(PathBuf);

    impl TempStore {
        fn new() -> Self {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            loop {
                let root = std::env::temp_dir().join(format!(
                    "extalia-daemon-reaper-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
                match std::fs::create_dir(&root) {
                    Ok(()) => return Self(root),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(error) => panic!("cannot create temporary store: {error}"),
                }
            }
        }

        fn session(&self) -> Session {
            Session::with_missions(Missions::new(
                extalia_core::CoreStore::open(&extalia_core::adapters::sqlite::store_path(&self.0))
                    .unwrap(),
                "default".to_owned(),
            ))
        }
    }

    impl Drop for TempStore {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    struct TestWriter {
        fail: bool,
    }

    impl Write for TestWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.fail {
                Err(io::Error::from(io::ErrorKind::BrokenPipe))
            } else {
                Ok(bytes.len())
            }
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn reaper_joins_and_releases_the_store_on_eof_fatal_frame_and_output_failure() {
        let hello = frame(
            json!({ "schemaVersion": 1, "kind": "request", "requestId": ID, "op": "hello", "params": { "clientVersion": "test", "capabilities": ["hello"] } }),
        );
        let invalid_payload = serde_json::to_vec(&json!({ "schemaVersion": 2, "kind": "request", "requestId": ID, "op": "hello", "params": { "clientVersion": "test", "capabilities": ["hello"] } })).unwrap();
        let invalid = [
            (invalid_payload.len() as u32).to_be_bytes().to_vec(),
            invalid_payload,
        ]
        .concat();
        for (input, fail_writer) in [(Vec::new(), false), (invalid, false), (hello, true)] {
            let temp = TempStore::new();
            let mut session = temp.session();
            let outcome = serve(
                input.as_slice(),
                TestWriter { fail: fail_writer },
                &mut session,
            );
            if fail_writer {
                assert_eq!(outcome.unwrap_err().kind(), io::ErrorKind::BrokenPipe);
            } else {
                assert!(matches!(outcome.unwrap(), Exit::Eof | Exit::ProtocolError));
            }
            assert_eq!(
                Arc::strong_count(session.missions.as_ref().unwrap()),
                1,
                "the reaper cannot retain a store lock after serve returns"
            );
            session
                .into_missions()
                .unwrap()
                .into_store()
                .close()
                .unwrap();
            let reopened =
                extalia_core::CoreStore::open(&extalia_core::adapters::sqlite::store_path(&temp.0))
                    .unwrap();
            reopened.close().unwrap();
        }
    }

    #[test]
    fn poisoned_reaper_lock_latches_without_repair_or_panic_and_degrades_health() {
        let temp = TempStore::new();
        let mut session = temp.session();
        let shared = Arc::clone(session.missions.as_ref().unwrap());
        let poison = Arc::clone(&shared);
        assert!(
            thread::spawn(move || {
                let _guard = poison.lock().unwrap();
                panic!("synthetic core worker panic");
            })
            .join()
            .is_err()
        );
        let (_stop, stopped) = mpsc::channel();
        run_reaper(Arc::clone(&shared), stopped);
        assert!(shared.is_poisoned(), "poison must never be repaired");
        assert!(!shared.lock().unwrap_err().into_inner().available());
        let request = |op: &str, params: serde_json::Value| {
            Ok(wire::parse_frame(&json!({ "schemaVersion": 1, "kind": "request", "requestId": ID, "op": op, "params": params })).unwrap())
        };
        session.handle(request(
            "hello",
            json!({ "clientVersion": "test", "capabilities": ["hello"] }),
        ));
        assert!(matches!(
            session.handle(request("health", json!({}))).frame,
            Some(Frame::Response(Response {
                result: ResponseResult::Health {
                    status: HealthStatus::Degraded,
                    ..
                },
                ..
            }))
        ));
        assert!(matches!(
            session
                .handle(request("mission.snapshot", json!({ "missionId": ID })))
                .frame,
            Some(Frame::Error(ErrorFrame {
                code: ErrorCode::StorageFailure,
                ..
            }))
        ));
        assert!(matches!(session.handle(request("permission.check", json!({ "access": "read", "mode": "workspace", "workspacePermissions": { "fileWrite": "ask", "commands": "ask" }, "sessionGrants": [] }))).frame, Some(Frame::Error(ErrorFrame { code: ErrorCode::StorageFailure, .. }))));
        drop(shared);
        session
            .into_missions()
            .unwrap()
            .into_store()
            .close()
            .unwrap();
    }

    #[test]
    fn knowledge_output_failure_cannot_disable_reaping_while_input_remains_open() {
        struct BrokenWriter(Sender<()>);
        impl Write for BrokenWriter {
            fn write(&mut self, _bytes: &[u8]) -> io::Result<usize> {
                let _ = self.0.send(());
                Err(io::Error::from(io::ErrorKind::BrokenPipe))
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let temp = TempStore::new();
        let mut session = temp
            .session()
            .with_knowledge(Knowledge::new(&temp.0, "default"));
        let request = |op: &str, params: serde_json::Value| {
            Ok(wire::parse_frame(&json!({ "schemaVersion": 1, "kind": "request", "requestId": ID, "op": op, "params": params })).unwrap())
        };
        session.handle(request(
            "hello",
            json!({ "clientVersion": "test", "capabilities": ["hello"] }),
        ));
        let mission = "00000000-0000-4000-8000-000000000200";
        let task = "00000000-0000-4000-8000-000000000201";
        let worker = "00000000-0000-4000-8000-000000000202";
        let created = session.handle(request("mission.create", json!({
            "mission": { "schemaVersion": 1, "id": mission, "workspaceId": ID, "leadAgentId": worker, "budgetId": ID,
                "state": "queued", "createdAt": "2026-10-22T11:00:00.000Z", "updatedAt": "2026-10-22T11:00:00.000Z", "version": 1 },
            "graph": { "schemaVersion": 1, "missionId": mission, "tasks": [{ "schemaVersion": 1, "id": task, "missionId": mission,
                "dependsOn": [], "assignedAgentId": worker, "state": "queued", "attempt": 0, "requirements": ["Read only"], "evidenceIds": [] }] }
        })));
        assert!(matches!(created.frame, Some(Frame::Response(_))));
        let running = session.handle(request("task.transition", json!({ "missionId": mission, "taskId": task, "eventId": ID, "from": "queued", "to": "running" })));
        assert!(matches!(running.frame, Some(Frame::Response(_))));
        let conn = rusqlite::Connection::open(extalia_core::adapters::sqlite::store_path(&temp.0))
            .unwrap();
        let acquired: String = conn
            .query_row(
                "SELECT acquired_at FROM leases WHERE task_id = ?1",
                [task],
                |row| row.get(0),
            )
            .unwrap();
        let expiry =
            extalia_core::time::format_utc(extalia_core::time::parse_utc(&acquired).unwrap() + 1);
        conn.execute(
            "UPDATE leases SET expires_at = ?1 WHERE task_id = ?2",
            [&expiry, task],
        )
        .unwrap();
        let (input, mut writer) = std::io::pipe().unwrap();
        let (broken, broken_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let outcome = serve(input, BrokenWriter(broken), &mut session);
            (outcome, session)
        });
        writer.write_all(&frame(json!({ "schemaVersion": 1, "kind": "request", "requestId": ID, "op": "knowledge.status", "params": {} }))).unwrap();
        broken_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("knowledge worker attempted its reply");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let state: String = conn
                .query_row(
                    "SELECT state FROM missions WHERE mission_id = ?1",
                    [mission],
                    |row| row.get(0),
                )
                .unwrap();
            if state == "recovering" {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "knowledge output failure stopped the live reaper"
            );
            thread::sleep(Duration::from_millis(10));
        }
        drop(writer);
        let (outcome, session) = server.join().unwrap();
        assert_eq!(outcome.unwrap_err().kind(), io::ErrorKind::BrokenPipe);
        session
            .into_missions()
            .unwrap()
            .into_store()
            .close()
            .unwrap();
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
