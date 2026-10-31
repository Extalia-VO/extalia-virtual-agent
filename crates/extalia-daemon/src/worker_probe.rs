//! Opt-in, trusted-configuration health probe. This owns one direct child only;
//! it verifies neither the program artifact nor a sandbox or descendant settlement.
//! Tokio's runtime must have I/O and time enabled. OS spawn itself is synchronous
//! and is not claimed to be bounded by the subsequent watchdog deadlines.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, watch};
use tokio::time::{Instant, sleep_until, timeout, timeout_at};

use crate::worker_exchange::{CloseReason, Exchange, Notice};
use crate::worker_protocol::{
    DecodeError, Frame, FrameReader, MAX_DEADLINE_MS, encode, valid_request_id, valid_version,
};

pub const MAX_STDOUT_BYTES: usize = 128 * 1024;
pub const MAX_STDERR_BYTES: usize = 16 * 1024;
const READ_BYTES: usize = 4096;
const IDLE: u8 = 0;
const BUSY: u8 = 1;
const POISONED: u8 = 2;
static ADMISSION: AtomicU8 = AtomicU8::new(IDLE);

/// All values are trusted caller configuration claims, not artifact evidence.
#[derive(Clone, Debug)]
pub struct ProbeConfig {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
    pub expected_version: String,
    pub request_id: String,
    pub handshake_timeout_ms: u64,
    pub request_timeout_ms: u64,
    pub exit_timeout_ms: u64,
    pub cancel_grace_ms: u64,
    pub reap_timeout_ms: u64,
}

impl ProbeConfig {
    fn valid(&self) -> bool {
        fn path_valid(path: &std::path::Path) -> bool {
            let raw = path.as_os_str().as_encoded_bytes();
            path.is_absolute() && raw.len() <= 4096 && !raw.contains(&0)
        }
        if !path_valid(&self.program)
            || !path_valid(&self.cwd)
            || self.args.len() > 8
            || !valid_version(&self.expected_version)
            || !valid_request_id(&self.request_id)
            || !(1..=MAX_DEADLINE_MS).contains(&self.handshake_timeout_ms)
            || !(1..=MAX_DEADLINE_MS).contains(&self.request_timeout_ms)
            || [
                self.exit_timeout_ms,
                self.cancel_grace_ms,
                self.reap_timeout_ms,
            ]
            .iter()
            .any(|v| !(1..=5000).contains(v))
        {
            return false;
        }
        let mut total = 0_usize;
        for arg in &self.args {
            let raw = arg.as_encoded_bytes();
            if raw.contains(&0) {
                return false;
            }
            let Some(next) = total.checked_add(raw.len()) else {
                return false;
            };
            total = next;
            if total > 16 * 1024 {
                return false;
            }
        }
        true
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdmissionState {
    Idle,
    Busy,
    Poisoned,
}

pub fn admission_state() -> AdmissionState {
    match ADMISSION.load(Ordering::Acquire) {
        IDLE => AdmissionState::Idle,
        BUSY => AdmissionState::Busy,
        _ => AdmissionState::Poisoned,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartError {
    InvalidConfiguration,
    Busy,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeOutcome {
    Healthy,
    Cancelled,
    HandshakeTimeout,
    RequestTimeout,
    ExitTimeout,
    ProtocolRejected,
    OutputLimit,
    IoFailed,
    SpawnFailed,
    WorkerError,
    NonZeroExit,
    CleanupUnverified,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChildExit {
    NotSpawned,
    Reaped { code: Option<i32>, success: bool },
    Unverified,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProbeReport {
    pub outcome: ProbeOutcome,
    pub exit: ChildExit,
    /// Observed bytes, at most the budget plus one overflow-detection byte.
    pub stdout_bytes: usize,
    pub stderr_bytes: usize,
    pub cancel_sent: bool,
    pub kill_requested: bool,
}

impl ProbeReport {
    pub fn physical_settlement_verified(&self) -> bool {
        false
    }

    fn new(outcome: ProbeOutcome, exit: ChildExit) -> Self {
        Self {
            outcome,
            exit,
            stdout_bytes: 0,
            stderr_bytes: 0,
            cancel_sent: false,
            kill_requested: false,
        }
    }
}

/// Dropping this handle or its wait future requests cancellation; it never aborts
/// the owner task and cannot release the process-wide admission slot.
pub struct ProbeHandle {
    cancel: watch::Sender<bool>,
    report: Option<oneshot::Receiver<ProbeReport>>,
}

impl ProbeHandle {
    pub fn cancel(&self) {
        self.cancel.send_replace(true);
    }

    pub async fn wait(mut self) -> ProbeReport {
        match self.report.take() {
            Some(receiver) => receiver.await.unwrap_or_else(|_| {
                ProbeReport::new(ProbeOutcome::CleanupUnverified, ChildExit::Unverified)
            }),
            None => ProbeReport::new(ProbeOutcome::CleanupUnverified, ChildExit::Unverified),
        }
    }
}

impl Drop for ProbeHandle {
    fn drop(&mut self) {
        self.cancel();
    }
}

/// An unsettled owner (including panic/runtime abort) poisons admission. A kill
/// request or dropping Child alone can never release it.
struct AdmissionPermit<'a> {
    state: &'a AtomicU8,
    settled: bool,
}

impl AdmissionPermit<'_> {
    fn finish(&mut self, exit: ChildExit) {
        if matches!(exit, ChildExit::NotSpawned | ChildExit::Reaped { .. }) {
            self.settled = true;
            self.state.store(IDLE, Ordering::Release);
        }
    }
}

impl Drop for AdmissionPermit<'_> {
    fn drop(&mut self) {
        if !self.settled {
            self.state.store(POISONED, Ordering::Release);
        }
    }
}

/// Fail-fast admission, without PATH lookup, a shell, or a queue.
pub fn start_probe(config: ProbeConfig) -> Result<ProbeHandle, StartError> {
    if !config.valid() {
        return Err(StartError::InvalidConfiguration);
    }
    let runtime = tokio::runtime::Handle::try_current().map_err(|_| StartError::Unavailable)?;
    ADMISSION
        .compare_exchange(IDLE, BUSY, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|state| {
            if state == BUSY {
                StartError::Busy
            } else {
                StartError::Unavailable
            }
        })?;
    let permit = AdmissionPermit {
        state: &ADMISSION,
        settled: false,
    };
    let (cancel, cancel_rx) = watch::channel(false);
    let (report_tx, report) = oneshot::channel();
    runtime.spawn(async move {
        let mut permit = permit;
        let report = run_owner(config, cancel_rx).await;
        permit.finish(report.exit);
        let _ = report_tx.send(report);
    });
    Ok(ProbeHandle {
        cancel,
        report: Some(report),
    })
}

async fn cancellation(cancel: &mut watch::Receiver<bool>) {
    if !*cancel.borrow() {
        let _ = cancel.changed().await;
    }
}

async fn read_pipe<T: AsyncRead + Unpin>(
    pipe: &mut Option<T>,
    bytes: &mut [u8],
) -> std::io::Result<usize> {
    match pipe {
        Some(pipe) => pipe.read(bytes).await,
        None => std::future::pending().await,
    }
}

async fn write_pipe(pipe: &mut Option<ChildStdin>, bytes: &[u8]) -> std::io::Result<usize> {
    match pipe {
        Some(pipe) => pipe.write(bytes).await,
        None => std::future::pending().await,
    }
}

async fn run_owner(config: ProbeConfig, cancel: watch::Receiver<bool>) -> ProbeReport {
    if *cancel.borrow() {
        return ProbeReport::new(ProbeOutcome::Cancelled, ChildExit::NotSpawned);
    }
    let mut command = Command::new(&config.program);
    command
        .args(&config.args)
        .current_dir(&config.cwd)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    if let Some(system_root) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", system_root);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return ProbeReport::new(ProbeOutcome::SpawnFailed, ChildExit::NotSpawned),
    };
    // Always take all three handles before any Child::wait call.
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let origin = Instant::now();
    let exchange = match Exchange::new(&config.expected_version, 0, config.handshake_timeout_ms) {
        Ok(exchange) => exchange,
        // Public validation above makes this unreachable without implementation drift.
        Err(_) => {
            drop((stdin, stdout, stderr));
            let mut report = ProbeReport::new(ProbeOutcome::IoFailed, ChildExit::Unverified);
            kill_and_reap(&mut child, &config, &mut report).await;
            return report;
        }
    };
    let mut owner = Owner {
        child,
        stdin,
        stdout,
        stderr,
        config,
        origin,
        exchange,
        reader: FrameReader::new(),
        stage: Stage::Hello,
        deadline: origin,
        request: Vec::new(),
        write_offset: 0,
        request_written: false,
        response_received: false,
        report: ProbeReport::new(ProbeOutcome::IoFailed, ChildExit::Unverified),
    };
    owner.deadline = origin + Duration::from_millis(owner.config.handshake_timeout_ms);
    owner.report.outcome =
        if owner.stdin.is_none() || owner.stdout.is_none() || owner.stderr.is_none() {
            ProbeOutcome::IoFailed
        } else {
            owner.drive(cancel).await
        };
    if !matches!(owner.report.exit, ChildExit::Reaped { .. }) {
        owner.cleanup().await;
    }
    owner.report
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Hello,
    WritingRequest,
    Response,
    Exit,
}

enum Event {
    Timeout,
    Cancel,
    Stdout(std::io::Result<usize>),
    Stderr(std::io::Result<usize>),
    Written(std::io::Result<usize>),
    Exited(std::io::Result<ExitStatus>),
}

struct Owner {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Option<ChildStdout>,
    stderr: Option<ChildStderr>,
    config: ProbeConfig,
    origin: Instant,
    exchange: Exchange,
    reader: FrameReader,
    stage: Stage,
    deadline: Instant,
    request: Vec<u8>,
    write_offset: usize,
    request_written: bool,
    response_received: bool,
    report: ProbeReport,
}

impl Owner {
    fn now_ms(&self) -> u64 {
        u64::try_from(self.origin.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    fn timeout_outcome(&self) -> ProbeOutcome {
        match self.stage {
            Stage::Hello => ProbeOutcome::HandshakeTimeout,
            Stage::WritingRequest | Stage::Response => ProbeOutcome::RequestTimeout,
            Stage::Exit => ProbeOutcome::ExitTimeout,
        }
    }

    async fn drive(&mut self, mut cancel: watch::Receiver<bool>) -> ProbeOutcome {
        let mut stdout_bytes = [0_u8; READ_BYTES];
        let mut stderr_bytes = [0_u8; READ_BYTES];
        loop {
            if Instant::now() >= self.deadline {
                return self.timeout_outcome();
            }
            if let Err(reason) = self.exchange.tick(self.now_ms()) {
                return if reason == CloseReason::DeadlineExpired {
                    self.timeout_outcome()
                } else {
                    ProbeOutcome::ProtocolRejected
                };
            }
            let stdout_capacity = READ_BYTES.min(MAX_STDOUT_BYTES - self.report.stdout_bytes + 1);
            let stderr_capacity = READ_BYTES.min(MAX_STDERR_BYTES - self.report.stderr_bytes + 1);
            // read(), write(), watch::changed(), and Child::wait() are cancel safe.
            // Offsets advance only after completed writes; no write_all future is cancelled.
            let event = tokio::select! {
                biased;
                _ = sleep_until(self.deadline) => Event::Timeout,
                _ = cancellation(&mut cancel) => Event::Cancel,
                result = read_pipe(&mut self.stdout, &mut stdout_bytes[..stdout_capacity]), if self.stdout.is_some() => Event::Stdout(result),
                result = read_pipe(&mut self.stderr, &mut stderr_bytes[..stderr_capacity]), if self.stderr.is_some() => Event::Stderr(result),
                result = write_pipe(&mut self.stdin, &self.request[self.write_offset..]), if self.stage == Stage::WritingRequest => Event::Written(result),
                result = self.child.wait(), if self.stdout.is_none() && self.stderr.is_none() => Event::Exited(result),
            };
            // Deadlines win at equality even when I/O and the timer become ready together.
            if Instant::now() >= self.deadline {
                return self.timeout_outcome();
            }
            match event {
                Event::Timeout => return self.timeout_outcome(),
                Event::Cancel => return ProbeOutcome::Cancelled,
                Event::Stdout(Err(_))
                | Event::Stderr(Err(_))
                | Event::Written(Err(_))
                | Event::Written(Ok(0)) => return ProbeOutcome::IoFailed,
                Event::Stdout(Ok(0)) => {
                    self.stdout.take();
                    if self.reader.finish().is_err() || !self.response_received {
                        return ProbeOutcome::ProtocolRejected;
                    }
                }
                Event::Stdout(Ok(count)) => {
                    self.report.stdout_bytes += count;
                    if self.report.stdout_bytes > MAX_STDOUT_BYTES {
                        return ProbeOutcome::OutputLimit;
                    }
                    for &byte in &stdout_bytes[..count] {
                        if self.stage == Stage::WritingRequest || self.response_received {
                            return ProbeOutcome::ProtocolRejected;
                        }
                        let frames = match self.reader.push(&[byte]) {
                            Ok(frames) => frames,
                            Err(DecodeError::Oversize | DecodeError::TooManyFrames) => {
                                return ProbeOutcome::OutputLimit;
                            }
                            Err(_) => return ProbeOutcome::ProtocolRejected,
                        };
                        for frame in frames {
                            if Instant::now() >= self.deadline {
                                return self.timeout_outcome();
                            }
                            if let Err(outcome) = self.receive(frame) {
                                return outcome;
                            }
                        }
                    }
                }
                Event::Stderr(Ok(0)) => {
                    self.stderr.take();
                }
                Event::Stderr(Ok(count)) => {
                    self.report.stderr_bytes += count;
                    if self.report.stderr_bytes > MAX_STDERR_BYTES {
                        return ProbeOutcome::OutputLimit;
                    }
                }
                Event::Written(Ok(count)) => {
                    self.write_offset += count;
                    if self.write_offset == self.request.len() {
                        self.request_written = true;
                        self.stage = Stage::Response;
                    }
                }
                Event::Exited(Ok(status)) => {
                    self.report.exit = reaped(status);
                    return if !status.success() {
                        ProbeOutcome::NonZeroExit
                    } else if self.response_received {
                        ProbeOutcome::Healthy
                    } else {
                        ProbeOutcome::ProtocolRejected
                    };
                }
                Event::Exited(Err(_)) => return ProbeOutcome::IoFailed,
            }
        }
    }

    fn receive(&mut self, frame: Frame) -> Result<(), ProbeOutcome> {
        let now = self.now_ms();
        let notice = self.exchange.receive(frame, now).map_err(|reason| {
            if reason == CloseReason::DeadlineExpired {
                self.timeout_outcome()
            } else {
                ProbeOutcome::ProtocolRejected
            }
        })?;
        match notice {
            Notice::Hello => {
                let request = self
                    .exchange
                    .request(&self.config.request_id, self.config.request_timeout_ms, now)
                    .map_err(|_| ProbeOutcome::ProtocolRejected)?;
                self.request = encode(&request).map_err(|_| ProbeOutcome::ProtocolRejected)?;
                self.stage = Stage::WritingRequest;
                self.deadline =
                    self.origin + Duration::from_millis(now + self.config.request_timeout_ms);
            }
            Notice::Response => {
                if !self.request_written {
                    return Err(ProbeOutcome::ProtocolRejected);
                }
                self.response_received = true;
                self.stage = Stage::Exit;
                self.deadline = Instant::now() + Duration::from_millis(self.config.exit_timeout_ms);
                self.stdin.take();
            }
            Notice::Error { .. } => return Err(ProbeOutcome::WorkerError),
        }
        Ok(())
    }

    async fn cleanup(&mut self) {
        // No more reads after failure, including through descendant-held pipes.
        self.stdout.take();
        self.stderr.take();
        if let Ok(Some(status)) = self.child.try_wait() {
            self.stdin.take();
            self.report.exit = reaped(status);
            return;
        }
        if self.request_written && !self.response_received && self.stdin.is_some() {
            let deadline = Instant::now() + Duration::from_millis(self.config.cancel_grace_ms);
            let frame = Frame::Cancel {
                request_id: self.config.request_id.clone(),
            };
            if let Ok(bytes) = encode(&frame) {
                let mut offset = 0;
                while offset < bytes.len() {
                    let result = tokio::select! {
                        biased;
                        _ = sleep_until(deadline) => break,
                        result = write_pipe(&mut self.stdin, &bytes[offset..]) => result,
                    };
                    match result {
                        Ok(0) | Err(_) => break,
                        Ok(count) => offset += count,
                    }
                }
                self.report.cancel_sent = offset == bytes.len();
            }
            self.stdin.take();
            if let Ok(Ok(status)) = timeout_at(deadline, self.child.wait()).await {
                self.report.exit = reaped(status);
                return;
            }
        } else {
            // Never append a cancel frame to an incomplete request line.
            self.stdin.take();
        }
        kill_and_reap(&mut self.child, &self.config, &mut self.report).await;
    }
}

fn reaped(status: ExitStatus) -> ChildExit {
    ChildExit::Reaped {
        code: status.code(),
        success: status.success(),
    }
}

async fn kill_and_reap(child: &mut Child, config: &ProbeConfig, report: &mut ProbeReport) {
    report.kill_requested = true;
    let _ = child.start_kill();
    match timeout(Duration::from_millis(config.reap_timeout_ms), child.wait()).await {
        Ok(Ok(status)) => report.exit = reaped(status),
        _ => {
            report.exit = ChildExit::Unverified;
            report.outcome = ProbeOutcome::CleanupUnverified;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> ProbeConfig {
        let directory = std::env::temp_dir();
        ProbeConfig {
            program: directory.join("synthetic-worker"),
            args: Vec::new(),
            cwd: directory,
            expected_version: "1.0.0".into(),
            request_id: "12345678-1234-4123-8123-123456789abc".into(),
            handshake_timeout_ms: 1,
            request_timeout_ms: 300_000,
            exit_timeout_ms: 1,
            cancel_grace_ms: 5000,
            reap_timeout_ms: 1,
        }
    }

    #[test]
    fn probe_config_is_bounded_before_admission() {
        assert!(config().valid());
        let mut value = config();
        value.program = PathBuf::from("relative-worker");
        assert!(!value.valid());
        let mut value = config();
        value.cwd = PathBuf::from("relative-cwd");
        assert!(!value.valid());
        let mut value = config();
        value.args = vec![OsString::from("x"); 9];
        assert!(!value.valid());
        let mut value = config();
        value.args = vec![OsString::from("x".repeat(16_384))];
        assert!(value.valid());
        value.args.push(OsString::from("x"));
        assert!(!value.valid());
        let mut value = config();
        value.args = vec![OsString::from("nul\0arg")];
        assert!(!value.valid());
        let mut value = config();
        value.expected_version = "é".into();
        assert!(!value.valid());
        let mut value = config();
        value.request_id = "invalid".into();
        assert!(!value.valid());
        let mut value = config();
        value.handshake_timeout_ms = 300_001;
        assert!(!value.valid());
        let mut value = config();
        value.request_timeout_ms = 0;
        assert!(!value.valid());
        let mut value = config();
        value.exit_timeout_ms = 5001;
        assert!(!value.valid());
        let mut value = config();
        value.cancel_grace_ms = 0;
        assert!(!value.valid());
        let mut value = config();
        value.reap_timeout_ms = 5001;
        assert!(!value.valid());
    }

    #[test]
    fn probe_permit_releases_only_verified_no_child_or_reaped() {
        for exit in [
            ChildExit::NotSpawned,
            ChildExit::Reaped {
                code: Some(0),
                success: true,
            },
            ChildExit::Unverified,
        ] {
            let state = AtomicU8::new(BUSY);
            {
                let mut permit = AdmissionPermit {
                    state: &state,
                    settled: false,
                };
                permit.finish(exit);
            }
            assert_eq!(
                state.load(Ordering::Acquire),
                if exit == ChildExit::Unverified {
                    POISONED
                } else {
                    IDLE
                }
            );
        }
        let state = AtomicU8::new(BUSY);
        {
            let _permit = AdmissionPermit {
                state: &state,
                settled: false,
            };
        }
        assert_eq!(state.load(Ordering::Acquire), POISONED);
    }

    #[test]
    fn probe_report_never_claims_physical_settlement() {
        for exit in [
            ChildExit::NotSpawned,
            ChildExit::Reaped {
                code: Some(0),
                success: true,
            },
            ChildExit::Unverified,
        ] {
            assert!(!ProbeReport::new(ProbeOutcome::Healthy, exit).physical_settlement_verified());
        }
    }
}
